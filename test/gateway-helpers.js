import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, defaultConfig } from '../src/gateway/config.js';
import { createFileLedgerStore } from '../src/gateway/store.js';
import { createRunStore } from '../src/gateway/runs.js';
import { loadCredentials } from '../src/gateway/credentials.js';
import { createGatewayApi } from '../src/gateway/api.js';
import { parsePriceTable, loadPriceTable } from '../src/grant/index.js';
import { createSpendSink } from '../src/grant/index.js';
import { makeRedactor } from '../src/gateway/credentials.js';
import { startMock, FAKE_KEY, makeGrant } from './builder-mock.js';

export { startMock, FAKE_KEY, makeGrant };

/** A fresh temp AGENT_HOME with a valid config pointing provider "mockprov" at `baseUrl`, and a 0600 credential file. */
export function tempHome({ baseUrl = 'http://127.0.0.1:9/v1', allowed, withCredentials = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'gw-home-'));
  const uid = process.getuid();
  const raw = defaultConfig({ gatewayUid: uid, runnerUid: uid });
  raw.providers = { mockprov: { base_url: baseUrl } };
  if (allowed) raw.allowed_peer_uids = allowed;
  writeFileSync(join(home, 'config.json'), JSON.stringify(raw), { mode: 0o600 });
  if (withCredentials) writeFileSync(join(home, 'credentials.json'), JSON.stringify({ providers: { mockprov: FAKE_KEY } }), { mode: 0o600 });
  mkdirSync(join(home, 'runs'), { recursive: true, mode: 0o700 });
  return { home, raw, config: loadConfig(home).config };
}

/** Build the gateway API against a temp home. `priceTable` defaults to the tracked (empty) config/prices.json. */
export function makeApi({ home, config, priceTable, fetchFn, now, logs = [] } = {}) {
  const credentials = loadCredentials(config.credentials_file);
  const redact = makeRedactor(credentials.secrets());
  const table = priceTable ?? loadPriceTable().table;
  const store = createFileLedgerStore(config.ledger_dir, now ? { now } : {});
  const runs = createRunStore(config.runs_dir, now ? { now } : {});
  const api = createGatewayApi({ config, store, runs, credentials, priceTable: table, fetchFn, now, log: (l) => logs.push(l), makeSink: (id) => createSpendSink(join(config.runs_dir, `${id}.spend.jsonl`), redact) });
  return { api, store, runs, credentials, logs };
}

export const chatOk = (content = 'hi', usage = { prompt_tokens: 100, completion_tokens: 5 }) => ({ status: 200, body: { choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage } });

/** All files under a directory (recursive) with their text, for secret scans. */
export function allFiles(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...allFiles(p)); else out.push({ path: p, text: readFileSync(p, 'utf8') });
  }
  return out;
}

export const PAID_TABLE = parsePriceTable({ schema_version: '1', models: { 'mockprov|paid/model': { input_micro_per_mtok: 1_000_000, output_micro_per_mtok: 1_000_000 } } });
export const FREE_MODEL = 'vendor/m:free';
