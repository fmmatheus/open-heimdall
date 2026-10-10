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

## Provider verification (feature 0004)

Result: `claude-code` stays **unsupported**. `VERIFIED_REPORT_ONLY_PROVIDERS` is unchanged
(empty). No disposable server was started, so no live denial was observed. Date of the
check: 2026-10-10.

### Versions

| Component | Version | Source |
| --- | --- | --- |
| OpenCode | `v2.0.22` | `opencode --version` |
| `@opencode/plugin` (this repo) | `2.0.22` | `node_modules/@opencode/plugin/package.json` |
| `opencode-claude` provider | `1.3.4` (`@openchamber/opencode-claude`, Agent SDK `0.3.224`) | `~/.config/opencode/v2-plugins/opencode-claude/package.json` (read only) |
| Claude Code CLI | `2.1.292` | `claude --version` |
| Node | `v22.22.3` | `node --version` |

### Dispatch paths for `claude-code`

Read from the provider source (`dist/proxy.js`, `dist/query.js`, read only) and the plugin
types. "Hook" is the Heimdall hook that would enforce the path. "Proven" means the source
or a live run shows the hook is reached; nothing here was observed live.

| Path | How the provider reaches it | Enforcing hook | Status |
| --- | --- | --- | --- |
| Claude Code built-in tools (Bash, Edit, Write, Task/Agent) | Provider passes `tools: []`, so built-ins are never enabled. | none needed | Proven by provider source only; not exercised live. |
| edit / write | OpenCode request tools are exposed as the in-process MCP server `mcp__<host>__*`; the call parks and returns to OpenCode as an ordinary tool call. | `execute.before`, `permission.evaluate`; `context` removes the tool from the request | Unverified: the source does not show that core runs `execute.before` or `permission.evaluate` for a parked call. |
| shell, tests, `git commit` | Same bridge (`bash`/`shell` aliased to `mcp__<host>__bash`). | same as above | Unverified (same reason). |
| delegation / subagent | OpenCode `subagent` (V2) or `task` (V1) is listed on purpose in the bridged tools, so a restricted session would call it through the bridge. | `execute.before`; `context` | Unverified (same reason). |
| namespaced MCP (`mcp__openchamber__*`, `mcp__opencode__*`) | This is the bridge itself: `allowedTools` lists every request tool as `mcp__<host>__<name>`; `permissionMode` is `bypassPermissions` whenever any tool is bridged, so Claude Code adds no permission check of its own. | `context` (an empty tool list gives the turn no MCP server and `dontAsk` mode), `execute.before` | Unverified: the empty-list behavior is in provider source, but it depends on core passing the post-`context` tool list to the provider, which is not shown. |
| nested code-mode (`execute` tool, `tools.x(...)`) | `execute` is itself a bridged tool; nested calls run inside core's code-mode runtime. | `execute.before` on the outer `execute` call; nested calls are not shown to reach any hook | Unverified. The public plugin types (`ToolHooks`) do not state that nested calls fire `execute.before`, and OpenCode core source is not available locally. |
| parked turn resumed after restriction | The provider keeps a live CLI child with its earlier MCP tools for a parked turn and resumes it when results arrive. | `execute.before` only | Not reachable for a correction (the child is idle before it is restricted), but not proven either. |

No dispatch path is proven by a live run, and the nested code-mode and parked-call paths
are unverified even by source, so the support rule (every path proven) is not met.

### Isolation

Supported isolation was found and proven read-only before anything else ran:
`opencode debug paths` honours `XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME`,
`XDG_STATE_HOME` and `HOME`. With a fresh temp dir `T` (`mktemp -d /tmp/t2-iso.XXXXXX`) and
the live `OPENCODE_CONFIG`, `OPENCODE_SERVER_PASSWORD` and `OPENCODE_PASSWORD` unset for the
command, it printed:

```
home   $T/home
data   $T/data/opencode
cache  $T/cache/opencode
config $T/config/opencode
state  $T/state/opencode
bin    $T/cache/opencode/bin
log    $T/data/opencode/log
repos  $T/data/opencode/repos
db     $T/data/opencode/opencode.db
tmp    /private/var/folders/.../T/opencode   (follows TMPDIR, not set)
```

Without that override the same command printed the real `~/.local/share/opencode`,
`~/.config/opencode` and `opencode.db`, so the isolation depends on setting every variable
and was not proven for a default environment. `serve` accepts `--hostname` and `--port`;
`opencode run` and the TUI default to the shared background service unless `--standalone`
or `--server` is given, so they were not used.

### Blocker

Store isolation works, but a `claude-code` session cannot be authenticated inside it
without touching credentials:

- The provider runs the real `claude` CLI and relies on its own login store
  (`buildClaudeCodeChildEnv` only removes `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and
  `CLAUDE_CODE_OAUTH_TOKEN`).
- With `HOME` and `CLAUDE_CONFIG_DIR` pointed at the temp dir, `claude auth status` printed
  `"loggedIn": false, "authMethod": "none"` and only wrote inside `$T/claude`.
- Running against the real `~/.claude` login would make the CLI write session transcripts
  and config under `~/.claude`; copying the login into the temp dir would copy credentials.
  Both were out of bounds for this task.

Therefore no server was started and no tool path was attempted. Nothing was run against
`http://127.0.0.1:57123`, no existing session database was opened, and `~/.config/opencode`,
`~/.claude`, credentials and installed builds were not modified (the provider and user
config were only read). No server or session process was started (no PID to stop); only
short read-only CLI commands ran (`--version`, `debug paths`, `auth status` in the temp dir). The temp dir was removed and `pgrep` showed no
`opencode serve` process of this check. No disposable repo, file hashes or `git rev-parse
HEAD` comparison exist because nothing was run. The repository was not changed by the check.

### Remaining verification (owner)

Run this on a machine where a disposable Claude Code login is allowed (a throwaway account
or an owner-approved `CLAUDE_CONFIG_DIR` login), never against the live server:

1. `npm run build`, create a temp git repo with a committed implementation file, and a
   fixture plugin there that loads this repo's `dist/opencode/plugin.js` with an injected
   registry from `createReportOnlyRegistry()` so a session can be restricted and released.
2. Set every XDG variable and `HOME`, run `opencode debug paths` and confirm each store is
   under the temp dir, then `opencode serve --port <free port>`; record PID, port, command.
3. In a fresh `claude-code/sonnet` session, restrict it and attempt edit/write, shell, tests,
   `git commit`, `subagent`, an `mcp__*` tool and a nested `tools.x(...)` call through
   `execute`. Each must be denied; hashes of the implementation file and `git rev-parse
   HEAD` must be unchanged; a plain text report must still complete.
4. Release through the owner-matched release, confirm an ordinary tool call works, stop only
   the recorded PID and confirm it exited.
5. Only then add `claude-code` to `VERIFIED_REPORT_ONLY_PROVIDERS` and update the
   default-set assertion in `test/native-backend.test.mjs`.

Until then a `report_format` pause on `claude-code` stays `correction_unsupported` and needs
a manual resume. Tests inject a verified provider (`openai`) to exercise the supported path.

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
