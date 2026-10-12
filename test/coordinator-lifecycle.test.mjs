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
import {
  COORDINATOR_LIFECYCLE_PROTOCOL, CoordinatorShutdownError, fetchCoordinatorLifecycle, parseCoordinatorLifecycle, parseShutdownRecord, readInstanceRecord,
  readShutdownRecord, requestCoordinatorShutdown, sanitizeShutdownError, writeShutdownRecord,
} from '../dist/coordinator/lifecycle.js';

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

const CLOSE_STAGES = ['scheduler-stop', 'server-close', 'store-close', 'ownership-release'];
const cliUrl = pathToFileURL(path.resolve('dist/coordinator/cli.js')).href;
const cliPath = path.resolve('dist/cli.js');

/** Clean shutdown is a completion record for the instance plus a released owner lock; anything else with a free lock is a crash. */
async function classifyShutdown(stateDirectory, instanceId) {
  let lock;
  try { lock = await acquireCoordinatorOwnership(stateDirectory); }
  catch (error) { if (/another coordinator owns/i.test(error.message)) return 'running-or-partially-closed'; throw error; }
  lock.release();
  const record = await readShutdownRecord(stateDirectory, instanceId);
  if (record?.status === 'completed') return 'clean';
  if (record === null || record.status === 'requested') return record === null ? 'crashed-unacknowledged' : 'crashed-after-acknowledgement';
  return `failed:${record.status}`;
}

async function childFixture(t, { environment = {}, script, args } = {}) {
  const temporary = await temporaryRoot(t);
  const stateDirectory = path.join(temporary, 's');
  const home = path.join(temporary, 'home');
  await fs.mkdir(home);
  const config = path.join(temporary, 'coordinator.toml');
  await fs.writeFile(config, `[coordinator]\nstateDirectory = ${JSON.stringify(stateDirectory)}\n`);
  const command = script ? ['--no-warnings', '--input-type=module', '-e', script] : ['--no-warnings', cliPath, 'coordinator', 'serve', '--coordinator-config', config];
  const child = spawn(process.execPath, args ?? command, { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, 'c'), XDG_STATE_HOME: path.join(home, 's'), HEIMDALL_COORDINATOR_CONFIG: '', CONFIG: config, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', chunk => { output.stdout += chunk; });
  child.stderr.on('data', chunk => { output.stderr += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  const waitFor = async (pattern, label) => {
    for (let index = 0; index < 1000; index++) {
      if (pattern.test(output.stdout)) return;
      if (child.exitCode !== null) throw new Error(`child exited before ${label}: ${output.stderr}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`child did not report ${label}: ${output.stdout} ${output.stderr}`);
  };
  await waitFor(/Coordinator listening/, 'listening');
  const instance = await readInstanceRecord(stateDirectory);
  const token = await readCoordinatorToken(stateDirectory);
  return { child, output, exited, waitFor, stateDirectory, instance, admin: createCoordinatorClient(instance.endpoint, token) };
}

const hookedServe = `import { coordinatorMain } from ${JSON.stringify(cliUrl)};
const fail = process.env.FAIL_STAGES ? process.env.FAIL_STAGES.split(',') : [];
const hang = process.env.HANG_STAGE;
await coordinatorMain(['serve', '--coordinator-config', process.env.CONFIG], { serviceOptions: { testHooks: { shutdownStage: async stage => {
  if (stage === hang) { process.stdout.write('hanging at ' + stage + '\\n'); await new Promise(() => {}); }
  if (fail.includes(stage)) throw new Error('injected ' + stage + ' failure Bearer synthetic-credential-value');
} } } });`;

test('close-stage and completion-publication failures never publish a clean marker and report partial state', { skip: !posix, timeout: 30000 }, async t => {
  const cases = [
    { fail: ['store-close'], status: 'close-failed', stage: 'store-close', stages: CLOSE_STAGES.slice(0, 2), locked: true },
    { fail: ['ownership-release'], status: 'close-failed', stage: 'ownership-release', stages: CLOSE_STAGES.slice(0, 3), locked: true },
    { fail: ['publish-completion'], status: 'completion-unknown', stage: 'publish-completion', stages: CLOSE_STAGES, locked: false },
    { fail: ['publish-completion', 'publish-failure'], status: 'requested', stage: null, stages: [], locked: false },
  ];
  for (const scenario of cases) {
    const name = scenario.fail.join('+');
    const f = await runningFixture(t, { testHooks: { shutdownStage: stage => { if (scenario.fail.includes(stage)) throw new Error(`injected ${stage} failure Bearer synthetic-credential-value`); } } });
    const instanceId = f.service.instance.instanceId;
    const acknowledgement = await requestCoordinatorShutdown(f.admin, instanceId);
    assert.equal(acknowledgement.lifecycle.phase, 'draining', name);
    await assert.rejects(f.service.closed, error => error instanceof CoordinatorShutdownError && error.retryable === false && !/synthetic-credential-value/.test(error.message), name);
    await assert.rejects(f.service.shutdown(), CoordinatorShutdownError, name);
    const record = await readShutdownRecord(f.stateDirectory, instanceId);
    assert.equal(record.status, scenario.status, name);
    assert.notEqual(record.status, 'completed', name);
    assert.equal(record.stage, scenario.stage, name);
    assert.deepEqual(record.completedStages.length ? record.completedStages : [], scenario.stages.length ? scenario.stages : [], name);
    assert.equal(JSON.stringify(record).includes('synthetic-credential-value'), false, `${name}: failure text is sanitized`);
    if (scenario.stage) assert.match(record.error, /injected/, name);
    // Partially closed state is real: the lock is still held until the earlier stages complete.
    if (scenario.locked) await assert.rejects(acquireCoordinatorOwnership(f.stateDirectory), /another coordinator owns/i, name);
    else (await acquireCoordinatorOwnership(f.stateDirectory)).release();
    assert.notEqual(await classifyShutdown(f.stateDirectory, instanceId), 'clean', name);
    // The server was closed before any of these stages, so the endpoint is not usable.
    await assert.rejects(f.admin.request('GET', '/status'), /unavailable/, name);
    if (name === 'store-close') f.service.store.close();
  }
});

test('shutdown evidence records are strict, private and bound to one instance', { skip: !posix }, async t => {
  const temporary = await temporaryRoot(t);
  const stateDirectory = path.join(temporary, 's');
  const service = await start(stateDirectory);
  const instanceId = service.instance.instanceId;
  const base = { lifecycleProtocol: 1, service: 'heimdall-coordinator', instanceId, status: 'requested', attempts: 1, requestedAt: 1, updatedAt: 2, completedAt: null, stage: null, error: null, completedStages: [] };
  const completed = { ...base, status: 'completed', completedAt: 3, completedStages: CLOSE_STAGES };
  assert.deepEqual(parseShutdownRecord(base), base);
  assert.deepEqual(parseShutdownRecord(completed), completed);
  for (const [name, record] of [
    ['unknown field', { ...base, extra: 1 }], ['missing field', (({ error: _error, ...rest }) => rest)(base)], ['protocol', { ...base, lifecycleProtocol: 2 }],
    ['bad instance', { ...base, instanceId: 'x' }], ['unknown status', { ...base, status: 'clean' }], ['unknown stage', { ...base, status: 'close-failed', stage: 'nope', error: 'e' }],
    ['requested with error', { ...base, error: 'e' }], ['failed without error', { ...base, status: 'drain-failed', stage: 'drain' }],
    ['completed without time', { ...completed, completedAt: null }], ['failed with time', { ...base, status: 'close-failed', stage: 'store-close', error: 'e', completedAt: 3 }],
    ['completed with partial stages', { ...completed, completedStages: CLOSE_STAGES.slice(0, 2) }], ['completed with error', { ...completed, error: 'e' }],
    ['unknown unclean completion', { ...base, status: 'completion-unknown', stage: 'publish-completion', error: 'e', completedStages: [] }],
    ['zero attempts', { ...base, attempts: 0 }], ['non-object', null],
  ]) assert.throws(() => parseShutdownRecord(record), /Invalid coordinator/, name);
  // A running instance has no shutdown evidence; a record is private and read back only for its own instance.
  assert.equal(await readShutdownRecord(stateDirectory, instanceId), null);
  const file = await writeShutdownRecord(stateDirectory, base);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await readShutdownRecord(stateDirectory, instanceId), base);
  assert.deepEqual((await fs.readdir(path.join(stateDirectory, 'lifecycle'))).filter(name => name.endsWith('.tmp')), []);
  await assert.rejects(readShutdownRecord(stateDirectory, '../escape'), /UUID/);
  await fs.chmod(file, 0o644);
  await assert.rejects(readShutdownRecord(stateDirectory, instanceId), /0600|private/);
  await assert.rejects(writeShutdownRecord(stateDirectory, base), /not private/);
  await fs.chmod(file, 0o600);
  await fs.rm(file);
  await fs.symlink(path.join(temporary, 'elsewhere'), file);
  await assert.rejects(readShutdownRecord(stateDirectory, instanceId), /regular file/);
  await assert.rejects(writeShutdownRecord(stateDirectory, base), /not private/);
  await fs.rm(file);
  await service.close();
  assert.equal(await readShutdownRecord(stateDirectory, instanceId), null, 'a close without a drain publishes no clean marker');
});

test('failure text is bounded and stripped of credentials, URL userinfo and control characters', () => {
  const token = 'a1'.repeat(32);
  const text = sanitizeShutdownError(new Error(`failed\u0000\n with Bearer abcdef Basic Zm9v https://user:secret@host/x ${token} custom-secret-value ${'x'.repeat(900)}`), ['custom-secret-value']);
  assert.ok(text.length <= 500);
  for (const secret of ['abcdef', 'Zm9v', 'user:secret', token, 'custom-secret-value']) assert.equal(text.includes(secret), false, secret);
  assert.equal(/[\u0000-\u001f]/.test(text), false);
  assert.equal(sanitizeShutdownError(undefined), 'Shutdown failed without a message');
});

test('a crash after acknowledgement leaves requested-without-completion evidence that differs from clean shutdown', { skip: !posix, timeout: 30000 }, async t => {
  const crashed = await childFixture(t, { script: hookedServe, environment: { HANG_STAGE: 'scheduler-stop' } });
  assert.equal(await classifyShutdown(crashed.stateDirectory, crashed.instance.instanceId), 'running-or-partially-closed');
  const acknowledgement = await requestCoordinatorShutdown(crashed.admin, crashed.instance.instanceId);
  assert.equal(acknowledgement.lifecycle.phase, 'draining');
  await crashed.waitFor(/hanging at scheduler-stop/, 'the close stage');
  assert.equal((await readShutdownRecord(crashed.stateDirectory, crashed.instance.instanceId)).status, 'requested');
  crashed.child.kill('SIGKILL');
  assert.equal((await crashed.exited).signal, 'SIGKILL');
  assert.equal(await classifyShutdown(crashed.stateDirectory, crashed.instance.instanceId), 'crashed-after-acknowledgement');
  const record = await readShutdownRecord(crashed.stateDirectory, crashed.instance.instanceId);
  assert.equal(record.status, 'requested');
  assert.equal(record.completedAt, null);
  assert.equal((await readInstanceRecord(crashed.stateDirectory)).instanceId, crashed.instance.instanceId);

  const clean = await childFixture(t);
  await requestCoordinatorShutdown(clean.admin, clean.instance.instanceId);
  assert.deepEqual(await clean.exited, { code: 0, signal: null });
  assert.equal(await classifyShutdown(clean.stateDirectory, clean.instance.instanceId), 'clean');
  assert.equal((await readShutdownRecord(clean.stateDirectory, clean.instance.instanceId)).status, 'completed');
  // A completion record belongs to its instance: it never vouches for the crashed one.
  assert.equal(await readShutdownRecord(clean.stateDirectory, crashed.instance.instanceId), null);
});

test('a foreground coordinator exits nonzero after a failed close or unpublished completion', { skip: !posix, timeout: 30000 }, async t => {
  for (const [stage, status] of [['scheduler-stop', 'close-failed'], ['store-close', 'close-failed'], ['publish-completion', 'completion-unknown']]) {
    const f = await childFixture(t, { script: hookedServe, environment: { FAIL_STAGES: stage } });
    await requestCoordinatorShutdown(f.admin, f.instance.instanceId);
    const result = await f.exited;
    assert.equal(result.code, 1, stage);
    assert.match(f.output.stderr, /did not complete cleanly/, stage);
    assert.equal(f.output.stderr.includes('synthetic-credential-value'), false, stage);
    const record = await readShutdownRecord(f.stateDirectory, f.instance.instanceId);
    assert.equal(record.status, status, stage);
    assert.equal(record.stage, stage);
    assert.notEqual(await classifyShutdown(f.stateDirectory, f.instance.instanceId), 'clean', stage);
  }
});

test('SIGINT, SIGTERM and an authenticated request share one shutdown and the process exits 0 after clean completion', { skip: !posix, timeout: 60000 }, async t => {
  for (const sequence of [['SIGINT'], ['SIGTERM'], ['SIGTERM', 'http', 'SIGINT', 'http', 'SIGTERM']]) {
    const f = await childFixture(t);
    for (const step of sequence) {
      if (step === 'http') await requestCoordinatorShutdown(f.admin, f.instance.instanceId).catch(() => {});
      else f.child.kill(step);
    }
    assert.deepEqual(await f.exited, { code: 0, signal: null }, sequence.join());
    assert.equal(f.output.stderr.replace(/\(node:\d+\)[^\n]*\n|\(Use `node[^\n]*\n/g, ''), '', sequence.join());
    assert.ok(f.output.stdout.split('Stopping admission and draining managed runs').length <= 2, sequence.join());
    const record = await readShutdownRecord(f.stateDirectory, f.instance.instanceId);
    assert.equal(record.status, 'completed', sequence.join());
    assert.equal(record.attempts, 1, sequence.join());
    assert.equal(await classifyShutdown(f.stateDirectory, f.instance.instanceId), 'clean', sequence.join());
    await assert.rejects(fs.lstat(f.instance.endpoint), { code: 'ENOENT' }, 'the closed server removed its socket');
  }
});
