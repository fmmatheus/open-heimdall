# Approval workflow validation

Records what was checked for the typed approval flow: an executor asks for an owner
decision, the owner answers once in the OpenChamber panel or with
`heimdall coordinator run respond`, and the agent continues the same unfinished task.
Guides: [coordinator](../coordinator.md#approvals-and-owner-responses),
[OpenChamber extension](../openchamber-extension.md), [skills](../skills.md). Example:
[`examples/approval-workflow/`](../../examples/approval-workflow/README.md).

**Status: final for the code listed below.** Automated and fake-model native checks
pass, an independent review was performed and its material findings were corrected.
The real OpenChamber panel, real model behavior and the managed
(coordinator-driven) path on a real OpenCode host are **not verified** (see
[Unverified](#unverified-acceptance-items)).

## Environment

| Item | Value |
| --- | --- |
| Date | 2026-10-20 |
| Code under test | `217e2d8` (`fix(coordinator): refuse a dropped approval written back into a checkpoint`). The feature commits are `a7dfe6f`, `3486ede`, `eb78c61`, `e04d538`, `3060026`, `512e123`, the example `6641727` and the native fixture scenario `c6310d3`; the review corrections are `eb3ffd9`, `5dd1f62`, `6d53c7e` and `217e2d8`. The commits that add or update this record change documentation only. |
| Base | `87c691b` (`docs(skills): record OpenCode 2.0.32 integration checks`) |
| OS / architecture | macOS 27.0.1 (Darwin 27.0.0), arm64 |
| Node.js / npm | v22.22.3 / 10.9.8 (declared minimum: Node.js 22.19) |
| OpenCode host | `opencode v2.0.32` (`opencode --version`), the pinned SDK version |
| OpenChamber | Target 2.1.0. The only installation seen on the machine reports 2.4.0; it is the user's own application and was not launched or modified. |
| Local CI | Not run. macOS and Linux CI runs for the installed package are a separate check. |

## Contracts and interfaces under test

| Surface | Value |
| --- | --- |
| Submission protocol | `structured-v1` |
| `executor-result` | contract **version 2**, adds the `approval-required` variant (`question`, `scope`, `completedWork`, `verification`, `artifacts`, `onApprove`, `onRequestChanges`) |
| `planner-plan` | version 1, unchanged (planner clarification stays on `blocked`) |
| Continuation envelope | `approval-continuation` version 1, rendered by the coordinator, parsed strictly by the runner |
| Coordinator storage | SQLite schema version 4 (tables `approval_requests`, `run_responses`) |
| Owner operation | `POST /runs/RUN_ID/approvals/REQUEST_ID/decision` (administrator key only) |
| Guarded legacy operation | `POST /runs/RUN_ID/respond` |
| CLI | `heimdall coordinator run respond RUN_ID --request REQUEST_ID --decision approve`, `... --decision request-changes --input FEEDBACK`, `... --pause PAUSE_ID --input GUIDANCE` |
| Extension | 0.2.0; `POST /runs/:id/approvals/:requestId/decision` and `POST /runs/:id/pause-response` |

## Evidence levels

These are kept apart on purpose.

| Level | Meaning | Where it applies here |
| --- | --- | --- |
| Automated, in process | Real coordinator, store, scheduler, service, CLI, runner and panel store with scripted inputs. | Unit, service, CLI, panel-store and installed-package tests. |
| Fake-model native integration | A real isolated coordinator and workflow runner, or a real OpenCode host, driven by a scripted model. | The example test (scripted stand-in for the native session) and the OpenCode compatibility fixture (real host, scripted model). |
| Real model behavior | A provider-hosted model decides when and how to ask. | **Not exercised.** |
| Real UI delivery | OpenChamber renders the card and a click reaches the coordinator. | **Not exercised.** |

## Commands and results

Run in the foreground from the repository root on commit `217e2d8`. The checks were
first run on the code before the last review correction and rerun after it; only the
runs on `217e2d8` are counted below.

| Command | Result |
| --- | --- |
| `npm run check` | Exit 0. |
| `npm test` | Exit 0: 1,750 tests, 1,750 passed, 0 failed, 0 skipped. |
| `npm run build:extension` | Exit 0. |
| `npm run test:package` | Exit 0: 87 tests, 87 passed, 0 failed, 0 skipped (consumer and temporary global installs outside the checkout). |
| `node scripts/live/skills-eval/run-eval.mjs selftest` | Exit 0, `"selftest": "passed"` (13 checks, including the approval and guarded-pause scenarios). |
| `node scripts/live/opencode-compatibility/run.mjs --opencode OPENCODE --scenario blocked --out REPORT` | `passed: true` against `opencode v2.0.32`, `fixtureRemoved: true`. |
| `node scripts/live/opencode-compatibility/run.mjs --opencode OPENCODE --scenario approval --out REPORT` | `passed: true` against `opencode v2.0.32`, `nativeApprovalPause` recorded, `fixtureRemoved: true`. |

`test/approval-workflow-example.test.mjs` (3 tests) is part of `npm test`.

Earlier runs, kept for the record:

- On the feature code (before the review), the first full `npm test` failed one test
  in `test/coordinator-drain.test.mjs` ("a failed drain keeps admission off and
  persistence open, ..."): the shutdown record was read as `'requested'` where
  `'drain-failed'` was expected. The test reads the record right after the lifecycle
  phase becomes visible and the record is written slightly later, so a loaded
  parallel run can read first. No lifecycle code, drain test or fixture differs from
  the base; the file passed alone five times (8 of 8 each time) and a second full run
  passed. It is the already-benched lifecycle test-timing instability. It was not
  fixed, no assertion was changed, and no reduced-concurrency run was needed.
  The failure did not recur in the three later full runs (after the corrections and
  after the last one).
- After the three material corrections, `npm test` passed 1,749 of 1,749 and
  `npm run test:package` 87 of 87. The last correction added one regression test
  (1,750).

CI on macOS and Linux was **not executed locally**; the installed-package tests were
run on macOS only.

## What the example test proves

`test/approval-workflow-example.test.mjs` runs a real isolated coordinator (SQLite,
scheduler, managed Git worktree, runtime snapshot), the real workflow runner and
durable submission gate through the real managed persistence, and the real
`heimdall coordinator run respond` CLI. A scripted stand-in plays the native session
and the model. It reads each dispatch prompt, edits files, makes Git commits and
submits typed results. The synthetic project and the dummy environment file are in
`examples/approval-workflow/`.

| Claim | Evidence in the test |
| --- | --- |
| The first task completes | Its result is in the checkpoint; the commit adding the client exists. |
| The second task pauses on a typed request | `wait.kind` is `approval`, request bound to task `T2`, index 1, state `pending`; nothing applied; results still 1; `run resume --input approve` is refused with `approval-pending`. |
| One owner decision | The owner role makes one CLI call (`run respond`); the worktree HEAD and status are identical before and after it; the run is `queued`, not executing. |
| The agent does the work | The agent applies the migration to the configuration and environment file, runs the verification and commits; every commit after the base is by the agent. |
| Same run, earlier work preserved | Same run ID, parent session, branch and worktree; the task 1 result is deep-equal to the one at the pause; the task 1 commit is an ancestor of HEAD; the continuation ran from a fresh attempt on the same child; one `approval.requested`, `answered`, `continuation_queued` and `consumed` event each; the single `run.resume_queued` event carries the request id; no guarded response was recorded. |
| Ordinary completion | The task finished only through a completed submission with evidence for each gate. |
| Dummy values never exposed | Every dummy value was searched for in the coordinator database, journal and write-ahead log, events, run list and detail, the approval record, the CLI output, every dispatch prompt, the agent's command output and the commit messages: none found. The worktree file itself still holds the values. A planted value in a surface and a deliberate leak by the scripted agent were each detected when tried. |
| Request changes, correction, re-review | The first request is answered with multiline feedback; the agent receives it verbatim between the fixed markers, applies nothing, corrects the migration and submits a fresh request with a new id, attempt and reviewed revision; the first request stays `answered` with decision `request-changes`; approving it afterwards exits 1 and records nothing; approving the fresh request lets the same run finish. The final configuration honours the feedback and the corrected rollback restores the original environment file. |

Not covered by this test: a real OpenCode host, a real model, the OpenChamber panel,
a coordinator restart (other tests in the coordinator suites cover restart, revision
changes and race conditions) and the live service lifecycle.

## Native host check

OpenCode 2.0.32 was available locally and the existing compatibility fixture was run
against it unchanged and with a new `--scenario approval` option, on the feature code
and again on `217e2d8` after the runner changed (both scenarios passed both times). The fixture isolates
the server's configuration, database, home and data directories, uses a scripted local
model and synthetic quota, listens on a random loopback port and removes its directory.
It contacts no provider, no credential and no running service.

- Default scenario: passed. Real host plugin load, structured planning after an
  output-limit continuation, native write, a blocked second task, same-run resume,
  paginated history. This shows the version 2 contract and runner changes did not
  break the standalone native path.
- `--scenario approval`: passed. The second task submitted an `approval-required`
  result through the real native tool schema. The runner paused with
  `wait: { kind: approval, taskId: T2, index: 1 }` and the reason
  `Approval required for T2: ...`, with one accepted result; the ordinary resume then
  completed both tasks and cleared the wait.

Limits of this evidence: the fixture runs the standalone workflow (local state, no
coordinator). It confirms that a real host accepts and the runner pauses on the typed
outcome. It does not record a decision, queue a continuation or carry the decision
envelope, because those need the coordinator and a managed worktree.

## Unverified acceptance items

Nothing below was claimed as passed. Where the environment was missing, nothing was
installed. The OpenChamber installation present on the machine belongs to the user, is
a different version and holds real logins, so it was left alone.

1. **Managed approval path on a real OpenCode host.** A coordinator with the real
   managed executor, a managed worktree and the runtime snapshot's plugin loaded by an
   OpenCode 2.0.32 server, driven to an approval request, an owner decision, an idle
   proof and a native resume. The existing harnesses cover the standalone host path
   and the managed path with a stand-in; none combines them.
2. **OpenChamber 2.1.0 render, click and continuation.** The card, its buttons and
   the extension service on a real OpenChamber 2.1.0. The panel store and service are
   tested against an isolated coordinator, but `src/extension/panel/main.ts` rendering
   is not DOM-tested and no host rendered it. Checklist items 1 to 14 in the
   [extension guide](../openchamber-extension.md#manual-verification-owner-checklist-020)
   remain PENDING.
3. **Real model behavior.** Whether a real model submits `approval-required` at the
   right moment, keeps the request free of values, obeys a decision and does not
   perform the gated action after requested changes. Whether a model that loads the
   skills asks for an explicit decision instead of approving on a bare "resume".

### Reproduction in an isolated profile

Use a disposable root, never your own profile, projects or coordinator.

1. Build the extension: `npm ci --ignore-scripts && npm run build:extension`.
2. Create a throwaway root (`ROOT=$(mktemp -d)`). Point `HOME`, the `XDG_*`
   directories, `TMPDIR`, `OPENCODE_CONFIG_DIR` and `OPENCHAMBER_DATA_DIR` at
   directories inside it, and keep any provider credentials out of that environment.
   Install OpenChamber 2.1.0 into it (`npm install @openchamber/web@2.1.0
   --ignore-scripts --save-exact` in a directory under `ROOT`;
   `scripts/live/skills-host/openchamber-catalog.mjs` shows an isolated start) and
   start it on a random loopback port with OpenCode 2.0.32.
3. Create a coordinator configuration and state directory under `ROOT` and start an
   isolated coordinator with `heimdall coordinator serve --coordinator-config FILE`.
4. Create a disposable Git repository from `examples/approval-workflow/project/`, run
   `heimdall setup` in it and register it. Submit the spec:
   `heimdall coordinator run submit PROJECT_ID --feature examples/approval-workflow/task-spec.md --coordinator-config FILE`.
5. In OpenChamber (**Settings → Extensions**) add the `dist/openchamber-extension`
   folder, approve it, and open the Heimdall panel. Use a model you are allowed to use
   for tests, or a scripted one.
6. When the run pauses, check the approval card against `run show`, click **Approve
   and continue** once, and confirm one continuation, the same run completing and an
   unchanged worktree apart from the agent's commits. Repeat on a second run with
   **Request changes** and feedback.
7. Record versions, commands and results, mark each owner checklist item and stop only
   your own processes. Remove `ROOT`.

## Fixture ownership and cleanup

- The example test creates one temporary directory per test (project copy, coordinator
  state, configuration, isolated HOME and worktrees), shuts its own coordinator down and
  removes the directory afterwards.
- The compatibility fixture owns its host process, its temporary directory and its
  random loopback port, stops the process and removes the directory itself. Every
  report states `fixtureRemoved: true`, and no fixture directory remained after the
  final runs.
- Leftovers from this work's own test runs were removed only after proving them
  inactive: two empty `heimdall-structured-*`/`heimdall-repair-*` scratch directories
  created by `test/structured-runner.test.mjs` and `test/submission-repair.test.mjs`
  (empty, nothing holding them open) and one `heimdall-tarball-*` directory created by
  the installed-package helper (no process or open file in it; it held only an npm
  cache, empty npm configuration files and a packed tarball). Review probes and logs
  lived in scratch directories under the system temporary directory and were removed.
- No real project, run, pending approval, service, credential or provider was used or
  changed. No dependency was installed. The user's OpenCode, OpenChamber and
  coordinator processes were not contacted, stopped or modified; other temporary
  directories on the machine were left alone.
- The synthetic values are fake: the endpoint ends in `.invalid` and none of the
  values is a credential.

## Independent review

A reviewer who had not written the code read the whole diff against the base and
reported findings in five areas: owner authority, restart and concurrency, UI/CLI
parity, old-client bypass and retained agent responsibility. Probes against the built
code reproduced each material finding.

| ID | Severity | Finding | Outcome |
| --- | --- | --- | --- |
| F1 | material | An agent-written checkpoint could carry a forged owner decision or approval wait that the runner later presented to the agent as the owner's. | Fixed. |
| F2 | material | After a request was superseded, a bare free-text `approve` advanced the run through the unguarded resume, and the panel pointed the owner at it. | Fixed. |
| F3 | material | A decision was marked delivered at the dispatch boundary before any attempt carried it; a crash or failed launch lost it and reported it as delivered. | Fixed. |
| F4 | minor | A stale earlier approval stayed in the checkpoint across a fresh request. | Fixed. |
| F5 | minor | The raw continuation envelope appeared as a later pause's "Resolution" in the panel. | Fixed. |
| F6 | minor | The review revision's exclusions (ignored files, bookkeeping paths) were undocumented. | Documented. |
| F7 | minor | A revision measurement failure (timeout, size limit) blocks publication or needs a manual reconcile at dispatch. | Benched: fails closed, liveness cost only. |
| F8 | minor | The revision is measured when the request is submitted, while the session may still write. | Benched: fails closed. |
| F9 | minor | A guarded legacy response has no inspection route by pause id. | Benched: an identical retry returns the stored acknowledgement and `run show` shows the labelled resolution. |
| F10 | minor | The panel's stale-card check is stricter than the CLI's identity check. | Benched: fails safe. |
| F11 | minor | One extra query per listed run; the runtime identity reads contract versions with a pattern. | Benched: bounded, fails closed. |

Areas with no defect beyond the above: decision recording is administrator-only and
atomic with the receipt; recording and queueing are one transaction; the review
revision is rechecked at the dispatch boundary; drain refuses every write; the CLI,
panel and skill helper use the same two operations and never fall back to `run resume`
on an old coordinator; the executor and skill instructions keep implementation work
with the agent.

## Corrections

Each correction has a regression test that failed on the code before it and passes
after it (ten failing tests before the first three corrections; one before the last).

| Commit | Fixes | Change |
| --- | --- | --- |
| `eb3ffd9` | F4 | A fresh approval request removes an earlier non-superseded `approve` from the checkpoint; contexts that only restrict stay. |
| `5dd1f62` | F1, F2, F3, F6 | `saveCheckpoint` accepts `approval` only when unchanged, absent or exactly the context the coordinator delivered, and `wait` only for a request published for that attempt (a refused checkpoint is not stored, HTTP 400). A superseded request on a paused, released run is reported as a generic wait with a pause identity, so the guarded labelled response applies; an unguarded resume of a run that used typed approvals arrives labelled as guidance. A decision counts as delivered only once an attempt's checkpoint carries it; a dispatch lost at the boundary is queued once more when the run is back on the asking wait, and the generic resume is refused meanwhile. The revision scope is documented. No schema change. |
| `6d53c7e` | F2 (panel), F5 | The superseded card no longer tells the owner to run `run resume`; the continuation envelope is not shown as a later pause's resolution. |

### Review of the correction diff

A second fresh review read the correction diff against each finding and the five
areas. All three material corrections hold and no assertion was weakened (the
fixture changes insert the request before the paused checkpoint, as the real flow
does, set `consumed_attempt_id` where a fixture means "delivered", and make the
resumed fake session active where a real launched session would be). It found one
further material gap, corrected in `217e2d8`:

| ID | Severity | Finding | Outcome |
| --- | --- | --- | --- |
| N1 | material | The delivered decision stays the run's stored resolution, so a checkpoint could write back an approval the runner had dropped for a fresh request, and a later plain resume would present it again. | Fixed in `217e2d8`: a new `approval` is accepted only while the stored checkpoint is still on the approval wait of the asking attempt. Regression test fails before and passes after. |
| N2 | minor | An owed decision is queued again each time the run is proven idle, without a cap. | Benched, listed under remaining gaps. |

## Remaining gaps

- The three unverified items above (managed path on a real OpenCode host,
  OpenChamber 2.1.0 render/click/continuation, real model behavior).
- CI on macOS and Linux for the installed package was not run; local runs are macOS
  only.
- An owed decision (dispatched but never carried by an attempt, which happens only
  when the resumed session ends without the runner recording its resume) is queued
  again each time the run is proven idle, without a retry limit. A probe whose
  fake session always reported idle produced one admission per scheduler tick. It
  affects cost and events only: no agent saw the decision, so no gated action ran.
  A limit needs a policy for what the owner sees afterwards.
- Benched review items F7 to F11 above.
- The three packaged skill helpers keep a client-side pre-check that does not know a
  decision is owed after a lost dispatch; the coordinator still refuses the generic
  resume with `approval-pending`.
- Revision measurement is at submission time and covers only git-visible content (see
  [the coordinator guide](../coordinator.md#approvals-and-owner-responses)).
