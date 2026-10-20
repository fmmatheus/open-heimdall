import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CoordinatorStore } from '../dist/coordinator/store.js';
import { CoordinatorScheduler } from '../dist/coordinator/scheduler.js';
import { CoordinatorError } from '../dist/coordinator/errors.js';
import { contractDigest, contractRef } from '../dist/workflow/contracts.js';
import { openSubmissionBinding, recordDispatchPrompt } from '../dist/workflow/submission-store.js';
import { parseApprovalContext } from '../dist/workflow/approval-context.js';
import { DatabaseSync } from 'node:sqlite';

const settings = { plannerAgent: 'planner', executorAgent: 'executor', plannerModel: 'anthropic/planner', executorModel: 'anthropic/executor', executorFallbackModel: 'kimi/fallback', maxTasks: 10, minQuotaRemainingPercent: 10, tokenLimitsDisabled: true };
const specification = { settings, plannerPrompt: 'Synthetic planner', executorPrompt: 'Synthetic executor', agents: {}, opencode: { baseUrl: 'http://127.0.0.1:4321', passwordEnvironmentVariable: 'SYNTHETIC_PASSWORD' } };
const turn = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, { globalConcurrency = 1, executor = {}, createWorktree, verifyWorktree, prepare, revision } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall scheduler fixture '));
  const store = new CoordinatorStore({ databasePath: path.join(directory, 'state.sqlite'), globalConcurrency });
  const calls = { launch: [], inspect: [], create: [], verify: [], prepare: [] };
  const native = {
    launch: async run => { calls.launch.push(run); await executor.launch?.(run); },
    inspect: async run => { calls.inspect.push(run); return executor.inspect ? executor.inspect(run) : { idle: false, status: 'unknown' }; },
    interrupt: async run => executor.interrupt?.(run),
  };
  const schedulerFor = (owned) => new CoordinatorScheduler({
    store: owned, executor: native, endpoint: path.join(directory, 'synthetic-ipc'),
    createWorktree: async input => { calls.create.push(input); await createWorktree?.(input); },
    verifyWorktree: async input => { calls.verify.push(input); await verifyWorktree?.(input); },
    prepare: async (run, endpoint) => { calls.prepare.push({ run, endpoint }); await prepare?.(run, endpoint); },
    ...(revision ? { revision: async run => revision(run) } : {}),
  });
  const scheduler = schedulerFor(store);
  const reopened = [];
  /** A restarted coordinator: the same database, a new store and a new scheduler. The earlier ones are closed first. */
  const reopen = async () => {
    await scheduler.stop(); store.close();
    for (const earlier of reopened) { await earlier.scheduler.stop(); earlier.store.close(); }
    const next = new CoordinatorStore({ databasePath: path.join(directory, 'state.sqlite'), globalConcurrency });
    const nextScheduler = schedulerFor(next);
    reopened.length = 0; reopened.push({ store: next, scheduler: nextScheduler });
    nextScheduler.markInterrupted();
    return { store: next, scheduler: nextScheduler, tick: async () => { await nextScheduler.tick(); await turn(); } };
  };
  t.after(async () => {
    await scheduler.stop(); store.close();
    for (const later of reopened) { await later.scheduler.stop(); later.store.close(); }
    await fs.rm(directory, { recursive: true, force: true });
  });
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
  return { directory, store, scheduler, calls, project, enqueue, tick, reopen, databasePath: path.join(directory, 'state.sqlite') };
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

// --- Owner decisions: idle-gated queueing, once-only continuation and dispatch revalidation ---------------------------------

const R0 = { head: 'b'.repeat(40), digest: 'c'.repeat(64) };
const R1 = { head: 'b'.repeat(40), digest: 'd'.repeat(64) };
const approvalPayload = overrides => ({
  status: 'approval-required', question: 'Ship the change?', scope: 'Merge only the reviewed commit', completedWork: 'Implemented and tested',
  verification: ['npm test: 12 passed'], artifacts: ['src/a.ts'], onApprove: ['Merge the branch'], onRequestChanges: ['Correct and ask again'], ...overrides,
});
const taskT1 = { id: 'T1', title: 'Synthetic task', brief: 'Do it', dependsOn: [], dod: ['gate one'] };
const requestFor = (store, id) => store.latestApproval(id);
const progressOf = (store, id, requestId) => store.approvalProgress(store.getApproval(id, requestId), store.getRun(id));
const eventCount = (store, type) => store.events().filter(event => event.type === type).length;
const code = expected => error => error instanceof CoordinatorError && error.code === expected;

/** A structured executor checkpoint on a running, reserved run: the steps a runner takes before and while it asks for approval. */
function structured(store, id, attempt = 1, claimed) {
  const run = store.getRun(id);
  const caller = { sessionID: run.parentSessionId, id: 'call-' + id, messageID: 'msg-' + id, agent: 'adr-orchestrator' };
  if (!run.binding) store.bindStart(id, run.ownerToken, caller);
  const current = store.getRun(id);
  const attemptId = 'attempt-' + attempt;
  const state = {
    id, status: 'running', adr: '.heimdall/feature.md', parent: run.parentSessionId, caller: claimed ?? current.checkpoint?.caller ?? caller, branch: run.branch, baseline: '',
    index: 0, tasks: [taskT1], results: [], phase: 'executor', child: 'child-session', settings, protocol: 'structured-v1',
    attempt: { id: attemptId, phase: 'executor', index: 0, child: 'child-session', status: 'admitted', startedAt: 1, model: 'anthropic/executor' },
  };
  state.submissionBinding = recordDispatchPrompt(openSubmissionBinding(state, attempt), 'prompt-' + attempt);
  const canonical = payload => ({ ...payload, taskId: 'T1' });
  const receipt = (payload = approvalPayload()) => {
    const contract = contractRef('executor-result');
    return {
      receiptVersion: 1, protocol: 'structured-v1', contract, kind: 'executor-result', runId: id, phase: 'executor', index: 0, taskId: 'T1', attemptId, dispatch: attempt,
      parent: state.parent, child: 'child-session', origin: 'prompt-' + attempt, caller: { sessionID: 'child-session', agent: 'executor', messageID: 'm' + attempt, callId: 'c' + attempt },
      runtime: { packageVersion: '0.0.0', protocol: 'structured-v1' }, outcome: 'approval-required', rawPayload: payload, canonical: canonical(payload),
      digest: contractDigest(contract, canonical(payload)), acceptedAt: 1,
    };
  };
  const paused = { ...state, status: 'paused', attempt: { ...state.attempt, status: 'rejected' }, wait: { kind: 'approval', attemptId, index: 0, taskId: 'T1' } };
  return {
    state, paused, receipt,
    save: value => store.saveCheckpoint(id, store.getRun(id).ownerToken, value),
    publish: (payload, revision = R0) => store.writeSubmission(id, store.getRun(id).ownerToken, receipt(payload), revision),
  };
}
/** Publishes a request and records the runner's pause on it. The run stays reserved until the scheduler observes it idle. */
function ask(store, id, attempt = 1, payload, claimed) {
  const step = structured(store, id, attempt, claimed);
  step.save(step.state);
  step.publish(payload);
  step.save(step.paused);
  return { ...step, request: requestFor(store, id) };
}
const idleOn = () => ({ idle: true, status: 'paused', reason: 'Approval required' });
const activeOn = () => ({ idle: false, status: 'unknown' });

test('approve on a paused, released, idle run queues exactly one resume that is consumed once at dispatch', async t => {
  const f = await fixture(t, { executor: { inspect: async run => run.launchAction === 'resume' ? activeOn() : idleOn() }, revision: async () => R0 });
  f.enqueue(await f.project(), 'run');
  await f.tick();
  const first = f.store.getRun('run');
  const asked = ask(f.store, 'run');
  await f.tick();
  const paused = f.store.getRun('run');
  assert.equal(paused.status, 'paused');
  assert.equal(paused.capacityReserved, false);
  assert.equal(f.calls.launch.length, 1, 'a request alone starts nothing');
  const { requestId } = asked.request;
  // Two submissions of the same decision race on the same proven version: one queue, one stored acknowledgement.
  const acks = await Promise.all([1, 2].map(async () => {
    const proven = await f.scheduler.proveContinuable('run');
    assert.equal(proven.version, paused.version);
    return f.store.decideApproval('run', requestId, { decision: 'approve' }, R0, proven.version);
  }));
  assert.deepEqual(acks.map(ack => ack.retried).sort(), [false, true]);
  assert.ok(acks.every(ack => ack.continuation === 'queued'));
  const queued = f.store.getRun('run');
  assert.equal(queued.status, 'queued');
  assert.equal(queued.launchAction, 'resume');
  assert.notEqual(queued.promptMessageId, first.promptMessageId);
  assert.equal(queued.version, paused.version + 1);
  const context = parseApprovalContext(queued.resolution);
  assert.deepEqual({ requestId: context.requestId, decision: context.decision, feedback: context.feedback, taskId: context.taskId, index: context.index, superseded: context.superseded },
    { requestId, decision: 'approve', feedback: null, taskId: 'T1', index: 0, superseded: undefined });
  assert.deepEqual(context.onApprove, ['Merge the branch']);
  assert.equal(context.scope, 'Merge only the reviewed commit');
  assert.deepEqual(context.revision, R0);
  assert.equal(progressOf(f.store, 'run', requestId), 'queued');
  assert.equal(f.store.getApproval('run', requestId).continuationMessageId, queued.promptMessageId);
  assert.equal(f.store.queueContinuation('run', requestId, paused.version), null, 'a second queue of the same decision is refused');
  assert.equal(f.store.queueContinuation('run', requestId, queued.version), null);
  // A generic resume racing the answered, unconsumed decision is refused, by the scheduler and by the store.
  await assert.rejects(f.scheduler.resume('run', 'approve'), code('approval-pending'));
  assert.throws(() => f.store.queueResume('run', 'approve'), code('approval-pending'));
  assert.throws(() => f.store.queueResume('run', queued.resolution), /cannot be an approval continuation/, 'free text cannot impersonate a decision');
  assert.equal(f.store.getRun('run').version, queued.version);
  await Promise.all([f.tick(), f.tick()]);
  await f.tick();
  assert.equal(f.calls.launch.length, 2, 'exactly one admission');
  const resumed = f.store.getRun('run');
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.capacityReserved, true);
  assert.equal(resumed.launchIntent, true);
  assert.notEqual(resumed.ownerToken, first.ownerToken, 'fresh authority');
  assert.deepEqual([resumed.id, resumed.parentSessionId, resumed.branch, resumed.worktreePath], [first.id, first.parentSessionId, first.branch, first.worktreePath]);
  assert.equal(f.calls.launch[1].resolution, queued.resolution);
  assert.equal(f.store.getApproval('run', requestId).continuation, 'consumed');
  assert.equal(progressOf(f.store, 'run', requestId), 'executing', 'dispatched, but no attempt has carried the decision yet');
  assert.equal(f.store.getApproval('run', requestId).consumedAttemptId, null);
  assert.equal(eventCount(f.store, 'approval.answered'), 1);
  assert.equal(eventCount(f.store, 'approval.continuation_queued'), 1);
  assert.equal(eventCount(f.store, 'approval.consumed'), 1);
  // The same decision never dispatches again, and an identical retry after advancement returns the stored acknowledgement.
  assert.equal(f.store.beginApprovalDispatch('run', resumed.ownerToken, R1), 'authorized');
  assert.equal(f.store.getApproval('run', requestId).continuation, 'consumed');
  assert.deepEqual(f.store.decideApproval('run', requestId, { decision: 'approve' }), { ...acks.find(ack => !ack.retried), retried: true });
  assert.throws(() => f.store.decideApproval('run', requestId, { decision: 'request-changes', feedback: 'late' }), code('approval-conflict'));
  // The resumed attempt pauses again with its own request: the earlier request cannot answer it.
  const claimed = { sessionID: resumed.parentSessionId, id: 'call-resume', messageID: 'msg-resume', agent: 'adr-orchestrator' };
  f.store.bindResume('run', resumed.ownerToken, claimed);
  // The first fresh attempt that carries the delivered decision is the one that consumed it.
  const carrier = structured(f.store, 'run', 2, claimed);
  carrier.save({ ...carrier.state, approval: parseApprovalContext(resumed.resolution) });
  assert.equal(f.store.getApproval('run', requestId).consumedAttemptId, 'attempt-2');
  assert.equal(progressOf(f.store, 'run', requestId), 'consumed');
  assert.equal(f.store.approvalWait(f.store.getRun('run')), null, 'a delivered decision is history');
  const again = ask(f.store, 'run', 2, undefined, claimed);
  assert.notEqual(again.request.requestId, requestId);
  assert.deepEqual(f.store.decideApproval('run', requestId, { decision: 'approve' }), { ...acks.find(ack => !ack.retried), retried: true }, 'the stored acknowledgement, nothing more');
  assert.throws(() => f.store.decideApproval('run', requestId, { decision: 'request-changes', feedback: 'no' }), code('approval-conflict'));
  const second = f.store.getApproval('run', again.request.requestId);
  assert.deepEqual({ state: second.state, continuation: second.continuation }, { state: 'pending', continuation: 'none' });
  assert.equal(f.store.getRun('run').status, 'running');
  assert.equal(eventCount(f.store, 'approval.continuation_queued'), 1);
});

test('a decision recorded while the run is active stays pending and is queued once, only after complete idle proof and open admission', async t => {
  const script = [];
  let observed = activeOn();
  const f = await fixture(t, { executor: { inspect: async () => script.length ? script.shift() : observed }, revision: async () => R0 });
  f.enqueue(await f.project(), 'run');
  await f.tick();
  const asked = ask(f.store, 'run');
  const { requestId } = asked.request;
  const ack = f.store.decideApproval('run', requestId, { decision: 'request-changes', feedback: 'Rename it' }, R0);
  assert.deepEqual({ continuation: ack.continuation, status: ack.run.status }, { continuation: 'pending', status: 'running' });
  assert.equal(progressOf(f.store, 'run', requestId), 'waiting-for-idle');
  for (const value of [activeOn(), { idle: false, status: 'paused' }, { idle: true, status: 'unknown' }]) {
    observed = value;
    await f.tick();
    const run = f.store.getRun('run');
    assert.deepEqual({ status: run.status, reserved: run.capacityReserved }, { status: 'running', reserved: true }, 'capacity is not released early');
    assert.equal(f.store.getApproval('run', requestId).continuation, 'pending');
    assert.equal(f.calls.launch.length, 1);
  }
  // The observation proves idle, but the proof repeated for the continuation is incomplete: released, recorded, not queued.
  script.push(idleOn(), activeOn());
  await f.tick();
  assert.deepEqual({ status: f.store.getRun('run').status, reserved: f.store.getRun('run').capacityReserved }, { status: 'paused', reserved: false });
  assert.equal(f.store.getApproval('run', requestId).continuation, 'pending');
  assert.equal(progressOf(f.store, 'run', requestId), 'recorded');
  assert.equal(eventCount(f.store, 'approval.continuation_queued'), 0);
  // Complete proof, but admission is paused (as while draining): the decision waits.
  observed = idleOn();
  f.scheduler.pauseAdmission();
  await f.tick();
  assert.equal(f.store.getRun('run').status, 'paused');
  assert.equal(f.store.getApproval('run', requestId).continuation, 'pending');
  assert.equal(await f.scheduler.proveContinuable('run'), undefined);
  assert.equal(f.calls.launch.length, 1);
  // A restarted coordinator with open admission queues it once and the ordinary admission launches it.
  const restarted = await f.reopen();
  await restarted.tick();
  observed = activeOn(); // The resumed session is working.
  await restarted.tick();
  assert.equal(f.calls.launch.length, 2);
  assert.equal(restarted.store.getApproval('run', requestId).continuation, 'consumed');
  assert.equal(eventCount(restarted.store, 'approval.continuation_queued'), 1);
  const context = parseApprovalContext(f.calls.launch[1].resolution);
  assert.equal(context.decision, 'request-changes');
  assert.equal(context.feedback, 'Rename it');
  assert.deepEqual(context.onRequestChanges, ['Correct and ask again']);
});

/** Run `a` waits for capacity behind run `b` after its decision was queued. */
async function waitingForCapacity(t, extra = {}) {
  const observed = { a: activeOn(), b: activeOn() };
  const revision = { value: R0 };
  const f = await fixture(t, { globalConcurrency: 1, executor: { inspect: async run => observed[run.id] }, revision: async () => revision.value, ...extra });
  const project = await f.project(2);
  f.enqueue(project, 'a');
  f.enqueue(project, 'b');
  await f.tick();
  const asked = ask(f.store, 'a');
  observed.a = idleOn();
  await f.tick(); // a is observed idle and released; b takes the capacity.
  assert.equal(f.store.getRun('b').capacityReserved, true);
  const proven = await f.scheduler.proveContinuable('a');
  const ack = f.store.decideApproval('a', asked.request.requestId, { decision: 'approve' }, R0, proven.version);
  assert.equal(ack.continuation, 'queued');
  assert.equal(f.store.getRun('a').status, 'queued');
  assert.equal(progressOf(f.store, 'a', asked.request.requestId), 'queued');
  await f.tick();
  assert.equal(f.store.getRun('a').status, 'queued', 'waiting for capacity');
  return { f, observed, revision, requestId: asked.request.requestId };
}

test('content changed after acceptance while waiting for capacity supersedes the decision at dispatch', async t => {
  const { f, observed, revision, requestId } = await waitingForCapacity(t);
  revision.value = R1; // committed and uncommitted reviewed content changed
  observed.b = { idle: true, status: 'succeeded' };
  await f.tick();
  const run = f.store.getRun('a');
  assert.equal(run.status, 'running');
  assert.deepEqual(f.calls.launch.map(launched => launched.id), ['a', 'b', 'a']);
  const delivered = parseApprovalContext(f.calls.launch[2].resolution);
  assert.equal(delivered.superseded.reason, 'The reviewed worktree changed after the decision was recorded');
  assert.equal(parseApprovalContext(run.resolution).superseded !== undefined, true, 'the stored resolution is the superseded one');
  const stored = f.store.getApproval('a', requestId);
  assert.equal(stored.continuation, 'superseded');
  assert.equal(stored.state, 'answered');
  assert.equal(progressOf(f.store, 'a', requestId), 'superseded');
  assert.equal(eventCount(f.store, 'approval.consumed'), 0);
  assert.equal(eventCount(f.store, 'approval.superseded'), 1);
  assert.equal(run.launchIntent, true);
  // Neither blocking a later generic resume nor requeueing the withdrawn decision.
  assert.doesNotThrow(() => f.store.assertNoUnresolvedApproval('a'));
  await f.tick();
  assert.equal(f.calls.launch.length, 3);
});

test('a restart while the decision waits for capacity keeps it queued once; unchanged content is consumed, changed content is superseded', async t => {
  for (const changed of [false, true]) await t.test(changed ? 'changed' : 'unchanged', async child => {
    const { f, observed, revision, requestId } = await waitingForCapacity(child);
    const restarted = await f.reopen();
    assert.equal(restarted.store.getRun('a').status, 'queued');
    assert.equal(restarted.store.getApproval('a', requestId).continuation, 'queued');
    assert.equal(restarted.store.getRun('b').status, 'reconciliation-required');
    assert.equal(restarted.store.getRun('b').capacityReserved, true, 'the retained run keeps its capacity');
    await restarted.tick();
    assert.equal(restarted.store.getRun('a').status, 'queued');
    if (changed) revision.value = R1;
    observed.b = { idle: true, status: 'succeeded' };
    await restarted.scheduler.reconcile('b');
    await restarted.tick();
    assert.equal(restarted.store.getRun('a').status, 'running');
    assert.deepEqual(f.calls.launch.map(launched => launched.id), ['a', 'b', 'a']);
    assert.equal(restarted.store.getApproval('a', requestId).continuation, changed ? 'superseded' : 'consumed');
    assert.equal(parseApprovalContext(f.calls.launch[2].resolution).superseded !== undefined, changed);
    assert.equal(eventCount(restarted.store, 'approval.continuation_queued'), 1);
    observed.a = activeOn(); // The resumed session is working.
    await restarted.tick();
    assert.equal(f.calls.launch.length, 3);
  });
});

function inject(f, statement) {
  const database = new DatabaseSync(f.databasePath);
  try { database.exec(statement); } finally { database.close(); }
}

test('a failure at request publication, response persistence, queueing or admission leaves no accepted response or exactly one continuation', async t => {
  await t.test('request publication', async child => {
    const f = await fixture(child, { executor: { inspect: async () => idleOn() }, revision: async () => R0 });
    f.enqueue(await f.project(), 'run');
    await f.tick();
    const step = structured(f.store, 'run');
    step.save(step.state);
    inject(f, "CREATE TRIGGER fail_publication BEFORE INSERT ON approval_requests BEGIN SELECT RAISE(ABORT, 'injected publication failure'); END");
    assert.throws(() => step.publish(), /injected publication failure/);
    assert.equal(f.store.readSubmission('run', f.store.getRun('run').ownerToken, 'attempt-1', 'executor-result'), undefined, 'no receipt without its request');
    assert.equal(f.store.latestApproval('run'), null);
    assert.equal(eventCount(f.store, 'approval.requested'), 0);
    inject(f, 'DROP TRIGGER fail_publication');
    step.publish();
    step.publish();
    assert.equal(eventCount(f.store, 'approval.requested'), 1);
    assert.equal(f.store.latestApproval('run').state, 'pending');
  });

  await t.test('response persistence', async child => {
    const f = await fixture(child, { executor: { inspect: async () => idleOn() }, revision: async () => R0 });
    f.enqueue(await f.project(), 'run');
    await f.tick();
    const { request } = ask(f.store, 'run');
    await f.tick();
    const before = f.store.getRun('run');
    inject(f, "CREATE TRIGGER fail_response BEFORE UPDATE ON approval_requests WHEN NEW.state = 'answered' BEGIN SELECT RAISE(ABORT, 'injected response failure'); END");
    assert.throws(() => f.store.decideApproval('run', request.requestId, { decision: 'approve' }, R0, before.version), /injected response failure/);
    assert.equal(f.store.getApproval('run', request.requestId).state, 'pending', 'no accepted response');
    assert.deepEqual(f.store.getRun('run'), before);
    assert.equal(eventCount(f.store, 'approval.answered'), 0);
    await f.tick();
    assert.equal(f.calls.launch.length, 1);
    inject(f, 'DROP TRIGGER fail_response');
    f.store.decideApproval('run', request.requestId, { decision: 'approve' }, R0, before.version);
    await f.tick();
    assert.equal(f.calls.launch.length, 2);
    assert.equal(eventCount(f.store, 'approval.answered'), 1);
  });

  await t.test('queueing', async child => {
    let observed = idleOn();
    const f = await fixture(child, { executor: { inspect: async () => observed }, revision: async () => R0 });
    f.enqueue(await f.project(), 'run');
    await f.tick();
    const { request } = ask(f.store, 'run');
    await f.tick();
    const before = f.store.getRun('run');
    inject(f, "CREATE TRIGGER fail_queue BEFORE UPDATE ON runs WHEN NEW.status = 'queued' BEGIN SELECT RAISE(ABORT, 'injected queue failure'); END");
    // Recording and queueing are one transaction: neither is kept.
    assert.throws(() => f.store.decideApproval('run', request.requestId, { decision: 'approve' }, R0, before.version), /injected queue failure/);
    assert.equal(f.store.getApproval('run', request.requestId).state, 'pending');
    // A decision recorded without queueing stays pending while the queue operation fails, and nothing is lost or duplicated.
    f.store.decideApproval('run', request.requestId, { decision: 'approve' }, R0);
    assert.equal(f.store.getApproval('run', request.requestId).continuation, 'pending');
    await f.tick();
    await f.tick();
    assert.deepEqual({ status: f.store.getRun('run').status, continuation: f.store.getApproval('run', request.requestId).continuation, launches: f.calls.launch.length }, { status: 'paused', continuation: 'pending', launches: 1 });
    inject(f, 'DROP TRIGGER fail_queue');
    await f.tick();
    observed = activeOn(); // The resumed session is working.
    await f.tick();
    assert.equal(f.calls.launch.length, 2);
    assert.equal(eventCount(f.store, 'approval.continuation_queued'), 1);
    assert.equal(f.store.getApproval('run', request.requestId).continuation, 'consumed');
  });

  await t.test('admission before dispatch, then reconciliation', async child => {
    let failPrepare = true;
    let observed = activeOn();
    const f = await fixture(child, { executor: { inspect: async () => observed }, revision: async () => R0, prepare: async run => { if (failPrepare && run.launchAction === 'resume') throw new Error('Preparation could not be confirmed'); } });
    f.enqueue(await f.project(), 'run');
    await f.tick();
    const { request } = ask(f.store, 'run');
    observed = idleOn();
    await f.tick();
    f.store.decideApproval('run', request.requestId, { decision: 'approve' }, R0);
    await f.tick();
    await f.tick();
    const retained = f.store.getRun('run');
    assert.deepEqual({ status: retained.status, reserved: retained.capacityReserved, intent: retained.launchIntent }, { status: 'reconciliation-required', reserved: true, intent: false });
    assert.equal(f.store.getApproval('run', request.requestId).continuation, 'queued', 'not consumed before the dispatch boundary');
    assert.equal(f.calls.launch.length, 1);
    observed = activeOn();
    assert.equal((await f.scheduler.reconcile('run')).capacityReserved, true, 'native-uncertain keeps its capacity');
    failPrepare = false;
    observed = idleOn();
    const released = await f.scheduler.reconcile('run');
    assert.deepEqual({ status: released.status, reserved: released.capacityReserved }, { status: 'paused', reserved: false });
    await f.tick();
    observed = activeOn(); // The resumed session is working.
    await f.tick();
    assert.equal(f.calls.launch.length, 2, 'one later continuation');
    assert.equal(f.store.getApproval('run', request.requestId).continuation, 'consumed');
    assert.equal(eventCount(f.store, 'approval.continuation_queued'), 2, 'the unconsumed queue was refreshed, never doubled');
    assert.equal(eventCount(f.store, 'approval.consumed'), 1);
  });

  await t.test('launch failure after the dispatch boundary keeps capacity, never reports the decision delivered and recovers it once', async child => {
    let observed = activeOn();
    let failLaunch = false;
    const f = await fixture(child, { executor: { inspect: async () => observed, launch: async () => { if (failLaunch) throw new Error('Native launch outcome unknown'); } }, revision: async () => R0 });
    f.enqueue(await f.project(), 'run');
    await f.tick();
    const { request } = ask(f.store, 'run');
    observed = idleOn();
    await f.tick();
    failLaunch = true;
    f.store.decideApproval('run', request.requestId, { decision: 'approve' }, R0);
    await f.tick();
    await f.tick();
    const uncertain = f.store.getRun('run');
    assert.deepEqual({ status: uncertain.status, reserved: uncertain.capacityReserved, intent: uncertain.launchIntent }, { status: 'reconciliation-required', reserved: true, intent: true });
    assert.equal(f.store.getApproval('run', request.requestId).continuation, 'consumed');
    assert.equal(f.store.getApproval('run', request.requestId).consumedAttemptId, null);
    assert.notEqual(progressOf(f.store, 'run', request.requestId), 'consumed', 'no attempt carried the decision');
    observed = activeOn();
    assert.equal((await f.scheduler.reconcile('run')).capacityReserved, true);
    failLaunch = false;
    observed = idleOn();
    assert.equal((await f.scheduler.reconcile('run')).status, 'paused');
    // The run is paused again on the asking task: the decision was lost at the boundary, so it is still owed and still shown.
    assert.equal(progressOf(f.store, 'run', request.requestId), 'waiting-for-idle', 'not reported as delivered');
    assert.notEqual(f.store.approvalWait(f.store.getRun('run')), null);
    assert.throws(() => f.store.queueResume('run', 'approve'), code('approval-pending'));
    assert.equal(f.store.pendingContinuations().length, 1);
    await f.tick();
    observed = activeOn(); // The resumed session is working now.
    await f.tick();
    await f.tick();
    assert.equal(f.calls.launch.length, 3, 'delivered once more, by exactly one further admission');
    assert.equal(parseApprovalContext(f.calls.launch[2].resolution).requestId, request.requestId);
    assert.equal(eventCount(f.store, 'approval.continuation_queued'), 2);
    assert.equal(eventCount(f.store, 'approval.consumed'), 2);
    assert.equal(f.store.getApproval('run', request.requestId).continuation, 'consumed');
    await f.tick();
    assert.equal(f.calls.launch.length, 3, 'never a third admission');
    // Delivered at last: the resumed attempt carries the decision, and only then is it consumed and history.
    const resumed = f.store.getRun('run');
    const claimed = { sessionID: resumed.parentSessionId, id: 'call-resume', messageID: 'msg-resume', agent: 'adr-orchestrator' };
    f.store.bindResume('run', resumed.ownerToken, claimed);
    const carrier = structured(f.store, 'run', 2, claimed);
    carrier.save({ ...carrier.state, approval: parseApprovalContext(resumed.resolution) });
    assert.equal(f.store.getApproval('run', request.requestId).consumedAttemptId, 'attempt-2');
    assert.equal(progressOf(f.store, 'run', request.requestId), 'consumed');
    assert.equal(f.store.pendingContinuations().length, 0);
  });

  await t.test('restart between queueing and dispatch', async child => {
    let observed = activeOn();
    const f = await fixture(child, { executor: { inspect: async () => observed }, revision: async () => R0 });
    f.enqueue(await f.project(), 'run');
    await f.tick();
    const { request } = ask(f.store, 'run');
    observed = idleOn();
    await f.tick();
    f.store.decideApproval('run', request.requestId, { decision: 'approve' }, R0, f.store.getRun('run').version);
    assert.ok(f.store.admitNext(), 'admitted, but the process ends before it dispatches');
    const restarted = await f.reopen();
    const interrupted = restarted.store.getRun('run');
    assert.deepEqual({ status: interrupted.status, reserved: interrupted.capacityReserved, intent: interrupted.launchIntent }, { status: 'reconciliation-required', reserved: true, intent: false });
    assert.equal(restarted.store.getApproval('run', request.requestId).continuation, 'queued');
    observed = activeOn();
    await assert.rejects(restarted.scheduler.reconcile('run').then(run => { assert.equal(run.capacityReserved, true); throw new Error('retained'); }), /retained/);
    observed = idleOn();
    assert.equal((await restarted.scheduler.reconcile('run')).status, 'paused');
    await restarted.tick();
    observed = activeOn(); // The resumed session is working.
    await restarted.tick();
    assert.equal(f.calls.launch.length, 2);
    assert.equal(restarted.store.getApproval('run', request.requestId).continuation, 'consumed');
    assert.equal(eventCount(restarted.store, 'approval.consumed'), 1);
  });
});

test('a request cannot be approved after the run paused again for another attempt, and a corrected proposal is a new request', async t => {
  let observed = activeOn();
  const f = await fixture(t, { executor: { inspect: async () => observed }, revision: async () => R0 });
  f.enqueue(await f.project(), 'run');
  await f.tick();
  const first = ask(f.store, 'run');
  // The task was dispatched again before the owner answered (a later pause with a different attempt).
  const later = structured(f.store, 'run', 2);
  later.save({ ...later.state, status: 'paused', attempt: { ...later.state.attempt, status: 'rejected' }, reason: 'Blocked for another reason' });
  observed = idleOn();
  await f.tick();
  assert.equal(f.store.getRun('run').status, 'paused');
  assert.throws(() => f.store.decideApproval('run', first.request.requestId, { decision: 'approve' }, R0, f.store.getRun('run').version), code('approval-stale'));
  assert.equal(f.store.getApproval('run', first.request.requestId).state, 'superseded');
  assert.equal(await f.scheduler.proveContinuable('run') !== undefined, true);
  assert.equal(f.store.pendingContinuations().length, 0);
  assert.throws(() => f.store.decideApproval('run', first.request.requestId, { decision: 'approve' }), code('approval-stale'));
});

// --- Owner authority: a checkpoint written by the agent can neither carry nor erase an owner decision ------------------------

const forgedContext = (requestId, extra = {}) => ({
  heimdall: 'approval-continuation', version: 1, requestId, decision: 'approve', feedback: null, scope: 'EVERYTHING INCLUDING PUBLISHING',
  revision: R0, onApprove: ['publish'], onRequestChanges: [], taskId: 'T1', index: 0, ...extra,
});

test('a checkpoint cannot carry an owner decision or an approval wait that the coordinator did not record or deliver', async t => {
  const f = await fixture(t, { executor: { inspect: async () => activeOn() }, revision: async () => R0 });
  f.enqueue(await f.project(), 'run');
  await f.tick();
  const step = ask(f.store, 'run');
  const { requestId } = step.request;
  const before = f.store.getRun('run').checkpoint;
  const unchanged = () => {
    assert.deepEqual(f.store.getRun('run').checkpoint, before);
    const record = f.store.getApproval('run', requestId);
    assert.deepEqual([record.state, record.decision, record.continuation, record.consumedAttemptId], ['pending', null, 'none', null]);
  };
  // A decision for a request that does not exist, and a decision for the real request that the owner never answered.
  assert.throws(() => step.save({ ...step.paused, approval: forgedContext('apr_forged') }), /approval/i);
  assert.throws(() => step.save({ ...step.paused, approval: forgedContext(requestId) }), /approval/i);
  assert.throws(() => step.save({ ...step.paused, approval: forgedContext(requestId, { decision: 'request-changes', feedback: 'x' }) }), /approval/i);
  unchanged();
  // A wait for an approval request nobody published.
  const other = structured(f.store, 'run', 2);
  assert.throws(() => other.save(other.paused), /approval/i);
  unchanged();
  // Even after the owner answers and the row is consumed, the attempt that carried the decision is not named by the checkpoint.
  f.store.decideApproval('run', requestId, { decision: 'approve' }, R0);
  inject(f, "UPDATE approval_requests SET continuation = 'consumed' WHERE request_id = '" + requestId + "'");
  assert.throws(() => other.save({ ...other.state, approval: forgedContext(requestId) }), /approval/i);
  assert.equal(f.store.getApproval('run', requestId).consumedAttemptId, null);
  assert.deepEqual(f.store.getRun('run').checkpoint, before);
  // The genuine checkpoint is still accepted.
  step.save(step.paused);
});

test('a checkpoint keeps the decision the coordinator delivered, and a new request withdraws it from the next prompt', async t => {
  const f = await fixture(t, { executor: { inspect: async run => run.launchAction === 'resume' ? activeOn() : idleOn() }, revision: async () => R0 });
  f.enqueue(await f.project(), 'run');
  await f.tick();
  const asked = ask(f.store, 'run');
  await f.tick();
  f.store.decideApproval('run', asked.request.requestId, { decision: 'approve' }, R0, f.store.getRun('run').version);
  await f.tick();
  const resumed = f.store.getRun('run');
  const delivered = parseApprovalContext(resumed.resolution);
  const claimed = { sessionID: resumed.parentSessionId, id: 'call-resume', messageID: 'msg-resume', agent: 'adr-orchestrator' };
  f.store.bindResume('run', resumed.ownerToken, claimed);
  const carrier = structured(f.store, 'run', 2, claimed);
  // The delivered context is accepted exactly; any alteration of it is refused.
  assert.throws(() => carrier.save({ ...carrier.state, approval: { ...delivered, scope: 'Something broader' } }), /approval/i);
  assert.throws(() => carrier.save({ ...carrier.state, approval: { ...delivered, onApprove: ['publish'] } }), /approval/i);
  carrier.save({ ...carrier.state, approval: delivered });
  assert.deepEqual(f.store.getRun('run').checkpoint.approval, delivered);
  // A later write may keep it or drop it (the task advanced) but never replace it.
  carrier.save({ ...carrier.state, approval: delivered, reason: 'still the same' });
  assert.throws(() => carrier.save({ ...carrier.state, approval: forgedContext('apr_forged') }), /approval/i);
  carrier.save(carrier.state);
  assert.equal(f.store.getRun('run').checkpoint.approval, undefined);
});

test('a decision the runner dropped for a fresh request cannot be written back into the checkpoint', async t => {
  const f = await fixture(t, { executor: { inspect: async run => run.launchAction === 'resume' ? activeOn() : idleOn() }, revision: async () => R0 });
  f.enqueue(await f.project(), 'run');
  await f.tick();
  const asked = ask(f.store, 'run');
  await f.tick();
  f.store.decideApproval('run', asked.request.requestId, { decision: 'approve' }, R0, f.store.getRun('run').version);
  await f.tick();
  const resumed = f.store.getRun('run');
  const delivered = parseApprovalContext(resumed.resolution);
  const claimed = { sessionID: resumed.parentSessionId, id: 'call-resume', messageID: 'msg-resume', agent: 'adr-orchestrator' };
  f.store.bindResume('run', resumed.ownerToken, claimed);
  const carrier = structured(f.store, 'run', 2, claimed);
  carrier.save({ ...carrier.state, approval: delivered });
  // The runner drops the approval when a fresh request for changed material is admitted. The coordinator still holds the delivered
  // text as the run's resolution, but a checkpoint may no longer bring the earlier approval back.
  carrier.save(carrier.state);
  assert.equal(f.store.getRun('run').checkpoint.approval, undefined);
  assert.throws(() => carrier.save({ ...carrier.state, approval: delivered }), /approval/i);
  assert.equal(f.store.getRun('run').checkpoint.approval, undefined);
});
