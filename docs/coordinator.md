# Global coordinator development

The opt-in coordinator registers local Git projects, queues feature runs, and
claims global/per-project capacity in SQLite. Each run gets a new locked Git
worktree and branch at its submitted base commit. The established runner plans
and executes tasks sequentially; OpenCode owns all agent and tool execution.

This is a development interface, tested with temporary repositories and mocked
OpenCode APIs. It has not been activated against the running original workflows.
Keep those workflows separate. Registration only reads the selected project;
submission creates managed worktrees and adds their Git registry entries.

## Setup

Build the package with Node.js 22.19 or newer. Use a separate development Git
project with a valid [project configuration](../examples/heimdall.toml). Set its
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

Copy [coordinator.toml](../examples/coordinator.toml) to a private configuration
directory. Limits default to one global run and one run per project when omitted.
An explicit project `--limit` overrides the registration default. Limits count
whole admitted runs, including uncertain execution, rather than individual tasks.

```sh
node dist/cli.js coordinator serve --coordinator-config /path/to/coordinator.toml
```

From another terminal, using the same coordinator configuration:

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
OpenCode retains session/message storage. The original standalone plugin retains
its file-backed checkpoints and recovery interface.

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

SIGINT/SIGTERM stops new admission and drains managed runs while keeping their
checkpoint connection open. Unresolved execution can keep draining open until
reconciled. Abrupt process loss can interrupt checkpoint writes; reservations
remain held for inspection after restart.

Runs can also be watched and reviewed read-only from OpenChamber 2.1.0; see the
[OpenChamber extension guide](openchamber-extension.md).

## Remaining limits

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
