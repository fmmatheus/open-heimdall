import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ProjectIdentity, ProjectRecord, RunRecord, WorktreePlan } from './types.js';

const execute = promisify(execFile);
const validId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const validCommit = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const missing = (error: unknown): boolean => record(error) && error.code === 'ENOENT';

// An ambient repository override must not redirect a command away from its cwd.
// Read-only: GIT_OPTIONAL_LOCKS=0 keeps status/diff from refreshing (writing) the index.
export function gitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_NAMESPACE', 'GIT_CONFIG', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS']) delete environment[name];
  for (const name of Object.keys(environment)) if (/^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(name)) delete environment[name];
  return environment;
}

async function git(directory: string, args: string[]): Promise<string> {
  const { stdout } = await execute('git', args, { cwd: directory, encoding: 'utf8', env: gitEnvironment(), maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

const line = (value: string): string => value.replace(/\r?\n$/, '');
const canonical = (value: string): Promise<string> => fs.realpath(value);

/** Main and linked worktrees share one canonical repository identity. */
export async function inspectProject(directory: string): Promise<ProjectIdentity> {
  const selected = await canonical(directory);
  if (line(await git(selected, ['rev-parse', '--is-inside-work-tree'])) !== 'true') throw new Error('Register a non-bare Git worktree');
  const source = line(await git(selected, ['rev-parse', '--path-format=absolute', '--show-toplevel']));
  const common = line(await git(selected, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
  return { directory: await canonical(source), commonGitDirectory: await canonical(common) };
}

/** Resolve once at submission; creation later receives the full immutable OID. */
export async function resolveBaseCommit(directory: string, ref = 'HEAD'): Promise<string> {
  if (typeof ref !== 'string' || !ref.trim() || ref.includes('\0')) throw new Error('Provide a Git base revision');
  const commit = line(await git(directory, ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}']));
  if (!validCommit.test(commit)) throw new Error('Git did not resolve a full base commit');
  return commit;
}

function identifier(value: string): void {
  if (!validId.test(value)) throw new Error('Invalid managed project or run identifier');
}

export function planManagedWorktree({ root, projectId, runId }: { root: string; projectId: string; runId: string }): WorktreePlan {
  identifier(projectId);
  identifier(runId);
  if (typeof root !== 'string' || !root || root.includes('\0')) throw new Error('Provide a coordinator root');
  const namespacePath = path.resolve(root, 'worktrees', projectId, runId);
  return { namespacePath, worktreePath: path.join(namespacePath, 'checkout'), branch: 'heimdall/run/' + runId };
}

function reservation(project: ProjectRecord, run: RunRecord): WorktreePlan {
  identifier(project.id);
  identifier(run.id);
  if (run.projectId !== project.id) throw new Error('Run belongs to a different project');
  if (!validCommit.test(run.baseCommit)) throw new Error('Run must contain a pinned full Git commit');
  if (!path.isAbsolute(run.worktreePath) || path.resolve(run.worktreePath) !== run.worktreePath) throw new Error('Managed checkout path must be absolute and normalized');
  const namespacePath = path.dirname(run.worktreePath);
  const projectNamespace = path.dirname(namespacePath);
  if (path.basename(run.worktreePath) !== 'checkout' || path.basename(namespacePath) !== run.id || path.basename(projectNamespace) !== project.id || path.basename(path.dirname(projectNamespace)) !== 'worktrees' || run.branch !== 'heimdall/run/' + run.id) throw new Error('Worktree does not match its reserved managed namespace');
  return { namespacePath, worktreePath: run.worktreePath, branch: run.branch };
}

async function verifySource(project: ProjectRecord): Promise<void> {
  const actual = await inspectProject(project.directory);
  if (actual.directory !== await canonical(project.directory) || actual.commonGitDirectory !== project.commonGitDirectory) throw new Error('Registered project identity changed; reconcile it before running');
}

interface WorktreeEntry { directory: string; branch?: string; locked: boolean }
async function listedWorktrees(directory: string): Promise<WorktreeEntry[]> {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const field of (await git(directory, ['worktree', 'list', '--porcelain', '-z'])).split('\0')) {
    if (!field) { if (current) entries.push(current); current = undefined; continue; }
    if (field.startsWith('worktree ')) current = { directory: field.slice('worktree '.length), locked: false };
    else if (current && field.startsWith('branch ')) current.branch = field.slice('branch '.length);
    else if (current && (field === 'locked' || field.startsWith('locked '))) current.locked = true;
  }
  if (current) entries.push(current);
  return entries;
}

async function notPresent(value: string): Promise<void> {
  try { await fs.lstat(value); }
  catch (error) { if (missing(error)) return; throw error; }
  throw new Error('Managed namespace already exists; existing files and worktrees are never reused');
}

async function sameDirectory(left: string, right: string): Promise<boolean> {
  if (path.resolve(left) === path.resolve(right)) return true;
  try { return await canonical(left) === await canonical(right); }
  catch (error) { if (missing(error)) return false; throw error; }
}

/** Called only after the store has reserved this run and path. Never cleans up on failure. */
export async function createManagedWorktree({ project, run }: { project: ProjectRecord; run: RunRecord }): Promise<void> {
  const planned = reservation(project, run);
  await verifySource(project);
  if (await resolveBaseCommit(project.directory, run.baseCommit) !== run.baseCommit) throw new Error('Pinned base commit no longer resolves exactly');
  await notPresent(planned.namespacePath);
  for (const entry of await listedWorktrees(project.directory)) if (await sameDirectory(entry.directory, planned.worktreePath)) throw new Error('Checkout path is already in the Git worktree registry');
  await fs.mkdir(path.dirname(planned.namespacePath), { recursive: true, mode: 0o700 });
  // Exclusive mkdir refuses even an empty directory or dangling symlink. Its name is never recycled.
  await fs.mkdir(planned.namespacePath, { mode: 0o700 });
  await fs.writeFile(path.join(planned.namespacePath, 'owner.json'), JSON.stringify({ projectId: project.id, runId: run.id, commonGitDirectory: project.commonGitDirectory, branch: run.branch }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const emptyHooks = path.join(planned.namespacePath, 'empty-hooks');
  await fs.mkdir(emptyHooks, { mode: 0o700 });
  await notPresent(planned.worktreePath);
  await git(project.directory, ['-c', 'core.hooksPath=' + emptyHooks, 'worktree', 'add', '--lock', '--reason', 'Heimdall run ' + run.id, '-b', planned.branch, planned.worktreePath, run.baseCommit]);
  await verifyManagedWorktree({ project, run });
  if (await resolveBaseCommit(planned.worktreePath) !== run.baseCommit) throw new Error('New worktree does not match its pinned base commit');
}

/** Continuing the same run permits agent commits; identity, branch and ownership remain fixed. */
export async function verifyManagedWorktree({ project, run }: { project: ProjectRecord; run: RunRecord }): Promise<void> {
  const planned = reservation(project, run);
  await verifySource(project);
  for (const [value, kind] of [[planned.namespacePath, 'directory'], [planned.worktreePath, 'directory'], [path.join(planned.namespacePath, 'owner.json'), 'file']] as const) {
    const stat = await fs.lstat(value);
    if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) throw new Error('Managed ownership paths changed; reconciliation is required');
  }
  const owner: unknown = JSON.parse(await fs.readFile(path.join(planned.namespacePath, 'owner.json'), 'utf8'));
  if (!record(owner) || owner.projectId !== project.id || owner.runId !== run.id || owner.commonGitDirectory !== project.commonGitDirectory || owner.branch !== run.branch) throw new Error('Worktree ownership sidecar does not match the reserved run');
  const actual = await inspectProject(planned.worktreePath);
  if (actual.directory !== await canonical(planned.worktreePath) || actual.commonGitDirectory !== project.commonGitDirectory) throw new Error('Managed checkout belongs to a different Git project');
  const branch = line(await git(planned.worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD']));
  if (branch !== planned.branch) throw new Error('Managed checkout branch changed; reconciliation is required');
  const registry = await listedWorktrees(project.directory);
  for (const entry of registry) {
    if (!await sameDirectory(entry.directory, planned.worktreePath)) continue;
    if (entry.branch !== 'refs/heads/' + planned.branch || !entry.locked) throw new Error('Managed checkout no longer has its reserved branch and Git registry lock');
    return;
  }
  throw new Error('Managed checkout is missing from the Git worktree registry');
}
