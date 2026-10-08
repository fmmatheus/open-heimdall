# Heimdall

**An opinionated, minimalist agent orchestrator for the OpenCode + OpenChamber workflow.**

> **Status:** Early development / pre-alpha.

You provide a feature. Heimdall breaks it into tasks, executes them sequentially within each run, manages model choice, and controls usage according to your configuration.

Heimdall is designed to run as a single global service across your local Git projects, keeping workflow policy, execution coordination, and observability in one place.

## Quickstart (macOS / Linux)

This first try uses a new demo project and separate Heimdall state. Your existing
ADR workflow keeps running. Heimdall creates its workflow files inside new
worktrees; you do not need to install a plugin into your current project.

You need Git, a configured Git author, Node.js **22.19 or newer**, and an already
running local **OpenCode 2.0.22** server. The example uses the OpenChamber Claude
Code provider and your existing Claude Code login. Use the server URL, model IDs
and variants available in your environment. Runs share provider quota with your
other workflows.

OpenCode also inherits global plugins. If the original `adr.workflow` plugin is
loaded globally, this setup will refuse the conflicting workflow plugins. Use a
separate OpenCode profile with fresh session storage for that case; keep the
original profile and running server untouched. See [plugin separation](docs/development.md#opencode-adapter).

### 1. Build Heimdall

There is no published package yet. Clone into a new directory:

```sh
git clone https://github.com/fmmatheus/open-heimdall.git
cd open-heimdall
npm ci --ignore-scripts
npm run build
export HEIMDALL_DIR="$PWD"
```

### 2. Create a separate demo project

Keep this directory and its state until you have reviewed the run. The short
path also keeps the coordinator's Unix socket within the OS path limit.

```sh
export HEIMDALL_TRY="$(mktemp -d /tmp/heimdall-try.XXXXXX)"
export HEIMDALL_COORDINATOR_CONFIG="$HEIMDALL_TRY/coordinator.toml"
mkdir "$HEIMDALL_TRY/project"
git -C "$HEIMDALL_TRY/project" init -b main
printf '# Heimdall demo\n' > "$HEIMDALL_TRY/project/README.md"
git -C "$HEIMDALL_TRY/project" add README.md
git -C "$HEIMDALL_TRY/project" commit -m "Initialize demo project"

cat > "$HEIMDALL_COORDINATOR_CONFIG" <<'EOF'
[coordinator]
stateDirectory = "state"
globalConcurrency = 1
projectConcurrency = 1
EOF

cat > "$HEIMDALL_TRY/project.toml" <<'EOF'
[workflow]
plannerModel = "claude-code/opus"
plannerVariant = "xhigh"
maxTasks = 2
tokenLimitsDisabled = true

[[workflow.executorCandidates]]
key = "sonnet"
quotaProvider = "claude-code"
model = "claude-code/sonnet"
variant = "xhigh"

[opencode]
baseUrl = "http://127.0.0.1:4096"
passwordEnvironmentVariable = "OPENCODE_PASSWORD"
EOF

cat > "$HEIMDALL_TRY/feature.md" <<'EOF'
Add an exported greet(name) function in greet.mjs. It should trim the name,
return "Hello, NAME!" for a nonempty name, and reject empty names.
Add tests using Node's built-in test runner and verify with node --test.
EOF
```

Edit `project.toml` to use your existing server's URL and supported models. For a
password-protected server, supply its existing server password in the terminal
that will start the coordinator:

```sh
printf 'OpenCode server password: '
read -r -s OPENCODE_PASSWORD
printf '\n'
export OPENCODE_PASSWORD
```

For an explicitly passwordless server, skip that prompt and add
`authentication = "none"` under `[opencode]`. No provider token import is needed.
Keep your current OpenCode server running; this setup does not require a restart.

### 3. Start the coordinator

```sh
node "$HEIMDALL_DIR/dist/cli.js" check \
  --project "$HEIMDALL_TRY/project" --config "$HEIMDALL_TRY/project.toml"
printf 'Quickstart directory: %s\n' "$HEIMDALL_TRY"
node "$HEIMDALL_DIR/dist/cli.js" coordinator serve
```

`check` validates the TOML only; it does not connect to OpenCode or verify models.
Leave this terminal running. All following commands must use the same
`HEIMDALL_COORDINATOR_CONFIG`.

### 4. Submit and observe a feature

Open a second terminal. Replace the two paths below with your Heimdall checkout
and the quickstart directory printed above:

```sh
cd /path/to/open-heimdall
export HEIMDALL_TRY="/tmp/heimdall-try.XXXXXX"
export HEIMDALL_COORDINATOR_CONFIG="$HEIMDALL_TRY/coordinator.toml"
node dist/cli.js coordinator project add "$HEIMDALL_TRY/project" \
  --project-config "$HEIMDALL_TRY/project.toml"
```

The command returns JSON. Copy its `id` as the project ID:

```sh
PROJECT_ID="PROJECT_ID_FROM_OUTPUT"
node dist/cli.js coordinator run submit "$PROJECT_ID" \
  --feature "$HEIMDALL_TRY/feature.md"
```

Submission queues real agent execution in a new isolated worktree. Copy this
response's `id` as the run ID:

```sh
RUN_ID="RUN_ID_FROM_OUTPUT"
node dist/cli.js coordinator run list
node dist/cli.js coordinator run show "$RUN_ID"
```

Run `show` again to see progress. If the run is `paused`, read its reason and
checkpoint, then resolve the blocker explicitly:

```sh
node dist/cli.js coordinator run resume "$RUN_ID" --input "Your resolution"
```

For `reconciliation-required`, inspect the run and use `coordinator run reconcile
RUN_ID` to observe existing execution. See [recovery rules](docs/coordinator.md#lifecycle-and-recovery).

### 5. Review the result

When the run is `succeeded`, `run show` provides task results, `worktreePath`,
`branch` and `baseCommit`. Use those values to inspect the generated work:

```sh
WORKTREE_PATH="WORKTREE_PATH_FROM_OUTPUT"
BASE_COMMIT="BASE_COMMIT_FROM_OUTPUT"
git -C "$WORKTREE_PATH" status --short
git -C "$WORKTREE_PATH" diff "$BASE_COMMIT"
```

Inspect new code files listed as untracked too; `git diff` does not include them.
Completed worktrees are retained for review, and results are not merged
automatically. After your runs finish, Ctrl-C in the coordinator terminal stops
that coordinator; it does not stop OpenCode or your original ADR workflow.

Usage is unlimited in this example. Optional cumulative token caps, warning-only
timeouts, and other current boundaries are documented in
[coordinator development](docs/coordinator.md#remaining-limits).

## Why Heimdall?

The opt-in development coordinator allows multiple features and runs to progress concurrently in the same project or across different projects. Each run handles one task at a time in its own Git worktree, subject to global and per-project limits.

Heimdall is designed around these principles:

- **One control plane** — a single installation and workflow version across projects.
- **Sequential tasks, concurrent runs** — each run executes one task at a time; concurrent agent changes use isolated Git worktrees. Multiple agents never modify the same worktree simultaneously.
- **Model and usage policy** — Heimdall manages model choice. Usage is unlimited by default, with optional boundaries such as session time and token usage per window.
- **Global observability** — see what is running, what succeeded, what failed, and why.

## How it works

The core workflow is feature request → task breakdown → sequential task execution, with model choice and configured usage boundaries managed throughout.

```text
                     Heimdall
                ┌─────────────────┐
                │   Coordinator   │
                │                 │
                │ Scheduler       │
                │ Model policy    │
                │ Usage policy    │
                │ Event store     │
                └────────┬────────┘
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
           Session    Session    Session
              │          │          │
              ▼          ▼          ▼
          Project A  Project B  Project B
          Worktree   Worktree   Worktree
```

The global coordinator controls OpenCode sessions through an adapter. OpenCode owns agent and tool execution. Multiple runs and features are coordinated within or across projects, subject to global and per-project concurrency limits. Within each run, one task finishes before the next starts, and each run owns a separate worktree.

## Architecture

The selected stack is TypeScript and Node.js for a global coordinator and CLI,
SQLite for coordination state and event history, and the Git CLI with isolated
worktrees. It builds on the validated ADR workflow and the existing
OpenChamber-managed OpenCode connection. OpenCode retains its session storage.

See [ADR 0002: TypeScript coordinator and OpenCode execution](docs/adr/0002-opencode-coordinator-stack.md)
for the current stack and execution boundary, and
[ADR 0001: Technical foundation](docs/adr/0001-technical-foundation.md) for the
retained foundations and original decisions.

## Goals

Heimdall aims to provide:

- Feature breakdown into tasks
- Sequential task execution within each run
- Model selection policy
- Optional session-time and token-usage boundaries, unlimited by default
- Global project and task management
- Concurrent runs within and across projects
- Git worktree isolation
- Centralized workflow versioning
- Centralized watch ownership for required workflow triggers
- Task lifecycle management
- Structured logs and events
- Failure tracking and retries
- CLI-based observability

## Non-goals

Heimdall is focused on the OpenCode + OpenChamber workflow. A general-purpose orchestration platform is outside its scope.

Heimdall is not intended to replace:

- Git
- CI/CD systems
- container orchestrators
- project-specific build and test tooling

It coordinates agent work around those tools.

## Project status

Heimdall has a TypeScript runner extracted from the working ADR workflow, an
OpenCode adapter, quota-aware model selection, and an opt-in SQLite coordinator
with project registration, isolated worktrees, concurrency limits and local IPC.

There is no public release yet. See [baseline development](docs/development.md)
and [coordinator development](docs/coordinator.md) for setup, tested boundaries,
current limits, and how to keep existing workflows separate.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test
```

Use Node.js 22.19 or newer. The tests use synthetic backends and temporary project
directories; they do not run live agents or operate on existing workflow state.

## Roadmap

Initial development will focus on:

1. Extract the validated ADR workflow behind an OpenCode adapter
2. Feature breakdown and sequential task execution
3. Model selection and configurable usage boundaries
4. Global coordinator, CLI, and project registry
5. Task and run lifecycle, with isolated Git worktrees
6. Concurrent runs and global/per-project limits
7. Central event and state storage, OpenCode event observation, and status reporting

## Contributing

Contribution guidelines will be added as the project moves from initial architecture into implementation.

Issues, design discussions, and pull requests will be welcome once the initial project structure is established.

## License

A license will be selected before the first public release.

## Name

Heimdall is named after the Norse god associated with vigilance, watchfulness, and maintaining order—fitting for a system responsible for coordinating and observing work across many projects.
