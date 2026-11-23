# ADR-0002: Extension request contract

Status: accepted (2026-11-23)

## Context
The system extends itself, but only through the same gates as any other change.

## Decision
When the agent lacks a capability it files an extension request (`schemas/v1/extension-request.schema.json`): missing capability, why, proposed approach, scopes wanted, and an undo plan. The undo plan has the same button-or-steps rule as a manifest (R1).

## Consequences
A request is only a proposal. Approval is decided by the fresh-context overseer (R2), never the requester; that code is out of scope for this repo.
