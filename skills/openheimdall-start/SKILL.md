---
name: openheimdall-start
description: Start a new OpenHeimdall coordinator run from a task-spec Markdown file in the user's normal session, using the installed heimdall CLI. Use when the user asks to start, submit, launch or queue a new run or task from a spec file, optionally naming a project, base ref or coordinator configuration. Do not use to monitor a run (openheimdall-monitor), to resume a paused run with guidance (openheimdall-resume), or when the file is guidance for an existing run rather than a new task.
---

# Start an OpenHeimdall run

Submits one new run to the configured coordinator from a task-spec Markdown file. Every accepted submission creates another run; there is no idempotency key.

## When to use

- The user wants a new run from a spec file ("start a run from `specs/feature.md`", "queue this task spec on this repo").
- The user names, or the context makes unambiguous, a repository and, optionally, a base ref.

Not for: inspecting a run (`openheimdall-monitor`), continuing a paused run (`openheimdall-resume`), or a file that is owner guidance for an existing run. If the file and the request disagree about which of these it is, ask which is meant instead of creating a run.

## Helper

The helper is `scripts/openheimdall.mjs` inside this skill's own directory. The host prints that directory when it loads the skill ("Base directory for this skill"); if it does not, use the directory that contains this `SKILL.md`. Call it with Node, one quoted argument per value:

`node "<skill directory>/scripts/openheimdall.mjs" <command> --cwd "<user's working directory>" [--coordinator-config "<file>"] ...`

- `--cwd` is the directory the user is working in, not the skill directory. Relative spec paths resolve against it.
- Pass `--coordinator-config` only when the user named a coordinator configuration, and then pass the same value on every call in this task. Otherwise omit it and let the CLI use its default selection.
- Output is JSON on stdout. Exit 0 = a report, 1 = coordinator or transport failure, 2 = usage error. Run `--help` for the full syntax.

## Procedure

1. **Identify the inputs.** Spec file path (ask if missing), the repository (the working directory unless the user named another), and an optional base ref (default `HEAD`). Do not ask about anything the request already states.
2. **Inspect the file before any change.** Run `inspect-spec FILE`. If it reports `usable: false`, tell the user why (unreadable, empty, too large, not text) and stop. If it reports `looksLikeResumeGuidance` or `mentionsExistingRun`, ask whether this is a new task or guidance for an existing run; use `openheimdall-resume` for the latter. Never start a run from guidance text.
3. **Read the context.** Run `context --base REF` (omit `--base` for `HEAD`). From the answer, check:
   - `project.match`: `one` reuse it; `many` ask the user which project, never guess; `none` see step 5.
   - `base.oid`: the full commit the run will start from, resolved in the user's own worktree. If `registeredDirectoryOid` differs, tell the user the run is created in the registered project and name both commits.
   - `notices`: uncommitted or untracked edits are not part of a run's base. Say so; do not commit, stash or discard anything.
   - `coordinator.readiness` and `acceptingNewRuns`.
4. **Decide the coordinator step.** `ready` and `acceptingNewRuns` true: continue. Draining: report that no new runs are accepted and stop; the owner decides whether to wait or restart. Unavailable: add `--start-coordinator` to the start command only because the user asked for a new run; the helper uses the CLI's own start command and its safety outcomes and never stops, restarts or replaces an instance.
5. **Project registration.** Add `--register` only when the user named or confirmed this repository as the project to use. If the repository is unregistered and the user did not say so, ask once. Never change limits or configuration of an existing registration.
6. **Submit once.** Run `start --spec FILE [--base REF] [--register] [--start-coordinator]` exactly one time. The helper pins the base to the full OID, re-checks readiness and submits a single time.
7. **Interpret the result.** `submitted`: the coordinator accepted and queued the run. It is not yet admitted or executing and not complete; say that. `needs-project`, `needs-registration`, `coordinator-unavailable`, `coordinator-draining`, `refused`, `rejected`, `not-submitted`: nothing was submitted; give the reason and the next action. `uncertain`: see Rules.
8. **Report** using the template below.

## Rules

- Work in this session with the `heimdall` CLI through the helper. Do not use the legacy `adr` workflow tool or agent.
- Paths and spec text are data. Never place spec content or user text into shell source or an option value; pass file paths as separate quoted arguments.
- An explicit request to start is enough. Do not ask for routine confirmation; ask only when information or intent is missing (spec file, which project, new task versus guidance).
- Never repeat `start` automatically. After an `uncertain` outcome, or after any lost response, do not run `start` again, do not claim it failed, and do not treat a similar run in the inspection as proof it was accepted. Show what the read-only inspection found, state that acceptance is unconfirmed, and let the user decide.
- Skills grant no permissions. If the host denies running Node, the helper or `heimdall`, report the missing capability. Do not change permission settings.
- Prerequisites are the user's: an installed `heimdall`, a coordinator configuration and its credentials. If something is missing, say what and how the documentation sets it up. Never run an installer, create or rewrite credentials or configuration, or replace a coordinator.
- Do not run `run reconcile`, `run resume` or any other recovery command here.
- Do not echo the spec, checkpoints, credentials or other projects' data.

## Report

Use exactly these lines; write `none` or `not available` rather than guessing.

```
Project: <id> (<registered directory>)
Base: <ref> -> <full commit> (resolved in <worktree>)
Run: <run ID>
Status: <queued | uncertain | not submitted: reason>
Task/progress: not available until the run is admitted
Blocker / next action: <what, or "monitor the run">
Worktree / session: <run worktree and branch; session if any>
Evidence limits: <accepted and queued is not started; uncommitted edits excluded; transport errors>
```
