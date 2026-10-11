import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { createCoordinatorClient } from '../dist/coordinator/client.js';
import { startCoordinatorService, readCoordinatorToken } from '../dist/coordinator/service.js';
import { parseCoordinatorStatus } from '../dist/coordinator/status.js';

const TOKEN = 'k'.repeat(64);

async function listen(t, handler) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hd-')));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\hd-${path.basename(temporary)}` : path.join(temporary, 's.sock');
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(endpoint, resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  return endpoint;
}

test('overall deadline bounds a trickling response that keeps resetting the inactivity timeout', async t => {
  const timers = new Set();
  t.after(() => { for (const timer of timers) clearInterval(timer); });
  const endpoint = await listen(t, (request, response) => {
    if (request.url === '/fresh') { response.setHeader('Content-Type', 'application/json'); response.end('{"ok":true}'); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    const timer = setInterval(() => response.write(' '), 20);
    timers.add(timer);
    response.on('close', () => { clearInterval(timer); timers.delete(timer); });
  });

  const client = createCoordinatorClient(endpoint, TOKEN, { timeoutMs: 5000, deadlineMs: 200 });
  const started = Date.now();
  await assert.rejects(client.request('GET', '/trickle'), error => /deadline/.test(error.message) && /200 ms/.test(error.message));
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 150, `rejected too early: ${elapsed} ms`);
  assert.ok(elapsed < 2000, `rejected too late: ${elapsed} ms`);

  assert.deepEqual(await client.request('GET', '/fresh'), { ok: true });
});

test('error responses keep their message and expose the HTTP status code', async t => {
  const endpoint = await listen(t, (_request, response) => {
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'Unknown coordinator route' }));
  });
  await assert.rejects(createCoordinatorClient(endpoint, TOKEN).request('GET', '/status'), error => {
    assert.equal(error.message, 'Unknown coordinator route');
    assert.equal(error.statusCode, 404);
    return true;
  });
});

test('deadlineMs must be a positive safe integer', () => {
  for (const deadlineMs of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createCoordinatorClient('/tmp/x.sock', TOKEN, { deadlineMs }), /deadline/);
  }
  assert.equal(typeof createCoordinatorClient('/tmp/x.sock', TOKEN, { deadlineMs: 1 }).request, 'function');
});

const settings = { plannerAgent: 'planner', executorAgent: 'executor', plannerModel: 'anthropic/planner', executorModel: 'anthropic/executor', executorFallbackModel: 'kimi/fallback', maxTasks: 10, minQuotaRemainingPercent: 10, tokenLimitsDisabled: true };
const specification = { settings, plannerPrompt: 'Synthetic planner', executorPrompt: 'Synthetic executor', agents: {}, opencode: { baseUrl: 'http://127.0.0.1:4321', passwordEnvironmentVariable: 'SYNTHETIC_PASSWORD' } };
const FEATURE = 'Synthetic feature text FEATURE-MARKER-7f3a';
const turn = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(predicate) {
  for (let index = 0; index < 200; index++) { if (predicate()) return; await turn(); }
  throw new Error('Synthetic launch did not reach its expected stage');
}

const valid = { schemaVersion: 1, service: 'heimdall-coordinator', status: 'running', acceptingNewRuns: true, queuedRuns: 0, reservedRuns: 2 };

test('parseCoordinatorStatus accepts both valid shapes and returns a fresh object', () => {
  const running = parseCoordinatorStatus(valid);
  assert.deepEqual(running, valid);
  assert.notEqual(running, valid);
  const draining = { ...valid, status: 'draining', acceptingNewRuns: false, queuedRuns: 3, reservedRuns: 0 };
  assert.deepEqual(parseCoordinatorStatus(draining), draining);
});

test('parseCoordinatorStatus rejects every malformed shape', () => {
  const { acceptingNewRuns: _removed, ...missingKey } = valid;
  const invalid = {
    'wrong service': { ...valid, service: 'other' },
    'schema version 2': { ...valid, schemaVersion: 2 },
    'unknown status': { ...valid, status: 'stopped' },
    'extra key': { ...valid, extra: true },
    'missing key': missingKey,
    'non-boolean admission': { ...valid, acceptingNewRuns: 'true' },
    'negative count': { ...valid, queuedRuns: -1 },
    'fractional count': { ...valid, reservedRuns: 1.5 },
    'string count': { ...valid, queuedRuns: '1' },
    'unsafe count': { ...valid, queuedRuns: Number.MAX_SAFE_INTEGER + 1 },
    'running while not accepting': { ...valid, acceptingNewRuns: false },
    'draining while accepting': { ...valid, status: 'draining', acceptingNewRuns: true },
    null: null,
    array: [valid],
    string: 'running',
    number: 1,
  };
  for (const [name, value] of Object.entries(invalid)) assert.throws(() => parseCoordinatorStatus(value), /Invalid coordinator status/, name);
});

/** Service with one admitted run whose launch is held open and one run left queued behind it. */
async function statusFixture(t, { pollIntervalMs = 60000 } = {}) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hds-')));
  const stateDirectory = path.join(temporary, 'state');
  const endpoint = process.platform === 'win32' ? '\\\\.\\pipe\\heimdall-status-' + randomUUID() : path.join(stateDirectory, 'coordinator.sock');
  const launches = [];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let released = false;
  let drain;
  let service;
  let closed = false;
  const fixture = {
    temporary, stateDirectory, endpoint, launches,
    release: () => { released = true; release(); },
    startDrain: () => { drain = service.drain(); return drain; },
    close: async () => { if (!closed) { closed = true; await service.close(); } },
  };
  t.after(async () => {
    fixture.release();
    if (drain) await drain;
    await fixture.close();
    await fs.rm(temporary, { recursive: true, force: true });
  });
  service = await startCoordinatorService({
    configuration: { stateDirectory, endpoint, globalConcurrency: 1, projectConcurrency: 2 }, pollIntervalMs,
    executor: {
      launch: async run => { launches.push(run); await held; },
      inspect: async () => released ? { idle: true, status: 'failed' } : { idle: false, status: 'unknown' },
      interrupt: async () => { throw new Error('Status must never cancel native execution'); },
    },
    scheduler: { createWorktree: async () => {}, verifyWorktree: async () => {}, prepare: async () => {} },
  });
  fixture.service = service;
  fixture.key = await readCoordinatorToken(stateDirectory);
  fixture.admin = createCoordinatorClient(endpoint, fixture.key);
  const directory = path.join(temporary, 'synthetic-project');
  await fs.mkdir(path.join(directory, '.git'), { recursive: true });
  const configPath = path.join(directory, '.heimdall.toml');
  await fs.writeFile(configPath, '[workflow]\n');
  const project = service.store.registerProject({ directory, commonGitDirectory: path.join(directory, '.git'), configPath, concurrency: 2 });
  const enqueue = id => service.store.enqueue({ id, projectId: project.id, feature: FEATURE, baseCommit: 'a'.repeat(40), worktreePath: path.join(stateDirectory, 'worktrees', project.id, id, 'checkout'), branch: 'heimdall/run/' + id, specification });
  enqueue('active');
  enqueue('queued');
  await service.scheduler.tick();
  await waitFor(() => launches.length === 1);
  assert.equal(service.store.getRun('active').capacityReserved, true);
  assert.equal(service.store.getRun('queued').status, 'queued');
  return fixture;
}

test('administrator reads the schema-1 status with queued and reserved counts', async t => {
  const { admin } = await statusFixture(t);
  const body = await admin.request('GET', '/status');
  assert.deepEqual(body, { schemaVersion: 1, service: 'heimdall-coordinator', status: 'running', acceptingNewRuns: true, queuedRuns: 1, reservedRuns: 1 });
  assert.deepEqual(parseCoordinatorStatus(body), body);
});

test('status stays readable while a drain is held open by an active reservation', { timeout: 10000 }, async t => {
  const fixture = await statusFixture(t, { pollIntervalMs: 5 });
  let drained = false;
  const drain = fixture.startDrain().then(() => { drained = true; });
  await turn();
  assert.equal(drained, false);
  const body = await fixture.admin.request('GET', '/status');
  assert.deepEqual(parseCoordinatorStatus(body), { schemaVersion: 1, service: 'heimdall-coordinator', status: 'draining', acceptingNewRuns: false, queuedRuns: 1, reservedRuns: 1 });
  fixture.release();
  await drain;
  const after = parseCoordinatorStatus(await fixture.admin.request('GET', '/status'));
  assert.equal(after.status, 'draining');
  assert.equal(after.acceptingNewRuns, false);
  assert.equal(after.reservedRuns, 0);
});

function rawStatus(endpoint, token) {
  return new Promise((resolve, reject) => {
    const headers = token === undefined ? {} : { Authorization: `Bearer ${token}` };
    const request = http.request({ socketPath: endpoint, path: '/status', method: 'GET', headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ statusCode: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('status refuses missing, wrong and run-owner tokens without leaking secrets', async t => {
  const fixture = await statusFixture(t);
  const ownerToken = fixture.service.store.getRun('active').ownerToken;
  assert.ok(ownerToken);
  const wrong = 'f'.repeat(64);
  const secrets = [fixture.key, ownerToken, wrong, FEATURE, 'FEATURE-MARKER'];
  for (const token of [undefined, wrong, ownerToken]) {
    const response = await rawStatus(fixture.endpoint, token);
    assert.equal(response.statusCode, 401);
    assert.deepEqual(JSON.parse(response.text), { error: 'Coordinator authorization required' });
    for (const secret of secrets) assert.ok(!response.text.includes(secret));
  }
  for (const token of [wrong, ownerToken]) {
    await assert.rejects(createCoordinatorClient(fixture.endpoint, token).request('GET', '/status'), error => {
      assert.equal(error.statusCode, 401);
      for (const secret of secrets) assert.ok(!error.message.includes(secret));
      return true;
    });
  }
});

async function sha256(file) {
  try { return createHash('sha256').update(await fs.readFile(file)).digest('hex'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function snapshot(fixture) {
  const entries = (await fs.readdir(fixture.stateDirectory)).sort();
  const files = {};
  // The WAL index (-shm) is compared too: SQLite could update read marks on a pure read, but reads
  // from the already-open connection were observed to leave it byte-identical.
  for (const name of ['coordinator.sqlite', 'coordinator.sqlite-wal', 'coordinator.sqlite-shm']) {
    const file = path.join(fixture.stateDirectory, name);
    files[name] = entries.includes(name) ? { size: (await fs.stat(file)).size, sha256: await sha256(file) } : null;
  }
  const events = fixture.service.store.events(0);
  return { entries, files, runs: structuredClone(fixture.service.store.listRuns()), eventCount: events.length, lastSequence: events.at(-1)?.sequence ?? 0, launches: fixture.launches.length };
}

test('repeated status reads do not change runs, events, launches or database files', async t => {
  const fixture = await statusFixture(t);
  const before = await snapshot(fixture);
  assert.ok(before.eventCount > 0);
  assert.ok(before.files['coordinator.sqlite']);
  for (let index = 0; index < 6; index++) {
    const body = parseCoordinatorStatus(await fixture.admin.request('GET', '/status'));
    assert.equal(body.queuedRuns, 1);
    assert.equal(body.reservedRuns, 1);
  }
  assert.deepEqual(await snapshot(fixture), before);
});
