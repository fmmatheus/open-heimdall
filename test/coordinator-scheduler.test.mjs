import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CoordinatorStore } from '../dist/coordinator/store.js';
import { CoordinatorScheduler } from '../dist/coordinator/scheduler.js';

const settings = { plannerAgent: 'planner', executorAgent: 'executor', plannerModel: 'anthropic/planner', executorModel: 'anthropic/executor', executorFallbackModel: 'kimi/fallback', maxTasks: 10, minQuotaRemainingPercent: 10, tokenLimitsDisabled: true };
const specification = { settings, plannerPrompt: 'Synthetic planner', executorPrompt: 'Synthetic executor', agents: {}, opencode: { baseUrl: 'http://127.0.0.1:4321', passwordEnvironmentVariable: 'SYNTHETIC_PASSWORD' } };
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, { globalConcurrency = 1, executor = {}, createWorktree, verifyWorktree, prepare } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall scheduler fixture '));
  const store = new CoordinatorStore({ databasePath: path.join(directory, 'state.sqlite'), globalConcurrency });
  const calls = { launch: [], inspect: [], create: [], verify: [], prepare: [] };
  const native = {
    launch: async run => { calls.launch.push(run); await executor.launch?.(run); },
    inspect: async run => { calls.inspect.push(run); return executor.inspect ? executor.inspect(run) : { idle: false, status: 'unknown' }; },
    interrupt: async run => executor.interrupt?.(run),
  };
  const scheduler = new CoordinatorScheduler({
    store, executor: native, endpoint: path.join(directory, 'synthetic-ipc'),
    createWorktree: async input => { calls.create.push(input); await createWorktree?.(input); },
    verifyWorktree: async input => { calls.verify.push(input); await verifyWorktree?.(input); },
    prepare: async (run, endpoint) => { calls.prepare.push({ run, endpoint }); await prepare?.(run, endpoint); },
  });
  t.after(async () => { await scheduler.stop(); store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  let projectNumber = 0;
  const project = async (concurrency = 1) => {
    const root = path.join(directory, 'project-' + ++projectNumber);
    await fs.mkdir(path.join(root, '.git'), { recursive: true });
    const configPath = path.join(root, '.heimdall.toml');
    await fs.writeFile(configPath, '[workflow]\n');
    return store.registerProject({ directory: root, commonGitDirectory: path.join(root, '.git'), configPath, concurrency });
  };
  const enqueue = (registered, id) => store.enqueue({ id, projectId: registered.id, feature: 'feature.md', baseCommit: 'a'.repeat(40), worktreePath: path.join(directory, 'worktrees', registered.id, id, 'checkout'), branch: 'heimdall/run/' + id, specification });
  const tick = async () => { await scheduler.tick(); await turn(); };
  return { directory, store, scheduler, calls, project, enqueue, tick };
}

function saveCheckpoint(store, id, status = 'paused') {
  const run = store.getRun(id);
  const binding = { sessionID: run.parentSessionId, messageID: run.promptMessageId, id: 'tool-' + id, agent: 'adr-orchestrator' };
  store.bindStart(id, run.ownerToken, binding);
  const checkpoint = { id, status, adr: 'feature.md', parent: run.parentSessionId, caller: binding, branch: run.branch, baseline: '', index: 0, tasks: [], results: [], phase: 'planner', child: null, settings };
  store.saveCheckpoint(id, run.ownerToken, checkpoint);
  return checkpoint;
}

test('global admission permits simultaneous runs in one project only on distinct reserved worktrees', async t => {
  const f = await fixture(t, { globalConcurrency: 2 });
  const firstProject = await f.project(2);
  const otherProject = await f.project(2);
  f.enqueue(firstProject, 'first');
  f.enqueue(firstProject, 'second');
  f.enqueue(otherProject, 'third');
  await Promise.all([f.scheduler.tick(), f.scheduler.tick()]);
  await turn();
  assert.deepEqual(f.calls.launch.map(run => run.id), ['first', 'second']);
  assert.notEqual(f.calls.launch[0].worktreePath, f.calls.launch[1].worktreePath);
  assert.notEqual(f.calls.launch[0].ownerToken, f.calls.launch[1].ownerToken);
  assert.equal(f.store.listRuns().filter(run => run.capacityReserved).length, 2);
  assert.equal(f.store.getRun('third').status, 'queued');
  await f.tick();
  assert.equal(f.calls.launch.length, 2, 'polling cannot launch an already admitted run again');
});

test('per-project limits skip a saturated project while admitting work in another project', async t => {
  const f = await fixture(t, { globalConcurrency: 3 });
  const limited = await f.project(1);
  const available = await f.project(2);
  f.enqueue(limited, 'limited-first');
  f.enqueue(limited, 'limited-second');
  f.enqueue(available, 'available-first');
  f.enqueue(available, 'available-second');
  await f.tick();
  assert.deepEqual(f.calls.launch.map(run => run.id), ['limited-first', 'available-first', 'available-second']);
  assert.equal(f.store.getRun('limited-second').status, 'queued');
  assert.equal(f.store.listRuns().filter(run => run.capacityReserved && run.projectId === limited.id).length, 1);
});

test('unknown or active native observations retain capacity and block replacement work', async t => {
  let observation = { idle: false, status: 'unknown' };
  const f = await fixture(t, { executor: { inspect: async () => observation } });
  const project = await f.project(2);
  f.enqueue(project, 'active');
  f.enqueue(project, 'waiting');
  await f.tick();
  for (const value of [{ idle: false, status: 'succeeded' }, { idle: true, status: 'unknown' }, { idle: false, status: 'unknown' }]) {
    observation = value;
    await f.tick();
    assert.equal(f.store.getRun('active').capacityReserved, true);
    assert.equal(f.store.getRun('waiting').status, 'queued');
  }
  assert.equal(f.calls.launch.length, 1);
});

test('failed preparation retains capacity until explicit reconciliation releases only its agent slot', async t => {
  const f = await fixture(t, { createWorktree: async ({ run }) => { if (run.id === 'uncertain') throw new Error('Worktree creation outcome uncertain'); } });
  const project = await f.project(2);
  f.enqueue(project, 'uncertain');
  f.enqueue(project, 'waiting');
  await f.tick();
  const failed = f.store.getRun('uncertain');
  assert.equal(failed.status, 'reconciliation-required');
  assert.equal(failed.capacityReserved, true);
  assert.equal(failed.launchIntent, false);
  assert.match(failed.reason, /outcome uncertain/);
  for (let index = 0; index < 2; index++) await f.tick();
  assert.equal(f.calls.create.length, 1);
  assert.equal(f.calls.prepare.length, 0);
  assert.equal(f.calls.launch.length, 0);
  assert.equal(f.calls.inspect.length, 0, 'ambiguous preparation is never automatically observed as a finished execution');
  assert.equal(f.store.getRun('waiting').status, 'queued');
  const reconciled = await f.scheduler.reconcile(failed.id);
  assert.equal(reconciled.status, 'failed');
  assert.equal(reconciled.capacityReserved, false);
  assert.equal(reconciled.worktreePath, failed.worktreePath);
  assert.equal(f.calls.verify.length, 0, 'no native intent requires no claim that an incomplete checkout is usable');
  assert.equal(f.calls.inspect.length, 0);
  assert.throws(() => f.store.enqueue({ id: 'reused-path', projectId: project.id, feature: 'Another feature', baseCommit: failed.baseCommit, worktreePath: failed.worktreePath, branch: 'heimdall/run/reused-path', specification }), /UNIQUE/);
  assert.equal(f.store.getRun('reused-path'), null, 'the failed run permanently retains its worktree reservation');
  await f.tick();
  assert.equal(f.store.getRun('waiting').status, 'running');
  assert.deepEqual(f.calls.launch.map(run => run.id), ['waiting']);
});

test('native launch failure after durable intent remains reserved when inspection is uncertain', async t => {
  const f = await fixture(t, { executor: { launch: async () => { throw new Error('Native prompt acknowledgement lost'); }, inspect: async () => ({ idle: false, status: 'unknown' }) } });
  const project = await f.project(2);
  f.enqueue(project, 'native-uncertain');
  f.enqueue(project, 'waiting');
  await f.tick();
  const run = f.store.getRun('native-uncertain');
  assert.equal(run.status, 'reconciliation-required');
  assert.equal(run.launchIntent, true);
  assert.equal(run.capacityReserved, true);
  const retained = await f.scheduler.reconcile(run.id);
  assert.equal(retained.status, 'reconciliation-required');
  assert.equal(retained.capacityReserved, true);
  await f.tick();
  assert.equal(f.calls.launch.length, 1, 'uncertain acknowledgement is not retried automatically');
  assert.equal(f.calls.inspect.length, 1);
  assert.equal(f.store.getRun('waiting').status, 'queued');
});

test('restart marks persisted active reservations for reconciliation without relaunching them', async t => {
  const f = await fixture(t, { globalConcurrency: 2 });
  const project = await f.project(3);
  f.enqueue(project, 'previous-running');
  f.enqueue(project, 'previous-preparing');
  f.enqueue(project, 'waiting');
  const first = f.store.admitNext();
  f.store.transition(first.id, first.ownerToken, first.version, 'running');
  f.store.admitNext();
  f.store.close();
  const restartedStore = new CoordinatorStore({ databasePath: path.join(f.directory, 'state.sqlite'), globalConcurrency: 2 });
  let relaunched = 0;
  let observed = 0;
  const restarted = new CoordinatorScheduler({ store: restartedStore, endpoint: 'synthetic-restart', executor: { launch: async () => { relaunched++; }, inspect: async () => { observed++; return { idle: false, status: 'unknown' }; } }, createWorktree: async () => { throw new Error('Restart must not create worktrees'); }, prepare: async () => {} });
  try {
    restarted.markInterrupted();
    assert.equal(restartedStore.getRun('previous-running').status, 'reconciliation-required');
    assert.equal(restartedStore.getRun('previous-preparing').status, 'reconciliation-required');
    assert.equal(restartedStore.listRuns().filter(run => run.capacityReserved).length, 2);
    await restarted.tick();
    await turn();
    assert.equal(relaunched, 0);
    assert.equal(observed, 0);
    assert.equal(restartedStore.getRun('waiting').status, 'queued');
  } finally {
    await restarted.stop();
    restartedStore.close();
  }
});

test('only proven idle terminal or paused outcomes release capacity and admit queued work', async t => {
  for (const outcome of ['succeeded', 'paused', 'failed']) await t.test(outcome, async child => {
    let idle = false;
    const f = await fixture(child, { executor: { inspect: async run => ({ idle, status: run.id === 'finished' ? outcome : 'unknown', reason: 'Synthetic proven outcome' }) } });
    const project = await f.project(2);
    f.enqueue(project, 'finished');
    f.enqueue(project, 'waiting');
    await f.tick();
    saveCheckpoint(f.store, 'finished', outcome === 'succeeded' ? 'completed' : 'paused');
    await f.tick();
    assert.equal(f.store.getRun('finished').capacityReserved, true, 'saved output alone does not establish that the native execution stopped');
    assert.equal(f.store.getRun('waiting').status, 'queued');
    idle = true;
    await f.tick();
    const finished = f.store.getRun('finished');
    assert.equal(finished.status, outcome);
    assert.equal(finished.capacityReserved, false);
    assert.equal(finished.checkpoint.status, outcome === 'succeeded' ? 'completed' : 'paused');
    assert.equal(f.store.getRun('waiting').status, 'running');
    assert.deepEqual(f.calls.launch.map(run => run.id), ['finished', 'waiting']);
  });
});

test('explicit reconciliation can release a retained run only after worktree verification and idle proof', async t => {
  let idle = false;
  const f = await fixture(t, { executor: { inspect: async () => ({ idle, status: 'paused' }) } });
  const project = await f.project(2);
  f.enqueue(project, 'retained');
  f.enqueue(project, 'waiting');
  await f.tick();
  saveCheckpoint(f.store, 'retained');
  f.scheduler.markInterrupted();
  const stillActive = await f.scheduler.reconcile('retained');
  assert.equal(stillActive.capacityReserved, true);
  assert.equal(stillActive.status, 'reconciliation-required');
  idle = true;
  const paused = await f.scheduler.reconcile('retained');
  assert.equal(paused.status, 'paused');
  assert.equal(paused.capacityReserved, false);
  assert.equal(f.calls.verify.length, 2);
  await f.tick();
  assert.equal(f.store.getRun('waiting').status, 'running');
});

test('explicit paused resume preserves the worktree and parent with a fresh admission owner', async t => {
  let idle = true;
  const f = await fixture(t, { executor: { inspect: async () => ({ idle, status: 'paused' }) } });
  const project = await f.project();
  f.enqueue(project, 'paused-run');
  await f.tick();
  const first = f.store.getRun('paused-run');
  const checkpoint = saveCheckpoint(f.store, 'paused-run');
  await f.tick();
  assert.equal(f.store.getRun('paused-run').status, 'paused');
  idle = false;
  await assert.rejects(f.scheduler.resume('paused-run', 'Owner resolved the blocker'), /confirmed idle/);
  assert.equal(f.store.getRun('paused-run').status, 'paused');
  idle = true;
  const queued = await f.scheduler.resume('paused-run', 'Owner resolved the blocker');
  assert.equal(queued.status, 'queued');
  assert.equal(queued.ownerToken, null);
  assert.equal(queued.worktreePath, first.worktreePath);
  assert.equal(queued.branch, first.branch);
  assert.equal(queued.parentSessionId, first.parentSessionId);
  assert.notEqual(queued.promptMessageId, first.promptMessageId);
  assert.equal(queued.resolution, 'Owner resolved the blocker');
  assert.equal(queued.launchAction, 'resume');
  idle = false;
  await f.tick();
  const resumed = f.store.getRun('paused-run');
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.capacityReserved, true);
  assert.notEqual(resumed.ownerToken, first.ownerToken);
  assert.equal(f.calls.create.length, 1, 'resume never creates another worktree');
  assert.equal(f.calls.launch.length, 2);
  assert.equal(f.calls.launch[1].launchAction, 'resume');
  assert.equal(f.calls.launch[1].worktreePath, first.worktreePath);
  assert.throws(() => f.store.saveCheckpoint(first.id, first.ownerToken, checkpoint), /Stale or invalid/);
});

test('stop halts admission without cancelling native launch or releasing its reservation', async t => {
  const acknowledgement = deferred();
  let nativeInterrupted = 0;
  const f = await fixture(t, { executor: { launch: async () => acknowledgement.promise, interrupt: async () => { nativeInterrupted++; } } });
  try {
    const project = await f.project(2);
    f.enqueue(project, 'launching');
    f.enqueue(project, 'waiting');
    await f.tick();
    assert.equal(f.calls.launch.length, 1);
    let stopped = false;
    const stopping = f.scheduler.stop().then(() => { stopped = true; });
    await turn();
    assert.equal(stopped, false, 'stop waits for the current launch acknowledgement');
    await f.scheduler.tick();
    assert.equal(f.store.getRun('launching').capacityReserved, true);
    assert.equal(f.store.getRun('waiting').status, 'queued');
    acknowledgement.resolve();
    await stopping;
    assert.equal(nativeInterrupted, 0);
    assert.equal(f.store.getRun('launching').status, 'running');
    assert.equal(f.store.getRun('launching').capacityReserved, true);
    await f.tick();
    assert.equal(f.calls.launch.length, 1);
    assert.equal(f.calls.inspect.length, 0);
  } finally { acknowledgement.resolve(); }
});
