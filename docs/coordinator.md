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
  agent, message and call ID, proved from the host message timeline, failing
  closed when no native origin exists). The accepted payload is written once as
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
