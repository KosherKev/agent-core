# Gateway (M1a)

One process, under a different OS identity from the runner, that holds the ledger, the grant engine and the provider credentials and is the only path to a model.

## Trust boundary: kernel file permissions
- The runner (the agent, under Kevin's normal user) talks to the gateway only over a Unix socket. There is no TCP listener and no network transport in M1a.
- Access is decided by the kernel, not by this code. Node cannot read a connecting process's uid (no SO_PEERCRED), so a peer-uid allowlist cannot be the boundary. Instead:
  - `AGENT_HOME` (config, credentials, ledger, runs, pid file): owned by the gateway user, mode **0700**. The runner cannot enter it.
  - `socket_dir` (a separate directory, not inside `AGENT_HOME`): owned by the gateway user, group = `runner_group`, mode **0750**. The runner group can traverse it, cannot create or delete anything in it.
  - the socket (`<socket_dir>/gateway.sock`): owner gateway user, group `runner_group`, mode **0660**.
  - So only members of `runner_group` can connect, and nothing the runner can do changes what the gateway holds.
- At startup the gateway creates `socket_dir` if it is missing (750, runner group), verifies every owner and mode above, and **refuses to listen** if anything is wrong. After listening it verifies the socket the same way.
- A peer-uid probe is an optional extra hook (`getPeerUid`, with `allowed_peer_uids` in config). None is configured by default; `agent status` and the `ping` reply say `kernel-permissions-only` in that case. If a probe is configured it is enforced and an unknown, throwing or unlisted answer refuses the connection (fail closed).
- The runner never receives a provider key. `modelCall` makes the provider request inside the gateway using `credentials.json` (mode 0600, gateway user only). Keys are redacted from every response, log, journal line, run record and spend file.
- Spend is enforced by the existing locked grant meter (`src/grant/`) and hash-chained ledger (`src/ledger/`), imported unchanged. Every response for a known run carries the grant's remaining budget (integer micro-USD).
- Fail closed everywhere: any error, bad config, wrong layout, unknown model or bad credential file refuses.

## Config (`config.json`, `config_version: 1`; unknown keys are refused)
`socket_dir` (absolute, outside `AGENT_HOME`), `runner_group` (a group name or numeric gid), `identities.{gateway_uid, runner_uid}`, `ledger_dir`, `credentials_file`, `runs_dir`, `pid_file` (all inside `AGENT_HOME`), `providers`, optional `socket_path` (directly inside `socket_dir`, default `gateway.sock`), optional `allowed_peer_uids`, and limits:

| key | default | meaning |
|---|---|---|
| `idle_timeout_ms` | 30000 | closes a connection with nothing in flight. Never fires while a request is being served. |
| `provider_timeout_ms` | 120000 | one provider call, separate from the idle timeout |
| `max_response_bytes` | 8 MiB | provider reply is read as a stream and aborted at the limit; the call settles at worst case |
| `max_request_bytes` | 1 MiB | a longer request line closes the connection |
| `max_connections` | 8 | more are dropped |

## API (JSON lines over the socket; one request in flight per connection)
`ping`, `openRun`, `endRun`, `reserve`, `settle`, `release`, `modelCall`, `journalAppend`, `journalRead`. `pushBranch` and `requestMerge` return `not_implemented` ("not implemented in M1a").
- `ping` returns `{ version, uptime_ms, pid, access, layout }`: no secrets. `layout` lists the gateway's own paths, uid and runner gid so a runner that cannot read `config.json` can still run doctor.
- A second request on a connection while one is in flight gets `busy` (the first is not affected). `endRun` while a model call is in flight on that run is also `busy`.
- `modelCall` requires a client-supplied `request_id` (1 to 100 of `A-Za-z0-9._:-`). One `request_id` is one logical call on a run: a repeat returns the recorded outcome (or waits for the in-flight one) and never reserves or settles a second time; a repeat with different parameters is refused (`request_id_conflict`). If the client disconnects mid-call the gateway still finishes and settles, and a retry with the same `request_id` receives the result. The outcome is final: to try again after an error, use a new `request_id`.
- A caller-supplied usage on `settle` is ignored (paid reservations settle at worst case); only `modelCall` measures cost.
- Run records are gateway-owned lines (the locked run-journal schema cannot hold them); `request` lines record request ids and outcomes, never message content.

## CLI
`agent init | doctor | status | ledger:report | gateway`; `run` and `upgrade` print "not implemented in M1a". `agent run` runs doctor first and refuses if it fails; there is no flag or variable to skip it. `agent gateway` shuts down cleanly on SIGTERM and SIGINT (removes the pid file and socket). On startup a pid file naming a live gateway refuses to start; a stale one is replaced.

## Setup (commands for Kevin to run by hand; the task and the tests never run these)
Names below are examples. Pick your own and put them in `config.json`.

### Linux
```sh
sudo groupadd --system agent-runner            # the runner group
sudo useradd --system --create-home --home-dir /var/lib/agent-gateway --shell /usr/sbin/nologin agentgw
sudo usermod -aG agent-runner agentgw          # the gateway may chgrp the socket to this group
sudo usermod -aG agent-runner "$USER"          # your normal (runner) user; log out and in afterwards
sudo install -d -o agentgw -g agent-runner -m 0750 /run/agent-gateway   # recreate at boot (systemd tmpfiles) or let the gateway create it
sudo install -d -o agentgw -m 0700 /var/lib/agent-gateway/agent-home
id agentgw; id "$USER"                         # note the uids
```
Do not make `agentgw` a member of any group your own user shares other than `agent-runner`, and keep `/var/lib/agent-gateway` traversable (not 0700) or doctor cannot inspect `AGENT_HOME` (it then reports the denial, which still proves the boundary, but check (a) cannot read the mode).

### macOS
```sh
sudo dscl . -create /Groups/agentrunner PrimaryGroupID 4200   # pick a free gid
sudo dscl . -create /Users/_agentgw UniqueID 4201 PrimaryGroupID 20 UserShell /usr/bin/false NFSHomeDirectory /var/agentgw RealName "agent gateway"
sudo dscl . -append /Groups/agentrunner GroupMembership _agentgw "$USER"
sudo install -d -o _agentgw -g agentrunner -m 0750 /var/run/agent-gateway   # cleared at reboot; the gateway recreates it
sudo install -d -o _agentgw -g staff -m 0755 /var/agentgw
sudo install -d -o _agentgw -m 0700 /var/agentgw/agent-home
```

### Both
1. As the gateway user create the config under its `AGENT_HOME`: `sudo -u agentgw env AGENT_HOME=<agent-home> agent init`, then edit `config.json` as that user: real `identities.gateway_uid` / `runner_uid`, `socket_dir`, `runner_group`, and the provider (`providers.<name>.base_url`).
2. As the gateway user write the credential file (`credentials.json`, mode 0600, `{ "providers": { "<name>": "<key>" } }`). Never put a key anywhere else.
3. Start it under the gateway user: `sudo -u agentgw env AGENT_HOME=<agent-home> agent gateway`.

## By-hand boundary proof (Kevin, on the real machine; NOT verified by tests). Do these in order.
1. Create the group and user (Setup above). Confirm: `id agentgw`, and `id` shows `agent-runner` for your normal user (new login).
2. Start the gateway as the gateway user. It must print `gateway running`. If it refuses with `layout refused`, fix exactly what it names.
3. As the gateway user: `ls -ld <agent-home> <socket_dir>` and `ls -l <socket_dir>`. Expect `drwx------ agentgw` (home), `drwxr-x--- agentgw agent-runner` (socket_dir), `srw-rw---- agentgw agent-runner` (socket).
4. As your normal user, by hand: `cat <agent-home>/credentials.json`, `ls <agent-home>/ledger`, `cat <agent-home>/config.json`, `touch <agent-home>/x`, `touch <socket_dir>/x`. Every one must say `Permission denied`.
5. As your normal user: `export AGENT_GATEWAY_SOCKET=<socket_dir>/gateway.sock` then `agent doctor`. (config.json is unreadable to you, so doctor learns the layout from the gateway's `ping`.) All eight checks must pass: (a) config and owners/modes, (b) real `ping`, (c) socket owner/group/mode, (d) boundary probes all denied, (e) kernel-permissions only, (f) no TCP listener, (g) price table, (h) locked-set checksum (record it). On macOS, (f) cannot see another user's process: run `sudo agent doctor --only f` once.
6. Negative checks: `sudo chmod 755 <agent-home>` then restart the gateway: it must refuse to start; `agent doctor` must fail (a) and (d). Restore 700. `chmod 666` the socket as the gateway user: doctor (c) must fail.
7. Run `agent doctor` as the gateway user: (d) must FAIL with "run doctor as the runner user".
8. Only then lock `src/gateway/` by hand (add it to `.github/locked-paths.txt` and CODEOWNERS). M1a is not trusted until this passes.

## What doctor can and cannot prove
It can prove, as the user running it: the config the gateway validated, the owners and modes of AGENT_HOME, config.json, socket_dir and the socket; that the gateway answers a real `ping` over the socket; that this user is denied reading the credential file, listing the ledger, reading config.json and creating files in AGENT_HOME and socket_dir; and that the process answering is a gateway under the gateway uid with no TCP listening socket.
It cannot prove: anything about a user other than the one running it; that no other path to the credential exists (a root-readable backup, a sudo rule, a shared group); that the runner group contains only the intended users; that the gateway binary is the audited one; or that a hostile gateway answers `ping` truthfully (doctor trusts the pid and layout it reports only after cross-checking the process's command line and uid). Root bypasses permissions, so doctor refuses to run its probes as root.

## What it does not do yet
No `pushBranch` / `requestMerge` (M1b), no overseer (M1c), no network transport or mTLS, no packaging (systemd, docker, installer), no paid models, no SQLite store, no native peer-credential reader. It creates no OS users and changes no system permissions (it only creates `socket_dir` if missing).
