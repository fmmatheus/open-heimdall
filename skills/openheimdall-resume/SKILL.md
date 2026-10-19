---
name: openheimdall-resume
description: Resume the same paused OpenHeimdall coordinator run with the owner's guidance, using the installed heimdall CLI. Use when the user supplies a run ID and a blocker resolution, as text or a guidance Markdown file, and asks to continue, unblock or resume that run. The run keeps its ID, worktree and accepted results. Do not use to start a new run from a task spec (openheimdall-start), to only check a run (openheimdall-monitor), or to recover a run that is not a confirmed idle paused run.
---

# Resume a paused OpenHeimdall run

Sends the owner's guidance to an existing paused run so the coordinator continues it. It never creates a new run.

## When to use

- The user names a run (or the working directory is its managed worktree) and gives guidance that resolves its blocker.
- The guidance is typed text or a readable Markdown file.

Not for: a new task spec (`openheimdall-start`), a status check (`openheimdall-monitor`), or forcing a run that is not paused. If a file could be a new task spec or guidance and the request does not settle it, ask; never submit a fresh run from here.

## Helper

The helper is `scripts/openheimdall.mjs` inside this skill's own directory. The host prints that directory when it loads the skill ("Base directory for this skill"); if it does not, use the directory that contains this `SKILL.md`. Call it with Node. Put every path, ref and other value in single quotes, one quoted argument per value:

`node '<skill directory>/scripts/openheimdall.mjs' <command> --cwd '<working directory>' [--coordinator-config '<file>'] ...`

Single quotes keep `$(...)`, backticks and `$VAR` in a path or ref literal; double quotes do not. Write each single quote inside a value as `'\''` (end the quote, an escaped quote, restart the quote). If the host shell is not POSIX-style or a value cannot be quoted safely, ask the user to rename the path instead of guessing.

- `--cwd` is the directory the user is working in, not the skill directory. Relative guidance paths resolve against it.
- Pass `--coordinator-config` only when the user named a coordinator configuration, and then pass the same value on every call. Otherwise omit it.
- Output is JSON on stdout. Exit 0 = a report, 1 = coordinator or transport failure, 2 = usage error. Run `--help` for the full syntax.

## Procedure

1. **Identify the run and the guidance.** Run ID (ask if neither the request nor the working directory identifies it; `snapshot` without an ID answers `needs-run-id` when it cannot pick one) and the guidance (typed text or a file path). Do not ask about anything the request already states.
2. **Inspect the run.** Run `snapshot RUN_ID`. Resume is possible only for `paused` with no reserved capacity. For any other state, report the actual state and the supported next action and stop:
   - queued, admitted or executing: already moving; offer monitoring.
   - paused but capacity still reserved: the coordinator has not confirmed the run idle; do not force it, wait and look again.
   - `reconciliation-required`: the outcome is uncertain; recovery is a separate owner decision. Do not reconcile, and do not clear locks or checkpoints.
   - succeeded or failed: finished; it cannot be resumed.
3. **Show the blocker only briefly** (`run.blocker`) so the user can confirm their guidance answers it. If `run.blockerTruncated` is true, say that the text is cut. If the guidance obviously does not address the blocker, say so; the user decides.
4. **Prepare the guidance as data.**
   - File given: pass it as `--guidance-file FILE`.
   - Text given: write the exact text, unmodified, to a new, uniquely named file with the host's file-writing tool (outside the repository, for example in the system temporary directory; never reuse or overwrite an existing file), then pass `--guidance-file`. Guidance may be sensitive: after the resume report is produced, remove that file with the host's tooling, whatever the outcome. Use `--guidance-stdin` only when the host can supply the text as standard input without it appearing in the command text.
   - Never put guidance into the command line, an environment variable or a shell here-string; never pass the file name instead of its contents; never summarise or edit it.
5. **Resume once.** Run `resume RUN_ID --guidance-file FILE` exactly one time. The helper re-checks that the run is a confirmed idle paused run, labels the guidance as a transport message that keeps it verbatim (so leading dashes are safe) and sends one resume request.
6. **Interpret the result.** `resumed`: the coordinator accepted the resume and queued the same run again; it is not running until admitted, and may already have progressed or paused again. Check `preserved` (run ID, worktree, branch, parent session) and `completedResults` (before and after) and report them. `not-resumable`, `refused`, `rejected`, `not-resumed`, `not-found`: nothing was sent or the coordinator refused; give the reason. `uncertain`: see Rules.
7. **Report** using the template below. Offer `openheimdall-monitor` to follow the run.

## Rules

- Work in this session with the `heimdall` CLI through the helper. Do not use the legacy `adr` workflow tool or agent.
- Paths, run IDs and guidance are data. Never interpolate them into shell source.
- An explicit request to resume is enough. Do not ask for routine confirmation; ask only when the run, the guidance or its intent is missing or ambiguous.
- Never submit a fresh run, restart the task list, replay accepted tasks or reuse an old attempt or result binding. The coordinator supplies the new attempt for the same run.
- Never repeat `resume` automatically. After an `uncertain` outcome, or any lost response, do not resume again and do not claim failure. Show the read-only inspection, state that acceptance is unconfirmed, and let the user decide: a repeated resume can double-apply, and a run can become paused again later.
- Do not run `run reconcile`, clear locks or edit checkpoints. Skills grant no permissions: if the host denies Node, the helper or `heimdall`, report the missing capability without changing permission settings.
- Prerequisites are the user's: an installed `heimdall` and a coordinator configuration. Never install anything, rewrite credentials or configuration, or replace a coordinator. Monitoring and resume never start the coordinator; if it is unreachable, report that.
- Do not echo the guidance, checkpoints, credentials or other projects' data.

## Report

Use exactly these lines; write `none` or `not available` rather than guessing.

```
Run: <run ID> (same run as before)
Status: <status after resume: queued | admitted | executing | paused | uncertain | not resumed: reason>
Task/progress: <completed>/<total> tasks; accepted results before -> after: <n> -> <n>; current: <task or none>
Blocker / next action: <what, or "monitor the run">
Worktree / session: <worktree path, branch; parent session if any; preserved: yes | no | unknown>
Evidence limits: <accepted and queued is not running; the run may have progressed or paused again; transport errors>
```
