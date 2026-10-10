# Structured completion live verification (feature 0006)

Live end-to-end check of the structured completion protocol (`structured-v1`)
through the real Claude provider bridge, inside the guarded disposable fixture
introduced by [claude-code-report-only-live.md](claude-code-report-only-live.md).
No credential, transcript or store database is recorded here.

## Status

| Gate | State |
| --- | --- |
| Fixture root with a new prefix, stores resolved under it | Done, `/private/tmp/heimdall-0006.jFpXF9` |
| Guard proven before any live session | **guard proven**, ownership-based cleanup confirmed |
| Server started only through the `guard.mjs` launcher | Done |
| Planner typed submission, acknowledged, durable receipt | **Observed** |
| Executor typed submission, acknowledged, durable receipt | **Observed** |
| Exactly one task advancement (index 0 → 1) | **Observed** |
| Format-repair, negative-outcome and pause paths live | **Not exercised** (see [Not proven](#not-proven)) |
| Immutable runtime snapshot live | **Not exercised** (see [Not proven](#not-proven)) |
| Activation on the installed runtime | **PENDING (owner)**, see [Activation (owner)](#activation-owner) |

## Versions

Recorded by commands run in this task (`opencode --version`, `claude --version`,
the installed packages' `package.json`, `node --version`, `bun --version`,
`sw_vers`) and stored in the fixture `manifest.json`:

| Component | Version |
| --- | --- |
| OpenCode | 2.0.22 |
| Claude Code CLI | 2.1.292 |
| `@openchamber/opencode-claude` provider | 1.3.4 |
| `@anthropic-ai/claude-agent-sdk` | 0.3.224 |
| Node | v22.22.3 |
| Bun | 1.4.2 |
| macOS | 27.0.1 (build 26A434) |
| Executable the provider used | `<mise>/installs/node/22.22.3/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe`, version 2.1.292 |

These equal the versions of the feature 0005 record.

## What changed in the harness

- `scripts/live/claude-report-only/e2e-structured.mjs` (new): sends exactly one
  prompt, to an `adr-orchestrator` parent that calls `adr_workflow start` on the
  fixture ADR repository. It then only reads: it samples the run checkpoint every
  500 ms, waits for the parent to be idle, and writes a condensed summary
  (`evidence/e2e-structured.json`, timeline `e2e-structured.jsonl`). Transcripts
  are reduced to tool names, states and short result stubs.
- `t2-prepare.mjs`: takes `--planner-model` (a `claude-code/*` model) and
  `--variant`; mirrors the published package layout in the fixture (real
  `package.json`, lockfile, prompts, agent files) so the plugin computes its real
  runtime identity; and no longer patches `dist/policy/quota.js`. Only the
  provider-list check on the `dist` copy remains.
- `heimdall-fixture-plugin.mjs`: supplies the synthetic quota through the
  documented `createPlugin({ quota })` seam instead of a patched `dist` file, so
  the built plugin runs byte-identical.
- No file under `src/` or `test/` was changed by this task.

## Fixture-only settings

Not part of the shipped build, they live only under the fixture root:

- The planner model is `claude-code/opus` and the executor model
  `claude-code/sonnet`, both variant `high`, in the fixture `.heimdall/runtime.toml`.
- Synthetic quota snapshot, owner-only control socket and observer plugin, the
  disposable marker MCP server (`marker-mcp`).
- A copy of `dist` (manifest tree hash
  `d149b065aa41dfd1c9a62f2c4841e172fc090258417f5bad934220e254900e50`). The
  `claude-code` entry in `VERIFIED_REPORT_ONLY_PROVIDERS` was already present in
  this branch, so the copy was not patched (`patched: false`, `report-only.js`
  before and after both `51782f8f...c477b37`). The synthetic quota is passed to
  the plugin, not patched into `dist`.
- The copied provider carries the two isolation patches described in the 0005
  record (`settingSources` empty, `persistSession` false).

## Guard

The guard probe was run and recorded **guard proven** before any live session
(`manifest.json` `outcome`, `evidence/guard-results.json`). Ownership-based
cleanup of the probe was confirmed. Store resolution: the private profile, data,
cache and state directories all resolve under the fixture root, `HOME` unchanged,
and the live `OPENCODE_*` variables are unset. The real login was reached only
through the read-only Keychain broker (refresh tokens withheld, access token
only). The installed provider's `dist/query.js`
(`a3fc30b4...28a1d2`) and `dist/proxy.js` (`a993b4d0...006e2`) are identical
before and after (tree hash `810b0d93...afaa8`, 49 files); they were re-hashed
after the live run.

## Live result

One run, port `47411`, started through `guard.mjs launch ... -- bun server.mjs`.
The run took about 47 s from the parent prompt to completion.

| Step | Observed |
| --- | --- |
| Protocol | `structured-v1` persisted at start |
| Planner child (`adr-planner`, `claude-code/opus` `high`) | 8 model contexts, each offered `heimdall_submit_plan`; one call, pre and post hook, status completed |
| Planner submission | kind `planner-plan`, outcome `planned`, dispatch 1, caller session equals the recorded child, caller agent `adr-planner`, origin message recorded |
| Planner receipt | durable file `submission-<attempt>-planner-plan.json`, sealed; plus `outcome-<attempt>.json` captured after confirmed stop |
| Checkpoint after plan | phase `executor`, index 0, tasks 1 (`T1`, 3 DoD items) |
| Executor child (`adr-executor`, `claude-code/sonnet` `high`) | offered `heimdall_submit_result`; one call, status completed |
| Executor submission | kind `executor-result`, outcome `completed`, task `T1`, dispatch 2, caller session equals the recorded child, caller agent `adr-executor` |
| Executor receipt | durable file `submission-<attempt>-executor-result.json`, sealed; plus `outcome-<attempt>.json` |
| Final checkpoint | status `completed`, phase `executor`, **index 1**, tasks 1, results 1, child cleared |
| Task advancement | index moved 0 → 1 exactly once; evidence gates G1, G2, G3 passed; `reportCorrections` 0 |
| Repair | none: `repairs: 0`, `attempts: []`, boundary sealed with the attempt ID before the receipt was acknowledged |
| Dispatch generation | 2 (one planner binding, one executor binding), each with a recorded dispatch prompt |
| Parent | last turn `finish: stop`, no tool calls, then idle; no active session left after the run |
| Failures | none while waiting for idle or completion; no authentication or quota error |

Submission SHA-256 digests (file bytes):
planner `90d59f29b4da8489df18b33412d0ac67b777269167712ad314bdb915be1c7d68`,
executor `3d9c82ab0d8195d3968acf31cbf163252334f10f4938a2c786791bfd3ee44dd3`.
State file `465ee4829934033f6e8256239520bff62df29c3ed9ffabb15a0332312527cd0b`.

Loaded build identity recorded in the receipts: protocol `structured-v1`, build
digest `bc27246724349cdd15548f3371dacc6992fc979e7ad24e230e75c880671b71aa`
(package version `0.0.0`), identical in both receipts and the run state.

Real work in the fixture: the executor edited `src/impl.js` and
`test/impl.test.js` (`greet()` and `farewell()`); the changes are in the fixture
working tree and were **not committed** (`git status` shows two modified files,
HEAD still the baseline commit `596f48e`). The fixture is disposable.

An earlier invocation of the script created a parent session that left no run
state and no child (the script was started again); the run above is the only
run directory in the fixture repository.

## Not proven

- **Format repair, negative outcomes and every pause code.** The planner and
  executor both submitted a valid payload on the first call, so the two-retry
  repair, `submission_repair_exhausted`, `submission_refused`,
  `submission_unsupported`, `submission_missing`, `submission_unconfirmed` and
  `conflicting_work` were not reached live. They are covered by the unit tests
  only.
- **Immutable runtime snapshot.** The run used the fixture's copied `dist`
  loaded in place (`runtime.snapshot: false` in the receipt), not a run-owned
  snapshot from a coordinator-managed run. Snapshot creation, the read-only
  copy and the verification before launch and resume were not run live. The
  build identity recording (digests of `dist`, prompts and agents) was.
- **Coordinator-managed run.** The run was a native workflow start, not a
  coordinator submission. Owner fences, SQLite receipts and the service routes
  were not exercised live.
- **Other providers.** Only `claude-code` was tried. Providers other than
  `claude-code` are not claimed.
- **Restart behaviour.** The plugin was not restarted mid-run; recovery of a
  durable gate across a restart is unit-tested only.
- **Installed build.** Nothing was run against an installed build of this
  branch.
- The 0005 limits still apply: access token only (a token that expires mid-run
  fails authentication instead of rotating), and the guard denies writes without
  hiding credentials from reads or restricting the network.

## Cleanup

- Processes started by this task, stopped by PID and confirmed exited: Keychain
  broker `66047`, guard launcher `66360`, disposable server (bun) `66365` and its
  `marker-mcp` child `67692`; earlier probe brokers `64421` and `64460` had
  already exited. Nothing else was signalled. Port `47411` refuses connections
  afterwards and no process mentioning `heimdall-0006` remains.
- `HOME` and `CODEX_HOME` were not modified; no credential was copied, printed,
  refreshed or written.
- The fixture root stays on disk, outside the repository, with its evidence. It
  holds no committed material. Remove it with the owner's usual `rm -rf` when it
  is no longer needed.

## Command results

Run in this worktree on Node v22.22.3 after the live run, with no `src/` or
`test/` change by this task. The `dist/` output is git-ignored.

| Command | Exit | Result |
| --- | --- | --- |
| `npm run check` (`tsc --noEmit`) | 0 | no diagnostics |
| `npm test` (`npm run build`, then `node --test test/*.test.mjs`) | 0 | tests 649, suites 3, pass 649, fail 0, cancelled 0, skipped 0, todo 0 |
| `npm run build` (`tsc`) | 0 | built |
| `npm run build:extension` | 0 | `dist/openchamber-extension/`: `package.json` 941 B, `panel/index.html` 7,797 B, `panel/main.js` 196,654 B, `service/main.js` 97,840 B |

## Activation (owner)

Nothing here has been done by this task: no install, activation, merge or push.
The concrete steps are in the final owner message and in
[the coordinator guide](../coordinator.md#structured-completion-protocol).
