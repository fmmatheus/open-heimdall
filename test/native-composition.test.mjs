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
import { createMessageHistory } from '../dist/opencode/observer.js';
import { SUBMISSION_TOOL_IDS } from '../dist/workflow/contracts.js';
import { originUnverifiedDenial, SUBMISSION_DENIAL } from '../dist/workflow/submission.js';

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
function nativeHost(directory, script, { pageSize = 2 } = {}) {
  const sessions = new Map();
  const hooks = new Map();
  const registered = new Map();
  const contexts = [];
  const dispatches = [];
  const ctrl = { outcome: 'succeeded', finish: 'stop' };
  let children = 0, messages = 0, calls = 0;
  const registration = () => ({ dispose: async () => {} });
  // `messages` is the compacted active context; `archive` is the complete native history in chronological order.
  const addSession = (id, parentID) => sessions.set(id, { id, parentID, messages: [], archive: [], outcome: undefined, idle: undefined, active: false });
  const admit = (s, message) => { s.messages.push(message); s.archive.push(message); };
  const requests = [];
  const interrupts = [];
  let compactions = 0;
  // Host-side compaction: the archive keeps everything; the active context restarts at the summary, and the model
  // continues in a NEW assistant message that now carries the submission calls.
  const compact = dispatch => {
    const s = sessions.get(dispatch.child);
    const n = ++compactions;
    const summary = { type: 'compaction', id: 'msg_compaction_' + n, status: 'completed', reason: 'auto', summary: 'Earlier work', recent: '', time: { created: Date.now() } };
    const assistant = { type: 'assistant', id: 'msg_asst_after_' + n, agent: dispatch.agent, content: [], time: { created: Date.now() } };
    s.archive.push(summary, assistant);
    s.messages = [summary, assistant];
    dispatch.assistant = assistant;
    return assistant;
  };
  /** Unrelated older traffic (earlier turns) that the archive keeps and the final context no longer has. */
  const chat = (child, count) => {
    const s = sessions.get(child);
    for (let i = 0; i < count; i++) s.archive.push({ type: 'user', id: 'msg_old_user_' + child + '_' + ++messages, text: 'Older question', time: { created: Date.now() } }, { type: 'assistant', id: 'msg_old_asst_' + messages, agent: 'build', content: [], time: { created: Date.now() } });
  };
  // The supported v2 message-list route: native order, an opaque cursor, `order` only on the first page.
  const fetchImpl = async url => {
    const route = url.pathname + '?' + [...url.searchParams].filter(([key]) => key !== 'location[directory]').map(([key, value]) => key + '=' + value).join('&');
    requests.push(route);
    if (url.pathname === '/api/info') return Response.json({ version: '2.0.22', pid: 77 });
    const match = /^\/api\/session\/([^/]+)(\/message)?$/.exec(url.pathname);
    const s = match && sessions.get(match[1]);
    if (!s) return new Response('missing', { status: 404 });
    if (!match[2]) return Response.json({ data: { id: s.id, location: { directory }, time: {} } });
    const cursor = url.searchParams.get('cursor');
    if (cursor === null ? url.searchParams.get('order') !== 'desc' : url.searchParams.has('order')) return new Response('bad paging', { status: 400 });
    const newest = s.archive.slice().reverse();
    const start = cursor === null ? 0 : Number(Buffer.from(cursor, 'base64url').toString().replace(/^cursor:/, ''));
    const end = start + Math.min(Number(url.searchParams.get('limit')), pageSize);
    return Response.json({ data: newest.slice(start, end), cursor: end < newest.length ? { next: Buffer.from('cursor:' + end).toString('base64url') } : {} });
  };
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
      admit(s, user);
      const event = { sessionID: child, agent: input.agent, tools: Object.fromEntries(['read', 'subagent', PLANNER_TOOL, EXECUTOR_TOOL].map(name => [name, {}])) };
      await hooks.get('session.context')?.(event);
      contexts.push({ n, child, agent: input.agent, tools: Object.keys(event.tools) });
      admit(s, assistant);
      const submit = async (name, payload, messageID = dispatch.assistant.id, listed = {}) => {
        const info = { tool: name, sessionID: child, agent: input.agent, messageID, id: 'call_' + ++calls, input: payload };
        // The host lists the call on the assistant message that carries it; `listed` makes the archive disagree with the call.
        s.archive.find(m => m.id === messageID)?.content?.push({ type: 'tool', id: listed.id ?? info.id, name: listed.name ?? name, state: { status: 'running' }, time: { created: Date.now() } });
        await hooks.get('tool.execute.before')(info);
        return registered.get(name).execute(payload, { sessionID: child, agent: input.agent, messageID, id: info.id, signal: native.signal, progress: async () => {} });
      };
      await script.shift()?.({ dispatch, submit, tools: contexts.at(-1).tools, sessions });
      dispatch.assistant.content.push({ type: 'text', text: 'Done.' });
      dispatch.assistant.finish = ctrl.finish;
      dispatch.assistant.time.completed = Date.now();
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
      interrupt: async ({ sessionID }) => { interrupts.push(sessionID); },
      hook: async (name, callback) => { hooks.set('session.' + name, callback); return registration(); },
    },
    rpc: { register: async () => registration() },
  };
  /** Intermediate assistant turns between the prompt and the call: they push the call and its prompt onto different pages. */
  const steps = (dispatch, count) => {
    const s = sessions.get(dispatch.child);
    for (let i = 0; i < count; i++) admit(s, { type: 'assistant', id: 'msg_step_' + ++messages, agent: dispatch.agent, content: [], time: { created: Date.now() } });
  };
  return { ctx, observe, registered, contexts, dispatches, ctrl, sessions, addSession, compact, chat, steps, fetchImpl, requests, interrupts };
}

/** The real full-archive reader over the fixture's v2 message-list route. */
const history = (host, directory, bounds = {}) => createMessageHistory({ directory, baseUrl: 'http://127.0.0.1:4096', authentication: 'none', fetchImpl: host.fetchImpl, ...bounds });

const readState = async (directory, runId) => JSON.parse(await fs.readFile(path.join(directory, '.heimdall/runs', runId, 'state.json'), 'utf8'));
const planStep = (...ids) => async ({ submit }) => { const response = (await submit(PLANNER_TOOL, plan(...ids))).output; assert.equal(response.accepted, true); };
const doneStep = () => async ({ submit }) => { const response = (await submit(EXECUTOR_TOOL, completed())).output; assert.equal(response.accepted, true); };

test('a normal standalone start through createPlugin selects structured-v1, exposes the first context its tool and advances once after the native stop', async t => {
  const { directory, configuration } = await project(t, 'heimdall-native-standalone-');
  const host = nativeHost(directory, [planStep('T1'), doneStep()]);
  const setup = await createPlugin({ configuration, observe: host.observe, history: history(host, directory), quota, git }).setup(host.ctx);
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
      await assert.rejects(submit(EXECUTOR_TOOL, completed(), 'msg_unknown'), new Error(originUnverifiedDenial('call_not_found')));
      assert.equal((await submit(EXECUTOR_TOOL, completed(), dispatch.assistant.id)).output.accepted, true);
    },
  ]);
  const setup = await createPlugin({ configuration, observe: host.observe, history: history(host, directory), quota, git }).setup(host.ctx);
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

const receiptFiles = async (directory, runId) => (await fs.readdir(path.join(directory, '.heimdall/runs', runId), { recursive: true })).filter(file => /submission/i.test(file) && file.endsWith('.json'));
const hasUser = (host, child) => host.sessions.get(child).messages.some(m => m.type === 'user');

test('a cyclic archive page cannot authenticate a submission even when it carries the exact call and dispatch prompt', async t => {
  for (const steps of [2, 4]) await t.test(steps === 2 ? 'current cursor repeats' : 'earlier cursor repeats', async t => {
    const { directory, configuration } = await project(t, 'heimdall-native-cyclic-proof-');
    let denial;
    let cyclic = true;
    const host = nativeHost(directory, [planStep('T1'), async ({ submit, dispatch }) => {
      host.steps(dispatch, steps);
      denial = await submit(EXECUTOR_TOOL, completed()).then(() => 'accepted', error => error.message);
      cyclic = false;
      // The native final turn remains readable after the rejected call; no second submission is made.
      const session = host.sessions.get(dispatch.child);
      for (const timeline of [session.archive, session.messages]) {
        timeline.splice(timeline.indexOf(dispatch.assistant), 1);
        timeline.push(dispatch.assistant);
      }
    }]);
    const firstCursors = new Map();
    const fetchImpl = async url => {
      const response = await host.fetchImpl(url);
      if (!url.pathname.endsWith('/message')) return response;
      const page = await response.json();
      const cursor = url.searchParams.get('cursor');
      if (!cursor) firstCursors.set(url.pathname, page.cursor.next);
      else if (cyclic && page.data.some(message => message.type === 'user')) page.cursor.next = firstCursors.get(url.pathname);
      return Response.json(page);
    };
    const archive = createMessageHistory({ directory, baseUrl: 'http://127.0.0.1:4096', authentication: 'none', fetchImpl });
    const setup = await createPlugin({ configuration, observe: host.observe, history: archive, quota, git }).setup(host.ctx);
    t.after(setup);
    const result = JSON.parse((await host.registered.get('adr_workflow').execute({ action: 'start', adr: '.heimdall/feature.md' }, caller())).content);
    assert.equal(denial, originUnverifiedDenial('cursor_repeated'));
    assert.equal(result.status, 'paused');
    const state = await readState(directory, result.runId);
    assert.equal(state.index, 0);
    assert.equal(state.results.length, 0);
    assert.equal(state.submissionRepair, undefined);
    assert.equal((await receiptFiles(directory, result.runId)).length, 1, 'only the planner receipt exists');
    assert.deepEqual(host.interrupts, []);
  });
});

test('a genuine submission can prove its origin on the final permitted archive page without following another cursor', async t => {
  const { directory, configuration } = await project(t, 'heimdall-native-final-proof-');
  const host = nativeHost(directory, [planStep('T1'), async ({ submit, dispatch }) => {
    host.steps(dispatch, 2);
    const session = host.sessions.get(dispatch.child);
    // Keep the submitting assistant as the final native turn, with the prompt on the next page.
    for (const timeline of [session.archive, session.messages]) {
      timeline.splice(timeline.indexOf(dispatch.assistant), 1);
      timeline.push(dispatch.assistant);
    }
    assert.equal((await submit(EXECUTOR_TOOL, completed())).output.accepted, true);
  }]);
  const fetchImpl = async url => {
    const response = await host.fetchImpl(url);
    if (!url.pathname.endsWith('/message')) return response;
    assert.notEqual(url.searchParams.get('cursor'), 'older-unvisited', 'proof must not fetch a third page');
    const page = await response.json();
    if (url.searchParams.has('cursor')) page.cursor.next = 'older-unvisited';
    return Response.json(page);
  };
  const archive = createMessageHistory({ directory, baseUrl: 'http://127.0.0.1:4096', authentication: 'none', fetchImpl, maxPages: 2 });
  const setup = await createPlugin({ configuration, observe: host.observe, history: archive, quota, git }).setup(host.ctx);
  t.after(setup);
  const result = JSON.parse((await host.registered.get('adr_workflow').execute({ action: 'start', adr: '.heimdall/feature.md' }, caller())).content);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  const state = await readState(directory, result.runId);
  assert.equal(state.results.length, 1);
  assert.equal(state.index, 1);
  assert.equal((await receiptFiles(directory, result.runId)).length, 2);
});

test('a compacted active context without the dispatch prompt still authenticates the genuine submission from the full archive', async t => {
  const { directory, configuration } = await project(t, 'heimdall-native-compacted-');
  const compacted = async ({ submit, dispatch }) => {
    host.steps(dispatch, 3);
    host.compact(dispatch);
    assert.equal(hasUser(host, dispatch.child), false, 'the active context no longer holds the dispatch prompt');
    const response = (await submit(dispatch.agent === 'adr-planner' ? PLANNER_TOOL : EXECUTOR_TOOL, dispatch.agent === 'adr-planner' ? plan('T1') : completed())).output;
    assert.equal(response.accepted, true);
  };
  const host = nativeHost(directory, [compacted, compacted]);
  const setup = await createPlugin({ configuration, observe: host.observe, history: history(host, directory), quota, git }).setup(host.ctx);
  t.after(setup);
  const result = JSON.parse((await host.registered.get('adr_workflow').execute({ action: 'start', adr: '.heimdall/feature.md' }, caller())).content);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  const state = await readState(directory, result.runId);
  assert.equal(state.results.length, 1);
  assert.equal(state.submissionBinding.status, 'closed');
  // Fully paginated: the first page asks for descending order, every later page carries only the opaque cursor.
  const pages = host.requests.filter(route => route.includes('/message?'));
  assert.ok(pages.length > 2, pages.join(', '));
  assert.ok(pages.every(route => route.includes('cursor=') ? !route.includes('order=') : route.includes('order=desc')), pages.join(', '));
});

test('multiple compactions with the call and its prompt on different pages still authenticate', async t => {
  const { directory, configuration } = await project(t, 'heimdall-native-multi-compaction-');
  const host = nativeHost(directory, [
    async ({ submit, dispatch }) => { host.compact(dispatch); host.steps(dispatch, 5); host.compact(dispatch); host.compact(dispatch); assert.equal((await submit(PLANNER_TOOL, plan('T1'))).output.accepted, true); },
    async ({ submit, dispatch }) => { host.steps(dispatch, 7); host.compact(dispatch); host.compact(dispatch); assert.equal((await submit(EXECUTOR_TOOL, completed())).output.accepted, true); },
  ], { pageSize: 3 });
  const setup = await createPlugin({ configuration, observe: host.observe, history: history(host, directory), quota, git }).setup(host.ctx);
  t.after(setup);
  const result = JSON.parse((await host.registered.get('adr_workflow').execute({ action: 'start', adr: '.heimdall/feature.md' }, caller())).content);
  assert.equal(result.status, 'completed');
  assert.equal((await readState(directory, result.runId)).results.length, 1);
  assert.ok(host.requests.filter(route => route.includes('cursor=')).length >= 3, 'later pages were reached through the returned cursor');
});

test('after compaction and a plugin restart, a reused child accepts its own call and rejects a delayed call from the earlier dispatch', async t => {
  const { directory, configuration } = await project(t, 'heimdall-native-reused-compacted-');
  let stale;
  const host = nativeHost(directory, [
    planStep('T1'),
    async ({ submit, dispatch }) => { host.compact(dispatch); stale = dispatch.assistant.id; assert.equal((await submit(EXECUTOR_TOOL, { status: 'blocked', reason: 'Need the owner' })).output.accepted, true); host.chat(dispatch.child, 2); },
    async ({ submit, dispatch }) => {
      host.steps(dispatch, 4);
      host.compact(dispatch);
      host.compact(dispatch);
      assert.equal(hasUser(host, dispatch.child), false);
      // The earlier call still resolves, but to the earlier prompt: it is not this dispatch's.
      await assert.rejects(submit(EXECUTOR_TOOL, completed(), stale), new Error(SUBMISSION_DENIAL));
      await assert.rejects(submit(EXECUTOR_TOOL, completed(), 'msg_unknown'), new Error(originUnverifiedDenial('call_not_found')));
      assert.equal((await submit(EXECUTOR_TOOL, completed())).output.accepted, true);
    },
  ]);
  const first = await createPlugin({ configuration, observe: host.observe, history: history(host, directory), quota, git }).setup(host.ctx);
  const paused = JSON.parse((await host.registered.get('adr_workflow').execute({ action: 'start', adr: '.heimdall/feature.md' }, caller())).content);
  assert.equal(paused.status, 'paused');
  // A fresh plugin and a fresh history reader hold no process-local authority from the first one.
  await first();
  const second = await createPlugin({ configuration, observe: host.observe, history: history(host, directory), quota, git }).setup(host.ctx);
  t.after(second);
  const resumed = JSON.parse((await host.registered.get('adr_workflow').execute({ action: 'resume', runId: paused.runId, input: 'Owner resolved it' }, caller())).content);
  assert.equal(resumed.status, 'completed');
  assert.equal((await readState(directory, paused.runId)).results.length, 1);
  assert.equal(host.dispatches[1].child, host.dispatches[2].child, 'the child was reused');
  assert.equal((await receiptFiles(directory, paused.runId)).length, 3, 'the delayed and unknown calls recorded nothing');
});

test('unverifiable provenance denies without a receipt, is not a format repair and does not block the genuine retry', async t => {
  const { directory, configuration } = await project(t, 'heimdall-native-unavailable-');
  let mode = 'up';
  let cycles = 0;
  const attempts = [];
  const host = nativeHost(directory, [planStep('T1'), async ({ submit, dispatch }) => {
    host.compact(dispatch);
    for (const failure of ['http', 'malformed', 'cycle', 'duplicate']) {
      mode = failure;
      attempts.push(await submit(EXECUTOR_TOOL, completed()).then(() => 'accepted', error => error.message));
    }
    mode = 'exhausted';
    attempts.push(await submit(EXECUTOR_TOOL, completed()).then(() => 'accepted', error => error.message));
    mode = 'up';
    assert.equal((await submit(EXECUTOR_TOOL, completed())).output.accepted, true);
  }]);
  const served = async url => {
    if (mode === 'up' || !url.pathname.endsWith('/message')) return host.fetchImpl(url);
    if (mode === 'http') return new Response('boom', { status: 500 });
    if (mode === 'malformed') return Response.json({ data: 'not a list', cursor: {} });
    // Distinct messages on every page, but the cursor never advances: only the repeated cursor can stop the scan.
    if (mode === 'cycle') return Response.json({ data: [{ type: 'compaction', id: 'msg_cycle_' + ++cycles }], cursor: { next: 'again' } });
    if (mode === 'duplicate') return Response.json({ data: [{ type: 'compaction', id: 'msg_dup' }, { type: 'compaction', id: 'msg_dup' }], cursor: {} });
    // Exhausted: a well-formed endless history that never reaches the prompt within the bound.
    const start = Number(url.searchParams.get('cursor') ?? 0);
    return Response.json({ data: [{ type: 'compaction', id: 'msg_endless_' + start }], cursor: { next: String(start + 1) } });
  };
  const bounded = createMessageHistory({ directory, baseUrl: 'http://127.0.0.1:4096', authentication: 'none', fetchImpl: served, maxPages: 5 });
  const setup = await createPlugin({ configuration, observe: host.observe, history: bounded, quota, git }).setup(host.ctx);
  t.after(setup);
  const result = JSON.parse((await host.registered.get('adr_workflow').execute({ action: 'start', adr: '.heimdall/feature.md' }, caller())).content);
  assert.deepEqual(attempts, ['history_unavailable', 'page_malformed', 'cursor_repeated', 'duplicate_message', 'scan_exhausted'].map(originUnverifiedDenial));
  assert.equal(result.status, 'completed');
  const state = await readState(directory, result.runId);
  assert.equal(state.results.length, 1);
  // The planner receipt and the single genuine executor receipt only.
  assert.equal((await receiptFiles(directory, result.runId)).length, 2);
});

const runOf = async directory => (await fs.readdir(path.join(directory, '.heimdall/runs')))[0];

test('every unverifiable native origin is denied with its own message, records nothing and leaves the binding usable, while wrong callers keep the plain denial', async t => {
  const { directory, configuration } = await project(t, 'heimdall-native-origin-cases-');
  const outcomes = [];
  const host = nativeHost(directory, [planStep('T1'), async ({ submit, dispatch }) => {
    const runId = await runOf(directory);
    const s = host.sessions.get(dispatch.child);
    const carrier = s.archive.find(m => m.id === dispatch.assistant.id);
    const denied = async (label, run, expected) => {
      const message = await run().then(() => 'accepted', error => error.message);
      outcomes.push([label, message]);
      assert.equal(message, expected, label);
      assert.equal((await readState(directory, runId)).submissionRepair, undefined, label + ': no repair is spent or recorded');
      assert.equal((await receiptFiles(directory, runId)).length, 1, label + ': only the planner receipt exists');
    };
    await denied('missing call', () => submit(EXECUTOR_TOOL, completed(), 'msg_unknown'), originUnverifiedDenial('call_not_found'));
    await denied('wrong call id', () => submit(EXECUTOR_TOOL, completed(), dispatch.assistant.id, { id: 'call_other' }), originUnverifiedDenial('call_mismatch'));
    await denied('wrong call name', () => submit(EXECUTOR_TOOL, completed(), dispatch.assistant.id, { name: PLANNER_TOOL }), originUnverifiedDenial('call_mismatch'));
    carrier.agent = 'build';
    await denied('wrong agent', () => submit(EXECUTOR_TOOL, completed()), originUnverifiedDenial('agent_mismatch'));
    carrier.agent = dispatch.agent;
    const at = s.archive.indexOf(dispatch.user);
    s.archive.splice(at, 1);
    await denied('missing prompt', () => submit(EXECUTOR_TOOL, completed()), originUnverifiedDenial('prompt_not_found'));
    s.archive.splice(at, 0, dispatch.user);
    // Not the bound child, not the configured role, not this kind: none of these reaches origin proof.
    const tool = host.registered.get(EXECUTOR_TOOL);
    const native = { messageID: dispatch.assistant.id, id: 'call_forged', signal: new AbortController().signal, progress: async () => {} };
    await denied('wrong session', () => tool.execute(completed(), { ...native, sessionID: 'ses_other', agent: dispatch.agent }), SUBMISSION_DENIAL);
    await denied('wrong role', () => tool.execute(completed(), { ...native, sessionID: dispatch.child, agent: 'build' }), SUBMISSION_DENIAL);
    await denied('wrong kind', () => submit(PLANNER_TOOL, plan('T9')), SUBMISSION_DENIAL);
    assert.equal((await submit(EXECUTOR_TOOL, completed())).output.accepted, true);
  }]);
  const setup = await createPlugin({ configuration, observe: host.observe, history: history(host, directory), quota, git }).setup(host.ctx);
  t.after(setup);
  const result = JSON.parse((await host.registered.get('adr_workflow').execute({ action: 'start', adr: '.heimdall/feature.md' }, caller())).content);
  assert.equal(result.status, 'completed', JSON.stringify(result));
  assert.equal(outcomes.length, 8);
  for (const [, message] of outcomes) assert.doesNotMatch(message, /msg_|call_[0-9]|Older question|Workflow attempt/, 'no transcript or identity text in a denial');
  assert.equal((await readState(directory, result.runId)).results.length, 1);
  assert.equal((await receiptFiles(directory, result.runId)).length, 2);
  assert.deepEqual(host.interrupts, []);
});

test('an attempt that ends after only unverifiable submission calls pauses naming the unverifiable origin, never a malformed output, and changes nothing else', async t => {
  const { directory, configuration } = await project(t, 'heimdall-native-origin-pause-');
  const host = nativeHost(directory, [
    planStep('T1'),
    async ({ submit }) => { await assert.rejects(submit(EXECUTOR_TOOL, completed(), 'msg_unknown'), new Error(originUnverifiedDenial('call_not_found'))); },
    async () => {},
  ]);
  const setup = await createPlugin({ configuration, observe: host.observe, history: history(host, directory), quota, git }).setup(host.ctx);
  t.after(setup);
  const paused = JSON.parse((await host.registered.get('adr_workflow').execute({ action: 'start', adr: '.heimdall/feature.md' }, caller())).content);
  assert.equal(paused.status, 'paused');
  assert.match(paused.reason, /No valid submission was recorded for T1/);
  assert.match(paused.reason, /a submission call was denied because its native origin could not be verified/i);
  assert.match(paused.reason, /\(call_not_found\)/);
  assert.match(paused.reason, /payload was not evaluated/);
  assert.doesNotMatch(paused.reason, /malformed|invalid|format/i);
  assert.doesNotMatch(paused.reason, /msg_unknown|call_[0-9]/);
  const state = await readState(directory, paused.runId);
  assert.equal(state.reason, paused.reason);
  assert.equal(state.reportRecovery.diagnostic.code, 'submission_missing');
  assert.equal(state.submissionRepair, undefined, 'no repair counter, refusal or restriction was recorded');
  assert.equal(state.results.length, 0);
  assert.equal(host.dispatches.length, 2, 'nothing was rerun');
  assert.deepEqual(host.interrupts, [], 'the dispatch was neither aborted nor interrupted by the denial');
  assert.equal((await receiptFiles(directory, paused.runId)).length, 1, 'only the planner receipt exists');
  // A later attempt with no denial of its own gets the plain missing-submission reason: the note belonged to the earlier attempt.
  const again = JSON.parse((await host.registered.get('adr_workflow').execute({ action: 'resume', runId: paused.runId, input: 'Try again' }, caller())).content);
  assert.equal(again.status, 'paused');
  assert.match(again.reason, /No valid submission was recorded for T1/);
  assert.doesNotMatch(again.reason, /native origin|verified/);
});

test('a receipt proven from the full archive after compaction is replayed after a crash and advances exactly once', async t => {
  const { directory, configuration } = await project(t, 'heimdall-native-replay-');
  const host = nativeHost(directory, [planStep('T1'), async ({ submit, dispatch }) => {
    host.steps(dispatch, 3);
    host.compact(dispatch);
    host.compact(dispatch);
    assert.equal(hasUser(host, dispatch.child), false, 'the active context no longer holds the dispatch prompt');
    assert.equal((await submit(EXECUTOR_TOOL, completed())).output.accepted, true);
    host.ctrl.outcome = 'failed'; // The process dies before the native stop is confirmed or the run advances.
  }], { pageSize: 3 });
  const first = await createPlugin({ configuration, observe: host.observe, history: history(host, directory), quota, git }).setup(host.ctx);
  const paused = JSON.parse((await host.registered.get('adr_workflow').execute({ action: 'start', adr: '.heimdall/feature.md' }, caller())).content);
  assert.equal(paused.status, 'paused');
  const before = await readState(directory, paused.runId);
  assert.equal(before.results.length, 0);
  assert.equal((await receiptFiles(directory, paused.runId)).length, 2);
  await first();
  // The restarted host: a fresh plugin, supervisor and history reader, and the child now stopped cleanly.
  host.ctrl.outcome = 'succeeded';
  Object.assign(host.sessions.get(host.dispatches[1].child), { outcome: 'succeeded', idle: Date.now() });
  const second = await createPlugin({ configuration, observe: host.observe, history: history(host, directory), quota, git }).setup(host.ctx);
  t.after(second);
  const resumed = JSON.parse((await host.registered.get('adr_workflow').execute({ action: 'resume', runId: paused.runId, input: 'Child stopped' }, caller())).content);
  assert.equal(resumed.status, 'completed', JSON.stringify(resumed));
  const after = await readState(directory, paused.runId);
  assert.equal(after.results.length, 1);
  assert.equal(after.index, 1);
  assert.equal(host.dispatches.length, 2, 'the receipt was replayed; no work was redone');
  assert.equal((await receiptFiles(directory, paused.runId)).length, 2, 'no second receipt');
});

test('a submission followed by a failed native outcome never advances', async t => {
  const { directory, configuration } = await project(t, 'heimdall-native-failed-');
  const host = nativeHost(directory, [planStep('T1'), async ({ submit }) => { await submit(EXECUTOR_TOOL, completed()); host.ctrl.outcome = 'failed'; }]);
  const setup = await createPlugin({ configuration, observe: host.observe, history: history(host, directory), quota, git }).setup(host.ctx);
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
  const setup = await createPlugin({ configuration, observe: host.observe, history: history(host, directory), quota, git }).setup(host.ctx);
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
  const setup = await createPlugin({ configuration, observe: host.observe, history: history(host, directory), quota, git }).setup(host.ctx);
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
  const setup = await createPlugin({ configuration, observe: host.observe, history: history(host, directory), quota, git }).setup(host.ctx);
  t.after(setup);
  await assert.rejects(host.registered.get('adr_workflow').execute({ action: 'start', adr: '.heimdall/feature.md' }, caller()), /./);
  assert.equal(denial, SUBMISSION_DENIAL);
  assert.equal(coordinator.store.submissions.size, 0);
});
