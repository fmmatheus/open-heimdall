import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createCoordinatorClient } from '../dist/coordinator/client.js';
import { startCoordinatorService, readCoordinatorToken } from '../dist/coordinator/service.js';
import { RUN_LIST_MAX_BYTES, RUN_LIST_PAGE_SIZE } from '../dist/coordinator/run-list.js';
import { createCoordinatorAdapter } from '../dist/extension/service/coordinator.js';
import { summarizeRun } from '../dist/extension/service/projection.js';
import { createExtensionServer, listenExtensionServer } from '../dist/extension/service/server.js';

const SERVICE_TOKEN = 'synthetic-extension-service-token';
const specification = {
  settings: { plannerAgent: 'planner', executorAgent: 'executor', plannerModel: 'anthropic/planner', executorModel: 'anthropic/executor', executorFallbackModel: 'kimi/fallback', maxTasks: 10, minQuotaRemainingPercent: 10, tokenLimitsDisabled: true },
  plannerPrompt: 'PRIVATE-PLANNER-PROMPT', executorPrompt: 'PRIVATE-EXECUTOR-PROMPT', agents: {},
  opencode: { baseUrl: 'http://127.0.0.1:9999', passwordEnvironmentVariable: 'SYNTHETIC_PASSWORD' },
};

async function fixture(t, globalConcurrency = 2) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hd-list-')));
  const stateDirectory = path.join(directory, 'state');
  const configuration = { stateDirectory, endpoint: path.join(stateDirectory, 'c.sock'), globalConcurrency, projectConcurrency: globalConcurrency };
  let executorCalls = 0;
  const executor = {
    async launch() { executorCalls++; throw new Error('A list read must not launch work'); },
    async inspect() { executorCalls++; throw new Error('A list read must not inspect work'); },
  };
  const service = await startCoordinatorService({ configuration, executor, pollIntervalMs: 60000 });
  service.scheduler.pauseAdmission();
  t.after(async () => { await service.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const token = await readCoordinatorToken(stateDirectory);
  const client = createCoordinatorClient(configuration.endpoint, token, { timeoutMs: 5000, deadlineMs: 10000 });
  const requests = [];
  const adapter = createCoordinatorAdapter({
    loadConfiguration: async () => configuration,
    readToken: async () => token,
    clientFactory: () => ({
      async request(method, route) { requests.push({ method, route }); return client.request(method, route); },
    }),
  });
  const registerProject = async name => {
    const checkout = path.join(directory, name);
    const commonGitDirectory = path.join(checkout, '.git');
    const configPath = path.join(checkout, '.heimdall.toml');
    await fs.mkdir(commonGitDirectory, { recursive: true });
    await fs.writeFile(configPath, '[workflow]\n');
    return service.store.registerProject({ directory: checkout, commonGitDirectory, configPath, concurrency: globalConcurrency });
  };
  const enqueue = (project, id, feature = `# Fixture ${id}\n\nFeature body`) => service.store.enqueue({
    id, projectId: project.id, feature, baseCommit: 'a'.repeat(40), worktreePath: path.join(directory, 'worktrees', id),
    branch: `heimdall/${id}`, specification,
  });
  return { directory, configuration, service, store: service.store, client, adapter, requests, registerProject, enqueue, executorCalls: () => executorCalls };
}

function checkpoint(run, overrides = {}) {
  const caller = { sessionID: run.parentSessionId, id: `call-${run.id}`, messageID: `message-${run.id}`, agent: 'adr-orchestrator' };
  return {
    id: run.id, status: 'running', adr: 'feature.md', parent: run.parentSessionId, caller, branch: run.branch, baseline: '',
    index: 1, tasks: [
      { id: 'T1', title: 'First task', brief: 'First private brief', dependsOn: [], dod: ['First gate'] },
      { id: 'T2', title: 'Second task', brief: 'Second private brief', dependsOn: ['T1'], dod: ['Second gate'] },
    ],
    results: [{ taskId: 'T1', status: 'completed', summary: 'Completed first task', handoff: 'Proceed to T2', evidence: [], model: 'anthropic/executor', sessionId: `child-${run.id}` }],
    phase: 'executor', child: null, settings: specification.settings, ...overrides,
  };
}

function startSavedRun(f, project, id, { feature, state = {}, status = 'succeeded' } = {}) {
  f.enqueue(project, id, feature);
  let run = f.store.admitNext();
  assert.equal(run.id, id);
  const saved = checkpoint(run, state);
  f.store.bindStart(id, run.ownerToken, saved.caller);
  f.store.saveCheckpoint(id, run.ownerToken, saved);
  run = f.store.transition(id, run.ownerToken, run.version, 'running');
  if (status !== 'running') run = f.store.transition(id, run.ownerToken, run.version, status, undefined, ['paused', 'succeeded', 'failed'].includes(status));
  return run;
}

function snapshot(store) {
  return { runs: store.listRuns(), events: store.events(), counts: store.statusCounts() };
}

async function extension(t, adapter) {
  const server = await listenExtensionServer(createExtensionServer({ token: SERVICE_TOKEN, adapter }), 0);
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return server;
}

function call(server, target, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: '127.0.0.1', port: server.address().port, method, path: target, headers: { Authorization: `Bearer ${SERVICE_TOKEN}`, 'Content-Type': 'application/json' } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, text, json: JSON.parse(text) });
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error('Extension fixture request timed out')));
    request.on('error', reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

test('large saved history loads through compact lists without changing saved records or active reservations', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const project = await f.registerProject('project');
  const otherProject = await f.registerProject('other-project');
  const ids = [];
  for (let index = 0; index < 35; index++) {
    const id = `saved-${index}`;
    ids.push(id);
    startSavedRun(f, index === 34 ? otherProject : project, id, {
      feature: `# Saved task ${index}\n\n${'feature-body-'.repeat(2500)}FEATURE-TAIL-${index}`,
      state: { status: 'completed', results: [{ taskId: 'T1', status: 'completed', summary: 'checkpoint-body-'.repeat(4500) + `CHECKPOINT-TAIL-${index}`, handoff: 'Done', evidence: [], model: 'anthropic/executor', sessionId: `child-${id}` }] },
    });
  }
  const active = startSavedRun(f, project, 'active', { status: 'running' });
  ids.push(active.id);
  const before = snapshot(f.store);
  assert.ok(Buffer.byteLength(JSON.stringify(before.runs)) > 2 * 1024 * 1024, 'fixture reproduces the oversized historical list');
  await assert.rejects(f.client.request('GET', '/runs'), error => error.code === 'response-too-large');

  const page = await f.client.request('GET', '/run-list');
  assert.equal(page.total, ids.length);
  assert.ok(Buffer.byteLength(JSON.stringify(page)) <= RUN_LIST_MAX_BYTES);
  assert.deepEqual(page.runs.map(run => run.id), ids);
  for (const run of page.runs) {
    for (const field of ['checkpoint', 'specification', 'ownerToken', 'binding', 'resumeBinding', 'promptMessageId']) assert.equal(Object.hasOwn(run, field), false, field);
  }
  assert.ok(!JSON.stringify(page).includes('PRIVATE-PLANNER-PROMPT'));
  const runs = await f.adapter.runs();
  assert.deepEqual(runs.map(run => run.id), ids);
  assert.ok(f.requests.every(request => request.method === 'GET' && request.route.startsWith('/run-list?')), 'the adapter never downloads the legacy full history');
  const server = await extension(t, f.adapter);
  const listed = await call(server, '/runs');
  assert.equal(listed.status, 200);
  assert.equal(listed.json.total, ids.length);
  assert.equal(listed.json.truncated, false);
  const filtered = await call(server, `/runs?projectId=${project.id}&status=running`);
  assert.equal(filtered.status, 200);
  assert.deepEqual(filtered.json.runs, [summarizeRun(await f.client.request('GET', `/runs/${active.id}`), project)]);
  const full = await f.adapter.run('saved-0');
  assert.equal(full.feature, before.runs[0].feature);
  assert.deepEqual(full.checkpoint, before.runs[0].checkpoint);
  assert.ok(full.feature.endsWith('FEATURE-TAIL-0'));
  assert.ok(full.checkpoint.results[0].summary.endsWith('CHECKPOINT-TAIL-0'));
  const detail = await call(server, '/runs/saved-0');
  assert.equal(detail.status, 200);
  assert.equal(detail.json.run.id, 'saved-0');
  assert.equal(detail.json.run.tasks[0].clipped.summary, true);
  assert.deepEqual(snapshot(f.store), before, 'list and detail reads preserve every run, event, status, checkpoint and reservation');
  assert.equal(f.store.getRun(active.id).ownerToken, active.ownerToken);
  assert.equal(f.store.getRun(active.id).capacityReserved, true);
  assert.equal(f.executorCalls(), 0);
});

test('pagination respects actual Unicode and JSON-escape bytes and finds worktrees from later pages', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const project = await f.registerProject('project');
  const ids = [];
  for (let index = 0; index < RUN_LIST_PAGE_SIZE + 25; index++) {
    const id = `unicode-${index}`;
    ids.push(id);
    f.enqueue(project, id, `# Unicode ${index}\n\n${'\u0001"\\😀'.repeat(6000)}`);
  }
  const last = f.store.getRun(ids.at(-1));
  await fs.mkdir(last.worktreePath, { recursive: true });
  const before = snapshot(f.store);
  let after = 0;
  let through;
  const seen = [];
  let pageCount = 0;
  do {
    const page = await f.client.request('GET', `/run-list?after=${after}${through === undefined ? '' : `&through=${through}`}`);
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= RUN_LIST_MAX_BYTES, 'budget counts encoded UTF-8 JSON bytes');
    assert.ok(page.runs.length > 0 && page.runs.length <= RUN_LIST_PAGE_SIZE);
    assert.equal(page.total, ids.length);
    if (through !== undefined) assert.equal(page.through, through);
    through = page.through;
    seen.push(...page.runs.map(run => run.id));
    pageCount++;
    if (page.nextCursor === null) break;
    assert.ok(page.nextCursor > after && page.nextCursor <= through);
    after = page.nextCursor;
  } while (true);
  assert.ok(pageCount > 2, 'the byte budget splits these runs before the 100-record cap');
  assert.deepEqual(seen, ids);
  assert.deepEqual((await f.adapter.runs()).map(run => run.id), ids);
  assert.ok(f.requests.filter(request => request.route.startsWith('/run-list?')).length > 1);
  const server = await extension(t, f.adapter);
  const listed = await call(server, '/runs');
  assert.equal(listed.status, 200);
  assert.equal(listed.json.total, ids.length);
  const matching = await call(server, '/directories/match', { method: 'POST', body: { directories: [project.directory, last.worktreePath] } });
  assert.equal(matching.status, 200);
  assert.deepEqual(matching.json.matches, [{ projectId: project.id }, { projectId: project.id, runId: last.id }]);
  assert.deepEqual(snapshot(f.store), before);
  assert.equal(f.executorCalls(), 0);
});

test('insertion cursors remain stable when an earlier run resumes and new submissions wait for the next refresh', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const project = await f.registerProject('project');
  startSavedRun(f, project, 'earlier', { status: 'paused', state: { status: 'paused' } });
  const ids = ['earlier', 'second', 'third', 'fourth', 'fifth'];
  for (const id of ids.slice(1)) f.enqueue(project, id);
  const first = await f.client.request('GET', '/run-list?limit=2');
  assert.deepEqual(first.runs.map(run => run.id), ids.slice(0, 2));
  assert.notEqual(first.nextCursor, null);
  const resumed = f.store.queueResume('earlier', 'Continue with the recorded resolution');
  assert.equal(resumed.status, 'queued');
  f.enqueue(project, 'new-submission');
  const seen = first.runs.map(run => run.id);
  let after = first.nextCursor;
  while (after !== null) {
    const page = await f.client.request('GET', `/run-list?after=${after}&through=${first.through}&limit=2`);
    assert.equal(page.total, ids.length);
    assert.equal(page.through, first.through);
    seen.push(...page.runs.map(run => run.id));
    after = page.nextCursor;
  }
  assert.deepEqual(seen, ids, 'resume admission order does not duplicate an already-listed record');
  assert.deepEqual((await f.adapter.runs()).map(run => run.id), [...ids, 'new-submission']);
  assert.equal(f.executorCalls(), 0);
});

test('compact summaries match full detail summaries for every status and malformed indexed task fields', { timeout: 30000 }, async t => {
  const f = await fixture(t, 20);
  const project = await f.registerProject('project');
  for (const status of ['running', 'paused', 'succeeded', 'failed', 'reconciliation-required']) {
    startSavedRun(f, project, status, { status, state: { status: status === 'succeeded' ? 'completed' : 'paused' } });
  }
  startSavedRun(f, project, 'planning', { status: 'running', state: { phase: 'planner', tasks: [], results: [], index: 0 } });
  startSavedRun(f, project, 'missing-task-fields', { status: 'running', state: { index: 0, tasks: [{ brief: 'private' }], results: [] } });
  startSavedRun(f, project, 'malformed-task-fields', { status: 'running', state: { index: 0, tasks: [{ id: 42, title: { private: 'PRIVATE-TITLE' } }], results: [] } });
  startSavedRun(f, project, 'scalar-task', { status: 'running', state: { index: 0, tasks: ['not an object'], results: [] } });
  startSavedRun(f, project, 'noninteger-task-index', { status: 'running', state: { index: 0.5, tasks: [{ id: 'T1', title: 'Task' }], results: [] } });
  startSavedRun(f, project, 'oversized-phase', { status: 'running', state: { phase: 'unknown'.repeat(180000), results: [] } });
  startSavedRun(f, project, 'nul-fields', {
    status: 'running', feature: '# NUL task fields\n\nPrivate body',
    state: { index: 0, tasks: [{ id: 'T\0suffix', title: 'Task\0suffix', brief: 'private' }], results: [] },
  });
  f.enqueue(project, 'preparing');
  assert.equal(f.store.admitNext().id, 'preparing');
  f.enqueue(project, 'queued');
  const nulFeature = 'First\0line\n# Heading after NUL\n\nPrivate body';
  f.enqueue(project, 'nul-feature', nulFeature);
  const before = snapshot(f.store);
  const compact = await f.adapter.runs();
  for (const run of compact) {
    const full = await f.client.request('GET', `/runs/${run.id}`);
    // Some Node SQLite versions truncate text columns at NUL; the list's bounded byte projection preserves the input.
    const expected = run.id === 'nul-feature' ? { ...full, feature: nulFeature } : full;
    assert.deepEqual(summarizeRun(run, project), summarizeRun(expected, project), run.id);
  }
  assert.deepEqual(snapshot(f.store), before);
  assert.equal(f.executorCalls(), 0);
});

test('run-list queries reject invalid cursors, invalid limits and non-administrator access without changing state', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const project = await f.registerProject('project');
  const active = startSavedRun(f, project, 'active', { status: 'running' });
  const before = snapshot(f.store);
  for (const query of [
    'after=-1', 'after=1.5', 'after=01', 'after=abc', 'after=9007199254740992', 'after=0&after=1',
    'through=-1', 'through=1.5', 'through=9007199254740992', 'through=1&through=2',
    'limit=0', `limit=${RUN_LIST_PAGE_SIZE + 1}`, 'limit=1.5', 'limit=01', 'limit=1&limit=2',
  ]) {
    await assert.rejects(f.client.request('GET', `/run-list?${query}`), error => error.statusCode === 400, query);
  }
  for (const token of ['wrong-token', active.ownerToken]) {
    await assert.rejects(createCoordinatorClient(f.configuration.endpoint, token).request('GET', '/run-list'), error => error.statusCode === 401);
  }
  const empty = await f.client.request('GET', '/run-list?after=0&through=0&limit=1');
  assert.deepEqual(empty, { runs: [], total: 0, nextCursor: null, through: 0 });
  assert.deepEqual(snapshot(f.store), before);
  assert.equal(f.executorCalls(), 0);
});

test('list entries and run details carry the same bounded wait summary and the same pause identity', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const project = await f.registerProject('project');
  const long = 'Blocked: choose é between the options.\n' + 'é'.repeat(30000) + ' END-OF-BLOCKER';
  const specimens = {
    short: 'Need the owner to pick the database',
    long,
    empty: undefined,
    quotes: 'Line one\n"quoted" and --option-like text',
  };
  for (const [name, reason] of Object.entries(specimens)) {
    startSavedRun(f, project, `paused-${name}`, { status: 'paused', state: { status: 'paused', ...(reason === undefined ? {} : { reason }) } });
  }
  startSavedRun(f, project, 'running-run', { status: 'running' });
  startSavedRun(f, project, 'done-run', { status: 'succeeded', state: { status: 'completed' } });
  // A paused run whose checkpoint is not a paused checkpoint is not offered a guarded response.
  startSavedRun(f, project, 'odd-run', { status: 'paused', state: { status: 'running' } });

  const page = await f.client.request('GET', '/run-list');
  const byId = Object.fromEntries(page.runs.map(run => [run.id, run]));
  const detail = Object.fromEntries((await f.client.request('GET', '/runs')).map(run => [run.id, run]));
  for (const name of Object.keys(specimens)) {
    const entry = byId[`paused-${name}`].wait;
    assert.equal(entry.kind, 'generic', name);
    assert.match(entry.pauseId, /^pau_[0-9a-f]{32}$/);
    assert.deepEqual(entry, detail[`paused-${name}`].wait, `${name}: the list entry and the run detail agree exactly`);
    assert.ok(entry.reason.length <= 1500, name);
  }
  assert.equal(byId['paused-short'].wait.reason, specimens.short);
  assert.equal(byId['paused-short'].wait.reasonClipped, false);
  assert.equal(byId['paused-long'].wait.reasonClipped, true);
  assert.equal(byId['paused-long'].wait.reason.length, 1500);
  assert.ok(!JSON.stringify(page).includes('END-OF-BLOCKER'));
  assert.equal(byId['paused-empty'].wait.reason, '');
  assert.equal(byId['paused-quotes'].wait.reason, specimens.quotes);
  const identities = new Set(['short', 'long', 'empty', 'quotes'].map(name => byId[`paused-${name}`].wait.pauseId));
  assert.equal(identities.size, 4, 'each pause has its own identity');
  for (const id of ['running-run', 'done-run', 'odd-run']) {
    assert.equal(byId[id].wait, null, id);
    assert.equal(detail[id].wait, null, id);
  }
  // The identity is stable between reads and changes when the blocker changes.
  const again = await f.client.request('GET', '/run-list');
  assert.equal(again.runs.find(run => run.id === 'paused-long').wait.pauseId, byId['paused-long'].wait.pauseId);
});

test('a run list entry summarises a typed approval request by identity and state, and the page stays bounded', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const project = await f.registerProject('project');
  startSavedRun(f, project, 'asking', { status: 'paused', state: { status: 'paused', reason: 'Approval required for T2: ship?' } });
  const db = new DatabaseSync(path.join(f.configuration.stateDirectory, 'coordinator.sqlite'));
  t.after(() => { if (db.isOpen) db.close(); });
  const insert = (requestId, state, continuation) => db.prepare(`INSERT INTO approval_requests(run_id, request_id, phase, task_index, task_id, attempt_id, receipt_digest, request_json, revision_json, state, decision, feedback, response_json, answered_at, continuation, created_at)
    VALUES ('asking', ?, 'executor', 1, 'T2', ?, 'digest', '{"question":"q","scope":"s","completedWork":"w","verification":["v"],"artifacts":["a"],"onApprove":["x"],"onRequestChanges":["y"]}', '{"head":"h","digest":"d"}', ?, ?, ?, ?, ?, ?, 1)`)
    .run(requestId, 'attempt_' + requestId, state, state === 'answered' ? 'approve' : null, null, state === 'answered' ? '{}' : null, state === 'answered' ? 1 : null, continuation);
  insert('apr_one', 'pending', 'none');
  const page = await f.client.request('GET', '/run-list');
  assert.deepEqual(page.runs[0].wait, { kind: 'approval', requestId: 'apr_one', state: 'pending', continuation: 'none', taskId: 'T2' });
  assert.deepEqual((await f.client.request('GET', '/runs/asking')).wait.requestId, 'apr_one');
  // A consumed decision is history: the run's wait falls back to what it is now waiting for.
  db.prepare("UPDATE approval_requests SET state = 'answered', decision = 'approve', response_json = '{}', answered_at = 2, continuation = 'consumed' WHERE request_id = 'apr_one'").run();
  const history = await f.client.request('GET', '/run-list');
  assert.equal(history.runs[0].wait.kind, 'generic');
  assert.equal((await f.client.request('GET', '/runs/asking')).wait.kind, 'generic');
  assert.ok(Buffer.byteLength(JSON.stringify(history)) <= RUN_LIST_MAX_BYTES);
});
