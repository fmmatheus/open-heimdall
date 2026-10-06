# Baseline extraction

This package extracts the working ADR runner into TypeScript. It preserves
planning, sequential fresh task sessions, completion gates, saved receipts,
explicit resume, quota-aware model choice and usage tracking. It has no global
scheduler or SQLite migration yet.

Existing workflows and running agents remain separate. The package does not
install itself into OpenCode, migrate existing state, restart a server, or change
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

## Configuration and CLI

```sh
node dist/cli.js init --project /path/to/separate-project
node dist/cli.js check --project /path/to/separate-project
node dist/cli.js status RUN_ID --project /path/to/separate-project
```

`init` creates `.heimdall.toml` and refuses to overwrite it. Edit the model IDs
and managed OpenCode URL using [the example](../examples/heimdall.toml). `check`
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

The native adapter targets OpenCode and `@opencode/plugin` **2.0.22**. It uses a
real parent tool context and the effective native `subagent` tool. Configure the
existing local managed server's URL in `[opencode]` and supply its password through
the named environment variable. The adapter validates server version, session
identity and project directory. It does not harvest passwords from processes.
Explicitly passwordless loopback servers can use `authentication = "none"` in
`[opencode]`; password authentication remains the default.

After building this checkout, use a local link in a **separate development Git
project**. Run these commands from that separate project:

```sh
mkdir -p .opencode/plugins .opencode/agents .opencode/commands
npm install --prefix .opencode --ignore-scripts --install-links=false /path/to/open-heimdall
cp -n /path/to/open-heimdall/examples/opencode/plugins/heimdall.ts .opencode/plugins/
cp -n /path/to/open-heimdall/examples/opencode/agents/*.md .opencode/agents/
cp -n /path/to/open-heimdall/examples/opencode/commands/*.md .opencode/commands/
```

The explicit link keeps dependencies resolved from the built checkout and its
lockfile. Dependency overrides do not propagate to consumer roots; regular
tarball/copy installation requires the same quota/plugin override in the consumer.
The plugin entry point is `@open-heimdall/core/plugin`. Do not load it alongside the original `adr.workflow`
plugin in the same location: this extraction preserves its tool and RPC names.
Loading or restarting the running original workflow is outside this setup.

From the configured OpenChamber parent session, use `/adr-run ADR_PATH`,
`/adr-status RUN_ID`, or `/adr-resume RUN_ID RESOLUTION`. Planner and executor names
are configurable; the examples use the established `adr-*` roles. Renaming those
roles also requires corresponding agent filenames and matching orchestrator
permission resources.

The quota adapter pins `@slkiser/opencode-quota` **5.0.1** and isolates its internal
provider-module paths. A scoped dependency override uses the tested native plugin
version. Credentials resolve through the active OpenCode account and stay
transient; caches retain normalized quota fields and hashed account scope.

## Current limits

- The standalone baseline keeps one active run per configured state directory
  and file-backed checkpoints. The [opt-in coordinator](coordinator.md) adds
  project registration, isolated worktrees, concurrent scheduling and SQLite
  checkpoints/receipts without migrating existing runs.
- Usage caps are disabled by default. Enabled caps cover cumulative session/run
  token counts, checked before child prompting, before tool execution and during
  periodic polling. Active requests can exceed a cap before cancellation is
  confirmed. Provider quota
  windows influence model choice; arbitrary user token windows are not implemented.
- `timeoutMinutes` emits a warning and does not enforce a hard deadline.
- Planning currently requires available Anthropic quota. Account authentication
  and model availability still come from the configured OpenCode environment.
- Phone deployment and the independent watchdog service are not included. The
  runner's saved receipts and reserved-recovery checks remain intact.

These are the standalone baseline's limits. See the coordinator guide for its
execution and recovery boundaries; existing workflows remain separate.
