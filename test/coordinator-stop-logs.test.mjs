import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { lifecycleCommandMain } from '../dist/coordinator/lifecycle-cli.js';
import { LIFECYCLE_OUTCOMES, lifecycleExitCode, parseLifecycleResult, renderLifecycleJson } from '../dist/coordinator/lifecycle-result.js';
import { readStopGeneration } from '../dist/coordinator/lifecycle-lock.js';
import { FOLLOW_INTERRUPTED_EXIT_CODE, cleanLogLine, readTailLines } from '../dist/coordinator/lifecycle-logs.js';
import { startCoordinatorService, readCoordinatorToken } from '../dist/coordinator/service.js';
import { createCoordinatorClient } from '../dist/coordinator/client.js';
import { readShutdownRecord, shutdownRecordName } from '../dist/coordinator/lifecycle.js';
import { probeCoordinatorOwnership } from '../dist/coordinator/ownership.js';
import { nativeServiceNames } from '../dist/coordinator/native/types.js';
import { launchdPaths } from '../dist/coordinator/native/launchd.js';
import { FakeServiceManager } from './fixtures/fake-native-service.mjs';

const posix = process.platform !== 'win32';
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repository, 'dist', 'cli.js');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const settings = { plannerAgent: 'planner', executorAgent: 'executor', plannerModel: 'anthropic/planner', executorModel: 'anthropic/executor', executorFallbackModel: 'kimi/fallback', maxTasks: 10, minQuotaRemainingPercent: 10, tokenLimitsDisabled: true };
const specification = { settings, plannerPrompt: 'Synthetic planner', executorPrompt: 'Synthetic executor', agents: {}, opencode: { baseUrl: 'http://127.0.0.1:4321', passwordEnvironmentVariable: 'SYNTHETIC_PASSWORD' } };

async function until(predicate, message, attempts = 600) {
  for (let index = 0; index < attempts; index++) { if (await predicate()) return; await sleep(10); }
  throw new Error(message);
}

/** An isolated HOME, state directory and coordinator configuration. Short roots keep Unix socket paths portable. */
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/hs-'));
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  const home = path.join(root, 'home');
  await fs.mkdir(home);
  const stateDirectory = path.join(root, 'state');
  const configFile = path.join(root, 'coordinator.toml');
  await fs.writeFile(configFile, `[coordinator]\nstateDirectory = ${JSON.stringify(stateDirectory)}\n`);
  return { root, home, stateDirectory, configFile, endpoint: path.join(stateDirectory, 'coordinator.sock'), onCleanup: cleanup => cleanups.push(cleanup) };
}

function manage(f, options) {
  const manager = new FakeServiceManager(options);
  f.onCleanup(() => manager.terminate());
  return manager;
}

function capture() {
  const out = { stdout: '', stderr: '' };
  return { out, streams: { stdout: { write: text => { out.stdout += text; } }, stderr: { write: text => { out.stderr += text; } } } };
}

async function run(f, manager, command, args, { signals, dependencies = {}, platform = 'darwin', environment = {} } = {}) {
  const { out, streams } = capture();
  let result = null;
  const status = await lifecycleCommandMain(command, args, {
    streams, signals, onResult: value => { result = value; },
    dependencies: {
      environment: { HOME: f.home, ...environment }, platform, createAdapter: manager.createAdapter,
      launchOverrides: { nodeExecutable: process.execPath, entryPoint: cli }, pollIntervalMs: 20, requestTimeoutMs: 3000, ...dependencies,
    },
  });
  return { status, ...out, result };
}

async function runJson(f, manager, command, args, options) {
  const outcome = await run(f, manager, command, [...args, '--json'], options);
  const document = parseLifecycleResult(JSON.parse(outcome.stdout));
  assert.equal(outcome.stdout, renderLifecycleJson(document), 'stdout must be exactly one document');
  assert.equal(outcome.status, lifecycleExitCode(document));
  assert.equal(outcome.status === 0, document.ok);
  return { ...outcome, document };
}

const stop = (f, manager, extra = [], options) => runJson(f, manager, 'stop', ['--coordinator-config', f.configFile, ...extra], options);

/** The fake adapter records only inspections and reads for these tests; any start/install/cleanup would be a mutation. */
function assertReadOnly(manager) {
  for (const call of manager.calls) assert.ok(['inspect', 'remembered'].includes(call), `unexpected adapter call: ${call}`);
  assert.equal(manager.spawnCount, 0);
}

/** The service manager reports the in-process coordinator as its owned, running main process. */
function adopt(manager) {
  manager.definition = { text: 'owned', credentialFile: null, openchamberDataDirectory: null };
  manager.externalPid = process.pid;
}
function processExited(manager, code = 0) {
  manager.externalPid = null;
  manager.exit = { code, signal: null };
}

/** A real coordinator holding one admitted synthetic native run that stays reserved until the test proves native idle. */
async function heldCoordinator(t, f, { mode = 'managed', testHooks } = {}) {
  const control = { proof: false, cleanup: false, interrupts: 0, launches: [] };
  let acknowledge;
  const acknowledgement = new Promise(resolve => { acknowledge = resolve; });
  const lifecycle = mode === 'managed' ? { mode: 'managed', label: nativeServiceNames(f.stateDirectory).launchdLabel } : undefined;
  const service = await startCoordinatorService({
    configuration: { stateDirectory: f.stateDirectory, endpoint: f.endpoint, globalConcurrency: 1, projectConcurrency: 2 },
    pollIntervalMs: 5, lifecycle, testHooks,
    executor: {
      launch: async run => { control.launches.push(run); await acknowledgement; },
      inspect: async run => {
        const idle = control.proof || control.cleanup;
        return { idle, status: !idle ? 'unknown' : run.checkpoint?.status === 'completed' ? 'succeeded' : 'failed' };
      },
      interrupt: async () => { control.interrupts++; throw new Error('Lifecycle commands must not interrupt native execution'); },
    },
    scheduler: { createWorktree: async () => {}, verifyWorktree: async () => {}, prepare: async () => {} },
  });
  f.onCleanup(async () => { control.cleanup = true; acknowledge(); await service.close().catch(() => {}); });
  const directory = path.join(f.root, 'synthetic-project');
  await fs.mkdir(path.join(directory, '.git'), { recursive: true });
  const configPath = path.join(directory, '.heimdall.toml');
  await fs.writeFile(configPath, '[workflow]\n');
  const project = service.store.registerProject({ directory, commonGitDirectory: path.join(directory, '.git'), configPath, concurrency: 2 });
  service.store.enqueue({ id: 'active', projectId: project.id, feature: 'Synthetic feature', baseCommit: 'a'.repeat(40), worktreePath: path.join(f.stateDirectory, 'worktrees', project.id, 'active', 'checkout'), branch: 'heimdall/run/active', specification });
  await service.scheduler.tick();
  await until(() => control.launches.length === 1, 'the synthetic run was not launched');
  const admin = createCoordinatorClient(f.endpoint, await readCoordinatorToken(f.stateDirectory));
  return { service, control, admin, instanceId: service.instance.instanceId, acknowledge };
}

test('stop --no-wait sends one authenticated drain request and reports only that it was accepted', { skip: !posix, timeout: 30000 }, async t => {
  const f = await fixture(t);
  const manager = manage(f);
  const held = await heldCoordinator(t, f);
  adopt(manager);
  const outcome = await stop(f, manager, ['--no-wait']);
  assert.equal(outcome.status, 0);
  assert.equal(outcome.document.outcome, 'stop-requested');
  assert.deepEqual([outcome.document.command, outcome.document.instance.instanceId, outcome.document.instance.mode], ['stop', held.instanceId, 'managed']);
  assert.match(outcome.document.message, /not necessarily exited/);
  const status = await held.admin.request('GET', '/status');
  assert.equal(status.status, 'draining');
  assert.equal(status.acceptingNewRuns, false);
  assert.equal(status.reservedRuns, 1, 'active runs keep their capacity');
  assert.equal((await readShutdownRecord(f.stateDirectory, held.instanceId)).status, 'requested');
  assertReadOnly(manager);
  assert.equal(held.control.interrupts, 0);
  // A repeated request joins the same drain and is still not a completion.
  const again = await stop(f, manager, ['--no-wait']);
  assert.equal(again.document.outcome, 'stop-requested');
  assert.equal((await readShutdownRecord(f.stateDirectory, held.instanceId)).attempts, 1);
  assert.equal(await readStopGeneration(f.stateDirectory), 0, 'a drain request alone does not fence a waiting start');
});

test('stop waits for native idle, the end of the service process and a free ownership lock before it reports stopped', { skip: !posix, timeout: 30000 }, async t => {
  const f = await fixture(t);
  const manager = manage(f);
  const held = await heldCoordinator(t, f);
  adopt(manager);
  const progress = [];
  let settled = false;
  const pending = stop(f, manager, ['--timeout', '30'], { dependencies: { progress: text => progress.push(text) } }).then(value => { settled = true; return value; });
  await until(() => progress.some(text => /Waiting up to 30 seconds/.test(text)), 'stop did not start waiting');
  held.acknowledge();
  await sleep(150);
  assert.equal(settled, false, 'no native idle proof, so no completion');
  assert.equal((await held.admin.request('GET', '/status')).reservedRuns, 1);
  held.control.proof = true;
  await held.service.closed;
  assert.equal((await readShutdownRecord(f.stateDirectory, held.instanceId)).status, 'completed');
  assert.equal(await probeCoordinatorOwnership(f.stateDirectory), 'free');
  await sleep(200);
  assert.equal(settled, false, 'clean completion evidence without a confirmed process exit is not a stop');
  processExited(manager, 0);
  const outcome = await pending;
  assert.equal(outcome.status, 0);
  assert.equal(outcome.document.outcome, 'stopped');
  assert.equal(outcome.document.instance.instanceId, held.instanceId);
  assert.match(outcome.document.message, /status 0/);
  assert.equal(await readStopGeneration(f.stateDirectory), 1, 'a start that was already waiting is fenced');
  assertReadOnly(manager);
  assert.equal(held.control.interrupts, 0);
  // Repeating stop after a clean completion is already-stopped, with nothing requested.
  const again = await stop(f, manager);
  assert.equal(again.status, 0);
  assert.equal(again.document.outcome, 'already-stopped');
  assertReadOnly(manager);
  // Process logs stay readable after the stop.
  await fs.mkdir(path.join(f.stateDirectory, 'logs'), { mode: 0o700 });
  await fs.writeFile(path.join(f.stateDirectory, 'logs', 'coordinator.out.log'), 'after the stop\n', { mode: 0o600 });
  const logs = await run(f, manager, 'logs', ['--coordinator-config', f.configFile]);
  assert.equal(logs.status, 0);
  assert.match(logs.stdout, /after the stop/);
});

test('a wait that times out reports still-draining and leaves the coordinator draining', { skip: !posix, timeout: 30000 }, async t => {
  const f = await fixture(t);
  const manager = manage(f);
  const held = await heldCoordinator(t, f);
  adopt(manager);
  const started = Date.now();
  const outcome = await stop(f, manager, ['--timeout', '1']);
  assert.ok(Date.now() - started < 8000, 'one deadline for the whole command');
  assert.equal(outcome.status, 1);
  assert.equal(outcome.document.outcome, 'still-draining');
  assert.equal(outcome.document.error.code, 'deadline-exceeded');
  assert.match(outcome.document.message, /keeps draining/);
  assert.match(outcome.document.message, /1 reserved run/);
  assert.equal(held.service.lifecycle().phase, 'draining');
  assert.equal((await held.admin.request('GET', '/status')).reservedRuns, 1);
  assertReadOnly(manager);
  assert.equal(await readStopGeneration(f.stateDirectory), 0);
  // The drain continues and a later stop finishes the job.
  held.acknowledge();
  held.control.proof = true;
  await held.service.closed;
  processExited(manager, 0);
  const finished = await stop(f, manager);
  assert.equal(finished.document.outcome, 'already-stopped');
});

test('Ctrl-C during the wait ends only the client: the drain continues and the exit status is nonzero', { skip: !posix, timeout: 30000 }, async t => {
  const f = await fixture(t);
  const manager = manage(f);
  const held = await heldCoordinator(t, f);
  adopt(manager);
  const signals = new EventEmitter();
  const progress = [];
  const pending = stop(f, manager, ['--timeout', '60'], { signals, dependencies: { progress: text => progress.push(text) } });
  await until(() => progress.some(text => /Waiting up to 60 seconds/.test(text)), 'stop did not start waiting');
  signals.emit('SIGINT');
  const outcome = await pending;
  assert.equal(outcome.status, 1);
  assert.equal(outcome.document.outcome, 'still-draining');
  assert.equal(outcome.document.error.code, 'interrupted');
  assert.match(outcome.document.message, /keeps draining/);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.equal(held.service.lifecycle().phase, 'draining', 'the drain request stays in effect');
  assert.equal((await held.admin.request('GET', '/status')).reservedRuns, 1);
  assert.equal(held.control.interrupts, 0);
  assertReadOnly(manager);
  held.acknowledge();
  held.control.proof = true;
  await held.service.closed;
});

test('a drain that fails is reported with its retry behavior, and running stop again retries the same drain', { skip: !posix, timeout: 30000 }, async t => {
  const f = await fixture(t);
  const manager = manage(f);
  let injected = 0;
  const held = await heldCoordinator(t, f, { testHooks: { shutdownStage: stage => { if (stage === 'drain' && injected++ === 0) throw new Error('injected drain failure'); } } });
  adopt(manager);
  const first = await stop(f, manager, ['--timeout', '20']);
  assert.equal(first.status, 1);
  assert.equal(first.document.outcome, 'failed');
  assert.equal(first.document.error.code, 'drain-failed');
  assert.match(first.document.message, /injected drain failure/);
  assert.match(first.document.message, /run `heimdall coordinator stop` again to retry the same drain/i);
  assert.match(first.document.message, /Admission stays disabled/);
  assert.equal((await held.admin.request('GET', '/status')).acceptingNewRuns, false);
  assertReadOnly(manager);
  held.acknowledge();
  held.control.proof = true;
  const pending = stop(f, manager, ['--timeout', '20']);
  await held.service.closed;
  processExited(manager, 0);
  const second = await pending;
  assert.equal(second.document.outcome, 'stopped');
  assert.equal((await readShutdownRecord(f.stateDirectory, held.instanceId)).attempts, 2);
});

test('a foreground coordinator is never signalled or asked to drain: stop points to SIGINT and SIGTERM', { skip: !posix, timeout: 30000 }, async t => {
  const f = await fixture(t);
  const manager = manage(f);
  const held = await heldCoordinator(t, f, { mode: 'foreground' });
  const outcome = await stop(f, manager);
  assert.equal(outcome.status, 1);
  assert.equal(outcome.document.outcome, 'conflict');
  assert.equal(outcome.document.error.code, 'foreground-coordinator');
  assert.match(outcome.document.message, /SIGINT or SIGTERM/);
  assert.match(outcome.document.message, new RegExp(`process ${process.pid}`));
  assert.equal(outcome.document.instance.mode, 'foreground');
  assert.deepEqual(manager.calls, [], 'the service manager is not consulted');
  assert.equal(held.service.lifecycle().phase, 'running');
  assert.equal((await held.admin.request('GET', '/status')).acceptingNewRuns, true);
  const withoutWait = await stop(f, manager, ['--no-wait']);
  assert.equal(withoutWait.document.error.code, 'foreground-coordinator');
});

test('stop sends no request unless the answering process is the loaded service Heimdall owns', { skip: !posix, timeout: 30000 }, async t => {
  const f = await fixture(t);
  const manager = manage(f);
  const held = await heldCoordinator(t, f);
  // Not registered at all.
  let outcome = await stop(f, manager);
  assert.equal(outcome.document.outcome, 'conflict');
  assert.equal(outcome.document.error.code, 'registered-elsewhere');
  // Registered, but the manager runs another process.
  adopt(manager);
  manager.externalPid = process.pid + 1;
  outcome = await stop(f, manager);
  assert.equal(outcome.document.error.code, 'registered-elsewhere');
  // A foreign definition.
  manager.externalPid = process.pid;
  manager.foreign = 'not generated by Heimdall';
  outcome = await stop(f, manager);
  assert.equal(outcome.document.error.code, 'foreign-definition');
  // The manager's state cannot be read.
  manager.foreign = null;
  const failing = new FakeServiceManager();
  failing.createAdapter = context => {
    const selected = manager.createAdapter(context);
    return { ...selected, adapter: { ...selected.adapter, inspect: async () => { throw new Error('manager unavailable'); } } };
  };
  outcome = await stop(f, failing);
  assert.equal(outcome.document.error.code, 'state-unknown');
  for (const value of [held.service.lifecycle().phase]) assert.equal(value, 'running');
  assert.equal(held.control.interrupts, 0);
});

test('a missing, older or malformed lifecycle reply is a failure and never a signal', { skip: !posix, timeout: 30000 }, async t => {
  const f = await fixture(t);
  const manager = manage(f);
  // A coordinator with nothing running closes at once; its identity document is then served by a stub.
  const original = await startCoordinatorService({
    configuration: { stateDirectory: f.stateDirectory, endpoint: f.endpoint, globalConcurrency: 1, projectConcurrency: 1 },
    pollIntervalMs: 5, lifecycle: { mode: 'managed', label: nativeServiceNames(f.stateDirectory).launchdLabel },
    scheduler: { createWorktree: async () => {}, verifyWorktree: async () => {}, prepare: async () => {} },
  });
  const lifecycle = { ...original.lifecycle(), phase: 'draining', shutdown: { requestedAt: Date.now(), error: null } };
  await original.close();
  await fs.rm(f.endpoint, { force: true });
  adopt(manager);
  let reply = { statusCode: 404, body: { error: 'not found' } };
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    const answer = request.method === 'GET' && request.url === '/lifecycle' ? { statusCode: 200, body: lifecycle } : reply;
    response.writeHead(answer.statusCode, { 'Content-Type': 'application/json' });
    response.end(typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body));
  });
  await new Promise(resolve => server.listen(f.endpoint, resolve));
  f.onCleanup(() => new Promise(resolve => server.close(resolve)));
  const cases = [
    [{ statusCode: 404, body: { error: 'not found' } }, 'failed', 'unsupported-lifecycle-protocol'],
    [{ statusCode: 200, body: '{"accepted": "maybe"' }, 'failed', 'endpoint-invalid'],
    [{ statusCode: 200, body: { accepted: true } }, 'failed', 'endpoint-invalid'],
    [{ statusCode: 409, body: { error: 'instance mismatch' } }, 'conflict', 'instance-mismatch'],
    [{ statusCode: 401, body: { error: 'unauthorized' } }, 'conflict', 'endpoint-refused'],
  ];
  for (const [answer, outcomeName, code] of cases) {
    reply = answer;
    requests.length = 0;
    for (const extra of [[], ['--no-wait']]) {
      const outcome = await stop(f, manager, extra);
      assert.equal(outcome.status, 1, `${code} ${extra}`);
      assert.equal(outcome.document.outcome, outcomeName, `${code} ${extra}`);
      assert.equal(outcome.document.error.code, code, `${code} ${extra}`);
    }
    assert.equal(requests.filter(line => line.startsWith('POST')).length, 2, 'one request per command and no fallback');
  }
  assertReadOnly(manager);
});

test('stop on a target that never ran anything creates nothing and reports why', { skip: !posix }, async t => {
  const f = await fixture(t);
  const manager = manage(f);
  const outcome = await stop(f, manager);
  assert.equal(outcome.status, 1);
  assert.equal(outcome.document.outcome, 'failed');
  assert.equal(outcome.document.error.code, 'not-managed');
  assert.deepEqual(manager.calls, []);
  await assert.rejects(fs.lstat(f.stateDirectory));
  assert.deepEqual(await fs.readdir(f.home), []);
});

test('a repeated stop claims already-stopped only with an owned inactive definition and correlated clean evidence', { skip: !posix, timeout: 30000 }, async t => {
  const f = await fixture(t);
  const manager = manage(f);
  const held = await heldCoordinator(t, f);
  adopt(manager);
  // Process still reported running while nothing answers: unknown, never already-stopped.
  held.acknowledge();
  held.control.proof = true;
  await stop(f, manager, ['--no-wait']);
  await held.service.closed;
  let outcome = await stop(f, manager);
  assert.equal(outcome.status, 1);
  assert.equal(outcome.document.outcome, 'completion-unknown');
  // The process is gone, but the manager reports an unclean exit.
  processExited(manager, 7);
  outcome = await stop(f, manager);
  assert.equal(outcome.status, 1);
  assert.equal(outcome.document.error.code, 'shutdown-failed');
  // The manager cannot say whether the process exists.
  const unknown = new FakeServiceManager();
  unknown.createAdapter = context => {
    const selected = manager.createAdapter(context);
    return { ...selected, adapter: { ...selected.adapter, inspect: async () => ({ registration: 'unknown', running: 'unknown', pid: null, lastExitStatus: null, registeredPath: null, detail: 'unreadable' }) } };
  };
  outcome = await stop(f, unknown);
  assert.equal(outcome.status, 1);
  assert.equal(outcome.document.outcome, 'completion-unknown');
  // A foreign definition is never claimed.
  processExited(manager, 0);
  manager.foreign = 'foreign definition';
  outcome = await stop(f, manager);
  assert.equal(outcome.document.error.code, 'foreign-definition');
  manager.foreign = null;
  // An evidence-free state is not a clean stop.
  const evidence = path.join(f.stateDirectory, 'lifecycle', shutdownRecordName(held.instanceId));
  const saved = await fs.readFile(evidence);
  await fs.rm(evidence);
  outcome = await stop(f, manager);
  assert.equal(outcome.status, 1);
  assert.equal(outcome.document.outcome, 'completion-unknown');
  await fs.writeFile(evidence, saved, { mode: 0o600 });
  outcome = await stop(f, manager);
  assert.equal(outcome.document.outcome, 'already-stopped');
  assert.equal(outcome.status, 0);
});

test('start, stop and a new start of a real coordinator process: stop ends it gracefully, never by signal or manager removal', { skip: !posix, timeout: 60000 }, async t => {
  const f = await fixture(t);
  const manager = manage(f);
  const started = await runJson(f, manager, 'start', ['--coordinator-config', f.configFile]);
  assert.equal(started.document.outcome, 'ready');
  const first = started.document.instance;
  const signalled = [];
  const kill = manager.child.kill.bind(manager.child);
  manager.child.kill = signal => { signalled.push(signal); return kill(signal); };
  const stopped = await stop(f, manager, ['--timeout', '30']);
  assert.equal(stopped.status, 0, stopped.stderr);
  assert.equal(stopped.document.outcome, 'stopped');
  assert.equal(stopped.document.instance.instanceId, first.instanceId);
  assert.deepEqual(manager.exit, { code: 0, signal: null }, 'the service exited by itself with status 0');
  assert.deepEqual(signalled, []);
  assert.equal(await probeCoordinatorOwnership(f.stateDirectory), 'free');
  assert.equal((await readShutdownRecord(f.stateDirectory, first.instanceId)).status, 'completed');
  assert.equal(manager.calls.filter(call => ['install', 'start'].includes(call)).length, 2, 'stop added no install or start');
  const again = await stop(f, manager);
  assert.equal(again.document.outcome, 'already-stopped');
  const restarted = await runJson(f, manager, 'start', ['--coordinator-config', f.configFile]);
  assert.equal(restarted.document.outcome, 'ready');
  assert.notEqual(restarted.document.instance.instanceId, first.instanceId, 'a new explicit start is a new instance');
  const noWait = await stop(f, manager, ['--no-wait']);
  assert.equal(noWait.document.outcome, 'stop-requested');
  await manager.exited;
  const last = await stop(f, manager);
  assert.equal(last.document.outcome, 'already-stopped');
});

test('every stop outcome is a documented one and the help describes the contract', async t => {
  const f = await fixture(t);
  const manager = manage(f);
  const help = await run(f, manager, 'stop', ['--help']);
  assert.equal(help.status, 0);
  for (const outcome of ['stop-requested', 'stopped', 'already-stopped', 'still-draining', 'completion-unknown']) assert.ok(LIFECYCLE_OUTCOMES.includes(outcome) && help.stdout.includes(outcome), outcome);
  assert.match(help.stdout, /Ctrl-C/);
  assert.match(help.stdout, /never stops, kills or restarts/);
  const logsHelp = await run(f, manager, 'logs', ['--help']);
  assert.match(logsHelp.stdout, /not rotated or truncated by Heimdall/);
  assert.match(logsHelp.stdout, /130/);
  assert.deepEqual(manager.calls, []);
});

// --- logs ---------------------------------------------------------------------------------------------------

async function logFixture(t, { out = '', err = '' } = {}) {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.stateDirectory, 'logs'), { recursive: true, mode: 0o700 });
  await fs.chmod(path.join(f.stateDirectory, 'logs'), 0o700);
  const paths = launchdPaths(f.stateDirectory, nativeServiceNames(f.stateDirectory).launchdLabel);
  await fs.writeFile(paths.standardOut, out, { mode: 0o600 });
  await fs.writeFile(paths.standardError, err, { mode: 0o600 });
  return { f, paths, manager: manage(f) };
}

const numbered = (count, prefix = 'line') => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`);

test('logs prints a bounded recent tail of each private output file, with the file named', { skip: !posix }, async t => {
  const { f, manager } = await logFixture(t, { out: numbered(50).join('\n') + '\n', err: 'only error line\n' });
  const outcome = await run(f, manager, 'logs', ['--coordinator-config', f.configFile, '--lines', '3']);
  assert.equal(outcome.status, 0);
  assert.equal(outcome.stderr, '');
  assert.equal(outcome.stdout, [
    `==> ${path.join(f.stateDirectory, 'logs', 'coordinator.out.log')} <==`, 'line 48', 'line 49', 'line 50',
    `==> ${path.join(f.stateDirectory, 'logs', 'coordinator.err.log')} <==`, 'only error line', '',
  ].join('\n'));
  const full = await run(f, manager, 'logs', ['--coordinator-config', f.configFile]);
  assert.equal(full.stdout.split('\n').filter(line => line.startsWith('line ')).length, 50, 'fewer lines than requested prints them all');
  assert.deepEqual(manager.calls, [], 'logs never consults the service manager');
});

test('logs sanitizes terminal control sequences and bounds line length', { skip: !posix }, async t => {
  const { f, manager } = await logFixture(t, { out: `\u001b[31mred\u001b[0m \u001b]0;title\u0007text\u0001\r\n${'x'.repeat(9000)}\n` });
  const outcome = await run(f, manager, 'logs', ['--coordinator-config', f.configFile]);
  assert.equal(outcome.status, 0);
  assert.ok(!/[\u001b\u0001\u0007\r]/.test(outcome.stdout));
  assert.match(outcome.stdout, /\nred text\?\n/);
  assert.ok(outcome.stdout.split('\n').every(line => line.length < 4100));
  assert.equal(cleanLogLine('a\u009fb'), 'a?b');
});

test('the tail is read backwards in chunks and never reads the whole file', async t => {
  const root = await fs.mkdtemp('/tmp/hs-tail-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'big.log');
  const body = numbered(200000, 'a fairly long synthetic log line number').join('\n') + '\n';
  await fs.writeFile(file, body);
  const size = Buffer.byteLength(body);
  assert.ok(size > 8 * 1024 * 1024);
  const handle = await fs.open(file, 'r');
  try {
    const tail = await readTailLines(handle, size, 5);
    assert.deepEqual(tail.lines, numbered(200000, 'a fairly long synthetic log line number').slice(-5));
    assert.ok(tail.bytesRead <= 64 * 1024, `read ${tail.bytesRead} bytes`);
    assert.equal(tail.truncated, false);
    const many = await readTailLines(handle, size, 2000);
    assert.equal(many.lines.length, 2000);
    assert.equal(many.lines.at(-1), 'a fairly long synthetic log line number 200000');
    assert.ok(many.bytesRead < size / 10);
    // The scan bound applies even when no line break is found.
    const bounded = await readTailLines(handle, size, 1_000_000, { chunkBytes: 4096, maximumBytes: 32768 });
    assert.ok(bounded.bytesRead <= 32768);
    assert.equal(bounded.truncated, true);
    assert.ok(bounded.lines.length > 0 && bounded.lines.length < 1000);
    assert.ok(bounded.lines.every(line => /^a fairly long synthetic log line number \d+$/.test(line)), 'a partial first line is never returned');
  } finally { await handle.close(); }
});

test('the tail is correct across chunk boundaries, without a final newline, with multibyte text and for short or empty files', async t => {
  const root = await fs.mkdtemp('/tmp/hs-tail-');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const tail = async (text, count, chunkBytes) => {
    const file = path.join(root, 'sample.log');
    await fs.writeFile(file, text);
    const handle = await fs.open(file, 'r');
    try { return (await readTailLines(handle, Buffer.byteLength(text), count, { chunkBytes })).lines; } finally { await handle.close(); }
  };
  const lines = ['alpha', 'béta ✓', '', 'gamma 🚀 long long long', 'delta', 'epsilon'];
  for (const chunkBytes of [1, 2, 3, 5, 7, 16, 64 * 1024]) {
    for (const count of [1, 2, 3, 5, 6, 9]) {
      assert.deepEqual(await tail(lines.join('\n') + '\n', count, chunkBytes), lines.slice(-count), `newline-terminated, chunk ${chunkBytes}, count ${count}`);
      assert.deepEqual(await tail(lines.join('\n'), count, chunkBytes), lines.slice(-count), `unterminated, chunk ${chunkBytes}, count ${count}`);
    }
  }
  assert.deepEqual(await tail('', 3, 8), []);
  assert.deepEqual(await tail('\n', 3, 8), ['']);
});

test('logs reports unavailable logs accurately and creates nothing', { skip: !posix }, async t => {
  const f = await fixture(t);
  const manager = manage(f);
  let outcome = await run(f, manager, 'logs', ['--coordinator-config', f.configFile]);
  assert.equal(outcome.status, 1);
  assert.equal(outcome.stdout, '');
  assert.match(outcome.stderr, /No coordinator has used/);
  await assert.rejects(fs.lstat(f.stateDirectory));
  await fs.mkdir(f.stateDirectory, { mode: 0o700 });
  outcome = await run(f, manager, 'logs', ['--coordinator-config', f.configFile]);
  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /No coordinator logs exist/);
  assert.match(outcome.stderr, /never started/);
  assert.deepEqual(await fs.readdir(f.stateDirectory), [], 'logs never creates the log directory');
  await fs.mkdir(path.join(f.stateDirectory, 'logs'), { mode: 0o700 });
  outcome = await run(f, manager, 'logs', ['--coordinator-config', f.configFile]);
  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /No coordinator logs exist/);
  assert.deepEqual(manager.calls, []);
  // One file present: it is shown and the absent one is named on stderr.
  await fs.writeFile(path.join(f.stateDirectory, 'logs', 'coordinator.err.log'), 'only stderr\n', { mode: 0o600 });
  outcome = await run(f, manager, 'logs', ['--coordinator-config', f.configFile]);
  assert.equal(outcome.status, 0);
  assert.match(outcome.stdout, /only stderr/);
  assert.match(outcome.stderr, /coordinator\.out\.log: It does not exist yet/);
  // Empty files are reported as empty, not as an error.
  await fs.writeFile(path.join(f.stateDirectory, 'logs', 'coordinator.err.log'), '', { mode: 0o600 });
  outcome = await run(f, manager, 'logs', ['--coordinator-config', f.configFile]);
  assert.equal(outcome.status, 0);
  assert.match(outcome.stderr, /empty so far/);
});

test('logs refuses symlinked, non-private and non-regular destinations without following them', { skip: !posix }, async t => {
  const { f, paths, manager } = await logFixture(t, { out: 'private\n', err: '' });
  const secret = path.join(f.root, 'secret.txt');
  await fs.writeFile(secret, 'must not be read\n', { mode: 0o600 });
  await fs.rm(paths.standardError);
  await fs.symlink(secret, paths.standardError);
  let outcome = await run(f, manager, 'logs', ['--coordinator-config', f.configFile]);
  assert.equal(outcome.status, 1);
  assert.ok(!outcome.stdout.includes('must not be read'));
  assert.match(outcome.stdout, /private/);
  assert.match(outcome.stderr, /must not be a symbolic link/);
  await fs.rm(paths.standardError);
  await fs.writeFile(paths.standardError, 'shared\n', { mode: 0o644 });
  await fs.chmod(paths.standardError, 0o644);
  outcome = await run(f, manager, 'logs', ['--coordinator-config', f.configFile]);
  assert.equal(outcome.status, 1);
  assert.ok(!outcome.stdout.includes('shared'));
  assert.match(outcome.stderr, /mode 0600/);
  await fs.rm(paths.standardError);
  await fs.mkdir(paths.standardError, { mode: 0o700 });
  outcome = await run(f, manager, 'logs', ['--coordinator-config', f.configFile]);
  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /regular file|cannot be (opened|read)/);
  await fs.rm(paths.standardError, { recursive: true });
  await fs.chmod(path.dirname(paths.standardOut), 0o755);
  outcome = await run(f, manager, 'logs', ['--coordinator-config', f.configFile]);
  assert.equal(outcome.status, 1);
  assert.equal(outcome.stdout, '');
  assert.match(outcome.stderr, /log directory cannot be read safely/);
});

test('logs --follow prints appended output, survives truncation, and Ctrl-C closes only the reader', { skip: !posix, timeout: 30000 }, async t => {
  const { f, paths, manager } = await logFixture(t, { out: 'old one\nold two\n', err: '' });
  const signals = new EventEmitter();
  const { out, streams } = capture();
  const pending = lifecycleCommandMain('logs', ['--coordinator-config', f.configFile, '--lines', '1', '--follow'], {
    streams, signals,
    dependencies: { environment: { HOME: f.home }, platform: 'darwin', createAdapter: manager.createAdapter, pollIntervalMs: 20 },
  });
  await until(() => out.stdout.includes('old two'), 'the initial tail was not printed');
  assert.ok(!out.stdout.includes('old one'));
  await fs.appendFile(paths.standardOut, 'new a\nnew b\npart');
  await until(() => out.stdout.includes('new b'), 'appended lines were not followed');
  assert.ok(!out.stdout.includes('part'), 'an unterminated line waits for its line break');
  await fs.appendFile(paths.standardOut, 'ial\n');
  await until(() => out.stdout.includes('partial'), 'the completed line was not printed');
  await fs.appendFile(paths.standardError, 'err one\n');
  await until(() => out.stdout.includes('err one'), 'the second file was not followed');
  assert.match(out.stdout, new RegExp(`==> ${paths.standardError.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} <==\\nerr one`));
  await fs.writeFile(paths.standardOut, 'restarted\n');
  await until(() => out.stdout.includes('restarted'), 'a truncated file was not read again from its start');
  const before = await fs.readFile(paths.standardOut, 'utf8');
  signals.emit('SIGINT');
  const status = await pending;
  assert.equal(status, FOLLOW_INTERRUPTED_EXIT_CODE);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.equal(await fs.readFile(paths.standardOut, 'utf8'), before, 'logs never writes the files');
  assert.deepEqual(manager.calls, []);
  const settled = out.stdout;
  await fs.appendFile(paths.standardOut, 'after interrupt\n');
  await sleep(120);
  assert.equal(out.stdout, settled, 'the reader stopped');
});

// --- Linux journal ------------------------------------------------------------------------------------------

function fakeJournal() {
  const calls = [];
  const spawnProcess = (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = [];
    child.kill = signal => { child.killed.push(signal); setImmediate(() => child.emit('close', null, signal)); return true; };
    calls.push({ file, args, options, child });
    return child;
  };
  return { calls, spawnProcess };
}

const linux = (f, journal, extra = {}) => ({ platform: 'linux', dependencies: { journalctl: '/usr/bin/journalctl', spawnProcess: journal.spawnProcess, ...extra } });

test('on Linux logs reads only the owned unit through journalctl with an argument array', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const manager = manage(f);
  const journal = fakeJournal();
  const pending = run(f, manager, 'logs', ['--coordinator-config', f.configFile, '--lines', '7'], linux(f, journal));
  await until(() => journal.calls.length === 1, 'journalctl was not started');
  const [{ file, args, options, child }] = journal.calls;
  const unit = nativeServiceNames(f.stateDirectory).systemdUnit;
  assert.equal(file, '/usr/bin/journalctl');
  assert.deepEqual(args, ['--user', '-u', unit, '-n', '7', '--no-pager', '-o', 'short-iso']);
  assert.ok(!options.shell && options.stdio[0] === 'ignore');
  child.stdout.write('2026-01-01T00:00:00+0000 host unit[1]: first\n2026-01-01T00:00:01+0000 host unit[1]: sec\u001b[31mond\n2026-01-01 partial');
  child.stdout.end();
  child.emit('close', 0, null);
  const outcome = await pending;
  assert.equal(outcome.status, 0);
  assert.equal(outcome.stdout, '2026-01-01T00:00:00+0000 host unit[1]: first\n2026-01-01T00:00:01+0000 host unit[1]: second\n2026-01-01 partial\n');
  assert.deepEqual(manager.calls, []);
  await assert.rejects(fs.lstat(f.stateDirectory), 'the journal path reads no state files');
});

test('on Linux a failing or missing journalctl is reported as unavailable', async t => {
  const f = await fixture(t);
  const manager = manage(f);
  let journal = fakeJournal();
  let pending = run(f, manager, 'logs', ['--coordinator-config', f.configFile], linux(f, journal));
  await until(() => journal.calls.length === 1, 'journalctl was not started');
  journal.calls[0].child.stderr.write('Failed to connect to bus: No medium found\n');
  journal.calls[0].child.emit('close', 1, null);
  let outcome = await pending;
  assert.equal(outcome.status, 1);
  assert.equal(outcome.stdout, '');
  assert.match(outcome.stderr, /journalctl exited with status 1: Failed to connect to bus/);
  journal = fakeJournal();
  pending = run(f, manager, 'logs', ['--coordinator-config', f.configFile], linux(f, journal));
  await until(() => journal.calls.length === 1, 'journalctl was not started');
  journal.calls[0].child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
  outcome = await pending;
  assert.equal(outcome.status, 1);
  assert.match(outcome.stderr, /journalctl could not run/);
  const missing = await run(f, manager, 'logs', ['--coordinator-config', f.configFile], { platform: 'linux', dependencies: { journalctl: undefined, spawnProcess: () => { throw new Error('ENOENT'); } } });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /journalctl/);
});

test('on Linux --follow adds -f and Ctrl-C ends only the journal reader', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const manager = manage(f);
  const journal = fakeJournal();
  const signals = new EventEmitter();
  const pending = run(f, manager, 'logs', ['--coordinator-config', f.configFile, '--follow'], { ...linux(f, journal), signals });
  await until(() => journal.calls.length === 1, 'journalctl was not started');
  const [{ args, child }] = journal.calls;
  assert.deepEqual(args, ['--user', '-u', nativeServiceNames(f.stateDirectory).systemdUnit, '-n', '100', '--no-pager', '-f', '-o', 'short-iso']);
  child.stdout.write('streamed line\n');
  signals.emit('SIGINT');
  const outcome = await pending;
  assert.equal(outcome.status, FOLLOW_INTERRUPTED_EXIT_CODE);
  assert.deepEqual(child.killed, ['SIGTERM'], 'only the reader this command started is ended');
  assert.match(outcome.stdout, /streamed line/);
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('on Linux a real child process is spawned without a shell and ended on Ctrl-C', { skip: !posix, timeout: 30000 }, async t => {
  const f = await fixture(t);
  const manager = manage(f);
  const script = path.join(f.root, 'journalctl');
  const argvFile = path.join(f.root, 'argv.txt');
  const pidFile = path.join(f.root, 'pid.txt');
  await fs.writeFile(script, `#!/bin/sh\nprintf '%s\\n' "$@" > "$ARGV_FILE"\necho $$ > "$PID_FILE"\necho 'unit line'\nexec sleep 30\n`, { mode: 0o755 });
  const signals = new EventEmitter();
  const environment = { ARGV_FILE: argvFile, PID_FILE: pidFile, PATH: process.env.PATH };
  const pending = run(f, manager, 'logs', ['--coordinator-config', f.configFile, '--lines', '3', '--follow'], { platform: 'linux', signals, environment, dependencies: { journalctl: script } });
  await until(async () => (await fs.readFile(pidFile, 'utf8').catch(() => '')).trim() !== '', 'the journal reader did not start');
  const pid = Number((await fs.readFile(pidFile, 'utf8')).trim());
  assert.deepEqual((await fs.readFile(argvFile, 'utf8')).trim().split('\n'), ['--user', '-u', nativeServiceNames(f.stateDirectory).systemdUnit, '-n', '3', '--no-pager', '-f', '-o', 'short-iso']);
  signals.emit('SIGINT');
  const outcome = await pending;
  assert.equal(outcome.status, FOLLOW_INTERRUPTED_EXIT_CODE);
  assert.match(outcome.stdout, /unit line/);
  await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 'the journal reader was not ended');
});
