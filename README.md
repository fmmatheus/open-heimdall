# Heimdall

**An opinionated, minimalist agent orchestrator for the OpenCode + OpenChamber workflow.**

> **Status:** Early development / pre-alpha.

You provide a feature. Heimdall breaks it into tasks, executes them sequentially within each run, manages model choice, and controls usage according to your configuration.

Heimdall runs as a single global service across your local Git projects, keeping workflow policy, execution coordination, and observability in one place.

## Why Heimdall?

Multiple features and runs can progress concurrently in the same project or across different projects. Each run handles one task at a time.

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

The global coordinator controls OpenCode sessions through an adapter. OpenCode owns agent and tool execution. Multiple runs and features can be active concurrently within or across projects, subject to global and per-project concurrency limits. Within each run, one task finishes before the next starts, and a worktree has only one agent modifying it at a time.

## Architecture

The first version uses TypeScript and Node.js for a global coordinator and CLI,
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

Heimdall is currently being designed.

The architecture and public interfaces are not yet stable, and there is no usable release yet.

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