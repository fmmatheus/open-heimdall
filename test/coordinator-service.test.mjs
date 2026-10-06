import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createCoordinatorClient } from '../dist/coordinator/client.js';
import { loadCoordinatorConfiguration } from '../dist/coordinator/config.js';
import { startCoordinatorService, readCoordinatorToken } from '../dist/coordinator/service.js';

const git = (directory, args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(t) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hd-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const project = path.join(temporary, 'source');
  const state = path.join(temporary, 'state');
  await fs.mkdir(project);
  git(project, ['init', '-b', 'main']);
  git(project, ['config', 'user.name', 'Fixture']);
  git(project, ['config', 'user.email', 'fixture@example.invalid']);
  await fs.writeFile(path.join(project, 'README.md'), 'pinned base\n');
  git(project, ['add', 'README.md']); git(project, ['commit', '-m', 'fixture']);
  await fs.writeFile(path.join(project, '.heimdall.toml'), `[workflow]\nplannerModel = "anthropic/fixture"\nexecutorModel = "anthropic/fixture"\nexecutorFallbackModel = "openai/fixture"\n[opencode]\nbaseUrl = "http://127.0.0.1:4096"\n`);
  const configuration = { stateDirectory: state, endpoint: path.join(state, 'coordinator.sock'), globalConcurrency: 2, projectConcurrency: 1 };
  const launches = [];
  let observation = { idle: false, status: 'unknown' };
  const executor = {
    async launch(run) { launches.push(run); },
    async inspect() { return observation; },
  };
  let service = await startCoordinatorService({ configuration, executor, pollIntervalMs: 60000 });
  t.after(async () => { if (service) await service.close(); });
  const client = createCoordinatorClient(configuration.endpoint, await readCoordinatorToken(state));
  return {
    temporary, project, state, configuration, client, launches,
    service: () => service,
    observation: value => { observation = value; },
    async restart() { await service.close(); service = await startCoordinatorService({ configuration, executor, pollIntervalMs: 60000 }); },
    async close() { await service.close(); service = null; },
  };
}
async function settled(store, runId) {
  for (let n = 0; n < 200; n++) {
    const run = store.getRun(runId);
    if (run.status === 'running' || run.status === 'reconciliation-required') return run;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Fixture launch did not settle');
}
async function bindCheckpoint(f, run, status = 'paused') {
  const binding = { sessionID: run.parentSessionId, id: 'native_call', messageID: 'assistant_message', agent: 'adr-orchestrator' };
  await f.client.request('POST', `/runs/${run.id}/binding`, binding, run.ownerToken);
  const state = { id: run.id, status, adr: '.heimdall/feature.md', parent: run.parentSessionId, caller: binding, branch: run.branch, baseline: '', index: 0, tasks: [], results: [], phase: 'planner', child: null, settings: run.specification.settings };
  await f.client.request('PUT', `/runs/${run.id}/checkpoint`, state, run.ownerToken);
  return state;
}

test('IPC submission pins the source, creates one owned runtime, and exposes no capabilities', async t => {
  const f = await fixture(t);
  const before = git(f.project, ['status', '--porcelain']);
  const project = await f.client.request('POST', '/projects', { directory: f.project });
  const submitted = await f.client.request('POST', '/runs', { projectId: project.id, feature: 'Implement the specified feature.' });
  assert.equal(submitted.status, 'queued');
  assert.equal(Object.hasOwn(submitted, 'ownerToken'), false);
  await fs.writeFile(path.join(f.project, 'README.md'), 'source moved\n');
  git(f.project, ['add', 'README.md']); git(f.project, ['commit', '-m', 'move source']);
  await f.service().scheduler.tick();
  const run = await settled(f.service().store, submitted.id);
  assert.equal(run.status, 'running', run.reason ?? '');
  assert.equal(f.launches.length, 1);
  assert.equal(await fs.readFile(path.join(run.worktreePath, 'README.md'), 'utf8'), 'pinned base\n');
  assert.equal(await fs.readFile(path.join(run.worktreePath, '.heimdall/feature.md'), 'utf8'), 'Implement the specified feature.');
  const metadata = JSON.parse(await fs.readFile(path.join(run.worktreePath, '.heimdall/managed.json'), 'utf8'));
  assert.equal(metadata.ownerToken, run.ownerToken);
  assert.equal(metadata.parentSessionId, run.parentSessionId);
  const shim = await fs.readFile(path.join(run.worktreePath, '.opencode/plugins/heimdall.ts'), 'utf8');
  assert.match(shim, /createPlugin/);
  assert.match(shim, /runtime\.toml/);
  assert.equal(git(f.project, ['status', '--porcelain']), before);
  await bindCheckpoint(f, run);
  await assert.rejects(f.client.request('GET', '/projects', undefined, run.ownerToken), /authorization|cannot administer/);
  await assert.rejects(f.client.request('GET', '/runs/' + run.id, undefined, 'wrong-token'), /authorization/);
  const visible = await f.client.request('GET', '/runs/' + run.id);
  assert.equal(Object.hasOwn(visible, 'ownerToken'), false);
  assert.equal(visible.checkpoint.caller.messageID, 'assistant_message');
  const events = await f.client.request('GET', '/events');
  assert.ok(events.some(event => event.type === 'checkpoint.saved'));
  assert.ok(!JSON.stringify(events).includes(run.ownerToken));
});

test('restart retains active ownership; explicit idle reconciliation and resume rotate the capability', async t => {
  const f = await fixture(t);
  const project = await f.client.request('POST', '/projects', { directory: f.project });
  const queued = await f.client.request('POST', '/runs', { projectId: project.id, feature: 'Feature' });
  await f.service().scheduler.tick();
  const run = await settled(f.service().store, queued.id);
  const checkpoint = await bindCheckpoint(f, run);
  await f.restart();
  const retained = f.service().store.getRun(run.id);
  assert.equal(retained.status, 'reconciliation-required');
  assert.equal(retained.capacityReserved, true);
  await f.service().scheduler.tick();
  assert.equal(f.launches.length, 1);
  f.observation({ idle: true, status: 'paused', reason: 'Needs resolution' });
  const reconciled = await f.client.request('POST', `/runs/${run.id}/reconcile`, {});
  assert.equal(reconciled.status, 'paused');
  assert.equal(reconciled.capacityReserved, false);
  const resumed = await f.client.request('POST', `/runs/${run.id}/resume`, { input: 'Use the agreed approach' });
  assert.equal(resumed.status, 'queued');
  await f.service().scheduler.tick();
  const fresh = await settled(f.service().store, run.id);
  // Resumed admission is already running while metadata/launch finish.
  for (let n = 0; n < 100 && f.launches.length < 2; n++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(fresh.worktreePath, run.worktreePath);
  assert.equal(fresh.parentSessionId, run.parentSessionId);
  assert.notEqual(fresh.ownerToken, run.ownerToken);
  assert.notEqual(fresh.promptMessageId, run.promptMessageId);
  await assert.rejects(f.client.request('PUT', `/runs/${run.id}/checkpoint`, checkpoint, run.ownerToken), /authorization/);
  const metadata = JSON.parse(await fs.readFile(path.join(run.worktreePath, '.heimdall/managed.json'), 'utf8'));
  assert.equal(metadata.ownerToken, fresh.ownerToken);
});

test('an existing IPC endpoint is never removed or replaced', async t => {
  const f = await fixture(t);
  await f.close();
  await fs.writeFile(f.configuration.endpoint, 'external owner');
  await assert.rejects(startCoordinatorService({ configuration: f.configuration }), /endpoint already exists/);
  assert.equal(await fs.readFile(f.configuration.endpoint, 'utf8'), 'external owner');
});

test('tracked original plugin assets are rejected before queueing or reserving a worktree', async t => {
  const f = await fixture(t);
  const plugins = path.join(f.project, '.opencode/plugins');
  await fs.mkdir(plugins, { recursive: true });
  const original = path.join(plugins, 'adr-workflow.js');
  await fs.writeFile(original, '// Existing workflow remains untouched.\n');
  git(f.project, ['add', '.opencode/plugins/adr-workflow.js']); git(f.project, ['commit', '-m', 'existing workflow']);
  const project = await f.client.request('POST', '/projects', { directory: f.project });
  await assert.rejects(f.client.request('POST', '/runs', { projectId: project.id, feature: 'Feature' }), /already tracks a managed runtime path/);
  assert.equal(f.service().store.listRuns().length, 0);
  await assert.rejects(fs.stat(path.join(f.state, 'worktrees')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(original, 'utf8'), '// Existing workflow remains untouched.\n');
});

test('explicit no-auth settings survive submission snapshots and managed runtime configuration', async t => {
  const f = await fixture(t);
  const configFile = path.join(f.project, '.heimdall.toml');
  await fs.appendFile(configFile, 'authentication = "none"\n');
  const project = await f.client.request('POST', '/projects', { directory: f.project });
  const queued = await f.client.request('POST', '/runs', { projectId: project.id, feature: 'Feature' });
  assert.equal(f.service().store.getRun(queued.id).specification.opencode.authentication, 'none');
  await f.service().scheduler.tick();
  const run = await settled(f.service().store, queued.id);
  const runtime = await fs.readFile(path.join(run.worktreePath, '.heimdall/runtime.toml'), 'utf8');
  assert.match(runtime, /authentication = "none"/);
});

test('relative project registration resolves against the client rather than server cwd', async t => {
  const f = await fixture(t);
  const file = path.join(f.temporary, 'coordinator.toml');
  await fs.writeFile(file, `[coordinator]\nstateDirectory="state"\nglobalConcurrency=2\nprojectConcurrency=1\n`);
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [cli, 'coordinator', 'project', 'add', './source', '--coordinator-config', file], { cwd: f.temporary, encoding: 'utf8' });
  assert.equal(JSON.parse(stdout).directory, f.project);
});

test('coordinator TOML resolves paths against its file and rejects unsupported limits', async t => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hd-cfg-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const file = path.join(temporary, 'coordinator.toml');
  await fs.writeFile(file, '[coordinator]\nstateDirectory="state"\nglobalConcurrency=3\nprojectConcurrency=2\n');
  const config = await loadCoordinatorConfiguration(file);
  assert.equal(config.stateDirectory, path.join(temporary, 'state'));
  assert.equal(config.globalConcurrency, 3);
  assert.equal(config.projectConcurrency, 2);
  const alias = path.join(temporary, 'alias');
  await fs.symlink(temporary, alias, 'dir');
  const throughAlias = path.join(temporary, 'alias-config.toml');
  await fs.writeFile(throughAlias, '[coordinator]\nstateDirectory="alias/state"\nglobalConcurrency=3\nprojectConcurrency=2\n');
  const aliased = await loadCoordinatorConfiguration(throughAlias);
  assert.equal(aliased.stateDirectory, config.stateDirectory);
  assert.equal(aliased.endpoint, config.endpoint);
  await fs.writeFile(file, '[coordinator]\nglobalConcurrency=0\n');
  await assert.rejects(loadCoordinatorConfiguration(file), /positive integer/);
  await fs.writeFile(file, '[coordinator]\nunknown=true\n');
  await assert.rejects(loadCoordinatorConfiguration(file), /Unknown coordinator setting/);
});
