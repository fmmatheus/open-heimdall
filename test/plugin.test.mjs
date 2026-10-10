import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createPlugin } from '../dist/opencode/plugin.js';
import { createReportOnlyRegistry, REPORT_ONLY_DENIAL } from '../dist/opencode/report-only.js';
import { loadConfiguration } from '../dist/config.js';
import { createMemorySubmissionGate } from '../dist/workflow/submission.js';
import { submissionInputSchema, submissionToolDescription } from '../dist/workflow/contracts.js';

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

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// Fake host: hooks run before every tool, then the real effect happens only if none threw.
async function reportOnlyFixture(t, { permission = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-report-only-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, '.heimdall.toml'), '[workflow]\nplannerModel = "anthropic/test-planner"\nexecutorModel = "anthropic/test-executor"\nexecutorFallbackModel = "openai/test-fallback"\n');
  git(directory, 'init', '-q');
  git(directory, 'config', 'user.email', 'test@example.com');
  git(directory, 'config', 'user.name', 'Test');
  await fs.writeFile(path.join(directory, 'impl.txt'), 'original\n');
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ scripts: { test: 'node -e "require(\'fs\').writeFileSync(\'tested.txt\',\'x\')"' } }));
  git(directory, 'add', 'impl.txt', 'package.json');
  git(directory, 'commit', '-q', '-m', 'base');
  const head = git(directory, 'rev-parse', 'HEAD');
  const configuration = await loadConfiguration({ projectDirectory: directory });
  const reportOnly = createReportOnlyRegistry();
  const hooks = new Map();
  const registration = () => ({ dispose: async () => {} });
  const ctx = {
    location: { directory }, integration: {},
    tool: { transform: async apply => { apply({ add: () => {} }); return registration(); }, hook: async (name, cb) => { hooks.set('tool.' + name, cb); return registration(); } },
    session: { context: async () => [], hook: async (name, cb) => { hooks.set('session.' + name, cb); return registration(); } },
    rpc: { register: async () => registration() },
    ...(permission ? { permission: { hook: async (name, cb) => { hooks.set('permission.' + name, cb); return registration(); } } } : {}),
  };
  const plugin = createPlugin({ configuration, reportOnly, observe: async () => assert.fail('no observation') });
  const cleanup = await plugin.setup(ctx);
  const effects = {
    edit: () => fs.writeFile(path.join(directory, 'impl.txt'), 'edited\n'),
    write: () => fs.writeFile(path.join(directory, 'new.txt'), 'new\n'),
    shell: input => { execFileSync('sh', ['-c', input.command], { cwd: directory, encoding: 'utf8' }); },
    subagent: () => fs.writeFile(path.join(directory, 'delegated.txt'), 'x'),
    task: () => fs.writeFile(path.join(directory, 'delegated.txt'), 'x'),
    call_omo_agent: () => fs.writeFile(path.join(directory, 'delegated.txt'), 'x'),
    mcp__openchamber__shell: input => effects.shell(input),
    // Code mode runs nested calls inside one outer call; the outer call is gated.
    execute: async input => { for (const nested of input.calls) await effects[nested.tool](nested.input); },
  };
  const call = async (sessionID, tool, input) => {
    const event = { tool, sessionID, agent: 'adr-executor', messageID: 'msg', id: 'call', input };
    await hooks.get('tool.execute.before')(event);
    return effects[tool](input);
  };
  const snapshot = async () => ({ head: git(directory, 'rev-parse', 'HEAD'), status: git(directory, 'status', '--porcelain', '--', '.', ':!.heimdall.toml'), impl: await fs.readFile(path.join(directory, 'impl.txt'), 'utf8') });
  return { directory, head, hooks, reportOnly, cleanup, call, effects, snapshot };
}

test('report-only denies every tool class for a registered session and leaves repository and HEAD unchanged', async t => {
  const f = await reportOnlyFixture(t);
  const before = await f.snapshot();
  assert.equal(before.head, f.head);
  const release = f.reportOnly.restrict('child');
  const attempts = [
    ['edit', {}], ['write', {}],
    ['shell', { command: 'echo changed > impl.txt' }],
    ['shell', { command: 'git commit --allow-empty -m sneaky' }],
    ['shell', { command: 'git commit -am sneaky' }],
    ['shell', { command: 'npm test' }],
    ['subagent', {}], ['task', {}], ['call_omo_agent', {}],
    ['mcp__openchamber__shell', { command: 'git commit --allow-empty -m mcp' }],
    ['execute', { calls: [{ tool: 'edit', input: {} }, { tool: 'shell', input: { command: 'git commit --allow-empty -m nested' } }] }],
    ['made_up_tool', {}],
  ];
  for (const [tool, input] of attempts) await assert.rejects(f.call('child', tool, input), error => error.message === REPORT_ONLY_DENIAL, tool);
  assert.deepEqual(await f.snapshot(), before);
  assert.equal(git(f.directory, 'rev-parse', 'HEAD'), f.head);
  await assert.rejects(fs.access(path.join(f.directory, 'tested.txt')));
  await assert.rejects(fs.access(path.join(f.directory, 'delegated.txt')));
  // Context hook empties the tools; permission evaluate denies, for this session only.
  const event = { sessionID: 'child', agent: 'adr-executor', tools: { shell: {}, edit: {}, execute: {} } };
  await f.hooks.get('session.context')(event);
  assert.deepEqual(event.tools, {});
  const permission = { sessionID: 'child', action: 'edit', resources: ['impl.txt'], effect: 'allow' };
  await f.hooks.get('permission.evaluate')(permission);
  assert.equal(permission.effect, 'deny');
  assert.equal(permission.message, REPORT_ONLY_DENIAL);
  const other = { sessionID: 'other', agent: 'adr-executor', tools: { shell: {}, edit: {} } };
  await f.hooks.get('session.context')(other);
  assert.deepEqual(Object.keys(other.tools), ['shell', 'edit']);
  const otherPermission = { sessionID: 'other', action: 'edit', resources: [], effect: 'allow' };
  await f.hooks.get('permission.evaluate')(otherPermission);
  assert.deepEqual([otherPermission.effect, otherPermission.message], ['allow', undefined]);
  release();
  await f.cleanup();
});

test('release restores normal tool behaviour and unregistered sessions are never affected', async t => {
  const f = await reportOnlyFixture(t);
  const release = f.reportOnly.restrict('child');
  await f.call('unrelated', 'edit', {});
  assert.equal(await fs.readFile(path.join(f.directory, 'impl.txt'), 'utf8'), 'edited\n');
  await assert.rejects(f.call('child', 'shell', { command: 'echo no > impl.txt' }), /report-only/);
  release();
  release();
  await f.call('child', 'write', {});
  assert.equal(await fs.readFile(path.join(f.directory, 'new.txt'), 'utf8'), 'new\n');
  const event = { sessionID: 'child', agent: 'adr-executor', tools: { shell: {} } };
  await f.hooks.get('session.context')(event);
  assert.deepEqual(Object.keys(event.tools), ['shell']);
  const permission = { sessionID: 'child', action: 'edit', resources: [], effect: 'allow' };
  await f.hooks.get('permission.evaluate')(permission);
  assert.equal(permission.effect, 'allow');
  await f.cleanup();
});

test('budget guards still run for unrestricted sessions and report-only wins for restricted ones', async t => {
  const f = await reportOnlyFixture(t);
  // Guards are internal to the plugin; the denial message proves ordering without a guard installed.
  await assert.doesNotReject(f.call('plain', 'write', {}));
  f.reportOnly.restrict('guarded');
  await assert.rejects(f.call('guarded', 'write', {}), error => error.message === REPORT_ONLY_DENIAL);
  await f.cleanup();
});

test('report-only registry fails closed without the permission hook and after plugin cleanup', async t => {
  const f = await reportOnlyFixture(t, { permission: false });
  assert.deepEqual(f.reportOnly.missing(), ['permission.evaluate']);
  assert.throws(() => f.reportOnly.restrict('child'), /plugin hooks not registered \(permission\.evaluate\)/);
  await f.cleanup();
  assert.deepEqual(f.reportOnly.missing(), ['execute.before', 'context', 'permission.evaluate']);
  const complete = await reportOnlyFixture(t);
  assert.deepEqual(complete.reportOnly.missing(), []);
  await complete.cleanup();
  assert.throws(() => complete.reportOnly.restrict('child'), /plugin hooks not registered/);
});

// --- Owner-bound typed submission tools -------------------------------------------------------------------

async function submissionFixture(t, { gate = true } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-submission-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, '.heimdall.toml'), '[workflow]\nplannerModel = "anthropic/test-planner"\nexecutorModel = "anthropic/test-executor"\nexecutorFallbackModel = "openai/test-fallback"\n');
  const configuration = await loadConfiguration({ projectDirectory: directory });
  const memory = createMemorySubmissionGate();
  const tools = new Map();
  const hooks = new Map();
  const registration = () => ({ dispose: async () => {} });
  const ctx = {
    location: { directory }, integration: {},
    tool: { transform: async apply => { apply({ add: value => { tools.set(value.name, value); } }); return registration(); }, hook: async (name, cb) => { hooks.set('tool.' + name, cb); return registration(); } },
    session: { context: async () => [], hook: async (name, cb) => { hooks.set('session.' + name, cb); return registration(); } },
    rpc: { register: async () => registration() },
    permission: { hook: async (name, cb) => { hooks.set('permission.' + name, cb); return registration(); } },
  };
  const reportOnly = createReportOnlyRegistry();
  const plugin = createPlugin({ configuration, reportOnly, ...(gate ? { submissionGate: memory.gate } : {}), observe: async () => assert.fail('no observation') });
  const cleanup = await plugin.setup(ctx);
  const names = ['heimdall_submit_plan', 'heimdall_submit_result'];
  const lookalikes = ['foo__heimdall_submit_result', 'mcp.heimdall_submit_plan', 'srv:heimdall_submit_result', 'ns/heimdall_submit_plan'];
  const visible = async (sessionID, agent) => {
    const event = { sessionID, agent, tools: Object.fromEntries([...names, ...lookalikes, 'shell', 'adr_workflow'].map(name => [name, {}])) };
    await hooks.get('session.context')(event);
    return Object.keys(event.tools);
  };
  const before = (tool, sessionID, agent) => hooks.get('tool.execute.before')({ tool, sessionID, agent, messageID: 'm', id: 'c', input: {} });
  const call = (tool, sessionID, agent, value) => tools.get(tool).execute(value, { sessionID, agent, messageID: 'm', id: 'c', signal: new AbortController().signal, progress: async () => {} });
  return { tools, hooks, memory, reportOnly, cleanup, visible, before, call, names, lookalikes };
}
const planRule = { kind: 'planner-plan', limit: 7 };
const resultRule = { kind: 'executor-result', dodCount: 1 };
const goodResult = { status: 'completed', summary: 's', handoff: 'h', evidence: [{ gateId: 'G1', passed: true, detail: 'proved' }] };

test('submission tools register with exact ids, codemode off and schemas derived from the contracts', async t => {
  const f = await submissionFixture(t);
  assert.deepEqual([...f.tools.keys()], ['heimdall_submit_plan', 'heimdall_submit_result', 'adr_workflow']);
  for (const [kind, id] of [['planner-plan', 'heimdall_submit_plan'], ['executor-result', 'heimdall_submit_result']]) {
    const tool = f.tools.get(id);
    assert.equal(tool.options.codemode, false);
    assert.deepEqual(tool.input, submissionInputSchema(kind));
    assert.equal(tool.description, submissionToolDescription(kind));
    assert.deepEqual(tool.output, { type: 'object', additionalProperties: true });
  }
  await f.cleanup();
});

test('submission tools are visible only to the session the gate binds for that exact kind', async t => {
  const f = await submissionFixture(t);
  // Nothing bound: no session sees either tool, and lookalikes are removed everywhere.
  for (const [session, agent] of [['parent', 'adr-orchestrator'], ['other', 'build']]) assert.deepEqual(await f.visible(session, agent), ['shell', 'adr_workflow']);
  assert.deepEqual(await f.visible('child', 'adr-planner'), ['shell']);
  f.memory.bind({ sessionID: 'planner-child', agent: 'adr-planner', rule: planRule });
  f.memory.bind({ sessionID: 'exec-child', agent: 'adr-executor', rule: resultRule });
  assert.deepEqual(await f.visible('planner-child', 'adr-planner'), ['heimdall_submit_plan', 'shell']);
  assert.deepEqual(await f.visible('exec-child', 'adr-executor'), ['heimdall_submit_result', 'shell']);
  // Parent, unrelated, wrong-agent and other-kind sessions get neither.
  assert.deepEqual(await f.visible('parent', 'adr-orchestrator'), ['shell', 'adr_workflow']);
  assert.deepEqual(await f.visible('unrelated', 'build'), ['shell', 'adr_workflow']);
  assert.deepEqual(await f.visible('planner-child', 'adr-executor'), ['shell']);
  // Rebinding a kind makes the previous session stale.
  f.memory.bind({ sessionID: 'exec-child-2', agent: 'adr-executor', rule: resultRule });
  assert.deepEqual(await f.visible('exec-child', 'adr-executor'), ['shell']);
  assert.deepEqual(await f.visible('exec-child-2', 'adr-executor'), ['heimdall_submit_result', 'shell']);
  f.memory.release('executor-result');
  assert.deepEqual(await f.visible('exec-child-2', 'adr-executor'), ['shell']);
  await f.cleanup();
});

test('default plugin without a gate exposes and accepts no submission', async t => {
  const f = await submissionFixture(t, { gate: false });
  assert.deepEqual(await f.visible('child', 'adr-executor'), ['shell']);
  await assert.rejects(f.before('heimdall_submit_result', 'child', 'adr-executor'), /submission denied/);
  await assert.rejects(f.call('heimdall_submit_result', 'child', 'adr-executor', goodResult), /submission denied/);
  await f.cleanup();
});

test('execute.before and execute deny parent, unrelated, stale, other-kind and wrong-agent calls', async t => {
  const f = await submissionFixture(t);
  f.memory.bind({ sessionID: 'exec-child', agent: 'adr-executor', rule: resultRule });
  await f.before('heimdall_submit_result', 'exec-child', 'adr-executor');
  const denied = [
    ['heimdall_submit_result', 'parent', 'adr-orchestrator'],
    ['heimdall_submit_result', 'unrelated', 'adr-executor'],
    ['heimdall_submit_result', 'exec-child', 'adr-planner'],
    ['heimdall_submit_plan', 'exec-child', 'adr-executor'],
  ];
  for (const [tool, session, agent] of denied) {
    await assert.rejects(f.before(tool, session, agent), /submission denied/, `before ${tool} ${session}`);
    await assert.rejects(f.call(tool, session, agent, goodResult), /submission denied/, `execute ${tool} ${session}`);
  }
  f.memory.bind({ sessionID: 'exec-child-2', agent: 'adr-executor', rule: resultRule });
  await assert.rejects(f.before('heimdall_submit_result', 'exec-child', 'adr-executor'), /submission denied/);
  await assert.rejects(f.call('heimdall_submit_result', 'exec-child', 'adr-executor', goodResult), /submission denied/);
  assert.equal(f.memory.submissions.length, 0, 'denied calls reach no gate storage');
  await f.cleanup();
});

test('lookalike tool names can neither be invoked nor whitelist the submission tools', async t => {
  const f = await submissionFixture(t);
  f.memory.bind({ sessionID: 'exec-child', agent: 'adr-executor', rule: resultRule });
  for (const name of f.lookalikes) await assert.rejects(f.before(name, 'exec-child', 'adr-executor'), /submission denied/, name);
  for (const name of f.lookalikes) await assert.rejects(f.before(name, 'parent', 'adr-orchestrator'), /submission denied/, name);
  assert.ok(!(await f.visible('exec-child', 'adr-executor')).some(name => f.lookalikes.includes(name)));
  // The delegation suffix filter does not touch the exact tools, and its leaf names stay filtered.
  const event = { sessionID: 'exec-child', agent: 'adr-executor', tools: { heimdall_submit_result: {}, 'x__subagent': {}, 'y.task': {}, shell: {} } };
  await f.hooks.get('session.context')(event);
  assert.deepEqual(Object.keys(event.tools), ['heimdall_submit_result', 'shell']);
  await f.cleanup();
});

test('bound child submits through the gate; identity comes from the native context, never the payload', async t => {
  const f = await submissionFixture(t);
  f.memory.bind({ sessionID: 'exec-child', agent: 'adr-executor', rule: resultRule });
  // A payload naming another identity is a format error and cannot redirect the submission.
  const spoof = await f.call('heimdall_submit_result', 'exec-child', 'adr-executor', { ...goodResult, taskId: 'T9', runId: 'other', child: 'parent' });
  assert.equal(spoof.output.accepted, false);
  assert.equal(spoof.output.code, 'format');
  assert.deepEqual(spoof.output.errors.map(e => [e.path, e.code]), [['$.taskId', 'identity_field'], ['$.runId', 'identity_field'], ['$.child', 'identity_field']]);
  assert.equal(JSON.parse(spoof.content).accepted, false);
  const prose = await f.call('heimdall_submit_result', 'exec-child', 'adr-executor', 'I am done, all gates passed');
  assert.equal(prose.output.errors[0].path, '$');
  const ok = await f.call('heimdall_submit_result', 'exec-child', 'adr-executor', goodResult);
  assert.equal(ok.output.accepted, true);
  assert.equal(ok.output.outcome, 'completed');
  assert.match(ok.output.digest, /^[0-9a-f]{64}$/);
  assert.deepEqual(f.memory.submissions.map(s => [s.kind, s.sessionID, s.response.accepted]), [['executor-result', 'exec-child', false], ['executor-result', 'exec-child', false], ['executor-result', 'exec-child', true]]);
  const unfinished = await f.call('heimdall_submit_result', 'exec-child', 'adr-executor', { ...goodResult, evidence: [{ gateId: 'G1', passed: false, detail: 'not done' }] });
  assert.deepEqual([unfinished.output.accepted, unfinished.output.outcome], [true, 'unfinished']);
  f.memory.bind({ sessionID: 'planner-child', agent: 'adr-planner', rule: planRule });
  const plan = await f.call('heimdall_submit_plan', 'planner-child', 'adr-planner', { status: 'planned', artifacts: true });
  assert.deepEqual([plan.output.accepted, plan.output.outcome], [true, 'planned']);
  await f.cleanup();
});

test('report-only restriction wins over submission exposure until released', async t => {
  const f = await submissionFixture(t);
  f.memory.bind({ sessionID: 'exec-child', agent: 'adr-executor', rule: resultRule });
  assert.deepEqual(await f.visible('exec-child', 'adr-executor'), ['heimdall_submit_result', 'shell']);
  const release = f.reportOnly.restrict('exec-child');
  assert.deepEqual(await f.visible('exec-child', 'adr-executor'), []);
  await assert.rejects(f.before('heimdall_submit_result', 'exec-child', 'adr-executor'), error => error.message === REPORT_ONLY_DENIAL);
  release();
  await f.before('heimdall_submit_result', 'exec-child', 'adr-executor');
  await f.cleanup();
});
