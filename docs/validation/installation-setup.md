# Installation, setup and doctor validation

Automated and local verification of the installable tarball, `heimdall setup`
and `heimdall doctor` (guide: [installation.md](../installation.md)).

**Status: local automated checks PASSED on one macOS host. The CI jobs for macOS
and Linux are updated but PENDING (not run); Linux, Node.js 22.19.0 and Node.js 24
have not been tested. No live host or provider verification was done.**
Fixture and synthetic-project tests do not prove behavior against a user's
OpenCode server, OpenChamber Desktop, provider accounts or quota. This record
does not show that the coordinator was started or that a run can execute.

## Environment

| Item | Value |
| --- | --- |
| Date | 2026-10-11 |
| Verified code | `d597d8e` (`fix(cli): redact selected credential references consistently`), the last commit that changed code or tests. Later commits change only `docs/installation.md`, `.github/workflows/test.yml` and this record. |
| Branch | `heimdall/run/2327e50f-8828-4a67-be86-e39b44cef151`, based on `6aff533` |
| OS | macOS 27.0.1 (Darwin 27.0.0, arm64) |
| Node.js | v22.22.3 |
| npm | 10.9.8 |
| Registry access | Required (`npm ci` and ordinary tarball installs fetch declared dependencies) |

Not run locally: Linux, Node.js 22.19.0 exactly, Node.js 24, Windows.

## Command results

All commands ran from the repository root with a clean tree, after the code,
documentation and workflow commits. `node_modules` was installed from the lockfile
with `npm ci --ignore-scripts` earlier in the same checkout; no dependency changed
since, so the install was not repeated.

| Command | Exit | Result |
| --- | --- | --- |
| `npm run check` | 0 | TypeScript check passed |
| `npm test` | 0 | 917 tests, 917 pass, 0 fail, 0 cancelled, 0 skipped (includes the PTY wizard tests) |
| `npm run build:extension` | 0 | Build and extension bundle completed |
| `npm run test:package` | 0 | 19 tests, 19 pass, 0 fail, 0 skipped |
| `git diff --check 6aff533..HEAD` | 0 | No whitespace errors |

`npm run pack:clean` was not rerun for this change. The package artifact section
below was recorded earlier; `npm run test:package` rebuilds the tarball from a
clean copy on every run and installs it, which is what the table above shows.

## Regression coverage of the eight fixes

Each fix has regression tests that were written first. They were run against the
`6aff533` source (an archive of that commit, built, with this branch's tests
copied in): across `test/runtime-identity-compat.test.mjs`,
`test/runtime-identity.test.mjs`, `test/setup-core.test.mjs`,
`test/setup-cli.test.mjs`, `test/setup-wizard.test.mjs`, `test/doctor.test.mjs`
and `test/doctor-connect.test.mjs` that run gave 248 tests, 142 pass, 106 fail,
and every test named below failed there, except the ones noted as guarding
behavior that already worked. On the final code commit the same files pass as
part of the full 917/917 run above.

| # | Fix | Regression tests (file: title) |
| --- | --- | --- |
| 1 | Legacy lockless version-1 snapshots verify by their recorded format | `runtime-identity-compat`: "a version-1 lockless snapshot admitted by an earlier release verifies unchanged"; "a legacy version-1 lockless snapshot is refused after ..." (changed, removed or scoped direct dependency; changed, added or removed dist, prompt or agent file; altered loader; altered or redirected dependency location; marker for another run); "a legacy lockless run admitted but not yet snapshotted is copied and verified by its recorded format"; "global layout: stripping the links from the record and the marker does not select the legacy calculation". The legacy identity expectation is a frozen constant produced by running the historical `8f3bd7e` algorithm, not by the current code |
| 2 | Unidentifiable installed dependencies are refused | `runtime-identity`: "consumer layout / global layout: a (direct, direct nested, hoisted transitive, nested transitive) dependency whose package.json is (invalid JSON, an array, a string, null, no version, an empty version, a non-string version) is refused, naming it and nothing of its content" and "... an installed optional dependency with an unidentifiable manifest is refused, an absent one is not"; `doctor`: "required dependencies without a readable package identity make the report not ok, without echoing their content" |
| 3 | Existing coordinator settings are reused under a long home directory | `setup-cli`: "an existing coordinator file with a short state directory is reused under a HOME whose default socket path is too long". The new-file and explicit `--state-directory` cases in the same group guard behavior that already worked and pass on both |
| 4 | Legacy quota settings compare by the effective primary candidate | `setup-core`: "legacy files without a candidate pool are compared by the effective primary candidate"; "explicit values equal to loader defaults and equivalent paths are accepted" |
| 5 | Doctor reports local and connection verdicts separately | `doctor-connect`: connection-failure cases ("basic authentication without the environment password fails before any request", "basic authentication with a wrong password fails on the 401 without leaking either credential", "authentication none against a server that requires credentials fails", "OpenChamber authentication fails for a wrong token", "malformed OpenChamber settings fail without echoing their content", "an unavailable host fails the connection check", "a redirect is a connection failure and is never followed", "an invalid JSON response fails", "an HTTP error status fails", "an invalid info document fails", "a wrong OpenCode version fails ...") now assert a passed local verdict; "a local failure with a verified connection" asserts the reverse and guards behavior that already worked (passes on both) |
| 6 | Doctor warns about group- or other-writable configuration files | `doctor`: "configuration file exposure is described by the access it grants" (modes 0600 to 0666 on both files); "permission findings are advisory warnings, never repaired" |
| 7 | Selected credential references are redacted consistently | `setup-cli`: "a password variable of any name is redacted when named with --password-env NAME or --password-env=NAME", "the password variable of an existing project file is redacted without any flag", "a password variable chosen interactively is redacted in the result and in errors", "partial outcomes and warnings never reveal the referenced credential"; `setup-wizard` (pseudo-terminal): "the wizard's target summary and result redact the variable named by --password-env NAME" and "... =NAME"; `doctor`: "the password variable selected by the project configuration is redacted whatever its name" |
| 8 | Partially created directories are reported | `setup-core`: "directories created before a later directory creation fails are reported and no file is published"; "a directory failure for the second file reports every directory created and the exact partial outcome, and a rerun finishes"; `setup-cli`: "a directory failure after the first file was published reports the directories created, in JSON and human output"; "a first directory creation failure with some directories created is not a partial outcome" |

Known limit of fix 7: the wizard cannot redact output it printed before it learned
a reference. If a target path contains the credential and the variable is chosen
only by answering the wizard prompt, the earlier target-summary lines have
already been printed; the result and error output after the prompt are redacted.
Matching is literal, so only the variable's value itself is masked.

## Package artifact

`npm run pack:clean -- --out DIRECTORY` copies the tracked and untracked,
non-ignored files into a temporary directory, then runs `npm ci --ignore-scripts`,
`npm run build` and `npm pack --ignore-scripts` there. It never reads the
checkout's `dist/` or `node_modules/` and builds no extension.

- Tarball: `open-heimdall-core-0.0.0.tgz` (about 250 KB)
- Version `0.0.0`, `private: true`; nothing was published or given a release version
- Inventory: 159 files, packed from the tree before this record was added (a
  later pack also includes this file under `docs/`)

| Path | Files | Contents |
| --- | --- | --- |
| `package.json`, `README.md` | 2 | Manifest and readme (no `package-lock.json`) |
| `dist/` (CLI, root, `coordinator/`, `opencode/`, `policy/`, `workflow/`, `setup/`, `doctor/`) | 104 | Compiled code and declarations, including `dist/cli.js`, `dist/index.js`, `dist/opencode/plugin.js`, `dist/coordinator/index.js` |
| `dist/vendor/opencode-quota/` | 30 | Vendored 28-file import closure of the four pinned quota provider modules, a manifest and the MIT license |
| `prompts/` | 2 | `planner.md`, `executor.md` |
| `examples/` | 9 | `heimdall.toml`, `coordinator.toml`, three agent definitions, three commands, one plugin |
| `docs/` | 12 | Guides, ADRs and validation records |

No source maps and no `dist/extension*` or `dist/openchamber-extension*` output
are shipped. The `@slkiser/opencode-quota` package is a development dependency
only; the peer conflict with `@opencode/plugin` 2.0.22 is avoided by shipping
the vendored provider modules, so no consumer override is needed.

## Installed-package commands

`npm run test:package` builds the tarball from a clean copy, then installs it
with ordinary npm commands only. A guard rejects overrides, links, `--force`,
`--legacy-peer-deps` and other shortcuts. The commands, with synthetic paths:

```sh
# Fresh consumer project
cd /tmp/consumer && npm install /tmp/pack/open-heimdall-core-0.0.0.tgz

# Temporary user-writable global prefix (no sudo, no real global install)
npm install --global --prefix /tmp/global-prefix /tmp/pack/open-heimdall-core-0.0.0.tgz
```

From a working directory outside the source checkout, with isolated home,
configuration and npm cache directories, the tests run the installed binary:

```sh
heimdall --help
heimdall --version
heimdall coordinator --help
heimdall setup --no-input --json --project /tmp/project \
  --config /tmp/project/.heimdall.toml --coordinator-config /tmp/config/coordinator.toml \
  --planner-model PROVIDER/PLANNER --executor-model PROVIDER/EXECUTOR \
  --quota-provider openai --opencode-url http://127.0.0.1:PORT --opencode-auth none
heimdall doctor --json              # offline
heimdall doctor --connect --json    # against a loopback fixture server
```

Results for both layouts (consumer, global):

- one supported `@opencode/plugin` and no quota-package dependency are resolved;
- the supported exports and the vendored quota helper modules import with
  provider network access disabled;
- the runtime is admitted, an isolated snapshot is created and verified from the
  installed package without a source lockfile, and its plugin imports;
- changing, or removing, a resolved transitive dependency in an isolated fixture
  makes snapshot verification refuse;
- setup writes files that the installed loaders accept; offline doctor passes
  with the connection left unverified; `--connect` against the fixture sends
  exactly one `GET /api/info` request without an `Authorization` header.

## Setup flags and JSON contract

Flags: `--project`, `--config`, `--coordinator-config`, `--planner-model`,
`--executor-model`, `--quota-provider`, `--opencode-url`, `--opencode-auth
basic|none|openchamber`, `--password-env`, `--state-directory`,
`--global-concurrency`, `--project-concurrency`, `--no-input`, `--json`,
`--help`. No flag accepts a password or token.

`setup --json` prints one document with `schemaVersion` `1`, `ok`,
`projectDirectory`, `targets` (`coordinator` and `project`, each with `path` and
`outcome` of `created`, `reused`, `not-written` or `failed`),
`createdDirectories`, `verification` (`level` and the always-unverified
`opencode-connection`, `model-availability`, `provider-login` and `quota`),
`error`, `partial` and `warnings`. Exit status is 0 for complete files and 1
otherwise.

`doctor --json` prints one document with `schemaVersion` `1`, `ok`, `targets`,
`checks` (`id`, `status`, `fatal`, `message`), `verification` (`local`,
`connection` as `not-requested`, `verified` or `failed`, and the always
`unverified` `protectedApiAuthorization`, `modelAvailability`, `providerLogin`
and `quota`) and `error`. The full field tables are in
[installation.md](../installation.md).

## Acceptance coverage

| Item | Evidence (test files; all pass in `npm test` or `npm run test:package`) |
| --- | --- |
| 1. Package, installs, runtime snapshots | `test/package/install.test.mjs` (clean-copy inventory, manifest, shipped imports, consumer and global installs without workarounds, help/version outside the checkout, exports and synthetic quota imports); `test/package/runtime.test.mjs` (admit, snapshot, verify and import in both layouts; changed and removed transitive dependency refused); `test/runtime-identity-compat.test.mjs` (lockfile-mode digest frozen, version-1 snapshots still verify and still refuse tampering); `test/runtime-identity.test.mjs` (existing mismatch and tamper matrix) |
| 2. Setup core and flags | `test/setup-core.test.mjs` and `test/setup-cli.test.mjs`: files accepted by the existing loaders, loader defaults, selected models/provider/endpoint/auth, no service, state or run artifacts, network guard records no attempts; wizard answers equal equivalent flags in `test/setup-wizard.test.mjs` |
| 3. Reruns, failures and races | `test/setup-core.test.mjs`: byte-identical reuse including rich and nondefault files, equivalent explicit defaults and paths, conflicts, incomplete files, invalid input and pairing, malformed/symlink/directory/identical destinations, destination created after validation, failed write without truncated final file, failure after the first file with exact partial outcome and rerun completion; `test/setup-cli.test.mjs` repeats the partial/rerun case through the CLI |
| 4. Wizard PTY and headless | `test/setup-wizard.test.mjs` runs the wizard in a pseudo-terminal (`test/pty/driver.py`): invalid-answer correction, Ctrl-C and EOF cancellation with nothing written, reuse and incomplete-file paths; `test/setup-cli.test.mjs`: `--no-input`, `--json` and non-TTY runs with finite deadlines, an open never-written stdin, stdout/stderr and exit statuses, structured partial outcomes |
| 5. Doctor | `test/doctor.test.mjs` (valid and invalid fixtures offline, no network, no filesystem writes, advisory versus fatal findings, secret sanitization); `test/doctor-connect.test.mjs` (all three auth modes, missing and wrong credentials, unavailable host, timeout, redirect, invalid info, wrong version, only `GET /api/info` requested, no secrets in any output or error path, default 10 s timeout unchanged) |
| 6. CI on macOS and Linux | Job `installed-package` in `.github/workflows/test.yml` (below). Added and syntax-checked locally; **not run** |

## CI jobs added

| Job | Matrix | Steps | Status |
| --- | --- | --- | --- |
| `installed-package` | `ubuntu-latest`, `macos-latest` x Node.js `22.19.0`, `24` (bundled npm; `fail-fast: false`) | print Node and npm versions, `npm ci --ignore-scripts`, `npm run test:package`, `node --test --test-concurrency=1 test/setup-*.test.mjs test/doctor*.test.mjs test/runtime-identity*.test.mjs` | updated, pending (not run): Linux and macOS with Node.js 22.19.0 and 24 have no result |

The matrix is unchanged. The job's test line now also runs
`test/runtime-identity*.test.mjs`, which holds the regression tests for fixes 1
and 2, so those run on every operating system and Node.js version of the matrix
rather than only in `baseline`. The setup and doctor regression tests for fixes 3
to 8 were already matched by the existing patterns. The existing `baseline` and
`macos-harness` jobs are unchanged. The workflow
never installs `npm@latest`: npm 12.2.0 requires Node.js `^22.22.2 || ^24.15.0
|| >=26`, which Node.js 22.19.0 does not satisfy. Expected bundled npm, from the
Node.js distribution index and the npm registry manifests: npm 10.9.3 with
Node.js 22.19.0 and npm 11.19.0 with Node.js 24. These are expectations from
metadata, not results from a run. Nothing was pushed to obtain CI evidence.

## Scope review

`git diff --stat 6aff533..HEAD` (before this record) shows 17 files:
`src/workflow/runtime-identity.ts`, `src/coordinator/runtime-snapshot.ts`,
`src/setup/` (`cli.ts`, `core.ts`, `publish.ts`, `wizard.ts`), `src/doctor/`
(`checks.ts`, `cli.ts`), seven test files, `docs/installation.md` and
`.github/workflows/test.yml`. `AGENTS.md`, `prompts/`, roles, `examples/` and
`.heimdall/` are unchanged, and `package.json` and its lockfile are unchanged, so
no dependency changed. The added lines contain no home-directory paths; the tests
use synthetic paths and sentinel values.

## Remaining limits

- No public release or registry publication; the tarball is a local artifact and
  the package stays private at version `0.0.0`.
- No live host or provider verification: no real OpenCode server, OpenChamber
  Desktop, provider login or quota was contacted. `doctor --connect` was
  exercised only against loopback fixture servers.
- Even a successful `doctor --connect` leaves protected-API authorization, model
  availability, provider login and quota unverified.
- The coordinator was not started, no run was submitted and no execution was
  verified by this work.
- Windows is unsupported and untested.
- Everything above was run on a single macOS host with Node.js v22.22.3. Linux,
  Node.js 22.19.0 exactly and Node.js 24 were not run; they depend on the
  pending, not executed `installed-package` CI job, and nothing was pushed to
  obtain CI evidence. No platform parity is claimed.
- Fix 7 redacts literal credential values only, and cannot unprint output the
  wizard wrote before it learned a reference (see the note under the regression
  table).
- The PTY wizard tests need `python3` with the `pty` module; they skip with an
  explicit reason where it is missing (they ran, not skipped, in the local
  results above).
- Installs fetch declared dependencies from the npm registry; no offline bundle
  exists.
