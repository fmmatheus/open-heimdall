#!/usr/bin/env node
// OpenHeimdall skill helper (read-only core).
//
// A dependency-free wrapper around the installed `heimdall coordinator` command line. It gathers repository
// and coordinator context, selects a run and reports compact state. Every command in this file only reads:
// it never submits, resumes, reconciles, registers a project or starts/stops the coordinator.
//
// The command line is invoked without a shell: `execFile` with an argument array, using the binary named by
// HEIMDALL_BIN or `heimdall` on PATH. Every option value is data, so paths may contain spaces, quotes or a
// leading dash.
//
//   openheimdall.mjs context  [--base REF]
//   openheimdall.mjs snapshot [RUN_ID]
//   openheimdall.mjs watch    [RUN_ID] [--budget-seconds N] [--interval-seconds N]
//
// Common options: --cwd DIR (default: the current directory), --coordinator-config FILE (resolved against --cwd
// and forwarded to every coordinator call). Reports are JSON on stdout. `watch` prints one JSON line per change.

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

const COMMAND_TIMEOUT_MS = 30000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MANAGED_BRANCH = /^heimdall\/run\/([A-Za-z0-9][A-Za-z0-9_-]{0,127})$/;
const COMMIT = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

const COMMANDS = {
  context: { options: ['--base'], positional: 0 },
  snapshot: { options: [], positional: 1 },
  watch: { options: ['--budget-seconds', '--interval-seconds'], positional: 1 },
};
const COMMON_OPTIONS = ['--cwd', '--coordinator-config'];

export const HELP = `OpenHeimdall helper (read-only)

Usage:
  openheimdall.mjs context  [--base REF]
  openheimdall.mjs snapshot [RUN_ID]
  openheimdall.mjs watch    [RUN_ID] [--budget-seconds N] [--interval-seconds N]

Common options: --cwd DIR, --coordinator-config FILE
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
    if (!allowed.has(name)) throw new UsageError(`Unknown option for ${command}: ${name}`);
    if (Object.hasOwn(options, name)) throw new UsageError(`Repeated option: ${name}`);
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
      resolve({ ok: false, kind, stdout: stdout ?? '', stderr: stderr ?? '', message: String(error.message) });
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
  return {
    binary,
    /** Run one coordinator subcommand; arguments are an array, never a shell string. */
    async call(args, { json = true, timeoutMs } = {}) {
      const argv = ['coordinator', ...args, ...(configFile ? ['--coordinator-config', configFile] : [])];
      const result = await run(binary, argv, { env, signal, timeoutMs });
      if (!result.ok) return failure(result);
      if (!json) return { ok: true, value: result.stdout };
      try { return { ok: true, value: JSON.parse(result.stdout) }; }
      catch { return { ok: false, kind: 'invalid-response', message: 'Coordinator output is not JSON' }; }
    },
  };
}

function git(directory, args, env) {
  return run('git', ['-C', directory, ...args], { env: { ...env, GIT_OPTIONAL_LOCKS: '0' } });
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
    blocker: blocked && reason ? limitText(reason, 300) : null,
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
  return JSON.stringify([projection.status, projection.capacityReserved, projection.launchAction, projection.phase, projection.progress, projection.currentTask?.id ?? null, projection.blocker]);
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
    return { ok: true, projection };
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

/** Run the helper. Returns the exit status: 0 for a report, 1 for a coordinator or transport failure, 2 for bad usage. */
export async function main(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr, signal } = {}) {
  try {
    const parsed = parseArguments(argv);
    if (parsed.command === 'help') { stdout.write(HELP); return 0; }
    const cwd = path.resolve(parsed.options['--cwd'] ?? process.cwd());
    let isDirectory = false;
    try { isDirectory = (await fs.stat(cwd)).isDirectory(); } catch { /* reported below */ }
    if (!isDirectory) throw new UsageError('--cwd must name an existing directory');
    const configFile = parsed.options['--coordinator-config'] === undefined ? undefined : path.resolve(cwd, parsed.options['--coordinator-config']);
    const coordinator = createCoordinator({ env, configFile, signal });
    const context = { coordinator, cwd, env, options: parsed.options, positional: parsed.positional, configFile, stdout, signal };
    const result = parsed.command === 'context' ? await contextReport(context)
      : parsed.command === 'snapshot' ? await snapshotReport(context)
        : await watchCommand(context);
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
