# OpenChamber extension validation

Automated verification of the read-only Heimdall extension for OpenChamber 2.1.0
(guide: [openchamber-extension.md](../openchamber-extension.md)). This record has
a section for version 0.1.1 (feature 0002) followed by the unchanged 0.1.0
history (feature 0001).

**Status (0.1.1): automated checks PASSED. Live OpenChamber UI checks are PENDING (owner).**
Mocked and synthetic tests do not prove live OpenChamber behavior.

## Version 0.1.1

### Environment (0.1.1)

| Item | Value |
| --- | --- |
| Date | 2026-10-09 |
| Verified code | `8a1286c` (`Load long Heimdall task content on demand`) plus the working tree of the final 0.1.1 commit (`Polish OpenChamber extension usability and record 0.1.1 verification`), which adds only the usability pass, the version bump, tests and these docs |
| Branch | `heimdall/run/88407fbc-3d6a-48fc-9997-fe6f1db1ac58` |
| Node.js | v22.22.3 |
| OS | macOS 27.0.1 (Darwin, arm64) |
| `@openchamber/sdk` / `esbuild` / `typescript` | 2.1.0 / 0.28.2 / 7.0.2 (exact devDependencies, unchanged) |

Nothing was installed into the running OpenChamber; the live coordinator, its
key and database were never contacted. Fixtures are temp directories, temp git
repositories and temp coordinators.

### Command results (0.1.1)

| Command | Result |
| --- | --- |
| `npm run check` | exit 0 (`tsc --noEmit`) |
| `npm test` | exit 0, **364 tests, 364 pass, 0 fail, 0 skipped, 0 cancelled** (builds with `tsc` first) |
| `npm run build:extension` | exit 0; `dist/openchamber-extension/` = `package.json` (941 B), `panel/index.html` (7,797 B), `panel/main.js` (193,538 B), `service/main.js` (94,245 B) |

Extension test files: `extension-build` 2, `extension-navigation` 21,
`extension-panel-store` 25, `extension-panel-view` 53, `extension-projection` 30,
`extension-review-view` 29, `extension-review` 12, `extension-service` 10,
`extension-smoke` 1 (all pass). The first full run after adding the version
assertion failed once (the SDK-parsed manifest has no `version`; the test now reads
the built `package.json`); the rerun is the result above.

### Manifest check (0.1.1)

One-off script (not in the repo) using SDK 2.1.0 `parseManifestJson`
(`dist/schemas.js`) and `hostMeetsOpenChamberEngine` (`dist/host-version.js`)
against `dist/openchamber-extension/package.json`:

- `ok: true`, `version` **0.1.1**, `apiVersion` 1, capabilities `["sessions"]`.
- Panel `heimdall` (`panel/index.html`); service `service/main.js`, `runtime: "host"`,
  permissions unchanged from 0.1.0: `exec: ["git"]` and the `coordinator` socket
  with the darwin/linux candidate `~/.local/state/heimdall/coordinator.sock`.
- `engines.openchamber` `>=2.1.0`: `hostMeetsOpenChamberEngine('2.1.0', '>=2.1.0')`
  is `true`, `('2.0.0', '>=2.1.0')` is `false`.

### Security sweep (0.1.1)

Existing pattern: `innerHTML|outerHTML|insertAdjacentHTML|document\.write|startSession|prompt\(|compose\(|sessionLink|generate\(|writeFile|/reconcile|/resume|ownerToken|coordinator\.key|node:sqlite`,
plus `openSurface|openUrl|openchamber://`.

| Target | Hits | Justification |
| --- | --- | --- |
| `src/extension` (existing pattern) | 1: `service/coordinator.ts:7` `Omit<RunRecord, 'ownerToken' | …>` | Type that removes the owner token; no value is read. |
| `src/extension` (`openSurface|openUrl|openchamber://`) | 0 | Never used. |
| `src/extension` (`writeClipboard`) | `navigation.ts` only: the `NavigationHost` type and one call `host.writeClipboard(directory)` | Added for **Copy project folder**. Needs no capability (SDK API.md: "Copy in the host", 1–32000 characters). It copies only the project's directory, which the panel also shows as selectable text; the call is skipped for an unknown, empty or oversized directory (`test/extension-navigation.test.mjs`). |
| `dist/…/panel/index.html` | 0 | |
| `dist/…/panel/main.js` | `startSession`, `sessionLink`, `writeFile`, `openSurface`, `openUrl`: 1 each; `writeClipboard`: 2; `openchamber://`, `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `prompt(`, `compose(`, `generate(`: 0 | The first five are method *definitions* in the bundled `@openchamber/sdk` host client (lines 748–900); our sources reference none of them (static test `NAV_FORBIDDEN` plus recorded-host tests). `writeClipboard` is the SDK definition plus our single call (line 2443). |
| `dist/…/service/main.js` | `ownerToken` 2, `coordinator.key` 2; `openSurface`, `openUrl`, `openchamber://`, `writeClipboard`, `node:sqlite`: 0 | Unchanged from 0.1.0: the shared client's optional owner-token argument is never passed by the adapter, and `coordinator.key` is the legitimate key read. |

The service still issues only `GET` requests to the coordinator; the new
`/runs/:id/tasks/:index` and `/runs/:id/blocker` routes are GET-only
(`test/extension-projection.test.mjs`, `test/extension-smoke.test.mjs`).

### Usability and accessibility evidence (0.1.1)

Static checks (no DOM library is used; rendered interaction cannot be driven in
Node, so keyboard/theme behaviour remains an owner check):

- `test/extension-panel-view.test.mjs` "panel stylesheet defines visible focus
  styles from host theme variables": `:focus-visible` rules for details
  summaries, the copy-path block, the diff region and buttons, all using
  `var(--oc-focus, currentColor)`.
- Same file, "panel stylesheet uses no hard-coded colours outside var(--oc-*)
  fallbacks" (and `overflow-wrap: anywhere` for ids, paths and models).
- Same file, "interactive controls have accessible names, aria-expanded, live
  feedback and an Escape path": toggles named with their task or blocker,
  `aria-expanded`/`aria-controls`, `role=status`/`alert` for feedback, Escape
  → `goBack()`, focus kept on the selected tab, focusable copy and diff regions.
- "panel sources never assign HTML or write documents" still passes.

### ADR 0002 acceptance criteria evidence

| Acceptance criterion | Evidence | Result |
| --- | --- | --- |
| Overview shows one status, no duplicated model/candidate rows, no irrelevant "No attempt recorded" on a completed run; Technical details keep the recorded information | `test/extension-panel-view.test.mjs`: "succeeded run summary: one status label, no model plumbing, no attempt text", "Technical details keep configured, fallback and candidate models, quota time, commit, branch and sessions", "no attempt row for finished runs; shown only while preparing or running", "detail tabs: sessions, tasks, review, technical details; sessions is the default", friendly-model and local-time tests | Automated PASS; live check 2 PENDING |
| Planner/current/completed sessions open the correct existing ids; missing projects/sessions give accurate guidance; no creation, prompt or registration fallback | `test/extension-navigation.test.mjs`: "planner target opens the existing planner session only while planning", "completed task targets are keyed by task id…", "session targets…", project-not-added / discovering / discovery-failed / session-not-discovered / host-failure tests, "copy project folder…" (2 tests), "Refresh re-runs only…", "viewing a run is read-only…", "the navigation module names no forbidden host method"; `extension-panel-view` wiring tests; sweep above | Automated PASS (mocked host); live checks 3–4 PENDING |
| Review separates feature changes from `.omc` and runtime artifacts, incl. committed changes on a clean worktree and genuine untracked code; state unchanged | `test/extension-review.test.mjs` ("isGeneratedPath treats only top-level .omc as runtime metadata", real temp-git review, clean-worktree case, state snapshot, `.omc` file view empty); `test/extension-review-view.test.mjs` (collapsed runtime group, counts); `test/extension-smoke.test.mjs` (real coordinator-created worktree with `.omc`) | Automated PASS; live check 5 PENDING |
| Long content has a bounded inspection path or an explicit limit; no instruction to inspect raw saved state | `test/extension-projection.test.mjs` (per-field shortened flags, content routes strictly longer than the detail clip yet < 200000 bytes, no secrets); `test/extension-panel-store.test.mjs` (on-demand, once per detail, exact paths, stale ignored); `test/extension-panel-view.test.mjs` ("toggling reveals the loaded text with its tail…", "incomplete content states the limit…", "the shortened-text notice names what was cut…"); `test/extension-smoke.test.mjs` (built service) | Automated PASS |
| Tests exercise these behaviours; existing checks, tests and `npm run build:extension` pass in the new worktree | Command results above (364/364, exit 0 for check, test and build:extension) | PASS |
| Record automated results; short owner checklist; live results pending until observed | This record; [guide checklist](../openchamber-extension.md#manual-verification-owner-checklist-011); live table below | Documented; execution PENDING |
| Return the new installable folder; leave the installed build and its worktree intact | Folder: `<this worktree>/dist/openchamber-extension` (0.1.1). Read-only check of the old worktree's `dist/openchamber-extension`: `package.json` `"version": "0.1.0"`; mtimes of the folder, `package.json` and `panel/main.js` are `2026-10-09T16:07:05-0300`, before this feature's first commit (16:50) and this task's build (19:39); the folder was only read with `stat` and `cat` | PASS |

### Live UI verification (0.1.1)

**All items are PENDING — not yet performed.** Builds and mocked hosts are not
live evidence. Step numbers refer to the guide's
[0.1.1 checklist](../openchamber-extension.md#manual-verification-owner-checklist-011).

| # | Check | Status | Observed |
| --- | --- | --- | --- |
| 1 | Activate the new folder (separate install or deliberate switch from 0.1.0), approve sessions and the local service, version shows 0.1.1 | PENDING | |
| 2 | Overview: one status, models, usage, local date; Technical details with exact UTC | PENDING | |
| 3 | Session opening: parent, current (running run) and completed task session | PENDING | |
| 4 | Project-missing flow: Copy project folder, add it, Refresh sessions (also H4: managed-worktree sessions listed under the source project) | PENDING | |
| 5 | Diff inspection: file list vs `git -C W diff --stat B` plus untracked; `.omc`/`.heimdall` only in the collapsed runtime group; several diffs | PENDING | |
| 6 | Keyboard (Tab, Enter/Space, Escape) and light and dark themes | PENDING | |
| 7 | `git -C W status --porcelain` and run status unchanged; no new sessions | PENDING | |

Owner steps: (a) in OpenChamber **Settings → Extensions** add
`<this worktree>/dist/openchamber-extension` as a separate install, or switch from
the 0.1.0 folder deliberately (that folder and its worktree are left intact);
approve sessions and the local service; confirm version 0.1.1. (b) Follow the
guide's 0.1.1 checklist with completed runs. (c) Replace each PENDING above with
PASS/FAIL and observations.

---

## Version 0.1.0 (history, feature 0001)

### Environment (0.1.0)

| Item | Value |
| --- | --- |
| Date | 2026-10-09 |
| Verified code | `52eec27` (`Document OpenChamber extension`); the validation commit adds only this record and `test/extension-smoke.test.mjs` |
| Branch | `heimdall/run/5907b2db-f21a-429b-bcf4-47b7ae27b472` |
| Node.js | v22.22.3 |
| OS | macOS 27.0.1 (Darwin, arm64) |
| `@openchamber/sdk` / `esbuild` | 2.1.0 / 0.28.2 (exact devDependencies) |

Nothing was installed into the running OpenChamber, and the live coordinator,
its key and database were never contacted. All fixtures are temp directories,
temp git repositories and temp coordinators.

### Command results (0.1.0)

| Command | Result |
| --- | --- |
| `npm ci --ignore-scripts` | exit 0, 402 packages added (engine warnings come from the OpenCode toolchain dependency, `npm audit` findings are pre-existing and out of scope) |
| `npm run check` | exit 0 (`tsc --noEmit`, extension sources included) |
| `npm test` | exit 0, **309 tests, 309 pass, 0 fail, 0 skipped** (builds with `tsc` first) |
| `npm run build:extension` | exit 0; `dist/openchamber-extension/` = `package.json` (941 B), `panel/index.html` (5,774 B), `panel/main.js` (157,934 B), `service/main.js` (88,215 B) |

`npm run check`, `npm test` and `npm run build:extension` were run twice: once
before and once after adding the smoke test (first run 308 tests, second 309).

### Manifest check (0.1.0)

One-off script (not part of the repo), run against the built manifest with the
SDK 2.1.0 exports `parseManifestJson` (`dist/schemas.js`) and
`hostMeetsOpenChamberEngine` (`dist/host-version.js`):

- `parseManifestJson(dist/openchamber-extension/package.json)` returned `ok: true`,
  `apiVersion` 1, version `0.1.0`, capabilities `["sessions"]`, panel `heimdall`
  (`panel/index.html`), service `service/main.js` with `runtime: "host"`,
  `exec: ["git"]` and the default coordinator socket candidate for darwin/linux.
- `engines.openchamber` is `>=2.1.0`; it matches `OPENCHAMBER_ENGINE_PATTERN`,
  `hostMeetsOpenChamberEngine('2.1.0', '>=2.1.0')` is `true` and
  `hostMeetsOpenChamberEngine('2.0.0', '>=2.1.0')` is `false`.

### Security sweep (0.1.0)

Pattern: `innerHTML|outerHTML|insertAdjacentHTML|document\.write|startSession|prompt\(|compose\(|sessionLink|generate\(|writeFile|/reconcile|/resume|ownerToken|coordinator\.key|node:sqlite`.

| Target | Hits | Justification |
| --- | --- | --- |
| `src/extension` | 1: `service/coordinator.ts:7` `Omit<RunRecord, 'ownerToken' | ...>` | Type that **removes** the owner token from the coordinator record; no value is read. |
| `dist/openchamber-extension/panel/index.html` | 0 | |
| `dist/openchamber-extension/panel/main.js` | 3: `startSession`, `sessionLink`, `writeFile` | Method definitions inside the bundled `@openchamber/sdk` host client. Our sources (`src/extension/panel`) reference none of them; the only host calls are `serviceRequest`, `serviceStatus`, `listProjects`, `listSessions`, `openSession`, `onReady` (a static test enforces this). No `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write` in the bundle. |
| `dist/openchamber-extension/service/main.js` | `ownerToken` parameter (coordinator client, `request(method, route, body, ownerToken)`), 2 `coordinator.key` | The shared client's optional owner-token argument is never passed by the adapter, which only calls `request('GET', route)` for `/projects`, `/runs`, `/runs/:id`, `/events?after=`. `coordinator.key` is the legitimate read of the access key (token helper) and its creation code from the bundled coordinator module; the key is never echoed (see smoke test). No `node:sqlite`. |

Additional checks: the only `POST` is the panel → local service `/directories/match`
route (canonical directory matching, returns ids only); the review module calls
`execFile('git', …)` with fixed read-only arguments and no `add|commit|reset|checkout|switch|merge|stash|clean|rm|update-index` (grep over `src/extension/service` found none, and `test/extension-review.test.mjs` asserts it). No fix was necessary.

### Synthetic end-to-end smoke (0.1.0)

`test/extension-smoke.test.mjs` (included in `npm test`) starts a real temp
coordinator with a fake executor and a temp git project, submits and admits a
run so the coordinator creates the real managed worktree, then adds committed,
uncommitted and untracked changes, a deletion and a 20,000-line rewrite. It
builds the extension to a temp folder and runs the built `service/main.js` with
`OPENCHAMBER_SERVICE_PORT`/`OPENCHAMBER_SERVICE_TOKEN` and a temp `HOME`
holding `coordinator.toml` for the temp state. Asserted:

- `/health` 200 with the token, 401 without; `/status` connected.
- `/projects`, `/runs` (and a status filter), `/runs/:id`, `/changes`,
  `/runs/:id/review` (exactly `README.md` deleted, `big.txt`/`edit.txt` modified,
  `committed.txt` added, `untracked.txt` untracked, against the run's `baseCommit`),
  and file diffs for `edit.txt` (committed and uncommitted lines), `untracked.txt`
  and the large `big.txt`; every response under 200,000 bytes.
- `../` and absolute paths are refused with a 4xx; `.heimdall/managed.json` is
  classified `generated` with empty text; POST/DELETE on run and project routes
  (`/resume`, `/reconcile`, `/runs`, `/projects`) get 404/405.
- The coordinator key, the run owner token and the service token appear in no
  response, and the service writes nothing to stdout/stderr.
- Worktree `git status --porcelain=v2`, HEAD, branch, stash list, worktree
  registry, refs and source-project status are identical before and after; the
  run's `status`, `version` and `updatedAt` are unchanged.

Result: pass (also in the 309-test full run).

### Acceptance criteria evidence (0.1.0)

| ADR acceptance criterion | Evidence | Result |
| --- | --- | --- |
| Built extension installable through the supported mechanism; useful empty/offline state | `test/extension-build.test.mjs` (package layout, manifest, service entry); manifest check above; `test/extension-panel-view.test.mjs` "connection banners" and "empty states"; `test/extension-panel-store.test.mjs` offline/stale/backoff tests. Real installation: see Live UI verification | Automated PASS; install PENDING |
| Queued, planning, executing, paused, failed and completed runs render from coordinator data incl. task progress, model, usage | `test/extension-projection.test.mjs` (all statuses, detail projections, succeeded results/evidence); `test/extension-panel-view.test.mjs` queued/preparing/planning/executing/paused/failed/reconciliation/succeeded view models | Automated PASS (synthetic data); real run PENDING |
| Navigation opens the existing session or explains discovery failure; viewing never launches agents or changes run state | `test/extension-navigation.test.mjs` (found, project-not-added, discovering, discovery-failed, session-not-discovered, "viewing a run is read-only", no forbidden host method); smoke test (run status/version unchanged); sweep above | Automated PASS (mocked host); live discovery PENDING |
| Review includes committed and uncommitted work vs the run baseline incl. untracked files, without changing Git state | `test/extension-review.test.mjs` (committed/staged/unstaged/untracked, clean tree with commits, state untouched, read-only commands); smoke test with a real coordinator-created worktree | Automated PASS |
| Secrets absent from responses and errors; untrusted text rendered safely; unrelated paths rejected | `test/extension-projection.test.mjs` "projected JSON excludes…"; `test/extension-service.test.mjs` "secrets never reach responses", auth tests; `test/extension-review.test.mjs` path tests; `test/extension-panel-view.test.mjs` "untrusted text stays literal", "panel sources never assign HTML"; smoke test; sweep above | Automated PASS |
| Meaningful tests: projections, polling/reconnects, navigation boundaries, read-only transport, complete-change review with synthetic fixtures | `test/extension-projection.test.mjs` (20), `extension-panel-store.test.mjs` (18), `extension-navigation.test.mjs` (16), `extension-service.test.mjs` (10), `extension-review.test.mjs` (11), `extension-review-view.test.mjs` (28), `extension-panel-view.test.mjs` (22), `extension-build.test.mjs` (2), `extension-smoke.test.mjs` (1) | PASS |
| Existing typecheck/build/tests pass; extension build succeeds | Command results above (309/309, exit 0 for all four commands) | PASS |
| Short manual verification with the existing completed `test_app` run; live UI checks reported pending until performed | the guide's 0.1.0 manual verification (since replaced by the 0.1.1 checklist); this record's Live UI verification section | Documented; execution PENDING |

### Live UI verification (0.1.0)

**All items are PENDING — not yet performed.** The ADR forbids installing into
the running OpenChamber during this feature, and mocked tests do not prove live
behavior. Step numbers refer to the guide's
0.1.0 manual verification (replaced by the 0.1.1 checklist in the guide).

| # | Check | Status | Observed |
| --- | --- | --- | --- |
| 1 | Build in a separate checkout; expected folder contents | PENDING | |
| 2 | Install folder in Settings → Extensions, approve permissions; panel loads | PENDING | |
| 3 | Offline messaging with the coordinator down (skip if it is running) | PENDING | |
| 4 | Record `git -C W status --porcelain` and the `test_app` run status | PENDING | |
| 5 | Find the `test_app` run via project/status filters | PENDING | |
| 6 | Label, status `succeeded`, tasks, models, usage and limits match `run show RUN_ID` | PENDING | |
| 7 | Project-not-added guidance, then add the directory and Refresh | PENDING | |
| 8 | Open parent and a task session (H4: managed-worktree sessions listed under the source project, else "session not discovered") | PENDING | |
| 9 | Review file list equals `git -C W diff --stat B` plus untracked files | PENDING | |
| 10 | Diffs incl. binary, deleted and large files match `git -C W diff B -- <path>` | PENDING | |
| 11 | `git -C W status --porcelain` identical to step 4 | PENDING | |
| 12 | No new OpenChamber sessions; run status unchanged | PENDING | |

#### Owner steps (0.1.0)

1. After this branch is accepted, check it out in a **separate** checkout (not the
   running OpenChamber's project) and run `npm ci --ignore-scripts && npm run build:extension`.
2. In OpenChamber 2.1.0 open **Settings → Extensions**, paste the absolute path of
   that checkout's `dist/openchamber-extension`, review and approve the `sessions`
   permission and the local service, and enable it.
3. Keep the live coordinator running. Follow the guide's Manual verification
   steps 3–12 with the completed `test_app` run (`W` = its worktree, `B` = its
   base commit from `run show RUN_ID`).
4. Replace each PENDING entry above with PASS/FAIL and the observed result,
   including whether H4 (session discovery for managed worktrees) held.
