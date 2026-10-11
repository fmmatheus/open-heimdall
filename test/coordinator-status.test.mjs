import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCoordinatorClient } from '../dist/coordinator/client.js';
import { startCoordinatorService, readCoordinatorToken } from '../dist/coordinator/service.js';
import { parseCoordinatorStatus } from '../dist/coordinator/status.js';
import { coordinatorStatus } from '../dist/coordinator/cli.js';

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

// ---- heimdall coordinator status (spawned CLI) ----
//
// Every spawned CLI runs from a temporary working directory with an isolated HOME, no
// HEIMDALL_COORDINATOR_CONFIG and an explicit temporary --coordinator-config, so the default
// configuration can never resolve to a live coordinator.

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const repository = fileURLToPath(new URL('..', import.meta.url));
const posix = { skip: process.platform === 'win32' ? 'Unix socket endpoints only' : false };
const COORDINATOR_TOML = '[coordinator]\nstateDirectory="state"\nglobalConcurrency=2\nprojectConcurrency=1\n';
const HEX64 = /[a-f0-9]{64}/;

/** Prepare an isolated HOME, working directory and coordinator.toml inside `root` (the state directory is created on request). */
async function prepareCli(root, { state = true } = {}) {
  const home = path.join(root, 'home');
  const cwd = path.join(root, 'cwd');
  await fs.mkdir(home, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });
  if (state) await fs.mkdir(path.join(root, 'state'), { recursive: true });
  const config = path.join(root, 'coordinator.toml');
  await fs.writeFile(config, COORDINATOR_TOML);
  assert.ok(path.relative(repository, cwd).startsWith('..'), 'spawned CLI must run outside the repository');
  return { root, home, cwd, config, state: path.join(root, 'state'), endpoint: path.join(root, 'state', 'coordinator.sock') };
}

async function scenario(t, options) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hdc-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return prepareCli(root, options);
}

function runCli(env, args) {
  const childEnvironment = { ...process.env, HOME: env.home, USERPROFILE: env.home };
  delete childEnvironment.HEIMDALL_COORDINATOR_CONFIG;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: env.cwd, env: childEnvironment, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

const statusArguments = (env, json) => ['coordinator', 'status', ...(json ? ['--json'] : []), '--coordinator-config', env.config];
const tree = async root => (await fs.readdir(root, { recursive: true })).sort();

async function writeKey(env, key = 'a'.repeat(64)) {
  const file = path.join(env.state, 'coordinator.key');
  await fs.writeFile(file, key, { mode: 0o600 });
  await fs.chmod(file, 0o600);
  return key;
}

async function serveAt(t, endpoint, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(endpoint, resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
}

const respond = (statusCode, text) => (_request, response) => {
  response.writeHead(statusCode, { 'Content-Type': 'application/json' });
  response.end(text);
};

/** Both modes must fail with a nonzero exit, empty stdout, a stderr diagnostic, no key and no new files. */
async function expectFailure(env, pattern, secrets = []) {
  for (const json of [false, true]) {
    const before = await tree(env.root);
    const result = await runCli(env, statusArguments(env, json));
    const mode = json ? 'json' : 'human';
    assert.equal(result.signal, null, mode);
    assert.equal(result.status, 1, `${mode}: ${result.stderr}`);
    assert.equal(result.stdout, '', `${mode}: stdout must stay empty`);
    assert.match(result.stderr, /^Heimdall: /, mode);
    assert.match(result.stderr, pattern, mode);
    for (const output of [result.stdout, result.stderr]) {
      assert.doesNotMatch(output, HEX64, `${mode}: output must not contain a key`);
      for (const secret of secrets) assert.ok(!output.includes(secret), mode);
    }
    assert.deepEqual(await tree(env.root), before, `${mode}: failure must not create files`);
  }
}

const expectedStatus = { schemaVersion: 1, service: 'heimdall-coordinator', status: 'running', acceptingNewRuns: true, queuedRuns: 1, reservedRuns: 1 };

test('status command reports a running coordinator in human and JSON mode', posix, async t => {
  const fixture = await statusFixture(t);
  const env = await prepareCli(fixture.temporary);
  const human = await runCli(env, statusArguments(env, false));
  assert.equal(human.status, 0, human.stderr);
  assert.equal(human.stderr, '');
  assert.equal(human.stdout, 'Coordinator running; accepting new runs.\nQueued runs: 1\nReserved runs: 1 (retained capacity, including uncertain execution)\n');

  const json = await runCli(env, statusArguments(env, true));
  assert.equal(json.status, 0, json.stderr);
  assert.equal(json.stderr, '');
  const validated = parseCoordinatorStatus(await fixture.admin.request('GET', '/status'));
  assert.deepEqual(validated, expectedStatus);
  assert.equal(json.stdout, JSON.stringify(validated, null, 2) + '\n');
  assert.deepEqual(Object.keys(JSON.parse(json.stdout)).sort(), Object.keys(validated).sort());
  for (const output of [human.stdout, json.stdout]) assert.ok(!output.includes(fixture.key));
});

test('status command reports a draining coordinator in human and JSON mode', { ...posix, timeout: 30000 }, async t => {
  const fixture = await statusFixture(t, { pollIntervalMs: 5 });
  const env = await prepareCli(fixture.temporary);
  const drain = fixture.startDrain();
  await turn();
  const human = await runCli(env, statusArguments(env, false));
  assert.equal(human.status, 0, human.stderr);
  assert.equal(human.stdout, 'Coordinator draining; not accepting new runs.\nQueued runs: 1\nReserved runs: 1 (retained capacity, including uncertain execution)\n');
  const json = await runCli(env, statusArguments(env, true));
  assert.equal(json.status, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout), { ...expectedStatus, status: 'draining', acceptingNewRuns: false });
  fixture.release();
  await drain;
});

test('status fails clearly when the coordinator configuration file is missing', posix, async t => {
  const env = await scenario(t, { state: false });
  await fs.rm(env.config);
  const missing = path.join(env.root, 'missing.toml');
  for (const json of [false, true]) {
    const before = await tree(env.root);
    const result = await runCli(env, ['coordinator', 'status', ...(json ? ['--json'] : []), '--coordinator-config', missing]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /^Heimdall: .*(ENOENT|no such file)/);
    assert.deepEqual(await tree(env.root), before);
  }
  assert.ok(!(await fs.readdir(env.root)).includes('state'));
});

test('status fails clearly when the coordinator key is missing', posix, async t => {
  const env = await scenario(t);
  await expectFailure(env, /Cannot read the coordinator key/);
  assert.deepEqual(await fs.readdir(env.state), []);
});

test('status fails clearly when no coordinator is listening', posix, async t => {
  const env = await scenario(t);
  const key = await writeKey(env);
  await expectFailure(env, new RegExp(`Coordinator status request to ${env.endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} failed: Coordinator unavailable`), [key]);
  assert.deepEqual(await fs.readdir(env.state), ['coordinator.key']);
});

test('status fails clearly when the coordinator rejects the key', posix, async t => {
  const fixture = await statusFixture(t);
  const env = await prepareCli(fixture.temporary);
  const wrong = 'b'.repeat(64);
  assert.notEqual(wrong, fixture.key);
  await fs.writeFile(path.join(env.state, 'coordinator.key'), wrong, { mode: 0o600 });
  await fs.chmod(path.join(env.state, 'coordinator.key'), 0o600);
  await expectFailure(env, /refused authorization/, [fixture.key, wrong]);
});

test('status reports an older coordinator without the status route as incompatible', posix, async t => {
  const env = await scenario(t);
  const key = await writeKey(env);
  await serveAt(t, env.endpoint, respond(404, JSON.stringify({ error: 'Unknown coordinator route' })));
  await expectFailure(env, /does not support status.*incompatible.*does not restart/s, [key]);
});

test('status reports a coordinator that is starting or stopping', posix, async t => {
  const env = await scenario(t);
  const key = await writeKey(env);
  await serveAt(t, env.endpoint, respond(503, JSON.stringify({ error: 'Coordinator is starting or stopping' })));
  await expectFailure(env, /starting or stopping/, [key]);
});

test('status rejects an invalid JSON body', posix, async t => {
  const env = await scenario(t);
  const key = await writeKey(env);
  await serveAt(t, env.endpoint, respond(200, 'this is not json'));
  await expectFailure(env, new RegExp('Invalid coordinator JSON response'), [key]);
});

test('status rejects schema-invalid and contradictory bodies', posix, async t => {
  const bodies = {
    'running while not accepting': { ...expectedStatus, acceptingNewRuns: false },
    'unknown status': { ...expectedStatus, status: 'stopped' },
    'schema version 2': { ...expectedStatus, schemaVersion: 2 },
  };
  for (const [name, body] of Object.entries(bodies)) {
    await t.test(name, async subtest => {
      const env = await scenario(subtest);
      const key = await writeKey(env);
      await serveAt(subtest, env.endpoint, respond(200, JSON.stringify(body)));
      await expectFailure(env, /returned an invalid status response: Invalid coordinator status/, [key]);
    });
  }
});

test('status gives up at its deadline and writes nothing, in both modes', posix, async t => {
  const env = await scenario(t);
  const key = await writeKey(env);
  const timers = new Set();
  t.after(() => { for (const timer of timers) clearInterval(timer); });
  await serveAt(t, env.endpoint, (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    const timer = setInterval(() => response.write(' '), 20);
    timers.add(timer);
    response.on('close', () => { clearInterval(timer); timers.delete(timer); });
  });
  const configuration = { stateDirectory: env.state, endpoint: env.endpoint, globalConcurrency: 2, projectConcurrency: 1 };
  for (const json of [false, true]) {
    const written = [];
    const started = Date.now();
    await assert.rejects(coordinatorStatus({ configuration, json, deadlineMs: 200, stdout: { write: text => written.push(text) } }), error => {
      assert.match(error.message, /deadline/);
      assert.ok(!error.message.includes(key));
      return true;
    });
    assert.ok(Date.now() - started < 3000);
    assert.deepEqual(written, [], 'nothing may be written before validation succeeds');
  }
});

test('coordinator help documents status and needs no coordinator state', posix, async t => {
  const env = await scenario(t, { state: false });
  const homeBefore = await tree(env.root);
  for (const args of [['coordinator', '--help'], ['coordinator', 'status', '--help'], ['coordinator', 'help']]) {
    const result = await runCli(env, args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    for (const text of ['heimdall coordinator status [--json] [--coordinator-config FILE]', '--json', '--coordinator-config FILE', '10 second deadline', 'heimdall coordinator status\n', 'heimdall coordinator status --json --coordinator-config ./coordinator.toml', 'exits 0', 'nothing on stdout']) {
      assert.ok(result.stdout.includes(text), `${args.join(' ')} should mention ${text}`);
    }
    assert.match(result.stdout, /heimdall coordinator serve/);
    assert.match(result.stdout, /heimdall coordinator events \[--after SEQUENCE\]/);
  }
  assert.deepEqual(await tree(env.root), homeBefore);
});

test('--json applies only to coordinator status and other commands are unchanged', posix, async t => {
  const fixture = await statusFixture(t);
  const env = await prepareCli(fixture.temporary);
  const rejected = [
    ['coordinator', 'run', 'list', '--json', '--coordinator-config', env.config],
    ['coordinator', 'project', 'list', '--json', '--coordinator-config', env.config],
    ['coordinator', 'events', '--json', '--coordinator-config', env.config],
    ['coordinator', 'serve', '--json', '--coordinator-config', env.config],
  ];
  for (const args of rejected) {
    const result = await runCli(env, args);
    assert.equal(result.status, 1, args.join(' '));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /--json does not apply to this command/);
  }
  const repeated = await runCli(env, ['coordinator', 'status', '--json', '--json', '--coordinator-config', env.config]);
  assert.equal(repeated.status, 1);
  assert.equal(repeated.stdout, '');
  assert.match(repeated.stderr, /repeated option: --json/);
  const foreign = await runCli(env, ['coordinator', 'status', '--limit', '3', '--coordinator-config', env.config]);
  assert.equal(foreign.status, 1);
  assert.equal(foreign.stdout, '');
  assert.match(foreign.stderr, /--limit does not apply/);
  const topLevel = await runCli(env, ['check', '--json']);
  assert.equal(topLevel.status, 1);
  assert.match(topLevel.stderr, /Unknown argument: --json/);

  const list = await runCli(env, ['coordinator', 'project', 'list', '--coordinator-config', env.config]);
  assert.equal(list.status, 0, list.stderr);
  assert.equal(list.stdout, JSON.stringify(await fixture.admin.request('GET', '/projects'), null, 2) + '\n');
  const runs = await runCli(env, ['coordinator', 'run', 'list', '--coordinator-config', env.config]);
  assert.equal(runs.status, 0, runs.stderr);
  assert.equal(runs.stdout, JSON.stringify(await fixture.admin.request('GET', '/runs'), null, 2) + '\n');
});
