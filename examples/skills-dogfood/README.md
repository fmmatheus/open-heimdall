# Skills dogfood example

> **Owner-operated. Status: PENDING.** Nothing in this directory has been run
> against a live OpenCode, OpenChamber or coordinator. Automated tests do not
> cover it. Treat the outcome below as unknown until you have observed it and
> recorded the result.

A small, portable exercise for the [OpenHeimdall skills](../../docs/skills.md).
It starts a run from a spec through `openheimdall-start`, follows it with
`openheimdall-monitor` until it pauses for a choice only you can make, answers it
through `openheimdall-resume` and checks that the run kept its first result.

| File | Purpose |
| --- | --- |
| [`task-spec.md`](task-spec.md) | The task spec. Task 1 adds `dogfood/hello.txt`. Task 2 must stop and ask which output format (`plain` or `json`) to use. |
| [`guidance.md`](guidance.md) | The answer to that question, given to the resume skill as a file. |

The tasks only add two small files under `dogfood/` in the project you choose, so
use a disposable repository. The spec is plain Markdown with no personal paths.

## Before you start

1. Install and configure Heimdall ([installation](../../docs/installation.md)),
   start the coordinator and check `heimdall coordinator status`.
2. Use a disposable Git project with at least one commit and a valid project
   configuration (`heimdall setup` from the project writes one). Keep it clean:
   uncommitted changes are not part of a run.
3. Install the three skills for your host ([OpenCode](../../docs/skills.md#install-for-opencode)
   or [OpenChamber](../../docs/skills.md#install-in-openchamber-210)) and confirm the IDs
   are listed.
4. Find the example files in the installed package and copy them somewhere
   outside the project, so the spec is not part of the repository being changed:

   ```sh
   EXAMPLE="$(npm root -g)/@open-heimdall/core/examples/skills-dogfood"
   mkdir -p /tmp/skills-dogfood
   cp "$EXAMPLE/task-spec.md" "$EXAMPLE/guidance.md" /tmp/skills-dogfood/
   ```

5. Open the host in the disposable project's directory and allow the session to
   run `node` and `heimdall`. If you use a non-default coordinator configuration,
   name its file in each request below.

## Steps

Phrase the requests in your own words; the wording below is an example.

1. **Start the run.** Ask: "Use `@openheimdall-start` to start a run from
   `/tmp/skills-dogfood/task-spec.md` in this project." Answer its questions about
   the project or registration if it asks. Expect a report with `Status: queued`
   and a run ID. Write the run ID down; this is `RUN_ID` below. If the report says
   the outcome is uncertain, do not ask for another start; look at `heimdall
   coordinator run list` first.
2. **Monitor until it pauses.** Ask: "Use `@openheimdall-monitor` to watch run
   `RUN_ID`." Repeat, or ask for a longer watch, until the report shows
   `Status: paused`. Expected: the run is admitted, task 1 completes (progress
   `1/2`), and task 2 stops with a question about the output format. The planner may
   word or split the tasks differently from the spec; record what you see.
3. **Record the state before resuming.** From the monitor report (or `heimdall
   coordinator run show RUN_ID`) note: the run ID, the worktree path, the branch
   (`heimdall/run/RUN_ID`), the completed-task count, and the commit that added
   `dogfood/hello.txt` (`git -C WORKTREE log --oneline -- dogfood/hello.txt`).
4. **Resume with the guidance file.** Ask: "Use `@openheimdall-resume` to resume
   run `RUN_ID` with the guidance in `/tmp/skills-dogfood/guidance.md`." Expect a
   `resumed` report that lists the preserved run ID, worktree and branch and the
   completed-results counts before and after. It is queued, not yet running.
5. **Monitor to the end.** Use the monitor skill again until the run is
   `succeeded`, or until it pauses again or fails; record which.
6. **Verify what was kept.** Compare with step 3:
   - the run ID is the same, and `heimdall coordinator run list` shows no additional
     run created by the resume;
   - the worktree path and branch are unchanged;
   - the completed-results count did not go down (it was 1 at the pause), and the
     commit for `dogfood/hello.txt` is still in the branch history, unchanged;
   - on success, `dogfood/format.txt` contains `json` and `dogfood/hello.txt` is
     untouched (`git -C WORKTREE show HEAD --stat` and `cat` the two files).

## What to record

Fill in after observing. Nothing here has been observed yet.

| Item | Observed |
| --- | --- |
| Host and version | PENDING |
| Start report (run ID, status) | PENDING |
| Planner task list (two tasks as specified?) | PENDING |
| Pause observed with the format question (yes or no) | PENDING |
| Before resume: run ID, worktree, branch, completed count, task 1 commit | PENDING |
| After resume: same run ID, worktree, branch; completed count not lower; task 1 commit unchanged | PENDING |
| Final status and contents of `dogfood/format.txt` | PENDING |
| Deviations or surprises | PENDING |

## If something differs

- The run does not pause: the executor chose a format itself instead of asking.
  Record it; the spec relies on the model following its instructions.
- The report says `uncertain`: acceptance is unconfirmed. Inspect with the monitor
  skill or `heimdall coordinator run show`; do not repeat the start or the resume
  until you know what happened.
- The resume skill reports the run as not resumable: it only resumes a run that is
  paused with no reserved capacity. Wait and look again, or see
  [Lifecycle and recovery](../../docs/coordinator.md#lifecycle-and-recovery).

## Cleaning up

The managed worktree and branch remain for inspection after the run, as with any
Heimdall run. Remove them with your usual Git commands when you no longer need
them, and delete `/tmp/skills-dogfood`.
