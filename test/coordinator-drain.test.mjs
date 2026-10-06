import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { startCoordinatorService, readCoordinatorToken } from '../dist/coordinator/service.js';
import { createCoordinatorClient } from '../dist/coordinator/client.js';

const settings = { plannerAgent: 'planner', executorAgent: 'executor', plannerModel: 'anthropic/planner', executorModel: 'anthropic/executor', executorFallbackModel: 'kimi/fallback', maxTasks: 10, minQuotaRemainingPercent: 10, tokenLimitsDisabled: true };
const task = { id: 'T1', title: 'Synthetic task', brief: 'Synthetic execution only', dependsOn: [], dod: ['synthetic proof'] };
const specification = { settings, plannerPrompt: 'Synthetic planner', executorPrompt: 'Synthetic executor', agents: {}, opencode: { baseUrl: 'http://127.0.0.1:4321', passwordEnvironmentVariable: 'SYNTHETIC_PASSWORD' } };
const turn = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(predicate) {
  for (let index = 0; index < 100; index++) { if (predicate()) return; await turn(); }
  throw new Error('Synthetic launch did not reach its expected stage');
}

test('graceful drain keeps owner persistence available, blocks new work, and waits for native idle proof', { timeout: 5000 }, async t => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hdd-')));
  const stateDirectory = path.join(temporary, 'state');
  const endpoint = process.platform === 'win32' ? '\\\\.\\pipe\\heimdall-drain-' + randomUUID() : path.join(stateDirectory, 'coordinator.sock');
  let acknowledge;
  const acknowledgement = new Promise(resolve => { acknowledge = resolve; });
  let proof = false;
  let cleanup = false;
  const launches = [];
  let service;
  let closed = false;
  let drain;
  t.after(async () => {
    cleanup = true;
    acknowledge();
    if (drain) await drain;
    if (service && !closed) await service.close();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  service = await startCoordinatorService({
    configuration: { stateDirectory, endpoint, globalConcurrency: 1, projectConcurrency: 2 }, pollIntervalMs: 5,
    executor: {
      launch: async run => { launches.push(run); await acknowledgement; },
      inspect: async run => cleanup ? { idle: true, status: 'failed' } : { idle: proof, status: proof && run.checkpoint?.status === 'completed' ? 'succeeded' : 'unknown' },
      interrupt: async () => { throw new Error('Drain must not cancel native execution'); },
    },
    scheduler: { createWorktree: async () => {}, verifyWorktree: async () => {}, prepare: async () => {} },
  });
  const admin = createCoordinatorClient(endpoint, await readCoordinatorToken(stateDirectory));
  const directory = path.join(temporary, 'synthetic-project');
  await fs.mkdir(path.join(directory, '.git'), { recursive: true });
  const configPath = path.join(directory, '.heimdall.toml');
  await fs.writeFile(configPath, '[workflow]\n');
  const project = service.store.registerProject({ directory, commonGitDirectory: path.join(directory, '.git'), configPath, concurrency: 2 });
  const enqueue = id => service.store.enqueue({ id, projectId: project.id, feature: 'Synthetic feature', baseCommit: 'a'.repeat(40), worktreePath: path.join(stateDirectory, 'worktrees', project.id, id, 'checkout'), branch: 'heimdall/run/' + id, specification });
  enqueue('active');
  enqueue('queued');
  await service.scheduler.tick();
  await waitFor(() => launches.length === 1);
  const active = service.store.getRun('active');
  assert.equal(active.launchIntent, true);
  assert.equal(active.capacityReserved, true);
  let drained = false;
  drain = service.drain().then(() => { drained = true; });
  await turn();
  assert.equal(drained, false, 'an unacknowledged active launch must keep persistence and capacity alive');
  await assert.rejects(admin.request('POST', '/runs', { projectId: project.id, feature: 'New work during shutdown' }), /draining/);
  const owner = createCoordinatorClient(endpoint, active.ownerToken);
  const binding = { sessionID: active.parentSessionId, id: 'synthetic-call', messageID: 'synthetic-assistant-message', agent: 'adr-orchestrator' };
  await owner.request('POST', '/runs/active/binding', binding);
  const running = { id: active.id, status: 'running', adr: '.heimdall/feature.md', parent: active.parentSessionId, caller: binding, branch: active.branch, baseline: '', index: 0, tasks: [task], results: [], phase: 'executor', child: 'synthetic-child', settings, usage: { 'synthetic-child': 10 }, uncachedUsage: { 'synthetic-child': 10 } };
  await owner.request('PUT', '/runs/active/checkpoint', running);
  assert.equal((await owner.request('GET', '/runs/active/checkpoint')).status, 'running');
  assert.equal(drained, false);
  assert.equal(service.store.getRun('queued').status, 'queued');
  acknowledge();
  await waitFor(() => service.store.getRun('active').status === 'running');
  const completed = { ...running, status: 'completed', child: null, index: 1, results: [{ status: 'completed', taskId: task.id, summary: 'Synthetic completion', handoff: 'Synthetic handoff', evidence: [{ gateId: 'G1', gate: 'synthetic proof', passed: true, detail: 'Synthetic test fixture only' }], sessionId: 'synthetic-child', model: 'anthropic/executor' }] };
  await owner.request('PUT', '/runs/active/checkpoint', completed);
  assert.equal(drained, false, 'saved completion does not replace native idle proof');
  proof = true;
  await drain;
  assert.equal(service.store.getRun('active').status, 'succeeded');
  assert.equal(service.store.getRun('active').capacityReserved, false);
  assert.equal(service.store.getRun('queued').status, 'queued');
  assert.deepEqual(launches.map(run => run.id), ['active']);
  assert.equal((await admin.request('GET', '/runs/active')).checkpoint.status, 'completed', 'IPC remains open until the caller closes the drained service');
  await service.close();
  closed = true;
  await assert.rejects(admin.request('GET', '/runs'), /unavailable/);
});
