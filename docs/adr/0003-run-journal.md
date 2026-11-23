# ADR-0003: Run journal contract

Status: accepted (2026-11-23)

## Context
Doubts, attempts and findings during a run must be trustworthy after the fact, so the agent must not be able to rewrite them.

## Decision
The journal (`schemas/v1/run-journal-entry.schema.json`, `src/journal.js`) has three entry kinds: reservation (doubt and what was done), attempt (what was tried, outcome ok/failed/blocked, reason), issue (bug/risk/improvement, severity, suggested fix). The API is `append` and `read` only. Stored entries are frozen copies, ids are unique, and there is no edit or delete operation.

## Consequences
This is an in-process guarantee. Durable storage must preserve the same two-operation surface; the ledger is protected from the agent by R4.
