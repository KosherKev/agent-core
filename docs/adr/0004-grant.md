# ADR-0004: Grant contract

Status: accepted (2026-11-23)

## Context
Rule R3: one grant per task, bounded in scope, budget and time.

## Decision
A grant (`schemas/v1/grant.schema.json`) names the task, the repos and paths in scope, a budget (USD and tool calls), an expiry timestamp and the allowed risk tiers. All fields are required and unknown fields are rejected.

## Consequences
Enforcement lives in the (future) gateway; this contract only fixes the shape so enforcement can be tested against fixtures.

## Addendum 2026-11-23: what the shape means today (documentation only, no change)
This records what the existing adapter (`src/builder-adapter.js`, `src/builder-confine.js`) and meter (`src/grant/`) do. It invents nothing and changes no behaviour. `test/grant-semantics-doc.test.js` pins the path rules below. Where today's behaviour looks like a defect, it is stated as a fact; deciding what it should be belongs to a later, versioned, human-reviewed change.

### `scope.repos`
The adapter accepts a task when the grant's `scope.repos` contains the base name of the task's `repo` (the last path segment) or the full `repo` string. Comparison is exact and case-sensitive.

### `scope.paths`
- Applied to writes only. Reads are not limited by the grant; they are limited by the worktree boundary and the read denylist.
- Each entry is a relative path prefix. Empty segments and `.` are dropped, a trailing `/` is ignored, and the text is compared in Unicode NFC.
- An entry matches a path equal to it or under it, by whole segments (`src` matches `src/a.js`, not `srcx/a.js`). Matching is case-sensitive.
- `.`, `./`, the empty string, `*` and `**` (exactly those spellings) mean every path.
- Nothing else is a glob. An entry such as `src/**` is a literal prefix, so it matches no real file. The valid grant fixture uses `src/**` and `docs/**`; under the current adapter those entries allow no writes.
- Both the path as written and its real path (after symlink resolution) must match some entry.
- Locked paths and git internals are refused regardless of the grant, even with `**`.

### `allowed_risk_tiers`
The schema allows `low`, `medium`, `high` and `payments`. The only check anywhere in the code is the adapter's: it refuses unless the list includes `low`. Nothing reads `medium`, `high` or `payments`, no capability is compared with the tiers, and the meter ignores them. Every capability the builder adapter declares has `risk_tier: low`. The tier names have no further defined meaning.

### Scope vocabulary
`scopes` in a capability manifest and `scopes_wanted` in an extension request are free-form non-empty strings with no registry. The builder adapter's own manifests use `repo:write:task-worktree`, `repo:read:task-worktree` and `repo:commit:task-branch`. No code compares these strings with a grant's `scope`, so they carry no enforced meaning.

### `budget`
`max_usd` is a JSON number; the meter requires a finite number greater than zero and rounds it down to whole micro-USD. `max_tool_calls` must be a positive integer. A decimal-string `max_usd` is not accepted by the meter (see LOG.md, 2026-11-23 additive contract gap cleanup).

## Addendum 2026-11-23 (follow-up): `scope.paths` entries are literal prefixes, no globs
Decision (Kevin): no glob support. Every path rule so far produced a bypass, so prefix-only stays.
- Each `scope.paths` entry is a literal path prefix matched on whole segments. Glob characters (`*`, `?`, `[`, `{`) are NOT interpreted and the schema does not reject them.
- The only special spellings are the ones listed above (`.`, `./`, the empty string, `*`, `**` meaning every path).
- `src/**` therefore matches nothing today: a grant with that entry allows no writes under `src`. To allow writes under `src`, write `src` or `src/`.
- `fixtures/grant/valid/basic.json` (and the embedded copy in `fixtures/task-spec/valid/embedded-grant.json`) still use `src/**`, left untouched: they are schema-valid, and the acceptance suite iterates every grant fixture. `fixtures/grant/valid/prefix-paths.json` is the example that actually allows writes (`src/`, `docs/`).
- `test/grant-prefix-paths.test.js` asserts this through the public `confine` API.
