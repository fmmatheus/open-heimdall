import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectProject, planManagedWorktree, createManagedWorktree, resolveBaseCommit } from '../dist/coordinator/worktrees.js';
import { reviewRun, reviewFile, readUntracked, ReviewRequestError, isGeneratedPath, validReviewPath } from '../dist/extension/service/review.js';
import { createExtensionServer, listenExtensionServer } from '../dist/extension/service/server.js';
import { CoordinatorAdapterError } from '../dist/extension/service/coordinator.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SECRET = 'owner-token-' + 'f00dfeed'.repeat(6);
const OMC_MARKER = 'omc-marker-' + 'badc0de5'.repeat(4);
const SERVICE_TOKEN = 'svc-' + 'c0ffee11'.repeat(8);
const CAP = 200000;

const environment = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_OPTIONAL_LOCKS: '0' };
for (const key of Object.keys(environment)) if (key.startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL', 'GIT_OPTIONAL_LOCKS'].includes(key)) delete environment[key];
const git = (directory, args) => execFileSync('git', args, { cwd: directory, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\r?\n$/, '');
const identity = ['-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid'];
const commitAll = (directory, message) => { git(directory, ['add', '-A']); git(directory, [...identity, 'commit', '-m', message]); };

const lines = (count, prefix) => Array.from({ length: count }, (_, index) => `${prefix} ${index}\n`).join('');

async function source(t) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hd-rv-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const repository = path.join(temporary, 'source');
  const state = path.join(temporary, 'state');
  await fs.mkdir(repository);
  await fs.mkdir(state);
  git(repository, ['init', '-b', 'main']);
  const base = {
    'README.md': 'readme\n', 'a.txt': 'alpha\n', 'staged.txt': 'staged base\n', 'unstaged.txt': 'unstaged base\n',
    'deleted.txt': 'to be deleted\nsecond line\n', 'big.txt': lines(20000, 'base line'),
  };
  for (const [name, content] of Object.entries(base)) await fs.writeFile(path.join(repository, name), content);
  await fs.writeFile(path.join(repository, 'bin.dat'), Buffer.from([0, 1, 2, 3, 0, 255]));
  await fs.mkdir(path.join(repository, '.omc'));
  await fs.writeFile(path.join(repository, '.omc', 'state.json'), '{"committed":true}\n');
  commitAll(repository, 'Base');
  const found = await inspectProject(repository);
  const project = { ...found, id: 'project-1', configPath: path.join(found.directory, '.heimdall.toml'), concurrency: 2, createdAt: Date.now() };
  return { temporary, repository, state, project, configuration: { stateDirectory: state }, baseCommit: await resolveBaseCommit(repository) };
}

/** A coordinator-shaped run (the public form: no owner token) with a real locked managed worktree. */
async function managedRun(f, id, { create = true, status = 'running' } = {}) {
  const planned = planManagedWorktree({ root: f.state, projectId: f.project.id, runId: id });
  const run = {
    id, projectId: f.project.id, feature: 'x', baseCommit: f.baseCommit, worktreePath: planned.worktreePath, branch: planned.branch,
    specification: {}, status, capacityReserved: true, ownerToken: 'synthetic-claim', version: 1, parentSessionId: '', promptMessageId: '',
    launchAction: 'start', resolution: null, checkpoint: null, binding: null, reason: null, createdAt: Date.now(), updatedAt: Date.now(),
    settings: { plannerAgent: 'adr-planner', executorAgent: 'adr-executor' },
  };
  if (create) await createManagedWorktree({ project: f.project, run });
  const { ownerToken, specification, binding, ...publicRun } = run;
  return publicRun;
}

async function snapshot(f, run) {
  const checkout = run.worktreePath;
  const indexFile = git(checkout, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  const stat = await fs.stat(indexFile);
  return {
    status: execFileSync('git', ['status', '--porcelain=v2', '-z', '--untracked-files=all'], { cwd: checkout, env: environment, encoding: 'utf8' }),
    head: git(checkout, ['rev-parse', 'HEAD']),
    branch: git(checkout, ['symbolic-ref', '--short', 'HEAD']),
    stash: git(checkout, ['stash', 'list']),
    index: (await fs.readFile(indexFile)).toString('base64'),
    indexMtime: stat.mtimeMs,
    indexInode: stat.ino,
    registry: git(f.repository, ['worktree', 'list', '--porcelain']),
    sourceHead: git(f.repository, ['rev-parse', 'HEAD']),
    refs: git(f.repository, ['for-each-ref']),
  };
}

/** Everything an agent could have left: commits, staged, unstaged, untracked, deleted, binary, large, generated, symlinks. */
async function populate(f, run) {
  const checkout = run.worktreePath;
  const write = (name, content) => fs.mkdir(path.dirname(path.join(checkout, name)), { recursive: true }).then(() => fs.writeFile(path.join(checkout, name), content));
  await write('a.txt', 'alpha\nbeta committed\n');
  await write('committed.txt', 'committed during the run\n');
  commitAll(checkout, 'Agent commit');
  await write('staged.txt', 'staged edit\n');
  git(checkout, ['add', 'staged.txt']);
  await write('stagednew.txt', 'new and staged\n');
  git(checkout, ['add', 'stagednew.txt']);
  await write('unstaged.txt', 'unstaged edit\n');
  await write('new.txt', 'untracked line 1\nuntracked line 2');
  await fs.rm(path.join(checkout, 'deleted.txt'));
  await fs.writeFile(path.join(checkout, 'bin.dat'), Buffer.from([0, 9, 9, 9, 0, 0]));
  await fs.writeFile(path.join(checkout, 'blob.bin'), Buffer.from([1, 2, 0, 3]));
  await write('big.txt', lines(20000, 'changed line'));
  await write('control.txt', '\u0001'.repeat(100000));
  await write('.opencode/agents/custom.md', 'a real feature agent\n');
  // Agent runtime metadata (never feature changes) next to genuine code, dotfiles and look-alike paths.
  await write('.omc/project-memory.json', JSON.stringify({ marker: OMC_MARKER }));
  await write('.omc/sessions/abc.json', JSON.stringify({ marker: OMC_MARKER }));
  await write('.omc/state.json', JSON.stringify({ committed: false, marker: OMC_MARKER }));
  await write('src/new-feature.ts', 'export const feature = 1;\n');
  await write('.eslintrc.json', '{}\n');
  await write('.omcx', 'not runtime\n');
  await write('docs/.omc/note.md', 'nested look-alike\n');
  // Generated runtime artifacts.
  await write('.heimdall/managed.json', JSON.stringify({ ownerToken: SECRET }));
  await write('.heimdall/feature.md', 'feature body');
  await write('.heimdall/state/x.json', '{}');
  await write('.opencode/plugins/heimdall.ts', 'export default {};\n');
  for (const name of ['adr-orchestrator', 'adr-planner', 'adr-executor']) await write(`.opencode/agents/${name}.md`, 'generated agent\n');
  await fs.chmod(path.join(checkout, '.heimdall', 'managed.json'), 0);
  // Symlinks that point outside the checkout.
  const outside = path.join(f.temporary, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'secret.txt'), 'OUTSIDE SECRET CONTENT');
  await fs.symlink(outside, path.join(checkout, 'linkdir'));
  await fs.symlink(path.join(outside, 'secret.txt'), path.join(checkout, 'linkfile'));
  return outside;
}

const paths = entries => entries.map(entry => entry.path);
const changes = entries => Object.fromEntries(entries.map(entry => [entry.path, entry.change]));

test('review lists committed, staged, unstaged and untracked changes against the base commit', async t => {
  const f = await source(t);
  const run = await managedRun(f, 'run-main');
  await populate(f, run);
  const review = await reviewRun(run, f.project, f.configuration);

  assert.equal(review.state, 'ready');
  assert.equal(review.message, null);
  assert.equal(review.baseCommit, f.baseCommit);
  assert.equal(review.branch, 'heimdall/run/run-main');
  assert.equal(review.head, git(run.worktreePath, ['rev-parse', 'HEAD']));
  assert.notEqual(review.head, f.baseCommit);
  assert.deepEqual(changes(review.files), {
    'a.txt': 'modified', 'bin.dat': 'modified', 'big.txt': 'modified', 'blob.bin': 'untracked', 'committed.txt': 'added', 'control.txt': 'untracked',
    'deleted.txt': 'deleted', 'linkdir': 'untracked', 'linkfile': 'untracked', 'new.txt': 'untracked', 'staged.txt': 'modified', 'stagednew.txt': 'added',
    'unstaged.txt': 'modified', '.opencode/agents/custom.md': 'untracked',
    'src/new-feature.ts': 'untracked', '.eslintrc.json': 'untracked', '.omcx': 'untracked', 'docs/.omc/note.md': 'untracked',
  });
  assert.deepEqual(paths(review.files), [...paths(review.files)].sort());
  const byName = Object.fromEntries(review.files.map(entry => [entry.path, entry]));
  assert.equal(byName['a.txt'].additions, 1);
  assert.equal(byName['a.txt'].deletions, 0);
  assert.equal(byName['unstaged.txt'].additions, 1);
  assert.equal(byName['unstaged.txt'].deletions, 1);
  assert.equal(byName['bin.dat'].binary, true);
  assert.equal(byName['bin.dat'].additions, null);
  assert.equal(byName['new.txt'].size, 'untracked line 1\nuntracked line 2'.length);
  assert.equal(byName['deleted.txt'].deletions, 2);
  assert.equal(review.counts.files, 18);
  assert.equal(review.counts.binary, 1);
  assert.equal(review.truncated, false);
  assert.ok(Buffer.byteLength(JSON.stringify(review)) < CAP);

  // Generated runtime artifacts are grouped apart and never presented as feature code.
  assert.deepEqual(paths(review.generated), [
    '.heimdall/feature.md', '.heimdall/managed.json', '.heimdall/state/x.json', '.omc/project-memory.json', '.omc/sessions/abc.json', '.omc/state.json',
    '.opencode/agents/adr-executor.md', '.opencode/agents/adr-orchestrator.md', '.opencode/agents/adr-planner.md', '.opencode/plugins/heimdall.ts',
  ]);
  assert.equal(review.counts.generated, 10);
  // The runtime group never leaks into feature counts, and the tracked-then-edited runtime file has no line counts.
  assert.ok(!paths(review.files).some(name => name === '.omc' || name.startsWith('.omc/')));
  assert.ok(byName['src/new-feature.ts'] && byName['.eslintrc.json'] && byName['.omcx'] && byName['docs/.omc/note.md']);
  assert.equal(review.counts.additions, review.files.reduce((sum, entry) => sum + (entry.additions ?? 0), 0));
  assert.ok(!JSON.stringify(review).includes(OMC_MARKER), 'runtime contents are never relayed');
  for (const entry of review.files) assert.equal(isGeneratedPath(entry.path, run.settings), false, entry.path);
  assert.ok(review.generated.every(entry => entry.additions === null && entry.binary === null));

  // Neither the secret nor the worktree location is relayed.
  const text = JSON.stringify(review);
  assert.ok(!text.includes(SECRET));
  assert.ok(!text.includes(f.state));
  assert.ok(!text.includes(run.worktreePath));
});

test('isGeneratedPath treats only top-level .omc as runtime metadata', () => {
  const settings = { plannerAgent: 'adr-planner', executorAgent: 'adr-executor' };
  for (const name of ['.omc', '.omc/', '.omc/project-memory.json', '.omc/sessions/abc.json', '.omc/state.json', '.omc/a/b/c', '.heimdall', '.heimdall/managed.json', '.opencode/plugins/heimdall.ts', '.opencode/agents/adr-planner.md']) {
    assert.equal(isGeneratedPath(name, settings), true, name);
  }
  for (const name of ['.omcx', '.omc-x/y', '.omcx/y', 'foo/.omc/x', 'docs/.omc/note.md', 'src/a.omc', 'omc/x', 'src/.omc', '.eslintrc.json', '.gitignore', '.github/workflows/ci.yml', '.opencode/agents/custom.md', '.opencode/plugins/other.ts', 'src/new-feature.ts', '.heimdallx']) {
    assert.equal(isGeneratedPath(name, settings), false, name);
  }
});

test('a clean working tree still shows the commits the run made', async t => {
  const f = await source(t);
  const run = await managedRun(f, 'run-clean');
  await fs.writeFile(path.join(run.worktreePath, 'a.txt'), 'alpha\nfrom a commit\n');
  await fs.writeFile(path.join(run.worktreePath, 'added.txt'), 'added in a commit\n');
  await fs.rm(path.join(run.worktreePath, 'deleted.txt'));
  await fs.writeFile(path.join(run.worktreePath, '.omc', 'state.json'), `{"edited":"${OMC_MARKER}"}\n`);
  await fs.mkdir(path.join(run.worktreePath, '.omc', 'sessions'));
  await fs.writeFile(path.join(run.worktreePath, '.omc', 'sessions', 'abc.json'), OMC_MARKER);
  commitAll(run.worktreePath, 'Only commits');
  assert.equal(git(run.worktreePath, ['status', '--porcelain']), '', 'working tree is clean');
  const review = await reviewRun(run, f.project, f.configuration);
  assert.equal(review.state, 'ready');
  assert.deepEqual(changes(review.files), { 'a.txt': 'modified', 'added.txt': 'added', 'deleted.txt': 'deleted' });
  assert.equal(review.counts.files, 3);
  assert.deepEqual(changes(review.generated), { '.omc/sessions/abc.json': 'added', '.omc/state.json': 'modified' });
  assert.equal(review.counts.generated, 2);
  assert.ok(!JSON.stringify(review).includes(OMC_MARKER));
  const runtimeFile = await reviewFile(run, f.project, f.configuration, '.omc/state.json');
  assert.equal(runtimeFile.view, 'generated');
  assert.equal(runtimeFile.text, '');

  const file = await reviewFile(run, f.project, f.configuration, 'a.txt');
  assert.equal(file.view, 'diff');
  assert.match(file.text, /\+from a commit/);

  // A fresh worktree with no change at all lists nothing.
  const fresh = await managedRun(f, 'run-untouched');
  const none = await reviewRun(fresh, f.project, f.configuration);
  assert.equal(none.state, 'ready');
  assert.deepEqual(none.files, []);
  assert.equal(none.head, f.baseCommit);
});

test('per-file diffs are bounded and expose binary, deleted, large and unsupported states', async t => {
  const f = await source(t);
  const run = await managedRun(f, 'run-files');
  await populate(f, run);
  const open = name => reviewFile(run, f.project, f.configuration, name);

  const committed = await open('a.txt');
  assert.equal(committed.state, 'ready');
  assert.equal(committed.view, 'diff');
  assert.equal(committed.change, 'modified');
  assert.match(committed.text, /^diff --git a\/a\.txt b\/a\.txt/m);
  assert.match(committed.text, /\+beta committed/);
  assert.equal(committed.large, false);
  assert.equal(committed.truncated, false);
  assert.equal(committed.additions, 1);

  assert.match((await open('staged.txt')).text, /\+staged edit/);
  assert.match((await open('stagednew.txt')).text, /\+new and staged/);
  const unstaged = await open('unstaged.txt');
  assert.match(unstaged.text, /-unstaged base/);
  assert.match(unstaged.text, /\+unstaged edit/);

  const untracked = await open('new.txt');
  assert.equal(untracked.view, 'diff');
  assert.equal(untracked.change, 'untracked');
  assert.match(untracked.text, /^--- \/dev\/null$/m);
  assert.match(untracked.text, /^@@ -0,0 \+1,2 @@$/m);
  assert.match(untracked.text, /^\+untracked line 1$/m);
  assert.match(untracked.text, /^\+untracked line 2$/m);
  assert.match(untracked.text, /No newline at end of file/);
  assert.equal(untracked.additions, 2);

  const deleted = await open('deleted.txt');
  assert.equal(deleted.view, 'deleted');
  assert.equal(deleted.change, 'deleted');
  assert.match(deleted.text, /^-to be deleted$/m);

  const trackedBinary = await open('bin.dat');
  assert.equal(trackedBinary.view, 'binary');
  assert.equal(trackedBinary.binary, true);
  assert.equal(trackedBinary.text, '');
  const untrackedBinary = await open('blob.bin');
  assert.equal(untrackedBinary.view, 'binary');
  assert.equal(untrackedBinary.binary, true);
  assert.equal(untrackedBinary.text, '');
  assert.equal(untrackedBinary.size, 4);

  const large = await open('big.txt');
  assert.equal(large.view, 'diff');
  assert.equal(large.large, true);
  assert.equal(large.truncated, true);
  assert.ok(Buffer.byteLength(large.text) <= 64 * 1024);
  assert.ok(Buffer.byteLength(large.text) > 60 * 1024);
  assert.match(large.text, /^diff --git a\/big\.txt/);
  assert.ok(Buffer.byteLength(JSON.stringify(large)) < CAP);

  // 100000 control characters escape to six bytes each in JSON; the response is still shrunk under the cap.
  const control = await open('control.txt');
  assert.equal(control.view, 'diff');
  assert.equal(control.large, true);
  assert.equal(control.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(control)) <= 150000);
  assert.ok(Buffer.byteLength(JSON.stringify(control)) < CAP);

  // Generated artifacts expose no contents at all.
  for (const name of ['.heimdall/managed.json', '.heimdall/feature.md', '.opencode/plugins/heimdall.ts', '.opencode/agents/adr-planner.md', '.omc/project-memory.json', '.omc/sessions/abc.json', '.omc/state.json']) {
    const generated = await open(name);
    assert.equal(generated.view, 'generated', name);
    assert.equal(generated.text, '', name);
    assert.ok(!JSON.stringify(generated).includes(OMC_MARKER), name);
  }
  // Look-alikes and ordinary code are feature files with real diffs.
  assert.match((await open('src/new-feature.ts')).text, /\+export const feature = 1;/);
  assert.equal((await open('.eslintrc.json')).view, 'diff');
  assert.equal((await open('.omcx')).view, 'diff');
  assert.equal((await open('docs/.omc/note.md')).view, 'diff');
  assert.ok(!JSON.stringify(await open('.heimdall/managed.json')).includes(SECRET));
});

test('untracked reads never follow symlinks and report vanished files as missing', async t => {
  const f = await source(t);
  const run = await managedRun(f, 'run-symlinks');
  const outside = await populate(f, run);
  const checkout = run.worktreePath;

  for (const name of ['linkfile', 'linkdir']) {
    const linked = await reviewFile(run, f.project, f.configuration, name);
    assert.equal(linked.view, 'unsupported', name);
    assert.equal(linked.text, '');
    assert.ok(!JSON.stringify(linked).includes('OUTSIDE SECRET CONTENT'));
  }
  // Reaching through a symlinked directory is not a listed path and is refused.
  for (const name of ['linkdir/secret.txt', 'linkfile/x']) {
    await assert.rejects(reviewFile(run, f.project, f.configuration, name), ReviewRequestError, name);
  }

  // Direct engine checks for races the listing cannot produce on demand.
  assert.deepEqual(await readUntracked(checkout, 'does-not-exist.txt'), { view: 'missing', text: '', binary: false, large: false, size: null, additions: null });
  assert.equal((await readUntracked(checkout, 'linkdir/secret.txt')).view, 'unsupported');
  assert.equal((await readUntracked(checkout, 'linkfile')).view, 'unsupported');
  assert.ok(!JSON.stringify(await readUntracked(checkout, 'linkdir/secret.txt')).includes('OUTSIDE SECRET'));
  assert.equal((await readUntracked(checkout, 'unstaged.txt')).view, 'diff', 'a regular file reads normally');
  await fs.mkdir(path.join(checkout, 'a-directory'));
  assert.equal((await readUntracked(checkout, 'a-directory')).view, 'unsupported');
  assert.ok((await fs.readFile(path.join(outside, 'secret.txt'), 'utf8')).startsWith('OUTSIDE'));
});

test('only listed repository-relative paths are accepted', async t => {
  const f = await source(t);
  const run = await managedRun(f, 'run-paths');
  await populate(f, run);
  const attempts = ['../x', '..', 'a/../b', './a.txt', 'a//b', '/etc/passwd', '/', '', 'x\0y', '.heimdall/../a.txt', 'a.txt/', 'README.md', 'nope.txt', 'linkdir/secret.txt', 'a.txt/../README.md', '*', ':(glob)**', 'a'.repeat(2000), undefined, 7, null];
  for (const attempt of attempts) await assert.rejects(reviewFile(run, f.project, f.configuration, attempt), ReviewRequestError, JSON.stringify(attempt));
  assert.equal(validReviewPath('src/ok.txt'), true);
  assert.equal(validReviewPath('src/../ok.txt'), false);

  // Syntax is rejected before any filesystem access: it works even when no worktree exists at all.
  const gone = await managedRun(f, 'run-gone', { create: false, status: 'running' });
  for (const attempt of ['../x', '/etc/passwd', 'x\0y', '']) await assert.rejects(reviewFile(gone, f.project, f.configuration, attempt), ReviewRequestError, JSON.stringify(attempt));
  // A pathspec-looking name that is not a changed file is not a wildcard.
  await assert.rejects(reviewFile(run, f.project, f.configuration, '*.txt'), ReviewRequestError);
});

test('missing, queued and mismatched worktrees produce explicit states', async t => {
  const f = await source(t);
  const states = async (run, project = f.project, configuration = f.configuration) => {
    const review = await reviewRun(run, project, configuration);
    const file = await reviewFile(run, project, configuration, 'a.txt').catch(error => { throw new Error(`${run.id} ${run.status} ${review.state}: ${error.message}`); });
    assert.equal(file.state, review.state);
    assert.equal(review.files.length, 0);
    assert.equal(review.generated.length, 0);
    assert.equal(review.head, null);
    assert.equal(typeof review.message, 'string');
    assert.equal(file.view, null);
    assert.equal(file.text, '');
    const text = JSON.stringify([review, file]);
    assert.ok(!text.includes(f.state), 'no worktree location in a state response');
    return review.state;
  };

  assert.equal(await states(await managedRun(f, 'run-queued', { create: false, status: 'queued' })), 'queued-no-worktree');
  assert.equal(await states(await managedRun(f, 'run-preparing', { create: false, status: 'preparing' })), 'queued-no-worktree');
  assert.equal(await states(await managedRun(f, 'run-lost', { create: false, status: 'running' })), 'worktree-missing');
  assert.equal(await states(await managedRun(f, 'run-lost-failed', { create: false, status: 'failed' })), 'worktree-missing');

  const good = await managedRun(f, 'run-good');
  assert.equal((await reviewRun(good, f.project, f.configuration)).state, 'ready');

  assert.equal(await states({ ...good, worktreePath: path.join(f.temporary, 'elsewhere', 'checkout') }), 'worktree-mismatch');
  assert.equal(await states({ ...good, worktreePath: f.repository }), 'worktree-mismatch');
  assert.equal(await states({ ...good, worktreePath: 'relative/checkout' }), 'worktree-mismatch');
  assert.equal(await states({ ...good, branch: 'heimdall/run/other' }), 'worktree-mismatch');
  assert.equal(await states({ ...good, branch: 'main' }), 'worktree-mismatch');
  assert.equal(await states({ ...good, baseCommit: 'abc123' }), 'worktree-mismatch');
  assert.equal(await states({ ...good, baseCommit: 'HEAD' }), 'worktree-mismatch');
  assert.equal(await states({ ...good, baseCommit: '0'.repeat(40) }), 'worktree-mismatch', 'a full OID that is not in the repository');
  assert.equal(await states({ ...good, id: 'run-other' }), 'worktree-mismatch');
  assert.equal(await states({ ...good, projectId: 'project-2' }), 'worktree-mismatch');
  assert.equal(await states(good, null), 'worktree-mismatch');
  assert.equal(await states(good, { ...f.project, id: 'project-2' }), 'worktree-mismatch');
  assert.equal(await states(good, f.project, { stateDirectory: path.join(f.temporary, 'other-state') }), 'worktree-mismatch');
  assert.equal(await states(good, { ...f.project, commonGitDirectory: path.join(f.temporary, 'not-a-git-dir') }), 'worktree-mismatch');

  // The checkout was swapped for a symlink to a real directory.
  const swapped = await managedRun(f, 'run-swapped');
  await fs.rename(swapped.worktreePath, swapped.worktreePath + '.real');
  await fs.symlink(swapped.worktreePath + '.real', swapped.worktreePath);
  assert.equal(await states(swapped), 'worktree-mismatch');

  // The agent switched the managed checkout to another branch.
  const switched = await managedRun(f, 'run-switched');
  git(switched.worktreePath, ['checkout', '-b', 'something-else']);
  assert.equal(await states(switched), 'worktree-mismatch');

  // The checkout path exists but is a plain directory, not a registered worktree.
  const plain = await managedRun(f, 'run-plain', { create: false });
  await fs.mkdir(plain.worktreePath, { recursive: true });
  assert.equal(await states(plain), 'worktree-mismatch');

  // A plain file where the checkout belongs.
  const file = await managedRun(f, 'run-file', { create: false });
  await fs.mkdir(path.dirname(file.worktreePath), { recursive: true });
  await fs.writeFile(file.worktreePath, 'not a directory');
  assert.equal(await states(file), 'worktree-mismatch');
});

test('a list longer than 500 entries is capped and flagged', async t => {
  const f = await source(t);
  const run = await managedRun(f, 'run-many');
  await fs.mkdir(path.join(run.worktreePath, 'many'));
  for (let index = 0; index < 600; index++) await fs.writeFile(path.join(run.worktreePath, 'many', `f${String(index).padStart(4, '0')}.txt`), `${index}\n`);
  const review = await reviewRun(run, f.project, f.configuration);
  assert.equal(review.files.length, 500);
  assert.equal(review.counts.files, 600);
  assert.equal(review.truncated, true);
  assert.equal(review.files[0].path, 'many/f0000.txt');
  assert.ok(Buffer.byteLength(JSON.stringify(review)) < CAP);
  const capped = await reviewRun(run, f.project, f.configuration, { maxFiles: 5 });
  assert.equal(capped.files.length, 5);
  assert.equal(capped.truncated, true);
});

test('reviews leave status, HEAD, branch, index, stash list and worktree registry untouched', async t => {
  const f = await source(t);
  const run = await managedRun(f, 'run-snapshot');
  await populate(f, run);
  // Move time forward so a rewritten index would have a different mtime.
  await new Promise(resolve => setTimeout(resolve, 30));
  const before = await snapshot(f, run);
  const files = (await reviewRun(run, f.project, f.configuration)).files;
  for (let round = 0; round < 2; round++) {
    await reviewRun(run, f.project, f.configuration);
    for (const entry of files) await reviewFile(run, f.project, f.configuration, entry.path);
    for (const name of ['.heimdall/managed.json', '.opencode/plugins/heimdall.ts', '.omc/project-memory.json', '.omc/sessions/abc.json', '.omc/state.json']) await reviewFile(run, f.project, f.configuration, name);
  }
  await assert.rejects(reviewFile(run, f.project, f.configuration, 'README.md'), ReviewRequestError);
  const after = await snapshot(f, run);
  assert.deepEqual(after, before);
  assert.ok(!(await fs.readdir(path.dirname(git(run.worktreePath, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])))).some(name => name.endsWith('.lock')), 'no lock files left behind');
});

test('the review module issues only read-only git commands and never opens runtime files', async () => {
  const text = await fs.readFile(path.join(root, 'src', 'extension', 'service', 'review.ts'), 'utf8');
  const code = text.split('\n').filter(line => !line.trim().startsWith('*') && !line.trim().startsWith('//') && !line.trim().startsWith('/*')).join('\n');
  assert.doesNotMatch(code, /['"](add|commit|reset|switch|merge|stash|clean|rm|update-index|restore|apply|worktree|gc|prune|config|fetch|pull|push)['"]/);
  assert.doesNotMatch(code, /managed\.json/);
  assert.doesNotMatch(code, /\.git\/|writeFile|appendFile|unlink|fs\.rename|chmod|mkdir|rmdir|copyFile|symlink\(/);
  assert.match(code, /--no-ext-diff/);
  assert.match(code, /--no-textconv/);
  assert.match(code, /--no-color/);
  assert.match(code, /--literal-pathspecs/);
  assert.match(code, /core\.quotepath=off/);
  assert.match(code, /gitEnvironment/);
  const worktrees = await fs.readFile(path.join(root, 'src', 'coordinator', 'worktrees.ts'), 'utf8');
  assert.match(worktrees, /export function gitEnvironment/);
  assert.match(worktrees, /GIT_OPTIONAL_LOCKS: '0'/);
});

/** Raw request so query strings are sent byte for byte. */
function call(server, target, { token = SERVICE_TOKEN } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: server.address().port, method: 'GET', path: target, headers: token ? { Authorization: `Bearer ${token}` } : {} }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: response.statusCode, text, json });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

async function serve(t, f, runs) {
  const calls = [];
  const adapter = {
    async projects() { calls.push('projects'); return [f.project]; },
    async runs() { return runs; },
    async run(id) {
      calls.push(`run:${id}`);
      const found = runs.find(run => run.id === id);
      if (!found) throw new CoordinatorAdapterError('not-found');
      return found;
    },
    async events() { return []; },
  };
  const server = await listenExtensionServer(createExtensionServer({ token: SERVICE_TOKEN, adapter, loadConfiguration: async () => f.configuration }), 0);
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return { server, calls };
}

test('review routes return bounded responses and refuse bad paths', async t => {
  const f = await source(t);
  const run = await managedRun(f, 'run-route');
  await populate(f, run);
  const queued = await managedRun(f, 'run-route-queued', { create: false, status: 'queued' });
  const { server, calls } = await serve(t, f, [run, queued]);
  const before = await snapshot(f, run);

  assert.equal((await call(server, '/runs/run-route/review', { token: null })).status, 401);
  const list = await call(server, '/runs/run-route/review');
  assert.equal(list.status, 200);
  assert.ok(Buffer.byteLength(list.text) < CAP);
  assert.equal(list.json.state, 'ready');
  assert.equal(list.json.baseCommit, f.baseCommit);
  assert.equal(list.json.branch, 'heimdall/run/run-route');
  assert.equal(list.json.files.length, 18);
  assert.equal(list.json.generated.length, 10);
  for (const text of [list.text]) {
    assert.ok(!text.includes(SECRET));
    assert.ok(!text.includes(OMC_MARKER));
    assert.ok(!text.includes(f.state));
    assert.ok(!text.includes(run.worktreePath));
    assert.ok(!text.includes('worktreePath'));
  }

  for (const name of ['a.txt', 'new.txt', 'deleted.txt', 'bin.dat', 'big.txt', 'control.txt', '.heimdall/managed.json', '.omc/project-memory.json', '.omc/sessions/abc.json', '.omc/state.json']) {
    const file = await call(server, `/runs/run-route/review/file?path=${encodeURIComponent(name)}`);
    assert.equal(file.status, 200, name);
    assert.ok(!file.text.includes(OMC_MARKER), name);
    if (name.startsWith('.omc/')) { assert.equal(file.json.view, 'generated', name); assert.equal(file.json.text, '', name); }
    assert.ok(Buffer.byteLength(file.text) < CAP, name);
    assert.equal(file.json.path, name);
    assert.ok(!file.text.includes(SECRET));
    assert.ok(!file.text.includes(run.worktreePath));
  }
  assert.equal((await call(server, '/runs/run-route/review/file?path=big.txt')).json.large, true);

  const refused = [
    '/runs/run-route/review/file', '/runs/run-route/review/file?path=', '/runs/run-route/review/file?path=..%2Fx', '/runs/run-route/review/file?path=%2Fetc%2Fpasswd',
    '/runs/run-route/review/file?path=a%00b', '/runs/run-route/review/file?path=README.md', '/runs/run-route/review/file?path=linkdir%2Fsecret.txt',
    '/runs/run-route/review/file?path=a.txt&path=new.txt', '/runs/run-route/review/file?path=.%2Fa.txt', '/runs/run-route/review/file?path=a%2F..%2Fb',
  ];
  for (const target of refused) {
    const response = await call(server, target);
    assert.equal(response.status, 400, target);
    assert.equal(response.json.error.kind, 'invalid-request');
  }
  assert.ok(!calls.some(entry => entry === 'run:../x'));

  const link = await call(server, '/runs/run-route/review/file?path=linkfile');
  assert.equal(link.json.view, 'unsupported');
  assert.ok(!link.text.includes('OUTSIDE SECRET'));

  // Unknown run, odd run id and non-GET methods.
  assert.equal((await call(server, '/runs/run-unknown/review')).status, 404);
  assert.equal((await call(server, '/runs/run-unknown/review/file?path=a.txt')).status, 404);
  assert.equal((await call(server, '/runs/..%2Fx/review')).status, 404);
  const waiting = await call(server, '/runs/run-route-queued/review');
  assert.equal(waiting.status, 200);
  assert.equal(waiting.json.state, 'queued-no-worktree');
  assert.equal((await call(server, '/runs/run-route-queued/review/file?path=a.txt')).json.state, 'queued-no-worktree');

  assert.deepEqual(await snapshot(f, run), before);
});

test('a broken coordinator configuration yields a sanitized 503, not a crash', async t => {
  const f = await source(t);
  const run = await managedRun(f, 'run-config');
  const adapter = { async projects() { return [f.project]; }, async runs() { return [run]; }, async run() { return run; }, async events() { return []; } };
  const server = await listenExtensionServer(createExtensionServer({ token: SERVICE_TOKEN, adapter, loadConfiguration: async () => { throw new Error('secret path ' + f.state); } }), 0);
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const response = await call(server, '/runs/run-config/review');
  assert.equal(response.status, 503);
  assert.equal(response.json.error.kind, 'configuration-invalid');
  assert.ok(!response.text.includes(f.state));
});
