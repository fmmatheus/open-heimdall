# Heimdall

**A local control plane for running and observing parallel engineering workflows across multiple projects.**

> **Status:** Early development / pre-alpha.

Heimdall runs as a single global service that coordinates isolated tasks across your local Git projects.

Instead of installing and maintaining workflow infrastructure independently in every repository, Heimdall provides one place to manage execution, concurrency, lifecycle, and observability.

## Why Heimdall?

Engineering workflows increasingly need to operate across multiple repositories and run several tasks concurrently.

Heimdall is designed around three principles:

- **One control plane** — a single installation and workflow version across projects.
- **Safe parallelism** — tasks execute independently, using isolated Git worktrees where appropriate.
- **Global observability** — see what is running, what succeeded, what failed, and why.

## How it works

```text
                     Heimdall
                ┌─────────────────┐
                │   Local daemon  │
                │                 │
                │ Scheduler       │
                │ Watch manager   │
                │ Task manager    │
                │ Event store     │
                └────────┬────────┘
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
           Worker     Worker     Worker
              │          │          │
              ▼          ▼          ▼
          Project A  Project B  Project B
          Worktree   Worktree   Worktree
```

The daemon acts as the control plane. Individual workers execute tasks in isolation, allowing multiple projects—and multiple tasks within the same project—to run concurrently.

## Architecture

The initial foundation is Go, a global daemon with subprocess workers, SQLite
persistence, and Git worktree isolation.

See [ADR 0001: Technical foundation](docs/adr/0001-technical-foundation.md) for the
accepted decisions, tradeoffs, and deferred choices.

## Goals

Heimdall aims to provide:

- Global project and task management
- Parallel task execution
- Git worktree isolation
- Centralized workflow versioning
- Centralized filesystem watching
- Task lifecycle management
- Structured logs and events
- Failure tracking and retries
- CLI-based observability

## Non-goals

Heimdall is not intended to replace:

- Git
- CI/CD systems
- container orchestrators
- project-specific build and test tooling

It coordinates local engineering workflows around those tools.

## Project status

Heimdall is currently being designed.

The architecture and public interfaces are not yet stable, and there is no usable release yet.

## Roadmap

Initial development will focus on:

1. Global daemon and CLI
2. Project registry
3. Task and run lifecycle
4. Isolated Git worktrees
5. Parallel workers
6. Central event and state storage
7. Watch management
8. Logs and status reporting

## Contributing

Contribution guidelines will be added as the project moves from initial architecture into implementation.

Issues, design discussions, and pull requests will be welcome once the initial project structure is established.

## License

A license will be selected before the first public release.

## Name

Heimdall is named after the Norse god associated with vigilance, watchfulness, and maintaining order—fitting for a system responsible for coordinating and observing work across many projects.