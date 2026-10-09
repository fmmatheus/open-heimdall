# OpenChamber extension validation

Automated verification of the read-only Heimdall extension for OpenChamber 2.1.0
(guide: [openchamber-extension.md](../openchamber-extension.md)).

**Status: automated checks PASSED. Live OpenChamber UI checks are PENDING (owner).**
Mocked and synthetic tests do not prove live OpenChamber behavior.

## Environment

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

## Command results

| Command | Result |
| --- | --- |
| `npm ci --ignore-scripts` | exit 0, 402 packages added (engine warnings come from the OpenCode toolchain dependency, `npm audit` findings are pre-existing and out of scope) |
| `npm run check` | exit 0 (`tsc --noEmit`, extension sources included) |
| `npm test` | exit 0, **309 tests, 309 pass, 0 fail, 0 skipped** (builds with `tsc` first) |
| `npm run build:extension` | exit 0; `dist/openchamber-extension/` = `package.json` (941 B), `panel/index.html` (5,774 B), `panel/main.js` (157,934 B), `service/main.js` (88,215 B) |

`npm run check`, `npm test` and `npm run build:extension` were run twice: once
before and once after adding the smoke test (first run 308 tests, second 309).

## Manifest check

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

## Security sweep

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

## Synthetic end-to-end smoke

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

## Acceptance criteria evidence

| ADR acceptance criterion | Evidence | Result |
| --- | --- | --- |
| Built extension installable through the supported mechanism; useful empty/offline state | `test/extension-build.test.mjs` (package layout, manifest, service entry); manifest check above; `test/extension-panel-view.test.mjs` "connection banners" and "empty states"; `test/extension-panel-store.test.mjs` offline/stale/backoff tests. Real installation: see Live UI verification | Automated PASS; install PENDING |
| Queued, planning, executing, paused, failed and completed runs render from coordinator data incl. task progress, model, usage | `test/extension-projection.test.mjs` (all statuses, detail projections, succeeded results/evidence); `test/extension-panel-view.test.mjs` queued/preparing/planning/executing/paused/failed/reconciliation/succeeded view models | Automated PASS (synthetic data); real run PENDING |
| Navigation opens the existing session or explains discovery failure; viewing never launches agents or changes run state | `test/extension-navigation.test.mjs` (found, project-not-added, discovering, discovery-failed, session-not-discovered, "viewing a run is read-only", no forbidden host method); smoke test (run status/version unchanged); sweep above | Automated PASS (mocked host); live discovery PENDING |
| Review includes committed and uncommitted work vs the run baseline incl. untracked files, without changing Git state | `test/extension-review.test.mjs` (committed/staged/unstaged/untracked, clean tree with commits, state untouched, read-only commands); smoke test with a real coordinator-created worktree | Automated PASS |
| Secrets absent from responses and errors; untrusted text rendered safely; unrelated paths rejected | `test/extension-projection.test.mjs` "projected JSON excludes…"; `test/extension-service.test.mjs` "secrets never reach responses", auth tests; `test/extension-review.test.mjs` path tests; `test/extension-panel-view.test.mjs` "untrusted text stays literal", "panel sources never assign HTML"; smoke test; sweep above | Automated PASS |
| Meaningful tests: projections, polling/reconnects, navigation boundaries, read-only transport, complete-change review with synthetic fixtures | `test/extension-projection.test.mjs` (20), `extension-panel-store.test.mjs` (18), `extension-navigation.test.mjs` (16), `extension-service.test.mjs` (10), `extension-review.test.mjs` (11), `extension-review-view.test.mjs` (28), `extension-panel-view.test.mjs` (22), `extension-build.test.mjs` (2), `extension-smoke.test.mjs` (1) | PASS |
| Existing typecheck/build/tests pass; extension build succeeds | Command results above (309/309, exit 0 for all four commands) | PASS |
| Short manual verification with the existing completed `test_app` run; live UI checks reported pending until performed | [openchamber-extension.md "Manual verification"](../openchamber-extension.md#manual-verification-owner-checklist); this record's Live UI verification section | Documented; execution PENDING |

## Live UI verification

**All items are PENDING — not yet performed.** The ADR forbids installing into
the running OpenChamber during this feature, and mocked tests do not prove live
behavior. Step numbers refer to the guide's
[Manual verification](../openchamber-extension.md#manual-verification-owner-checklist).

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

### Owner steps (final step of this feature)

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
