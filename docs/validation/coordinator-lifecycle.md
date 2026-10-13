# Coordinator lifecycle validation

Evidence for `heimdall coordinator start`, `stop` and `logs` and the native user-service adapters.

**Status: this page holds two separate bodies of evidence.**

1. **Corrected code, `61847fe`** (next section). Local checks and the native lifecycle suite on a real launchd
   user domain (macOS) pass. The native suite on a real systemd user manager (Ubuntu 24.04 VM) passes with 10
   passing and 3 skipped cases (none of them native Linux checks of the corrected behavior). On Linux, the
   installed-package tests fail 3 of 22 (the same 3 as at the base commit `e5c6fbc`, so not caused by the corrected
   code), and nothing in this work makes them pass. PENDING: the GitHub-hosted CI jobs (configured, not run), a
   held-reservation drain under a native manager, a native systemd check of the stopped-definition refresh and of
   the deadline cases, and Windows (unsupported).
2. **Earlier evidence, `3bfdc76`** (sections headed "Historical"). Kept as recorded, attributed to the code it was
   gathered on. It is not evidence for the corrected code.

Nothing in this record shows that a run can execute under a native service. A user's real OpenCode or
OpenChamber installation, provider accounts and quota were not involved.

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
| `test/package/install.test.mjs`: `resolves one supported @opencode/plugin and no quota package dependency` | `npm ls` (npm 10.9.3) in the consumer reports `@msgpackr-extract/msgpackr-extract-linux-arm64@3.0.4 extraneous`, which the test rejects. Cause not investigated further. |
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
link source as its `FragmentPath`. The reported fragment can therefore be the expected link. **Real-manager check:
pending.** The foreign-link refusal has not been run under a real systemd user manager; that check belongs to the
later real-native task, and the actual `FragmentPath` is not recorded here.

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
explicit `start` replaces an unresolved record. No flag, result field or error code was added.

Regression file: `test/coordinator-lifecycle-launch-uncertainty.test.mjs` (10 cases, both managers). With the start
held on the gate: the invoking CLI is killed with `SIGKILL`; a separate-process `stop` (twice) does not report
`stopped` or `already-stopped`, the record stays unchanged, the synthetic tool saw no violation and no signal; the gate
is released, the coordinator launches, `stop` reports `stopped` and the record is gone; a later `stop` reports
`already-stopped` and a later explicit `start` reaches `ready`. Also: the invoking CLI reaching its deadline
(`startup-not-confirmed`, a `stop` meanwhile is not a stopped claim, then `stopped`; since the next subsection the CLI
exits at the deadline instead of staying alive for the request); systemd resolving by absence only
after the queued job ended; launchd staying unresolved after a failed `kickstart` until a `start` is run; and controls
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
refresh and the delayed-drain fixture on Linux) are still reported as skipped.

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
  was not run under launchd or systemd with a real held run: **PENDING**. The native delayed-drain case on macOS
  delays a shutdown stage in a fixture entry point and is not a held-reservation test.
- On Linux there is no native check of the stopped-definition refresh, the overall deadline or the stop ordering;
  those are covered by mocked-manager tests, and the native refresh and delayed-drain cases run on macOS only.
- The Linux installed-package tests fail 3 of 22 on the corrected code and on `e5c6fbc` alike (npm reports an
  optional dependency as extraneous; `coordinator logs` on an unused state directory exits 0 on Linux). They are
  unresolved. The package tests were not run on Linux with Node.js 24.
- The GitHub-hosted jobs in `.github/workflows/test.yml` (`baseline`, `macos-harness`, `installed-package`,
  `native-lifecycle`) were not run for the corrected code, and whether a hosted Linux runner provides a usable user
  manager is unverified.
- Node.js 22.19.0 ran on Linux only. Node.js 24 ran the package tests on macOS only, and Node.js 26 ran only the
  credential test file on macOS. Native service-manager checks used Node.js 22.
- The Node.js 26 diagnosis is established for the failure mode (handlers installed after the readiness line). A
  flush or `process.exit` problem was not demonstrated and is not claimed.
- A start whose native call was already issued survives the death of its process only through the private launch
  attempt record (see "Launch attempts survive the invoking process"). Real launchd and systemd behavior for these
  races was not exercised, and launchd cannot report a queued start request, so an issued `kickstart` that never
  produced the coordinator stays unresolved until a `start` is run again.
- The post-deadline shutdown-request defect and the failing-install variant of the abandoned-start defect did not
  reproduce as runtime failures; they are covered by invariant tests only.
- Windows is unsupported and was not exercised.
- Closing the terminal was exercised by hanging up a pseudo-terminal, with another login session active; a
  logout of the last login session on Linux with linger disabled was not tested.
- One macOS and one Ubuntu release on arm64 only.
