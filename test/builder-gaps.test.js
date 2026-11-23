import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { loadConfig } from '../src/builder-config.js';
import { runBuilder, CONTRACT_GAPS } from '../src/builder-adapter.js';
import { validateJournalEntry } from '../src/validators.js';
import { startMock, happyScript, tempRepo, makeGrant, FAKE_KEY } from './builder-mock.js';

// One pattern per known gap. The first 8 are the gaps the builder logged; the next 5 are the ones the reviewers found.
const LOGGED = [
  ['issue kind field', /issue entries have no `kind` field/],
  ['failure entry kind', /no failure entry kind/],
  ['task-spec schema', /no task-spec schema/],
  ['scope.paths semantics', /scope\.paths semantics are unspecified/],
  ['journal in-process only', /in-process only/],
  ['self-model indexing', /indexes only top-level src/],
  ['manifest registry', /no registry or place to publish manifests/],
  ['role concept', /no role concept anywhere in the contract/],
];
const REVIEWER = [
  ['max_usd unenforced', /max_usd is required but the contract defines no metering/],
  ['expires_at start-only', /expires_at is checked once at run start/],
  ['risk tiers only low', /allowed_risk_tiers has no defined meaning/],
  ['ad-hoc scope strings', /scopes are free-form strings with no vocabulary/],
  ['refusal and truncation', /refusal and a truncated response have no representation/],
];

const SELF_MODEL = [['self-model capabilities field', /no field for adapter capabilities/]];

test('runtime journal carries all 8 logged gaps, the 5 reviewer gaps and the self-model capabilities gap as contract-gap issues', async () => {
  const dir = tempRepo();
  const mock = await startMock((_r, n) => happyScript(n));
  try {
    const config = loadConfig({ env: { OPENROUTER_API_KEY: FAKE_KEY, AGENT_BUILDER_BASE_URL: mock.url }, cwd: tmpdir() });
    const result = await runBuilder({ config, task: { repo: 'agent-core', goal: 'Write docs/hello.md', grant: makeGrant(), workdir: dir } });
    const gaps = result.entries.filter((e) => e.kind === 'issue' && e.description.startsWith('[kind: contract-gap]'));
    for (const e of gaps) assert.equal(validateJournalEntry(e).valid, true);
    for (const [name, re] of [...LOGGED, ...REVIEWER, ...SELF_MODEL]) {
      assert.equal(gaps.filter((e) => re.test(e.description)).length, 1, `gap not journaled exactly once: ${name}`);
    }
    assert.equal(gaps.length, CONTRACT_GAPS.length);
    assert.equal(gaps.length, 14);
  } finally { await mock.close(); }
});

test('every declared gap names a file and a reason, and no two are identical', () => {
  assert.ok(CONTRACT_GAPS.every((g) => g.file && g.reason));
  assert.equal(new Set(CONTRACT_GAPS.map((g) => g.reason)).size, CONTRACT_GAPS.length);
});
