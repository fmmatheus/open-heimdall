# OpenChamber extension

A Heimdall panel for OpenChamber (version **0.2.0**). It lists coordinator
runs, shows a compact overview of each run, opens the run's existing OpenCode
sessions, and reviews the files a run changed in its managed worktree. It is
read-only except for two narrow owner responses: answering an approval request
and giving guidance to a paused run (see
[Answering approval requests and pauses](#answering-approval-requests-and-pauses)).

The runs list loads bounded summary pages rather than all saved checkpoints.
Full run details stay available on demand; listing never alters saved history.
A failed connection is shown as unreachable, and an oversized response has its
own message rather than claiming the coordinator stopped. Update the coordinator
and extension together; older coordinators report that the list needs an update.

## Reading a run

Selecting a run shows a compact **overview**: label, project, one status badge,
progress and current action, planner and task models, recorded usage and budget,
and when it was last updated (relative time plus your local date). Below it are
the tabs **Sessions**, **Tasks**, **Review** and **Technical details**.

- **Technical details** holds the exact UTC times, every configured and
  candidate model, the quota check, commit, branch and per-session usage.
- **Review** shows feature changes against the run's base commit. A collapsed
  **Runtime metadata (not feature changes)** group lists Heimdall and agent
  runtime files (`.heimdall`, `.omc`, and the generated `.opencode` plugin and
  agent files). They are never modified, and their contents are never shown.
- **Long text.** Task summaries, handoffs, evidence and blocker text are
  shortened in the list. Where text was shortened, a **Show full …** button
  loads more of it on demand (still read-only; up to 32,000 characters for
  summaries, handoffs and blocker text, less for titles, models and evidence
  details). If even that is cut, the panel says so. If the plan
  changed since the run was loaded, it offers **Refresh**.
- **Keyboard.** Tab reaches every control; Enter or Space activates it. Arrow
  keys move through the run list and tabs, and **Escape** returns to the run
  list. Colours follow the OpenChamber theme (light and dark).

## Answering approval requests and pauses

When the selected run waits for you, a card appears in its overview. It is
drawn from the coordinator's bounded view of the wait and is plain text only.

**Approval request.** An executor task asked for an owner decision. The card
shows the question, the scope the approval covers, the completed work, the
verification, artifact references, the reviewed revision, what the agent will do
if you approve and what it will do if you request changes, and its state:

| State | Meaning |
| --- | --- |
| Pending | Waiting for your decision. **Approve and continue** and **Request changes** are available. Leaving the panel decides nothing. |
| Approved / Changes requested | Your decision is recorded. The card shows how far it got: recorded, waiting for the run to be idle, queued (not started), the agent resumed with it, or delivered. "Queued" is never shown as running or finished. |
| Superseded | A newer request replaced it, or the reviewed material changed. It can no longer be answered; the card says how to continue from the CLI. |

- The first click on a button is the decision. There is no confirmation step.
  Buttons are disabled while a response is in flight, so a double click sends one
  response.
- **Request changes** needs non-empty feedback (at most 8000 characters). The
  agent receives it unchanged, does not perform the gated action, corrects within
  the task scope and submits a fresh request, which appears as a new card.
- Artifact references that are files offer **Show in Review**.

**Generic pause.** A paused run with no approval request shows the recorded
reason and **Respond and continue** with a text field (at most 8000 characters).
The text is delivered to the agent as owner guidance when the run continues. The
coordinator refuses it, and records nothing, unless the run is paused, released
and idle.

**Stale, offline and unconfirmed cards.** Before anything is sent, the panel
checks that the card on screen is for this run and this pending request or pause,
and that its data is current. If the connection is down, the data is stale, or
the request was replaced, nothing is sent: the panel reads the run again from
the coordinator, says why, and you choose again on the refreshed card. The
service repeats the check against the run's version, and the coordinator checks
again. If a response is sent and no answer arrives, the panel says it cannot
confirm the result, never sends it a second time on its own, and reads the run
from the coordinator, which is the source of truth. Closing and reopening the
panel, or answering with `heimdall coordinator run respond`, shows the same
recorded decision.

## Opening sessions

When OpenChamber lists them, **Open planner** (only while planning), **Open
current task** and **Open parent** appear in the overview; completed task
sessions are under **Sessions**, and each task has **Open session**. Nothing is
created: a session that OpenChamber does not list is never opened.

| Sessions state | What to do |
| --- | --- |
| Project not added | The run's project folder is not in OpenChamber. Choose **Copy project folder**, add that folder through OpenChamber's project controls, then **Refresh sessions**. |
| Discovery pending | OpenChamber is still loading sessions. Wait or **Refresh sessions**. |
| Session not discovered | OpenChamber does not list some recorded sessions yet. **Refresh sessions**. |
| Session unavailable / listing failed | Sessions could not be listed. **Refresh sessions**. |
| Permission | The sessions permission was not granted. Allow it in **Settings → Extensions**, then **Refresh sessions**. |

## Requirements

- OpenChamber **2.1.0** (web or desktop).
- A built Heimdall checkout (Node.js 22.19+, see the [README](../README.md)).
- A running [coordinator](coordinator.md). The extension never starts it; run
  `node dist/cli.js coordinator serve` separately.

## Build

```sh
npm ci --ignore-scripts && npm run build:extension
```

This writes the installable folder `dist/openchamber-extension`
(`package.json`, `panel/`, `service/`). OpenChamber does not compile anything,
so rebuild after every source change.

## Install

1. In OpenChamber open **Settings → Extensions**.
2. Paste the absolute path of `dist/openchamber-extension` (a folder install
   runs directly from that folder, so keep it in place).
3. Review the requested permissions: **sessions** (list projects and sessions,
   open an existing session) and a **local service with full user access**
   (OpenChamber does not sandbox it; it reads the coordinator key and runs
   read-only `git`).
4. Choose **Allow** and enable the extension. Open the **Heimdall** panel.

## Configuration

The service reads `~/.config/heimdall/coordinator.toml` (see
[coordinator setup](coordinator.md#setup)) to find the coordinator socket and
access key. OpenChamber does not pass `HEIMDALL_COORDINATOR_CONFIG` to guest
services, so in this milestone the coordinator must use the default
configuration location. The extension manifest also declares the default socket
`~/.local/state/heimdall/coordinator.sock` (macOS and Linux).

## Read-only guarantees and data handling

- The service reads from the coordinator with `GET` requests (projects, runs,
  events) plus a local directory-matching route. It has exactly two write
  operations, each forwarding one owner response to the same coordinator
  operation that the CLI's `run respond` uses:
  - `POST /runs/RUN_ID/approvals/REQUEST_ID/decision` with
    `{decision, feedback?, displayedVersion}`, forwarded to the coordinator's
    approval decision operation.
  - `POST /runs/RUN_ID/pause-response` with `{pauseId, input, displayedVersion}`,
    forwarded to the coordinator's guarded pause response.

  Identifiers, the decision value, the feedback and input size, and the body
  size are validated before the coordinator is contacted; every other `POST` is
  refused. There is no generic proxy, method or route choice, and the
  coordinator key and the run capability never leave the service. A response is
  recorded only by an explicit click; nothing is sent on load, poll or reopen.
- The extension never submits, pauses, stops, cancels, reconciles or registers
  runs, never resumes a run without an owner response, and does not answer native
  permission or form prompts. A run waiting on a quota, credential or permission
  problem needs that fixed outside the panel.
- The panel never creates sessions or prompts; the only host calls are listing
  projects and sessions, opening an existing session, and `writeClipboard` (the
  **Copy project folder** button copies the project's directory; it needs no
  permission).
- Review runs read-only `git` (diff, status, untracked listing) and makes no
  git mutations. The Review and Git routes stay read-only. File diffs are
  requested only for paths returned by the review list, and responses are
  size-bounded.
- Owner tokens, the coordinator key, run capabilities, the raw checkpoint, the
  run specification and `.heimdall/managed.json` are never sent to the panel.
  Error text is a fixed vocabulary; coordinator messages, raw paths, stacks and
  headers are not relayed, and the text you type is never echoed in an error.
- The panel renders file names, diffs, requests and feedback as plain text.

## States and troubleshooting

| What you see | Meaning and fix |
| --- | --- |
| Extension service has not been allowed to run | Permission not approved. **Settings → Extensions** → Allow. |
| Extension disabled, not installed or not built | Enable it, or rebuild and reinstall the folder. |
| Extension service failed to start or stopped | Restart it from **Settings → Extensions**, then Retry. |
| No coordinator connection / coordinator is not running | Start the coordinator. Panel retries automatically; stale data stays visible, marked stale. |
| Coordinator refused the credentials | Restart the coordinator so the key matches. |
| Coordinator configuration is not valid | Fix `~/.config/heimdall/coordinator.toml`. |
| Sessions states | See [Opening sessions](#opening-sessions). |
| The run changed since this card was shown | The request was replaced, the run moved on, or someone answered from the CLI. Nothing was recorded; the card refreshes to the current state. |
| Could not confirm that the response was recorded | The answer was lost. The panel reads the run again; if the request still shows as pending, the response was not recorded and you can choose again. |
| The run is not ready to continue yet | A generic pause can be answered only while the run is paused, released and idle. Retry shortly. |
| The coordinator is draining or is an older version | Responses are refused (503 or unsupported). Retry after the coordinator restarts, or update Heimdall; use the CLI meanwhile. |
| Worktree missing / mismatch (Review) | The managed worktree was removed or no longer matches the run. Diffs cannot be produced. |

## Limitations

- Besides the two owner responses above, no resume, reconcile, cancel or
  submission; use the CLI. A superseded request is continued from the CLI.
- Usage is what the coordinator has recorded, not a live meter. Timeout is a
  warning only.
- Review is shown in the panel: OpenChamber's commit view (`openCommit`) cannot
  represent the `baseCommit` → managed worktree comparison.
- Whether OpenChamber lists managed-worktree sessions under the source project
  is unverified; see the manual check below.

## Manual verification (owner checklist, 0.2.0)

Uses a disposable run, never the live coordinator's real work. Automated tests
cover behaviour with fakes and with an isolated coordinator; every live UI check
below is **PENDING — not yet performed**. Record results in a new dated record
under `docs/validation/` (earlier records are historical and are not edited).

Let `W` be a run's worktree and `B` its base commit (`run show RUN_ID`).

1. **Activate the new folder.** Build output is `dist/openchamber-extension` of
   the 0.2.0 worktree. In **Settings → Extensions** add it as a separate install
   (or switch from the earlier folder deliberately), approve sessions and the
   local service, and confirm the version is 0.2.0.
   **PENDING — not yet performed.**
2. **Overview.** Open a completed run: one status badge, models, usage, local
   date, and Technical details with exact UTC times.
   **PENDING — not yet performed.**
3. **Session opening.** Open the parent, the current (running run) and a
   completed task session. **PENDING — not yet performed.**
4. **Project-missing flow.** For a project not in OpenChamber: **Copy project
   folder**, add it, **Refresh sessions**. **PENDING — not yet performed.**
5. **Diff inspection.** In **Review**, compare the file list with
   `git -C W diff --stat B` plus untracked files; confirm `.omc` and `.heimdall`
   sit only in the collapsed runtime group; open several diffs.
   **PENDING — not yet performed.**
6. **Keyboard and themes.** Tab through summary actions, tabs, task toggles and
   the approval card's field and buttons; Enter or Space activate them; Escape
   returns to the list; check light and dark themes.
   **PENDING — not yet performed.**
7. **Unchanged state for read-only use.** For a run with no pending wait,
   `git -C W status --porcelain` and the run status are the same before and
   after viewing it, and no new OpenChamber sessions exist.
   **PENDING — not yet performed.**
8. **Approval card.** With a disposable run that submitted an approval request
   (an executor that returned an `approval-required` result), open it in the panel. The
   card shows the question, scope, completed work, verification, artifacts,
   revision and retained actions, as plain text, with the Pending state. Close
   and reopen the panel: nothing was decided and the card is unchanged. Compare
   the text with `heimdall coordinator run show RUN_ID`.
   **PENDING — not yet performed.**
9. **Approve.** Click **Approve and continue** once. The card shows the decision
   and its progress (queued or waiting for idle, never running before the agent
   resumed). `heimdall coordinator run show RUN_ID` agrees, and exactly one
   continuation is started. **PENDING — not yet performed.**
10. **Request changes.** On another request, confirm **Request changes** is
    unavailable with an empty field, enter feedback and click it. The agent
    corrects without performing the gated action and a new card with a new
    request id appears; approve that one. **PENDING — not yet performed.**
11. **Stale and CLI decisions.** Open a pending request in the panel, answer it
    with `heimdall coordinator run respond RUN_ID --request REQUEST_ID
    --decision approve`, then click a button in the panel: nothing is sent
    twice, the card refreshes and shows the CLI's decision.
    **PENDING — not yet performed.**
12. **Offline and lost response.** With a pending request on screen, stop only a
    disposable coordinator and click a button: the panel refreshes with an
    explanation and sends nothing. After it restarts the card is current again.
    **PENDING — not yet performed.**
13. **Generic pause.** For a disposable run paused by an ordinary blocker, use
    **Respond and continue** with some guidance; the card shows it queued and
    `run show` agrees. A stale card (answered elsewhere) is refused with an
    explanation. **PENDING — not yet performed.**
14. **Unchanged state after responses.** Apart from the recorded response and
    the continuation it queued, `git -C W status --porcelain` is unchanged by
    the panel, and no new OpenChamber sessions were created by it.
    **PENDING — not yet performed.**
