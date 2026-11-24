import net from 'node:net';

/** One request over the gateway socket. Resolves with the parsed response; rejects on connection close or timeout. */
export function request(socketPath, method, params = {}, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const c = net.connect(socketPath);
    let buf = '';
    const t = setTimeout(() => { c.destroy(); reject(new Error('gateway request timed out')); }, timeoutMs);
    c.setEncoding('utf8');
    c.once('error', (e) => { clearTimeout(t); reject(e.code === 'EPIPE' || e.code === 'ECONNRESET' ? new Error('gateway closed the connection (refused or unavailable)') : e); });
    c.once('close', () => { clearTimeout(t); reject(new Error('gateway closed the connection (refused or unavailable)')); });
    c.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { clearTimeout(t); try { resolve(JSON.parse(buf.slice(0, i))); } catch (e) { reject(e); } c.destroy(); } });
    c.once('connect', () => c.write(JSON.stringify({ id: 1, method, params }) + '\n'));
  });
}

/** Just open and close a connection: is something accepting on this socket path? */
export const canConnect = (socketPath, timeoutMs = 3000) => new Promise((resolve) => {
  const c = net.connect(socketPath);
  const t = setTimeout(() => { c.destroy(); resolve(false); }, timeoutMs);
  c.once('connect', () => { clearTimeout(t); c.destroy(); resolve(true); });
  c.once('error', () => { clearTimeout(t); resolve(false); });
});
