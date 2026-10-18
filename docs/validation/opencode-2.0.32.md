# OpenCode 2.0.32 compatibility

## Scope

The native host guard, direct SDK dependency and quota development override target
OpenCode 2.0.32. Other host versions, including 2.0.22, remain rejected. Existing
run snapshots retain their original runtime and dependency identity; updating the
coordinator does not migrate those snapshots.

The upstream comparison used OpenCode 2.0.22 commit
`527f0b931d1f9b3ebd34e106c51b31ce5db5b075` and
[2.0.32 commit `843a6c5`](https://github.com/anomalyco/opencode/tree/843a6c514e606b436a7fe713422ace0a93ad3d61).
Session/tool APIs, prompt submission, context hooks and message archive pagination
used by Heimdall remain compatible. The SDK moves Effect from 4.0.0-rc.112 to
4.0.1. The npm lock update also refreshes transitive packages in the SDK closure.

OpenCode now continues an output-limited response at most twice before failing
with `output-limit`. Heimdall continues to require a matching durable receipt and
confirmed native idle stop. Final chat text does not substitute for a receipt.
No workflow policy or prompt changes were required.

## Automated checks

Checked on macOS arm64 with Node.js 22.22.3 and npm 10.9.8:

- `npm run check`: passed.
- `npm test`: 1,488 passed, one skipped, zero failed. Git global/system settings
  were isolated so host commit-signing preferences did not affect fixtures.
- `npm run build:extension`: passed.
- `npm run test:package`: 64 passed, zero failed or skipped. Fresh consumer and
  temporary global installs passed dependency-tree checks, SDK/Effect API probes,
  all four package exports, setup/doctor and immutable snapshot verification.
  Changed and removed transitive Effect dependencies were rejected in both
  layouts. Existing optional-package validation rules were unchanged.

Continuation regressions cover missing receipts despite valid-looking final JSON,
receipt-backed advancement exactly once, sealed context/tool rejection, and
exhausted continuations preserving evidence without advancing a task. Existing
ownership, submission, recovery and coordinator tests run in the ordinary suite.

## Real native host check

`scripts/live/opencode-compatibility/run.mjs` passed against a real OpenCode
2.0.32 binary on the same macOS host. It loaded the plugin through the native
plugin API and used a synthetic local model and quota, without real credentials
or provider requests.

Observed: structured plan submission after a native output-limit continuation;
native write and structured result for the first task; a blocked second task;
explicit resume of the same run and parent without replaying the accepted first
task; completion with two accepted tasks; and five archived messages retrieved
through two-message pages. The fixture server exited and its directory was
removed.

This establishes standalone native workflow compatibility. It does not establish
real model quality, provider quota behavior, a live managed-run execution, or
Linux native-host behavior. Linux and additional Node versions remain CI checks.
Historical validation records describe their original versions.
