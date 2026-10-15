# OpenHeimdall skills

The package ships three agent skills that drive the coordinator from a normal
OpenCode or OpenChamber session, using the installed `heimdall` CLI:

| Skill (ID) | Use it to | Changes coordinator state |
| --- | --- | --- |
| `openheimdall-start` | Submit a new run from a task-spec Markdown file. | Yes: at most one `run submit` per use; optionally registers the project and starts the coordinator when asked. |
| `openheimdall-monitor` | Read the state of a run once, or watch it for a bounded time. | Never. |
| `openheimdall-resume` | Send the owner's guidance to a paused run so the same run continues. | Yes: at most one `run resume` per use. |

Each skill is a directory with a `SKILL.md` and `scripts/openheimdall.mjs`, a
dependency-free Node helper (identical in all three directories) that calls the
`heimdall` CLI and prints compact JSON. Nothing is installed by `npm install`:
you copy the directories into a skills location that your host reads.

> **Status:** pre-alpha, like the rest of Heimdall. Automated tests cover the
> helper, the skill files and the packaged copies. Loading and following the
> skills inside a live OpenCode or OpenChamber session has not been observed yet;
> see [Verification status](#verification-status) for which statements about
> hosts come from documentation or source and which are unverified.

## Prerequisites

The skills run the coordinator workflow; they do not set it up.

1. A global `heimdall` installation on `PATH` and a coordinator configuration, as
   described in [Installation and setup](installation.md). `heimdall doctor`
   checks the installation.
2. A Git project with at least one commit. Starting a run needs the project to
   be registered with the coordinator (the start skill can do this when you name
   or confirm the repository) and to have a valid project configuration.
3. A running coordinator, unless you ask the start skill to start it
   ([Coordinator operation](coordinator.md#background-service-start-stop-and-logs)).
   The monitor and resume skills never start one.
4. Host permissions that allow the session to run `node` and `heimdall` (see
   [Permissions](#permissions-the-skills-do-not-grant)), and to write a file when
   you give guidance as text.
5. Node.js 22.19 or newer, the same requirement as the package.

## What each skill is for

- **`openheimdall-start`**: "start a run from `specs/feature.md`", "queue this
  spec on this repository". It checks the spec file, resolves the base to a full
  commit, finds the registered project, submits once and reports the run as
  `queued`. Accepted means queued, not started or complete. It is not for status
  checks, not for guidance for an existing run and refuses to start a run from a
  file that looks like guidance without asking.
- **`openheimdall-monitor`**: "what is the state of this run?", "watch it until
  it pauses". It reads the run record (`status`, progress, current task, blocker,
  worktree, branch, session) and reports it. It selects the run from an explicit
  ID, else from the managed `heimdall/run/<id>` branch of your working directory,
  else from the only active run of the matching project, and asks when that is
  ambiguous.
- **`openheimdall-resume`**: "resume run RUN_ID with this guidance" (typed text
  or a Markdown file). The run must be paused with no reserved capacity. It keeps
  its ID, worktree, branch and accepted results; it never creates a new run.
  Anything else (still running, `reconciliation-required`, finished) is reported
  and left alone.

## Install for OpenCode

OpenCode reads a skill from a directory whose name is the skill ID. Install by
copying the three directories from the installed package; do not link them.

### Locate the installed package

For a global install, the package is under the npm global root:

```sh
SKILLS="$(npm root -g)/@open-heimdall/core/skills"
ls "$SKILLS"
```

`npm prefix -g` prints the prefix that root lives under (on Unix
`$(npm prefix -g)/lib/node_modules`). The listing must show
`openheimdall-monitor`, `openheimdall-resume` and `openheimdall-start`. For a
project-local install, use `node_modules/@open-heimdall/core/skills` in that
project instead.

### Personal install (every project)

The personal location is the `skills` directory of the OpenCode configuration
directory: `~/.config/opencode/skills`, or `$XDG_CONFIG_HOME/opencode/skills`
when `XDG_CONFIG_HOME` is set, or `$OPENCODE_CONFIG_DIR/skills` when
`OPENCODE_CONFIG_DIR` is set (see [Custom configuration directory](#custom-configuration-directory)).

```sh
TARGET="${OPENCODE_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/opencode}/skills"
mkdir -p "$TARGET"
for name in openheimdall-start openheimdall-monitor openheimdall-resume; do
  if [ -e "$TARGET/$name" ] || [ -L "$TARGET/$name" ]; then
    echo "skip: $TARGET/$name already exists" >&2
  else
    cp -R "$SKILLS/$name" "$TARGET/$name"
  fi
done
```

### Project install (one repository)

Copy into the repository's `.opencode/skills` directory instead:

```sh
TARGET="/path/to/your/project/.opencode/skills"
mkdir -p "$TARGET"
for name in openheimdall-start openheimdall-monitor openheimdall-resume; do
  if [ -e "$TARGET/$name" ] || [ -L "$TARGET/$name" ]; then
    echo "skip: $TARGET/$name already exists" >&2
  else
    cp -R "$SKILLS/$name" "$TARGET/$name"
  fi
done
```

Decide whether to commit `.opencode/skills/` with the project or keep it out of
version control. Heimdall does not install, update or manage these copies.

### Collisions and renaming

The loop never overwrites: if a target directory (or a link with that name)
exists, it is skipped and reported. To see whether the existing copy matches the
package, run `diff -r "$SKILLS/openheimdall-start" "$TARGET/openheimdall-start"`.
To replace it with the packaged version, remove that one directory yourself and
copy again. Do not merge the new files into an old directory: the helper must be
identical in all three skills.

Renaming a copy is not supported. OpenCode derives the skill ID from the
directory name, and the three skills and their instructions refer to each other
by the names `openheimdall-start`, `openheimdall-monitor` and
`openheimdall-resume`. Keep the directory names unchanged.

If the same ID exists in two skill sources, OpenCode loads the one from the
source with higher precedence, and a project `.opencode/skills` copy takes
precedence over a personal copy. A stale copy in the higher-precedence location
therefore hides an updated one in the other.

### Custom configuration directory

OpenCode 2.0.22 uses `OPENCODE_CONFIG_DIR`, when set, as its global
configuration directory and reads `skills` below it. Set the variable the same
way for the process that runs OpenCode, and use the same value in the `TARGET`
expression above. A graphical host started from a launcher does not necessarily
see variables you export in a terminal.

## Install in OpenChamber 2.1.0

OpenChamber 2.1.0 manages skills at **Settings → Skills**: it can create a skill
there and install published skills from **Settings → Skills → Catalog**, in a
personal scope (available in every project) or a project scope. Its personal
scope is the same `skills` directory of the OpenCode configuration directory
(honouring `OPENCODE_CONFIG_DIR` for the OpenChamber server process), and its
project scope is the project's `.opencode/skills`. Skills you placed there by
hand with the commands above appear in the same list.

To install the three skills from the catalog, add this repository as a custom
source: a GitHub `owner/repo` name (optionally with a subpath, for example
`owner/repo/skills`), an `https://` Git URL or a `git@` SSH URL. The catalog
clones the repository, finds `SKILL.md` files, and installs the directories you
select. It copies files and rejects symbolic links ("Symlinks are not supported
in skills"); the three skill directories contain only regular files. If a skill
with the same name already exists in the chosen scope, OpenChamber asks whether
to skip or overwrite it, per skill or for all; choose skip to keep what you have.
Private repositories need a configured SSH key or saved credentials on the machine
that runs OpenChamber.

Limits of this route:

- It installs from a Git remote only. The documented source forms do not include
  a local directory, so before this repository's skills are published at a
  reachable remote, use the copy instructions above.
- It installs whatever the selected revision of the repository contains. Check that
  the revision has the `skills/` directory of the version you run.
- A repository can contain other `SKILL.md` files; select only
  `openheimdall-start`, `openheimdall-monitor` and `openheimdall-resume`.

## Find the installed skill IDs

The ID is the directory name, so the three IDs are `openheimdall-start`,
`openheimdall-monitor` and `openheimdall-resume`. List the directories:

```sh
ls "$TARGET"
```

OpenCode shows the global configuration directory with `opencode debug paths`
(the `config` line). OpenCode 2.0.22's `opencode debug` has `agents`, `config`
and `paths` subcommands; it has no command that lists skills, so whether
`opencode debug config` shows them is unverified. In OpenChamber, **Settings →
Skills** lists what it discovered. The `name` in a `SKILL.md` is a display label
and does not change the ID.

## Invoke a skill

- **OpenCode (V2):** mention the skill in your prompt as `@openheimdall-start`,
  `@openheimdall-monitor` or `@openheimdall-resume`, or ask in plain words
  ("start a run from `specs/feature.md`") and let the model load the skill from
  its description. OpenCode loads a skill with the `skill` tool by exact ID.
- **OpenChamber 2.1.0:** type `/` in the middle of a message to open the skill
  picker and choose the skill. A `/` at the very start of a message opens
  commands, not skills.

Do not rely on a `/openheimdall-start` slash command: neither host documents that
skills become slash commands, and this package does not define commands.

When the host loads a skill it prints the skill's base directory; the skill runs
`node "<base directory>/scripts/openheimdall.mjs" ...` from there, with `--cwd`
set to your working directory. OpenCode prints this base directory; OpenChamber
2.1.0 doing so is unverified, and the skills fall back to the directory that holds
`SKILL.md`.

## Coordinator selection

Every skill call uses one coordinator configuration. By default the CLI selects it
as documented in [Configuration locations](installation.md#configuration-locations):
`--coordinator-config FILE`, then `HEIMDALL_COORDINATOR_CONFIG`, then
`~/.config/heimdall/coordinator.toml`. To use another one, name the file in your
request ("monitor the run using `/path/to/coordinator.toml`"). The skill then passes
`--coordinator-config` with the absolute path to every call of that task. The
helper's `context` report states which configuration was selected. Relative paths
resolve against your working directory, not the skill directory.

## Watching a run

`openheimdall-monitor` takes one snapshot by default. It watches only when you
ask. The helper's `watch` command is always finite:

| Setting | Default | Allowed |
| --- | --- | --- |
| Time budget | 600 seconds | up to 3600 seconds |
| Poll interval | 15 seconds | 0.1 to 300 seconds |

Values outside the range are rejected, not adjusted. A watch prints one line per
real change, nothing for an unchanged state, and ends when the run pauses or
reaches a terminal state, when the budget ends, when it is interrupted or when
the coordinator becomes unreachable. If your host limits how long a command may
run, ask for a budget below that limit. Ending a watch never affects the run. A
reserved capacity slot is not proof that an agent is active and a quiet run is not
proof of a stall.

## Uncertain outcomes

The start and resume helpers send their request once and never retry. If the
response is lost (a timeout, a reset, an invalid or oversized reply, or an unknown
error after the request may have been delivered), the result is `uncertain`:

- the skill follows only with read-only inspection and shows what it found;
- it does not claim the request failed and does not claim it was accepted because a
  similar run exists, since every accepted submission creates another run;
- it does not repeat the request. Deciding whether to submit or resume again is
  yours, after checking with the monitor skill or `heimdall coordinator run show`.

A refusal that happens before anything is sent (for example the coordinator is not
reachable, the spec is empty or the run is not paused) is reported as nothing sent.
A `run list` can be incomplete or too large, so a run missing from it is not proof
that it does not exist; `run show RUN_ID` is authoritative.

## What monitoring never does

`openheimdall-monitor` reads only. It runs `status --json`, `project list`,
`run list` and `run show`, and read-only Git inspection. It never runs
`run submit`, `run resume`, `run reconcile`, `project add`, `coordinator start` or
`stop`, the helper's `start` or `resume`, and never edits locks, keys, state files
or sessions. If a run needs recovery, it reports that and stops.

## Permissions the skills do not grant

A skill is instructions. It gives the session no permission, installs nothing and
changes no configuration or credentials. The session still needs the host's
permission to run `node` and `heimdall` and, for text guidance, to write a file. If
the host denies one, the skill reports the missing capability instead of working
around it. In OpenCode, whether a session may load a skill is itself a permission
(the `skill` action with the skill ID as the resource), so a deny rule can hide
these skills.

## Uninstall

Remove only the directories you installed:

```sh
rm -r "$TARGET/openheimdall-start" "$TARGET/openheimdall-monitor" "$TARGET/openheimdall-resume"
```

Use the target you installed into (personal or project). In OpenChamber you can
remove them from **Settings → Skills** instead. Uninstalling does not touch the
coordinator, its projects or any run, and `npm uninstall` of the package does not
remove copies you made.

## Try it end to end

[`examples/skills-dogfood/`](../examples/skills-dogfood/README.md) holds a small
two-task spec, a guidance file and the steps to start a run, watch it pause,
resume it and check that the first result was kept. It is operated by the owner
and has not been run yet.

## Verification status

Statements about OpenCode and OpenChamber behavior in this guide come from these
sources. Anything not listed or marked unverified has not been checked against the
pinned sources.

| Claim | Source |
| --- | --- |
| Personal and project locations, `@skill-id` mention, ID = directory name, later source wins, `skill` permission, base directory is provided | OpenCode V2 skills documentation (https://opencode.ai/v2/docs/skills) |
| `OPENCODE_CONFIG_DIR` replaces the global configuration directory, and `skills` under it is read | OpenCode 2.0.22 source at commit `527f0b9`: `packages/util/src/global.ts`, `packages/util/src/global-roots.ts`, `packages/core/src/config/discovery.ts`, `packages/core/src/config/plugin/skill.ts` |
| Skill ID is the parent directory name of `SKILL.md`; the loaded skill reports "Base directory for this skill" | Same commit: `packages/core/src/config/plugin/skill-file.ts`, `packages/core/src/skill.ts` |
| `/` mid-message opens the skill picker; the catalog, custom Git source, scopes and skip/overwrite prompt | OpenChamber v2.1.0: `packages/docs/content/docs/skills.mdx`, `skills-catalog.mdx` |
| Source forms (`owner/repo[/subpath]`, `https://`, `git@`), `SKILL.md` discovery, project and personal targets, copy without symbolic links, name check | OpenChamber v2.1.0: `packages/web/server/lib/skills-catalog/source.js`, `scan.js`, `install.js`; `packages/web/server/lib/opencode/shared.js` |
| `opencode debug` subcommands in 2.0.22 | Local `opencode debug --help` (v2.0.22) |

**Unverified:**

- Loading the skills and following them in a live OpenCode 2.0.22 or OpenChamber
  2.1.0 session (the `skill` tool call, the printed base directory, running the
  helper). Only the packaged files and the helper are covered by automated tests.
- OpenChamber 2.1.0 printing the skill's base directory to the model.
- A skill picker in OpenCode V2 (only the `@skill-id` mention is documented).
- Whether `opencode debug config` lists skills.
- Installing from a custom Git source in the OpenChamber UI with this repository,
  and what its overwrite option does to an existing directory.
- Skills copied to `~/.claude/skills`, `~/.agents/skills`, `.claude/skills` or
  `.agents/skills`, which the hosts discover but this guide does not use.
- Native Windows: the commands above are POSIX shell, and native Windows operation
  of Heimdall is untested.
