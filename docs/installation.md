# Installation and setup

Heimdall has no public release yet and is not published to a package registry.
You install it from a tarball that you build from this repository. This guide
covers building the tarball (the producer), installing it (the consumer),
creating the configuration with `heimdall setup`, and checking the result with
`heimdall doctor`.

All paths, URLs and model names below are synthetic examples. Replace them with
your own.

## Requirements

- Node.js **22.19** or newer, with npm.
- Git, and a Git project that has at least one commit.
- A running local **OpenCode 2.0.22** server. Heimdall supports only that
  OpenCode version and only loopback URLs (`localhost`, `127.0.0.1` or `[::1]`).
- Registry access for the producer's `npm ci`; the consumer's install also
  fetches the package's dependencies from the npm registry.

## Build the tarball (producer)

Run these steps once per build, in a clone of this repository:

```sh
git clone https://github.com/fmmatheus/open-heimdall.git
cd open-heimdall
npm ci --ignore-scripts
npm run pack:clean -- --out /path/to/output
```

`npm run pack:clean` copies the tracked and untracked-but-not-ignored files into
a disposable directory, then runs `npm ci --ignore-scripts`, `npm run build` and
`npm pack` there. The checkout's `dist/` and `node_modules/` are never used, so
stale build output cannot reach the tarball. It prints the tarball path and the
file inventory. `--out DIRECTORY` selects where the tarball is written; without
it a temporary directory is used. `--keep` retains the disposable source copy.

The tarball is named after the package and version, for example
`open-heimdall-core-0.0.0.tgz`. Plain `npm pack` also works after
`npm run build`, but it packs whatever is in the checkout's `dist/`;
`pack:clean` is the supported way to build a tarball.

The tarball contains the built CLI, prompts, examples and these docs. It does not
contain sources, tests, the OpenChamber extension build or `node_modules`. See
[Packaging](development.md#packaging) for the inventory and the reason the quota
provider modules are vendored.

## Install the tarball (consumer)

Install the tarball globally with ordinary `npm install`. No overrides,
`--force`, `--legacy-peer-deps` or links are needed.

```sh
npm install --global /path/to/output/open-heimdall-core-0.0.0.tgz
heimdall --version
```

### Install without sudo

Do not use `sudo` for a global install. If `npm install --global` fails with a
permission error, point npm at a prefix your user owns, either for one install:

```sh
npm install --global --prefix "$HOME/.local" /path/to/output/open-heimdall-core-0.0.0.tgz
```

or permanently:

```sh
npm config set prefix "$HOME/.local"
```

Then make sure `$HOME/.local/bin` is on your `PATH` (add it to your shell
profile) and open a new shell. Check with `command -v heimdall`. `npm prefix
--global` shows the prefix npm is using; the installed package, including its
`examples/` and `docs/`, is under `$(npm root --global)/@open-heimdall/core`.

To remove it later, run `npm uninstall --global @open-heimdall/core` with the same
prefix. Configuration and state files are never removed by npm.

## Create the configuration with `heimdall setup`

Run `heimdall setup` from the Git project you want Heimdall to work on, or pass
`--project DIRECTORY`. It writes two files, each only when it is absent:

- the **coordinator configuration**, shared by all projects, and
- the **project configuration**, `.heimdall.toml` in the project.

Setup does not initialize Git, create commits, start a coordinator, register the
project, create state directories or contact OpenCode or any provider. It
validates every file it writes (and every existing file it reuses) with the same
loaders the coordinator uses.

### Interactive wizard

In a terminal, run `heimdall setup` without `--no-input` or `--json`. The wizard
asks only for decisions that are still missing: planner model, executor model,
quota provider, OpenCode URL and authentication mode. For `basic` authentication
it asks for the *name* of the environment variable that holds the password
(default `OPENCODE_PASSWORD`); it never asks for the password itself. If the
current directory is not in a Git project it asks for the project directory.
Nothing is written until every answer is valid, and Ctrl-C cancels without
writing.

### Non-interactive setup

Supply every decision as a flag:

```sh
heimdall setup \
  --planner-model PROVIDER/PLANNER --executor-model PROVIDER/EXECUTOR \
  --quota-provider openai --opencode-url http://127.0.0.1:4096 \
  --opencode-auth basic --no-input
```

Replace the model placeholders with models that are available through your
OpenCode accounts. Setup does not check availability, and it rejects the
placeholder models from the shipped template.

### Flag reference

| Flag | Meaning |
| --- | --- |
| `--project DIRECTORY` | Existing Git project with a commit. Default: the current Git project. |
| `--config FILE` | Project configuration. Default: `$HEIMDALL_CONFIG`, else `.heimdall.toml` in the project. |
| `--coordinator-config FILE` | Coordinator configuration. Default: `$HEIMDALL_COORDINATOR_CONFIG`, else `~/.config/heimdall/coordinator.toml`. |
| `--planner-model PROVIDER/MODEL` | Planner model for a new project configuration. |
| `--executor-model PROVIDER/MODEL` | Primary executor model for a new project configuration. |
| `--quota-provider PROVIDER` | `anthropic`, `claude-code`, `openai` or `kimi`. `claude-code` pairs with `claude-code/` models. |
| `--opencode-url URL` | Local OpenCode origin, for example `http://127.0.0.1:4096`. |
| `--opencode-auth basic\|none\|openchamber` | Authentication for the OpenCode connection (see [Authentication](#authentication)). |
| `--password-env NAME` | Name of the environment variable that holds the Basic password. A reference only; no password or token is accepted as a flag. |
| `--state-directory DIRECTORY` | Coordinator state directory. A relative path resolves against the coordinator configuration file. |
| `--global-concurrency NUMBER` | Coordinator-wide run limit (default 1). |
| `--project-concurrency NUMBER` | Per-project run limit (default 1). |
| `--no-input` | Never prompt. Missing required inputs fail before anything is written. |
| `--json` | Print one JSON document on stdout (schema version 1). Never prompts. |
| `--help` | Show the help text. |

A new project configuration needs `--planner-model`, `--executor-model`,
`--quota-provider`, `--opencode-url` and `--opencode-auth`. When you run setup
without `--no-input` or `--json` in an interactive terminal, missing values are
asked for; any other invocation, including piped input, never prompts. Flags
cannot be repeated, and flags that look like credentials are rejected.

### Outcomes and safe reruns

Each of the two files ends in one of these outcomes:

- **created**: the file was absent, and setup wrote it (mode 0600, in a parent
  directory it creates with mode 0700 if necessary).
- **reused**: the file already existed and is valid and complete. It is left
  byte-for-byte unchanged.
- **not-written** or **failed**: setup stopped before or while writing this file.

Setup never overwrites. If you pass an explicit value that disagrees with an
existing file (for example a different `--opencode-url`), setup fails with a
`conflict` error naming the key, the existing value and the requested value. Omit
the option to reuse the existing value, or choose a new destination with
`--config` or `--coordinator-config`.

Values are compared with what the existing file actually uses. An existing
coordinator file is judged by its own effective state directory and limits, so
rerunning setup without `--state-directory` reuses it even where the default
state directory would not fit in a socket path (for example under a very long
home directory); the default is evaluated only when setup would create the
coordinator file. A project file without an `executorCandidates` pool is
compared by its effective primary executor: `--executor-model` against
`workflow.executorModel` and `--quota-provider` against the provider that model
prefix implies (`claude-code/` models use `claude-code`, other models
`anthropic`), so passing those matching values reuses the file. With a pool, only
the first candidate is compared.

An existing project file that still holds
template placeholders or has no endpoint fails as `incomplete-configuration`;
edit it yourself or choose another destination.

The coordinator file is published first, then the project file. If writing the
second file fails after the first was published, the result is **partial**:
nothing is rolled back, the error names the file that was created and the one
that is incomplete, and rerunning the same command finishes the missing file and
reuses the first. Directories are never removed either: if a directory cannot be
created, `createdDirectories` still lists every directory created before the
failure, and a rerun lists only the directories it newly creates. Rerunning a
successful setup is safe: it reuses both files and reports that nothing changed.

### Exit codes and JSON output

Exit status is **0** when both files are complete, whether created or reused, and
**1** for every other result: argument errors, missing inputs, incomplete
configuration, conflicts, invalid configuration, write failures and partial
outcomes. In human mode a summary goes to stdout and diagnostics to stderr.

With `--json`, stdout carries exactly one JSON document, including for argument
errors, and stderr stays empty. Schema version 1:

| Field | Value |
| --- | --- |
| `schemaVersion` | `1` |
| `ok` | `true` when both configuration files are complete (created or reused). |
| `projectDirectory` | Canonical Git project directory, or `null` if it was not determined. |
| `targets` | `{ "coordinator": { "path", "outcome" }, "project": { "path", "outcome" } }`. `outcome` is `created`, `reused`, `not-written` or `failed`; `path` may be `null`. |
| `createdDirectories` | Configuration parent directories this invocation created, including those created before a failure. |
| `verification` | `{ "level", "unverified" }`. `level` is `configuration-validated` (the files passed the configuration validators) or `none`. `unverified` always lists `opencode-connection`, `model-availability`, `provider-login` and `quota`. |
| `error` | `null`, or `{ "code", "message", "missing" }`. `code` is one of `invalid-input`, `missing-input`, `no-git-project`, `no-commit`, `invalid-destination`, `invalid-configuration`, `incomplete-configuration`, `conflict`, `identical-destinations`, `destination-exists`, `write-failed` or `unexpected`. `missing` lists flag names for `missing-input` and setting keys for `incomplete-configuration`. |
| `partial` | `null`, or `{ "created": [...], "incomplete": [...] }` when one file was published and the other was not. |
| `warnings` | Array of strings. |

All strings are redacted: credential values taken from the environment, URL user
information and Authorization-style values never appear in output. This includes
the value of the environment variable named by `--password-env` (in either the
`--password-env NAME` or `--password-env=NAME` form), chosen in the wizard or
named by the existing project file that setup reuses, whatever the variable is
called. The selected project's variable is also masked when validation of either
configuration file fails, for example when an existing coordinator file is
malformed, provided the project file is readable and valid TOML. If the
coordinator file cannot be read at all, setup fails before it reads the project
file and cannot mask that variable's value.

Example of a successful result (abbreviated paths):

```json
{
  "schemaVersion": 1,
  "ok": true,
  "projectDirectory": "/path/to/project",
  "targets": {
    "coordinator": { "path": "/home/user/.config/heimdall/coordinator.toml", "outcome": "created" },
    "project": { "path": "/path/to/project/.heimdall.toml", "outcome": "created" }
  },
  "createdDirectories": ["/home/user/.config/heimdall"],
  "verification": {
    "level": "configuration-validated",
    "unverified": ["opencode-connection", "model-availability", "provider-login", "quota"]
  },
  "error": null,
  "partial": null,
  "warnings": []
}
```

Setup validates configuration only. It proves nothing about the connection,
models, provider login or quota; use [`heimdall doctor`](#check-the-installation-with-heimdall-doctor)
for what can be checked.

## Configuration locations

| Configuration | Selected by, highest precedence first | Default |
| --- | --- | --- |
| Coordinator | `--coordinator-config FILE`, then `HEIMDALL_COORDINATOR_CONFIG` | `~/.config/heimdall/coordinator.toml` |
| Project | `--config FILE`, then `HEIMDALL_CONFIG` | `.heimdall.toml` in the project |

Relative project configuration paths resolve against the project directory.
Relative coordinator paths resolve against the working directory. Both
`heimdall setup` and `heimdall doctor` follow this precedence, and the
`heimdall coordinator` commands accept `--coordinator-config` and
`HEIMDALL_COORDINATOR_CONFIG` the same way.

When no coordinator file exists at the default location and neither override is
set, the coordinator loader uses built-in defaults. An explicitly selected file
(by flag or environment variable) must exist. Defaults when a value is omitted:

- global concurrency `1` and per-project concurrency `1`;
- state directory `~/.local/state/heimdall` on Unix and
  `LOCALAPPDATA/Heimdall` on Windows (native Windows operation is untested).

Setup writes only the values you supplied, so a coordinator file created with
no concurrency flags contains an empty `[coordinator]` table and runs with the
`1`/`1` defaults. The [example coordinator file](../examples/coordinator.toml)
shows the available settings. The project file written by setup contains the
planner model, one executor candidate, and the `[opencode]` connection settings;
everything else uses built-in defaults. See the
[example project file](../examples/heimdall.toml) for the full set of settings.

## Authentication

The configuration holds a reference to credentials, never a credential. Choose
the mode with `--opencode-auth` (the `authentication` key in `[opencode]`):

- **`basic`** (the default when the key is omitted): the password is read at run
  time from an environment variable. The variable's name is
  `passwordEnvironmentVariable` in `[opencode]`, `OPENCODE_PASSWORD` unless you
  pass `--password-env NAME`. Export it in the terminal that runs
  `heimdall doctor --connect` and a foreground `heimdall coordinator serve`; do
  not put the password in a flag or in the Heimdall configuration. A coordinator
  started with `heimdall coordinator start` runs under your service manager and
  does not inherit that terminal's environment: select a private, owner-only
  credential file with `--env-file` instead (see
  [Credential context](coordinator.md#credential-context)). A managed
  coordinator never reads the Basic password from its own environment, even when
  the service manager provides `OPENCODE_PASSWORD`; without a file, or with a file
  that lacks the configured name, connections fail before any request while the
  coordinator itself still starts. A foreground `serve` without `--env-file`
  keeps using its environment.
- **`none`**: no authorization header is sent. Use it only for an explicitly
  passwordless loopback server.
- **`openchamber`**: for OpenChamber Desktop. Use Desktop's local HTTP port in
  the URL. At connection time Heimdall reads the existing Desktop client token
  from `~/.config/openchamber/settings.json` (or the directory named by
  `OPENCHAMBER_DATA_DIR`), checks that the URL's port matches Desktop's local
  port, and sends the token only to that loopback origin. The token is not copied
  into any Heimdall file. Heimdall does not discover the endpoint: you supply the
  URL, and Desktop must be open when a connection is made.

Provider credentials always stay in OpenCode.

## Check the installation with `heimdall doctor`

`heimdall doctor` runs read-only checks and reports each one. It never creates
files, changes permissions, starts the coordinator, repairs configuration or
contacts a provider. By default it makes no network request.

```sh
heimdall doctor
heimdall doctor --connect
heimdall doctor --json
```

| Flag | Meaning |
| --- | --- |
| `--project DIRECTORY` | Git project to inspect. Default: the current Git project. |
| `--config FILE` | Project configuration, with the same precedence as setup. |
| `--coordinator-config FILE` | Coordinator configuration, with the same precedence as setup. |
| `--connect` | Also verify the configured OpenCode endpoint (`GET /api/info`, 10 second limit). |
| `--json` | Print one JSON document on stdout (schema version 1). |
| `--help` | Show the help text. |

### Offline checks

The local checks cover:

- Node.js meets the minimum version, and Git is available;
- the project is in a Git project that has a commit;
- the installed runtime: built code, prompts, agent files and configuration
  templates are present, the package identity can be computed, the declared
  dependencies resolve, and the pinned quota package is installed. An installed
  dependency whose `package.json` cannot be read, is not a JSON object or has no
  version cannot be identified and fails this check; the report names the
  dependency but never quotes the file;
- the coordinator configuration and the project configuration are valid, and the
  project configuration is complete (real models and an OpenCode endpoint);
- the configured state, workflow and plan directories, and the prompt files, are
  usable. A state directory that does not exist yet is not a failure;
- an advisory permissions check for configuration files that group or others can
  read or write, and for group- or world-writable directories. It only reports;
  it never changes anything.

### Connection check

With `--connect`, doctor sends one `GET /api/info` request to the loopback
OpenCode URL from the project configuration, using the configured authentication
source, and nothing else. It passes when the endpoint answers with the supported
OpenCode version and the selected authentication is accepted.

### What a passing result does not show

Neither the local checks nor the connection check prove that a run can execute.
Doctor never verifies:

- authorization to protected OpenCode APIs beyond the `GET /api/info` request;
- model availability;
- provider login;
- quota.

The JSON `verification` object reports these four as `"unverified"` on every
run.

### Exit codes and JSON output

Exit status is **0** when no required check failed and **1** otherwise. A
requested connection check that fails is required. Warnings, advisory checks and
unverified items never change the exit status. The "Local checks" line of the
human report and `verification.local` describe the local checks only, so a failed
connection check makes `ok` false and the exit status 1 while the local verdict
stays `passed`. In human mode the report goes to
stdout and diagnostics to stderr.

With `--json`, stdout carries exactly one JSON document and stderr stays empty.
Schema version 1:

| Field | Value |
| --- | --- |
| `schemaVersion` | `1` |
| `ok` | `true` unless a required check failed or the arguments were invalid. |
| `targets` | `{ "projectDirectory", "projectConfig", "coordinatorConfig", "stateDirectory" }`, each a string or `null`. |
| `checks` | Array of `{ "id", "status", "fatal", "message" }`. `status` is `pass`, `fail`, `warn`, `not-verified` or `skipped`. `fatal` is `true` for a required check, whose `fail` makes `ok` false, and `false` for advisory checks. |
| `verification` | `{ "local": "passed" \| "failed" (local checks only), "connection": "not-requested" \| "verified" \| "failed", "protectedApiAuthorization", "modelAvailability", "providerLogin", "quota" }`. The last four are always `"unverified"`. |
| `error` | `null`, or `{ "code": "invalid-input" \| "unexpected", "message" }` when no checks could run. |

Strings are redacted in the same way as setup output, including the password
variable named by a project configuration that is valid TOML but fails
validation. A project file that is not valid TOML names no variable that can be
read, so nothing is masked for it.

## Next step

With the configuration in place and the checks passing, start the coordinator in
the background through your user service manager (launchd on macOS, a systemd
user manager on Linux), then submit a feature as described in
[Global coordinator development](coordinator.md#setup):

```sh
heimdall coordinator start
heimdall coordinator status
heimdall coordinator logs
heimdall coordinator stop
```

Installing the package and running `heimdall setup` never start the coordinator
or register a service; only `start` does, and nothing starts at login or boot.
`start --env-file FILE` supplies a Basic password, `--coordinator-config FILE`
selects a non-default configuration, and `--timeout SECONDS` changes the 30 second
startup wait. `stop` drains safely and waits up to 60 seconds by default; it does
not force a shutdown. A ready coordinator means only that its local IPC answers,
not that OpenCode, credentials, models or quota are available. Add `--json` to
`start` or `stop` for one versioned result document. Targets, credential files,
stop outcomes and exit codes, logs and the supported service contexts are
described in [Background service](coordinator.md#background-service-start-stop-and-logs).
`heimdall coordinator serve` remains available to run the coordinator in a
terminal.
