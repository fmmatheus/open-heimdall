import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createPlugin } from '../dist/opencode/plugin.js';
import { createWorkflow } from '../dist/workflow.js';
import { createRunner } from '../dist/workflow/runner.js';
import { loadConfiguration } from '../dist/config.js';
import { SUBMISSION_TOOL_IDS } from '../dist/workflow/contracts.js';
import { SUBMISSION_DENIAL } from '../dist/workflow/submission.js';

const PLANNER_TOOL = SUBMISSION_TOOL_IDS['planner-plan'];
const EXECUTOR_TOOL = SUBMISSION_TOOL_IDS['executor-result'];
const ZERO = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
const quota = async () => ({ anthropic: { fetchedAt: Date.now(), errors: [], entries: [{ name: '5h', percentRemaining: 80 }, { name: 'Weekly', percentRemaining: 80 }] } });
const git = args => args[0] === 'branch' ? 'main\n' : '';
const task = id => ({ id, title: 'Task ' + id, brief: 'Implement ' + id, dependsOn: [], dod: ['gate for ' + id] });
const plan = (...ids) => ({ status: 'planned', planMarkdown: '# Plan', factSheet: 'Facts', tasks: ids.map(task) });
const completed = () => ({ status: 'completed', summary: 'Done', handoff: 'Handoff', evidence: [{ gateId: 'G1', passed: true, detail: 'verified with a real check' }] });
const TOML = '[workflow]\nplannerModel = "anthropic/test-planner"\nexecutorModel = "anthropic/test-executor"\nexecutorFallbackModel = "openai/test-fallback"\n';
const caller = (agent = 'adr-orchestrator', sessionID = 'ses_parent') => ({ sessionID, id: 'call_start', messageID: 'msg_parent', agent, signal: new AbortController().signal });

async function project(t, prefix) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, '.heimdall'));
  await fs.writeFile(path.join(directory, '.heimdall.toml'), TOML);
  await fs.writeFile(path.join(directory, '.heimdall/feature.md'), 'Synthetic feature');
  return { directory, configuration: await loadConfiguration({ projectDirectory: directory }) };
}

/**
 * A fake OpenCode host with the installed signatures: an ordered session message timeline (user prompt, then the
 * assistant message that carries tool calls), tool hooks run before every execute, and the session `context` hook
 * fires when the host BUILDS the model context. The dispatch prompt becomes visible in the child timeline only when
 * that generation begins, so the runner's 50ms watcher cannot have recorded it before the first context is built.
 */
function nativeHost(directory, script) {
  const sessions = new Map();
  const hooks = new Map();
  const registered = new Map();
  const contexts = [];
  const dispatches = [];
  const ctrl = { outcome: 'succeeded', finish: 'stop' };
  let children = 0, messages = 0, calls = 0;
  const registration = () => ({ dispose: async () => {} });
  const addSession = (id, parentID) => sessions.set(id, { id, parentID, messages: [], outcome: undefined, idle: undefined, active: false });
  const observe = async id => {
    const s = sessions.get(id);
    if (!s) throw new Error('Unknown session ' + id);
    return { session: { id, parentID: s.parentID, outcome: s.outcome, time: { idle: s.idle }, tokens: ZERO }, active: s.active, inbox: [], permissions: [], forms: [], messages: s.messages.slice() };
  };
  const subagent = {
    id: 'subagent', name: 'subagent',
    async execute(input, native) {
      const child = input.sessionID ?? 'ses_child_' + ++children;
      if (!sessions.has(child)) addSession(child, native.sessionID);
      await native.progress({ sessionID: child });
      const s = sessions.get(child);
      s.outcome = undefined; s.idle = undefined; s.active = true;
      const n = ++messages;
      const user = { type: 'user', id: 'msg_user_' + n, text: input.prompt, time: { created: Date.now() } };
      const assistant = { type: 'assistant', id: 'msg_asst_' + n, agent: input.agent, content: [], time: { created: Date.now() } };
      const dispatch = { n, child, agent: input.agent, user, assistant };
      dispatches.push(dispatch);
      // Host admits the prompt and builds the FIRST model context. No waiting for the runner: the hook must cope.
      s.messages.push(user);
      const event = { sessionID: child, agent: input.agent, tools: Object.fromEntries(['read', 'subagent', PLANNER_TOOL, EXECUTOR_TOOL].map(name => [name, {}])) };
      await hooks.get('session.context')?.(event);
      contexts.push({ n, child, agent: input.agent, tools: Object.keys(event.tools) });
      s.messages.push(assistant);
      const submit = async (name, payload, messageID = assistant.id) => {
        const info = { tool: name, sessionID: child, agent: input.agent, messageID, id: 'call_' + ++calls, input: payload };
        await hooks.get('tool.execute.before')(info);
        return registered.get(name).execute(payload, { sessionID: child, agent: input.agent, messageID, id: info.id, signal: native.signal, progress: async () => {} });
      };
      await script.shift()?.({ dispatch, submit, tools: contexts.at(-1).tools, sessions });
      assistant.content = [{ type: 'text', text: 'Done.' }];
      assistant.finish = ctrl.finish;
      assistant.time.completed = Date.now();
      s.active = false;
      if (ctrl.outcome === 'succeeded') s.idle = Date.now();
      s.outcome = ctrl.outcome;
      return { output: { sessionID: child, status: 'completed', output: 'Done.' } };
    },
  };
  const ctx = {
    location: { directory }, integration: {},
    tool: {
      list: async () => [subagent],
      transform: async apply => { apply({ add: value => { registered.set(value.name, value); } }); return registration(); },
      hook: async (name, callback) => { hooks.set('tool.' + name, callback); return registration(); },
    },
    session: {
      context: async ({ sessionID }) => (sessions.get(sessionID)?.messages ?? []).slice(),
      get: async ({ sessionID }) => ({ id: sessionID, tokens: ZERO }),
      interrupt: async () => {},
      hook: async (name, callback) => { hooks.set('session.' + name, callback); return registration(); },
    },
    rpc: { register: async () => registration() },
  };
  return { ctx, observe, registered, contexts, dispatches, ctrl, sessions, addSession };
}

const readState = async (directory, runId) => JSON.parse(await fs.readFile(path.join(directory, '.heimdall/runs', runId, 'state.json'), 'utf8'));
const planStep = (...ids) => async ({ submit }) => { const response = (await submit(PLANNER_TOOL, plan(...ids))).output; assert.equal(response.accepted, true); };
const doneStep = () => async ({ submit }) => { const response = (await submit(EXECUTOR_TOOL, completed())).output; assert.equal(response.accepted, true); };

test('a normal standalone start through createPlugin selects structured-v1, exposes the first context its tool and advances once after the native stop', async t => {
  const { directory, configuration } = await project(t, 'heimdall-native-standalone-');
  const host = nativeHost(directory, [planStep('T1'), doneStep()]);
  const setup = await createPlugin({ configuration, observe: host.observe, quota, git }).setup(host.ctx);
  t.after(setup);
  const result = JSON.parse((await host.registered.get('adr_workflow').execute({ action: 'start', adr: '.heimdall/feature.md' }, caller())).content);
  assert.equal(result.status, 'completed');
  const state = await readState(directory, result.runId);
  assert.equal(state.protocol, 'structured-v1');
  assert.equal(state.results.length, 1);
  assert.equal(state.submissionBinding.status, 'closed');
  // The FIRST actionable context of each dispatch already carried exactly its rightful submission tool.
  assert.deepEqual(host.contexts.map(c => c.tools.filter(name => name.startsWith('adr_') || name === PLANNER_TOOL || name === EXECUTOR_TOOL)), [[PLANNER_TOOL], [EXECUTOR_TOOL]]);
  assert.equal(host.dispatches.length, 2);
  // The durable receipt is bound to the host-observed prompt of that dispatch, not to anything the model supplied.
  const receiptDir = path.join(directory, '.heimdall/runs', result.runId);
  const files = (await fs.readdir(receiptDir, { recursive: true })).filter(file => /submission/i.test(file));
  assert.ok(files.length >= 2, 'both submissions persisted a receipt: ' + files.join(', '));
  assert.match(await fs.readFile(path.join(receiptDir, 'ledger.md'), 'utf8'), /T1/);
});

test('an unknown call origin and a late call from an earlier dispatch on a reused child fail closed', async t => {
  const { directory, configuration } = await project(t, 'heimdall-native-stale-');
  let stale;
  const host = nativeHost(directory, [
    planStep('T1'),
    async ({ submit, dispatch }) => { stale = dispatch.assistant.id; assert.equal((await submit(EXECUTOR_TOOL, { status: 'blocked', reason: 'Need the owner' })).output.accepted, true); },
    async ({ submit, dispatch }) => {
      // A delayed call from the earlier dispatch's assistant message must not bind to the newest attempt.
      await assert.rejects(submit(EXECUTOR_TOOL, completed(), stale), new Error(SUBMISSION_DENIAL));
      await assert.rejects(submit(EXECUTOR_TOOL, completed(), 'msg_unknown'), new Error(SUBMISSION_DENIAL));
      assert.equal((await submit(EXECUTOR_TOOL, completed(), dispatch.assistant.id)).output.accepted, true);
    },
  ]);
  const setup = await createPlugin({ configuration, observe: host.observe, quota, git }).setup(host.ctx);
  t.after(setup);
  const paused = JSON.parse((await host.registered.get('adr_workflow').execute({ action: 'start', adr: '.heimdall/feature.md' }, caller())).content);
  assert.equal(paused.status, 'paused');
  assert.match(paused.reason ?? '', /blocked|owner/i);
  const resumed = JSON.parse((await host.registered.get('adr_workflow').execute({ action: 'resume', runId: paused.runId, input: 'Owner resolved it' }, caller())).content);
  assert.equal(resumed.status, 'completed');
  const state = await readState(directory, paused.runId);
  assert.equal(state.results.length, 1);
  assert.equal(host.dispatches[1].child, host.dispatches[2].child, 'the child was reused');
  // Only the blocked receipt of the first dispatch and the completed receipt of the new one exist: the late calls recorded nothing.
  const receipts = (await fs.readdir(path.join(directory, '.heimdall/runs', paused.runId), { recursive: true })).filter(file => /submission/i.test(file) && file.endsWith('.json'));
  assert.equal(receipts.length, 3, receipts.join(', '));
});

test('a submission followed by a failed native outcome never advances', async t => {
  const { directory, configuration } = await project(t, 'heimdall-native-failed-');
  const host = nativeHost(directory, [planStep('T1'), async ({ submit }) => { await submit(EXECUTOR_TOOL, completed()); host.ctrl.outcome = 'failed'; }]);
  const setup = await createPlugin({ configuration, observe: host.observe, quota, git }).setup(host.ctx);
  t.after(setup);
  const result = JSON.parse((await host.registered.get('adr_workflow').execute({ action: 'start', adr: '.heimdall/feature.md' }, caller())).content);
  assert.equal(result.status, 'paused');
  assert.equal((await readState(directory, result.runId)).results.length, 0);
});

test('createWorkflow alone, over the native backend, also selects structured-v1 for a new run', async t => {
  const { directory, configuration } = await project(t, 'heimdall-native-workflow-');
  const host = nativeHost(directory, [async () => {}]);
  const run = createWorkflow({ configuration, ctx: host.ctx, observe: host.observe, quota, git });
  const result = JSON.parse(await run({ action: 'start', adr: '.heimdall/feature.md' }, caller()));
  // No gate is composed here, so the model cannot submit: it pauses actionably instead of trusting prose.
  assert.equal(result.status, 'paused');
  const state = await readState(directory, result.runId);
  assert.equal(state.protocol, 'structured-v1');
  assert.equal(state.tasks.length, 0);
});

test('an unversioned legacy run resumes through the plugin on its legacy path with no binding or submission tool', async t => {
  const { directory, configuration } = await project(t, 'heimdall-native-legacy-');
  const legacyTask = id => ({ ...task(id), dod: ['test passed'] });
  const responses = [
    JSON.stringify({ status: 'planned', planMarkdown: '# Plan', factSheet: 'Facts', tasks: [legacyTask('T1')] }),
    JSON.stringify({ status: 'blocked', reason: 'Attach phone' }),
  ];
  let legacyChildren = 0;
  const legacyBackend = {
    assertIdle: async () => {}, recoverResponse: async () => undefined, usage: async () => ({ used: 0, uncached: 0 }), interrupt: async () => {},
    runSubagent: async (input) => { const id = input.child ?? 'ses_child_' + ++legacyChildren; await input.onStarted(id); return responses.shift(); },
  };
  const legacy = createRunner({
    backend: legacyBackend, directory, quota, git, settings: configuration.settings, workflowRoot: configuration.workflowRoot,
    plannerPromptPath: configuration.plannerPromptPath, executorPromptPath: configuration.executorPromptPath, planRoot: configuration.planRoot,
  });
  const paused = JSON.parse(await legacy({ action: 'start', adr: '.heimdall/feature.md' }, caller()));
  assert.equal(paused.status, 'paused');
  const before = await readState(directory, paused.runId);
  assert.equal(before.protocol, undefined);

  const host = nativeHost(directory, [async ({ dispatch }) => { host.legacyTools = host.contexts.at(-1)?.tools; }]);
  // The legacy executor's child exists, is idle and belongs to the same parent.
  host.addSession(before.child, 'ses_parent');
  Object.assign(host.sessions.get(before.child), { outcome: 'succeeded', idle: Date.now() });
  // The legacy model replies with the historical prose JSON; the host child's final text carries it.
  const subagent = (await host.ctx.tool.list())[0];
  const execute = subagent.execute;
  subagent.execute = async (input, native) => {
    const out = await execute(input, native);
    return { output: { ...out.output, output: JSON.stringify({ status: 'completed', taskId: 'T1', summary: 'Done', handoff: 'Handoff', evidence: [{ gateId: 'G1', passed: true, gate: 'test passed', detail: 'targeted test exit 0' }] }) } };
  };
  const setup = await createPlugin({ configuration, observe: host.observe, quota, git }).setup(host.ctx);
  t.after(setup);
  const resumed = JSON.parse((await host.registered.get('adr_workflow').execute({ action: 'resume', runId: paused.runId, input: 'Phone attached' }, caller())).content);
  assert.equal(resumed.status, 'completed');
  const after = await readState(directory, paused.runId);
  assert.equal(after.protocol, undefined);
  assert.equal(after.submissionBinding, undefined);
  assert.equal(after.results.length, 1);
  assert.deepEqual(host.legacyTools.filter(name => name === PLANNER_TOOL || name === EXECUTOR_TOOL), []);
});

/** A coordinator over a Unix socket that implements exactly the checkpoint, binding, receipt, submission and outcome routes. */
async function fakeCoordinator(t, { runId, parentSessionId, worktreePath, ownerToken }) {
  const socketDirectory = await fs.mkdtemp('/tmp/hmd-');
  const endpoint = path.join(socketDirectory, 'c.sock');
  const store = { checkpoint: null, binding: null, receipts: new Map(), submissions: new Map(), outcomes: new Map() };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
    const send = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value ?? null)); };
    if (request.headers.authorization !== 'Bearer ' + ownerToken) return send(401, { error: 'unauthorized' });
    const route = decodeURIComponent(new URL(request.url, 'http://x').pathname).replace('/runs/' + runId, '') || '/';
    const put = request.method === 'PUT';
    const keyed = (map, key) => put ? (map.has(key) || map.set(key, body), send(200, map.get(key))) : send(200, map.get(key) ?? null);
    if (route === '/') return send(200, { id: runId, parentSessionId, worktreePath, launchAction: 'start', resolution: null, checkpoint: store.checkpoint, binding: store.binding, specification: {} });
    if (route === '/checkpoint') { if (put) { store.checkpoint = body; return send(200, {}); } return send(200, store.checkpoint); }
    if (route === '/binding') { store.binding = body; return send(200, {}); }
    const match = /^\/(receipts|outcomes|submissions)\/(.+)$/.exec(route);
    if (match) return keyed({ receipts: store.receipts, outcomes: store.outcomes, submissions: store.submissions }[match[1]], match[2]);
    return send(404, { error: 'not found' });
  });
  await new Promise(resolve => server.listen(endpoint, resolve));
  t.after(async () => { server.close(); server.closeAllConnections?.(); await fs.rm(socketDirectory, { recursive: true, force: true }); });
  return { endpoint, store };
}

test('a managed start through createPlugin gates submissions on the active owner checkpoint and advances once after the native stop', async t => {
  const { directory, configuration } = await project(t, 'heimdall-native-managed-');
  const runId = 'run_managed';
  const parentSessionId = 'ses_parent';
  const ownerToken = 'synthetic-owner-token';
  const coordinator = await fakeCoordinator(t, { runId, parentSessionId, worktreePath: directory, ownerToken });
  const metadata = { endpoint: coordinator.endpoint, runId, ownerToken, parentSessionId };
  await fs.writeFile(path.join(directory, '.heimdall/managed.json'), JSON.stringify(metadata));
  const host = nativeHost(directory, [planStep('T1'), doneStep()]);
  const setup = await createPlugin({ configuration, observe: host.observe, quota, git }).setup(host.ctx);
  t.after(setup);
  const result = JSON.parse((await host.registered.get('adr_workflow').execute({ action: 'start', adr: '.heimdall/feature.md' }, caller())).content);
  assert.equal(result.status, 'completed');
  const checkpoint = coordinator.store.checkpoint;
  assert.equal(checkpoint.protocol, 'structured-v1');
  assert.equal(checkpoint.results.length, 1);
  assert.equal(coordinator.store.submissions.size, 2, 'both receipts live in the coordinator, not in local files');
  assert.deepEqual(host.contexts.map(c => c.tools.filter(name => name === PLANNER_TOOL || name === EXECUTOR_TOOL)), [[PLANNER_TOOL], [EXECUTOR_TOOL]]);
});

test('a managed identity change makes the gate expose nothing and deny submissions', async t => {
  const { directory, configuration } = await project(t, 'heimdall-native-managed-identity-');
  const runId = 'run_managed';
  const coordinator = await fakeCoordinator(t, { runId, parentSessionId: 'ses_parent', worktreePath: directory, ownerToken: 'tok' });
  await fs.writeFile(path.join(directory, '.heimdall/managed.json'), JSON.stringify({ endpoint: coordinator.endpoint, runId, ownerToken: 'tok', parentSessionId: 'ses_parent' }));
  let denial;
  const host = nativeHost(directory, [async ({ submit }) => {
    // The owner binding is replaced after setup: this is no longer the workflow the plugin was composed for.
    await fs.writeFile(path.join(directory, '.heimdall/managed.json'), JSON.stringify({ endpoint: coordinator.endpoint, runId: 'run_other', ownerToken: 'tok', parentSessionId: 'ses_parent' }));
    denial = await submit(PLANNER_TOOL, plan('T1')).then(() => 'accepted', error => error.message);
  }]);
  const setup = await createPlugin({ configuration, observe: host.observe, quota, git }).setup(host.ctx);
  t.after(setup);
  await assert.rejects(host.registered.get('adr_workflow').execute({ action: 'start', adr: '.heimdall/feature.md' }, caller()), /./);
  assert.equal(denial, SUBMISSION_DENIAL);
  assert.equal(coordinator.store.submissions.size, 0);
});
