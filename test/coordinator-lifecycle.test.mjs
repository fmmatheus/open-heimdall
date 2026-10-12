import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { startCoordinatorService, readCoordinatorToken } from '../dist/coordinator/service.js';
import { createCoordinatorClient } from '../dist/coordinator/client.js';
import { acquireCoordinatorOwnership } from '../dist/coordinator/ownership.js';
import { COORDINATOR_LIFECYCLE_PROTOCOL, fetchCoordinatorLifecycle, parseCoordinatorLifecycle, readInstanceRecord } from '../dist/coordinator/lifecycle.js';

const posix = process.platform !== 'win32';
const settings = { plannerAgent: 'planner', executorAgent: 'executor', plannerModel: 'anthropic/planner', executorModel: 'anthropic/executor', executorFallbackModel: 'kimi/fallback', maxTasks: 10, minQuotaRemainingPercent: 10, tokenLimitsDisabled: true };
const specification = { settings, plannerPrompt: 'Synthetic planner', executorPrompt: 'Synthetic executor', agents: {}, opencode: { baseUrl: 'http://127.0.0.1:4321', passwordEnvironmentVariable: 'SYNTHETIC_PASSWORD' } };
const idleExecutor = { launch: async () => new Promise(() => {}), inspect: async () => ({ idle: true, status: 'failed' }), interrupt: async () => { throw new Error('Lifecycle identity must not interrupt native execution'); } };
const scheduler = { createWorktree: async () => {}, verifyWorktree: async () => {}, prepare: async () => {} };
const turn = () => new Promise(resolve => setImmediate(resolve));

async function temporaryRoot(t) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hdl-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  return temporary;
}

function configurationFor(stateDirectory) {
  const endpoint = posix ? path.join(stateDirectory, 'coordinator.sock') : '\\\\.\\pipe\\heimdall-lifecycle-' + randomUUID();
  return { stateDirectory, endpoint, globalConcurrency: 1, projectConcurrency: 2 };
}

function start(stateDirectory, extra = {}) {
  return startCoordinatorService({ configuration: configurationFor(stateDirectory), executor: idleExecutor, scheduler, pollIntervalMs: 5, ...extra });
}

async function sha256(file) { return createHash('sha256').update(await fs.readFile(file)).digest('hex'); }

async function runningFixture(t, extra = {}) {
  const temporary = await temporaryRoot(t);
  const stateDirectory = path.join(temporary, 'state');
  const service = await start(stateDirectory, extra);
  let closed = false;
  t.after(async () => { if (!closed) await service.close().catch(() => {}); });
  const admin = createCoordinatorClient(service.endpoint, await readCoordinatorToken(stateDirectory));
  return { temporary, stateDirectory, service, admin, close: async () => { closed = true; await service.close(); } };
}

function spawnHolder(script, environment) {
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', script], { env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const ready = new Promise((resolve, reject) => {
    let stdout = '';
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.includes('holding\n')) resolve(); });
    child.once('exit', code => reject(new Error(`holder exited early (${code}): ${stderr}`)));
  });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, ready, exited };
}

const moduleUrl = name => pathToFileURL(path.resolve('dist/coordinator', name)).href;
const ownershipHolder = `import { acquireCoordinatorOwnership } from ${JSON.stringify(moduleUrl('ownership.js'))};
await acquireCoordinatorOwnership(process.env.HOLDER_STATE);
process.stdout.write('holding\\n');
setInterval(() => {}, 1000);`;
const serviceHolder = `import { startCoordinatorService } from ${JSON.stringify(moduleUrl('service.js'))};
const state = process.env.HOLDER_STATE;
await startCoordinatorService({ configuration: { stateDirectory: state, endpoint: state + '/coordinator.sock', globalConcurrency: 1, projectConcurrency: 1 } });
process.stdout.write('holding\\n');
setInterval(() => {}, 1000);`;

test('a second coordinator for the same canonical state is refused without side effects and may start after close', { skip: !posix }, async t => {
  const f = await runningFixture(t);
  const key = path.join(f.stateDirectory, 'coordinator.key');
  const database = path.join(f.stateDirectory, 'coordinator.sqlite');
  const before = { entries: (await fs.readdir(f.stateDirectory)).sort(), key: await sha256(key), database: (await fs.stat(database)).size, record: await readInstanceRecord(f.stateDirectory) };
  const alias = path.join(f.temporary, 'alias');
  await fs.symlink(f.stateDirectory, alias, 'dir');
  const spellings = [
    f.stateDirectory,
    path.join(f.stateDirectory, '..', 'state', '.'),
    alias,
    path.join(alias, '..', 'alias'),
  ];
  for (const spelling of spellings) {
    await assert.rejects(start(spelling), /another coordinator owns this state/i, spelling);
    await assert.rejects(start(spelling, { lifecycle: { mode: 'managed', label: 'dev.example.coordinator' } }), /another coordinator owns this state/i, spelling);
  }
  assert.deepEqual((await fs.readdir(f.stateDirectory)).sort(), before.entries);
  assert.equal(await sha256(key), before.key);
  assert.equal((await fs.stat(database)).size, before.database);
  assert.deepEqual(await readInstanceRecord(f.stateDirectory), before.record, 'refusals keep the owner identity record');
  const lifecycle = await fetchCoordinatorLifecycle(f.admin);
  assert.equal(lifecycle.instanceId, before.record.instanceId, 'the first coordinator keeps serving');
  await f.close();
  const second = await start(alias);
  t.after(() => second.close());
  assert.notEqual(second.instance.instanceId, before.record.instanceId);
  assert.equal((await readInstanceRecord(f.stateDirectory)).instanceId, second.instance.instanceId);
  assert.equal(second.instance.stateDirectory, f.stateDirectory);
});

test('ownership is taken before the endpoint, key, database or lifecycle record are created', { skip: !posix }, async t => {
  const temporary = await temporaryRoot(t);
  const stateDirectory = path.join(temporary, 'state');
  await fs.mkdir(stateDirectory, { mode: 0o700 });
  const holder = spawnHolder(ownershipHolder, { HOLDER_STATE: stateDirectory });
  t.after(() => holder.child.kill('SIGKILL'));
  await holder.ready;
  assert.deepEqual(await fs.readdir(stateDirectory), ['coordinator.owner.sqlite']);
  await assert.rejects(start(stateDirectory), /another coordinator owns this state/i);
  await assert.rejects(start(stateDirectory), /another coordinator owns this state/i, 'a refused attempt does not drop the holder lock');
  assert.deepEqual(await fs.readdir(stateDirectory), ['coordinator.owner.sqlite']);
  holder.child.kill('SIGKILL');
  assert.equal((await holder.exited).signal, 'SIGKILL');
  const service = await start(stateDirectory);
  t.after(() => service.close());
  assert.ok((await fs.readdir(stateDirectory)).includes('coordinator.key'));
});

test('a killed owning process releases ownership without lock file repair', { skip: !posix, timeout: 30000 }, async t => {
  const temporary = await temporaryRoot(t);
  const stateDirectory = path.join(temporary, 'state');
  const holder = spawnHolder(serviceHolder, { HOLDER_STATE: stateDirectory });
  t.after(() => holder.child.kill('SIGKILL'));
  await holder.ready;
  const lockFile = path.join(stateDirectory, 'coordinator.owner.sqlite');
  const lockStat = await fs.stat(lockFile);
  await assert.rejects(acquireCoordinatorOwnership(stateDirectory), /another coordinator owns this state/i);
  await assert.rejects(start(stateDirectory), /another coordinator owns this state/i, 'ownership is checked before the live endpoint');
  const record = await readInstanceRecord(stateDirectory);
  assert.equal(record.pid, holder.child.pid);
  holder.child.kill('SIGKILL');
  assert.equal((await holder.exited).signal, 'SIGKILL');
  // The crashed owner leaves its lock file, socket and instance record behind; none is repaired or removed.
  assert.equal((await fs.stat(lockFile)).ino, lockStat.ino);
  await fs.lstat(path.join(stateDirectory, 'coordinator.sock'));
  const reacquired = await acquireCoordinatorOwnership(stateDirectory);
  assert.equal(reacquired.lockPath, lockFile);
  assert.equal((await fs.stat(lockFile)).ino, lockStat.ino, 'the same lock file is reused without repair');
  reacquired.release();
  await assert.rejects(start(stateDirectory), /endpoint already exists/, 'ownership is free; the stale endpoint is reported, not repaired');
  assert.equal((await readInstanceRecord(stateDirectory)).instanceId, record.instanceId, 'refused starts leave the crash record untouched');
});

async function lifecycleResponse(endpoint, token, route = '/lifecycle') {
  return new Promise((resolve, reject) => {
    const headers = token === undefined ? {} : { Authorization: `Bearer ${token}` };
    const request = http.request({ socketPath: endpoint, path: route, method: 'GET', headers }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ statusCode: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('GET /lifecycle returns the validated versioned identity and a new instance after restart', async t => {
  const f = await runningFixture(t, { lifecycle: { mode: 'managed', label: 'dev.example.coordinator.abc' } });
  const body = await f.admin.request('GET', '/lifecycle');
  const lifecycle = parseCoordinatorLifecycle(body);
  assert.deepEqual(lifecycle, body);
  assert.equal(lifecycle.lifecycleProtocol, COORDINATOR_LIFECYCLE_PROTOCOL);
  assert.equal(lifecycle.service, 'heimdall-coordinator');
  assert.equal(lifecycle.pid, process.pid);
  assert.equal(lifecycle.mode, 'managed');
  assert.equal(lifecycle.manager, 'dev.example.coordinator.abc');
  assert.equal(lifecycle.stateDirectory, f.stateDirectory);
  assert.equal(lifecycle.endpoint, f.service.endpoint);
  assert.equal(lifecycle.phase, 'running');
  assert.equal(lifecycle.shutdown, null);
  assert.deepEqual(await fetchCoordinatorLifecycle(f.admin), lifecycle);
  assert.deepEqual(await readInstanceRecord(f.stateDirectory), { instanceId: lifecycle.instanceId, pid: lifecycle.pid, startedAt: lifecycle.startedAt, stateDirectory: lifecycle.stateDirectory, endpoint: lifecycle.endpoint, mode: 'managed', manager: 'dev.example.coordinator.abc' });
  // The status schema stays untouched by the lifecycle contract.
  assert.deepEqual(Object.keys(await f.admin.request('GET', '/status')).sort(), ['acceptingNewRuns', 'queuedRuns', 'reservedRuns', 'schemaVersion', 'service', 'status']);
  await f.close();
  const again = await start(f.stateDirectory);
  t.after(() => again.close());
  const next = await createCoordinatorClient(again.endpoint, await readCoordinatorToken(f.stateDirectory)).request('GET', '/lifecycle');
  assert.equal(next.mode, 'foreground');
  assert.equal(next.manager, null);
  assert.notEqual(next.instanceId, lifecycle.instanceId);
});

test('lifecycle phase follows drain and the route stays readable while draining', async t => {
  const f = await runningFixture(t);
  await f.service.drain();
  const draining = parseCoordinatorLifecycle(await f.admin.request('GET', '/lifecycle'));
  assert.equal(draining.phase, 'draining');
  assert.equal(draining.shutdown.error, null);
  assert.equal(typeof draining.shutdown.requestedAt, 'number');
});

test('GET /lifecycle refuses missing, wrong and run-owner tokens without leaking identity', async t => {
  let acknowledge;
  const acknowledgement = new Promise(resolve => { acknowledge = resolve; });
  const f = await runningFixture(t, { executor: { ...idleExecutor, launch: async () => acknowledgement } });
  try {
    const directory = path.join(f.temporary, 'synthetic-project');
    await fs.mkdir(path.join(directory, '.git'), { recursive: true });
    const configPath = path.join(directory, '.heimdall.toml');
    await fs.writeFile(configPath, '[workflow]\n');
    const project = f.service.store.registerProject({ directory, commonGitDirectory: path.join(directory, '.git'), configPath, concurrency: 2 });
    f.service.store.enqueue({ id: 'active', projectId: project.id, feature: 'Synthetic feature', baseCommit: 'a'.repeat(40), worktreePath: path.join(f.stateDirectory, 'worktrees', project.id, 'active', 'checkout'), branch: 'heimdall/run/active', specification });
    await f.service.scheduler.tick();
    for (let index = 0; index < 100 && !f.service.store.getRun('active').capacityReserved; index++) await turn();
    const ownerToken = f.service.store.getRun('active').ownerToken;
    assert.ok(ownerToken);
    const identity = await f.admin.request('GET', '/lifecycle');
    for (const token of [undefined, 'f'.repeat(64), ownerToken]) {
      const response = await lifecycleResponse(f.service.endpoint, token);
      assert.equal(response.statusCode, 401);
      assert.deepEqual(JSON.parse(response.text), { error: 'Coordinator authorization required' });
      assert.ok(!response.text.includes(identity.instanceId));
      assert.ok(!response.text.includes(ownerToken));
    }
    const owned = await lifecycleResponse(f.service.endpoint, ownerToken, '/runs/active/lifecycle');
    assert.equal(owned.statusCode, 403);
    const forged = createCoordinatorClient(f.service.endpoint, ownerToken);
    await assert.rejects(fetchCoordinatorLifecycle(forged), error => error.statusCode === 401);
  } finally { acknowledge(); }
});

test('the lifecycle parser is strict about fields, versions and contradictions', () => {
  const valid = { lifecycleProtocol: 1, service: 'heimdall-coordinator', instanceId: randomUUID(), pid: 42, startedAt: 1700000000000, stateDirectory: '/tmp/state', endpoint: '/tmp/state/coordinator.sock', mode: 'foreground', manager: null, phase: 'running', shutdown: null };
  assert.deepEqual(parseCoordinatorLifecycle(valid), valid);
  assert.deepEqual(parseCoordinatorLifecycle({ ...valid, mode: 'managed', manager: 'dev.example.coordinator', phase: 'drain-failed', shutdown: { requestedAt: 5, error: 'boom' } }).shutdown, { requestedAt: 5, error: 'boom' });
  const rejected = [
    [null, /expected an object/], [[], /expected an object/], ['x', /expected an object/],
    [{ ...valid, extra: true }, /unexpected field extra/],
    [{ ...valid, instanceId: undefined }, /instanceId/],
    [(({ phase, ...rest }) => rest)(valid), /missing field phase/],
    [(({ shutdown, ...rest }) => rest)(valid), /missing field shutdown/],
    [{ ...valid, lifecycleProtocol: 2 }, /unsupported lifecycleProtocol/],
    [{ ...valid, lifecycleProtocol: '1' }, /unsupported lifecycleProtocol/],
    [(({ lifecycleProtocol, ...rest }) => rest)(valid), /missing field lifecycleProtocol/],
    [{ ...valid, service: 'other' }, /unexpected service/],
    [{ ...valid, instanceId: 'not-a-uuid' }, /UUID/],
    [{ ...valid, pid: 0 }, /pid/], [{ ...valid, pid: 1.5 }, /pid/], [{ ...valid, startedAt: -1 }, /startedAt/],
    [{ ...valid, stateDirectory: ' ' }, /stateDirectory/], [{ ...valid, endpoint: 3 }, /endpoint/],
    [{ ...valid, mode: 'daemon' }, /unknown mode/],
    [{ ...valid, mode: 'managed' }, /manager contradicts mode/],
    [{ ...valid, manager: 'dev.example.coordinator' }, /manager contradicts mode/],
    [{ ...valid, manager: 'has space', mode: 'managed' }, /manager must be/],
    [{ ...valid, phase: 'stopped' }, /unknown phase/],
    [{ ...valid, phase: 'draining' }, /shutdown contradicts phase/],
    [{ ...valid, shutdown: { requestedAt: 1, error: null } }, /shutdown contradicts phase/],
    [{ ...valid, phase: 'draining', shutdown: { requestedAt: 1, error: 'x' } }, /error contradicts phase/],
    [{ ...valid, phase: 'drain-failed', shutdown: { requestedAt: 1, error: null } }, /error contradicts phase/],
    [{ ...valid, phase: 'draining', shutdown: { requestedAt: 1, error: null, extra: 1 } }, /unexpected field extra/],
    [{ ...valid, phase: 'draining', shutdown: { requestedAt: 1 } }, /missing field error/],
    [{ ...valid, phase: 'draining', shutdown: { requestedAt: -1, error: null } }, /requestedAt/],
  ];
  for (const [value, pattern] of rejected) assert.throws(() => parseCoordinatorLifecycle(value), pattern, JSON.stringify(value));
});

test('an older coordinator without the lifecycle route is reported as unsupported', async () => {
  const client = { request: async () => { throw Object.assign(new Error('Unknown coordinator route'), { statusCode: 404 }); } };
  await assert.rejects(fetchCoordinatorLifecycle(client), error => error.statusCode === 404 && /lifecycle protocol/.test(error.message));
  const malformed = { request: async () => ({ lifecycleProtocol: 2 }) };
  await assert.rejects(fetchCoordinatorLifecycle(malformed), /Invalid coordinator lifecycle/);
});

test('lifecycle options are validated before any state is created', async t => {
  const temporary = await temporaryRoot(t);
  const stateDirectory = path.join(temporary, 'state');
  await assert.rejects(start(stateDirectory, { lifecycle: { mode: 'managed' } }), /requires a valid service label/);
  await assert.rejects(start(stateDirectory, { lifecycle: { mode: 'managed', label: '../escape' } }), /requires a valid service label/);
  await assert.rejects(start(stateDirectory, { lifecycle: { mode: 'foreground', label: 'dev.example' } }), /no service label/);
  await assert.rejects(start(stateDirectory, { lifecycle: { mode: 'detached' } }), /managed or foreground/);
  await assert.rejects(fs.lstat(stateDirectory), { code: 'ENOENT' });
});

test('lifecycle directory and record are private and created atomically', { skip: !posix }, async t => {
  const f = await runningFixture(t);
  const directory = path.join(f.stateDirectory, 'lifecycle');
  assert.equal((await fs.lstat(directory)).mode & 0o777, 0o700);
  const record = path.join(directory, 'instance.json');
  assert.equal((await fs.lstat(record)).mode & 0o777, 0o600);
  assert.equal((await fs.lstat(path.join(f.stateDirectory, 'coordinator.owner.sqlite'))).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(directory), ['instance.json'], 'no temporary file remains');
});

test('an insecure or symlinked lifecycle path is rejected without repair and releases ownership', { skip: !posix }, async t => {
  const temporary = await temporaryRoot(t);
  const outside = path.join(temporary, 'outside');
  await fs.mkdir(outside, { mode: 0o700 });
  const cases = [
    {
      name: 'symlinked directory', before: true,
      prepare: async lifecycle => { await fs.symlink(outside, lifecycle, 'dir'); },
      check: async lifecycle => { assert.equal(await fs.readlink(lifecycle), outside); assert.deepEqual(await fs.readdir(outside), []); },
      fix: lifecycle => fs.rm(lifecycle),
    },
    {
      name: 'file in place of directory', before: true,
      prepare: async lifecycle => { await fs.writeFile(lifecycle, 'x', { mode: 0o600 }); },
      check: async lifecycle => { assert.equal(await fs.readFile(lifecycle, 'utf8'), 'x'); },
      fix: lifecycle => fs.rm(lifecycle),
    },
    {
      name: 'group-readable directory', before: true,
      prepare: async lifecycle => { await fs.mkdir(lifecycle, { mode: 0o755 }); await fs.chmod(lifecycle, 0o755); },
      check: async lifecycle => { assert.equal((await fs.lstat(lifecycle)).mode & 0o777, 0o755); },
      fix: lifecycle => fs.chmod(lifecycle, 0o700),
    },
    {
      name: 'symlinked record', before: false,
      prepare: async lifecycle => { await fs.mkdir(lifecycle, { mode: 0o700 }); await fs.writeFile(path.join(outside, 'target'), 'keep', { mode: 0o600 }); await fs.symlink(path.join(outside, 'target'), path.join(lifecycle, 'instance.json')); },
      check: async lifecycle => { assert.equal(await fs.readlink(path.join(lifecycle, 'instance.json')), path.join(outside, 'target')); assert.equal(await fs.readFile(path.join(outside, 'target'), 'utf8'), 'keep'); },
      fix: lifecycle => fs.rm(path.join(lifecycle, 'instance.json')),
    },
    {
      name: 'world-readable record', before: false,
      prepare: async lifecycle => { await fs.mkdir(lifecycle, { mode: 0o700 }); await fs.writeFile(path.join(lifecycle, 'instance.json'), 'stale', { mode: 0o644 }); await fs.chmod(path.join(lifecycle, 'instance.json'), 0o644); },
      check: async lifecycle => { assert.equal((await fs.lstat(path.join(lifecycle, 'instance.json'))).mode & 0o777, 0o644); assert.equal(await fs.readFile(path.join(lifecycle, 'instance.json'), 'utf8'), 'stale'); },
      fix: lifecycle => fs.rm(path.join(lifecycle, 'instance.json')),
    },
  ];
  for (const scenario of cases) {
    const stateDirectory = path.join(temporary, 's' + cases.indexOf(scenario)); // Keep the socket path short.
    await fs.mkdir(stateDirectory, { mode: 0o700 });
    const lifecycle = path.join(stateDirectory, 'lifecycle');
    await scenario.prepare(lifecycle);
    await assert.rejects(start(stateDirectory), /lifecycle|private/i, scenario.name);
    await scenario.check(lifecycle);
    if (scenario.before) assert.deepEqual((await fs.readdir(stateDirectory)).sort(), ['coordinator.owner.sqlite', 'lifecycle'], `${scenario.name}: refused before key and database creation`);
    await assert.rejects(fs.lstat(path.join(stateDirectory, 'coordinator.sock')), { code: 'ENOENT' }, `${scenario.name}: no endpoint remains`);
    // Ownership was released by the failed start, so a repaired path starts normally.
    await scenario.fix(lifecycle);
    const service = await start(stateDirectory);
    assert.equal(parseCoordinatorLifecycle(service.lifecycle()).phase, 'running', scenario.name);
    await service.close();
  }
});
