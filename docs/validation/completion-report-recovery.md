# Completion-report recovery validation

Automated verification of feature 0003 (guide section:
[Completion-report correction](../coordinator.md#completion-report-correction)).

**Status: automated checks PASSED. Live provider verification and activation are PENDING (owner).**
Mocked and synthetic tests do not prove live OpenCode or provider behavior. Automatic
correction ships disabled in practice: `VERIFIED_REPORT_ONLY_PROVIDERS` is empty.

## Environment

| Item | Value |
| --- | --- |
| Date | 2026-10-09 |
| Verified code | `bea7797` (`Recover format-only completion reports with bounded correction`) plus the final commit of this task (`Surface completion-report recovery diagnostics and record verification`), which adds only the event payload, the extension projection and view, tests and docs |
| Branch | `heimdall/run/ac63f51d-d13c-489f-b538-cc340fe41fe9` |
| Node.js | v22.22.3 |
| OS | macOS 27.0.1 (Darwin) |

Everything ran in this worktree. Nothing was installed, activated, restarted, pushed or
published, the active runtime plugin (`.opencode/plugins/heimdall.ts`, which imports the
original repository's `dist`) and `.heimdall/` were not modified, and no command was run or
written in `/Users/matheusmoreira/Projects/open-heimdall` (it was only listed once to confirm
it exists). Fixtures are temp directories, temp git repositories and in-memory or temp
coordinators.

## Command results

| Command | Result |
| --- | --- |
| `npm run check` | exit 0 (`tsc --noEmit`), no output |
| `npm test` | exit 0, **474 tests, 474 pass, 0 fail, 0 skipped, 0 cancelled, 0 todo** (builds with `tsc` first) |
| `npm run build:extension` | exit 0; `dist/openchamber-extension/` = `package.json` (941 B), `panel/index.html` (7,797 B), `panel/main.js` (196,654 B), `service/main.js` (95,962 B) |

The suite grew from 465 (end of T4) to 474 with the nine tests added here. Per-file counts
for the files this feature touched: `report-classifier` 61, `report-correction` 26,
`coordinator-store` 16 (+2), `extension-projection` 33 (+3), `extension-panel-view` 57 (+4);
`executor-contract` 7, `plugin` 6, `native-backend` 11, `runner` 40 and `managed-runner` 5
passed in the full run.

## What the tests prove

- **Footer:** every executor prompt ends with the task-specific contract; the planner prompt
  is unchanged (`executor-contract`).
- **Classification:** blocked, `passed: false`, wrong identity, bad gate IDs, prose,
  truncation and native/auth/quota failures never classify as `report_format`; omitted
  fields and gate entries do, without fabricating `passed` evidence (`report-classifier`).
- **Correction:** a format-only failure with a supported capability is corrected within two
  attempts on the same child, agent, model and variant, advances once and keeps both
  receipts; every other failure pauses with its category and no prompt. The counter is
  persisted before dispatch and survives restart, new attempt IDs, owner rotation and
  manual resume; ambiguous or unanswered corrections are never re-sent
  (`report-correction`).
- **Enforcement:** a temp git repository shows that edit, shell, `git commit`, tests,
  delegation, namespaced MCP and code-mode tool attempts are all denied for a restricted
  session and that implementation files and `HEAD` are unchanged, including across a
  correction (`plugin`, `report-correction`).
- **Diagnostics (this task):** `checkpoint.saved` events carry only
  `{mode, corrections, limit: 2, code, missingFields, gateIds}`; reason text, raw
  replies, secret-like strings, extra keys, unknown codes and non-`G<n>` IDs are dropped,
  and the run keeps status `running` with capacity reserved (`coordinator-store`). The
  extension projects the same bounded state from the checkpoint only, through the real
  `GET /runs/:id` route and into the panel view model; the list stays summary-only
  (`extension-projection`). The panel shows `Correcting report (n/2)` while running and four
  distinct paused categories with honest next steps, with raw and secret strings never
  projected (`extension-panel-view`).

## Supported recovery boundaries

- Automatic correction: only `report_format` (completed-intent JSON that omitted fields or
  gate entries), at most twice per task, only on a provider listed in
  `VERIFIED_REPORT_ONLY_PROVIDERS`, only while the plugin hooks are registered.
- Everything else pauses without re-sending: unfinished or blocked work, wrong identity,
  ambiguous, truncated or non-JSON output, native and auth/quota failures, exhausted
  corrections (`correction_exhausted`), unsupported enforcement (`correction_unsupported`)
  and a possibly-run correction (`correction_ambiguous`).
- A resumed legacy receipt without gate IDs is still rejected at admission (unchanged).
- A checkpoint saved before this feature (no `reportRecovery`) loads and resumes.

## Enforcement limitation

`claude-code` is **unsupported, not proven**. The provider plugin disables Claude Code's
built-in tools and exposes only the tools in the OpenCode request as an MCP server,
parking each call back to OpenCode. The local sources do not show that OpenCode core runs
`execute.before` and `permission.evaluate` for those parked calls or for code-mode
`execute` nested calls (`tools.x(...)`), and OpenCode core is not available locally. No
live experiment was run. The production capability therefore reports unsupported for every
provider and `report_format` failures pause as `correction_unsupported`. Tests inject a
verified provider (`openai`) to exercise the supported path.

## Owner activation checklist

Nothing below has been done; each step is yours.

1. Review the branch `heimdall/run/ac63f51d-d13c-489f-b538-cc340fe41fe9` (commits
   `f2a25ee`, `e4548fd`, `4277bb4`, `bea7797` and the final one).
2. Build and install from this branch only when you accept it (`npm ci --ignore-scripts`,
   `npm run build`, `npm run build:extension`), then restart your own OpenCode runtime and
   the Heimdall extension service yourself. The active plugin imports the original
   repository's `dist`, so until you rebuild there nothing changes.
3. Before relying on automatic correction for a provider, verify tool denial live with a
   throwaway session: restrict it through the plugin and confirm that edit, shell,
   `git commit`, delegation, namespaced MCP calls (for `claude-code`, the
   `mcp__openchamber__*` tools) and code-mode nested calls are all denied and that the
   repository is unchanged.
4. Only then add that provider to `VERIFIED_REPORT_ONLY_PROVIDERS` in
   `src/opencode/report-only.ts`, rebuild and restart. Until then, a `report_format` pause
   needs a manual resume with the format-only guidance shown in the pause reason.
5. Optional live check in the extension: a paused report problem shows its category and
   next step in the run summary, and a running correction shows `Correcting report (1/2)`.
