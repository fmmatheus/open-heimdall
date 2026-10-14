# Coordinator lifecycle validation

Evidence for `heimdall coordinator start`, `stop` and `logs` and the native user-service adapters.

**Status: this page holds three separate bodies of evidence.**

0. **Final acceptance, `01b073f`** (next section). The full local matrix on macOS, the Linux installed-package and
   native suites, and the corrections made after `0651d81` pass at that commit, with one host-load instability of
   `npm test` on macOS that is recorded rather than resolved. PENDING: the GitHub-hosted CI jobs, a held-reservation
   drain under a native manager, native systemd checks of the stopped-definition refresh and of the stop ordering,
   and Windows (unsupported).
1. **Corrected code, `61847fe`** (the section after it). Local checks and the native lifecycle suite on a real launchd
   user domain (macOS) pass. The native suite on a real systemd user manager (Ubuntu 24.04 VM) passes with 10
   passing and 3 skipped cases (none of them native Linux checks of the corrected behavior). On Linux, the
   installed-package tests fail 3 of 22 (the same 3 as at the base commit `e5c6fbc`, so not caused by the corrected
   code), and nothing in this work makes them pass. PENDING: the GitHub-hosted CI jobs (configured, not run), a
   held-reservation drain under a native manager, a native systemd check of the stopped-definition refresh and of
   the deadline cases, and Windows (unsupported).
2. **Earlier evidence, `3bfdc76`** (sections headed "Historical"). Kept as recorded, attributed to the code it was
   gathered on. It is not evidence for the corrected code.

- **Follow-up corrections (in progress)**, the first section below. It records the evidence gathered for the start
  and stop corrections made after `97552f9`, starting with a baseline that reproduces a defect and the correction that
  makes it pass. It is not acceptance evidence for any commit.

Nothing in this record shows that a run can execute under a native service. A user's real OpenCode or
OpenChamber installation, provider accounts and quota were not involved.

## Follow-up corrections (in progress)

This section is written as the corrections land. Each subsection names the code it was gathered on. Until a later
subsection says otherwise, nothing here shows a correction works.

### Pre-delivery start request: baseline

**Trigger.** The production runner lets a native start client outlive the lifecycle command that spawned it. A start
command can therefore end (its `--timeout` deadline, Ctrl-C, or being killed) while its client has not yet delivered
the request to the service manager. At that moment the manager has no job queued and reports nothing, so a later
`heimdall coordinator stop` that consults the manager sees an inactive service with a correlated clean shutdown. The
client can still deliver afterwards and launch the coordinator. A `stop` that answers `already-stopped` in that
window is a false success.

**Method.** `test/fixtures/synthetic-native-tool.mjs` gains an additive `predeliver/<verb>` control: while the file
exists a starting call (`systemctl --user start`, `launchctl kickstart`) waits before it is recorded in `calls.jsonl`,
before it writes its `inflight/` marker, and so before `show <unit> -p Job` can report a queued job; after the file is
removed it proceeds as an ordinary call. `test/coordinator-lifecycle-pre-delivery.test.mjs` runs the production
lifecycle commands, adapters and `createExecFileRunner` in separate CLI subprocesses against that synthetic tool,
with file barriers and finite harness deadlines. It is mocked-manager evidence: the synthetic tool is neither
launchd nor systemd. Each case starts from an owned inactive definition with a correlated previous clean shutdown
(`start` ready, `stop` stopped), holds the next start before delivery, ends the invoking command, and runs `stop`,
the same `stop` again and `stop --no-wait` from other processes while the held client is alive, then releases the
client.

| Case (per manager) | Invoking command is ended by |
| --- | --- |
| hold control | nothing: the held client is released while the command waits |
| deadline | `start --timeout 1` expiring |
| Ctrl-C | an actual SIGINT sent to the start process |
| kill | SIGKILL of only the start process; its detached client is not signalled |

The hold-control case shows, while the client is held: `show -p Job` prints nothing (systemd), no `inflight/` marker
exists, the call is absent from `calls.jsonl`, the attempt record is `dispatching` and no service is running. After
release, with a second gate set, the same client is recorded, marks its request in flight, `show -p Job` prints
`Job=1`, and once the gate is lifted the start completes `ready`.

**Baseline code and commands.** The cases were run on a disposable build of `97552f9` (`git archive 97552f9`
extracted into a fresh directory, `npm ci --ignore-scripts` and `npm run build` with an isolated `HOME` and npm
cache; the new test file and the changed fixture and harness files were copied in unchanged; `src/` identical to the
managed checkout, which is at the same source) and, with the same source, in the managed checkout, on macOS (Node
v22.22.3):

```
node --test test/coordinator-lifecycle-pre-delivery.test.mjs
```

**Results (identical in the disposable copy and the checkout): 8 cases, 5 pass, 3 fail.**

| Manager | Case | Result |
| --- | --- | --- |
| launchd | hold control, deadline, Ctrl-C, kill | pass: no `kickstart` probe reports a queued request, so the attempt stays unresolved and every `stop` answers `completion-unknown` |
| systemd | hold control | pass |
| systemd | deadline, Ctrl-C, kill | **fail** (expected): every `stop` answered `already-stopped` while the held client was alive |

Outcomes of the three failing cases (client-exit times from the baseline run; the checkout run differed by at most
30 ms):

| systemd case | Invoking command | Elapsed | `stop`, repeated `stop`, `stop --no-wait` | Held client after the stops | Attempt record after the stops |
| --- | --- | --- | --- | --- | --- |
| deadline | `startup-not-confirmed` / `startup-timeout`, exit 1, one document | 1052 ms | `already-stopped`, `already-stopped`, `already-stopped` (all `ok: true`, exit 0; 150 to 230 ms each) | alive, no inflight marker, no recorded start call | removed |
| Ctrl-C | `startup-not-confirmed` / `interrupted`, exit 1, one document | 341 ms (4 ms after the signal) | the same three `already-stopped` | alive, no inflight marker | removed |
| kill | killed by SIGKILL, no output | 328 ms | the same three `already-stopped` | alive, no inflight marker | removed |

The attempt record was `dispatching` (written by the invoking command, `ownerPid` equal to its pid) before the first
`stop`. The first `stop` removed it because the manager reported no queued job, and the record did not exist for the
two later stops, which therefore had nothing to consult.

After release the held client delivered exactly one `start` call and the manager launched the coordinator in every
failing case, that is, after the three `already-stopped` answers. A `stop` after that launch returned `stopped`
and no tool call was signalled. The synthetic tool refused no verb.

**What remains unproven here.** launchd passes only because it has no probe, not because it knows the client is gone,
so it stays unresolved even after a client has ended without delivering. Nothing shows how long a started client
lives or what happens once it is gone. The synthetic tool stands in for both managers, so the behavior of real
`systemctl --user start` and `launchctl kickstart` clients under a deadline, Ctrl-C or kill is not established by
these cases. The 3 failing cases assert that no `stop` claims `stopped`, `already-stopped` or `stop-requested` while
the held client is alive and can still deliver; the next subsection records them passing with these assertions
unchanged.

### Pre-delivery start request: fixed

**Change.** The released start client is now recorded durably before it can deliver, and a recorded client that is not
proven finished keeps its attempt unresolved whatever the manager reports.

- When a `start` runs its native start call, the production runner starts the client (`systemctl --user start`,
  `launchctl kickstart`) through a small launcher process: spawned detached, so it leads its own process group and its
  process id names the group. The launcher waits on its standard input and runs the tool only after the invoking
  command has written the client's `{ pid, spawnedAt }` into `launch-attempt.json` (an additive optional `client`
  field of the existing `schemaVersion: 1` record) and then sent the go-ahead. If the record cannot be written, or the
  command's deadline or Ctrl-C comes first, or the command dies, the launcher's input closes without the go-ahead and
  it exits without running the tool, so no request was issued and none is left behind.
- Liveness is the process group: `kill(-pid, 0)`. Only `ESRCH` means gone. A group that exists, a refused probe, and a
  process id reused by something else all count as running, so the answer errs toward unresolved. Elapsed time, the exit
  of the invoking command, an interruption and its `ownerPid` are never evidence.
- `assessLaunchAttempt` resolves a `dispatching` attempt only when the client is proven gone and the manager has no
  queued job (systemd: inactive and `Job=` empty). A `dispatching` record with no `client`, which is what a record
  written before this change looks like and what remains when a command ended before it started a client, is
  unresolved with the message "no record of the start client exists ...". A malformed `client` makes the record
  unreadable, and `stop` reports `completion-unknown` / `state-unknown`. A `requested` record (the client exited
  successfully and the manager answered) resolves as before. launchd has no queued-request probe, so a `dispatching`
  launchd attempt stays unresolved after the client is gone, as before.
- `stop` with no endpoint (including `--no-wait`, which never returns `stop-requested` or `already-stopped` there)
  keeps returning `completion-unknown` while the attempt is unresolved. When the endpoint answers, the authenticated
  instance no longer clears a record whose client may still deliver; after a clean drain, `stop` returns
  `completion-unknown` ("... completed a clean shutdown, but a stopped coordinator is not established") instead of
  `stopped`, and `stop --no-wait` still reports `stop-requested` but adds that an earlier start request may still
  launch the coordinator. Stop-generation fencing, expected-instance validation and the drain request itself are
  unchanged.
- The command's lifetime is unchanged: the client is released at the deadline or on Ctrl-C exactly as before, and
  nothing is killed, cancelled, stopped or signalled that was not before.

**Commands** (macOS, Node v22.22.3, mocked-manager evidence as above):

```
node --test test/coordinator-lifecycle-pre-delivery.test.mjs
node --test test/coordinator-lifecycle-released-client.test.mjs
node --test test/coordinator-lifecycle-pre-delivery.test.mjs test/coordinator-lifecycle-released-client.test.mjs test/coordinator-lifecycle-launch-uncertainty.test.mjs test/coordinator-lifecycle-process-exit.test.mjs test/coordinator-lifecycle-ordering.test.mjs test/coordinator-lifecycle-ownership.test.mjs test/coordinator-lifecycle-deadline.test.mjs test/coordinator-drain.test.mjs test/coordinator-native-systemd.test.mjs test/coordinator-native-launchd.test.mjs test/coordinator-lifecycle-cli.test.mjs
npm run check
npm test
```

**Results.** `coordinator-lifecycle-pre-delivery.test.mjs`: 8 of 8 pass, with the assertions of the baseline unchanged
(no assertion was weakened, removed or given a longer wait). The eleven files of the third command (the ten of the
focused lifecycle set plus the new released-client file): 212 of 212 pass. `npm run check` exits 0; `npm test` passes, 1407 of 1407 (the 1390 of the earlier record plus the 8
pre-delivery and 9 released-client cases).

| Case (per manager) | Invoking command | Elapsed (budget) | `stop`, repeated `stop`, `stop --no-wait` while the client is held | After release |
| --- | --- | --- | --- | --- |
| deadline | `startup-not-confirmed` / `startup-timeout`, exit 1 | 1055 to 1058 ms (1000 ms budget, 2500 ms limit) | `completion-unknown`, `completion-unknown`, `completion-unknown` (`ok: false`, exit 1, 105 to 215 ms each) | one start delivered, coordinator launched once, final `stop` returned `stopped`, record removed |
| Ctrl-C | `startup-not-confirmed` / `interrupted`, exit 1 | 241 to 414 ms (2 to 6 ms after the signal; 1500 ms limit) | the same three `completion-unknown` | the same |
| kill | killed by SIGKILL | 263 to 388 ms | the same three `completion-unknown` | the same |

In every case the held client stayed alive, unsignalled, with its attempt record `dispatching` and no in-flight
marker or call recorded across all three stops. The synthetic tool's `violations` and `signals` logs were empty, and no
`stop`, `kill`, `bootout`, `restart`, `disable`, removal or unload verb was called. Both managers behave alike here:
the launchd cases already passed at baseline, and the systemd cases that answered `already-stopped` now answer
`completion-unknown`.

`coordinator-lifecycle-released-client.test.mjs` (9 cases) adds: the record names the client, as the leader of the
process group the tool runs in, before the tool runs (checked while the tool is held before delivery, with no
in-flight marker and no recorded start call); a recorded live client makes the drain path end in `completion-unknown`
rather than `stopped`, keeps the record unchanged, and makes `stop` and `stop --no-wait` claim nothing afterwards; the
record resolves once the client group is gone on systemd (`already-stopped`) and stays unresolved on launchd;
`stop --no-wait` after a drain request returns `stop-requested` with the late-launch note; and records without client
evidence, with a malformed client, or in the `requested` phase are handled as described above. The drain-path case
was checked to fail (`stopped`) when the new check is removed from the built output.

**Assertion changes to existing tests.** None.

**What remains unproven.** The synthetic tool stands in for both managers; real `systemctl --user start` and
`launchctl kickstart` clients under a deadline, Ctrl-C or kill are not exercised. Process-group liveness is the only
client-completion evidence: a process id reused by an unrelated group keeps an attempt unresolved until that group
ends, and a command that died between writing the record and starting a client leaves a record that only an explicit
start or a `requested` outcome replaces. An explicit `start` still replaces an earlier record, the authenticated
instance still clears a record in the start paths, and recovery of attempts, are not changed here (the next
subsection changes all three). The Linux VM and the native suites were not run for this change.

### Explicit start and the authenticated instance no longer settle an unresolved attempt

**Defect.** At `97552f9` (source identical at `6850805`), an explicit `start` that found an earlier launch attempt
logged "this explicit start replaces its record", wrote a new record, refreshed the service definition and issued a
second start, even when the earlier request was a client that could still deliver. The record is the only thing that
keeps `stop` from claiming a stopped coordinator, so replacing it discarded the evidence. Separately, the two
authenticated-instance paths of `start` cleared the record unconditionally, although a client that was not proven
finished could still deliver a request that launches the coordinator again after a stop.

**Change** (`lifecycle-launch.ts`, `lifecycle-start.ts`; no flag, outcome or error code was added):

- `writeLaunchAttempt` refuses to write while any record exists, so a replacement cannot happen even by mistake. An
  explicit `start` first assesses the earlier record with the observations `stop` uses (`assessLaunchAttempt`). While
  it is unresolved, unreadable or malformed, or its assessment fails, the start is a `conflict` / `state-unknown` that
  names the record file and does not replace the record, refresh the definition or issue a request. If it resolves,
  the start continues with a fresh record.
- The authenticated-instance sites call `clearLandedAttempt`, which clears the record only when no recorded client that
  is not proven finished could deliver; an unreadable record is kept.
- A record written by this version carries `recordsClients: true`. A record with it that names no client belongs to a
  command that ended before it released one: nothing left that command, so it resolves without a manager probe. A
  record without it (written by an earlier version) that names no client stays unresolved, as before.

**Commands** (macOS, Node v22.22.3, mocked-manager evidence):

```
node --test test/coordinator-lifecycle-pre-delivery.test.mjs test/coordinator-lifecycle-launch-uncertainty.test.mjs test/coordinator-lifecycle-ordering.test.mjs
node --test test/coordinator-lifecycle-*.test.mjs test/coordinator-lifecycle.test.mjs test/coordinator-native-systemd.test.mjs test/coordinator-native-launchd.test.mjs
npm run check
```

**Baseline versus fixed.** The new cases in `coordinator-lifecycle-pre-delivery.test.mjs` (per manager: an explicit
start while a client is held before delivery; recovery after the client finished; a malformed record; plus one
manager-independent case for the record helpers) were run on a disposable worktree of `6850805` with the fixtures
from the checkout, and on the fixed code.

| Case | Baseline `6850805` | Fixed |
| --- | --- | --- |
| explicit start while the client is held, both managers | `startup-not-confirmed`: the start logged "this explicit start replaces its record" and went on to start (the first assertion that failed was the outcome, so the later ones were not reached) | `conflict` / `state-unknown`, record, definition and native calls unchanged, `stop` still claims nothing; after release one delivery, one launch, `stopped`, record removed |
| explicit start after the client finished and no request is queued | launchd: the start replaced the record and went on (the case expects `conflict`); systemd: the case passed, the record resolves by absence | systemd starts (the record resolves); launchd is `conflict` until the owner removes the record, then `ready` |
| explicit start with a malformed record | `ok: true` on launchd (record replaced, start went on); systemd failed the same expectation | `conflict` / `state-unknown`, record bytes unchanged, no native call, no definition installed |
| `clearLandedAttempt` with a live, a finished and no client, and an unreadable record | not present | live client and unreadable record keep the record; finished or absent client clears it |

On the fixed code `coordinator-lifecycle-pre-delivery.test.mjs` passes 15 of 15; the lifecycle set (the second
command) passes 248 of 248; `npm run check` exits 0.

**Assertion changes to existing tests.** Two cases encoded the replacement and now assert the stricter behavior:
`launchd: without queued-request evidence an issued kickstart stays unresolved ...` in
`coordinator-lifecycle-launch-uncertainty.test.mjs` used an explicit `start` to settle the record. It now asserts that
`stop` and `start` both stay unresolved, that the refused start issues no `kickstart` or `bootstrap`, and that the
start reaches `ready` after the owner removes the record as the message directs. This is the launchd uncertainty
claim kept truthful: launchd still cannot report a queued request, so Heimdall still does not guess. In
`coordinator-lifecycle-ordering.test.mjs`, `a native launch that was already issued ...` (both managers) ran an
explicit `start` right after the held launch landed; the instance may not have answered yet, so that start is now a
`conflict` until it does. The case retries the start until it is ready and asserts that no second launch was issued.

**What remains unproven.** The synthetic tool stands in for both managers; real clients under a deadline, Ctrl-C or
kill are not exercised. A record whose client is a process id reused by an unrelated group stays unresolved until that
group ends; the owner can then remove the record as the message states. The Linux VM, the native suites, the package
tests and the full suite were not run for this change.

## Final acceptance: verified commit `01b073f`

The source verified in this section is `01b073f` (`fix(coordinator): publish the access key only once it holds a
complete token`), the last commit that changed source. Its ancestry includes the base `0651d81`. Every later commit
on the branch changes this page only. The source changed after the earlier Linux and native runs, so the Linux
installed-package suite and the native suites were run again at `01b073f` in a new VM instead of being cited.

### Environments

| Item | macOS host | Linux VM |
| --- | --- | --- |
| OS | macOS 27.0.1 (Darwin 27.0.0, arm64) | Ubuntu 24.04.5 LTS, Linux 6.8.0-142-generic aarch64, systemd 255 |
| Node.js / npm | v22.22.3 / 10.9.8 (default); v24.21.0 / 11.19.0 (mise); v22.19.0 / 10.9.3 (official `darwin-arm64` tarball, SHA-256 checked against `SHASUMS256.txt`, extracted in a disposable directory); v26.11.1 (credentials regression only) | v22.19.0 / 10.9.3 and v24.21.0 / 11.19.0 (official `linux-arm64` tarballs, SHA-256 checked) |
| Execution context | ordinary logged-in user | ordinary non-root user, `Linger=no` before and after the suites |
| Source | managed checkout at `01b073f` | `git archive HEAD` of `01b073f` committed into a scratch repository, `npm ci --ignore-scripts`, `npm run build` |

The VM was a Lima 2.2.1 `vz` guest (stock `ubuntu-24.04` template, no host mounts, 2 CPUs, 3 GiB), created for this
run and deleted afterwards.

### Commands and results at `01b073f`

| Command | Environment | Result |
| --- | --- | --- |
| `npm run check` | macOS, Node 22.22.3 | exit 0 |
| `npm run build:extension` | macOS, Node 22.22.3 | exit 0 |
| `npm test` | macOS, Node 22.22.3 | passes, with intermittent failures under host load (see below): 1390 tests, 1390 pass in 2 of the 3 clean re-runs (83 s each); 10 further consecutive full runs 1390 of 1390 |
| `npm run test:package` | macOS, Node 22.22.3 | 46 of 46 pass (140 s) |
| `npm run test:package` | macOS, Node 24.21.0 | 46 of 46 pass (155 s) |
| `npm run test:package` | macOS, Node 22.19.0 | 46 of 46 pass (123 s) |
| `node --test --test-concurrency=1 test/setup-*.test.mjs test/doctor*.test.mjs test/runtime-identity*.test.mjs` | macOS | 253 of 253 pass (89 s) |
| Regression set: the access-key, redaction, systemd link ownership, launch uncertainty, process exit, journal, ownership, refresh, private paths, managed and short credentials, deadline, ordering, credentials, adapters, CLI, stop and logs, drain, native adapter, executor, service and lifecycle files, run serially | macOS | 452 of 452 pass (188 s) |
| `node@26 --test test/coordinator-credentials.test.mjs` | macOS, Node 26.11.1 | 12 of 12 pass |
| `HEIMDALL_NATIVE_LIFECYCLE=1 npm run test:native` | macOS, launchd user domain | 16 tests: 12 pass, 4 expected skips (23 s) |
| `npm run test:package` | Linux, Node 22.19.0 | 46 of 46 pass (221 s) |
| `npm run test:package` | Linux, Node 24.21.0 | 46 of 46 pass (228 s) |
| setup, doctor and runtime-identity set | Linux, Node 22.19.0 and 24.21.0 | 253 of 253 pass on each (37 s and 48 s) |
| `HEIMDALL_NATIVE_LIFECYCLE=1 node --test --test-concurrency=1 test/native/*.test.mjs` | Linux, real systemd user manager, Node 22.19.0 | 16 tests: 14 pass, 2 expected skips (14 s) |

The Linux native skips are the launchd-only refresh case and the case that needs the production executor (a
restarted managed service always runs the real executor). After the native suite on Linux no
`heimdall-coordinator-*` unit, unit file, `~/.config/systemd/user` entry, `/tmp/hn-*` root or coordinator process
remained, and `Linger` was still `no`.

### Baseline versus fixed: the access key could be read empty

Defect (found while diagnosing `npm test` failures; present at `0651d81` and before): `startCoordinatorService`
created `coordinator.key` empty and wrote it in a second step. `coordinator start`, `status`, `stop` and the
OpenChamber service read that key without the ownership lock, so a probe racing a starting coordinator could read an
empty file and fail with `Invalid coordinator access key`. A lifecycle `start` that hit this reported an unresolved
state instead of waiting.

Correction: `src/coordinator/service.ts` writes the key to `coordinator.key.pending` and renames it into place under
the state-directory ownership. An existing key is kept, and a leftover pending file is replaced.

Regression: `test/coordinator-key-creation.test.mjs` (3 tests) starts a real service process on a fresh state
directory 12 times while another loop reads the key as fast as it can. Baseline (the same test against the previous
two-step creation in a disposable copy of the built output), three runs: 1 of 3 tests passing each time; the
reader saw an unusable key in 2 to 4 of the 12 starts, and the pending-file test failed. Fixed, three runs: 3 of 3
pass. A separate tight-poll loop over 150 fresh starts of the previous code saw an empty key in 120 of them.

### `npm test` on the macOS host: recorded instability

`npm test` ran as one `node --test test/*.test.mjs` process with default parallelism. On this host the result
depends on load from unrelated processes (load averages between 10 and 99 were observed while an unrelated test
run was active on the same machine).

- At `473e6ca` (before the access-key fix), under load: 1381 of 1387 (5 failures and 1 cancelled file), then 1387 of
  1387, then 1383 of 1387 (4 failures). The failing tests differed from run to run (drain, launchd and systemd
  readiness, snapshot launch, link-ownership and configuration tests). One of them (`start does not adopt a running
  managed coordinator whose expected link is a missing target`) failed with the empty-key read described above and
  is fixed by `01b073f`.
- At `01b073f`: one full run (519 s, while a VM was being prepared) ended with one test file,
  `coordinator-service.test.mjs`, alive at 0% CPU about seven minutes after its last reported test; the process was
  ended by hand and counted as one failure (1389 of 1390). The file passes alone (6 of 6 runs) and showed no hang in
  96 further runs at 8-way concurrency. Three clean re-runs then gave 1389 of 1390 (one failure, `systemd: after an
  already-issued start, a timeout ends the command without ending the request, and stop claims nothing until it
  resolves`, which returned `failed` instead of `startup-not-confirmed`), 1390 of 1390 and 1390 of 1390. Ten more
  consecutive runs, with a message-only change to one assertion that was reverted afterwards, were all 1390 of 1390.
- The 96 concurrent runs of `coordinator-service.test.mjs` also showed that its fixture repositories inherit the
  host's `commit.gpgsign=true`: 11 runs failed with `gpg failed to sign the data` when several commits competed for
  the signing agent. The full-suite failures above contained no such error.

Not resolved: the single hang and the single process-exit failure did not reproduce, and no cause is claimed for
them. The access-key read is the only failure with a demonstrated mechanism and a fix. **PENDING**: the cause of the
two non-reproduced failures, and a fixture-level `commit.gpgsign=false` for hosts that sign commits globally.

### Areas of the work and where they are established

| Area | Tests | Where the evidence is |
| --- | --- | --- |
| Redaction of known values that collide with credential syntax | `test/coordinator-redaction-collisions.test.mjs` | "Redaction: known values that collide with credential syntax" |
| systemd link ownership | `test/coordinator-systemd-link-ownership.test.mjs`, `test/native/` foreign-link case | "systemd ownership" and "Real-native checks" |
| Launch attempts surviving the invoking process | `test/coordinator-lifecycle-launch-uncertainty.test.mjs` | "Launch attempts survive the invoking process" |
| Command lifetime bound to its deadline and Ctrl-C | `test/coordinator-lifecycle-process-exit.test.mjs`, native delayed-shutdown case | "The command's lifetime is bound by its deadline and Ctrl-C" and "Real-native checks" |
| Empty Linux journals | `test/coordinator-journal-logs.test.mjs`, `test/package/` | "Empty Linux journals" |
| Linux installed package (extraneous `msgpackr-extract` platform package) | `test/package/` | "Linux installed package: the extraneous `msgpackr-extract` platform package" |
| Access key published only when complete | `test/coordinator-key-creation.test.mjs` | this section |

The dependency diagnosis (npm 10 reports the leftover optional `@msgpackr-extract/*` platform package as extraneous)
is unchanged; the package suite passes on Linux with Node 22.19.0 and 24.21.0 in the new VM.

### Cleanup

- Both Lima instances created for this work were stopped and deleted; `limactl list` reports no instance.
- On the host: no fixture launchd label (`launchctl list` shows none), no `~/Library/LaunchAgents` entry, no `/tmp/hn-*`
  root and no fixture process remains. Fixture processes and a temporary root left by an aborted diagnostic copy of
  the tests were ended and removed, as were the extracted Node 22.19.0 tarball and the temporary installed-package
  roots from interrupted package runs.
- **Cleanup pending**: 19 directories `/private/tmp/hl-*` and older `heimdall-baseline-*` and `heimdall-native-*`
  roots under the user temporary directory predate this verification pass and could not be attributed to it, so
  they were not removed. Check that nothing uses them (`lsof +D <dir>`) before deleting.

### Pending in this record

- The GitHub-hosted jobs in `.github/workflows/test.yml` (`baseline`, `macos-harness`, `installed-package`,
  `native-lifecycle`) were not run; whether a hosted Linux runner provides a usable user manager is unverified.
- A held-reservation drain under a real launchd or systemd manager; a native systemd check of the stopped-definition
  refresh and of the stop ordering.
- The non-reproduced `npm test` hang and process-exit failure, and the fixture signing sensitivity (see above).
- Windows is unsupported and was not exercised. One macOS and one Ubuntu release on arm64 only.

## Corrected code: verified commit `61847fe`

The code verified below is `61847fe` (`docs(coordinator): align lifecycle documentation with corrected behavior`),
the last commit that changed source. The base it corrects is `e5c6fbc`. Every later commit on the branch changes
this page only. Evidence labels: **mocked-manager** means the production launchd/systemd adapters and a real
coordinator process driven through `test/fixtures/controlled-native-runner.mjs`, with a stateful stand-in for
`launchctl`/`systemctl`; it is not native evidence. **Protocol fixture** means a synthetic authenticated socket
peer. **Native** means a real user service manager.

### Environments

| Item | macOS host | Linux VM |
| --- | --- | --- |
| OS | macOS 27.0.1 (Darwin 27.0.0, arm64) | Ubuntu 24.04.5 LTS, Linux 6.8.0-142-generic aarch64 |
| Service manager | launchd (Darwin Bootstrapper 7.0.0), per-user domain `gui/<uid>` | systemd 255 (255.4-1ubuntu8.17), `systemctl --user`, user bus at `/run/user/<uid>/bus` |
| Node.js / npm | v22.22.3 / 10.9.8 (default); v24.21.0 / 11.19.0; v26.11.1 | v22.19.0 (the minimum supported, official tarball) / 10.9.3 |
| Execution context | ordinary logged-in user, existing GUI login session | ordinary non-root VM user in an SSH login session |
| Linger | not applicable | `Linger=no` before the suite, after the suite and after the package tests (the template enabled it; it was disabled inside the VM only) |
| Source | the managed checkout at `61847fe` | `git archive 61847fe` copied into the VM |

Linux VM: Lima 2.2.1, `vz` driver, stock `ubuntu-24.04` template (cloud image release 20260926), no host mounts,
2 CPUs, 3 GiB memory, 12 GiB disk. Dependencies were installed with `npm ci --ignore-scripts` and the project was
built with `npm run build` inside the VM. The VM was stopped and deleted afterwards; `limactl list` then showed no
instance.

### Local checks (macOS, Node 22.22.3, npm 10.9.8)

| Command | Result |
| --- | --- |
| `npm run check` | `tsc --noEmit` clean |
| `npm test` | 1245 tests, 1245 pass, 0 fail, 0 skipped (run twice, before and after the last documentation commit) |
| `npm run build:extension` | exit 0 |
| `npm run test:package` | 22 tests, 22 pass, 0 fail, 0 skipped |
| `node --test --test-concurrency=1 test/setup-*.test.mjs test/doctor*.test.mjs test/runtime-identity*.test.mjs` | 253 tests, 253 pass, 0 fail, 0 skipped |
| `npm run test:package` on Node 24.21.0 / npm 11.19.0 | 22 tests, 22 pass, 0 fail, 0 skipped |
| `node --test test/coordinator-credentials.test.mjs` on Node 26.11.1 | 12 tests, 12 pass, 0 fail, 0 skipped |
| `git diff --check e5c6fbc..61847fe` | clean |

Node.js 22.19.0 was not run on macOS; it was run on Linux (below). Node.js 24 and 26 were not run on Linux.

### Defect regressions: baseline versus corrected

**Baseline** means a disposable copy of `e5c6fbc` (`git archive e5c6fbc`, `npm ci --ignore-scripts`,
`npm run build`) into which the new test file and `test/fixtures/controlled-native-runner.mjs` were copied, then:

```sh
cd <baseline> && node --test test/<file>.test.mjs
```

**Corrected** is the same command in the branch checkout at `61847fe` (after `npm run build`). All results are
mocked-manager or protocol-fixture evidence unless a native result is named.

| Defect | Regression file (cases) | Baseline `e5c6fbc` | Corrected |
| --- | --- | --- | --- |
| 1. Public `start` could not refresh an owned, stopped launchd definition after the credential file or entry point changed; the diagnostic named an internal adapter method | `test/coordinator-lifecycle-refresh.test.mjs` (16): changed credential path and changed entry point end `ready` with a new instance and one `bootout`; refusal and state-change-during-refresh cases; systemd in-place refresh | 16 tests, 8 pass, 8 fail (both launchd refresh cases returned conflict `inactive-registration-stale`; the six state-change tests failed). Unchanged-context, running, foreign and systemd cases pass at the base and keep passing | 16 of 16 pass. Native launchd: see below |
| 2. Ownership was accepted from a disk definition, a pid or an authenticated endpoint alone | `test/coordinator-lifecycle-ownership.test.mjs` (51; both adapters): foreign registration with a matching pid, missing loaded path and null manager pid for start, stop and new start; unrecognized state; ownership change between inspection and the shutdown request; controls (owned graceful stop, alias link, previous credential context, linked systemd fragment) | 51 tests, 21 pass, 30 fail: foreign, missing-path and null-pid registrations were reported `already-running` or `ready`, and the shutdown request was sent anyway; the change-between-inspection case sent the request. Mismatched pid and unknown-state cases for start and stop already passed at the base | 51 of 51 pass |
| 3/4. An existing group- or world-accessible state directory was chmodded and accepted; a FIFO at a log destination blocked the open | `test/coordinator-private-paths.test.mjs` (21): insecure 0755 state directory for public start and stop, creation of missing directories, create races, symlink substitution, FIFO / directory / symlink / insecure-file log destinations | 21 tests, 9 pass, 12 fail: start and stop returned status 0 on a 0755 directory and changed it to 0700; a symlink target was chmodded; the FIFO start child stayed alive 15 s past its result and was killed by the harness | 21 of 21 pass; the FIFO child exits 1 in under 100 ms with one JSON document and no native call |
| 5. A managed `serve` without a credential file used the manager-inherited OpenCode password | `test/coordinator-managed-credentials.test.mjs` (12) and two executor cases in `test/coordinator-executor.test.mjs` | 12 tests, 10 pass, 2 fail: the default and the opaque custom reference authenticated with the inherited value (a request with an `Authorization` header reached the stand-in) | 12 of 12 pass; managed without a file fails before any OpenCode request |
| 6. Short known credential values (under 4 or 8 characters) were not masked | `test/coordinator-short-credentials.test.mjs` (12); the old "values under four characters are not masked" assertion in `test/coordinator-credentials.test.mjs` is replaced by a masking requirement | 12 tests, 1 pass (the authentication control), 11 fail: values leaked in producer logs, lifecycle result text, `/lifecycle` responses and shutdown records | 12 of 12 pass across streams, result fields, `/lifecycle`, shutdown records and log files |
| 7/8. Start and stop shared no overall deadline; `stop` published its ordering boundary only after the drain; an abandoned start could still launch | `test/coordinator-lifecycle-deadline.test.mjs` (7, protocol fixture) and `test/coordinator-lifecycle-ordering.test.mjs` (21, both adapters) | Deadline: 0 pass, 7 fail (start readiness reported success after the deadline; a stop with a 1000 ms budget took 2004 ms; Ctrl-C took 2992 ms). Ordering: 21 tests, 2 pass, 19 fail (a queued start relaunched after `--no-wait` and after `already-stopped`; a publication failure still reported success; an abandoned install launched, giving 2 starts instead of 1). The abandoned-install-failure scenario and the post-deadline shutdown request did not reproduce as runtime failures; they are covered only by an invariant unit test | Deadline 7 of 7 and ordering 21 of 21 pass; elapsed times stay within the budget plus a 600 ms tolerance |
| 9. `serve output never contains credential values, even in shutdown failure diagnostics` failed on Node 26 | `test/coordinator-credentials.test.mjs`: the original test (unchanged) and `serve handles SIGINT and SIGTERM before it announces readiness` | The new test fails. Cause demonstrated: `serve` printed `Coordinator listening` before installing its SIGINT/SIGTERM handlers, so an early SIGTERM ended the child by default action with empty stderr (about 60% of serial diagnostic runs on Node 26.11.1 and on 22.22.3). The original test failed 1 of 80 under 8-way load on Node 26.11.1 and 0 of 80 on Node 22.22.3 | The new test passes. The original test passed 12 of 12 on Node 26.11.1, 20 of 20 singly and 80 of 80 under 8-way load on both versions; 300 diagnostic runs per version all ended `code:1` with the diagnostic flushed |

Additional behavior covered by existing passing tests: foreground recognition, expected-instance validation and
run-owner refusal (`test/coordinator-stop-logs.test.mjs`, `test/coordinator-lifecycle-cli.test.mjs`,
`test/coordinator-drain.test.mjs`).

Two existing assertions were replaced because they endorsed the defects: the `--no-wait` and timeout generation
expectations in `test/coordinator-stop-logs.test.mjs` (a stop request now advances the stop generation once), and
the short-value assertion named above.

### Native results on the corrected code

**macOS, real launchd** (host above, Node 22.22.3):
`HEIMDALL_NATIVE_LIFECYCLE=1 npm run test:native` gave 13 tests, 12 pass, 0 fail, 1 skipped. The skip is the
documented queued-work case (covered by a coordinator test); it is not counted as a pass. The passing cases
include `launchd: start after a clean stop applies a changed credential file path to the stopped definition`
(defect 1, native) and `native delayed drain (protocol fixture; launchd on macOS)`: a `stop --timeout 1` against
a coordinator whose shutdown is delayed by a fixture entry point ended in about 1.0 s with `completion-unknown`
and exit 1 while the service stayed registered and running; after the service finished on its own the shutdown
record was `completed` and a later `stop` reported `already-stopped`. This is a delayed shutdown stage, not a held
run reservation.

**Linux, real systemd user manager** (VM above, Node 22.19.0, `61847fe` snapshot):

```sh
HEIMDALL_NATIVE_LIFECYCLE=1 node --test --test-concurrency=1 test/native/*.test.mjs
```

13 tests, 10 pass, 0 fail, 0 cancelled, 3 skipped. The 10 passing cases are the same registration, readiness,
duplicate and simultaneous start, terminal independence, explicit-only policy, clean and repeated stop, logs,
later start and crash cases as in the historical run, now on the corrected code. The 3 skips are not passes:

- the documented queued-work case;
- the launchd stopped-definition refresh (macOS only by design);
- the delayed-drain fixture (macOS only by design).

So there is **no native Linux check** of the stopped-definition refresh or of the deadline and delayed-drain
behavior. The systemd in-place refresh is covered by a mocked-manager case in
`test/coordinator-lifecycle-refresh.test.mjs` only.

**Linux installed-package tests** (`npm run test:package`, same VM): 22 tests, 19 pass, 3 fail. The same three
fail on the `e5c6fbc` base built in the same VM (22 tests, 19 pass, 3 fail), so they are not caused by the
corrected code, and nothing in this work addresses them:

| Failing case | Observed |
| --- | --- |
| `test/package/install.test.mjs`: `resolves one supported @opencode/plugin and no quota package dependency` | `npm ls` (npm 10.9.3) in the consumer reports `@msgpackr-extract/msgpackr-extract-linux-arm64@3.0.4 extraneous`, which the test rejects. Cause not investigated further at the time; diagnosed and resolved in "Linux installed package: the extraneous `msgpackr-extract` platform package" below. |
| `test/package/lifecycle.test.mjs`: `consumer install:` and `global install: setup registers nothing; ...` | The final `coordinator logs` on an unused state directory exits 0 and prints `-- No entries --` from `journalctl`; the test expects exit 1 and a "no logs" message, which is what the macOS file-log path produces. |

The package tests also need git metadata, because `scripts/pack.mjs` lists files with `git ls-files`: the first run on
the bare `git archive` copy was cancelled by that hook (22 cancelled) until a throwaway repository was created in the
VM copy. The installed-package CI matrix includes `ubuntu-latest`, so these failures would be expected there too.
Whether to change the tests or the Linux behavior is an open decision and was not made here.

### Cleanup

| Item | Outcome |
| --- | --- |
| macOS native run | `launchctl print gui/<uid>` before and after contained no Heimdall label; no new temporary fixture directory; no Heimdall file in `LaunchAgents`. |
| Linux native run | No fixture service left loaded, no `heimdall` link or unit file under the user manager's configuration directory, no `hl-*` or `hn-*` fixture directory, no coordinator process, `Linger=no`. The user manager still held an in-memory `not-found failed` record for the fixture unit (see the historical observation below); it is cleared with the VM. The package tests left four `heimdall-tarball-*` directories under the VM's temporary directory. |
| Linux VM | Stopped and deleted; `limactl list` showed no instance. The downloaded image remains in the host's Lima cache. |

Nothing was escalated; no cleanup is pending on the host.

## Corrections after `0651d81`

Further corrections made on top of `0651d81`. Each subsection names the defect, the regression file, the commands and
the baseline versus fixed results. Environment of the runs below: macOS (arm64), Node v22.22.3, npm 10.9.8. The
"baseline" is a disposable copy of `0651d81` outside the repository (`git archive 0651d81`, `npm ci --ignore-scripts`,
`npm run build`) into which the new test file was copied unchanged.

### Redaction: known values that collide with credential syntax

Defect: known-value masking ran before the Authorization, URL user information and capability masks, in `maskSecrets`
and in `sanitizeShutdownError`. An accepted credential value `B` turned `Bearer`/`Basic` into `[redacted]earer` and
`[redacted]asic`, and a value `:` destroyed `://`, so the pattern masks no longer matched and the payload stayed
visible. A value `e` did the same to `Bearer`.

Correction: `src/redaction.ts` locates the known values and the pattern spans on the original text and replaces the
union of the spans in one pass. Overlapping spans are replaced as one, by the stable marker of the first pattern among
them (`Bearer [redacted]`, `scheme://[redacted]@`, `[redacted]`), otherwise by `[redacted]`. A marker is never
scanned again. Known values of every nonempty length remain masked, longest first, with regular expression
metacharacters escaped. `sanitizeShutdownError` and `sanitizeResultText` use the same helper with their previous rule
sets. Only diagnostic strings are sanitized; serialized JSON structure, protocol identifiers, outcomes, error codes
and numeric fields are untouched. The minimum password length and the setup and doctor credential policy are unchanged.

Regression file: `test/coordinator-redaction-collisions.test.mjs` (52 cases). Credential values `B` and `:` come from
a private (mode 0600) credential file with opaque references. Collision cases cover `B` with Bearer and Basic payloads,
`:` with `scheme://user:password@host`, both together, `e` with the Bearer marker, partially overlapping values and
capability digits, on the helpers (`maskSecrets`, the output sanitizer, `sanitizeResultText`,
`sanitizeShutdownError`), the producer writers (strings and buffers), parsed and rendered lifecycle results (JSON
fields and human text) and, per manager with the controlled native runner (mocked manager, real coordinator process
and files), a start failure, a drain failure (`/lifecycle` response, stored shutdown record read and raw, raw process
log) and a close failure, where the original failure code stays observable. Controls: no known value, a one- to
three-character value accepted from the file and authenticating unchanged, longer and contained values,
metacharacters, `e` alone, and the same end-to-end cases with an unrelated credential.

| Run | Command | Result |
| --- | --- | --- |
| Baseline `0651d81` | `node --test test/coordinator-redaction-collisions.test.mjs` | 52 tests, 19 pass, 33 fail (all collision cases and the colliding end-to-end cases; every control passes) |
| Fixed code | same command | 52 tests, 52 pass |

Decisive baseline assertion: `maskSecrets` returned `first [redacted]earer syntheticbearer123 second [redacted]asic
c3ludGhldGljOnNlY3JldA== third`, and the stored shutdown error read `... [redacted]earer syntheticbearer123 ...
scheme[redacted]//syntheticuser[redacted]syntheticpassword@example.test/path ...`.

Other checks on the fixed code:

| Command | Result |
| --- | --- |
| `node --test` on the new file, `test/coordinator-short-credentials.test.mjs`, `test/coordinator-credentials.test.mjs`, `test/setup-*.test.mjs`, `test/doctor*.test.mjs` | 197 tests, 197 pass, 0 fail, 0 skipped; the existing files are unchanged |
| `npm run check` | exit 0 |
| `npm test` | exit 0; 1297 tests, 1297 pass, 0 fail, 0 skipped |
| `npm run build:extension` | exit 0 |

Scope of the evidence: automated tests against the controlled native runner on a macOS host. No real launchd or
systemd service was involved.

### systemd ownership: the expected user-unit link must resolve to the owned definition

Evidence label: **controlled-runner** (mocked manager). The production systemd adapter, the unit definitions, the
public lifecycle commands, the coordinator process and the state files are real; `systemctl --user` is a stateful
stand-in. Upstream behavior is cited from the systemd v255 sources (link handling in `unit-file.c`, fragment storage
in `load-fragment.c`, the exported property in `dbus-unit.c`): a unit linked from outside the search paths keeps the
link source as its `FragmentPath`. The reported fragment can therefore be the expected link. The real-manager
check, with the `FragmentPath` systemd actually reported, is recorded in "Real-native checks: delayed shutdown on
launchd and systemd, and the foreign unit link under systemd" below; the evidence in this subsection is the
controlled-runner part only.

Defect: `ownsFragment` accepted a reported fragment equal to the expected link path (`$XDG_CONFIG_HOME/systemd/user/<unit>`)
without resolving it. With a valid owned definition kept under the state directory, the expected link pointing at a
different complete unit, the manager reporting the link as the fragment, and the authenticated instance and process id
matching, `start` reported `already-running` and `stop` sent the shutdown request.

Correction (`src/coordinator/native/systemd.ts`): the reported fragment, the expected link and the definition path are
all resolved with `realpath`, and ownership requires equality with the resolved owned definition (a missing, looping,
unreadable, dangling or foreign target is not ownership). The definition itself must still pass the existing
no-follow read and shape validation. Rechecks: `start` resolves the fragment and validates the definition again
immediately before the start request; the in-place refresh of an inactive unit resolves it before the rewrite and
again before the reload; a first install refuses to run `systemctl link` over an unowned link that already occupies
the expected path; `unloadInactive` resolves the link immediately before unlinking. The lifecycle layer already
inspects ownership twice before a shutdown request (`stop`) and once more on every readiness pass (`start`), so those
paths pick the corrected check up. Canonical aliases and links that resolve to the owned definition (any number of
hops) remain owned, and the macOS launchd adapter is unchanged. The remaining window between the final resolution and
the manager acting on the unit cannot be closed from the client side.

Review of every `ownsFragment` call site: `registrationOwnership` (feeds `inspectOwnership`, used by the start
readiness loop, the already-running adoption, and both `stop` checks) now resolves; `install` (loaded: refuse unless
resolved, resolved again before rewrite and reload; not loaded: pre-check of an occupying link before `systemctl
link`); `start` (resolved plus definition validation, repeated before the request); `unloadInactive` (resolved, then
the link itself resolved again before `unlink`). `cleanupFixture` goes through `unloadInactive`.

Regression file: `test/coordinator-systemd-link-ownership.test.mjs` (43 cases) with a small runner extension in
`test/fixtures/controlled-native-runner.mjs` (`observe`, which records on `start`, `link` and `daemon-reload` where the
unit's link resolved when the manager began the call). A complete foreign unit, a missing target, a link loop and a
two-hop link ending at the foreign unit are each placed at the expected link path while the manager reports the link as
the fragment with the coordinator's own process id. For each: an existing managed `start` (conflict, not
`already-running`), `stop` and `stop --no-wait` (conflict, no shutdown request: no shutdown record, lifecycle phase
still `running`, process alive), a new start whose link changes after the service started (never `ready`), start of an
inactive unit, a refresh of a changed credential (the owned definition is not rewritten, no `daemon-reload`), and
`unloadInactive` (link kept). Also: an unreadable target, a first start over an occupying foreign link, and a link
swapped after the manager's inspection for start, both stop ownership checks, the new-start launch, a refresh and
`unloadInactive`. Controls: the normal owned file and legitimate link (start adopts, stop drains), links reaching the
owned definition through 1, 2 and 3 extra hops, a stopped owned unit starting again, `unloadInactive` of an owned
link, and a link restored after a refusal. The refusal cases assert that the runner recorded no forbidden verb and
that no `start`, `link` or `daemon-reload` ran after the command began.

| Run | Command | Result |
| --- | --- | --- |
| Baseline `0651d81` | `node --test test/coordinator-systemd-link-ownership.test.mjs` | 43 tests, 11 pass, 32 fail (every foreign, dangling, looping and swapped-link case; all controls and the `unloadInactive` cases, which already checked the link, pass) |
| Fixed code | same command | 43 tests, 43 pass |

Decisive baseline assertions: with the link on the foreign unit, `start` exited 0 with `already-running` and `stop`
exited 0 with `stopped` (a shutdown request was sent to a coordinator owned by a different definition).

Other checks on the fixed code (macOS host, Node v22.22.3, npm 10.9.8):

| Command | Result |
| --- | --- |
| `test/coordinator-lifecycle-ownership.test.mjs` | 51 tests, 51 pass |
| `test/coordinator-native-systemd.test.mjs`, `test/coordinator-native-launchd.test.mjs` | 25 and 28 tests, all pass |
| `test/coordinator-lifecycle-ordering.test.mjs` | 21 tests, 21 pass |
| `test/coordinator-lifecycle-refresh.test.mjs` | 16 tests, 16 pass on repeated runs; one earlier run reported a single failure that was not captured and did not reproduce in nine later runs (alone, in parallel and inside `npm test`) |
| `npm run check` | exit 0 |
| `npm test` | exit 0; 1340 tests, 1340 pass, 0 fail, 0 skipped |
| `npm run build:extension` | exit 0 |

### Launch attempts survive the invoking process

Evidence label: **subprocess, synthetic native tool** (mocked manager). Each lifecycle command runs in its own
process (`test/fixtures/lifecycle-cli-entry.mjs`) with the production adapter and `createExecFileRunner`. `systemctl`
and `launchctl` are explicit synthetic executables (`test/fixtures/synthetic-native-tool.mjs`) that keep their state in
files, hold a verb on a gate file, spawn the real coordinator from the registered definition when released, and refuse
(and record) any verb that could stop, kill, restart or enable a service. Not launchd or systemd evidence; **real-manager
check: pending.**

Defect: the evidence that a native start was requested lived in the operation lock held by the invoking process. When
that process was killed after the request was dispatched, the lock disappeared and a `stop` from another process saw no
coordinator and no lock, so it could not tell that the request was still in flight.

Correction (`src/coordinator/lifecycle-launch.ts`, used by `lifecycle-start.ts` and `lifecycle-stop.ts`): `start` writes
`<state>/lifecycle/launch-attempt.json` (mode `0600`, atomic) under the operation lock after the last chance to abandon
the launch and before the native start is issued; if it cannot be written, no start is requested. The record is
`dispatching` until the manager answers the request, then `requested`. It is removed when a start was not needed, was
refused before dispatch or definitively failed, and when an observation correlates it with the service: the
authenticated instance running as the owned registration's main process, or the service proven inactive with the
request accepted (`requested`) or, for systemd, `systemctl --user show -p Job` reporting no queued job. A start
tool that was ended by its timeout keeps the record `dispatching`. `stop` with no answering coordinator reads the
record after inspecting ownership and, while it is unresolved, returns `completion-unknown` (`completion-unknown`)
without a stopped claim and without any native stop, kill or removal. An unreadable record is `state-unknown`. An
explicit `start` replaced an unresolved record (superseded by "Explicit start and the authenticated instance no longer settle an unresolved attempt"). No flag, result field or error code was added.

Regression file: `test/coordinator-lifecycle-launch-uncertainty.test.mjs` (10 cases, both managers). With the start
held on the gate: the invoking CLI is killed with `SIGKILL`; a separate-process `stop` (twice) does not report
`stopped` or `already-stopped`, the record stays unchanged, the synthetic tool saw no violation and no signal; the gate
is released, the coordinator launches, `stop` reports `stopped` and the record is gone; a later `stop` reports
`already-stopped` and a later explicit `start` reaches `ready`. Also: the invoking CLI reaching its deadline
(`startup-not-confirmed`, a `stop` meanwhile is not a stopped claim, then `stopped`; since the next subsection the CLI
exits at the deadline instead of staying alive for the request); systemd resolving by absence only
after the queued job ended; launchd staying unresolved after a failed `kickstart` (a `start` ran it then; now the owner removes the record); and controls
for a coordinator that never ran (`not-managed`, as before) and for a start the tool refused (no record left).

| Run | Command | Result |
| --- | --- | --- |
| Baseline `0651d81` (disposable worktree, tests and fixtures copied in unchanged) | `node --test test/coordinator-lifecycle-launch-uncertainty.test.mjs` | 10 tests, 4 pass (controls), 6 fail: in the process-death cases the separate-process `stop` answered `failed` / `not-managed` ("nothing to stop") instead of `completion-unknown`; in the other cases no launch attempt record existed |
| Fixed code | same command | 10 tests, 10 pass |

Other checks on the fixed code (macOS host, Node v22.22.3): `npm run check` exit 0; `npm run build:extension` exit 0;
`node --test --test-concurrency=1 test/*.test.mjs`: 1350 tests, 1350 pass. Under the default parallel `npm test` an
unrelated test failed in some runs (different tests each time, including runs that excluded the new file, and one
of three runs on the unmodified `HEAD`: for example "Invalid coordinator access key" while reading a token, a drain
record `requested` instead of `drain-failed`); each passed when run alone and in the serial run. They are not
attributed to this change and are unresolved.

### The command's lifetime is bound by its deadline and Ctrl-C

Evidence label: **subprocess, synthetic native tool** (mocked manager), same harness as the previous subsection. Not
launchd or systemd evidence; **real-manager check: pending.**

Defect: the overall `--timeout` and Ctrl-C bounded when the result was printed, not how long the process lived. Native
tool calls ran under their own 15 second timeout (`execFile`) that neither the remaining budget nor Ctrl-C reached, so a
slow `launchctl`/`systemctl` kept the process alive well past the requested deadline, and Ctrl-C waited for the tool.

Correction (`src/coordinator/native/types.ts`, `lifecycle-start.ts`, `lifecycle-stop.ts`, both adapters): each lifecycle
command runs inside a command budget (its deadline and abort signal) that `createExecFileRunner` reads for every native
tool call, including calls of work the command gave up on. No tool starts once the budget is spent. A tool still
running at the deadline or on Ctrl-C has its own client ended (`SIGTERM`, then `SIGKILL` after 250 ms; the runner stops
waiting after 500 ms); only that client is signalled, never the coordinator, the supervisor or a process the manager
started. The one exception is the start request (`kickstart`, `systemctl start`): its client is left running and
detached, because ending it could drop a request the manager has not received, and the durable launch attempt record
from the previous subsection is what keeps `stop` from claiming a stopped state while it is unresolved. A late
installation tool call therefore cannot write the definition or turn into a start after the command ended. No flag,
result field or error code was added.

Regression file: `test/coordinator-lifecycle-process-exit.test.mjs` (22 cases, both managers), each lifecycle command in
its own process with the production runner and one exact JSON document on stdout. A tool call is delayed 4 s (what the
earlier code waited for) and `--timeout 1` is used; a command passes within `1000 ms + 1500 ms` tolerance (process
start, termination grace, scheduling noise), which is more than a second below the delayed call. Ctrl-C cases must end
within 1500 ms of the signal. Further cases: a first tool call and an installation call released after a timeout or
Ctrl-C never write the definition or start the service, and the definition does not change after the first command
exited or behind a second lifecycle command (sampled every 10 ms); an already-issued start followed by a timeout or
Ctrl-C ends the command with `startup-not-confirmed`, leaves the request running with no signal sent, keeps the
`dispatching` record, makes a separate `stop` answer `completion-unknown`, and resolves to `stopped` once the request is
released. In every case the synthetic tool saw no stop, kill, restart, disable or removal verb and no signal reached the
coordinator or its supervisor.
`test/coordinator-lifecycle-launch-uncertainty.test.mjs` had one case that asserted the old behavior (the invoking
command staying alive after its deadline to learn the request outcome); it now asserts that the command has exited, the
request is untouched and the record stays `dispatching` until an observation resolves it.

Measured exit times (macOS host, one run each; the baseline is a disposable copy of `0651d81` outside the repository
with the new test and the harness fixtures copied in unchanged; the same cases measured the same on the parent commit):

| Case (both managers) | Baseline | Fixed | Limit |
| --- | --- | --- | --- |
| start, installation tool delayed 4 s, `--timeout 1` | 4.4 s | 1.06-1.07 s | 2.5 s |
| start, manager inspection delayed 4 s, `--timeout 1` | 4.4 s | 1.06 s | 2.5 s |
| stop, manager inspection delayed 4 s, `--timeout 1` | 4.1-4.2 s | 1.06 s | 2.5 s |
| start, Ctrl-C during the installation tool | 15.0 s after the signal | 6 ms after the signal | 1.5 s |
| stop, Ctrl-C during manager inspection | 14.9-15.0 s after the signal | 6-7 ms after the signal | 1.5 s |
| start, issued start request, `--timeout 1` | not measured | 1.06 s | 2.5 s |
| start, issued start request, Ctrl-C | not measured | 4-6 ms after the signal | 1.5 s |

Baseline run of the first five rows: 10 tests, 0 pass, 10 fail. Fixed code: 22 of 22 pass.

### Empty Linux journals: `logs` reports unavailable logs

Evidence label: **unit level, synthetic `journalctl`** (a scripted child process through the spawn seam, and a real
executable that mimics `journalctl`) run on a macOS host. Not a real journal. **Linux installed-package evidence:
pending** until the installed suite runs on a Linux host; the consumer and global lifecycle cases that expect an unused
state directory to produce no logs are the ones to watch.

Defect: a finite `coordinator logs` read on Linux forwarded the `-- No entries --` line that `journalctl` prints for an
empty selection and exited 0, while the unavailable-log contract (also used on macOS) is exit 1, empty stdout and a
"no logs" message on stderr.

Correction (`src/coordinator/lifecycle-logs.ts`): a finite read adds `--quiet`, and a successful exit that produced zero
output bytes is an empty read. It does not match localized text, so an entry containing the old status text is an
ordinary entry. `--follow` is unchanged (no `--quiet`, no empty rule). Source for the option: systemd v255,
`man/journalctl.xml` documents `-q`/`--quiet` as suppressing informational messages, and `src/journal/journalctl.c`
prints the status line only under `if (n_shown == 0 && !arg_quiet)`. The same source (`src/shared/journal-util.c`,
`journal_access_check_and_warn`) logs "No journal files were opened due to insufficient permissions." without
consulting `quiet` and returns an error, so denied access remains a nonzero exit with a diagnostic rather than an empty
read. Both were read from the v255 tag upstream; a real `journalctl --quiet` run is part of the pending Linux evidence.

Regression file: `test/coordinator-journal-logs.test.mjs` (15 cases) runs the production `lifecycleCommandMain('logs')`
with `platform: 'linux'`: empty read (exit 1, empty stdout, stderr names the unit and contains "no logs", argv recorded,
no state created); empty chunks only; nonempty read; an entry containing `-- No entries --`, and a line that is exactly
that text; output split mid-word, inside a two-byte character and before the last byte; one byte without a line break;
output after an initial empty chunk; nonzero exit, nonzero exit after partial output and death by signal; denied access;
missing and unrunnable `journalctl`; unit filtering for two state directories without consulting the service manager;
`--follow` waiting with no entries, printing a later entry, then Ctrl-C exiting 130 with `SIGTERM` sent only to the one
reader and no second reader; Ctrl-C before any entry; and two cases with a real executable that prints the status line
unless given `--quiet`. `test/coordinator-stop-logs.test.mjs` had one argument assertion updated for `--quiet`.

Baseline: a disposable `git archive 0651d81` build (`npm ci --ignore-scripts`, `npm run build`) given the new file
unchanged: 15 tests, 11 pass, 4 fail. The empty-result cases fail on the unchanged assertion (`0 !== 1`: exit 0 instead
of 1), as does the real-executable empty case; the fourth failure is the argument check that expects `--quiet`.
The cases for nonempty output, the old status text inside an entry, chunk boundaries, reader failures, missing and denied
access and `--follow` pass on both builds, so they guard against regressions. Corrected code: 15 of 15 pass.

Checks on the corrected code (macOS arm64, Node v22.22.3, npm 10.9.8): `node --test` on the new file,
`test/coordinator-stop-logs.test.mjs` and `test/coordinator-lifecycle-cli.test.mjs`: 61 of 61; `npm run check`,
`npm run build:extension` exit 0; `npm test`: 1387 of 1387; `npm run test:package`: 22 of 22.

### Linux installed package: the extraneous `msgpackr-extract` platform package

Evidence label: **real Linux, installed tarball** (Lima VM `heimdall-lc-d7432164`, ordinary `npm install <tarball>` and
`npm install --global --prefix`, no overrides, links or flags), plus a macOS comparison. The 22 new tree controls use
synthetic `node_modules` trees checked with the real `npm ls`.

| Item | Linux VM | macOS host |
| --- | --- | --- |
| OS | Ubuntu 24.04.5 LTS, Linux 6.8.0-142-generic aarch64 (glibc) | macOS 27.0.1, arm64 |
| Hypervisor | Lima 2.2.1, `vz`, template `ubuntu-24.04`, `--mount-none`, 2 CPUs, 3 GiB, 12 GiB; instance `heimdall-lc-d7432164` (left running for the native checks) | not applicable |
| Service manager | systemd 255 (255.4-1ubuntu8.17); `systemctl --user show-environment` works (`XDG_RUNTIME_DIR=/run/user/501`, user bus); `is-system-running`: `running` | not exercised here |
| Linger | the template enabled it; `Linger=no` set inside the VM, still `no` after the runs | not applicable |
| Node.js / npm | v22.19.0 / 10.9.3 and v24.21.0 / 11.19.0 (official linux-arm64 tarballs, SHA-256 checked, under the VM user's home) | v22.22.3 / 10.9.8 |
| C compiler | none (`gcc` not installed) | Xcode toolchain |
| Source | `git archive 1277c23` plus the three package test files of the fix, in a throwaway git repository with a fixture identity and signing disabled | the managed checkout |

**Symptom.** On Linux, `npm install <tarball>` exits 0 (283 packages) and `npm ls --all` exits 0, but the tree starts
with `├── @msgpackr-extract/msgpackr-extract-linux-arm64@3.0.4 extraneous`. `npm ls --all --json` has
`problems: ["extraneous: @msgpackr-extract/msgpackr-extract-linux-arm64@3.0.4 …/node_modules/@msgpackr-extract/msgpackr-extract-linux-arm64"]`
and `npm explain` reports the package as `extraneous`. The test rejected it through its text match, not through npm's
exit status. The global install on npm 10.9.3 is not flagged; the platform package sits under the package's own
`node_modules`.

**Captured evidence (Node v22.19.0, npm 10.9.3, consumer install).**

- The installed manifests: `msgpackr@2.1.0` declares `optionalDependencies: {"msgpackr-extract": "^3.0.4"}`; the platform
  package is `@msgpackr-extract/msgpackr-extract-linux-arm64@3.0.4` with `os: ["linux"]`, `cpu: ["arm64"]` and no scripts.
  `msgpackr-extract`, `node-gyp-build-optional-packages` and `detect-libc` are **not installed**; `npm explain
  msgpackr-extract` finds nothing, and `npm ls` shows `UNMET OPTIONAL DEPENDENCY msgpackr-extract@^3.0.4` under
  `msgpackr`.
- `node_modules/.package-lock.json` has an entry for the platform package (`"optional": true`, same `os`/`cpu`) and none
  for `msgpackr-extract`. Ancestry in the shipped graph: `@opencode/plugin` → `effect` → `msgpackr` (dependency) →
  `msgpackr-extract` (optional) → `@msgpackr-extract/msgpackr-extract-<os>-<cpu>` (optional, platform restricted).
- The npm debug log of the same install: `placeDep` places `msgpackr-extract@3.0.4` and all six platform packages; the
  five platform packages for other platforms are marked `reify failed optional dependency` and deleted; then
  `info run msgpackr-extract@3.0.4 install … { code: 1 }` is followed by `reify mark deleted` for `msgpackr-extract`,
  `node-gyp-build-optional-packages` and `detect-libc`. The linux-arm64 package is **not** among the deleted paths.
- Running the install script in the foreground (`--foreground-scripts`, diagnosis only): the prebuild test
  (`node-gyp-build-optional-packages`) cannot load a native build and throws, then the fallback `node-gyp rebuild`
  stops with `/bin/sh: 1: gcc: not found`, so the script exits 1. The reason no prebuild is usable: the registry tarball `@msgpackr-extract/msgpackr-extract-linux-arm64@3.0.4` contains only
  `node.abi115.musl.node` and `node.napi.musl.node` (like `…-linux-arm`), while `…-linux-x64@3.0.4` also ships the
  `glibc` builds. `msgpackr-extract@3.0.4` is the latest version of the package.
- Runtime: `import('@open-heimdall/core')` and `import('effect')` load; `require('msgpackr-extract')` from `msgpackr` is
  `MODULE_NOT_FOUND`; `msgpackr` packs and unpacks (`{"a":1,"b":[1,2,3]}` and 50 records) in its JavaScript path, which
  `node_modules/msgpackr/node-index.js` takes when the optional `require('msgpackr-extract')` throws.

**Comparison.**

| Run | Install script of `msgpackr-extract` | Result in the consumer tree |
| --- | --- | --- |
| Linux, Node 22.19.0, npm 10.9.3 | exit 1 (no glibc prebuild for arm64, no compiler) | `msgpackr-extract` removed, platform package kept; `npm ls` marks it `extraneous` |
| Linux, Node 24.21.0, npm 11.19.0 | exit 1, same cause | `msgpackr-extract` **and** the platform package removed; `npm ls` clean, no `@msgpackr-extract` directory |
| macOS, Node 22.22.3, npm 10.9.8 | succeeds (darwin-arm64 prebuild) | `msgpackr-extract` installed, native accelerator loaded, `npm ls` clean |

**Root cause: an npm installation artifact, not a packaging graph defect.** The package's graph is the upstream one
(`msgpackr` lists `msgpackr-extract` as optional); nothing in `@open-heimdall/core`'s manifest or lockfile is
mis-declared, and an unbuildable optional native module is a supported outcome for npm. The leftover comes from how npm
10 cleans up after the failed optional install. `@npmcli/arborist` 8.0.1 (bundled with npm 10.9.3),
`lib/optional-set.js`, ends with `return gatherDepSet(set, edge => !edge.optional)`: the set of nodes removed with a
failed optional package follows only non-optional edges, so the package's own optional dependencies (the platform
packages that survived the platform filter) stay on disk without a parent. `@npmcli/arborist` 9.9.1 (npm 11.19.0)
ends with `gatherDepSet(set, edge => !set.has(edge.to) && !edge.from?.inert)` and removes them. The change is upstream
[npm/cli#8537](https://github.com/npm/cli/pull/8537) "fix: optional set calculation" (commit `13d8df64e`, merged
2025-09-29, first contained in npm v11.6.2 / arborist v9.1.6; found with `git tag --contains` on a clone of
`npm/cli`). npm's report is accurate for the disk state: the package really has no parent. The host-dependent part
is the failed install script: hosts with a glibc arm64 runtime and no compiler hit it; x64 glibc (platform package
ships glibc builds) and macOS do not, which is why only this environment failed.

**Not changed:** `package.json`, `package-lock.json` and the published dependency graph. A dependency or lockfile change
cannot make `msgpackr-extract` installable on glibc arm64 without a compiler, and the consumer must stay an ordinary
`npm install <tarball>`.

**Rule change** (`test/package/helpers.mjs` `verifyDependencyTree`, used by
`resolves one supported @opencode/plugin and no quota package dependency` for the consumer and global installs). The
rule still requires `npm ls --all` to exit 0 with no `invalid`, `extraneous` or `UNMET DEPENDENCY` line, exactly the
supported `@opencode/plugin` version in every copy and no `@slkiser/opencode-quota` copy. It makes one exception: an
`extraneous` line is accepted only when every condition holds for that package: (1) the checkout's `package-lock.json`
marks it optional and lists it in `optionalDependencies` of a package that is itself optional; (2) that optional parent
is declared in `optionalDependencies` of an installed package and is not installed; (3) the leftover's manifest has `os`
and `cpu` lists that include this host. A new case, `msgpackr loads and round-trips with or without its optional native
accelerator`, runs the installed `msgpackr` (consumer and global) and checks that a missing accelerator is
`MODULE_NOT_FOUND`, not a broken load, and that pack/unpack round-trips.

**Negative controls** (`test/package/tree-validation.test.mjs`, 22 cases; synthetic trees, real `npm ls`, so the same
on every platform): a complete tree is accepted; the host platform package left without its failed parent is reported
`extraneous` by npm and accepted; and each of these is rejected: the leftover next to an unrelated extraneous package; no
installed package declaring the optional parent; the lockfile not declaring the leftover, its declaring package not
optional or the leftover not optional; a missing, foreign-host or absent `os`/`cpu` restriction; a look-alike package in
the same scope; a platform package that does not satisfy its installed parent (`invalid`); an unrelated extraneous
package; a missing required dependency; an invalid required dependency version; a missing required peer; an invalid
required peer version; an unsupported `@opencode/plugin` version both when npm accepts the range and when it reports it
invalid; a missing `@opencode/plugin`; a nested second `@opencode/plugin` copy at another version; a declared runtime
dependency on the quota package; and an undeclared installed quota package. Mutation checks on the rule (restored
afterwards): accepting any `extraneous` line fails 9 controls; ignoring the exit status fails 2; dropping the plugin
version check fails 3; dropping the quota check fails 2; dropping the `os` check fails 1.

**Results.**

| Where | Command | Result |
| --- | --- | --- |
| Linux VM, Node 22.19.0 / npm 10.9.3, before the fix | `npm run test:package` | 22 tests, 21 pass, 1 fail (the consumer `npm ls` case, `extraneous`); the two unused-state `coordinator logs` cases pass with the journal fix |
| Linux VM, Node 22.19.0 / npm 10.9.3 | `npm run test:package` | 46 tests, 46 pass, 0 fail, 0 skipped (22 original, 2 new `msgpackr` cases, 22 controls) |
| Linux VM, Node 24.21.0 / npm 11.19.0 | `npm run test:package` | 46 tests, 46 pass, 0 fail, 0 skipped |
| Linux VM, Node 22.19.0 | `node --test --test-concurrency=1 test/setup-*.test.mjs test/doctor*.test.mjs test/runtime-identity*.test.mjs` | 253 tests, 253 pass, 0 fail, 0 skipped |
| Linux VM, Node 24.21.0 | same command | 253 tests, 253 pass, 0 fail, 0 skipped |
| macOS host, Node 22.22.3 / npm 10.9.8 | `npm run test:package` | 46 tests, 46 pass, 0 fail, 0 skipped |

The two lifecycle cases that expect an unused state directory to produce no logs (`coordinator logs` exit 1, empty
stdout, stderr `/no logs/i`, inside the consumer and global lifecycle tests) pass on both Node versions with their
assertions unchanged. One earlier run of the Node 24 setup/doctor set in the VM exceeded its time budget while the host
was suspended and reported timing assertions as failures; it was repeated unchanged afterwards and passed (253 of 253).
Not run here: the GitHub-hosted jobs. The real-systemd lifecycle checks are recorded in the next subsection.

### Real-native checks: delayed shutdown on launchd and systemd, and the foreign unit link under systemd

Evidence label: **real-native**. Everything below ran against the real launchd (`gui/<uid>`) of the macOS host and the
real systemd user manager of the Linux VM; no stand-in manager is involved. It is kept apart from the
**controlled-runner** evidence (mocked `launchctl`/`systemctl`, subsections above) and from the **upstream-source**
citations (systemd v255 sources, quoted only where a subsection says so).

| Item | Value |
| --- | --- |
| Code | `bcd1296` on top of `0651d81` (test code only; no product change) |
| macOS host | Darwin arm64, Node v22.22.3, npm 10.9.8, real launchd |
| Linux VM | Lima `heimdall-lc-d7432164`, Ubuntu 24.04.5 aarch64, systemd 255.4-1ubuntu8.17, Node 22.19.0 / npm 10.9.3, `Linger=no` before and after |
| Isolation | HOME, XDG state/data/cache, credentials and the OpenChamber directory private to each fixture; on Linux the real `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR` and `DBUS_SESSION_BUS_ADDRESS` stay visible (the user manager reads and writes its own link directory), and only the uniquely derived fixture unit is ever placed there |

Changes to the native suite (`test/native/lifecycle.native.test.mjs`):

- The delayed-shutdown fixture no longer skips on Linux. It runs on both platforms with the shared isolated
  environment. It is a **delayed-shutdown protocol fixture** (`test/fixtures/delayed-drain-entry.mjs` delays one
  shutdown stage by 6 s), not a held-run idle proof.
- Its `stop --timeout 1` runs as the invoking client **process** (`test/fixtures/native-lifecycle-entry.mjs`: the
  production `lifecycleCommandMain`, adapters and native tool, with only the environment and the service entry point
  injected), so the measured time includes process start-up and exit. Limit: 1000 ms budget plus 1500 ms tolerance
  (2500 ms), as in the process-exit tests.
- The manager is queried directly before and after the hurried stop: `systemctl --user show` (`ActiveState`,
  `SubState`, `MainPID`, `InvocationID`, `StateChangeTimestampMonotonic`, `NRestarts`, `FragmentPath`) and
  `launchctl print` (`state`, `pid`, `runs`). Real managers keep no call log, so the absence of a native stop, kill,
  restart or removal is established by identical manager state (same invocation, main PID, state-change time and run
  count), the live process, held ownership, the retained registration and the same instance reported by `/lifecycle`.
- A new Linux-only suite loads the expected user-unit link naming a complete synthetic foreign unit that lives outside
  every unit search path, next to a valid separate owned definition in the fixture state directory, and runs the
  public `start` and `stop` as client processes.

Delayed-shutdown results (macOS launchd; Linux systemd):

| Step | macOS launchd | Linux systemd |
| --- | --- | --- |
| Start | `ready`, owned registration, positive main PID, authenticated `/lifecycle` `running` | same |
| `stop --timeout 1` client process | 1055 ms and 1078 ms in two runs; exit 1, one JSON document, `completion-unknown` (not a success) | 1041 ms and 1043 ms in two runs; same outcome |
| Manager before / after | `state=running pid runs=1` unchanged | `ActiveState=active`, `MainPID`, `InvocationID`, `StateChangeTimestampMonotonic` unchanged, `NRestarts=0` |
| Service during the drain | same PID alive, ownership held | same |
| Self-completed shutdown | record `completed`, `last exit code = 0`, process absent, ownership free | record `completed`, `ExecMainStatus=0`, `Result=success`, `ActiveState=inactive`, process absent, ownership free |
| Later `stop` | `already-stopped`, exit 0 | same |

Foreign-link refusal (Linux, real systemd 255.4):

- The unit was linked with `systemctl --user link <foreign file>` (file name equal to the derived unit name, under the
  fixture directory), then `daemon-reload`. systemd loaded it (`LoadState=loaded`, `ActiveState=inactive`,
  `UnitFileState=linked`).
- **Actual `FragmentPath`:** the expected link, `$XDG_CONFIG_HOME/systemd/user/<unit>`
  (`/home/<user>/.config/systemd/user/heimdall-coordinator-<24 hex>.service`), not the foreign file and not the owned
  definition. This matches the upstream-source statement above that a linked unit keeps the link source as its
  fragment. The link resolves to the foreign file, which differs from the owned definition; the adapter's
  `registrationOwnership` answered `refused` / `registered-elsewhere`.
- Public `start`: exit 1, outcome `conflict`, error `registered-elsewhere` ("... loaded from <link>, which does not
  resolve to <owned definition>").
- Public `stop`: exit 1, outcome `conflict`, error `registered-elsewhere`, "Nothing was requested".
- After each command: identical manager properties, identical link target, foreign and owned file text, the foreign
  unit never started (its marker file was never written), no coordinator endpoint, and no `shutdown-*.json`,
  `instance.json` or `launch-attempt.json` in the state directory. The coordinator was never running in this
  fixture, so "zero shutdown requests" is established by the absent endpoint and records, not by a counter.
- Not run: the same case against the pre-fix code (`0651d81`) under real systemd. The pre-fix behavior is shown only by
  the controlled-runner baseline above.

Full native suite counts (`HEIMDALL_NATIVE_LIFECYCLE=1`):

| Platform | Command | Tests | Pass | Fail | Skipped |
| --- | --- | --- | --- | --- | --- |
| macOS launchd | `npm run test:native` | 16 | 12 | 0 | 4 |
| Linux systemd, Node 22.19.0 | `node --test --test-concurrency=1 test/native/*.test.mjs` | 16 | 14 | 0 | 2 |

Skips (never counted as passes): on macOS the queued-work case (covered by `test/coordinator-service.test.mjs`) and
the three Linux-only foreign-link cases; on Linux the queued-work case and the launchd stopped-definition refresh
(macOS only by design). Both platforms ran the suite twice on code that differed only in the final cleanup step;
counts and timings above are from the final code, the first runs gave the same counts.

Actual-coordinator evidence, separate label (macOS host, fake or controlled manager, synthetic executor holding a run
reservation): `node --test test/coordinator-drain.test.mjs test/coordinator-stop-logs.test.mjs` gave 31 tests, 31
pass, 0 fail, 0 skipped. This is not native-manager evidence.

Cleanup (fixture names only):

| Item | macOS | Linux VM |
| --- | --- | --- |
| Registered label / unit | `launchctl list` shows no `openheimdall` label | `list-units` and `list-unit-files` for `heimdall-coordinator-*`: none |
| Link / definition | no fixture file | no `heimdall` link in `~/.config/systemd/user`; foreign unit, link and owned definition removed |
| Fixture directories, processes | no `/tmp/hn-*`; no fixture process | no `/tmp/hn-*`; no coordinator, `delayed-drain`, `foreign-service` or `sleep 300` process |
| Linger | not applicable | `Linger=no` |

The first Linux run left the manager remembering the crash-test unit as `not-found failed` in memory (nothing loaded,
no file). That record was cleared once by hand with `systemctl --user reset-failed <that unit>`, and the suite's
cleanup now does the same for its own derived unit; the second run left none. The macOS host also runs an unrelated
coordinator from an installed engine directory; it is not a fixture and was not touched. No cleanup is pending.
The VM `heimdall-lc-d7432164` is still running and holds no fixture state.

Hosted CI: `native-lifecycle` already runs `npm run test:native` on `ubuntu-latest` after proving a user manager and
exports the real `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS`, so the workflow needed no change; the hosted job has not
run for this code.

## Historical evidence at `3bfdc76`

The remaining sections record the earlier run. They describe code at `3bfdc76` and are not repeated for the
corrected code, except where the sections above say so. Their status words (Met, PENDING) are as recorded then.

## Historical environment (`3bfdc76`)

Values are measured on the machines that ran the checks, not CI matrix settings.

| Item | macOS host | Linux VM |
| --- | --- | --- |
| Date | 2026-10-12 | 2026-10-12 |
| Verified code | `3bfdc76` (`test(coordinator): add installed-package lifecycle tests and native lifecycle suite`); no source change was needed | same |
| OS | macOS 27.0.1 (Darwin 27.0.0, arm64) | Ubuntu 24.04.5 LTS, Linux 6.8.0 aarch64 |
| Service manager | launchd (`launchctl version`: Darwin Bootstrapper 7.0.0), per-user domain `gui/<uid>` | systemd 255 (255.4-1ubuntu8.17), `systemctl --user`, user bus at `/run/user/<uid>/bus` |
| Node.js / npm | v22.22.3 / 10.9.8 | v22.19.0 (the minimum supported) / 10.9.3 |
| Execution context | ordinary logged-in user, existing GUI login session | ordinary non-root VM user in an SSH login session |
| Linger | not applicable | `Linger=no` before, during and after (see note below) |

Linux VM: Lima 2.2.1, `vz` driver, stock `ubuntu-24.04` template, instance created for this check with no host
mounts, 2 CPUs, 3 GiB memory and a 12 GiB disk; Node.js 22.19.0 from the official tarball. The template
provisions the VM user with linger enabled; it was turned off inside the VM (`loginctl disable-linger`) before any
check so that the linger assertions were meaningful. The user manager stayed available because the
SSH session that drove the checks remained open. The VM was deleted afterwards.

Configured CI coverage, which is **not** a measured result (no hosted run happened): the `installed-package` job
runs `npm run test:package` on `ubuntu-latest` and `macos-latest` with Node.js 22.19.0 and 24, and the
`native-lifecycle` job runs the native suite on `ubuntu-latest` and `macos-latest` with Node.js 22 after checking
that a user manager is usable.

## Historical local checks (`3bfdc76`)

Run on the macOS host above (Node v22.22.3, npm 10.9.8) in the managed checkout, with source identical to the
code the native checks verified (`3bfdc76`); the only later changes are documentation. Each command exited 0.

| Command | Result |
| --- | --- |
| `npm run check` | `tsc --noEmit` clean |
| `npm test` | 1098 tests, 1098 pass, 0 fail, 0 cancelled, 0 skipped |
| `npm run build:extension` | build and quota vendoring succeeded |
| `npm run test:package` | 22 tests, 22 pass, 0 fail, 0 skipped (includes `test/package/lifecycle.test.mjs`) |
| `git diff --check <base>..HEAD` | clean |

The diff against the supplied base touches coordinator lifecycle code, the two native adapters, credential and
output handling, tests, `package.json`, `.github/workflows/test.yml`, `README.md` and the three documentation
pages. It does not touch `AGENTS.md`, any `.heimdall` file or `src/coordinator/status.ts` (the `/status` schema 1
validator), and the existing status tests are unchanged.

## Historical acceptance criteria and evidence (`3bfdc76`)

| # | Criterion | Evidence | Status |
| --- | --- | --- | --- |
| 1 | Installed startup: tarball in an isolated consumer, lifecycle commands outside the checkout, intended authenticated instance, terminal close, duplicate and simultaneous start, configuration precedence and failure cases, empty-state no-op, queued-work admission | Installed-package tests (`test/package/lifecycle.test.mjs`, within 22/22 package tests); real installed-tarball flow 41/41 on both platforms (readiness, duplicate and simultaneous start, terminal hang-up, no project, OpenCode or provider activity with an empty state); configuration precedence, working-directory independence, paths with metacharacters, absent implicit versus explicit configuration, invalid configuration, startup timeout and exited service in `test/coordinator-lifecycle-cli.test.mjs` (fake service manager, real coordinators); queued-work admission in `test/coordinator-service.test.mjs` | Met, with limits. A missing Node.js executable is covered only by launch-context resolution in `test/coordinator-native-launchd.test.mjs`, not by a native start. The terminal check hung up a pseudo-terminal, not a Terminal.app window. |
| 2 | Explicit-only service policy: no registration by install or setup, no login or boot trigger, no linger or restart, inactive definition after stop, later start works, crash not relaunched | Package test asserts install and setup create no definition; generated and loaded launchd and systemd definitions inspected on real managers (`RunAtLoad` and `KeepAlive` false, no triggers; `Type=exec`, `Restart=no`, no `[Install]`, `UnitFileState=linked`, `Linger=no`); clean stop, repeated stop, later start; `SIGKILL` not relaunched through an 8 s window | Met on macOS and on Ubuntu 24.04. No stale-endpoint repair is claimed. |
| 3 | Held-run drain: status draining, admission off, owner persistence usable, capacity held, completed checkpoint is not idle proof, bounded wait without manager stop or kill, shared operation, idle proof then clean exit and completion | `test/coordinator-drain.test.mjs` and `test/coordinator-stop-logs.test.mjs` (actual coordinator with a synthetic reserved run; fake service manager recording calls) | Met by actual-coordinator and fake-adapter tests only. Not run under a real launchd or systemd manager: **PENDING**. |
| 4 | Failure and races: unauthorized and run-owner stop, instance mismatch, drain and close-stage errors, crash after acknowledgement, old protocol, malformed replies, foreground, foreign registration, stale endpoint, start during drain and racing stop, `/status` unchanged | `test/coordinator-lifecycle.test.mjs`, `test/coordinator-drain.test.mjs`, `test/coordinator-stop-logs.test.mjs`, `test/coordinator-lifecycle-cli.test.mjs`, unchanged `test/coordinator-status.test.mjs`; adapter conflicts in the two native adapter test files | Met by automated tests. |
| 5 | CLI and credentials: human, JSON, non-TTY and interrupted paths, exactly one JSON document, no prompts, remembered credential file, rejected files and keys, no sentinel in output, definitions, records or logs, files unchanged | `test/coordinator-lifecycle-cli.test.mjs`, `test/coordinator-credentials.test.mjs`, `test/coordinator-executor.test.mjs`; a pseudo-terminal run confirms no prompt; sentinel scans in the real flows | Met. Authentication against a live OpenCode or OpenChamber was not exercised. |
| 6 | Logs: tail, bounded read, no-log failure, access after stop, follow interruption, private macOS destinations, Linux unit filtering, producer-side sanitizing | `test/coordinator-stop-logs.test.mjs`, `test/coordinator-credentials.test.mjs`; real `logs` after stop on both platforms (macOS private files, Linux journal filtered to the unit) | Met. A real journal `--follow` and large real journals were not exercised. |
| 7 | Real platform evidence on one macOS and one Linux | Sections below: launchd on macOS 27.0.1 and systemd 255 on Ubuntu 24.04.5; registration, readiness, duplicate start, clean stop, later start | Met with an empty state. Delayed drain under a native manager is **PENDING**. |
| 8 | Isolation and cleanup | Cleanup section below; fixture names derived from isolated state; live coordinator untouched | Met. No cleanup is pending. |
| 9 | CI and checks: existing checks and matrix preserved, lifecycle regressions, explicit native route, Linux user manager provisioning | `.github/workflows/test.yml` keeps `baseline`, `macos-harness` and the `installed-package` matrix unchanged and adds the `native-lifecycle` job, which fails rather than skips when no user manager is usable; local checks above | Local checks met. Hosted CI **PENDING**: it was not run, nothing was pushed, and whether `ubuntu-latest` provides a usable user manager is unverified. |

## How the checks are run

Every fixture used its own temporary root: state directory, `HOME`, XDG state/data/cache directories, OpenChamber
data directory, npm cache and prefix. The coordinator configuration declared only `stateDirectory` and
concurrency. The credential file held a synthetic opaque value that was never used for authentication.
Fixture service names come from the production identity logic applied to the isolated state directory:
`dev.openheimdall.coordinator.<24 hex>` on launchd and `heimdall-coordinator-<24 hex>.service` on systemd. Each
differs from the identity of the default state directory. Only `launchctl print` / `systemctl --user show` of
fixture names was used for inspection.

| Layer | What it establishes | Where |
| --- | --- | --- |
| Actual coordinator tests | Instance ownership, authenticated shutdown, held-run drain, close-stage failures and queued-work admission with real coordinators and a synthetic executor | `test/coordinator-drain.test.mjs`, `test/coordinator-lifecycle.test.mjs`, `test/coordinator-service.test.mjs`, `test/coordinator-stop-logs.test.mjs` |
| Mocked adapter tests | Rendered definitions, command sequences, conflict and failure handling with a mock `launchctl`/`systemctl` runner or a fake service manager | `test/coordinator-native-launchd.test.mjs`, `test/coordinator-native-systemd.test.mjs`, `test/coordinator-lifecycle-cli.test.mjs`, `test/coordinator-stop-logs.test.mjs` |
| Installed-package tests | Tarball install, no service registered by install or setup, failures before side effects, rendered definition of the installed entry point | `test/package/lifecycle.test.mjs` |
| Real native checks | The native result sections of this page | `test/native/lifecycle.native.test.mjs` and, for the historical run, the installed-tarball flow |
| Controlled-manager tests | The production adapters and a real coordinator process against a stateful stand-in for `launchctl`/`systemctl`; mocked-manager evidence, not native | `test/fixtures/controlled-native-runner.mjs` with the defect regression files named above |

### Reproduce: native suite

```sh
npm ci --ignore-scripts
npm run build
HEIMDALL_NATIVE_LIFECYCLE=1 node --test --test-concurrency=1 test/native/*.test.mjs
```

Without `HEIMDALL_NATIVE_LIFECYCLE=1` every case is reported as skipped, which is not a pass. With it, a host
without a usable user manager fails the suite, and the cases that are specific to another platform (the launchd
refresh on Linux, the systemd foreign-link cases on macOS) are still reported as skipped.

### Reproduce: Linux VM

```sh
limactl create --name=heimdall-native-check --tty=false --cpus=2 --memory=3 --disk=12 --mount-none template:ubuntu-24.04
limactl start heimdall-native-check
limactl shell heimdall-native-check
# inside the VM, as the ordinary user
loginctl show-user "$(id -u)" --property=Linger          # expect Linger=no; sudo loginctl disable-linger "$(id -u)" for the VM only
systemctl --user show-environment >/dev/null && echo "user manager ok"
# install Node.js >= 22.19 (official tarball under $HOME), then in a source copy
# (a `git archive HEAD` tarball copied with `limactl copy`; run `git init && git add -A && git commit` in it,
# because `npm run test:package` lists files with `git ls-files`):
npm ci --ignore-scripts && npm run build
HEIMDALL_NATIVE_LIFECYCLE=1 node --test --test-concurrency=1 test/native/*.test.mjs
npm run test:package
# afterwards, from the host
limactl stop heimdall-native-check && limactl delete heimdall-native-check
```

### Reproduce: installed-tarball flow

The flow ran from a throwaway harness outside the repository; the equivalent manual steps, in a fresh root
`R` with `HOME=$R/home`, isolated XDG and npm cache variables, `OPENCHAMBER_DATA_DIR=$R/openchamber` and a working
directory outside any checkout:

```sh
node scripts/pack.mjs --out "$R/tarball"
npm install --global --ignore-scripts --prefix "$R/prefix" "$R/tarball/open-heimdall-core-0.0.0.tgz"
printf '[coordinator]\nstateDirectory = "%s"\n' "$R/state" > "$R/coordinator.toml"
printf 'OPENCODE_PASSWORD=synthetic-value\n' > "$R/credentials.env" && chmod 600 "$R/credentials.env"
H="$R/prefix/bin/heimdall"; C="--coordinator-config $R/coordinator.toml"
$H coordinator start --json --env-file "$R/credentials.env" $C      # run three at once for the simultaneous check
$H coordinator status $C
$H coordinator logs --lines 20 $C
$H coordinator stop --json $C
```

On Linux keep the real `XDG_RUNTIME_DIR`, `DBUS_SESSION_BUS_ADDRESS` and `XDG_CONFIG_HOME` visible, because
`systemctl --user link` is performed by the user manager.

## Historical macOS: real launchd (`3bfdc76`)

Native suite: `HEIMDALL_NATIVE_LIFECYCLE=1 node --test test/native/*.test.mjs` gave 11 tests, 10 pass, 0 fail,
1 skipped. The skip is the documented queued-work case, covered by a coordinator test (see above). Installed flow:
41 checks, 41 pass. Both used a fixture such as `dev.openheimdall.coordinator.<24 hex>`.

| Check | Result |
| --- | --- |
| Native registration | Before start: nothing loaded, no state directory, no definition. After start: `launchctl print gui/<uid>/<fixture label>` shows `type = LaunchAgent`, `state = running`, the plist path in the private state directory, and `program`/`arguments` equal to the absolute Node executable and the real path of the installed `dist/cli.js`. `plutil -lint` accepts the plist. |
| Authenticated readiness | `start --json` returned `ready` with `instance.mode = managed`. An independent `GET /lifecycle` over the Unix socket with the coordinator key returned the same instance, `phase = running`, and the label as `manager`. `/status` reported `running`, 0 queued, 0 reserved, accepting. `coordinator status` exited 0. |
| Duplicate and simultaneous start | Three concurrent starts returned one `ready` and two `already-running`, all naming the same instance and pid. A later start returned `already-running`. `ps` showed exactly one `coordinator serve` process for the fixture, and the pid matched `launchctl`. |
| Clean CLI stop | `stop --json` returned `stopped` for that instance (exit 0). The correlated `shutdown-<instance>.json` record had `status = completed`. The process exited, `launchctl print` showed the job not running with `last exit` 0, and the ownership lock was free. |
| Inactive retained definition | After the stop the plist remained, owned and loaded but not running. A repeated `stop` returned `already-stopped`. `logs` still read the private log files. |
| Later explicit start | A new start returned `ready` with a different instance id and pid. |
| Crash not relaunched | `SIGKILL` of the service process: the process stayed gone through an 8 s observation window, `launchctl` reported it not running, the ownership lock was released by the OS, and no clean-shutdown record existed for that instance. The stale endpoint file was left in place; no stale-endpoint repair is claimed. |
| Definition policy | The generated plist contains `RunAtLoad = false` and `KeepAlive = false` and none of `StartInterval`, `StartCalendarInterval`, `WatchPaths`, `QueueDirectories`, `StartOnMount`, `Sockets`, `LaunchEvents`. The full `launchctl print` output of the loaded job contains no keep-alive or run-at-load property. The plist and the log files hold no credential value. |
| Terminal independence | The start command ran in a shell on a pseudo-terminal; once it finished, the terminal was closed (hang-up). The shell was alive before and gone after. From a different process the service was still running under launchd, `status` answered, a second `start` returned `already-running` for the same instance, and `ps` showed no controlling terminal. The user's GUI login session stayed active throughout. Limitation: a pseudo-terminal hang-up is not a closed Terminal.app window. |

Generated definition (sanitized):

```xml
<key>ProgramArguments</key>
<array>
  <string><node executable></string>
  <string><fixture>/prefix/lib/node_modules/@open-heimdall/core/dist/cli.js</string>
  <string>coordinator</string><string>serve</string>
  <string>--coordinator-config</string><string><fixture>/coordinator.toml</string>
  <string>--env-file</string><string><fixture>/credentials.env</string>
</array>
<key>EnvironmentVariables</key>  <!-- HEIMDALL_COORDINATOR_CONFIG_ORIGIN, HEIMDALL_COORDINATOR_MANAGER_LABEL, HOME, OPENCHAMBER_DATA_DIR -->
<key>RunAtLoad</key><false/>
<key>KeepAlive</key><false/>
<key>StandardOutPath</key><string><fixture>/state/logs/coordinator.out.log</string>
<key>StandardErrorPath</key><string><fixture>/state/logs/coordinator.err.log</string>
```

## Historical Linux: real systemd user manager (`3bfdc76`)

Native suite: 11 tests, 10 pass, 0 fail, 1 skipped (same documented case). Installed flow: 41 checks, 41 pass,
Node.js 22.19.0, as an ordinary VM user with a real `systemctl --user` session and bus.

The registration, readiness, duplicate and simultaneous start, clean stop, inactive-definition, later-start,
crash and terminal-independence checks have the same results as on macOS, with these systemd specifics:

| Check | Result |
| --- | --- |
| Native registration | `systemctl --user show <unit>`: `Type=exec`, `Restart=no`, `ActiveState=active`, `SubState=running`, `FragmentPath` in the user manager's configuration directory (the link to the private definition), `WantedBy=` empty, `MainPID` equal to the coordinator-reported pid. |
| No enable, no linger | `UnitFileState=linked`; `systemctl --user is-enabled` printed `linked` (not `enabled`). The unit text has no `[Install]` section. `loginctl` showed `Linger=no` before the start, after the start and at the end of the flow, in both the suite and the flow. No `enable`, `loginctl enable-linger` or `sudo` call was made by the commands under test. |
| Clean stop | `stop` returned `stopped`; the shutdown record was `completed`; the unit went inactive with a clean exit and the ownership lock was free; the unit file link remained. |
| Crash not relaunched | After `SIGKILL` the unit stayed inactive for the 8 s window (`Restart=no`). |
| Terminal independence | The starting pseudo-terminal shell was hung up inside the SSH login session that remained open; the service kept running and answered `status` from another process; `ps` showed no controlling terminal. |
| Logs | `logs` read the unit's journal entries, filtered to that unit, and stayed readable after stop. |

Generated unit (sanitized):

```ini
[Unit]
Description=OpenHeimdall coordinator

[Service]
Type=exec
Restart=no
ExecStart="<node>" "<fixture>/prefix/lib/node_modules/@open-heimdall/core/dist/cli.js" "coordinator" "serve" "--coordinator-config" "<fixture>/coordinator.toml" "--env-file" "<fixture>/credentials.env"
Environment="HEIMDALL_COORDINATOR_CONFIG_ORIGIN=flag" "HEIMDALL_COORDINATOR_MANAGER_LABEL=<unit>" "HOME=<fixture>/home" "OPENCHAMBER_DATA_DIR=<fixture>/openchamber"
StandardOutput=journal
StandardError=journal
```

## Historical installed-tarball flow and empty state (`3bfdc76`)

On both platforms the tarball built by `scripts/pack.mjs` was installed into an isolated global prefix and driven
through its installed `bin` from a working directory outside the checkout; the installed entry point resolved
inside the installation.

- Installing the package created no `*.plist`, `*.service`, `LaunchAgents` or `systemd` entries below the isolated
  `HOME` or prefix, and nothing was registered under the fixture name before the first `start`.
- With an empty state the fixture database held 0 rows in `projects`, `runs`, `worktrees`, `events` and
  `receipts`, `/status` reported 0 queued and 0 reserved runs, and the service process held no TCP or UDP socket
  (`lsof -i` on macOS, `ss` on Linux) when sampled. No project, OpenCode URL or provider was configured, so no
  OpenCode session or provider call was possible from the fixture. This is a sampled absence of sockets plus
  an absence of configuration, not a packet capture.
- Output of `start`, `stop`, `status` and `logs` and the service definitions contained none of the synthetic
  credential value.

## Historical cleanup (`3bfdc76`)

| Fixture | Outcome |
| --- | --- |
| macOS native-suite fixture | Not running at cleanup (crashed instance). `cleanupFixture` unloaded the label and removed the definition; the label was no longer registered and the temporary root was removed. |
| macOS installed-flow fixture | Same as above. |
| Linux native-suite and installed-flow fixtures (VM) | Not running at cleanup. Link and definition removed, user manager reloaded, temporary roots removed. |
| Linux VM | Stopped and deleted as test infrastructure after the evidence was copied out. The downloaded template image remains in the host's Lima cache. |

After the run no fixture label was registered with `launchctl`, no fixture directory remained in the temporary
directory, and no `LaunchAgents` entry for Heimdall existed. Nothing was escalated; no cleanup is pending.

Observation: after the `SIGKILL` case the Linux user manager keeps an in-memory record of the fixture unit as
`not-found failed` until `systemctl --user reset-failed` or a manager restart. The adapter never calls
`reset-failed` by design, so this record is not removed by the fixture cleanup; it is cleared with the VM here.

Live coordinator and default state: the checks never used the default configuration, state directory, label or
unit. The default state directory listing was identical before and after (apart from the live coordinator's own
database files), the live coordinator process was the same process before and after, and no Heimdall launchd
entry existed in the user's domain. All commands ran with an isolated `HOME` and explicit `--coordinator-config`.

## Limits

- The native suites use an empty state. The delayed drain with a held run reservation is established by the
  actual-coordinator tests with a synthetic executor and checked against a fake or controlled service manager. It
  was not run under launchd or systemd with a real held run: **PENDING**. The native delayed-shutdown case (macOS
  and Linux) delays a shutdown stage in a fixture entry point and is not a held-reservation test.
- On Linux there is no native check of the stopped-definition refresh or the stop ordering; those are covered by
  mocked-manager tests, and the native launchd refresh case runs on macOS only. The overall deadline is checked
  natively on both platforms by the delayed-shutdown case (client process time), the foreign-link refusal only under
  systemd.
- At `61847fe` the Linux installed-package tests failed 3 of 22 (npm reports an optional dependency as extraneous;
  `coordinator logs` on an unused state directory exits 0 on Linux). Both causes are corrected after `0651d81`; the
  package suite passes on Linux with Node.js 22.19.0 and 24 (see "Linux installed package: the extraneous
  `msgpackr-extract` platform package"). The hosted `installed-package` job has not run.
- The GitHub-hosted jobs in `.github/workflows/test.yml` (`baseline`, `macos-harness`, `installed-package`,
  `native-lifecycle`) were not run for the corrected code, and whether a hosted Linux runner provides a usable user
  manager is unverified.
- At `01b073f`, Node.js 22.19.0 and 24.21.0 ran the package tests on Linux, and Node.js 22.19.0, 22.22.3 and
  24.21.0 on macOS (see "Final acceptance"). Node.js 26 ran only the credential test file on macOS. Native
  service-manager checks used Node.js 22.
- The Node.js 26 diagnosis is established for the failure mode (handlers installed after the readiness line). A
  flush or `process.exit` problem was not demonstrated and is not claimed.
- A start whose native call was already issued survives the death of its process only through the private launch
  attempt record (see "Launch attempts survive the invoking process"). Real launchd and systemd behavior for these
  races was not exercised, and launchd cannot report a queued start request, so an issued `kickstart` that never
  produced the coordinator stays unresolved until the coordinator appears or the owner removes the record.
- The post-deadline shutdown-request defect and the failing-install variant of the abandoned-start defect did not
  reproduce as runtime failures; they are covered by invariant tests only.
- Windows is unsupported and was not exercised.
- Closing the terminal was exercised by hanging up a pseudo-terminal, with another login session active; a
  logout of the last login session on Linux with linger disabled was not tested.
- One macOS and one Ubuntu release on arm64 only.
