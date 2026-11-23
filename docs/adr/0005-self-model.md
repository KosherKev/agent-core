# ADR-0005: Self-model contract

Status: accepted (2026-11-23)

## Context
The agent needs an accurate, checkable picture of its own parts before it proposes changes to them.

## Decision
The self-model (`schemas/v1/self-model.schema.json`) is a generated index of modules, contracts and ADRs. `npm run build` regenerates `self-model.json` deterministically from the repo contents; `npm run check:self-model` fails if the committed file is stale. It is never edited by hand.

## Consequences
The index contains no timestamps so regeneration is byte-stable and diffs are meaningful.

## Addendum 2026-11-23: nested modules and capabilities
The generator now indexes every `.js` file under `src/` at any depth (symlinks skipped). A nested module is named by its path below `src/` without the extension (`grant/meter`, `ledger/lock`); top-level names are unchanged. Entries are sorted by path in plain string order.

A module entry may carry an optional `capabilities` array (name, version, risk_tier, sorted scopes). It is filled only from capability manifests that exist in the repo: today, the `*_CAPABILITIES` array exported by `src/builder-capabilities.js`, attached to that module. A module with no manifests has no field. If the manifests cannot be loaded, the field is omitted and the build does not fail. The schema change is additive (an optional property); a self-model without the field still validates. The generator now loads that module while building; it has no side effects.
