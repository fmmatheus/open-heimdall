import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRunner } from '../dist/workflow/runner.js';
import { createManagedPersistence } from '../dist/opencode/managed.js';
import { createPlugin } from '../dist/opencode/plugin.js';

const settings = { plannerAgent: 'adr-planner', executorAgent: 'adr-executor', plannerModel: 'anthropic/planner', executorModel: 'anthropic/executor', executorFallbackModel: 'kimi/fallback', maxTasks: 10, minQuotaRemainingPercent: 10, tokenLimitsDisabled: true };
const task = { id: 'T1', title: 'Task', brief: 'Implement task', dependsOn: [], dod: ['passed'] };
const plan = { status: 'planned', planMarkdown: '# Plan', factSheet: 'Facts', tasks: [task] };
const done = { status: 'completed', taskId: 'T1', summary: 'Done', handoff: 'Handoff', evidence: [{ gateId: 'G1', passed: true, detail: 'Verified', gate: 'passed' }] };
const caller = () => ({ sessionID: 'ses_parent', id: 'call_start', messageID: 'msg_assistant_start', agent: 'adr-orchestrator', signal: new AbortController().signal });
const quota = async () => ({ anthropic: { fetchedAt: Date.now(), errors: [], entries: [{ name: '5h', percentRemaining: 80 }, { name: 'Weekly', percentRemaining: 80 }] } });

async function fixture(t, responses = [plan, done]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-managed-runner-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, '.heimdall');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'feature.md'), 'Synthetic feature');
  await fs.writeFile(path.join(root, 'planner.md'), 'Planner contract');
  await fs.writeFile(path.join(root, 'executor.md'), 'Executor contract');
  let checkpoint = null, binding = null, count = 0;
  const receipts = new Map(), events = [], children = [];
  const persistence = {
    load: async () => structuredClone(checkpoint),
    save: async state => { assert.ok(binding); checkpoint = structuredClone(state); events.push(['checkpoint', state.child, state.status]); },
    bindStart: async value => { if (binding) assert.deepEqual(value, binding, 'start binding is immutable'); else binding = structuredClone(value); events.push(['binding']); },
    readReceipt: async (id, attempt) => structuredClone(receipts.get(attempt) ?? null),
    writeReceipt: async (id, receipt) => { assert.equal(checkpoint.attempt.id, receipt.id); receipts.set(receipt.id, structuredClone(receipt)); events.push(['receipt', receipt.child]); },
  };
  const backend = {
    assertIdle: async () => {}, recoverResponse: async () => assert.fail('Unexpected response recovery'), usage: async () => ({ used: 0, uncached: 0 }), interrupt: async () => {},
    runSubagent: async input => {
      const child = input.child ?? 'ses_child_' + ++count;
      await input.onStarted(child);
      assert.equal(checkpoint.child, child, 'authoritative child identity precedes inference');
      assert.ok(binding, 'native start identity precedes inference');
      children.push(child); events.push(['inference', child]);
      const response = responses.shift();
      if (response instanceof Error) throw response;
      return JSON.stringify(response);
    },
  };
  const run = createRunner({ directory, backend, settings, quota, persistence, workflowRoot: '.heimdall/state', planRoot: '.heimdall/plans', plannerPromptPath: '.heimdall/planner.md', executorPromptPath: '.heimdall/executor.md', git: args => args[0] === 'branch' ? 'heimdall/run\n' : '' });
  return { directory, root, run, persistence, receipts, children, events, get state() { return checkpoint; }, set state(value) { checkpoint = value; }, set binding(value) { binding = value; } };
}

test('managed start persists one stable ID and native binding before sequential inference', async t => {
  const f = await fixture(t);
  const result = JSON.parse(await f.run({ action: 'start', runId: 'reserved', adr: '.heimdall/feature.md' }, caller()));
  assert.equal(result.runId, 'reserved'); assert.equal(result.status, 'completed');
  assert.deepEqual(f.children, ['ses_child_1', 'ses_child_2']);
  assert.deepEqual(f.events[0], ['binding']);
  assert.equal(f.state.id, 'reserved'); assert.equal(f.receipts.size, 2);
  await assert.rejects(fs.access(path.join(f.root, 'state/runs/reserved/state.json')), { code: 'ENOENT' });
  const replay = JSON.parse(await f.run({ action: 'start', runId: 'reserved', adr: '.heimdall/feature.md' }, caller()));
  assert.equal(replay.status, 'completed'); assert.equal(f.children.length, 2);
  await assert.rejects(f.run({ action: 'start', runId: 'reserved', adr: '.heimdall/feature.md' }, { ...caller(), id: 'another-call' }));
  assert.equal(f.children.length, 2);
});

test('unfinished start replay fails closed; explicit resume uses a new caller and existing child', async t => {
  const f = await fixture(t, [plan, { status: 'blocked', reason: 'Owner input' }, done]);
  assert.equal(JSON.parse(await f.run({ action: 'start', runId: 'reserved', adr: '.heimdall/feature.md' }, caller())).status, 'paused');
  await assert.rejects(f.run({ action: 'start', runId: 'reserved', adr: '.heimdall/feature.md' }, caller()), /already started/);
  assert.equal(f.children.length, 2);
  const resumed = JSON.parse(await f.run({ action: 'resume', runId: 'reserved', input: 'Resolved' }, { ...caller(), id: 'call_resume', messageID: 'msg_assistant_resume' }));
  assert.equal(resumed.status, 'completed'); assert.deepEqual(f.children, ['ses_child_1', 'ses_child_2', 'ses_child_2']);
  assert.equal(f.state.caller.id, 'call_resume');
});

test('authoritative receipt recovery advances without duplicate native inference', async t => {
  const f = await fixture(t, []);
  f.binding = { sessionID: 'ses_parent', id: 'call_start', messageID: 'msg_assistant_start', agent: 'adr-orchestrator' };
  const attempt = { id: 'attempt_1', phase: 'executor', index: 0, child: 'ses_saved', status: 'admitted', startedAt: 1, model: 'anthropic/executor' };
  f.state = { id: 'reserved', status: 'paused', parent: 'ses_parent', caller: caller(), adr: '.heimdall/feature.md', branch: 'heimdall/run', baseline: '', index: 0, tasks: [task], results: [], phase: 'executor', child: 'ses_saved', attempt, settings };
  f.receipts.set(attempt.id, { ...attempt, response: JSON.stringify(done) });
  const result = JSON.parse(await f.run({ action: 'resume', runId: 'reserved', input: 'Reconcile committed receipt' }, caller()));
  assert.equal(result.status, 'completed'); assert.deepEqual(f.children, []); assert.equal(f.state.results.length, 1);
});

test('managed persistence authenticates owner rotation and rejects changed run identities', async t => {
  const f = await fixture(t);
  const identity = { endpoint: '/synthetic-coordinator.sock', runId: 'reserved', ownerToken: 'owner-one', parentSessionId: 'ses_parent' };
  const file = path.join(f.root, 'managed.json');
  await fs.writeFile(file, JSON.stringify(identity));
  const calls = [];
  const remote = { id: 'reserved', parentSessionId: 'ses_parent', worktreePath: f.directory, launchAction: 'start', binding: null, specification: { settings }, checkpoint: null };
  const managed = createManagedPersistence(f.directory, identity, { request: async (...args) => { calls.push(args); return args[1] === '/runs/reserved' ? remote : null; } });
  await managed.persistence.load('reserved'); assert.equal(calls.at(-1)[3], 'owner-one');
  await fs.writeFile(file, JSON.stringify({ ...identity, ownerToken: 'owner-two' }));
  const beforeRotation = calls.length;
  await assert.rejects(managed.persistence.load('reserved'), /identity changed/);
  await assert.rejects(managed.persistence.save({ id: 'reserved', parent: 'ses_parent' }), /identity changed/);
  assert.equal(calls.length, beforeRotation, 'stale work cannot send a checkpoint using the new owner token');
  let resumeClaimed = false;
  const resumed = createManagedPersistence(f.directory, { ...identity, ownerToken: 'owner-two' }, { request: async (...args) => { calls.push(args); if (args[1].endsWith('/resume-binding')) { const claimed = !resumeClaimed; resumeClaimed = true; return { claimed }; } return args[1] === '/runs/reserved' ? remote : null; } });
  await resumed.persistence.load('reserved'); assert.equal(calls.at(-1)[3], 'owner-two');
  await assert.rejects(resumed.authorize({ action: 'start', runId: 'other' }, caller()), /does not own/);
  assert.deepEqual(await resumed.authorize({ action: 'start' }, caller()), { action: 'start', runId: 'reserved', adr: '.heimdall/feature.md' });
  remote.binding = { sessionID: 'ses_parent', id: 'another-call', messageID: 'msg_other', agent: 'adr-orchestrator' };
  await assert.rejects(resumed.authorize({ action: 'start' }, caller()), /different native tool call/);
  remote.launchAction = 'resume'; remote.resolution = 'Exact resolution'; remote.checkpoint = { status: 'paused' };
  await assert.rejects(resumed.authorize({ action: 'resume', input: 'Other' }, caller()), /approved resolution/);
  assert.equal((await resumed.authorize({ action: 'resume', input: 'Exact resolution' }, caller())).input, 'Exact resolution');
  await assert.rejects(resumed.authorize({ action: 'resume', input: 'Exact resolution' }, caller()), /already claimed/);
  await assert.rejects(resumed.authorize({ action: 'resume', input: 'Exact resolution' }, { ...caller(), id: 'another-resume-call' }), /already claimed/);
  await fs.writeFile(file, JSON.stringify({ ...identity, runId: 'different' }));
  await assert.rejects(managed.persistence.load('reserved'), /identity changed/);
});

test('managed plugin keeps native hooks but omits watchdog recovery RPC', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, 'managed.json'), JSON.stringify({ endpoint: '/unused-test.sock', runId: 'reserved', ownerToken: 'synthetic', parentSessionId: 'ses_parent' }));
  const configuration = { projectDirectory: f.directory, configPath: 'synthetic', workflowRoot: path.join(f.root, 'state'), planRoot: path.join(f.root, 'plans'), plannerPromptPath: path.join(f.root, 'planner.md'), executorPromptPath: path.join(f.root, 'executor.md'), settings, opencode: { passwordEnvironmentVariable: 'UNUSED_TEST_PASSWORD' } };
  let registered, contextHook, disposed = 0;
  const registration = () => ({ dispose: async () => { disposed++; } });
  const ctx = { location: { directory: f.directory }, integration: {}, tool: { transform: async apply => { apply({ add: value => { registered = value; } }); return registration(); }, hook: async () => registration() }, session: { hook: async (name, callback) => { contextHook = callback; return registration(); } }, rpc: { register: async () => assert.fail('Managed mode must not register watchdog RPC') } };
  const cleanup = await createPlugin({ configuration, observe: async () => assert.fail('No live session observation in setup') }).setup(ctx);
  const parent = { sessionID: 'ses_parent', agent: 'adr-orchestrator', tools: { subagent: {}, 'native.subagent': {}, adr_workflow: {}, 'native.adr_workflow': {}, shell: {} } };
  await contextHook(parent);
  assert.deepEqual(Object.keys(parent.tools), ['adr_workflow', 'native.adr_workflow']);
  const outsider = { sessionID: 'other-parent', agent: 'adr-orchestrator', tools: { adr_workflow: {}, subagent: {} } };
  await contextHook(outsider); assert.deepEqual(outsider.tools, {});
  await assert.rejects(registered.execute({ action: 'start' }, { ...caller(), sessionID: 'other-parent' }), /does not own/);
  await cleanup(); assert.equal(disposed, 3);
});
