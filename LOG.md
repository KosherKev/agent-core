# LOG

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
- Key safety: key is never put in an entry; every string is additionally passed through a redactor (exact key, `sk-or-...` shape, `Bearer ...`) before append, commit message, tool reply or thrown error; stacks are rebuilt redacted.

## CONTRACT GAPS (file, what was awkward, how it was handled)
- schemas/v1/run-journal-entry.schema.json: issue entries have no `kind` field (category is bug/risk/improvement, unevaluatedProperties false). Handled: description prefixed `[kind: rate-limit]`, `[kind: contract-gap]`, etc., with the nearest category (rate-limit=risk, contract-gap=improvement).
- schemas/v1/run-journal-entry.schema.json: no failure entry kind. Handled: `attempt` with outcome `failed` or `blocked`.
- schemas/v1/grant.schema.json: no task-spec schema (no goal, repo identity, branch). Handled: adapter wrapper object, grant validated only.
- schemas/v1/grant.schema.json: `scope.paths` semantics unspecified. Handled: relative prefixes; `.`, `*`, `**` mean all.
- docs/adr/0003-run-journal.md (src/journal.js): guarantee is in-process only. Handled: adapter mirrors entries to untracked `.agent-runs/<run_id>.jsonl` (no append-only protection on that file).
- src/self-model.js: only indexes top-level `src/*.js`, no capabilities field, so builder capabilities are not listed in self-model.json (modules are). Not changed.
- schemas/v1/capability-manifest.schema.json: no registry/publication place for manifests. Handled: validated and written to `.agent-runs/<run_id>.capabilities.json`.
- No role concept anywhere in the contract; R2 for this builder is enforced by the adapter config only.
All of the above are journaled as `contract-gap` issues in every run.

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
Per run, the adapter journals: one reservation (free/third-party model data policy doubt); one `[kind: contract-gap]` issue per gap above (7); `[kind: rate-limit]` on a rate-limit stop; `[kind: refusal]`, `[kind: truncation]`, `[kind: malformed-tool-calls]` when those stop a run. Entries are only produced when the adapter runs; none were produced against any real endpoint during this task.
