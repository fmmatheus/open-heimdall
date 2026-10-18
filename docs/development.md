# Development overview

The standalone workflow provides planning, sequential fresh task sessions,
completion gates, saved receipts, explicit resume, quota-aware model choice and
usage tracking. It keeps file-backed checkpoints and allows one active run per
configured state directory. The [opt-in coordinator](coordinator.md) adds
scheduling, managed worktrees and SQLite persistence on top of that runner.

The package does not install itself into OpenCode, restart a server, or change
credentials. Develop and try it in a separate Git checkout with fresh state.

## Build and tests

Use Node.js 22.19 or newer. The baseline was checked on Node.js 22.22.3.

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Tests use temporary project directories, injected backends and synthetic
credentials. They do not prompt live models or operate on current OpenCode runs.

## Packaging

`npm run pack:clean` (`scripts/pack.mjs`) builds the npm tarball from a disposable
copy of the working tree: tracked and untracked-but-not-ignored files are copied,
then `npm ci --ignore-scripts`, `npm run build` and `npm pack` run inside the copy.
The checkout's `dist/` and `node_modules/` are never read and no extension build is
needed. It prints the tarball path and the file inventory (`--out DIRECTORY`
selects where the tarball is written).

`npm run test:package` builds that tarball, installs it with plain `npm install`
into a fresh consumer project and, separately, with
`npm install --global --prefix TEMPORARY_DIRECTORY` into a temporary prefix, and
checks the inventory, the installed `heimdall --help` and `--version` outside the
checkout, the three package exports and the quota helper modules with `fetch`
replaced by a stub that fails. It needs registry access, uses isolated HOME and npm
cache/configuration, and is not part of `npm test`. `test/package/helpers.mjs`
holds the reusable tarball and install helpers.

The tarball contains `dist` (without source maps), `prompts`, `examples`, `README.md`
and `docs`. It excludes `src`, `test`, `scripts`, `node_modules`, lockfiles,
`.heimdall` and the extension outputs. `dist/extension/**` is compiled from the
OpenChamber extension sources and imports the `@openchamber/sdk` development
dependency; no export or CLI path imports it, so it is not part of the core package
and `dist/openchamber-extension/**` (the bundled extension) stays a separate
`npm run build:extension` artifact.

### Quota provider packaging

`@slkiser/opencode-quota` 5.0.1 declares an exact peer on `@opencode/plugin` 2.0.16,
while Heimdall requires the supported 2.0.32. A development-only root `overrides`
entry resolves that peer conflict in the source checkout; npm does not apply that
override when Heimdall is installed as a dependency. Before quota vendoring, with
Heimdall pinned to 2.0.22, a plain `npm install` of the previous tarball either hoisted a
second, unsupported `@opencode/plugin` 2.0.16 next to the nested 2.0.22 or, when the
consumer also depended on 2.0.22, produced an invalid peer tree (`npm ls`: `invalid:
"2.0.16" from node_modules/@slkiser/opencode-quota`, `ELSPROBLEMS`).

Alternatives checked with npm 10.9.8: a shipped `npm-shrinkwrap.json` was not
applied when installing a local tarball (the resolved tree was unchanged), and
`bundleDependencies` still yielded an invalid peer tree while adding roughly 48 MB
of platform-specific files (including `@opentui` binaries).
Heimdall only uses four provider modules, whose relative import closure is 28
plain JavaScript files that import nothing but Node built-ins and `comment-json`.
`scripts/vendor-quota.mjs`, run by `npm run build`, therefore copies exactly that
closure and the upstream MIT license into `dist/vendor/opencode-quota` and writes a
manifest with the pinned name and version. The upstream package moves to
`devDependencies` (still 5.0.1, with the development-only override) and
`comment-json` becomes a direct dependency. `resolveQuotaPackage` resolves the
vendored copy by default, still requires name `@slkiser/opencode-quota` and version
5.0.1 and still honors `settings.packagePath`. The script fails if the upstream
version changes or the closure imports another package. Because the files live in
`dist`, runtime identity covers them.

## Configuration and CLI

```sh
node dist/cli.js init --project /path/to/separate-project
node dist/cli.js check --project /path/to/separate-project
node dist/cli.js status RUN_ID --project /path/to/separate-project
node dist/cli.js --version
```

`init` creates `.heimdall.toml` and refuses to overwrite it. Edit the model IDs
and managed OpenCode URL using [the example](../examples/heimdall.toml), or use
`heimdall setup` to create the project and coordinator configuration from flags
or prompts; see [Installation and setup](installation.md). `check`
only validates configuration; it does not verify model availability or connect
to a server. `status` reads saved state without starting or interrupting agents.

Paths are resolved against the selected project, independent of the shell's
working directory. The default state directory is `.heimdall`; planning artifacts
default to its `plans` subdirectory and must stay inside the project. If state is
external, configure an explicit internal planning path. Prompts ship with the package and can be
overridden. `--config` or `HEIMDALL_CONFIG` selects another TOML file. Models and
budgets are reread on each invocation; changing paths, native roles or connection
settings requires reloading this plugin in its own development environment.

## OpenCode adapter

The native adapter targets OpenCode and `@opencode/plugin` **2.0.32**. It uses a
real parent tool context and the effective native `subagent` tool. Configure the
existing local connection's URL in `[opencode]`. For OpenChamber Desktop, set
`authentication = "openchamber"` and use Desktop's local HTTP port. Heimdall
reads the existing Desktop client token from `~/.config/openchamber/settings.json`
(or `OPENCHAMBER_DATA_DIR`) and sends it only to that matching loopback port; no
password needs to be copied. For a direct OpenCode server, supply its password
through the named environment variable. The adapter validates server version, session
identity and project directory. It does not harvest passwords from processes.
Explicitly passwordless loopback servers can use `authentication = "none"` in
`[opencode]`; password authentication remains the default.

The optional native compatibility fixture runs a disposable OpenCode server with
a scripted local model and synthetic quota. After building, run:

```sh
node scripts/live/opencode-compatibility/run.mjs --opencode /absolute/path/to/opencode --out /tmp/heimdall-compatibility.json
```

It isolates the server's configuration, database and home directory, exercises
structured planning and submission, output-limit continuation, a native file
write, pause, same-run resume and paginated history, then stops its own server and
removes its fixture. It does not contact a model provider or the configured live
coordinator. See [the compatibility record](validation/opencode-2.0.32.md) for
the checked environment and limits.

To try the native plugin, build the tarball as described in
[Packaging](#packaging) and install it into a **separate development Git
project** with ordinary `npm install`; no consumer overrides, links or peer
flags are needed. Run these commands from that separate project, with the
installed package's `examples/opencode` directory (under the directory printed by
`npm root --global` when installed globally, see
[Installation and setup](installation.md)) in place of `EXAMPLES`:

```sh
mkdir -p .opencode/plugins .opencode/agents .opencode/commands
npm install --prefix .opencode --ignore-scripts /path/to/open-heimdall-core-0.0.0.tgz
cp -n EXAMPLES/plugins/heimdall.ts .opencode/plugins/
cp -n EXAMPLES/agents/*.md .opencode/agents/
cp -n EXAMPLES/commands/*.md .opencode/commands/
```

The plugin entry point is `@open-heimdall/core/plugin`. Do not load it alongside
another plugin that uses the same identity (`adr.workflow`), tool names or RPC
names at the same project location.

From the configured OpenChamber parent session, use `/adr-run ADR_PATH`,
`/adr-status RUN_ID`, or `/adr-resume RUN_ID RESOLUTION`. Planner and executor names
are configurable; the examples use the established `adr-*` roles. Renaming those
roles also requires corresponding agent filenames and matching orchestrator
permission resources.

The quota adapter pins `@slkiser/opencode-quota` **5.0.1** and isolates its internal
provider-module paths. The build vendors the pinned provider modules (see
[Packaging](#packaging)); a development-only override keeps the source checkout on
the tested native plugin version. Credentials resolve through the active OpenCode account and stay
transient; caches retain normalized quota fields and hashed account scope.

For the OpenChamber Claude Code provider, use `claude-code/opus` for planning
and pair executor models such as `claude-code/sonnet` with
`quotaProvider = "claude-code"`. Model names and variants must be available in
your configured OpenCode integration. Execution uses Claude Code's existing
login through the installed provider; no token import into OpenCode is needed.
Heimdall reads that login's current quota without copying, refreshing or writing
credentials. Expired or refresh-due credentials pause the run for manual refresh
in Claude Code and explicit resume. Quota requests share a short cache and respect
rate-limit cooldowns.

See the [live Claude Code coordinator validation](validation/claude-code-coordinator-smoke.md)
for execution, concurrency, token tracking and recovery observations.

## Structured completion

New native and managed runs use `structured-v1`: the planner and executor submit
through `heimdall_submit_plan` / `heimdall_submit_result`, receipts are durable
and immutable, and a task advances only after a matching receipt and a confirmed
idle stop. Runs persisted without a protocol keep the prose completion path.
Pause codes and the repair bound are described in
[the coordinator guide](coordinator.md#structured-completion-protocol).

The plugin computes its own runtime identity (digests of `dist`, `prompts`,
`examples/opencode/agents`, package version and dependency resolution) and records
it in run states and receipts. Coordinator-managed runs are pinned to a run-owned
read-only copy (`.heimdall-runtime-snapshot.json`), verified before launch and
resume. Rebuilding the package therefore needs no coordination with managed runs
already started, but a native standalone run loads `dist` in place: do not
rebuild or reload while one is running.

The guarded live harness is `scripts/live/claude-report-only/`; the structured
run is `e2e-structured.mjs` (one prompt, read-only sampling), described in
[structured-completion-live.md](validation/structured-completion-live.md).

## Current limits

- The standalone workflow keeps one active run per configured state directory
  and file-backed checkpoints. The [opt-in coordinator](coordinator.md) adds
  project registration, isolated worktrees, concurrent scheduling and SQLite
  checkpoints/receipts without migrating standalone runs.
- Usage caps are disabled by default. Enabled caps cover cumulative session/run
  token counts, checked before child prompting, before tool execution and during
  periodic polling. Active requests can exceed a cap before cancellation is
  confirmed. Provider quota
  windows influence model choice; arbitrary user token windows are not implemented.
- `timeoutMinutes` emits a warning and does not enforce a hard deadline.
- Planning requires available quota for the configured Claude provider (`anthropic`
  or `claude-code`). Account authentication
  and model availability still come from the configured OpenCode environment.
- The runner's saved receipts and reserved-recovery checks remain part of the
  standalone workflow.

These are the standalone workflow's limits. See the coordinator guide for its
execution and recovery boundaries.
