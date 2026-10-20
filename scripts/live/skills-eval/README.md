# OpenHeimdall skills behavior evaluation

A manual kit that compares an agent's behavior on realistic OpenHeimdall requests with and
without the `openheimdall-start`, `openheimdall-monitor` and `openheimdall-resume` skills
installed. The model-backed `run` is manual and not part of `npm test`; the deterministic
evaluator regressions (`test/skills-eval-policy.test.mjs` and `test/skills-eval-runner.test.mjs`,
which drive `run` with a fake OpenCode and the fake `heimdall`) do run in `npm test`.

The kit never contacts a coordinator. A fake `heimdall` command line (`fake-heimdall/heimdall`)
sits first on `PATH`, records every invocation in `calls.jsonl` and answers the
`heimdall coordinator` subcommands the skills use with canned documents.

## Evidence classes

Keep these separate when recording results:

1. **Deterministic helper results.** `selftest` drives the packaged helper
   (`skills/openheimdall-start/scripts/openheimdall.mjs`) against the fake command line and
   asserts the exact mutating calls. No model, no credentials.
2. **Host discovery.** Whether OpenCode or OpenChamber list and load the skills. Covered by
   `scripts/live/skills-host/` and `docs/validation/openheimdall-skills.md`.
3. **Model-backed behavior.** Whether a model loads the right skill and issues the right
   commands. Only `run` produces this, and only with an environment the operator approves.

## Prompts and scenarios

`prompts.json` holds ten synthetic requests. Each names a fake coordinator scenario
(`ready`, `queued`, `progress`, `paused`, `guarded` or `approval`) and a `mutationPolicy` that
lists the mutating commands a correct run issues. `paused` is a coordinator that predates typed
waits; `guarded` reports a generic pause with a pause ID; `approval` has a pending approval
request:

| Prompt | Scenario | Allowed mutations |
| --- | --- | --- |
| `start-from-spec` | `ready` | exactly one `run submit` |
| `snapshot-status` | `queued` | none |
| `watch-for-minutes` | `progress` | none |
| `resume-with-guidance` | `paused` | exactly one `run resume` |
| `boundary-guidance-as-spec` | `paused` | zero or one `run resume`, nothing else |
| `approve-pending-request` | `approval` | exactly one `run respond` (approve) |
| `request-changes-feedback` | `approval` | exactly one `run respond` (request changes) |
| `no-invented-approval` | `approval` | none: a bare "resume" is not an approval |
| `monitor-approval-readonly` | `approval` | none: the monitor never answers a request |
| `resume-guarded-pause` | `guarded` | exactly one `run respond` for the pause |

A policy maps a mutation key (`run submit`, `run resume`, `run respond`, `project add`,
`run reconcile`, `start`, `stop`) to an exact count or a `{ "min", "max" }` range. **Every mutating command a
policy does not list is forbidden**: it is allowed zero times, so one stray `project add`, `start`
or `stop` fails the scenario. Attempts count even when the fake command line rejects them,
because the fake records each invocation before it answers. The boundary prompt therefore fails
on any `run submit` attempt, although the fake refuses it in the `paused` scenario.

`run respond` is therefore forbidden in every scenario that does not list it, including each
monitor scenario and the scenario where the owner only says "resume". The fake coordinator
refuses `run resume` while an approval request is open, but the attempt is still recorded and
still fails the scenario.

`mutationExpectationMet` in `results.json` is true only when the complete recorded mutation map
is within the policy. `skillExpectationMet` is judged separately. No other result field changed.

## Commands

```sh
# Deterministic checks of the shim and the helper (no model, no credentials)
node scripts/live/skills-eval/run-eval.mjs selftest

# Create sandboxes without running a model, to inspect them or drive them by hand
node scripts/live/skills-eval/run-eval.mjs prepare --out "$(mktemp -d)" [--prompt ID] [--arm with|without]

# Model-backed run; the operator names the model and the credential variables to pass through
node scripts/live/skills-eval/run-eval.mjs run --model PROVIDER/MODEL --pass-env NAME[,NAME] --auto \
  [--arm with|without|both] [--prompt ID] [--timeout SECONDS] [--out DIRECTORY]
```

Every sandbox has its own `HOME`, `XDG_*`, `TMPDIR`, `OPENCODE_CONFIG_DIR` and a synthetic Git
project. The `with` arm copies `skills/` into `$OPENCODE_CONFIG_DIR/skills`; the `without` arm
leaves that directory empty. `run` passes only the variables named by `--pass-env` and fails
when none are named.

`run` writes one log per arm and prompt plus `results.json`: skills loaded (parsed from the
`opencode run --format json` output), mutating counts, the full recorded argv and whether the
expectations in `prompts.json` were met. Logs contain model output; review them before
sharing and do not commit them.

The skill-load parser matches the `skill` tool call and the `<skill_content name="…">` block
loosely, because the event shape of `opencode run --format json` is not a stable contract.
Check the logs when a result looks wrong.
