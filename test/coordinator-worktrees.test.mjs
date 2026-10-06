import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectProject, resolveBaseCommit, planManagedWorktree, createManagedWorktree, verifyManagedWorktree } from '../dist/coordinator/worktrees.js';

const environment = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' };
for (const key of Object.keys(environment)) if (key.startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL'].includes(key)) delete environment[key];
const git = (directory, args) => execFileSync('git', args, { cwd: directory, env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\r?\n$/, '');
const commit = directory => git(directory, ['-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture commit']);

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall worktree fixture '));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'source');
  await fs.mkdir(source);
  git(source, ['init', '-b', 'main']);
  await fs.writeFile(path.join(source, 'feature.md'), 'Synthetic feature');
  git(source, ['add', 'feature.md']);
  commit(source);
  const identity = await inspectProject(source);
  const project = { ...identity, id: 'project-1', configPath: path.join(identity.directory, '.heimdall.toml'), concurrency: 2, createdAt: Date.now() };
  const root = path.join(temporary, 'managed coordinator');
  return { temporary, source, root, project, baseCommit: await resolveBaseCommit(source) };
}

function run(f, id = 'run-1') {
  const planned = planManagedWorktree({ root: f.root, projectId: f.project.id, runId: id });
  return { id, projectId: f.project.id, feature: 'feature.md', baseCommit: f.baseCommit, worktreePath: planned.worktreePath, branch: planned.branch, specification: {}, status: 'preparing', capacityReserved: true, ownerToken: 'synthetic-claim', version: 1, parentSessionId: '', promptMessageId: '', launchAction: 'start', resolution: null, checkpoint: null, binding: null, reason: null, createdAt: Date.now(), updatedAt: Date.now() };
}

test('project identity is canonical and shared by nested paths and linked worktrees', async t => {
  const f = await fixture(t);
  const linked = path.join(f.temporary, 'existing linked');
  git(f.source, ['worktree', 'add', '--detach', linked, f.baseCommit]);
  await fs.mkdir(path.join(linked, 'nested'));
  const identity = await inspectProject(path.join(linked, 'nested'));
  assert.equal(identity.commonGitDirectory, f.project.commonGitDirectory);
  assert.equal(identity.directory, await fs.realpath(linked));
  assert.equal(await resolveBaseCommit(linked), f.baseCommit);
});

test('submission pins a commit even when the source branch moves before worktree creation', async t => {
  const f = await fixture(t);
  const queued = run(f);
  await fs.writeFile(path.join(f.source, 'feature.md'), 'Source moved after submission');
  git(f.source, ['add', 'feature.md']);
  commit(f.source);
  const moved = await resolveBaseCommit(f.source);
  assert.notEqual(moved, queued.baseCommit);
  await createManagedWorktree({ project: f.project, run: queued });
  assert.equal(await resolveBaseCommit(queued.worktreePath), queued.baseCommit);
  assert.equal(await fs.readFile(path.join(queued.worktreePath, 'feature.md'), 'utf8'), 'Synthetic feature');
  assert.equal(await resolveBaseCommit(f.source), moved, 'creation does not reset source HEAD');
  const owner = JSON.parse(await fs.readFile(path.join(path.dirname(queued.worktreePath), 'owner.json'), 'utf8'));
  assert.deepEqual(owner, { projectId: f.project.id, runId: queued.id, commonGitDirectory: f.project.commonGitDirectory, branch: queued.branch });
});

test('concurrent identical reservations can create only one managed namespace', async t => {
  const f = await fixture(t);
  const owned = run(f);
  const attempts = await Promise.allSettled([createManagedWorktree({ project: f.project, run: owned }), createManagedWorktree({ project: f.project, run: owned })]);
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(attempts.filter(result => result.status === 'rejected').length, 1);
  await verifyManagedWorktree({ project: f.project, run: owned });
  await assert.rejects(createManagedWorktree({ project: f.project, run: owned }), /already exists/);
});

test('distinct runs create separate locked branches and preserve independent edits', async t => {
  const f = await fixture(t);
  const first = run(f, 'run-first');
  const second = run(f, 'run-second');
  await Promise.all([createManagedWorktree({ project: f.project, run: first }), createManagedWorktree({ project: f.project, run: second })]);
  await fs.writeFile(path.join(first.worktreePath, 'private-edit.txt'), 'First run edit');
  assert.equal(await fs.readFile(path.join(first.worktreePath, 'private-edit.txt'), 'utf8'), 'First run edit');
  await assert.rejects(fs.access(path.join(second.worktreePath, 'private-edit.txt')), { code: 'ENOENT' });
  assert.equal(git(first.worktreePath, ['branch', '--show-current']), first.branch);
  assert.equal(git(second.worktreePath, ['branch', '--show-current']), second.branch);
  await verifyManagedWorktree({ project: f.project, run: first });
  await verifyManagedWorktree({ project: f.project, run: second });
});

test('existing empty namespaces and unmanaged worktrees are never adopted or altered', async t => {
  const f = await fixture(t);
  const empty = run(f, 'run-empty');
  await fs.mkdir(path.dirname(empty.worktreePath), { recursive: true });
  await assert.rejects(createManagedWorktree({ project: f.project, run: empty }), /already exists/);
  assert.deepEqual(await fs.readdir(path.dirname(empty.worktreePath)), []);
  const existing = run(f, 'run-existing');
  await fs.mkdir(path.dirname(existing.worktreePath), { recursive: true });
  git(f.source, ['worktree', 'add', '-b', 'user-work', existing.worktreePath, f.baseCommit]);
  await fs.writeFile(path.join(existing.worktreePath, 'keep.txt'), 'Existing work');
  await assert.rejects(createManagedWorktree({ project: f.project, run: existing }), /already exists/);
  assert.equal(await fs.readFile(path.join(existing.worktreePath, 'keep.txt'), 'utf8'), 'Existing work');
  assert.equal(git(existing.worktreePath, ['branch', '--show-current']), 'user-work');
  await assert.rejects(fs.access(path.join(path.dirname(existing.worktreePath), 'owner.json')), { code: 'ENOENT' });
});

test('a conflicting existing branch is retained with its edits and failed namespace', async t => {
  const f = await fixture(t);
  const owned = run(f);
  git(f.source, ['branch', owned.branch, f.baseCommit]);
  await fs.writeFile(path.join(f.source, 'keep-dirty.txt'), 'Source edits');
  await assert.rejects(createManagedWorktree({ project: f.project, run: owned }));
  assert.equal(git(f.source, ['rev-parse', '--verify', 'refs/heads/' + owned.branch]), f.baseCommit);
  assert.equal(await fs.readFile(path.join(f.source, 'keep-dirty.txt'), 'utf8'), 'Source edits');
  await fs.access(path.join(path.dirname(owned.worktreePath), 'owner.json'));
  await assert.rejects(createManagedWorktree({ project: f.project, run: owned }), /already exists/);
});

test('continuation permits run commits and dirty files while enforcing branch and registry lock', async t => {
  const f = await fixture(t);
  const owned = run(f);
  await createManagedWorktree({ project: f.project, run: owned });
  await fs.writeFile(path.join(owned.worktreePath, 'feature.md'), 'Agent committed result');
  git(owned.worktreePath, ['add', 'feature.md']);
  commit(owned.worktreePath);
  assert.notEqual(await resolveBaseCommit(owned.worktreePath), owned.baseCommit);
  await fs.writeFile(path.join(owned.worktreePath, 'retained.txt'), 'Uncommitted follow-up');
  await verifyManagedWorktree({ project: f.project, run: owned });
  git(f.source, ['worktree', 'unlock', owned.worktreePath]);
  await assert.rejects(verifyManagedWorktree({ project: f.project, run: owned }), /registry lock/);
  assert.equal(await fs.readFile(path.join(owned.worktreePath, 'retained.txt'), 'utf8'), 'Uncommitted follow-up');
  git(f.source, ['worktree', 'lock', '--reason', 'Synthetic restored claim', owned.worktreePath]);
  git(owned.worktreePath, ['switch', '-c', 'different-branch']);
  await assert.rejects(verifyManagedWorktree({ project: f.project, run: owned }), /branch changed/);
});

test('ownership tampering and project identity changes fail without cleanup or replacement', async t => {
  const f = await fixture(t);
  const owned = run(f);
  const mismatched = { ...f.project, commonGitDirectory: path.join(f.temporary, 'another-repository') };
  await assert.rejects(createManagedWorktree({ project: mismatched, run: owned }), /identity changed/);
  await assert.rejects(fs.access(path.dirname(owned.worktreePath)), { code: 'ENOENT' });
  await createManagedWorktree({ project: f.project, run: owned });
  const ownerPath = path.join(path.dirname(owned.worktreePath), 'owner.json');
  const owner = JSON.parse(await fs.readFile(ownerPath, 'utf8'));
  await fs.writeFile(ownerPath, JSON.stringify({ ...owner, runId: 'different-run' }));
  await assert.rejects(verifyManagedWorktree({ project: f.project, run: owned }), /sidecar/);
  assert.equal((await fs.stat(owned.worktreePath)).isDirectory(), true);
  assert.equal(JSON.parse(await fs.readFile(ownerPath, 'utf8')).runId, 'different-run');
});

test('creation suppresses shared post-checkout hooks without changing repository configuration', async t => {
  const f = await fixture(t);
  const hooks = path.join(f.temporary, 'shared hooks');
  await fs.mkdir(hooks);
  await fs.writeFile(path.join(hooks, 'post-checkout'), '#!/bin/sh\nexit 73\n', { mode: 0o700 });
  git(f.source, ['config', 'core.hooksPath', hooks]);
  const owned = run(f);
  await createManagedWorktree({ project: f.project, run: owned });
  assert.equal(git(f.source, ['config', '--get', 'core.hooksPath']), hooks);
  await verifyManagedWorktree({ project: f.project, run: owned });
});

test('managed identifiers and reserved path/branch mismatches are rejected', async t => {
  const f = await fixture(t);
  for (const bad of ['', '..', '../run', 'run/name', '.hidden', 'name\\suffix']) assert.throws(() => planManagedWorktree({ root: f.root, projectId: f.project.id, runId: bad }), /identifier/);
  const owned = run(f);
  for (const invalid of [{ ...owned, projectId: 'another-project' }, { ...owned, branch: 'main' }, { ...owned, worktreePath: path.join(f.temporary, 'not-owned') }, { ...owned, baseCommit: 'HEAD' }]) {
    await assert.rejects(createManagedWorktree({ project: f.project, run: invalid }));
  }
  await assert.rejects(fs.access(f.root), { code: 'ENOENT' });
});
