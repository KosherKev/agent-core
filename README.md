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
6. **Locked acceptance suite** (`acceptance/`): runnable by the builder, not editable by it. Protected by `.github/CODEOWNERS` and the `protect-locked-paths` workflow (R4).
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
