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
  process that already served the owner's profile kept its original start time.
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

## Unverified

- Model-backed behavior of the skills in either arm (see the evaluation kit above):
  whether the right skill loads for each prompt, whether the without-skill arm differs,
  and the boundary prompt outcome.

- Loading any of the skills in a model-backed OpenCode or OpenChamber session: the
  `skill` tool call, the printed base directory, running the helper from it, `@skill-id`
  mentions, the OpenChamber `/` picker and permissions prompts.
- OpenChamber 2.1.0 printing the base directory; its UI; overwrite semantics.
- `.claude/skills` and `.agents/skills` locations, `opencode debug config` output,
  and native Windows.
- Behavior of any OpenCode or OpenChamber version other than 2.0.22 and 2.1.0.
