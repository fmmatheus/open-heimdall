# ADR 0001: Technical foundation

- Status: Accepted
- Date: 2026-10-06

## Context

Heimdall is an opinionated, minimalist agent orchestrator for the OpenCode +
OpenChamber workflow. A user provides a feature; Heimdall breaks it into tasks,
executes them sequentially within each run, manages model choice, and controls
usage according to user configuration.

The initial foundation should be approachable for OSS contributors, practical to
distribute, and reliable enough to coordinate concurrent runs across Git projects.
A single global service keeps workflow policy, watching, and observability
consistent. General-purpose orchestration is outside the product's scope.

## Decision

- **OpenCode + OpenChamber focus.** OpenCode is the target agent execution engine;
  Heimdall's workflow is designed to fit OpenChamber. The integration mechanism
  remains deferred.
- **Go** for the core daemon and CLI.
- **One global daemon with subprocess workers.** The daemon owns scheduling,
  lifecycle, state, watch management, resource allocation, and observability.
  Workers coordinate OpenCode task execution, worktree operations, and external
  commands.
- **SQLite** for persistent control-plane state and structured event history.
- **Git CLI integration** using the user's installed Git.
- **Git worktrees** to isolate concurrent agent changes within a project. Multiple
  agents must never modify the same worktree simultaneously.
- **HTTP/JSON over local IPC** between the CLI and daemon: a Unix domain socket on
  Unix and a named pipe equivalent on Windows.
- **Structured events and logs** for lifecycle history and execution diagnostics,
  associated with projects, tasks, and runs. CLI output remains human-readable.
- **TOML configuration**, with global settings and optional project-specific
  configuration.
- **Model selection and optional usage boundaries** managed by Heimdall. Usage is
  unlimited by default; users may configure boundaries such as session time and
  token usage per window. Exact policies remain deferred.
- **Project, Task, and Run** as core domain abstractions: a Project identifies a
  local Git project, a Task describes a work item from feature breakdown, and a
  Run tracks workflow execution. A feature is the user-requested change from
  which tasks are derived; detailed entity relationships remain deferred.
- **Sequential execution within each run:** at most one task is active per run.
  Multiple runs and features may progress concurrently within the same project
  or across different projects.
- **Explicit task/run state machines** with defined allowed transitions and event
  history, rather than independent lifecycle booleans. Exact states and
  transitions remain deferred.
- **A centralized watch manager** in the daemon, using abstractions over native
  OS watchers. Centralized ownership may involve multiple OS subscriptions; it
  does not require one watcher handle.
- **Global and per-project concurrency limits** on active runs, enforced by the
  daemon's scheduler. These do not permit parallel tasks within a run.

## Rationale

Go offers a straightforward concurrency model and practical distribution for a
daemon and CLI. Subprocess workers separate execution failures from the control
plane and make worker lifecycle management explicit.

Sequential task execution keeps each run's changes ordered. Worktree isolation
allows separate runs to progress concurrently without simultaneous agent writes
to the same working tree. Model selection and configurable usage boundaries make
workflow policy explicit while leaving usage unrestricted by default.

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
- Sequential tasks limit parallelism within a run. Concurrency limits need tuning
  and do not define scheduling fairness. Structured events and logs require
  consistent conventions and retention.
- OpenCode and OpenChamber integration creates compatibility requirements.
  Configured usage boundaries require accounting and enforcement policies.

## Consequences

Implementation should follow the daemon/worker boundary and Project/Task/Run
model. Feature breakdown, model choice, and usage policy belong to Heimdall.
Lifecycle changes must be explicit and observable, and scheduling and watch
ownership belong to the global control plane. Execution must preserve one active
task per run and one agent modifying a worktree at a time.

This records the accepted starting architecture, not an implementation or stable
public API. Detailed contracts and policies should be decided separately.

## Deferred decisions

- OpenCode/OpenChamber integration contracts and supported versions, feature/task/
  run relationships, task-planning policy, and model-selection rules.
- Usage-boundary scope, accounting, window definitions, and behavior when a
  configured boundary is reached.
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
