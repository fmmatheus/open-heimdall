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
  for (const target of ['/runs/x/resume', '/../etc/passwd', '/%2e%2e/etc/passwd', '/runs/%2e%2e/%2e%2e/health', '/health/', '//health', '/health/..', '/.%2e/health', '/status/extra', '/%2fhealth', '/\\health', '/', '/projects', '/runs']) {
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
      { method: 'GET', path: '/runs/:id', handler: context => ({ id: context.params.id, query: context.query.get('q') }) },
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
  assert.equal((await call(server, { method: 'POST', path: '/runs/abc', body: 'z'.repeat(40000) })).status, 405);

  assert.deepEqual((await call(server, { path: '/runs/abc?q=1' })).json, { id: 'abc', query: '1' });

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

  // Failure drops the cached client: the next call reloads configuration and key.
  let reads = 0;
  let healthy = false;
  const reconnecting = createCoordinatorAdapter({
    configPath: f.configPath,
    readToken: async () => { reads++; return 'a'.repeat(64); },
    clientFactory: () => ({ request: async () => { if (!healthy) throw new Error('Coordinator unavailable: connect ECONNREFUSED'); return []; } }),
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
        request: async (...args) => { calls.push(args); return []; },
        // Anything beyond `request` would be a mutation path; the adapter never sees one.
      };
    },
  });
  assert.deepEqual(Object.keys(adapter).sort(), ['events', 'projects', 'run', 'runs']);
  await adapter.projects();
  await adapter.runs();
  await adapter.run('run_1-A');
  await adapter.events(7);
  assert.deepEqual(calls, [
    ['GET', '/projects'], ['GET', '/runs'], ['GET', '/runs/run_1-A'], ['GET', '/events?after=7'],
  ]);
  const source = await fs.readFile(path.join(root, 'src', 'extension', 'service', 'coordinator.ts'), 'utf8');
  assert.doesNotMatch(source, /'(POST|PUT|PATCH|DELETE)'/);
  assert.doesNotMatch(source, /\/reconcile|\/resume|\/checkpoint|\/binding|\/receipts?/);
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
