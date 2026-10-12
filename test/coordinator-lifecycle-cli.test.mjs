import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { lifecycleCommandMain } from '../dist/coordinator/lifecycle-cli.js';
import { parseLifecycleArguments } from '../dist/coordinator/lifecycle-arguments.js';
import { LIFECYCLE_OUTCOMES, createLifecycleResult, lifecycleExitCode, parseLifecycleResult, renderLifecycleJson, sanitizeResultText } from '../dist/coordinator/lifecycle-result.js';
import { acquireOperationLock, advanceStopGeneration, readStopGeneration } from '../dist/coordinator/lifecycle-lock.js';
import { startCoordinatorService } from '../dist/coordinator/service.js';
import { nativeServiceNames } from '../dist/coordinator/native/types.js';
import { FakeServiceManager } from './fixtures/fake-native-service.mjs';

const posix = process.platform !== 'win32';
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repository, 'dist', 'cli.js');
const driver = path.join(repository, 'test', 'pty', 'driver.py');
const SENTINEL = 'sentinel-credential-7d41c9e0b2a8';
const SPECIAL = 's p\'"$;&';
const idleExecutor = { launch: async () => new Promise(() => {}), inspect: async () => ({ idle: true, status: 'failed' }), interrupt: async () => { throw new Error('Lifecycle commands must not interrupt native execution'); } };
const scheduler = { createWorktree: async () => {}, verifyWorktree: async () => {}, prepare: async () => {} };

/**
 * An isolated HOME, state directory and coordinator configuration. Cleanups run before the directory is removed,
 * so services a test started are ended first. Short roots keep the Unix socket path within its portable limit.
 */
async function fixture(t, { state = 'state', configName = 'coordinator.toml' } = {}) {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/hl-'));
  const cleanups = [];
  t.after(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup().catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  const home = path.join(root, 'home');
  await fs.mkdir(home);
  const stateDirectory = path.join(root, state);
  const configFile = path.join(root, configName);
  await fs.writeFile(configFile, `[coordinator]\nstateDirectory = ${JSON.stringify(stateDirectory)}\n`);
  return {
    root, home, stateDirectory, configFile, endpoint: path.join(stateDirectory, 'coordinator.sock'),
    onCleanup: cleanup => cleanups.push(cleanup),
  };
}

async function credentialFile(f, name = 'opencode.env', body = `OPENCODE_SERVER_PASSWORD=${SENTINEL}\n`, mode = 0o600) {
  const file = path.join(f.root, name);
  await fs.writeFile(file, body, { mode });
  await fs.chmod(file, mode);
  return file;
}

function manage(t, f, options = {}) {
  const manager = new FakeServiceManager(options);
  f.onCleanup(() => manager.terminate());
  return manager;
}

function capture() {
  const out = { stdout: '', stderr: '' };
  return { out, streams: { stdout: { write: text => { out.stdout += text; } }, stderr: { write: text => { out.stderr += text; } } } };
}

/** Run a lifecycle command in-process with the fake native service manager and captured streams. */
async function run(f, manager, command, args, { environment = {}, signals, dependencies = {}, platform = 'darwin' } = {}) {
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

/** JSON mode: stdout is exactly one document and it satisfies the documented contract. */
async function runJson(f, manager, command, args, options) {
  const outcome = await run(f, manager, command, [...args, '--json'], options);
  const document = parseLifecycleResult(JSON.parse(outcome.stdout));
  assert.equal(outcome.stdout, renderLifecycleJson(document), 'stdout must be exactly one document');
  assert.equal(outcome.status, lifecycleExitCode(document));
  assert.equal(outcome.status === 0, document.ok);
  return { ...outcome, document };
}

async function walk(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => [])) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

async function assertNoSentinel(f, manager, ...texts) {
  // The credential input file itself holds the sentinel; everything Heimdall or the coordinator wrote must not.
  for (const file of [...await walk(f.stateDirectory), ...await walk(f.home)]) assert.ok(!(await fs.readFile(file)).includes(SENTINEL), `${file} contains the credential sentinel`);
  for (const text of [...texts, manager.output.stdout, manager.output.stderr, JSON.stringify(manager.spawns), manager.definition?.text ?? '']) assert.ok(!text.includes(SENTINEL));
}

/** Node prints its SQLite experimental warning on first use; it is not command output. */
const withoutWarnings = text => text.split('\n').filter(line => !/ExperimentalWarning|--trace-warnings/.test(line)).join('\n');

const fingerprint = async file => { const stat = await fs.stat(file); return `${stat.mtimeMs}:${stat.size}:${createHash('sha256').update(await fs.readFile(file)).digest('hex')}`; };

function foreground(t, f, extra = {}) {
  return startCoordinatorService({
    configuration: { stateDirectory: f.stateDirectory, endpoint: f.endpoint, globalConcurrency: 1, projectConcurrency: 1 },
    executor: idleExecutor, scheduler, pollIntervalMs: 5, ...extra,
  }).then(service => { f.onCleanup(() => service.close()); return service; });
}

async function exists(file) { try { await fs.lstat(file); return true; } catch { return false; } }

test('argument parsing defaults, ranges and exclusions are decided before anything is consulted', () => {
  const start = parseLifecycleArguments('start', []);
  assert.deepEqual([start.timeoutSeconds, start.timeoutExplicit, start.json, start.envFile], [30, false, false, undefined]);
  const stop = parseLifecycleArguments('stop', []);
  assert.deepEqual([stop.timeoutSeconds, stop.timeoutExplicit, stop.noWait], [60, false, false]);
  assert.equal(parseLifecycleArguments('logs', []).lines, 100);
  assert.equal(parseLifecycleArguments('start', ['--timeout', '3600']).timeoutSeconds, 3600);
  assert.equal(parseLifecycleArguments('start', ['--timeout', '1.5']).timeoutSeconds, 1.5);
  assert.equal(parseLifecycleArguments('stop', ['--timeout', '1', '--json']).timeoutExplicit, true);
  assert.equal(parseLifecycleArguments('stop', ['--no-wait']).noWait, true);
  assert.equal(parseLifecycleArguments('logs', ['--lines', '10000', '--follow']).lines, 10000);
  assert.equal(parseLifecycleArguments('start', ['--bogus', '--help']).help, true);
});

const invalidArguments = [
  ['start', ['--bogus'], /Unknown option/],
  ['start', ['extra'], /Unexpected argument/],
  ['start', ['--json', '--json'], /Repeated option/],
  ['start', ['--timeout', '5', '--timeout', '6'], /Repeated option/],
  ['start', ['--coordinator-config', 'a', '--coordinator-config', 'b'], /Repeated option/],
  ['start', ['--env-file', 'a', '--env-file', 'b'], /Repeated option/],
  ['start', ['--timeout'], /requires a value/],
  ['start', ['--timeout', '--json'], /requires a value/],
  ['start', ['--coordinator-config'], /requires a value/],
  ['start', ['--env-file'], /requires a value/],
  ['start', ['--env-file', ''], /nonempty path/],
  ['start', ['--coordinator-config', ''], /nonempty path/],
  ['start', ['--env-file', 'bad\nname'], /control characters/],
  ['start', ['--timeout', '0'], /--timeout must be/],
  ['start', ['--timeout', '0.9'], /--timeout must be/],
  ['start', ['--timeout', '3601'], /--timeout must be/],
  ['start', ['--timeout', '-5'], /--timeout must be/],
  ['start', ['--timeout', 'abc'], /--timeout must be/],
  ['start', ['--timeout', '1e2'], /--timeout must be/],
  ['start', ['--timeout', '0x10'], /--timeout must be/],
  ['start', ['--timeout', ' 5'], /--timeout must be/],
  ['start', ['--timeout', 'Infinity'], /--timeout must be/],
  ['start', ['--timeout', 'NaN'], /--timeout must be/],
  ['start', ['--no-wait'], /does not apply to start/],
  ['start', ['--lines', '5'], /does not apply to start/],
  ['start', ['--follow'], /does not apply to start/],
  ['stop', ['--env-file', 'x'], /does not apply to stop/],
  ['stop', ['--lines', '5'], /does not apply to stop/],
  ['stop', ['--no-wait', '--timeout', '5'], /cannot be combined/],
  ['stop', ['--timeout', '5', '--no-wait'], /cannot be combined/],
  ['stop', ['--no-wait', '--no-wait'], /Repeated option/],
  ['stop', ['--timeout', '3601'], /--timeout must be/],
  ['logs', ['--json'], /does not apply to logs/],
  ['logs', ['--timeout', '5'], /does not apply to logs/],
  ['logs', ['--env-file', 'x'], /does not apply to logs/],
  ['logs', ['--lines', '0'], /--lines must be/],
  ['logs', ['--lines', '10001'], /--lines must be/],
  ['logs', ['--lines', '-1'], /--lines must be/],
  ['logs', ['--lines', '1.5'], /--lines must be/],
  ['logs', ['--lines', '1e3'], /--lines must be/],
  ['logs', ['--lines', 'many'], /--lines must be/],
  ['logs', ['--lines', '5', '--lines', '6'], /Repeated option/],
  ['logs', ['--follow', '--follow'], /Repeated option/],
];

test('every malformed, repeated, unknown or inapplicable option fails with status 2 before any side effect', async t => {
  const f = await fixture(t);
  const manager = manage(t, f);
  const before = await fingerprint(f.configFile);
  for (const [command, args, pattern] of invalidArguments) {
    const label = `${command} ${JSON.stringify(args)}`;
    const plain = await run(f, manager, command, args);
    assert.equal(plain.status, 2, label);
    if (!args.includes('--json')) {
      assert.equal(plain.stdout, '', label);
      assert.match(plain.stderr, pattern, label);
      assert.match(plain.stderr, new RegExp(`coordinator ${command} --help`), label);
      assert.equal(plain.result, null, label);
    }
    if (command === 'logs') continue;
    // JSON mode prints exactly one document on stdout, even for an argument error.
    const json = await run(f, manager, command, [...args, '--json']);
    assert.equal(json.status, 2, label);
    const document = parseLifecycleResult(JSON.parse(json.stdout));
    assert.equal(json.stdout, renderLifecycleJson(document), label);
    assert.deepEqual([document.command, document.outcome, document.ok, document.error.code, document.target, document.instance], [command, 'failed', false, 'invalid-arguments', null, null], label);
    assert.match(document.error.message, pattern, label);
    assert.equal(json.stderr, '', label);
  }
  assert.deepEqual(manager.calls, []);
  assert.equal(manager.spawnCount, 0);
  assert.equal(await exists(f.stateDirectory), false, 'argument errors must not create state');
  assert.deepEqual(await fs.readdir(f.home), []);
  assert.equal(await fingerprint(f.configFile), before);
});

test('help paths exit 0, print usage and create nothing', async t => {
  const f = await fixture(t);
  const manager = manage(t, f);
  for (const command of ['start', 'stop', 'logs']) {
    for (const args of [['--help'], ['--bogus', '--help'], ['--timeout', '0', '--help', '--json']]) {
      const outcome = await run(f, manager, command, args);
      assert.equal(outcome.status, 0, `${command} ${args}`);
      assert.match(outcome.stdout, new RegExp(`^heimdall coordinator ${command} `));
      assert.equal(outcome.stderr, '');
    }
  }
  assert.deepEqual(manager.calls, []);
  assert.equal(await exists(f.stateDirectory), false);
  assert.deepEqual(await fs.readdir(f.home), []);
});

test('the real command line dispatches start/stop/logs parsing without a service manager and reports one document', { skip: !posix }, async t => {
  const f = await fixture(t);
  const environment = { PATH: process.env.PATH, HOME: f.home };
  const help = spawnSync(process.execPath, [cli, 'coordinator', 'start', '--help'], { cwd: f.root, env: environment, encoding: 'utf8', input: '' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /heimdall coordinator start/);
  const json = spawnSync(process.execPath, [cli, 'coordinator', 'start', '--bogus', '--json'], { cwd: f.root, env: environment, encoding: 'utf8', input: '' });
  assert.equal(json.status, 2);
  assert.equal(parseLifecycleResult(JSON.parse(json.stdout)).error.code, 'invalid-arguments');
  assert.equal(withoutWarnings(json.stderr), '');
  const plain = spawnSync(process.execPath, [cli, 'coordinator', 'stop', '--no-wait', '--timeout', '5'], { cwd: f.root, env: environment, encoding: 'utf8', input: '' });
  assert.equal(plain.status, 2);
  assert.equal(plain.stdout, '');
  assert.match(plain.stderr, /cannot be combined/);
  const missing = spawnSync(process.execPath, [cli, 'coordinator', 'start', '--coordinator-config', path.join(f.root, 'absent.toml'), '--json'], { cwd: f.root, env: environment, encoding: 'utf8', input: '' });
  assert.equal(missing.status, 1);
  assert.equal(parseLifecycleResult(JSON.parse(missing.stdout)).error.code, 'invalid-configuration');
  assert.deepEqual(await fs.readdir(f.home), []);
  assert.equal(await exists(f.stateDirectory), false);
  const listed = spawnSync(process.execPath, [cli, 'coordinator', '--help'], { cwd: f.root, env: environment, encoding: 'utf8', input: '' });
  assert.match(listed.stdout, /coordinator start /);
});

test('result documents are strict, sanitized and one-to-one with exit status', () => {
  const secret = 'sentinel-credential-abcdef';
  const text = `failed with ${secret} and key ${'a'.repeat(64)}\u0007\n${'x'.repeat(5000)}`;
  const sanitized = sanitizeResultText(text, [secret]);
  assert.ok(!sanitized.includes(secret) && !sanitized.includes('a'.repeat(64)) && !/[\u0000-\u001f]/.test(sanitized));
  assert.ok(sanitized.length <= 2000);
  for (const outcome of LIFECYCLE_OUTCOMES) {
    const ok = ['ready', 'already-running', 'already-running-foreground', 'stop-requested', 'stopped', 'already-stopped'].includes(outcome);
    const result = createLifecycleResult({ command: 'start', outcome, message: `outcome ${secret}`, ...(ok ? {} : { error: { code: 'internal', message: `detail ${secret}` } }) }, [secret]);
    assert.equal(result.ok, ok, outcome);
    assert.equal(lifecycleExitCode(result) === 0, ok, outcome);
    assert.ok(!JSON.stringify(result).includes(secret));
    assert.deepEqual(parseLifecycleResult(JSON.parse(renderLifecycleJson(result))), result);
  }
  assert.throws(() => createLifecycleResult({ command: 'start', outcome: 'ready', message: 'x', error: { code: 'internal', message: 'y' } }));
  assert.throws(() => createLifecycleResult({ command: 'start', outcome: 'failed', message: 'x' }));
  const valid = createLifecycleResult({ command: 'start', outcome: 'ready', message: 'ok' });
  for (const tampered of [{ ...valid, extra: 1 }, { ...valid, schemaVersion: 2 }, { ...valid, ok: false }, { ...valid, outcome: 'nope' }, { ...valid, command: 'logs' }, { ...valid, error: { code: 'internal', message: 'x' } }, { ...valid, instance: { instanceId: 'a', pid: 1.5, mode: 'managed' } }]) {
    assert.throws(() => parseLifecycleResult(tampered));
  }
});

test('start launches the managed coordinator and reports ready; a repeated start leaves the instance unchanged', { skip: !posix }, async t => {
  const f = await fixture(t);
  const manager = manage(t, f);
  const before = await fingerprint(f.configFile);
  const first = await runJson(f, manager, 'start', ['--coordinator-config', f.configFile]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.document.outcome, 'ready');
  assert.equal(first.document.command, 'start');
  assert.deepEqual(first.document.target, { configFile: f.configFile, origin: 'flag', stateDirectory: f.stateDirectory, endpoint: f.endpoint, manager: 'launchd', label: nativeServiceNames(f.stateDirectory).launchdLabel });
  assert.equal(first.document.instance.mode, 'managed');
  assert.equal(first.document.instance.pid, manager.child.pid);
  assert.match(first.stderr, /Starting the coordinator/);
  assert.equal(manager.spawnCount, 1);
  assert.deepEqual(manager.calls.filter(call => ['install', 'start'].includes(call)), ['install', 'start']);
  const second = await runJson(f, manager, 'start', ['--coordinator-config', f.configFile]);
  assert.equal(second.status, 0);
  assert.equal(second.document.outcome, 'already-running');
  assert.equal(second.document.instance.instanceId, first.document.instance.instanceId);
  assert.equal(manager.spawnCount, 1);
  assert.deepEqual(manager.calls.filter(call => ['install', 'start'].includes(call)), ['install', 'start']);
  const plain = await run(f, manager, 'start', ['--coordinator-config', f.configFile]);
  assert.equal(plain.status, 0);
  assert.match(plain.stdout, /already running/i);
  assert.equal(plain.stderr, '');
  assert.equal(await fingerprint(f.configFile), before, 'the configuration file must not be rewritten');
  assert.equal(await exists(f.endpoint), true);
});

test('simultaneous starts leave exactly one owned process', { skip: !posix }, async t => {
  const f = await fixture(t);
  const manager = manage(t, f);
  const outcomes = await Promise.all([1, 2, 3].map(() => runJson(f, manager, 'start', ['--coordinator-config', f.configFile, '--timeout', '30'])));
  const names = outcomes.map(outcome => outcome.document.outcome).sort();
  assert.equal(names.filter(name => name === 'ready').length, 1, names.join());
  for (const name of names) assert.ok(['ready', 'already-running', 'busy'].includes(name), name);
  assert.equal(manager.spawnCount, 1);
  assert.equal(new Set(outcomes.filter(outcome => outcome.document.instance).map(outcome => outcome.document.instance.instanceId)).size, 1);
});

test('a foreground coordinator is reported as already-running-foreground and nothing is registered', { skip: !posix }, async t => {
  const f = await fixture(t);
  const manager = manage(t, f);
  const service = await foreground(t, f);
  const outcome = await runJson(f, manager, 'start', ['--coordinator-config', f.configFile]);
  assert.equal(outcome.status, 0);
  assert.equal(outcome.document.outcome, 'already-running-foreground');
  assert.equal(outcome.document.instance.mode, 'foreground');
  assert.equal(outcome.document.instance.pid, process.pid);
  assert.ok(!manager.calls.some(call => ['install', 'start'].includes(call)), manager.calls.join());
  assert.equal(manager.spawnCount, 0);
  assert.equal(manager.definition, null);
  assert.equal(await exists(path.join(f.stateDirectory, 'service')), false);
  assert.ok(service.endpoint);
});

test('start during a drain reports shutdown-in-progress without restarting or re-enabling admission', { skip: !posix }, async t => {
  const label = nativeServiceNames(path.join('/tmp', 'unused')).launchdLabel;
  assert.ok(label);
  for (const mode of ['foreground', 'managed']) {
    const f = await fixture(t);
    const manager = manage(t, f);
    const lifecycle = mode === 'managed' ? { lifecycle: { mode: 'managed', label: nativeServiceNames(f.stateDirectory).launchdLabel } } : {};
    const service = await foreground(t, f, lifecycle);
    await service.drain();
    const outcome = await runJson(f, manager, 'start', ['--coordinator-config', f.configFile]);
    assert.equal(outcome.status, 1, mode);
    assert.equal(outcome.document.outcome, 'shutdown-in-progress', mode);
    assert.equal(outcome.document.error.code, 'shutdown-in-progress', mode);
    assert.equal(outcome.document.instance.mode, mode);
    assert.match(outcome.document.message, /not restarted/);
    assert.equal(manager.spawnCount, 0);
    assert.ok(!manager.calls.some(call => ['install', 'start'].includes(call)));
    const status = await service.status?.();
    if (status) assert.equal(status.acceptingNewRuns, false);
  }
});

test('a start that waited before a successful stop does not run after it', { skip: !posix }, async t => {
  const f = await fixture(t);
  const manager = manage(t, f);
  const held = await acquireOperationLock(f.stateDirectory, { deadlineAt: Date.now() + 60000 });
  assert.equal(held.acquired, true);
  f.onCleanup(async () => held.lock.release());
  let waiting;
  const sawWaiting = new Promise(resolve => { waiting = resolve; });
  const pending = runJson(f, manager, 'start', ['--coordinator-config', f.configFile, '--timeout', '30'], {
    dependencies: { progress: text => { if (/waiting for it to finish/.test(text)) waiting(); } },
  });
  await sawWaiting;
  assert.equal(await readStopGeneration(f.stateDirectory), 0);
  await advanceStopGeneration(f.stateDirectory);
  held.lock.release();
  const outcome = await pending;
  assert.equal(outcome.status, 1);
  assert.equal(outcome.document.outcome, 'conflict');
  assert.equal(outcome.document.error.code, 'superseded-by-stop');
  assert.equal(manager.spawnCount, 0);
  assert.ok(!manager.calls.includes('install'));
  // A new explicit start is the way back.
  const again = await runJson(f, manager, 'start', ['--coordinator-config', f.configFile]);
  assert.equal(again.document.outcome, 'ready');
  assert.equal(await readStopGeneration(f.stateDirectory), 1);
});

test('the operation lock is bounded: a held lock ends in busy, not a start', { skip: !posix }, async t => {
  const f = await fixture(t);
  const manager = manage(t, f);
  const held = await acquireOperationLock(f.stateDirectory, { deadlineAt: Date.now() + 60000 });
  assert.equal(held.acquired, true);
  f.onCleanup(async () => held.lock.release());
  const started = Date.now();
  const outcome = await runJson(f, manager, 'start', ['--coordinator-config', f.configFile, '--timeout', '1']);
  assert.ok(Date.now() - started < 5000);
  assert.equal(outcome.status, 1);
  assert.equal(outcome.document.outcome, 'busy');
  assert.equal(outcome.document.error.code, 'busy');
  assert.match(outcome.stderr, /waiting for it to finish/);
  assert.equal(manager.spawnCount, 0);
  assert.deepEqual(manager.calls, []);
  const lockFile = held.lock.path;
  assert.equal((await fs.stat(lockFile)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(lockFile))).mode & 0o777, 0o700);
  // The operating system releases the lock with its holder, and a leftover file blocks nothing.
  held.lock.release();
  const free = await acquireOperationLock(f.stateDirectory, { deadlineAt: Date.now() });
  assert.equal(free.acquired, true);
  free.lock.release();
});

test('a service that never listens reports startup-not-confirmed with the observed state and log location, and is left running', { skip: !posix }, async t => {
  const f = await fixture(t);
  const manager = manage(t, f, { behavior: 'hang' });
  const started = Date.now();
  const outcome = await runJson(f, manager, 'start', ['--coordinator-config', f.configFile, '--timeout', '1']);
  assert.ok(Date.now() - started < 6000, 'the whole start stays within one deadline');
  assert.equal(outcome.status, 1);
  assert.equal(outcome.document.outcome, 'startup-not-confirmed');
  assert.equal(outcome.document.error.code, 'startup-timeout');
  assert.match(outcome.document.message, /does not exist yet|not stopped|did not stop/i);
  assert.match(outcome.document.logs, /fake service output/);
  assert.equal(manager.running(), true, 'start never stops what it launched');
  assert.equal(manager.spawnCount, 1);
});

test('a service that exits before listening reports startup-not-confirmed naming the exit', { skip: !posix }, async t => {
  const f = await fixture(t);
  const manager = manage(t, f, { behavior: 'exit' });
  const outcome = await runJson(f, manager, 'start', ['--coordinator-config', f.configFile, '--timeout', '20']);
  assert.equal(outcome.status, 1);
  assert.equal(outcome.document.outcome, 'startup-not-confirmed');
  assert.equal(outcome.document.error.code, 'service-exited');
  assert.match(outcome.document.message, /exit status 3/);
  assert.match(outcome.document.logs, /Process logs:/);
});

test('Ctrl-C while waiting ends only the client; the launch is not reversed', { skip: !posix }, async t => {
  const f = await fixture(t);
  const manager = manage(t, f, { behavior: 'hang' });
  const signals = new EventEmitter();
  let waiting;
  const sawWaiting = new Promise(resolve => { waiting = resolve; });
  const pending = runJson(f, manager, 'start', ['--coordinator-config', f.configFile, '--timeout', '30'], {
    signals, dependencies: { progress: text => { if (/Waiting up to/.test(text)) waiting(); } },
  });
  await sawWaiting;
  signals.emit('SIGINT');
  const outcome = await pending;
  assert.equal(outcome.status, 1);
  assert.equal(outcome.document.outcome, 'startup-not-confirmed');
  assert.equal(outcome.document.error.code, 'interrupted');
  assert.equal(manager.running(), true);
  assert.equal(signals.listenerCount('SIGINT'), 0);
});

test('service manager failures are reported with the observed outcome and nothing is claimed cleaned up', { skip: !posix }, async t => {
  const f = await fixture(t);
  const manager = manage(t, f);
  manager.installFailure = { outcome: 'failed', registered: false, conflicts: [{ code: 'manager-unavailable', message: 'No user manager session.', action: 'Log in to a desktop session.', changes: [] }], detail: 'no manager' };
  const unavailable = await runJson(f, manager, 'start', ['--coordinator-config', f.configFile]);
  assert.equal(unavailable.document.outcome, 'failed');
  assert.equal(unavailable.document.error.code, 'manager-unavailable');
  assert.match(unavailable.document.message, /Log in to a desktop session/);
  manager.installFailure = { outcome: 'conflict', registered: false, conflicts: [{ code: 'registered-elsewhere', message: 'Registered from another path.', action: 'Remove it yourself.', changes: [] }], detail: 'conflict' };
  const conflict = await runJson(f, manager, 'start', ['--coordinator-config', f.configFile]);
  assert.equal(conflict.document.outcome, 'conflict');
  assert.equal(conflict.document.error.code, 'registered-elsewhere');
  assert.equal(manager.spawnCount, 0);
  const unsupported = await runJson(f, manager, 'start', ['--coordinator-config', f.configFile], { dependencies: { createAdapter: () => ({ supported: false, message: 'No native manager on this platform.' }) } });
  assert.equal(unsupported.document.outcome, 'failed');
  assert.equal(unsupported.document.error.code, 'unsupported-platform');
  manager.installFailure = null;
  manager.calls.length = 0;
  manager.foreign = 'file is not written by Heimdall';
  const foreign = await runJson(f, manager, 'start', ['--coordinator-config', f.configFile]);
  assert.equal(foreign.document.outcome, 'conflict');
  assert.equal(foreign.document.error.code, 'foreign-definition');
  assert.equal(manager.spawnCount, 0);
  assert.ok(!manager.calls.includes('install'));
});

test('a stale or unverifiable endpoint is reported as a conflict; nothing is removed or signalled', { skip: !posix }, async t => {
  const f = await fixture(t);
  const manager = manage(t, f);
  await fs.mkdir(f.stateDirectory, { mode: 0o700 });
  await fs.writeFile(f.endpoint, 'stale');
  const outcome = await runJson(f, manager, 'start', ['--coordinator-config', f.configFile]);
  assert.equal(outcome.status, 1);
  assert.equal(outcome.document.outcome, 'conflict');
  assert.equal(outcome.document.error.code, 'endpoint-refused');
  assert.match(outcome.document.message, /does not remove it|Nothing was started/);
  assert.equal(await fs.readFile(f.endpoint, 'utf8'), 'stale', 'the endpoint must stay');
  assert.equal(manager.spawnCount, 0);
  assert.ok(!manager.calls.includes('install'));
});

test('configuration precedence is flag over environment over the implicit default, and absent selected files fail before launch', { skip: !posix }, async t => {
  const f = await fixture(t);
  const manager = manage(t, f);
  const other = path.join(f.root, 'other.toml');
  const otherState = path.join(f.root, 'other-state');
  await fs.writeFile(other, `[coordinator]\nstateDirectory = ${JSON.stringify(otherState)}\n`);
  const bad = await credentialFile(f, 'bad.env', `OPENCODE_SERVER_PASSWORD=${SENTINEL}\n`, 0o644);
  // An invalid credential file stops each attempt after the target resolved and before anything is launched.
  const flagWins = await runJson(f, manager, 'start', ['--coordinator-config', f.configFile, '--env-file', bad], { environment: { HEIMDALL_COORDINATOR_CONFIG: other } });
  assert.deepEqual([flagWins.document.target.origin, flagWins.document.target.configFile, flagWins.document.target.stateDirectory], ['flag', f.configFile, f.stateDirectory]);
  const envWins = await runJson(f, manager, 'start', ['--env-file', bad], { environment: { HEIMDALL_COORDINATOR_CONFIG: other } });
  assert.deepEqual([envWins.document.target.origin, envWins.document.target.configFile, envWins.document.target.stateDirectory], ['env', other, otherState]);
  const previousHome = process.env.HOME;
  process.env.HOME = f.home;
  try {
    const implicit = await runJson(f, manager, 'start', ['--env-file', bad]);
    assert.equal(implicit.document.target.origin, 'implicit-default');
    assert.equal(implicit.document.target.configFile, path.join(f.home, '.config', 'heimdall', 'coordinator.toml'));
    assert.equal(implicit.document.target.stateDirectory, path.join(f.home, '.local', 'state', 'heimdall'), 'loader defaults apply when the implicit default file is absent');
  } finally { process.env.HOME = previousHome; }
  for (const document of [flagWins, envWins]) assert.equal(document.document.error.code, 'invalid-credentials');
  for (const missing of [
    runJson(f, manager, 'start', ['--coordinator-config', path.join(f.root, 'absent.toml')]),
    runJson(f, manager, 'start', [], { environment: { HEIMDALL_COORDINATOR_CONFIG: path.join(f.root, 'absent.toml') } }),
  ]) {
    const outcome = await missing;
    assert.equal(outcome.status, 1);
    assert.equal(outcome.document.error.code, 'invalid-configuration');
    assert.equal(outcome.document.target, null);
  }
  const broken = path.join(f.root, 'broken.toml');
  await fs.writeFile(broken, '[coordinator]\nunknownSetting = 1\n');
  const invalid = await runJson(f, manager, 'start', ['--coordinator-config', broken]);
  assert.equal(invalid.document.error.code, 'invalid-configuration');
  assert.match(invalid.document.message, /Unknown coordinator setting/);
  assert.equal(manager.spawnCount, 0);
  assert.deepEqual(manager.calls, []);
  assert.equal(await exists(f.stateDirectory), false);
  assert.equal(await exists(otherState), false);
  assert.deepEqual(await fs.readdir(f.home), [], 'nothing is created under HOME before a launch');
  await assertNoSentinel(f, manager, flagWins.stdout, flagWins.stderr, envWins.stdout, envWins.stderr);
});

test('an absent implicit default configuration starts with the loader defaults', { skip: !posix }, async t => {
  const f = await fixture(t);
  const manager = manage(t, f);
  const previousHome = process.env.HOME;
  process.env.HOME = f.home;
  try {
    const outcome = await runJson(f, manager, 'start', []);
    assert.equal(outcome.document.outcome, 'ready', outcome.stderr);
    assert.equal(outcome.document.target.origin, 'implicit-default');
    assert.equal(outcome.document.target.stateDirectory, path.join(f.home, '.local', 'state', 'heimdall'));
    assert.equal(await exists(path.join(f.home, '.config')), false, 'no configuration file is written');
    const [{ args, environment }] = manager.spawns;
    assert.equal(args.at(-1), path.join(f.home, '.config', 'heimdall', 'coordinator.toml'));
    assert.equal(environment.HEIMDALL_COORDINATOR_CONFIG_ORIGIN, 'implicit-default');
    assert.equal((await runJson(f, manager, 'start', [])).document.outcome, 'already-running');
  } finally { process.env.HOME = previousHome; }
});

test('paths with spaces and shell metacharacters work from any working directory and the launch is cwd independent', { skip: !posix }, async t => {
  const f = await fixture(t, { state: SPECIAL, configName: `conf ${SPECIAL}.toml` });
  const manager = manage(t, f);
  const previous = process.cwd();
  const elsewhere = await fs.mkdir(path.join(f.root, 'cwd'), { recursive: true }).then(() => path.join(f.root, 'cwd'));
  process.chdir(elsewhere);
  try {
    const relative = path.relative(elsewhere, f.configFile);
    assert.notEqual(relative, f.configFile);
    const outcome = await runJson(f, manager, 'start', ['--coordinator-config', relative]);
    assert.equal(outcome.document.outcome, 'ready', outcome.stderr);
    assert.equal(outcome.document.target.configFile, f.configFile, 'the configuration path is absolute in the result');
    assert.equal(outcome.document.target.stateDirectory, f.stateDirectory);
    const [{ args }] = manager.spawns;
    assert.ok(args.includes(f.configFile), 'the service receives the absolute configuration path as one argument');
    assert.ok(args.every(argument => !argument.includes(elsewhere)));
    process.chdir(f.root);
    assert.equal((await runJson(f, manager, 'start', ['--coordinator-config', path.relative(f.root, f.configFile)])).document.outcome, 'already-running');
  } finally { process.chdir(previous); }
});

test('explicit and remembered credential files are validated before launch, kept by path and never printed', { skip: !posix }, async t => {
  const f = await fixture(t);
  const manager = manage(t, f);
  const base = ['--coordinator-config', f.configFile];
  const file = await credentialFile(f);
  const loose = await credentialFile(f, 'loose.env', `OPENCODE_SERVER_PASSWORD=${SENTINEL}\n`, 0o644);
  const rejected = [
    await runJson(f, manager, 'start', [...base, '--env-file', path.join(f.root, 'absent.env')]),
    await runJson(f, manager, 'start', [...base, '--env-file', loose]),
    await runJson(f, manager, 'start', [...base, '--env-file', await credentialFile(f, 'bad.env', `HOME=${SENTINEL}\n`)]),
  ];
  for (const outcome of rejected) {
    assert.equal(outcome.status, 1);
    assert.equal(outcome.document.error.code, 'invalid-credentials');
    assert.equal(outcome.document.outcome, 'failed');
  }
  assert.equal(manager.spawnCount, 0);
  assert.deepEqual(manager.calls, []);
  assert.equal(manager.definition, null);

  const ready = await runJson(f, manager, 'start', [...base, '--env-file', file]);
  assert.equal(ready.document.outcome, 'ready', ready.stderr);
  assert.ok(manager.spawns[0].args.join('\n').includes(await fs.realpath(file)));
  assert.deepEqual(manager.spawns[0].args.slice(-2), ['--env-file', await fs.realpath(file)]);
  assert.equal(manager.definition.credentialFile, await fs.realpath(file));

  // Same file again: unchanged. A different file while running: conflict, nothing changes.
  const same = await runJson(f, manager, 'start', [...base, '--env-file', file]);
  assert.equal(same.document.outcome, 'already-running');
  const omitted = await runJson(f, manager, 'start', base);
  assert.equal(omitted.document.outcome, 'already-running');
  const another = await credentialFile(f, 'another.env', 'OPENCODE_SERVER_PASSWORD=another-secret-value-1234\n');
  const changed = await runJson(f, manager, 'start', [...base, '--env-file', another]);
  assert.equal(changed.status, 1);
  assert.equal(changed.document.outcome, 'conflict');
  assert.equal(changed.document.error.code, 'credential-conflict');
  assert.match(changed.document.message, /stop the coordinator/i);
  assert.equal(manager.spawnCount, 1);

  // After the process ends, the owned definition remembers the file by path and a bare start reuses it.
  await manager.terminate();
  assert.equal(manager.running(), false);
  const remembered = await runJson(f, manager, 'start', base);
  assert.equal(remembered.document.outcome, 'ready', remembered.stderr);
  assert.deepEqual(manager.spawns[1].args.slice(-2), ['--env-file', await fs.realpath(file)]);

  // A remembered file that became unusable blocks the launch and says how to fix it.
  await manager.terminate();
  await fs.chmod(file, 0o644);
  const spawned = manager.spawnCount;
  const unusable = await runJson(f, manager, 'start', base);
  assert.equal(unusable.status, 1);
  assert.equal(unusable.document.error.code, 'invalid-credentials');
  assert.match(unusable.document.message, /remembered/);
  assert.match(unusable.document.message, /--env-file/);
  assert.equal(manager.spawnCount, spawned);

  await assertNoSentinel(f, manager, ...[...rejected, ready, same, omitted, changed, remembered, unusable].flatMap(outcome => [outcome.stdout, outcome.stderr]));
  const definitionFiles = await walk(path.join(f.stateDirectory, 'service'));
  assert.ok(definitionFiles.length > 0);
});

test('OPENCHAMBER_DATA_DIR is recorded by path; a different value while running is a conflict', { skip: !posix }, async t => {
  const f = await fixture(t);
  const manager = manage(t, f);
  const base = ['--coordinator-config', f.configFile];
  const dataA = path.join(f.root, 'data a');
  const dataB = path.join(f.root, 'data b');
  await fs.mkdir(dataA);
  await fs.mkdir(dataB);
  const ready = await runJson(f, manager, 'start', base, { environment: { OPENCHAMBER_DATA_DIR: dataA } });
  assert.equal(ready.document.outcome, 'ready', ready.stderr);
  assert.equal(manager.spawns[0].environment.OPENCHAMBER_DATA_DIR, dataA);
  assert.equal(manager.definition.openchamberDataDirectory, dataA);
  assert.equal((await runJson(f, manager, 'start', base, { environment: { OPENCHAMBER_DATA_DIR: dataA } })).document.outcome, 'already-running');
  assert.equal((await runJson(f, manager, 'start', base)).document.outcome, 'already-running');
  const changed = await runJson(f, manager, 'start', base, { environment: { OPENCHAMBER_DATA_DIR: dataB } });
  assert.equal(changed.status, 1);
  assert.equal(changed.document.outcome, 'conflict');
  assert.equal(changed.document.error.code, 'data-directory-conflict');
  assert.equal(manager.spawnCount, 1);
  assert.deepEqual((await fs.readdir(dataA)).concat(await fs.readdir(dataB)), [], 'the data directory is only recorded, never read or written');
});

test('lifecycle sources never read a terminal, and the commands finish without prompting on a terminal or without one', { skip: !posix }, async t => {
  for (const name of ['lifecycle-cli', 'lifecycle-start', 'lifecycle-arguments', 'lifecycle-result', 'lifecycle-lock']) {
    const source = await fs.readFile(path.join(repository, 'src', 'coordinator', `${name}.ts`), 'utf8');
    assert.ok(!/readline|process\.stdin|createInterface|\bprompt\(/.test(source), `${name} must not read from a terminal`);
  }
  const f = await fixture(t);
  const environment = { PATH: process.env.PATH, HOME: f.home };
  const absent = path.join(f.root, 'absent.toml');
  const python = spawnSync('python3', ['-I', '-c', 'import pty, select, os; assert hasattr(os, "waitstatus_to_exitcode")'], { encoding: 'utf8', timeout: 20000 });
  for (const args of [['start', '--coordinator-config', absent], ['start', '--bogus'], ['stop', '--no-wait', '--timeout', '5'], ['start', '--help']]) {
    const headless = spawnSync(process.execPath, [cli, 'coordinator', ...args], { cwd: f.root, env: environment, encoding: 'utf8', input: '', timeout: 30000, killSignal: 'SIGKILL' });
    assert.equal(headless.error, undefined);
    assert.equal(headless.status, args.at(-1) === '--help' ? 0 : args[1] === '--coordinator-config' ? 1 : 2, `${args}: ${headless.stderr}`);
    if (python.status !== 0) continue;
    const specification = { argv: [process.execPath, cli, 'coordinator', ...args], cwd: f.root, env: environment, steps: [], deadline: 25 };
    const run = spawnSync('python3', ['-I', driver, JSON.stringify(specification)], { encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' });
    assert.equal(run.status, 0, run.stderr);
    const terminal = JSON.parse(run.stdout);
    assert.equal(terminal.timedOut, false, `${args} waited for input:\n${terminal.output}`);
    assert.equal(terminal.status, headless.status, `${args}\n${terminal.output}`);
    assert.ok(!/\[y\/N\]|\(y\/n\)|password|press enter/i.test(terminal.output), terminal.output);
  }
  assert.deepEqual(await fs.readdir(f.home), []);
  assert.equal(await exists(f.stateDirectory), false);
});

test('a standalone instance identifier cannot be mistaken between two targets', { skip: !posix }, async t => {
  // A coordinator for another state directory must never satisfy this target's readiness.
  const a = await fixture(t);
  const b = await fixture(t);
  const managerA = manage(t, a);
  const managerB = manage(t, b);
  const first = await runJson(a, managerA, 'start', ['--coordinator-config', a.configFile]);
  const second = await runJson(b, managerB, 'start', ['--coordinator-config', b.configFile]);
  assert.equal(first.document.outcome, 'ready');
  assert.equal(second.document.outcome, 'ready');
  assert.notEqual(first.document.instance.instanceId, second.document.instance.instanceId);
  assert.notEqual(first.document.target.label, second.document.target.label);
  assert.ok(randomUUID());
});
