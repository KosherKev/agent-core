# ADR-0004: Grant contract

Status: accepted (2026-11-23)

## Context
Rule R3: one grant per task, bounded in scope, budget and time.

## Decision
A grant (`schemas/v1/grant.schema.json`) names the task, the repos and paths in scope, a budget (USD and tool calls), an expiry timestamp and the allowed risk tiers. All fields are required and unknown fields are rejected.

## Consequences
Enforcement lives in the (future) gateway; this contract only fixes the shape so enforcement can be tested against fixtures.
