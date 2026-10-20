# Approval workflow validation

Records what was checked for the typed approval flow: an executor asks for an owner
decision, the owner answers once in the OpenChamber panel or with
`heimdall coordinator run respond`, and the agent continues the same unfinished task.
Guides: [coordinator](../coordinator.md#approvals-and-owner-responses),
[OpenChamber extension](../openchamber-extension.md), [skills](../skills.md). Example:
[`examples/approval-workflow/`](../../examples/approval-workflow/README.md).

**Status: DRAFT.** Automated and fake-model native checks pass. The real
OpenChamber panel, real model behavior and the managed (coordinator-driven) path on
a real OpenCode host are **not verified** (see [Unverified](#unverified-acceptance-items)).
The independent review and correction sections are not written yet.

## Environment

| Item | Value |
| --- | --- |
| Date | 2026-10-20 |
| Code under test | `c6310d3` (`test(live): add an approval scenario to the native compatibility fixture`), on top of the feature commits `a7dfe6f`, `3486ede`, `eb78c61`, `e04d538`, `3060026`, `512e123` and the example commit `6641727`. Later commits in this series change documentation only. |
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

Run in the foreground from the repository root on the code above, in this order.

| Command | Result |
| --- | --- |
| `npm run check` | Exit 0. |
| `npm test` (first run) | Exit 1: 1,742 tests, 1,741 passed, 1 failed (below). |
| `npm test` (second run, no change in between) | Exit 0: 1,742 tests, 1,742 passed, 0 failed, 0 skipped. |
| `npm run build:extension` | Exit 0. |
| `npm run test:package` | Exit 0: 87 tests, 87 passed, 0 failed, 0 skipped (consumer and temporary global installs outside the checkout). |
| `node scripts/live/skills-eval/run-eval.mjs selftest` | Exit 0, "selftest passed" (13 checks, including the approval and guarded-pause scenarios). |
| `node --test test/approval-workflow-example.test.mjs` | 3 tests, 3 passed in each of three runs alone and in both full `npm test` runs, without a failure. |
| `node scripts/live/opencode-compatibility/run.mjs --opencode OPENCODE --out REPORT` | `passed: true` against `opencode v2.0.32`. |
| `node scripts/live/opencode-compatibility/run.mjs --opencode OPENCODE --scenario approval --out REPORT` | `passed: true` against `opencode v2.0.32`, with `nativeApprovalPause` recorded. |

### The failed full run

The first `npm test` failed one test in `test/coordinator-drain.test.mjs`:
"a failed drain keeps admission off and persistence open, records drain-failed, and a
later request retries the same operation". The assertion at the shutdown-record check
read `'requested'` where it expected `'drain-failed'`. The test reads the shutdown
record right after the lifecycle phase becomes visible, and the record is written
slightly later; under the load of a parallel full run the read can come first.

Investigation, bounded to that file:

- No file of the lifecycle code, the drain test or its fixtures differs from the base
  (`git diff 87c691b HEAD` over `src/coordinator/lifecycle*.ts`,
  `test/coordinator-drain.test.mjs` and `test/fixtures` is empty).
- `node --test test/coordinator-drain.test.mjs` run alone five times: 8 of 8 passed
  each time.
- The second full `npm test` with default concurrency passed 1,742 of 1,742.

The failure is classed as the already-benched lifecycle test-timing instability, not a
defect of this feature. It was not fixed, and no assertion was changed. The failed
output is kept with the run's scratch files and is not reproduced here. No
reduced-concurrency run was needed.

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
against it unchanged and with a new `--scenario approval` option. The fixture isolates
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
  removes the directory afterwards. After the runs no such directory remained.
- The compatibility fixture owns its host process, its temporary directory and its
  random loopback port, stops the process and removes the directory itself. Both
  reports state `fixtureRemoved: true`.
- No real project, run, pending approval, service, credential or provider was used or
  changed. No dependency was installed. The user's OpenCode and OpenChamber processes
  were not contacted.
- The synthetic values are fake: the endpoint ends in `.invalid` and none of the
  values is a credential.

## Independent review

Not yet performed. This section is completed when the independent review delivers its
findings.

## Corrections

Not yet performed. This section lists the corrections made for material review
findings and the review of their diff.

## Remaining gaps

- The three unverified items above.
- Local runs only: the installed-package tests were not run on Linux here, and CI was
  not run.
- A first full `npm test` hit one test-timing failure in unchanged lifecycle code; it
  is recorded above and was not fixed.
