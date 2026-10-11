# OpenHeimdall Agent Guide

## Purpose and scope

This file governs contributions to the OpenHeimdall repository.

OpenHeimdall coordinates agent work through OpenCode and provides run visibility and review through its OpenChamber extension. Consult the README for current capabilities and supported versions.

Keep repository instructions relevant to contributors. Personal preferences and owner-specific goals belong in local instructions.

## Setup and commands

Run commands from the repository root. Use `package.json` and `.github/workflows/` as the sources of truth for commands, prerequisites and required checks.

The current minimum Node.js version is 22.19.

| Command | Purpose |
| --- | --- |
| `npm ci --ignore-scripts` | Install locked dependencies |
| `npm run build` | Build the TypeScript package |
| `npm run check` | Check TypeScript without emitting files |
| `npm test` | Build and run the test suite |
| `npm run build:extension` | Build the OpenChamber extension |

Use focused tests while making changes. Before handing off source changes, run the applicable CI checks, including type checking, tests and the extension build.

For documentation-only changes, verify accuracy, references and documented commands. Run additional checks when the change affects setup or executable behavior.

Distinguish automated tests from live validation. Live validation must use an identified environment and stay within the authorized task.

## Change discipline

- Work within the requested scope and acceptance criteria.
- Read the files you change and follow nearby implementation conventions.
- Preserve pre-existing edits. Stage only changes belonging to the task.
- Treat existing public commands, configuration, protocols and persisted data as compatibility boundaries.
- Change workflow policy, prompts or runtime state only when the task includes that work.
- Keep acceptance checks intact. Fix failures without weakening checks or fabricating completion evidence.
- Proceed with routine implementation choices. Surface missing decisions when they materially affect scope, behavior or compatibility.
- Commit, push, merge, publish or deploy only within the authorization provided for the task.

## Documentation and comments

Write public artifacts for readers who have not seen the conversation.

- Keep conversation, prompt and iteration history out of code comments, documentation and pull request descriptions.
- Keep personal goals, temporary owner instructions, credentials and personal absolute paths out of public artifacts.
- Use `/local-features/` for owner-specific feature briefs. Keep generated run artifacts in their configured runtime storage.
- Public specifications should describe product behavior, constraints and acceptance criteria.
- Comments should explain current behavior and rationale. State the actual compatibility constraint when one exists.
- Use synthetic examples and sanitized evidence when documenting configuration or validation.
- Separate implemented behavior, proposed behavior and unverified claims.

## Verification and handoff

Choose verification that exercises the affected behavior. Reuse existing test patterns and check for existing coverage before adding tests.

Report exactly what was checked and what remains unverified. Static checks alone do not establish live execution, UI behavior or platform compatibility.

A human-facing handoff should explain:

- What changed and why.
- Which checks ran and their results.
- Remaining limitations or blockers.
- The specific action or decision required for any blocker.

For Heimdall-managed tasks, follow the supplied structured submission and evidence contract. Submit only results supported by actual evidence.

## Relevant documentation

Read documentation according to the task:

- `README.md`: product capabilities, supported setup and quickstart.
- `docs/development.md`: development setup and OpenCode integration.
- `docs/coordinator.md`: scheduling, persistence, execution and recovery.
- `docs/openchamber-extension.md`: extension behavior, build and installation.
- `docs/adr/`: rationale for existing architecture decisions.
- `docs/validation/`: recorded checks and known verification limits.

Existing validation records are historical evidence. Check that their code, environment and behavior remain applicable before relying on them.
