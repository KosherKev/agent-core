# ADR-0003: Run journal contract

Status: accepted (2026-11-23)

## Context
Doubts, attempts and findings during a run must be trustworthy after the fact, so the agent must not be able to rewrite them.

## Decision
The journal (`schemas/v1/run-journal-entry.schema.json`, `src/journal.js`) has three entry kinds: reservation (doubt and what was done), attempt (what was tried, outcome ok/failed/blocked, reason), issue (bug/risk/improvement, severity, suggested fix). The API is `append` and `read` only. Stored entries are frozen copies, ids are unique, and there is no edit or delete operation.

## Consequences
This is an in-process guarantee. Durable storage must preserve the same two-operation surface; the ledger is protected from the agent by R4.

## Addendum 2026-11-23: locked-path guard (R4)
The R4 protection this ADR leans on changed. The CI guard now fails any change to a locked path regardless of author (agent detection by branch prefix, actor or label was evadable and is removed). It runs from the base ref's script and locked-paths list, checks both ends of renames (`--no-renames`, `-z` parsing), and treats delete and add the same way. The human exception is a manual merge by the owner. The guard is only effective with branch protection and Code Owner review enabled; those settings belong to the owner. See README, "Locked-path guard". No contract changed, so there is no new ADR (the one-ADR-per-contract rule holds).
