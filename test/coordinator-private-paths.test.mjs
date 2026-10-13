import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseLifecycleResult } from '../dist/coordinator/lifecycle-result.js';
import { ensurePrivateDirectory, prepareLogFile } from '../dist/coordinator/native/private-files.js';
import { shutdownRecordName } from '../dist/coordinator/lifecycle.js';
import { createControlledNative } from './fixtures/controlled-native-runner.mjs';

/**
 * Private state and log destinations. Existing directories are validated and never repaired, only directories a call
 * created receive mode 0700, and a log destination that is not a private regular file is refused without blocking.
 * Public-command cases are mocked-manager evidence (production adapters against the controlled native runner).
 */

const posix = process.platform !== 'win32';
const skip = posix ? false : 'private file modes are POSIX-only';
const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const MUTATING = ['bootstrap', 'kickstart', 'bootout', 'link', 'daemon-reload', 'start'];
const managers = ['launchd', 'systemd'];

const mode = async file => (await fs.lstat(file)).mode & 0o777;

async function scratch(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hl-pp-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function privateDirectory(directory) {
  await fs.mkdir(directory, { mode: 0o700 });
  await fs.chmod(directory, 0o700);
}

/** Names, types, modes, sizes and times of everything under `directory`, so "unchanged" covers content and mtime. */
async function snapshot(directory) {
  const entries = [];
  async function visit(current, relative) {
    const stat = await fs.lstat(current);
    entries.push([relative || '.', stat.mode, stat.isDirectory() ? 0 : stat.size, stat.mtimeMs]);
    if (stat.isDirectory()) for (const name of (await fs.readdir(current)).sort()) await visit(path.join(current, name), path.join(relative, name));
  }
  await visit(directory, '');
  return entries;
}

const mutating = h => h.runner.verbs.filter(verb => MUTATING.includes(verb));

// --- Defect 3: existing directories are validated, never repaired -----------------------------------------------

for (const manager of managers) {
  test(`${manager}: public start refuses an existing 0755 state directory and changes nothing`, { skip }, async t => {
    const h = await createControlledNative(t, manager);
    await fs.mkdir(h.stateDirectory, { mode: 0o755 });
    await fs.chmod(h.stateDirectory, 0o755);
    await fs.writeFile(path.join(h.stateDirectory, 'marker.txt'), 'kept\n');
    const before = await snapshot(h.stateDirectory);

    const result = await h.start(['--timeout', '10']);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.notEqual(result.document.outcome, 'ready');
    assert.equal(await mode(h.stateDirectory), 0o755, 'an existing directory is never repaired');
    assert.deepEqual(await snapshot(h.stateDirectory), before, 'mode, content listing and mtime are unchanged');
    await assert.rejects(fs.lstat(path.join(h.stateDirectory, 'lifecycle')), { code: 'ENOENT' }, 'no lifecycle artifacts');
    assert.deepEqual(mutating(h), [], 'no native mutating call');
    assert.equal(h.runner.calls.length, 0, 'the manager was not consulted');
    assert.equal(h.runner.services.size, 0);
    h.runner.assertNoViolations();
  });

  test(`${manager}: public stop refuses an existing 0755 state directory, sends no shutdown request and changes nothing`, { skip }, async t => {
    const h = await createControlledNative(t, manager);
    const first = await h.start(['--timeout', '60']);
    assert.equal(first.document.outcome, 'ready', `${first.stdout}\n${first.stderr}`);
    const service = h.service();
    const instanceId = first.document.instance.instanceId;
    const lifecycleBefore = (await fs.readdir(path.join(h.stateDirectory, 'lifecycle'))).sort();
    const callsBefore = h.runner.calls.length;
    await fs.chmod(h.stateDirectory, 0o755);

    const stopped = await h.stop(['--timeout', '10']);
    assert.notEqual(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
    assert.notEqual(stopped.document.outcome, 'stopped');
    assert.equal(await mode(h.stateDirectory), 0o755, 'an existing directory is never repaired');
    assert.deepEqual((await fs.readdir(path.join(h.stateDirectory, 'lifecycle'))).sort(), lifecycleBefore, 'no new lifecycle artifacts');
    await assert.rejects(fs.lstat(path.join(h.stateDirectory, 'lifecycle', shutdownRecordName(instanceId))), { code: 'ENOENT' }, 'no shutdown record');
    assert.equal(h.runner.calls.length, callsBefore, 'the manager was not consulted');
    assert.ok(h.runner.isRunning(service), 'the coordinator was not asked to drain');

    await fs.chmod(h.stateDirectory, 0o700);
    const lifecycle = await (await h.client()).request('GET', '/lifecycle');
    assert.equal(lifecycle.phase, 'running');
    assert.equal(lifecycle.instanceId, instanceId);
    h.runner.assertNoViolations();
  });

  test(`${manager}: public stop of an empty 0755 state directory and a missing one change nothing`, { skip }, async t => {
    const h = await createControlledNative(t, manager);
    const missing = await h.stop(['--timeout', '10']);
    assert.notEqual(missing.status, 0);
    await assert.rejects(fs.lstat(h.stateDirectory), { code: 'ENOENT' }, 'looking never creates the directory');

    await fs.mkdir(h.stateDirectory, { mode: 0o755 });
    await fs.chmod(h.stateDirectory, 0o755);
    const before = await snapshot(h.stateDirectory);
    const result = await h.stop(['--timeout', '10']);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(await mode(h.stateDirectory), 0o755);
    assert.deepEqual(await snapshot(h.stateDirectory), before);
    assert.deepEqual(mutating(h), []);
  });

  test(`${manager}: public start creates a missing state directory with mode 0700 and a secure existing one works`, { skip }, async t => {
    const created = await createControlledNative(t, manager, { state: path.join('missing', 'parent', 'state') });
    const first = await created.start(['--timeout', '60']);
    assert.equal(first.document.outcome, 'ready', `${first.stdout}\n${first.stderr}`);
    for (const directory of [created.stateDirectory, path.dirname(created.stateDirectory), path.dirname(path.dirname(created.stateDirectory))]) {
      assert.equal(await mode(directory), 0o700, directory);
    }
    assert.equal(await mode(path.join(created.stateDirectory, 'lifecycle')), 0o700);

    const existing = await createControlledNative(t, manager);
    await privateDirectory(existing.stateDirectory);
    const second = await existing.start(['--timeout', '60']);
    assert.equal(second.document.outcome, 'ready', `${second.stdout}\n${second.stderr}`);
    assert.equal(await mode(existing.stateDirectory), 0o700);
  });
}

test('ensurePrivateDirectory creates missing directories with 0700 and leaves existing ancestors alone', { skip }, async t => {
  const root = await scratch(t);
  await fs.chmod(root, 0o755);
  const flat = path.join(root, 'flat');
  await ensurePrivateDirectory(flat, 'Test directory');
  assert.equal(await mode(flat), 0o700);

  const deep = path.join(root, 'a', 'b', 'c');
  await ensurePrivateDirectory(deep, 'Test directory', { recursive: true });
  for (const directory of [path.join(root, 'a'), path.join(root, 'a', 'b'), deep]) assert.equal(await mode(directory), 0o700, directory);
  assert.equal(await mode(root), 0o755, 'an existing ancestor is untouched');

  await assert.rejects(ensurePrivateDirectory(path.join(root, 'x', 'y'), 'Test directory'), { code: 'ENOENT' }, 'a missing parent is an error without recursion');
  await assert.rejects(fs.lstat(path.join(root, 'x')), { code: 'ENOENT' });

  await ensurePrivateDirectory(deep, 'Test directory', { recursive: true });
  assert.equal(await mode(deep), 0o700, 'a secure existing directory is accepted');
});

test('ensurePrivateDirectory preserves a state alias through an existing ancestor symlink', { skip }, async t => {
  const root = await scratch(t);
  const real = path.join(root, 'real');
  await privateDirectory(real);
  await fs.symlink(real, path.join(root, 'alias'));
  const state = path.join(root, 'alias', 'state');
  await ensurePrivateDirectory(state, 'Test directory', { recursive: true });
  assert.equal(await mode(path.join(real, 'state')), 0o700);
  assert.equal(await mode(real), 0o700);
});

test('ensurePrivateDirectory rejects insecure existing objects without repairing them', { skip }, async t => {
  const root = await scratch(t);
  for (const insecure of [0o755, 0o750, 0o705, 0o770]) {
    const directory = path.join(root, `d${insecure.toString(8)}`);
    await fs.mkdir(directory, { mode: insecure });
    await fs.chmod(directory, insecure);
    await assert.rejects(ensurePrivateDirectory(directory, 'Test directory'), /no group or other access/);
    await assert.rejects(ensurePrivateDirectory(directory, 'Test directory', { recursive: true }), /no group or other access/);
    assert.equal(await mode(directory), insecure);
  }

  const victim = path.join(root, 'victim');
  await fs.mkdir(victim, { mode: 0o755 });
  await fs.chmod(victim, 0o755);
  const link = path.join(root, 'link');
  await fs.symlink(victim, link);
  await assert.rejects(ensurePrivateDirectory(link, 'Test directory', { recursive: true }), /symbolic link or file/);
  assert.equal(await mode(victim), 0o755, 'a symlink target is never changed');
  assert.ok((await fs.lstat(link)).isSymbolicLink());

  const dangling = path.join(root, 'dangling');
  await fs.symlink(path.join(root, 'nowhere'), dangling);
  await assert.rejects(ensurePrivateDirectory(dangling, 'Test directory', { recursive: true }));
  await assert.rejects(fs.lstat(path.join(root, 'nowhere')), { code: 'ENOENT' }, 'a dangling link is not created through');

  const file = path.join(root, 'file');
  await fs.writeFile(file, 'content', { mode: 0o600 });
  await assert.rejects(ensurePrivateDirectory(file, 'Test directory'), /private directory/);
  assert.equal(await fs.readFile(file, 'utf8'), 'content');
});

/** Replace `fs.mkdir` for one call so another actor acts at exactly the point between the existence check and creation. */
async function withMkdirHook(hook, body) {
  const original = fs.mkdir;
  fs.mkdir = async (target, options) => hook(target, options, original);
  try { await body(); } finally { fs.mkdir = original; }
}

test('ensurePrivateDirectory handles another actor creating the target first without modifying it', { skip }, async t => {
  const root = await scratch(t);
  const insecure = path.join(root, 'raced-insecure');
  await withMkdirHook(async (target, options, original) => {
    await original(target, { mode: 0o755 });
    await fs.chmod(target, 0o755);
    return original(target, options);
  }, async () => {
    await assert.rejects(ensurePrivateDirectory(insecure, 'Test directory', { recursive: true }), /no group or other access/);
  });
  assert.equal(await mode(insecure), 0o755, 'the directory another actor created is not repaired');

  const secure = path.join(root, 'raced-secure');
  await withMkdirHook(async (target, options, original) => {
    await original(target, { mode: 0o700 });
    await fs.writeFile(path.join(target, 'theirs'), 'x');
    return original(target, options);
  }, async () => {
    await ensurePrivateDirectory(secure, 'Test directory');
  });
  assert.equal(await fs.readFile(path.join(secure, 'theirs'), 'utf8'), 'x');

  const concurrent = path.join(root, 'concurrent');
  await Promise.all(Array.from({ length: 8 }, () => ensurePrivateDirectory(concurrent, 'Test directory', { recursive: true })));
  assert.equal(await mode(concurrent), 0o700);
});

test('ensurePrivateDirectory never changes the target of a path substituted by a symlink after creation', { skip }, async t => {
  const root = await scratch(t);
  const victim = path.join(root, 'victim');
  await fs.mkdir(victim, { mode: 0o755 });
  await fs.chmod(victim, 0o755);
  const target = path.join(root, 'state');
  await withMkdirHook(async (directory, options, original) => {
    await original(directory, options);
    await fs.rename(directory, `${directory}.moved`);
    await fs.symlink(victim, directory);
  }, async () => {
    await assert.rejects(ensurePrivateDirectory(target, 'Test directory'), /symbolic link or file/);
  });
  assert.equal(await mode(victim), 0o755, 'the symlink target keeps its mode');
});

// --- Defect 4: log destinations ------------------------------------------------------------------------------

test('prepareLogFile appends to an existing private file and creates a missing one with 0600', { skip }, async t => {
  const root = await scratch(t);
  const existing = path.join(root, 'existing.log');
  await fs.writeFile(existing, 'earlier output\n', { mode: 0o600 });
  await fs.chmod(existing, 0o600);
  await prepareLogFile(existing, 'The log');
  assert.equal(await fs.readFile(existing, 'utf8'), 'earlier output\n');
  assert.equal(await mode(existing), 0o600);

  const empty = path.join(root, 'empty.log');
  await fs.writeFile(empty, '', { mode: 0o600 });
  await fs.chmod(empty, 0o600);
  await prepareLogFile(empty, 'The log');
  assert.equal(await mode(empty), 0o600);

  const created = path.join(root, 'created.log');
  await prepareLogFile(created, 'The log');
  assert.equal(await mode(created), 0o600);
  assert.equal(await fs.readFile(created, 'utf8'), '');

  const restrictive = path.join(root, 'restrictive.log');
  const umask = process.umask(0o277);
  try { await prepareLogFile(restrictive, 'The log'); } finally { process.umask(umask); }
  assert.equal(await mode(restrictive), 0o600, 'a file this call created gets 0600');
});

test('prepareLogFile refuses symlinks, directories and insecure files without changing them', { skip }, async t => {
  const root = await scratch(t);
  const victim = path.join(root, 'victim.txt');
  await fs.writeFile(victim, 'untouched\n', { mode: 0o644 });
  await fs.chmod(victim, 0o644);
  const link = path.join(root, 'link.log');
  await fs.symlink(victim, link);
  await assert.rejects(prepareLogFile(link, 'The log'), /symbolic link/);
  assert.equal(await fs.readFile(victim, 'utf8'), 'untouched\n');
  assert.equal(await mode(victim), 0o644, 'a symlink target is never changed');

  const dangling = path.join(root, 'dangling.log');
  await fs.symlink(path.join(root, 'nowhere.log'), dangling);
  await assert.rejects(prepareLogFile(dangling, 'The log'), /symbolic link/);
  await assert.rejects(fs.lstat(path.join(root, 'nowhere.log')), { code: 'ENOENT' }, 'a dangling link is not created through');

  const directory = path.join(root, 'directory.log');
  await fs.mkdir(directory, { mode: 0o700 });
  await assert.rejects(prepareLogFile(directory, 'The log'), /regular file/);

  for (const [name, content] of [['loose.log', 'kept\n'], ['loose-empty.log', '']]) {
    const loose = path.join(root, name);
    await fs.writeFile(loose, content, { mode: 0o644 });
    await fs.chmod(loose, 0o644);
    await assert.rejects(prepareLogFile(loose, 'The log'), /no group or other access/);
    assert.equal(await mode(loose), 0o644, 'an insecure file is rejected, not repaired');
    assert.equal(await fs.readFile(loose, 'utf8'), content);
  }
});

// Public start with a log destination of each kind: refused before any bootstrap or kickstart.
for (const kind of ['symlink', 'directory', 'insecure file']) {
  test(`launchd: public start refuses a ${kind} at a log destination without registering or starting anything`, { skip }, async t => {
    const h = await createControlledNative(t, 'launchd');
    const { standardError, logDirectory } = h.logPaths();
    await privateDirectory(h.stateDirectory);
    await privateDirectory(logDirectory);
    const victim = path.join(h.root, 'victim.txt');
    await fs.writeFile(victim, 'untouched\n', { mode: 0o644 });
    await fs.chmod(victim, 0o644);
    if (kind === 'symlink') await fs.symlink(victim, standardError);
    else if (kind === 'directory') await privateDirectory(standardError);
    else { await fs.writeFile(standardError, 'loose\n', { mode: 0o644 }); await fs.chmod(standardError, 0o644); }
    const before = await fs.lstat(standardError);

    const result = await h.start(['--timeout', '10']);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.notEqual(result.document.outcome, 'ready');
    assert.deepEqual(mutating(h), [], 'nothing was registered or started');
    const after = await fs.lstat(standardError);
    assert.deepEqual([after.ino, after.mode, after.size], [before.ino, before.mode, before.size]);
    assert.equal(await fs.readFile(victim, 'utf8'), 'untouched\n');
    assert.equal(await mode(victim), 0o644);
    assert.equal(h.service().starts, 0);
  });
}

test('launchd: public start appends to existing regular log files', { skip }, async t => {
  const h = await createControlledNative(t, 'launchd');
  const { standardOut, standardError, logDirectory } = h.logPaths();
  await privateDirectory(h.stateDirectory);
  await privateDirectory(logDirectory);
  for (const file of [standardOut, standardError]) { await fs.writeFile(file, 'earlier output\n', { mode: 0o600 }); await fs.chmod(file, 0o600); }
  const result = await h.start(['--timeout', '60']);
  assert.equal(result.document.outcome, 'ready', `${result.stdout}\n${result.stderr}`);
  assert.ok((await fs.readFile(standardOut, 'utf8')).startsWith('earlier output\n'));
  assert.equal(await fs.readFile(standardError, 'utf8').then(text => text.startsWith('earlier output\n')), true);
});

const childSource = `
import fs from 'node:fs';
const input = JSON.parse(process.env.HL_CHILD);
const { ControlledLaunchctl } = await import(input.fixture);
const { lifecycleCommandMain } = await import(input.dist + 'coordinator/lifecycle-cli.js');
const { resolveLaunchContext } = await import(input.dist + 'coordinator/launch-context.js');
const { createLaunchdAdapter } = await import(input.dist + 'coordinator/native/launchd.js');
const runner = new ControlledLaunchctl({});
const environment = { HOME: input.home, OPENCHAMBER_DATA_DIR: input.openchamber };
const createAdapter = context => ({ supported: true, manager: 'launchd', adapter: createLaunchdAdapter({ context, runner, uid: runner.uid }) });
const status = await lifecycleCommandMain('start', ['--coordinator-config', input.configFile, '--env-file', input.credentialFile, '--json', '--timeout', '1'], {
  dependencies: { environment, platform: 'darwin', createAdapter, launchOverrides: { nodeExecutable: process.execPath, entryPoint: input.entry }, pollIntervalMs: 20, requestTimeoutMs: 3000 },
});
fs.writeFileSync(input.callsFile, JSON.stringify(runner.calls.map(call => call.verb)));
process.exitCode = status;
`;

function mkfifo(file) {
  return new Promise((resolve, reject) => execFile('mkfifo', ['-m', '600', file], error => error ? reject(error) : resolve()));
}

/**
 * Run `heimdall coordinator start --json --timeout 1` in a child process, as the CLI does (it sets the exit code and
 * waits for the event loop to drain). The external deadline only bounds the harness; a child still alive at the
 * deadline is killed as harness cleanup and the test fails.
 */
async function startChild(h, deadlineMs) {
  const callsFile = path.join(h.root, 'child-calls.json');
  const input = {
    fixture: pathToFileURL(path.join(fixtures, 'controlled-native-runner.mjs')).href,
    dist: pathToFileURL(path.join(path.dirname(fixtures), '..', 'dist') + path.sep).href,
    entry: path.join(path.dirname(fixtures), '..', 'dist', 'cli.js'),
    home: h.home, openchamber: h.openchamber, configFile: h.configFile, credentialFile: h.credentialFile, callsFile,
  };
  const startedAt = Date.now();
  const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], { env: { ...process.env, HL_CHILD: JSON.stringify(input) }, stdio: ['ignore', 'pipe', 'pipe'], cwd: '/' });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  let harnessKill = null;
  let timer;
  const deadline = new Promise(resolve => { timer = setTimeout(() => resolve('deadline'), deadlineMs); });
  const first = await Promise.race([exited, deadline]);
  clearTimeout(timer);
  let exit = first;
  if (first === 'deadline') {
    harnessKill = `harness cleanup: SIGKILL child pid ${child.pid} still alive ${deadlineMs} ms after start`;
    child.kill('SIGKILL');
    exit = await exited;
  }
  const calls = await fs.readFile(callsFile, 'utf8').then(JSON.parse, () => null);
  return { elapsedMs: Date.now() - startedAt, exit, harnessKill, stdout, stderr, calls };
}

for (const stream of ['out', 'err']) {
  test(`launchd: public start refuses a FIFO without a reader at the ${stream} log destination and exits within its budget`, { skip }, async t => {
    const h = await createControlledNative(t, 'launchd');
    const paths = h.logPaths();
    const fifo = stream === 'out' ? paths.standardOut : paths.standardError;
    const regular = stream === 'out' ? paths.standardError : paths.standardOut;
    await privateDirectory(h.stateDirectory);
    await privateDirectory(paths.logDirectory);
    await mkfifo(fifo);
    await fs.writeFile(regular, 'earlier output\n', { mode: 0o600 });
    await fs.chmod(regular, 0o600);
    const before = await fs.lstat(fifo);
    assert.ok(before.isFIFO());

    const outcome = await startChild(h, 15_000);
    t.diagnostic(`elapsed ${outcome.elapsedMs} ms, exit ${JSON.stringify(outcome.exit)}, calls ${JSON.stringify(outcome.calls)}${outcome.harnessKill ? `, ${outcome.harnessKill}` : ''}`);
    const after = await fs.lstat(fifo);
    assert.deepEqual([after.isFIFO(), after.ino, after.dev, after.mode], [true, before.ino, before.dev, before.mode], 'the FIFO is unchanged');
    assert.equal(outcome.harnessKill, null, `the CLI must exit by itself; ${outcome.harnessKill}\n${outcome.stdout}`);
    assert.ok(outcome.elapsedMs < 10_000, `elapsed ${outcome.elapsedMs} ms exceeds the command budget`);
    assert.notEqual(outcome.exit.code, 0);
    assert.equal(outcome.exit.signal, null);
    const document = parseLifecycleResult(JSON.parse(outcome.stdout));
    assert.notEqual(document.outcome, 'ready');
    assert.match(document.message, /regular file/);
    assert.ok(outcome.calls, 'the child reported its manager calls');
    assert.equal(outcome.calls.filter(verb => verb === 'bootstrap' || verb === 'kickstart').length, 0, 'nothing was bootstrapped or kickstarted');
    assert.equal(await fs.readFile(regular, 'utf8'), 'earlier output\n');
  });
}
