# ADR-0005: Self-model contract

Status: accepted (2026-11-23)

## Context
The agent needs an accurate, checkable picture of its own parts before it proposes changes to them.

## Decision
The self-model (`schemas/v1/self-model.schema.json`) is a generated index of modules, contracts and ADRs. `npm run build` regenerates `self-model.json` deterministically from the repo contents; `npm run check:self-model` fails if the committed file is stale. It is never edited by hand.

## Consequences
The index contains no timestamps so regeneration is byte-stable and diffs are meaningful.
