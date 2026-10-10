# Completion-report recovery validation

Automated verification of feature 0003 (guide section:
[Completion-report correction](../coordinator.md#completion-report-correction)).

**Status: automated checks PASSED. Live provider verification and activation are PENDING (owner).**
Mocked and synthetic tests do not prove live OpenCode or provider behavior. Automatic
correction ships disabled in practice: `VERIFIED_REPORT_ONLY_PROVIDERS` is empty, and
`claude-code` was **not** verified (see [Provider verification](#provider-verification-feature-0004)),
so automatic recovery is **not operational** for it.

Feature 0004 (restriction lifetime fix) adds its own environment and results in
[Feature 0004 verification](#feature-0004-verification) below; the tables directly under
this heading are the feature 0003 record.

## Environment (feature 0003)

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

## Command results (feature 0003)

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

## What the tests prove (feature 0003)

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

## Feature 0004 verification

Scope: release a report-only restriction that outlived the runner invocation which took it
(guide: [Restriction lifetime](../coordinator.md#completion-report-correction)). Provider
verification for `claude-code` is recorded separately below and ended in a blocker.

### Environment (feature 0004)

| Item | Value |
| --- | --- |
| Date | 2026-10-10 |
| Branch | `heimdall/run/f63305a9-1230-49e6-a662-b1a00f08f264` |
| Feature commits | `7e7eae3` (`Release retained report-only restrictions after confirmed idle`: code and tests), `d4c67dd` (`Record claude-code report-only verification blocker`: provider evidence section and a comment), plus the docs commit that carries this record (`Document report-only restriction lifetime and record verification`; see `git log`) |
| Node.js | v22.22.3 |
| OS | macOS 27.0.1 (Darwin) |

**Base.** The managed worktree was created at `619d78b` (= `main`), but the ADR base is
`cbff04c` (tip of the feature 0003 branch `heimdall/run/ac63f51d-d13c-489f-b538-cc340fe41fe9`).
`619d78b` is an ancestor of `cbff04c`, so the branch was fast-forwarded with
`git merge --ff-only cbff04c6e5f351a1b084190e08191c96369dc64f` (five commits: `f2a25ee`,
`e4548fd`, `4277bb4`, `bea7797`, `cbff04c`) before any change; the branch name was kept.
A review diff computed from `619d78b` therefore also contains those five feature 0003
commits; the feature 0004 changes are only `7e7eae3`, `d4c67dd` and the docs commit.

Nothing was installed, activated, restarted, pushed or published, and the active runtime and
the live server were not touched. Everything ran in this worktree.

### Regression: base failure and post-fix pass

Scenario (real registry with all hooks registered, no plugin restart): a `report_format`
failure starts a correction, the correction attempt fails, the interrupt cannot be confirmed
so the restriction is kept and the run pauses; the child later becomes idle; a **new** runner
invocation resumes (twice, as the paused-state flow requires) and completes.

- Against unmodified feature 0003 code (`cbff04c`), `node --test test/report-correction.test.mjs`
  ran 27 tests: 26 pass, **1 fail**. The failing test was `regression: a restriction held after
  an unconfirmed interrupt is released by a NEW invocation once idle is confirmed, without a
  plugin restart`, with `AssertionError: the restriction must be released once idle is
  confirmed` (`true !== false`): the registry still held the child after completion.
- After the fix (`7e7eae3`) the same test passes and asserts `registry.has(child)` is false
  and the fake restriction count is 0.

### What the new tests prove (feature 0004)

All use the real `createReportOnlyRegistry()`; those in `report-correction` also use the real
`createNativeBackend()` adapter (`opts.native`), with only the OpenCode `observe` snapshot faked.

- A child that is busy, in an unknown outcome or under a different parent keeps the
  restriction (registry count 1, no prompt sent); once idle it is released.
- The idle check is repeated right before release: a child that turns busy on the second
  check keeps the restriction.
- Release happens only after the fenced resume save, and before any prompt or completion.
- Release is idempotent and owner-matched (`native-backend` unit test): repeats, other
  holders, wrong parent, wrong run and wrong attempt leave other entries in place.
- A failing release leaves the restriction in force, pauses the run without a prompt, and the
  next resume releases it.
- A stale checkpoint owner is rejected (`Owner token is stale`) and never calls the release;
  the rotated owner releases exactly one entry.
- Restrictions on another child, another run and an unowned holder stay at count 1.
- A backend recreated over the same registry releases the entry; a plugin recreated with a
  **fresh** registry dispatches no duplicate prompt and claims nothing (the old registry still
  shows count 1), because the in-memory registry does not survive a restart.
- A recovered valid report advances exactly once with `reportCorrections <= 2` and byte-identical
  receipts; unresolved work still pauses; a legacy checkpoint without `reportRecovery` or an
  attempt `purpose` still resumes.

### Fixture-only settings

These exist only in tests and are not production behavior: `verifiedProviders: ['a', 'k']`
injected into `createNativeBackend` (the shipped default set is empty; `native-backend` also
injects `openai`), a fake `observe` snapshot, `interruptError` (forces an unconfirmed
interrupt), `releaseError` (forces a failing release), `opts.native` and `swapNative()` (real
adapter and registry, adapter recreation), and a fake capability with `releaseRetained`
for the non-native runner tests.

### Command results (feature 0004)

Run in this worktree after the last code change (`7e7eae3` and `d4c67dd`; the docs commit
changes no code).

| Command | Result |
| --- | --- |
| `npm run check` | exit 0 |
| `npm test` (full suite; builds with `tsc` first) | exit 0, **486 tests, 486 pass, 0 fail, 0 skipped, 0 cancelled, 0 todo** |
| `npm run build` | exit 0 |
| `npm run build:extension` | exit 0; `dist/openchamber-extension/` = `package.json` (941 B), `panel/index.html` (7,797 B), `panel/main.js` (196,654 B), `service/main.js` (95,962 B) |

The suite grew from 474 to 486 (12 new tests). Per-file counts: `report-correction` 37 (was 26),
`native-backend` 12 (was 11), `plugin` 6, `runner` 40, `managed-runner` 5,
`report-classifier` 61, `executor-contract` 7; all pass.

Not proven by any of this: live OpenCode or provider behavior. `claude-code` remains
unsupported (next section).

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

### Verification limitation

No authenticated live check was attempted during feature 0004. The fresh login
store was empty; this does not prove isolated authentication is impossible:

- The provider uses the Claude CLI login store and removes credential overrides
  from its child environment.
- With `HOME` and `CLAUDE_CONFIG_DIR` pointed at the temp dir, `claude auth status`
  reported `"loggedIn": false, "authMethod": "none"`. Setting `CLAUDE_CONFIG_DIR`
  also selects a different macOS Keychain service.
- The earlier [Claude Code coordinator smoke](claude-code-coordinator-smoke.md)
  used the existing login with private OpenCode stores, transcript persistence
  disabled and user hooks disabled. It did not prove protection against Claude
  credential refresh or every CLI state write.

The next check should assess that earlier setup against the installed CLI and
prove credential-write protections before starting a disposable server. Do not
copy or refresh credentials or use existing sessions as fixtures. Provider
support remains disabled until live enforcement is proven.

No server was started and no tool path was attempted. Nothing was run against
`http://127.0.0.1:57123`, no existing session database was opened, and `~/.config/opencode`,
`~/.claude`, credentials and installed builds were not modified (the provider and user
config were only read). No server or session process was started (no PID to stop); only
short read-only CLI commands ran (`--version`, `debug paths`, `auth status` in the temp dir). The temp dir was removed and `pgrep` showed no
`opencode serve` process of this check. No disposable repo, file hashes or `git rev-parse
HEAD` comparison exist because nothing was run. The repository was not changed by the check.

### Remaining verification (owner)

Establish an isolated setup that preserves the existing login and prevents credential
changes, or use an owner-authorized disposable login. Never use the live server:

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

## Activation plan (owner)

Nothing below has been done; each step is yours and none is urgent. The fix is merged and
installed only by you.

1. Review the branch `heimdall/run/f63305a9-1230-49e6-a662-b1a00f08f264`. Feature 0004 is
   `7e7eae3`, `d4c67dd` and the docs commit; a diff from `619d78b` also shows the five
   feature 0003 commits (`f2a25ee`, `e4548fd`, `4277bb4`, `bea7797`, `cbff04c`).
2. Respect running workflows: let existing runs finish, or pause them, first. Do not
   rebuild, replace or restart the active runtime (the plugin imports the original
   repository's `dist`, and its in-memory restrictions are lost on restart) while any
   workflow is running.
3. Only when you accept the branch and nothing is running: build and install from this
   branch (`npm ci --ignore-scripts`, `npm run build`, `npm run build:extension`) and
   restart your own OpenCode runtime and the Heimdall extension service at a quiet point.
   Until you rebuild there, nothing changes.
4. Provider enablement only per recorded evidence. `claude-code` is **not verified**: do not
   add it to `VERIFIED_REPORT_ONLY_PROVIDERS` or describe automatic report recovery as
   operational for it until every step under
   [Remaining verification (owner)](#remaining-verification-owner) has been completed and
   recorded. Until then a `report_format` pause stays `correction_unsupported` and needs a
   manual resume with the format-only guidance in the pause reason. Automatic correction is
   operational only for a provider that has been proven live and listed.
5. Optional live check in the extension: a paused report problem shows its category and
   next step in the run summary, and a running correction shows `Correcting report (1/2)`.
