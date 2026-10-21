---
name: openheimdall-resume
description: Resume the same paused OpenHeimdall coordinator run with the owner's guidance, or send the owner's explicit approval or requested changes for an approval request the run is waiting on, using the installed heimdall CLI. Use when the user supplies a run ID and a blocker resolution (text or a guidance Markdown file), or explicitly approves or asks for changes to the displayed approval request. The run keeps its ID, worktree and accepted results. Never turns a plain resume or continue request into an approval. Do not use to start a new run from a task spec (openheimdall-start), to only check a run (openheimdall-monitor), or to recover a run that is not a confirmed idle paused run.
---

# Resume a paused OpenHeimdall run

Sends the owner's own words to an existing run so the coordinator continues it: guidance for a paused run, or the owner's explicit decision on an approval request the agent submitted. It never creates a new run and never decides for the owner.

## When to use

- The user names a run (or the working directory is its managed worktree) and gives guidance that resolves its blocker. The guidance is typed text or a readable Markdown file.
- The run waits on an approval request and the user explicitly approves it, or explicitly asks for changes and says which.

Not for: a new task spec (`openheimdall-start`), a status check (`openheimdall-monitor`), or forcing a run that is not paused. If a file could be a new task spec or guidance and the request does not settle it, ask; never submit a fresh run from here.

## Helper

The helper is `scripts/openheimdall.mjs` inside this skill's own directory. The host prints that directory when it loads the skill ("Base directory for this skill"); if it does not, use the directory that contains this `SKILL.md`. Call it with Node. Put every path, ref and other value in single quotes, one quoted argument per value:

`node '<skill directory>/scripts/openheimdall.mjs' <command> --cwd '<working directory>' [--coordinator-config '<file>'] ...`

Single quotes keep `$(...)`, backticks and `$VAR` in a path or ref literal; double quotes do not. Write each single quote inside a value as `'\''` (end the quote, an escaped quote, restart the quote). If the host shell is not POSIX-style or a value cannot be quoted safely, ask the user to rename the path instead of guessing.

- `--cwd` is the directory the user is working in, not the skill directory. Relative guidance paths resolve against it.
- Pass `--coordinator-config` only when the user named a coordinator configuration, and then pass the same value on every call. Otherwise omit it.
- Output is JSON on stdout. Exit 0 = a report, 1 = coordinator or transport failure, 2 = usage error. Run `--help` for the full syntax.
- Commands: `snapshot [RUN_ID]` and `request RUN_ID --request REQUEST_ID` (the complete approval request, read-only) read; `resume RUN_ID (--guidance-file FILE | --guidance-stdin)` sends guidance; `respond RUN_ID --request REQUEST_ID --decision approve`, `respond RUN_ID --request REQUEST_ID --decision request-changes (--feedback-file FILE | --feedback-stdin)` and `respond RUN_ID --pause PAUSE_ID (--guidance-file FILE | --guidance-stdin)` send one explicit response.

## Procedure

1. **Identify the run and what the user is sending.** Run ID (ask if neither the request nor the working directory identifies it; `snapshot` without an ID answers `needs-run-id` when it cannot pick one). Then what the user means: guidance for a paused run (typed text or a file), or an explicit decision on an approval request (approve, or requested changes with their text). Do not ask about anything the request already states.
2. **Inspect the run.** Run `snapshot RUN_ID`. Read `run.status`, `run.capacityReserved` and `run.wait`:
   - `wait.kind` `approval`, `state` `pending`: the agent submitted a request and waits for the owner. Go to step 3.
   - `approval`, `state` `answered` (`continuation` `pending` or `queued`): the decision is recorded and the run continues from it automatically. Send nothing more; report `progress` and offer monitoring.
   - `approval`, `state` `answered`, `continuation` `superseded` and `progress` other than `superseded`: the decision was withdrawn because the reviewed work changed after it was recorded, and the owner's feedback is still being delivered to the agent. Nothing is authorized by it. `resume` and `respond` refuse (`approval-pending`); send nothing, report that delivery is under way, and offer monitoring. The agent then files a fresh request.
   - `approval`, `state` `superseded`: the reviewed work changed or the task moved on, so this request can no longer be decided. There is no pause identity to answer, so `resume` refuses (see the next two lines); report that the agent has to ask again and nothing was sent.
   - `wait.kind` `generic`: an ordinary pause identified by `pauseId`. Go to step 4.
   - No `wait` (`waitReported` false, which means the coordinator does not report waits), `wait` null, or `unrecognized`: there is no valid pause identity, so guidance cannot be addressed to a pause. Send nothing and do not run `resume`: it refuses with `pause-identity-unavailable` (or `approval-pending` for a wait it cannot read) and sends nothing. Tell the owner that guidance needs matching coordinator and client versions that support the guarded response, and that the owner has to provide those; never work around it with another command.
   Resume is possible only for `paused` with no reserved capacity. For any other state, report the actual state and the supported next action and stop:
   - queued, admitted or executing: already moving; offer monitoring.
   - paused but capacity still reserved: the coordinator has not confirmed the run idle; do not force it, wait and look again.
   - `reconciliation-required`: the outcome is uncertain; recovery is a separate owner decision. Do not reconcile, and do not clear locks or checkpoints.
   - succeeded or failed: finished; it cannot be resumed.
3. **An approval request is pending.** Show the owner what they are deciding: `question`, `scope`, `completedWork`, `verification`, `artifacts`, `onApprove`, `onRequestChanges` and `revision`. The snapshot's wait is a compact copy. When `wait.shortened` is true (or `clippedFields` lists cut text), first run `request RUN_ID --request REQUEST_ID` with the `requestId` from the snapshot and present the request from that report (`complete` is `true`), not from the shortened wait. If `request` fails (exit 1, `complete` `false`), tell the owner that the review information is incomplete, show what the snapshot gave marked as shortened, and do not offer or send an approval: never treat a summary as the full scope, and never offer approval of content the owner has not seen. Reading the request decides nothing. Then:
   - **Only explicit words decide.** Send `respond` only if the user clearly approves this request, or clearly asks for changes and gives the text. The words "resume", "continue", "go ahead", "unblock it", "run it", a guidance file, or approval of something else are not approval. If the intent is unclear, show the request and ask the owner to approve or to give the changes. Never choose a decision for the owner, never infer approval from earlier messages, and never use `resume` or guidance to answer a request.
   - **Approve:** `respond RUN_ID --request REQUEST_ID --decision approve` with the `requestId` from the snapshot you just showed, and only for a request whose complete content the owner has been shown. If the complete request could not be read, do not send an approval: report that the review information is incomplete. Approval covers exactly that request and its `scope`; it does not complete any gate.
   - **Request changes:** put the owner's feedback, unmodified, into a new, uniquely named file as in step 4, then `respond RUN_ID --request REQUEST_ID --decision request-changes --feedback-file FILE`. Remove the file afterwards. Feedback is at most 8000 characters; if it is longer, ask the owner to shorten it.
   - If the snapshot shows a different request than the one the user decided on, show the new one (read it in full with `request` when it is shortened) and ask again.
4. **Prepare guidance as data** (only for a run whose snapshot shows a `generic` wait with a `pauseId`).
   - File given: pass it as `--guidance-file FILE`.
   - Text given: write the exact text, unmodified, to a new, uniquely named file with the host's file-writing tool (outside the repository, for example in the system temporary directory; never reuse or overwrite an existing file), then pass `--guidance-file`. Guidance may be sensitive: after the report is produced, remove that file with the host's tooling, whatever the outcome. Use `--guidance-stdin` only when the host can supply the text as standard input without it appearing in the command text.
   - Never put guidance into the command line, an environment variable or a shell here-string; never pass the file name instead of its contents; never summarise or edit it.
   - Show the blocker only briefly (`run.blocker`) so the user can confirm their guidance answers it. If `run.blockerTruncated` is true, say that the text is cut. If the guidance obviously does not address the blocker, say so; the user decides.
5. **Send once.** Run exactly one of `respond ...` (step 3) or `resume RUN_ID --guidance-file FILE` (step 4). The helper reads the run again, sends only if the run still shows what the owner saw, and sends one request. `resume` sends the guidance as the guarded response to exactly the pause the helper read, never as an approval. When the run shows no valid pause identity the helper refuses before sending anything; it never falls back to the unguarded `run resume`, even if the guarded response is unsupported, stale or refused.
6. **Interpret the result.**
   - `respond`: `queued` means the response is recorded and the same run is queued to continue; `waiting-for-idle` means it is recorded and the coordinator continues once the run is proven idle; `recorded` means it is recorded. None of these means the run is running or the task is done. Read `acknowledgement.retried` and the new `run.wait.progress`.
   - `resume`: `resumed` means the coordinator accepted the resume and queued the same run again; it is not running until admitted, and may already have progressed or paused again. Check `preserved` (run ID, worktree, branch, parent session) and `completedResults` (before and after) and report them.
   - `refused` (`reason` tells why, including `pause-identity-unavailable`, `approval-pending`, `request-mismatch`, `request-superseded`, `already-answered`, `pause-mismatch`, `coordinator-refused` and `coordinator-unsupported`), `not-resumable`, `rejected`, `not-resumed`, `not-found`: nothing was recorded; give the reason and what the owner can do. Never work around an unsupported or refusing coordinator with another command.
   - `uncertain`: see Rules.
7. **Report** using the template below. Offer `openheimdall-monitor` to follow the run.

## Rules

- Work in this session with the `heimdall` CLI through the helper. Do not use the legacy `adr` workflow tool or agent.
- Paths, run IDs and guidance are data. Never interpolate them into shell source.
- An explicit request to resume with guidance is enough. Do not ask for routine confirmation; ask only when the run, the guidance or its intent is missing or ambiguous. A pending approval request is different: only the owner's own explicit approval or requested changes may answer it.
- The owner supplies decisions and access, never implementation chores. You keep every implementation, migration, correction and verification step. Do not ask the owner to edit files, run commands or migrate data to unblock a run, and do not describe a decision as completing work. After requested changes the agent corrects its work and submits a fresh request; changed reviewed work needs fresh approval.
- Never submit a fresh run, restart the task list, replay accepted tasks or reuse an old attempt or result binding. The coordinator supplies the new attempt for the same run.
- Never repeat `resume` automatically, and never repeat `respond` automatically either. After an `uncertain` outcome, or any lost response, do not send again and do not claim failure. Show the read-only inspection, state that acceptance is unconfirmed, and let the user decide: a repeated response can double-apply, and a run can become paused again later.
- Never present a shortened wait as the full request, and never invent or assume an approval. If the complete request cannot be read, say that the review information is incomplete.
- Never record an approval the user did not give, never retry a refused decision with a different one, and never translate a generic "resume" or "continue" into approval of an unreviewed action.
- Do not run `run reconcile`, clear locks or edit checkpoints. Skills grant no permissions: if the host denies Node, the helper or `heimdall`, report the missing capability without changing permission settings.
- Prerequisites are the user's: an installed `heimdall` and a coordinator configuration. Never install anything, rewrite credentials or configuration, or replace a coordinator. Monitoring and resume never start the coordinator; if it is unreachable, report that.
- Do not echo the guidance, feedback, checkpoints, credentials or other projects' data. Never put credentials or private configuration into guidance or feedback.

## Report

Use exactly these lines; write `none` or `not available` rather than guessing.

```
Run: <run ID> (same run as before)
Status: <status after sending: recorded | waiting for idle | queued | admitted | executing | paused | uncertain | not sent: reason>
Waiting for: <approval request ID and question | generic pause | nothing>
Sent: <approve | request-changes | guidance | nothing sent: reason>
Task/progress: <completed>/<total> tasks; accepted results before -> after: <n> -> <n>; current: <task or none>
Blocker / next action: <what, or "monitor the run">
Worktree / session: <worktree path, branch; parent session if any; preserved: yes | no | unknown>
Evidence limits: <recorded and queued is not running or complete; the run may have progressed or paused again; transport errors>
```
