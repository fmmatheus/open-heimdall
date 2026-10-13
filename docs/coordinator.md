# Global coordinator development

The opt-in coordinator registers local Git projects, queues feature runs, and
claims global/per-project capacity in SQLite. Each run gets a new locked Git
worktree and branch at its submitted base commit. The established runner plans
and executes tasks sequentially; OpenCode owns all agent and tool execution.

This is a development interface, tested with temporary repositories and mocked
OpenCode APIs. Live evidence is limited to the records under `docs/validation/`
and the [Remaining limits](#remaining-limits). Registration only reads the
selected project; submission creates managed worktrees and adds their Git
registry entries.

## Setup

Install the package from a tarball and create the configuration with
`heimdall setup` as described in [Installation and setup](installation.md), using
Node.js 22.19 or newer; `heimdall doctor` checks the result. Use a separate
development Git project with a valid [project configuration](../examples/heimdall.toml)
(the file `heimdall setup` writes, or one you edit yourself). Set its
existing local OpenCode **2.0.22** connection URL. For OpenChamber Desktop, use
its local HTTP port and set `authentication = "openchamber"` in `[opencode]`.
Heimdall uses Desktop's existing client token from
`~/.config/openchamber/settings.json` (or `OPENCHAMBER_DATA_DIR`), verifies the
selected port matches, and keeps the token out of project/run configuration.
For a direct OpenCode server, provide the configured password in the coordinator's
environment. Provider credentials remain in OpenCode.

For an explicitly passwordless loopback server, set
`authentication = "none"` in `[opencode]`. This omits authorization and does not
read the password environment variable. Basic authentication remains the default.
OpenCode 2.0.22's standard CLI generates a password; its embedded fetch server
supports passwordless operation. Starting a second server on an existing native
database can resume its unfinished sessions, so validation must keep execution
state separate from running workflows.

`heimdall setup` creates the coordinator configuration in a private directory; the
[coordinator.toml](../examples/coordinator.toml) example lists its settings.
Limits default to one global run and one run per project when omitted.
An explicit project `--limit` overrides the registration default. Limits count
whole admitted runs, including uncertain execution, rather than individual tasks.

Start the coordinator in the background and confirm it is ready; see
[Background service](#background-service-start-stop-and-logs) for what that
confirms and how to stop it:

```sh
heimdall coordinator start --coordinator-config /path/to/coordinator.toml
heimdall coordinator status --coordinator-config /path/to/coordinator.toml
```

To keep the coordinator in the foreground of a terminal instead, for example to
troubleshoot, run `heimdall coordinator serve --coordinator-config /path/to/coordinator.toml`
and stop it with Ctrl-C ([Foreground operation](#foreground-operation-and-troubleshooting)).

With the coordinator running, using the same coordinator configuration:

```sh
node dist/cli.js coordinator project add /path/to/development-project --limit 2
node dist/cli.js coordinator project list
node dist/cli.js coordinator run submit PROJECT_ID --feature /path/to/feature.md
node dist/cli.js coordinator run list
node dist/cli.js coordinator run show RUN_ID
node dist/cli.js coordinator events --after 0
```

All commands accept `--coordinator-config`; alternatively set
`HEIMDALL_COORDINATOR_CONFIG`. Without either, configuration is read from
`~/.config/heimdall/coordinator.toml`. Paths in that file resolve against its
directory. Default state is `~/.local/state/heimdall` on Unix and
`LOCALAPPDATA/Heimdall` on Windows. Unix state/key/socket permissions are private;
both IPC transports require an access capability. Windows uses a named pipe and
the state directory's inherited user permissions; native Windows operation has
not been tested yet.

Projects use their canonical common Git directory as identity, so linked
worktrees cannot bypass the per-project limit. Duplicate registration must match
the stored source, configuration and limit. Initial limits are persisted;
editing registered limits is a deferred interface, and a conflicting global
limit fails startup rather than silently changing admission policy.

## Submission and execution

Submission snapshots feature text, workflow settings/prompts and the current
base commit. `--base REF` selects another commit/ref. Dirty and untracked source
changes are not copied. Model/usage settings are fixed for this run; later
configuration edits affect new submissions.

Managed checkouts live under `STATE/worktrees/PROJECT_ID/RUN_ID/checkout` on
`heimdall/run/RUN_ID`. Runtime assets are written exclusively there, using this
package's proven roles and pinned adapter. Tracked `.heimdall` assets, OpenCode
plugins, or conflicting role files are rejected before queueing. Original files
are never overwritten, installed into, or reloaded. No branch reset, worktree
cleanup or automatic reuse is performed; completed and failed worktrees remain
available for inspection.

The coordinator creates a real parent session in the new worktree with the
configured planner model. Its only exposed tool is `adr_workflow`. Native
subagents still execute through the real parent tool context. Persisted native
session/message IDs, immutable start binding, single-use resume claims, owner
fences and durable attempt receipts prevent replay from starting duplicate work.

Managed checkpoints and receipts are authoritative in SQLite. Planning files,
facts, task ledgers and diagnostic replies remain in the managed checkout.
OpenCode retains session/message storage. Standalone (non-managed) runs keep
their file-backed checkpoints and explicit recovery interface; the coordinator
does not migrate them.

## Lifecycle and recovery

The coordinator uses `queued → preparing → running`, followed by
`paused`, `succeeded`, `failed`, or `reconciliation-required`. A resumed run
queues again, preserving its worktree and parent but receiving a new owner fence
and prompt ID. Tasks advance only after their completion evidence is admitted.

Capacity is released only after complete native parent/child observations prove
idle execution, or an atomic record proves preparation never reached native
launch intent. Failed/unknown API calls, interrupted launches and coordinator
restarts retain reservations. There are no expiring leases or heartbeat-based
takeovers. Event history records admission, state, attempts and usage totals;
`events` returns up to 500 entries after its cursor.

```sh
node dist/cli.js coordinator run reconcile RUN_ID
node dist/cli.js coordinator run resume RUN_ID --input "Owner's resolution"
```

Reconciliation observes existing execution and never resubmits a prompt. Resume
requires an idle paused checkpoint and an explicit resolution. Ambiguous child
creation, unfinished checkpoints or stale local locks still need manual
inspection; this version does not guess or repair them. Existing IPC endpoints
are never replaced automatically.

A drain stops new admission and keeps the checkpoint connection open for managed
runs. It begins on `heimdall coordinator stop`, or on SIGINT/SIGTERM to a
foreground coordinator, and both share one operation. Unresolved execution can
keep draining open until reconciled. Abrupt process loss can interrupt checkpoint
writes; reservations remain held for inspection after restart.

Runs can also be watched and reviewed read-only from OpenChamber 2.1.0; see the
[OpenChamber extension guide](openchamber-extension.md).

## Background service: start, stop and logs

`start`, `stop` and `logs` run one coordinator per state directory as a native
user service and drain it safely. Starting is always an explicit command:
installing the package, running `heimdall setup`, logging in or rebooting never
starts the coordinator, and Heimdall never installs a login or boot trigger,
enables linger, or adds automatic restart.

### Installed-package flow

```sh
heimdall setup           # once; see Installation and setup
heimdall doctor
heimdall coordinator start
heimdall coordinator status
heimdall coordinator logs
heimdall coordinator stop
```

The commands never prompt, including in a terminal. Human results are short;
progress and diagnostics go to stderr. Installation and `setup` register nothing
with launchd or systemd: the service definition is created by the first `start`.

### Commands

| Command | Behavior | Defaults and ranges |
| --- | --- | --- |
| `heimdall coordinator start [--coordinator-config FILE] [--env-file FILE] [--timeout SECONDS] [--json]` | Launch through the native user service manager and wait for authenticated readiness. | `--timeout` 1 to 3600 seconds (decimal, up to three fractional digits), default 30. |
| `heimdall coordinator stop [--coordinator-config FILE] [--timeout SECONDS] [--no-wait] [--json]` | Request an authenticated drain and, by default, wait for confirmed clean shutdown. | `--timeout` 1 to 3600 seconds, default 60. `--no-wait` and `--timeout` cannot be combined. |
| `heimdall coordinator status [--coordinator-config FILE] [--json]` | Read-only status; unchanged. See [Status](#status). | 10 second deadline. |
| `heimdall coordinator logs [--coordinator-config FILE] [--lines N] [--follow]` | Print recent process logs, optionally following new lines. | `--lines` 1 to 10000, default 100. |
| `heimdall coordinator serve [--coordinator-config FILE] [--env-file FILE]` | Foreground operation. | Stops on SIGINT/SIGTERM. |

`start --help`, `stop --help` and `logs --help` show the same options. Malformed,
repeated, unknown or inapplicable options are rejected before any state,
configuration or service is touched and exit with status 2; with `--json` on
`start` or `stop` the rejection is still one result document. `--help` exits 0
and creates nothing. There is no force mode.

### Targets and configuration

The target is chosen like every other coordinator command: `--coordinator-config`,
then `HEIMDALL_COORDINATOR_CONFIG`, then `~/.config/heimdall/coordinator.toml`.
Heimdall remembers where the selection came from (`flag`, `env` or
`implicit-default`, reported as `target.origin`):

- A missing implicit default file is fine; the loader's defaults apply.
- A missing file named by the flag or the environment variable fails with
  `invalid-configuration` and nothing is started. Passing the default path with
  `--coordinator-config` makes it an explicit selection, so it is then required.
- The service receives the resolved absolute paths, so it keeps the same target
  whatever directory it is later started from. Paths with spaces and shell
  metacharacters are passed as literal arguments; no shell is involved.
- Lifecycle commands never write or rewrite the coordinator or project TOML.

The state directory (after canonicalization) identifies the coordinator. It is
owned by one process at a time through a lock the operating system releases when
that process exits, so a foreground `serve` and a managed `start` cannot run on the
same state directory; the later one is refused before it creates anything. The
service name is derived from the state directory
(`dev.openheimdall.coordinator.<24 hex>` on launchd and
`heimdall-coordinator-<24 hex>.service` on systemd).

### Credential context

A managed service does not inherit the credentials of the terminal that ran
`start`; it gets only a small nonsecret environment.

- **OpenChamber data directory.** When `OPENCHAMBER_DATA_DIR` is set at `start`,
  its resolved path is recorded in the service definition so the service keeps
  using that directory. Only the path is recorded: `start` does not read or copy
  the token in it, and the existing profile and token lookup is unchanged. If it is
  unset, the default OpenChamber location applies as before. A different explicit
  value while the coordinator runs is reported as `data-directory-conflict`.
- **Basic password file (`--env-file FILE`).** For `authentication = "basic"`,
  the coordinator needs the password named by `passwordEnvironmentVariable`
  (default `OPENCODE_PASSWORD`). The file holds one `NAME=value` per line. Blank
  lines and lines starting with `#` are ignored. A value is literal, optionally
  wrapped in one matching pair of single or double quotes; there is no `export`,
  interpolation, escape, inline comment or command substitution. Values must be
  nonempty and free of control characters, names may not repeat, and the file may
  be at most 64 KiB. It must be a regular file you own, not a symbolic link, with
  no group or other permissions (for example `chmod 600`). The opened file is
  validated, and Heimdall never creates, repairs or changes the file. Names that
  would change the execution environment (`HOME`, `PATH`, `NODE_*`, `HEIMDALL_*`,
  `OPENCHAMBER_*`, `GIT_*`, `XDG_*`, proxy variables and similar) are rejected, and
  diagnostics name only the file, line numbers and variable names, never values.
- **Selection and persistence.** `start` uses the explicit `--env-file`, otherwise
  the file remembered by the owned service definition, otherwise none. Only the
  canonical path is stored, never the contents. The coordinator reads the file at
  every fresh launch; there is no hot reload. An invalid or missing selected file
  (explicit or remembered) fails with `invalid-credentials` before a new service is
  launched. Passing a different file while the coordinator runs is a
  `credential-conflict`: stop, then start with the new file.
- **Exclusive use.** The Basic password source depends on how the coordinator
  runs:
  - *Managed service with a file.* The password comes only from the configured
    `passwordEnvironmentVariable` inside that file. A file that does not define
    that name never falls back to an environment variable inherited from the
    service manager, and the connection fails before any OpenCode request
    ("Set the configured OpenCode password environment variable").
  - *Managed service without a file.* There is no Basic password source at all:
    `OPENCODE_PASSWORD`, or a custom reference, present in the manager's
    environment is ignored, and the connection fails before any OpenCode request
    with an error that asks for a credential file.
  - *Foreground `serve --env-file FILE`.* Exclusive to the file, like a managed
    service with a file.
  - *Foreground `serve` without a file.* Keeps using the terminal's environment.

  Missing Basic input is reported when a run's connection is made, not at `start`:
  the coordinator still becomes ready, because readiness confirms coordinator IPC
  only. File values are never copied into `process.env`, and the manager-wide
  environment is not modified. `openchamber` and `none` authentication read no
  password and need no file; `openchamber` still locates the Desktop token through
  the nonsecret `OPENCHAMBER_DATA_DIR` selection.
- **Masking.** Known credential values, the coordinator key, run capabilities,
  authorization headers and URL credentials are masked before coordinator output is
  written to a log or printed by a lifecycle command, and before a shutdown
  diagnostic is stored. A known credential value is masked at any length, including a
  single character, and the longest value is masked whole when values overlap.
  Values that were never available to Heimdall cannot be masked.

### Readiness and its limits

`start` reports ready only after the instance it launched answers an authenticated
lifecycle identity request (`GET /lifecycle`, a separate versioned contract; the
`/status` schema is unchanged) and `/status` shows it `running` and accepting
runs, and the service manager shows the expected registration loaded from the owned
definition with a running main process whose process id is the answering
instance's. Missing, unknown or conflicting manager evidence is never readiness:
an unconfirmed answer ends as `startup-not-confirmed` and a registration from
another definition as a `conflict`. A successful call to the service manager is
only a launch result. One
deadline (`--timeout`, default 30 seconds) covers the manager calls and every
retry, and each coordinator request is limited to what remains of it, so a command
does not outlast its timeout by more than a small margin. Ctrl-C ends a request
that is in flight. An answer that arrives after the deadline is never reported as
success. When the deadline passes before the command changed anything, the result
is a `conflict` (`deadline-exceeded`) that says nothing was started or changed. If
readiness is not confirmed after a launch was requested, the result is
`startup-not-confirmed` or a failure with the observed state and where to read
logs; Heimdall does not claim to have stopped an instance that may still start.

Ready means coordinator IPC is available. It does not show that OpenCode is
reachable, that a Basic password is present or accepted, or that provider login,
a model or quota is available; `heimdall doctor --connect` and connection time
still report those. Starting and the readiness probe create no OpenCode session
and contact no provider. Runs already queued are admitted after startup under the
normal admission rules when capacity is available; that is separate scheduling,
not part of readiness.

Other starts:

- Repeating `start` on a ready managed coordinator returns `already-running`
  without changing it. Simultaneous starts leave one process.
- A matching foreground `serve` coordinator is reported as
  `already-running-foreground`; nothing is registered and it is not taken over.
- A draining coordinator is reported as `shutdown-in-progress`; it is not
  restarted and admission is not re-enabled.
- A `start` that was waiting on another lifecycle command while a stop was
  accepted or an `already-stopped` result was confirmed does not run afterwards
  (`conflict`, `superseded-by-stop`); run `start` again.
- A `start` whose deadline ends or that is interrupted while the service definition
  is still being installed requests no start afterwards; the installation under way
  finishes while the command keeps the per-target lock, so no other lifecycle command
  overlaps it. A start that was already requested from the service manager stays
  `startup-not-confirmed`: Heimdall does not undo it, and `stop` does not report
  `stopped` or `already-stopped` for the target until that call has settled.
- A foreign service registration, a mismatched target, a changed credential or data
  directory selection, or an endpoint that cannot be verified is a `conflict`.
  Heimdall does not remove a socket, take over a registration or signal a process.

### Stopping

`stop` verifies that the answering coordinator is the owned managed instance: the
service's loaded registration resolves to the owned definition and its running main
process has the answering instance's process id. An authenticated answer, a
definition on disk or a process id alone is not enough; unknown, missing or
conflicting evidence is a `conflict` and nothing is requested. Ownership is checked
again immediately before the request, which then names that instance. The service
that started the process is what is verified, so an owned service that was started
with an earlier launch context stays stoppable. Only the
coordinator key authorizes it; run-owner capabilities, wrong credentials, an
instance mismatch and an older coordinator without the lifecycle protocol are
refused, and there is no signal fallback. The coordinator disables admission
before it acknowledges, then drains with the same operation as SIGINT/SIGTERM.
Repeated or concurrent stops, and signals, share it.

An acknowledgement means draining began, not that the process stopped. While runs
hold capacity: queued runs stay queued, reservations are kept until the existing
native idle and reconciliation rules release them, a completed checkpoint is not
treated as idle proof, external sessions are not cancelled, and owner
checkpoint, receipt and outcome persistence stays available. A drain can therefore
stay open for a long time.

By default `stop` then waits up to 60 seconds for all of: the clean completion
record of that instance, a clean exit of the service's main process, and release
of the ownership lock. A vanished socket, a failed status request or a zero
reserved count is not proof. `stop --no-wait` returns after the acknowledgement.
The wait is bounded by one deadline that also covers the status request used to
describe a drain in progress: no request starts after it has passed, and a clean
exit established only after it is reported as `completion-unknown`
(`deadline-exceeded`), not as `stopped`. The coordinator keeps draining, and a later
`stop` reports its own result.

Before it sends the drain request (also with `--no-wait`), and before it reports
`already-stopped`, `stop` records an ordering boundary in the private `lifecycle`
state directory, so a `start` that began waiting earlier cannot launch the
coordinator again. If that record cannot be written, `stop` is a `failed`
result (`state-unknown`) that says no drain was requested, or that the coordinator
is not reported as already stopped; it never claims that admission was disabled.

| Outcome | Exit | Meaning |
| --- | --- | --- |
| `stopped` | 0 | Clean completion, clean process exit and released lock were confirmed for the instance. |
| `stop-requested` | 0 | `--no-wait` only: the matching coordinator accepted the drain request. It may still be running. |
| `already-stopped` | 0 | An owned inactive definition, a clean previous shutdown and process absence were all established. |
| `still-draining` | 1 | The wait ended while the coordinator was observed draining. It keeps draining; run `stop` again to keep waiting. |
| `completion-unknown` | 1 | Completion or exit could not be observed. Treat it as unknown, not as stopped. |
| `busy` | 1 | Another lifecycle command held the target for the whole wait. |
| `conflict` | 1 | For example a foreground coordinator, a foreign registration or a mismatched instance. |
| `failed` | 1 (2 for invalid arguments) | The operation could not be performed. |

A foreground coordinator is never signalled by `stop`: the result is a `conflict`
(`foreground-coordinator`) pointing to SIGINT/SIGTERM. If the drain fails, admission
stays disabled, reservations and owner persistence stay intact, and the result is
`drain-failed` with sanitized logs; running `stop` again observes and retries the
same pending shutdown. An instance that exits after acknowledging without a clean
completion record (`crashed-after-acknowledgement`) or fails while closing
(`shutdown-failed`, possibly with resources partly closed) is never reported as
stopped, and a later `stop` does not turn it into `already-stopped`.

`stop` never uses the manager's stop, disable, boot-out or kill operations, never
restarts the service and never deletes state. After a clean stop the owned
definition is kept, inactive, for the next explicit `start`. A changed executable,
configuration or credential source is applied to an inactive definition only after
its previous process is proven absent; a live definition is never replaced and the
conflict is reported. `start` applies the change itself, with no manual
service-manager step: systemd rewrites the unit in place and reloads the manager.
launchd keeps the definition it loaded, so `start` first unloads the registration
(`launchctl bootout`) only when it is loaded from the owned definition and
the manager reports it not running with no process, then reads the state again,
registers the new definition and starts it with `launchctl kickstart` (never with
`-k` or any kill option). A registration that is running, in an unknown state,
loaded from another definition, or that changes while the refresh is under way is
left untouched and reported as a conflict (`running-context-changed`,
`state-unknown` or `registered-elsewhere`).

Ctrl-C (or SIGTERM) during `start`'s or `stop`'s wait, or during `logs --follow`,
ends only that command. It does not reverse a requested drain, stop the
coordinator or signal OpenCode. An interrupted `stop` exits 1 as `still-draining`
or `completion-unknown` with error code `interrupted`; an interrupted `start`
reports `startup-not-confirmed`. An interrupted `logs --follow` exits 130.

Logout, reboot, operating-system shutdown and direct service-manager commands
(`launchctl bootout`, `systemctl --user stop`) can terminate the coordinator
under the manager's own timeout, before a drain finishes. The safe-wait guarantee
applies to `heimdall coordinator stop`. Heimdall does not promise survival across
logout or automatic recovery after a crash: nothing relaunches a crashed
coordinator, a stale socket is reported but not removed, and reservations stay
held for inspection.

### Result document

With `--json`, `start` and `stop` print exactly one document on stdout, including
for argument, configuration and operational failures. Progress and diagnostics stay
on stderr. Without `--json`, a successful result goes to stdout and a failure to
stderr. The exit status is 0 exactly when `ok` is `true`, 2 for invalid arguments,
and 1 otherwise.

```json
{
  "schemaVersion": 1,
  "command": "start",
  "ok": true,
  "outcome": "ready",
  "message": "Coordinator started and ready. Readiness confirms coordinator IPC only; it does not check OpenCode connectivity, credentials or quota.",
  "target": {
    "configFile": "/path/to/coordinator.toml",
    "origin": "flag",
    "stateDirectory": "/path/to/state",
    "endpoint": "/path/to/state/coordinator.sock",
    "manager": "launchd",
    "label": "dev.openheimdall.coordinator.0123456789abcdef01234567"
  },
  "instance": { "instanceId": "00000000-0000-4000-8000-000000000000", "pid": 4242, "mode": "managed" },
  "error": null,
  "logs": null
}
```

| Field | Meaning |
| --- | --- |
| `schemaVersion` | Result document version, currently `1`. It is independent of `/status` schema 1 and of the lifecycle protocol. |
| `command` | `start` or `stop`. |
| `ok` | `true` exactly when the requested result was established (exit 0). |
| `outcome` | `ready`, `already-running`, `already-running-foreground`, `shutdown-in-progress`, `startup-not-confirmed`, `stop-requested`, `stopped`, `already-stopped`, `still-draining`, `completion-unknown`, `busy`, `conflict` or `failed`. Success outcomes: `ready`, `already-running`, `already-running-foreground`, `stop-requested`, `stopped`, `already-stopped`. |
| `message` | One-line summary for people. Do not parse it. |
| `target` | `{ configFile, origin, stateDirectory, endpoint, manager, label }`, or `null` when no target resolved. `origin` is `flag`, `env` or `implicit-default`; `manager` is `launchd`, `systemd` or `null`. |
| `instance` | `{ instanceId, pid, mode }` of the instance that answered a validated lifecycle request (`mode` is `managed` or `foreground`), otherwise `null`. |
| `error` | `null` when `ok`, otherwise `{ code, message }`. |
| `logs` | Where to read logs when the operation did not complete, otherwise `null`. |

Error codes by group:

- Input and environment: `invalid-arguments`, `invalid-configuration`,
  `invalid-credentials`, `invalid-launch-context`, `unsupported-platform`,
  `manager-unavailable` (no usable launchd domain or systemd user manager and bus;
  there is no detached-process fallback).
- Launch and waiting: `launch-failed`, `startup-timeout`, `service-exited`,
  `deadline-exceeded`, `interrupted`, `busy`, `superseded-by-stop`.
- Conflicts: `context-conflict`, `credential-conflict`, `data-directory-conflict`,
  `running-context-changed`, `target-mismatch`, `foreign-registration`,
  `foreign-definition`, `registered-elsewhere`, `inactive-registration-stale`,
  `foreground-coordinator`, `instance-mismatch`, `not-managed`.
  `inactive-registration-stale` stays in the result schema for compatibility;
  `start` now refreshes such a registration itself instead of reporting it.
- Endpoint and state: `endpoint-unreachable`, `endpoint-refused`,
  `endpoint-transitioning`, `endpoint-invalid`, `endpoint-not-ready`,
  `unsupported-lifecycle-protocol`, `state-unknown`.
- Shutdown: `shutdown-in-progress`, `drain-failed`, `completion-unknown`,
  `crashed-after-acknowledgement`, `shutdown-failed`.
- Other: `internal`. `not-implemented` is reserved and not produced.

Consumers should accept new codes and treat unknown ones as failures.

### Logs

`logs` prints the most recent lines (default 100, at most 10000) as plain text
without a pager, and works while the coordinator is stopped or after a failed
start if logs exist; otherwise it says they are unavailable. Memory use is
bounded: only the tail of a file is read. There is no JSON log output.
`--follow` keeps printing new lines until Ctrl-C, which ends only the reader
(exit 130).

- **macOS:** the coordinator's standard output and error go to two private
  regular files, `coordinator.out.log` and `coordinator.err.log`, in the `logs`
  directory of the state directory (files 0600, directory 0700). Destinations that
  are symbolic links, not regular files (including a named pipe, which is refused
  without waiting for a reader) or not private are rejected without repair, and `start`
  reports the failure before registering or starting anything. An existing
  state directory that is not private is likewise rejected by `start` and `stop`
  without changing its mode; only directories Heimdall creates receive mode 0700.
  `--lines` applies to each file; they are printed one after the other
  under a header naming the file, because the two streams have no common
  timestamps. Files are appended to across stops and starts. Heimdall does not
  rotate or truncate them; they grow until you remove them while the service is
  stopped.
- **Linux:** the unit's journal output, read with
  `journalctl --user -u <unit>`, filtered to the owned unit. Retention and
  permissions follow the host's journal policy.

Output is sanitized by the coordinator before it is written, not only when read.
Process logs are separate from persisted run events, task results and proof that a
run succeeded.

### Supported service contexts

- **macOS:** the logged-in user's GUI launchd domain (`gui/<uid>`). The owned
  LaunchAgent plist is stored under the state directory (`service/`, file 0600,
  directory 0700), outside the directories launchd scans at login, with `RunAtLoad`
  and `KeepAlive` set to `false` and no other automatic trigger. `start` loads it
  if needed and uses `kickstart` without the kill-existing option.
- **Linux:** a systemd user manager with a user bus, as the ordinary user and
  without sudo. The unit has `Type=exec`, `Restart=no`, journal output and no
  `[Install]` section; it is linked into the user's unit directory, never enabled,
  and linger is not changed. The loaded fragment the manager reports, including
  that user-directory link, counts as owned only when it resolves through every
  link to the private definition; a link that is missing, dangling, unreadable or
  points at another unit is a `conflict`. If the manager is unavailable, `start` fails with
  `manager-unavailable` and guidance.

Other platforms report `unsupported-platform`; Windows is not supported by these
commands. The service runs the installed package's `dist/cli.js` with an absolute
Node.js executable, not npm, a shell or a profile. Closing the terminal that ran
`start` does not stop the service.

### Foreground operation and troubleshooting

`heimdall coordinator serve` is unchanged: it runs in the terminal, and
SIGINT/SIGTERM (Ctrl-C) stop admission and drain as described in
[Lifecycle and recovery](#lifecycle-and-recovery). Use it to see output directly
when `start` does not become ready. `stop` does not manage a foreground
coordinator, and `start` reports one as `already-running-foreground`.
Other troubleshooting:

- Read `heimdall coordinator logs` first; it works after a failed start.
- A refusal naming another coordinator, or "endpoint already exists", means
  another process owns the state directory or a stale socket is left from a crash.
  Inspect the owner before acting; Heimdall does not remove it.
- Removing a stale socket or clearing reservations after a crash is a manual
  decision; no lifecycle command does it.

## Status

`coordinator status` asks an already running coordinator whether it is running
or draining and how many runs are queued or hold capacity. It selects the
coordinator through the same `--coordinator-config` option, environment variable
and default path as the other commands.

```sh
node dist/cli.js coordinator status [--json] [--coordinator-config FILE]
node dist/cli.js coordinator status --coordinator-config /path/to/coordinator.toml
node dist/cli.js coordinator status --json --coordinator-config /path/to/coordinator.toml
```

The default output is a short summary:

```text
Coordinator running; accepting new runs.
Queued runs: 1
Reserved runs: 2 (retained capacity, including uncertain execution)
```

`--json` prints the validated schema-1 document instead. It has exactly these
fields; any other shape is rejected as an invalid response:

```json
{
  "schemaVersion": 1,
  "service": "heimdall-coordinator",
  "status": "running",
  "acceptingNewRuns": true,
  "queuedRuns": 1,
  "reservedRuns": 2
}
```

- `status` is `running` or `draining`. `draining` means the coordinator received
  a stop request or SIGINT/SIGTERM, stopped admission and is waiting for
  reservations to resolve;
  it is reported exactly when `acceptingNewRuns` is `false`.
- `queuedRuns` counts runs waiting for admission.
- `reservedRuns` counts runs holding capacity. It includes runs with uncertain
  execution that keep their reservation, so it is not a count of working agents.

Access and behavior:

- The route accepts only the administrator key from the coordinator state
  directory. Run-owner capabilities, wrong keys and missing keys are refused.
- Status gives up after a 10 second overall deadline, including when the
  coordinator keeps a connection open without finishing its response.
- Exit code 0 means a valid `running` or `draining` response was received
  (draining is not an error). Any other outcome exits 1 with a diagnostic on
  stderr and nothing on stdout: missing configuration or key, unavailable
  endpoint, refused authorization, a starting or stopping coordinator, an
  expired deadline, or an invalid response.
- A coordinator from an older version has no status route. It is reported as
  incompatible, and Heimdall never restarts or replaces it.
- Status is read-only. It does not create configuration, keys, sockets or
  databases, does not start or stop a coordinator, and does not contact OpenCode.

## Structured completion protocol

New runs persist `structured-v1` at start. The planner and the executor no longer
report through final chat text: each is offered one typed, owner-bound tool,
`heimdall_submit_plan` or `heimdall_submit_result`, and ends its turn after the
acknowledgement. The final chat text is never parsed as a result in a structured
run. Live record (planner and executor, one task advancement):
[structured-completion-live.md](validation/structured-completion-live.md).

- **Binding and receipts.** A binding with a rising dispatch generation is saved
  before each dispatch and bound to the child before the prompt is admitted; it
  is confirmed once the host observes the dispatch prompt. A submission is
  authenticated against that binding and against the native caller (session,
  agent, message and call ID). The origin is proved from the full native message
  archive, read page by page, not from the child's compacted active context, so a
  child whose context the host compacted past the dispatch prompt is still
  authenticated. A null cursor ends the scan; a repeated cursor is rejected before
  any of its messages is used, and a bounded scan that finds no proof fails closed,
  as does a missing native origin. Live record:
  [compaction-safe-provenance.md](validation/compaction-safe-provenance.md). A call by the bound child whose origin
  cannot be verified is denied with a distinct message naming a bounded reason;
  it is not a format error, spends no repair and leaves the binding usable, and
  if the attempt then ends without a submission the pause reason says the origin
  could not be verified. A wrong caller or a call from another dispatch gets the
  plain denial. The accepted payload is written once as
  an immutable receipt (`submission-<attempt>-<phase>-<kind>.json`, schema v3
  `submissions` table in the coordinator) before it is acknowledged.
- **Advancement.** A plan or task advances only with a matching durable receipt
  and a freshly confirmed successful native stop of the same idle child.
  Blocked, unfinished, interrupted, truncated or failed outcomes pause without a
  repair prompt; authentication and quota stay real failures.
- **Format repair.** A malformed submission gets at most two format repairs (the
  initial call plus two retries), counted per planner phase or executor task in
  the checkpoint and saved, with the owner-bound, submission-only restriction,
  before any feedback is returned. Framework-rejected calls count. An explicit
  `blocked` status or `passed: false` evidence inside a malformed payload is
  recorded as the real outcome and never consumes a repair. The reporting
  boundary is sealed (running implementation work is recorded as a conflict)
  before a receipt is acknowledged, and later implementation calls are denied.
- **Pause codes.** `submission_missing` (the child ended without a successful
  submission call), `submission_unconfirmed` (receipt recorded, successful stop
  not confirmed; a resume applies it without redoing the work),
  `submission_repair_exhausted`, `submission_unsupported` (repair cannot be
  enforced for this model or host, so none was offered), `submission_refused`
  (no repair could be offered) and `conflicting_work` (implementation work ran
  beside or after the accepted submission, so the evidence is not admitted). All
  carry bounded host-owned text, never submitted content, and none repeats a
  repair automatically.
- **Legacy compatibility.** A run persisted without a protocol keeps the prose
  path, including the completion-report correction below. The two paths are
  chosen once at start and never mixed in one run.
- **Runtime identity and snapshot.** The loaded plugin hashes its own `dist`,
  prompts, agent files and dependency resolution and records that build identity
  in new run states and in every submission receipt. A coordinator-managed run is
  admitted with that identity and launches from a run-owned, read-only copy
  beside its checkout (`STATE/worktrees/PROJECT_ID/RUN_ID/runtime`, marker
  `.heimdall-runtime-snapshot.json`, generated loader `.opencode/plugins/heimdall.ts`).
  The copy, its dependency location and the loader are verified before launch and
  before every resume; any mismatch refuses the run, so a rebuild of the shared
  package cannot change a running workflow. A run admitted without a snapshot
  (an earlier run) is not pinned and follows its existing path.
- **Not proven live.** Repair, negative outcomes, the pause codes above and the
  runtime snapshot were not exercised in the live run; they rest on unit tests.

## Completion-report correction

This path applies to runs persisted without the structured protocol. An executor that finishes the work but sends a malformed report no longer
forces a full re-run. Verification record:
[completion-report-recovery.md](validation/completion-report-recovery.md).

- **Contract footer.** Every executor prompt ends with a task-specific
  completion contract (task ID, required fields, every `Gn` mapped to its
  verbatim DoD item, the blocked shape). It is the last prompt text, after the
  `Workflow attempt:` marker; planner prompts are unchanged.
- **Classification.** A rejected reply gets a bounded code stored in the
  checkpoint as `reportRecovery.diagnostic`: `report_format`,
  `unfinished_work`, `agent_blocked`, `identity_mismatch`, `ambiguous_output`,
  `native_failure`, `auth_or_quota` and the correction outcomes
  `correction_exhausted`, `correction_unsupported`, `correction_ambiguous`.
  Semantic signals (blocked, `passed: false`, wrong task, bad or duplicate gate
  IDs, prose, truncation, native/auth/quota errors) are checked first; only
  completed-intent JSON that omitted fields or gate entries is `report_format`.
  Heimdall never repairs JSON or invents a `passed` value.
- **Two-attempt bound.** Only `report_format` is corrected automatically, at
  most twice per task and child, on the same idle child with the same agent,
  model and variant. The counter and attempt ID are saved before the prompt is
  sent and survive restarts, new attempt IDs, owner rotation and manual resume;
  only real task advancement clears them. An unanswered correction counts. The
  original and each correction receipt are kept as separate immutable files.
- **Enforcement boundary.** A correction runs only after a fail-closed
  report-only restriction is taken: the plugin denies every tool call for that
  child (`execute.before` throws, the session tool list is emptied,
  `permission.evaluate` denies where available) and releases it only after the
  child is confirmed idle. Heimdall sends a correction only for a provider
  listed in `VERIFIED_REPORT_ONLY_PROVIDERS` (`src/opencode/report-only.ts`).
  On this branch the list is exactly `['claude-code']`. Feature 0005 observed
  live, in a guarded disposable OpenCode fixture (OpenCode 2.0.22, Claude Code
  CLI 2.1.292, provider 1.3.4), that edit, write, shell, tests, `git commit`,
  delegation, namespaced MCP calls and nested code-mode calls were denied under
  restriction, left the files and Git `HEAD` unchanged, and worked again after
  owner-matched release; recovery (one bounded correction, the cap, interrupt and
  resume, failed work staying paused, late release) was also observed. Record:
  [claude-code-report-only-live.md](validation/claude-code-report-only-live.md).
  The live runs used a fixture-only copy of `dist` with the constant patched and
  a fault injected into the idle observation for the retained-restriction case;
  they were not run against an installed build of this branch. No other provider
  has live evidence and none is listed. For any unlisted provider every
  `report_format` failure still pauses as `correction_unsupported` and nothing is
  re-sent automatically. Activation is an owner action: until you build and
  install this branch, the installed runtime keeps the earlier empty list.
- **Restriction lifetime.** Each restriction carries an owner identity (parent,
  child, correction attempt ID and run ID) in the plugin's in-memory registry,
  so a later runner invocation, or a backend recreated over the same registry,
  can release it. The restriction is **kept** while the child is busy, awaiting
  input, in an unknown outcome or under a different parent, and whenever an
  interruption of a failed correction could not be confirmed. It is
  **released** only on resume, after the checkpoint owner's fenced save
  succeeded and a fresh idle check of the recorded child and parent passed, and
  before any prompt is sent or the task completes. A stale owner never reaches
  the release. Release removes only the entry matching that owner, so
  restrictions of other children, runs or holders are untouched. It is
  idempotent; if it fails the restriction stays in force, the run pauses and the
  next explicit resume retries. The first resume after an unconfirmed
  interruption still pauses as `correction_ambiguous` (the restriction is
  already released by then); the next resume sends the ordinary task prompt.
  The registry lives in the plugin process and does not survive a restart:
  after a restart nothing is released or assumed, the durable checkpoint is
  reconciled instead, and `correction_ambiguous` still prevents replaying a
  correction.
- **Pause categories.** The pause reason and the extension distinguish
  *Invalid completion report* (resume with guidance to restate existing results;
  no new work), *Unfinished work* (do the work or make the owner decision first),
  and *Report correction exhausted* / *unavailable* (owner review, then a
  format-only resume). The run stays `running` with capacity reserved while a
  correction is in flight; no database status was added. `checkpoint.saved`
  events carry only mode, counter, limit 2, the allowlisted code, field names
  and `G<n>` IDs, never reason text, replies, tokens or capabilities. The
  extension shows `Correcting report (n/2)` while running.

## Remaining limits

- The structured protocol was observed live once, on `claude-code`, with a valid
  first submission from each role. Repair, every `submission_*` pause code and
  the immutable runtime snapshot have no live evidence; the live run used a
  native workflow start with the built `dist` loaded in place, not a
  coordinator-managed run. Nothing runs against an installed build until the
  owner installs this branch. See
  [structured-completion-live.md](validation/structured-completion-live.md).
- Automatic report correction needs an owner-verified provider
  (`VERIFIED_REPORT_ONLY_PROVIDERS`). On this branch only `claude-code` is
  listed, from the live record in
  [claude-code-report-only-live.md](validation/claude-code-report-only-live.md)
  (feature 0005); it becomes operational only after you build and install the
  branch. Any other provider pauses format-only failures for a manual resume.
  The live proof has stated limits: authentication used the existing login
  through a read-only guard with refresh tokens withheld, so an access token
  that expires mid-run fails authentication instead of rotating; the retained
  restriction case used an injected observation fault, not a real OpenCode
  interrupt that fails to terminate a child; the receipt hashes were computed
  after the fact; and a restriction lost to a plugin restart is not recovered.
  The earlier feature 0004 status (no authenticated live check) is kept in
  [Provider verification](validation/completion-report-recovery.md#provider-verification-feature-0004).
- A correction that was dispatched but never answered consumes one of the two
  attempts and is not re-sent; the next owner resume uses a normal task prompt.
- Report-only restrictions are held in memory by the plugin process. A restart
  loses them (nothing is released or claimed for them); recovery then relies on
  the durable checkpoint and a manual resume.

- `coordinator status` is covered by automated tests with temporary fixtures on
  macOS only; Linux and Windows behavior and a live installed coordinator are
  unverified.
- Lifecycle commands were checked against a real launchd domain and a real systemd
  user manager with an empty coordinator state; a delayed drain with a held run was
  checked only with a synthetic executor and a fake service manager, and the
  hosted CI native job has not run. See
  [coordinator-lifecycle.md](validation/coordinator-lifecycle.md).
- Windows has no service adapter. There is no automatic startup, crash restart,
  stale-endpoint repair or force-stop mode, and drain can stay open while
  execution is unresolved.
- SQLite uses Node's built-in `node:sqlite`, still experimental on Node 22.
- Usage is unlimited by default. Existing optional caps cover cumulative child
  session/run tokens; parent orchestration tokens are outside those caps. Active
  requests can overshoot before cancellation is confirmed.
- Arbitrary user token windows and hard session deadlines remain deferred.
  `timeoutMinutes` remains a warning only.
- Automatic restart recovery, limit editing, runtime-asset migration/cleanup,
  release packaging and native Windows verification remain deferred.
- Observation is centralized polling. Native OS watchers require a concrete
  workflow trigger before being added.
