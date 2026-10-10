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

## Completion-report correction

An executor that finishes the work but sends a malformed report no longer
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
  listed in `VERIFIED_REPORT_ONLY_PROVIDERS` (`src/opencode/report-only.ts`),
  which ships **empty**. `claude-code` is unsupported, not proven: its provider
  plugin exposes only OpenCode's tool list and parks tool calls back to
  OpenCode, but the local sources do not show that OpenCode core routes those
  calls, or code-mode `execute` nested calls, through the hooks, and no live
  experiment was run. Without a verified provider every `report_format` failure
  pauses as `correction_unsupported` and nothing is re-sent automatically.
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

- Automatic report correction needs an owner-verified provider
  (`VERIFIED_REPORT_ONLY_PROVIDERS` is empty); until then format-only failures
  pause for a manual resume. **`claude-code` is unsupported.** Feature 0004
  did not perform an authenticated live check. Its fresh Claude login store
  had no login. Earlier smoke tests reused the existing login with isolated
  OpenCode stores, transcript persistence disabled and user hooks disabled;
  that does not prove protection against credential refresh or every CLI write.
  Those protections and every supported tool path still need verification. See
  [Provider verification](validation/completion-report-recovery.md#provider-verification-feature-0004).
- A correction that was dispatched but never answered consumes one of the two
  attempts and is not re-sent; the next owner resume uses a normal task prompt.
- Report-only restrictions are held in memory by the plugin process. A restart
  loses them (nothing is released or claimed for them); recovery then relies on
  the durable checkpoint and a manual resume.

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
