import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createNativeSubmissionGate } from '../dist/opencode/submission-gate.js';
import { createPlugin } from '../dist/opencode/plugin.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-native-scope-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, '.heimdall'));
  const metadata = { endpoint: '/synthetic-unavailable-coordinator.sock', runId: 'run', parentSessionId: 'ses_parent', ownerToken: 'synthetic-owner' };
  const metadataFile = path.join(directory, '.heimdall/managed.json');
  await fs.writeFile(metadataFile, JSON.stringify(metadata));
  const configuration = {
    projectDirectory: directory, configPath: 'synthetic', workflowRoot: path.join(directory, '.heimdall/state'), planRoot: path.join(directory, '.heimdall/plans'),
    settings: { plannerAgent: 'adr-planner', executorAgent: 'adr-executor', maxTasks: 10 }, opencode: {},
  };
  const sessions = new Map([
    ['ses_child', { id: 'ses_child', parentID: 'ses_parent' }], ['ses_unknown_child', { id: 'ses_unknown_child', parentID: 'ses_parent' }],
    ['ses_descendant', { id: 'ses_descendant', parentID: 'ses_child' }],
    ['ses_other', { id: 'ses_other', parentID: 'ses_other_parent' }], ['ses_other_parent', { id: 'ses_other_parent' }],
  ]);
  let state = { id: 'run', status: 'running', parent: 'ses_parent', phase: 'executor', index: 0, child: 'ses_child', settings: configuration.settings, tasks: [], results: [],
    attempt: { id: 'attempt', phase: 'executor', index: 0, child: 'ses_child', status: 'admitted' } };
  let unavailable = false, nativeUnavailable = false, requests = 0;
  const nativeSession = async id => { if (nativeUnavailable) throw new Error('Synthetic native outage'); return sessions.get(id); };
  const history = async function* () {};
  const gate = createNativeSubmissionGate({ configuration, metadata, nativeSession, history, coordinatorClient: { request: async (method, route, body, token) => {
    requests++; assert.equal(method, 'GET'); assert.equal(route, '/runs/run/checkpoint'); assert.equal(token, metadata.ownerToken);
    if (unavailable) throw new Error('Synthetic coordinator outage');
    return structuredClone(state);
  } } });
  return { directory, metadata, metadataFile, configuration, sessions, gate, history, nativeSession,
    get requests() { return requests; }, get state() { return state; }, set state(value) { state = value; },
    set unavailable(value) { unavailable = value; }, set nativeUnavailable(value) { nativeUnavailable = value; },
  };
}

test('managed submission fence proves unrelated ancestry before coordinator access or managed metadata reads', async t => {
  const f = await fixture(t);
  f.unavailable = true;
  for (const agent of ['build', 'adr-executor', undefined]) assert.equal(await f.gate.sealed('ses_other', agent), false);
  assert.equal(await f.gate.owns('ses_other'), false);
  assert.equal(await f.gate.exposed('ses_other', 'adr-executor'), undefined);
  const submission = await f.gate.submit('executor-result', {}, { sessionID: 'ses_other', agent: 'adr-executor', id: 'call', messageID: 'msg' });
  assert.equal(submission.accepted, false);
  assert.equal(f.requests, 0, 'unrelated callers never select or query the managed run');
  await fs.writeFile(f.metadataFile, '{invalid json');
  assert.equal(await f.gate.sealed('ses_other', 'adr-executor'), false);
  assert.equal(await f.gate.owns('ses_other'), false);
  assert.equal(f.requests, 0);
  assert.equal(await f.gate.sealed('ses_child', 'adr-executor'), true);
  assert.equal(await f.gate.owns('ses_child'), true);
  assert.equal(await f.gate.sealed('ses_parent', 'adr-orchestrator'), false);
});

test('managed children and descendants fail closed on outages, absent checkpoints and unrecognized authority', async t => {
  const f = await fixture(t);
  assert.equal(await f.gate.sealed('ses_child', 'adr-executor'), false);
  assert.equal(await f.gate.owns('ses_child'), true);
  assert.equal(await f.gate.sealed('ses_child', 'build'), true);
  assert.equal(await f.gate.sealed('ses_unknown_child', 'adr-executor'), true);
  assert.equal(await f.gate.owns('ses_unknown_child'), true);
  assert.equal(await f.gate.sealed('ses_descendant', 'build'), true);
  assert.equal(await f.gate.owns('ses_descendant'), true);
  f.state = null;
  assert.equal(await f.gate.sealed('ses_child', 'adr-executor'), true);
  assert.equal(await f.gate.owns('ses_child'), true);
  f.unavailable = true;
  assert.equal(await f.gate.sealed('ses_child', 'adr-executor'), true);
  assert.equal(await f.gate.owns('ses_child'), true);
  assert.equal(await f.gate.sealed('ses_other', 'adr-executor'), false);
});

test('unverifiable native ancestry never opens a managed child fence', async t => {
  const f = await fixture(t);
  f.sessions.set('ses_cycle_a', { id: 'ses_cycle_a', parentID: 'ses_cycle_b' });
  f.sessions.set('ses_cycle_b', { id: 'ses_cycle_b', parentID: 'ses_cycle_a' });
  for (const id of ['ses_missing', 'ses_cycle_a']) {
    assert.equal(await f.gate.sealed(id, 'build'), true);
    assert.equal(await f.gate.owns(id), true);
  }
  f.nativeUnavailable = true;
  assert.equal(await f.gate.sealed('ses_child', 'build'), true);
  assert.equal(await f.gate.owns('ses_child'), true);
});

test('production plugin uses native session ancestry to preserve unrelated tools during a coordinator outage', async t => {
  const f = await fixture(t);
  const hooks = new Map();
  const registration = () => ({ dispose: async () => {} });
  const cleanup = await createPlugin({ configuration: f.configuration, history: f.history, observe: async () => assert.fail('No native observer is needed for tool scope') }).setup({
    location: { directory: f.directory },
    tool: { transform: async edit => { edit({ add: () => {} }); return registration(); }, hook: async (name, callback) => { hooks.set('tool.' + name, callback); return registration(); } },
    session: { get: ({ sessionID }) => f.nativeSession(sessionID), hook: async (name, callback) => { hooks.set('session.' + name, callback); return registration(); } },
    permission: { hook: async (name, callback) => { hooks.set('permission.' + name, callback); return registration(); } },
  });
  t.after(cleanup);
  const ordinary = { sessionID: 'ses_other', agent: 'build', tool: 'write', input: {}, messageID: 'msg', id: 'call_other' };
  await hooks.get('tool.execute.before')(ordinary);
  const context = { sessionID: 'ses_other', agent: 'build', tools: { write: {}, shell: {} } };
  await hooks.get('session.context')(context);
  assert.deepEqual(Object.keys(context.tools), ['write', 'shell']);
  const permission = { sessionID: 'ses_other', action: 'write', effect: 'allow' };
  await hooks.get('permission.evaluate')(permission);
  assert.equal(permission.effect, 'allow');
  await assert.rejects(hooks.get('tool.execute.before')({ ...ordinary, sessionID: 'ses_child', agent: 'adr-executor', id: 'call_child' }), /no further implementation work/);
});
