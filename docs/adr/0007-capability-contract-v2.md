# ADR-0007: Capability contract v2 (third-party tools, trust and enforcement)

Status: accepted (2026-11-27). Decisions on the five questions are recorded at the end. v1 (ADR-0001, ADR-0004) stays valid and unchanged.

Location: this file waited in `docs/adr-pending/` because `test/self-model.test.js` required exactly one ADR per contract. It moved here with the v2 schemas (`schemas/v2/`), and that count rule was replaced by an explicit coverage rule in the same change: every contract is covered by at least one ADR, and an ADR may cover several.

## Context
Observed in the repo at commit 42f65c6:
1. `scopes` in a v1 manifest are free-form strings and nothing compares them with a grant (ADR-0004 addendum).
2. `allowed_risk_tiers` is enforced only as "must include `low`". Medium, high and payments have no behaviour.
3. Capabilities exist only as manifests for the in-process builder adapter, all tier `low`. The gateway exposes model calls only; there is no method for "call capability X".
4. A grant's scope is repos and paths. It cannot say which server or tool a task may use.
5. `schemas/` is not in `.github/locked-paths.txt`, so the files that define what a grant and a manifest mean can be changed by an agent branch without the guard firing.
6. R1 says an irreversible capability cannot be registered. External tools can send, post or pay, so a v2 contract must say what happens to them rather than quietly bend R1.

What MCP gives us (spec revision 2026-07-28, https://modelcontextprotocol.io/specification/2026-07-28/server/tools):
- A tool definition is name, title, description, icons, inputSchema, optional outputSchema, optional annotations. The spec says annotations are untrusted unless they come from a trusted server, and that tools are arbitrary code execution.
- The protocol is stateless. Which tools a server lists can change; clients learn of it by listing again (with a server-given `ttlMs`) or via a subscription.
- Tool names are unique only within one server; the server's self-reported name is not unique across servers.
- A `tools/call` can answer `input_required` (the server asks for more input); a result can carry resource links and embedded resources.
- The spec's own advice is a human in the loop with the ability to deny, input validation, output validation, timeouts and an audit log.
These revisions change; the adapter pins one (D10) and the contract below does not depend on it.

## Decision
**D1. Three documents, one job each.** The manifest DESCRIBES a capability and grants nothing. The trust registry (human-owned) says what may run and at what level. The grant says what one task may use. A capability runs only if all three agree.

**D2. Manifest v2** (`schemas/v2/capability-manifest.schema.json`), all fields required unless noted, unknown fields rejected:
- `schema_version` "2"; `name`; `version` (semver). External capabilities are named `<server_id>.<tool>`. `server_id` comes from the registry, never from what the server calls itself.
- `origin`: `kind` (`builtin` or `mcp`), and for `mcp`: `server_id`, `source_url`, `pinned_commit` (full 40-hex sha), `lockfile_sha256`, `protocol_version`.
- `definition_hash`: sha256 over canonical JSON of the whole tool definition (name, description, inputSchema, outputSchema, annotations). Descriptions are included because they are an injection surface.
- `scopes`: from a closed vocabulary `resource:verb:boundary`, kept in `config/` (locked). A string outside the vocabulary fails validation.
- `effect`: `read`, `write_reversible`, `write_irreversible` or `money`. `mode`: `execute` or `draft`. `write_irreversible` and `money` are valid only with `mode: draft` (the capability produces a proposal a human or the merge gate applies; it never performs the effect). This keeps R1 and the "payments are draft only" decision.
- `risk_tier` is DERIVED and must match: read=low, write_reversible=medium, write_irreversible=high, money=payments. A manifest cannot declare a lower tier than its effect.
- `network`: `egress` `none` or `allowlist`, with `hosts`. `credentials`: names of credential references only, never values; the holder is always the gateway.
- `execution_identity`: the OS identity the capability runs under (never the runner's).
- `undo`: as v1. `not_applicable_read_only` is allowed only when `effect` is `read`.

**D3. Trust registry** (`config/trust-registry.json`, locked, edited by hand only). One entry per `(server_id, pinned_commit, definition_hash)`: `trust_level` (0, 1 or 2), approved scopes, allowed credential references, approved_by, date. No entry means denied. Levels: 0 = read only, no credentials, allowlisted network; 1 = its own narrowly scoped, spend-capped token, each use approved by Kevin; 2 = money, draft only. The vetting module (ADR-0008) writes a RECOMMENDATION report elsewhere; it never writes the registry.

**D4. Grant v2** (`schemas/v2/grant.schema.json`): adds `capabilities`, a list of `{name, definition_hash, max_calls}` (may be empty, no wildcard). `allowed_risk_tiers` is now enforced against the capability's derived tier. The task-wide `max_tool_calls` and `max_usd` stay.

**D5. Enforcement.** A new gateway method `call_capability` checks, in this order, failing closed: grant valid and unexpired; capability listed with the same hash; registry entry for the exact `(server, commit, hash)` at a sufficient level; tier allowed; arguments valid against `inputSchema`; budget reserved DURABLY before execution (the same request_start and request_reserved rules as model calls); execution by the MCP host under `execution_identity`; result validated against `outputSchema`; ledger entry. If the outcome of a non-idempotent call is unknown after a crash, the gateway never re-executes automatically; it answers `request_outcome_unknown` and a human decides.

**D6. Drift.** If a live `tools/list` yields a different `definition_hash` than the pinned one, the capability is disabled, the ledger records it and Kevin is told. There is no automatic re-approval. Server-supplied cache lifetimes are capped by our own maximum.

**D7. Outputs are data.** Results travel in a fixed envelope marked untrusted, with a size cap, and are never placed in instruction text. Resource links and embedded URIs are never fetched automatically. An `input_required` result stops the call and goes to Kevin; the agent never answers a server's questions by itself.

**D8. Compatibility.** v1 manifests and grants stay valid for `origin: builtin` only. The gateway refuses a v1 manifest for an MCP tool. v2 schemas are added beside v1 and the acceptance suite iterates both.

**D9. Not decided here.** What vetting checks (ADR-0008), how the MCP host is sandboxed (OS identity, egress allowlist; needs its own ADR and a Linux proof), discovery, the voice layer.

**D10. Protocol pin.** The MCP host adapter implements one protocol revision (2026-07-28 at drafting), recorded in `origin.protocol_version`. Moving to a newer revision is a reviewed change.

## Consequences
- Adding a capability needs a human edit to the locked registry. That is deliberate.
- `schemas/` must be locked (by hand) before v2 is trusted, or the contract can be edited by the agent it constrains.
- Pinned commits stop a local server from changing under us. They do NOT cover a REMOTE (HTTP) MCP server, which runs someone else's code we cannot pin; only the definition hash applies there, and a hash does not capture behaviour.
- `effect`, annotations and descriptions come from the tool's author. They are claims, not facts; vetting's sandbox observation and the registry's level are what cap the real risk.
- Implementing D5 touches the gateway, which is locked: that work is a human-reviewed change to `src/gateway/` and must repeat the by-hand proof.

## Tests this contract needs (before any MCP code)
Fixtures for valid and invalid v2 manifests and grants; effect/tier mismatch rejected; irreversible or money with `mode: execute` rejected; scope outside the vocabulary rejected; hash mismatch denies; registry-absent denies; `input_required` and resource-link handling; a drift case; an unknown-outcome case that never re-executes.

## Decisions (Kevin, 2026-11-27)
1. Irreversible and money capabilities register only in `draft` mode (D2). Never `execute`.
2. The scope vocabulary (`config/capability-scopes.json`) and the trust registry are edited by hand only. The orchestrator and any agent never write them. When an entry is needed, the proposed content is produced as a file outside `config/` together with one command for Kevin to run. Initial vocabulary: the three scopes the builder adapter declares today (`repo:read:task-worktree`, `repo:write:task-worktree`, `repo:commit:task-branch`). Initial registry: no entries (everything denied).
3. Remote (HTTP) MCP servers are excluded from the first version. Only local servers run by the gateway from a pinned commit.
4. `schemas/` is locked by hand. Sequencing: the v2 schemas and fixtures are added first (by the normal pipeline, reviewed and merged by Kevin), then `schemas/` is locked. After that, any schema change is a human change.
5. The registry lives in `config/trust-registry.json` (already a locked path).

## Addendum 2026-11-27
(a) `tool_definition` is stored in the MCP manifest so the definition hash can be re-checked. (b) Because `acceptance/` is locked, v2 fixtures are iterated by `test/capability-v2-schemas.test.js`, not by the acceptance suite.

## Addendum 2026-11-27 (fix round 1)
(a) `checkCapabilityAllowed` requires the scope vocabulary and denies without it (`vocabulary_missing`); a manifest scope outside the vocabulary is denied whatever the registry approves. (b) Builtin status comes from a host-held list of `<name>@<definition_hash>` keys passed to `checkCapabilityAllowed`, not from the manifest's `origin` claim; a builtin manifest not on the list is denied (`builtin_not_registered`). (c) MCP tool names may be mixed case, `[A-Za-z0-9_.-]`, up to 128 characters, and are case-sensitive; the manifest name is `<server_id>.<tool name>` and `server_id` stays lowercase. A tool whose real name falls outside that cannot be registered.
