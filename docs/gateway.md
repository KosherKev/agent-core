# Gateway (M1a)

One process, under a different OS identity from the runner, that holds the ledger, the grant engine and the provider credentials and is the only path to a model.

## Trust boundary
- The runner (the agent, under Kevin's normal user) talks to the gateway only over a Unix socket (`gateway.sock`, mode 0600, owned by the gateway user). There is no TCP listener and no network transport in M1a.
- Every connection's peer uid is checked against `allowed_peer_uids` in `config.json` before any byte is read or parsed. An unlisted or unknown peer is disconnected silently.
- The runner never receives a provider key. `modelCall` makes the provider request inside the gateway using `credentials.json` (mode 0600, gateway user only). Keys are redacted from every response, log, journal line, run record and spend file.
- Spend is enforced by the existing locked grant meter (`src/grant/`) and hash-chained ledger (`src/ledger/`), imported unchanged. Every response for a known run carries the grant's remaining budget (integer micro-USD).
- Fail closed everywhere: any error, unknown peer, unknown model, bad config or bad credential file refuses.

## What it holds
- `config.json` (`config_version: 1`; unknown keys and versions are refused), the ledger directory (0700), the credential file, per-run records (`runs/`), a pid file.
- Everything lives under `AGENT_HOME` (default `~/.agent`) unless config gives an absolute path.
- Prices: the tracked `config/prices.json` is read unchanged and stays empty, so no paid model can run. Only `:free` models run. Price keys are `provider|model` (a bare model key never matches).

## API (JSON lines over the socket)
`openRun`, `endRun`, `reserve`, `settle`, `release`, `modelCall`, `journalAppend`, `journalRead`. `pushBranch` and `requestMerge` return `not_implemented` ("not implemented in M1a"). A caller-supplied usage on `settle` is ignored (paid reservations settle at worst case); only `modelCall` measures cost, at the higher of provider-reported and computed cost.
Run records (start, end, duration, model, provider, outcome, `capability_added` events) are gateway-owned lines, because the locked run-journal schema cannot hold them. Journal entries are validated against that schema unchanged.

## CLI
`agent init | doctor | status | ledger:report | gateway`; `run` and `upgrade` print "not implemented in M1a". `agent run` runs doctor first and refuses if it fails; there is no flag or variable to skip it.

## What it does not do yet
No `pushBranch` / `requestMerge` (M1b), no overseer (M1c), no network transport or mTLS, no packaging (systemd, docker, installer), no paid models, no SQLite store. It creates no OS users and changes no system permissions.
Known limit: Node cannot read a peer's uid from a Unix socket (no SO_PEERCRED). The default probe returns "unknown", so the server refuses every connection until a real peer-uid probe is supplied. This must be resolved before the gateway can serve a real runner (see LOG.md).

## By-hand boundary proof (Kevin, on the real machine; NOT verified by tests)
1. Create the gateway user (outside this repo's tooling). Set `identities.gateway_uid` and `runner_uid` in `config.json` to the real uids.
2. As the gateway user: put the credential file in place (mode 0600) and run `agent gateway`.
3. As your normal user run `agent doctor`. All eight checks must pass: (a) config, (b) reachable, (c) socket 0600 owned by the gateway uid, (d) runner cannot read credentials or ledger, (e) runner refused once its allowlist entry is removed, (f) no TCP listener, (g) price table empty or fully priced, (h) locked-set checksum (record it).
4. Confirm by hand that your user cannot `cat` the credential file or read the ledger, and that the only way to a model is through the gateway.
5. Only then lock `src/gateway/` by hand (add it to `.github/locked-paths.txt` and CODEOWNERS). M1a is not trusted until this passes.
