# ADR-0001: Capability manifest contract

Status: accepted (2026-11-23)

## Context
Parts of the agent must swap behind stable contracts, and every change must be reversible (rule R1).

## Decision
Each capability declares a manifest (`schemas/v1/capability-manifest.schema.json`): name, semver version, scopes needed, inputs, outputs, undo, risk tier. `undo` must carry a button reference or at least one reversal step; a manifest with neither fails validation, so an irreversible capability cannot be registered.

## Consequences
Schemas are versioned under `schemas/v1/`; breaking changes go to `v2/`. Risk tiers (low, medium, high, payments) let later gates apply the tier policy.
