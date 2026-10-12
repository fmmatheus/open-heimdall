import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { startCoordinatorService, readCoordinatorToken } from '../dist/coordinator/service.js';
import { createCoordinatorClient } from '../dist/coordinator/client.js';
import { CoordinatorStore } from '../dist/coordinator/store.js';
import { acquireCoordinatorOwnership } from '../dist/coordinator/ownership.js';
import { superviseForeground } from '../dist/coordinator/cli.js';
import { readShutdownRecord, requestCoordinatorShutdown } from '../dist/coordinator/lifecycle.js';
import { createDurableSubmissionGate } from '../dist/workflow/durable-submission.js';
import { openSubmissionBinding, recordDispatchPrompt } from '../dist/workflow/submission-store.js';

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

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, message) {
  for (let index = 0; index < 400; index++) { if (await predicate()) return; await sleep(5); }
  throw new Error(message);
}

/** A real coordinator holding one admitted synthetic native run and one queued run. */
async function heldFixture(t, { testHooks, credentials } = {}) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hdd-')));
  const stateDirectory = path.join(temporary, 'state');
  const endpoint = process.platform === 'win32' ? '\\\\.\\pipe\\heimdall-shutdown-' + randomUUID() : path.join(stateDirectory, 'coordinator.sock');
  const control = { proof: false, cleanup: false, interrupts: 0, launches: [] };
  let acknowledge;
  const acknowledgement = new Promise(resolve => { acknowledge = resolve; });
  const service = await startCoordinatorService({
    configuration: { stateDirectory, endpoint, globalConcurrency: 1, projectConcurrency: 2 }, pollIntervalMs: 5, testHooks, credentials,
    executor: {
      launch: async run => { control.launches.push(run); await acknowledgement; },
      inspect: async run => {
        const idle = control.proof || control.cleanup;
        return { idle, status: !idle ? 'unknown' : run.checkpoint?.status === 'completed' ? 'succeeded' : 'failed' };
      },
      interrupt: async () => { control.interrupts++; throw new Error('Shutdown must not cancel native execution'); },
    },
    scheduler: { createWorktree: async () => {}, verifyWorktree: async () => {}, prepare: async () => {} },
  });
  t.after(async () => {
    control.cleanup = true;
    acknowledge();
    await service.close().catch(() => {});
    await fs.rm(temporary, { recursive: true, force: true });
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
  await waitFor(() => control.launches.length === 1);
  const active = service.store.getRun('active');
  return { temporary, stateDirectory, endpoint, service, admin, project, active, control, acknowledge, owner: createCoordinatorClient(endpoint, active.ownerToken), instanceId: service.instance.instanceId };
}

function rawRequest(endpoint, method, route, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const request = http.request({ socketPath: endpoint, method, path: route, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(payload === undefined ? {} : { 'Content-Length': Buffer.byteLength(payload) }) } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ statusCode: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') }));
    });
    request.on('error', reject);
    request.end(payload);
  });
}

const structuredCheckpoint = (run, caller) => {
  const checkpoint = {
    id: run.id, status: 'running', protocol: 'structured-v1', adr: '.heimdall/feature.md', parent: run.parentSessionId, caller, branch: run.branch, baseline: '', index: 0,
    tasks: [task], results: [], phase: 'executor', child: 'ses_child', settings,
    attempt: { id: 'attempt_1', phase: 'executor', index: 0, child: 'ses_child', status: 'admitted', startedAt: 1, model: 'anthropic/x' },
  };
  checkpoint.submissionBinding = recordDispatchPrompt(openSubmissionBinding(checkpoint, 1), 'prompt_1');
  return checkpoint;
};

/** Exercise every owner persistence route and return the stored artifacts. */
async function persistAsOwner(f) {
  const { active, owner } = f;
  const caller = { sessionID: active.parentSessionId, id: 'native_call', messageID: 'assistant_message', agent: 'adr-orchestrator' };
  await owner.request('POST', '/runs/active/binding', caller);
  const checkpoint = structuredCheckpoint(active, caller);
  await owner.request('PUT', '/runs/active/checkpoint', checkpoint);
  assert.equal((await owner.request('GET', '/runs/active/checkpoint')).phase, 'executor');
  const receipt = { ...checkpoint.attempt, response: 'synthetic response' };
  await owner.request('PUT', '/runs/active/receipts/attempt_1', receipt);
  assert.equal((await owner.request('GET', '/runs/active/receipts/attempt_1')).id, 'attempt_1');
  const gate = createDurableSubmissionGate({
    runId: active.id, directory: f.temporary, origin: () => 'prompt_1',
    persistence: {
      load: async () => checkpoint,
      readSubmission: async (id, attempt, kind) => owner.request('GET', `/runs/${id}/submissions/${attempt}/${kind}`),
      writeSubmission: async (id, stored) => owner.request('PUT', `/runs/${id}/submissions/${stored.attemptId}/${stored.kind}`, stored),
    },
  });
  const raw = { status: 'completed', summary: 'Done', handoff: 'Next', evidence: [{ gateId: 'G1', passed: true, detail: 'synthetic' }] };
  assert.equal((await gate.submit('executor-result', raw, { sessionID: 'ses_child', agent: 'executor', messageID: 'msg_1', id: 'call_1' })).accepted, true);
  assert.equal((await owner.request('GET', '/runs/active/submissions/attempt_1/executor-result')).attemptId, 'attempt_1');
  const outcome = { outcomeVersion: 1, runId: active.id, phase: 'executor', index: 0, attemptId: 'attempt_1', child: 'ses_child', response: 'text', capturedAt: 1 };
  assert.deepEqual(await owner.request('PUT', '/runs/active/outcomes/attempt_1', outcome), outcome);
  return { checkpoint, caller };
}

const completedCheckpoint = (checkpoint) => ({
  ...checkpoint, status: 'completed', child: null, index: 1, attempt: undefined,
  results: [{ status: 'completed', taskId: task.id, summary: 'Synthetic completion', handoff: 'Synthetic handoff', evidence: [{ gateId: 'G1', gate: 'synthetic proof', passed: true, detail: 'Synthetic test fixture only' }], sessionId: 'ses_child', model: 'anthropic/executor' }],
});

test('authenticated shutdown holds a native run: owner persistence works, no idle proof means no completion, proof yields correlated clean evidence', { timeout: 20000 }, async t => {
  const f = await heldFixture(t);
  const before = f.service.lifecycle();
  assert.equal(before.phase, 'running');
  const acknowledgement = await requestCoordinatorShutdown(f.admin, f.instanceId);
  assert.equal(acknowledgement.accepted, true);
  assert.equal(acknowledgement.retried, false);
  assert.equal(acknowledgement.previousError, null);
  assert.equal(acknowledgement.lifecycle.instanceId, f.instanceId);
  assert.equal(acknowledgement.lifecycle.phase, 'draining');
  assert.equal(acknowledgement.lifecycle.shutdown.error, null);
  // Admission was disabled before the acknowledgement, and the coordinator keeps answering.
  const status = await f.admin.request('GET', '/status');
  assert.equal(status.status, 'draining');
  assert.equal(status.acceptingNewRuns, false);
  assert.equal(status.queuedRuns, 1);
  assert.equal(status.reservedRuns, 1);
  assert.equal((await f.admin.request('GET', '/lifecycle')).phase, 'draining');
  await assert.rejects(f.admin.request('POST', '/runs', { projectId: f.project.id, feature: 'New work during shutdown' }), /draining/);
  // The request is persisted before it is acknowledged.
  const requested = await readShutdownRecord(f.stateDirectory, f.instanceId);
  assert.equal(requested.status, 'requested');
  assert.equal(requested.attempts, 1);
  assert.equal(requested.requestedAt, acknowledgement.lifecycle.shutdown.requestedAt);
  // Owner checkpoint, binding, receipt, submission and outcome persistence stays open while the reservation is held.
  const { checkpoint } = await persistAsOwner(f);
  assert.equal(f.service.store.getRun('active').capacityReserved, true);
  assert.equal(f.service.store.getRun('queued').status, 'queued');
  f.acknowledge();
  await waitFor(() => f.service.store.getRun('active').status === 'running');
  await f.owner.request('PUT', '/runs/active/checkpoint', completedCheckpoint(checkpoint));
  let settled = false;
  const closed = f.service.closed.then(() => { settled = true; });
  await sleep(150);
  assert.equal(settled, false, 'a completed checkpoint is not native idle proof');
  assert.equal(f.service.store.getRun('active').capacityReserved, true);
  assert.equal((await readShutdownRecord(f.stateDirectory, f.instanceId)).status, 'requested');
  assert.equal((await f.admin.request('GET', '/status')).reservedRuns, 1);
  f.control.proof = true;
  await closed;
  const completion = await readShutdownRecord(f.stateDirectory, f.instanceId);
  assert.equal(completion.status, 'completed');
  assert.equal(completion.instanceId, f.instanceId);
  assert.equal(completion.attempts, 1);
  assert.equal(completion.requestedAt, requested.requestedAt);
  assert.deepEqual(completion.completedStages, ['scheduler-stop', 'server-close', 'store-close', 'ownership-release']);
  assert.equal(completion.error, null);
  assert.equal(typeof completion.completedAt, 'number');
  // The store is closed, the endpoint is gone, native execution was never interrupted and the lock is free.
  assert.throws(() => f.service.store.getRun('active'));
  await assert.rejects(f.admin.request('GET', '/status'), /unavailable/);
  assert.equal(f.control.interrupts, 0);
  assert.deepEqual(f.control.launches.map(run => run.id), ['active']);
  (await acquireCoordinatorOwnership(f.stateDirectory)).release();
  const persisted = new CoordinatorStore({ databasePath: path.join(f.stateDirectory, 'coordinator.sqlite'), globalConcurrency: 1 });
  try {
    assert.equal(persisted.getRun('active').status, 'succeeded');
    assert.equal(persisted.getRun('active').capacityReserved, false);
    assert.equal(persisted.getRun('queued').status, 'queued');
  } finally { persisted.close(); }
});

test('shutdown requests from a run owner, a wrong or missing token, another instance or another protocol start no drain', { timeout: 20000 }, async t => {
  const f = await heldFixture(t);
  const body = { protocol: 1, instanceId: f.instanceId };
  const refusal = (promise, statusCode, code) => assert.rejects(promise, error => error.statusCode === statusCode && (code === undefined || error.code === code));
  await refusal(f.owner.request('POST', '/lifecycle/shutdown', body), 403, 'forbidden');
  await refusal(createCoordinatorClient(f.endpoint, 'f'.repeat(64)).request('POST', '/lifecycle/shutdown', body), 401);
  assert.equal((await rawRequest(f.endpoint, 'POST', '/lifecycle/shutdown', { body })).statusCode, 401);
  await refusal(f.admin.request('POST', '/lifecycle/shutdown', { protocol: 1, instanceId: randomUUID() }), 409, 'instance-mismatch');
  await refusal(f.admin.request('POST', '/lifecycle/shutdown', { protocol: 2, instanceId: f.instanceId }), 400, 'unsupported-protocol');
  await refusal(f.admin.request('POST', '/lifecycle/shutdown', { instanceId: f.instanceId }), 400, 'unsupported-protocol');
  await refusal(f.admin.request('POST', '/lifecycle/shutdown', { protocol: 1 }), 400, 'invalid-request');
  await refusal(f.admin.request('POST', '/lifecycle/shutdown', { protocol: 1, instanceId: 42 }), 400, 'invalid-request');
  assert.equal((await rawRequest(f.endpoint, 'POST', '/lifecycle/shutdown', { token: await readCoordinatorToken(f.stateDirectory), body: '{broken' })).statusCode, 400);
  await refusal(f.admin.request('GET', '/lifecycle/shutdown'), 405, 'method-not-allowed');
  // No refusal started a drain, recorded a request or disabled admission.
  const status = await f.admin.request('GET', '/status');
  assert.equal(status.status, 'running');
  assert.equal(status.acceptingNewRuns, true);
  assert.equal((await f.admin.request('GET', '/lifecycle')).phase, 'running');
  assert.equal(f.service.lifecycle().shutdown, null);
  assert.equal(await readShutdownRecord(f.stateDirectory, f.instanceId), null);
  assert.deepEqual((await fs.readdir(path.join(f.stateDirectory, 'lifecycle'))).filter(name => name.startsWith('shutdown-')), []);
  // A working owner route is unaffected and the run is untouched.
  assert.equal((await f.owner.request('GET', '/runs/active')).id, 'active');
  assert.equal(f.control.interrupts, 0);
});

test('repeated and concurrent shutdown requests and direct calls share one operation', { timeout: 20000 }, async t => {
  const stages = [];
  const f = await heldFixture(t, { testHooks: { shutdownStage: stage => { stages.push(stage); } } });
  const answers = await Promise.all([
    requestCoordinatorShutdown(f.admin, f.instanceId), requestCoordinatorShutdown(f.admin, f.instanceId),
    requestCoordinatorShutdown(f.admin, f.instanceId), requestCoordinatorShutdown(f.admin, f.instanceId),
  ]);
  const direct = [f.service.shutdown(), f.service.shutdown()];
  const results = Promise.allSettled(direct);
  for (const answer of answers) {
    assert.equal(answer.retried, false);
    assert.equal(answer.previousError, null);
    assert.equal(answer.lifecycle.shutdown.requestedAt, answers[0].lifecycle.shutdown.requestedAt);
  }
  assert.equal(direct[0], direct[1], 'direct calls return the one in-flight operation');
  assert.equal(stages.filter(stage => stage === 'request').length, 1);
  const repeat = await requestCoordinatorShutdown(f.admin, f.instanceId);
  assert.equal(repeat.retried, false);
  assert.equal(repeat.lifecycle.phase, 'draining');
  assert.equal((await readShutdownRecord(f.stateDirectory, f.instanceId)).attempts, 1);
  f.acknowledge();
  await waitFor(() => f.service.store.getRun('active').status === 'running');
  f.control.proof = true;
  assert.deepEqual((await results).map(result => result.status), ['fulfilled', 'fulfilled']);
  await f.service.closed;
  const completion = await readShutdownRecord(f.stateDirectory, f.instanceId);
  assert.equal(completion.status, 'completed');
  assert.equal(completion.attempts, 1);
  assert.equal(stages.filter(stage => stage === 'request').length, 1);
  for (const stage of ['scheduler-stop', 'server-close', 'store-close', 'ownership-release', 'publish-completion']) assert.equal(stages.filter(name => name === stage).length, 1, stage);
});

test('a failed drain keeps admission off and persistence open, records drain-failed, and a later request retries the same operation', { timeout: 20000 }, async t => {
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  let injected = 0;
  let token;
  const f = await heldFixture(t, { testHooks: { shutdownStage: stage => { if (stage === 'drain' && injected++ === 0) throw new Error(`injected drain failure Bearer sekrit-credential ${token} https://user:pw@example.test/x`); } } });
  token = await readCoordinatorToken(f.stateDirectory);
  const first = await requestCoordinatorShutdown(f.admin, f.instanceId);
  assert.equal(first.accepted, true);
  assert.equal(first.retried, false);
  await until(() => f.service.lifecycle().phase === 'drain-failed', 'drain failure was not exposed');
  const failed = await f.admin.request('GET', '/lifecycle');
  assert.equal(failed.phase, 'drain-failed');
  assert.match(failed.shutdown.error, /^Drain failed: injected drain failure/);
  for (const secret of ['sekrit-credential', token, 'user:pw']) assert.equal(JSON.stringify(failed).includes(secret), false, 'lifecycle error is sanitized');
  // Admission stays off, reservations and owner persistence stay open, and nothing was closed or marked clean.
  const status = await f.admin.request('GET', '/status');
  assert.equal(status.status, 'draining');
  assert.equal(status.acceptingNewRuns, false);
  assert.equal(status.reservedRuns, 1);
  await assert.rejects(f.admin.request('POST', '/runs', { projectId: f.project.id, feature: 'Work after a failed drain' }), /draining/);
  const { checkpoint } = await persistAsOwner(f);
  assert.equal(f.service.store.getRun('active').capacityReserved, true);
  assert.equal(f.service.store.getRun('queued').status, 'queued');
  const record = await readShutdownRecord(f.stateDirectory, f.instanceId);
  assert.equal(record.status, 'drain-failed');
  assert.equal(record.stage, 'drain');
  assert.equal(record.attempts, 1);
  assert.equal(JSON.stringify(record).includes('sekrit-credential'), false);
  assert.equal(JSON.stringify(record).includes(token), false);
  let closedSettled = false;
  f.service.closed.then(() => { closedSettled = true; }, () => { closedSettled = true; });
  await sleep(50);
  assert.equal(closedSettled, false);
  // A later request observes the failure and retries under the same instance without enabling admission.
  const retry = await requestCoordinatorShutdown(f.admin, f.instanceId);
  assert.equal(retry.retried, true);
  assert.match(retry.previousError, /^Drain failed: injected drain failure/);
  assert.equal(retry.lifecycle.instanceId, f.instanceId);
  assert.equal(retry.lifecycle.phase, 'draining');
  assert.equal(retry.lifecycle.shutdown.error, null);
  assert.equal((await f.admin.request('GET', '/status')).acceptingNewRuns, false);
  assert.equal((await readShutdownRecord(f.stateDirectory, f.instanceId)).status, 'requested');
  assert.equal((await readShutdownRecord(f.stateDirectory, f.instanceId)).attempts, 2);
  const joined = await requestCoordinatorShutdown(f.admin, f.instanceId);
  assert.equal(joined.retried, false, 'a request during the retry joins it');
  f.acknowledge();
  await waitFor(() => f.service.store.getRun('active').status === 'running');
  await f.owner.request('PUT', '/runs/active/checkpoint', completedCheckpoint(checkpoint));
  await sleep(100);
  assert.equal(f.service.store.getRun('active').capacityReserved, true);
  f.control.proof = true;
  await f.service.closed;
  const completion = await readShutdownRecord(f.stateDirectory, f.instanceId);
  assert.equal(completion.status, 'completed');
  assert.equal(completion.attempts, 2);
  assert.equal(f.control.interrupts, 0);
  await sleep(20);
  assert.deepEqual(unhandled, []);
});

test('the foreground supervisor maps signals and IPC requests to the one shutdown operation', { timeout: 20000 }, async t => {
  const f = await heldFixture(t);
  const host = new EventEmitter();
  const out = [];
  const err = [];
  const supervised = superviseForeground(f.service, host, { stdout: { write: text => out.push(text) }, stderr: { write: text => err.push(text) } });
  let result;
  supervised.then(value => { result = value; });
  host.emit('SIGTERM');
  host.emit('SIGINT');
  host.emit('SIGTERM');
  await requestCoordinatorShutdown(f.admin, f.instanceId);
  assert.equal(out.filter(line => /Stopping admission/.test(line)).length, 1);
  assert.equal(f.service.lifecycle().phase, 'draining');
  assert.equal((await readShutdownRecord(f.stateDirectory, f.instanceId)).attempts, 1);
  await sleep(50);
  assert.equal(result, undefined, 'the process keeps running while the reservation is held');
  f.acknowledge();
  await waitFor(() => f.service.store.getRun('active').status === 'running');
  f.control.proof = true;
  assert.equal(await supervised, true);
  assert.deepEqual(err, []);
  assert.equal(host.listenerCount('SIGINT') + host.listenerCount('SIGTERM'), 0);
  const completion = await readShutdownRecord(f.stateDirectory, f.instanceId);
  assert.equal(completion.status, 'completed');
  assert.equal(completion.attempts, 1);
});

test('the foreground supervisor stays open after a drain failure and a repeated signal retries the drain', { timeout: 20000 }, async t => {
  let injected = 0;
  const f = await heldFixture(t, { testHooks: { shutdownStage: stage => { if (stage === 'drain' && injected++ === 0) throw new Error('injected drain failure'); } } });
  const host = new EventEmitter();
  const out = [];
  const err = [];
  const supervised = superviseForeground(f.service, host, { stdout: { write: text => out.push(text) }, stderr: { write: text => err.push(text) } });
  let result;
  supervised.then(value => { result = value; });
  host.emit('SIGINT');
  await until(() => err.length > 0, 'drain failure was not reported');
  assert.match(err.join(''), /Drain failed: injected drain failure[\s\S]*signal it again to retry/);
  assert.equal(result, undefined, 'a drain failure does not exit the process');
  assert.equal(f.service.lifecycle().phase, 'drain-failed');
  assert.equal(f.service.store.getRun('active').capacityReserved, true);
  host.emit('SIGINT');
  assert.match(out.join(''), /Retrying the failed drain; admission stays disabled/);
  assert.equal(f.service.lifecycle().phase, 'draining');
  f.acknowledge();
  await waitFor(() => f.service.store.getRun('active').status === 'running');
  f.control.proof = true;
  assert.equal(await supervised, true);
  assert.equal((await readShutdownRecord(f.stateDirectory, f.instanceId)).attempts, 2);
});

test('a drain failure that echoes a credential-file value is sanitized in the lifecycle error, record and error message', { timeout: 20000 }, async t => {
  const { loadCredentialFile } = await import('../dist/coordinator/credentials.js');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hdd-cred-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'credentials.env');
  // Shorter than the generic eight-character threshold, so only the credential context can mask it.
  await fs.writeFile(file, 'SYNTHETIC_PASSWORD=pw-7x\n', { mode: 0o600 });
  const credentials = await loadCredentialFile(file);
  let injected = 0;
  const f = await heldFixture(t, { credentials, testHooks: { shutdownStage: stage => { if (stage === 'drain' && injected++ === 0) throw new Error('injected drain failure with pw-7x inside'); } } });
  await requestCoordinatorShutdown(f.admin, f.instanceId);
  await until(() => f.service.lifecycle().phase === 'drain-failed', 'drain failure was not exposed');
  const failed = await f.admin.request('GET', '/lifecycle');
  assert.match(failed.shutdown.error, /^Drain failed: injected drain failure with \[redacted\] inside/);
  let record;
  await until(async () => { record = await readShutdownRecord(f.stateDirectory, f.instanceId); return record.status === 'drain-failed'; }, 'drain failure was not recorded');
  assert.match(record.error, /with \[redacted\] inside/);
  assert.ok(!JSON.stringify(record).includes('pw-7x'));
});
