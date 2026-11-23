// Live smoke test for the OpenRouter builder adapter. FOR KEVIN TO RUN with his own key:
//   OPENROUTER_API_KEY=... npm run builder:smoke
// Runs one tiny, low-risk task against the REAL endpoint in a throwaway clone of this repo
// (public repo only; a :free model is refused for any repo not on FREE_MODEL_REPO_ALLOWLIST).
// Nothing is pushed. Prints the journal summary and exits with the adapter's exit code
// (0 ok, 1 failed, 2 refused/config, 3 rate-limited).
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, ConfigError } from '../src/builder-config.js';
import { runBuilder, EXIT } from '../src/builder-adapter.js';
import { REPO_ROOT } from '../src/self-model.js';

let config;
try { config = loadConfig(); } catch (e) {
  if (!(e instanceof ConfigError)) throw e;
  console.error(`config error: ${e.message}`);
  process.exit(EXIT.REFUSED);
}
if (!config.apiKey) { console.error('OPENROUTER_API_KEY is not set (environment only).'); process.exit(EXIT.REFUSED); }

const dir = mkdtempSync(join(tmpdir(), 'builder-smoke-'));
const git = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe', encoding: 'utf8' }).trim();
execFileSync('git', ['clone', '--quiet', '--no-hardlinks', REPO_ROOT, dir], { stdio: 'pipe' });
// The clone's origin is the local path; a :free model decides from the real git remote, so point origin at
// this repo's own remote URL (nothing is pushed or fetched).
try { git('remote', 'set-url', 'origin', execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: REPO_ROOT, stdio: 'pipe', encoding: 'utf8' }).trim()); } catch { /* no remote: a :free model will be refused */ }
git('checkout', '-q', '-b', `smoke/builder-${Date.now()}`);

const task = {
  repo: 'agent-core',
  workdir: dir,
  goal: 'Create the file docs/builder-smoke.md containing a two-sentence description of what this repository is for (read README.md first). Do not modify any other file.',
  grant: {
    schema_version: '1', task_id: 'builder-smoke',
    scope: { repos: ['agent-core'], paths: ['docs/'] },
    budget: { max_usd: 0.1, max_tool_calls: 8 },
    expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    allowed_risk_tiers: ['low'],
  },
};

console.log(`model: ${config.model}\nendpoint: ${config.base_url}\nthrowaway clone: ${dir}`);
const result = await runBuilder({ config, task });
console.log(result.summary);
console.log(`status: ${result.status}  exit_code: ${result.exit_code}  commit: ${result.commit ?? 'none'}`);
console.log(`journal file: ${result.journal_path}`);
process.exit(result.exit_code);
