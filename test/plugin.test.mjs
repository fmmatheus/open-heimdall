import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPlugin } from '../dist/opencode/plugin.js';
import { loadConfiguration } from '../dist/config.js';

test('published V2 plugin registers native workflow, safe context hooks and reserved recovery RPC', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'adr-v2-plugin-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, '.heimdall.toml'), '[workflow]\nplannerModel = "anthropic/test-planner"\nexecutorModel = "anthropic/test-executor"\nexecutorFallbackModel = "openai/test-fallback"\n');
  const configuration = await loadConfiguration({ projectDirectory: directory });
  const plugin = createPlugin({ configuration, observe: async () => { throw new Error('Status must not observe live sessions'); } });
  const runDir = path.join(configuration.workflowRoot, 'runs/existing');
  await fs.mkdir(runDir, { recursive: true });
  const original = JSON.stringify({ id: 'existing', status: 'completed', parent: 'parent', results: [] });
  await fs.writeFile(path.join(runDir, 'state.json'), original);
  const hooks = new Map();
  let registered;
  let rpc;
  let rpcHandlers;
  let messages = [];
  let disposed = 0;
  const registration = () => ({ dispose: async () => { disposed++; } });
  const ctx = {
    location: { directory }, integration: {},
    tool: {
      transform: async apply => { apply({ add: value => { registered = value; } }); return registration(); },
      hook: async (name, callback) => { hooks.set('tool.' + name, callback); return registration(); },
    },
    session: {
      context: async () => messages,
      hook: async (name, callback) => { hooks.set('session.' + name, callback); return registration(); },
    },
    rpc: { register: async (definition, handlers) => { rpc = definition; rpcHandlers = handlers; return registration(); } },
  };
  assert.equal(plugin.id, 'adr.workflow');
  const cleanup = await plugin.setup(ctx);
  assert.equal(registered.name, 'adr_workflow');
  assert.equal(registered.options.codemode, false);
  // Native Tool.execute rejects an output property unless the tool declares its schema.
  assert.deepEqual(registered.output, { type: 'object', additionalProperties: true });
  assert.deepEqual(registered.input.properties.action.enum, ['start', 'resume', 'status']);
  const result = await registered.execute({ action: 'status', runId: 'existing' }, { sessionID: 'parent', signal: new AbortController().signal });
  assert.equal(result.output.status, 'completed');
  assert.equal(JSON.parse(result.content).id, 'existing');
  assert.deepEqual(result.output, JSON.parse(result.content));
  assert.equal(await fs.readFile(path.join(runDir, 'state.json'), 'utf8'), original);
  for (const agent of ['adr-planner', 'adr-executor']) {
    const event = { sessionID: 'child', agent, tools: { subagent: {}, adr_workflow: {}, opencode: {}, 'native.subagent': {}, read: {}, skill: {}, shell: {} } };
    await hooks.get('session.context')(event);
    assert.deepEqual(Object.keys(event.tools), ['read', 'skill', 'shell']);
  }
  const parent = { sessionID: 'parent', agent: 'adr-orchestrator', tools: { adr_workflow: {}, subagent: {}, shell: {} } };
  messages = [{ type: 'user', metadata: { adrNotification: true } }];
  await hooks.get('session.context')(parent);
  assert.deepEqual(parent.tools, {});
  messages.push({ type: 'user', text: 'Please resume' });
  const owner = { ...parent, tools: { adr_workflow: {} } };
  await hooks.get('session.context')(owner);
  assert.deepEqual(Object.keys(owner.tools), ['adr_workflow']);
  assert.equal(rpc.id, 'adr.workflow');
  await assert.rejects(registered.execute({ action: 'phone_deploy' }, {}), /Unknown workflow action/);
  await assert.rejects(rpcHandlers.recover({ runId: '../outside', child: 'child', input: 'Retry', expectedReservationAt: 1 }), /Invalid recovery reservation/);
  await assert.rejects(rpcHandlers.recover({ runId: 'existing', child: 'child', input: 'Retry', expectedReservationAt: 1 }), /no saved native caller identity/);
  await cleanup();
  assert.equal(disposed, 4);
});

test('native role restrictions follow configuration and blank config environment uses the project default', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-plugin-roles-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, '.heimdall.toml'), '[workflow]\nplannerAgent = "custom-planner"\nexecutorAgent = "custom-executor"\nplannerModel = "anthropic/test-planner"\nexecutorModel = "anthropic/test-executor"\nexecutorFallbackModel = "openai/test-fallback"\n');
  const previous = process.env.HEIMDALL_CONFIG;
  process.env.HEIMDALL_CONFIG = '   ';
  t.after(() => { if (previous === undefined) delete process.env.HEIMDALL_CONFIG; else process.env.HEIMDALL_CONFIG = previous; });
  let contextHook;
  const registration = () => ({ dispose: async () => {} });
  const ctx = {
    location: { directory }, integration: {},
    tool: { transform: async apply => { apply({ add: () => {} }); return registration(); }, hook: async () => registration() },
    session: { context: async () => [], hook: async (name, callback) => { contextHook = callback; return registration(); } },
    rpc: { register: async () => registration() },
  };
  const plugin = createPlugin({ observe: async () => assert.fail('Setup and hooks never observe active sessions') });
  const cleanup = await plugin.setup(ctx);
  for (const agent of ['custom-planner', 'custom-executor']) {
    const event = { sessionID: 'child', agent, tools: { 'namespace__subagent': {}, 'native.adr_workflow': {}, session_goal: {}, shell: {} } };
    await contextHook(event);
    assert.deepEqual(Object.keys(event.tools), ['shell']);
  }
  await cleanup();
});
