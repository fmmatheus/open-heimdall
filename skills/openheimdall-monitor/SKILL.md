---
name: openheimdall-monitor
description: Read-only view of an OpenHeimdall coordinator run, using the installed heimdall CLI. Use when the user asks for the status, progress, current task or blocker of a run, or explicitly asks to watch a run for a limited time. Gives one current-state snapshot by default and a finite watch only when requested. It never changes a run or the coordinator. Do not use to start a new run or to give a paused run guidance.
---

# Monitor an OpenHeimdall run

Reports what the coordinator's records currently say about one run. It changes nothing.

## When to use

- "What is run X doing?", "is it blocked?", "where is my run?" - one snapshot.
- "Watch run X" or "tell me when it pauses" - a finite watch, only because the user asked.

Not for creating runs or acting on a blocker; see Prohibitions for where to send the user.

## Helper

The helper is `scripts/openheimdall.mjs` inside this skill's own directory. The host prints that directory when it loads the skill ("Base directory for this skill"); if it does not, use the directory that contains this `SKILL.md`. Call it with Node, one quoted argument per value:

`node "<skill directory>/scripts/openheimdall.mjs" <command> --cwd "<user's working directory>" [--coordinator-config "<file>"] ...`

- `--cwd` is the directory the user is working in, not the skill directory.
- Pass `--coordinator-config` only when the user named a coordinator configuration, and then pass the same value on every call. Otherwise omit it.
- Output is JSON on stdout. Exit 0 = a report, 1 = coordinator or transport failure, 2 = usage error.
- Read commands: `snapshot [RUN_ID]`, `watch [RUN_ID] [--budget-seconds N] [--interval-seconds N]`, `context`. Plain `heimdall run show RUN_ID` and `heimdall status --json` are also read-only.

## Procedure

1. **Pick the run.** Use the run ID the user gave. Otherwise run `snapshot` without an ID: it uses the managed run branch of the working directory, else the single active run of the matching project. If it answers `needs-run-id`, show its `reason` and candidates and ask which run; do not report another run as the user's. If it answers `none`, say there is no active run. A run list can be incomplete or too large, so a run missing from it is not proof that it does not exist; `run show RUN_ID` is authoritative.
2. **Take one snapshot.** Run `snapshot RUN_ID`. Read `run.status` and `run.stateClass`, `run.progress`, `run.currentTask`, `run.blocker`, `run.worktreePath`, `run.branch`, `run.parentSessionId` and `limits`.
3. **Interpret carefully.**
   - `queued`: accepted, waiting for a slot. `admitted` (preparing): a worktree is being prepared. `executing`: a task is in progress. `paused`: the run stopped for an owner decision. `succeeded` or `failed`: finished. `reconciliation-required`: the outcome is uncertain and needs the owner.
   - A reserved capacity slot does not prove that an agent is active. A quiet run is not proof of a stall; the record changes only when the coordinator records something.
   - Progress is completed versus total tasks; the current task exists only while the run is executing. If either is missing, say it is not available.
4. **Watch only on request.** Run `watch RUN_ID`. Defaults are a 600 s budget and 15 s interval; a requested duration must be finite (maximum 3600 s, interval 0.1 to 300 s). If the host limits how long a command may run, choose a budget below that limit. The helper prints one line per real change and none for unchanged state, and stops when the run pauses or reaches a terminal state, when the budget ends, on interruption, or when the coordinator is unreachable. Report the last known state and why the watch ended. Ending a watch does not affect the run.
5. **Report** using the template below, then give the next action as information for the user, not an action taken.

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
- no helper `start` or `resume` command and none of their options.

If the user wants a new run or wants to unblock a paused run, say that `openheimdall-start` and `openheimdall-resume` do that, and stop. If the monitor finds a run needing recovery, report it; do not attempt it.

## Report

Use exactly these lines; write `none` or `not available` rather than guessing.

```
Run: <run ID>
Status: <status> (<queued | admitted | executing | paused | succeeded | failed | reconciliation-required | unknown>)
Task/progress: <completed>/<total> tasks; current: <task id - title, or none>
Blocker / next action: <blocker text and what the owner must do, or "none">
Worktree / session: <worktree path, branch; parent session if any>
Evidence limits: <single read of the run record; reserved capacity is not activity; watch ended because ...>
```
