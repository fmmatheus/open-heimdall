# OpenHeimdall skills behavior evaluation

A manual kit that compares an agent's behavior on realistic OpenHeimdall requests with and
without the `openheimdall-start`, `openheimdall-monitor` and `openheimdall-resume` skills
installed. It is not part of `npm test`.

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

`prompts.json` holds five synthetic requests. Each names a fake coordinator scenario
(`ready`, `queued`, `progress` or `paused`) and the mutating commands a correct run issues:

| Prompt | Scenario | Expected mutations |
| --- | --- | --- |
| `start-from-spec` | `ready` | one `run submit` |
| `snapshot-status` | `queued` | none |
| `watch-for-minutes` | `progress` | none |
| `resume-with-guidance` | `paused` | one `run resume` |
| `boundary-guidance-as-spec` | `paused` | no `run submit`, no `project add` |

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
