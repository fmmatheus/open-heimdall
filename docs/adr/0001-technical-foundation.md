# ADR 0001: Technical foundation

- Status: Accepted
- Date: 2026-10-06

## Context

Heimdall is a local control plane for parallel engineering workflows across Git
projects. A single global service should coordinate workflow execution, watching,
and observability without duplicating infrastructure in each repository.

The initial foundation should be approachable for OSS contributors, practical to
distribute, and reliable enough to coordinate independent tasks. It must keep
project identity, intended work, and individual executions distinct.

## Decision

- **Go** for the core daemon and CLI.
- **One global daemon with subprocess workers.** The daemon owns scheduling,
  lifecycle, state, watch management, resource allocation, and observability.
  Workers execute tasks, worktree operations, and external commands.
- **SQLite** for persistent control-plane state and structured event history.
- **Git CLI integration** using the user's installed Git.
- **Git worktrees** to isolate parallel work within a project.
- **HTTP/JSON over local IPC** between the CLI and daemon: a Unix domain socket on
  Unix and a named pipe equivalent on Windows.
- **Structured events and logs** for lifecycle history and execution diagnostics,
  associated with projects, tasks, and runs. CLI output remains human-readable.
- **TOML configuration**, with global settings and optional project-specific
  configuration.
- **Project, Task, and Run** as core domain abstractions: a Project identifies a
  local Git project, a Task describes intended work, and a Run represents an
  execution attempt of a Task.
- **Explicit task/run state machines** with defined allowed transitions and event
  history, rather than independent lifecycle booleans. Exact states and
  transitions remain deferred.
- **A centralized watch manager** in the daemon, using abstractions over native
  OS watchers. Centralized ownership may involve multiple OS subscriptions; it
  does not require one watcher handle.
- **Global and per-project concurrency limits** enforced by the daemon's scheduler.

## Rationale

Go offers a straightforward concurrency model and practical distribution for a
daemon and CLI. Subprocess workers separate execution failures from the control
plane and make worker lifecycle management explicit.

SQLite provides transactional, queryable local storage without a database
service. The Git CLI follows the user's Git installation and configuration;
worktrees support concurrent repository work. HTTP/JSON and TOML keep interfaces
and configuration familiar and inspectable.

Explicit domain boundaries, lifecycle transitions, and structured events make
execution history understandable. Central watch ownership avoids independently
managed watchers, while both concurrency limits bound simultaneous work across
and within projects.

## Tradeoffs

- Worker subprocesses add startup and supervision overhead. Processes and
  worktrees isolate execution and working files, but do not provide a security
  sandbox or isolate every shared resource.
- SQLite simplifies operation, but write contention and schema evolution still
  require care.
- Git must be installed, and command output and failures need careful handling.
- Local IPC and native watcher abstractions require platform-specific integration
  and testing.
- Concurrency limits need tuning; limits alone do not define scheduling fairness.
  Structured events and logs also require consistent conventions and retention.

## Consequences

Implementation should follow the daemon/worker boundary and Project/Task/Run
model. Lifecycle changes must be explicit and observable, and scheduling and
watch ownership belong to the global control plane.

This records the accepted starting architecture, not an implementation or stable
public API. Detailed contracts and policies should be decided separately.

## Deferred decisions

- Go version, concrete libraries, SQLite driver, and repository/package layout.
- Database schema, migrations, storage locations, and event/log schemas and retention.
- Exact task/run states and transitions, retries, cancellation, timeouts, and
  crash/restart recovery.
- API endpoints and versioning, worker communication, IPC permissions, and
  platform transport details.
- Configuration keys, locations, precedence, and validation; watcher library,
  subscriptions, filtering, debouncing, and fallback behavior.
- Concurrency defaults, queue ordering, fairness, resource-aware scheduling, and
  worktree creation, naming, cleanup, and retention policies.
- Supported platform/version matrix, service installation, packaging/releases,
  optional container execution, and future UI/plugin interfaces.
