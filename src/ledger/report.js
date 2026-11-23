#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultLedgerDir, scanLedgerDir } from './ledger.js';
import { microToUsd } from '../grant/money.js';

const usd = (m) => `${m} micro-USD (${microToUsd(Math.max(m, 0))} USD)`;

/** Format the report lines for a ledger directory. Returns { lines, failed }. Read-only. */
export function buildReport(dir) {
  const lines = [`Ledger directory: ${dir}`];
  if (!existsSync(dir)) { lines.push('No ledger directory yet: nothing has been spent.'); return { lines, failed: false }; }
  const rows = scanLedgerDir(dir);
  if (rows.length === 0) lines.push('No grant ledgers found.');
  let failed = false;
  for (const r of rows) {
    if (!r.ok) { failed = true; lines.push('', `ERROR ${r.file}: ${r.error}`, '  This ledger cannot be trusted; every run on this grant refuses until you fix it by hand.'); continue; }
    const s = r.summary;
    lines.push('', `Grant ${s.key}`,
      `  limit:             ${usd(s.budget_micro)}, ${s.max_tool_calls} tool calls`,
      `  settled:           ${usd(s.settled_micro)}`,
      `  open reservations: ${s.open_reservations} holding ${usd(s.open_micro)}`,
      `  remaining:         ${usd(s.remaining_micro)}, ${s.calls_remaining} tool calls (${s.calls_used} used)`,
      `  runs without run_end: ${s.unended_runs.length ? s.unended_runs.join(', ') : 'none'}`);
  }
  return { lines, failed };
}

if (import.meta.url === `file://${resolve(process.argv[1] ?? '')}`) {
  const i = process.argv.indexOf('--dir');
  const dir = i > 0 && process.argv[i + 1] ? resolve(process.argv[i + 1]) : defaultLedgerDir();
  const { lines, failed } = buildReport(dir);
  console.log(lines.join('\n'));
  if (failed) { console.error('\nledger:report: one or more ledgers failed verification'); process.exit(1); }
}
