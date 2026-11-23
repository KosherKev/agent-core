# LOG

## 2026-11-23 (Meter cost and expiry fixes)

### What was done
- Cost rule (commit 2a563c6, `src/grant/meter.js` `settle`): for a paid model the settled cost is the higher of the provider-reported `usage.cost` and the cost computed from `usage` tokens and the price table. A reported 0, negative, non-finite, non-numeric or null cost is never trusted below computed (malformed values are dropped). Missing or unusable usage settles at the full reservation, even if a cost was reported (a reported cost with no token counts cannot be checked against the price table). `:free` models unchanged (valid reported cost, else 0). Spend-record `source` is `provider` when reported >= computed, else `computed`.
- Strict expiry (commit 7ce6f7a): new `src/grant/expiry.js` `parseExpiry`. Confirmed first: the meter used `Date.parse` directly, which accepts locale strings and reads an offset-less timestamp as host-local time; the adapter preflight also used bare `Date.parse` (only the grant schema's `date-time` format check stood in front of both). Now both call `parseExpiry`: strict pattern `YYYY-MM-DDTHH:MM:SS[.f{1,9}](Z|+hh:mm|-hh:mm)`, upper-case `T`/`Z`, no padding, then explicit calendar range checks (month, days per month incl. leap years, hour 0-23, minute and second 0-59, offset hours 0-23 and minutes 0-59, year 1000-9999) before `Date.parse` on the validated string. Anything else refuses: meter `GrantError('grant')`, adapter preflight exit 2 before any network call. Past expiry at preflight still refuses.
- Existing tests adjusted for the new rule: two tests settled a reported cost with no token counts (now worst case); they now include token counts.
- Schema, guard, validators, acceptance, workflows, price table contents untouched.

### Commands run and results (with counts)
- Baseline f266fc5: 288 tests, 288 pass.
- After commit 1 (cost): Node 24.22.3 296 tests, 296 pass (8 new).
- After commit 2 (expiry), final: Node 24.22.3: `npm test` 303 tests, 303 pass, 0 fail, 0 skipped. Node 22.23.5: 303 tests, 303 pass, 0 fail, 0 skipped. 15 new tests in total.
- `npm run build` clean (self-model unchanged); `npm run check:self-model` passes; `npm audit --omit=dev` found 0 vulnerabilities. No new dependencies.
- Fail-before proof: the new `test/grant-meter.test.js` and `test/grant-adapter.test.js` run against an unmodified f266fc5 source copy (scratch dir, since removed): 6 failed, including "cost: a reported cost of 0 on a paid model settles at the computed cost", "cost: missing usage still settles at the worst-case reservation even with a reported cost", and the expiry tests for no offset, date-only, locale string and calendar-invalid date. They pass on this branch. The padded-string and preflight zero-request tests pass on f266fc5 too, because the grant schema check already refused those; the new tests lock that in at the meter and adapter level.

### Decisions and why
- SUPERSEDED: the earlier decision "Provider-reported cost is trusted over computed cost (the stated order of trust), including a reported 0" is replaced by: higher of reported and computed wins; a reported cost is never trusted below computed (Kevin's decision, 2026-11-23).
- A numeric-looking string reported cost (for example "0.003") is still parsed; if higher than computed it is honoured, otherwise computed wins. Non-numeric strings are dropped.
- Restrictive choices on expiry: leap second (:60) refused, lower-case `t`/`z` refused, years before 1000 refused, fractions beyond milliseconds truncated by `Date.parse` (rounds the expiry down, which is the safe direction).
- `parseExpiry` is exported from `src/grant/index.js` and used by the adapter so there is a single parser.

### What is NOT enforced after this task
- Spend is only as good as the price table and provider data; no reconciliation against the provider's account.
- Per-run budget only: meter state is in memory per run, the budget is per run, not per grant across runs. Two runs on the same grant each get the full budget. There is no shared ledger (a later spec).
- Only `budget.max_usd`, `budget.max_tool_calls` and `expires_at` are metered; `scope` and risk tiers are not.
- A provider that reports a cost lower than the truth AND omits token counts is settled at worst case; one that reports plausible token counts but lies about them is only as safe as those counts.
- The meter cannot stop a request already in flight; the host clock is trusted (only a backwards jump over 1 s is caught).
- The guard workflow on a real PR is unverified here.

### CHANGED LOCKED PATHS (expected: none)
- None. `git diff --name-only origin/main...HEAD` lists only LOG.md, README.md, config/prices.json, src/builder-adapter.js, src/builder-confine.js, src/grant/*, test/*; nothing under `acceptance/`, `.github/`, `schemas/`, nor `CODEOWNERS` or `src/validators.js`. (Local `main` is stale; origin/main is used as the base. This round touched `src/grant/` as the spec allows, plus `src/builder-adapter.js` for the preflight parse, and the two grant test files.)

### Not verified
- The CI guard on a real PR; any paid model against a real provider; `builder:smoke` (out of scope).

### Open questions for Kevin
- `src/builder-adapter.js` also changed (preflight now calls `parseExpiry`). It is not a locked path; consider locking it with `src/grant/`.
- Should a reported cost with no token counts on a paid model ever be honoured when it is above zero but below the reservation? Settled at the worst case for now (more restrictive).

## 2026-11-23 (Grant metering and expiry)

### What was done
- New `src/grant/` (lock as one unit): `meter.js` (`createMeter`, `GrantError`, `isMeter`), `money.js` (integer micro-USD, BigInt-exact, decimal-string conversion), `prices.js` (price table parser/loader, `:free` = 0), `spend-log.js` (append-only sidecar sink), `index.js`.
- `config/prices.json`: tracked price table (`schema_version "1"`, per model `input_micro_per_mtok` / `output_micro_per_mtok`). It ships with NO paid models, so every paid model is refused until Kevin adds a price he trusts.
- Meter: the grant is deep-copied and deep-frozen on entry; no setter exists; the meter object is frozen. `reserve(call)` checks expiry, prices the worst case (input tokens estimated as UTF-8 bytes of the serialised request, an upper bound, plus `max_tokens`), clamps `max_tokens` to the largest value that fits the remaining budget (exact integer search) or refuses. `settle` uses provider-reported `usage.cost`, else tokens x price, else (paid model, no usable usage) the full reservation. `release` returns a reservation at zero when the provider rejected the request with an HTTP error. `checkTool()` checks expiry then counts against `budget.max_tool_calls`. `checkExpiry()` refuses at or after `expires_at` and when the clock moves back by more than 1000 ms (or is non-finite). Any internal error becomes a refusal.
- Adapter: `callModel` (the only function that reaches the endpoint) and `dispatchTool` (the only code that reads or writes the worktree) both require a real meter (`isMeter`, a WeakSet brand). `runBuilder` builds the meter in preflight from the run's own grant; a grant the meter cannot use, an unpriced paid model, or no run directory for the spend record all refuse (exit 2) before any network call. Requests now carry `max_tokens` (clamped) and `usage: {include: true}`.
- Stop behaviour: any meter refusal mid-run commits work so far, journals an `attempt` (blocked) and an `issue` of kind `grant-exceeded` (limit name and numbers) and exits with the NEW exit code `EXIT.GRANT_EXCEEDED = 4` (status `grant-exceeded`). Rate limit stays 3.
- Spend record: the run-journal schema has no entry kind that can hold structured spend, so every reserve/settle/release is appended to `.agent-runs/<run_id>.spend.jsonl` (one JSON line each, `appendFileSync` with the `a` flag, key-redacted), referenced from the journal by an `attempt`, and a 15th `contract-gap` issue is logged. The schema was NOT edited.
- Write protection: `ALWAYS_LOCKED` in `src/builder-confine.js` now also covers `src/grant/`, `config/`, `grant.json`, `grants/`, `fixtures/grant/` (case, unicode and symlink folding as for the other entries).
- README exit-code line updated. The two stale contract-gap texts (max_usd unenforced, expiry start-only) were reworded, keeping their original match phrases.

### Commands run and results (with counts)
- Baseline on origin/main (84bd114), Node 24: `npm test` 258 tests, 258 pass.
- After the change, Node 24.22.3: `npm test` 288 tests, 288 pass, 0 fail, 0 skipped.
- After the change, Node 22.23.5: `npm test` 288 tests, 288 pass, 0 fail, 0 skipped.
- New tests: 30 (15 in `test/grant-meter.test.js`, 15 in `test/grant-adapter.test.js`). Existing tests changed: the old "tool calls beyond max_tool_calls" test now expects exit 4 and the new issue; the gaps test expects 15 gaps; test helpers pass a test price table (`TEST_PRICES` in `test/builder-mock.js`) to runs that use fake paid model ids. No tests skipped or removed.
- `npm run build` clean (self-model unchanged); `npm run check:self-model` passes; `npm audit --omit=dev` 0 vulnerabilities. No new dependencies.
- `git diff --name-only origin/main...HEAD` touches nothing under `acceptance/`, `.github/`, `schemas/`, nor `CODEOWNERS`, `src/validators.js`.
- Every item-6 test exists under its own name: reservation refuses over budget; `max_tokens` clamped; settle provider vs computed; missing usage settles at worst case; budget exhausted mid-run exit 4; expiry mid-run (tool call and model call); clock backwards (meter and adapter); unknown paid model zero requests; `:free` still enforces tool calls and expiry; no way to mutate the grant; write tools refuse the grant file, price table and meter; float-rounding sum; key never in spend record. Plus the structural test (grep-based: one `fetchFn(` call site inside `requestModel`, reached only via `callModel`; no other source file can reach the network; filesystem tool operations only inside `dispatchTool` after `meter.checkTool()`) and a behavioural test (fake or prototype-forged meters make no request and run no tool).

### Decisions and why (restrictive choices made without asking)
- Empty price table: no paid model priced, rather than guessing real prices. A wrong price silently weakens the budget.
- Input tokens estimated as bytes (upper bound), so budgets are conservative; real usage will be well under the reservation.
- Budget `max_usd` is rounded DOWN to micro-USD; every cost is rounded UP.
- Network error or timeout settles at the worst-case reservation (the request may have been billed). HTTP error responses release at zero (the provider rejected the request). Each 429 retry reserves and releases again.
- If the spend record cannot be written, the run refuses (mid-run: the meter refuses); no unaudited spend.
- (SUPERSEDED 2026-11-23, see the cost and expiry fixes section above: the higher of reported and computed cost now wins; a reported cost is never trusted below computed.) Provider-reported cost is trusted over computed cost (the stated order of trust), including a reported 0.
- Every mid-run meter refusal (including clock backwards, internal error) uses exit 4, not 2; preflight refusals use exit 2.
- Default `max_tokens` per call is 8192 (`DEFAULT_MAX_OUTPUT_TOKENS`); this now also applies to `:free` models, which previously sent no `max_tokens`.
- Locked the whole of `config/` and `fixtures/grant/` for builder writes, broader than the two files named in the spec.
- Only the grant's own `expires_at`, `max_usd`, `max_tool_calls` are used; no grant fields invented.

### What is NOT enforced after this task
- Spend is only as good as the price table and provider data: there is no independent check of what OpenRouter actually bills, and no reconciliation against the provider's account.
- Only `budget.max_usd`, `budget.max_tool_calls` and `expires_at` are metered. `scope`, `allowed_risk_tiers` and per-capability risk tiers are not (see earlier gaps).
- Meter state is in memory per run: the budget is per run, not per grant across runs. Two runs on the same grant each get the full budget. There is no shared ledger (out of scope).
- The meter cannot stop a request already in flight; a single in-flight call can cost up to its reservation.
- Wall-clock expiry relies on the host clock; only a backwards jump over 1 s is caught. A forward jump just expires the grant early.
- The meter protects the builder adapter only. Nothing stops other code from calling the endpoint; the structural test covers `src/` only, and a future edit that adds a path can still pass if it also keeps those strings.
- Locking `src/grant/`, `config/` is enforced for the adapter's write tools and (after Kevin's step below) by the CI guard; until Kevin adds them to `.github/locked-paths.txt`, a human or another tool can still edit them without a CI failure.
- `src/grant/` is not listed in `self-model.json` (the generator indexes only top-level `src/*.js`).
- No paid model has ever been run; paid-model reconciliation is untested against a real provider.

### CONTRACT GAPS
- Run journal cannot hold structured spend (new, journaled at runtime as the 15th `contract-gap`; sidecar used instead, schema not edited).
- The grant schema defines `max_usd` as a JSON number (float); the meter converts through decimal text, but a decimal string or integer micro-USD field would be safer. Not changed.
- Self-model generator ignores subdirectories of `src/`.
- Existing gaps from Spec C (role, risk tiers, scope vocabulary, refusal/truncation, self-model capabilities) are untouched, as specified.

### CHANGED LOCKED PATHS (expected: none)
- None. `git diff --name-only origin/main...HEAD` lists only `config/prices.json`, `src/builder-adapter.js`, `src/builder-confine.js`, `src/grant/*`, `test/*`, `README.md`, `LOG.md`. (`src/builder-confine.js` is not a locked path today but holds the adapter's lock list; review it with the same care.)

### Files for Kevin to lock by hand after review
- `src/grant/` (whole directory)
- `config/prices.json` (or all of `config/`)
- Consider also `src/builder-confine.js` (it holds `ALWAYS_LOCKED`) and `src/builder-adapter.js` (the chokepoint), and `test/grant-meter.test.js`, `test/grant-adapter.test.js` so the structural test cannot be loosened by the builder.
- Add them to `.github/locked-paths.txt` and CODEOWNERS (not edited here).

### Not verified (guard on a real PR, live endpoint)
- The `protect-locked-paths` workflow on a real PR (cannot run here).
- Any live OpenRouter call, real usage/`cost` response shape, and `builder:smoke` (not run). The `usage.cost` field and `usage: {include: true}` request flag follow OpenRouter's documented usage accounting but were only exercised against the local mock.

### Open questions for Kevin
- Which paid models, and at what prices, should go in `config/prices.json`? It is empty on purpose.
- Should the budget be per grant across runs (needs a shared ledger) instead of per run?
- Should `max_usd` in the grant schema become a decimal string or integer micro-USD?
- Should a reported provider cost of 0 on a paid model be trusted (current) or treated as suspect and settled at computed cost?
- Should mid-run clock-backwards and meter-internal errors be exit 4 (current) or 2?

### Run-journal issues raised
- `grant-exceeded` (risk/high): one per stopped run, with limit name (`budget`, `tool_calls`, `expiry`, `clock`) and numbers.
- `contract-gap`: 15 per run now (14 existing, plus spend-record sidecar).
- Existing kinds unchanged: `rate-limit`, `refusal`, `truncation`, `malformed-tool-calls`.

## 2026-11-23 (Spec C parity test and adapter fold fix)
- Files touched: src/builder-confine.js, src/builder-adapter.js, test/builder-confine.test.js, test/builder-readdeny.test.js, LOG.md
- What changed: fixed the red parity test on main (PR #4 merged with `test/builder-confine.test.js` "shared corpus" pinning the old guard's gap with a `deepEqual` on the adapter-only list; with the hardened guard that list is empty, so main failed 1 of 256 tests). The test now asserts parity both ways (`adapterOnly` and `guardOnly` both `[]`) and has four new hostile spellings (long-s CODEOWNERS, `sub/.GitAttributes`, `.git~1/x`, `a/.gitmodules`). `foldSegment` now folds exactly like the guard (`toUpperCase().toLowerCase()` before the final NFC), closing the long s (U+017F) and sharp s gap, with a test that a write to the long-s CODEOWNERS spelling is refused. `list_dir` now accepts the repository root (`.`, `./`, empty) for listing only, via a `confine` option `allowRoot` that is ignored when `write` is set; secrets and git internals stay hidden; test through the mock adapter. One existing list_dir test used a prefix match on `.git` that would now false-match `.github`; changed to an exact-name check.
- Acceptance criteria (pass/fail each):
  - parity test asserts adapterOnly == [] and guardOnly == [] with the new entries: PASS
  - foldSegment matches the guard; long-s CODEOWNERS write refused; case/NFC/NFD tests still pass: PASS
  - list_dir on root returns entries with no .git and no denylisted names; root writes refused: PASS
  - full suite green on Node 24 and Node 22, check:self-model and audit clean: see Status
- Deviations: the parity test commit alone is red on its long-s entry until the fold commit lands (one commit per issue as specified). The `list_dir` root test also covers the empty-string path, beyond `.` and `./`.
- Status: complete on branch task/spec-c-parity-fix, awaiting review. Not merged, no PR. Nothing under .github/ or acceptance/ touched; `builder:smoke` not run.
- Next step: Kevin opens the PR and reviews.

## 2026-11-23
- Files touched: package.json, package-lock.json, .gitignore, schemas/v1/*.schema.json (5), src/{validators,journal,self-model}.js, scripts/build-self-model.js, self-model.json, fixtures/** (5 schemas, valid+invalid), test/*.test.js, acceptance/{README.md,contracts.test.js}, docs/adr/0001-0005, .github/{CODEOWNERS,locked-paths.txt,scripts/locked-paths.mjs,workflows/protect-locked-paths.yml}, README.md, LOG.md
- What changed: new repo structure; versioned (v1) JSON Schemas with ajv validators for capability manifest, extension request, run journal entry (reservation/attempt/issue), grant, self-model; append/read-only journal API; deterministic self-model generator with staleness check; one ADR per contract; locked acceptance suite skeleton with CODEOWNERS and a CI workflow that fails agent-authored changes to locked paths; README (seven seams).
- Acceptance criteria (pass/fail each):
  - (a) valid and invalid fixtures for every schema, all behave: PASS
  - (b) manifest without undo rejected: PASS
  - (c) journal has no edit/delete through the API: PASS
  - (d) acceptance-suite paths protected in CI: PASS (workflow written and its logic unit-tested and exercised locally; the workflow itself has not run on GitHub)
  - (e) one ADR per contract: PASS (5 contracts, 5 ADRs)
  - (f) README explains the seven seams: PASS
  - (g) LOG.md updated: PASS
  - (h) tests and build pass: PASS (67 tests, 0 failures; `npm run build` and `npm run check:self-model` succeed)
- Deviations:
  - The spec never lists "seven seams". They were inferred as: capability manifest, extension request, run journal, grant, self-model, locked acceptance suite, overseer/gate boundary (R2/R4). The last is documented only; no code.
  - This branch itself changes locked paths (it creates them), so the CI guard will fail this agent-authored PR by design; Kevin reviews and merges it as the human exception.
  - Locked paths are `acceptance/` and `.github/`. Schemas are not locked.
  - "Agent-authored" is detected by head branch prefix task/ or agent/, bot actor, or an `agent-authored` label. Branch protection requiring the check and CODEOWNERS review must be enabled in GitHub settings by Kevin.
  - ajv strict mode is on except `strictRequired`, which is off so `anyOf: [{required}]` can express the undo rule.
  - ajv pinned at 8.20.0 (8.17.1 had an npm audit advisory; not exploitable here as `$data` is unused).
- Status: complete on branch task/contracts-and-schemas, awaiting review. Not merged.
- Next step: Kevin reviews and merges; enable branch protection and CODEOWNERS review.

## 2026-11-23 (guard and schema fixes)
- Files touched: .github/scripts/locked-paths.mjs, .github/workflows/protect-locked-paths.yml, schemas/v1/{capability-manifest,extension-request}.schema.json, fixtures/{capability-manifest,extension-request}/invalid/ws-*.json (8 new), test/ci-locked-paths.test.js, test/whitespace-text.test.js, docs/adr/0003-run-journal.md (addendum), README.md, LOG.md
- CHANGED LOCKED PATHS (review these first):
  - .github/scripts/locked-paths.mjs (guard rewritten: --no-renames -z, agent detection removed)
  - .github/workflows/protect-locked-paths.yml (guard job runs from base SHA, SHAs via env, agent env removed)
  - acceptance/: no changes. .github/CODEOWNERS and .github/locked-paths.txt: no changes.
- What changed: (1) guard checks both ends of renames and parses -z; (2) schemas reject whitespace-only button_ref, reversal_steps items, and extension-request undo_plan, why, proposed_approach, missing_capability via pattern "\S", with 8 whitespace-only invalid fixtures asserted to fail on the targeted pattern error; (3) workflow runs the base ref's guard against the PR head; (4) all agent detection removed, any locked-path change fails; (5) CLI tests on temp git repos: rename out of acceptance/, rename out of .github/, delete, add, plus a non-locked control; (6) README section, ADR-0003 addendum, this entry.
- Acceptance criteria (pass/fail each):
  - items 1-6 implemented: PASS
  - npm test: PASS (89 tests, 0 failures; was 67); build and check:self-model: PASS; npm audit --omit=dev: 0 vulnerabilities
  - new rename tests fail against the old guard (842760b), pass against the new: PASS
  - whitespace-only rejected, valid fixtures pass: PASS
  - workflow run on GitHub: NOT RUN (not allowed; logic unit/CLI tested only)
- Deviations:
  - Delete and add of locked files were already caught by the old guard (git diff --name-only lists them); only the two rename tests fail against it. The delete/add tests are regression coverage.
  - ADR note is an addendum to ADR-0003 (it already references R4), not ADR-0006, to keep the one-ADR-per-contract test and self-model unchanged.
  - acceptance/README.md (locked) still describes "agent-authored" detection and is now stale; not edited, to avoid changing another locked path. Kevin may update it.
  - Observed, not fixed (out of scope): the guard's CLI entry check compares process.argv[1] to the module URL, so invoking it through a symlinked path (e.g. /tmp on macOS) silently exits 0 without checking. The workflow calls it by a plain path, so CI is unaffected.
  - The guard cannot run from a base that lacks it, so the first PR into an empty main has no base to guard against.
- Status: complete on branch task/contracts-and-schemas, awaiting review. Not merged.
- Next step: Kevin reviews the locked-path changes above first, enables branch protection with this check and Code Owner review required, and merges manually.

## 2026-11-23 (guard symlink fail-open fix)
- Files touched: .github/scripts/locked-paths.mjs, test/ci-locked-paths.test.js, docs/adr/0003-run-journal.md (one line added to the guard addendum), LOG.md
- CHANGED LOCKED PATHS (review these first):
  - .github/scripts/locked-paths.mjs (raw-mode diff with --no-abbrev, symlink-aware resolution of changed paths and symlink targets, fail-closed main with exit 2, realpath entry-point check)
  - acceptance/, .github/workflows/protect-locked-paths.yml, .github/CODEOWNERS, .github/locked-paths.txt: no changes.
- What changed: the guard parses `git diff --raw -z --no-renames --no-abbrev` and rejects (a) any change at or under a locked path including symlink add/change/type-change/removal, (b) any changed path or symlink target whose real path lands in a locked path (symlink chains and symlinked parents followed lexically within the repo), and (c) fails closed with exit 2 on bad refs, git errors, unexpected git output, absolute or repo-escaping symlink targets. The entry-point check compared argv[1] to import.meta.url as strings, so invoking the guard through a symlink skipped it and exited 0; now realpath-compared. 20 new temp-repo CLI tests.
- Acceptance criteria (pass/fail each):
  - symlink under a locked dir, outside symlink into a locked dir, locked file replaced by symlink all fail the guard: PASS (old guard already failed closed on the first and third because it matched on path names; it failed open on a new or retargeted outside symlink into a locked dir, on symlinked invocation, and on unresolvable targets)
  - unresolvable path or git error makes the guard fail: PASS
  - existing tests incl. rename, delete, add still pass: PASS (109 tests, 0 failures: 89 existing + 20 new)
  - build, check:self-model, npm audit --omit=dev clean: PASS
  - LOG.md and ADR addendum updated: PASS
- Deviations: git never follows symlinks, so a write made through an outside symlink is recorded under the real locked path and was already caught; that case is kept as regression coverage. Tests and the symlink fix share the first commit. Workflow YAML untouched. Other review findings left out of scope.
- Status: complete on branch task/contracts-and-schemas, awaiting review. Not merged.
- Next step: Kevin reviews the locked guard change first.

## 2026-11-23 (guard workflow split)
- Files touched: .github/workflows/protect-locked-paths.yml, .github/workflows/tests.yml (new), acceptance/contracts.test.js, acceptance/README.md, README.md (guard section and layout line), LOG.md
- CHANGED LOCKED PATHS (review these first):
  - .github/workflows/protect-locked-paths.yml (now pull_request_target on main, single job id and name protect-locked-paths, contents: read, base-sha checkout with credentials kept for the refs/pull/N/head fetch, tests job removed)
  - .github/workflows/tests.yml (new: tests job moved here unchanged, plain pull_request, contents: read, no secrets)
  - acceptance/contracts.test.js (old single-workflow assertion replaced by 3 workflow-layout tests)
  - acceptance/README.md (guard fails ANY PR touching locked paths; agent-authored description removed)
  - .github/scripts/locked-paths.mjs, .github/CODEOWNERS, .github/locked-paths.txt: no changes.
- What changed: (1) guard job renamed so the required check is exactly protect-locked-paths; (2) guard in its own pull_request_target workflow so a PR cannot edit it away; (3) tests job in a separate pull_request workflow; (4) new acceptance tests (text-structure checks, no YAML parser dependency) for trigger, branches, job name, permissions, no PR code execution, and the separate tests workflow; README guard section updated to match.
- Acceptance criteria (pass/fail each):
  - npm test: PASS on Node 22 and Node 24 (111 tests, 0 failures each; was 109)
  - build, check:self-model, npm audit --omit=dev (0 vulnerabilities): PASS
  - new tests fail against the old single workflow (ffa8148), pass against the new layout: PASS
  - workflow run on GitHub: NOT RUN (not possible locally)
- Deviations: root README.md edited (two statements about the old workflow were factually wrong now); ADR-0003 addendum left as is (still accurate). tests.yml keeps node 24 and the old step order.
- Status: complete on branch task/contracts-and-schemas, awaiting review. Not pushed, not merged.
- Next step: Kevin reviews the locked-path changes above first, then pushes.

# LOG - Spec C

(New top-level section: the existing LOG.md history above is kept; entries there are per-task dated notes, this one follows the Spec C template.)

## What was done
Built the OpenRouter builder adapter in agent-core, items 1-6 of the spec, in new files only.
1. Config: `src/builder-config.js` (loader, `ConfigError`), `src/builder-redact.js`. Env, optional untracked `.agent-builder.local.json` (added to `.gitignore` with `.agent-runs/`), defaults per spec. API key env only (a key-like field in the file is an error), attached as a non-enumerable property, redacted from journal, errors, stacks and commits. Provider prefs passthrough. `FREE_MODEL_REPO_ALLOWLIST` default `["agent-core"]`. `role` accepts only `builder`.
2. Adapter: `src/builder-adapter.js` (tool loop on built-in fetch, no new dependencies), `src/builder-confine.js` (path confinement), `src/builder-capabilities.js` (4 manifests, all with undo, validated with the existing validator). Journal entries (reservation, attempt, issue) go through `createJournal().append`.
3. Rate limits: 429 or daily-cap error handled with bounded backoff, then a clean stop (see RATE-LIMIT BEHAVIOUR).
4. Tests: `test/builder-config.test.js` (7) and `test/builder-adapter.test.js` (25) with `test/builder-mock.js`, a local mock server on 127.0.0.1 with an ephemeral port. Two model IDs both complete; mocks for 429, malformed tool calls, refusal, truncation, 404 model-not-found.
5. `npm run builder:smoke` (`scripts/builder-smoke.js`): runs one tiny task in a throwaway local clone against the real endpoint. NOT RUN by this task.
6. Contract gaps journaled at runtime as issues of kind `contract-gap` and listed below.
Also: self-model regenerated (the generator indexes top-level `src/*.js`, so the adapter files are flat `src/builder-*.js` rather than `src/builder/`); README section.

## Commands run and results (with counts)
- Baseline on origin/main (de64e51): 111 tests (not re-run before changes; `npm ci --ignore-scripts` clean, 0 vulnerabilities).
- `npm test` Node 22.23.5: 143 tests, 143 pass, 0 fail, 0 skipped (111 + 7 config + 25 adapter).
- `npm test` Node 24.22.3: 143 tests, 143 pass, 0 fail, 0 skipped.
- `npm run build`: wrote self-model.json (8 modules, 5 contracts, 5 ADRs). `npm run check:self-model`: up to date.
- `npm audit --omit=dev`: 0 vulnerabilities.
- `git diff --name-only origin/main...HEAD`: no path under acceptance/, .github/, schemas/, or src/validators.js.
- Local guard dry-run `node .github/scripts/locked-paths.mjs <origin/main sha> <HEAD sha>`: exit 0.
- Not run, by design: `npm run builder:smoke`, any real network call, any real key.

## Decisions and why
- Task shape: the contract has no task-spec schema, so a task is `{repo, goal, grant, workdir, branch?}` with `grant` validated by the existing grant validator (see gaps). Grant scope, `max_tool_calls`, `expires_at` and risk tier low are enforced before any network call.
- Exit codes: 0 ok, 1 failed (model not found, refusal, truncation twice, malformed x3, budget, HTTP/network error), 2 refused before any network call (config, allowlist, expired grant, protected branch), 3 rate-limited.
- The adapter refuses to build on main/master/develop or detached HEAD, and commits only the files the model wrote, by explicit path.
- Truncation: the cut-off reply is discarded and the model is told once to use smaller steps; a second truncation stops. Malformed tool call: error returned to the model; 3 in a row stops.
- Flat file layout `src/builder-*.js` so the existing self-model generator lists the adapter without changing it.
- Key safety: key is never put in an entry; every string is additionally passed through a redactor (exact key, `sk-or-...` shape, `Bearer ...`) before append, commit message, tool reply or thrown error; stacks are rebuilt redacted (UNVERIFIED beyond the one thrown-error test; see fix round).

## CONTRACT GAPS (file, what was awkward, how it was handled)
- schemas/v1/run-journal-entry.schema.json: issue entries have no `kind` field (category is bug/risk/improvement, unevaluatedProperties false). Handled: description prefixed `[kind: rate-limit]`, `[kind: contract-gap]`, etc., with the nearest category (rate-limit=risk, contract-gap=improvement).
- schemas/v1/run-journal-entry.schema.json: no failure entry kind. Handled: `attempt` with outcome `failed` or `blocked`.
- schemas/v1/grant.schema.json: no task-spec schema (no goal, repo identity, branch). Handled: adapter wrapper object, grant validated only.
- schemas/v1/grant.schema.json: `scope.paths` semantics unspecified. Handled: relative prefixes; `.`, `*`, `**` mean all.
- docs/adr/0003-run-journal.md (src/journal.js): guarantee is in-process only. Handled: adapter mirrors entries to untracked `.agent-runs/<run_id>.jsonl` (no append-only protection on that file).
- src/self-model.js: only indexes top-level `src/*.js`, no capabilities field, so builder capabilities are not listed in self-model.json (modules are). Not changed.
- schemas/v1/capability-manifest.schema.json: no registry/publication place for manifests. Handled: validated and written to `.agent-runs/<run_id>.capabilities.json`.
- No role concept anywhere in the contract; R2 for this builder is enforced by the adapter config only.
All of the above are journaled as `contract-gap` issues in every run. [CORRECTION, fix round: this was wrong. The role gap was in this list but not journaled (7 of 8). Fixed; see the fix-round section below.]

## RATE-LIMIT BEHAVIOUR (documented exit code, backoff bounds)
- Exit code 3 (`EXIT.RATE_LIMITED`).
- Trigger: HTTP 429, or any error body mentioning a per-day/daily cap.
- Wait: the `Retry-After` header (seconds or HTTP date) if present, else exponential `base_delay_ms * 2^n` (1s, 2s, 4s), capped at `max_delay_ms` (30s). Defaults: `max_retries` 3, so at most 4 requests per step and 7s to 90s of waiting. Configurable only inside bounds: max_retries 0-5, max_delay_ms up to 120000.
- Stops immediately (no waiting) on a daily cap or a `Retry-After` above `max_delay_ms`.
- On stop: attempt entry (blocked), issue `[kind: rate-limit]` (risk/medium), work so far committed on the branch, status `rate-limited`.
- Model not found (404 or equivalent) is a journaled failed attempt, exit 1, no throw.

## CHANGED LOCKED PATHS (expected: none)
None. `git diff --name-only origin/main...HEAD` lists only: .gitignore, LOG.md, README.md, package.json, scripts/builder-smoke.js, self-model.json, src/builder-*.js (5 files), test/builder-*.js (3 files).

## Open questions for Kevin
- Template conflict: the existing LOG.md uses dated per-task entries; this Spec C section follows the template exactly and is appended.
- Should the contract gain a task-spec schema, an issue `kind` field and a failure entry kind (new schema version)?
- The smoke script clones this repo locally and works in a temp dir; confirm that is the low-risk public-repo task you wanted (it makes no push).
- `particle-ai/particle-1:free` could not be verified (no network); the id is config only.

## Run-journal issues raised
Per run, the adapter journals: one reservation (free/third-party model data policy doubt); one `[kind: contract-gap]` issue per gap above (7 at first pass; now 14, see fix-round section); `[kind: rate-limit]` on a rate-limit stop; `[kind: refusal]`, `[kind: truncation]`, `[kind: malformed-tool-calls]` when those stop a run. Entries are only produced when the adapter runs; none were produced against any real endpoint during this task.

# LOG - Spec C fix round

Fixes the standards-review findings on 56f4ad2 (see `.agents/specs/failed/TASK_SPEC-openrouter-builder-adapter-2026-11-23T0904-a3c66b.md` in the orchestrator repo). Same branch, one commit per issue, new commits on top of 56f4ad2. The "LOG - Spec C" section above is the first-pass log; where it differs from this section, this section is the current truth (the first-pass section was not rewritten, corrections are listed below).

## What was done
1. Path-lock hardening (`src/builder-confine.js`, `test/builder-confine.test.js`). One shared check for every path the tools can touch, failing closed on any error: realpath (symlinks followed, canonical case via `realpathSync.native`) and the lexical path are both checked; segments are folded (NFD, ignorable zero-width/soft-hyphen characters removed, NFC, lower case, trailing dots/spaces stripped) before comparing; `..`, absolute paths, leading `~`, NUL, backslash refused; any `.git`-like segment refused (`.git`, `.GIT`, `.git `, `.git.`, `.git~1`, `GIT~1`, `.gitmodules`, `.gitattributes`, ignorable-char spellings), for reads and writes. Locked: acceptance/, .github/ (holds the guard script and CODEOWNERS), any file named CODEOWNERS, src/validators.js, .git/, .agent-runs/, .agent-builder.local.json, plus whatever `.github/locked-paths.txt` lists. package.json is not locked. `confineMove(root, from, to)` checks both ends of a rename or move. Reproduced reviewer finding: `.GIT/config` write is now refused (end-to-end test with a hostile fsmonitor config; `.git/config` is byte-identical afterwards).
2. Allowlist from the git remote (`remoteRepos`, `parseGithubRemote` in `src/builder-adapter.js`). For a `:free` model every remote of the workdir (fetch and push URLs) must parse as GitHub https, scp-style ssh or ssh:// and be on `FREE_MODEL_REPO_ALLOWLIST`; `task.repo` is ignored for that decision. No remote, unparseable remote, userinfo in the URL, a workdir that is not its repo's top level, or any git error refuses. Runs in preflight, before any request. `scripts/builder-smoke.js` now sets the clone's origin to this repo's own remote URL so a `:free` smoke run is not refused.
3. Read denylist (`isReadDenied`, `confine`). Refused: `.env*`, `.git` contents, `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`, `~`-relative paths, anything outside the workdir (including via symlinks), `*.pem *.key *.crt *.cer *.p12 *.pfx *.der *.jks *.keystore *.asc *.gpg *.ppk`, `id_*`, `.netrc .npmrc .pypirc .pgpass .git-credentials`, `.agent-builder.local.json`, `.agent-runs`, and any name containing token, credential, secret, password, apikey, private-key. Refusals are `attempt` entries with outcome `failed`, never crashes. `list_dir` hides denied names. Reads now open the file, require a regular file, and read at most 50000 bytes (no whole-file read, no FIFO hang).
4. https enforcement (`checkBaseUrl` in `src/builder-config.js`). Base URL must be https; plain http only for 127.0.0.1, `[::1]`, localhost (exact hostnames). Checked at config load and again in adapter preflight (hand-built config). Requests use `redirect: 'error'`.
5. Journal correctness (`CONTRACT_GAPS`). 8 first-pass gaps now all journaled (the role gap was missing), plus 5 reviewer gaps (max_usd unenforced, expires_at start-only, risk tiers only checks low, ad-hoc scope strings, refusal/truncation unrepresented).
6. Self-model: generator and schema NOT extended. The missing capabilities field is journaled as one more `contract-gap`.

## Commands run and results (with counts)
- Baseline at 56f4ad2: 143 tests.
- New tests: 13 (confine) + 8 (allowlist) + 3 (read denylist) + 4 (https) + 2 (gaps) = 30; total 173.
- `npm test` Node 22.23.5: 173 tests, 173 pass, 0 fail, 0 skipped (143 + 30 new).
- `npm test` Node 24.22.3: 173 tests, 173 pass, 0 fail, 0 skipped.
- `npm run build`: wrote self-model.json (8 modules, 5 contracts, 5 ADRs), no diff. `npm run check:self-model`: up to date.
- `npm audit --omit=dev`: 0 vulnerabilities.
- `git diff --name-only origin/main...HEAD` (and against the local `main`, which is ahead of origin/main): no path under acceptance/, .github/, schemas/, CODEOWNERS or src/validators.js.
- Local guard dry run `node .github/scripts/locked-paths.mjs <origin/main> <HEAD>`: exit 0 ("no locked paths touched").
- Not run, by design: `npm run builder:smoke`, any live network call, any real key.

## Decisions and why (restrictive choices made without asking)
- Locked set follows this spec (acceptance/, .github/, CODEOWNERS, guard, src/validators.js), not only `.github/locked-paths.txt`, which today lists just acceptance/ and .github/. A file named CODEOWNERS is locked at any depth.
- The guard (`.github/scripts/locked-paths.mjs`) exports `isLocked` but it is an exact-string prefix match with no case, unicode or `.git` handling, so it cannot be reused for normalisation. The adapter check is its own implementation, and `test/builder-confine.test.js` runs a shared corpus through both: on canonical paths they agree; every guard-locked path is refused by the adapter; the adapter additionally refuses the exact list of spellings the guard does not fold (case variants, zero-width characters, `./acceptance/x`, trailing dot/space, the bare name `acceptance`). The guard was not edited.
- The write allowed-path (grant) check is exact-case on both the lexical and the real path, so `DOCS/x.md` is refused under a `docs/` grant even on a case-insensitive filesystem.
- All spellings of `.gitmodules` and `.gitattributes` are treated as git internals, and `.git`-like segments are refused for reads as well as writes.
- Read-denylist matches are deliberately broad (any name containing "token", "secret", "credential", "password"); this will refuse some harmless docs. False positives are cheaper than leaks.
- Denylist and git refusals on reads are `attempt` outcome `failed` (spec wording); lock and grant refusals on writes stay `blocked` as before.
- `:free` allowlist entries compare by repo name, case-insensitive (the spec says "list of repo names"). An entry may also be written `owner/repo`. The default stays `agent-core` by name only, so a fork `someoneelse/agent-core` would also pass; see Open questions.
- Every remote (fetch and push, all URLs) must be allowlisted, not just `origin`, so a second private remote cannot ride along.
- Spec item 4's last clause ("refused when the model ID is `:free` against a non-loopback host") is read as: non-https is refused for every non-loopback host including `:free` models; https hosts are allowed. A `:free` model against loopback http works only for the mock server.
- No `move_file` tool was added; `confineMove` exists and is tested for any future move/rename tool.
- No new dependencies.

## CONTRACT GAPS (all 13 plus the self-model gap)
All 14 are journaled at runtime on every run as `[kind: contract-gap]` issues (proved by `test/builder-gaps.test.js`).
First pass, 8 (the first-pass LOG said all 8 were journaled; only 7 were, the role gap was missing and is now fixed):
1. schemas/v1/run-journal-entry.schema.json: issue entries have no `kind` field.
2. schemas/v1/run-journal-entry.schema.json: no failure entry kind (failures are `attempt` failed/blocked).
3. schemas/v1/grant.schema.json: no task-spec schema.
4. schemas/v1/grant.schema.json: `scope.paths` semantics unspecified.
5. docs/adr/0003-run-journal.md: journal guarantee is in-process only.
6. src/self-model.js: indexes only top-level `src/*.js`.
7. schemas/v1/capability-manifest.schema.json: no registry for manifests.
8. schemas/v1/ (all): no role concept (builder vs overseer, R2).
Found by the reviewers, 5:
9. grant.schema.json: `budget.max_usd` cannot be enforced (no metering).
10. grant.schema.json: `expires_at` checked only at start; no mid-run or wall-clock expiry.
11. grant.schema.json: `allowed_risk_tiers` has no defined semantics; adapter only checks `low`.
12. capability-manifest.schema.json: `scopes` are free-form strings; adapter invented its own.
13. run-journal-entry.schema.json: refusal and truncation have no representation.
Self-model:
14. schemas/v1/self-model.schema.json and scripts/build-self-model.js: no field for adapter capabilities. NOT extended; Kevin decides. (Gap 6 is the related but different "only indexes top-level src/*.js" point.)

## CHANGED LOCKED PATHS (expected: none)
None. `git diff --name-only main...HEAD` lists no file under acceptance/, .github/, CODEOWNERS, schemas/, or src/validators.js (checked, see below).

## Not verified (guard on a real PR, live endpoint)
- The `protect-locked-paths` workflow on a real PR: not run (no PR; not possible locally). Only the guard script was dry-run locally.
- The live OpenRouter endpoint, the `particle-ai/particle-1:free` model ID, and its real response shapes: never contacted. `builder:smoke` not run. No real key was used.
- Behaviour on a case-insensitive filesystem is exercised by the folding tests (which pass on any filesystem) and by the real APFS volume this was run on; a case-sensitive Linux run was not done.
- 8.3 short-name (`.git~1`, `GIT~1`) and trailing-dot/space handling is refused by name; it was not tested against an NTFS volume.
- First-pass LOG claims not proved by a test, now marked unverified: "stacks are rebuilt redacted" is only tested through the thrown-error path with a stack containing the key (test "a network error whose message contains the key"), not for every error path; "mock server records zero requests" is proved only for the preflight refusals listed in tests; "the smoke script makes no push" is by inspection, not by a test.

## Open questions for Kevin
- Allowlist is by repo name, so a fork `other-owner/agent-core` would pass. Should the default become `KosherKev/agent-core` (owner/repo entries are already supported)? Restrictive choice not taken because the spec fixes the default to `agent-core`.
- Read denylist breadth (names containing token/secret/credential/password) may block legitimate docs; loosen?
- Should `.gitignore` / `.gitattributes` / `.gitmodules` writes ever be allowed to a builder? Currently `.gitattributes` and `.gitmodules` are refused, `.gitignore` is allowed.
- Should the contract gain a role concept, an issue `kind`, a failure entry, metering for `max_usd`, a self-model capabilities field (gaps above)?
- The first-pass review also listed LOW findings not in this spec's scope and left open: `.agent-runs` is written before the role/branch/allowlist checks, `git add` fails the batch on a gitignored file, an unchanged write reports "completed" with no commit, the `/per[- ]day|daily/` match also applies to non-429 bodies, no wall-clock cap, unbounded response body size, redaction covers only the exact key, `sk-or-...` and `Bearer ...` shapes, test temp dirs are not cleaned up.
- builder:smoke is safe to run only after Kevin reviews this fix round; the command-execution path (`.GIT/config`) is closed and tested, but the guard check on a real PR is still unverified.

## Run-journal issues raised
Per run, the adapter journals one reservation (free/third-party model data policy), 14 `[kind: contract-gap]` issues, and on the relevant stops `[kind: rate-limit]`, `[kind: refusal]`, `[kind: truncation]`, `[kind: malformed-tool-calls]`. Read-denylist and git-internals refusals are `attempt` entries, not issues. No entries were produced against a real endpoint during this task.
