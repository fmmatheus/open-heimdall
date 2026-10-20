# OpenHeimdall skills: host loading validation

Records whether OpenCode 2.0.22 and OpenChamber 2.1.0 discover and load the three
OpenHeimdall skills (`openheimdall-start`, `openheimdall-monitor`,
`openheimdall-resume`) from the packed tarball. Guide: [skills.md](../skills.md).

**Status: discovery and catalog installation PASSED in isolated hosts. Loading a
skill inside a model-backed session, the OpenChamber UI and OpenChamber's base
directory exposure are NOT verified (see [Unverified](#unverified)).**

No model, credential, user profile, running host or coordinator was used.

## Environment

| Item | Value |
| --- | --- |
| Date | 2026-10-15 |
| Verified code | `a7c7d47` (`docs(skills): add skills guide and dogfood example`) plus the two harness scripts committed with this record |
| Branch | `heimdall/run/60594e5b-5a51-4c40-b236-2d53bdbd5a3b` |
| OS / Node.js | macOS 27.0.1 (Darwin, arm64) / v22.22.3 |
| OpenCode | `opencode v2.0.22` (`opencode --version`) |
| OpenChamber | `@openchamber/web` **2.1.0** (`/health` and `/api/version` report `openchamberVersion: "2.1.0"`) |
| Tarball | `npm run pack:clean` output (214 files, `skills/` holds the six expected files) |

## Isolation

- Every host process ran with a scrubbed environment: `HOME`, `XDG_CONFIG_HOME`,
  `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `XDG_STATE_HOME`, `TMPDIR` (and for
  OpenChamber `OPENCHAMBER_DATA_DIR`) inside a per-run temporary directory, a minimal
  `PATH`, no credentials, and a random loopback port. `OPENCODE_CONFIG_DIR` was set
  only for the custom-directory scenario.
- OpenCode runs a background service by default (`opencode service`). It was never
  started, queried or stopped: each check used its own `opencode serve` instance. The
  process that already served the host's existing service kept its original start time.
- The packed tarball and the OpenChamber install were created with an isolated npm
  `HOME` and cache.
- All temporary directories and processes were removed afterwards (the harness
  deletes its sandbox unless `--keep` is given).

## OpenCode 2.0.22

### Method

`opencode debug` has only `agents`, `config` and `paths`, so there is no CLI command
that lists skills. The OpenCode 2.0.22 server API does: `GET /api/skill` (operation
`skill.list`, "Retrieve currently registered skills") returns `id`, `name`,
`description`, `autoinvoke`, `path` and the loaded `content` for the location given by
`location[directory]`. It does not call a model. `opencode serve` protects the API with
basic auth (user `opencode`, a password it generates and prints at startup); the harness
reads that password from the process output.

Skills are loaded asynchronously after the first request for a location, so the first
answers can be an empty list. The harness polls until the listing is non-empty and
unchanged. With debug logging the server also prints one `skill source loaded` line per
source directory, which the harness records.

```sh
npm run pack:clean -- --out "$OUT"
node scripts/live/skills-host/opencode-discovery.mjs --tarball "$OUT"/open-heimdall-core-0.0.0.tgz --json "$OUT/observations.json"
```

The harness extracts the tarball, copies the skills with the exact loop from
[skills.md](../skills.md) (`cp -R`, skip when the target exists), starts a private
`opencode serve --hostname 127.0.0.1 --port <random>` per scenario in a synthetic Git
project, and queries `/api/skill`.

### Observations

| Scenario | Install target | Skills loaded (path prefix of `SKILL.md`) | Result |
| --- | --- | --- | --- |
| Baseline | none | none of ours; built-ins `opencode`, `report` only | PASS (control) |
| Personal | `$XDG_CONFIG_HOME/opencode/skills` | all three, from `<home>/.config/opencode/skills/` | PASS |
| Project | `<project>/.opencode/skills` | all three, from `<project>/.opencode/skills/` | PASS |
| Custom config dir | `$OPENCODE_CONFIG_DIR/skills` (`OPENCODE_CONFIG_DIR` set, a different directory than `XDG_CONFIG_HOME/opencode`) | all three, from `<custom>/skills/` | PASS |
| Existing same-named skill | personal `openheimdall-start` created by hand before running the copy loop | copy loop printed `skip: …/skills/openheimdall-start already exists`; host loads the pre-existing `openheimdall-start` (description "Pre-existing user skill, not from the package.", 21-byte content, no `scripts/`), and the other two from the package | PASS: the loop refuses, the host loads the existing one |
| Same ID in personal and project | stale personal `openheimdall-start`, full bundle in the project | all three from the project directory; the server logged both sources, and the project copy is the one reported | PASS: project scope wins (confirms the statement in the guide) |

For each of the three package scenarios and for each skill:

- `id` equals the directory name; `name` equals `id`.
- `description` equals the frontmatter description of the packed `SKILL.md`.
- `content` equals the body of the packed `SKILL.md` after the frontmatter (the
  harness compares it; `contentIsPackedBody: true`). Content sizes: monitor 5458 bytes,
  resume 5953 bytes, start 5970 bytes.
- `scripts/openheimdall.mjs` is present next to the loaded `SKILL.md`, so
  `dirname(path)` — the "Base directory for this skill" that the host reports to the
  model — contains the helper.
- Debug log line, for example: `skill source loaded source=directory:<home>/.config/opencode/skills … skills=["openheimdall-monitor","openheimdall-resume","openheimdall-start"]`.

H3 from the plan (a non-model way to list discovered skills) is therefore confirmed
for 2.0.22 through the server API, not through the CLI.

### What this does not show

The literal "Base directory for this skill: …" text is produced when the `skill` tool
runs in a session. Creating a session that executes the tool needs a model, so only
the pinned source (`packages/core/src/skill.ts`, commit `527f0b9`) and the reported
`path` back it. The `@skill-id` mention was not exercised.

## OpenChamber 2.1.0

### Method

An exact 2.1.0 install was made in a temporary directory:

```sh
npm install @openchamber/web@2.1.0 --ignore-scripts --no-audit --no-fund --save-exact
```

Native build scripts were skipped; the terminal features that need them were not used.
The server ran in the foreground, `--api-only`, on a random loopback port, and started
its own managed OpenCode (`opencode serve` 2.0.22, port allocated by OpenChamber)
with the same isolated environment. `OPENCODE_HOST`, `OPENCODE_PORT` and
`OPENCODE_SKIP_START` were not set, so it could not attach to another instance.

OpenChamber accepts only `owner/repo[/subpath]`, `https://` and `git@` sources; there
is no local path form. The local clone was therefore reached by giving the server
process `GIT_CONFIG_*` variables that rewrite the clone URL of the placeholder
repository `https://github.com/example/openheimdall.git` to a local clone of this
branch (`git clone --branch <branch>`, HEAD `a7c7d47`; `skills/` held the six
expected files). The harness then called the routes that Settings → Skills → Catalog
uses (`packages/web/server/lib/opencode/skill-routes.js`):

```sh
node scripts/live/skills-host/openchamber-catalog.mjs --install-dir "$INSTALL" --opencode "$(command -v opencode)" --json "$OUT/openchamber.json"
```

### Observations

| Step | Route | Result |
| --- | --- | --- |
| Start | `GET /health` | `status: ok`, `openchamberVersion: "2.1.0"` |
| Scan the source with subpath `skills` | `POST /api/config/skills/scan` | HTTP 200; three items, `installable: true`, `skillName` equals `frontmatterName`, descriptions match the packed files |
| Install, personal scope (`scope: user`, `targetSource: opencode`) | `POST /api/config/skills/install` | HTTP 200; installed `openheimdall-monitor`, `-resume`, `-start`. `<home>/.config/opencode/skills/` holds exactly `SKILL.md` and `scripts/openheimdall.mjs` for each, no symlinks |
| Install again, no policy | same | HTTP 409 `conflicts` listing all three, nothing changed |
| Install again, `conflictPolicy: skipAll` | same | HTTP 200; `installed: []`, three entries `Already installed (skipped)` |
| Install, project scope (`?directory=<project>`) | same | HTTP 200; the same three skills; `<project>/.opencode/skills/` has the same six files |
| List for the project directory | `GET /api/config/skills?directory=<project>` | HTTP 200, `openCodeSkillsUnavailable: false` (the list came from the managed OpenCode 2.0.22); the three skills are listed with `scope: project`, `source: opencode`, the project path and the packed descriptions (the project copy wins over the personal one, as in OpenCode) |
| Skill detail | `GET /api/config/skills/openheimdall-start?directory=…` | HTTP 200 |

The server log showed the managed OpenCode starting on its own allocated port and no
error. The server and its OpenCode child were stopped by the harness.

### What this does not show

- The Settings → Skills → Catalog UI, including adding a custom source in the
  interface, was not exercised. The custom source was passed per request; the saved
  `skillCatalogs` settings path (`GET /api/config/skills/catalog` and
  `/catalog/source`) was not driven.
- The `overwriteAll` / per-skill `overwrite` decision was not run, so what it does to
  an existing directory is unverified.
- Whether OpenChamber 2.1.0 prints the skill's base directory to the model was not
  observed (needs a model-backed session).
- The route was driven against a placeholder GitHub name redirected with Git
  configuration; a real remote, SSH identities and private repositories were not
  tried.

## Harness

- `scripts/live/skills-host/opencode-discovery.mjs`: OpenCode scenarios above.
- `scripts/live/skills-host/openchamber-catalog.mjs`: OpenChamber scenarios above.

Both create their own temporary sandbox, remove it when done (`--keep` preserves it
for inspection) and print JSON observations. They are manual tools, not part of
`npm test`.

## Behavior evaluation kit

`scripts/live/skills-eval/` compares an agent with and without the skills on five
synthetic requests (start from a specification file, snapshot status, bounded watch,
resume with a guidance file, and a boundary prompt that names a guidance file as if it
were a specification). A fake `heimdall` command line records argv and answers canned
coordinator documents, so mutating calls can be counted without a coordinator. See the
kit's [README](../../scripts/live/skills-eval/README.md).

### Deterministic helper results (PASSED)

`node scripts/live/skills-eval/run-eval.mjs selftest` ran on 2026-10-15 (Node.js
v22.22.3, no model, no credentials, no network) against the packaged helper:

| Check | Recorded mutating calls |
| --- | --- |
| Start from `specs/add-greeting.md` | one `run submit` with the registered project id, `--feature` and `--base <HEAD>` |
| Snapshot of a queued run | none |
| Bounded watch of a run that pauses | none; the final event is `stopped` with reason `paused` |
| Resume with `guidance/pick-format.md` | one `run resume` for the same run id, `--input` starting with the labeled guidance header; run id preserved |
| `inspect-spec` on the guidance file | none; flagged as resume guidance and the existing run id reported |
| Resume of a queued (not paused) run | refused as `not-resumable`; none |
| Sandbox isolation | skills only in the with-skills arm; every sandbox path variable stays inside the sandbox |

This establishes the helper and the shim only. It says nothing about whether a model
loads a skill or chooses these commands.

After the independent review, the same selftest passed again with the corrected
helper. The review corrections are covered by automated tests only: a blocker is
reported up to 1500 characters with a `blockerTruncated` flag, `start --register` from
a linked worktree registers the main worktree (and stops when it cannot be derived),
and the skill text single-quotes shell values, reads runs only through the helper
and removes the temporary guidance file. Skill frontmatter and the packaged file
layout did not change, so the host discovery results above still apply.

### Model-backed behavior (NOT RUN)

No approved model, provider credential or model-backed environment was supplied for
this work, so the with-skill and without-skill arms were not executed and no model
output was recorded. The `run` command refuses to start without an explicit `--model`
and `--pass-env`. To obtain the evidence, an operator with an approved environment runs:

```sh
node scripts/live/skills-eval/run-eval.mjs run --model PROVIDER/MODEL --pass-env NAME[,NAME] --auto --out "$OUT"
```

and records `results.json` (skills loaded, mutating counts, argv, expectation flags) for
both arms. The `run` path, including the parsing of skill loads from
`opencode run --format json`, has not been exercised against a real model; treat its
first results as a check of the harness as well as of the skills.

## Final integrated verification

Run on the settled tree at `f23f7da` (`fix(skills): address review findings`), which
is the last code and skill change; this record is the only later edit. Commits since
the base `71be91d`: `e426fb4`, `cbb9953`, `2b34846`, `125c127`, `a7c7d47`, `2a98fe1`,
`1bc7a2d`, `f23f7da`.

| Item | Value |
| --- | --- |
| Date | 2026-10-15 |
| OS | macOS 27.0.1 (Darwin, arm64) |
| Node.js / npm | v22.22.3 / 10.9.8 |
| OpenCode | `opencode v2.0.22` |

| Check | Result |
| --- | --- |
| `npm run check` | exit 0, no type errors |
| `npm test` | 1525 tests, 1525 pass, 0 fail, 0 cancelled, 0 skipped |
| `npm run build:extension` | exit 0 |
| `npm run test:package` | 74 tests, 74 pass, 0 fail, 0 cancelled |
| `git diff --stat 71be91d..HEAD -- src` | empty: no coordinator lifecycle, CLI or service change, so the native lifecycle suites were not run separately |
| `npm pack --dry-run --ignore-scripts` | 215 files; `skills/` holds exactly `openheimdall-{start,monitor,resume}/SKILL.md` and `openheimdall-{start,monitor,resume}/scripts/openheimdall.mjs` |
| Helper copies | `cmp` identical across the three skills; no symlinks under `skills/` |

Review of the correction diff (`f23f7da`) found no regression and no unresolved finding:
each correction has a test that failed before it. The one assertion that changed
(`blocker.length <= 300` to `<= 1500`) tracks the corrected limit rather than weakening
a check. The inspect-spec resume-guidance heuristic was left unchanged on purpose;
the start skill asks whenever the request and the file disagree.

These runs are automated tests. They do not exercise a model, the OpenChamber UI or a
live coordinator started by the owner.

## Git environment and evaluator mutation fixes

Two defects found in the delivered skills were fixed after the verification above. This
section records the reproductions, the regression coverage, the review and the final
results. It supersedes the helper and evaluator results above wherever they differ; the
host discovery results are unaffected because skill frontmatter and file layout did not
change.

### Defect 1: helper Git commands followed ambient Git overrides

The helper ran `git -C <directory>` with a copy of the caller's environment. When
`GIT_DIR` and `GIT_WORK_TREE` were set (for example inside a Git hook or a wrapper), Git
ignored `-C` and reported the repository named by the variables, so the helper could
describe, select runs for, or submit a run for the wrong repository.

Reproduction on synthetic repositories `repo-a` (selected with `--cwd`) and `repo-b`
(named by the variables), with a fake `HEIMDALL_BIN`:

| Command with `GIT_DIR=<repo-b>/.git`, `GIT_WORK_TREE=<repo-b>` | Before (`0ef74b0`) | After (`0c89582`) |
| --- | --- | --- |
| `context --cwd <repo-a>` | `topLevel` and `head` of `repo-b` | `topLevel`, `commonGitDirectory` and `head` of `repo-a` |
| `snapshot --cwd <repo-a>` with one active run in each repository | selected the run of `repo-b` | selected the run of `repo-a`; an explicit run ID still wins |
| `start` from `repo-a` (fake command line) | `run submit` for the project of `repo-b` | one `run submit` for the project of `repo-a`, absolute specification path and full base OID |
| `start --register` from `repo-a` | no `project add` recorded for `repo-a` | proposes the main worktree of `repo-a`; nothing registered for `repo-b` |

The fix adds an exported `gitEnvironment(env)` to the helper. It returns a copy of the
supplied environment with `GIT_OPTIONAL_LOCKS=0`, without `GIT_DIR`, `GIT_WORK_TREE`,
`GIT_COMMON_DIR`, `GIT_INDEX_FILE`, `GIT_OBJECT_DIRECTORY`,
`GIT_ALTERNATE_OBJECT_DIRECTORIES`, `GIT_NAMESPACE`, `GIT_CONFIG`, `GIT_CONFIG_COUNT`,
`GIT_CONFIG_PARAMETERS` and every `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`. It is
applied only inside the helper's single `git()` function; `GIT_CONFIG_GLOBAL`,
`GIT_CONFIG_NOSYSTEM`, `HEIMDALL_BIN`, `HEIMDALL_COORDINATOR_CONFIG` and the environment
handed to the coordinator command line are unchanged. The three skill copies remain
byte-identical and import only `node:` built-ins.

### Defect 2: the evaluator ignored unlisted mutating calls

`run-eval.mjs` compared recorded mutation counts only for keys listed in a scenario's
`expect.mutations`. A `start` attempt (which the fake command line rejects but still
records) during a snapshot scenario therefore left `mutationExpectationMet` true.

Reproduction through `run-eval.mjs run` with an explicit fake OpenCode that calls
`heimdall coordinator start` and prints an `openheimdall-monitor` skill marker
(`--model fake/model`, a synthetic `--pass-env` variable, prompt `snapshot-status`):

| Row in `results.json` | Before (`ad166c8`) | After (`b9c9a38`) |
| --- | --- | --- |
| `mutations` | `{ "start": 1 }` | `{ "start": 1 }` |
| `skillExpectationMet` | `true` | `true` |
| `mutationExpectationMet` | `true` (false pass) | `false` |

The process exit status is 0 in both cases; the verdict is only in the row. `prompts.json`
now states `expect.mutationPolicy` per scenario instead of `expect.mutations`: a map
from mutation key to an exact count or a `{ "min", "max" }` range, and every key that is
not listed is allowed zero times. Policies: start `{"run submit":1}`; snapshot and watch
`{}`; resume `{"run resume":1}`; boundary `{"run resume":{"min":0,"max":1}}`. Result row
fields are unchanged. The kit's README describes the policy shape.

### Regression coverage

All of it runs inside `npm test` with synthetic repositories and an explicit fake host;
no model, credential or real OpenCode is used.

| Test file | Coverage |
| --- | --- |
| `test/skills-helper-readonly.test.mjs` | `context` and `snapshot`/`watch`/explicit run ID under a poisoned environment; the `gitEnvironment` policy (every listed variable, indexed config entries, retained variables, no mutation of the input or `process.env`) |
| `test/skills-helper-mutations.test.mjs` | `start` under a poisoned environment: fake command line, coordinator-backed, linked worktree, `--register` |
| `test/skills-eval-policy.test.mjs` | policy unit cases: zero-mutation scenarios with each injected mutation, start 0/1/2/extra, resume 0/1/2/extra, ambiguous 0/1/2/other, unknown key, malformed policy |
| `test/skills-eval-runner.test.mjs` | end-to-end `results.json` rows for start, resume, ambiguous and watch, plus the false-pass reproduction and a clean control |

Failing-before evidence, from running the new tests against the unmodified code:

- Helper (`0ef74b0`): the `context` test failed with `topLevel` equal to `repo-b`
  instead of `repo-a`; the monitor test failed with `'run-b' !== 'run-a'`; all four
  `start` tests failed (a submission for the project of `repo-b`, a run created for the
  wrong project, and a missing `project add` for `--register`).
- Evaluator (`ad166c8`): the start-attempt runner test failed with
  `true !== false` on `mutationExpectationMet`.

After the fixes all of them pass.

### Review

An independent review of `0ef74b0..5e9ad4e` exercised both real paths (the helper
command line under a poisoned environment and the runner with a fake OpenCode attempting
a coordinator start) and ran the focused suites (97 tests, 97 pass) and the selftest.

| Finding | Classification | Disposition |
| --- | --- | --- |
| Removal of `GIT_CONFIG_COUNT`/`KEY_<n>`/`VALUE_<n>` and `GIT_INDEX_FILE` is proven by the unit-level `gitEnvironment` test, not by an end-to-end helper run | Benched | Left unchanged; the reviewer confirmed by hand that `context` still reports the selected repository with those variables set |
| `key in policy` in `run-eval.mjs` would also match inherited `Object.prototype` names | Benched | Left unchanged; unreachable because recorded keys come only from the fake command line's fixed mutating set |

No material finding was reported, so the correction step made no change and no commit.
The benched items remain open as optional polish.

### Final results

Run on the settled code at `5e9ad4e` (`test(skills-eval): cover each mutation policy
through the runner`), the last code change; this record is the only later edit. Code
commits since `0ef74b0`: `0c89582` (helper fix), `ad166c8` (start regressions),
`b9c9a38` (evaluator fix), `5e9ad4e` (runner regressions and README).

| Item | Value |
| --- | --- |
| Date | 2026-10-19 |
| OS | macOS 27.0.1 (Darwin, arm64) |
| Node.js / npm / Git | v22.22.3 / 10.9.8 / 2.54.0 (Apple Git-157); minimum Node.js is 22.19 |
| Isolation | each command ran in the foreground with `HOME`, `TMPDIR` and `XDG_*` inside a short temporary root |

| Check | Result |
| --- | --- |
| `npm run check` | exit 0, no type errors |
| `npm test` | exit 0; 1550 tests, 1550 pass, 0 fail, 0 cancelled, 0 skipped; the new helper, policy and runner tests appear by name |
| `npm run build:extension` | exit 0 |
| `npm run test:package` | exit 0; 74 tests, 74 pass, 0 fail, 0 cancelled, 0 skipped |
| `node scripts/live/skills-eval/run-eval.mjs selftest` | exit 0, `"selftest": "passed"` |
| `npm pack --dry-run --ignore-scripts` | 215 files; `skills/` holds exactly the six expected files (`SKILL.md` and `scripts/openheimdall.mjs` for each of the three skills) |
| Helper copies | `cmp` identical across the three skills |
| `git diff 0ef74b0..HEAD -- src` | empty: no coordinator, CLI or service change |

Limits of this evidence: the regressions use a fake command line, a coordinator-backed
fixture and a fake host. They show the helper and the evaluator, not model behavior or
host and UI behavior. The temporary root and its logs were removed after the runs.

## Combined OpenCode 2.0.32 integration

Checked on 2026-10-19 on macOS arm64 with Node.js 22.22.3 and npm 10.9.8.
The verified code is merge `156bea2`, combining the skills fixes at `a088fcf`
with the OpenCode 2.0.32 compatibility and ownership protections at `f009743`.
Later integration edits only clarify this record and the skills guide.

The integration leaves `src/` and `package-lock.json` unchanged from `f009743`.
Both SDK dependency pins remain 2.0.32, the ownership-guard export is retained,
and all three skill helpers remain byte-identical to `a088fcf`. Two independent
reviews found no material integration issue. The benched observations above
remain unchanged.

Commands used isolated temporary HOME, XDG and temporary directories, with host
Git signing settings excluded. No existing coordinator or run was changed.

| Check | Result |
| --- | --- |
| `npm ci --ignore-scripts` | exit 0, locked dependencies installed |
| `npm run check` | exit 0 |
| `npm test` with default parallelism | 1584 pass, 1 fail, 1 skip; the coordinator-service launch-settling test failed and the process later required termination; not counted as a passing run |
| `node --test --test-concurrency=2 test/*.test.mjs` after the successful package build | exit 0; 1586 tests, 1585 pass, 0 fail, 1 skip |
| Focused `test/coordinator-service.test.mjs` | 10 pass, 0 fail |
| `npm run build:extension` | exit 0 |
| `node scripts/live/skills-eval/run-eval.mjs selftest` | exit 0, passed |
| `node --test --test-concurrency=1 test/package/*.test.mjs` after the successful package build | exit 0; 74 pass, 0 fail or skip; no concurrent rebuild of the checkout |
| Real OpenCode 2.0.32 compatibility fixture | passed with a synthetic local model and quota; native continuation, two accepted tasks, pause, same-run resume and five archived messages; server stopped and fixture removed |

The default-suite failure exceeded the existing fixture's launch-settling budget
in `test/coordinator-service.test.mjs`. The exact cleanup wait was not established.
Earlier parallel-run instability is recorded in the
[coordinator lifecycle validation](coordinator-lifecycle.md#npm-test-on-the-macos-host-recorded-instability).
The focused pass and reduced-concurrency pass do not establish that default
parallelism is reliable; that existing issue remains benched. The single skipped
core case requires a usable Bun and sandbox-exec guard-wrapper environment.

Package checks used ordinary consumer and temporary global npm installations,
freshly built tarballs, all four export imports, SDK 2.0.32 and Effect 4.0.1 API
probes, changed/removed dependency refusal, and the six packaged skill files.
The native-host fixture used no real provider credentials or model requests.
These checks do not reverify skill discovery on OpenCode 2.0.32 or model-backed
skill behavior. Linux and additional Node versions remain CI checks; owner
dogfood remains pending.

## Unverified

- Owner dogfood: the end-to-end start, monitor, pause, resume and monitor sequence in
  [`examples/skills-dogfood`](../../examples/skills-dogfood/README.md) is **pending**
  and operated by the owner. It is an outstanding verification step, not a known defect.

- Model-backed behavior of the skills in either arm (see the evaluation kit above):
  whether the right skill loads for each prompt, whether the without-skill arm differs,
  and the boundary prompt outcome.

- The Git environment and evaluator fixes are covered by fake-host and synthetic
  fixture regressions only; they are not model-backed acceptance. The two benched review
  observations above remain open.

- Loading any of the skills in a model-backed OpenCode or OpenChamber session: the
  `skill` tool call, the printed base directory, running the helper from it, `@skill-id`
  mentions, the OpenChamber `/` picker and permissions prompts.
- OpenChamber 2.1.0 printing the base directory; its UI; overwrite semantics.
- `.claude/skills` and `.agents/skills` locations, `opencode debug config` output,
  and native Windows.
- Skill discovery and model-backed skill behavior on OpenCode versions other than
  2.0.22, including the currently supported 2.0.32. The separate
  [native compatibility check](opencode-2.0.32.md) exercises workflow execution,
  rather than skill loading. OpenChamber versions other than 2.1.0 are unverified.
