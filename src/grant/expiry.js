/**
 * Strict grant expiry. Accepts only ISO-8601 date-time with an explicit offset: YYYY-MM-DDTHH:MM:SS[.f{1,9}](Z|+hh:mm|-hh:mm),
 * upper-case T and Z, no padding, no locale strings, no local time. The calendar value must be real (no Feb 30, month 13, hour 25).
 * Date.parse is only called on a string that already passed the pattern and the range checks.
 */
const PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysIn = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];

/** Epoch milliseconds for a strict expiry string, or NaN if it is anything else. Never throws. */
export function parseExpiry(value) {
  if (typeof value !== 'string' || value.length > 40) return NaN;
  const m = PATTERN.exec(value);
  if (!m) return NaN;
  const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
  if (y < 1000 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo) || h > 23 || mi > 59 || s > 59) return NaN;
  const off = m[7];
  if (off !== 'Z') {
    const oh = Number(off.slice(1, 3)); const om = Number(off.slice(4, 6));
    if (oh > 23 || om > 59) return NaN;
  }
  return Date.parse(value);
}
