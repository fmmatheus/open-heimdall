import { runSetup, UNVERIFIED_BY_SETUP, type SetupInput, type SetupOptions, type SetupResult } from './core.js';

/*
 * `heimdall setup` command line front end over the shared setup core (core.ts).
 *
 * Output contract
 * ---------------
 * Human mode (default): the summary goes to stdout on success; every diagnostic (errors, partial outcomes,
 * warnings, flag guidance) goes to stderr.
 *
 * `--json`: stdout carries exactly one JSON document followed by a newline, for success and for every
 * reportable failure, including argument errors. Nothing else is written to stdout and no prose is printed
 * there. stderr stays empty. `--help` is the single exception: it prints the help text and ignores all
 * other arguments.
 *
 * JSON document, schemaVersion 1 (the SetupResult of the core):
 *   schemaVersion  1
 *   ok             true when both configuration files are complete (created or reused), otherwise false
 *   projectDirectory  canonical Git project directory, or null when it was not determined
 *   targets        { coordinator, project }, each { path: string | null, outcome }
 *                  outcome: "created" | "reused" | "not-written" | "failed"
 *   createdDirectories  configuration parent directories created by this invocation (mode 0700)
 *   verification   { level: "configuration-validated" | "none", unverified: string[] }
 *                  "configuration-validated" means only that the files pass the configuration validators;
 *                  unverified always lists opencode-connection, model-availability, provider-login, quota
 *   error          null, or { code, message, missing: string[] }
 *                  code: invalid-input | missing-input | no-git-project | no-commit | invalid-destination |
 *                        invalid-configuration | incomplete-configuration | conflict | identical-destinations |
 *                        destination-exists | write-failed | unexpected
 *                  missing: flag names for missing-input, setting keys for incomplete-configuration, else []
 *   partial        null, or { created: string[], incomplete: string[] } when one file was published and the
 *                  other was not; nothing is rolled back and a rerun finishes the missing file
 *   warnings       string[]
 * Argument errors use code "invalid-input". Every string is redacted: credential values taken from the
 * environment, URL user information and Authorization-style values never appear.
 *
 * Exit status: 0 when ok is true (including a run that only reuses existing files); 1 for every other
 * outcome, including argument errors, missing inputs, incomplete configuration, conflicts and partial
 * outcomes. Use error.code and partial to tell them apart.
 */

export const setupHelp = `Create the coordinator and project configuration

Usage:
  heimdall setup [flags]

Writes the coordinator configuration and the project's .heimdall.toml only when they are absent.
Existing valid files are reused byte-for-byte. Explicit values that disagree with an existing file
fail with an explanation; setup never overwrites. It does not initialize Git, create commits, start
a coordinator, register the project, create state or contact OpenCode or any provider.

Flags:
  --project DIRECTORY             existing Git project with a commit (default: the current Git project)
  --config FILE                   project configuration (default: $HEIMDALL_CONFIG, else .heimdall.toml in the project)
  --coordinator-config FILE       coordinator configuration (default: $HEIMDALL_COORDINATOR_CONFIG,
                                  else ~/.config/heimdall/coordinator.toml)
  --planner-model PROVIDER/MODEL  planner model for a new project configuration
  --executor-model PROVIDER/MODEL primary executor model for a new project configuration
  --quota-provider PROVIDER       anthropic, claude-code, openai or kimi; claude-code pairs with claude-code/ models
  --opencode-url URL              local OpenCode origin, for example http://127.0.0.1:4096
  --opencode-auth basic|none|openchamber
                                  authentication for the OpenCode connection
  --password-env NAME             environment variable that holds the Basic password (a reference only;
                                  no password or token is ever accepted as a flag)
  --state-directory DIRECTORY     coordinator state directory (relative paths resolve against the coordinator configuration)
  --global-concurrency NUMBER     coordinator-wide run limit (default 1)
  --project-concurrency NUMBER    per-project run limit (default 1)
  --no-input                      never prompt; missing required inputs fail before anything is written
  --json                          print one JSON document on stdout (schemaVersion 1); never prompts
  --help                          show this help

A new project configuration needs --planner-model, --executor-model, --quota-provider, --opencode-url
and --opencode-auth. Without --no-input or --json, an interactive terminal may be asked for them;
any other invocation (including piped input) never prompts.

Exit status is 0 on success or when existing files are reused, and 1 for errors, incomplete
configuration, conflicts and partial outcomes. A summary goes to stdout; diagnostics go to stderr.
With --json, stdout is a single document with fields schemaVersion, ok, projectDirectory, targets,
createdDirectories, verification, error, partial and warnings.

Setup only validates configuration. It does not verify the OpenCode connection, model availability,
provider login or quota; run \`heimdall doctor --connect\` for the connection check.

Example:
  heimdall setup --planner-model PROVIDER/PLANNER --executor-model PROVIDER/EXECUTOR \\
    --quota-provider openai --opencode-url http://127.0.0.1:4096 --opencode-auth basic --no-input
`;

/** Prompt hook for the interactive wizard: returns the completed input, or null when the user cancelled. */
export type SetupPrompt = (request: { input: SetupInput; environment: NodeJS.ProcessEnv }) => Promise<SetupInput | null>;

interface Writable { write(text: string): unknown; isTTY?: boolean }

export interface SetupCommandOptions {
  stdin?: { isTTY?: boolean };
  stdout?: Writable;
  stderr?: Writable;
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
  homeDirectory?: string;
  operations?: SetupOptions['operations'];
  /** Used only when stdin and stdout are terminals and neither --no-input nor --json was given. */
  prompt?: SetupPrompt;
}

class UsageError extends Error {
  constructor(message: string) { super(message); this.name = 'UsageError'; }
}

const TEXT_FLAGS: Record<string, keyof SetupInput> = {
  '--project': 'projectDirectory', '--config': 'configPath', '--coordinator-config': 'coordinatorConfigPath',
  '--planner-model': 'plannerModel', '--executor-model': 'executorModel', '--quota-provider': 'quotaProvider',
  '--opencode-url': 'opencodeUrl', '--opencode-auth': 'opencodeAuth', '--password-env': 'passwordEnv',
  '--state-directory': 'stateDirectory',
};
const NUMBER_FLAGS: Record<string, keyof SetupInput> = { '--global-concurrency': 'globalConcurrency', '--project-concurrency': 'projectConcurrency' };
const SWITCHES = new Set(['--no-input', '--json']);
const CREDENTIAL_FLAG = /pass|token|secret|credential|authoriz|api-?key|bearer/i;

export interface ParsedSetupArguments { input: SetupInput; noInput: boolean; json: boolean; help: boolean }

/** Never echoes a value; a flag is named only when it looks like a plain flag name. */
export function parseSetupArguments(args: readonly string[]): ParsedSetupArguments {
  const input: Record<string, string | number> = {};
  const seen = new Set<string>();
  let noInput = false;
  let json = false;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith('--')) throw new UsageError('Unexpected argument; setup takes flags only. See heimdall setup --help');
    const equals = argument.indexOf('=');
    const name = equals === -1 ? argument : argument.slice(0, equals);
    const inline = equals === -1 ? undefined : argument.slice(equals + 1);
    if (name === '--help') { help = true; continue; }
    const known = name in TEXT_FLAGS || name in NUMBER_FLAGS || SWITCHES.has(name);
    if (!known) {
      const label = /^--[A-Za-z][A-Za-z0-9-]{0,40}$/.test(name) ? ` ${name}` : '';
      if (CREDENTIAL_FLAG.test(name)) throw new UsageError(`Credentials are never accepted as flags${label}. Name an environment variable with --password-env NAME instead`);
      throw new UsageError(`Unknown flag${label}. See heimdall setup --help`);
    }
    if (seen.has(name)) throw new UsageError(`Repeated flag ${name}`);
    seen.add(name);
    if (SWITCHES.has(name)) {
      if (inline !== undefined) throw new UsageError(`${name} does not take a value`);
      if (name === '--json') json = true; else noInput = true;
      continue;
    }
    let value = inline;
    if (value === undefined) {
      value = args[index + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${name} requires a value`);
      index += 1;
    }
    if (!value) throw new UsageError(`${name} requires a value`);
    if (name in NUMBER_FLAGS) {
      if (!/^[0-9]{1,15}$/.test(value)) throw new UsageError(`${name} must be a positive whole number`);
      input[NUMBER_FLAGS[name]!] = Number(value);
    } else input[TEXT_FLAGS[name]!] = value;
  }
  return { input: input as SetupInput, noInput, json, help };
}

const SECRET_NAME = /pass|token|secret|credential|api_?key/i;

/** Builds a redactor for diagnostics: environment credential values, URL user information and Authorization-style values. */
function createRedactor(environment: NodeJS.ProcessEnv, args: readonly string[]): (text: string) => string {
  const secrets = new Set<string>();
  for (const [name, value] of Object.entries(environment)) if (value && value.length >= 4 && SECRET_NAME.test(name)) secrets.add(value);
  const indexOfPasswordName = args.indexOf('--password-env');
  const passwordName = indexOfPasswordName === -1 ? undefined : args[indexOfPasswordName + 1];
  if (passwordName !== undefined) {
    const referenced = environment[passwordName];
    if (referenced && referenced.length >= 4) secrets.add(referenced);
    // A value that is not a variable name may be a pasted credential.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(passwordName) && passwordName.length >= 3) secrets.add(passwordName);
  }
  for (const argument of args) {
    const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)@/i.exec(argument.includes('=') && argument.startsWith('--') ? argument.slice(argument.indexOf('=') + 1) : argument);
    if (match?.[1]) { secrets.add(match[1]); for (const part of match[1].split(':')) if (part.length >= 3) secrets.add(part); }
  }
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  return text => {
    let result = text;
    for (const secret of ordered) result = result.split(secret).join('[redacted]');
    return result
      .replace(/(:\/\/)[^/?#\s@]*@/g, '$1[redacted]@')
      .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [redacted]');
  };
}

function redactResult(result: SetupResult, redact: (text: string) => string): SetupResult {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, walk(entry)]));
    return value;
  };
  return walk(result) as SetupResult;
}

function failureResult(code: 'invalid-input' | 'unexpected', message: string): SetupResult {
  return {
    schemaVersion: 1, ok: false, projectDirectory: null,
    targets: { coordinator: { path: null, outcome: 'not-written' }, project: { path: null, outcome: 'not-written' } },
    createdDirectories: [], verification: { level: 'none', unverified: [...UNVERIFIED_BY_SETUP] },
    error: { code, message, missing: [] }, partial: null, warnings: [],
  };
}

const outcomeWord = (outcome: string): string => outcome === 'created' ? 'created' : outcome === 'reused' ? 'reused (unchanged)' : outcome;

function humanSummary(result: SetupResult): string {
  const created = result.targets.coordinator.outcome === 'created' || result.targets.project.outcome === 'created';
  return [
    created ? 'Heimdall setup complete.' : 'Heimdall setup found existing configuration; nothing was changed.',
    `Project: ${result.projectDirectory}`,
    `Coordinator configuration: ${result.targets.coordinator.path} (${outcomeWord(result.targets.coordinator.outcome)})`,
    `Project configuration: ${result.targets.project.path} (${outcomeWord(result.targets.project.outcome)})`,
    ...(result.createdDirectories.length ? [`Created directories: ${result.createdDirectories.join(', ')}`] : []),
    'Verification: configuration validated only. The OpenCode connection, model availability, provider login and quota are unverified.',
    'Run `heimdall doctor --connect` to check the connection.',
    '',
  ].join('\n');
}

function humanDiagnostics(result: SetupResult): string {
  const lines = [`Heimdall setup failed (${result.error!.code}): ${result.error!.message}`];
  if (result.error!.code === 'missing-input') lines.push('Supply the flags above, or run in an interactive terminal without --no-input or --json. See heimdall setup --help');
  if (result.partial) {
    lines.push(`Partial outcome: created ${result.partial.created.join(', ')}; incomplete ${result.partial.incomplete.join(', ')}. Rerun the same command to finish.`);
  }
  for (const warning of result.warnings) lines.push(`Warning: ${warning}`);
  lines.push('');
  return lines.join('\n');
}

/** Runs `heimdall setup` and returns the process exit status. Never throws. */
export async function setupMain(args: readonly string[], options: SetupCommandOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const environment = options.environment ?? process.env;
  const redact = createRedactor(environment, args);
  const jsonRequested = args.includes('--json');
  const emit = (result: SetupResult): number => {
    const safe = redactResult(result, redact);
    if (jsonRequested) stdout.write(JSON.stringify(safe, null, 2) + '\n');
    else if (safe.ok) { stdout.write(humanSummary(safe)); if (safe.warnings.length) stderr.write(safe.warnings.map(warning => `Warning: ${warning}\n`).join('')); }
    else stderr.write(humanDiagnostics(safe));
    return safe.ok ? 0 : 1;
  };
  if (args.includes('--help')) { stdout.write(setupHelp); return 0; }
  let parsed: ParsedSetupArguments;
  try { parsed = parseSetupArguments(args); }
  catch (error) { return emit(failureResult('invalid-input', error instanceof UsageError ? error.message : 'Invalid setup arguments')); }

  try {
    const interactive = !parsed.noInput && !parsed.json && Boolean((options.stdin ?? process.stdin).isTTY) && Boolean(stdout.isTTY) && options.prompt !== undefined;
    let input = parsed.input;
    if (interactive) {
      const completed = await options.prompt!({ input, environment });
      if (completed === null) {
        stderr.write('Heimdall setup cancelled; no configuration was written.\n');
        return 1;
      }
      input = completed;
    }
    const result = await runSetup(input, {
      environment,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
      ...(options.operations === undefined ? {} : { operations: options.operations }),
    });
    return emit(result);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return emit(failureResult('unexpected', `Setup failed unexpectedly (${code ?? (error instanceof Error ? error.name : 'error')}); no configuration was written`));
  }
}
