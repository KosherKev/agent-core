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
.github/          CODEOWNERS, locked-paths list, CI workflow (LOCKED)
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
`.github/workflows/protect-locked-paths.yml` runs on `pull_request` and fails when a PR changes any path listed in `.github/locked-paths.txt`, whoever or whatever authored it. There is no agent detection (no branch prefix, actor or label logic).
- The guard script and the locked-paths list are taken from the BASE commit (the workflow checks out the base SHA and only fetches the PR head as data), so a PR cannot edit the rules it is judged by.
- The check diffs `base...head` with `--no-renames --name-only -z`: a rename counts as a delete of the old path plus an add of the new one, so both ends are checked, and paths are NUL-delimited so odd filenames cannot slip through.
- The human exception is a manual merge by Kevin (the owner) after reviewing the locked-path changes. It is not a way for the check to pass.
- This only works if GitHub branch protection is enabled on `main` with this check required and Code Owner review required (`.github/CODEOWNERS`). Without those, the check is advisory. Those settings are the owner's to configure; nothing in this repo can enforce them.
- A PR that changes the guard itself is judged by the old guard (base) and so fails like any other locked-path change; Code Owner review is the real control.
- Until `main` exists with the guard on it, the check has no base to run from.
