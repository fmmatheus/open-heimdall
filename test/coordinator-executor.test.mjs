import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createManagedExecutor, managedPrompt } from '../dist/coordinator/executor.js';

const tokens = value => ({ input: value, output: 0, reasoning: 0, cache: { read: 0, write: 0 } });
const runFixture = () => ({ id: 'run-one', ownerToken: 'synthetic-owner', capacityReserved: true, version: 1, parentSessionId: 'ses_reserved', promptMessageId: 'msg_reserved', worktreePath: '/synthetic/managed/checkout', launchAction: 'start', resolution: null, checkpoint: null, specification: { settings: { plannerAgent: 'adr-planner', executorAgent: 'adr-executor', plannerModel: 'anthropic/planner', plannerVariant: 'max' }, opencode: { baseUrl: 'http://127.0.0.1:4096', passwordEnvironmentVariable: 'SYNTHETIC_PASSWORD' } } });

function fixture(run = runFixture(), connectionOverrides = {}) {
  const calls = [], projected = new Map(), sessions = new Map();
  let active = {}, inbox = [], permissions = [], forms = [], pluginsValid = true, listingAvailable = true, coldReads = 0, pluginFailed = false, clock = 0;
  const delays = [];
  const parent = { id: run.parentSessionId, agent: 'adr-orchestrator', model: { providerID: 'anthropic', id: 'planner', variant: 'max' }, location: { directory: run.worktreePath }, metadata: { heimdallRunId: run.id }, tokens: tokens(0), time: { created: 1 } };
  sessions.set(parent.id, parent);
  const fetchImpl = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ method: options.method ?? 'GET', route: url.pathname, body, directory: url.searchParams.get('location[directory]'), authenticated: Object.hasOwn(options.headers ?? {}, 'Authorization'), headers: options.headers });
    if (url.pathname === '/api/info') return Response.json({ version: '2.0.22', pid: 44 });
    if (url.pathname === '/api/plugin') {
      const cold = coldReads > 0; if (cold) coldReads--;
      return Response.json({ data: pluginsValid && !cold ? [{ id: 'adr.workflow', source: { type: 'local', path: path.join(run.worktreePath, '.opencode/plugins/heimdall.ts') }, state: { status: pluginFailed ? 'failed' : 'active' } }] : [] });
    }
    if (url.pathname === '/api/agent') return Response.json({ data: ['adr-orchestrator', 'adr-planner', 'adr-executor'].map(id => ({ id, mode: id === 'adr-orchestrator' ? 'primary' : 'subagent' })) });
    if (url.pathname === '/api/session' && options.method === 'POST') return Response.json({ data: sessions.get(body.id) });
    if (url.pathname === '/api/session' && (options.method ?? 'GET') === 'GET') {
      if (!listingAvailable) return new Response('', { status: 503 });
      const marker = url.searchParams.get('cursor');
      const [parentID, offset] = marker ? marker.split(':') : [url.searchParams.get('parentID'), '0'];
      const linked = [...sessions.values()].filter(session => session.parentID === parentID);
      const start = Number(offset), data = linked.slice(start, start + 1);
      return Response.json({ data, cursor: data.length ? { next: parentID + ':' + (start + 1) } : {} });
    }
    if (url.pathname === '/api/session/active') return Response.json({ data: active });
    const match = /^\/api\/session\/([^/]+)(.*)$/.exec(url.pathname);
    if (!match) return new Response('', { status: 404 });
    const session = sessions.get(match[1]);
    if (!session) return new Response('', { status: 404 });
    if (!match[2]) return Response.json({ data: session });
    if (match[2] === '/inbox') return Response.json({ data: match[1] === parent.id ? inbox : [] });
    if (match[2] === '/permission') return Response.json({ data: match[1] === parent.id ? permissions : [] });
    if (match[2] === '/form') return Response.json({ data: match[1] === parent.id ? forms : [] });
    if (match[2] === '/message') return Response.json({ data: session.outcome ? [{ type: 'assistant', finish: 'stop', time: { completed: 20 } }] : [] });
    if (match[2].startsWith('/message/')) return projected.has(match[2].slice(9)) ? Response.json({ data: projected.get(match[2].slice(9)) }) : new Response('', { status: 404 });
    if (match[2] === '/prompt' && options.method === 'POST') {
      const value = { id: body.id, sessionID: session.id, type: 'user', delivery: body.delivery, payload: { text: body.text, metadata: body.metadata } };
      if (body.resume) { projected.set(body.id, { id: body.id, type: 'user', text: body.text, metadata: body.metadata }); inbox = []; active = { [session.id]: { type: 'running' } }; }
      else inbox = [value];
      return Response.json({ data: value });
    }
    return new Response('', { status: 404 });
  };
  const executor = createManagedExecutor({ getRun: () => run, preflightTimeoutMs: 1000, now: () => clock, pause: async ms => { assert.ok(!calls.some(call => call.method === 'POST'), 'readiness never writes before active inventory'); delays.push(ms); clock += ms; }, connection: { environment: { SYNTHETIC_PASSWORD: 'synthetic-test-secret' }, fetchImpl, ...connectionOverrides } });
  const settled = (id, parentID) => ({ id, ...(parentID ? { parentID } : {}), location: { directory: run.worktreePath }, tokens: tokens(1), outcome: 'succeeded', time: { idle: 10 } });
  return { run, executor, calls, parent, sessions, projected, settled, delays,
    set active(value) { active = value; }, set inbox(value) { inbox = value; }, set permissions(value) { permissions = value; }, set forms(value) { forms = value; }, set pluginsValid(value) { pluginsValid = value; }, set listingAvailable(value) { listingAvailable = value; }, set coldReads(value) { coldReads = value; }, set pluginFailed(value) { pluginFailed = value; } };
}

test('native launch uses exact saved session/message IDs, explicit worktree location, and two-phase admission', async () => {
  const f = fixture(); await f.executor.launch(f.run);
  const create = f.calls.find(call => call.route === '/api/session');
  assert.deepEqual(create.body.location, { directory: f.run.worktreePath });
  assert.equal(create.body.id, f.run.parentSessionId);
  assert.deepEqual(create.body.model, { providerID: 'anthropic', id: 'planner', variant: 'max' });
  const prompts = f.calls.filter(call => call.route.endsWith('/prompt'));
  assert.deepEqual(prompts.map(call => call.body.resume), [false, true]);
  assert.ok(prompts.every(call => call.body.id === f.run.promptMessageId && call.body.text === managedPrompt(f.run)));
  assert.ok(f.calls.every(call => call.directory === f.run.worktreePath));
  await f.executor.launch(f.run);
  assert.equal(f.calls.filter(call => call.route.endsWith('/prompt')).length, 2, 'projected prompt retries never admit or wake another inference');
});

test('native default variant projection matches an omitted planner variant without weakening explicit variants', async () => {
  const run = runFixture();
  delete run.specification.settings.plannerVariant;
  const implicit = fixture(run);
  implicit.parent.model.variant = 'default';
  await implicit.executor.launch(run);
  const created = implicit.calls.find(call => call.route === '/api/session' && call.method === 'POST');
  assert.ok(!Object.hasOwn(created.body.model, 'variant'));
  assert.equal(implicit.calls.filter(call => call.route.endsWith('/prompt')).length, 2);

  const explicit = fixture();
  explicit.parent.model.variant = 'default';
  await assert.rejects(explicit.executor.launch(explicit.run), /Created native parent does not match/);
  assert.ok(!explicit.calls.some(call => call.route.endsWith('/prompt')));
});

test('launch retries wake a matching pending admission and reject conflicting parent identity', async () => {
  const f = fixture();
  f.inbox = [{ id: f.run.promptMessageId, sessionID: f.run.parentSessionId, type: 'user', payload: { text: managedPrompt(f.run), metadata: { heimdallRunId: f.run.id } } }];
  await f.executor.launch(f.run);
  assert.deepEqual(f.calls.filter(call => call.route.endsWith('/prompt')).map(call => call.body.resume), [true]);
  const other = fixture(); other.parent.location.directory = '/different/project';
  await assert.rejects(other.executor.launch(other.run), /reserved managed identity/);
  assert.ok(!other.calls.some(call => call.route.endsWith('/prompt')));
});

test('wrong plugin or unrelated parent input cannot launch managed inference', async () => {
  const wrong = fixture(); wrong.pluginsValid = false;
  await assert.rejects(wrong.executor.launch(wrong.run), /managed Heimdall plugin/);
  assert.ok(!wrong.calls.some(call => call.route === '/api/session'));
  const gated = fixture(); gated.permissions = [{ id: 'permission' }];
  await assert.rejects(gated.executor.launch(gated.run), /pending input/);
  assert.ok(!gated.calls.some(call => call.route.endsWith('/prompt')));
  const conflict = fixture();
  conflict.projected.set(conflict.run.promptMessageId, { id: conflict.run.promptMessageId, type: 'user', text: 'A different admitted action', metadata: { heimdallRunId: conflict.run.id } });
  await assert.rejects(conflict.executor.launch(conflict.run), /prompt identity conflicts/);
  assert.ok(!conflict.calls.some(call => call.route.endsWith('/prompt')));
});

test('inspection requires authoritative completion plus idle parent and every known child', async () => {
  const f = fixture();
  f.sessions.set(f.run.parentSessionId, f.settled(f.run.parentSessionId));
  f.sessions.set('ses_planner', f.settled('ses_planner', f.run.parentSessionId));
  f.sessions.set('ses_executor', f.settled('ses_executor', f.run.parentSessionId));
  f.run.checkpoint = { id: f.run.id, parent: f.run.parentSessionId, status: 'completed', tasks: [{ id: 'T1' }], results: [{ sessionId: 'ses_executor' }], index: 1, child: null, usage: { ses_planner: 1, ses_executor: 1 } };
  assert.deepEqual(await f.executor.inspect(f.run), { idle: true, status: 'succeeded' });
  f.active = { ses_planner: { type: 'running' } };
  assert.deepEqual((await f.executor.inspect(f.run)).idle, false);
  f.active = {}; f.sessions.get('ses_executor').parentID = 'different-parent';
  assert.equal((await f.executor.inspect(f.run)).status, 'unknown');
});

test('paused and uncheckpointed terminal parents are distinguished; ambiguous child launch retains capacity', async () => {
  const f = fixture(); f.sessions.set(f.run.parentSessionId, f.settled(f.run.parentSessionId));
  assert.equal((await f.executor.inspect(f.run)).status, 'failed');
  f.run.checkpoint = { id: f.run.id, parent: f.run.parentSessionId, status: 'paused', reason: 'Owner gate', child: null, results: [] };
  assert.deepEqual(await f.executor.inspect(f.run), { idle: true, status: 'paused', reason: 'Owner gate' });
  f.run.checkpoint.attempt = { status: 'launching', child: null };
  assert.equal((await f.executor.inspect(f.run)).idle, false);
  f.run.checkpoint = null; f.sessions.delete(f.run.parentSessionId);
  assert.deepEqual(await f.executor.inspect(f.run), { idle: true, status: 'failed', reason: 'Reserved native parent is absent and all linked native children were verified idle' });
});

test('resume submits a new persisted message with the exact owner resolution on the same terminal parent', async () => {
  const f = fixture();
  Object.assign(f.parent, f.settled(f.run.parentSessionId));
  f.run.launchAction = 'resume'; f.run.resolution = 'Exact owner resolution'; f.run.promptMessageId = 'msg_resume';
  await f.executor.launch(f.run);
  const message = f.calls.find(call => call.route.endsWith('/prompt')).body;
  assert.equal(message.id, 'msg_resume'); assert.match(message.text, /Exact owner resolution/);
  assert.match(message.text, /"action":"resume"/);
});


test('uncheckpointed active children, unknown nested delegation, and unavailable inventories retain capacity', async () => {
  const f = fixture();
  f.sessions.delete(f.run.parentSessionId);
  f.sessions.set('ses_unrecorded', f.settled('ses_unrecorded', f.run.parentSessionId));
  f.active = { ses_unrecorded: { type: 'running' } };
  assert.equal((await f.executor.inspect(f.run)).idle, false);
  f.active = {};
  assert.equal((await f.executor.inspect(f.run)).idle, true);
  f.sessions.set('ses_nested', f.settled('ses_nested', 'ses_unrecorded'));
  assert.equal((await f.executor.inspect(f.run)).status, 'unknown');
  f.sessions.delete('ses_nested'); f.listingAvailable = false;
  assert.equal((await f.executor.inspect(f.run)).idle, false);
});


test('stale executor ownership/version cannot create a session or admit another prompt', async () => {
  const f = fixture(); const expected = structuredClone(f.run); f.run.ownerToken = 'new-owner';
  await assert.rejects(f.executor.launch(expected), /ownership or version/);
  assert.equal(f.calls.length, 0);
  f.run.ownerToken = expected.ownerToken; f.run.version++;
  await assert.rejects(f.executor.launch(expected), /ownership or version/);
  assert.equal(f.calls.length, 0);
  f.run.version = expected.version; f.run.capacityReserved = false;
  await assert.rejects(f.executor.launch(expected), /ownership or version/);
  assert.equal(f.calls.length, 0);
});


test('cold plugin readiness is read-only until the actual inventory becomes active', async () => {
  const f = fixture(); f.coldReads = 2;
  await f.executor.launch(f.run);
  assert.equal(f.calls.filter(call => call.route === '/api/plugin').length, 3);
  assert.deepEqual(f.delays, [250, 250]);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 3);
});

test('failed native plugins fail immediately and readiness deadline never mutates sessions', async () => {
  const failed = fixture(); failed.pluginFailed = true;
  await assert.rejects(failed.executor.launch(failed.run), /failed to activate/);
  assert.deepEqual(failed.delays, []);
  assert.ok(!failed.calls.some(call => call.method === 'POST'));
  const pending = fixture(); pending.pluginsValid = false;
  await assert.rejects(pending.executor.launch(pending.run), /Timed out waiting/);
  assert.equal(pending.delays.reduce((sum, ms) => sum + ms, 0), 1000);
  assert.ok(!pending.calls.some(call => call.method === 'POST'));
  assert.throws(() => createManagedExecutor({ getRun: () => pending.run, preflightTimeoutMs: 10001 }), /at most 10000ms/);
});


test('persisted authentication wins over a shared connection override, including legacy basic defaults', async () => {
  const legacy = fixture(runFixture(), { authentication: 'none', environment: {} });
  await assert.rejects(legacy.executor.launch(legacy.run), /password environment/);
  assert.equal(legacy.calls.length, 0);
  const explicit = runFixture(); explicit.specification.opencode.authentication = 'none';
  const none = fixture(explicit, { authentication: 'basic', environment: new Proxy({}, { get: () => assert.fail('Explicit none must not read a password') }) });
  await none.executor.launch(none.run);
  assert.ok(none.calls.every(call => call.authenticated === false));
});


test('saved Desktop mode reaches managed native launch with token-free run metadata', async () => {
  const run = runFixture();
  run.specification.opencode.authentication = 'openchamber';
  const environment = new Proxy({}, { get: (_target, key) => { assert.equal(key, 'OPENCHAMBER_DATA_DIR'); return undefined; } });
  const f = fixture(run, { authentication: 'basic', environment, openchamber: { homeDirectory: '/synthetic/home', readFile: async () => JSON.stringify({ desktopLocalPort: 4096, desktopLocalClientToken: 'synthetic-desktop-token' }) } });
  await f.executor.launch(run);
  assert.ok(f.calls.every(call => call.headers.Authorization === 'Bearer synthetic-desktop-token' && call.headers['x-opencode-directory-encoding'] === 'uri'));
  assert.ok(!JSON.stringify(run.specification).includes('synthetic-desktop-token'));
  const created = f.calls.find(call => call.method === 'POST' && call.route === '/api/session');
  assert.deepEqual(created.body.metadata, { heimdallRunId: run.id });
  assert.deepEqual(f.calls.filter(call => call.route.endsWith('/prompt')).map(call => call.body.resume), [false, true]);
});
