import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { CoordinatorConfiguration } from '../../coordinator/config.js';
import type { ProjectRecord } from '../../coordinator/types.js';
import { gitEnvironment, verifyManagedWorktree } from '../../coordinator/worktrees.js';
import { REVIEW_LIMITS } from '../shared/protocol.js';
import type { ReviewChange, ReviewFile, ReviewFileResponse, ReviewFileView, ReviewResponse, ReviewState } from '../shared/protocol.js';
import type { PublicRun } from './coordinator.js';

/**
 * Read-only review of a run's exact managed worktree against its recorded base commit.
 *
 * Nothing here writes to Git: every command is a read (`diff`, `ls-files`, `rev-parse`, `cat-file`,
 * `symbolic-ref`, `worktree list`), runs with GIT_OPTIONAL_LOCKS=0 and an argument array, and never stages,
 * resets, switches, stashes or cleans. Untracked files are read directly (no `git add -N`).
 * `.heimdall/managed.json` holds the run's owner token; no code path here ever opens anything under `.heimdall/`.
 */

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const FULL_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const AGENT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const GIT_TIMEOUT_MS = 8000;
const LIST_BUFFER = 4 * 1024 * 1024;
const DIFF_BUFFER = 512 * 1024;

export type ReviewRun = Pick<PublicRun, 'id' | 'projectId' | 'baseCommit' | 'worktreePath' | 'branch' | 'status' | 'settings'>;

export interface ReviewOptions {
  /** Largest number of feature files listed (default and maximum 500). */
  maxFiles?: number;
  /** Per-git-command timeout in milliseconds. */
  timeoutMs?: number;
  now?: () => Date;
}

/** A request the caller must not repeat unchanged (unknown or malformed path); the message is safe to show. */
export class ReviewRequestError extends Error {
  constructor(message: string) { super(message); this.name = 'ReviewRequestError'; }
}

/** Git failed after the worktree had been verified; the message is deliberately generic. */
export class ReviewGitError extends Error {
  constructor() { super('Git could not inspect the managed worktree.'); this.name = 'ReviewGitError'; }
}

const MESSAGES: Record<Exclude<ReviewState, 'ready'>, string> = {
  'queued-no-worktree': 'This run has not started yet, so there is no worktree to review.',
  'worktree-missing': 'The managed worktree for this run is missing.',
  'worktree-mismatch': 'The managed worktree does not match the coordinator record, so it was not inspected.',
};

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const code = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

interface GitResult { stdout: Buffer; overflow: boolean }

/** `--literal-pathspecs` is added per call: a file named like pathspec magic must never match other files. */
function runGit(cwd: string, args: string[], options: { maxBuffer: number; timeoutMs: number; literal?: boolean }): Promise<GitResult> {
  const prefix = [...(options.literal ? ['--literal-pathspecs'] : []), '-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false'];
  return new Promise((resolve, reject) => {
    execFile('git', [...prefix, ...args], { cwd, env: gitEnvironment(), encoding: 'buffer', maxBuffer: options.maxBuffer, timeout: options.timeoutMs, windowsHide: true }, (error, stdout) => {
      if (!error) { resolve({ stdout, overflow: false }); return; }
      // execFile kills the process on overflow but still hands over what it read.
      if (code(error) === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') { resolve({ stdout: Buffer.from(stdout), overflow: true }); return; }
      reject(new ReviewGitError());
    });
  });
}

const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color', '--no-renames'];

/** Syntax check for a repository-relative path; used on request input and on names git reports. */
export function validReviewPath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('�')) return false;
  if (Buffer.byteLength(value) > REVIEW_LIMITS.pathBytes) return false;
  if (value.startsWith('/') || (process.platform === 'win32' && (/^[A-Za-z]:/.test(value) || value.startsWith('\\')))) return false;
  const segments = process.platform === 'win32' ? value.split(/[\\/]/) : value.split('/');
  return !segments.some(segment => segment === '' || segment === '.' || segment === '..');
}

function agentNames(settings: unknown): Set<string> {
  const names = new Set(['adr-orchestrator']);
  if (record(settings)) for (const key of ['plannerAgent', 'executorAgent']) {
    const value = settings[key];
    if (typeof value === 'string' && AGENT_NAME.test(value)) names.add(value);
  }
  return names;
}

/** Runtime assets the coordinator writes into every managed checkout (see prepareRuntime). */
export function isGeneratedPath(filePath: string, settings: unknown): boolean {
  if (filePath === '.heimdall' || filePath.startsWith('.heimdall/')) return true;
  if (filePath === '.opencode/plugins/heimdall.ts') return true;
  for (const name of agentNames(settings)) if (filePath === `.opencode/agents/${name}.md`) return true;
  return false;
}

type Unavailable = { ok: false; state: Exclude<ReviewState, 'ready'> };
type Available = { ok: true; checkout: string };

/** Decide whether this exact run owns a managed worktree that may be inspected. Never throws for a bad worktree. */
async function resolveWorktree(run: ReviewRun, project: ProjectRecord | undefined, configuration: Pick<CoordinatorConfiguration, 'stateDirectory'>, timeoutMs: number): Promise<Available | Unavailable> {
  const mismatch: Unavailable = { ok: false, state: 'worktree-mismatch' };
  if (!project || project.id !== run.projectId || !IDENTIFIER.test(run.id) || !IDENTIFIER.test(project.id)) return mismatch;
  if (typeof run.baseCommit !== 'string' || !FULL_OID.test(run.baseCommit)) return mismatch;
  if (run.branch !== `heimdall/run/${run.id}`) return mismatch;
  if (typeof run.worktreePath !== 'string' || !configuration.stateDirectory) return mismatch;
  const expected = path.join(path.resolve(configuration.stateDirectory), 'worktrees', project.id, run.id, 'checkout');
  if (path.resolve(run.worktreePath) !== expected) return mismatch;

  const notCreated: Unavailable = { ok: false, state: run.status === 'queued' || run.status === 'preparing' ? 'queued-no-worktree' : 'worktree-missing' };
  let stat;
  try { stat = await fs.lstat(expected); }
  catch (error) { return code(error) === 'ENOENT' ? notCreated : mismatch; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return mismatch;

  // Every ancestor must be a real directory: the canonical path has to equal the managed layout exactly.
  let real: string;
  try {
    real = await fs.realpath(expected);
    const realState = await fs.realpath(configuration.stateDirectory);
    if (real !== path.join(realState, 'worktrees', project.id, run.id, 'checkout')) return mismatch;
  } catch (error) { return code(error) === 'ENOENT' ? notCreated : mismatch; }

  try { await verifyManagedWorktree({ project, run: run as never }); }
  catch { return mismatch; }
  try { await runGit(real, ['cat-file', '-e', `${run.baseCommit}^{commit}`], { maxBuffer: 1024, timeoutMs }); }
  catch { return mismatch; }
  return { ok: true, checkout: real };
}

interface Collected {
  head: string;
  /** Every change found (after path validation), keyed by path. */
  entries: Map<string, ReviewFile>;
  /** Names git reported that were dropped (invalid path) or output that overflowed. */
  incomplete: boolean;
}

/** Split NUL-terminated git output; a trailing partial record (overflow) is discarded. */
function records(result: GitResult): string[] {
  const parts = result.stdout.toString('utf8').split('\0');
  parts.pop(); // after the final terminator, or an incomplete record
  return parts;
}

const CHANGES: Record<string, ReviewChange> = { A: 'added', M: 'modified', D: 'deleted', T: 'type-changed', U: 'unmerged' };

async function collect(checkout: string, run: ReviewRun, timeoutMs: number): Promise<Collected> {
  const base = run.baseCommit;
  const options = { maxBuffer: LIST_BUFFER, timeoutMs };
  const [nameStatus, numstat, untracked, head] = await Promise.all([
    runGit(checkout, ['diff', ...DIFF_FLAGS, '--name-status', '-z', base, '--'], options),
    // Sizes never read the runtime directory, which holds the run's owner token.
    runGit(checkout, ['diff', ...DIFF_FLAGS, '--numstat', '-z', base, '--', '.', ':(exclude).heimdall'], options),
    runGit(checkout, ['ls-files', '--others', '--exclude-standard', '-z'], options),
    runGit(checkout, ['rev-parse', 'HEAD'], { maxBuffer: 1024, timeoutMs }),
  ]);
  const headOid = head.stdout.toString('utf8').trim();
  if (!FULL_OID.test(headOid)) throw new ReviewGitError();

  let incomplete = nameStatus.overflow || numstat.overflow || untracked.overflow;
  const entries = new Map<string, ReviewFile>();

  const status = records(nameStatus);
  for (let index = 0; index + 1 < status.length; index += 2) {
    const change = CHANGES[status[index]!.charAt(0)];
    const filePath = status[index + 1]!;
    if (!change || !validReviewPath(filePath)) { incomplete = true; continue; }
    entries.set(filePath, { path: filePath, change, additions: null, deletions: null, binary: null, size: null });
  }
  for (const line of records(numstat)) {
    const first = line.indexOf('\t');
    const second = line.indexOf('\t', first + 1);
    if (first < 0 || second < 0) continue;
    const entry = entries.get(line.slice(second + 1));
    if (!entry) continue;
    const added = line.slice(0, first);
    const deleted = line.slice(first + 1, second);
    if (added === '-' && deleted === '-') entry.binary = true;
    else { entry.binary = false; entry.additions = Number(added); entry.deletions = Number(deleted); }
  }
  for (const filePath of records(untracked)) {
    if (filePath.endsWith('/')) continue; // nested repository: its files are not part of this checkout's content
    if (!validReviewPath(filePath)) { incomplete = true; continue; }
    if (!entries.has(filePath)) entries.set(filePath, { path: filePath, change: 'untracked', additions: null, deletions: null, binary: null, size: null });
  }
  return { head: headOid, entries, incomplete };
}

const byPath = (left: ReviewFile, right: ReviewFile) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

async function untrackedSize(checkout: string, filePath: string): Promise<number | null> {
  try {
    const stat = await fs.lstat(path.join(checkout, ...filePath.split('/')));
    return stat.isFile() ? stat.size : null;
  } catch { return null; }
}

function identity(run: ReviewRun): { baseCommit: string; branch: string } {
  return {
    baseCommit: typeof run.baseCommit === 'string' && FULL_OID.test(run.baseCommit) ? run.baseCommit : '',
    branch: IDENTIFIER.test(run.id) ? `heimdall/run/${run.id}` : '',
  };
}

const maxEntries = (options: ReviewOptions) => Math.max(1, Math.min(options.maxFiles ?? REVIEW_LIMITS.files, REVIEW_LIMITS.files));

/** List what the run changed in its managed worktree: commits, staged, unstaged and untracked, against `baseCommit`. */
export async function reviewRun(run: ReviewRun, project: ProjectRecord | undefined, configuration: Pick<CoordinatorConfiguration, 'stateDirectory'>, options: ReviewOptions = {}): Promise<ReviewResponse> {
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const resolved = await resolveWorktree(run, project, configuration, timeoutMs);
  if (!resolved.ok) {
    return {
      state: resolved.state, message: MESSAGES[resolved.state], ...identity(run), head: null, files: [], generated: [],
      counts: { files: 0, generated: 0, additions: 0, deletions: 0, binary: 0 }, truncated: false, fetchedAt: now().toISOString(),
    };
  }

  const collected = await collect(resolved.checkout, run, timeoutMs);
  const feature: ReviewFile[] = [];
  const generated: ReviewFile[] = [];
  for (const entry of collected.entries.values()) (isGeneratedPath(entry.path, run.settings) ? generated : feature).push(entry);
  feature.sort(byPath);
  generated.sort(byPath);

  const counts = { files: feature.length, generated: generated.length, additions: 0, deletions: 0, binary: 0 };
  for (const entry of feature) {
    counts.additions += entry.additions ?? 0;
    counts.deletions += entry.deletions ?? 0;
    if (entry.binary) counts.binary++;
  }

  let truncated = collected.incomplete;
  let budget = 2048;
  const fit = (entries: ReviewFile[], limit: number): ReviewFile[] => {
    const kept: ReviewFile[] = [];
    for (const entry of entries) {
      const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (kept.length >= limit || budget + size > REVIEW_LIMITS.responseBytes) { truncated = true; break; }
      kept.push(entry);
      budget += size;
    }
    return kept;
  };
  const files = fit(feature, maxEntries(options));
  const listedGenerated = fit(generated, REVIEW_LIMITS.generated);
  for (const entry of files) if (entry.change === 'untracked') entry.size = await untrackedSize(resolved.checkout, entry.path);

  return {
    state: 'ready', message: null, baseCommit: run.baseCommit, branch: run.branch, head: collected.head,
    files, generated: listedGenerated, counts, truncated, fetchedAt: now().toISOString(),
  };
}

function decode(buffer: Buffer, cut: boolean): string {
  const text = buffer.toString('utf8');
  // A cut inside a multi-byte character leaves a trailing replacement character; drop it.
  return cut && text.endsWith('�') ? text.slice(0, -1) : text;
}

export interface Contents { view: ReviewFileView; text: string; binary: boolean; large: boolean; size: number | null; additions: number | null }

/** Render an untracked regular file as all-added lines. Symlinks and special files are never followed or opened. */
export async function readUntracked(checkout: string, filePath: string): Promise<Contents> {
  const cap = REVIEW_LIMITS.diffBytes;
  const none = (view: ReviewFileView): Contents => ({ view, text: '', binary: false, large: false, size: null, additions: null });
  const segments = filePath.split('/');
  let current = checkout;
  try {
    for (const segment of segments.slice(0, -1)) {
      current = path.join(current, segment);
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return none('unsupported');
    }
    const target = path.join(current, segments[segments.length - 1]!);
    const before = await fs.lstat(target);
    if (before.isSymbolicLink() || !before.isFile()) return none('unsupported');
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (before.ino !== 0 && (stat.ino !== before.ino || stat.dev !== before.dev))) return none('unsupported');
      const buffer = Buffer.alloc(cap + 1);
      const { bytesRead } = await handle.read(buffer, 0, cap + 1, 0);
      const large = bytesRead > cap || stat.size > cap;
      const data = buffer.subarray(0, Math.min(bytesRead, cap));
      if (data.includes(0)) return { view: 'binary', text: '', binary: true, large: false, size: stat.size, additions: null };
      const content = decode(data, large);
      const lines = content.length === 0 ? [] : content.split('\n');
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
      const header = `diff --git a/${filePath} b/${filePath}\nnew file mode 100644\n--- /dev/null\n+++ b/${filePath}\n`;
      const hunk = lines.length === 0 ? '' : `@@ -0,0 +1,${lines.length} @@\n${lines.map(line => `+${line}`).join('\n')}\n${!large && !content.endsWith('\n') ? '\\ No newline at end of file\n' : ''}`;
      return { view: 'diff', text: header + hunk, binary: false, large, size: stat.size, additions: large ? null : lines.length };
    } finally { await handle.close(); }
  } catch (error) {
    return none(code(error) === 'ENOENT' ? 'missing' : 'unsupported');
  }
}

async function readTracked(checkout: string, run: ReviewRun, entry: ReviewFile, timeoutMs: number): Promise<Contents> {
  const cap = REVIEW_LIMITS.diffBytes;
  const deleted = entry.change === 'deleted';
  if (entry.binary) return { view: deleted ? 'deleted' : 'binary', text: '', binary: true, large: false, size: null, additions: null };
  const result = await runGit(checkout, ['diff', ...DIFF_FLAGS, '--unified=3', run.baseCommit, '--', entry.path], { maxBuffer: DIFF_BUFFER, timeoutMs, literal: true });
  if (/^Binary files .* differ$/m.test(result.stdout.subarray(0, 4096).toString('utf8'))) return { view: deleted ? 'deleted' : 'binary', text: '', binary: true, large: false, size: null, additions: null };
  const large = result.overflow || result.stdout.length > cap;
  return { view: deleted ? 'deleted' : 'diff', text: decode(result.stdout.subarray(0, cap), large), binary: false, large, size: null, additions: null };
}

/** Bounded diff of one file. `filePath` must be an entry of the freshly computed change list. */
export async function reviewFile(run: ReviewRun, project: ProjectRecord | undefined, configuration: Pick<CoordinatorConfiguration, 'stateDirectory'>, filePath: unknown, options: ReviewOptions = {}): Promise<ReviewFileResponse> {
  // Syntax first, before any filesystem or git access: absolute, traversal, NUL and oversized paths stop here.
  if (!validReviewPath(filePath)) throw new ReviewRequestError('The path is not a valid repository-relative path.');
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const resolved = await resolveWorktree(run, project, configuration, timeoutMs);
  const empty = { path: filePath, change: null, view: null, binary: false, large: false, truncated: false, additions: null, deletions: null, size: null, text: '' } as const;
  if (!resolved.ok) return { state: resolved.state, message: MESSAGES[resolved.state], ...identity(run), ...empty, fetchedAt: now().toISOString() };

  const { entries } = await collect(resolved.checkout, run, timeoutMs);
  const entry = entries.get(filePath);
  if (!entry) throw new ReviewRequestError('That path is not one of this run\'s changed files.');

  let contents: Contents;
  if (isGeneratedPath(entry.path, run.settings)) contents = { view: 'generated', text: '', binary: false, large: false, size: null, additions: null };
  else if (entry.change === 'untracked') contents = await readUntracked(resolved.checkout, entry.path);
  else contents = await readTracked(resolved.checkout, run, entry, timeoutMs);

  const response: ReviewFileResponse = {
    state: 'ready', message: null, baseCommit: run.baseCommit, path: entry.path, change: entry.change, view: contents.view,
    binary: contents.binary, large: contents.large, truncated: contents.large,
    additions: entry.additions ?? contents.additions, deletions: entry.deletions, size: contents.size ?? entry.size,
    text: contents.text, fetchedAt: now().toISOString(),
  };
  // JSON escaping can expand control characters; keep the whole response inside the service cap.
  while (response.text.length > 0 && Buffer.byteLength(JSON.stringify(response)) > REVIEW_LIMITS.responseBytes) {
    response.text = response.text.slice(0, Math.floor(response.text.length * 0.75));
    response.truncated = true;
  }
  return response;
}
