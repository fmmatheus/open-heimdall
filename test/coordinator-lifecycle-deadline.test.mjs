import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { lifecycleCommandMain } from '../dist/coordinator/lifecycle-cli.js';
import { lifecycleExitCode, parseLifecycleResult, renderLifecycleJson } from '../dist/coordinator/lifecycle-result.js';
import { COORDINATOR_LIFECYCLE_PROTOCOL } from '../dist/coordinator/lifecycle.js';
import { COORDINATOR_SERVICE_ID, COORDINATOR_STATUS_SCHEMA_VERSION } from '../dist/coordinator/status.js';
import { bounded } from '../dist/coordinator/lifecycle-start.js';
import { nativeServiceNames } from '../dist/coordinator/native/types.js';
import { FakeServiceManager } from './fixtures/fake-native-service.mjs';

/**
 * One overall deadline for `start` and `stop`: every sequential request, manager observation and wait takes its
 * allowance from what remains of `--timeout`, and Ctrl-C ends the request in flight. The coordinator here is a
 * protocol fixture (an authenticated Unix socket server answering the lifecycle protocol with controlled delays),
 * not a real coordinator process.
 */
const posix = process.platform !== 'win32';
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repository, 'dist', 'cli.js');
const BUDGET_MS = 1000;
/** Process scheduling, socket teardown and result rendering may follow the deadline by at most this much. */
const TOLERANCE_MS = 600;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/hd-'));
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  const home = path.join(root, 'home');
  await fs.mkdir(home);
  const stateDirectory = path.join(root, 'state');
  await fs.mkdir(stateDirectory, { mode: 0o700 });
  const key = randomBytes(32).toString('hex');
  await fs.writeFile(path.join(stateDirectory, 'coordinator.key'), key, { mode: 0o600 });
  const configFile = path.join(root, 'coordinator.toml');
  await fs.writeFile(configFile, `[coordinator]\nstateDirectory = ${JSON.stringify(stateDirectory)}\n`);
  return { root, home, stateDirectory, configFile, key, endpoint: path.join(stateDirectory, 'coordinator.sock'), onCleanup: cleanup => cleanups.push(cleanup) };
}

function manage(f, options) {
  const manager = new FakeServiceManager(options);
  f.onCleanup(() => manager.terminate());
  return manager;
}

/** The service manager reports the synthetic coordinator as its owned, running main process. */
function adopt(manager, pid = process.pid) {
  manager.definition = { text: 'owned', credentialFile: null, openchamberDataDirectory: null };
  manager.externalPid = pid;
}

/**
 * An authenticated protocol fixture. Every request is recorded when it arrives; each route answers after its delay.
 * `delays.lifecycle`, `delays.status` and `delays.shutdown` are milliseconds, `Infinity` never answers.
 */
function syntheticCoordinator(f, { pid = process.pid, phase = 'running', delays = {} } = {}) {
  const requests = [];
  const timers = new Set();
  const instance = {
    instanceId: randomUUID(), pid, startedAt: Date.now(), stateDirectory: f.stateDirectory, endpoint: f.endpoint,
    mode: 'managed', manager: nativeServiceNames(f.stateDirectory).launchdLabel,
  };
  const state = { phase };
  const lifecycle = () => ({
    lifecycleProtocol: COORDINATOR_LIFECYCLE_PROTOCOL, service: COORDINATOR_SERVICE_ID, ...instance, phase: state.phase,
    shutdown: state.phase === 'running' ? null : { requestedAt: Date.now(), error: null },
  });
  const status = () => ({
    schemaVersion: COORDINATOR_STATUS_SCHEMA_VERSION, service: COORDINATOR_SERVICE_ID, status: state.phase === 'running' ? 'running' : 'draining',
    acceptingNewRuns: state.phase === 'running', queuedRuns: 0, reservedRuns: 1,
  });
  const answerLater = (delay, response, body) => {
    if (delay === Infinity) return;
    const timer = setTimeout(() => { timers.delete(timer); if (response.destroyed) return; response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body())); }, delay ?? 0);
    timers.add(timer);
  };
  let connections = 0;
  const server = http.createServer((request, response) => {
    requests.push({ at: Date.now(), method: request.method, url: request.url });
    if (request.headers.authorization !== `Bearer ${f.key}`) { response.writeHead(401).end(); return; }
    request.resume();
    if (request.method === 'GET' && request.url === '/lifecycle') answerLater(delays.lifecycle, response, lifecycle);
    else if (request.method === 'GET' && request.url === '/status') answerLater(state.phase === 'running' ? delays.status : delays.statusDraining ?? delays.status, response, status);
    else if (request.method === 'POST' && request.url === '/lifecycle/shutdown') {
      answerLater(delays.shutdown, response, () => { state.phase = 'draining'; return { lifecycleProtocol: COORDINATOR_LIFECYCLE_PROTOCOL, accepted: true, retried: false, previousError: null, lifecycle: lifecycle() }; });
    } else response.writeHead(404).end();
  });
  server.on('connection', () => { connections++; });
  const coordinator = {
    requests, state, instance,
    /** Connections accepted; one that carried no complete request is a request that was begun and then abandoned. */
    abandonedConnections: () => connections - requests.length,
    async listen() { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(f.endpoint, resolve); }); },
    async close() {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
    shutdownRequests: () => requests.filter(request => request.method === 'POST'),
  };
  f.onCleanup(() => coordinator.close());
  return coordinator;
}

function capture() {
  const out = { stdout: '', stderr: '' };
  return { out, streams: { stdout: { write: text => { out.stdout += text; } }, stderr: { write: text => { out.stderr += text; } } } };
}

/** Runs one lifecycle command with `--timeout 1 --json` and checks the documented shape: one JSON document, matching exit status. */
async function runBounded(f, manager, command, args = [], { signals, dependencies = {}, timeout = '1' } = {}) {
  const { out, streams } = capture();
  const startedAt = Date.now();
  const status = await lifecycleCommandMain(command, ['--coordinator-config', f.configFile, '--timeout', timeout, '--json', ...args], {
    streams, signals,
    dependencies: {
      environment: { HOME: f.home }, platform: 'darwin', createAdapter: manager.createAdapter,
      launchOverrides: { nodeExecutable: process.execPath, entryPoint: cli }, pollIntervalMs: 20, requestTimeoutMs: 3000, ...dependencies,
    },
  });
  const finishedAt = Date.now();
  const document = parseLifecycleResult(JSON.parse(out.stdout));
  assert.equal(out.stdout, renderLifecycleJson(document), 'stdout must be exactly one document');
  assert.equal(status, lifecycleExitCode(document));
  assert.equal(status === 0, document.ok);
  return { status, document, startedAt, finishedAt, elapsed: finishedAt - startedAt };
}

/** The command ended within its budget plus the documented tolerance, and no request was begun once the budget was spent. */
function assertWithinBudget(outcome, coordinator) {
  assert.ok(outcome.elapsed <= BUDGET_MS + TOLERANCE_MS, `took ${outcome.elapsed} ms for a ${BUDGET_MS} ms budget`);
  for (const request of coordinator.requests) {
    assert.ok(request.at - outcome.startedAt <= BUDGET_MS + 100, `${request.method} ${request.url} began ${request.at - outcome.startedAt} ms into a ${BUDGET_MS} ms budget`);
  }
}

test('start recognizing a running coordinator is bounded by one deadline across both of its requests', { skip: !posix, timeout: 30000 }, async t => {
  const f = await fixture(t);
  const manager = manage(f);
  adopt(manager);
  // Each request is quicker than the budget; together they are not.
  const coordinator = syntheticCoordinator(f, { delays: { lifecycle: 600, status: 600 } });
  await coordinator.listen();
  const outcome = await runBounded(f, manager, 'start');
  assertWithinBudget(outcome, coordinator);
  assert.equal(outcome.document.ok, false, 'no success after the deadline');
  assert.notEqual(outcome.status, 0);
  assert.equal(outcome.document.error.code, 'deadline-exceeded');
  assert.equal(manager.spawnCount, 0);
  assert.equal(coordinator.shutdownRequests().length, 0);
});

test('start waiting for readiness never reports ready from an answer that arrives after the deadline', { skip: !posix, timeout: 30000 }, async t => {
  const f = await fixture(t);
  const manager = manage(f, { behavior: 'hang' });
  const coordinator = syntheticCoordinator(f, { delays: { lifecycle: 600, status: 600 } });
  // The service starts, and a coordinator for its process begins to answer, slowly.
  const createAdapter = context => {
    const created = manager.createAdapter(context);
    const start = created.adapter.start.bind(created.adapter);
    created.adapter.start = async () => {
      const result = await start();
      coordinator.instance.pid = manager.child.pid;
      await coordinator.listen();
      return result;
    };
    return created;
  };
  const outcome = await runBounded(f, { createAdapter }, 'start');
  assertWithinBudget(outcome, coordinator);
  assert.equal(outcome.document.ok, false, 'no success after the deadline');
  assert.notEqual(outcome.status, 0);
  assert.notEqual(outcome.document.outcome, 'ready');
  assert.equal(manager.running(), true, 'start never stops what it launched');
});

test('stop waiting for completion spends no new allowance once the deadline has passed', { skip: !posix, timeout: 30000 }, async t => {
  const f = await fixture(t);
  const manager = manage(f);
  adopt(manager);
  // The drain is accepted at once, then the coordinator keeps answering lifecycle quickly and, while draining, status never.
  const coordinator = syntheticCoordinator(f, { delays: { shutdown: 0, statusDraining: Infinity } });
  await coordinator.listen();
  const outcome = await runBounded(f, manager, 'stop');
  assertWithinBudget(outcome, coordinator);
  assert.equal(outcome.document.ok, false);
  assert.notEqual(outcome.status, 0);
  assert.equal(outcome.document.outcome, 'still-draining');
  assert.equal(outcome.document.error.code, 'deadline-exceeded');
  assert.equal(coordinator.shutdownRequests().length, 1, 'the drain was requested exactly once');
});

test('stop sends no drain request once the deadline has passed while it verified ownership', { skip: !posix, timeout: 30000 }, async t => {
  const f = await fixture(t);
  const manager = manage(f);
  adopt(manager);
  const coordinator = syntheticCoordinator(f);
  await coordinator.listen();
  // A controlled clock that jumps past the deadline when the second ownership check (the one right before the request) completes.
  let offset = 0;
  let inspections = 0;
  const createAdapter = context => {
    const created = manager.createAdapter(context);
    const inspect = created.adapter.inspect.bind(created.adapter);
    created.adapter.inspect = async () => {
      const inspected = await inspect();
      if (++inspections === 2) offset += 5 * BUDGET_MS;
      return inspected;
    };
    return created;
  };
  const outcome = await runBounded(f, { createAdapter }, 'stop', [], { dependencies: { now: () => Date.now() + offset } });
  assert.ok(inspections >= 2, 'both ownership checks ran');
  assert.equal(outcome.document.ok, false);
  assert.notEqual(outcome.status, 0);
  assert.equal(outcome.document.outcome, 'completion-unknown');
  assert.equal(outcome.document.error.code, 'deadline-exceeded');
  assert.equal(coordinator.shutdownRequests().length, 0, 'no shutdown request after the deadline');
  await sleep(100);
  assert.ok(coordinator.abandonedConnections() <= 0, 'no request was even begun after the deadline');
});

for (const command of ['start', 'stop']) {
  test(`${command} interrupted while a coordinator request is in flight ends promptly and sends nothing further`, { skip: !posix, timeout: 30000 }, async t => {
    const f = await fixture(t);
    const manager = manage(f);
    adopt(manager);
    const coordinator = syntheticCoordinator(f, { delays: { lifecycle: Infinity } });
    await coordinator.listen();
    const signals = new EventEmitter();
    const pending = runBounded(f, manager, command, [], { signals, timeout: '30' });
    const started = Date.now();
    while (coordinator.requests.length === 0) { if (Date.now() - started > 5000) throw new Error('the request never arrived'); await sleep(10); }
    const interruptedAt = Date.now();
    signals.emit('SIGINT');
    const outcome = await pending;
    assert.ok(outcome.finishedAt - interruptedAt < TOLERANCE_MS, `ended ${outcome.finishedAt - interruptedAt} ms after Ctrl-C`);
    assert.equal(outcome.document.ok, false);
    assert.notEqual(outcome.status, 0);
    assert.equal(outcome.document.error.code, 'interrupted');
    assert.equal(coordinator.shutdownRequests().length, 0);
    assert.equal(coordinator.requests.length, 1, 'no further request after the interruption');
    assert.equal(manager.spawnCount, 0);
    assert.equal(signals.listenerCount('SIGINT'), 0);
  });
}

test('an operation whose deadline has passed or that was interrupted never starts its action', async () => {
  let started = 0;
  const action = () => { started++; return Promise.resolve('answer'); };
  const expired = await bounded(action, { now: () => 1000, signal: undefined }, 1000);
  assert.equal(expired.kind, 'timeout');
  assert.equal(started, 0, 'an expired deadline starts nothing');
  const controller = new AbortController();
  controller.abort();
  const interrupted = await bounded(action, { now: () => 0, signal: controller.signal }, 5000);
  assert.equal(interrupted.kind, 'aborted');
  assert.equal(started, 0, 'an interruption starts nothing');
  const answered = await bounded(action, { now: () => 0, signal: undefined }, 5000);
  assert.deepEqual([answered.kind, answered.value, started], ['value', 'answer', 1]);
});
