# agent-core

M0 of the personal agent backbone: the versioned contracts (seams) that let the system extend itself safely. This repo holds schemas, validators, fixtures, tests and ADRs only. There is no runtime, gateway, overseer or orchestrator code here.

Tenets: modular (parts swap behind contracts), correctable (every change reversible), improvable (the agent upgrades itself through the same gates).

## Hard rules
- R1: no undo button or reversal steps means the action is refused.
- R2: gates are answered by a fresh-context overseer, never the builder.
- R3: one grant per task (scope, budget, expiry).
- R4: the agent can never edit the overseer, policy, ledger or acceptance suite.

## The seven seams
1. **Capability manifest** (`schemas/v1/capability-manifest.schema.json`, ADR-0001): what a capability needs, takes, returns, how to undo it, and its risk tier. No undo, no manifest (R1).
2. **Extension request** (`extension-request`, ADR-0002): how the agent asks for a capability it lacks, with an undo plan.
3. **Run journal** (`run-journal-entry`, `src/journal.js`, ADR-0003): append-only record of reservations, attempts and issues. API is `append` and `read` only.
4. **Grant** (`grant`, ADR-0004): one per task; repos and paths, budget, expiry, allowed risk tiers (R3).
5. **Self-model** (`self-model`, `self-model.json`, ADR-0005): generated index of modules, contracts and ADRs.
6. **Locked acceptance suite** (`acceptance/`): runnable by the builder, not editable by it. Protected by `.github/CODEOWNERS` and the `protect-locked-paths` workflow (R4); see "Locked-path guard" below.
7. **Overseer/gate boundary** (rules R2 and R4): the line between the builder and whoever answers gates. This repo defines only what crosses it (the contracts above); the overseer itself lives elsewhere and is out of scope.

Seams 1-5 are contracts with schemas. Seams 6 and 7 are enforcement boundaries.

## Layout
```
schemas/v1/       versioned JSON Schemas (draft 2020-12)
src/              validators, journal API, self-model generator
fixtures/<name>/  valid/ and invalid/ examples per schema
test/             unit tests
acceptance/       LOCKED acceptance suite
docs/adr/         one ADR per contract
.github/          CODEOWNERS, locked-paths list, guard workflow and tests workflow (LOCKED)
scripts/          build-self-model.js
self-model.json   generated; do not hand-edit
```

## Use
```
npm ci
npm run build            # regenerate self-model.json
npm run check:self-model # fail if self-model.json is stale
npm test                 # unit tests + locked acceptance suite
```
Dependencies are exact-pinned and locked in `package-lock.json`; install with `npm ci`.

## Adding a contract version
Add `schemas/v2/` alongside `v1/`; never change a published version in a breaking way. Add valid and invalid fixtures and an ADR.

## Locked-path guard
`.github/workflows/protect-locked-paths.yml` runs on `pull_request_target` (so the workflow file itself comes from the base branch and a PR cannot edit it away; it never executes PR code) and fails when a PR changes any path listed in `.github/locked-paths.txt`, whoever or whatever authored it. There is no agent detection (no branch prefix, actor or label logic).
- The guard script and the locked-paths list are taken from the BASE commit (the workflow checks out the base SHA and only fetches the PR head as data), so a PR cannot edit the rules it is judged by.
- The check diffs `base...head` with `--no-renames --name-only -z`: a rename counts as a delete of the old path plus an add of the new one, so both ends are checked, and paths are NUL-delimited so odd filenames cannot slip through.
- The human exception is a manual merge by Kevin (the owner) after reviewing the locked-path changes. It is not a way for the check to pass.
- This only works if GitHub branch protection is enabled on `main` with this check required and Code Owner review required (`.github/CODEOWNERS`). Without those, the check is advisory. Those settings are the owner's to configure; nothing in this repo can enforce them.
- A PR that changes the guard itself is judged by the old guard (base) and so fails like any other locked-path change; Code Owner review is the real control.
- Until `main` exists with the guard on it, the check has no base to run from.

## OpenRouter builder adapter
`src/builder-*.js` lets the contract drive an OpenAI-compatible model (default `particle-ai/particle-1:free` via OpenRouter) as a BUILDER only (R2: `role` accepts only `builder`; `overseer` and unknown roles are rejected at config load).
- Config (`src/builder-config.js`): env `AGENT_BUILDER_MODEL`, `AGENT_BUILDER_BASE_URL`, `AGENT_BUILDER_ROLE`, `FREE_MODEL_REPO_ALLOWLIST` (default `agent-core`), provider prefs (`AGENT_BUILDER_PROVIDER_ORDER`, `AGENT_BUILDER_ALLOW_FALLBACKS`, `AGENT_BUILDER_DATA_COLLECTION`), plus an optional untracked `.agent-builder.local.json`. `OPENROUTER_API_KEY` is env only and is redacted from every journal entry, error and commit. A `:free` model is refused before any network call unless every git remote of the workdir (not the task input) is an allowlisted GitHub repo. The base URL must be https (plain http only for 127.0.0.1, ::1, localhost).
- Adapter (`src/builder-adapter.js`): takes `{ repo, goal, grant, workdir }` (the grant is the `schemas/v1` grant), runs a read/write/list tool loop, writes only inside the task branch worktree (never `acceptance/`, `.github/`, `CODEOWNERS`, `src/validators.js`, `.git`-like segments, outside the grant's paths, or via symlinks; case, unicode and realpath are folded), and refuses reads of secrets, keys, `.env*`, `.git` and anything outside the workdir, commits work on the branch, and journals through the existing append-only API (mirrored to untracked `.agent-runs/<run_id>.jsonl`).
- Exit codes: 0 ok, 1 failed, 2 refused or config error, 3 rate-limited (see LOG.md for backoff bounds), 4 grant exceeded (budget, tool-call limit or expiry reached mid-run, or the clock moved backwards; work so far is committed and a `grant-exceeded` issue says which limit and the numbers). The meter lives in `src/grant/`; prices in `config/prices.json`.
- `npm run builder:smoke` is a live check for the owner to run with their own key. It is never run by tests or by the build agent.
