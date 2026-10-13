# Coordinator lifecycle validation

Evidence for `heimdall coordinator start`, `stop` and `logs` and the native user-service adapters.

**Status (draft): the native lifecycle suite and an installed-tarball lifecycle flow PASSED against a real
launchd user domain (macOS) and a real systemd user manager (Ubuntu VM). Not yet recorded here: the
GitHub-hosted `native-lifecycle` CI job (configured, not run), Node.js 24, Windows, and any native run with a
held run (delayed drain). Native checks used an empty coordinator state, no project, no OpenCode server and no agent.**

Nothing in this record shows that a run can execute under a native service. A user's real OpenCode or
OpenChamber installation, provider accounts and quota were not involved.

## Environment

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

## How the checks were run

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
| Real native checks | Everything below on this page | `test/native/lifecycle.native.test.mjs` and the installed-tarball flow |

### Reproduce: native suite

```sh
npm ci --ignore-scripts
npm run build
HEIMDALL_NATIVE_LIFECYCLE=1 node --test --test-concurrency=1 test/native/*.test.mjs
```

Without `HEIMDALL_NATIVE_LIFECYCLE=1` all 11 cases are reported as skipped, which is not a pass. With it, a host
without a usable user manager fails the suite.

### Reproduce: Linux VM

```sh
limactl create --name=heimdall-native-check --tty=false --cpus=2 --memory=3 --disk=12 --mount-none template:ubuntu-24.04
limactl start heimdall-native-check
limactl shell heimdall-native-check
# inside the VM, as the ordinary user
loginctl show-user "$(id -u)" --property=Linger          # expect Linger=no; sudo loginctl disable-linger "$(id -u)" for the VM only
systemctl --user show-environment >/dev/null && echo "user manager ok"
# install Node.js >= 22.19 (official tarball under $HOME), then in a source copy:
npm ci --ignore-scripts && npm run build
HEIMDALL_NATIVE_LIFECYCLE=1 node --test --test-concurrency=1 test/native/*.test.mjs
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

## macOS: real launchd

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

## Linux: real systemd user manager

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

## Installed-tarball flow and empty state

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

## Cleanup

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

- The native suite and the flow use an empty state. The delayed drain with a held run is established by the
  actual-coordinator tests with a synthetic executor and checked against a fake service manager; it was not run
  under launchd or systemd.
- The GitHub-hosted `native-lifecycle` job in `.github/workflows/test.yml` was not run, and whether a hosted
  Linux runner provides a usable user manager is unverified.
- macOS ran Node.js 22.22.3 and Linux ran 22.19.0; Node.js 24 was not exercised natively.
- Closing the terminal was exercised by hanging up a pseudo-terminal, with another login session active; a
  logout of the last login session on Linux with linger disabled was not tested.
- One macOS and one Ubuntu release on arm64 only.
