# Claude Code report-only live verification (feature 0005)

## Status

| Gate | State |
| --- | --- |
| Reusable harness (`scripts/live/claude-report-only/`) | Done, all files pass `node --check` |
| Private OpenCode stores resolved under the fixture root | Done, observed (T1) |
| Copied provider differs only by isolation patches | Done, observed (T1) |
| Claude CLI and provider user-state write audit | Done, read-only (T1) |
| Enforced read-only guard over login and user state | **guard proven** (T1) |
| Live tool-path enforcement, release, recovery | **observed (T2)**, see [Live results](#live-results-t2) |
| Enablement of `claude-code` in `VERIFIED_REPORT_ONLY_PROVIDERS` | **ENABLED on this branch**: the list is exactly `['claude-code']`; see [Decision](#decision-and-final-status) |
| Full repository checks after the last code change | **Passed**, see [Command results](#command-results) |
| Activation on the installed runtime | **PENDING (owner)**, see [Activation (owner)](#activation-owner) |

T1 started no OpenCode server and no model session; T2 did, inside the guard
and the disposable fixture only (see Live results). The real login was used
only through the read-only guard broker. No credential was copied, printed,
refreshed or written.

## Versions

Recorded by commands run in this task (`opencode --version`, `claude --version`,
the installed packages' `package.json`, `node --version`, `bun --version`,
`sw_vers`):

| Component | Version |
| --- | --- |
| OpenCode | 2.0.22 |
| Claude Code CLI | 2.1.292 |
| `@openchamber/opencode-claude` provider | 1.3.4 |
| `@anthropic-ai/claude-agent-sdk` | 0.3.224 |
| Node | v22.22.3 |
| Bun | 1.4.2 |
| macOS | 27.0.1 (build 26A434) |

These match the versions used by the earlier coordinator smoke test.

## Fixture layout and cleanup ownership

`prepare.mjs` creates `mktemp -d /private/tmp/heimdall-0005.XXXXXX` (mode 700)
and writes `manifest.json`. This run's root was `/private/tmp/heimdall-0005.mZaL06`.

```text
<root>/manifest.json   versions, resolved stores, guard hashes, outcome, process records
<root>/config/         empty git hooks directory
<root>/profile/        data, cache, config, state, home, tmp, pty, native.db
<root>/native-host/    copied provider, read-only symlink to host node_modules
<root>/repo/           disposable git repository (src/impl.js, test/impl.test.js, package.json)
<root>/guard/          profile.sb, bin/security shim, probe plan, disposable keychain
<root>/evidence/       store resolution, provider diff, broker logs, guard results
```

Harness files:

| File | Role |
| --- | --- |
| `lib.mjs` | Fixture-root assertions, manifest helpers, store environment, hashing |
| `prepare.mjs` | Create root and manifest, record versions |
| `stores.mjs` | Resolve every store and refuse unless all are under the root |
| `copy-provider.mjs` | Exclusive-create copy of the installed provider plus the two isolation patches |
| `repo.mjs` | Disposable git repository with empty hooks path, fixture identity, no signing |
| `server.mjs` | Guarded disposable server launcher (started only in T2) |
| `guard.mjs` | Sandbox profile, launch wrapper and the disposable probe |
| `guard-probe-inner.mjs` | Runs the probe attempts inside the wrapper |
| `broker.mjs`, `security-shim.mjs` | Read-only Keychain broker and the `security` shim the CLI sees |

Cleanup ownership: the fixture root is owned by this run and is left on disk
for T2. T1 started two kinds of short-lived processes, both owned by the probe:
a Keychain broker over the disposable keychain and a broker over the real
login (read-only). Each recorded its PID in `manifest.json` and was stopped by
the probe, with exit confirmed (`disposableBrokerExited`, `realBrokerExited`).
The disposable keychain file was deleted and the user's keychain search list
was restored and compared. No `opencode serve` or `server.mjs` process was
started by this task; the long-running OpenCode server on the machine belongs
to the user and was not contacted.

## Store isolation (resolved paths)

Resolution used the OpenCode path resolver plus `opencode debug paths` with the
XDG variables, `TMPDIR`, `OPENCODE_CONFIG_DIR`, `OPENCODE_DB`,
`OPENCODE_PTY_RUNTIME_DIR`, `OPENCODE_TEST_HOME` and the provider auth-state
variable pointing into the root. `HOME` was not changed. `OPENCODE_CONFIG`,
`OPENCODE_CONFIG_CONTENT`, `OPENCODE_PASSWORD` and `OPENCODE_SERVER_PASSWORD`
were unset. `server.mjs` repeats the check and refuses to start when any path
is outside the root.

| Store | Resolved path | Under root |
| --- | --- | --- |
| home | `<root>/profile/home` | yes |
| data | `<root>/profile/data/opencode` | yes |
| cache | `<root>/profile/cache/opencode` | yes |
| config | `<root>/profile/config/opencode` | yes |
| state | `<root>/profile/state/opencode` | yes |
| tmp | `<root>/profile/tmp/opencode` | yes |
| bin | `<root>/profile/cache/opencode/bin` | yes |
| log | `<root>/profile/data/opencode/log` | yes |
| repos | `<root>/profile/data/opencode/repos` | yes |
| db (`OPENCODE_DB`) | `<root>/profile/native.db` | yes |
| pty (`OPENCODE_PTY_RUNTIME_DIR`) | `<root>/profile/pty` | yes |
| provider auth state | `<root>/profile/data/opencode-claude/manual-auth.json` | yes |
| provider models, rate limit, sessions, debug log | `<root>/profile/data/opencode-claude/*.json`, `debug.log` | yes |

`storeResolution.outsideRoot` is empty and `homeUnchanged` is true. No existing
OpenCode database was opened.

## Claude CLI and provider write audit

Read-only inspection of the installed CLI (`@anthropic-ai/claude-code` 2.1.292,
a native `bin/claude.exe`, searched with `strings`/`grep`) and of the copied
provider `dist/` (1.3.4). CLI findings are string/symbol evidence from the
binary; they show the code path exists, not that a given run takes it.

| Area | Evidence | Guarded by |
| --- | --- | --- |
| Credential read (macOS Keychain) | CLI shells out to `security find-generic-password -a "<user>" ...` | shim and broker allowlist |
| Credential write / refresh | `add-generic-password -U -a` and `delete-generic-password` strings; OAuth `/oauth/token` and `refresh_token` strings | exec deny on `/usr/bin/security`, Security mach services denied, refresh token stripped by the broker |
| Credential file fallback | `.credentials.json` under the Claude config directory (also referenced in `Read(~/.claude/.credentials.json)` deny text) | file-write deny on `~/.claude` |
| Global state | `~/.claude.json` and sibling files (backups, locks) | file-write and link deny by regex |
| Transcripts and sessions | `~/.claude/projects`, `sessions`, `todos`, `shell-snapshots`, `session-env`, `statsig`, `telemetry`, `plugins`; `cleanupPeriodDays` retention | file-write deny on `~/.claude` |
| Hooks and settings | `disableAllHooks` and user/project/local settings sources | provider copy sets `settingSources: []`; user settings are not read |
| Config directory override | `CLAUDE_CONFIG_DIR` read in the CLI and in `dist/session-store.js:424`, `dist/opencode-context.js:56` | not set; fallback to `~/.claude` is read-only under the guard |
| Auto-update, telemetry | `DISABLE_AUTOUPDATER`, `DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` flags exist | writes they would cause land under guarded paths |
| Other Claude app dirs | `~/Library/Application Support/Claude`, `~/Library/Caches/claude-cli-nodejs`, `~/Library/Logs/Claude`, XDG `claude` dirs | file-write deny |

Provider (`@openchamber/opencode-claude` 1.3.4) writers:

| File | Write | Location |
| --- | --- | --- |
| `dist/auth-stop.js:44-47` | atomic write of auth-stop state | `OPENCODE_CLAUDE_AUTH_STATE_FILE`, else `$XDG_DATA_HOME/opencode-claude` |
| `dist/session-store.js:29-30` | session map | `$XDG_DATA_HOME/opencode-claude/sessions.json` |
| `dist/models.js:168-169` | model cache | `$XDG_DATA_HOME/opencode-claude/models.json` |
| `dist/rate-limit.js:56-57` | rate-limit state | `OPENCODE_CLAUDE_RATE_LIMIT_STORE`, else `$XDG_DATA_HOME/opencode-claude` |
| `dist/log.js:45` | debug log | `$XDG_DATA_HOME/opencode-claude/debug.log` |
| `dist/query.js:288` | `persistSession` (installed: only when the caller passes `false`) | forced `false` in the copy |
| `dist/query.js:255` | `settingSources` (installed: defaults to user, project, local) | forced `[]` in the copy |

The provider reads `~/.claude/projects` and `CLAUDE.md` files but does not write
them. Its own stores all follow `XDG_DATA_HOME`, which the fixture points into
the root.

Paths that must be read-only to the guarded process (all in the profile):
`~/.claude.json*`, `~/.claude`, `~/.config/claude`, `~/.local/share/claude`,
`~/.local/state/claude`, `~/.cache/claude`, `~/Library/Keychains`,
`/Library/Keychains`, `~/Library/Application Support/Claude`,
`~/Library/Caches/claude-cli-nodejs`, `~/Library/Logs/Claude`, and the live
OpenCode and OpenChamber stores (`~/.local/share/opencode`, `~/.config/opencode`,
`~/.local/state/opencode`, `~/.cache/opencode`, `~/.config/openchamber`,
`~/.local/share/openchamber`).

No supported Claude CLI setting that disables credential refresh was found, so
the boundary is an OS sandbox plus a read-only broker rather than a CLI flag.

## Guard design and disposable-fixture results

Mechanisms, all enforced by the OS or by a process outside the sandbox:

1. `/usr/bin/sandbox-exec -f <root>/guard/profile.sb <command>` with `(allow default)`
   and `(deny file-write*)`. Only the fixture root and null/terminal devices stay
   writable. The guard directory and `manifest.json` are denied again inside the root.
   Each user-state path above is denied again for `file-write*` and `file-link`
   so widening the base rule cannot expose it.
2. `(deny process-exec (literal "/usr/bin/security"))` and `(deny mach-lookup ...)`
   for `com.apple.SecurityServer`, `securityd`, `secd`, `security.agentd` and
   `security.XPCKeychainSandboxCheck`, so a sandboxed process cannot add, update or
   delete a Keychain item even through the framework.
3. `security` on `PATH` is a shim that forwards only
   `find-generic-password -w` for an allowlisted service to `broker.mjs`. The broker
   runs outside the sandbox, performs the read, and removes every refresh token
   from the credential before returning it. Everything else is refused. The
   CLI therefore sees a valid login but cannot refresh or rotate it.

Launch wrapper (used by the probe and intended for the server): `sandbox-exec -f
<root>/guard/profile.sb <command> <args>` with the fixture store environment and
the shim directory first on `PATH`. The profile and shim hashes are recorded in
`manifest.json` (`guardInstall`) and re-checked after the probe.

Disposable fixtures only: credential-like files were created in each existing
guarded class under `~` using probe sibling names
(`heimdall-0005-probe.*`, never the real credential files), plus a disposable
keychain created inside the root. The real login was not touched by any probe.

Results (`guard.mjs probe`, run in the final fresh fixture root; evidence in
`<root>/evidence/guard-results.json`):

| Class | Probes denied | Operations |
| --- | --- | --- |
| `~/.claude` credentials, settings; `projects`, `plugins`, `session-env`, `telemetry`, `sessions` | 8/8 each | overwrite, truncate, append, unlink, rename, chmod, hard link, create sibling |
| `~/.claude.json` sibling and `~/Library/Keychains` file | 9/9 each | same, plus lock/keychain file create |
| Absent class directories (`todos`, `shell-snapshots`, `statsig`, XDG `claude` dirs) | 1/1 each | `mkdir` of the class directory |
| Live OpenCode and OpenChamber stores | 1/1 each | create |
| Guard material (profile, shim, disposable keychain, guard dir) | 10/10 | overwrite, unlink, rename, create |
| Fixture root (allowed control) | 1/1 allowed | create |
| **Total** | **96/96 as expected** | |

Post-conditions: every seeded target kept its SHA-256, mode and link count; no
`.renamed`, sibling, hard-link or created path existed afterwards; guard
material was unchanged.

Keychain probes, run inside the wrapper against the disposable keychain:

| Attempt | Result |
| --- | --- |
| shim `add-generic-password` (existing item, `-U`; new item), `delete-generic-password` | refused by the shim, exit 1 |
| shim `find-generic-password` for a non-allowlisted service, and without `-w` | refused, exit 1 |
| `/usr/bin/security add-generic-password`, `delete-generic-password` (direct exec) | `EPERM` (exec denied) |
| Security.framework `SecKeychainAddGenericPassword` (new item) | hung until the 30 s probe timeout and was killed; no item created |
| Security.framework `SecKeychainFindGenericPassword` + `SecKeychainItemDelete` (control item) | exit 3, `OSStatus -25300` (`errSecItemNotFound`); item still present |
| shim `find-generic-password -w` on the allowlisted probe service | succeeded; returned the disposable access token and no refresh token |

Unsandboxed controls show the same framework client can add to and delete from
the disposable keychain, so the sandbox, not the client, is what changes the
outcome. Caveat: the framework delete returns "not found" rather than a
permission error, so it shows the control item could not be reached or removed,
not a distinct "denied" status. After the probes the disposable keychain's
service set, probe secret, new-item absence and control-item presence were all
unchanged, and the keychain file hash was unchanged. The user's keychain search
list was identical before and after (`create-keychain` did not alter it).

Guarded read-only operation: `claude auth status --json` inside the wrapper
with the real-login broker reported `loggedIn: true`, `authMethod: claude.ai`
(exit 0). Broker log: 2 `find-generic-password` read requests per run (one
answered not-found with exit 44, one served read-only); the stored credential's access-token expiry fell in the
`<24h` bucket. No refresh was triggered and no credential value was recorded.

Residual limits, not claimed as covered:

- The guard denies writes; it does not hide credentials from reads by the
  Claude CLI (it must read the login) and does not restrict network access.
- Because refresh tokens are stripped, an access token that expires during a
  live run will fail authentication instead of rotating. This is deliberate and
  is a T2 consideration for the length of any live session.
- A write path not listed in the profile and outside the fixture root is blocked
  by the default deny, but only the listed classes were probed individually.

## Copied-provider diff

`copy-provider.mjs` copies the installed provider with exclusive-create writes
into `<root>/native-host/plugins/opencode-claude` and fails if either anchor
below does not match the installed 1.3.4 source. Only `dist/query.js` differs
(9 diff lines); `dist/proxy.js` (the tool bridge) and every other file are
byte-identical. Neither `tools`, `allowedTools` nor `permissionMode` is touched.

```diff
--- <installed-provider>/dist/query.js
+++ <root>/native-host/plugins/opencode-claude/dist/query.js
@@ -251,9 +251,8 @@
-        settingSources: Array.isArray(params.settingSources)
-            ? params.settingSources
-            : ["user", "project", "local"],
+        // Fixture isolation: never load user/project/local Claude settings or hooks.
+        settingSources: [],
@@ -285,8 +284,8 @@
-    if (params.persistSession === false)
-        options.persistSession = false;
+    // Fixture isolation: never persist Claude transcripts for any turn.
+    options.persistSession = false;
```

Installed provider (49 files, tree SHA-256
`810b0d9301ef3a0dd0c17d56b2632945370e1c9219a3488254d9d3d1f21afaa8`): hashes
were identical before and after the copy and after the probe
(`installedHashesIdenticalBeforeAndAfter: true`). `dist/query.js` SHA-256:
installed `a3fc30b4...28a1d2`, copy `a47c7f09...0c9fc`. `dist/proxy.js`
SHA-256 `a993b4d0...006e2` in both. The patches affect what Claude persists
and which settings it loads, not how tools are exposed or dispatched, so
tool-path evidence from the copy applies to the installed provider's dispatch
(to be recorded in T2).

## Outcome

**guard proven.** In a fresh fixture root, every disposable credential-like
write probe (96 probes across all guarded path classes, plus disposable
Keychain targets) was denied inside the exact launch wrapper, the disposable
targets were unchanged, and guarded `claude auth status` still reports
`loggedIn: true` with `authMethod: claude.ai`.

No server and no model session were started. The real login was never
refreshed, rotated, copied or printed. No existing server, session or database
was opened. The probe's brokers were stopped and confirmed exited. Installed
provider hashes are unchanged.

T2 (live tool-path enforcement, owner-matched release, recovery) ran after this
outcome; its results follow.

## Live results (T2)

Run against the same fixture root (`/private/tmp/heimdall-0005.mZaL06`), with
every model session on `claude-code/sonnet`. The real login was reachable only
through the read-only guard broker.

### Fixture-only configuration (no `src/` or `test/` change)

The repository was built from the current worktree and the built `dist/` was
copied into the fixture. The pieces below exist only under the fixture root:

- `VERIFIED_REPORT_ONLY_PROVIDERS` patched to `['claude-code']` in the copied
  `dist/opencode/report-only.js`. At the time of the live runs the checked-in
  `src/` list was empty; the same value was then enabled in `src/` by the
  decision below, and no other source behaviour changed.
- A fixture plugin (`fixture/heimdall-fixture-plugin.mjs`) calling
  `createPlugin({ reportOnly: createReportOnlyRegistry() })`.
- An owner-only Unix control socket (`control.sock`, mode 700 root) exposing
  `restrict`, `releaseOwned` and `has` on the live registry. It is not a model
  tool and is not visible to any session.
- An observer plugin (`fixture/observer-plugin.mjs`) that records tool
  attempts, hook outcomes, permission evaluation and per-turn tool lists
  without altering Heimdall's hooks.
- A disposable stdio MCP server (`fixture/marker-mcp.mjs`) whose
  `marker_write_marker` tool appends a line to a marker file outside the
  repository, proving that a namespaced `mcp__*` call actually executed.
- Two ADR executor agents that omit `handoff` once or always, to drive the
  automatic correction path.

### Tool-path matrix

For each path the same model prompt was run in four phases on a disposable
git repository (`repo/`): **A** unrestricted, **B** restricted in the middle of
the turn, **C** turn started while already restricted, **D** after release.

| Path (tool) | A: runs, effect present | B: call after restriction | C: tools offered | D: after release |
| --- | --- | --- | --- | --- |
| edit (`edit`) | yes | not completed, no effect | 13 -> 0 | yes |
| write (`write`) | yes | not completed, no effect | 13 -> 0 | yes |
| shell (`shell`) | yes | not completed, no effect | 13 -> 0 | yes |
| tests (`shell`, `node --test`) | yes | not completed, no effect | 13 -> 0 | yes |
| git commit (`shell`) | new commit | not completed, HEAD unchanged | 13 -> 0 | new commit |
| delegation (`subagent`) | yes | not completed, no effect | 13 -> 0 | yes |
| code mode (`execute`, calling MCP) | yes, marker +1 | not completed, marker unchanged | 13 -> 0 | yes, marker +1 |
| nested MCP inside code mode (`mcp__*` via `execute`) | yes, marker +1 | not completed, marker unchanged | 13 -> 0 | yes, marker +1 |

Details observed in the hook log (`observer.jsonl`, 1033 events; control log
280 events, both kept under `<root>/evidence/`):

- In phase B the restricting shell call completed, then the next tool call
  reached the pre-hook but never reached the post-execution hook and never
  completed (`reachedPostObserver: false`); the model reported the
  report-only denial. Repository `HEAD` and `src/impl.js`, `package.json`,
  `test/impl.test.js` hashes were identical before and after, and the marker
  file gained no line.
- In phase B for the nested path, the outer `execute` call completed while
  the inner namespaced `marker_write_marker` call did not; the marker file
  stayed at the same length.
- In phase C the tool list for the restricted turn dropped from 13 to 0.
- In phase D the tool list returned to 13, the effect landed, and the
  restriction registry reported `restricted: false, count: 0`.
- The disposable repository ended with exactly two new commits (phase A and
  phase D of the git-commit path), no commit from B or C.

### Owner-matched release

On a throwaway session two owners (distinct parent, attempt and run) restricted
the same session: count 1 then 2. A release naming the right session but the
wrong run removed 0 and left count 2. Releasing owner A removed 1 (count 1);
releasing owner A again removed 0; the session stayed restricted for owner B;
releasing owner B removed 1 and cleared the restriction (count 0).

### Automatic correction, pause, cap and late release

Scenario repositories `repo-correct`, `repo-cap` and `repo-interrupt` were
created from the same baseline. Their executors do real task work (writing
`src/impl.js` and `test/impl.test.js`), so those files differ from baseline
by design; `HEAD` and `package.json` were unchanged.

| Scenario | Executor | Observed |
| --- | --- | --- |
| `correct` | omits `handoff` once | one `report-correction` attempt on the same child session, task completed (`reportCorrections: 1`) |
| `cap` | omits `handoff` always | two correction attempts on the same child, then `paused` with `correction_exhausted` (missing `handoff`); no further correction was started |
| `interrupt` | omits `handoff` always | parent interrupted during the first correction; child and parent idle, no restriction left (`count: 0`); run paused; next explicit resume after confirmed idle ended `paused` with `correction_ambiguous` |

Owner-matched cleanup on resume (first T2 session): the `interrupt` runtime had
already confirmed idle and released normally, so it left no restriction. The
harness then re-created a restriction itself (owner-matched `restrict` of the
paused child using its recorded parent, attempt id and run id). On the next
explicit resume the runtime released exactly that owner after fresh idle proof:
the first context after resume offered 11 tools, the correction attempt that
followed was itself restricted (0 tools), and the registry ended at
`restricted: false, count: 0` with the run `paused` at `correction_exhausted`
(2 corrections). This proves owner-matched cleanup on resume. It does **not**
prove retention after an unconfirmed interrupt; that is covered by the
follow-up scenario `retained` below.

Post-release check: for each of the three children, a write issued after the
final release reached all hooks, completed, produced the file, and the
context offered 11 tools (executor profile) with no restriction.

### Follow-up verification (second T2 session)

Run against the same fixture root and a fresh disposable server (new PIDs, same
guard wrapper, same stores, same port 47311), with a newly started read-only
login broker. Every session below was created by this task and was idle before
the processes were stopped. Harness: `t2-negative-prepare.mjs`,
`t2-negative.mjs`; evidence under `<root>/evidence/negative-*.json(l)`.

Additional fixture-only settings (none in `src/`, `test/` or the installed
packages):

- `adr-executor-blocked` and `adr-executor-unresolved`: the shipped
  `adr-executor` plus one appended rule each (blocked: reply the blocked shape
  naming a missing owner prerequisite, change nothing; unresolved: implement
  but do not run the tests and reply `completed` with the test gate
  `passed:false`). The first attempt used an ADR needing an absent owner file
  with the shipped executor; the real planner correctly refused to plan it
  (run paused in phase `planner`), which does not exercise the executor path,
  so that attempt is not counted.
- The fixture plugin now injects its own `observe` through the documented
  `createPlugin({ observe })` option. It wraps the real `createObserver` and
  changes a result only for a session id the owner marked through the control
  socket (`fault`), whose snapshot is then reported `active: true`. Unmarked
  sessions get the real snapshot. Hooks are untouched.

**Failed or unresolved work stays paused, no correction prompt, no
advancement** (`blocked`, `unresolved`):

| Scenario | Executor reply | Checkpoint after the run | Correction evidence |
| --- | --- | --- | --- |
| `blocked` | `blocked` (missing owner prerequisite) | `paused`, phase `executor`, index 0, `results: []`, diagnostic `agent_blocked` | `reportRecovery.corrections: 0`, `attempts: 0`; attempt receipts: planner task + executor task only; the child received 1 user message, not a `Report-only correction`; the child never got a restriction (11 tools every turn) |
| `unresolved` | `completed`, gates G1 true, G2 **false**, G3 true | `paused`, phase `executor`, index 0, `results: []`, diagnostic `unfinished_work` (G2) | same: 0 corrections, 0 attempts, no correction prompt, never restricted |

In both runs the repository `HEAD` was unchanged and no task result was
recorded (no advancement). The correction path is only reachable for a
format-only rejection (`report_format`), as in the `correct` scenario above.

**Retained restriction after an unconfirmed interrupt, then genuine late idle
proof and release** (`retained`). Fixture-only observation fault, so the
interrupt of the correction child could not be confirmed while the child was
genuinely interrupted:

1. During a running `report-correction` attempt the child was marked faulted and
   the parent was interrupted. The real active map showed the child (and the
   parent) idle at once; the registry kept the child restricted
   (`restricted: true, count: 1`).
2. The original invocation kept polling the faulted observer for its confirmation
   window (118 faulted observations) and then gave up: checkpoint `paused`,
   attempt `interrupted`, reason `Could not confirm child termination and empty
   inbox`. The restriction was still held at that point.
3. Only then was the fault removed (the child was already idle in the real active
   map). After a further 3 s with no invocation running, the restriction was
   still held (`restricted: true, count: 1`): nothing releases it by itself.
4. A new explicit `resume` released exactly the recorded owner (`parent`, child,
   correction attempt id, run id) after fresh idle proof: the registry went to
   `restricted: false, count: 0` and the run paused with `correction_ambiguous`
   (counter stayed 1, no further correction prompt).
5. An ordinary `write` sent to the same child afterwards reached every hook,
   completed, produced the file, and the context offered 11 tools.

A first `retained` run lifted the fault while the original invocation was still
polling (its in-flight confirmation loop released the restriction within about
300 ms). That run is kept as `negative-retained.first-run.*` and is **not** used
as evidence of retention; the second run above waited for the original
invocation to give up first.

**Receipts and accounting for the `correct` scenario** (existing evidence,
reused; not re-run). The run directory holds three attempt receipts, kept as
separate files with these SHA-256 values computed after the fact (no hashes were
recorded while the run was live, so there are no historical before/after hashes
to compare):

| File | Purpose | Child | SHA-256 |
| --- | --- | --- | --- |
| `attempt-65e0a35f-...json` | executor `task`, reply has no `handoff` | `ses_edbe64c8...` | `135cdc86...c383e` |
| `attempt-c55850fa-...json` | executor `report-correction`, reply has `handoff` | same child | `30c5822d...5f6b` |
| `attempt-ff35ad53-...json` | planner `task` | `ses_edbe68b7...` | `34003020...a8ac` |
| `reply-T1.json` | admitted (corrected) completion report | | `eeebc302...1a29` |

What this proves: the original and the corrected response are preserved
separately in their own receipts (the first lacks `handoff`, the second has it);
both ran on the same child session, with model `claude-code/sonnet` and no
variant on either receipt (the fixture used the default, unspecified variant
throughout); `state.json` shows `index` advancing 0 to 1 exactly once
(`status: completed`, one result with `reportCorrections: 1`), and the timeline
`recovery-correct.jsonl` records executor usage 52,239 at the start of the
correction and 60,729 at completion (planner 48,498 throughout), i.e. usage
accumulated across the correction rather than resetting. What it does not prove:
that the receipt files were byte-identical at the moment they were written (no
live hashes exist).

Manifest note: the first T2 session's cleanup step overwrote the fixture
`manifest.json` `t2` object; it was rebuilt from the recorded harness constants
and on-disk state (flagged `restoredAfterManifestOverwrite`). No evidence file,
receipt or repository was affected.

Follow-up cleanup: the login broker (PID 43852), the final guard launcher (58201)
and disposable server (58203) were stopped after `session.active()` returned
`{}`; earlier follow-up launchers (47848/47850, 51049/51051, 51894/51896,
54012/54014) were stopped or had exited on their own, each noted in the
manifest. `pgrep -f heimdall-0005` found nothing afterwards, and port 47311
refuses connections. Installed provider `query.js` and `proxy.js` hashes are
unchanged (`a3fc30b4...`, `a993b4d0...`).

Still not proven: nothing is claimed about a retained restriction when the real
OpenCode interrupt itself fails to terminate a child (the fault only affects what
the runtime observes).

### Cleanup and integrity

- Recorded processes stopped by PID, confirmed exited: Keychain broker 93163,
  guard launcher 93427, disposable OpenCode server (bun) 93429, and its
  `marker-mcp` children. No other process was signalled. Before stopping, the
  server reported no active session. Endpoint `127.0.0.1:47311` refuses
  connections afterwards.
- Installed provider `dist/query.js` SHA-256 `a3fc30b4...28a1d2` and
  `dist/proxy.js` `a993b4d0...006e2`, identical to the T1 record.
- No credential, raw transcript or store database was copied into the
  repository. Only the harness scripts and this note are committed; the
  fixture root with its evidence stays on disk, outside the repository.

## Decision and final status

Every T1 and T2 live gate is recorded above as passed: store isolation, the
credential and user-state guard, all eight tool paths denied under restriction
with files, `HEAD` and the MCP marker unchanged, owner-matched release, an
ordinary tool call after release, and the recovery scenarios (`correct`, `cap`,
`interrupt`, `blocked`, `unresolved`, `retained`). No gate failed and none was
unavailable. T3 therefore added `'claude-code'`, and nothing else, to
`VERIFIED_REPORT_ONLY_PROVIDERS` in `src/opencode/report-only.ts`, and changed
`test/native-backend.test.mjs` to assert that the shipped default set is exactly
`['claude-code']`, that `claude-code/sonnet` is supported by default and that
`openai` stays unsupported by default. No other provider is enabled.

The T3 change touches only that constant (and its comment) and one test. It does
not alter the tool dispatch, hooks or recovery code the live runs exercised, so
the T2 evidence is not invalidated and no live run was repeated.

Limits that remain, none of them a failed gate:

- The retained-restriction case used a fixture-only observation fault with a
  child that really was idle. A real OpenCode interrupt that fails to terminate a
  child was not tested.
- Authentication used the stored access token with refresh tokens withheld. An
  access token that expires during a run fails authentication instead of
  rotating. Nothing here shows a new login or account is required.
- Receipt hashes were computed after the fact; no live before/after hashes exist.
- The live runs used a fixture-only patched copy of `dist` and the copied
  provider with two isolation patches (see Copied-provider diff); they were not
  run against an installed build of this branch.
- The guard denies writes; it does not hide credentials from reads or restrict
  the network.
- Report-only restrictions live in the plugin process memory; a restart loses
  them.

## Command results

Run in this worktree after the last source change (the constant and the test),
with no further source edits afterwards, on Node v22.22.3. These are the real
results; the `dist/` build output is git-ignored.

| Command | Exit | Result |
| --- | --- | --- |
| `npm run check` (`tsc --noEmit`) | 0 | no diagnostics |
| `npm test` (`npm run build`, then `node --test test/*.test.mjs`) | 0 | tests 486, pass 486, fail 0, cancelled 0, skipped 0, todo 0 |
| `npm run build` (`tsc`) | 0 | `dist/opencode/report-only.js` contains `VERIFIED_REPORT_ONLY_PROVIDERS = ['claude-code']` |
| `npm run build:extension` | 0 | `dist/openchamber-extension/`: `package.json` 941 B, `panel/index.html` 7,797 B, `panel/main.js` 196,654 B, `service/main.js` 95,962 B |

The suite size (486) and the extension artifact sizes equal the feature 0003
record; the change does not touch the extension.

Fixture-only settings (none of them in `src/` or `test/`): the patched `dist`
copy, the synthetic quota snapshot, the control-socket and observer plugins, the
disposable marker MCP server, the omit-`handoff`, blocked and unresolved executor
rules, the injected `observe` wrapper with its fault, and the two copied-provider
isolation patches. They are described under Live results and Copied-provider diff,
live only under the fixture root, and are not part of the shipped build.

## Activation (owner)

Nothing here has been done by this task; installing, activating and merging are
your actions.

1. Review branch `heimdall/run/138b8157-4527-4842-8c8e-8d745af8eb48` and its
   commits on top of `dadeb3c`: `60adf62` (harness and T1 record), `5591d83`
   (live enforcement, release and recovery results), `a03b396` (follow-up
   verification) and the T3 commit that enables `claude-code` and records the
   results (`git log dadeb3c..HEAD`).
2. Let running workflows finish (or pause them) first. Do not rebuild, replace
   or restart the active runtime while any workflow is running: the plugin's
   restrictions are in memory and are lost on restart.
3. At a quiet point, build and install from this branch (`npm ci
   --ignore-scripts`, `npm run build`, `npm run build:extension`, then your usual
   install), and restart only your own OpenCode runtime and the Heimdall
   extension service. No other process, session or database needs to change.
4. Operational status: after that install and restart, automatic completion-report
   correction **is operational for `claude-code`** (at most two corrections per
   task, on the same idle child, with the same model and variant). Before it, the
   installed runtime keeps the empty list and format-only failures pause as
   `correction_unsupported`. Every other provider remains unsupported and needs a
   manual resume.
5. Optional: remove the disposable fixture root `/private/tmp/heimdall-0005.mZaL06`
   when you no longer need its evidence. It holds no committed material; nothing
   in it needs to run.
