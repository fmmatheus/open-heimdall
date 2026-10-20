import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createCoordinatorClient } from '../dist/coordinator/client.js';
import { startCoordinatorService } from '../dist/coordinator/service.js';
import { readCoordinatorToken as tokenFromService } from '../dist/coordinator/service.js';
import { readCoordinatorToken } from '../dist/coordinator/token.js';
import * as coordinatorIndex from '../dist/coordinator/index.js';
import { createCoordinatorAdapter } from '../dist/extension/service/coordinator.js';
import { createExtensionServer, listenExtensionServer, Reply } from '../dist/extension/service/server.js';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE_TOKEN = 'svc-' + 'a1b2c3d4'.repeat(8);

const git = (directory, args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function fixture(t, { start = true } = {}) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hd-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const project = path.join(temporary, 'source');
  const state = path.join(temporary, 'state');
  await fs.mkdir(project);
  git(project, ['init', '-b', 'main']);
  git(project, ['config', 'user.name', 'Fixture']);
  git(project, ['config', 'user.email', 'fixture@example.invalid']);
  await fs.writeFile(path.join(project, 'README.md'), 'pinned base\n');
  git(project, ['add', 'README.md']); git(project, ['commit', '-m', 'fixture']);
  await fs.writeFile(path.join(project, '.heimdall.toml'), `[workflow]\nplannerModel = "anthropic/fixture"\nexecutorModel = "anthropic/fixture"\nexecutorFallbackModel = "openai/fixture"\n[opencode]\nbaseUrl = "http://127.0.0.1:4096"\n`);
  const configPath = path.join(temporary, 'coordinator.toml');
  await fs.writeFile(configPath, `[coordinator]\nstateDirectory = ${JSON.stringify(state)}\n`);
  const configuration = { stateDirectory: state, endpoint: path.join(state, 'coordinator.sock'), globalConcurrency: 2, projectConcurrency: 1 };
  const executor = { async launch() {}, async inspect() { return { idle: false, status: 'unknown' }; } };
  let service;
  const begin = async () => {
    service = await startCoordinatorService({ configuration, executor, pollIntervalMs: 60000 });
    t.after(async () => { if (service) await service.close(); service = null; });
  };
  if (start) await begin();
  return { temporary, project, state, configPath, configuration, begin, service: () => service };
}

async function listening(t, options) {
  const server = await listenExtensionServer(createExtensionServer(options), 0);
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return server;
}

/** Raw request so paths are sent byte for byte (fetch would normalize dot segments). */
function call(server, { method = 'GET', path: target = '/health', token = SERVICE_TOKEN, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port: server.address().port, method, path: target,
      headers: { ...(token === null ? {} : { Authorization: `Bearer ${token}` }), ...headers },
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: response.statusCode, headers: response.headers, text, json });
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

test('token helper is sqlite-free and still exported from the service and coordinator index', async t => {
  const f = await fixture(t);
  const key = await readCoordinatorToken(f.state);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(tokenFromService, readCoordinatorToken);
  assert.equal(coordinatorIndex.readCoordinatorToken, readCoordinatorToken);
  const source = await fs.readFile(path.join(root, 'src', 'coordinator', 'token.ts'), 'utf8');
  assert.doesNotMatch(source, /sqlite|store\.js/);
});

test('coordinator client honours an optional timeout and rejects invalid ones', async t => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hd-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const socket = path.join(temporary, 's.sock');
  const server = http.createServer(() => { /* never answers */ });
  await new Promise(resolve => server.listen(socket, resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const started = Date.now();
  await assert.rejects(createCoordinatorClient(socket, 'k'.repeat(64), { timeoutMs: 150 }).request('GET', '/projects'), /timed out/);
  assert.ok(Date.now() - started < 5000);
  assert.throws(() => createCoordinatorClient(socket, 'k', { timeoutMs: 0 }), /timeout/);
  assert.equal(typeof createCoordinatorClient(socket, 'k').request, 'function');
});

test('oversized coordinator responses stay data-size failures through the client and extension adapter', async t => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hd-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const socket = path.join(temporary, 's.sock');
  let receivedToken;
  const server = http.createServer((request, response) => {
    receivedToken = request.headers.authorization;
    response.end(JSON.stringify({ text: 'x'.repeat(2 * 1024 * 1024) }));
  });
  await new Promise(resolve => server.listen(socket, resolve));
  t.after(() => { server.close(); server.closeAllConnections(); });
  const token = 'k'.repeat(64);
  const client = createCoordinatorClient(socket, token);
  await assert.rejects(client.request('GET', '/projects'), error => {
    assert.equal(error.code, 'response-too-large');
    assert.equal(error.message, 'Coordinator response is too large');
    return true;
  });
  assert.equal(receivedToken, `Bearer ${token}`);

  const adapter = createCoordinatorAdapter({
    loadConfiguration: async () => ({ stateDirectory: temporary, endpoint: socket, globalConcurrency: 1, projectConcurrency: 1 }),
    readToken: async () => token,
  });
  await assert.rejects(adapter.projects(), error => {
    assert.equal(error.kind, 'coordinator-response-too-large');
    assert.equal(error.message.includes(temporary), false);
    assert.equal(error.message.includes(token), false);
    assert.doesNotMatch(error.message, /not running|unavailable|could not be reached/);
    return true;
  });
  const extension = await listening(t, { token: SERVICE_TOKEN, adapter });
  const oversized = await call(extension, { path: '/projects' });
  assert.equal(oversized.status, 503);
  assert.equal(oversized.json.error.kind, 'coordinator-response-too-large');
  assert.equal(oversized.json.error.message, 'The Heimdall coordinator response is too large to load.');
  assert.doesNotMatch(oversized.text, /not running|could not be reached/);
  assert.equal(oversized.text.includes(temporary), false);
  assert.equal(oversized.text.includes(token), false);
});

test('coordinator transport wrapping preserves the original failure code and cause', async t => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hd-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const client = createCoordinatorClient(path.join(temporary, 'missing.sock'), 'k'.repeat(64));
  await assert.rejects(client.request('GET', '/projects'), error => {
    assert.equal(error.code, 'ENOENT');
    assert.equal(error.cause.code, 'ENOENT');
    assert.match(error.message, /^Coordinator unavailable:/);
    return true;
  });
});

test('service rejects every request without the exact bearer token and binds loopback only', async t => {
  const f = await fixture(t);
  const adapter = createCoordinatorAdapter({ configPath: f.configPath });
  const server = await listening(t, { token: SERVICE_TOKEN, adapter });
  assert.equal(server.address().address, '127.0.0.1');

  for (const attempt of [
    { token: null }, { token: 'wrong' }, { token: SERVICE_TOKEN + 'x' }, { token: SERVICE_TOKEN.slice(0, -1) },
    { token: null, headers: { Authorization: SERVICE_TOKEN } },
    { token: null, headers: { Authorization: `bearer ${SERVICE_TOKEN}` } },
    { path: '/status', token: null }, { path: '/nope', token: 'wrong' },
  ]) {
    const response = await call(server, attempt);
    assert.equal(response.status, 401, JSON.stringify(attempt));
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.json.error.kind, 'unauthorized');
    assert.equal(response.text.includes(SERVICE_TOKEN), false);
  }
  const ok = await call(server);
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { ok: true });
  assert.equal(ok.headers['cache-control'], 'no-store');
  assert.match(ok.headers['content-type'], /^application\/json/);
});

test('route table: unknown paths are 404, wrong methods 405, traversal never reaches a handler', async t => {
  const f = await fixture(t);
  const server = await listening(t, { token: SERVICE_TOKEN, adapter: createCoordinatorAdapter({ configPath: f.configPath }) });
  for (const target of ['/runs/x/resume', '/../etc/passwd', '/%2e%2e/etc/passwd', '/runs/%2e%2e/%2e%2e/health', '/health/', '//health', '/health/..', '/.%2e/health', '/status/extra', '/%2fhealth', '/\\health', '/', '/runs/x/y', '/projects/x']) {
    for (const method of ['GET', 'POST']) {
      const response = await call(server, { method, path: target });
      assert.equal(response.status, 404, `${method} ${target}`);
      assert.equal(response.json.error.kind, 'not-found');
    }
  }
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
    const response = await call(server, { method, path: '/health', body: method === 'POST' ? '{}' : undefined });
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.allow, 'GET');
  }
});

test('request bodies are rejected unless a POST route registers them, and are capped', async t => {
  const f = await fixture(t);
  const seen = [];
  const server = await listening(t, {
    token: SERVICE_TOKEN,
    adapter: createCoordinatorAdapter({ configPath: f.configPath }),
    routes: [
      { method: 'POST', path: '/echo', body: {}, handler: context => { seen.push(context.body); return new Reply(201, { got: context.body }); } },
      { method: 'GET', path: '/items/:id', handler: context => ({ id: context.params.id, query: context.query.get('q') }) },
      { method: 'GET', path: '/boom', handler: () => { throw new Error(`secret ${SERVICE_TOKEN} at /Users/x/stack`); } },
      { method: 'GET', path: '/big', handler: () => ({ data: 'x'.repeat(250000) }) },
    ],
  });
  const created = await call(server, { method: 'POST', path: '/echo', body: JSON.stringify({ a: 1 }), headers: { 'Content-Type': 'application/json' } });
  assert.equal(created.status, 201);
  assert.deepEqual(created.json, { got: { a: 1 } });
  assert.equal((await call(server, { method: 'POST', path: '/echo', body: '{nope' })).status, 400);
  const oversize = await call(server, { method: 'POST', path: '/echo', body: JSON.stringify({ pad: 'y'.repeat(17 * 1024) }) });
  assert.equal(oversize.status, 413);
  assert.equal(seen.length, 1);
  // POST to a GET-only route is 405 and its body is never parsed.
  assert.equal((await call(server, { method: 'POST', path: '/items/abc', body: 'z'.repeat(40000) })).status, 405);

  assert.deepEqual((await call(server, { path: '/items/abc?q=1' })).json, { id: 'abc', query: '1' });

  const boom = await call(server, { path: '/boom' });
  assert.equal(boom.status, 500);
  assert.equal(boom.json.error.kind, 'internal-error');
  assert.equal(boom.text.includes(SERVICE_TOKEN), false);
  assert.equal(boom.text.includes('/Users/x'), false);

  const big = await call(server, { path: '/big' });
  assert.equal(big.status, 502);
  assert.equal(big.json.error.kind, 'response-too-large');
  assert.ok(Buffer.byteLength(big.text) < 1000);
});

test('adapter lists projects, runs and events from a real coordinator; secrets never reach responses', async t => {
  const f = await fixture(t);
  const admin = createCoordinatorClient(f.configuration.endpoint, await readCoordinatorToken(f.state));
  const registered = await admin.request('POST', '/projects', { directory: f.project });
  const submitted = await admin.request('POST', '/runs', { projectId: registered.id, feature: 'Implement the specified feature.' });
  // Admission assigns the run owner capability that must never leave the coordinator.
  await f.service().scheduler.tick();
  let ownerToken;
  for (let n = 0; n < 200 && !ownerToken; n++) {
    ownerToken = f.service().store.getRun(submitted.id).ownerToken;
    if (!ownerToken) await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.match(ownerToken, /\S{16,}/);
  const key = await readCoordinatorToken(f.state);

  const adapter = createCoordinatorAdapter({ configPath: f.configPath });
  const projects = await adapter.projects();
  assert.deepEqual(projects.map(project => project.id), [registered.id]);
  const runs = await adapter.runs();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, submitted.id);
  assert.notEqual(runs[0].status, 'queued');
  assert.equal((await adapter.run(submitted.id)).id, submitted.id);
  const events = await adapter.events(0);
  assert.ok(events.some(event => event.type === 'run.queued'));

  const server = await listening(t, { token: SERVICE_TOKEN, adapter });
  const status = await call(server, { path: '/status' });
  assert.equal(status.status, 200);
  assert.equal(status.json.connected, true);
  assert.match(status.json.checkedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(Object.hasOwn(status.json, 'error'), false);

  const everything = [JSON.stringify(projects), JSON.stringify(runs), JSON.stringify(events), status.text, (await call(server)).text];
  for (const body of everything) {
    assert.equal(body.includes(key), false);
    assert.equal(body.includes(ownerToken), false);
    assert.equal(body.includes(SERVICE_TOKEN), false);
  }
  // /status never discloses endpoint or state paths.
  assert.equal(status.text.includes(f.state), false);

  await assert.rejects(adapter.run('does-not-exist'), error => error.kind === 'not-found');
  for (const bad of ['', '../x', 'a/b', 'a?b', '-x', 'a'.repeat(129), '%2e%2e']) {
    await assert.rejects(adapter.run(bad), error => error.kind === 'not-found', bad);
  }
  await assert.rejects(adapter.events(-1), error => error.kind === 'coordinator-error');
  await assert.rejects(adapter.events(1.5), error => error.kind === 'coordinator-error');
});

test('offline coordinator is reported sanitized and the adapter reconnects once it starts', async t => {
  const f = await fixture(t, { start: false });
  const adapter = createCoordinatorAdapter({ configPath: f.configPath });
  const server = await listening(t, { token: SERVICE_TOKEN, adapter });

  const offline = await call(server, { path: '/status' });
  assert.equal(offline.status, 200);
  assert.equal(offline.json.connected, false);
  assert.equal(offline.json.error.kind, 'coordinator-offline');
  assert.equal(typeof offline.json.error.message, 'string');
  assert.equal(offline.text.includes(f.state), false);
  assert.equal(offline.text.includes(os.tmpdir()), false);
  assert.equal(offline.text.includes(SERVICE_TOKEN), false);
  assert.doesNotMatch(offline.text, /ENOENT|ECONNREFUSED|\bat .*:\d+/);
  await assert.rejects(adapter.projects(), error => error.kind === 'coordinator-offline' && !/ENOENT|\/tmp|\/var/.test(error.message));

  // Key exists but the socket is gone (stale file left by a stopped coordinator) is also offline.
  await f.begin();
  const key = await readCoordinatorToken(f.state);
  await f.service().close();
  const stale = await call(server, { path: '/status' });
  assert.equal(stale.json.connected, false);
  assert.equal(stale.json.error.kind, 'coordinator-offline');
  assert.equal(stale.text.includes(key), false);

  await f.begin();
  const back = await call(server, { path: '/status' });
  assert.equal(back.json.connected, true, back.text);
  assert.equal(back.text.includes(await readCoordinatorToken(f.state)), false);
});

test('adapter maps rejected keys, bad configuration and timeouts to fixed sanitized kinds', async t => {
  const f = await fixture(t);
  const wrongKey = 'f'.repeat(64);
  const unauthorized = createCoordinatorAdapter({ configPath: f.configPath, readToken: async () => wrongKey });
  await assert.rejects(unauthorized.projects(), error => {
    assert.equal(error.kind, 'coordinator-unauthorized');
    assert.equal(error.message.includes(wrongKey), false);
    assert.equal(/Bearer|Authorization/i.test(error.message), false);
    return true;
  });

  const invalid = createCoordinatorAdapter({ configPath: path.join(f.temporary, 'missing.toml') });
  await assert.rejects(invalid.projects(), error => error.kind === 'configuration-invalid');
  const brokenKey = createCoordinatorAdapter({ configPath: f.configPath, readToken: async () => { throw new Error('Invalid coordinator access key at /secret/path'); } });
  await assert.rejects(brokenKey.projects(), error => error.kind === 'configuration-invalid' && !error.message.includes('/secret'));

  const slow = createCoordinatorAdapter({
    configPath: f.configPath,
    clientFactory: () => ({ request: async () => { throw new Error('Coordinator unavailable: Coordinator request timed out'); } }),
  });
  await assert.rejects(slow.runs(), error => error.kind === 'coordinator-timeout');

  for (const error of [
    new Error('Coordinator unavailable: Coordinator response is too large'),
    Object.assign(new Error('Coordinator unavailable: hidden transport detail'), { code: 'response-too-large' }),
  ]) {
    const oversized = createCoordinatorAdapter({
      configPath: f.configPath,
      clientFactory: () => ({ request: async () => { throw error; } }),
    });
    await assert.rejects(oversized.projects(), mapped => mapped.kind === 'coordinator-response-too-large' && !mapped.message.includes('hidden'));
  }

  // Failure drops the cached client: the next call reloads configuration and key.
  let reads = 0;
  let healthy = false;
  const reconnecting = createCoordinatorAdapter({
    configPath: f.configPath,
    readToken: async () => { reads++; return 'a'.repeat(64); },
    clientFactory: () => ({ request: async (_method, route) => { if (!healthy) throw new Error('Coordinator unavailable: connect ECONNREFUSED'); return route.startsWith('/run-list') ? { runs: [], total: 0, nextCursor: null, through: 0 } : []; } }),
  });
  await assert.rejects(reconnecting.projects(), error => error.kind === 'coordinator-offline');
  await assert.rejects(reconnecting.projects(), error => error.kind === 'coordinator-offline');
  assert.equal(reads, 2);
  healthy = true;
  assert.deepEqual(await reconnecting.projects(), []);
  assert.deepEqual(await reconnecting.runs(), []);
  assert.equal(reads, 3);
});

test('adapter exposes no mutating method and issues only GET requests on allowed routes', async () => {
  const calls = [];
  const adapter = createCoordinatorAdapter({
    loadConfiguration: async () => ({ stateDirectory: '/unused', endpoint: '/unused/coordinator.sock', globalConcurrency: 1, projectConcurrency: 1 }),
    readToken: async () => 'b'.repeat(64),
    clientFactory: (endpoint, token, options) => {
      assert.equal(options.timeoutMs, 8000);
      return {
        request: async (...args) => { calls.push(args); return args[1].startsWith('/run-list') ? { runs: [], total: 0, nextCursor: null, through: 0 } : []; },
        // Anything beyond `request` would be a mutation path; the adapter never sees one.
      };
    },
  });
  // The reads, plus exactly the two narrow owner responses (covered by the approval tests); nothing else can write.
  assert.deepEqual(Object.keys(adapter).sort(), ['decideApproval', 'events', 'projects', 'respondToPause', 'run', 'runs']);
  await adapter.projects();
  await adapter.runs();
  await adapter.run('run_1-A');
  await adapter.events(7);
  assert.deepEqual(calls, [
    ['GET', '/projects'], ['GET', '/run-list?after=0'], ['GET', '/runs/run_1-A'], ['GET', '/events?after=7'],
  ]);
  const source = await fs.readFile(path.join(root, 'src', 'extension', 'service', 'coordinator.ts'), 'utf8');
  // One POST call site, fed only by the two route builders; no other verb and no other coordinator route.
  assert.equal((source.match(/'POST'/g) ?? []).length, 1);
  assert.doesNotMatch(source, /'(PUT|PATCH|DELETE)'/);
  assert.deepEqual([...source.matchAll(/post\(`([^`]*)`/g)].map(match => match[1]), ['/runs/${runId}/approvals/${requestId}/decision', '/runs/${runId}/respond']);
  assert.doesNotMatch(source, /\/reconcile|\/resume|\/checkpoint|\/binding|\/receipts?/);
});

test('an older coordinator reports an explicit update requirement without fetching the full history', async () => {
  const calls = [];
  const adapter = createCoordinatorAdapter({
    loadConfiguration: async () => ({ stateDirectory: '/unused', endpoint: '/unused/coordinator.sock', globalConcurrency: 1, projectConcurrency: 1 }),
    readToken: async () => 'b'.repeat(64),
    clientFactory: () => ({ request: async (method, route) => {
      calls.push([method, route]);
      throw Object.assign(new Error('Unknown coordinator route'), { statusCode: 404 });
    } }),
  });
  await assert.rejects(adapter.runs(), error => error.kind === 'coordinator-incompatible');
  assert.deepEqual(calls, [['GET', '/run-list?after=0']]);
});

test('built service bundle has no node:sqlite, refuses to start without env, and enforces auth', async t => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), 'hd-ext-'));
  t.after(() => fs.rm(out, { recursive: true, force: true }));
  await execFileAsync(process.execPath, [path.join(root, 'scripts', 'build-extension.mjs'), '--out', out], { cwd: root });
  const bundle = await fs.readFile(path.join(out, 'service', 'main.js'), 'utf8');
  assert.equal(bundle.includes('node:sqlite'), false);
  assert.equal(bundle.includes('DatabaseSync'), false);
  assert.equal(bundle.includes('OPENCHAMBER_SERVICE_TOKEN'), true);

  const entry = path.join(out, 'service', 'main.js');
  const missing = await new Promise(resolve => execFile(process.execPath, [entry], { env: { PATH: process.env.PATH } }, (error, stdout, stderr) => resolve({ code: error?.code, stdout, stderr })));
  assert.equal(missing.code, 1);
  assert.equal(missing.stdout, '');

  const port = await new Promise(resolve => { const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
  // Short path: the default state directory is HOME-relative and Unix socket paths are length-limited.
  const home = await fs.mkdtemp(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'hd-home-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const child = spawn(process.execPath, [entry], { env: { PATH: process.env.PATH, HOME: home, OPENCHAMBER_SERVICE_PORT: String(port), OPENCHAMBER_SERVICE_TOKEN: SERVICE_TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const probe = { address: () => ({ port }) };
  let health;
  for (let attempt = 0; attempt < 100 && !health; attempt++) {
    try { health = await call(probe, { path: '/health' }); }
    catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.equal(health?.status, 200, output);
  assert.equal((await call(probe, { token: 'nope' })).status, 401);
  // HOME has no coordinator: offline, sanitized, and nothing is written to the console.
  const status = await call(probe, { path: '/status' });
  assert.equal(status.json.connected, false);
  assert.equal(status.json.error.kind, 'coordinator-offline');
  assert.equal(output, '');
  assert.equal(output.includes(SERVICE_TOKEN), false);
});

// ----- owner responses: the only two writes -----

const FAKE_KEY = 'k'.repeat(64);
const RUN_CAPABILITY = 'run-capability-' + 'f'.repeat(24);

/** A recording adapter whose run carries a pending approval; any call the routes should not make is counted. */
function recordingAdapter({ wait, version = 7, answer, failure } = {}) {
  const calls = { run: 0, decide: [], respond: [], other: 0 };
  const pending = {
    kind: 'approval', requestId: 'apr_1', state: 'pending', continuation: 'none', progress: 'none', phase: 'executor', taskIndex: 0, taskId: 'T1', taskTitle: 'Task',
    attemptId: 'attempt_secret', question: 'Q?', scope: 'S', completedWork: 'C', verification: [], artifacts: [], onApprove: [], onRequestChanges: [],
    revision: { head: 'a'.repeat(40), digest: 'b'.repeat(64) }, response: null, createdAt: 1, clipped: {},
  };
  const adapter = {
    async run(id) {
      calls.run++;
      return { id, version, status: 'paused', wait: wait === undefined ? pending : wait, ownerToken: RUN_CAPABILITY, checkpoint: { raw: 'RAW-CHECKPOINT' }, specification: { secret: FAKE_KEY } };
    },
    async decideApproval(...args) {
      calls.decide.push(args);
      if (failure) throw failure;
      return answer ?? { runId: args[0], requestId: args[1], decision: args[2].decision, recordedAt: 5, retried: false, continuation: 'queued', run: { status: 'queued', version: version + 1 }, ownerToken: RUN_CAPABILITY, coordinatorKey: FAKE_KEY };
    },
    async respondToPause(...args) {
      calls.respond.push(args);
      if (failure) throw failure;
      return answer ?? { runId: args[0], pauseId: args[1].pauseId, recordedAt: 5, retried: false, continuation: 'queued', run: { status: 'queued', version: version + 1 }, ownerToken: RUN_CAPABILITY };
    },
    async projects() { calls.other++; return []; },
    async runs() { calls.other++; return []; },
    async events() { calls.other++; return []; },
  };
  return { adapter, calls, pending };
}

const DECISION = '/runs/run_1/approvals/apr_1/decision';
const PAUSE = '/runs/run_1/pause-response';
const post = (server, target, body, options = {}) => call(server, { method: 'POST', path: target, body: typeof body === 'string' ? body : JSON.stringify(body), ...options });

test('only the two response routes accept POST: every other POST is refused before any coordinator call', async t => {
  const { adapter, calls } = recordingAdapter();
  const server = await listening(t, { token: SERVICE_TOKEN, adapter });
  const unknown = [
    '/runs/run_1/resume', '/runs/run_1/respond', '/runs/run_1/reconcile', '/runs/run_1/stop', '/runs/run_1/cancel', '/runs/run_1/pause',
    '/runs/run_1/approvals/apr_1', '/runs/run_1/approvals/apr_1/decision/extra', '/runs/run_1/approvals/apr_1/approve', '/runs/run_1/pause-response/x',
    '/runs/run_1/approvals/decision', '/runs', '/runs/run_1', '/runs/run_1/blocker', '/runs/run_1/review', '/runs/run_1/review/file', '/projects',
    '/status', '/changes', '/health', '/events', '/exec', '/shell', '/proxy', '/runs/run_1/tasks/0',
  ];
  for (const target of unknown) {
    const answer = await post(server, target, '{}').catch(error => assert.fail(`${target}: ${error.message}`));
    assert.ok(answer.status === 404 || answer.status === 405, `${target} gave ${answer.status}`);
  }
  for (const method of ['PUT', 'PATCH', 'DELETE']) {
    for (const target of [DECISION, PAUSE]) assert.equal((await call(server, { method, path: target, ...(method === 'DELETE' ? {} : { body: '{}' }) }).catch(error => assert.fail(`${method} ${target}: ${error.message}`))).status, 405, `${method} ${target}`);
  }
  assert.equal((await call(server, { path: DECISION })).status, 405);
  assert.equal((await call(server, { path: PAUSE })).status, 405);
  assert.deepEqual({ ...calls, decide: calls.decide.length, respond: calls.respond.length }, { run: 0, decide: 0, respond: 0, other: 0 });
});

test('response routes require the service token', async t => {
  const { adapter, calls } = recordingAdapter();
  const server = await listening(t, { token: SERVICE_TOKEN, adapter });
  const body = { decision: 'approve', displayedVersion: 7 };
  for (const target of [DECISION, PAUSE]) {
    for (const token of [null, 'nope', FAKE_KEY, '']) {
      const answer = await post(server, target, body, { token });
      assert.equal(answer.status, 401, `${target} with ${JSON.stringify(token)}`);
      assert.equal(answer.json.error.kind, 'unauthorized');
    }
  }
  assert.deepEqual({ run: calls.run, decide: calls.decide.length, respond: calls.respond.length }, { run: 0, decide: 0, respond: 0 });
});

test('response routes validate identifiers, enums, sizes and fields before the coordinator is contacted', async t => {
  const { adapter, calls } = recordingAdapter();
  const server = await listening(t, { token: SERVICE_TOKEN, adapter });
  const approve = { decision: 'approve', displayedVersion: 7 };
  const bodies = {
    'unknown decision': { decision: 'maybe', displayedVersion: 7 },
    'missing decision': { displayedVersion: 7 },
    'missing version': { decision: 'approve' },
    'fractional version': { decision: 'approve', displayedVersion: 1.5 },
    'negative version': { decision: 'approve', displayedVersion: -1 },
    'string version': { decision: 'approve', displayedVersion: '7' },
    'approve with feedback': { ...approve, feedback: 'why' },
    'request without feedback': { decision: 'request-changes', displayedVersion: 7 },
    'blank feedback': { decision: 'request-changes', feedback: '  \n ', displayedVersion: 7 },
    'numeric feedback': { decision: 'request-changes', feedback: 5, displayedVersion: 7 },
    'oversize feedback': { decision: 'request-changes', feedback: 'x'.repeat(8001), displayedVersion: 7 },
    'extra field': { ...approve, runId: 'other' },
    'forged capability': { ...approve, ownerToken: RUN_CAPABILITY },
    array: [approve],
    string: 'approve',
    null: null,
  };
  for (const [name, body] of Object.entries(bodies)) {
    const answer = await post(server, DECISION, body);
    assert.equal(answer.status, 400, name);
    assert.equal(answer.json.error.kind, 'invalid-request', name);
  }
  assert.equal((await post(server, DECISION, '{not json')).status, 400);
  assert.equal((await post(server, DECISION, '')).status, 400);
  // Larger than the route's body cap: refused while reading, never parsed.
  assert.equal((await post(server, DECISION, JSON.stringify({ decision: 'request-changes', feedback: 'y'.repeat(70 * 1024), displayedVersion: 7 }))).status, 413);
  for (const target of ['/runs/..%2f/approvals/apr_1/decision', '/runs/run_1/approvals/%2e%2e/decision', `/runs/${'a'.repeat(129)}/approvals/apr_1/decision`, `/runs/run_1/approvals/${'b'.repeat(129)}/decision`, '/runs/run%201/approvals/apr_1/decision', '/runs/-run/approvals/apr_1/decision', '/runs/run_1/approvals/-apr/decision']) {
    const answer = await post(server, target, approve);
    assert.ok([400, 404].includes(answer.status), `${target} gave ${answer.status}`);
  }

  const pause = { pauseId: 'pau_' + 'a'.repeat(32), input: 'go ahead', displayedVersion: 7 };
  const pauseBodies = {
    'missing pause': { input: 'go', displayedVersion: 7 },
    'bad pause': { ...pause, pauseId: '../x' },
    'long pause': { ...pause, pauseId: 'p'.repeat(129) },
    'missing input': { pauseId: pause.pauseId, displayedVersion: 7 },
    'blank input': { ...pause, input: '   ' },
    'oversize input': { ...pause, input: 'z'.repeat(8001) },
    'non-string input': { ...pause, input: ['x'] },
    'bad version': { ...pause, displayedVersion: 'x' },
    'extra field': { ...pause, decision: 'approve' },
  };
  for (const [name, body] of Object.entries(pauseBodies)) {
    const answer = await post(server, PAUSE, body);
    assert.equal(answer.status, 400, name);
  }
  assert.equal((await post(server, PAUSE, JSON.stringify({ ...pause, input: 'y'.repeat(70 * 1024) }))).status, 413);
  assert.equal((await post(server, '/runs/..%2fx/pause-response', pause)).status, 404);
  assert.equal((await post(server, `/runs/${'r'.repeat(129)}/pause-response`, pause)).status, 404);
  assert.deepEqual({ run: calls.run, decide: calls.decide.length, respond: calls.respond.length, other: calls.other }, { run: 0, decide: 0, respond: 0, other: 0 });

  // Exactly the limit is accepted.
  assert.equal((await post(server, DECISION, { decision: 'request-changes', feedback: 'x'.repeat(8000), displayedVersion: 7 })).status, 200);
  assert.equal(calls.decide.length, 1);
});

test('a decision is forwarded for exactly the run and request on the card; the acknowledgement carries nothing else', async t => {
  const { adapter, calls } = recordingAdapter();
  const server = await listening(t, { token: SERVICE_TOKEN, adapter, now: () => new Date('2026-03-09T12:00:00Z') });
  const feedback = 'Add a rollback.\nKeep "quotes" and --dashes.';
  const answer = await post(server, DECISION, { decision: 'request-changes', feedback, displayedVersion: 7 });
  assert.equal(answer.status, 200);
  assert.deepEqual(calls.decide, [['run_1', 'apr_1', { decision: 'request-changes', feedback }]]);
  assert.deepEqual(answer.json, {
    ack: { runId: 'run_1', recordedAt: 5, retried: false, continuation: 'queued', run: { status: 'queued', version: 8 }, requestId: 'apr_1', decision: 'request-changes' },
    fetchedAt: '2026-03-09T12:00:00.000Z',
  });
  for (const secret of [FAKE_KEY, RUN_CAPABILITY, 'coordinatorKey', 'ownerToken', 'RAW-CHECKPOINT']) assert.equal(answer.text.includes(secret), false, secret);

  const approve = await post(server, DECISION, { decision: 'approve', displayedVersion: 7 });
  assert.equal(approve.status, 200);
  assert.deepEqual(calls.decide[1], ['run_1', 'apr_1', { decision: 'approve' }]);
});

test('a card that no longer matches the run is refused without a coordinator write', async t => {
  const pending = recordingAdapter();
  const server = await listening(t, { token: SERVICE_TOKEN, adapter: pending.adapter });
  const refuse = async (target, body) => {
    const answer = await post(server, target, body);
    assert.equal(answer.status, 409, JSON.stringify(body));
    assert.equal(answer.json.error.kind, 'stale-card');
    return answer;
  };
  await refuse(DECISION, { decision: 'approve', displayedVersion: 6 });
  await refuse('/runs/run_1/approvals/apr_other/decision', { decision: 'approve', displayedVersion: 7 });
  await refuse(PAUSE, { pauseId: 'pau_x', input: 'go', displayedVersion: 7 });
  assert.equal(pending.calls.decide.length + pending.calls.respond.length, 0);

  const answered = recordingAdapter({ wait: { ...recordingAdapter().pending, state: 'answered' } });
  const second = await listening(t, { token: SERVICE_TOKEN, adapter: answered.adapter });
  assert.equal((await post(second, DECISION, { decision: 'approve', displayedVersion: 7 })).status, 409);
  const none = recordingAdapter({ wait: null });
  const third = await listening(t, { token: SERVICE_TOKEN, adapter: none.adapter });
  assert.equal((await post(third, DECISION, { decision: 'approve', displayedVersion: 7 })).status, 409);
  assert.equal((await post(third, PAUSE, { pauseId: 'pau_x', input: 'go', displayedVersion: 7 })).status, 409);
  const generic = recordingAdapter({ wait: { kind: 'generic', pauseId: 'pau_a', reason: 'r', reasonClipped: false } });
  const fourth = await listening(t, { token: SERVICE_TOKEN, adapter: generic.adapter });
  assert.equal((await post(fourth, DECISION, { decision: 'approve', displayedVersion: 7 })).status, 409, 'a generic pause is never answered as an approval');
  assert.equal((await post(fourth, PAUSE, { pauseId: 'pau_b', input: 'go', displayedVersion: 7 })).status, 409);
  const ok = await post(fourth, PAUSE, { pauseId: 'pau_a', input: 'go', displayedVersion: 7 });
  assert.equal(ok.status, 200);
  assert.deepEqual(generic.calls.respond, [['run_1', { pauseId: 'pau_a', input: 'go' }]]);
  assert.deepEqual(ok.json.ack, { runId: 'run_1', recordedAt: 5, retried: false, continuation: 'queued', run: { status: 'queued', version: 8 }, pauseId: 'pau_a' });
  assert.equal([answered, none].reduce((sum, entry) => sum + entry.calls.decide.length + entry.calls.respond.length, 0), 0);
});

test('an acknowledgement for a different target or an unreadable one is reported as unconfirmed, never as success', async t => {
  const wrong = recordingAdapter({ answer: { runId: 'run_1', requestId: 'apr_other', decision: 'approve', recordedAt: 5, retried: false, continuation: 'queued', run: { status: 'queued', version: 8 } } });
  const server = await listening(t, { token: SERVICE_TOKEN, adapter: wrong.adapter });
  const answer = await post(server, DECISION, { decision: 'approve', displayedVersion: 7 });
  assert.equal(answer.status, 502);
  assert.equal(answer.json.error.kind, 'delivery-uncertain');
  const garbled = recordingAdapter({ answer: { nonsense: true } });
  const second = await listening(t, { token: SERVICE_TOKEN, adapter: garbled.adapter });
  assert.equal((await post(second, PAUSE, { pauseId: 'pau_a', input: 'go', displayedVersion: 7 })).status, 409, 'the card does not match, so nothing is sent');
});

test('coordinator refusals and failures reach the panel as fixed text without coordinator messages or secrets', async t => {
  const secretText = `boom ${FAKE_KEY} ${RUN_CAPABILITY} /Users/someone/.local/state/heimdall/coordinator.key`;
  const cases = [
    [{ statusCode: 409, code: 'approval-stale' }, 409, 'approval-stale'],
    [{ statusCode: 409, code: 'approval-conflict' }, 409, 'approval-conflict'],
    [{ statusCode: 409, code: 'pause-stale' }, 409, 'pause-stale'],
    [{ statusCode: 409, code: 'pause-not-ready' }, 409, 'pause-not-ready'],
    [{ statusCode: 409, code: 'response-conflict' }, 409, 'response-conflict'],
    [{ statusCode: 409, code: 'approval-pending' }, 409, 'approval-pending'],
    [{ statusCode: 409, code: 'something-new' }, 409, 'response-refused'],
    [{ statusCode: 400 }, 409, 'response-refused'],
    [{ statusCode: 404, code: 'approval-not-found' }, 404, 'not-found'],
    [{ statusCode: 404, message: 'Unknown coordinator route' }, 503, 'coordinator-unsupported'],
    [{ statusCode: 503, message: 'Coordinator is draining; new work is disabled' }, 503, 'coordinator-draining'],
    [{ statusCode: 401 }, 503, 'coordinator-unauthorized'],
    [{ statusCode: 403 }, 503, 'coordinator-unauthorized'],
    [{ code: 'ECONNREFUSED', message: 'Coordinator unavailable: connect ECONNREFUSED' }, 503, 'coordinator-offline'],
    [{ code: 'ENOENT', message: 'Coordinator unavailable: connect ENOENT' }, 503, 'coordinator-offline'],
    [{ message: 'Coordinator request timed out' }, 502, 'delivery-uncertain'],
    [{ code: 'ECONNRESET', message: 'Coordinator unavailable: socket hang up' }, 502, 'delivery-uncertain'],
    [{ message: 'Invalid coordinator JSON response' }, 502, 'delivery-uncertain'],
  ];
  const decide = { decision: 'approve', displayedVersion: 7 };
  const respond = { pauseId: 'pau_a', input: 'go', displayedVersion: 7 };
  for (const [failure, status, kind] of cases) {
    const error = Object.assign(new Error(failure.message ?? secretText), failure);
    const reads = [];
    const adapter = createCoordinatorAdapter({
      loadConfiguration: async () => ({ stateDirectory: '/unused', endpoint: '/unused/coordinator.sock', globalConcurrency: 1, projectConcurrency: 1 }),
      readToken: async () => FAKE_KEY,
      clientFactory: () => ({ request: async (method, route, body) => {
        reads.push([method, route, body]);
        if (method === 'POST') throw error;
        return route === '/projects' ? [] : { id: 'run_1', version: 7, status: 'paused', wait: { kind: 'approval', requestId: 'apr_1', state: 'pending', continuation: 'none', progress: 'none' } };
      } }),
    });
    const server = await listening(t, { token: SERVICE_TOKEN, adapter });
    for (const [target, body] of [[DECISION, decide], [PAUSE, respond]]) {
      // The pause route needs a generic wait on screen; use a coordinator that reports one.
      const answered = target === PAUSE ? await (async () => {
        const generic = createCoordinatorAdapter({
          loadConfiguration: async () => ({ stateDirectory: '/unused', endpoint: '/unused/coordinator.sock', globalConcurrency: 1, projectConcurrency: 1 }),
          readToken: async () => FAKE_KEY,
          clientFactory: () => ({ request: async method => { if (method === 'POST') throw error; return { id: 'run_1', version: 7, status: 'paused', wait: { kind: 'generic', pauseId: 'pau_a', reason: 'r', reasonClipped: false } }; } }),
        });
        return post(await listening(t, { token: SERVICE_TOKEN, adapter: generic }), target, body);
      })() : await post(server, target, body);
      assert.equal(answered.status, status, `${target} ${JSON.stringify(failure)}`);
      assert.equal(answered.json.error.kind, kind, `${target} ${JSON.stringify(failure)}`);
      for (const secret of [FAKE_KEY, RUN_CAPABILITY, 'coordinator.key', '/Users/', 'boom', 'draining; new work', 'Unknown coordinator route', 'ECONN']) {
        assert.equal(answered.text.includes(secret), false, `${secret} leaked for ${JSON.stringify(failure)}`);
      }
    }
    // Only the two coordinator routes were ever posted to, with only the validated body fields.
    for (const [method, route, body] of reads.filter(entry => entry[0] === 'POST')) {
      assert.equal(method, 'POST');
      assert.ok(route === '/runs/run_1/approvals/apr_1/decision' || route === '/runs/run_1/respond', route);
      assert.deepEqual(Object.keys(body).sort(), route.endsWith('/decision') ? ['decision'] : ['input', 'pauseId']);
    }
  }
});

test('the adapter writes only to the two coordinator routes, with validated identifiers', async () => {
  const calls = [];
  const adapter = createCoordinatorAdapter({
    loadConfiguration: async () => ({ stateDirectory: '/unused', endpoint: '/unused/coordinator.sock', globalConcurrency: 1, projectConcurrency: 1 }),
    readToken: async () => FAKE_KEY,
    clientFactory: () => ({ request: async (...args) => { calls.push(args); return {}; } }),
  });
  await adapter.decideApproval('run_1', 'apr_1', { decision: 'approve' });
  await adapter.decideApproval('run_1', 'apr_1', { decision: 'request-changes', feedback: 'fix it' });
  await adapter.respondToPause('run_1', { pauseId: 'pau_a', input: 'go' });
  assert.deepEqual(calls, [
    ['POST', '/runs/run_1/approvals/apr_1/decision', { decision: 'approve' }],
    ['POST', '/runs/run_1/approvals/apr_1/decision', { decision: 'request-changes', feedback: 'fix it' }],
    ['POST', '/runs/run_1/respond', { pauseId: 'pau_a', input: 'go' }],
  ]);
  for (const bad of ['../x', 'a/b', '', 'x'.repeat(129), '%2e%2e']) {
    await assert.rejects(adapter.decideApproval(bad, 'apr_1', { decision: 'approve' }), error => error.kind === 'not-found');
    await assert.rejects(adapter.decideApproval('run_1', bad, { decision: 'approve' }), error => error.kind === 'not-found');
    await assert.rejects(adapter.respondToPause('run_1', { pauseId: bad, input: 'go' }), error => error.kind === 'not-found');
  }
  assert.equal(calls.length, 3);
});

test('run projections carry the bounded wait and no coordinator key, run capability or raw checkpoint', async t => {
  const { adapter } = recordingAdapter();
  const server = await listening(t, { token: SERVICE_TOKEN, adapter });
  const shown = await call(server, { path: '/runs/run_1' });
  assert.equal(shown.status, 200);
  assert.equal(shown.json.run.version, 7);
  assert.equal(shown.json.run.wait.kind, 'approval');
  assert.equal(shown.json.run.wait.requestId, 'apr_1');
  for (const secret of [FAKE_KEY, RUN_CAPABILITY, 'RAW-CHECKPOINT', 'attempt_secret', 'ownerToken', 'specification']) assert.equal(shown.text.includes(secret), false, secret);
});
