# OpenChamber extension

A read-only Heimdall panel for OpenChamber (version **0.1.1**). It lists
coordinator runs, shows a compact overview of each run, opens the run's existing
OpenCode sessions, and reviews the files a run changed in its managed worktree.

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

- The service only issues `GET` requests to the coordinator (projects, runs,
  events) plus a local directory-matching route. It never submits, resumes,
  reconciles, cancels or registers anything.
- The panel never creates sessions or prompts; the only host calls are listing
  projects and sessions, opening an existing session, and `writeClipboard` (the
  **Copy project folder** button copies the project's directory; it needs no
  permission).
- Review runs read-only `git` (diff, status, untracked listing) and makes no
  git mutations. File diffs are requested only for paths returned by the review
  list, and responses are size-bounded.
- Owner tokens, the coordinator key, the run specification and
  `.heimdall/managed.json` are never sent to the panel. Error text is a fixed
  vocabulary; raw paths, stacks and headers are not relayed.
- The panel renders file names and diffs as plain text.

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
| Worktree missing / mismatch (Review) | The managed worktree was removed or no longer matches the run. Diffs cannot be produced. |

## Limitations

- No resume, reconcile, cancel or submission; use the CLI.
- Usage is what the coordinator has recorded, not a live meter. Timeout is a
  warning only.
- Review is shown in the panel: OpenChamber's commit view (`openCommit`) cannot
  represent the `baseCommit` → managed worktree comparison.
- Whether OpenChamber lists managed-worktree sessions under the source project
  is unverified; see the manual check below.

## Manual verification (owner checklist, 0.1.1)

Uses completed runs. Do not stop the live coordinator. Automated tests cover
behaviour with fakes; every live UI check below is **PENDING — not yet
performed**. Record results in the
[validation record](validation/openchamber-extension.md#live-ui-verification-011).

Let `W` be a run's worktree and `B` its base commit (`run show RUN_ID`).

1. **Activate the new folder.** Build output is `dist/openchamber-extension` of
   the 0.1.1 worktree. In **Settings → Extensions** add it as a separate install
   (or switch from the 0.1.0 folder deliberately), approve sessions and the
   local service, and confirm the version is 0.1.1.
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
6. **Keyboard and themes.** Tab through summary actions, tabs and task toggles;
   Enter or Space activate them; Escape returns to the list; check light and
   dark themes. **PENDING — not yet performed.**
7. **Unchanged state.** `git -C W status --porcelain` and the run status are the
   same before and after, and no new OpenChamber sessions exist.
   **PENDING — not yet performed.**
