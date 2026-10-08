# Native coordinator bootstrap validation

For subsequent real-model execution and recovery results, see the
[Claude Code coordinator smoke](claude-code-coordinator-smoke.md).

Validated against merged PR #4 and OpenCode **2.0.22** using disposable Git
projects and a separate passwordless loopback server. The server used private
execution state, configuration, logs, cache and temporary directories; automatic
session restart recovery was disabled.

Observed:
- The real `/api/info` returned 200 without authorization and matched version/PID.
- Both dependency-free fixture projects passed their baseline tests and registered
  with distinct canonical Git identities and the requested project limits.
- SQLite reservation, new locked worktree creation and exclusive runtime assets
  produced one managed checkout without modifying its source project.
- OpenCode activated the exact generated `adr.workflow` plugin and the primary
  orchestrator plus two subagent roles in that checkout.
- The diagnostic reservation admitted no model prompt. It was explicitly
  released before native launch while retaining its worktree and ownership.
- SHA-256 verification found all 85 protected original workflow files unchanged.

The setup exposed two integration gaps addressed here: explicit passwordless
connections were unsupported, and a cold location could be rejected while its
plugin/agent inventories were still activating. Basic authentication remains the
default, including legacy stored submissions; readiness now has a bounded
read-only wait before any native mutation.

Full feature execution is **pending**. The selected Anthropic credentials in the
default native account store were expired, and the read-only test setup did not
refresh them. No stored credential values were copied into the test database,
displayed or changed. Sequential
task completion, simultaneous native execution, global/per-project live admission
and blocked-task resume have not yet been validated against real models.
