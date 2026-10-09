# OpenChamber extension

A read-only Heimdall panel for OpenChamber. It lists coordinator runs, shows a
run's tasks, models, usage and limits, opens the run's existing OpenCode
sessions, and reviews the files a run changed in its managed worktree.

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
  projects and sessions and opening an existing session.
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
| Project not added | The run's project is not in OpenChamber. Add its directory (shown as copyable text) through OpenChamber's project UI. |
| Session not discovered | OpenChamber has not listed the managed-worktree sessions yet. Use **Refresh sessions**; nothing is opened or created until listed. |
| Worktree missing / mismatch (Review) | The managed worktree was removed or no longer matches the run. Diffs cannot be produced. |

## Limitations

- No resume, reconcile, cancel or submission; use the CLI.
- Usage is what the coordinator has recorded, not a live meter. Timeout is a
  warning only.
- Review is shown in the panel: OpenChamber's commit view (`openCommit`) cannot
  represent the `baseCommit` → managed worktree comparison.
- Whether OpenChamber lists managed-worktree sessions under the source project
  is unverified; see the manual check below.

## Manual verification (owner checklist)

Uses the existing completed `test_app` run. Do not stop the live coordinator.
Automated tests cover behaviour with fakes; every live UI check below is
**PENDING — not yet performed**.

Let `W` be the run's worktree and `B` its base commit (`run show RUN_ID`).

1. Build in a separate checkout: `npm ci --ignore-scripts && npm run build:extension`.
   **PENDING — not yet performed.** Expect `dist/openchamber-extension` with
   `package.json`, `panel/index.html`, `panel/main.js`, `service/main.js`.
2. Install the folder (steps above) and approve the permissions.
   **PENDING — not yet performed.** Expect the Heimdall panel to load.
3. Offline messaging: only if the coordinator is already down, expect "No
   coordinator connection" with start guidance. Otherwise skip.
   **PENDING — not yet performed.**
4. Record `git -C W status --porcelain` and the `test_app` run status before
   continuing. **PENDING — not yet performed.**
5. Find the `test_app` run using the project and status filters.
   **PENDING — not yet performed.**
6. Verify the label, status **succeeded**, completed/total tasks, models,
   usage and limits against `run show RUN_ID`.
   **PENDING — not yet performed.**
7. If the panel says the project is not added, add the `test_app` directory via
   OpenChamber's project UI, then Refresh. **PENDING — not yet performed.**
8. Open the parent session and a completed task session. Expect the existing
   sessions to open. If not listed, expect "session not discovered" guidance
   (this is the H4 check). **PENDING — not yet performed.**
9. Open **Review**. Expect the changed files to equal
   `git -C W diff --stat B` plus `git -C W ls-files --others --exclude-standard`
   (Heimdall runtime files appear in a separate generated group).
   **PENDING — not yet performed.**
10. Open several diffs, including any binary, deleted or large file, and
    compare with `git -C W diff B -- <path>`. **PENDING — not yet performed.**
11. Re-run `git -C W status --porcelain`; expect identical output to step 4.
    **PENDING — not yet performed.**
12. Confirm no new OpenChamber sessions were created and the run status is
    unchanged (`run show RUN_ID`). **PENDING — not yet performed.**
