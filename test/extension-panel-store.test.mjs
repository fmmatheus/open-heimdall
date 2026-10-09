import test from 'node:test';
import assert from 'node:assert/strict';
import { HostRequestError } from '@openchamber/sdk';
import { createPanelStore, backoffDelay } from '../dist/extension/panel/store.js';
import { createPanelClient, isAllowedPath, mapHostFailure } from '../dist/extension/panel/client.js';

const SECRET = 'RAW-SECRET /Users/someone/.local/state/heimdall/coordinator.key Bearer abc123';
const GENERATION = 'aaaaaaaaaaaa';
const POLL = 3000;

const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise(resolve => setImmediate(resolve)); };

function fakeClock() {
  let time = 1_000_000;
  let next = 0;
  const pending = new Map();
  return {
    now: () => time,
    setTimeout(callback, ms) { const handle = ++next; pending.set(handle, { at: time + ms, callback }); return handle; },
    clearTimeout(handle) { pending.delete(handle); },
    pending: () => pending.size,
    async advance(ms) {
      const end = time + ms;
      for (;;) {
        await flush();
        const due = [...pending.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (!due) break;
        pending.delete(due[0]);
        time = Math.max(time, due[1].at);
        due[1].callback();
      }
      time = end;
      await flush();
    },
  };
}

const project = (id, name = id) => ({ id, name, directory: `/work/${id}`, concurrency: 1, createdAt: 1 });
const summary = (id, projectId = 'proj_a', status = 'running', extra = {}) => ({
  id, label: `Label ${id}`, projectId, projectName: projectId, status, phase: 'executing', completed: 1, total: 3,
  currentTask: { id: 'T2', title: 'Second' }, createdAt: 1, updatedAt: 2, ...extra,
});
const detailOf = (id, marker = 'v1') => ({ ...summary(id), blocker: null, label: `Detail ${id} ${marker}`, tasks: [], truncated: false });

/** A fake guest service speaking the T3 wire protocol, behind a recording host. */
function fixture(options = {}) {
  const clock = fakeClock();
  const service = {
    generation: GENERATION,
    sequence: 0,
    log: [],
    projects: [project('proj_a'), project('proj_b')],
    runs: [summary('run_1'), summary('run_2', 'proj_b', 'queued')],
    details: { run_1: detailOf('run_1'), run_2: detailOf('run_2') },
    fail: null,
    respond: null,
    intercept: null,
    requests: [],
    change(ids, extra = {}) { this.sequence += 1; this.log.push({ sequence: this.sequence, ids }); Object.assign(this, extra); },
    restart() { this.generation = 'bbbbbbbbbbbb'; this.sequence = 0; this.log = []; },
  };
  const reply = (status, body) => ({ status, body: JSON.stringify(body) });
  const host = {
    async serviceRequest(request) {
      service.requests.push({ ...structuredClone(request), at: clock.now() });
      if (service.intercept) await service.intercept(request);
      if (service.fail) {
        const failure = typeof service.fail === 'function' ? service.fail(request) : service.fail;
        if (failure instanceof Error) throw failure;
        return failure;
      }
      if (service.respond) { const custom = service.respond(request); if (custom) return custom; }
      const query = request.query ?? {};
      if (request.path === '/changes') {
        const cursor = query.cursor;
        const current = `${service.generation}:${service.sequence}`;
        const match = cursor ? /^([0-9a-f]{12}):(\d+)$/.exec(cursor) : null;
        if (!match || match[1] !== service.generation) {
          return reply(200, { cursor: current, changedRunIds: [], projectsChanged: false, resync: true, more: false, fetchedAt: 'x' });
        }
        const since = Number(match[2]);
        const ids = [...new Set(service.log.filter(entry => entry.sequence > since).flatMap(entry => entry.ids))];
        return reply(200, { cursor: current, changedRunIds: ids, projectsChanged: false, resync: false, more: Boolean(service.more), fetchedAt: 'x' });
      }
      if (request.path === '/projects') return reply(200, { projects: service.projects, fetchedAt: 'x' });
      if (request.path === '/runs') {
        const runs = service.runs.filter(run => (!query.projectId || run.projectId === query.projectId) && (!query.status || run.status === query.status));
        return reply(200, { runs, total: runs.length, truncated: false, fetchedAt: 'x' });
      }
      const detail = /^\/runs\/([^/]+)$/.exec(request.path);
      if (detail) {
        const run = service.details[detail[1]];
        return run ? reply(200, { run, fetchedAt: 'x' }) : reply(404, { error: { kind: 'not-found', message: SECRET } });
      }
      return reply(404, { error: { kind: 'not-found', message: SECRET } });
    },
    async serviceStatus() { return { status: 'ready' }; },
  };
  const store = createPanelStore({ host, timers: clock, now: clock.now, pollIntervalMs: POLL, maxBackoffMs: 30000, ...options });
  const paths = (from = 0) => service.requests.slice(from).map(request => request.path + (request.query ? `?${new URLSearchParams(request.query)}` : ''));
  return { clock, service, host, store, paths };
}

const offlineReply = { status: 503, body: JSON.stringify({ error: { kind: 'coordinator-offline', message: SECRET } }) };

test('initial load takes the cursor first, then loads projects and runs', async () => {
  const { store, service, clock, paths } = fixture();
  assert.equal(store.getState().connection, 'connecting');
  store.start();
  store.start();
  await clock.advance(0);
  assert.deepEqual(paths(), ['/changes', '/projects', '/runs']);
  const state = store.getState();
  assert.equal(state.connection, 'online');
  assert.equal(state.message, null);
  assert.equal(state.stale, false);
  assert.equal(state.cursor, `${GENERATION}:0`);
  assert.deepEqual(state.projects.map(item => item.id), ['proj_a', 'proj_b']);
  assert.deepEqual(state.runs.map(item => item.id), ['run_1', 'run_2']);
  assert.equal(state.lastSuccessAt, clock.now());
  assert.equal(service.requests[0].query, undefined);
  store.dispose();
});

test('change feed polls every interval and refetches only what changed', async () => {
  const { store, service, clock, paths } = fixture();
  store.start();
  await clock.advance(0);
  let mark = service.requests.length;

  await clock.advance(POLL);
  assert.deepEqual(paths(mark), [`/changes?cursor=${GENERATION}%3A0`]);

  mark = service.requests.length;
  store.select('run_1');
  await clock.advance(0);
  assert.deepEqual(paths(mark), ['/runs/run_1']);
  assert.equal(store.getState().detail.id, 'run_1');

  mark = service.requests.length;
  service.change(['run_2']);
  service.runs = [summary('run_1'), summary('run_2', 'proj_b', 'running')];
  await clock.advance(POLL);
  assert.deepEqual(paths(mark), [`/changes?cursor=${GENERATION}%3A0`, '/runs']);
  assert.equal(store.getState().runs[1].status, 'running');
  assert.equal(store.getState().cursor, `${GENERATION}:1`);

  mark = service.requests.length;
  service.change(['run_1']);
  service.details.run_1 = detailOf('run_1', 'v2');
  await clock.advance(POLL);
  assert.deepEqual(paths(mark).sort(), [`/changes?cursor=${GENERATION}%3A1`, '/runs', '/runs/run_1'].sort());
  assert.equal(store.getState().detail.label, 'Detail run_1 v2');

  mark = service.requests.length;
  await clock.advance(POLL);
  assert.deepEqual(paths(mark), [`/changes?cursor=${GENERATION}%3A2`]);
  store.dispose();
});

test('more=true polls again soon', async () => {
  const { store, service, clock, paths } = fixture({ morePollMs: 250 });
  store.start();
  await clock.advance(0);
  service.more = true;
  await clock.advance(POLL);
  const mark = service.requests.length;
  await clock.advance(250);
  assert.equal(paths(mark)[0].startsWith('/changes?cursor='), true);
  store.dispose();
});

test('filters reload the run list with validated query values', async () => {
  const { store, service, clock, paths } = fixture();
  store.start();
  await clock.advance(0);
  let mark = service.requests.length;

  store.setFilters({ status: 'queued' });
  await clock.advance(0);
  assert.deepEqual(paths(mark), ['/runs?status=queued']);
  assert.deepEqual(store.getState().runs.map(item => item.id), ['run_2']);
  assert.deepEqual(store.getState().filters, { projectId: null, status: 'queued' });

  mark = service.requests.length;
  store.setFilters({ projectId: 'proj_b' });
  await clock.advance(0);
  assert.deepEqual(paths(mark), ['/runs?projectId=proj_b&status=queued']);

  mark = service.requests.length;
  store.setFilters({ projectId: 'proj_b' });
  store.setFilters({ status: 'bogus', projectId: '../etc' });
  await clock.advance(0);
  assert.deepEqual(store.getState().filters, { projectId: null, status: null });
  assert.deepEqual(paths(mark), ['/runs']);
  assert.deepEqual(store.getState().runs.map(item => item.id), ['run_1', 'run_2']);
  store.dispose();
});

test('a filter whose project disappeared falls back to all projects', async () => {
  const { store, service, clock, paths } = fixture();
  store.start();
  await clock.advance(0);
  const mark = service.requests.length;
  service.respond = request => (request.query?.projectId === 'proj_gone' ? { status: 404, body: JSON.stringify({ error: { kind: 'not-found', message: SECRET } }) } : null);
  store.setFilters({ projectId: 'proj_gone' });
  await clock.advance(0);
  assert.deepEqual(paths(mark), ['/runs?projectId=proj_gone', '/runs']);
  assert.equal(store.getState().filters.projectId, null);
  assert.equal(store.getState().connection, 'online');
  assert.equal(store.getState().message.includes('RAW-SECRET'), false);
  store.dispose();
});

test('service restart gives resync: lists and selected detail reload under the new cursor', async () => {
  const { store, service, clock, paths } = fixture();
  store.start();
  await clock.advance(0);
  store.select('run_1');
  await clock.advance(0);
  service.change(['run_1']);
  await clock.advance(POLL);
  assert.equal(store.getState().cursor, `${GENERATION}:1`);

  service.restart();
  service.runs = [summary('run_1', 'proj_a', 'succeeded')];
  service.details.run_1 = detailOf('run_1', 'after-restart');
  const mark = service.requests.length;
  await clock.advance(POLL);
  assert.deepEqual(paths(mark).sort(), [`/changes?cursor=${GENERATION}%3A1`, '/projects', '/runs', '/runs/run_1'].sort());
  const state = store.getState();
  assert.equal(state.cursor, 'bbbbbbbbbbbb:0');
  assert.equal(state.runs[0].status, 'succeeded');
  assert.equal(state.detail.label, 'Detail run_1 after-restart');
  assert.equal(state.connection, 'online');
  store.dispose();
});

test('offline keeps the last data marked stale with a fixed message, then recovers', async () => {
  const { store, service, clock } = fixture();
  store.start();
  await clock.advance(0);
  store.select('run_1');
  await clock.advance(0);
  const before = store.getState();

  service.fail = offlineReply;
  await clock.advance(POLL);
  let state = store.getState();
  assert.equal(state.connection, 'offline');
  assert.equal(state.stale, true);
  assert.equal(state.message, 'The Heimdall coordinator is not running.');
  assert.match(state.hint, /heimdall coordinator serve/);
  assert.equal(JSON.stringify(state).includes('RAW-SECRET'), false);
  assert.deepEqual(state.runs, before.runs);
  assert.deepEqual(state.projects, before.projects);
  assert.deepEqual(state.detail, before.detail);
  assert.equal(state.lastSuccessAt, before.lastSuccessAt);

  service.fail = null;
  service.change(['run_2']);
  await clock.advance(POLL * 2);
  state = store.getState();
  assert.equal(state.connection, 'online');
  assert.equal(state.stale, false);
  assert.equal(state.message, null);
  assert.equal(state.hint, null);
  assert.equal(state.failures, 0);
  assert.equal(state.lastSuccessAt > before.lastSuccessAt, true);
  store.dispose();
});

test('backoff doubles to the cap while offline, retry is immediate, and success resets it', async () => {
  const { store, service, clock } = fixture();
  store.start();
  await clock.advance(0);
  service.fail = offlineReply;
  const mark = service.requests.length;
  await clock.advance(POLL);
  await clock.advance(150000);
  const times = service.requests.slice(mark).map(request => request.at);
  const gaps = times.slice(1).map((at, index) => at - times[index]);
  assert.deepEqual(gaps.slice(0, 6), [3000, 6000, 12000, 24000, 30000, 30000]);
  assert.equal(store.getState().failures >= 6, true);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 9].map(n => backoffDelay(n, 3000, 30000)), [3000, 3000, 6000, 12000, 24000, 30000, 30000]);

  // Manual retry runs now, without waiting for the long timer.
  const retryMark = service.requests.length;
  service.fail = null;
  store.retry();
  await clock.advance(0);
  assert.equal(service.requests.length > retryMark, true);
  assert.equal(store.getState().connection, 'online');
  assert.equal(store.getState().failures, 0);

  // A new failure starts again from the base delay.
  service.fail = offlineReply;
  await clock.advance(POLL);
  const failMark = service.requests.length;
  await clock.advance(POLL);
  assert.equal(service.requests.length, failMark + 1);
  await clock.advance(POLL * 2);
  const after = service.requests.slice(failMark - 1).map(request => request.at);
  assert.deepEqual([after[1] - after[0], after[2] - after[1]], [3000, 6000]);
  store.dispose();
});

test('data older than two poll intervals becomes stale even before a failure', async () => {
  const { store, service, clock } = fixture();
  store.start();
  await clock.advance(0);
  service.intercept = () => new Promise(() => {}); // the next poll hangs
  await clock.advance(POLL);
  assert.equal(store.getState().stale, false);
  await clock.advance(POLL + 10);
  assert.equal(store.getState().stale, true);
  assert.equal(store.getState().connection, 'online');
  store.dispose();
});

test('superseded filter responses are ignored', async () => {
  const { store, service, clock } = fixture();
  store.start();
  await clock.advance(0);
  const releases = [];
  service.intercept = request => (request.path === '/runs'
    ? new Promise(resolve => { releases.push(resolve); })
    : undefined);
  store.setFilters({ status: 'running' }); // request 0
  store.setFilters({ status: 'queued' }); // request 1
  await clock.advance(0);
  assert.equal(releases.length, 2);
  releases[1](); // newer answers first
  await clock.advance(0);
  assert.deepEqual(store.getState().runs.map(item => item.id), ['run_2']);
  releases[0](); // the older one arrives last and must not win
  await clock.advance(0);
  assert.deepEqual(store.getState().runs.map(item => item.id), ['run_2']);
  assert.equal(store.getState().filters.status, 'queued');
  store.dispose();
});

test('superseded detail responses and failures are ignored', async () => {
  const { store, service, clock } = fixture();
  store.start();
  await clock.advance(0);
  const releases = {};
  service.intercept = request => (request.path.startsWith('/runs/') ? new Promise(resolve => { releases[request.path] = resolve; }) : undefined);
  store.select('run_1');
  store.select('run_2');
  await clock.advance(0);
  releases['/runs/run_2']();
  await clock.advance(0);
  assert.equal(store.getState().detail.id, 'run_2');
  service.fail = offlineReply; // a late failure of the old request must not flip the connection
  releases['/runs/run_1']();
  await clock.advance(0);
  assert.equal(store.getState().detail.id, 'run_2');
  assert.equal(store.getState().connection, 'online');
  store.dispose();
});

test('retry supersedes an in-flight poll so its late result is dropped', async () => {
  const { store, service, clock } = fixture();
  store.start();
  await clock.advance(0);
  let release;
  service.intercept = () => new Promise(resolve => { release = resolve; });
  await clock.advance(POLL); // poll hangs
  service.intercept = null;
  service.change(['run_2']);
  service.runs = [summary('run_1'), summary('run_2', 'proj_b', 'failed')];
  store.retry();
  await clock.advance(0);
  assert.equal(store.getState().runs[1].status, 'failed');
  assert.equal(store.getState().cursor, `${GENERATION}:1`);
  service.runs = [summary('run_1'), summary('run_2', 'proj_b', 'queued')];
  release(); // old cycle finishes later with an older view
  await clock.advance(0);
  assert.equal(store.getState().runs[1].status, 'failed');
  assert.equal(store.getState().cursor, `${GENERATION}:1`);
  store.dispose();
});

test('host and service failures map to fixed messages and never relay raw text', async () => {
  const hostCases = [
    ['NO_SERVICE', 'service-unavailable', /not installed or not built/, /Settings → Extensions/],
    ['SERVICE_FAILED', 'service-unavailable', /failed to start or stopped/, /Settings → Extensions/],
    ['REQUEST_FAILED', 'service-unavailable', /could not complete the request/, /Settings → Extensions/],
    ['DISABLED', 'service-unavailable', /is disabled/, /Enable Heimdall in Settings → Extensions/],
    ['NOT_GRANTED', 'service-unavailable', /has not been allowed to run/, /Allow the local service in Settings → Extensions/],
    ['HOST_TIMEOUT', 'offline', /did not answer in time/, /retry automatically/],
    ['HOST_UNAVAILABLE', 'offline', /could not be reached/, /retry automatically/],
    ['SOMETHING_NEW', 'offline', /request failed/, /retry automatically/],
  ];
  for (const [code, connection, message, hint] of hostCases) {
    const { store, service, clock } = fixture();
    service.fail = new HostRequestError(code === 'SOMETHING_NEW' ? 'HOST_REJECTED' : code, SECRET);
    if (code === 'SOMETHING_NEW') service.fail = Object.assign(new Error(SECRET), { code });
    store.start();
    await clock.advance(0);
    const state = store.getState();
    assert.equal(state.connection, connection, code);
    assert.match(state.message, message, code);
    assert.match(state.hint, hint, code);
    assert.equal(JSON.stringify(state).includes('RAW-SECRET'), false, code);
    assert.equal(state.stale, false); // nothing was ever shown
    assert.equal(state.nextAttemptAt, clock.now() + POLL);
    store.dispose();
  }
  assert.equal(mapHostFailure(new HostRequestError('NO_SERVICE', SECRET)).message.includes('RAW'), false);
  assert.equal(mapHostFailure('weird').code, 'UNKNOWN');
  assert.equal(mapHostFailure(null).category, 'offline');

  const serviceCases = [
    ['coordinator-offline', 'offline', /coordinator is not running/, /heimdall coordinator serve/],
    ['coordinator-unauthorized', 'offline', /refused the service credentials/, /heimdall coordinator serve/],
    ['coordinator-timeout', 'offline', /did not answer in time/, /retry automatically/],
    ['configuration-invalid', 'service-unavailable', /configuration is not valid/, /coordinator\.toml/],
    ['coordinator-error', 'offline', /reported an error/, /retry automatically/],
    ['made-up-kind', 'service-unavailable', /unexpected error/, /Settings → Extensions/],
  ];
  for (const [kind, connection, message, hint] of serviceCases) {
    const { store, service, clock } = fixture();
    service.fail = { status: 503, body: JSON.stringify({ error: { kind, message: SECRET } }) };
    store.start();
    await clock.advance(0);
    const state = store.getState();
    assert.equal(state.connection, connection, kind);
    assert.match(state.message, message, kind);
    assert.match(state.hint, hint, kind);
    assert.equal(JSON.stringify(state).includes('RAW-SECRET'), false, kind);
    store.dispose();
  }

  for (const [status, body] of [[200, SECRET], [200, '<html>RAW-SECRET</html>'], [200, '[]'], [200, JSON.stringify({ unexpected: SECRET })], [500, SECRET], [401, JSON.stringify({ error: SECRET })], [502, '']]) {
    const { store, service, clock } = fixture();
    service.fail = { status, body };
    store.start();
    await clock.advance(0);
    const state = store.getState();
    assert.equal(state.connection, 'service-unavailable', `${status} ${body}`);
    assert.equal(JSON.stringify(state).includes('RAW-SECRET'), false);
    assert.equal(typeof state.message, 'string');
    store.dispose();
  }
});

test('an unknown selected run shows a request error without breaking the connection', async () => {
  const { store, clock } = fixture();
  store.start();
  await clock.advance(0);
  store.select('run_missing');
  await clock.advance(0);
  const state = store.getState();
  assert.equal(state.connection, 'online');
  assert.equal(state.detail, null);
  assert.equal(state.detailError, 'That Heimdall item no longer exists.');
  store.select('../x');
  assert.equal(store.getState().selectedRunId, 'run_missing');
  store.dispose();
});

test('subscribers get state updates until they unsubscribe', async () => {
  const { store, clock } = fixture();
  const seen = [];
  const unsubscribe = store.subscribe(state => seen.push(state.connection));
  store.start();
  await clock.advance(0);
  assert.equal(seen.at(-1), 'online');
  const count = seen.length;
  unsubscribe();
  store.setFilters({ status: 'queued' });
  await clock.advance(0);
  assert.equal(seen.length, count);
  store.dispose();
});

test('dispose stops timers and ignores in-flight responses', async () => {
  const { store, service, clock } = fixture();
  const seen = [];
  store.subscribe(state => seen.push(state));
  store.start();
  await clock.advance(0);
  assert.equal(clock.pending() > 0, true);
  let release;
  service.intercept = () => new Promise(resolve => { release = resolve; });
  await clock.advance(POLL);
  const frozen = store.getState();
  const count = seen.length;
  store.dispose();
  assert.equal(clock.pending(), 0);
  release();
  service.intercept = null;
  const requests = service.requests.length;
  await clock.advance(POLL * 20);
  assert.equal(service.requests.length, requests);
  assert.equal(seen.length, count);
  assert.equal(store.getState(), frozen);
  store.start();
  store.retry();
  store.setFilters({ status: 'queued' });
  store.select('run_1');
  await clock.advance(POLL);
  assert.equal(service.requests.length, requests);
  assert.equal(clock.pending(), 0);
});

test('the client only requests allowlisted GET service paths', async () => {
  const { store, service, clock } = fixture();
  store.start();
  await clock.advance(0);
  store.select('run_1');
  store.setFilters({ status: 'running', projectId: 'proj_a' });
  await clock.advance(0);
  service.change(['run_1']);
  await clock.advance(POLL);
  service.restart();
  await clock.advance(POLL);
  service.fail = offlineReply;
  await clock.advance(POLL * 3);
  service.fail = new HostRequestError('NO_SERVICE', SECRET);
  await clock.advance(POLL * 10);
  service.fail = null;
  store.retry();
  await clock.advance(POLL);
  store.dispose();

  assert.equal(service.requests.length > 10, true);
  const queryKeys = new Set(['projectId', 'status', 'cursor']);
  for (const request of service.requests) {
    assert.equal(request.method, 'GET');
    assert.equal(isAllowedPath(request.path), true, request.path);
    assert.equal(Object.hasOwn(request, 'body'), false);
    for (const key of Object.keys(request.query ?? {})) assert.equal(queryKeys.has(key), true, key);
  }
  assert.deepEqual([...new Set(service.requests.map(request => request.path.replace(/^\/runs\/.+/, '/runs/:id')))].sort(), ['/changes', '/projects', '/runs', '/runs/:id']);

  for (const path of ['/runs/../x', '/runs/a/b', '/runs/', '/runs/%2e%2e', '/runs/a?b=1', '/health', '/status', '/directories/match', '/runs/run_1/review/', '/runs/run_1/review/file/x', '/runs/run_1/review/other', '/runs/run_1/reviews', '/runs/run_1/reconcile', '/runs/run_1/resume', '/events', '/projects/x', '']) {
    assert.equal(isAllowedPath(path), false, path);
  }
  for (const path of ['/projects', '/runs', '/changes', '/runs/run_1', '/runs/A-b_9', '/runs/run_1/review', '/runs/run_1/review/file']) assert.equal(isAllowedPath(path), true, path);
});

test('the client refuses malformed ids before touching the host', async () => {
  const requests = [];
  const client = createPanelClient({
    async serviceRequest(request) { requests.push(request); return { status: 200, body: '{}' }; },
    async serviceStatus() { return { status: 'bogus' }; },
  });
  for (const id of ['', '../x', 'a/b', 'a'.repeat(129), '%2e%2e', ' run']) {
    await assert.rejects(client.run(id), error => error.name === 'PanelError' && error.category === 'request');
  }
  assert.equal(requests.length, 0);
  assert.equal(await client.serviceStatus(), 'unknown');
  const filtered = [];
  const filteredClient = createPanelClient({
    async serviceRequest(request) { filtered.push(request); return { status: 200, body: JSON.stringify({ runs: [], total: 0, truncated: false, fetchedAt: 'x' }) }; },
    async serviceStatus() { return { status: 'ready' }; },
  });
  await filteredClient.runs({ projectId: '../x', status: 'nope' });
  assert.deepEqual(filtered, [{ method: 'GET', path: '/runs' }]);
});
