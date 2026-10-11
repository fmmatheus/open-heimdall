# Installation, setup and doctor validation

Automated and local verification of the installable tarball, `heimdall setup`
and `heimdall doctor` (guide: [installation.md](../installation.md)).

**Status: local automated checks PASSED on macOS. CI jobs for macOS and Linux are
added but PENDING (not run). No live host or provider verification was done.**
Fixture and synthetic-project tests do not prove behavior against a user's
OpenCode server, OpenChamber Desktop, provider accounts or quota. This record
does not show that the coordinator was started or that a run can execute.

## Environment

| Item | Value |
| --- | --- |
| Date | 2026-10-11 |
| Verified code | `0e555b8` (`docs: add installation and setup guide`), the last commit that changed code or tests. The commit that adds this record changes only this file. |
| Branch | `heimdall/run/8393310b-67b0-4e75-b553-9eec7f6c2c94`, based on `8f3bd7e` |
| OS | macOS 27.0.1 (Darwin 27.0.0, arm64) |
| Node.js | v22.22.3 |
| npm | 10.9.8 |
| Registry access | Required (`npm ci` and ordinary tarball installs fetch declared dependencies) |

Not run locally: Linux, Node.js 22.19.0 exactly, Node.js 24, Windows.

## Command results

All commands ran from the repository root on `0e555b8` with a clean tree.

| Command | Exit | Result |
| --- | --- | --- |
| `npm ci --ignore-scripts` | 0 | Locked dependencies installed |
| `npm run check` | 0 | TypeScript check passed |
| `npm test` | 0 | 803 tests, 803 pass, 0 fail, 0 skipped (includes the PTY wizard tests) |
| `npm run build:extension` | 0 | Build and extension bundle completed |
| `npm run test:package` | 0 | 19 tests, 19 pass, 0 fail, 0 skipped |
| `npm run pack:clean -- --out DIRECTORY` | 0 | Tarball built from a clean copy (below) |
| `git diff --check 8f3bd7e..HEAD` | 0 | No whitespace errors |

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
| 5. Doctor | `test/doctor.test.mjs` (valid and invalid fixtures offline, no network, no filesystem writes, advisory versus fatal findings, secret sanitization); `test/doctor-connect.test.mjs` (24 tests: all three auth modes, missing and wrong credentials, unavailable host, timeout, redirect, invalid info, wrong version, only `GET /api/info` requested, no secrets in any output or error path, default 10 s timeout unchanged) |
| 6. CI on macOS and Linux | Job `installed-package` in `.github/workflows/test.yml` (below). Added and syntax-checked locally; **not run** |

## CI jobs added

| Job | Matrix | Steps | Status |
| --- | --- | --- | --- |
| `installed-package` | `ubuntu-latest`, `macos-latest` x Node.js `22.19.0`, `24` (bundled npm; `fail-fast: false`) | print Node and npm versions, `npm ci --ignore-scripts`, `npm run test:package`, `node --test --test-concurrency=1 test/setup-*.test.mjs test/doctor*.test.mjs` | pending (not run) |

The existing `baseline` and `macos-harness` jobs are unchanged. The workflow
never installs `npm@latest`: npm 12.2.0 requires Node.js `^22.22.2 || ^24.15.0
|| >=26`, which Node.js 22.19.0 does not satisfy. Expected bundled npm, from the
Node.js distribution index and the npm registry manifests: npm 10.9.3 with
Node.js 22.19.0 and npm 11.19.0 with Node.js 24. These are expectations from
metadata, not results from a run. Nothing was pushed to obtain CI evidence.

## Scope review

`git diff --stat 8f3bd7e..HEAD` shows 39 files: the workflow, README and three
docs, `package.json` and its lockfile, `scripts/pack.mjs` and
`scripts/vendor-quota.mjs`, the CLI, configuration, quota, observer, runtime
identity and snapshot sources, `src/setup/` and `src/doctor/`, and their tests.
`AGENTS.md`, `prompts/`, `examples/opencode/agents/` and `.heimdall/` are
unchanged. A search of the changed files for home-directory paths and
credential-like strings found only synthetic example paths, header names in the
redaction code and tests, and sentinel values in tests.

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
- Linux, Node.js 22.19.0 exactly and Node.js 24 were not run locally; they depend
  on the pending CI job.
- The PTY wizard tests need `python3` with the `pty` module; they skip with an
  explicit reason where it is missing (they ran, not skipped, in the local
  results above).
- Installs fetch declared dependencies from the npm registry; no offline bundle
  exists.
