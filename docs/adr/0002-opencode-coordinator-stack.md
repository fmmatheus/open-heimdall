# ADR 0002: TypeScript coordinator and OpenCode execution

- Status: Accepted
- Date: 2026-10-06
- Amends: [ADR 0001: Technical foundation](0001-technical-foundation.md)

## Context

The existing JavaScript ADR workflow has exercised planning, sequential task
sessions, model/quota selection, usage tracking, and OpenCode/OpenChamber
integration, including a successful live two-task run. Its logic and tests are
Heimdall's starting point.

Heimdall adds global coordination and concurrent isolated runs within and across
projects. These requirements do not establish a need to port the proven workflow
to Go or to build another agent execution runtime.

## Decision

- **TypeScript + Node.js** for the first version's coordinator and CLI. Extract
  the existing workflow logic and preserve its behavioral tests.
- **One global Heimdall coordinator** owns planning, scheduling, model policy,
  configured usage boundaries, coordination state, and recovery.
- **OpenCode owns agent and tool execution.** Heimdall controls its sessions
  through an adapter, preserving the existing OpenChamber-managed connection and
  workflow commands. Adapters must match supported OpenCode versions.
- **SQLite** stores Heimdall's coordination state and structured event history.
  OpenCode retains its session storage.
- **Git CLI and isolated worktrees** remain the Git integration and isolation
  model. Multiple agents must never modify the same worktree simultaneously.
- **HTTP/JSON over local IPC** remains the CLI-to-Heimdall interface: Unix sockets
  on Unix and named pipes on Windows. The adapter uses OpenCode's API; these are
  separate communication boundaries.
- **TOML configuration, structured events/logs, and explicit task/run state
  machines** remain the foundations for configuration and observability.
- **Centralized watch ownership** remains. Observe execution through OpenCode
  events; add native filesystem subscriptions only for concrete workflow
  triggers.

Each run handles at most one active task. Multiple runs and features may progress
concurrently within the same project or across projects, subject to global and
per-project concurrency limits.

Heimdall manages model choice and optional usage boundaries. Usage is unlimited
by default; users may configure boundaries such as session time and token usage
per window. Exact accounting and enforcement semantics remain deferred.

## Rationale

Reusing the working workflow preserves tested execution policy and reduces the
amount of new implementation. TypeScript provides typed interfaces within the
same language ecosystem as the existing JavaScript modules and OpenCode's
[JS/TS client](https://opencode.ai/docs/sdk/).

The coordinator owns global policy and durable coordination while OpenCode owns
agent execution. Separate storage ownership keeps Heimdall's run history distinct
from OpenCode's session data. OpenCode events provide a starting point for
observation without requiring new filesystem subscriptions for every run.

## Tradeoffs

- Node.js distribution requires runtime and packaging decisions. The earlier Go
  choice favored native binary distribution.
- Integration depends on supported OpenCode/OpenChamber behavior and requires
  version compatibility maintenance.
- Existing per-location locks and state files need adaptation for global
  scheduling, SQLite persistence, and concurrent isolated runs.
- Configured usage boundaries require precise accounting and stopping rules;
  the existing workflow does not establish every future boundary guarantee.

## Consequences

This supersedes ADR 0001's Go choice, its separate Heimdall worker execution layer,
and its assumption of native filesystem watching as the initial mechanism.
SQLite, Git/worktrees, TOML, local IPC, lifecycle states, structured events,
concurrency rules, and unlimited-by-default usage remain accepted.

Implementation starts by extracting the validated workflow and preserving its
tests. New verification should cover changes introduced by global coordination,
worktree ownership, and recovery.

## Deferred decisions

- Node.js version, libraries, SQLite driver, package layout, and distribution.
- Adapter contracts, supported versions, process lifecycle details, and
  session/run/worktree mappings.
- Feature/plan/task/run relationships, exact states, retry and recovery rules.
- Usage-boundary scope, window definitions, accounting, and limit-reached behavior.
- Scheduling defaults and fairness, worktree lifecycle, and required watch
  triggers.

Other deferred choices in ADR 0001 remain open where consistent with this record.
