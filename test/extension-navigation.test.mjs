import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createPanelClient, isAllowedPostPath } from '../dist/extension/panel/client.js';
import { createNavigation, sessionTargets } from '../dist/extension/panel/navigation.js';
import { createExtensionServer, listenExtensionServer } from '../dist/extension/service/server.js';

const SERVICE_TOKEN = 'svc-' + 'a1b2c3d4'.repeat(8);
const SECRET = 'RAW-SECRET-/Users/x/stack';
const FORBIDDEN = ['startSession', 'prompt', 'compose', 'attach', 'sessionLink', 'writeFile', 'generate', 'openSurface', 'openUrl'];
const ALLOWED_HOST_CALLS = ['listProjects', 'listSessions', 'openSession', 'writeClipboard'];

/* ---------- fixtures ---------- */

async function directories(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hd-nav-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const project = path.join(base, 'real', 'alpha-app');
  const decoy = path.join(base, 'other', 'alpha-app');
  const alias = path.join(base, 'alias-to-alpha');
  const worktree = path.join(base, 'state', 'worktrees', 'proj_a', 'run_1', 'checkout');
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(decoy, { recursive: true });
  await fs.mkdir(worktree, { recursive: true });
  await fs.writeFile(path.join(project, 'secret.txt'), 'FILE-CONTENT-MARKER');
  await fs.symlink(project, alias);
  return { base, project, decoy, alias, worktree };
}

/** Read-only coordinator adapter; every call is recorded. */
function makeAdapter(dirs, { projectId = 'proj_a' } = {}) {
  const calls = [];
  return {
    calls,
    async projects() { calls.push('projects'); return [{ id: projectId, directory: dirs.project, commonGitDirectory: path.join(dirs.project, '.git'), configPath: '', concurrency: 1, createdAt: 1 }]; },
    async runs() { calls.push('runs'); return [{ id: 'run_1', projectId, worktreePath: dirs.worktree, status: 'running' }]; },
    async run() { calls.push('run'); throw new Error('not used'); },
    async events() { calls.push('events'); return []; },
  };
}

async function serve(t, adapter) {
  const server = await listenExtensionServer(createExtensionServer({ token: SERVICE_TOKEN, adapter }), 0);
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return server;
}

function call(server, { method = 'GET', path: target, body, token = SERVICE_TOKEN }) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port: server.address().port, method, path: target,
      headers: token === null ? {} : { Authorization: `Bearer ${token}` },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: response.statusCode, text, json });
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

const match = (server, directoriesList) => call(server, { method: 'POST', path: '/directories/match', body: JSON.stringify({ directories: directoriesList }) });

/** A panel host that forwards service requests to the real extension server and records each one. */
function bridge(server) {
  const requests = [];
  return {
    requests,
    async serviceRequest(request) {
      requests.push(request);
      const query = request.query && Object.keys(request.query).length > 0 ? `?${new URLSearchParams(request.query)}` : '';
      const result = await call(server, { method: request.method, path: request.path + query, body: request.body });
      return { status: result.status, body: result.text };
    },
    async serviceStatus() { return { status: 'ready' }; },
  };
}

/** Recording OpenChamber host: forbidden methods throw (and are recorded) if anything touches them. */
function fakeOpenChamber({ projects, sessions = {}, projectsState = 'ready' } = {}) {
  const calls = [];
  const state = { projectsState, sessionsState: {}, failures: {} };
  const host = {
    calls,
    state,
    async listProjects() {
      calls.push(['listProjects']);
      if (state.failures.listProjects) throw state.failures.listProjects;
      return { kind: 'projects', state: state.projectsState, projects };
    },
    async listSessions(projectId) {
      calls.push(['listSessions', projectId]);
      if (state.failures.listSessions) throw state.failures.listSessions;
      return { kind: 'sessions', projectId, state: state.sessionsState[projectId] ?? 'ready', coverage: [], sessions: (sessions[projectId] ?? []).map(id => ({ id, title: 't' })) };
    },
    async openSession(id) {
      calls.push(['openSession', id]);
      if (state.failures.openSession) throw state.failures.openSession;
    },
    async writeClipboard(text) {
      calls.push(['writeClipboard', text]);
      if (state.failures.writeClipboard) throw state.failures.writeClipboard;
    },
  };
  for (const name of FORBIDDEN) {
    host[name] = () => { calls.push([`FORBIDDEN:${name}`]); throw new Error(`${name} must never be called`); };
  }
  return host;
}

const hostError = (code, message = SECRET) => Object.assign(new Error(message), { code });

function detail(overrides = {}) {
  return {
    id: 'run_1', label: 'Add billing', projectId: 'proj_a', projectName: 'alpha-app', status: 'running', phase: 'executing',
    completed: 2, total: 4, currentTask: { id: 'T3', title: 'Wire billing' }, createdAt: 1, updatedAt: 2,
    blocker: null, models: {}, usage: {}, limits: {},
    tasks: [{ id: 'T1', title: 'Schema' }, { id: 'T2', title: 'Service' }, { id: 'T3', title: 'Wire billing' }],
    sessions: { parent: 'ses_parent', current: 'ses_t3', completed: [{ id: 'ses_t1', taskId: 'T1' }, { id: 'ses_t2', taskId: 'T2' }] },
    review: { baseCommit: 'abc', branch: 'b' }, truncated: false,
    ...overrides,
  };
}

const heimdallProject = dirs => ({ id: 'proj_a', name: 'alpha-app', directory: dirs.project });
const ALL_IDS = ['ses_parent', 'ses_t3', 'ses_t1', 'ses_t2'];

async function stack(t, { projects, sessions, projectsState } = {}) {
  const dirs = await directories(t);
  const adapter = makeAdapter(dirs);
  const server = await serve(t, adapter);
  const panelHost = bridge(server);
  const oc = fakeOpenChamber({ projects: projects?.(dirs) ?? [], sessions: sessions ?? {}, projectsState });
  const navigation = createNavigation({ host: oc, matcher: createPanelClient(panelHost) });
  return { dirs, adapter, server, panelHost, oc, navigation };
}

function assertNoForbiddenAndReadOnly({ oc, adapter, panelHost }) {
  assert.deepEqual(oc.calls.filter(entry => entry[0].startsWith('FORBIDDEN')), [], 'forbidden host methods were called');
  for (const [name] of oc.calls) assert.ok(ALLOWED_HOST_CALLS.includes(name), name);
  for (const name of adapter.calls) assert.ok(['projects', 'runs'].includes(name), `coordinator call ${name}`);
  for (const request of panelHost.requests) {
    if (request.method === 'POST') assert.equal(request.path, '/directories/match');
    else assert.equal(request.method, 'GET');
  }
}

/* ---------- targets ---------- */

test('session targets: parent, current task while executing, completed tasks, each id once', () => {
  const targets = sessionTargets(detail());
  assert.deepEqual(targets.map(target => [target.key, target.kind, target.sessionId]), [
    ['parent', 'parent', 'ses_parent'],
    ['current', 'current', 'ses_t3'],
    ['completed:ses_t1', 'completed', 'ses_t1'],
    ['completed:ses_t2', 'completed', 'ses_t2'],
  ]);
  assert.equal(targets[1].label, 'Current task T3: Wire billing');
  assert.equal(targets[2].label, 'Completed T1: Schema');

  // The checkpoint child is the planner session while planning, and stale after a pause or finish.
  for (const phase of ['planning', 'paused', 'succeeded', 'failed', 'queued', 'preparing', 'reconciliation-required']) {
    assert.equal(sessionTargets(detail({ phase })).some(target => target.kind === 'current'), false, phase);
    assert.equal(sessionTargets(detail({ phase })).some(target => target.kind === 'planner'), phase === 'planning', phase);
  }
  const planning = sessionTargets(detail({ phase: 'planning', currentTask: null }));
  assert.deepEqual(planning.filter(target => target.kind === 'planner').map(target => [target.key, target.sessionId, target.buttonText]), [['planner', 'ses_t3', 'Open planner']]);
  // Planner sessions are never derived from anything but the current child (usage rows are ignored).
  const usageOnly = sessionTargets(detail({ phase: 'executing', sessions: { parent: null, current: null, completed: [] }, usage: { sessions: [{ id: 'ses_usage', role: 'planner' }] } }));
  assert.deepEqual(usageOnly, []);
  assert.deepEqual(sessionTargets(detail({ phase: 'planning', sessions: { parent: 'ses_parent', current: null, completed: [] } })).map(target => target.kind), ['parent']);
  assert.deepEqual(targets.map(target => [target.buttonText, target.taskId]), [
    ['Open parent', null], ['Open current task T3', 'T3'], ['Open T1: Schema', 'T1'], ['Open T2: Service', 'T2'],
  ]);
  // A session that is both current and completed (or the parent) is offered once.
  const duplicate = sessionTargets(detail({ sessions: { parent: 'ses_a', current: 'ses_a', completed: [{ id: 'ses_a', taskId: 'T1' }, { id: 'ses_a', taskId: 'T2' }] } }));
  assert.deepEqual(duplicate.map(target => target.sessionId), ['ses_a']);
  assert.deepEqual(sessionTargets(detail({ sessions: { parent: null, current: null, completed: [] } })), []);
  assert.equal(sessionTargets(detail({ sessions: { parent: null, current: null, completed: [{ id: 'ses_x', taskId: 'T9' }] } }))[0].label, 'Completed T9');
});

/* ---------- POST /directories/match ---------- */

test('directory match uses canonical identity and returns only ids', async t => {
  const dirs = await directories(t);
  const adapter = makeAdapter(dirs);
  const server = await serve(t, adapter);
  const missing = path.join(dirs.base, 'does', 'not', 'exist');

  const result = await match(server, [dirs.project, dirs.alias, `${dirs.alias}/`, path.join(dirs.alias, '..', 'alias-to-alpha'), dirs.decoy, dirs.worktree, missing, dirs.base]);
  assert.equal(result.status, 200);
  assert.deepEqual(result.json, {
    matches: [
      { projectId: 'proj_a' },
      { projectId: 'proj_a' },
      { projectId: 'proj_a' },
      { projectId: 'proj_a' },
      {},
      { projectId: 'proj_a', runId: 'run_1' },
      {},
      {},
    ],
  });
  // No paths, file names or file contents are echoed back.
  for (const forbidden of [dirs.base, 'alpha-app', 'secret.txt', 'FILE-CONTENT-MARKER', 'checkout']) assert.equal(result.text.includes(forbidden), false, forbidden);
  assert.deepEqual(Object.keys(result.json), ['matches']);
  assert.ok(adapter.calls.every(name => name === 'projects' || name === 'runs'));

  assert.deepEqual((await match(server, [])).json, { matches: [] });
});

test('directory match rejects relative, NUL, oversized and malformed input with 400', async t => {
  const dirs = await directories(t);
  const adapter = makeAdapter(dirs);
  const server = await serve(t, adapter);
  const good = dirs.project;
  const rejected = [
    ['relative', [good, 'alpha-app']],
    ['dot relative', ['./alpha-app']],
    ['empty string', ['']],
    ['NUL', [`${good}\0/x`]],
    ['entry too long', ['/' + 'a'.repeat(1024)]],
    ['too many', Array.from({ length: 201 }, () => good)],
    ['non-string', [good, 7]],
    ['null entry', [null]],
    ['object entry', [{ path: good }]],
  ];
  for (const [name, list] of rejected) {
    const result = await match(server, list);
    assert.equal(result.status, 400, name);
    assert.equal(result.json.error.kind, 'invalid-request', name);
    assert.equal(result.text.includes(good), false, `${name}: no path echoed`);
  }
  for (const [name, body] of [['not an array', { directories: good }], ['missing', {}], ['array body', [good]], ['null', null]]) {
    assert.equal((await call(server, { method: 'POST', path: '/directories/match', body: JSON.stringify(body) })).status, 400, name);
  }
  assert.equal((await call(server, { method: 'POST', path: '/directories/match', body: '{nope' })).status, 400);
  assert.equal((await call(server, { method: 'POST', path: '/directories/match', body: JSON.stringify({ directories: [good], pad: 'x'.repeat(300 * 1024) }) })).status, 413);
  assert.equal((await call(server, { method: 'POST', path: '/directories/match', body: JSON.stringify({ directories: [good], pad: 'x'.repeat(17 * 1024) }) })).status, 200, 'larger than the default cap is allowed here');

  // Exactly at the limits is accepted.
  assert.equal((await match(server, Array.from({ length: 200 }, () => good))).status, 200);
  assert.equal((await match(server, ['/' + 'a'.repeat(1023)])).status, 200);

  assert.equal((await call(server, { method: 'POST', path: '/directories/match', body: '{}', token: null })).status, 401);
  assert.equal((await call(server, { method: 'GET', path: '/directories/match' })).status, 405);
});

test('the rejected requests were refused before the coordinator was consulted', async t => {
  const dirs = await directories(t);
  const adapter = makeAdapter(dirs);
  const server = await serve(t, adapter);
  await match(server, ['relative']);
  await match(server, [`${dirs.project}\0`]);
  await match(server, Array.from({ length: 201 }, () => dirs.project));
  assert.deepEqual(adapter.calls, []);
});

test('the panel client sends match requests only to the match route and never invalid directories', async t => {
  const dirs = await directories(t);
  const server = await serve(t, makeAdapter(dirs));
  const panelHost = bridge(server);
  const client = createPanelClient(panelHost);
  assert.equal(isAllowedPostPath('/directories/match'), true);
  for (const other of ['/runs', '/runs/run_1/reconcile', '/runs/run_1/resume', '/projects', '/directories/match/', '/directories/match?x=1', '']) assert.equal(isAllowedPostPath(other), false, other);

  const result = await client.matchDirectories(['relative/path', dirs.alias, `${dirs.project}\0`, '/' + 'a'.repeat(1025), dirs.decoy]);
  assert.deepEqual(result, [{}, { projectId: 'proj_a' }, {}, {}, {}]);
  assert.equal(panelHost.requests.length, 1);
  assert.equal(panelHost.requests[0].method, 'POST');
  assert.deepEqual(JSON.parse(panelHost.requests[0].body), { directories: [dirs.alias, dirs.decoy] });

  assert.deepEqual(await client.matchDirectories([]), []);
  assert.deepEqual(await client.matchDirectories(['relative']), [{}]);
  assert.equal(panelHost.requests.length, 1, 'nothing sendable means no request');

  // More than 200 directories are split into batches the service accepts.
  const many = await client.matchDirectories(Array.from({ length: 450 }, (_, index) => (index % 2 === 0 ? dirs.alias : dirs.decoy)));
  assert.equal(many.length, 450);
  assert.equal(many.filter(entry => entry.projectId === 'proj_a').length, 225);
  assert.equal(panelHost.requests.length, 4);
});

test('a malformed match response is refused instead of trusted', async () => {
  const respond = body => createPanelClient({ serviceRequest: async () => ({ status: 200, body }), serviceStatus: async () => ({ status: 'ready' }) });
  await assert.rejects(respond(JSON.stringify({ matches: [] })).matchDirectories(['/a']), error => error.code === 'invalid-response');
  await assert.rejects(respond('<html>').matchDirectories(['/a']), error => error.code === 'invalid-response');
  const sanitized = await respond(JSON.stringify({ matches: [{ projectId: '../x', runId: 'run_1' }, { projectId: 'proj_a', runId: 'bad/id', path: '/etc' }] })).matchDirectories(['/a', '/b']);
  assert.deepEqual(sanitized, [{}, { projectId: 'proj_a' }]);
});

/* ---------- navigation states ---------- */

test('found: a symlinked OpenChamber directory maps to the Heimdall project and sessions open by native id', async t => {
  const s = await stack(t, {
    projects: dirs => [
      { id: 'oc_other', name: 'alpha-app', directory: dirs.decoy },
      { id: 'oc_alpha', name: 'alpha', directory: dirs.alias },
    ],
    sessions: { oc_alpha: ALL_IDS, oc_other: ALL_IDS },
  });
  const view = await s.navigation.load(detail(), heimdallProject(s.dirs));
  assert.equal(view.state, 'listed');
  assert.deepEqual(view.targets.map(entry => [entry.target.sessionId, entry.state, entry.enabled, entry.note]), ALL_IDS.map(id => [id, 'found', true, null]));
  assert.deepEqual(s.oc.calls.filter(entry => entry[0] === 'listSessions'), [['listSessions', 'oc_alpha']], 'sessions come from the matched project, not the same-name one');
  assert.equal(view.targets[0].actionLabel, 'Open Parent session');
  assert.equal(view.targets[1].actionLabel, 'Open Current task T3: Wire billing');

  assert.deepEqual(await s.navigation.open(view, 'parent'), { ok: true, message: null });
  assert.deepEqual(await s.navigation.open(view, 'current'), { ok: true, message: null });
  assert.deepEqual(await s.navigation.open(view, 'completed:ses_t1'), { ok: true, message: null });
  assert.deepEqual(s.oc.calls.filter(entry => entry[0] === 'openSession'), [['openSession', 'ses_parent'], ['openSession', 'ses_t3'], ['openSession', 'ses_t1']]);
  assertNoForbiddenAndReadOnly(s);
});

test('a registered managed worktree of this run also reaches its sessions', async t => {
  const s = await stack(t, { projects: dirs => [{ id: 'oc_wt', name: 'checkout', directory: dirs.worktree }], sessions: { oc_wt: ALL_IDS } });
  const view = await s.navigation.load(detail(), heimdallProject(s.dirs));
  assert.equal(view.state, 'listed');
  assert.equal(view.targets.every(entry => entry.state === 'found'), true);
  // The worktree of a different run is not this run's project.
  const other = await s.navigation.load(detail({ id: 'run_other' }), heimdallProject(s.dirs));
  assert.equal(other.state, 'project-not-added');
});

test('project-not-added: same name and equal ids do not count, and the guidance names the project', async t => {
  const s = await stack(t, {
    projects: dirs => [
      { id: 'proj_a', name: 'alpha-app', directory: dirs.decoy },
      { id: 'oc_x', name: 'alpha-app', directory: path.join(dirs.base, 'nowhere') },
    ],
    sessions: { proj_a: ALL_IDS },
  });
  const view = await s.navigation.load(detail(), heimdallProject(s.dirs));
  assert.equal(view.state, 'project-not-added');
  assert.equal(view.message, 'Sessions require this project in OpenChamber.');
  assert.equal(view.copyText, s.dirs.project);
  assert.equal(view.canRefresh, true);
  assert.equal(view.targets.length, 4);
  assert.equal(view.targets.every(entry => entry.state === 'project-not-added' && !entry.enabled), true);
  assert.deepEqual(s.oc.calls.filter(entry => entry[0] === 'listSessions'), [], 'no sessions are listed for a project that was not matched');
  assert.deepEqual(await s.navigation.open(view, 'parent'), { ok: false, message: 'That session is not available to open yet.' });
  assert.deepEqual(s.oc.calls.filter(entry => entry[0] === 'openSession'), []);
  assertNoForbiddenAndReadOnly(s);

  // No projects at all is the same guidance, and a missing directory simply omits the copyable text.
  s.oc.state.projectsState = 'ready';
  const empty = await createNavigation({ host: fakeOpenChamber({ projects: [] }), matcher: createPanelClient(s.panelHost) }).load(detail(), { id: 'proj_a', name: 'alpha-app', directory: null });
  assert.equal(empty.state, 'project-not-added');
  assert.equal(empty.copyText, null);
});

test('discovering: projects or sessions still loading', async t => {
  const loadingProjects = await stack(t, { projects: () => [], projectsState: 'loading' });
  const first = await loadingProjects.navigation.load(detail(), heimdallProject(loadingProjects.dirs));
  assert.equal(first.state, 'discovering');
  assert.equal(first.targets.every(entry => entry.state === 'discovering' && !entry.enabled), true);
  assert.match(first.message, /still loading/);

  const loadingSessions = await stack(t, { projects: dirs => [{ id: 'oc_alpha', name: 'alpha', directory: dirs.alias }], sessions: { oc_alpha: ALL_IDS } });
  loadingSessions.oc.state.sessionsState.oc_alpha = 'loading';
  const second = await loadingSessions.navigation.load(detail(), heimdallProject(loadingSessions.dirs));
  assert.equal(second.state, 'discovering');
  assert.equal(second.targets.every(entry => !entry.enabled), true, 'a loading snapshot never enables a session');
  assertNoForbiddenAndReadOnly(loadingSessions);

  // Refresh just lists again and picks up the finished load.
  loadingSessions.oc.state.sessionsState.oc_alpha = 'ready';
  const refreshed = await loadingSessions.navigation.load(detail(), heimdallProject(loadingSessions.dirs));
  assert.equal(refreshed.state, 'listed');
  assert.equal(refreshed.targets.every(entry => entry.enabled), true);
  assert.equal(loadingSessions.oc.calls.filter(entry => entry[0] === 'openSession').length, 0);
});

test('discovery-failed: an error snapshot explains and offers refresh', async t => {
  const s = await stack(t, { projects: dirs => [{ id: 'oc_alpha', name: 'alpha', directory: dirs.alias }], sessions: { oc_alpha: ALL_IDS } });
  s.oc.state.sessionsState.oc_alpha = 'error';
  const failed = await s.navigation.load(detail(), heimdallProject(s.dirs));
  assert.equal(failed.state, 'discovery-failed');
  assert.match(failed.message, /could not list sessions/);
  assert.equal(failed.canRefresh, true);
  assert.equal(failed.targets.every(entry => entry.state === 'discovery-failed' && !entry.enabled), true);

  const brokenProjects = await stack(t, { projects: () => [], projectsState: 'error' });
  assert.equal((await brokenProjects.navigation.load(detail(), heimdallProject(brokenProjects.dirs))).state, 'discovery-failed');
});

test('session-not-discovered: ready listing without the id explains and never opens or creates anything', async t => {
  const s = await stack(t, { projects: dirs => [{ id: 'oc_alpha', name: 'alpha', directory: dirs.alias }], sessions: { oc_alpha: ['ses_parent', 'ses_t1'] } });
  const view = await s.navigation.load(detail(), heimdallProject(s.dirs));
  assert.equal(view.state, 'listed');
  const states = Object.fromEntries(view.targets.map(entry => [entry.target.sessionId, entry.state]));
  assert.deepEqual(states, { ses_parent: 'found', ses_t3: 'session-not-discovered', ses_t1: 'found', ses_t2: 'session-not-discovered' });
  const missing = view.targets.find(entry => entry.target.sessionId === 'ses_t3');
  assert.equal(missing.enabled, false);
  assert.match(missing.note, /has not listed this session yet/);
  assert.match(missing.note, /managed worktree/);
  assert.doesNotMatch(missing.note, /group/i, 'no promise of worktree grouping');
  assert.match(missing.note, /Refresh/);

  assert.deepEqual(await s.navigation.open(view, 'current'), { ok: false, message: 'That session is not available to open yet.' });
  assert.deepEqual(await s.navigation.open(view, 'completed:ses_unknown'), { ok: false, message: 'That session is not available to open yet.' });
  assert.deepEqual(await s.navigation.open(view, 'parent'), { ok: true, message: null });
  assert.deepEqual(s.oc.calls.filter(entry => entry[0] === 'openSession'), [['openSession', 'ses_parent']], 'only a listed, known id is opened');

  // After OpenChamber discovers the rest, Refresh (a plain re-list) enables them.
  const again = createNavigation({ host: fakeOpenChamber({ projects: [{ id: 'oc_alpha', name: 'alpha', directory: s.dirs.alias }], sessions: { oc_alpha: ALL_IDS } }), matcher: createPanelClient(s.panelHost) });
  assert.equal((await again.load(detail(), heimdallProject(s.dirs))).targets.every(entry => entry.enabled), true);
  assertNoForbiddenAndReadOnly(s);
});

test('no recorded sessions: nothing is asked of OpenChamber', async t => {
  const s = await stack(t, { projects: dirs => [{ id: 'oc_alpha', name: 'alpha', directory: dirs.alias }] });
  const view = await s.navigation.load(detail({ sessions: { parent: null, current: null, completed: [] } }), heimdallProject(s.dirs));
  assert.equal(view.state, 'no-sessions');
  assert.equal(view.canRefresh, false);
  assert.deepEqual(s.oc.calls, []);
  assert.deepEqual(s.panelHost.requests, []);
});

test('host failures become explicit fixed messages without relaying raw text', async t => {
  const s = await stack(t, { projects: dirs => [{ id: 'oc_alpha', name: 'alpha', directory: dirs.alias }], sessions: { oc_alpha: ALL_IDS } });

  s.oc.state.failures.listProjects = hostError('NOT_GRANTED');
  let view = await s.navigation.load(detail(), heimdallProject(s.dirs));
  assert.equal(view.state, 'permission-denied');
  assert.equal(view.message, 'Allow Heimdall to read sessions in Settings → Extensions, then Refresh sessions.');
  assert.equal(view.targets.every(entry => entry.state === 'permission-denied' && !entry.enabled), true);
  assert.equal(view.canRefresh, true);
  assert.equal(JSON.stringify(view).includes('RAW-SECRET'), false);

  s.oc.state.failures.listProjects = hostError('HOST_TIMEOUT');
  view = await s.navigation.load(detail(), heimdallProject(s.dirs));
  assert.equal(view.state, 'unavailable', 'a timeout is not a permission failure');
  assert.match(view.message, /did not answer in time/);

  s.oc.state.failures.listProjects = hostError('SOMETHING_ELSE');
  view = await s.navigation.load(detail(), heimdallProject(s.dirs));
  assert.equal(view.state, 'unavailable');
  assert.match(view.message, /could not list projects/);

  delete s.oc.state.failures.listProjects;
  s.oc.state.failures.listSessions = hostError('NOT_GRANTED');
  view = await s.navigation.load(detail(), heimdallProject(s.dirs));
  assert.equal(view.state, 'permission-denied');
  assert.equal(view.message, 'Allow Heimdall to read sessions in Settings → Extensions, then Refresh sessions.');
  s.oc.state.failures.listSessions = hostError('HOST_TIMEOUT');
  view = await s.navigation.load(detail(), heimdallProject(s.dirs));
  assert.equal(view.state, 'unavailable');
  assert.match(view.message, /list sessions/);

  delete s.oc.state.failures.listSessions;
  view = await s.navigation.load(detail(), heimdallProject(s.dirs));
  assert.equal(view.state, 'listed');
  for (const [code, pattern] of [['NOT_GRANTED', /not been allowed/], ['HOST_TIMEOUT', /did not answer in time/], ['OTHER', /could not open that session/]]) {
    s.oc.state.failures.openSession = hostError(code);
    const result = await s.navigation.open(view, 'parent');
    assert.equal(result.ok, false, code);
    assert.match(result.message, pattern, code);
    assert.equal(result.message.includes('RAW-SECRET'), false);
  }

  // A failing match service is reported with the panel's fixed text.
  const offline = createNavigation({
    host: fakeOpenChamber({ projects: [{ id: 'oc_alpha', name: 'alpha', directory: s.dirs.alias }] }),
    matcher: createPanelClient({ serviceRequest: async () => { throw hostError('NO_SERVICE'); }, serviceStatus: async () => ({ status: 'ready' }) }),
  });
  view = await offline.load(detail(), heimdallProject(s.dirs));
  assert.equal(view.state, 'unavailable');
  assert.match(view.message, /extension service is not installed or not built/);
  assert.equal(JSON.stringify(view).includes('RAW-SECRET'), false);
  for (const entry of s.oc.calls) assert.equal(entry[0].startsWith('FORBIDDEN'), false);
});

test('viewing a run is read-only: GET coordinator calls, one match POST, no forbidden host method', async t => {
  const s = await stack(t, { projects: dirs => [{ id: 'oc_alpha', name: 'alpha', directory: dirs.alias }], sessions: { oc_alpha: ALL_IDS } });
  await s.navigation.load(detail(), heimdallProject(s.dirs));
  assert.deepEqual(s.adapter.calls.sort(), ['projects', 'runs']);
  assert.deepEqual(s.panelHost.requests.map(request => `${request.method} ${request.path}`), ['POST /directories/match']);
  assert.deepEqual(s.oc.calls.map(entry => entry[0]), ['listProjects', 'listSessions']);
  assertNoForbiddenAndReadOnly(s);
  assert.deepEqual(FORBIDDEN.filter(name => s.oc.calls.some(entry => entry[0].includes(name))), []);
});

test('the navigation module names no forbidden host method', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const source = await fs.readFile(path.join(root, 'src', 'extension', 'panel', 'navigation.ts'), 'utf8');
  for (const name of FORBIDDEN) assert.equal(new RegExp(`\\b${name}\\b`).test(source.replace(/\/\*[\s\S]*?\*\//g, '')), false, name);
  const used = [...source.matchAll(/\bhost\.(\w+)\(/g)].map(entry => entry[1]);
  assert.deepEqual([...new Set(used)].sort(), ['listProjects', 'listSessions', 'openSession', 'writeClipboard']);
});

/* ---------- planner, copy folder, refresh ---------- */

test('planner target opens the existing planner session only while planning', async t => {
  const s = await stack(t, { projects: dirs => [{ id: 'oc_alpha', name: 'alpha', directory: dirs.alias }], sessions: { oc_alpha: ['ses_parent', 'ses_plan'] } });
  const planning = detail({ phase: 'planning', status: 'running', currentTask: null, sessions: { parent: 'ses_parent', current: 'ses_plan', completed: [] } });
  const view = await s.navigation.load(planning, heimdallProject(s.dirs));
  assert.deepEqual(view.targets.map(entry => [entry.target.key, entry.target.kind, entry.state]), [['parent', 'parent', 'found'], ['planner', 'planner', 'found']]);
  assert.equal(view.targets[1].actionLabel, 'Open Planner session');
  assert.deepEqual(await s.navigation.open(view, 'planner'), { ok: true, message: null });
  assert.deepEqual(await s.navigation.open(view, 'current'), { ok: false, message: 'That session is not available to open yet.' });
  assert.deepEqual(s.oc.calls.filter(entry => entry[0] === 'openSession'), [['openSession', 'ses_plan']]);

  // Once the runner moves on, the same child id is no longer offered as a planner.
  const after = await s.navigation.load({ ...planning, phase: 'paused' }, heimdallProject(s.dirs));
  assert.deepEqual(after.targets.map(entry => entry.target.kind), ['parent']);
  assertNoForbiddenAndReadOnly(s);
});

test('completed task targets are keyed by task id and open the recorded ids', async t => {
  const s = await stack(t, { projects: dirs => [{ id: 'oc_alpha', name: 'alpha', directory: dirs.alias }], sessions: { oc_alpha: ALL_IDS } });
  const view = await s.navigation.load(detail(), heimdallProject(s.dirs));
  assert.deepEqual(view.targets.filter(entry => entry.target.kind === 'completed').map(entry => [entry.target.taskId, entry.target.sessionId]), [['T1', 'ses_t1'], ['T2', 'ses_t2']]);
  assert.deepEqual(await s.navigation.open(view, 'completed:ses_t2'), { ok: true, message: null });
  assert.deepEqual(s.oc.calls.filter(entry => entry[0] === 'openSession'), [['openSession', 'ses_t2']]);
});

test('copy project folder: one writeClipboard call with the exact directory, success and failure feedback', async t => {
  const s = await stack(t, { projects: () => [] });
  const ok = await s.navigation.copyProjectFolder(s.dirs.project);
  assert.deepEqual(ok, { ok: true, message: 'Copied project folder' });
  assert.deepEqual(s.oc.calls, [['writeClipboard', s.dirs.project]]);

  for (const code of ['NOT_GRANTED', 'HOST_TIMEOUT', 'HOST_REJECTED']) {
    s.oc.state.failures.writeClipboard = hostError(code);
    const failed = await s.navigation.copyProjectFolder(s.dirs.project);
    assert.equal(failed.ok, false, code);
    assert.match(failed.message, /Select the folder path shown on this page/, code);
    assert.equal(failed.message.includes('RAW-SECRET'), false, code);
  }
  assert.equal(s.oc.calls.filter(entry => entry[0] === 'writeClipboard').length, 4, 'one call per attempt');
  assertNoForbiddenAndReadOnly(s);
});

test('copy project folder makes no host call for an unknown, empty or too long directory', async t => {
  const s = await stack(t, { projects: () => [] });
  for (const directory of [null, undefined, '', '   ']) {
    const result = await s.navigation.copyProjectFolder(directory);
    assert.equal(result.ok, false);
    assert.match(result.message, /not known/);
  }
  const tooLong = await s.navigation.copyProjectFolder('/' + 'a'.repeat(32000));
  assert.equal(tooLong.ok, false);
  assert.match(tooLong.message, /Select the folder path/);
  assert.deepEqual(s.oc.calls, []);
  // Exactly at the limit is passed through unchanged.
  const edge = '/' + 'a'.repeat(31999);
  assert.equal((await s.navigation.copyProjectFolder(edge)).ok, true);
  assert.deepEqual(s.oc.calls, [['writeClipboard', edge]]);
});

test('Refresh re-runs only listProjects, the directory match and listSessions', async t => {
  const s = await stack(t, { projects: dirs => [{ id: 'oc_alpha', name: 'alpha', directory: dirs.alias }], sessions: { oc_alpha: ['ses_parent'] } });
  await s.navigation.load(detail(), heimdallProject(s.dirs));
  s.oc.calls.length = 0;
  s.panelHost.requests.length = 0;
  s.adapter.calls.length = 0;
  const again = await s.navigation.load(detail(), heimdallProject(s.dirs));
  assert.equal(again.state, 'listed');
  assert.deepEqual(s.oc.calls.map(entry => entry[0]), ['listProjects', 'listSessions']);
  assert.deepEqual(s.panelHost.requests.map(request => `${request.method} ${request.path}`), ['POST /directories/match']);
  assert.deepEqual([...new Set(s.adapter.calls)].sort(), ['projects', 'runs']);
});
