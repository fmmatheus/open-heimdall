import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gitEnvironment } from './worktrees.js';

/**
 * The reviewed state of a managed worktree: the commit it stands on and a digest of everything uncommitted that is
 * part of the feature. The coordinator computes it itself, so no agent- or client-supplied digest is ever trusted.
 */
export interface ReviewRevision {
  head: string;
  digest: string;
}

export type ReviewRevisionErrorCode = 'revision-unavailable' | 'revision-timeout' | 'revision-too-large';

/** The revision could not be measured; nothing was written. The message is safe to show and never contains file content. */
export class ReviewRevisionError extends Error {
  readonly code: ReviewRevisionErrorCode;
  constructor(code: ReviewRevisionErrorCode, message: string) {
    super(message);
    this.name = 'ReviewRevisionError';
    this.code = code;
  }
}

export interface ReviewRevisionOptions {
  /** Agent role names whose generated `.opencode/agents/<role>.md` file is runtime metadata, not feature content. */
  roles?: Iterable<string>;
  /** Total time for every git command and file read (default 30 s). */
  timeoutMs?: number;
  /** Total bytes of git output and untracked file content that may be measured (default 256 MiB). */
  maxBytes?: number;
  /** Most untracked files that may be measured (default 20000). */
  maxFiles?: number;
}

const FULL_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ROLE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 256 * 1024 * 1024;
const DEFAULT_MAX_FILES = 20_000;
const STATUS_LIMIT = 16 * 1024 * 1024;
const FORMAT = 'heimdall-review-revision-v1';

/**
 * Runtime metadata the coordinator writes into every managed checkout, and the agent runtime's own state. These paths
 * are excluded whether or not the project ignores them: `.heimdall/managed.json` holds a capability that rotates on every
 * admission and must never make unchanged work look changed. Only top-level `.omc` matches; `.omcx` and `docs/.omc/x` are code.
 */
export function generatedPathspecs(roles: Iterable<string> = []): string[] {
  const generated = ['.heimdall', '.omc', '.opencode/plugins/heimdall.ts'];
  for (const role of roles) if (ROLE_NAME.test(role)) generated.push(`.opencode/agents/${role}.md`);
  return generated.map(entry => `:(exclude,literal)${entry}`);
}

/** One shared limit for time and size, so a slow disk or a huge tree fails the whole measurement clearly. */
class Budget {
  private remaining: number;
  private readonly deadline: number;
  constructor(private readonly timeoutMs: number, maxBytes: number) {
    this.deadline = Date.now() + timeoutMs;
    this.remaining = maxBytes;
  }
  timeLeft(): number {
    const left = this.deadline - Date.now();
    if (left <= 0) throw new ReviewRevisionError('revision-timeout', `The review revision could not be measured within ${this.timeoutMs} ms.`);
    return left;
  }
  consume(bytes: number): void {
    this.remaining -= bytes;
    if (this.remaining < 0) throw new ReviewRevisionError('revision-too-large', 'The worktree changes are too large to measure as one review revision.');
  }
}

const unavailable = (): ReviewRevisionError => new ReviewRevisionError('revision-unavailable', 'Git could not measure the managed worktree.');

/**
 * Read-only git: an argument array, no shell, the sanitized repository environment with optional locks off (so status never
 * refreshes the index), no fsmonitor, no hooks, no pager, no external diff or text conversion. Output is streamed to `sink`.
 */
function git(cwd: string, args: string[], budget: Budget, sink: (chunk: Buffer) => void, extraEnvironment: NodeJS.ProcessEnv = {}): Promise<void> {
  const prefix = ['--no-pager', '-c', 'core.quotepath=off', '-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${os.devNull}`];
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) { child.kill('SIGKILL'); reject(error); } else resolve();
    };
    const child = spawn('git', [...prefix, ...args], { cwd, env: { ...gitEnvironment(), GIT_TERMINAL_PROMPT: '0', ...extraEnvironment }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let timer: NodeJS.Timeout;
    try { timer = setTimeout(() => finish(new ReviewRevisionError('revision-timeout', 'The review revision could not be measured in time.')), budget.timeLeft()); }
    catch (error) { child.kill('SIGKILL'); reject(error); return; }
    child.stdout.on('data', (chunk: Buffer) => {
      try { budget.consume(chunk.length); sink(chunk); } catch (error) { finish(error as Error); }
    });
    child.stderr.resume();
    child.on('error', () => finish(unavailable()));
    child.on('close', code => finish(code === 0 ? undefined : unavailable()));
  });
}

async function collect(cwd: string, args: string[], budget: Budget, sink?: (chunk: Buffer) => void, limit = STATUS_LIMIT, environment: NodeJS.ProcessEnv = {}): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  await git(cwd, args, budget, chunk => {
    size += chunk.length;
    if (size > limit) throw new ReviewRevisionError('revision-too-large', 'The worktree changes are too large to measure as one review revision.');
    chunks.push(chunk);
    sink?.(chunk);
  }, environment);
  return Buffer.concat(chunks);
}

const sha256 = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

function safeRelative(value: string): boolean {
  if (!value || value.includes('\0') || path.isAbsolute(value) || /^[A-Za-z]:/.test(value)) return false;
  return !value.replace(/\/$/, '').split('/').some(segment => segment === '' || segment === '.' || segment === '..');
}

/** Stable fingerprint of one untracked path without following links; content is streamed, never held whole. */
async function fingerprint(checkout: string, relative: string, budget: Budget): Promise<string> {
  if (!safeRelative(relative)) throw unavailable();
  if (relative.endsWith('/')) return 'nested-repository'; // A nested repository's files are not content of this checkout.
  const target = path.join(checkout, ...relative.split('/'));
  let before;
  try { before = await fs.lstat(target); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing'; throw unavailable(); }
  if (before.isSymbolicLink()) {
    try { return 'link:' + sha256(await fs.readlink(target)); }
    catch { throw unavailable(); }
  }
  if (!before.isFile()) return 'special';
  const hash = createHash('sha256');
  try {
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      if (!(await handle.stat()).isFile()) return 'special';
      for await (const chunk of handle.createReadStream({ autoClose: false }) as AsyncIterable<Buffer>) {
        budget.timeLeft();
        budget.consume(chunk.length);
        hash.update(chunk);
      }
    } finally { await handle.close(); }
  } catch (error) {
    if (error instanceof ReviewRevisionError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw unavailable();
  }
  return `${before.mode & 0o111 ? 'x' : '-'}:${hash.digest('hex')}`;
}

/**
 * Copies the index for a private, read-only measurement and gives the copy a timestamp that is never newer than the source.
 *
 * Git trusts an entry's cached stat data only while the entry is older than the index file ("racy git"): when the entry's
 * mtime is not older than the index file's mtime, a same-size edit made within the same timestamp could have escaped the
 * stat comparison, so Git compares content instead. A plain copy is dated now, which would make every entry look safely
 * older than the index and let a same-size edit with a restored mtime pass as unchanged. The copy therefore carries the
 * source's mtime floored to whole seconds; an older timestamp can only cause extra content comparisons, never hide a change.
 * The bytes and the timestamp are taken from one file version (one open handle, and the copy fails closed if that file
 * changed while it was read), so the timestamp always describes the bytes it accompanies.
 */
async function copyIndex(source: string, target: string): Promise<void> {
  try {
    const handle = await fs.open(source, constants.O_RDONLY);
    try {
      const before = await handle.stat({ bigint: true });
      const bytes = await handle.readFile();
      const after = await handle.stat({ bigint: true });
      if (!before.isFile() || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || BigInt(bytes.length) !== after.size) throw unavailable();
      await fs.writeFile(target, bytes);
      const seconds = Number(before.mtimeNs / 1_000_000_000n);
      await fs.utimes(target, seconds, seconds);
    } finally { await handle.close(); }
  } catch { throw unavailable(); }
}

/**
 * Computes the review revision of a managed worktree.
 *
 * The digest covers, in order: the HEAD commit; `git status --porcelain=v2` of every non-ignored path (staged, unstaged
 * and untracked); the binary diff of tracked content against HEAD; and the content of every untracked non-ignored file.
 * Paths ignored by git and the coordinator's generated runtime paths (see `generatedPathspecs`) are excluded, so
 * bookkeeping under `.heimdall/` can never invalidate or authorize anything. The work is bounded by one time and size
 * budget and fails with a `ReviewRevisionError` rather than returning a partial digest. Nothing is written.
 */
export async function computeReviewRevision(directory: string, options: ReviewRevisionOptions = {}): Promise<ReviewRevision> {
  const budget = new Budget(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.maxBytes ?? DEFAULT_MAX_BYTES);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const checkout = path.resolve(directory);
  const pathspec = ['--', '.', ...generatedPathspecs(options.roles)];
  const headOf = async (): Promise<string> => {
    const head = (await collect(checkout, ['rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}'], budget, undefined, 256)).toString('utf8').trim();
    if (!FULL_OID.test(head)) throw unavailable();
    return head;
  };

  const head = await headOf();
  const outer = createHash('sha256');
  const frame = (label: string, value: string | Buffer) => {
    outer.update(`${label}\0${Buffer.byteLength(value)}\0`);
    outer.update(value);
    outer.update('\0');
  };
  frame('format', FORMAT);
  frame('head', head);

  // `git status` and `git diff` refresh the index's stat cache and write it back even with optional locks disabled, which
  // could make an agent's own concurrent git command fail on index.lock. They run on a private copy of the index instead.
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-revision-'));
  let status: Buffer;
  try {
    const source = (await collect(checkout, ['rev-parse', '--path-format=absolute', '--git-path', 'index'], budget, undefined, 4096)).toString('utf8').replace(/\r?\n$/, '');
    await copyIndex(source, path.join(scratch, 'index'));
    const environment = { GIT_INDEX_FILE: path.join(scratch, 'index') };

    status = await collect(checkout, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--no-renames', ...pathspec], budget, undefined, STATUS_LIMIT, environment);
    frame('status', status);

    const diff = createHash('sha256');
    let diffBytes = 0;
    await git(checkout, [
      'diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--src-prefix=a/', '--dst-prefix=b/', 'HEAD', ...pathspec,
    ], budget, chunk => { diff.update(chunk); diffBytes += chunk.length; }, environment);
    frame('diff', `${diffBytes}:${diff.digest('hex')}`);
  } finally { await fs.rm(scratch, { recursive: true, force: true }); }

  const untracked = status.toString('utf8').split('\0').filter(entry => entry.startsWith('? ')).map(entry => entry.slice(2)).sort();
  if (untracked.length > maxFiles) throw new ReviewRevisionError('revision-too-large', 'The worktree has too many untracked files to measure as one review revision.');
  for (const relative of untracked) frame('untracked', `${relative}\0${await fingerprint(checkout, relative, budget)}`);

  // A commit made while the tree was being measured would mix two states; refuse instead of returning that mixture.
  if (await headOf() !== head) throw new ReviewRevisionError('revision-unavailable', 'The worktree changed while its review revision was measured.');
  return { head, digest: outer.digest('hex') };
}
