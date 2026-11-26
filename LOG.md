# LOG

## 2026-11-26 (Gateway round 6: stale durability docs, durable outcome line, release-path tests)
Branch task/gateway-round-6, based on main 7aa93e0 (round 5 merge). Baseline 665 tests; after: 670 on Node 22.23.5 and 24.22.3. The reviewers' findings reached me second hand; each was checked in the code.

### Per item
1. Docs finding 1 ("best-effort" `request_reserved`): DONE, verified in code. The word survived only in the outcome-unknown paragraph; the code flushes that line before the provider is called. Rewritten.
2. Docs finding 2 (directory flushed only when that write created the file): NOT PRESENT in docs/gateway.md at 7aa93e0. The API paragraph already said `openRun` flushes file then directory. The wording exists only as an accurate comment on `writeDurable` in `runs.js` (a later durable write also flushes the directory if the file came from an earlier unflushed write), which I left. I rewrote the paragraph to state the whole order (openRun file+dir, request_start, reserve, request_reserved, provider, outcome line) so it cannot be misread.
3. Docs finding 3 (cut-off paragraph): DONE, verified. The outcome-unknown text sat after the durability caveat with a leading space, detached from the list. It is now a list bullet and the caveat follows the list.
4. Outcome line durable: DONE for FAILED or released requests (`runs.recordRequestFailed`, flushed through the same injectable sync; if the flush fails the caller gets `request_start_not_durable` with its own message, and the entry stays pinned). Deviation, on purpose: the SUCCESS outcome line is still written without a flush. Making it fail closed would hand a paid, settled result away as an error; a lost success line can only produce `request_outcome_unknown`, never a second reservation. The spec only asked for failed or released requests. The existing `durabilityError` text says "the provider was not called", which would be false after the provider ran, so the outcome-line failure has its own message under the same code.
5. Tests (test/gateway-round6.test.js, 5 new): (a) failed `request_reserved` flush: reservation released (budget reserved 0), provider never called, order recorded; (b) retry in the same process and from a second gateway over the same run file: durable failure answer, never "reservation kept", no second reserve; (b2) both flushes fail: still durability error, no second reserve or provider call; (c) failed outcome flush after a provider 500 fails closed with the durability error and is not repeated; (c2) healthy disk: outcome flushed after the provider, plain `provider_rejected` returned. (d) the round 5 order tests pass unchanged (file not edited).
6. Finding 6 (duplication, `run_file_max_bytes` special case): left alone as instructed.

### What the spec got wrong or left open
- Finding 2 is not in the docs (above).
- Power loss is untested. If both the `request_reserved` and outcome flushes fail and power is then lost, a retry may still say "reservation kept" for a released reservation (a wrong message, not a double payment). The docs say so. Kevin's Linux power-loss check remains manual.
- Open question for Kevin: should a successful call whose outcome flush fails also fail closed? I chose not to (see item 4).

### Verification
- Changed: src/gateway/api.js, src/gateway/runs.js, docs/gateway.md, test/gateway-round6.test.js, LOG.md. No locked path, no new dependency. self-model.json unchanged (check passes).
- `npm test`: Node 22.23.5 670 tests, 670 pass, 0 fail, 0 skipped (includes test/grant-adapter.test.js and the locked-paths guard); Node 24.22.3 670/670. `npm run check:self-model` up to date on both. `npm audit --omit=dev` 0 vulnerabilities.
- Nothing missing on this machine (Mac mini); no servermac-only path or tool was needed.

## 2026-11-24 (Gateway round 5: durable run file, durable reservation line, review leftovers)
Branch task/gateway-round-5, based on origin/main 82ba650 (round 4 merge). Baseline before my change was 659 tests (round 4's own count); after: 665 on Node 22.23.5 and 24.22.3.
The reviewers' claims reached me second hand; each was checked in the code, and what I found is stated per item.

### Per item
1. DONE, verified in code: finding true. `runs.start()` used `appendFileSync` with no flush, so the run file (and its `run_start` line) was never flushed or directory-synced by anything before `request_start`; and round 4's directory flush fired only when the `request_start` write itself created the file, which it never did in a real flow. Now `runs.start()` is async and durable (write, fsync file, fsync directory) using the same injectable `fileSync`, and `openRun` awaits it. Any other non-durable write that creates a run file marks it, and the next durable write flushes the directory once (a per-store set, `dirPending`). Failure: `openRun` fails with `request_start_not_durable` (the run is not opened; a partial file may remain, so the run id is used up: use a new run_id). Tests: `test/gateway-round5.test.js` (open flushes file then dir; the side-path file gets its directory flushed once). Three round 4 tests had to change because a failing or gated sync now also stops `openRun`: they now break or gate the sync only after the run is open.
2. DONE, verified in code. Ordering is now: `request_start` flushed, then `doReserve`, then `request_reserved` flushed, then the provider. Before: `request_reserved` was a best-effort unflushed write. Is a second reservation possible when `request_reserved` is lost? No: `findRequest` returns the `request_start` line as `pending`, and `outcomeOf` answers `request_outcome_unknown` without reserving or calling the provider (api.js, the retry path before `callModel`). So the existing design already blocks a double spend if the start line is durable; the flush of `request_reserved` is kept as asked, and only makes the retry message accurate. The real hole was the start line not being durable (item 1). Failure of the reserved-line flush: the reservation is released (nothing was sent) and the call fails with `request_start_not_durable`; edge case: if that failure were followed by a failure to record the outcome line too, a later retry would read "its reservation is kept" although it was released. Tests: one order test (run_start sync, dir, request_start sync, reserve, request_reserved sync, provider) and one test failing each of four steps: the provider is never called.
3. DONE, verified in code: `LIMITS.run_file_max_bytes` upper bound 1 GiB to 256 MiB; a value above it gets its own message naming the ceiling and why. Default (64 MiB) unchanged, documented in docs/gateway.md as a judgement, not a measurement. I did not measure the JS string limit myself; 256 MiB is the spec's number and sits well under V8's ~512 MB (taken from the spec). Test: boundary values and message.
4. DONE, verified in code: `SYSTEM_SYMLINKS.darwin` is now `/var` only. Checked what else could need `/tmp` or `/etc`: the symlink walk only runs over AGENT_HOME, socket_dir, the socket and the discovery file; the only `/etc` uses in src/gateway are file reads (`/etc/group`, `/etc/passwd`) that do not pass through it, and `/tmp` appears only in the docs' manual steps as a scratch file, not a trust path. Tests: key list is exactly `/var`; `/tmp` and `/etc` links are refused on darwin (test updated in gateway-doctor.test.js, new one in round5).
5. DONE (spec item 5): the test already half existed (a file with broken JSON gave exit 1) but not a file that parses and fails validation. Added: unknown key, a limit over the new ceiling, and a wrong config_version each print `config: INVALID` and exit non-zero; the denied case still exits 0.
6. DONE (spec item 6): docs/gateway.md says Linux is the target, macOS fsync is weaker (no `F_FULLFSYNC`), no power-loss test has been run on any machine. Also updated the symlink and `run_file_max_bytes` text.
7. This file. Nothing skipped.

### What the spec got wrong or left open
- Item numbering: the "task" section skips the 5th research finding's number; I used the task's numbering above.
- The spec said the dir sync happens "once per run file on first creation by any other path"; a non-durable write cannot itself wait for a flush, so the directory is flushed by the next durable write for that file. In the gateway every run file is created by `start()`, so this is a safety net.
- `agent status` finding 6 was partly covered already (see item 5).
- Not done and not asked: `F_FULLFSYNC` on macOS (no portable Node API without a native addon or a new dependency).

### Verification
- Locked paths: only src/gateway/*, docs/gateway.md, LOG.md and test/gateway-*.test.js changed. No new dependency, no new banned token, README.md not touched (it quotes none of this).
- `npm test`: Node 22.23.5 665 tests, 665 pass, 0 fail, 0 skipped; Node 24.22.3 665 tests, 665 pass, 0 fail, 0 skipped. `npm run check:self-model`: up to date on both (no regeneration). `npm audit --omit=dev`: 0 vulnerabilities on both.

### Open questions for Kevin
- Should the outcome line (`request`) also be flushed? Losing it is safe today (retry says outcome unknown, never re-runs), but a paid model may want the answer kept.
- Run the power-loss and Linux boundary proofs by hand; nothing here proves crash-safety.

## 2026-11-24 (Gateway round 4: durable request_start, remaining doctor lows, status exit code)
Branch task/gateway-round-4, based on origin/main 38c4170. Baseline `npm test` on Node 24.22.3 after `npm ci`: 643/643. After: 659/659 (see Verification).
The round 3 reviewer findings were given to me second hand; each was checked in the code, and what I found is stated per item.

### Per item
1. DONE, verified in code: finding true. `recordRequestStart` was a plain `appendFileSync`, no fsync. Now `runs.recordRequestStart` is async and durable: open, write, `fileSync.file(fd)`, and `fileSync.dir(runs_dir)` only if that write created the file (the file normally exists already from `run_start`, which itself is not flushed, so the directory flush only fires for a start line on a new file). The default is real `fsync`; `createRunStore(dir, { fileSync })` takes `{ file(fd), dir(path) }`, either may return a promise. `api.js` awaits it before `doReserve` and before the provider call; any failure (flush or open/write) becomes `request_start_not_durable` and nothing is reserved. That outcome is then recorded like any other failed outcome, so a retry with the same request_id replays it and never calls the provider (use a new id). Tests: provider not called on a sync throw, on an async rejection, on a dir-sync failure; provider not called while the sync promise is pending and called after it resolves; dir flushed only when the write created the file. One existing test (`round 2 low`, restart test) expected `internal` for an unwritable run file; it now expects `request_start_not_durable` (the spec asked for a distinct error). Not flushed, by choice: `run_start`, `request_reserved`, the outcome line (losing the outcome line is safe: the start line makes the retry say outcome unknown).
2. DONE, verified in code: finding true, and worse than reported: the run file recorded NO reservation at all, only the start line, so the file could not distinguish the two cases. Added a best-effort `request_reserved` line written right after `doReserve`; `findRequest` returns `pending` plus `reserved`. Messages: with the line, "its reservation is kept"; without, "the run file shows no reservation for it, so none is claimed here". The `reserved` line is not flushed, so after a power loss a real reservation could show as "none claimed"; the wording says only what the file shows and does not say that no reservation exists. Tests: both messages, and the order start, reserved, request in a real call.
3. DONE, verified in code: finding true. `tools.js` kept a module-level `lastRefusal`; `doctor.js` read it for the `--gateway-user` message and for check (f). It could carry a reason from an earlier lookup into a later check (for example (f) on Linux never calls a tool, so any earlier refusal leaked). Removed the shared state and the `lastToolRefusal` export; the reason now travels with the `ToolError` and reaches doctor through an `onRefusal(reason)` callback passed per lookup (`resolveUser`, `tcpListeners`). Test: a refusal reported while resolving the user does not appear in any other check, a refusal from the listener probe shows only in (f), and the module has no `lastToolRefusal`. `test/gateway-tools.test.js` lost its one use of it.
4. DONE, verified in code: `agent status` with a denied (EACCES/EPERM) config prints the same line and exits 0 (decision by the spec author, recorded in docs/gateway.md). Readable-but-invalid and missing configs still print `config: INVALID` and exit 1. The existing test expected exit 1 for the denied case; updated, and a missing-config case added.
5. DONE, verified in code: finding true, no gid check existed. Doctor now requires the discovery file's gid to equal the runner group's gid and names both in the reason; an unresolvable or unreported group fails closed with its own reason. Caveat: in the runner case the runner group comes from the gateway's own ping layout (config.json is unreadable), so this compares the file with what the gateway says its runner group is; it is only as strong as the rest of the anchor (the uid checks). It runs after the ping, because of that. Tests: match, mismatch, missing group config.
6a. DONE. Doctor lstat-walks every component from the root to AGENT_HOME, socket_dir, the socket and the discovery file (`findSymlinkComponent` in layout.js, exposed as probe `symlinkComponent`, injectable). A symlink fails the trust anchor with a reason naming the component and target; a component that cannot be inspected, or a missing probe, fails closed. macOS exception: `/var`, `/tmp` and `/etc` only, only when the link is at the filesystem root, owned by root and points exactly at `private/var`, `private/tmp`, `private/etc`; only on darwin; none on Linux. The "resolve realpath once and require the configured path to equal it" option is stricter, but it would reject `/var/run/agent-gateway` (the documented macOS socket_dir) and every temp dir used by the tests, so it is not workable; the exact allowlist is the strictest option that works. Only these three entries are allowed, no others were found necessary (checked on this Mac: `/var/folders/...` and `/var/run` pass; `/tmp`, `/etc` are listed because they are the other root links on macOS but nothing here depends on them). The check only runs in the trust anchor (config.json unreadable); the readable-config run is the gateway side and proves nothing anyway.
6b. DONE. The anchor is split. Stage 1 (owners, modes, discovery file contents, symlinks, write probe) uses only the filesystem and the paths the human gave and runs first. If it fails, no ping is sent: (a) fails with "trust anchor failed: ..." (it cannot learn a layout it refuses to ask for) and (b) to (f) fail with the same reasons. Stage 2 (instance_id, pid, ping layout uid, runner group) needs the ping and runs after it. Consequence for Kevin's proof: the impostor in step 6b of docs/gateway.md is now rejected before any ping and (a) fails too; docs updated and marked as covered by fakes only, not a VM. Test: a real unix socket server records connections and bytes: zero for seven different filesystem failures, exactly one connection for a passing run; plus a fake `ping` that counts calls. Not changed: with a readable config.json (gateway side) check (b) still pings; that mode has no trust anchor and proves nothing.
6c. DONE. `run_file_max_bytes` config key (default 64 MiB, integer 1024 to 1 GiB, validated, listed in docs) and `createRunStore(dir, { maxBytes })`. Every re-read of a run file (`findRequest`, the duplicate journal id check, `read`) opens it, checks `fstat` size and refuses before reading: `RunFileTooLarge`, API code `run_file_too_large`, message "the run record is N bytes, over run_file_max_bytes (M); refusing to read it (fail closed)". Writes are not bounded. Wired from config in `startGateway`. A consequence to know: a run that grows past the bound can no longer start new modelCalls (they need the re-read) until the bound is raised.
7. This file. Nothing skipped.

### What the spec got wrong or left open
- Item 2: the spec said distinguish "start with reservation" from "start with none" as if the run file showed it; it did not (no reservation line existed). Added one.
- Item 5: the runner group in the runner case is the gateway's own claim (see item 5).
- Item 6b: the runner-group comparison cannot precede the ping (its input only arrives with the ping); everything the spec listed (ownership, modes, symlinks, discovery file) does precede it.
- The spec lists `test/gateway-*.test.js` as writable; `test/gateway-helpers.js` does not match and was not touched, so the new tests build their own api in `test/gateway-round4.test.js`.

### Verification
- Locked paths: `git diff --name-only origin/main...HEAD` lists only src/gateway/*, docs/gateway.md, LOG.md and test/gateway-*.test.js. No change under src/grant/, src/ledger/, src/builder-*.js, acceptance/, .github/, config/, test/grant-adapter.test.js. README.md not touched (it quotes none of the changed text). No new dependency. No new banned token (the suite's allowlist test passes unmodified).
- `npm test`: Node 22.23.5 659 tests, 659 pass, 0 fail, 0 skipped; Node 24.22.3 659 tests, 659 pass, 0 fail, 0 skipped (baseline 643, +16 new). `npm run check:self-model`: up to date (no regeneration needed). `npm audit --omit=dev`: 0 vulnerabilities.

### Open questions for Kevin
- Item 1 flushes only the start line. Should the outcome line and `request_reserved` be flushed too? Skipped because losing either is safe today (retry says outcome unknown), but a paid model may want a different answer.
- Default `run_file_max_bytes` of 64 MiB is a guess; no real run file has been measured.
- Allowed macOS system links are `/var`, `/tmp`, `/etc`. Tell me if you want them narrowed to `/var` only.
- Linux behaviour of everything here (group, symlink, ordering) is not run on a Linux box.

## 2026-11-24 (Gateway round 3: proof findings, restart-retry, shutdown ordering, absolute tool paths)
Branch task/gateway-round-3, based on origin/main 5e7554f. Baseline `npm test` on Node 24.22.3 (after `npm ci`): 624/624.

### Per item
1-4. Docs (docs/gateway.md): done. macOS full-doctor limitation and the `sudo agent doctor --gateway-user <name> --only f` route (PARTIAL; macOS is a rehearsal, Linux is the proof); step 6b impostor socket mode 660 and runner group (macOS inherits the directory group, Linux set explicitly, marked NOT verified); (e) listed as failing on the replay impostor (b, c, d, e, f); `sudo -u` with cleaned environment is weaker evidence than a clean login. Taken from the spec, not re-run (no VM): the macOS/Linux group behaviour and the failing set.
5. done. Verified in code: the `FAIL (e) undefined:` in the proof was NOT caused by an undefined field as the spec guessed: `CHECK_NAMES` in doctor.js had no entry for `e`, so any anchored failure of (e) printed `undefined` as its name. Fixed (name added). Also fixed: missing `st.uid`, `st.code`, discovery `gateway_uid`, ping layout `gateway_uid`, the `peerDecision()` empty/partial answer, and the same in layout.js (`st.code/uid/gid`). Tests assert no "undefined" anywhere in the output.
6. done. Check (a) via ping now reads "config.json was NOT read by doctor ... the layout is the gateway's own report, unverified by doctor ...". No "validated". Test added; the old tests matched /unreadable here/, which is kept.
7. done. `agent status` with EACCES/EPERM prints "config: not readable by this user (expected for the runner ...) ... agent doctor --gateway-user <name>"; readable-but-bad stays INVALID. Both tested (denied test skips as root).
8. done. modelCall looks up the persisted record before the run-state check (only for a well-formed request on a run file that exists and is not open). (i) settled: same stored result, conflict on a different fingerprint, also after endRun; (ii) NEW: a `request_start` line is written before anything is reserved; a start without a finish gives `request_outcome_unknown` (no provider call, no reservation, existing reservation kept); (iii) not persisted: unchanged (`run_not_open` on a closed run). If the start line cannot be written nothing is reserved or sent (test). Tests simulate a restart with a new api over the same files.
   Double-reservation question, resolved by reading the code: the statement that NO double reserve is possible after a restart was true (round 2 review notes, "G1"). After a restart `open` is empty, so `run()` threw `run_not_open` before any reserve, and `openRun` refuses the old id (`run_exists`). The statement in the shutdown finding that "a retry after restart then reserves and pays again" was not reachable in the code as it stood. What was real: the retry got `run_not_open` instead of the recorded result (case i), and a cut-off call was indistinguishable from "never started" in the record (case ii), now distinguishable. Test "restart, case (ii)" also asserts `run_exists` and `run_not_open` leave the ledger at one reserve.
9. done. `api.drain()` resolves when every detached modelCall has persisted its outcome; `stop()` finishes only when connections are closed AND drain resolved, bounded by `shutdown_grace_ms`. Tests: client hangs up mid-call, stop() holds, result persisted before it returns, retry gets it; deadline case leaves the reservation (pending record) and stop() returns at the deadline. Shutdown settles or releases nothing itself.
10. done. New src/gateway/tools.js: fixed absolute candidates per platform, stat check (regular file, owner root, not group/world writable), fail closed with the path in the reason, child env `{LC_ALL:C, LANG:C}` with no PATH. sys.js (dscl, id, ps) and probes.js (lsof) use it; no other file imports child_process (tested). Confirmed on this macOS machine: id /usr/bin/id, ps /bin/ps (setuid, root, 755), dscl /usr/bin/dscl, lsof /usr/sbin/lsof. NOT confirmed (no Linux machine here): linux candidates id /usr/bin/id,/bin/id; ps /usr/bin/ps,/bin/ps; lsof /usr/bin/lsof,/usr/sbin/lsof,/bin/lsof. dscl has no Linux entry (fails closed, not used there). Only the final file is stat-checked; ancestor directories and symlinks along the path are not (a /bin -> /usr/bin symlink is followed). Doctor shows the refusal reason for the user lookup and check (f) when it is a tool refusal. No banned token added (no node:net etc.).
11. PARTIAL. Found and read (read-only): .agents/specs/failed/TASK_SPEC-gateway-m1a-fix-round-2-...-f262aa.md, "Review notes". It says "6 low" but its LOW line lists eight things, so the count is ambiguous. Fixed: (a) persist failure was silent: now logged ("request outcome could not be persisted ..."), plus start-line failure fails closed (test); (b) cleanupSync unlinked the socket without an inode check: now only the inode this process created (test); (c) discovery file mode and pid not verified: doctor now requires gateway.json not group/world writable and its pid equal to the answering gateway's (test). NOT fixed, left for Kevin: ancestor symlinks unchecked in doctor stats; doctor pings the hinted socket before the trust stat checks (no secrets sent); instance_id readable by the runner group (doctor needs it, by design); run-file re-parse O(n^2) with no size bound; `doctor --only` exits 0 on a passing partial run (PARTIAL is printed; docs step 5 says to rely on it and `agent run` rejects a partial, so left unchanged on purpose).
Also unfixed by design: check (f) behaviour unchanged.

### Deviations
- Items 5 and 6 share one commit (same files); items 1-4 one commit; the item-11 fixes one commit; plus a final docs note commit for items 8 and 9.
- Item 8 introduced a new persisted line type `request_start` in run files (additive; old files without it behave as before).

### Commands and counts
- `npm test`: Node 22.23.5 643 tests, 643 pass, 0 fail, 0 skipped; Node 24.22.3 643 tests, 643 pass, 0 fail, 0 skipped (baseline 624). Includes test/grant-adapter.test.js, unedited.
- `npm run check:self-model`: up to date after `npm run build` regenerated self-model.json (new module tools.js). `npm audit --omit=dev`: 0 vulnerabilities.
- Locked paths: `git diff --name-only origin/main...HEAD` touches only docs/gateway.md, self-model.json, src/gateway/*, test/gateway-*.test.js, LOG.md. No new dependency.

### Open questions for Kevin
- Should `doctor --only` on a passing partial exit non-zero? (left at 0; PARTIAL is printed.)
- Do you want the remaining item-11 lows (ancestor symlinks, ping-before-stat order, run-file size bound) in a later round?
- Linux tool paths in tools.js need confirming on the Linux VM (`ls -l` of id, ps, lsof there).

## 2026-11-24 (Gateway docs and doctor message corrections)
Branch task/gateway-docs-fixes, based on origin/main 69547a4 (PR #16). Baseline on origin/main before changes: `npm test` 623 tests, 623 pass, 0 fail on Node 22.23.5 and on Node 24.22.3 (after `npm ci --ignore-scripts` in the worktree).

### What was done per item
1. docs/gateway.md step 5: `export AGENT_HOME=<agent-home>` added before the doctor run, with the reason. Verified in code: `agentHome()` (src/gateway/config.js) returns `AGENT_HOME` when set and non-blank, else `~/.agent`; `runDoctor` defaults `home` to it and `probes.readConfig` calls `loadConfig(home)`, which marks `denied` only for EACCES/EPERM. So AGENT_HOME is the variable the runner-side doctor reads. No gap found there. The docs also state that a MISSING file fails (a) and skips (b), (c), (d), (f) (verified in doctor.js: only the `denied` branch takes the ping path).
2. Check (a), config.json MISSING (ENOENT, not denied): reason now reads "config.json is missing. If you are the runner, set AGENT_HOME to the gateway's AGENT_HOME. (cannot read ... (ENOENT))"; the `agent init` fix text is unchanged. Invalid/unparseable config keeps its old reason. New test in test/gateway-doctor.test.js covers missing (new wording, init fix kept) and denied (still passes via ping). This is the only behaviour change.
3. Install subsection added to Setup (root-owned /opt/agent-core, `sudo npm ci --omit=dev --ignore-scripts`, checkout + `rev-parse HEAD` to pin and record, CLI by full path, why).
4. Proof section: run doctor as the normal user, never sudo or as the gateway user; chmod 755 case expects six failures (a)-(f); chmod 666 fails (c) with "socket mode is 666, it must be 660".
5. Step 6b replaced with the replay procedure; commands copied verbatim from the spec (shell-level backslash-n kept as `\n` inside the node strings); marked as not run on a real VM.

### Verified in the code vs copied from the spec unverified
Verified: agentHome() and the config probe behaviour (item 1); the missing-versus-denied branch in doctor.js (item 2); wording tested. Copied unverified: the item 5 commands and their expected outcomes; the six-failure expectation and the "socket mode is 666" text (not re-derived from the code or run); the install steps (not run; no sudo was used here); the claim that socket_dir 0750 prevents a normal user binding there.

### Gaps / deviations
- No agentHome() gap: AGENT_HOME is what the doctor reads.
- Existing docs tell macOS users to run `sudo agent doctor --only f`, which conflicts with "never under sudo". Restrictive choice: kept that existing line (removing it would lose the only macOS (f) route) and named it, plus step 7's deliberate gateway-user run, as the explicit exceptions in the "never sudo" sentence. Not verified on macOS.
- Existing Setup/proof lines still say `agent` rather than the full path; the install subsection says `agent` there means `node /opt/agent-core/bin/agent`. Further rewriting was left to round 3.
- README.md does not quote the proof commands; not changed. self-model.json not changed (see below).

### Commands run and counts
- Baseline (origin/main): Node 22.23.5 and Node 24.22.3, 623 tests, 623 pass, 0 fail.
- After changes: Node 22.23.5 `npm test` 624 tests, 624 pass, 0 fail; Node 24.22.3 624 tests, 624 pass, 0 fail (one new test).
- `npm run check:self-model`: up to date (no regeneration needed). `npm audit --omit=dev`: 0 vulnerabilities.
- `git diff --name-only origin/main...HEAD` (before this LOG commit): docs/gateway.md, src/gateway/doctor.js, test/gateway-doctor.test.js. No locked path.
- Setup note: `npm ci --ignore-scripts` was run in the worktree to get node_modules.

## 2026-11-24 (Gateway M1a fix round 2)
Branch `task/gateway-m1a-fixes-2`, based on origin/main c23f7ed (PR #15). Works only in `src/gateway/`, `bin/agent` (unchanged), `docs/gateway.md`, README.md, `test/gateway-*.test.js`, LOG.md and `self-model.json`.

### What was done, per item
1. Doctor trust anchor. Doctor never takes identity from the environment: `AGENT_GATEWAY_SOCKET` is a location hint only. The gateway now writes `<socket_dir>/gateway.json` (0640, gateway uid, runner group; `src/gateway/discovery.js`, atomic write) holding socket path, a random `instance_id` per start, gateway uid and gid, pid; `ping` returns the same `instance_id`. When config.json is unreadable, doctor needs `--gateway-user <name>` (without it, check a fails with that instruction, b/c/d/f are skipped, and the socket is never contacted), resolves it to a uid (`resolveUser`: /etc/passwd, then `id -u`), and verifies: socket_dir, socket and gateway.json owned by that uid; socket_dir not writable by the doctor identity (a real create attempt); gateway.json names that uid and the hinted socket path; ping `instance_id` equals gateway.json's; the gateway's described uid and socket path match; doctor is not root or the gateway user. Any mismatch fails b, c, d and f with the reason named (and e follows). A readable-config run still behaves as before and prints a NOTE that it proves nothing about the runner boundary. `docs/gateway.md` says a doctor run by a compromised runner proves nothing and that the proof is the human running `--gateway-user`.
2. Graceful shutdown. `server.js` keeps its own connection set; no `closeAllConnections`. `stop()`: stop accepting, destroy idle connections at once, let in-flight requests finish up to `shutdown_grace_ms` (config, default 10000, 0 to 600000; injectable `shutdownGraceMs`), then destroy the rest. `stop({ force: true })` (second signal) destroys at once. `agent gateway` handles SIGTERM, SIGINT and SIGHUP (first graceful, second forced) and an `exit` hook calling `cleanupSync()`. Pid file, socket and discovery file are removed on every path that can run code. Shutdown never settles or releases: a cut-off call keeps its reservation.
3. Bounds. Request-id records are one global LRU (`request_cache_max`, default 1024, 1 to 1,000,000); only settled and persisted entries are evictable, in-flight ones never. Each finished call is persisted in the run file (fingerprint, outcome, redacted result or error) BEFORE the entry counts as settled; a memory miss falls back to `runs.findRequest`, so eviction cannot cause a second reservation or settlement (tests prove it for success and for failure). `request_read_timeout_ms` (default 10000, 1 to 3,600,000, injectable `readTimeoutMs`) runs from the first byte of a request line to its newline, never while a request is being served, separate from the idle timeout. `agent doctor --only` prints `PARTIAL: N of M checks run` (never "all checks passed"), exits non-zero unless all selected pass; `agent run` refuses a partial or failing doctor.

### Interface gaps in locked code
None hit. The structural test `test/grant-adapter.test.js` passed on the first run with no change to any file for it (discovery.js has no banned token; `node:net` only in server.js and client.js; no `fetchFn` added anywhere). No locked path touched.

### Added dependencies
None.

### Deviations from the spec and judgement calls
- Persisting the call result in the run file (needed so a retry after eviction "returns the persisted result") means model reply text is now stored in the run's `request` line (run files are 0600, gateway user only, and redacted). Previously only ids and costs were stored. Request messages are still never stored. Restrictive fallback: a persisted ok record without a result answers `request_result_unavailable` rather than calling the provider.
- Persisted records without a fingerprint (written by round 1) are treated as a `request_id_conflict`, not replayed.
- If persisting a record fails, that entry stays pinned in memory (never evicted); with a permanently failing disk the cache can exceed its cap. The in-memory result still dedupes.
- `gateway_gid` in gateway.json is the gateway process's own gid; the file's group is the runner group.
- `request_cache_max` is global across runs (not per run); closing a run drops its entries.
- Trust checks run only when config.json is unreadable. If it is readable `--gateway-user` is ignored (the run proves nothing anyway and says so).
- `dscl` was replaced by `id -u` for user lookup because an existing test forbids the host path text `/Users/` in `src/gateway`.
- A restarted gateway does not reopen runs (round 1 behaviour), so after a real restart a retry gets `run_not_open`; "no double reserve" after restart is shown by reading the ledger from a fresh store, and the same-process retry test.
- Commits: the per-issue split is by file group, not hunk; server.js, cli.js and api.js carry changes for more than one item.

### What the tests cannot prove
- The real OS boundary: real owners, groups, modes, a real second user, real impostor sockets owned by another uid. Doctor trust is tested with faked `stat`, `resolveUser`, `readDiscovery` and `tryCreate`; `resolveUser` itself and the real discovery file ownership (chown to another uid needs root) are not exercised against another user.
- A real SIGTERM/SIGINT to a real `agent gateway` process: the signal handling is tested with a fake process object and the server `stop()` is tested directly.
- Shutdown with a call held by a real provider over a slow network, kill -9 and power loss (stale files are replaced on next start by round 1 logic, untested here for the discovery file).
- Memory growth under a persistently failing disk (see deviations).

### Commands run and counts
- Baseline on origin/main c23f7ed before changes: `npm test` Node 22.23.5: 587 tests, 587 pass, 0 fail. Node 24.22.3: 587 tests, 587 pass, 0 fail.
- After the changes: `npm test` Node 22.23.5: 623 tests, 623 pass, 0 fail. Node 24.22.3: 623 tests, 623 pass, 0 fail (includes the structural test). `npm run check:self-model`: up to date. `npm audit --omit=dev`: 0 vulnerabilities. `builder:smoke` not run; no real key, no live network, no TCP listener.

## 2026-11-24 (Gateway M1a fix round)
### What was done
Branch task/gateway-m1a-fixes off origin/main 8a47113 (merge of PR 13). One commit per issue. Only `src/gateway/`, `docs/gateway.md`, README.md, new/changed `test/gateway-*.test.js`, self-model.json and this file changed.
1. Idle timeout and double-pay. The idle timer runs only when no request is in flight (timer disabled while serving, re-armed after the response). The provider call has its own `provider_timeout_ms` (120000), the connection `idle_timeout_ms` (30000); both are config keys and injectable. `modelCall` requires `request_id`; the gateway keeps `request_id -> { params fingerprint, outcome }` per run: a repeat (in flight or settled) gets the recorded outcome and never reserves or settles again, a repeat with different parameters is `request_id_conflict`. The call runs to completion and settles even if the client is gone. `endRun` during an in-flight call is `busy`. New `ping` method. `fetchFn` renamed `transport` in api/cli and `send` in proxy (the structural test greps for the old name).
2. Kernel-enforced access. New config keys `socket_dir` (absolute, outside AGENT_HOME), `runner_group` (name or gid), limits; `allowed_peer_uids` optional; `config_version` still 1; unknown keys refused; all state paths must be inside AGENT_HOME. New `src/gateway/layout.js` (pure checks, creates socket_dir 750 only if missing) and `sys.js` (group lookup, process info). The server verifies AGENT_HOME 700, config.json not group/other writable, socket_dir 750 group runner_group, running uid = gateway_uid BEFORE listening (and `startGateway` checks before creating anything under AGENT_HOME), sets the socket to 660 group runner_group after listening and re-verifies it. No probe configured: serves (kernel permissions), says so in `ping.access` and `agent status`. Probe configured: still enforced, unknown/throwing/unlisted refused.
3. Doctor makes real checks, each with a one-line reason and an exact fix: (a) config + owners/modes, (b) real `ping` through client.js (refused/silent/malformed fails), (c) socket owner/group/mode, (d) boundary probes as the invoking identity (read credentials, list ledger, read config.json, create in AGENT_HOME and socket_dir; all must be denied; fails as the gateway uid or root), (e) peer-uid probe exercised via `peerDecision` if the gateway reports one, otherwise "kernel permissions only" and passes only if a-d passed, (f) pid taken from the answering gateway (ping) and cross-checked against the pid file, verified alive, command line `agent gateway`, uid; listeners from /proc (fds, or all listeners owned by the gateway uid when the fds are not readable) or lsof, else fail, (g), (h) as before. `agent doctor --only a,b` for diagnostics; `agent run` still runs the full doctor.
4. Hardening. Provider body read as a stream and cancelled at `max_response_bytes` (default 8 MiB; declared content-length checked first); oversize request line closes the connection; pipelined requests while one is in flight get `busy`; `max_connections`; pid file removed on SIGTERM/SIGINT and on stop, a pid file naming a live gateway refuses startup, a stale one is replaced.
5. Docs: group-permission boundary, Linux and macOS setup commands (for Kevin, not run), by-hand proof in order, what doctor can and cannot prove.

### Interface gaps in locked code
1. EXPECTED FAILURE, locked test `test/grant-adapter.test.js` "structural: only callModel reaches the endpoint, only dispatchTool touches the worktree, and both demand a meter" exempts only `src/builder-adapter.js`. It fails with "gateway/client.js must not reach the network" (and would for server.js). It fails only because of `node:net` in `src/gateway/server.js` and `client.js` (proxy.js uses the injected `send`, whose default is `globalThis.fetch`, and carries no flagged token). No other file under `src/` carries a flagged token (checked by grep and by the new test in `gateway-no-hardcoded-paths.test.js`). Not edited; tokens not disguised. It clears once Kevin adds his exemption for exactly those three paths.
2. Platform gap, not locked code: Node has no peer-credential (SO_PEERCRED) reader. The peer-uid allowlist is no longer the boundary (spec decision); a probe stays an optional hook and no real probe exists.
3. The locked run-journal schema still cannot hold run records; unchanged from the first round (gateway-owned JSONL lines, now also `request` lines).
No other interface gap hit.

### Added dependencies
None.

### Deviations from the spec / decisions where it was open
- Doctor as the runner cannot read `config.json` (that is the point of 0700). So when `config.json` is denied, doctor takes the layout from the running gateway's `ping` (`layout`: paths, gateway uid, runner group/gid) and needs the socket path in `AGENT_GATEWAY_SOCKET`. Check (a) then says the config could not be read here and that the gateway validated it. The gateway-reported home must equal doctor's `AGENT_HOME`. This is trust in the gateway for the config contents only; owners, modes and the boundary probes are still checked by doctor itself.
- Doctor (a): a denied stat of `AGENT_HOME` (parent not traversable) is accepted, because (d) then proves the denial; the startup check of the gateway itself verifies the exact mode.
- Doctor (f) pid comes from `ping`, not the pid file (the runner cannot read it); both are compared when both are available. On Linux without access to the gateway's fds it falls back to every TCP listener owned by the gateway uid (stricter). On macOS lsof cannot see another user's process, so it fails closed with the remediation `sudo agent doctor --only f`.
- Doctor (d) also fails when run as root (root ignores permissions), in addition to the gateway uid case in the spec.
- Doctor (e) when the gateway reports a peer probe and doctor has none to exercise: fails (restrictive).
- `socket_path` kept as an optional config key (must be directly inside `socket_dir`; default `gateway.sock`); `agent init` does not create `socket_dir` (outside AGENT_HOME; the gateway creates it at startup or Kevin does by hand).
- Idempotency outcome is final per `request_id` including errors: a retry after an error needs a new `request_id`. Requests that fail validation before the reservation are not recorded.
- Provider responses over the cap are settled at worst case (treated like a network error), not released.
- Limit config keys are bounded (for example `max_connections` 1 to 256).
- `agent status` now uses `ping` instead of a bare connect.

### What the tests cannot prove
- The real OS boundary: a different gateway user, real ownership under another uid, real group membership of the runner, root-owned directories. Tests run as one user: layouts use that user's own uid and gid, other owners and modes are checked with a fake stat, and the real boundary probes are exercised against files and directories with modes 000/555 owned by the test user. Kevin's by-hand proof (docs/gateway.md) is NOT verified by me.
- The macOS group and user commands, and that `/var/run/agent-gateway` survives or is recreated across reboots.
- Doctor (f) against another user's process on a real host (the lsof and /proc fallbacks for a foreign process are not exercised); the real own-process /proc or lsof path is tested.
- Real provider behaviour (mock servers and fake streams only; no real call, no real key; the key in tests is the existing fake).
- Behaviour under load beyond the connection cap test, and cross-process ledger lock contention beyond the existing ledger tests.
- Timing tests use short injected timeouts (80 to 500 ms) and real sleeps; they can in principle be flaky on a very slow host.

### Commands run and results (with counts)
- Baseline origin/main 8a47113 `npm test`: 535 tests, 534 pass, 1 fail, 0 skipped on Node 22.23.5 and on Node 24.22.3; the one failure is "structural: only callModel reaches the endpoint, only dispatchTool touches the worktree, and both demand a meter" (test/grant-adapter.test.js, gap 1).
- Final `npm test`: Node 22.23.5: 587 tests, 586 pass, 1 fail, 0 skipped. Node 24.22.3: 587 tests, 586 pass, 1 fail, 0 skipped. The one failure is the same locked structural test in both; nothing else fails.
- `npm run build` (36 modules, 6 contracts, 6 ADRs) then `npm run check:self-model`: up to date. `npm audit --omit=dev`: 0 vulnerabilities.
- `git diff --name-only origin/main...HEAD` touches no locked path.

## 2026-11-24 (Gateway M1a)
### What was done
Branch task/gateway-m1a off origin/main 7b53dda. DESIGN_M1.md is NOT available anywhere; the task spec was the only reference. New: `src/gateway/` (config, init, store, credentials, prices, runs, proxy, api, server, client, doctor, probes, cli), `bin/agent`, `docs/gateway.md`, 7 new test files, `bin` entry in package.json, README section, self-model.json regenerated.

### Interface gaps in locked code
1. **BLOCKER, locked test fails: `test/grant-adapter.test.js` "structural: only callModel reaches the endpoint..."** (locked). It greps EVERY file under `src/` for `fetch(`, `fetchFn`, `node:net`, `node:http(s)`, `WebSocket` and fails if any file other than `src/builder-adapter.js` has them. The gateway necessarily uses a Unix-socket module (`src/gateway/server.js`, `client.js`) and an HTTP client call for the provider proxy (`src/gateway/proxy.js`). I did NOT edit the test and did NOT disguise the tokens to slip past it (that would defeat what the test guards). Result: 1 failing test, 534 of 535 pass. Options for Kevin: (a) edit that locked test by hand to exempt `src/gateway/`, (b) move the gateway outside `src/` (the test then stays meaningful for the builder; the self-model would stop indexing it and `src/gateway/` in the spec/locking steps would change).
2. Run journal schema (`schemas/v1/run-journal-entry.schema.json`, `unevaluatedProperties:false`, three kinds) cannot hold start/end/duration/model/provider/outcome/`capability_added`. Run records are gateway-owned JSONL lines (`runs/<run>.jsonl`); ordinary journal entries are validated against the unchanged schema and stored in the same file. Journal API itself (`src/journal.js`) is in-memory only, so it is not used.
3. `config/prices.json` format and `src/grant/prices.js`: keyed by model id only. The gateway keys by provider AND model by giving the meter the composite id `provider|model` (a `:free` suffix keeps the free rule). A bare-model key in the file never matches and doctor check (g) reports it. File untouched and empty.
4. The meter accepts a usage object from whoever calls `settle`; the gateway therefore never forwards runner-supplied usage (paid reservation settles at worst case, free at 0). Only `modelCall` supplies measured usage.
5. Ledger `openRun` is the only registration call and `remaining(grant)` is the read; the store interface maps `append`->`openRun`, `read`->`remaining`, `lock`->`acquireLock`, `report`->`buildReport`. A crashed gateway leaves in-memory meters lost; the ledger keeps open reservations counted (conservative), and those runs cannot be resumed (`run_not_open`).
6. Platform gap (not locked code): Node exposes no SO_PEERCRED. The default peer-uid probe returns unknown and the server refuses every connection; a real probe must be injected before the gateway can serve a runner. Doctor (b) only proves a connection can be opened.

### Added dependencies
None.

### Deviations from the spec
- Added `agent gateway` (starts the gateway); the spec lists no way to start it and the by-hand proof needs one.
- `bin` entry added to package.json (not a locked path).
- `settle` ignores caller usage (see gap 4); spec item 5 says cost is measured by the gateway.
- Doctor (e) is a pure simulation (the same exact-uid decision function the server uses, applied to the allowlist minus the runner), per the spec's "simulated".
- Doctor (d) treats any group/other read bit as readable (runner group membership is unknown) and a missing file as a failure.
- Doctor (h) checksum is sha256 over the file names and bytes of every path in `.github/locked-paths.txt`.
- `test/grant-adapter.test.js` failing (gap 1): the spec's "all existing tests still green" is NOT met.

### What the tests cannot prove
- The real OS boundary: different uid, real file ownership/modes under another user, that the runner cannot read credential and ledger files, real SO_PEERCRED peer checks, real TCP listener detection (fakes in tests; `lsof` or `/proc` used for real). Kevin's by-hand proof (docs/gateway.md) is NOT verified by me.
- Real provider behaviour (mock server only; no real call, no real key). Mock key is the existing FAKE_KEY.
- Gateway restart semantics under load, concurrent connections, and ledger lock contention across processes beyond the existing ledger tests.

### Commands run and results (with counts)
- Baseline origin/main 7b53dda `npm test`: 470 tests, 470 pass, 0 fail, 0 skipped on Node 22.23.5 and on Node 24.22.3.
- Final `npm test`: 535 tests, 534 pass, 1 fail (the locked structural test above), 0 skipped on Node 22.23.5 and on Node 24.22.3 (+65 new tests, all passing).
- `npm run build` (34 modules, 6 contracts, 6 ADRs) then `npm run check:self-model`: up to date. `npm audit --omit=dev`: 0 vulnerabilities.
- The by-hand boundary proof is NOT verified by me.

## 2026-11-23 (Contract gap follow-ups)
### What was done
Branch task/contract-gap-followups off origin/main 6f6837c (merge of task/contract-gaps; task-spec schema and `issue_kind` confirmed present). One commit per issue.
1. Repo pattern (649ec9a): `task-spec` `repo` is strict `host/owner/name`: DNS-style host, owner and name 1 to 100 of `[A-Za-z0-9_.-]`, segment `.`/`..` rejected, name ending `.git` (any case) rejected, no empty segments, whitespace (incl. trailing newline), backslash, percent, control chars, non-ASCII. 25 new invalid fixtures (one per rule, several variants) and `test/task-spec-repo.test.js`: each `repo-*` invalid fixture must fail ONLY with a `/repo must match pattern` error and pass once `repo` is replaced by a good value; accepted shapes listed too. ADR-0006 addendum.
2. grant_ref cross-check (new `src/task-spec.js`, `validateTaskSpec`, `checkGrantRef`): schema first, then `grant_ref` must equal `grant.task_id` when both exist. `test/task-spec-grant-ref.test.js`: match, mismatch, one-only, schema-failure-first. `self-model.json` regenerated (new module). ADR-0006 addendum.
3. scope.paths: ADR-0004 addendum (literal prefixes, no globs, `src/**` matches nothing, schema does not reject glob chars); new valid fixture `fixtures/grant/valid/prefix-paths.json` (`src/`, `docs/`); `test/grant-prefix-paths.test.js` via the public `confine` API (prefix allows a write, `src/**` allows none, schema accepts glob chars). No behaviour change.
4. Self-model manifests: `loadCapabilities(root)` in `src/self-model.js` collects errors (import failure, no `*_CAPABILITIES` export, invalid manifest via `validateManifest`); `scripts/build-self-model.js` prints `<file>: <error>` and exits 1 for build and `--check`; missing manifest stays optional. New `--root <dir>` option so tests use a temp tree. `test/self-model-broken-manifest.test.js` (temp dirs only). ADR-0005 addendum.
README.md updated.

### Commands run and results (with counts)
- Baseline origin/main 6f6837c `npm test`: 400 tests, 400 pass, 0 fail, 0 skipped on Node 22.23.5 and on Node 24.22.3.
- Final `npm test`: 470 tests, 470 pass, 0 fail, 0 skipped on Node 22.23.5 and on Node 24.22.3 (+70 new, no skips added).
- `npm run build` (21 modules, 6 contracts, 6 ADRs) leaves tracked files unchanged apart from the intended self-model.json; `npm run check:self-model` up to date; `npm audit --omit=dev`: 0 vulnerabilities.
- Backward compatibility: all baseline tests pass unedited, including every pre-existing fixture across all contracts (task-spec valid/embedded-grant and grant-ref-with-branch still validate; the 9 older invalid task-spec fixtures still rejected); acceptance suite untouched and green.

### Decisions and why
- Mismatch check lives in `checkGrantRef`, and `validateTaskSpec` takes an optional schema step: the v1 schema (oneOf) already refuses a spec with both `grant` and `grant_ref`, so the mismatch branch is unreachable through the real schema; tests exercise it directly and show the real schema refuses first. Schema not loosened (more restrictive).
- A capability file with no `*_CAPABILITIES` export, or an invalid manifest, is now an error too (previously silently omitted); an empty exported array is still fine.
- `src/**` fixture: `fixtures/grant/valid/basic.json` and `fixtures/task-spec/valid/embedded-grant.json` left UNCHANGED. `acceptance/contracts.test.js` (locked) iterates every grant fixture and `test/task-spec.test.js` loads the grant fixture, so the restrictive choice was to add a new fixture, not edit.
- Adding a valid grant fixture changes nothing for locked tests (they only require valid ones validate).

### Fixtures touched (and why)
- Added: `fixtures/grant/valid/prefix-paths.json`; 25 files `fixtures/task-spec/invalid/repo-*.json` (backslash, control-char, empty-host/name/owner, host-empty-label/leading-hyphen/trailing-hyphen-label/underscore, leading/trailing-space, trailing-newline, tab, name-dot, name-dotdot, name-dot-git, name-dot-git-upper, name-only-dot-git, name-too-long, owner-dot, owner-dotdot, owner-too-long, non-ascii, non-ascii-host, percent).
- Modified or deleted: none. No previously valid fixture became invalid.

### CHANGED LOCKED PATHS (expected: none)
None. `git diff --name-only origin/main...HEAD` touches no file under src/grant/, src/ledger/, config/, acceptance/, .github/, CODEOWNERS, src/builder-adapter.js, src/builder-confine.js, src/validators.js, test/builder-mock.js, or any locked test.

### Not verified
- The guard on a real PR (not runnable here).
- `npm test` on Node 22 prints TAP, not the summary format Node 24 uses; counts were read from its TAP totals.

### Open questions for Kevin
- Adopting `validateTaskSpec` in the builder adapter needs a locked-code edit (src/builder-adapter.js); not done.
- Should the schema ever allow `grant_ref` alongside an embedded `grant` (so the cross-check becomes live)? Left refused.
- Glob support stays rejected per decision; fixtures with `src/**` still allow no writes.

## 2026-11-23 (Additive contract gap cleanup)
### What was done
Branch task/contract-gaps off origin/main a797766 (`.github/locked-paths.txt` there lists `src/ledger/`; checked). One commit per issue. Only schemas/, docs/adr/, fixtures/, src/self-model.js, self-model.json, new tests, README.md and LOG.md changed.
1. Issue kind (889fb85): optional `issue_kind` on issue entries, pattern `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, max 64 chars, not an enum. NOT named `kind`: `kind` is already the entry discriminator (`reservation`/`attempt`/`issue`), so a second `kind` is impossible. Valid and invalid fixtures; new `test/contract-gaps-journal.test.js`. Note: this commit's schema diff also already contains the item 2 enum change (my commit split slipped); the item 2 commit carries its fixtures and test.
2. Attempt outcomes (ad8768b): `outcome` enum is now ok, failed, blocked, refused, truncated. Fixtures for both plus a wrong-case invalid one; new `test/contract-gaps-outcomes.test.js`.
3. Task spec (5ce2ea8): new `schemas/v1/task-spec.schema.json` (goal, repo `host/owner/name`, optional branch, exactly one of embedded `grant` (refs the grant schema) or `grant_ref`), ADR-0006, 2 valid and 9 invalid fixtures, `test/task-spec.test.js`. Acceptance test untouched and still passes (its contract list is hardcoded and does not include task-spec; the one-ADR-per-contract check lives in unlocked `test/self-model.test.js`, 6 contracts and 6 ADRs).
4. max_usd decimal string: NOT DONE, reverted before any commit (see Decisions). No schema change.
5. Semantics doc (b8bbf5a): addendum to `docs/adr/0004-grant.md` documenting what the adapter and meter do today for `scope.repos`, `scope.paths`, `allowed_risk_tiers`, scope vocabulary and `budget`; `test/grant-semantics-doc.test.js` pins the path rules (characterization only). Finding stated as fact: entries like `src/**` (used in the valid grant fixture) are literal prefixes and allow no writes today.
6. Self-model (9f2eda8): generator now indexes `.js` files under `src/` at any depth (name `grant/meter`, path `src/grant/meter.js`; 8 modules became 20), sorted by path. Optional per-module `capabilities` (name, version, risk_tier, sorted scopes) filled from the `*_CAPABILITIES` export of `src/*-capabilities.js` (only `builder-capabilities` today), otherwise omitted. Schema additive. ADR-0005 addendum. `self-model.json` regenerated. New `test/self-model-nested.test.js`, new valid and invalid self-model fixtures.
7. Gap table below.
README.md updated (task-spec, self-model line).

### Commands run and results (with counts)
- Baseline origin/main a797766 `npm test`: 362 tests, 362 pass, 0 fail, 0 skipped on Node 24.22.3 and on Node 22.23.5.
- Final `npm test`: 400 tests, 400 pass, 0 fail, 0 skipped on Node 22.23.5 and 400/400/0/0 on Node 24.22.3 (+38 new; no skips added).
- `npm run build`: wrote self-model.json (20 modules, 6 contracts, 6 ADRs). `npm run check:self-model`: up to date. Generator run twice, outputs byte-identical (cmp). `npm audit --omit=dev`: 0 vulnerabilities.
- Backward compatibility: all 362 baseline tests (which validate every pre-existing fixture across all 5 contracts) still pass unedited except the one listing below; `test/contract-gaps-journal.test.js` names the 4 old valid and 6 old invalid journal fixtures explicitly; `test/self-model-nested.test.js` checks the old self-model shape still validates. Grant schema unchanged.
- Item 4 probe: `createMeter` with `max_usd: 0.05` accepts (budget_micro 50000); with `'0.05'` refuses `grant budget.max_usd is missing or invalid`.

### Decisions and why
- `issue_kind` instead of `kind` (name collision, see item 1). Restrictive and non-breaking.
- Item 4 reverted: `src/grant/money.js` `usdToMicro` does parse decimal strings exactly (existing test), but `src/grant/meter.js` line 66 requires `typeof max_usd === 'number'`, so the meter refuses the string form. Accepting it needs a locked-code edit. Allowing the string in the schema alone would pass validation and then fail at the meter, so the schema was left as is.
- `repo` in task-spec requires a host with a dot (`github.com/owner/name`); stricter than the adapter, which accepts a bare name or path. `workdir` left out (local path, not a task property).
- Self-model capabilities come from loading `src/builder-capabilities.js` (top-level await in the generator); a failure to load omits the field instead of failing the build. Chosen over inventing a manifest directory convention.
- No change to the adapter's runtime `CONTRACT_GAPS` list (locked); it still reports gaps now closed in the contract.

### Gap table (CLOSED / NEEDS LOCKED CODE / NEEDS VERSIONED SCHEMA CHANGE / DECISION FOR KEVIN)
Runtime list is the 15 in `src/builder-adapter.js` `CONTRACT_GAPS` (in order), then the extra gaps named in the "Grant metering and expiry" and "Per grant spend ledger" sections.
| # | Gap | Status |
|---|-----|--------|
| 1 | Issue entries have no `kind` | CLOSED here (889fb85, field `issue_kind`). Adapter still writes the `[kind: x]` prefix: adopting the field NEEDS LOCKED CODE (src/builder-adapter.js). |
| 2 | No failure entry kind (attempt failed/blocked) | DECISION FOR KEVIN: `attempt` failed/blocked/refused/truncated now covers it; a separate failure entry kind would be a new kind every reader must handle. |
| 3 | No task-spec schema | CLOSED here (5ce2ea8, ADR-0006). Adapter adoption NEEDS LOCKED CODE (src/builder-adapter.js). |
| 4 | `scope.paths` semantics unspecified | Documented (b8bbf5a), not closed. DECISION FOR KEVIN: define globs or keep prefixes; any change NEEDS LOCKED CODE (src/builder-confine.js). |
| 5 | Journal guarantee in-process only; adapter mirror unprotected | DECISION FOR KEVIN (durable append-only journal storage; NEEDS LOCKED CODE in the adapter). |
| 6 | Self-model indexes only top-level `src/*.js` | CLOSED here (9f2eda8). |
| 7 | No registry for capability manifests | DECISION FOR KEVIN. Partial: the self-model now lists the builder manifests, but there is still no registry or publish path. |
| 8 | No role concept (builder vs overseer) | DECISION FOR KEVIN (out of scope; a field only helps if locked meter/adapter read it). |
| 9 | `max_usd` has no metering or price source in the contract | DECISION FOR KEVIN (metering lives in locked src/grant/; budget semantics documented in the ADR-0004 addendum). |
| 10 | `expires_at` checked at start, no mid-run or wall-clock semantics in the contract | DECISION FOR KEVIN (the adapter and meter already check before every call; the contract still says nothing). |
| 11 | `allowed_risk_tiers` has no defined meaning | Documented today's behaviour (only `low` is checked; `payments` exists in the enum). DECISION FOR KEVIN on real semantics; enforcement NEEDS LOCKED CODE. |
| 12 | Capability `scopes` free-form, no vocabulary | Documented. DECISION FOR KEVIN (a vocabulary is a versioned change if it becomes an enum or pattern). |
| 13 | Refusal and truncation unrepresented | CLOSED here (ad8768b outcomes `refused`/`truncated`, plus 889fb85 `issue_kind`). Adapter adoption NEEDS LOCKED CODE. |
| 14 | Self-model has no field for adapter capabilities | CLOSED here (9f2eda8). |
| 15 | No journal entry kind for structured spend | NEEDS VERSIONED SCHEMA CHANGE: a structured spend entry is a new entry kind with money and token fields; the spend sidecar is in locked code. |
| 16 | `task_id` not documented as the unique grant key (ledger relies on it) | DECISION FOR KEVIN (uniqueness cannot be enforced by a schema; ledger refuses a mutated grant already). |
| 17 | Contract has no notion of a grant spanning runs, a run id or a spend ledger | NEEDS VERSIONED SCHEMA CHANGE (new run and ledger concepts) and is adapter-local today. |
| 18 | `max_usd` is a float number; decimal string would be safer | NEEDS LOCKED CODE (src/grant/meter.js line 66 rejects non-numbers). Schema alternative deliberately not added. |
| 19 | Self-model generator ignores subdirectories of `src/` | CLOSED here (9f2eda8). |
| 20 | Spec C fix-round list (role, risk tiers, scope vocabulary, refusal/truncation, self-model capabilities) | Same as 8, 11, 12, 13, 14. |

### Existing tests edited (and why)
- `test/self-model.test.js`: the expected contract-name list gained `'task-spec'` (item 3, count/listing change). No other existing test file edited. `self-model.json` and `README.md` changed as generated or doc files.

### CHANGED LOCKED PATHS (expected: none)
None. `git diff --name-only origin/main...HEAD` lists nothing under src/grant/, src/ledger/, src/builder-adapter.js, src/builder-confine.js, src/validators.js, config/, acceptance/, .github/, CODEOWNERS or test/builder-mock.js.

### Not verified
- The locked-path guard on a real PR (not runnable here).
- `builder:smoke`, live endpoints and real keys: not run by design.
- Self-model generation on a case-sensitive or Windows filesystem was not run.

### Open questions for Kevin
- Rename wanted? The spec asked for `kind` on issue entries; shipped as `issue_kind` because `kind` is the entry discriminator.
- Item 4: allow `max_usd` as a decimal string only together with a meter edit (src/grant/meter.js, locked)? Until then the schema stays number-only.
- The valid grant fixture uses `src/**` and `docs/**`, which allow no writes under today's prefix semantics. Define glob support (locked src/builder-confine.js) or change what the fixtures and docs say?
- Should the adapter be updated (locked) to use `issue_kind`, the new outcomes and the task-spec shape, and drop the matching runtime gap entries?
- `task-spec.repo` requires `host/owner/name`; the adapter accepts bare names. Keep the stricter form?

## 2026-11-23 (Ledger fix round)
### What was done
One commit per issue, only `src/ledger/`, ledger tests under `test/`, and this file changed.
1. Report CLI entry (`src/ledger/report.js`): the entry check compared `import.meta.url` to `file://${resolve(argv[1])}` as strings, so a repo path with a space (URL-encoded `%20`) or a symlinked `argv[1]` made `npm run ledger:report` print nothing and exit 0, even on a corrupt ledger. Now `isCliEntry()` compares `realpathSync(resolve(argv[1]))` with `realpathSync(fileURLToPath(import.meta.url))`; if the comparison itself throws it answers "yes, I am the entry" (fail closed, the CLI runs); no `argv[1]` means imported. Any error in the CLI body prints `ledger:report: ERROR ...` and exits 1.
2. Lock takeover (`src/ledger/lock.js`): the stale-lock logic is gone. An existing lock is never broken by code. A lock whose owner pid is dead refuses at once with the lock path and the exact command (`rm -r '<lock path>'`) to clear it by hand.
3. Durability (`src/ledger/durable.js`, `ledger.js`, `lock.js`): every append checks the byte count (a short write is retried for the remainder; three zero-progress writes, a negative or too-large return, or a throw refuses); the file is fsynced after each append; the directory is fsynced when the append created the ledger file; for a lock, the owner file is fsynced, the temp dir is fsynced before the rename, and the parent directory after it. A failed fsync after the rename releases the lock and refuses. File operations are injectable through `openLedger(dir, { io: { writeSync, fsyncSync } })`.
4. Operator errors (`lock.js`): a lock with a missing, unreadable, corrupt or malformed `owner.json`, and a live pid holding the lock longer than `lockMaxAgeMs` (default 300000 ms), refuse at once, naming the lock path, the pid and age where known, "NOT broken automatically", and the clearing command. A lock that merely looks ownerless because it is being released and re-taken is not misreported (see decisions).
5. Event loop (`lock.js`): the wait was already `Atomics.wait` on a shared buffer, not a busy loop, so there was nothing to swap for async (and async would change the meter's calls, which are out of scope). Changed: one shared wait cell, and the sleep is capped at the remaining deadline, so a long `pollMs` can no longer overshoot `timeoutMs`. The thread still blocks during the wait (inherent to a synchronous API); the wait is bounded. Test: a 120 ms timeout with a 5000 ms poll refuses in well under 1.5 s without burning CPU.
6. Cleanup: the release comment now states what is and is not protected; release verifies an owner token before renaming, so a lock cleared by hand and re-taken by another run is left alone; the stray `GENESIS` re-export (`index.js`, `ledger.js`) is removed (`format.js` still exports it for its own use); the `testHooks.betweenCheckAndAppend` hook is removed from production code, and `test/ledger-worker.js` now widens the race window through the injected `io.writeSync` instead.

### Commands run and results (with counts)
- Baseline, origin/main 74ca6d5, `npm test`: Node 22.23.5 340 tests, 340 pass, 0 fail, 0 skipped; Node 24.22.3 340 tests, 340 pass, 0 fail, 0 skipped.
- Final: Node 22.23.5 362 tests, 362 pass, 0 fail, 0 skipped; Node 24.22.3 362 tests, 362 pass, 0 fail, 0 skipped (340 + 22 new, no test skipped or removed; one old test, "a stale lock from a dead pid is recovered", was replaced by "a dead-pid lock is never broken", because the behaviour it asserted is deliberately gone).
- `npm run build` clean (self-model.json unchanged), `npm run check:self-model` passes, `npm audit --omit=dev` 0 vulnerabilities. No new dependencies.
- Fail-before, in a scratch copy of origin/main under /private/tmp/ledger-fb (new tests copied onto the old `src/ledger`; the worktree was never broken):
  - Report CLI: 5 of the 8 report tests fail on the old code (space path, symlink, space+symlink, unexpected error exit, `isCliEntry`); the 3 old report tests pass. All 8 pass now.
  - Lock: against the old `lock.js`, the 3 dead-pid tests fail: the seeded dead-pid lock was taken over in 39 of 39 rounds (6 processes), 195 appends went through a dead-pid lock, and the real-ledger chain verified as forked in 3 of 3 runs. The 3 control/detector tests pass on both old and new code (they show the harness itself is sound). All 6 pass now.
  - Multi-process lock test design (`test/ledger-lock.test.js`, `test/ledger-lock-worker.js`): 6 separate processes, 40 rounds, a start barrier per round, a pre-seeded dead-pid lock re-seeded every round; a critical section that detects any concurrent entry (mkdir of a marker directory, rmdir at exit); asserts zero entries, zero overlaps, lock left exactly as seeded, no appended entry, and a hash chain that still verifies. Controls: the same 6 processes x 40 rounds on a fresh lock never overlap and every one of the 240 appends is a valid link; a planted occupant is detected (proves the detector can fail).
- Debugging notes: the first operator-error version misreported a healthy contended lock as "no owner.json" in a 5-process run (the instant between a release and the next take); fixed by identity check, below.

### Decisions and why
- What the earlier ledger section undersold about the lock race: it said a stale lock was "broken only if the owner pid is dead AND older than 30 s" and presented the recovery as safe. It was not. With three or more processes racing over a dead-pid lock, process A could move the lock aside, process B could then examine and move A's fresh replacement lock aside, and two processes ended up holding the lock at once. The outcome was not a clean refusal: both appended, the hash chain forked, and from then on every run on that grant refused until someone repaired the file by hand (reproduced here: forked chain in 3 of 3 runs on the old code). It failed closed in the sense that it could not overspend silently afterwards, but the first overlapping appends were already written.
- Lock design, restrictive option: no automatic takeover of any existing lock. Argument: the only way two processes can both hold the lock is for the lock directory to be removed while its holder still believes it holds it. Acquire is a single atomic `rename(tmp, lock)` that cannot succeed over an existing non-empty directory, so at most one process creates the lock at a time. The only code that removes a lock is release, which renames aside only after checking the owner token equals the one this process wrote. No code path examines a foreign lock and then removes it, so there is no check-then-act step to race. The cost is that a crashed run needs a human to clear its lock.
- A kept auto-recovery was considered and rejected: it would need an additional mutual-exclusion step to guard the takeover, which is the same problem again.
- A lock that looks ownerless is only reported after the same directory (same device, inode and birth time, checked before and after the read) shows the bad owner three times with sleeps between; otherwise a lock being released and re-taken during heavy contention was misreported (this was seen once in the existing 5-process overspend test).
- `lockStaleMs` is gone as an option (nothing is broken by age); `lockMaxAgeMs` is new and only turns a long wait on a live pid into an immediate refusal with instructions.
- Short write: retry the remainder (the file is opened O_APPEND under the lock, so a retry continues the same line); refuse after three zero-progress writes. A refused short write can leave a partial last line; the next read then refuses as a torn line, with the existing hand-repair route.
- The injected `io` parameter replaces the production test hook; it carries only the two functions the durability check needs.

### What is NOT enforced after this task
- A crashed run's lock needs a human; until cleared, that grant refuses (by design, loudly, with the command).
- Release has a microsecond window between the owner-token check and the rename in which a hand-cleared lock re-taken by another run could be moved aside; it requires a manual clear while the original holder is still running.
- fsync is requested but not proven durable against a lying disk or a filesystem that ignores fsync; macOS `fsync` does not force a drive cache flush (`F_FULLFSYNC` is not used; Node does not expose it).
- Everything listed as not enforced in the earlier ledger section still holds (anyone with the user's filesystem access can rewrite the ledger; tail truncation is undetectable without an external anchor).
- A pid reused by an unrelated live program makes a dead run's lock look alive until `lockMaxAgeMs`, then it refuses with instructions.

### CHANGED LOCKED PATHS (expected: none)
None. `git diff --name-only origin/main...HEAD` lists only `LOG.md`, `src/ledger/*` and `test/ledger*` files (see the final report for the list); nothing under src/grant/, src/builder-adapter.js, src/builder-confine.js, test/builder-mock.js, `.github/`, acceptance/, schemas/, CODEOWNERS, src/validators.js or config/.

### Not verified
- The `protect-locked-paths` guard on a real PR: not runnable here, unverified.
- Power-loss durability itself: only that fsync is called on the right file descriptors (injected function), not that data survives a real power cut.
- Behaviour on a case-sensitive Linux filesystem, a network filesystem, or Windows: not run. Inode identity checks rely on `dev:ino:birthtime` and were exercised on APFS only.
- The race tests are probabilistic by nature on the old code (the failures were reproduced in every run done, but not for a fixed number of runs); on the new code they are deterministic refusals.

### Open questions for Kevin
- Dead-pid locks now always need a manual `rm -r`. Do you want an opt-in operator command (for example `npm run ledger:clear-lock -- <path>`) that verifies the pid is dead and removes the lock under a documented single-operator assumption? Not built: it is outside this spec and would be the first automatic takeover.
- `lockMaxAgeMs` default is 5 minutes; a single ledger operation takes milliseconds. Shorter?
- The meter (`src/grant/`, locked) maps any ledger lock failure to `GrantError('ledger')`; whether the adapter should show the operator the clearing command in its exit message was not touched (out of scope).
- Should `F_FULLFSYNC`-grade durability on macOS be required? Node does not offer it; it would need a native step.

## 2026-11-23 (Per grant spend ledger)
### What was done
- New `src/ledger/` (format.js, lock.js, ledger.js, report.js, index.js). Local append-only JSON-lines ledger, one file per grant, in `AGENT_LEDGER_DIR` (default `~/.agent-ledger`, refused if inside this repo, dir 0700, files 0600, a looser pre-existing dir is refused). Money is integer micro-USD. Entries: `open`, `reserve`, `settle`, `release`, `run_end`. Remaining = limit - settled - open reservations; a run with no `run_end` keeps its reservations counted. `max_tool_calls` is counted across runs (tool calls are `reserve` entries of kind `tool`).
- Grant key = the grant's existing `task_id` (schema v1 has it, so no "no identity" gap); the file name is a SHA-256 of the key. Fingerprint = SHA-256 of canonical (sorted-key) grant JSON, stored on first use; a later run with the same key and a different fingerprint refuses.
- Integrity: each line carries the SHA-256 of the previous line (hash chain), plus a sequence number. Read verifies chain, sequence, entry shape and reservation state; a broken chain, unparseable or torn line, or unknown entry type refuses. The writer validates what it appends so it can never poison its own file.
- Atomic reserve: read, check and append happen under a per-grant exclusive lock directory (built with its owner file in a temp dir, then renamed into place, so the lock never exists without an owner; released by rename-then-delete). Bounded wait; timeout or any lock error refuses. A stale lock is broken only if the owner pid is dead AND the lock is older than 30 s; a live pid's lock is never broken.
- `npm run ledger:report` (`src/ledger/report.js`, read-only, accepts `--dir`): per grant limit, settled, open reservations, remaining, tool calls, and runs without `run_end`; exit 1 with a clear ERROR on any chain failure.
- Meter (`src/grant/meter.js`): `createMeter(grant, { ledger, runId })` opens the run at creation (preflight), and routes reserve, settle, release and each tool call through the ledger; the reservation is clamped to the stricter of the in-memory and ledger remaining; `meter.end(status)` writes `run_end`. Ledger failures become `GrantError('ledger')` (added to `EXCEEDED_LIMITS`). An exhausted grant refuses at preflight.
- Adapter (`src/builder-adapter.js`): opens the default ledger (or `opts.ledger`; `null` or a non-ledger refuses), passes it to the meter, calls `meter.end` in `finish`, and passes the ledger dir to every tool as a protected directory. Preflight refusal = exit 2, mid-run failure = exit 4 with a `grant-exceeded` issue naming `ledger`.
- Confine (`src/builder-confine.js`): `src/ledger/` and `.agent-ledger/` added to `ALWAYS_LOCKED`; the read denylist refuses a `.agent-ledger` segment; new `protectedDirs` option refuses read and write of any absolute directory (ledger dir) in any case spelling, via symlink or realpath.
- Test helper `test/builder-mock.js` (not locked): points `AGENT_LEDGER_DIR` at a fresh temp dir at import and gives each `makeGrant()` a unique `task_id`, so existing tests never touch `~/.agent-ledger` and do not share a budget through the ledger.

### Commands run and results (with counts)
- Baseline origin/main 8055c29, `npm test`: Node 22.23.5 303 tests, 303 pass; Node 24.22.3 303 tests, 303 pass.
- Final: Node 24.22.3 and Node 22.23.5 both 340 tests (303 + 37 new: 19 in ledger.test.js, 3 report, 10 integration, 5 confine), 0 fail, 0 skipped. See the final report for the exact last run.
- `npm run build` clean, `npm run check:self-model` passes, `npm audit --omit=dev` 0 vulnerabilities. No new dependencies (node crypto and fs only).
- Lock removed (scratch copy under /private/tmp with the lock replaced by a no-op): "two concurrent meters ... can never overspend" FAILED 3 of 3 runs; "a lock timeout refuses" and "a stale lock ..." also fail. With the lock it passed in repeated runs, including 12 simultaneous copies.
- Debugging notes: a first release-by-delete could remove a successor's lock (found by a flaky full-suite run); fixed by releasing via rename. A later flake was a test flaw (a slow worker legitimately refused at open once the budget was gone).

### Decisions and why
- Restrictive: any ledger problem refuses; a pre-existing ledger dir with mode other than 0700 is refused rather than chmod-ed; a settle may exceed its reservation (provider cost) and then remaining goes negative, which blocks further spend.
- A mutated grant includes any change, even `expires_at` or scope; a new budget needs a new `task_id`. A run id cannot be reused on a grant.
- `createMeter` without a ledger still works in memory only (library use and the older meter tests); the adapter never runs without one.
- Lock built by mkdir plus rename rather than a bare mkdir so a crash cannot leave an ownerless lock.

### What is NOT enforced after this task
- Anyone with filesystem access as Kevin's user can delete or rewrite the whole ledger (a fresh consistent chain is accepted); a gateway-held ledger (M1) is the real answer. This does not close that.
- Tail truncation (whole lines cut off the end) cannot be detected without an external anchor; deleting the file or its last lines silently frees budget. Only an edit or removal before the last line breaks the chain.
- Single machine, single filesystem only; no provider billing reconciliation; spend is only as good as the price table and provider data.
- The `task_id` is trusted as the grant identity: the schema does not say it is unique per grant, so two different grants reusing one `task_id` collide (the second refuses as mutated).
- A crash between lock-directory creation and use is recovered only after the stale age, and only when the pid is dead; a tiny window remains where two simultaneous stale-lock breakers could contend (they refuse rather than proceed).
- The previously listed per-run-only gap from "Grant metering and expiry" is closed for runs that go through the adapter with the ledger; it remains for any other consumer of `createMeter` that passes no ledger.

### CONTRACT GAPS
- `schemas/v1/grant.schema.json`: `task_id` is the only identity field and is not documented as the unique grant key; the ledger uses it as such (no schema change made).
- The contract has no notion of a grant spanning runs, a run id, or a spend ledger; the ledger, `run_end` statuses and entry types are adapter-local.

### CHANGED LOCKED PATHS (file, one-line reason)
- `src/grant/meter.js`: meter takes a ledger and routes reserve, settle, release, tool calls and run end through it; adds the `ledger` limit.
- `src/builder-adapter.js`: opens and requires the ledger at preflight, writes run_end, passes the ledger dir as protected to the tools.
- `src/builder-confine.js`: locks `src/ledger/` and `.agent-ledger/`, denies reading `.agent-ledger`, adds `protectedDirs`.
- (`test/grant-meter.test.js` and `test/grant-adapter.test.js` were NOT changed; the new tests are in new files.)
- Not locked but touched: `package.json` (`ledger:report` script), `test/builder-mock.js` (temp ledger dir, unique task ids).

### Files for Kevin to lock by hand after review
- `src/ledger/` (add to `.github/locked-paths.txt` and the guard/CODEOWNERS lists), and the new tests `test/ledger.test.js`, `test/ledger-report.test.js`, `test/ledger-integration.test.js`, `test/ledger-confine.test.js`, `test/ledger-worker.js`. Not edited here (out of the exception).

### Not verified
- The `protect-locked-paths` guard workflow on a real PR (not runnable here); expected to fail by design.
- Behaviour on a non-macOS or network filesystem (rename atomicity, fsync, pid liveness); only APFS on macOS tested.
- No live network, real key, `builder:smoke` or paid model was used; the real `~/.agent-ledger` was never created.

### Open questions for Kevin
- Should an existing ledger dir with mode 0755 be accepted (chmod by the tool) instead of refused? Refused for now.
- Should a mutated grant under the same `task_id` ever be allowed (for example an expiry extension)? Refused for now.
- Should the stale-lock age (30 s) and lock wait (5 s) be configurable by env? Fixed defaults for now.
- Where should an external anchor for the chain tip live (gateway or a second location)?

### Run-journal issues raised
- Per run the adapter journals the existing issues; a ledger stop adds a `[kind: grant-exceeded]` issue naming limit "ledger". If `run_end` cannot be written an `attempt` entry 'ledger run_end' is journaled as failed. No entries were produced against a real endpoint.

## 2026-11-23 (Meter cost and expiry fixes)

### What was done
- Cost rule (commit 2a563c6, `src/grant/meter.js` `settle`): for a paid model the settled cost is the higher of the provider-reported `usage.cost` and the cost computed from `usage` tokens and the price table. A reported 0, negative, non-finite, non-numeric or null cost is never trusted below computed (malformed values are dropped). Missing or unusable usage settles at the full reservation, even if a cost was reported (a reported cost with no token counts cannot be checked against the price table). `:free` models unchanged (valid reported cost, else 0). Spend-record `source` is `provider` when reported >= computed, else `computed`.
- Strict expiry (commit 7ce6f7a): new `src/grant/expiry.js` `parseExpiry`. Confirmed first: the meter used `Date.parse` directly, which accepts locale strings and reads an offset-less timestamp as host-local time; the adapter preflight also used bare `Date.parse` (only the grant schema's `date-time` format check stood in front of both). Now both call `parseExpiry`: strict pattern `YYYY-MM-DDTHH:MM:SS[.f{1,9}](Z|+hh:mm|-hh:mm)`, upper-case `T`/`Z`, no padding, then explicit calendar range checks (month, days per month incl. leap years, hour 0-23, minute and second 0-59, offset hours 0-23 and minutes 0-59, year 1000-9999) before `Date.parse` on the validated string. Anything else refuses: meter `GrantError('grant')`, adapter preflight exit 2 before any network call. Past expiry at preflight still refuses.
- Existing tests adjusted for the new rule: two tests settled a reported cost with no token counts (now worst case); they now include token counts.
- Schema, guard, validators, acceptance, workflows, price table contents untouched.

### Commands run and results (with counts)
- Baseline f266fc5: 288 tests, 288 pass.
- After commit 1 (cost): Node 24.22.3 296 tests, 296 pass (8 new).
- After commit 2 (expiry), final: Node 24.22.3: `npm test` 303 tests, 303 pass, 0 fail, 0 skipped. Node 22.23.5: 303 tests, 303 pass, 0 fail, 0 skipped. 15 new tests in total.
- `npm run build` clean (self-model unchanged); `npm run check:self-model` passes; `npm audit --omit=dev` found 0 vulnerabilities. No new dependencies.
- Fail-before proof: the new `test/grant-meter.test.js` and `test/grant-adapter.test.js` run against an unmodified f266fc5 source copy (scratch dir, since removed): 6 failed, including "cost: a reported cost of 0 on a paid model settles at the computed cost", "cost: missing usage still settles at the worst-case reservation even with a reported cost", and the expiry tests for no offset, date-only, locale string and calendar-invalid date. They pass on this branch. The padded-string and preflight zero-request tests pass on f266fc5 too, because the grant schema check already refused those; the new tests lock that in at the meter and adapter level.

### Decisions and why
- SUPERSEDED: the earlier decision "Provider-reported cost is trusted over computed cost (the stated order of trust), including a reported 0" is replaced by: higher of reported and computed wins; a reported cost is never trusted below computed (Kevin's decision, 2026-11-23).
- A numeric-looking string reported cost (for example "0.003") is still parsed; if higher than computed it is honoured, otherwise computed wins. Non-numeric strings are dropped.
- Restrictive choices on expiry: leap second (:60) refused, lower-case `t`/`z` refused, years before 1000 refused, fractions beyond milliseconds truncated by `Date.parse` (rounds the expiry down, which is the safe direction).
- `parseExpiry` is exported from `src/grant/index.js` and used by the adapter so there is a single parser.

### What is NOT enforced after this task
- Spend is only as good as the price table and provider data; no reconciliation against the provider's account.
- Per-run budget only: meter state is in memory per run, the budget is per run, not per grant across runs. Two runs on the same grant each get the full budget. There is no shared ledger (a later spec).
- Only `budget.max_usd`, `budget.max_tool_calls` and `expires_at` are metered; `scope` and risk tiers are not.
- A provider that reports a cost lower than the truth AND omits token counts is settled at worst case; one that reports plausible token counts but lies about them is only as safe as those counts.
- The meter cannot stop a request already in flight; the host clock is trusted (only a backwards jump over 1 s is caught).
- The guard workflow on a real PR is unverified here.

### CHANGED LOCKED PATHS (expected: none)
- None. `git diff --name-only origin/main...HEAD` lists only LOG.md, README.md, config/prices.json, src/builder-adapter.js, src/builder-confine.js, src/grant/*, test/*; nothing under `acceptance/`, `.github/`, `schemas/`, nor `CODEOWNERS` or `src/validators.js`. (Local `main` is stale; origin/main is used as the base. This round touched `src/grant/` as the spec allows, plus `src/builder-adapter.js` for the preflight parse, and the two grant test files.)

### Not verified
- The CI guard on a real PR; any paid model against a real provider; `builder:smoke` (out of scope).

### Open questions for Kevin
- `src/builder-adapter.js` also changed (preflight now calls `parseExpiry`). It is not a locked path; consider locking it with `src/grant/`.
- Should a reported cost with no token counts on a paid model ever be honoured when it is above zero but below the reservation? Settled at the worst case for now (more restrictive).

## 2026-11-23 (Grant metering and expiry)

### What was done
- New `src/grant/` (lock as one unit): `meter.js` (`createMeter`, `GrantError`, `isMeter`), `money.js` (integer micro-USD, BigInt-exact, decimal-string conversion), `prices.js` (price table parser/loader, `:free` = 0), `spend-log.js` (append-only sidecar sink), `index.js`.
- `config/prices.json`: tracked price table (`schema_version "1"`, per model `input_micro_per_mtok` / `output_micro_per_mtok`). It ships with NO paid models, so every paid model is refused until Kevin adds a price he trusts.
- Meter: the grant is deep-copied and deep-frozen on entry; no setter exists; the meter object is frozen. `reserve(call)` checks expiry, prices the worst case (input tokens estimated as UTF-8 bytes of the serialised request, an upper bound, plus `max_tokens`), clamps `max_tokens` to the largest value that fits the remaining budget (exact integer search) or refuses. `settle` uses provider-reported `usage.cost`, else tokens x price, else (paid model, no usable usage) the full reservation. `release` returns a reservation at zero when the provider rejected the request with an HTTP error. `checkTool()` checks expiry then counts against `budget.max_tool_calls`. `checkExpiry()` refuses at or after `expires_at` and when the clock moves back by more than 1000 ms (or is non-finite). Any internal error becomes a refusal.
- Adapter: `callModel` (the only function that reaches the endpoint) and `dispatchTool` (the only code that reads or writes the worktree) both require a real meter (`isMeter`, a WeakSet brand). `runBuilder` builds the meter in preflight from the run's own grant; a grant the meter cannot use, an unpriced paid model, or no run directory for the spend record all refuse (exit 2) before any network call. Requests now carry `max_tokens` (clamped) and `usage: {include: true}`.
- Stop behaviour: any meter refusal mid-run commits work so far, journals an `attempt` (blocked) and an `issue` of kind `grant-exceeded` (limit name and numbers) and exits with the NEW exit code `EXIT.GRANT_EXCEEDED = 4` (status `grant-exceeded`). Rate limit stays 3.
- Spend record: the run-journal schema has no entry kind that can hold structured spend, so every reserve/settle/release is appended to `.agent-runs/<run_id>.spend.jsonl` (one JSON line each, `appendFileSync` with the `a` flag, key-redacted), referenced from the journal by an `attempt`, and a 15th `contract-gap` issue is logged. The schema was NOT edited.
- Write protection: `ALWAYS_LOCKED` in `src/builder-confine.js` now also covers `src/grant/`, `config/`, `grant.json`, `grants/`, `fixtures/grant/` (case, unicode and symlink folding as for the other entries).
- README exit-code line updated. The two stale contract-gap texts (max_usd unenforced, expiry start-only) were reworded, keeping their original match phrases.

### Commands run and results (with counts)
- Baseline on origin/main (84bd114), Node 24: `npm test` 258 tests, 258 pass.
- After the change, Node 24.22.3: `npm test` 288 tests, 288 pass, 0 fail, 0 skipped.
- After the change, Node 22.23.5: `npm test` 288 tests, 288 pass, 0 fail, 0 skipped.
- New tests: 30 (15 in `test/grant-meter.test.js`, 15 in `test/grant-adapter.test.js`). Existing tests changed: the old "tool calls beyond max_tool_calls" test now expects exit 4 and the new issue; the gaps test expects 15 gaps; test helpers pass a test price table (`TEST_PRICES` in `test/builder-mock.js`) to runs that use fake paid model ids. No tests skipped or removed.
- `npm run build` clean (self-model unchanged); `npm run check:self-model` passes; `npm audit --omit=dev` 0 vulnerabilities. No new dependencies.
- `git diff --name-only origin/main...HEAD` touches nothing under `acceptance/`, `.github/`, `schemas/`, nor `CODEOWNERS`, `src/validators.js`.
- Every item-6 test exists under its own name: reservation refuses over budget; `max_tokens` clamped; settle provider vs computed; missing usage settles at worst case; budget exhausted mid-run exit 4; expiry mid-run (tool call and model call); clock backwards (meter and adapter); unknown paid model zero requests; `:free` still enforces tool calls and expiry; no way to mutate the grant; write tools refuse the grant file, price table and meter; float-rounding sum; key never in spend record. Plus the structural test (grep-based: one `fetchFn(` call site inside `requestModel`, reached only via `callModel`; no other source file can reach the network; filesystem tool operations only inside `dispatchTool` after `meter.checkTool()`) and a behavioural test (fake or prototype-forged meters make no request and run no tool).

### Decisions and why (restrictive choices made without asking)
- Empty price table: no paid model priced, rather than guessing real prices. A wrong price silently weakens the budget.
- Input tokens estimated as bytes (upper bound), so budgets are conservative; real usage will be well under the reservation.
- Budget `max_usd` is rounded DOWN to micro-USD; every cost is rounded UP.
- Network error or timeout settles at the worst-case reservation (the request may have been billed). HTTP error responses release at zero (the provider rejected the request). Each 429 retry reserves and releases again.
- If the spend record cannot be written, the run refuses (mid-run: the meter refuses); no unaudited spend.
- (SUPERSEDED 2026-11-23, see the cost and expiry fixes section above: the higher of reported and computed cost now wins; a reported cost is never trusted below computed.) Provider-reported cost is trusted over computed cost (the stated order of trust), including a reported 0.
- Every mid-run meter refusal (including clock backwards, internal error) uses exit 4, not 2; preflight refusals use exit 2.
- Default `max_tokens` per call is 8192 (`DEFAULT_MAX_OUTPUT_TOKENS`); this now also applies to `:free` models, which previously sent no `max_tokens`.
- Locked the whole of `config/` and `fixtures/grant/` for builder writes, broader than the two files named in the spec.
- Only the grant's own `expires_at`, `max_usd`, `max_tool_calls` are used; no grant fields invented.

### What is NOT enforced after this task
- Spend is only as good as the price table and provider data: there is no independent check of what OpenRouter actually bills, and no reconciliation against the provider's account.
- Only `budget.max_usd`, `budget.max_tool_calls` and `expires_at` are metered. `scope`, `allowed_risk_tiers` and per-capability risk tiers are not (see earlier gaps).
- Meter state is in memory per run: the budget is per run, not per grant across runs. Two runs on the same grant each get the full budget. There is no shared ledger (out of scope).
- The meter cannot stop a request already in flight; a single in-flight call can cost up to its reservation.
- Wall-clock expiry relies on the host clock; only a backwards jump over 1 s is caught. A forward jump just expires the grant early.
- The meter protects the builder adapter only. Nothing stops other code from calling the endpoint; the structural test covers `src/` only, and a future edit that adds a path can still pass if it also keeps those strings.
- Locking `src/grant/`, `config/` is enforced for the adapter's write tools and (after Kevin's step below) by the CI guard; until Kevin adds them to `.github/locked-paths.txt`, a human or another tool can still edit them without a CI failure.
- `src/grant/` is not listed in `self-model.json` (the generator indexes only top-level `src/*.js`).
- No paid model has ever been run; paid-model reconciliation is untested against a real provider.

### CONTRACT GAPS
- Run journal cannot hold structured spend (new, journaled at runtime as the 15th `contract-gap`; sidecar used instead, schema not edited).
- The grant schema defines `max_usd` as a JSON number (float); the meter converts through decimal text, but a decimal string or integer micro-USD field would be safer. Not changed.
- Self-model generator ignores subdirectories of `src/`.
- Existing gaps from Spec C (role, risk tiers, scope vocabulary, refusal/truncation, self-model capabilities) are untouched, as specified.

### CHANGED LOCKED PATHS (expected: none)
- None. `git diff --name-only origin/main...HEAD` lists only `config/prices.json`, `src/builder-adapter.js`, `src/builder-confine.js`, `src/grant/*`, `test/*`, `README.md`, `LOG.md`. (`src/builder-confine.js` is not a locked path today but holds the adapter's lock list; review it with the same care.)

### Files for Kevin to lock by hand after review
- `src/grant/` (whole directory)
- `config/prices.json` (or all of `config/`)
- Consider also `src/builder-confine.js` (it holds `ALWAYS_LOCKED`) and `src/builder-adapter.js` (the chokepoint), and `test/grant-meter.test.js`, `test/grant-adapter.test.js` so the structural test cannot be loosened by the builder.
- Add them to `.github/locked-paths.txt` and CODEOWNERS (not edited here).

### Not verified (guard on a real PR, live endpoint)
- The `protect-locked-paths` workflow on a real PR (cannot run here).
- Any live OpenRouter call, real usage/`cost` response shape, and `builder:smoke` (not run). The `usage.cost` field and `usage: {include: true}` request flag follow OpenRouter's documented usage accounting but were only exercised against the local mock.

### Open questions for Kevin
- Which paid models, and at what prices, should go in `config/prices.json`? It is empty on purpose.
- Should the budget be per grant across runs (needs a shared ledger) instead of per run?
- Should `max_usd` in the grant schema become a decimal string or integer micro-USD?
- Should a reported provider cost of 0 on a paid model be trusted (current) or treated as suspect and settled at computed cost?
- Should mid-run clock-backwards and meter-internal errors be exit 4 (current) or 2?

### Run-journal issues raised
- `grant-exceeded` (risk/high): one per stopped run, with limit name (`budget`, `tool_calls`, `expiry`, `clock`) and numbers.
- `contract-gap`: 15 per run now (14 existing, plus spend-record sidecar).
- Existing kinds unchanged: `rate-limit`, `refusal`, `truncation`, `malformed-tool-calls`.

## 2026-11-23 (Spec C parity test and adapter fold fix)
- Files touched: src/builder-confine.js, src/builder-adapter.js, test/builder-confine.test.js, test/builder-readdeny.test.js, LOG.md
- What changed: fixed the red parity test on main (PR #4 merged with `test/builder-confine.test.js` "shared corpus" pinning the old guard's gap with a `deepEqual` on the adapter-only list; with the hardened guard that list is empty, so main failed 1 of 256 tests). The test now asserts parity both ways (`adapterOnly` and `guardOnly` both `[]`) and has four new hostile spellings (long-s CODEOWNERS, `sub/.GitAttributes`, `.git~1/x`, `a/.gitmodules`). `foldSegment` now folds exactly like the guard (`toUpperCase().toLowerCase()` before the final NFC), closing the long s (U+017F) and sharp s gap, with a test that a write to the long-s CODEOWNERS spelling is refused. `list_dir` now accepts the repository root (`.`, `./`, empty) for listing only, via a `confine` option `allowRoot` that is ignored when `write` is set; secrets and git internals stay hidden; test through the mock adapter. One existing list_dir test used a prefix match on `.git` that would now false-match `.github`; changed to an exact-name check.
- Acceptance criteria (pass/fail each):
  - parity test asserts adapterOnly == [] and guardOnly == [] with the new entries: PASS
  - foldSegment matches the guard; long-s CODEOWNERS write refused; case/NFC/NFD tests still pass: PASS
  - list_dir on root returns entries with no .git and no denylisted names; root writes refused: PASS
  - full suite green on Node 24 and Node 22, check:self-model and audit clean: see Status
- Deviations: the parity test commit alone is red on its long-s entry until the fold commit lands (one commit per issue as specified). The `list_dir` root test also covers the empty-string path, beyond `.` and `./`.
- Status: complete on branch task/spec-c-parity-fix, awaiting review. Not merged, no PR. Nothing under .github/ or acceptance/ touched; `builder:smoke` not run.
- Next step: Kevin opens the PR and reviews.

## 2026-11-23
- Files touched: package.json, package-lock.json, .gitignore, schemas/v1/*.schema.json (5), src/{validators,journal,self-model}.js, scripts/build-self-model.js, self-model.json, fixtures/** (5 schemas, valid+invalid), test/*.test.js, acceptance/{README.md,contracts.test.js}, docs/adr/0001-0005, .github/{CODEOWNERS,locked-paths.txt,scripts/locked-paths.mjs,workflows/protect-locked-paths.yml}, README.md, LOG.md
- What changed: new repo structure; versioned (v1) JSON Schemas with ajv validators for capability manifest, extension request, run journal entry (reservation/attempt/issue), grant, self-model; append/read-only journal API; deterministic self-model generator with staleness check; one ADR per contract; locked acceptance suite skeleton with CODEOWNERS and a CI workflow that fails agent-authored changes to locked paths; README (seven seams).
- Acceptance criteria (pass/fail each):
  - (a) valid and invalid fixtures for every schema, all behave: PASS
  - (b) manifest without undo rejected: PASS
  - (c) journal has no edit/delete through the API: PASS
  - (d) acceptance-suite paths protected in CI: PASS (workflow written and its logic unit-tested and exercised locally; the workflow itself has not run on GitHub)
  - (e) one ADR per contract: PASS (5 contracts, 5 ADRs)
  - (f) README explains the seven seams: PASS
  - (g) LOG.md updated: PASS
  - (h) tests and build pass: PASS (67 tests, 0 failures; `npm run build` and `npm run check:self-model` succeed)
- Deviations:
  - The spec never lists "seven seams". They were inferred as: capability manifest, extension request, run journal, grant, self-model, locked acceptance suite, overseer/gate boundary (R2/R4). The last is documented only; no code.
  - This branch itself changes locked paths (it creates them), so the CI guard will fail this agent-authored PR by design; Kevin reviews and merges it as the human exception.
  - Locked paths are `acceptance/` and `.github/`. Schemas are not locked.
  - "Agent-authored" is detected by head branch prefix task/ or agent/, bot actor, or an `agent-authored` label. Branch protection requiring the check and CODEOWNERS review must be enabled in GitHub settings by Kevin.
  - ajv strict mode is on except `strictRequired`, which is off so `anyOf: [{required}]` can express the undo rule.
  - ajv pinned at 8.20.0 (8.17.1 had an npm audit advisory; not exploitable here as `$data` is unused).
- Status: complete on branch task/contracts-and-schemas, awaiting review. Not merged.
- Next step: Kevin reviews and merges; enable branch protection and CODEOWNERS review.

## 2026-11-23 (guard and schema fixes)
- Files touched: .github/scripts/locked-paths.mjs, .github/workflows/protect-locked-paths.yml, schemas/v1/{capability-manifest,extension-request}.schema.json, fixtures/{capability-manifest,extension-request}/invalid/ws-*.json (8 new), test/ci-locked-paths.test.js, test/whitespace-text.test.js, docs/adr/0003-run-journal.md (addendum), README.md, LOG.md
- CHANGED LOCKED PATHS (review these first):
  - .github/scripts/locked-paths.mjs (guard rewritten: --no-renames -z, agent detection removed)
  - .github/workflows/protect-locked-paths.yml (guard job runs from base SHA, SHAs via env, agent env removed)
  - acceptance/: no changes. .github/CODEOWNERS and .github/locked-paths.txt: no changes.
- What changed: (1) guard checks both ends of renames and parses -z; (2) schemas reject whitespace-only button_ref, reversal_steps items, and extension-request undo_plan, why, proposed_approach, missing_capability via pattern "\S", with 8 whitespace-only invalid fixtures asserted to fail on the targeted pattern error; (3) workflow runs the base ref's guard against the PR head; (4) all agent detection removed, any locked-path change fails; (5) CLI tests on temp git repos: rename out of acceptance/, rename out of .github/, delete, add, plus a non-locked control; (6) README section, ADR-0003 addendum, this entry.
- Acceptance criteria (pass/fail each):
  - items 1-6 implemented: PASS
  - npm test: PASS (89 tests, 0 failures; was 67); build and check:self-model: PASS; npm audit --omit=dev: 0 vulnerabilities
  - new rename tests fail against the old guard (842760b), pass against the new: PASS
  - whitespace-only rejected, valid fixtures pass: PASS
  - workflow run on GitHub: NOT RUN (not allowed; logic unit/CLI tested only)
- Deviations:
  - Delete and add of locked files were already caught by the old guard (git diff --name-only lists them); only the two rename tests fail against it. The delete/add tests are regression coverage.
  - ADR note is an addendum to ADR-0003 (it already references R4), not ADR-0006, to keep the one-ADR-per-contract test and self-model unchanged.
  - acceptance/README.md (locked) still describes "agent-authored" detection and is now stale; not edited, to avoid changing another locked path. Kevin may update it.
  - Observed, not fixed (out of scope): the guard's CLI entry check compares process.argv[1] to the module URL, so invoking it through a symlinked path (e.g. /tmp on macOS) silently exits 0 without checking. The workflow calls it by a plain path, so CI is unaffected.
  - The guard cannot run from a base that lacks it, so the first PR into an empty main has no base to guard against.
- Status: complete on branch task/contracts-and-schemas, awaiting review. Not merged.
- Next step: Kevin reviews the locked-path changes above first, enables branch protection with this check and Code Owner review required, and merges manually.

## 2026-11-23 (guard symlink fail-open fix)
- Files touched: .github/scripts/locked-paths.mjs, test/ci-locked-paths.test.js, docs/adr/0003-run-journal.md (one line added to the guard addendum), LOG.md
- CHANGED LOCKED PATHS (review these first):
  - .github/scripts/locked-paths.mjs (raw-mode diff with --no-abbrev, symlink-aware resolution of changed paths and symlink targets, fail-closed main with exit 2, realpath entry-point check)
  - acceptance/, .github/workflows/protect-locked-paths.yml, .github/CODEOWNERS, .github/locked-paths.txt: no changes.
- What changed: the guard parses `git diff --raw -z --no-renames --no-abbrev` and rejects (a) any change at or under a locked path including symlink add/change/type-change/removal, (b) any changed path or symlink target whose real path lands in a locked path (symlink chains and symlinked parents followed lexically within the repo), and (c) fails closed with exit 2 on bad refs, git errors, unexpected git output, absolute or repo-escaping symlink targets. The entry-point check compared argv[1] to import.meta.url as strings, so invoking the guard through a symlink skipped it and exited 0; now realpath-compared. 20 new temp-repo CLI tests.
- Acceptance criteria (pass/fail each):
  - symlink under a locked dir, outside symlink into a locked dir, locked file replaced by symlink all fail the guard: PASS (old guard already failed closed on the first and third because it matched on path names; it failed open on a new or retargeted outside symlink into a locked dir, on symlinked invocation, and on unresolvable targets)
  - unresolvable path or git error makes the guard fail: PASS
  - existing tests incl. rename, delete, add still pass: PASS (109 tests, 0 failures: 89 existing + 20 new)
  - build, check:self-model, npm audit --omit=dev clean: PASS
  - LOG.md and ADR addendum updated: PASS
- Deviations: git never follows symlinks, so a write made through an outside symlink is recorded under the real locked path and was already caught; that case is kept as regression coverage. Tests and the symlink fix share the first commit. Workflow YAML untouched. Other review findings left out of scope.
- Status: complete on branch task/contracts-and-schemas, awaiting review. Not merged.
- Next step: Kevin reviews the locked guard change first.

## 2026-11-23 (guard workflow split)
- Files touched: .github/workflows/protect-locked-paths.yml, .github/workflows/tests.yml (new), acceptance/contracts.test.js, acceptance/README.md, README.md (guard section and layout line), LOG.md
- CHANGED LOCKED PATHS (review these first):
  - .github/workflows/protect-locked-paths.yml (now pull_request_target on main, single job id and name protect-locked-paths, contents: read, base-sha checkout with credentials kept for the refs/pull/N/head fetch, tests job removed)
  - .github/workflows/tests.yml (new: tests job moved here unchanged, plain pull_request, contents: read, no secrets)
  - acceptance/contracts.test.js (old single-workflow assertion replaced by 3 workflow-layout tests)
  - acceptance/README.md (guard fails ANY PR touching locked paths; agent-authored description removed)
  - .github/scripts/locked-paths.mjs, .github/CODEOWNERS, .github/locked-paths.txt: no changes.
- What changed: (1) guard job renamed so the required check is exactly protect-locked-paths; (2) guard in its own pull_request_target workflow so a PR cannot edit it away; (3) tests job in a separate pull_request workflow; (4) new acceptance tests (text-structure checks, no YAML parser dependency) for trigger, branches, job name, permissions, no PR code execution, and the separate tests workflow; README guard section updated to match.
- Acceptance criteria (pass/fail each):
  - npm test: PASS on Node 22 and Node 24 (111 tests, 0 failures each; was 109)
  - build, check:self-model, npm audit --omit=dev (0 vulnerabilities): PASS
  - new tests fail against the old single workflow (ffa8148), pass against the new layout: PASS
  - workflow run on GitHub: NOT RUN (not possible locally)
- Deviations: root README.md edited (two statements about the old workflow were factually wrong now); ADR-0003 addendum left as is (still accurate). tests.yml keeps node 24 and the old step order.
- Status: complete on branch task/contracts-and-schemas, awaiting review. Not pushed, not merged.
- Next step: Kevin reviews the locked-path changes above first, then pushes.

# LOG - Spec C

(New top-level section: the existing LOG.md history above is kept; entries there are per-task dated notes, this one follows the Spec C template.)

## What was done
Built the OpenRouter builder adapter in agent-core, items 1-6 of the spec, in new files only.
1. Config: `src/builder-config.js` (loader, `ConfigError`), `src/builder-redact.js`. Env, optional untracked `.agent-builder.local.json` (added to `.gitignore` with `.agent-runs/`), defaults per spec. API key env only (a key-like field in the file is an error), attached as a non-enumerable property, redacted from journal, errors, stacks and commits. Provider prefs passthrough. `FREE_MODEL_REPO_ALLOWLIST` default `["agent-core"]`. `role` accepts only `builder`.
2. Adapter: `src/builder-adapter.js` (tool loop on built-in fetch, no new dependencies), `src/builder-confine.js` (path confinement), `src/builder-capabilities.js` (4 manifests, all with undo, validated with the existing validator). Journal entries (reservation, attempt, issue) go through `createJournal().append`.
3. Rate limits: 429 or daily-cap error handled with bounded backoff, then a clean stop (see RATE-LIMIT BEHAVIOUR).
4. Tests: `test/builder-config.test.js` (7) and `test/builder-adapter.test.js` (25) with `test/builder-mock.js`, a local mock server on 127.0.0.1 with an ephemeral port. Two model IDs both complete; mocks for 429, malformed tool calls, refusal, truncation, 404 model-not-found.
5. `npm run builder:smoke` (`scripts/builder-smoke.js`): runs one tiny task in a throwaway local clone against the real endpoint. NOT RUN by this task.
6. Contract gaps journaled at runtime as issues of kind `contract-gap` and listed below.
Also: self-model regenerated (the generator indexes top-level `src/*.js`, so the adapter files are flat `src/builder-*.js` rather than `src/builder/`); README section.

## Commands run and results (with counts)
- Baseline on origin/main (de64e51): 111 tests (not re-run before changes; `npm ci --ignore-scripts` clean, 0 vulnerabilities).
- `npm test` Node 22.23.5: 143 tests, 143 pass, 0 fail, 0 skipped (111 + 7 config + 25 adapter).
- `npm test` Node 24.22.3: 143 tests, 143 pass, 0 fail, 0 skipped.
- `npm run build`: wrote self-model.json (8 modules, 5 contracts, 5 ADRs). `npm run check:self-model`: up to date.
- `npm audit --omit=dev`: 0 vulnerabilities.
- `git diff --name-only origin/main...HEAD`: no path under acceptance/, .github/, schemas/, or src/validators.js.
- Local guard dry-run `node .github/scripts/locked-paths.mjs <origin/main sha> <HEAD sha>`: exit 0.
- Not run, by design: `npm run builder:smoke`, any real network call, any real key.

## Decisions and why
- Task shape: the contract has no task-spec schema, so a task is `{repo, goal, grant, workdir, branch?}` with `grant` validated by the existing grant validator (see gaps). Grant scope, `max_tool_calls`, `expires_at` and risk tier low are enforced before any network call.
- Exit codes: 0 ok, 1 failed (model not found, refusal, truncation twice, malformed x3, budget, HTTP/network error), 2 refused before any network call (config, allowlist, expired grant, protected branch), 3 rate-limited.
- The adapter refuses to build on main/master/develop or detached HEAD, and commits only the files the model wrote, by explicit path.
- Truncation: the cut-off reply is discarded and the model is told once to use smaller steps; a second truncation stops. Malformed tool call: error returned to the model; 3 in a row stops.
- Flat file layout `src/builder-*.js` so the existing self-model generator lists the adapter without changing it.
- Key safety: key is never put in an entry; every string is additionally passed through a redactor (exact key, `sk-or-...` shape, `Bearer ...`) before append, commit message, tool reply or thrown error; stacks are rebuilt redacted (UNVERIFIED beyond the one thrown-error test; see fix round).

## CONTRACT GAPS (file, what was awkward, how it was handled)
- schemas/v1/run-journal-entry.schema.json: issue entries have no `kind` field (category is bug/risk/improvement, unevaluatedProperties false). Handled: description prefixed `[kind: rate-limit]`, `[kind: contract-gap]`, etc., with the nearest category (rate-limit=risk, contract-gap=improvement).
- schemas/v1/run-journal-entry.schema.json: no failure entry kind. Handled: `attempt` with outcome `failed` or `blocked`.
- schemas/v1/grant.schema.json: no task-spec schema (no goal, repo identity, branch). Handled: adapter wrapper object, grant validated only.
- schemas/v1/grant.schema.json: `scope.paths` semantics unspecified. Handled: relative prefixes; `.`, `*`, `**` mean all.
- docs/adr/0003-run-journal.md (src/journal.js): guarantee is in-process only. Handled: adapter mirrors entries to untracked `.agent-runs/<run_id>.jsonl` (no append-only protection on that file).
- src/self-model.js: only indexes top-level `src/*.js`, no capabilities field, so builder capabilities are not listed in self-model.json (modules are). Not changed.
- schemas/v1/capability-manifest.schema.json: no registry/publication place for manifests. Handled: validated and written to `.agent-runs/<run_id>.capabilities.json`.
- No role concept anywhere in the contract; R2 for this builder is enforced by the adapter config only.
All of the above are journaled as `contract-gap` issues in every run. [CORRECTION, fix round: this was wrong. The role gap was in this list but not journaled (7 of 8). Fixed; see the fix-round section below.]

## RATE-LIMIT BEHAVIOUR (documented exit code, backoff bounds)
- Exit code 3 (`EXIT.RATE_LIMITED`).
- Trigger: HTTP 429, or any error body mentioning a per-day/daily cap.
- Wait: the `Retry-After` header (seconds or HTTP date) if present, else exponential `base_delay_ms * 2^n` (1s, 2s, 4s), capped at `max_delay_ms` (30s). Defaults: `max_retries` 3, so at most 4 requests per step and 7s to 90s of waiting. Configurable only inside bounds: max_retries 0-5, max_delay_ms up to 120000.
- Stops immediately (no waiting) on a daily cap or a `Retry-After` above `max_delay_ms`.
- On stop: attempt entry (blocked), issue `[kind: rate-limit]` (risk/medium), work so far committed on the branch, status `rate-limited`.
- Model not found (404 or equivalent) is a journaled failed attempt, exit 1, no throw.

## CHANGED LOCKED PATHS (expected: none)
None. `git diff --name-only origin/main...HEAD` lists only: .gitignore, LOG.md, README.md, package.json, scripts/builder-smoke.js, self-model.json, src/builder-*.js (5 files), test/builder-*.js (3 files).

## Open questions for Kevin
- Template conflict: the existing LOG.md uses dated per-task entries; this Spec C section follows the template exactly and is appended.
- Should the contract gain a task-spec schema, an issue `kind` field and a failure entry kind (new schema version)?
- The smoke script clones this repo locally and works in a temp dir; confirm that is the low-risk public-repo task you wanted (it makes no push).
- `particle-ai/particle-1:free` could not be verified (no network); the id is config only.

## Run-journal issues raised
Per run, the adapter journals: one reservation (free/third-party model data policy doubt); one `[kind: contract-gap]` issue per gap above (7 at first pass; now 14, see fix-round section); `[kind: rate-limit]` on a rate-limit stop; `[kind: refusal]`, `[kind: truncation]`, `[kind: malformed-tool-calls]` when those stop a run. Entries are only produced when the adapter runs; none were produced against any real endpoint during this task.

# LOG - Spec C fix round

Fixes the standards-review findings on 56f4ad2 (see `.agents/specs/failed/TASK_SPEC-openrouter-builder-adapter-2026-11-23T0904-a3c66b.md` in the orchestrator repo). Same branch, one commit per issue, new commits on top of 56f4ad2. The "LOG - Spec C" section above is the first-pass log; where it differs from this section, this section is the current truth (the first-pass section was not rewritten, corrections are listed below).

## What was done
1. Path-lock hardening (`src/builder-confine.js`, `test/builder-confine.test.js`). One shared check for every path the tools can touch, failing closed on any error: realpath (symlinks followed, canonical case via `realpathSync.native`) and the lexical path are both checked; segments are folded (NFD, ignorable zero-width/soft-hyphen characters removed, NFC, lower case, trailing dots/spaces stripped) before comparing; `..`, absolute paths, leading `~`, NUL, backslash refused; any `.git`-like segment refused (`.git`, `.GIT`, `.git `, `.git.`, `.git~1`, `GIT~1`, `.gitmodules`, `.gitattributes`, ignorable-char spellings), for reads and writes. Locked: acceptance/, .github/ (holds the guard script and CODEOWNERS), any file named CODEOWNERS, src/validators.js, .git/, .agent-runs/, .agent-builder.local.json, plus whatever `.github/locked-paths.txt` lists. package.json is not locked. `confineMove(root, from, to)` checks both ends of a rename or move. Reproduced reviewer finding: `.GIT/config` write is now refused (end-to-end test with a hostile fsmonitor config; `.git/config` is byte-identical afterwards).
2. Allowlist from the git remote (`remoteRepos`, `parseGithubRemote` in `src/builder-adapter.js`). For a `:free` model every remote of the workdir (fetch and push URLs) must parse as GitHub https, scp-style ssh or ssh:// and be on `FREE_MODEL_REPO_ALLOWLIST`; `task.repo` is ignored for that decision. No remote, unparseable remote, userinfo in the URL, a workdir that is not its repo's top level, or any git error refuses. Runs in preflight, before any request. `scripts/builder-smoke.js` now sets the clone's origin to this repo's own remote URL so a `:free` smoke run is not refused.
3. Read denylist (`isReadDenied`, `confine`). Refused: `.env*`, `.git` contents, `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`, `~`-relative paths, anything outside the workdir (including via symlinks), `*.pem *.key *.crt *.cer *.p12 *.pfx *.der *.jks *.keystore *.asc *.gpg *.ppk`, `id_*`, `.netrc .npmrc .pypirc .pgpass .git-credentials`, `.agent-builder.local.json`, `.agent-runs`, and any name containing token, credential, secret, password, apikey, private-key. Refusals are `attempt` entries with outcome `failed`, never crashes. `list_dir` hides denied names. Reads now open the file, require a regular file, and read at most 50000 bytes (no whole-file read, no FIFO hang).
4. https enforcement (`checkBaseUrl` in `src/builder-config.js`). Base URL must be https; plain http only for 127.0.0.1, `[::1]`, localhost (exact hostnames). Checked at config load and again in adapter preflight (hand-built config). Requests use `redirect: 'error'`.
5. Journal correctness (`CONTRACT_GAPS`). 8 first-pass gaps now all journaled (the role gap was missing), plus 5 reviewer gaps (max_usd unenforced, expires_at start-only, risk tiers only checks low, ad-hoc scope strings, refusal/truncation unrepresented).
6. Self-model: generator and schema NOT extended. The missing capabilities field is journaled as one more `contract-gap`.

## Commands run and results (with counts)
- Baseline at 56f4ad2: 143 tests.
- New tests: 13 (confine) + 8 (allowlist) + 3 (read denylist) + 4 (https) + 2 (gaps) = 30; total 173.
- `npm test` Node 22.23.5: 173 tests, 173 pass, 0 fail, 0 skipped (143 + 30 new).
- `npm test` Node 24.22.3: 173 tests, 173 pass, 0 fail, 0 skipped.
- `npm run build`: wrote self-model.json (8 modules, 5 contracts, 5 ADRs), no diff. `npm run check:self-model`: up to date.
- `npm audit --omit=dev`: 0 vulnerabilities.
- `git diff --name-only origin/main...HEAD` (and against the local `main`, which is ahead of origin/main): no path under acceptance/, .github/, schemas/, CODEOWNERS or src/validators.js.
- Local guard dry run `node .github/scripts/locked-paths.mjs <origin/main> <HEAD>`: exit 0 ("no locked paths touched").
- Not run, by design: `npm run builder:smoke`, any live network call, any real key.

## Decisions and why (restrictive choices made without asking)
- Locked set follows this spec (acceptance/, .github/, CODEOWNERS, guard, src/validators.js), not only `.github/locked-paths.txt`, which today lists just acceptance/ and .github/. A file named CODEOWNERS is locked at any depth.
- The guard (`.github/scripts/locked-paths.mjs`) exports `isLocked` but it is an exact-string prefix match with no case, unicode or `.git` handling, so it cannot be reused for normalisation. The adapter check is its own implementation, and `test/builder-confine.test.js` runs a shared corpus through both: on canonical paths they agree; every guard-locked path is refused by the adapter; the adapter additionally refuses the exact list of spellings the guard does not fold (case variants, zero-width characters, `./acceptance/x`, trailing dot/space, the bare name `acceptance`). The guard was not edited.
- The write allowed-path (grant) check is exact-case on both the lexical and the real path, so `DOCS/x.md` is refused under a `docs/` grant even on a case-insensitive filesystem.
- All spellings of `.gitmodules` and `.gitattributes` are treated as git internals, and `.git`-like segments are refused for reads as well as writes.
- Read-denylist matches are deliberately broad (any name containing "token", "secret", "credential", "password"); this will refuse some harmless docs. False positives are cheaper than leaks.
- Denylist and git refusals on reads are `attempt` outcome `failed` (spec wording); lock and grant refusals on writes stay `blocked` as before.
- `:free` allowlist entries compare by repo name, case-insensitive (the spec says "list of repo names"). An entry may also be written `owner/repo`. The default stays `agent-core` by name only, so a fork `someoneelse/agent-core` would also pass; see Open questions.
- Every remote (fetch and push, all URLs) must be allowlisted, not just `origin`, so a second private remote cannot ride along.
- Spec item 4's last clause ("refused when the model ID is `:free` against a non-loopback host") is read as: non-https is refused for every non-loopback host including `:free` models; https hosts are allowed. A `:free` model against loopback http works only for the mock server.
- No `move_file` tool was added; `confineMove` exists and is tested for any future move/rename tool.
- No new dependencies.

## CONTRACT GAPS (all 13 plus the self-model gap)
All 14 are journaled at runtime on every run as `[kind: contract-gap]` issues (proved by `test/builder-gaps.test.js`).
First pass, 8 (the first-pass LOG said all 8 were journaled; only 7 were, the role gap was missing and is now fixed):
1. schemas/v1/run-journal-entry.schema.json: issue entries have no `kind` field.
2. schemas/v1/run-journal-entry.schema.json: no failure entry kind (failures are `attempt` failed/blocked).
3. schemas/v1/grant.schema.json: no task-spec schema.
4. schemas/v1/grant.schema.json: `scope.paths` semantics unspecified.
5. docs/adr/0003-run-journal.md: journal guarantee is in-process only.
6. src/self-model.js: indexes only top-level `src/*.js`.
7. schemas/v1/capability-manifest.schema.json: no registry for manifests.
8. schemas/v1/ (all): no role concept (builder vs overseer, R2).
Found by the reviewers, 5:
9. grant.schema.json: `budget.max_usd` cannot be enforced (no metering).
10. grant.schema.json: `expires_at` checked only at start; no mid-run or wall-clock expiry.
11. grant.schema.json: `allowed_risk_tiers` has no defined semantics; adapter only checks `low`.
12. capability-manifest.schema.json: `scopes` are free-form strings; adapter invented its own.
13. run-journal-entry.schema.json: refusal and truncation have no representation.
Self-model:
14. schemas/v1/self-model.schema.json and scripts/build-self-model.js: no field for adapter capabilities. NOT extended; Kevin decides. (Gap 6 is the related but different "only indexes top-level src/*.js" point.)

## CHANGED LOCKED PATHS (expected: none)
None. `git diff --name-only main...HEAD` lists no file under acceptance/, .github/, CODEOWNERS, schemas/, or src/validators.js (checked, see below).

## Not verified (guard on a real PR, live endpoint)
- The `protect-locked-paths` workflow on a real PR: not run (no PR; not possible locally). Only the guard script was dry-run locally.
- The live OpenRouter endpoint, the `particle-ai/particle-1:free` model ID, and its real response shapes: never contacted. `builder:smoke` not run. No real key was used.
- Behaviour on a case-insensitive filesystem is exercised by the folding tests (which pass on any filesystem) and by the real APFS volume this was run on; a case-sensitive Linux run was not done.
- 8.3 short-name (`.git~1`, `GIT~1`) and trailing-dot/space handling is refused by name; it was not tested against an NTFS volume.
- First-pass LOG claims not proved by a test, now marked unverified: "stacks are rebuilt redacted" is only tested through the thrown-error path with a stack containing the key (test "a network error whose message contains the key"), not for every error path; "mock server records zero requests" is proved only for the preflight refusals listed in tests; "the smoke script makes no push" is by inspection, not by a test.

## Open questions for Kevin
- Allowlist is by repo name, so a fork `other-owner/agent-core` would pass. Should the default become `KosherKev/agent-core` (owner/repo entries are already supported)? Restrictive choice not taken because the spec fixes the default to `agent-core`.
- Read denylist breadth (names containing token/secret/credential/password) may block legitimate docs; loosen?
- Should `.gitignore` / `.gitattributes` / `.gitmodules` writes ever be allowed to a builder? Currently `.gitattributes` and `.gitmodules` are refused, `.gitignore` is allowed.
- Should the contract gain a role concept, an issue `kind`, a failure entry, metering for `max_usd`, a self-model capabilities field (gaps above)?
- The first-pass review also listed LOW findings not in this spec's scope and left open: `.agent-runs` is written before the role/branch/allowlist checks, `git add` fails the batch on a gitignored file, an unchanged write reports "completed" with no commit, the `/per[- ]day|daily/` match also applies to non-429 bodies, no wall-clock cap, unbounded response body size, redaction covers only the exact key, `sk-or-...` and `Bearer ...` shapes, test temp dirs are not cleaned up.
- builder:smoke is safe to run only after Kevin reviews this fix round; the command-execution path (`.GIT/config`) is closed and tested, but the guard check on a real PR is still unverified.

## Run-journal issues raised
Per run, the adapter journals one reservation (free/third-party model data policy), 14 `[kind: contract-gap]` issues, and on the relevant stops `[kind: rate-limit]`, `[kind: refusal]`, `[kind: truncation]`, `[kind: malformed-tool-calls]`. Read-denylist and git-internals refusals are `attempt` entries, not issues. No entries were produced against a real endpoint during this task.
