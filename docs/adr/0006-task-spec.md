# ADR-0006: Task spec contract

Status: accepted (2026-11-23)

## Context
A grant bounds a task but says nothing about what the task is. The builder adapter took a hand-made `{ grant, repo, goal, workdir, branch? }` object and journaled a `contract-gap` because no schema described it.

## Decision
A task spec (`schemas/v1/task-spec.schema.json`) has `goal` (non-blank text), `repo` (identity as `host/owner/name`, for example `github.com/KosherKev/agent-core`), an optional `branch`, and exactly one of `grant` (a full grant, validated by the grant schema) or `grant_ref` (the `task_id` of a grant held elsewhere). Unknown fields are rejected.

`workdir` is deliberately not part of the contract: it is a local, per-machine path and not a property of the task. The adapter's own wrapper keeps passing it separately.

## Consequences
- Additive: no existing contract changed. The adapter is not changed (its code is locked); it keeps its own wrapper object and its runtime `contract-gap` entry for this issue until locked code is updated by a human.
- The adapter accepts a bare repo name or path as `repo`; this schema is stricter (host/owner/name). A wrapper that should validate against this schema must use the full identity.
- `grant_ref` only names a grant. Resolving it (and checking it matches `task_id`) is not implemented anywhere yet.

## Addendum 2026-11-23: strict `repo` identity
`repo` must be `host/owner/name`. The host is a DNS-style hostname (dotted labels of letters, digits and inner hyphens, alphabetic final label). Owner and name are each 1 to 100 characters of letters, digits, `_`, `-` and `.`. Rejected: a segment equal to `.` or `..`, a name ending in `.git` (any case), empty segments, leading or trailing whitespace (including a trailing newline), backslashes, percent signs, control characters and non-ASCII. Reason: a repo identity that accepts `..` will eventually be used as a path. Every previously valid fixture still validates.

## Addendum 2026-11-23: grant_ref cross-check
`src/task-spec.js` exports `validateTaskSpec(spec)` (schema first, schema errors returned as is) and `checkGrantRef(spec)`: when both `grant_ref` and an embedded `grant.task_id` are present they must be equal, else `/grant_ref "X" does not match /grant/task_id "Y"`. A schema cannot compare two fields (ajv `$data` is unused on purpose), and `src/validators.js` is locked, hence the separate helper. The v1 schema already refuses both forms in one spec, so the check is defence in depth. Resolving a `grant_ref` to a stored grant is still not implemented.
