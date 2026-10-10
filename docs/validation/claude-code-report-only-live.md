# Claude Code report-only live verification (feature 0005)

## Status

| Gate | State |
| --- | --- |
| Reusable harness (`scripts/live/claude-report-only/`) | Done, all files pass `node --check` |
| Private OpenCode stores resolved under the fixture root | Done, observed (T1) |
| Copied provider differs only by isolation patches | Done, observed (T1) |
| Claude CLI and provider user-state write audit | Done, read-only (T1) |
| Enforced read-only guard over login and user state | **guard proven** (T1) |
| Live tool-path enforcement, release, recovery | **PENDING (T2)**: not run |
| Enablement of `claude-code` in `VERIFIED_REPORT_ONLY_PROVIDERS` | **PENDING (T3)**: still disabled |

Nothing in this record starts an OpenCode server or a model session. The
real login was used only for `claude auth status` inside the guard. No
credential was copied, printed, refreshed or written.

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
| `server.mjs` | Guarded disposable server launcher (not started in T1) |
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

PENDING (T2): live tool-path enforcement (edit, write, shell, tests, `git commit`,
delegation, namespaced MCP, nested code mode), owner-matched release, and
recovery (correction, pause, cap, late-release). Not run.
