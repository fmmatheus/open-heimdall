#!/usr/bin/env node
// OpenHeimdall skill helper.
//
// A dependency-free wrapper around the installed `heimdall coordinator` command line. It gathers repository
// and coordinator context, selects a run and reports compact state. `context`, `snapshot`, `watch`, `request` and
// `inspect-spec` only read. `start`, `resume` and `respond` are the only commands that mutate, each at most once per
// invocation: they never retry, reconcile, stop or restart anything, and an unconfirmed outcome is reported as
// uncertain instead of being repeated. Reports of a run include its bounded wait: the typed approval request the
// agent is waiting on, or the identity of a generic pause. A compact wait is shortened when a text or list is cut, and
// says so; `request` then reads the complete request through `run approval`. Guidance reaches a run only through the guarded response for
// the identity of that pause; without it the helper refuses and sends nothing.
//
// The command line is invoked without a shell: `execFile` with an argument array, using the binary named by
// HEIMDALL_BIN or `heimdall` on PATH. Every option value is data, so paths may contain spaces, quotes or a
// leading dash.
//
//   openheimdall.mjs context  [--base REF]
//   openheimdall.mjs snapshot [RUN_ID]
//   openheimdall.mjs watch    [RUN_ID] [--budget-seconds N] [--interval-seconds N]
//   openheimdall.mjs request  RUN_ID --request ID
//   openheimdall.mjs inspect-spec FILE
//   openheimdall.mjs start    --spec FILE [--base REF] [--register] [--start-coordinator]
//   openheimdall.mjs resume   RUN_ID (--guidance-file FILE | --guidance-stdin)
//   openheimdall.mjs respond  RUN_ID --request ID --decision approve
//   openheimdall.mjs respond  RUN_ID --request ID --decision request-changes (--feedback-file FILE | --feedback-stdin)
//   openheimdall.mjs respond  RUN_ID --pause ID (--guidance-file FILE | --guidance-stdin)
//
// Common options: --cwd DIR (default: the current directory), --coordinator-config FILE (resolved against --cwd
// and forwarded to every coordinator call). Reports are JSON on stdout. `watch` prints one JSON line per change.
// Exit status: 0 for a report (for `start`, `resume` and `respond`: the coordinator accepted the request), 1 when the
// coordinator or transport failed or the request was not accepted, 2 for a usage error.

import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_WATCH_BUDGET_SECONDS = 600;
export const DEFAULT_WATCH_INTERVAL_SECONDS = 15;
export const MAX_WATCH_BUDGET_SECONDS = 3600;
export const MIN_WATCH_INTERVAL_SECONDS = 0.1;
export const MAX_WATCH_INTERVAL_SECONDS = 300;
export const ACTIVE_STATUSES = Object.freeze(['queued', 'preparing', 'running', 'paused', 'reconciliation-required']);
export const TERMINAL_STATUSES = Object.freeze(['succeeded', 'failed', 'reconciliation-required']);

export const BLOCKER_LIMIT = 1500;
const COMMAND_TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MANAGED_BRANCH = /^heimdall\/run\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/;
const COMMIT = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

export const MAX_SPEC_BYTES = 128 * 1024;
// Guidance travels as one command-line argument; stay well below the per-argument limits of common systems.
export const MAX_GUIDANCE_BYTES = 64 * 1024;
// The longest feedback or guidance the coordinator accepts for a response, in characters.
export const RESPONSE_INPUT_LIMIT = 8000;
// Bounds for the wait a report shows. The coordinator bounds its own projection; these hold whatever it sends.
export const WAIT_QUESTION_LIMIT = 1500;
export const WAIT_TEXT_LIMIT = 1000;
export const WAIT_LIST_LIMIT = 10;
export const WAIT_ENTRY_LIMIT = 300;
// The limits of a complete approval request, as the coordinator accepts it: characters per text and per list entry,
// entries per list, and bytes of the whole request as JSON.
export const REQUEST_TEXT_LIMIT = 4000;
export const REQUEST_LIST_LIMIT = 20;
export const REQUEST_PAYLOAD_LIMIT = 32 * 1024;
const MUTATION_TIMEOUT_MS = 60000;
const COORDINATOR_START_TIMEOUT_MS = 150000;
const START_SUCCESS_OUTCOMES = Object.freeze(['ready', 'already-running', 'already-running-foreground']);
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

const COMMANDS = {
  context: { options: ['--base'], positional: 0 },
  snapshot: { options: [], positional: 1 },
  watch: { options: ['--budget-seconds', '--interval-seconds'], positional: 1 },
  request: { options: ['--request'], positional: 1 },
  'inspect-spec': { options: [], positional: 1 },
  start: { options: ['--spec', '--base'], flags: ['--register', '--start-coordinator'], positional: 0 },
  resume: { options: ['--guidance-file'], flags: ['--guidance-stdin'], positional: 1 },
  respond: { options: ['--request', '--decision', '--pause', '--feedback-file', '--guidance-file'], flags: ['--feedback-stdin', '--guidance-stdin'], positional: 1 },
};
const COMMON_OPTIONS = ['--cwd', '--coordinator-config'];

export const HELP = `OpenHeimdall helper

Usage:
  openheimdall.mjs context  [--base REF]
  openheimdall.mjs snapshot [RUN_ID]
  openheimdall.mjs watch    [RUN_ID] [--budget-seconds N] [--interval-seconds N]
  openheimdall.mjs request  RUN_ID --request ID
  openheimdall.mjs inspect-spec FILE
  openheimdall.mjs start    --spec FILE [--base REF] [--register] [--start-coordinator]
  openheimdall.mjs resume   RUN_ID (--guidance-file FILE | --guidance-stdin)
  openheimdall.mjs respond  RUN_ID --request ID --decision approve
  openheimdall.mjs respond  RUN_ID --request ID --decision request-changes (--feedback-file FILE | --feedback-stdin)
  openheimdall.mjs respond  RUN_ID --pause ID (--guidance-file FILE | --guidance-stdin)

Common options: --cwd DIR, --coordinator-config FILE
context, snapshot, watch, request and inspect-spec only read. request prints the complete approval request that a shortened
wait cannot show. start, resume and respond change coordinator state, at most once each.
respond carries only an explicit owner decision for the displayed request, or explicit guidance for the displayed pause.
`;

export class UsageError extends Error {}

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Collapse control characters and bound the length so coordinator text cannot flood a report. */
export function limitText(value, limit) {
  const text = String(value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
}

/** Split argv into a command, options and positionals. Option values are always taken verbatim. */
export function parseArguments(argv) {
  const [command, ...rest] = argv;
  if (command === undefined || command === '--help' || command === '-h' || command === 'help') return { command: 'help', options: {}, positional: [] };
  const spec = COMMANDS[command];
  if (!spec) throw new UsageError(`Unknown command: ${command}`);
  const allowed = new Set([...COMMON_OPTIONS, ...spec.options]);
  const flags = new Set(spec.flags ?? []);
  const options = {};
  const positional = [];
  let optionsEnded = false;
  for (let index = 0; index < rest.length; index++) {
    const token = rest[index];
    if (optionsEnded || !token.startsWith('--')) { positional.push(token); continue; }
    if (token === '--') { optionsEnded = true; continue; }
    if (token === '--help') return { command: 'help', options: {}, positional: [] };
    const equals = token.indexOf('=');
    const name = equals === -1 ? token : token.slice(0, equals);
    if (!allowed.has(name) && !flags.has(name)) throw new UsageError(`Unknown option for ${command}: ${name}`);
    if (Object.hasOwn(options, name)) throw new UsageError(`Repeated option: ${name}`);
    if (flags.has(name)) {
      if (equals !== -1) throw new UsageError(`${name} does not take a value`);
      options[name] = true;
      continue;
    }
    let value;
    if (equals !== -1) value = token.slice(equals + 1);
    else if (index + 1 < rest.length) value = rest[++index];
    if (value === undefined || value === '') throw new UsageError(`${name} requires a value`);
    options[name] = value;
  }
  if (positional.length > spec.positional) throw new UsageError(`Unexpected argument for ${command}: ${positional[spec.positional]}`);
  return { command, options, positional };
}

function secondsOption(options, name, fallback, minimum, maximum) {
  if (options[name] === undefined) return fallback;
  const value = Number(options[name]);
  if (!Number.isFinite(value) || value < minimum || value > maximum) throw new UsageError(`${name} must be a number from ${minimum} to ${maximum}`);
  return value;
}

/** Validate watch timing. The budget and interval are always finite. */
export function watchTiming(options) {
  const budgetSeconds = secondsOption(options, '--budget-seconds', DEFAULT_WATCH_BUDGET_SECONDS, MIN_WATCH_INTERVAL_SECONDS, MAX_WATCH_BUDGET_SECONDS);
  const intervalSeconds = secondsOption(options, '--interval-seconds', DEFAULT_WATCH_INTERVAL_SECONDS, MIN_WATCH_INTERVAL_SECONDS, MAX_WATCH_INTERVAL_SECONDS);
  return { budgetSeconds, intervalSeconds };
}

export function validRunId(value) {
  return typeof value === 'string' && RUN_ID.test(value);
}

// --- Processes ---------------------------------------------------------------------------------------------

function run(file, args, { env, signal, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  return new Promise(resolve => {
    execFile(file, args, { env, signal, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
      if (!error) { resolve({ ok: true, stdout, stderr }); return; }
      let kind = 'error';
      if (error.code === 'ENOENT') kind = 'not-installed';
      else if (error.name === 'AbortError' || error.code === 'ABORT_ERR') kind = 'aborted';
      else if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') kind = 'response-too-large';
      else if (error.killed) kind = 'timeout';
      resolve({ ok: false, kind, exitCode: typeof error.code === 'number' ? error.code : null, stdout: stdout ?? '', stderr: stderr ?? '', message: String(error.message) });
    });
  });
}

/** Classify a failed coordinator command from its diagnostic. The command line does not print HTTP status codes. */
export function classifyCliFailure(result) {
  if (result.kind !== 'error') return result.kind;
  const text = `${result.stderr}\n${result.message}`;
  if (/Coordinator response is too large/i.test(text)) return 'response-too-large';
  if (/Coordinator unavailable/i.test(text)) return 'unavailable';
  if (/Run not found/i.test(text)) return 'not-found';
  if (/Invalid coordinator JSON/i.test(text)) return 'invalid-response';
  return 'error';
}

function failure(result) {
  const kind = classifyCliFailure(result);
  const detail = result.kind === 'error' ? result.stderr.replace(/^Heimdall:\s*/, '') || result.message : result.message;
  return { ok: false, kind, message: limitText(detail, 300) };
}

function createCoordinator({ env, configFile, signal }) {
  const binary = env.HEIMDALL_BIN || 'heimdall';
  const execute = (args, timeoutMs) => run(binary, ['coordinator', ...args, ...(configFile ? ['--coordinator-config', configFile] : [])], { env, signal, timeoutMs });
  return {
    binary,
    /** Run one coordinator subcommand and return the process result unparsed. Mutations use this to classify failures themselves. */
    raw: (args, { timeoutMs } = {}) => execute(args, timeoutMs),
    /** Run one coordinator subcommand; arguments are an array, never a shell string. */
    async call(args, { json = true, timeoutMs } = {}) {
      const result = await execute(args, timeoutMs);
      if (!result.ok) return failure(result);
      if (!json) return { ok: true, value: result.stdout };
      try { return { ok: true, value: JSON.parse(result.stdout) }; }
      catch { return { ok: false, kind: 'invalid-response', message: 'Coordinator output is not JSON' }; }
    },
  };
}

const GIT_REDIRECTING_VARIABLES = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE', 'GIT_CONFIG', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
];

/**
 * The environment for a Git subprocess. Ambient overrides such as GIT_DIR or GIT_WORK_TREE take precedence over
 * `git -C`, so inherited ones would make the helper inspect a different repository than the selected directory.
 * Returns a new object; the supplied environment is not modified. Other variables, including GIT_CONFIG_GLOBAL and
 * GIT_CONFIG_NOSYSTEM, are kept.
 */
export function gitEnvironment(env) {
  const result = { ...env, GIT_OPTIONAL_LOCKS: '0' };
  for (const name of Object.keys(result)) {
    if (GIT_REDIRECTING_VARIABLES.includes(name) || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name)) delete result[name];
  }
  return result;
}

function git(directory, args, env) {
  return run('git', ['-C', directory, ...args], { env: gitEnvironment(env) });
}

const firstLine = text => text.replace(/\r?\n[\s\S]*$/, '');

// --- Configuration -----------------------------------------------------------------------------------------

/** Which coordinator configuration the calls use, mirroring the command line's own precedence. */
export function configurationSelection({ configFile, env, homeDirectory = env.HOME || env.USERPROFILE || os.homedir() }) {
  if (configFile) return { source: 'flag', file: configFile };
  if (env.HEIMDALL_COORDINATOR_CONFIG) return { source: 'environment', file: path.resolve(env.HEIMDALL_COORDINATOR_CONFIG) };
  return { source: 'default', file: path.join(homeDirectory, '.config', 'heimdall', 'coordinator.toml') };
}

// --- Repository --------------------------------------------------------------------------------------------

async function canonical(value) {
  try { return await fs.realpath(value); } catch { return value; }
}

/** Parse `git status --porcelain=v1 -z` into counts. */
export function countStatus(output) {
  const fields = output.split('\0');
  let tracked = 0;
  let untracked = 0;
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (field.length < 3) continue;
    if (field.startsWith('??')) untracked++;
    else if (field.startsWith('!!')) continue;
    else {
      tracked++;
      if (field[0] === 'R' || field[0] === 'C') index++;
    }
  }
  return { tracked, untracked };
}

export async function inspectRepository(cwd, env) {
  const top = await git(cwd, ['rev-parse', '--path-format=absolute', '--show-toplevel'], env);
  if (!top.ok) return top.kind === 'not-installed' ? { ok: false, kind: 'git-missing' } : { ok: false, kind: 'not-a-repository' };
  const common = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], env);
  if (!common.ok) return { ok: false, kind: 'not-a-repository' };
  const topLevel = await canonical(firstLine(top.stdout));
  const branch = await git(topLevel, ['symbolic-ref', '--quiet', '--short', 'HEAD'], env);
  const head = await git(topLevel, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], env);
  const status = await git(topLevel, ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], env);
  return {
    ok: true,
    topLevel,
    commonGitDirectory: await canonical(firstLine(common.stdout)),
    branch: branch.ok ? firstLine(branch.stdout) : null,
    head: head.ok && COMMIT.test(firstLine(head.stdout)) ? firstLine(head.stdout) : null,
    changes: status.ok ? countStatus(status.stdout) : null,
  };
}

/**
 * The directory a new project should be registered under: the main worktree of the repository. A linked worktree is
 * disposable, so it is never registered. The main worktree is derived from the common Git directory (`<main>/.git`);
 * a bare, separate or submodule Git directory has no derivable main worktree and yields null.
 */
export async function registrationDirectory(repository) {
  if (repository.commonGitDirectory === path.join(repository.topLevel, '.git')) return repository.topLevel;
  if (path.basename(repository.commonGitDirectory) !== '.git') return null;
  const main = path.dirname(repository.commonGitDirectory);
  try {
    return (await fs.stat(main)).isDirectory() ? await canonical(main) : null;
  } catch {
    return null;
  }
}

/** Resolve REF to a full commit ID inside one worktree. HEAD differs between linked worktrees of a repository. */
export async function resolveBase(directory, ref, env) {
  if (typeof ref !== 'string' || !ref.trim() || ref.includes('\0')) return { ok: false, message: 'Provide a Git base revision' };
  const result = await git(directory, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`], env);
  const oid = result.ok ? firstLine(result.stdout) : '';
  if (!COMMIT.test(oid)) return { ok: false, message: `Revision ${limitText(ref, 100)} does not resolve to a commit` };
  return { ok: true, oid };
}

/** Match a repository against registered projects by canonical common Git directory. */
export function matchProjects(projects, commonGitDirectory, canonicalDirectories = new Map()) {
  const candidates = projects.filter(project => isObject(project) && typeof project.commonGitDirectory === 'string'
    && (canonicalDirectories.get(project.commonGitDirectory) ?? project.commonGitDirectory) === commonGitDirectory);
  const compact = candidates.map(project => ({ id: String(project.id), directory: String(project.directory), commonGitDirectory: project.commonGitDirectory, concurrency: project.concurrency }));
  return { match: candidates.length === 0 ? 'none' : candidates.length === 1 ? 'one' : 'many', projects: compact };
}

async function findProjects(coordinator, commonGitDirectory) {
  const listed = await coordinator.call(['project', 'list']);
  if (!listed.ok) return { ok: false, error: { kind: listed.kind, message: listed.message } };
  if (!Array.isArray(listed.value)) return { ok: false, error: { kind: 'invalid-response', message: 'Project list is not an array' } };
  const canonicalDirectories = new Map();
  for (const project of listed.value) {
    if (isObject(project) && typeof project.commonGitDirectory === 'string') canonicalDirectories.set(project.commonGitDirectory, await canonical(project.commonGitDirectory));
  }
  return { ok: true, ...matchProjects(listed.value, commonGitDirectory, canonicalDirectories) };
}

export function projectCoordinatorStatus(value) {
  if (!isObject(value) || (value.status !== 'running' && value.status !== 'draining') || typeof value.acceptingNewRuns !== 'boolean') return null;
  return { readiness: value.status, acceptingNewRuns: value.acceptingNewRuns, queuedRuns: value.queuedRuns, reservedRuns: value.reservedRuns };
}

// --- Run selection -----------------------------------------------------------------------------------------

/**
 * Normalize `run list` output. The command line prints a bare array; a bounded page is `{ runs, total, nextCursor }`.
 * Either may be incomplete, so the result says how far it can be trusted.
 */
export function parseRunList(value) {
  if (Array.isArray(value)) return { runs: value.filter(isObject), completeness: 'unverified' };
  if (isObject(value) && Array.isArray(value.runs)) {
    const runs = value.runs.filter(isObject);
    const complete = (value.nextCursor === null || value.nextCursor === undefined) && (typeof value.total !== 'number' || value.total === runs.length);
    return { runs, completeness: complete ? 'complete' : 'incomplete' };
  }
  throw new Error('Run list has an unknown shape');
}

const compactRun = run => ({ id: String(run.id), status: String(run.status), updatedAt: typeof run.updatedAt === 'number' ? run.updatedAt : null });

/** Choose the sole active run of a project from a run list. Anything else needs an explicit run ID. */
export function chooseActiveRun(list, projectId) {
  const parsed = parseRunList(list);
  const active = parsed.runs.filter(entry => entry.projectId === projectId && typeof entry.id === 'string' && validRunId(entry.id) && ACTIVE_STATUSES.includes(entry.status));
  const candidates = active.slice(0, 10).map(compactRun);
  if (parsed.completeness === 'incomplete') return { outcome: 'needs-run-id', reason: 'run-list-incomplete', completeness: parsed.completeness, candidates };
  if (active.length === 0) return { outcome: 'none', completeness: parsed.completeness, candidates };
  if (active.length > 1) return { outcome: 'needs-run-id', reason: 'multiple-active-runs', completeness: parsed.completeness, candidates };
  return { outcome: 'selected', runId: active[0].id, completeness: parsed.completeness, candidates };
}

// --- Run projection ----------------------------------------------------------------------------------------

const STATE_CLASSES = {
  queued: 'queued',
  preparing: 'admitted',
  running: 'executing',
  paused: 'paused',
  succeeded: 'succeeded',
  failed: 'failed',
  'reconciliation-required': 'reconciliation-required',
};

export const EVIDENCE_LIMITS = Object.freeze([
  'capacityReserved only means the coordinator holds a run slot; it is not proof that an agent is active right now.',
  'A quiet run is not necessarily stalled: updatedAt changes only when the coordinator records a change.',
  'This report comes from one read of the run record and is not corroborated by events or the agent session.',
  'reconciliation-required means the outcome is uncertain and needs the owner; it is neither success nor failure.',
]);

const timestamp = value => (typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString() : null);

const WAIT_STATES = Object.freeze(['pending', 'answered', 'superseded']);
const WAIT_CONTINUATIONS = Object.freeze(['none', 'pending', 'queued', 'consumed', 'superseded']);
const WAIT_PROGRESS = Object.freeze(['none', 'recorded', 'waiting-for-idle', 'queued', 'executing', 'consumed', 'superseded']);
const WAIT_DECISIONS = Object.freeze(['approve', 'request-changes']);
const waitText = (value, limit) => (typeof value === 'string' ? limitText(value, limit) : null);
const waitList = value => (Array.isArray(value) ? value.filter(entry => typeof entry === 'string').slice(0, WAIT_LIST_LIMIT).map(entry => limitText(entry, WAIT_ENTRY_LIMIT)) : []);
// Whether the helper shortens a text or a list when it builds a compact wait. Whitespace collapsing alone is not shortening.
const textCut = (value, limit) => typeof value === 'string' && limitText(value, Number.MAX_SAFE_INTEGER).length > limit;
const listCut = value => Array.isArray(value) && (value.length > WAIT_LIST_LIMIT || value.some(entry => typeof entry !== 'string' || textCut(entry, WAIT_ENTRY_LIMIT)));
const oneOf = (value, allowed) => (typeof value === 'string' && allowed.includes(value) ? value : null);

/**
 * The bounded wait of a run record: the typed approval request it is waiting on, or the identity of a generic pause,
 * else null. Text is shortened and lists are capped, however much the coordinator sent. Feedback the owner gave is not
 * copied: only the decision is. A shape this helper does not know is reported as unrecognized, never guessed at.
 */
export function projectWait(value) {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) return { kind: 'unrecognized' };
  if (value.kind === 'generic') {
    if (typeof value.pauseId !== 'string' || !RUN_ID.test(value.pauseId)) return { kind: 'unrecognized' };
    return { kind: 'generic', pauseId: value.pauseId, reasonClipped: value.reasonClipped === true };
  }
  if (value.kind !== 'approval') return { kind: 'unrecognized' };
  const state = oneOf(value.state, WAIT_STATES);
  if (typeof value.requestId !== 'string' || !RUN_ID.test(value.requestId) || state === null) return { kind: 'unrecognized' };
  const response = isObject(value.response) && oneOf(value.response.decision, WAIT_DECISIONS)
    ? { decision: value.response.decision, answeredAt: timestamp(value.response.answeredAt), feedbackRecorded: typeof value.response.feedback === 'string' && value.response.feedback.length > 0 }
    : null;
  const revision = isObject(value.revision) && typeof value.revision.head === 'string' && typeof value.revision.digest === 'string'
    ? { head: value.revision.head.replace(/[^0-9a-f]/gi, '').slice(0, 12), digest: value.revision.digest.replace(/[^0-9a-f]/gi, '').slice(0, 12) } : null;
  const clippedFields = isObject(value.clipped) ? Object.keys(value.clipped).filter(name => value.clipped[name] === true).slice(0, 9).map(name => limitText(name, 30)) : [];
  const shortened = clippedFields.length > 0 || textCut(value.question, WAIT_QUESTION_LIMIT) || textCut(value.scope, WAIT_TEXT_LIMIT) || textCut(value.completedWork, WAIT_TEXT_LIMIT)
    || [value.verification, value.artifacts, value.onApprove, value.onRequestChanges].some(listCut);
  return {
    kind: 'approval',
    requestId: value.requestId,
    state,
    continuation: oneOf(value.continuation, WAIT_CONTINUATIONS),
    progress: oneOf(value.progress, WAIT_PROGRESS),
    taskId: waitText(value.taskId, 120),
    taskTitle: waitText(value.taskTitle, 200),
    question: waitText(value.question, WAIT_QUESTION_LIMIT),
    scope: waitText(value.scope, WAIT_TEXT_LIMIT),
    completedWork: waitText(value.completedWork, WAIT_TEXT_LIMIT),
    verification: waitList(value.verification),
    artifacts: waitList(value.artifacts),
    onApprove: waitList(value.onApprove),
    onRequestChanges: waitList(value.onRequestChanges),
    revision,
    response,
    clippedFields,
    shortened,
  };
}

/** Whether a projected wait is a typed request that still has to be answered, or an answer whose continuation is not consumed. */
export function approvalUnresolved(wait) {
  if (!wait) return false;
  if (wait.kind === 'unrecognized') return true;
  if (wait.kind !== 'approval') return false;
  return wait.state === 'pending' || (wait.state === 'answered' && (wait.continuation === 'pending' || wait.continuation === 'queued'));
}

/**
 * A shortened approval wait names the command that reads the whole request, so a report never passes a summary off as the
 * request. The note is part of the wait and therefore shows in every report that carries it.
 */
function withCompleteRequestHint(runId, wait) {
  if (!wait || wait.kind !== 'approval' || wait.shortened !== true) return wait;
  return {
    ...wait,
    completeRequest: {
      command: `request ${runId} --request ${wait.requestId}`,
      note: 'This request is shortened: some text or list entries are cut. Read the complete request with the request command before presenting it, and do not treat this summary as the full scope.',
    },
  };
}

/** Project a coordinator run record to the compact fields a report may show. The feature, checkpoint bodies, resolution and settings are never copied. */
export function projectRun(record) {
  if (!isObject(record) || typeof record.id !== 'string' || typeof record.status !== 'string') throw new Error('Run record has an unexpected shape');
  const checkpoint = isObject(record.checkpoint) ? record.checkpoint : null;
  const tasks = checkpoint && Array.isArray(checkpoint.tasks) ? checkpoint.tasks : null;
  const phase = checkpoint && (checkpoint.phase === 'planner' || checkpoint.phase === 'executor') ? checkpoint.phase : null;
  let currentTask = null;
  if (tasks && phase === 'executor' && record.status !== 'succeeded' && Number.isInteger(checkpoint.index) && checkpoint.index >= 0 && checkpoint.index < tasks.length && isObject(tasks[checkpoint.index])) {
    const task = tasks[checkpoint.index];
    currentTask = {
      id: typeof task.id === 'string' && task.id ? limitText(task.id, 120) : `task-${checkpoint.index + 1}`,
      title: typeof task.title === 'string' ? limitText(task.title, 200) : '',
    };
  }
  const reason = typeof record.reason === 'string' && record.reason ? record.reason
    : checkpoint && typeof checkpoint.reason === 'string' && checkpoint.reason ? checkpoint.reason : null;
  const blocked = record.status === 'paused' || record.status === 'failed' || record.status === 'reconciliation-required';
  const blockerText = blocked && reason ? limitText(reason, Number.MAX_SAFE_INTEGER) : '';
  const blocker = { text: blockerText ? limitText(blockerText, BLOCKER_LIMIT) : null, truncated: blockerText.length > BLOCKER_LIMIT };
  return {
    runId: record.id,
    projectId: typeof record.projectId === 'string' ? record.projectId : null,
    status: record.status,
    stateClass: STATE_CLASSES[record.status] ?? 'unknown',
    capacityReserved: record.capacityReserved === true,
    launchAction: record.launchAction === 'resume' || record.launchAction === 'start' ? record.launchAction : null,
    phase,
    progress: tasks && checkpoint ? { completed: Array.isArray(checkpoint.results) ? checkpoint.results.length : 0, total: tasks.length } : null,
    currentTask,
    blocker: blocker.text,
    blockerTruncated: blocker.truncated,
    waitReported: Object.hasOwn(record, 'wait'),
    wait: withCompleteRequestHint(record.id, projectWait(record.wait)),
    worktreePath: typeof record.worktreePath === 'string' ? record.worktreePath : null,
    branch: typeof record.branch === 'string' ? record.branch : null,
    baseCommit: typeof record.baseCommit === 'string' ? record.baseCommit : null,
    parentSessionId: typeof record.parentSessionId === 'string' && record.parentSessionId ? record.parentSessionId : null,
    createdAt: timestamp(record.createdAt),
    updatedAt: timestamp(record.updatedAt),
  };
}

/** The fields whose change is worth a watch line. updatedAt is excluded so a bare timestamp refresh stays quiet. */
export function stateKey(projection) {
  return JSON.stringify([projection.status, projection.capacityReserved, projection.launchAction, projection.phase, projection.progress, projection.currentTask?.id ?? null, projection.blocker, projection.blockerTruncated, projection.wait]);
}

/** Why a watch must stop once it has seen this state, or null to keep going. */
export function stopReasonFor(projection) {
  if (projection.status === 'paused') return 'paused';
  if (TERMINAL_STATUSES.includes(projection.status)) return `terminal:${projection.status}`;
  return null;
}

// --- Selection against a live coordinator ------------------------------------------------------------------

async function showRun(coordinator, runId) {
  const shown = await coordinator.call(['run', 'show', runId]);
  if (!shown.ok) return shown;
  try {
    const projection = projectRun(shown.value);
    if (projection.runId !== runId) return { ok: false, kind: 'invalid-response', message: 'Coordinator answered with a different run' };
    return { ok: true, projection, record: shown.value };
  } catch (error) {
    return { ok: false, kind: 'invalid-response', message: limitText(error.message, 200) };
  }
}

/**
 * Find the run to report: an explicit ID, else the managed branch of the selected worktree, else the one active run
 * of the matching project. Returns { outcome: 'selected', runId, via, projection? } or an explanatory outcome.
 */
async function selectRun({ coordinator, cwd, env, explicit }) {
  if (explicit !== undefined) {
    if (!validRunId(explicit)) return { outcome: 'usage', message: 'RUN_ID must be letters, digits, underscore or dash and must not start with a dash' };
    return { outcome: 'selected', runId: explicit, via: 'explicit' };
  }
  const repository = await inspectRepository(cwd, env);
  if (!repository.ok) return { outcome: 'needs-run-id', reason: repository.kind };
  const managed = repository.branch === null ? null : MANAGED_BRANCH.exec(repository.branch);
  if (managed) {
    const shown = await showRun(coordinator, managed[1]);
    if (shown.ok && shown.projection.branch === repository.branch) return { outcome: 'selected', runId: managed[1], via: 'managed-branch', projection: shown.projection };
    if (shown.ok || shown.kind === 'not-found') return { outcome: 'needs-run-id', reason: 'managed-branch-run-mismatch', branch: repository.branch };
    return { outcome: 'error', error: { kind: shown.kind, message: shown.message } };
  }
  const projects = await findProjects(coordinator, repository.commonGitDirectory);
  if (!projects.ok) return { outcome: 'error', error: projects.error };
  if (projects.match !== 'one') return { outcome: 'needs-run-id', reason: projects.match === 'none' ? 'no-matching-project' : 'multiple-matching-projects', projects: projects.projects };
  const listed = await coordinator.call(['run', 'list']);
  if (!listed.ok) {
    if (listed.kind === 'response-too-large') return { outcome: 'needs-run-id', reason: 'run-list-too-large', project: projects.projects[0] };
    return { outcome: 'error', error: { kind: listed.kind, message: listed.message } };
  }
  let chosen;
  try { chosen = chooseActiveRun(listed.value, projects.projects[0].id); }
  catch (error) { return { outcome: 'error', error: { kind: 'invalid-response', message: limitText(error.message, 200) } }; }
  if (chosen.outcome === 'selected') return { outcome: 'selected', runId: chosen.runId, via: 'sole-active-run', completeness: chosen.completeness, project: projects.projects[0] };
  return { ...chosen, project: projects.projects[0] };
}

// --- Commands ----------------------------------------------------------------------------------------------

async function contextReport({ coordinator, cwd, env, options, configFile }) {
  const notices = [];
  const report = { ok: true, command: 'context', cwd, coordinator: { configuration: configurationSelection({ configFile, env }) }, notices };
  const repository = await inspectRepository(cwd, env);
  if (repository.ok) {
    const managed = repository.branch === null ? null : MANAGED_BRANCH.exec(repository.branch);
    report.repository = {
      topLevel: repository.topLevel, commonGitDirectory: repository.commonGitDirectory, branch: repository.branch, head: repository.head,
      managedRunId: managed ? managed[1] : null, changes: repository.changes,
    };
    if (repository.changes && (repository.changes.tracked || repository.changes.untracked)) {
      notices.push(`The working tree has ${repository.changes.tracked} changed and ${repository.changes.untracked} untracked paths. A run starts from a committed base and does not include them.`);
    }
    if (repository.branch === null) notices.push('HEAD is detached.');
  } else {
    report.repository = null;
    notices.push(repository.kind === 'git-missing' ? 'Git is not available on PATH.' : 'The working directory is not inside a Git worktree.');
  }

  const status = await coordinator.call(['status', '--json'], { timeoutMs: 15000 });
  const parsedStatus = status.ok ? projectCoordinatorStatus(status.value) : null;
  report.coordinator.readiness = parsedStatus ? parsedStatus.readiness : 'unavailable';
  report.coordinator.acceptingNewRuns = parsedStatus ? parsedStatus.acceptingNewRuns : false;
  if (parsedStatus) { report.coordinator.queuedRuns = parsedStatus.queuedRuns; report.coordinator.reservedRuns = parsedStatus.reservedRuns; }
  else report.coordinator.error = status.ok ? { kind: 'invalid-response', message: 'Coordinator status is not a valid status document' } : { kind: status.kind, message: status.message };
  if (parsedStatus?.readiness === 'draining') notices.push('The coordinator is draining and accepts no new runs.');

  report.project = { match: 'unknown', projects: [] };
  if (repository.ok && parsedStatus) {
    const projects = await findProjects(coordinator, repository.commonGitDirectory);
    if (projects.ok) {
      report.project = { match: projects.match, projects: projects.projects };
      if (projects.match === 'none') notices.push('No registered project uses this repository.');
      if (projects.match === 'many') notices.push('More than one registered project matches this repository.');
    } else report.project = { match: 'unknown', projects: [], error: projects.error };
  }

  if (options['--base'] !== undefined) {
    if (!repository.ok) report.base = { ref: options['--base'], ok: false, message: 'No repository to resolve against' };
    else {
      const resolved = await resolveBase(repository.topLevel, options['--base'], env);
      report.base = resolved.ok ? { ref: options['--base'], ok: true, oid: resolved.oid, resolvedIn: repository.topLevel } : { ref: options['--base'], ok: false, message: resolved.message };
      const registered = report.project.match === 'one' ? report.project.projects[0].directory : null;
      if (resolved.ok && registered && (await canonical(registered)) !== repository.topLevel) {
        const there = await resolveBase(registered, options['--base'], env);
        report.base.registeredDirectory = registered;
        report.base.registeredDirectoryOid = there.ok ? there.oid : null;
        if (!there.ok || there.oid !== resolved.oid) notices.push('The coordinator resolves a base revision in the registered project directory, where it differs from this worktree.');
      }
    }
  }
  return { report, exitCode: 0 };
}

function outcomeReport(command, selection, configuration) {
  const { outcome, ...rest } = selection;
  return { ok: true, command, outcome, ...rest, coordinator: { configuration } };
}

function errorReport(command, error) {
  return { ok: false, command, outcome: 'error', error: { kind: error.kind, message: error.message } };
}

async function snapshotReport({ coordinator, cwd, env, positional, configFile }) {
  const configuration = configurationSelection({ configFile, env });
  const selection = await selectRun({ coordinator, cwd, env, explicit: positional[0] });
  if (selection.outcome === 'usage') throw new UsageError(selection.message);
  if (selection.outcome === 'error') return { report: errorReport('snapshot', selection.error), exitCode: 1 };
  if (selection.outcome !== 'selected') return { report: outcomeReport('snapshot', selection, configuration), exitCode: 0 };
  const shown = selection.projection ? { ok: true, projection: selection.projection } : await showRun(coordinator, selection.runId);
  if (!shown.ok) return { report: errorReport('snapshot', shown), exitCode: 1 };
  const { completeness, via } = selection;
  return {
    report: { ok: true, command: 'snapshot', outcome: 'snapshot', selection: { via, ...(completeness ? { runListCompleteness: completeness } : {}) }, run: shown.projection, limits: EVIDENCE_LIMITS, coordinator: { configuration } },
    exitCode: 0,
  };
}

function defaultSleep(milliseconds, signal) {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const timer = setTimeout(done, milliseconds);
    function done() { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); }
    signal?.addEventListener('abort', done, { once: true });
  });
}

/**
 * Poll one run until it pauses, ends, the budget is spent, the signal aborts or a read fails. `readRun` returns
 * `{ ok: true, projection }` or `{ ok: false, ... }`; `emit` receives each projection that differs from the last emitted one.
 */
export async function watchRun({ readRun, emit, budgetMs, intervalMs, signal, now = Date.now, sleep = defaultSleep }) {
  const started = now();
  let polls = 0;
  let last = null;
  let lastKey = null;
  const finish = (reason, error) => ({ reason, polls, elapsedSeconds: Math.round((now() - started) / 100) / 10, lastState: last, ...(error ? { error } : {}) });
  for (;;) {
    if (signal?.aborted) return finish('interrupted');
    const result = await readRun(signal);
    if (signal?.aborted) return finish('interrupted');
    polls++;
    if (!result.ok) return finish('transport-error', { kind: result.kind, message: result.message });
    last = result.projection;
    const key = stateKey(last);
    if (key !== lastKey) { lastKey = key; await emit(last); }
    const stop = stopReasonFor(last);
    if (stop) return finish(stop);
    const remaining = budgetMs - (now() - started);
    if (remaining <= 0) return finish('budget');
    await sleep(Math.min(intervalMs, remaining), signal);
  }
}

async function watchCommand({ coordinator, cwd, env, positional, options, configFile, stdout, signal }) {
  const timing = watchTiming(options);
  const configuration = configurationSelection({ configFile, env });
  const selection = await selectRun({ coordinator, cwd, env, explicit: positional[0] });
  if (selection.outcome === 'usage') throw new UsageError(selection.message);
  if (selection.outcome === 'error') return { report: errorReport('watch', selection.error), exitCode: 1 };
  if (selection.outcome !== 'selected') return { report: outcomeReport('watch', selection, configuration), exitCode: 0 };
  const write = value => stdout.write(`${JSON.stringify(value)}\n`);
  write({ event: 'watching', runId: selection.runId, via: selection.via, budgetSeconds: timing.budgetSeconds, intervalSeconds: timing.intervalSeconds, coordinator: { configuration } });
  const summary = await watchRun({
    readRun: () => showRun(coordinator, selection.runId),
    emit: projection => write({ event: 'state', at: new Date().toISOString(), run: projection }),
    budgetMs: timing.budgetSeconds * 1000,
    intervalMs: timing.intervalSeconds * 1000,
    signal,
  });
  write({ event: 'stopped', runId: selection.runId, ...summary, limits: EVIDENCE_LIMITS });
  return { report: null, exitCode: summary.reason === 'transport-error' ? 1 : 0 };
}

// --- Complete approval request ---------------------------------------------------------------------------------

const REQUEST_TEXT_FIELDS = Object.freeze(['question', 'scope', 'completedWork']);
const REQUEST_LIST_FIELDS = Object.freeze(['verification', 'artifacts', 'onApprove', 'onRequestChanges']);
const HEX = /^[0-9a-f]{1,128}$/i;

/**
 * Validate the coordinator's complete answer for one approval request against the run and request that were asked for and
 * the limits of an accepted request. Nothing is shortened and nothing is repaired: a text or list that is missing, mistyped
 * or over a limit makes the whole answer invalid, because a partly valid request is not a request the owner can review.
 * Returns { ok: true, request } with the content verbatim, or { ok: false, message }.
 */
export function parseCompleteRequest(value, { runId, requestId }) {
  const bad = what => ({ ok: false, message: `${what} is missing or not valid` });
  if (!isObject(value)) return bad('The answer');
  if (value.runId !== runId) return bad('The run id');
  if (value.requestId !== requestId) return bad('The request id');
  const content = {};
  for (const field of REQUEST_TEXT_FIELDS) {
    if (typeof value[field] !== 'string' || value[field].length > REQUEST_TEXT_LIMIT) return bad(`The ${field} text`);
    content[field] = value[field];
  }
  for (const field of REQUEST_LIST_FIELDS) {
    const entries = value[field];
    if (!Array.isArray(entries) || entries.length > REQUEST_LIST_LIMIT) return bad(`The ${field} list`);
    if (entries.some(entry => typeof entry !== 'string' || entry.length > REQUEST_TEXT_LIMIT)) return bad(`An entry of the ${field} list`);
    content[field] = [...entries];
  }
  if (Buffer.byteLength(JSON.stringify(content), 'utf8') > REQUEST_PAYLOAD_LIMIT) return bad('The request size');
  const revision = value.revision;
  if (!isObject(revision) || typeof revision.head !== 'string' || !HEX.test(revision.head) || typeof revision.digest !== 'string' || !HEX.test(revision.digest)) return bad('The revision');
  if (typeof value.taskId !== 'string' || !value.taskId || value.taskId.length > 128) return bad('The task id');
  if (typeof value.attemptId !== 'string' || !value.attemptId || value.attemptId.length > 128) return bad('The attempt id');
  if (!Number.isSafeInteger(value.taskIndex) || value.taskIndex < 0) return bad('The task index');
  const state = oneOf(value.state, WAIT_STATES);
  const continuation = oneOf(value.continuation, WAIT_CONTINUATIONS);
  const progress = oneOf(value.progress, WAIT_PROGRESS);
  if (state === null) return bad('The state');
  if (continuation === null) return bad('The continuation');
  if (progress === null) return bad('The progress');
  let response = null;
  if (state === 'answered') {
    const answer = value.response;
    if (!isObject(answer) || oneOf(answer.decision, WAIT_DECISIONS) === null) return bad('The response');
    if (answer.feedback !== null && answer.feedback !== undefined && typeof answer.feedback !== 'string') return bad('The feedback');
    // The owner's feedback is not copied into a report, only the decision and whether feedback exists.
    response = { decision: answer.decision, answeredAt: timestamp(answer.answeredAt), feedbackRecorded: typeof answer.feedback === 'string' && answer.feedback.length > 0 };
  } else if (value.response !== null && value.response !== undefined) return bad('The response');
  return {
    ok: true,
    request: {
      requestId, runId, state, continuation, progress,
      task: { id: value.taskId, index: value.taskIndex }, attemptId: value.attemptId,
      revision: { head: revision.head, digest: revision.digest },
      ...content,
      response, createdAt: timestamp(value.createdAt),
    },
  };
}

/**
 * Read one approval request completely, read-only: a single `run approval` call, validated, with nothing shortened. When the
 * read or the validation fails the report says that review information is incomplete and carries no request content, so a
 * summary can never be mistaken for the request.
 */
async function requestCommand({ coordinator, options, positional, configFile, env }) {
  const runId = positional[0];
  if (runId === undefined) throw new UsageError('request requires RUN_ID');
  if (!validRunId(runId)) throw new UsageError('RUN_ID must be letters, digits, underscore or dash and must not start with a dash');
  const requestId = options['--request'];
  if (requestId === undefined) throw new UsageError('request requires --request ID');
  if (!validRunId(requestId)) throw new UsageError('--request must be letters, digits, underscore or dash and must not start with a dash');
  const configuration = configurationSelection({ configFile, env });
  const incomplete = (kind, message) => ({
    report: {
      ok: false, command: 'request', outcome: 'error', complete: false, runId, requestId, error: { kind, message },
      note: 'The complete request could not be read, so the review information is incomplete. Do not present a summary as the full request or ask the owner to approve on it; say that the review is incomplete.',
      coordinator: { configuration },
    },
    exitCode: 1,
  });
  const read = await coordinator.call(['run', 'approval', runId, '--request', requestId]);
  if (!read.ok) {
    const older = read.kind === 'error' && /Unknown coordinator command|does not support reading an approval request/i.test(read.message);
    return incomplete(older ? 'unsupported' : read.kind, older ? 'The coordinator or command line is too old to read a complete approval request' : read.message);
  }
  const parsed = parseCompleteRequest(read.value, { runId, requestId });
  if (!parsed.ok) return incomplete('invalid-response', limitText(parsed.message, 200));
  return {
    report: { ok: true, command: 'request', outcome: 'request', complete: true, request: parsed.request, coordinator: { configuration } },
    exitCode: 0,
  };
}

// --- Input files -------------------------------------------------------------------------------------------

const PROBLEM_MESSAGES = {
  unreadable: 'The file cannot be read.',
  'not-a-file': 'The path is not a regular file.',
  empty: 'The text is empty or only whitespace.',
  'too-large': 'The text is larger than the allowed size.',
  'not-utf8': 'The text is not valid UTF-8.',
  'contains-nul': 'The text contains a NUL character, which cannot be passed on a command line.',
  'too-long': `The text is longer than the ${RESPONSE_INPUT_LIMIT} characters the coordinator accepts for a response.`,
};

function decodeText(buffer, limit) {
  if (buffer.length > limit) return { ok: false, reason: 'too-large', bytes: buffer.length };
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer); }
  catch { return { ok: false, reason: 'not-utf8', bytes: buffer.length }; }
  if (!text.trim()) return { ok: false, reason: 'empty', bytes: buffer.length };
  return { ok: true, text, bytes: buffer.length };
}

/** Read a regular UTF-8 text file of at most `limit` bytes. The text is returned untouched. */
async function readTextFile(file, limit) {
  let stat;
  try { stat = await fs.stat(file); } catch { return { ok: false, reason: 'unreadable' }; }
  if (!stat.isFile()) return { ok: false, reason: 'not-a-file' };
  if (stat.size > limit) return { ok: false, reason: 'too-large', bytes: stat.size };
  let buffer;
  try { buffer = await fs.readFile(file); } catch { return { ok: false, reason: 'unreadable' }; }
  return decodeText(buffer, limit);
}

async function readStdin(stdin, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) return { ok: false, reason: 'too-large', bytes: size };
    chunks.push(buffer);
  }
  return decodeText(Buffer.concat(chunks), limit);
}

// --- inspect-spec ------------------------------------------------------------------------------------------

const RESUME_SIGNALS = {
  'mentions-resume': /\bresum(?:e|ed|es|ing)\b/i,
  'mentions-paused-or-blocked': /\b(?:paused|blocked|blocker|unblock\w*)\b/i,
  'mentions-guidance': /\b(?:guidance|resolution|owner decision|decision)\b/i,
  'mentions-a-run': /\b(?:the|this|that|existing) run\b|\brun id\b/i,
};

/** Candidate coordinator run IDs in a text: UUIDs (what the coordinator generates) and managed run branch names. */
export function runIdCandidates(text) {
  const found = new Set();
  for (const match of text.matchAll(UUID)) found.add(match[0].toLowerCase());
  for (const match of text.matchAll(/heimdall\/run\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})/g)) found.add(match[1]);
  return [...found].slice(0, 10);
}

/**
 * Describe a specification file without changing anything. The flags are heuristics for the caller to resolve with the
 * user; this command never decides whether a text is a new feature or guidance for an existing run.
 */
async function inspectSpecCommand({ coordinator, cwd, positional }) {
  if (positional[0] === undefined) throw new UsageError('inspect-spec requires FILE');
  const file = path.resolve(cwd, positional[0]);
  const read = await readTextFile(file, MAX_SPEC_BYTES);
  const base = { command: 'inspect-spec', file, maxBytes: MAX_SPEC_BYTES, mutations: [] };
  if (!read.ok && (read.reason === 'unreadable' || read.reason === 'not-a-file')) {
    return { report: { ok: false, ...base, outcome: 'refused', reason: `spec-${read.reason}`, message: PROBLEM_MESSAGES[read.reason] }, exitCode: 1 };
  }
  if (!read.ok) {
    return { report: { ok: true, ...base, outcome: 'inspected', usable: false, problem: read.reason, message: PROBLEM_MESSAGES[read.reason], bytes: read.bytes ?? null }, exitCode: 0 };
  }
  const heading = /^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t#]*$/m.exec(read.text);
  const existingRunIds = [];
  const candidates = runIdCandidates(read.text);
  let runLookup = candidates.length === 0 ? 'none' : 'checked';
  for (const candidate of candidates) {
    if (!validRunId(candidate)) continue;
    const shown = await showRun(coordinator, candidate);
    if (shown.ok) existingRunIds.push(candidate);
    else if (shown.kind !== 'not-found') { runLookup = 'unavailable'; break; }
  }
  const signals = Object.entries(RESUME_SIGNALS).filter(([, pattern]) => pattern.test(read.text)).map(([name]) => name);
  if (existingRunIds.length > 0) signals.push('mentions-existing-run-id');
  return {
    report: {
      ...base, ok: true, outcome: 'inspected', usable: true, bytes: read.bytes,
      firstHeading: heading ? limitText(heading[1], 120) : null,
      mentionsExistingRun: existingRunIds.length > 0, existingRunIds, runIdCandidates: candidates.length, runLookup,
      signals, looksLikeResumeGuidance: signals.length >= 2,
      note: 'Heuristic flags only. Ask the user whether this is a new feature or guidance for an existing run before changing anything.',
    },
    exitCode: 0,
  };
}

// --- Mutations ---------------------------------------------------------------------------------------------

// Refusals the coordinator makes before changing anything. The command line prints no HTTP status code, so any other
// failure of a request that may have been delivered is reported as uncertain rather than guessed to be a refusal.
const SERVER_REJECTIONS = [
  /Project not found/, /Feature specification exceeds/, /must be nonempty text/, /Invalid coordinator record ID/,
  /Coordinator is draining; new work is disabled/, /Provide a Git base revision/, /Git did not resolve a full base commit/,
  /already tracks a managed runtime path/, /Register a non-bare Git worktree/, /Project already registered with different/,
  /Project configuration/, /Runtime dependencies/, /Run not found/, /Unknown run/,
  /Only a confirmed idle paused run may be resumed/, /Native parent and children must be confirmed idle/,
  /Runtime snapshot refused/, /Resume requires a released paused run/,
  /An approval request is waiting for an owner decision/, /An owner decision is recorded and its continuation has not been consumed/,
];

/**
 * What a failed mutation tells us. `not-sent`: the request provably never reached the coordinator. `rejected`: the
 * coordinator answered with a known refusal. Anything else (timeout, reset, unreadable answer, unknown text) leaves
 * the outcome unknown. Only the diagnostic is examined: the process error message repeats the command line.
 */
export function classifyMutationFailure(result) {
  if (result.kind === 'not-installed') return 'not-sent';
  if (result.kind !== 'error') return 'uncertain';
  if (/Coordinator unavailable: connect (?:ENOENT|ECONNREFUSED)\b/.test(result.stderr)) return 'not-sent';
  if (SERVER_REJECTIONS.some(pattern => pattern.test(result.stderr))) return 'rejected';
  return 'uncertain';
}

/**
 * What a failed `run respond` tells us, from its exit status and first diagnostic line. `not-sent`: the request provably
 * never reached the coordinator. `rejected`: the coordinator answered with a refusal and recorded nothing. `unsupported`:
 * the command line or the coordinator does not know the operation, so nothing was sent. Exit status 2 is the command
 * line's own "may or may not have been recorded"; anything unrecognized is uncertain, never guessed to be a refusal.
 */
export function classifyRespondFailure(result) {
  if (result.kind === 'not-installed') return 'not-sent';
  if (result.kind !== 'error' || result.exitCode !== 1) return 'uncertain';
  const diagnostic = firstLine(result.stderr.replace(/^Heimdall:\s*/, '').trimStart());
  if (/^The coordinator at .+ does not support this response operation/.test(diagnostic)) return 'unsupported';
  if (/^Unknown coordinator command; see --help$/.test(diagnostic) || /^Unknown or repeated option: --(?:request|pause)$/.test(diagnostic)) return 'unsupported';
  if (/^The coordinator refused the response \(\d{3}(?: [a-z-]+)?\): /.test(diagnostic)) return 'rejected';
  if (/^The coordinator at .+ refused authorization; .*Nothing was recorded\.$/.test(diagnostic)) return 'rejected';
  if (/^The coordinator at .+ is unavailable: .*Nothing was sent\.$/.test(diagnostic)) return 'not-sent';
  return 'uncertain';
}

/** The HTTP status and code the command line printed for a refusal, when it printed them. */
function refusalCode(result) {
  const match = /^The coordinator refused the response \((\d{3})(?: ([a-z-]+))?\)/.exec(firstLine(result.stderr.replace(/^Heimdall:\s*/, '').trimStart()));
  return match ? { status: Number(match[1]), code: match[2] ?? null } : null;
}

/** Validate the acknowledgement `run respond` prints against the response that was sent. Null when it is anything else. */
function responseAck(stdout, expected) {
  const ack = parseJson(stdout);
  if (!isObject(ack) || ack.runId !== expected.runId) return null;
  if (expected.requestId !== undefined && (ack.requestId !== expected.requestId || ack.decision !== expected.decision)) return null;
  if (expected.pauseId !== undefined && ack.pauseId !== expected.pauseId) return null;
  if (typeof ack.continuation !== 'string' || typeof ack.retried !== 'boolean' || !isObject(ack.run) || typeof ack.run.status !== 'string') return null;
  return {
    runId: ack.runId,
    ...(expected.requestId === undefined ? { pauseId: ack.pauseId } : { requestId: ack.requestId, decision: ack.decision }),
    continuation: limitText(ack.continuation, 40), retried: ack.retried, recordedAt: timestamp(ack.recordedAt),
    run: { status: limitText(ack.run.status, 40), version: Number.isInteger(ack.run.version) ? ack.run.version : null },
  };
}

/**
 * Send exactly one `run respond` and classify the outcome. The text travels as the value of `--input=`, so it can never
 * be read as an option, and the call is never repeated: whatever happens, the caller reports it.
 */
async function deliverResponse(coordinator, args, expected) {
  const result = await coordinator.raw(['run', 'respond', ...args], { timeoutMs: MUTATION_TIMEOUT_MS });
  if (!result.ok) {
    const kind = classifyRespondFailure(result);
    return { kind, message: failureText(result), ...(kind === 'rejected' ? { refusal: refusalCode(result) } : {}) };
  }
  const ack = responseAck(result.stdout, expected);
  if (!ack) return { kind: 'uncertain', message: 'The coordinator answered, but the answer is not the expected acknowledgement.' };
  return { kind: 'recorded', ack };
}

function failureText(result) {
  const diagnostic = result.stderr.replace(/^Heimdall:\s*/, '').trim();
  if (diagnostic) return limitText(diagnostic, 500);
  return result.kind === 'error' ? 'The command failed without a diagnostic.' : `The command ended early (${result.kind}).`;
}

const UNCERTAIN_RULE = 'The request may or may not have been applied. Do not repeat it. Treat the records below as unconfirmed and check the run with the owner before any further step.';

function parseJson(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

async function readiness(coordinator) {
  const status = await coordinator.call(['status', '--json'], { timeoutMs: 15000 });
  if (!status.ok) return { state: 'unavailable', error: { kind: status.kind, message: status.message } };
  const parsed = projectCoordinatorStatus(status.value);
  if (!parsed) return { state: 'unavailable', error: { kind: 'invalid-response', message: 'Coordinator status is not a valid status document' } };
  return { state: parsed.readiness, acceptingNewRuns: parsed.acceptingNewRuns, queuedRuns: parsed.queuedRuns, reservedRuns: parsed.reservedRuns };
}

const readinessSummary = state => (state.state === 'unavailable' ? { readiness: 'unavailable', error: state.error } : { readiness: state.state, acceptingNewRuns: state.acceptingNewRuns, queuedRuns: state.queuedRuns, reservedRuns: state.reservedRuns });

/** Interpret the one document `coordinator start --json` prints. Only the documented success outcomes count. */
function lifecycleResult(result) {
  const document = parseJson(result.stdout);
  if (!isObject(document) || typeof document.outcome !== 'string') return { success: false, summary: { outcome: 'unknown', message: failureText(result) } };
  const error = isObject(document.error) ? document.error : null;
  return {
    success: result.ok && document.ok === true && START_SUCCESS_OUTCOMES.includes(document.outcome),
    summary: { outcome: document.outcome, ok: document.ok === true, errorCode: error && typeof error.code === 'string' ? error.code : null, message: limitText(error?.message ?? document.message ?? '', 300) },
  };
}

function dirtyNotice(changes) {
  if (!changes || (!changes.tracked && !changes.untracked)) return null;
  return `The working tree has ${changes.tracked} changed and ${changes.untracked} untracked paths. A run starts from the committed base and does not include them.`;
}

/** Read-only look at what a lost submit may have created. Candidates are never treated as confirmation. */
async function inspectSubmission({ coordinator, projectId, oid, text, since }) {
  const listed = await coordinator.call(['run', 'list']);
  if (!listed.ok) return { source: 'run list', available: false, reason: listed.kind, message: listed.message, candidates: [], confirmed: false };
  let parsed;
  try { parsed = parseRunList(listed.value); }
  catch (error) { return { source: 'run list', available: false, reason: 'invalid-response', message: limitText(error.message, 200), candidates: [], confirmed: false }; }
  const candidates = parsed.runs
    .filter(entry => entry.projectId === projectId && typeof entry.id === 'string' && typeof entry.createdAt === 'number' && entry.createdAt >= since)
    .slice(0, 10)
    .map(entry => ({
      runId: entry.id, status: String(entry.status), createdAt: timestamp(entry.createdAt),
      baseMatches: entry.baseCommit === oid, specMatches: typeof entry.feature === 'string' ? entry.feature === text : null,
    }));
  return { source: 'run list', available: true, completeness: parsed.completeness, candidates, confirmed: false };
}

/**
 * Start a run: validate everything locally, make sure the coordinator can take work, find (or with --register add)
 * the project, then submit exactly once. Nothing before the submit retries or replaces anything.
 */
async function startCommand({ coordinator, cwd, env, options, configFile, signal }) {
  if (options['--spec'] === undefined) throw new UsageError('start requires --spec FILE');
  const attempted = [];
  const notices = [];
  const configuration = configurationSelection({ configFile, env });
  const done = (outcome, fields = {}, ok = false) => ({
    report: { ok, command: 'start', outcome, ...fields, ...(notices.length ? { notices } : {}), mutationsAttempted: attempted, coordinator: { configuration } },
    exitCode: ok ? 0 : 1,
  });

  const specFile = path.resolve(cwd, options['--spec']);
  const spec = await readTextFile(specFile, MAX_SPEC_BYTES);
  if (!spec.ok) return done('refused', { reason: `spec-${spec.reason}`, message: PROBLEM_MESSAGES[spec.reason], spec: { file: specFile, ...(spec.bytes === undefined ? {} : { bytes: spec.bytes }), maxBytes: MAX_SPEC_BYTES } });
  const repository = await inspectRepository(cwd, env);
  if (!repository.ok) return done('refused', { reason: repository.kind, message: repository.kind === 'git-missing' ? 'Git is not available on PATH.' : 'The working directory is not inside a Git worktree.' });
  const requested = options['--base'] ?? 'HEAD';
  const resolved = await resolveBase(repository.topLevel, requested, env);
  if (!resolved.ok) return done('refused', { reason: 'base-unresolved', message: resolved.message });
  const base = { ref: requested, oid: resolved.oid, resolvedIn: repository.topLevel };
  const dirty = dirtyNotice(repository.changes);
  if (dirty) notices.push(dirty);
  const specSummary = { file: specFile, bytes: spec.bytes };

  let state = await readiness(coordinator);
  if (state.state === 'unavailable' && options['--start-coordinator'] === true && (state.error.kind === 'unavailable' || /Cannot read the coordinator key/.test(state.error.message))) {
    if (signal?.aborted) return done('interrupted', { reason: 'interrupted-before-mutation' });
    attempted.push('coordinator start');
    const started = lifecycleResult(await coordinator.raw(['start', '--json'], { timeoutMs: COORDINATOR_START_TIMEOUT_MS }));
    if (!started.success) return done('coordinator-start-failed', { coordinatorStart: started.summary, message: 'The coordinator did not report a started state. It was not retried, stopped or restarted.' });
    state = await readiness(coordinator);
  }
  if (state.state === 'unavailable') {
    return done('coordinator-unavailable', { ...readinessSummary(state), canStartCoordinator: options['--start-coordinator'] !== true, message: 'The coordinator is not reachable, so nothing was submitted.' });
  }
  if (state.state === 'draining' || state.acceptingNewRuns !== true) {
    return done('coordinator-draining', { ...readinessSummary(state), message: 'The coordinator is draining and accepts no new runs. Nothing was submitted; the owner decides whether to wait or restart it.' });
  }

  const found = await findProjects(coordinator, repository.commonGitDirectory);
  if (!found.ok) return done('error', { error: found.error });
  if (found.match === 'many') return done('needs-project', { reason: 'multiple-matching-projects', projects: found.projects, message: 'More than one registered project matches this repository. Ask the owner which one to use.' });
  let project = found.projects[0];
  if (found.match === 'none') {
    const registrationRoot = await registrationDirectory(repository);
    if (registrationRoot === null) {
      return done('needs-registration', { reason: 'registration-directory-unknown', directory: repository.topLevel, message: 'The main worktree of this repository cannot be derived from its Git directory, so nothing was registered. Ask the owner to register the project, then rerun.' });
    }
    if (options['--register'] !== true) return done('needs-registration', { reason: 'no-matching-project', directory: registrationRoot, message: 'No registered project uses this repository. Registering it is a separate change; rerun with --register once the owner agrees.' });
    if (signal?.aborted) return done('interrupted', { reason: 'interrupted-before-mutation' });
    if (registrationRoot !== repository.topLevel) notices.push(`This is a linked worktree; the main worktree ${registrationRoot} is registered as the project instead.`);
    attempted.push('project add');
    const added = await coordinator.raw(['project', 'add', registrationRoot], { timeoutMs: MUTATION_TIMEOUT_MS });
    if (!added.ok) {
      const kind = classifyMutationFailure(added);
      const message = failureText(added);
      if (kind === 'not-sent') return done('registration-not-sent', { message });
      if (kind === 'rejected') return done('registration-rejected', { message, directory: registrationRoot });
      const again = await findProjects(coordinator, repository.commonGitDirectory);
      return done('registration-uncertain', { message, rule: UNCERTAIN_RULE, inspection: { source: 'project list', available: again.ok, matches: again.ok ? again.projects : [], confirmed: false } });
    }
    const record = parseJson(added.stdout);
    if (!isObject(record) || typeof record.id !== 'string' || (await canonical(String(record.commonGitDirectory))) !== repository.commonGitDirectory) {
      return done('registration-uncertain', { message: 'The coordinator answered, but the answer is not the expected project record.', rule: UNCERTAIN_RULE });
    }
    project = { id: record.id, directory: String(record.directory), commonGitDirectory: record.commonGitDirectory, concurrency: record.concurrency };
  } else if ((await canonical(project.directory)) !== repository.topLevel) {
    notices.push(`The registered project directory is ${project.directory}; this worktree is ${repository.topLevel}. The run is created from the registered project.`);
  }
  if (!validRunId(project.id)) return done('error', { error: { kind: 'invalid-response', message: 'The registered project ID cannot be passed safely on a command line.' } });
  if (signal?.aborted) return done('interrupted', { reason: 'interrupted-before-mutation' });

  const since = Date.now() - 1000;
  attempted.push('run submit');
  const submitted = await coordinator.raw(['run', 'submit', project.id, '--feature', specFile, '--base', resolved.oid], { timeoutMs: MUTATION_TIMEOUT_MS });
  const known = { project: { id: project.id, directory: project.directory }, base, spec: specSummary };
  if (!submitted.ok) {
    const kind = classifyMutationFailure(submitted);
    const message = failureText(submitted);
    if (kind === 'not-sent') return done('not-submitted', { message, ...known });
    if (kind === 'rejected') return done('rejected', { message, ...known });
    return done('uncertain', { message, rule: UNCERTAIN_RULE, ...known, inspection: await inspectSubmission({ coordinator, projectId: project.id, oid: resolved.oid, text: spec.text, since }) });
  }
  const record = parseJson(submitted.stdout);
  if (!isObject(record) || typeof record.id !== 'string' || !validRunId(record.id) || record.status !== 'queued' || record.projectId !== project.id) {
    return done('uncertain', { message: 'The coordinator answered, but the answer is not a queued run record.', rule: UNCERTAIN_RULE, ...known, inspection: await inspectSubmission({ coordinator, projectId: project.id, oid: resolved.oid, text: spec.text, since }) });
  }
  const run = projectRun(record);
  if (run.baseCommit !== resolved.oid) notices.push('The run records a different base commit than the one requested; inspect it before relying on it.');
  return done('submitted', {
    accepted: true, status: 'queued',
    note: 'The coordinator accepted and queued the run. It is not admitted or started yet; monitor it for admission.',
    runId: run.runId, ...known, base: { ...base, recordedCommit: run.baseCommit }, worktreePath: run.worktreePath, branch: run.branch, run,
  }, true);
}

/** Read-only look at a run after a resume whose outcome is unknown. It is never treated as confirmation. */
async function inspectRun(coordinator, runId) {
  const inspected = await showRun(coordinator, runId);
  if (!inspected.ok) return { source: 'run show', available: false, reason: inspected.kind, message: inspected.message, confirmed: false };
  return { source: 'run show', available: true, run: inspected.projection, version: inspected.record.version ?? null, confirmed: false };
}

function resumeNextAction(projection) {
  switch (projection.status) {
    case 'queued': case 'preparing': case 'running':
      return { action: 'wait', detail: 'The run is already queued or executing. Monitor it; there is nothing to resume.' };
    case 'paused':
      return { action: 'wait', detail: 'The run reports paused, but the coordinator still holds its capacity because it has not confirmed the run idle. It can be resumed only after that. Monitor it.' };
    case 'reconciliation-required':
      return { action: 'owner-decision', detail: 'The outcome of this run is uncertain. `run reconcile` is an explicit, separate recovery decision for the owner; this helper never runs it.' };
    default:
      return { action: 'none', detail: 'The run has finished and cannot be resumed.' };
  }
}

/** What to do about a typed request that is still open. Generic resume or guidance is never a way to answer it. */
function approvalNextAction(wait) {
  if (wait.kind === 'approval' && wait.state === 'answered') {
    return { action: 'wait', detail: 'The owner decision is recorded and the run continues from it automatically. Guidance cannot replace it. Monitor the run.' };
  }
  if (wait.kind === 'approval') {
    return {
      action: 'owner-decision',
      detail: `The run waits for an owner decision on request ${wait.requestId}. Show the owner the request. Only an explicit approval, or explicit change feedback, sent with \`respond RUN_ID --request ${wait.requestId} --decision approve|request-changes\` answers it. A request to resume or continue is not a decision.`,
    };
  }
  return { action: 'monitor', detail: 'The coordinator reports a wait this helper does not recognize, so nothing was sent. Inspect the run with the owner. Guidance is delivered only with a valid pause identity, which needs a coordinator and client of matching versions that support the guarded response.' };
}

/**
 * Resume a paused run with the owner's guidance. The guidance is data: it is read from a file or stdin and sent once, only
 * as the guarded response for exactly the generic pause the coordinator reports (so text beginning with a dash never
 * reaches the command line as an option). A run whose record does not carry a valid pause identity (no wait reported, no
 * wait, a typed request that is no longer open, or a shape this helper does not know) is refused with nothing sent: the
 * unguarded `run resume` is never used here, because it cannot tell which pause the guidance was written for. A typed
 * approval request that is still open is never answered, replaced or bypassed from here.
 */
async function resumeCommand({ coordinator, cwd, env, options, positional, configFile, stdin, signal }) {
  const runId = positional[0];
  if (runId === undefined) throw new UsageError('resume requires RUN_ID');
  if (!validRunId(runId)) throw new UsageError('RUN_ID must be letters, digits, underscore or dash and must not start with a dash');
  const fromStdin = options['--guidance-stdin'] === true;
  const guidanceFile = options['--guidance-file'];
  if (fromStdin === (guidanceFile !== undefined)) throw new UsageError('resume requires exactly one of --guidance-file FILE or --guidance-stdin');
  const attempted = [];
  const configuration = configurationSelection({ configFile, env });
  const done = (outcome, fields = {}, ok = false) => ({
    report: { ok, command: 'resume', outcome, runId, ...fields, mutationsAttempted: attempted, coordinator: { configuration } },
    exitCode: ok ? 0 : 1,
  });

  const pauseIdentityRefusal = run => done('refused', {
    reason: 'pause-identity-unavailable', run,
    message: 'The coordinator does not report a valid pause identity for this run, so no guidance was sent. Guidance is delivered only as a guarded response to the exact pause it was written for, which needs a coordinator and an OpenHeimdall client of matching versions that support the guarded response. The unguarded resume is not used instead.',
    next: { action: 'owner-decision', detail: 'Use matching coordinator and client versions that support the guarded response, then read the run again. If the run then shows a pause identity, send the guidance again; otherwise nothing was changed.' },
  });

  let guidance = fromStdin ? await readStdin(stdin, MAX_GUIDANCE_BYTES) : await readTextFile(path.resolve(cwd, guidanceFile), MAX_GUIDANCE_BYTES);
  if (guidance.ok && guidance.text.includes('\0')) guidance = { ok: false, reason: 'contains-nul', bytes: guidance.bytes };
  if (!guidance.ok) return done('refused', { reason: `guidance-${guidance.reason}`, message: PROBLEM_MESSAGES[guidance.reason], guidance: { source: fromStdin ? 'stdin' : 'file', ...(guidance.bytes === undefined ? {} : { bytes: guidance.bytes }), maxBytes: MAX_GUIDANCE_BYTES } });
  const guidanceSummary = { source: fromStdin ? 'stdin' : 'file', bytes: guidance.bytes };

  const before = await showRun(coordinator, runId);
  if (!before.ok) {
    if (before.kind === 'not-found') return done('not-found', { message: 'The coordinator has no run with this ID.' });
    return done('error', { error: { kind: before.kind, message: before.message } });
  }
  const { wait } = before.projection;
  if (wait?.kind === 'unrecognized' && before.record.wait?.kind === 'generic') return pauseIdentityRefusal(before.projection);
  if (approvalUnresolved(wait)) {
    return done('refused', { reason: 'approval-pending', run: before.projection, next: approvalNextAction(wait), message: 'The run has a typed approval request that is not resolved, so no guidance was sent. Guidance cannot answer or replace it.' });
  }
  if (before.record.status !== 'paused' || before.record.capacityReserved === true) {
    return done('not-resumable', { run: before.projection, next: resumeNextAction(before.projection), message: 'The run is not a confirmed idle paused run, so nothing was sent.' });
  }
  if (wait?.kind !== 'generic') return pauseIdentityRefusal(before.projection);
  if (guidance.text.length > RESPONSE_INPUT_LIMIT) {
    return done('refused', { reason: 'guidance-too-long', message: PROBLEM_MESSAGES['too-long'], guidance: { ...guidanceSummary, maxCharacters: RESPONSE_INPUT_LIMIT } });
  }
  if (signal?.aborted) return done('interrupted', { reason: 'interrupted-before-mutation' });

  const known = { guidance: guidanceSummary, before: { status: before.projection.status, version: before.record.version ?? null, completedResults: before.projection.progress?.completed ?? null } };
  // The guarded response names this pause and is checked again by the coordinator. It is never replaced by `run resume`.
  attempted.push('run respond');
  const sent = await deliverResponse(coordinator, [runId, '--pause', wait.pauseId, `--input=${guidance.text}`], { runId, pauseId: wait.pauseId });
  if (sent.kind === 'not-sent') return done('not-resumed', { message: sent.message, via: 'respond', ...known });
  if (sent.kind === 'rejected' || sent.kind === 'unsupported') return done('rejected', { message: sent.message, via: 'respond', ...(sent.kind === 'unsupported' ? { unsupported: true } : { refusal: sent.refusal }), ...known });
  if (sent.kind === 'uncertain') return done('uncertain', { message: sent.message, via: 'respond', rule: UNCERTAIN_RULE, ...known, inspection: await inspectRun(coordinator, runId) });
  if (sent.ack.continuation !== 'queued' || sent.ack.run.status !== 'queued') {
    return done('uncertain', { message: 'The coordinator acknowledged the response, but not as a queued resume.', via: 'respond', acknowledgement: sent.ack, rule: UNCERTAIN_RULE, ...known, inspection: await inspectRun(coordinator, runId) });
  }
  const acknowledgement = sent.ack;
  const after = await showRun(coordinator, runId);
  // When the follow-up read fails, the acceptance still stands: report what the coordinator itself acknowledged.
  const current = after.ok ? after.projection : null;
  const original = before.projection;
  return done('resumed', {
    accepted: true, status: current ? current.status : acknowledgement.run.status,
    via: 'respond',
    note: 'The coordinator accepted the resume and queued the same run again. It is not running until it is admitted; monitor it.',
    ...(current ? {
      run: current,
      preserved: {
        runId: current.runId === runId, worktreePath: current.worktreePath === original.worktreePath, branch: current.branch === original.branch,
        parentSessionId: current.parentSessionId === original.parentSessionId,
      },
      completedResults: { before: original.progress?.completed ?? null, after: current.progress?.completed ?? null },
    } : {}),
    acknowledgement,
    ...(after.ok ? {} : { confirmation: { available: false, reason: after.kind, message: after.message } }),
    guidance: guidanceSummary,
  }, true);
}

// --- respond -----------------------------------------------------------------------------------------------

/** Validate the target and text source of `respond` before anything is read or sent. Throws UsageError. */
function respondTarget(options, runId) {
  if (runId === undefined) throw new UsageError('respond requires RUN_ID');
  if (!validRunId(runId)) throw new UsageError('RUN_ID must be letters, digits, underscore or dash and must not start with a dash');
  const requestId = options['--request'];
  const pauseId = options['--pause'];
  const decision = options['--decision'];
  const feedbackSources = (options['--feedback-file'] !== undefined ? 1 : 0) + (options['--feedback-stdin'] === true ? 1 : 0);
  const guidanceSources = (options['--guidance-file'] !== undefined ? 1 : 0) + (options['--guidance-stdin'] === true ? 1 : 0);
  if (requestId !== undefined && pauseId !== undefined) throw new UsageError('respond takes one target: --request ID for an approval request or --pause ID for a generic pause');
  if (requestId === undefined && pauseId === undefined) throw new UsageError('respond requires --request ID (approval request) or --pause ID (generic pause)');
  if (requestId !== undefined) {
    if (!validRunId(requestId)) throw new UsageError('--request must be letters, digits, underscore or dash and must not start with a dash');
    if (decision === undefined) throw new UsageError('--request requires --decision approve or --decision request-changes');
    if (decision !== 'approve' && decision !== 'request-changes') throw new UsageError('--decision must be approve or request-changes');
    if (guidanceSources > 0) throw new UsageError('Guidance options apply to --pause only; send change feedback with --feedback-file or --feedback-stdin');
    if (decision === 'approve') {
      if (feedbackSources > 0) throw new UsageError('Approving takes no feedback; use --decision request-changes to send feedback');
      return { kind: 'decision', runId, requestId, decision };
    }
    if (feedbackSources !== 1) throw new UsageError('--decision request-changes requires exactly one of --feedback-file FILE or --feedback-stdin');
    return { kind: 'decision', runId, requestId, decision, label: 'feedback', fromStdin: options['--feedback-stdin'] === true, file: options['--feedback-file'] };
  }
  if (!validRunId(pauseId)) throw new UsageError('--pause must be letters, digits, underscore or dash and must not start with a dash');
  if (decision !== undefined) throw new UsageError('--decision applies to --request only; a generic pause takes guidance');
  if (feedbackSources > 0) throw new UsageError('Feedback options apply to --request only; send guidance with --guidance-file or --guidance-stdin');
  if (guidanceSources !== 1) throw new UsageError('--pause requires exactly one of --guidance-file FILE or --guidance-stdin');
  return { kind: 'pause', runId, pauseId, label: 'guidance', fromStdin: options['--guidance-stdin'] === true, file: options['--guidance-file'] };
}

/**
 * Carry one explicit owner response to the coordinator, exactly once: the decision on a displayed approval request, or
 * guidance for a displayed generic pause. The run is read again first and the response is sent only if it still targets
 * what is displayed. Nothing here decides for the owner: an approval is sent only because `--decision approve` was passed.
 */
async function respondCommand({ coordinator, cwd, env, options, positional, configFile, stdin, signal }) {
  const target = respondTarget(options, positional[0]);
  const { runId } = target;
  const attempted = [];
  const configuration = configurationSelection({ configFile, env });
  const targetSummary = target.kind === 'decision' ? { request: target.requestId, decision: target.decision } : { pause: target.pauseId };
  const done = (outcome, fields = {}, ok = false) => ({
    report: { ok, command: 'respond', outcome, runId, target: targetSummary, ...fields, sent: attempted.length > 0, mutationsAttempted: attempted, coordinator: { configuration } },
    exitCode: ok ? 0 : 1,
  });
  const refuse = (reason, message, fields = {}) => done('refused', { reason, message, ...fields });

  let text = null;
  let textSummary = null;
  if (target.label) {
    text = target.fromStdin ? await readStdin(stdin, MAX_GUIDANCE_BYTES) : await readTextFile(path.resolve(cwd, target.file), MAX_GUIDANCE_BYTES);
    if (text.ok && text.text.includes('\0')) text = { ok: false, reason: 'contains-nul', bytes: text.bytes };
    if (text.ok && text.text.length > RESPONSE_INPUT_LIMIT) text = { ok: false, reason: 'too-long', bytes: text.bytes };
    textSummary = { source: target.fromStdin ? 'stdin' : 'file', ...(text.bytes === undefined ? {} : { bytes: text.bytes }) };
    if (!text.ok) return refuse(`${target.label}-${text.reason}`, PROBLEM_MESSAGES[text.reason], { [target.label]: { ...textSummary, maxCharacters: RESPONSE_INPUT_LIMIT } });
  }

  const before = await showRun(coordinator, runId);
  if (!before.ok) {
    if (before.kind === 'not-found') return refuse('run-not-found', 'The coordinator has no run with this ID.');
    return done('error', { error: { kind: before.kind, message: before.message } });
  }
  const { wait, waitReported } = before.projection;
  const shown = { run: before.projection };
  if (!waitReported) {
    return refuse('wait-not-reported', 'This coordinator does not report what a run waits for, so there is no displayed request or pause to answer. Nothing was sent.', shown);
  }
  if (target.kind === 'decision') {
    if (wait?.kind !== 'approval' || wait.requestId !== target.requestId) {
      return refuse(wait?.kind === 'approval' ? 'request-mismatch' : 'no-approval-request', wait?.kind === 'approval'
        ? `The run now waits on a different request (${wait.requestId}). Show the owner that request; a decision for ${target.requestId} was not sent.`
        : 'The run has no approval request with this ID. Nothing was sent.', shown);
    }
    if (wait.state === 'answered') return refuse('already-answered', 'This request already has a recorded decision. Nothing was sent; read the run instead of repeating the response.', shown);
    if (wait.state === 'superseded') return refuse('request-superseded', 'This request was superseded: the reviewed work changed or the task moved on, so it can no longer be decided. Nothing was sent.', shown);
  } else {
    if (wait?.kind === 'approval') {
      return refuse('approval-pending', `The run waits on approval request ${wait.requestId}, not on a generic pause. Guidance cannot answer it. Nothing was sent.`, { ...shown, next: approvalNextAction(wait) });
    }
    if (wait?.kind !== 'generic' || wait.pauseId !== target.pauseId) {
      return refuse(wait?.kind === 'generic' ? 'pause-mismatch' : 'no-generic-pause', wait?.kind === 'generic'
        ? 'The run is now at a different pause than the one displayed. Show the owner the current pause. Nothing was sent.'
        : 'The run is not at a generic pause. Nothing was sent.', shown);
    }
    if (before.record.status !== 'paused' || before.record.capacityReserved === true) {
      return refuse('not-paused-and-released', 'The run is not a confirmed idle paused run. Nothing was sent.', { ...shown, next: resumeNextAction(before.projection) });
    }
  }
  if (signal?.aborted) return done('interrupted', { reason: 'interrupted-before-mutation' });

  const known = { ...(textSummary ? { [target.label]: textSummary } : {}), before: { status: before.projection.status, version: before.record.version ?? null } };
  const args = target.kind === 'decision'
    ? [runId, '--request', target.requestId, '--decision', target.decision, ...(target.decision === 'request-changes' ? [`--input=${text.text}`] : [])]
    : [runId, '--pause', target.pauseId, `--input=${text.text}`];
  attempted.push('run respond');
  const sent = await deliverResponse(coordinator, args, target.kind === 'decision'
    ? { runId, requestId: target.requestId, decision: target.decision } : { runId, pauseId: target.pauseId });
  if (sent.kind === 'not-sent') return refuse('not-sent', sent.message, known);
  if (sent.kind === 'unsupported') return refuse('coordinator-unsupported', sent.message, { ...known, note: 'Nothing was sent and the unguarded resume was not used instead.' });
  if (sent.kind === 'rejected') return refuse('coordinator-refused', sent.message, { ...known, ...(sent.refusal ? { refusal: sent.refusal } : {}) });
  if (sent.kind === 'uncertain') return done('uncertain', { message: sent.message, rule: UNCERTAIN_RULE, ...known, inspection: await inspectRun(coordinator, runId) });

  const after = await showRun(coordinator, runId);
  const outcome = sent.ack.continuation === 'queued' ? 'queued' : sent.ack.continuation === 'pending' ? 'waiting-for-idle' : 'recorded';
  const note = {
    queued: 'The response is recorded and the same run is queued to continue. It is not running until it is admitted, and the task is not complete.',
    'waiting-for-idle': 'The response is recorded. The coordinator continues the run once it has proof that the run is idle. Nothing is running yet, and the task is not complete.',
    recorded: 'The response is recorded. Read the run for how it continues.',
  }[outcome];
  return done(outcome, {
    accepted: true, recorded: true, retried: sent.ack.retried, note, acknowledgement: sent.ack, ...known,
    ...(after.ok ? { run: after.projection } : { confirmation: { available: false, reason: after.kind, message: after.message } }),
  }, true);
}

/** Run the helper. Returns the exit status: 0 for a report, 1 for a coordinator or transport failure, 2 for bad usage. */
export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, stdin = process.stdin, signal } = {}) {
  try {
    const parsed = parseArguments(argv);
    if (parsed.command === 'help') { stdout.write(HELP); return 0; }
    const cwd = path.resolve(parsed.options['--cwd'] ?? process.cwd());
    let isDirectory = false;
    try { isDirectory = (await fs.stat(cwd)).isDirectory(); } catch { /* reported below */ }
    if (!isDirectory) throw new UsageError('--cwd must name an existing directory');
    const configFile = parsed.options['--coordinator-config'] === undefined ? undefined : path.resolve(cwd, parsed.options['--coordinator-config']);
    const coordinator = createCoordinator({ env, configFile, signal });
    const context = { coordinator, cwd, env, options: parsed.options, positional: parsed.positional, configFile, stdout, stdin, signal };
    const handlers = { context: contextReport, snapshot: snapshotReport, watch: watchCommand, request: requestCommand, 'inspect-spec': inspectSpecCommand, start: startCommand, resume: resumeCommand, respond: respondCommand };
    const result = await handlers[parsed.command](context);
    if (result.report) stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
    return result.exitCode;
  } catch (error) {
    if (error instanceof UsageError) { stderr.write(`openheimdall: ${error.message}\n`); return 2; }
    stderr.write(`openheimdall: ${limitText(error instanceof Error ? error.message : 'Command failed', 300)}\n`);
    return 1;
  }
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (invokedDirectly()) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  process.exitCode = await main(process.argv.slice(2), { signal: controller.signal });
  process.off('SIGINT', interrupt);
  process.off('SIGTERM', interrupt);
}
