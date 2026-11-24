import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, unlinkSync, chmodSync, chownSync, writeFileSync, readFileSync } from 'node:fs';
import { checkRealLayout, realStat, socketProblems } from './layout.js';
import { resolveGroup, processInfo, isGatewayCmdline } from './sys.js';
import { discoveryPath, writeDiscovery, removeDiscovery } from './discovery.js';

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
export function createGatewayServer({ api, config, getPeerUid, log = () => {}, checkLayout = checkRealLayout, group = resolveGroup, statFn = realStat, procInfo = processInfo, idleMs = config.idle_timeout_ms ?? 30_000, maxRequestBytes = config.max_request_bytes ?? MAX_LINE, readTimeoutMs = config.request_read_timeout_ms ?? 10_000, shutdownGraceMs = config.shutdown_grace_ms ?? 10_000, instanceId = api.instanceId ?? randomBytes(16).toString('hex') }) {
  const byteLen = (s) => Buffer.byteLength(s, 'utf8');
  const conns = new Map(); // socket -> { inFlight } : this server's own connection set
  let stopping = false;
  const server = net.createServer({ allowHalfOpen: false, pauseOnConnect: true }, (socket) => {
    const st = { inFlight: false };
    conns.set(socket, st);
    socket.once('close', () => conns.delete(socket));
    if (stopping) { socket.destroy(); return; }
    (async () => {
      if (getPeerUid) {
        let uid;
        try { uid = await getPeerUid(socket); } catch { uid = null; }
        if (!peerAllowed(config.allowed_peer_uids, uid)) { log('connection refused: peer not allowlisted'); socket.destroy(); return; }
      }
      if (socket.destroyed) return;
      let buf = ''; let readTimer = null;
      const stopReadTimer = () => { if (readTimer) { clearTimeout(readTimer); readTimer = null; } };
      // The idle timeout counts only quiet time between requests. While a request is being served no timer runs, so a slow provider call is never cut off.
      const arm = () => { if (!socket.destroyed) socket.setTimeout(idleMs); };
      // The read timeout runs from the first byte of a request line to its newline, so a client that drips bytes cannot hold the slot. It never runs while a request is being served.
      const watchRead = () => {
        if (buf.length === 0 || st.inFlight || socket.destroyed) { stopReadTimer(); return; }
        if (!readTimer) readTimer = setTimeout(() => { log('connection dropped: request line not completed in time'); socket.destroy(); }, readTimeoutMs);
      };
      socket.on('timeout', () => { if (!st.inFlight) socket.destroy(); });
      socket.once('close', stopReadTimer);
      arm();
      socket.setEncoding('utf8');
      socket.on('error', () => socket.destroy());
      const send = (res) => { if (!socket.destroyed) socket.write(JSON.stringify(res) + '\n'); };
      const serve = (line) => {
        st.inFlight = true; socket.setTimeout(0); stopReadTimer();
        (async () => {
          let req;
          try { req = JSON.parse(line); } catch { req = null; }
          send(req === null ? { id: null, ok: false, error: { code: 'invalid_request', message: 'request is not valid JSON' } } : await api.handle(req));
        })().catch(() => socket.destroy()).finally(() => {
          st.inFlight = false;
          if (stopping) { if (!socket.destroyed) socket.end(); return; } // the answer is flushed, then this connection is done
          arm(); watchRead();
        });
      };
      socket.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          if (byteLen(line) > maxRequestBytes) { socket.destroy(); return; }
          if (st.inFlight) {
            let id = null; try { const q = JSON.parse(line); id = q?.id ?? null; } catch { /* no id */ }
            send({ id, ok: false, error: { code: 'busy', message: 'a request is already in flight on this connection; wait for its response' } });
            continue;
          }
          if (stopping) {
            send({ id: null, ok: false, error: { code: 'shutting_down', message: 'the gateway is shutting down; refusing new requests' } });
            socket.end(); return;
          }
          serve(line);
        }
        if (byteLen(buf) > maxRequestBytes) { socket.destroy(); return; }
        watchRead();
      });
      socket.resume();
    })().catch(() => socket.destroy());
  });
  if (config.max_connections) server.maxConnections = config.max_connections;

  const dFile = discoveryPath(config.socket_dir);
  /** Synchronous and idempotent: safe to call from an 'exit' handler. Removes the pid file, the socket and the discovery file if they are ours. */
  const cleanupSync = () => {
    try { if (Number(readFileSync(config.pid_file, 'utf8').trim()) === process.pid) unlinkSync(config.pid_file); } catch { /* none, or not ours */ }
    try { if (server.listening || ownsSocket) { if (lstatSync(config.socket_path).isSocket()) unlinkSync(config.socket_path); } } catch { /* already gone */ }
    removeDiscovery(dFile, instanceId);
  };
  let ownsSocket = false;
  const destroyAll = () => { for (const s of conns.keys()) s.destroy(); };
  let stopP = null; let finishStop = null;

  return Object.freeze({
    server,
    instanceId,
    connectionCount: () => conns.size,
    cleanupSync,
    async start() {
      const p = config.socket_path;
      const gid = group(config.runner_group);
      const problems = await checkLayout(config, { gid });
      if (problems.length) throw new Error(`layout refused, not listening: ${problems.join('; ').slice(0, 400)}`);
      // A pid file is a claim, not proof: it blocks startup only if that pid is alive AND is a gateway. A stale one is replaced below.
      if (existsSync(config.pid_file)) {
        let old = null; try { old = Number(readFileSync(config.pid_file, 'utf8').trim()); } catch { /* unreadable: treat as stale */ }
        const info = Number.isSafeInteger(old) && old > 0 && old !== process.pid ? procInfo(old) : null;
        if (info && isGatewayCmdline(info.cmdline)) throw new Error(`a gateway is already running (pid ${old}); refusing`);
      }
      if (existsSync(p)) {
        if (!lstatSync(p).isSocket()) throw new Error('socket path exists and is not a socket; refusing');
        const live = await new Promise((res) => { const c = net.connect(p); c.once('connect', () => { c.destroy(); res(true); }); c.once('error', () => res(false)); });
        if (live) throw new Error('a gateway is already listening on this socket; refusing');
        unlinkSync(p);
      }
      const prev = process.umask(0o177); // created 0600 from the start; opened to the runner group only after the chown below
      try { await new Promise((res, rej) => { server.once('error', rej); server.listen(p, () => { server.off('error', rej); res(); }); }); } finally { process.umask(prev); }
      ownsSocket = true;
      try {
        chownSync(p, config.identities.gateway_uid, gid);
        chmodSync(p, 0o660);
        const bad = socketProblems(statFn(p), p, config.identities.gateway_uid, gid);
        if (bad.length) throw new Error(bad.map((x) => x.why).join('; '));
        writeDiscovery(dFile, { socket_path: p, instance_id: instanceId, gateway_uid: config.identities.gateway_uid, gateway_gid: typeof process.getgid === 'function' ? process.getgid() : gid, pid: process.pid }, { uid: config.identities.gateway_uid, gid });
      } catch (e) {
        await new Promise((res) => server.close(() => res()));
        try { unlinkSync(p); } catch { /* already gone */ }
        removeDiscovery(dFile, instanceId);
        throw new Error(`socket permissions refused, not serving: ${String(e?.message).slice(0, 300)}`);
      }
      writeFileSync(config.pid_file, `${process.pid}\n`, { mode: 0o600 });
      log('gateway listening on unix socket');
    },
    /**
     * Graceful stop: stop accepting, drop idle connections at once, let in-flight requests finish for up to shutdownGraceMs, then destroy what is left.
     * `{ force: true }` (the second signal) destroys everything now. Either way the pid file, the socket and the discovery file are removed.
     * A call cut off here keeps its ledger reservation: nothing in this module settles or releases anything.
     */
    stop({ force = false } = {}) {
      if (force) {
        try { server.close(); } catch { /* not running */ }
        destroyAll(); cleanupSync();
        if (finishStop) finishStop();
        return stopP ?? Promise.resolve();
      }
      if (stopP) return stopP;
      stopping = true;
      stopP = new Promise((res) => {
        let timer = null; let done = false;
        const finish = () => { if (done) return; done = true; clearTimeout(timer); destroyAll(); cleanupSync(); res(); };
        finishStop = finish;
        // Done only when every connection has ended AND every detached provider call has persisted its outcome (a client that hung up mid-call
        // does not end the call). A call still running at the deadline is left reserved; a retry after restart is answered as "outcome unknown".
        const closed = new Promise((r) => server.close(() => r()));
        Promise.all([closed, Promise.resolve().then(() => api.drain?.()).catch(() => {})]).then(() => finish());
        for (const [s, st] of conns) if (!st.inFlight) s.destroy();
        timer = setTimeout(finish, shutdownGraceMs);
      });
      return stopP;
    },
  });
}
