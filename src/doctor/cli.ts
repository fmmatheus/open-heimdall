import { createRedactor } from '../setup/cli.js';
import { connectionNotRequested, verifyConnection, type ConnectionResult } from './connection.js';
import { runLocalChecks, type DoctorCheck, type DoctorInput, type DoctorOptions, type DoctorReport, type DoctorTargets, type DoctorVerification } from './checks.js';

/*
 * `heimdall doctor` command line front end over the offline local checks (checks.ts) and the optional connection check (connection.ts).
 *
 * Output contract
 * ---------------
 * Human mode (default): the per-check report goes to stdout. Diagnostics (argument errors and the list of failed
 * required checks) go to stderr.
 *
 * `--json`: stdout carries exactly one JSON document followed by a newline, including for argument errors. stderr stays
 * empty. `--help` prints the help text and ignores every other argument, including `--json`.
 *
 * JSON document, schemaVersion 1:
 *   schemaVersion  1
 *   ok             true unless a required (fatal) check failed or the arguments were invalid
 *   targets        { projectDirectory, projectConfig, coordinatorConfig, stateDirectory }, each a string or null
 *   checks         [{ id, status, fatal, message }]
 *                  status: "pass" | "fail" | "warn" | "not-verified" | "skipped"
 *                  fatal: true for a required check (only a "fail" status on it makes ok false), false for advisory checks
 *   verification   { local: "passed" | "failed" (from the local checks only; a failed connection check does not change it),
 *                    connection: "not-requested" | "verified" | "failed",
 *                    protectedApiAuthorization, modelAvailability, providerLogin, quota: always "unverified" }
 *   error          null, or { code: "invalid-input" | "unexpected", message } when no checks could run
 * Every string is redacted: credential values taken from the environment, URL user information and
 * Authorization-style values never appear.
 *
 * The connection check is advisory and "not-verified" unless --connect is passed; then it is required: it passes when
 * GET /api/info answers with the supported version, a positive pid and the selected authentication, and fails otherwise.
 *
 * Exit status: 0 when ok is true (warnings and unverified items do not change it); 1 when a required check
 * failed (including a requested connection check) or the arguments were invalid.
 */

export const doctorHelp = `Run offline, read-only diagnostics

Usage:
  heimdall doctor [flags]

Checks the local installation without changing anything: the Node.js minimum, Git and the Git project with a
commit, the installed runtime files and dependencies, the project and coordinator configuration and whether setup
is complete, and the configured paths. A state directory that does not exist yet is not a failure. Permission
findings are advisory. Doctor never creates files, changes permissions, starts the coordinator or repairs
configuration. By default it makes no network request. With --connect it sends one GET /api/info request to the
loopback OpenCode URL from the project configuration, with the configured authentication source, and nothing else.

Flags:
  --project DIRECTORY             Git project to inspect (default: the current Git project)
  --config FILE                   project configuration (default: $HEIMDALL_CONFIG, else .heimdall.toml in the project)
  --coordinator-config FILE       coordinator configuration (default: $HEIMDALL_COORDINATOR_CONFIG,
                                  else ~/.config/heimdall/coordinator.toml)
  --connect                       also verify the configured OpenCode endpoint (GET /api/info, 10 s limit)
  --json                          print one JSON document on stdout (schemaVersion 1)
  --help                          show this help

A successful connection check verifies the endpoint, the supported OpenCode version and the selected
authentication source. Doctor never verifies authorization to protected APIs, model availability, provider login
or quota, and neither local checks nor the connection check show that a run can execute.

Exit status is 0 when no required check failed and 1 otherwise; a requested connection check that fails is
required. Warnings and unverified items do not change it. The report goes to stdout; diagnostics go to stderr. With --json, stdout is a single document with
fields schemaVersion, ok, targets, checks, verification and error.
`;

class UsageError extends Error {
  constructor(message: string) { super(message); this.name = 'UsageError'; }
}

const TEXT_FLAGS: Record<string, keyof DoctorInput> = { '--project': 'projectDirectory', '--config': 'configPath', '--coordinator-config': 'coordinatorConfigPath' };
const SWITCHES = new Set(['--json', '--connect']);
const CREDENTIAL_FLAG = /pass|token|secret|credential|authoriz|api-?key|bearer/i;

export interface ParsedDoctorArguments { input: DoctorInput; json: boolean; help: boolean }

/** Never echoes a value; a flag is named only when it looks like a plain flag name. */
export function parseDoctorArguments(args: readonly string[]): ParsedDoctorArguments {
  const input: DoctorInput = {};
  const seen = new Set<string>();
  let json = false;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!argument.startsWith('--')) throw new UsageError('Unexpected argument; doctor takes flags only. See heimdall doctor --help');
    const equals = argument.indexOf('=');
    const name = equals === -1 ? argument : argument.slice(0, equals);
    const inline = equals === -1 ? undefined : argument.slice(equals + 1);
    if (name === '--help') { help = true; continue; }
    if (!(name in TEXT_FLAGS) && !SWITCHES.has(name)) {
      const label = /^--[A-Za-z][A-Za-z0-9-]{0,40}$/.test(name) ? ` ${name}` : '';
      if (CREDENTIAL_FLAG.test(name)) throw new UsageError(`Credentials are never accepted as flags${label}. Authentication comes from the project configuration`);
      throw new UsageError(`Unknown flag${label}. See heimdall doctor --help`);
    }
    if (seen.has(name)) throw new UsageError(`Repeated flag ${name}`);
    seen.add(name);
    if (SWITCHES.has(name)) {
      if (inline !== undefined) throw new UsageError(`${name} does not take a value`);
      if (name === '--json') json = true; else input.connect = true;
      continue;
    }
    let value = inline;
    if (value === undefined) {
      value = args[index + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${name} requires a value`);
      index += 1;
    }
    if (!value) throw new UsageError(`${name} requires a value`);
    (input as Record<string, string>)[TEXT_FLAGS[name]!] = value;
  }
  return { input, json, help };
}

interface Writable { write(text: string): unknown }

export interface DoctorCommandOptions extends DoctorOptions {
  stdout?: Writable;
  stderr?: Writable;
}

const NO_TARGETS: DoctorTargets = { projectDirectory: null, projectConfig: null, coordinatorConfig: null, stateDirectory: null };

const requiredFailed = (check: DoctorCheck): boolean => check.fatal && check.status === 'fail';

function verificationFor(local: boolean, connection: DoctorVerification['connection']): DoctorVerification {
  return { local: local ? 'passed' : 'failed', connection, protectedApiAuthorization: 'unverified', modelAvailability: 'unverified', providerLogin: 'unverified', quota: 'unverified' };
}

/** The local verdict comes from the local checks only; `ok` also requires a requested connection check to pass. */
function buildReport(checks: DoctorCheck[], targets: DoctorTargets, connection: ConnectionResult, connect: boolean): DoctorReport {
  const local = !checks.some(requiredFailed);
  const all = [...checks, connection.check];
  const ok = !all.some(requiredFailed);
  const verification = verificationFor(local, connect ? (connection.verified ? 'verified' : 'failed') : 'not-requested');
  return { schemaVersion: 1, ok, targets, checks: all, verification, error: null };
}

function failureReport(code: 'invalid-input' | 'unexpected', message: string, connect: boolean): DoctorReport {
  return { schemaVersion: 1, ok: false, targets: { ...NO_TARGETS }, checks: [], verification: verificationFor(false, connect ? 'failed' : 'not-requested'), error: { code, message } };
}

function redactReport(report: DoctorReport, redact: (text: string) => string): DoctorReport {
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') return redact(value);
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, walk(entry)]));
    return value;
  };
  return walk(report) as DoctorReport;
}

function humanReport(report: DoctorReport): string {
  const lines = ['Heimdall doctor (read-only checks)'];
  const { targets } = report;
  if (targets.projectDirectory) lines.push(`Project: ${targets.projectDirectory}`);
  if (targets.projectConfig) lines.push(`Project configuration: ${targets.projectConfig}`);
  if (targets.coordinatorConfig) lines.push(`Coordinator configuration: ${targets.coordinatorConfig}`);
  if (targets.stateDirectory) lines.push(`Coordinator state directory: ${targets.stateDirectory}`);
  lines.push('');
  for (const check of report.checks) lines.push(`[${check.status}] ${check.id}${check.fatal ? '' : ' (advisory)'}: ${check.message}`);
  // The connection check has its own line below; the local summary counts the local checks only.
  const localChecks = report.checks.filter(check => check.id !== 'connection');
  const counts = (status: string): number => localChecks.filter(check => check.status === status).length;
  const failed = localChecks.filter(requiredFailed).length;
  lines.push('', report.verification.local === 'passed'
    ? `Local checks passed (${counts('pass')} passed, ${counts('warn')} warnings, ${counts('skipped')} skipped).`
    : `Local checks failed: ${failed} required check${failed === 1 ? '' : 's'} failed.`);
  lines.push({
    'not-requested': 'Connection verification: not requested (use --connect).',
    verified: 'Connection verification: verified (GET /api/info with the selected authentication source only).',
    failed: 'Connection verification: failed.',
  }[report.verification.connection]);
  lines.push('Unverified: protected-API authorization, model availability, provider login and quota. Passing local checks does not show that a run can execute.', '');
  return lines.join('\n');
}

/** Runs `heimdall doctor` and returns the process exit status. Never throws. */
export async function doctorMain(args: readonly string[], options: DoctorCommandOptions = {}): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const environment = options.environment ?? process.env;
  const redact = createRedactor(environment, args);
  const jsonRequested = args.includes('--json');
  const connectRequested = args.includes('--connect');
  const emit = (report: DoctorReport): number => {
    const safe = redactReport(report, redact);
    if (jsonRequested) stdout.write(JSON.stringify(safe, null, 2) + '\n');
    else if (safe.error) stderr.write(`Heimdall doctor: ${safe.error.message}\n`);
    else {
      stdout.write(humanReport(safe));
      const failed = safe.checks.filter(requiredFailed).map(check => check.id);
      if (failed.length) stderr.write(`Heimdall doctor: required check${failed.length === 1 ? '' : 's'} failed: ${failed.join(', ')}\n`);
    }
    return safe.ok ? 0 : 1;
  };
  if (args.includes('--help')) { stdout.write(doctorHelp); return 0; }
  let parsed: ParsedDoctorArguments;
  try { parsed = parseDoctorArguments(args); }
  catch (error) { return emit(failureReport('invalid-input', error instanceof UsageError ? error.message : 'Invalid doctor arguments', connectRequested)); }
  try {
    const { checks, targets, projectDirectory, configuration } = await runLocalChecks(parsed.input, {
      environment,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.homeDirectory === undefined ? {} : { homeDirectory: options.homeDirectory }),
      ...(options.packageRoot === undefined ? {} : { packageRoot: options.packageRoot }),
      ...(options.nodeVersion === undefined ? {} : { nodeVersion: options.nodeVersion }),
    });
    const connect = parsed.input.connect === true;
    const connection = connect
      ? await verifyConnection({ configuration, projectDirectory, environment, ...(options.connection === undefined ? {} : { connection: options.connection }) })
      : connectionNotRequested();
    return emit(buildReport(checks, targets, connection, connect));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return emit(failureReport('unexpected', `Doctor failed unexpectedly (${code ?? (error instanceof Error ? error.name : 'error')})`, connectRequested));
  }
}
