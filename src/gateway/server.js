import net from 'node:net';
import { existsSync, lstatSync, unlinkSync, chmodSync, chownSync, writeFileSync } from 'node:fs';
import { checkRealLayout, realStat, socketProblems } from './layout.js';
import { resolveGroup } from './sys.js';

export const MAX_LINE = 1024 * 1024;

/** Pure peer decision, shared with doctor check (e). Fail closed: anything but a listed integer uid is refused. */
export function peerAllowed(allowlist, uid) {
  return Number.isSafeInteger(uid) && Array.isArray(allowlist) && allowlist.includes(uid);
}

/**
 * Node exposes no SO_PEERCRED, so the peer uid cannot be read by the built-in modules and is NOT the access boundary. Access is
 * kernel-enforced: the socket is 0660 in a 0750 directory, both group-owned by runner_group, so only that group can even reach it.
 * A peer-uid probe is an optional extra hook. When one is supplied it is enforced, and an unknown, throwing or unlisted answer
 * refuses the connection (fail closed). `unknownPeerUid` is a probe that always answers "unknown", kept for tests of that rule.
 */
export const unknownPeerUid = () => null;

/**
 * Unix-socket JSON-lines server (one JSON request per line, one response per line; one request in flight per connection).
 * No TCP listener exists in this module: it only ever calls listen(path). Before it listens it verifies the file-permission layout
 * and refuses to start if anything is wrong. With a peer-uid probe configured, the peer is checked BEFORE any byte is read.
 */
export function createGatewayServer({ api, config, getPeerUid, log = () => {}, checkLayout = checkRealLayout, group = resolveGroup, statFn = realStat, idleMs = config.idle_timeout_ms ?? 30_000, maxRequestBytes = config.max_request_bytes ?? MAX_LINE }) {
  const byteLen = (s) => Buffer.byteLength(s, 'utf8');
  const server = net.createServer({ allowHalfOpen: false, pauseOnConnect: true }, (socket) => {
    (async () => {
      if (getPeerUid) {
        let uid;
        try { uid = await getPeerUid(socket); } catch { uid = null; }
        if (!peerAllowed(config.allowed_peer_uids, uid)) { log('connection refused: peer not allowlisted'); socket.destroy(); return; }
      }
      let buf = ''; let inFlight = false;
      // The idle timeout counts only quiet time between requests. While a request is being served no timer runs, so a slow provider call is never cut off.
      const arm = () => { if (!socket.destroyed) socket.setTimeout(idleMs); };
      socket.on('timeout', () => { if (!inFlight) socket.destroy(); });
      arm();
      socket.setEncoding('utf8');
      socket.on('error', () => socket.destroy());
      const send = (res) => { if (!socket.destroyed) socket.write(JSON.stringify(res) + '\n'); };
      const serve = (line) => {
        inFlight = true; socket.setTimeout(0);
        (async () => {
          let req;
          try { req = JSON.parse(line); } catch { req = null; }
          send(req === null ? { id: null, ok: false, error: { code: 'invalid_request', message: 'request is not valid JSON' } } : await api.handle(req));
        })().catch(() => socket.destroy()).finally(() => { inFlight = false; arm(); });
      };
      socket.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (byteLen(line) > maxRequestBytes) { socket.destroy(); return; }
          if (inFlight) {
            let id = null; try { const q = JSON.parse(line); id = q?.id ?? null; } catch { /* no id */ }
            send({ id, ok: false, error: { code: 'busy', message: 'a request is already in flight on this connection; wait for its response' } });
            continue;
          }
          serve(line);
        }
        if (byteLen(buf) > maxRequestBytes) socket.destroy();
      });
      socket.resume();
    })().catch(() => socket.destroy());
  });
  if (config.max_connections) server.maxConnections = config.max_connections;

  return Object.freeze({
    server,
    async start() {
      const p = config.socket_path;
      const gid = group(config.runner_group);
      const problems = await checkLayout(config, { gid });
      if (problems.length) throw new Error(`layout refused, not listening: ${problems.join('; ').slice(0, 400)}`);
      if (existsSync(p)) {
        if (!lstatSync(p).isSocket()) throw new Error('socket path exists and is not a socket; refusing');
        const live = await new Promise((res) => { const c = net.connect(p); c.once('connect', () => { c.destroy(); res(true); }); c.once('error', () => res(false)); });
        if (live) throw new Error('a gateway is already listening on this socket; refusing');
        unlinkSync(p);
      }
      const prev = process.umask(0o177); // created 0600 from the start; opened to the runner group only after the chown below
      try { await new Promise((res, rej) => { server.once('error', rej); server.listen(p, () => { server.off('error', rej); res(); }); }); } finally { process.umask(prev); }
      try {
        chownSync(p, config.identities.gateway_uid, gid);
        chmodSync(p, 0o660);
        const bad = socketProblems(statFn(p), p, config.identities.gateway_uid, gid);
        if (bad.length) throw new Error(bad.map((x) => x.why).join('; '));
      } catch (e) {
        await new Promise((res) => server.close(() => res()));
        try { unlinkSync(p); } catch { /* already gone */ }
        throw new Error(`socket permissions refused, not serving: ${String(e?.message).slice(0, 300)}`);
      }
      writeFileSync(config.pid_file, `${process.pid}\n`, { mode: 0o600 });
      log('gateway listening on unix socket');
    },
    stop: () => new Promise((res) => { server.close(() => res()); server.closeAllConnections?.(); }),
  });
}
