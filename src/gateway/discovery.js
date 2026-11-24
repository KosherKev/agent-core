import { readFileSync, writeFileSync, chownSync, chmodSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/** The gateway's discovery file: lets a client tell the REAL gateway from a socket somebody else put at the same path. */
export const DISCOVERY_NAME = 'gateway.json';
export const discoveryPath = (socketDir) => join(socketDir, DISCOVERY_NAME);
const isId = (n) => Number.isSafeInteger(n) && n >= 0;

/** Parse and validate a discovery document. Returns the document, or null for anything malformed (callers fail closed). */
export function parseDiscovery(text) {
  let d; try { d = JSON.parse(text); } catch { return null; }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  if (typeof d.socket_path !== 'string' || !d.socket_path || d.socket_path.length > 1024) return null;
  if (typeof d.instance_id !== 'string' || !/^[0-9a-f]{32}$/.test(d.instance_id)) return null;
  if (!isId(d.gateway_uid) || !isId(d.gateway_gid) || !Number.isSafeInteger(d.pid) || d.pid < 1) return null;
  return { socket_path: d.socket_path, instance_id: d.instance_id, gateway_uid: d.gateway_uid, gateway_gid: d.gateway_gid, pid: d.pid };
}

export function readDiscovery(path) { try { return parseDiscovery(readFileSync(path, 'utf8')); } catch { return null; } }

/** Write atomically: created 0600, handed to the gateway user and the runner group, then opened to 0640 and renamed into place. */
export function writeDiscovery(path, doc, { uid, gid }) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(doc) + '\n', { mode: 0o600 });
  try { chownSync(tmp, uid, gid); chmodSync(tmp, 0o640); renameSync(tmp, path); } catch (e) { try { unlinkSync(tmp); } catch { /* gone */ } throw e; }
}

/** Remove the discovery file only if it still names this instance. */
export function removeDiscovery(path, instanceId) {
  try { if (readDiscovery(path)?.instance_id === instanceId) unlinkSync(path); } catch { /* none */ }
}
