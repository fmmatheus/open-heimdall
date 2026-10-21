# Approval workflow example

A portable exercise for the typed approval flow: the owner makes one decision,
and the agent does the rest of the work in the same run.

The scenario is synthetic. A small repository holds a ledger integration and a
**dummy environment file with fake values only**. A two-task plan adds a client
(task 1), then migrates the integration to API v2 (task 2). Task 2 prepares the
migration, stops with a typed approval request, and finishes only after the
owner answers.

| Path | Purpose |
| --- | --- |
| [`task-spec.md`](task-spec.md) | The task spec that starts the run. Task 2 must ask for approval before it applies the migration. |
| [`project/`](project) | The synthetic repository: integration configuration, dummy environment file and a verification script that prints counts and variable names, never values. |
| [`scripted-agent/`](scripted-agent) | The files the scripted stand-in model writes (the client and two migration proposals). They are what a real agent would author, kept here so the automated test is readable. |

Every value in these files is invented. The endpoint ends in `.invalid`, and no
identifier refers to a real run, project, tenant or credential.

## Evidence levels

Keep these apart; this example covers the first and describes the others.

| Level | What it is | Status |
| --- | --- | --- |
| Fake-model native integration | [`test/approval-workflow-example.test.mjs`](../../test/approval-workflow-example.test.mjs) runs a real isolated coordinator, the real workflow runner, the real submission gate and the real `run respond` CLI. A scripted stand-in plays the native session and the model: it reads each dispatch prompt, edits files, commits with Git and submits typed results. | Automated. |
| Real model behavior | Whether a real model submits an `approval-required` result at the right moment, keeps the request free of values and obeys the decision. | Not verified here. |
| Real host and UI | OpenCode 2.0.32 hosting the plugin, and the OpenChamber 2.1.0 panel rendering the card and its buttons. | Owner-operated, see [Live procedure](#live-procedure-owner-operated-pending). |

## Run the automated example

From the repository root:

```sh
npm run build
node --test test/approval-workflow-example.test.mjs
```

The test creates a temporary directory, a Git repository from `project/`, a
coordinator state directory and a configuration file, then removes all of them.
It never reads real credentials, project configuration or the engine.

It proves two scenarios.

**Approve.** Task 1 completes and is committed. Task 2 writes the migration,
commits it, runs a dry run and the read-only verification, then submits an
approval request and the run pauses. The owner's only action is one
`heimdall coordinator run respond RUN_ID --request REQUEST_ID --decision approve`.
The test asserts that this call changes nothing in the worktree. The coordinator
queues the continuation, and the same run resumes the same unfinished task with a
fresh attempt. The agent applies the migration, runs the verification and
commits; the run ends `succeeded` with the same run ID, branch, worktree and
parent, the task 1 result and commit unchanged, and every commit after the base
authored by the agent. The decision, queue and consumption each happen once.

**Request changes.** The owner answers the first request with feedback instead:
keep one variable unchanged and make the change reversible. The agent receives
the feedback verbatim, does not apply anything, corrects the migration and asks
again with a fresh request ID. The earlier request stays closed and a late
approval of it is refused with nothing recorded. The owner approves the fresh
request, and the agent finishes.

In both scenarios the test scans everything the coordinator stores, the CLI
output, the run projections, the dispatch prompts, the agent's command output and
the commit messages for the dummy values. None appears, while the worktree file
itself still holds them: the agent moves values without printing them.

## Before and after

The same task in the base generic blocked/resume flow, and in this flow. Names
are placeholders.

| | Base: generic blocked, then resume | Typed approval |
| --- | --- | --- |
| What the agent reports | `blocked` with a reason. The agent has no way to say "I did the work, I need your decision". | `approval-required` with a question, the exact scope, completed work, verification, artifacts and the actions it keeps for each answer. |
| What the owner reads | A free-text blocker, often a list of steps to carry out. | A bounded card or `run show` output: `wait.kind` is `approval`, with the request, the scope and the revision under review. |
| What the owner does | Applies the migration, edits the environment file, runs the verification by hand, then resumes the run. | One decision: approve, or request changes with feedback. |
| Command | `heimdall coordinator run resume RUN_ID --input "Done, please continue"` after the manual work. | `heimdall coordinator run respond RUN_ID --request REQUEST_ID --decision approve` |
| What `resume --input` can be | Any string, including `approve`. Nothing ties it to the work that was reviewed. | Refused with `approval-pending` while a typed request is open. Only the decision bound to the request continues the run. |
| What the owner touches | The worktree and the environment file, which an agent then has to reconcile. | Nothing in the worktree. |
| What the agent receives | The owner's sentence. | The decision, the approved scope, the reviewed revision, the verbatim feedback and its own retained actions. |
| If the owner wants a change | Writes new instructions, or fixes the code personally. | Request changes: the agent corrects the proposal, never applies the rejected one and asks again under a new request ID. |
| If the work changed after the answer | Not noticed. | The decision is checked against the reviewed revision at dispatch; changed material supersedes it and needs fresh review. |
| Second step | A separate resume command after the manual work. | None. The continuation is queued once, when the run is provably idle. |
| Completion | The agent's report. | Unchanged: an ordinary evidence-backed completed submission. Approval completes no gate. |

The run ID, branch, worktree, task order, accepted results and earlier commits
are preserved by both flows. The difference is who does the work and what the
answer is bound to.

## Live procedure (owner-operated, PENDING)

Nothing below has been run against a live OpenCode, OpenChamber or model by the
automated test, and this README does not claim an outcome. Use a **disposable**
profile, project and coordinator; do not point this at a real project, a real
pending approval or your own services.

1. Install Heimdall into a throwaway prefix ([installation](../../docs/installation.md)),
   with OpenCode 2.0.32 and, for the panel, OpenChamber 2.1.0 in a disposable
   data directory. Start an isolated coordinator with its own configuration file
   and state directory, and check `heimdall coordinator status`.
2. Create a disposable Git repository from `project/`, commit it, and register it
   (`heimdall setup` writes the project configuration).
3. Install the extension build into the disposable OpenChamber profile
   ([extension guide](../../docs/openchamber-extension.md)) and open the project.
4. Submit the spec:

   ```sh
   heimdall coordinator run submit PROJECT_ID --feature task-spec.md
   ```

5. Watch the run until it pauses. Expected: task 1 done, task 2 paused with an
   approval card (question, scope, completed work, verification, artifacts and
   retained actions). Record whether a real model asked this way. If it paused
   as a generic blocker instead, record that: it is a model behavior finding, not
   a coordinator failure.
6. Click **Approve and continue** in the panel, or run `heimdall coordinator run
   respond RUN_ID --request REQUEST_ID --decision approve`. Expected: an
   acknowledgement with `continuation` `queued` (or `pending` while the run is
   being proven idle), then the same run resumes without a second command.
7. Repeat on a fresh run with **Request changes** and feedback. Expected: the
   agent corrects, a new card with a new request ID appears, and the earlier
   card shows as answered.
8. Verify in the worktree that the environment file kept its values, that the
   verification passes, and that you edited nothing.

Record the versions, commands and results in a dated file under
[`docs/validation/`](../../docs/validation) and mark each owner checklist item in
the [extension guide](../../docs/openchamber-extension.md) as passed or failed.
