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
| `request_read_timeout_ms` | 10000 | from the first byte of a request line to its newline; exceed it and the connection is destroyed. Separate from the idle timeout; never runs while a request is being served. |
| `shutdown_grace_ms` | 10000 | how long in-flight requests may finish after SIGTERM, SIGINT or SIGHUP before the remaining connections are destroyed (0 destroys at once) |
| `request_cache_max` | 1024 | in-memory request-id records across all runs (LRU for settled ones; in-flight ones are never evicted) |
| `run_file_max_bytes` | 64 MiB | most a run file may be when the gateway re-reads it (a retry lookup, a duplicate journal id check, `journalRead`). A bigger file is refused with `run_file_too_large` and a readable message instead of being read in full; writes are not bounded by it. Integer from 1024 to 256 MiB (a run file is read into one JavaScript string, which cannot hold much more; a larger value is refused at config validation with a message saying so). The 64 MiB default is a judgement, not a measurement: no real run file has been measured. |

## API (JSON lines over the socket; one request in flight per connection)
`ping`, `openRun`, `endRun`, `reserve`, `settle`, `release`, `modelCall`, `journalAppend`, `journalRead`. `pushBranch` and `requestMerge` return `not_implemented` ("not implemented in M1a").
- `ping` returns `{ version, uptime_ms, pid, instance_id, access, layout }`: no secrets. `instance_id` is random per gateway start and equals the one in the discovery file (below). `layout` lists the gateway's own paths, uid and runner gid so a runner that cannot read `config.json` can still run doctor.
- A second request on a connection while one is in flight gets `busy` (the first is not affected). `endRun` while a model call is in flight on that run is also `busy`.
- `modelCall` requires a client-supplied `request_id` (1 to 100 of `A-Za-z0-9._:-`). One `request_id` is one logical call on a run: a repeat returns the recorded outcome (or waits for the in-flight one) and never reserves or settles a second time; a repeat with different parameters is refused (`request_id_conflict`). If the client disconnects mid-call the gateway still finishes and settles, and a retry with the same `request_id` receives the result. The outcome is final: to try again after an error, use a new `request_id`. Records live in a bounded in-memory LRU (`request_cache_max`); every finished call is also recorded in the run's record (with its fingerprint and redacted result), and a lookup that misses memory falls back to that record, so eviction can never cause a second reservation or settlement. The persisted record is consulted before the run-state check, so after a restart (or after the run ended) a retry still gets its recorded answer. Order of writes for one call, as the code does it (the sync is injectable and these steps are pinned by tests that record it): `openRun` creates the run file, flushes the file (fsync) and then its directory, and fails closed with `request_start_not_durable` (the run is not opened) if either flush fails. `modelCall` then writes the `request_start` line and flushes the file (the directory too if this write created the file, or the file came from an earlier unflushed write) BEFORE anything is reserved or the provider is called. Next it reserves, writes the `request_reserved` line and flushes it BEFORE the provider is called. If either flush fails the request fails closed with `request_start_not_durable` and the provider is never called; a reservation made for the failed request is released, since nothing was sent. The outcome line of a FAILED or released request (a refused or failed reservation, a provider error, a failed flush above) is flushed before the caller gets the error; if that flush fails too, the caller gets `request_start_not_durable` ("the outcome of this request could not be made durable") and the request is not repeated. The outcome line of a SUCCESSFUL call is written without a flush: the call was paid and settled, and a lost line can only make a retry say `request_outcome_unknown`, never reserve or pay twice. The `request_start` line alone already blocks a retry from reserving or calling the provider, so a lost `request_reserved` or outcome line cannot cause a second reservation; the flushes exist so that the retry message is accurate. These flushes are only as strong as the platform's `fsync` (see the caveat below); if the `request_reserved` flush and the outcome-line flush both fail and the machine then loses power, the run file may hold a reservation line but no outcome line, and the retry may say "its reservation is kept" for a reservation that was released. That is a wrong message, not a second payment.
- If a call was cut off before its outcome was recorded, a retry gets `request_outcome_unknown`, the provider is not called and nothing is reserved again. The message says "its reservation is kept" only when the run file holds a `request_reserved` line for that request (written and flushed right after the reservation, before the provider is called); otherwise it says the run file shows no reservation, and claims none. A call whose failure was recorded (its outcome line is in the file) is answered with that recorded failure instead. Use a new `request_id` to try again. On shutdown the gateway waits (up to `shutdown_grace_ms`) for calls already running to persist their outcome, even if the client has hung up; a call still running at the deadline stays reserved.
- A caller-supplied usage on `settle` is ignored (paid reservations settle at worst case); only `modelCall` measures cost.
- Run records are gateway-owned lines (the locked run-journal schema cannot hold them); `request` lines record the request id, its parameter fingerprint and the outcome, and hold the (redacted) result of the call so a retry can be answered after eviction. They sit in the run file (mode 0600, gateway user only); the request messages are never stored.

**Durability caveat.** Linux is the target. On macOS `fsync` does not force a full flush to the drive (that needs `F_FULLFSYNC`, which is not used), so "durable" here is weaker on macOS than on Linux. No power-loss test has been run on any machine; the durability behaviour is covered by tests with an injected sync only.

## CLI
`agent init | doctor | status | ledger:report | gateway`; `run` and `upgrade` print "not implemented in M1a". `agent run` runs doctor first and refuses if it fails; there is no flag or variable to skip it. `agent status` run as the runner, when `config.json` is denied (EACCES or EPERM), prints the "not readable by this user (expected for the runner)" line and **exits 0**: that is the expected state for the runner, not a failure, and `agent doctor --gateway-user <name>` is the real health check (decision by the spec author, round 4). A readable but invalid or missing config, a gateway that is not reachable, or any other failure still exits non-zero. `agent gateway` stops gracefully on SIGTERM, SIGINT or SIGHUP: it stops accepting, drops idle connections at once, lets in-flight requests finish for up to `shutdown_grace_ms`, then destroys what is left and exits. A second signal destroys everything and exits immediately. A call cut off this way keeps its ledger reservation (nothing is settled or released by shutdown). The pid file, the socket and the discovery file are removed on every exit path that can run code (a SIGKILL or power loss cannot; the next start replaces stale ones). On startup a pid file naming a live gateway refuses to start; a stale one is replaced.

## Discovery file
The gateway writes `<socket_dir>/gateway.json` (owner gateway user, group `runner_group`, mode 0640) after the socket is in place: `{ socket_path, instance_id, gateway_uid, gateway_gid, pid }`. `instance_id` is random per start and `ping` returns the same value. Doctor uses it to tell the real gateway from a socket someone else put at the same path.

## Setup (commands for Kevin to run by hand; the task and the tests never run these)
Names below are examples. Pick your own and put them in `config.json`.

### Linux
```sh
sudo groupadd --system agent-runner            # the runner group
sudo useradd --system --create-home --home-dir /var/lib/agent-gateway --shell /usr/sbin/nologin agentgw
sudo usermod -aG agent-runner agentgw          # the gateway may chgrp the socket to this group
sudo usermod -aG agent-runner "$USER"          # your normal (runner) user; log out and in afterwards
sudo install -d -o agentgw -g agent-runner -m 0750 /run/agent-gateway   # recreate at boot (systemd tmpfiles) or let the gateway create it
sudo chmod 755 /var/lib/agent-gateway         # see the note below
sudo install -d -o agentgw -m 0700 /var/lib/agent-gateway/agent-home
id agentgw; id "$USER"                         # note the uids
```
Observed in the proof: on Ubuntu 24.04, `useradd --create-home --home-dir /var/lib/agent-gateway` creates that directory as mode 0750 owned `agentgw:agentgw`. The proof run set it to 755 (`chmod 755 /var/lib/agent-gateway`) before the checks. `agent-home` inside it stays 0700, and its group is root with the `install -d -o agentgw -m 0700` above.

**Socket directory.** These docs and the proof use `socket_dir` = `/run/agent-gateway` on Linux. `agent init` writes the default `/var/run/agent-gateway`; on Linux `/var/run` is a symlink to `/run`. That default was not tested on Linux, so set `socket_dir` explicitly in `config.json`.

**Runner account requirement.** The runner account must have no root-equivalent access: no sudo rule, no `wheel` or `sudo` group membership, no `docker` group membership and no root-owned setuid helper it can run. Doctor cannot see any of these (see "What doctor can and cannot prove").
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

### Install the audited copy (as root, once)
The runner user must not be able to edit gateway code, so install it root-owned, pinned to a commit, with no dependency install scripts run as root. `npm ci --omit=dev` alone would run those scripts as root.
```sh
sudo git clone <repo-url> /opt/agent-core                 # root-owned location
sudo git -C /opt/agent-core checkout <sha>                # the commit you audited
sudo git -C /opt/agent-core rev-parse HEAD                # record this sha; it is the audited commit
cd /opt/agent-core && sudo npm ci --omit=dev --ignore-scripts
```
Run the CLI by full path everywhere so PATH and shebangs do not matter. On Linux, commands below that say `agent` mean `/opt/agent-core-node /opt/agent-core/bin/agent` (see Interpreter). On macOS they mean `node /opt/agent-core/bin/agent`.

### Interpreter (Linux)
The gateway must be started with a Node binary the runner cannot write. In the proof, the nvm Node lived under a directory the runner's group could write and under the runner's own home (0750), so the gateway user could not even execute it. The fix used was a root-owned copy, and every gateway and doctor command then used `/opt/agent-core-node`:
```sh
sudo install -o root -g root -m 0755 "$(command -v node)" /opt/agent-core-node
```
The locked-set checksum (doctor check h) covers the locked files, not the interpreter that runs them.

### Both
Commands run as the gateway user use `sudo runuser -u agentgw --` (in the proof `sudo -u agentgw` prompted for a password, because sudoers allowed only `(root) NOPASSWD`, and `sudo runuser -u agentgw -- <cmd>` worked). `sudo -u agentgw` is the alternative where your sudoers allows it.
1. As the gateway user create the config under its `AGENT_HOME`: `sudo runuser -u agentgw -- env AGENT_HOME=<agent-home> /opt/agent-core-node /opt/agent-core/bin/agent init`, then edit `config.json` as that user: real `identities.gateway_uid` / `runner_uid`, `socket_dir`, `runner_group`, and the provider (`providers.<name>.base_url`).
2. As the gateway user write the credential file (`credentials.json`, mode 0600, `{ "providers": { "<name>": "<key>" } }`). Never put a key anywhere else.
3. Start it under the gateway user: `sudo runuser -u agentgw -- env AGENT_HOME=<agent-home> /opt/agent-core-node /opt/agent-core/bin/agent gateway`.

## By-hand boundary proof (Kevin, on the real machine; NOT verified by tests). Do these in order.
1. Create the group and user (Setup above). Confirm: `id agentgw`, and `id` shows `agent-runner` for your normal user (new login).
2. Start the gateway as the gateway user. It must print `gateway running`. If it refuses with `layout refused`, fix exactly what it names.
3. As the gateway user (`sudo runuser -u agentgw -- ls -ld <agent-home> <socket_dir>` and `sudo runuser -u agentgw -- ls -l <socket_dir>`). Expect `drwx------ agentgw` (home), `drwxr-x--- agentgw agent-runner` (socket_dir), `srw-rw---- agentgw agent-runner` (socket).
4. As your normal user, by hand: `cat <agent-home>/credentials.json`, `ls <agent-home>/ledger`, `cat <agent-home>/config.json`, `touch <agent-home>/x`, `touch <socket_dir>/x`. Every one must say `Permission denied`.
5. As your normal user: `export AGENT_HOME=<agent-home>` (the gateway's AGENT_HOME) and `export AGENT_GATEWAY_SOCKET=<socket_dir>/gateway.sock`, then `/opt/agent-core-node /opt/agent-core/bin/agent doctor --gateway-user agentgw` (use your gateway user's name). Why `AGENT_HOME`: doctor reads `<AGENT_HOME>/config.json` (`agentHome()` in `src/gateway/config.js` uses `AGENT_HOME` when set and non-blank, else `~/.agent`). Only when that read is DENIED does it learn the layout from `ping`, and the gateway's reported `layout.home` must equal this home. If the file is merely MISSING (the usual state of `~/.agent` for the runner), check (a) fails and (b), (c), (d), (f) are skipped. `config.json` is then unreadable to you, so doctor learns the layout from the gateway's `ping`, but it checks who the gateway is against the name YOU typed, never against the environment. Without `--gateway-user` the trust checks are refused. All eight checks must pass: (a) config and owners/modes, (b) real `ping`, (c) socket owner/group/mode, (d) boundary probes all denied, (e) kernel-permissions only, (f) no TCP listener, (g) price table, (h) locked-set checksum (record it). On macOS, (f) cannot see another user's process: run `sudo node /opt/agent-core/bin/agent doctor --gateway-user <name> --only f` once. `--only` always prints `PARTIAL: N of M checks run`, never "all checks passed", and exits non-zero if any selected check fails; `agent run` still needs the FULL doctor.
   **macOS limitation.** On macOS the full doctor cannot pass as the runner, because check (f) fails closed when it cannot inspect the gateway process's sockets as another user. That is deliberate and (f) is not weakened. The documented route on macOS is `sudo agent doctor --gateway-user <name> --only f`, which is PARTIAL by definition. macOS runs are a rehearsal only; the Linux run is the proof.
   **Weaker evidence.** A proof whose runs used `sudo -u <user>` with a cleaned environment is weaker evidence than a clean login as that user (ssh or a fresh console login): the environment and the session are not what the runner really gets. Use a clean login for the passing run and for the denied checks.
Run doctor as your normal user: never under `sudo` and never as the gateway user (it refuses root and the gateway uid; the exceptions are the documented macOS `sudo agent doctor --only f` above and the deliberate negative check in step 7).
6. Negative checks (keep `AGENT_HOME` and `AGENT_GATEWAY_SOCKET` exported, run doctor as the normal user):
   - `sudo chmod 755 <agent-home>` then restart the gateway: it refuses to start ("AGENT_HOME mode is 755, it must be 700"). With the gateway down doctor cannot learn the layout from `ping`, so (a), (b), (c), (d), (e) and (f) all FAIL. A six-failure output is expected, not only (a) and (d). Restore 700 and restart the gateway.
   - `sudo runuser -u agentgw -- chmod 666 <socket_dir>/gateway.sock` (the socket as the gateway user): doctor (c) must fail with "socket mode is 666, it must be 660". Restore 660 (or restart the gateway).
6b. Impostor check (replay). **This procedure was run once, in a container (see "Proof record"). A clean VM re-run with a runner that has no sudo and no docker group is still required before M1b depends on it.** `socket_dir` is 0750, so a normal user cannot bind there; only root or the gateway user can. A bare "answer ping with anything" fails (b) as "not a well-formed ping" and only (c) names the owner, so the impostor must replay a genuine ping reply to exercise all four trust-anchor reasons. `$SD` is your `socket_dir`.
   1. As the normal user, while the real gateway runs, capture a genuine ping reply:
      `node -e "const {createConnection}=require('net');const c=createConnection(process.env.AGENT_GATEWAY_SOCKET);c.on('connect',()=>c.write(JSON.stringify({id:1,method:'ping',params:{}})+'\n'));c.on('data',d=>{require('fs').writeFileSync('/tmp/real-ping.json',d);c.end()})"`
   2. Stop the gateway (remove a stale socket file if left).
   3. As root, bind the same path and replay it:
      `sudo env AGENT_GATEWAY_SOCKET=$SD/gateway.sock node -e "const net=require('net'),fs=require('fs');const real=fs.readFileSync('/tmp/real-ping.json','utf8').trim();net.createServer(c=>c.on('data',d=>{let id=1;try{id=JSON.parse(String(d).split('\n')[0]).id}catch{};const r=JSON.parse(real);r.id=id;c.write(JSON.stringify(r)+'\n')})).listen(process.env.AGENT_GATEWAY_SOCKET)"`
   3b. The impostor socket must be mode 660 with group = the runner group, or the runner cannot even connect and doctor fails at "gateway did not answer" without reaching the trust-anchor checks. On macOS the new socket inherits the group of its directory. On Linux it gets the creator's group, so set it explicitly: `sudo chgrp <runner-group> $SD/gateway.sock && sudo chmod 660 $SD/gateway.sock` (confirmed on Linux in the container proof: the impostor needed the explicit `chgrp` and `chmod 660`).
   4. As the normal user, `agent doctor --gateway-user <name>` must fail (b), (c), (d), (e), (f), each with a "trust anchor failed" reason (socket owned by uid 0, or discovery file missing). Since round 4 doctor sends nothing to the socket when a filesystem trust check fails, so this impostor is rejected before any ping and (a) also fails ("trust anchor failed"; it cannot learn a layout it refuses to ask for). This ordering is covered by fakes; the one real run was in a container (see "Proof record"). Then remove `/tmp/real-ping.json`, remove the impostor socket, and restart the real gateway.
7. Run doctor as the gateway user (`sudo runuser -u agentgw -- env AGENT_HOME=<agent-home> /opt/agent-core-node /opt/agent-core/bin/agent doctor`): (d) must FAIL with "run doctor as the runner user".
8. Only then lock `src/gateway/` by hand (add it to `.github/locked-paths.txt` and CODEOWNERS). M1a is not trusted until this passes. Done: `src/gateway/`, `bin/agent` and the gateway tests are now locked. The locked-set checksum recorded before locking (see "Proof record") differs from the one after.

## Proof record
- Date: 2026-11-26.
- Commit: af48a90.
- Environment: GitHub Codespace, an Ubuntu 24.04 container (not a VM), Node v24.22.2.
- Locked-set checksum before locking `src/gateway/`: sha256 47a52caeb7a09b80990d7c5b47b7ec1b8bc7aa94450324850b12598e183540fa over 30 files. It differs after the lock.
- Results, all as the runner user unless noted:
  - Step 3: modes as documented (`socket_dir` drwxr-x--- agentgw:agent-runner, socket srw-rw----, `agent-home` drwx------).
  - Step 4: all five attempts denied.
  - Step 5: all eight checks passed, exit 0. Check (f) verified the gateway pid and found no TCP listener as a non-root runner.
  - Step 6: with `agent-home` at 755 the gateway refused to start ("AGENT_HOME mode is 755, it must be 700") and doctor failed exactly (a) to (f). A 666 socket failed (c) with "socket mode is 666, it must be 660", and (e) failed as a cascade. After restoring 700 and restarting, doctor passed all eight again.
  - Step 6b: an impostor replaying a genuine ping, owned by root, `chgrp agent-runner`, mode 660, failed (a) to (f) with "the socket is owned by uid 0, not agentgw (uid 999)". The discovery file was also missing at that point (the real gateway removes it on shutdown), so two trust-anchor reasons fired together. Step 3b is confirmed on Linux: the impostor needed an explicit `chgrp` and `chmod 660`.
  - Step 7: doctor as the gateway user failed (d) with "run doctor as the runner user", failed (e) as a cascade, and printed the note that the run proves nothing about the runner boundary.
- Limits:
  - It ran in a container, not a VM. A clean VM re-run with a runner that has no sudo and no docker group is still required before M1b depends on it.
  - The proof's runner account (`codespace`) had passwordless sudo and was in the `docker` group, both root-equivalent. The proof therefore shows that kernel permissions deny an ordinary user; it does not show that the real runner account has no root path. Doctor cannot detect sudo, docker or wheel membership.
  - `socket_dir` was `/run/agent-gateway`. Whether doctor's symlink check accepts the `agent init` default `/var/run/agent-gateway` was not tested.

## What doctor can and cannot prove
**A doctor run by a compromised runner proves nothing.** The runner controls its own environment, its own copy of `agent` and anything that user can start, so a doctor it runs can be made to say anything. The proof is a human running `agent doctor --gateway-user <name>` from a clean login as the runner user, on a machine where `agent` itself is the audited copy.
When `config.json` is unreadable (the normal runner case) doctor trusts nothing it is told by the environment: `AGENT_GATEWAY_SOCKET` is only a hint of where to look. It requires `--gateway-user`, resolves it to a uid, and then verifies, **before sending a single byte to the socket**, that `socket_dir`, the socket and `gateway.json` are all owned by that uid, that `socket_dir` is not writable by the doctor's own identity, that no component of the path from the filesystem root to `AGENT_HOME`, `socket_dir`, the socket or `gateway.json` is a symbolic link (each is `lstat`ed; the only exception is macOS's root-owned `/var` link to `private/var`, exact target only, never on Linux; `/tmp` and `/etc` are not allowed), that `gateway.json` is in the configured runner group (a different or unresolvable group fails, naming both), that `gateway.json` names that uid and that socket path, and, only after those filesystem checks pass and one `ping` has been sent, that the `instance_id` in `ping` equals the one in `gateway.json`, the pid matches and the runner group (which only the ping layout tells doctor) matches the file's group. The filesystem checks never wait for the socket; the runner-group check necessarily follows the ping. Any mismatch fails checks (b), (c), (d) and (f) with the reason named. A run where `config.json` is readable (the gateway user's own) is flagged: it proves nothing about the runner boundary.
It can prove, as the user running it: the config the gateway validated, the owners and modes of AGENT_HOME, config.json, socket_dir and the socket; that the gateway answers a real `ping` over the socket; that this user is denied reading the credential file, listing the ledger, reading config.json and creating files in AGENT_HOME and socket_dir; and that the process answering is a gateway under the gateway uid with no TCP listening socket.
It cannot prove: anything about a user other than the one running it; that no other path to the credential exists (a root-readable backup, a sudo rule, a shared group); that the runner group contains only the intended users; whether the runner account has root-equivalent access (sudo, wheel, the docker group, root-owned setuid helpers); that the gateway binary is the audited one; or that a hostile gateway answers `ping` truthfully (doctor trusts the pid and layout it reports only after cross-checking the process's command line and uid). Root bypasses permissions, so doctor refuses to run its probes as root.

## What it does not do yet
No `pushBranch` / `requestMerge` (M1b), no overseer (M1c), no network transport or mTLS, no packaging (systemd, docker, installer), no paid models, no SQLite store, no native peer-credential reader. It creates no OS users and changes no system permissions (it only creates `socket_dir` if missing).
