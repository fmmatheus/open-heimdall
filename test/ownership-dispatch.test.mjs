import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createOwnershipGuard } from '../dist/opencode/ownership-guard.js';
import { createNativeBackend } from '../dist/opencode/native-backend.js';

test('native backend dispatch crosses the parent permission boundary without reopening manual or paused delegation', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-owned-dispatch-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, '.heimdall'));
  const metadata = { endpoint: '/synthetic.sock', runId: 'run', parentSessionId: 'ses_parent', ownerToken: 'owner_1' };
  const metadataFile = path.join(directory, '.heimdall/managed.json');
  await fs.writeFile(metadataFile, JSON.stringify(metadata));
  const settings = { plannerAgent: 'adr-planner', executorAgent: 'adr-executor' };
  const caller = { sessionID: 'ses_parent', id: 'call_workflow_1', messageID: 'msg_parent_1', agent: 'adr-orchestrator' };
  const state = { id: 'run', parent: 'ses_parent', caller, status: 'running', phase: 'executor', index: 0,
    child: null, settings, tasks: [{ id: 'T1' }], results: [],
    attempt: { id: 'attempt_1', phase: 'executor', index: 0, child: null, status: 'launching' } };
  const run = { id: 'run', parentSessionId: 'ses_parent', worktreePath: directory, specification: { settings },
    status: 'running', capacityReserved: true, ownerToken: metadata.ownerToken, checkpoint: state };
  const hooks = new Map();
  const registration = (name, callback) => { hooks.set(name, callback); return { dispose: async () => hooks.delete(name) }; };
  let prompts = 0, recorded = 0;
  const permission = async call => {
    // OpenCode 2.0.22 checks this inside SubagentTool before creating/resuming a child or reporting progress.
    const event = { action: 'subagent', resources: ['adr-executor'], sessionID: call.sessionID, agent: call.agent,
      source: { type: 'tool', messageID: call.messageID, id: call.id }, effect: 'allow' };
    await hooks.get('permission.evaluate')(event);
    if (event.effect === 'deny') throw new Error('Subagent denied: adr-executor');
    assert.equal(event.effect, 'allow');
  };
  const ctx = {
    location: { directory },
    tool: {
      hook: async (name, callback) => registration('tool.' + name, callback),
      list: async () => [{ id: 'subagent', name: 'subagent', execute: async (args, call) => {
        await permission(call);
        assert.equal(args.background, false);
        await call.progress({ sessionID: 'ses_child' });
        assert.equal(state.attempt.child, 'ses_child', 'ownership is persisted before the native prompt');
        prompts++;
        await hooks.get('tool.execute.before')({ sessionID: 'ses_child', agent: 'adr-executor', tool: 'write', input: {} });
        await assert.rejects(hooks.get('tool.execute.before')({ sessionID: 'ses_child', agent: 'adr-executor', tool: 'subagent', input: {} }), /no active workflow ownership/);
        return { output: { sessionID: 'ses_child', status: 'completed', output: 'Final result' } };
      } }],
    },
    session: {
      get: async ({ sessionID }) => ({ id: sessionID, ...(sessionID === 'ses_child' ? { parentID: 'ses_parent' } : {}) }),
      hook: async (name, callback) => registration('session.' + name, callback),
      context: async () => [{ type: 'assistant', finish: 'stop', time: { completed: 20 }, content: [{ type: 'text', text: 'Final result' }] }],
    },
    permission: { hook: async (name, callback) => registration('permission.' + name, callback) },
  };
  const cleanup = await createOwnershipGuard({ client: () => ({ request: async (method, route, _body, owner) => {
    assert.equal(method, 'GET'); assert.equal(route, '/runs/run'); assert.equal(owner, metadata.ownerToken);
    return structuredClone(run);
  } }) }).setup(ctx);
  t.after(cleanup);
  const backend = createNativeBackend({ ctx, observe: async () => ({ session: { id: 'ses_child', parentID: 'ses_parent',
    outcome: 'succeeded', time: { idle: 21 } }, active: false, inbox: [], permissions: [], forms: [], pendingWork: [] }) });
  const input = () => ({ parent: 'ses_parent', child: state.child ?? undefined, agent: 'adr-executor', model: 'synthetic/model', title: 'T1', prompt: 'Task',
    currentChild: () => state.child, onStarted: async child => { recorded++; state.child = child; state.attempt.child = child; } });
  const context = identity => ({ ...identity, signal: new AbortController().signal });
  assert.equal(await backend.runSubagent(input(), context(caller)), 'Final result');
  assert.equal(prompts, 1);
  assert.equal(recorded, 1);
  await assert.rejects(hooks.get('tool.execute.before')({ ...caller, tool: 'subagent', input: { agent: 'adr-executor' } }), /no active workflow ownership/);

  run.status = 'paused'; run.capacityReserved = false; state.status = 'paused';
  await assert.rejects(backend.runSubagent(input(), context(caller)), /Subagent denied/);
  assert.equal(prompts, 1, 'a paused run never reaches the native prompt');

  const resumedCaller = { ...caller, id: 'call_workflow_2', messageID: 'msg_parent_2' };
  metadata.ownerToken = 'owner_2'; run.ownerToken = 'owner_2';
  await fs.writeFile(metadataFile, JSON.stringify(metadata));
  run.status = 'running'; run.capacityReserved = true; state.status = 'running'; state.caller = resumedCaller;
  state.attempt = { ...state.attempt, id: 'attempt_2', status: 'launching' };
  await assert.rejects(backend.runSubagent(input(), context(caller)), /Subagent denied/);
  assert.equal(prompts, 1, 'an old parent tool call cannot reuse a new admission');
  assert.equal(await backend.runSubagent(input(), context(resumedCaller)), 'Final result');
  assert.equal(prompts, 2, 'the explicitly resumed call can reuse its existing child');
});
