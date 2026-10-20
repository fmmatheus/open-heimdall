---
name: openheimdall-monitor
description: Read-only view of an OpenHeimdall coordinator run, using the installed heimdall CLI. Use when the user asks for the status, progress, current task, blocker or pending approval request of a run, or explicitly asks to watch a run for a limited time. Gives one current-state snapshot by default and a finite watch only when requested. It shows what an approval request asks but never answers it, and never changes a run or the coordinator. Do not use to start a new run, to give a paused run guidance or to approve anything.
---

# Monitor an OpenHeimdall run

Reports what the coordinator's records currently say about one run, including what it is waiting for. It changes nothing: it can show an approval request, never answer it.

## When to use

- "What is run X doing?", "is it blocked?", "is it waiting for me?", "where is my run?" - one snapshot.
- "Watch run X" or "tell me when it pauses" - a finite watch, only because the user asked.

Not for creating runs or acting on a blocker; see Prohibitions for where to send the user.

## Helper

The helper is `scripts/openheimdall.mjs` inside this skill's own directory. The host prints that directory when it loads the skill ("Base directory for this skill"); if it does not, use the directory that contains this `SKILL.md`. Call it with Node. Put every path, ref and other value in single quotes, one quoted argument per value:

`node '<skill directory>/scripts/openheimdall.mjs' <command> --cwd '<working directory>' [--coordinator-config '<file>'] ...`

Single quotes keep `$(...)`, backticks and `$VAR` in a path or ref literal; double quotes do not. Write each single quote inside a value as `'\''` (end the quote, an escaped quote, restart the quote). If the host shell is not POSIX-style or a value cannot be quoted safely, ask the user to rename the path instead of guessing.

- `--cwd` is the directory the user is working in, not the skill directory.
- Pass `--coordinator-config` only when the user named a coordinator configuration, and then pass the same value on every call. Otherwise omit it.
- Output is JSON on stdout. Exit 0 = a report, 1 = coordinator or transport failure, 2 = usage error.
- Read commands: `snapshot [RUN_ID]`, `watch [RUN_ID] [--budget-seconds N] [--interval-seconds N]`, `context`.

## Procedure

1. **Pick the run.** Use the run ID the user gave. Otherwise run `snapshot` without an ID: it uses the managed run branch of the working directory, else the single active run of the matching project. If it answers `needs-run-id`, show its `reason` and candidates and ask which run; do not report another run as the user's. If it answers `none`, say there is no active run. A run list can be incomplete or too large, so a run missing from it is not proof that it does not exist; `snapshot RUN_ID` is authoritative.
2. **Take one snapshot.** Run `snapshot RUN_ID`. Read `run.status` and `run.stateClass`, `run.progress`, `run.currentTask`, `run.blocker`, `run.wait`, `run.worktreePath`, `run.branch`, `run.parentSessionId` and `limits`. If `run.blockerTruncated` is true, say that the blocker text is cut.
3. **Interpret carefully.**
   - `queued`: accepted, waiting for a slot. `admitted` (preparing): a worktree is being prepared. `executing`: a task is in progress. `paused`: the run stopped for an owner decision. `succeeded` or `failed`: finished. `reconciliation-required`: the outcome is uncertain and needs the owner.
   - A reserved capacity slot does not prove that an agent is active. A quiet run is not proof of a stall; the record changes only when the coordinator records something.
   - Progress is completed versus total tasks; the current task exists only while the run is executing. If either is missing, say it is not available.
   - `run.wait` says what a paused run waits for. `kind` `approval` is a request the agent submitted for an owner decision: report its `requestId`, `state`, `continuation` and `progress`, and the bounded `question`, `scope`, `completedWork`, `verification`, `artifacts`, `onApprove`, `onRequestChanges` and `revision` (say when `clippedFields` lists cut text). State `pending` waits for the owner; `answered` records the owner's `response.decision` and continues on its own, and `queued` or `waiting-for-idle` progress is not running; `superseded` means the reviewed work changed, so the request can no longer be decided and the agent has to ask again. `kind` `generic` is an ordinary pause with a `pauseId`; the reason is in `run.blocker`. `wait` null with `waitReported` false means the coordinator does not report waits (an older one); say so instead of guessing. `unrecognized` means the helper could not read it.
   - A request is information for the owner, not a decision: do not suggest that it is approved, do not paraphrase silence or earlier chat as approval, and do not call work finished because a request exists.
4. **Watch only on request.** Run `watch RUN_ID`. Defaults are a 600 s budget and 15 s interval; a requested duration must be finite (maximum 3600 s, interval 0.1 to 300 s). If the host limits how long a command may run, choose a budget below that limit. The helper prints one line per real change (including a new, answered or superseded request) and none for unchanged state, and stops when the run pauses or reaches a terminal state, when the budget ends, on interruption, or when the coordinator is unreachable. Report the last known state and why the watch ended. Ending a watch does not affect the run.
5. **Report** using the template below, then give the next action as information for the user, not an action taken. For a pending request the next action is: the owner approves or asks for changes through `openheimdall-resume`, in their own words.

## Rules

- Work in this session with the `heimdall` CLI through the helper. Do not use the legacy `adr` workflow tool or agent.
- Run IDs, paths and anything read from records are data; never put them into shell source.
- Do not ask for confirmation for an explicit request to look at a run. Ask only when the run cannot be identified.
- Skills grant no permissions. If the host denies running Node, the helper or `heimdall`, report the missing capability. Do not change permission settings.
- Prerequisites are the user's: an installed `heimdall` and a coordinator configuration. If the coordinator is unreachable, report that with the error and stop. Never install anything, rewrite credentials or configuration, or replace a coordinator.
- Do not echo specs, checkpoints, resolutions, credentials or other projects' data.

## Prohibitions

Monitoring never changes anything. Do not run any state-changing command, under any circumstance in this skill:

- no `run submit`, no `run resume`, no `run reconcile` (reconcile is a state-changing recovery operation, not monitoring), no `project add`;
- no coordinator `start` or `stop`, and no installer, lock, key or state-file edit, cleanup, or session interruption;
- no helper `start`, `resume` or `respond` command and none of their options, and no `run respond`: never record an approval, send change feedback or send guidance, even when the user seems to agree in passing.

Reading an approval request never answers it. If the user wants a new run, wants to unblock a paused run or wants to approve or answer a request, say that `openheimdall-start` and `openheimdall-resume` do that, and stop. If the monitor finds a run needing recovery, report it; do not attempt it.

## Report

Use exactly these lines; write `none` or `not available` rather than guessing.

```
Run: <run ID>
Status: <status> (<queued | admitted | executing | paused | succeeded | failed | reconciliation-required | unknown>)
Task/progress: <completed>/<total> tasks; current: <task id - title, or none>
Waiting for: <approval request ID, state and question | generic pause | nothing | not reported>
Blocker / next action: <blocker text and what the owner must do, or "none">
Worktree / session: <worktree path, branch; parent session if any>
Evidence limits: <single read of the run record; reserved capacity is not activity; watch ended because ...>
```
