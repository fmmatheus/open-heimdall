import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { childExecutionBlocked, isWorkflowChild } from '../dist/workflow/child-ownership.js';
import { BACKGROUND_DENIAL, createOwnershipGuard, OWNERSHIP_DENIAL } from '../dist/opencode/ownership-guard.js';
import { createCoordinatorClient } from '../dist/coordinator/client.js';
import { readCoordinatorToken, startCoordinatorService } from '../dist/coordinator/service.js';

const settings = { plannerAgent: 'adr-planner', executorAgent: 'adr-executor' };
const checkpoint = () => ({
  id: 'run', parent: 'ses_parent', status: 'running', phase: 'executor', index: 0, child: 'ses_child', settings,
  tasks: [{ id: 'T1' }], results: [], usage: { ses_old: 1 },
  attempt: { id: 'attempt', child: 'ses_child', phase: 'executor', index: 0, status: 'admitted' },
});
const binding = (state = checkpoint()) => ({ protocol: 'structured-v1', kind: 'executor-result', runId: state.id, parent: state.parent, child: state.child, phase: state.phase, index: state.index, taskId: 'T1', attemptId: state.attempt.id, dispatch: 1, prompt: 'msg_prompt', status: 'open' });

async function fixture(t, { managed = true, permission = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-ownership-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, '.heimdall'));
  const metadataFile = path.join(directory, '.heimdall', 'managed.json');
  let metadata = { endpoint: '/synthetic.sock', runId: 'run', parentSessionId: 'ses_parent', ownerToken: 'synthetic-owner' };
  if (managed) await fs.writeFile(metadataFile, JSON.stringify(metadata));
  let run = { id: 'run', parentSessionId: 'ses_parent', worktreePath: directory, specification: { settings }, status: 'running', capacityReserved: true, ownerToken: metadata.ownerToken, checkpoint: checkpoint() };
  let unavailable = false, nativeUnavailable = false;
  const sessions = new Map([
    ['ses_child', { id: 'ses_child', parentID: 'ses_parent' }], ['ses_old', { id: 'ses_old', parentID: 'ses_parent' }],
    ['ses_unrecorded', { id: 'ses_unrecorded', parentID: 'ses_parent' }], ['ses_other', { id: 'ses_other', parentID: 'ses_unrelated_parent' }],
    ['ses_unrelated_parent', { id: 'ses_unrelated_parent' }],
    ['ses_parent', { id: 'ses_parent' }],
  ]);
  const hooks = new Map(), calls = [], disposed = [];
  const register = (name, callback) => { hooks.set(name, callback); return { dispose: async () => { disposed.push(name); hooks.delete(name); } }; };
  const client = endpoint => ({ request: async (...args) => {
    calls.push([endpoint, ...args]);
    assert.equal(args[0], 'GET'); assert.equal(args[1], '/runs/run'); assert.equal(args[3], metadata.ownerToken);
    if (unavailable) throw new Error('Synthetic unavailable coordinator');
    return structuredClone(run);
  } });
  const ctx = {
    location: { directory },
    tool: { hook: async (name, callback) => register('tool.' + name, callback) },
    session: { get: async ({ sessionID }) => { if (nativeUnavailable) throw new Error('Synthetic unavailable native session'); return sessions.get(sessionID); }, hook: async (name, callback) => register('session.' + name, callback) },
    ...(permission ? { permission: { hook: async (name, callback) => register('permission.' + name, callback) } } : {}),
  };
  const plugin = createOwnershipGuard({ client });
  const setup = () => plugin.setup(ctx);
  const cleanup = await setup();
  const call = (tool = 'shell', input = {}, sessionID = 'ses_child', agent = 'adr-executor') => hooks.get('tool.execute.before')({ tool, input, sessionID, agent, messageID: 'msg', id: 'call' });
  const context = async (sessionID = 'ses_child', agent = 'adr-executor') => {
    const event = { sessionID, agent, tools: { shell: {}, write: {}, 'native.shell': {}, heimdall_submit_result: {} } };
    await hooks.get('session.context')(event);
    return event;
  };
  return { directory, metadataFile, hooks, sessions, calls, disposed, cleanup, setup, call, context,
    get run() { return run; }, set run(value) { run = value; }, set unavailable(value) { unavailable = value; }, set nativeUnavailable(value) { nativeUnavailable = value; },
    async metadata(value) { metadata = value; await fs.writeFile(metadataFile, JSON.stringify(value)); },
  };
}

test('child ownership survives phase completion, agent changes and legacy checkpoints', () => {
  const state = checkpoint();
  assert.equal(childExecutionBlocked(state, 'ses_child', 'adr-executor'), false);
  for (const mutate of [
    s => { s.status = 'paused'; }, s => { s.status = 'completed'; }, s => { s.attempt.status = 'rejected'; },
    s => { s.attempt.status = 'interrupted'; }, s => { s.attempt.index = 1; }, s => { s.attempt.phase = 'planner'; },
    s => { s.attempt.child = 'ses_another'; }, s => { delete s.attempt; },
    s => { s.submissionBinding = { ...binding(s), status: 'closed' }; },
    s => { s.submissionBinding = { ...binding(s), attemptId: 'stale_attempt' }; },
  ]) {
    const changed = structuredClone(state); mutate(changed);
    assert.equal(childExecutionBlocked(changed, 'ses_child', 'adr-executor'), true);
  }
  for (const field of ['sealed', 'refused', 'negative', 'conflict']) {
    const changed = { ...state, submissionRepair: { [field]: { attemptId: state.attempt.id } } };
    assert.equal(childExecutionBlocked(changed, 'ses_child'), true, field);
    changed.submissionRepair[field].attemptId = 'old_attempt';
    assert.equal(childExecutionBlocked(changed, 'ses_child'), false, 'fresh attempt releases ' + field);
  }
  assert.equal(childExecutionBlocked(state, 'ses_child', 'build'), true);
  assert.equal(childExecutionBlocked(state, 'ses_old', 'adr-executor'), true);
  assert.equal(childExecutionBlocked(state, 'ses_other', 'adr-executor'), false);
  assert.equal(isWorkflowChild({ ...state, child: null, attempt: undefined, results: [{ sessionId: 'ses_finished' }] }, 'ses_finished'), true);
  assert.equal(isWorkflowChild(state, state.parent), false);
});

test('global ownership guard is inert outside managed worktrees and disposes all hooks', async t => {
  const unmanaged = await fixture(t, { managed: false });
  assert.equal(unmanaged.hooks.size, 0);
  assert.equal(unmanaged.cleanup, undefined);
  const managed = await fixture(t);
  assert.deepEqual([...managed.hooks.keys()], ['tool.execute.before', 'session.context', 'permission.evaluate']);
  await managed.cleanup();
  assert.equal(managed.hooks.size, 0);
  assert.equal(managed.disposed.length, 3);
});

test('late background continuation after missing submission is denied through every hook after reload', async t => {
  const f = await fixture(t);
  await f.call('shell', { command: 'npm test' });
  f.run.checkpoint.status = 'paused';
  f.run.checkpoint.attempt.status = 'rejected';
  f.run.status = 'paused'; f.run.capacityReserved = false;
  const before = JSON.stringify(f.run);
  for (const tool of ['write', 'shell', 'native.shell', 'execute', 'heimdall_submit_result']) await assert.rejects(f.call(tool, {}), error => error.message === OWNERSHIP_DENIAL);
  assert.deepEqual((await f.context()).tools, {});
  const permission = { sessionID: 'ses_child', agent: 'adr-executor', action: 'write', effect: 'allow' };
  await f.hooks.get('permission.evaluate')(permission);
  assert.equal(permission.effect, 'deny');
  await f.cleanup();
  const cleanup = await f.setup();
  await assert.rejects(f.call('shell', { command: 'git commit -am late' }), error => error.message === OWNERSHIP_DENIAL);
  assert.equal(JSON.stringify(f.run), before, 'the guard never rewrites a run or its pinned runtime');
  await cleanup();
});

test('only current active child can implement; stale child, changed role and absent capacity cannot', async t => {
  const f = await fixture(t);
  await f.call('write');
  await assert.rejects(f.call('write', {}, 'ses_old'), /no active workflow ownership/);
  await assert.rejects(f.call('write', {}, 'ses_unrecorded'), /no active workflow ownership/);
  await assert.rejects(f.call('write', {}, 'ses_child', 'build'), /no active workflow ownership/);
  f.run.capacityReserved = false;
  await assert.rejects(f.call('shell'), /no active workflow ownership/);
  f.run.capacityReserved = true; f.run.checkpoint.status = 'completed';
  await assert.rejects(f.call('shell'), /no active workflow ownership/);
  const unrelated = await f.context('ses_other');
  assert.deepEqual(Object.keys(unrelated.tools), ['shell', 'write', 'native.shell', 'heimdall_submit_result']);
  await f.call('shell', { background: true }, 'ses_other');
  await f.cleanup();
});

test('managed background tool flags are denied while foreground native and namespaced shell remain allowed', async t => {
  const f = await fixture(t);
  for (const tool of ['shell', 'native.shell', 'mcp__openchamber__shell', 'execute']) {
    await assert.rejects(f.call(tool, { background: true }), error => error.message === BACKGROUND_DENIAL);
    await assert.rejects(f.call(tool, { calls: [{ input: { run_in_background: true } }] }), error => error.message === BACKGROUND_DENIAL);
    await f.call(tool, { background: false });
  }
  await f.cleanup();
});

test('native first-tool race is admitted only after reserved launch intent and a running child checkpoint', async t => {
  const f = await fixture(t);
  f.run.status = 'preparing'; f.run.launchIntent = true;
  await f.call('write');
  f.run.launchIntent = false;
  await assert.rejects(f.call('write'), /no active workflow ownership/);
  f.run.launchIntent = true; f.run.checkpoint.status = 'paused';
  await assert.rejects(f.call('write'), /no active workflow ownership/);
  await f.cleanup();
});

test('current owner resume and new attempt restore ownership without admitting old sealed authority', async t => {
  const f = await fixture(t);
  const state = f.run.checkpoint;
  state.protocol = 'structured-v1'; state.submissionBinding = binding(state);
  state.submissionRepair = { sealed: { attemptId: 'attempt' } };
  await assert.rejects(f.call('write'), /no active workflow ownership/);
  // The exact bound reporting tool remains available for format repair; implementation remains sealed.
  await f.call('heimdall_submit_result');
  state.submissionRepair.conflict = { attemptId: 'attempt' };
  await assert.rejects(f.call('heimdall_submit_result'), /no active workflow ownership/);
  delete state.submissionRepair.conflict;
  state.attempt = { ...state.attempt, id: 'new_attempt', status: 'launching' };
  state.submissionBinding = { ...binding(state), prompt: null };
  await f.metadata({ endpoint: '/synthetic.sock', runId: 'run', parentSessionId: 'ses_parent', ownerToken: 'resumed-owner' });
  f.run.ownerToken = 'resumed-owner';
  await f.call('write');
  assert.equal(f.calls.at(-1)[4], 'resumed-owner');
  state.submissionBinding.status = 'closed';
  await assert.rejects(f.call('write'), /no active workflow ownership/);
  await f.cleanup();
});

test('coordinator, identity and native verification failures deny managed children without affecting unrelated sessions', async t => {
  const f = await fixture(t);
  f.unavailable = true;
  await assert.rejects(f.call('write'), /no active workflow ownership/);
  assert.deepEqual((await f.context()).tools, {});
  await f.call('write', {}, 'ses_other');
  f.unavailable = false;
  f.run.worktreePath = '/synthetic/wrong-worktree';
  await assert.rejects(f.call('write'), /no active workflow ownership/);
  f.run.worktreePath = f.directory;
  f.run.checkpoint.parent = 'ses_wrong';
  await assert.rejects(f.call('write'), /no active workflow ownership/);
  f.run.checkpoint.parent = 'ses_parent';
  f.nativeUnavailable = true;
  await assert.rejects(f.call('write'), /no active workflow ownership/);
  f.nativeUnavailable = false;
  await f.metadata({ endpoint: '/other.sock', runId: 'run', parentSessionId: 'ses_parent', ownerToken: 'synthetic-owner' });
  await assert.rejects(f.call('write'), /no active workflow ownership/);
  await f.cleanup();
});

test('managed parent is limited to native workflow invocation regardless of agent role', async t => {
  const f = await fixture(t);
  await f.call('adr_workflow', {}, 'ses_parent', 'adr-orchestrator');
  await f.call('native.adr_workflow', {}, 'ses_parent', 'adr-orchestrator');
  await assert.rejects(f.call('shell', {}, 'ses_parent', 'build'), /no active workflow ownership/);
  const permission = { sessionID: 'ses_other', agent: 'adr-executor', action: 'write', effect: 'allow' };
  await f.hooks.get('permission.evaluate')(permission);
  assert.equal(permission.effect, 'allow');
  await f.cleanup();
});

test('native parent executor permission belongs to the admitted workflow call for planner, executor and resume', async t => {
  const f = await fixture(t);
  const state = f.run.checkpoint;
  const caller = { sessionID: 'ses_parent', agent: 'adr-orchestrator', id: 'workflow_call', messageID: 'workflow_message' };
  state.caller = caller;
  const permission = role => ({ sessionID: caller.sessionID, agent: caller.agent, action: 'subagent', resources: [role],
    source: { type: 'tool', id: caller.id, messageID: caller.messageID }, effect: 'allow' });
  const executor = permission('adr-executor');
  await f.hooks.get('permission.evaluate')(executor);
  assert.equal(executor.effect, 'allow');
  state.phase = 'planner'; state.child = null;
  state.attempt = { ...state.attempt, phase: 'planner', child: null, status: 'launching' };
  f.run.status = 'preparing'; f.run.launchIntent = true;
  const planner = permission('adr-planner');
  await f.hooks.get('permission.evaluate')(planner);
  assert.equal(planner.effect, 'allow', 'first planner dispatch precedes native child creation');
  state.phase = 'executor'; state.child = 'ses_child';
  state.attempt = { ...state.attempt, id: 'resumed_attempt', phase: 'executor', child: state.child };
  f.run.status = 'running'; state.caller = { ...caller, id: 'resumed_workflow_call', messageID: 'resumed_workflow_message' };
  const resumed = { ...permission('adr-executor'), source: { type: 'tool', id: state.caller.id, messageID: state.caller.messageID } };
  await f.hooks.get('permission.evaluate')(resumed);
  assert.equal(resumed.effect, 'allow');
  const alreadyDenied = { ...resumed, effect: 'deny' };
  await f.hooks.get('permission.evaluate')(alreadyDenied);
  assert.equal(alreadyDenied.effect, 'deny', 'the guard never overrides another native policy denial');
  await assert.rejects(f.call('subagent', {}, 'ses_parent', 'adr-orchestrator'), /no active workflow ownership/);
  const context = { sessionID: 'ses_parent', agent: 'adr-orchestrator', tools: { adr_workflow: {}, subagent: {}, shell: {} } };
  await f.hooks.get('session.context')(context);
  assert.deepEqual(Object.keys(context.tools), ['adr_workflow']);
  await f.cleanup();
});

test('parent executor permission rejects spoofed call identity, wrong targets and inactive ownership', async t => {
  const f = await fixture(t);
  const caller = { sessionID: 'ses_parent', agent: 'adr-orchestrator', id: 'workflow_call', messageID: 'workflow_message' };
  f.run.checkpoint.caller = caller;
  const valid = () => ({ sessionID: caller.sessionID, agent: caller.agent, action: 'subagent', resources: ['adr-executor'],
    source: { type: 'tool', id: caller.id, messageID: caller.messageID }, effect: 'allow' });
  for (const change of [
    event => { delete event.source; }, event => { event.source.type = 'manual'; },
    event => { event.source.id = 'manual_subagent_call'; }, event => { event.source.messageID = 'other_message'; },
    event => { event.resources = ['adr-planner']; }, event => { event.resources = ['adr-executor', 'adr-planner']; },
    event => { event.resources = []; }, event => { event.agent = 'build'; },
    event => { event.sessionID = 'ses_child'; }, event => { event.action = 'native.subagent'; },
  ]) {
    const event = valid(); change(event);
    await f.hooks.get('permission.evaluate')(event);
    assert.equal(event.effect, 'deny');
  }
  const baseline = structuredClone(f.run);
  for (const change of [
    run => { run.status = 'paused'; }, run => { run.capacityReserved = false; }, run => { run.ownerToken = 'stale-owner'; },
    run => { run.checkpoint.status = 'paused'; }, run => { run.checkpoint.phase = 'unknown'; },
    run => { run.checkpoint.attempt.phase = 'planner'; }, run => { run.checkpoint.attempt.index = 1; },
    run => { run.checkpoint.attempt.status = 'rejected'; }, run => { run.checkpoint.attempt.status = 'interrupted'; },
    run => { run.checkpoint.child = 'other_child'; }, run => { run.checkpoint.caller.id = 'new_workflow_call'; },
    run => { run.checkpoint = null; },
  ]) {
    f.run = structuredClone(baseline); change(f.run);
    const event = valid();
    await f.hooks.get('permission.evaluate')(event);
    assert.equal(event.effect, 'deny');
  }
  f.run = baseline; f.unavailable = true;
  const unavailable = valid();
  await f.hooks.get('permission.evaluate')(unavailable);
  assert.equal(unavailable.effect, 'deny');
  await f.cleanup();
});

test('managed descendants and delegation cannot escape ownership while unrelated native trees remain untouched', async t => {
  const f = await fixture(t);
  f.sessions.set('ses_grandchild', { id: 'ses_grandchild', parentID: 'ses_child' });
  f.sessions.set('ses_deeper', { id: 'ses_deeper', parentID: 'ses_grandchild' });
  for (const sessionID of ['ses_grandchild', 'ses_deeper']) {
    await assert.rejects(f.call('write', {}, sessionID, 'build'), /no active workflow ownership/);
    assert.deepEqual((await f.context(sessionID, 'build')).tools, {});
  }
  for (const tool of ['subagent', 'task', 'native.call_omo_agent', 'mcp__native__session_goals', 'opencode', 'namespace:adr_workflow', 'native/session_goal']) {
    await assert.rejects(f.call(tool), /no active workflow ownership/);
    await f.call(tool, {}, 'ses_other');
  }
  f.sessions.set('ses_unrelated_child', { id: 'ses_unrelated_child', parentID: 'ses_other' });
  await f.call('write', {}, 'ses_unrelated_child', 'build');
  f.sessions.set('ses_loop_a', { id: 'ses_loop_a', parentID: 'ses_loop_b' });
  f.sessions.set('ses_loop_b', { id: 'ses_loop_b', parentID: 'ses_loop_a' });
  await assert.rejects(f.call('write', {}, 'ses_loop_a', 'build'), /no active workflow ownership/);
  f.sessions.set('ses_unknown_parent', { id: 'ses_unknown_parent', parentID: 'ses_missing' });
  await assert.rejects(f.call('write', {}, 'ses_unknown_parent', 'build'), /no active workflow ownership/);
  for (let index = 0; index < 66; index++) f.sessions.set('ses_depth_' + index, { id: 'ses_depth_' + index, ...(index < 65 ? { parentID: 'ses_depth_' + (index + 1) } : {}) });
  await assert.rejects(f.call('write', {}, 'ses_depth_0', 'build'), /no active workflow ownership/);
  await f.cleanup();
});

test('real coordinator owner route supplies private run authority and rejects an old admission capability', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hog-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, 'worktree');
  const stateDirectory = path.join(root, 'state');
  await fs.mkdir(path.join(directory, '.heimdall'), { recursive: true });
  const configPath = path.join(root, 'config.toml');
  await fs.writeFile(configPath, '# Synthetic project configuration\n');
  const endpoint = path.join(stateDirectory, 'coordinator.sock');
  const service = await startCoordinatorService({
    configuration: { stateDirectory, endpoint, globalConcurrency: 1, projectConcurrency: 1 },
    executor: { launch: async () => assert.fail('The fixture admits directly without launching native inference'), inspect: async () => ({ idle: false, status: 'unknown' }) },
    pollIntervalMs: 60000,
  });
  t.after(() => service.close());
  const project = service.store.registerProject({ directory, commonGitDirectory: directory, configPath, concurrency: 1 });
  service.store.enqueue({ id: 'real_route', projectId: project.id, feature: 'Synthetic feature', baseCommit: 'synthetic', worktreePath: directory, branch: 'heimdall/test', specification: { settings } });
  let run = service.store.admitNext();
  const caller = { sessionID: run.parentSessionId, id: 'call_start', messageID: 'msg_start', agent: 'adr-orchestrator' };
  service.store.bindStart(run.id, run.ownerToken, caller);
  const state = { ...checkpoint(), id: run.id, parent: run.parentSessionId, caller, adr: '.heimdall/feature.md', branch: run.branch, baseline: '' };
  service.store.saveCheckpoint(run.id, run.ownerToken, state);
  run = service.store.transition(run.id, run.ownerToken, run.version, 'running');
  const client = createCoordinatorClient(endpoint);
  const owned = await client.request('GET', '/runs/' + run.id, undefined, run.ownerToken);
  assert.equal(owned.ownerToken, run.ownerToken, 'the authenticated owner route returns the private run before the public route');
  assert.deepEqual(owned.specification.settings, settings);
  const publicView = await client.request('GET', '/runs/' + run.id, undefined, await readCoordinatorToken(stateDirectory));
  for (const field of ['ownerToken', 'specification', 'binding']) assert.equal(Object.hasOwn(publicView, field), false, field + ' is absent from the administrator projection');
  const metadataFile = path.join(directory, '.heimdall/managed.json');
  const metadata = () => ({ endpoint, runId: run.id, parentSessionId: run.parentSessionId, ownerToken: run.ownerToken });
  await fs.writeFile(metadataFile, JSON.stringify(metadata()));
  const hooks = new Map();
  const hook = async (name, callback) => { hooks.set(name, callback); return { dispose: async () => { hooks.delete(name); } }; };
  const cleanup = await createOwnershipGuard().setup({
    location: { directory }, tool: { hook }, permission: { hook },
    session: { hook, get: async ({ sessionID }) => ({ id: sessionID, parentID: run.parentSessionId }) },
  });
  t.after(cleanup);
  const call = () => hooks.get('execute.before')({ tool: 'write', sessionID: 'ses_child', agent: 'adr-executor', messageID: 'msg', id: 'call', input: {} });
  await call();
  const oldOwner = run.ownerToken;
  state.status = 'paused';
  service.store.saveCheckpoint(run.id, run.ownerToken, state);
  run = service.store.transition(run.id, run.ownerToken, run.version, 'paused', 'Synthetic owner review', true);
  await assert.rejects(call(), /no active workflow ownership/);
  service.store.queueResume(run.id, 'Synthetic approval');
  run = service.store.admitNext();
  assert.notEqual(run.ownerToken, oldOwner);
  await assert.rejects(client.request('GET', '/runs/' + run.id, undefined, oldOwner), error => error.statusCode === 401);
  await assert.rejects(call(), /no active workflow ownership/, 'stale metadata cannot authorize through the old owner token');
  const resumedCaller = { ...caller, id: 'call_resume', messageID: 'msg_resume' };
  service.store.bindResume(run.id, run.ownerToken, resumedCaller);
  state.status = 'running'; state.caller = resumedCaller; state.attempt.id = 'resumed_attempt';
  service.store.saveCheckpoint(run.id, run.ownerToken, state);
  await fs.writeFile(metadataFile, JSON.stringify(metadata()));
  await call();
});
