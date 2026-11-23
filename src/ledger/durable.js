import { openSync, closeSync, writeSync, fsyncSync } from 'node:fs';
import { LedgerError } from './format.js';

/** The real file operations. Callers may inject replacements (tests do) through `io`; production never does. */
export const realIo = Object.freeze({ writeSync, fsyncSync });

const MAX_STALLS = 3;

/**
 * Write every byte of `data` to fd. A short write is retried for the remainder; a write that makes no progress
 * MAX_STALLS times in a row, returns something impossible, or throws, refuses. Never returns with bytes unwritten.
 */
export function writeAll(fd, data, io = realIo) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  let off = 0; let stalls = 0;
  while (off < buf.length) {
    const n = io.writeSync(fd, buf, off, buf.length - off);
    if (!Number.isSafeInteger(n) || n < 0 || n > buf.length - off) throw new LedgerError('ledger', 'ledger write returned an impossible byte count; refusing');
    if (n === 0) { stalls += 1; if (stalls >= MAX_STALLS) throw new LedgerError('ledger', `ledger short write: ${off} of ${buf.length} bytes written and no progress; the ledger file may end in a partial line and will refuse until repaired by hand`); } else { stalls = 0; off += n; }
  }
  return off;
}

/** fsync a directory so a file created or renamed in it survives power loss. */
export function fsyncDir(dir, io = realIo) {
  const fd = openSync(dir, 'r');
  try { io.fsyncSync(fd); } finally { closeSync(fd); }
}
