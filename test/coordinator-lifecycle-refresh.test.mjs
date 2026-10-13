import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createControlledNative } from './fixtures/controlled-native-runner.mjs';

/**
 * Public `coordinator start` after a clean `stop` must apply a changed credential file or installed entry point to
 * the owned inactive service definition without manual service-manager steps: launchd needs the inactive
 * registration unloaded (`bootout`) before the new definition can be registered, systemd refreshes in place.
 * A running, unknown, foreign or concurrently changing registration is never unloaded or replaced.
 *
 * The production launchd and systemd adapters run against the controlled native runner, which spawns a real
 * coordinator. This is mocked-manager evidence, never launchd or systemd evidence.
 */

const posix = process.platform !== 'win32';
const skip = posix ? false : 'the controlled native runner spawns POSIX services';
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ok = stdout => ({ exitCode: 0, stdout, stderr: '' });
const ELSEWHERE = '/elsewhere/definition.plist';
const forever = { times: 100_000 };
const MUTATING = ['bootout', 'bootstrap', 'kickstart'];

/** Start, then stop cleanly: the owned definition stays registered and inactive. */
async function stopped(t, manager) {
  const h = await createControlledNative(t, manager);
  const first = await h.start(['--timeout', '60']);
  assert.equal(first.document.outcome, 'ready', `${first.stdout}\n${first.stderr}`);
  const halt = await h.stop(['--timeout', '60']);
  assert.equal(halt.document.outcome, 'stopped', `${halt.stdout}\n${halt.stderr}`);
  assert.equal(h.runner.isRunning(h.service()), false);
  return { h, firstInstanceId: first.document.instance.instanceId };
}

async function otherCredentialFile(h) {
  const file = path.join(h.root, 'credentials-next.env');
  await fs.writeFile(file, 'OPENCODE_PASSWORD=controlled-native-next-credential\n', { mode: 0o600 });
  await fs.chmod(file, 0o600);
  return file;
}

/** A second real installed entry point: a copy of the build beside a link to the repository's dependencies. */
async function otherEntryPoint(h) {
  const directory = path.join(h.root, 'second-install');
  await fs.mkdir(directory);
  await fs.cp(path.join(repository, 'dist'), path.join(directory, 'dist'), { recursive: true });
  await fs.copyFile(path.join(repository, 'package.json'), path.join(directory, 'package.json'));
  await fs.symlink(path.join(repository, 'node_modules'), path.join(directory, 'node_modules'));
  return path.join(directory, 'dist', 'cli.js');
}

const startWith = (h, credentialFile, dependencies) =>
  h.runJson('start', ['--coordinator-config', h.configFile, '--env-file', credentialFile, '--timeout', '60'], dependencies ? { dependencies } : undefined);

function assertNoKillRequests(h) {
  h.runner.assertNoViolations();
  assert.ok(!h.runner.calls.some(call => call.args.includes('-k')), 'no kill-existing option was used');
  assert.ok(!h.runner.verbs.some(verb => ['kill', 'stop', 'remove', 'unload', 'restart'].includes(verb)), `unexpected verbs: ${h.runner.verbs.join(', ')}`);
  assert.equal(h.runner.cleanupLog.length, 0, 'the harness ended no process');
}

/** launchd reports the owned registration as running with a process id. */
const runningReport = (h, pid = 99_999) => call => ok([`${call.args[1]} = {`, `\tpath = ${h.definitionPath()}`, '\tstate = running', `\tpid = ${pid}`, '}', ''].join('\n'));
const unrecognized = () => ok('not launchctl output\n');
const unknownState = h => call => ok([`${call.args[1]} = {`, `\tpath = ${h.definitionPath()}`, '\tstate = starting', '}', ''].join('\n'));

async function assertRefreshed(h, firstInstanceId, result, { credentialFile, entryPoint } = {}) {
  assert.equal(result.document.outcome, 'ready', `${result.stdout}\n${result.stderr}`);
  assert.equal(result.status, 0);
  assert.notEqual(result.document.instance.instanceId, firstInstanceId, 'a new coordinator instance answered');
  const lifecycle = await (await h.client()).request('GET', '/lifecycle');
  assert.equal(lifecycle.instanceId, result.document.instance.instanceId);
  assert.equal(lifecycle.pid, h.service().child.pid);
  assert.equal(lifecycle.phase, 'running');
  const definition = await fs.readFile(h.definitionPath(), 'utf8');
  if (credentialFile) {
    assert.ok(definition.includes(credentialFile), 'the definition on disk carries the new credential path');
    assert.ok(!definition.includes(h.credentialFile), 'the previous credential path is gone');
    assert.ok(h.service().child.spawnargs.includes(credentialFile), 'the new process was launched with the new credential file');
  }
  if (entryPoint) {
    assert.ok(definition.includes(entryPoint), 'the definition on disk carries the new entry point');
    assert.ok(h.service().child.spawnargs.includes(entryPoint), 'the new process runs the new entry point');
  }
  assertNoKillRequests(h);
}

// --- launchd: the refresh -------------------------------------------------------------------------------------

test('launchd: start with a changed credential file path refreshes the stopped definition and is ready', { skip, timeout: 120000 }, async t => {
  const { h, firstInstanceId } = await stopped(t, 'launchd');
  const next = await otherCredentialFile(h);
  const before = h.runner.calls.length;
  const result = await startWith(h, next);
  await assertRefreshed(h, firstInstanceId, result, { credentialFile: next });
  const verbs = h.runner.calls.slice(before).map(call => call.verb);
  assert.equal(verbs.filter(verb => verb === 'bootout').length, 1, `bootout exactly once while inactive: ${verbs.join(', ')}`);
  assert.deepEqual(verbs.filter(verb => MUTATING.includes(verb)), ['bootout', 'bootstrap', 'kickstart']);
  assert.deepEqual(h.runner.calls.slice(before).find(call => call.verb === 'bootout').args, ['bootout', `gui/${h.runner.uid}/${h.label()}`]);
  assert.equal(h.service().starts, 2, 'the refreshed registration was started once more');
  assert.equal(h.runner.service(h.label()).registeredPath, h.definitionPath());
  assert.match(await fs.readFile(h.definitionPath(), 'utf8'), /<key>RunAtLoad<\/key>\s*<false\/>/);
  const halt = await h.stop(['--timeout', '60']);
  assert.equal(halt.document.outcome, 'stopped', `${halt.stdout}\n${halt.stderr}`);
});

test('launchd: start with a changed installed entry point refreshes the stopped definition and is ready', { skip, timeout: 120000 }, async t => {
  const { h, firstInstanceId } = await stopped(t, 'launchd');
  const entryPoint = await fs.realpath(await otherEntryPoint(h));
  const before = h.runner.calls.length;
  // The credential file is remembered by the definition, so only the entry point differs.
  const result = await h.runJson('start', ['--coordinator-config', h.configFile, '--timeout', '60'],
    { dependencies: { launchOverrides: { nodeExecutable: process.execPath, entryPoint } } });
  await assertRefreshed(h, firstInstanceId, result, { entryPoint });
  const verbs = h.runner.calls.slice(before).map(call => call.verb);
  assert.deepEqual(verbs.filter(verb => MUTATING.includes(verb)), ['bootout', 'bootstrap', 'kickstart']);
  assert.ok((await fs.readFile(h.definitionPath(), 'utf8')).includes(h.credentialFile), 'the remembered credential file is kept');
  const halt = await h.stop(['--timeout', '60']);
  assert.equal(halt.document.outcome, 'stopped', `${halt.stdout}\n${halt.stderr}`);
});

test('launchd: an unchanged context keeps today\'s behavior and never boots the registration out', { skip, timeout: 120000 }, async t => {
  const { h, firstInstanceId } = await stopped(t, 'launchd');
  const before = h.runner.calls.length;
  const result = await h.start(['--timeout', '60']);
  assert.equal(result.document.outcome, 'ready', `${result.stdout}\n${result.stderr}`);
  assert.notEqual(result.document.instance.instanceId, firstInstanceId);
  const verbs = h.runner.calls.slice(before).map(call => call.verb);
  assert.deepEqual(verbs.filter(verb => MUTATING.includes(verb)), ['kickstart'], verbs.join(', '));
  assertNoKillRequests(h);
});

// --- launchd: refusals ----------------------------------------------------------------------------------------

/** A changed credential file against a registration whose state forbids unloading it. */
const refusals = {
  'a registration the manager reports as running': {
    apply: h => h.runner.respond('print', runningReport(h), forever),
    codes: ['running-context-changed'],
  },
  'an unrecognized manager answer': {
    apply: h => h.runner.respond('print', unrecognized, forever),
    codes: ['state-unknown'],
  },
  'a loaded registration with an unknown running state': {
    apply: h => h.runner.respond('print', unknownState(h), forever),
    codes: ['state-unknown'],
  },
  'a registration loaded from another definition': {
    apply: h => { h.runner.foreign = { registeredPath: ELSEWHERE, pid: 4321, running: false }; },
    codes: ['registered-elsewhere'],
  },
  'a running registration loaded from another definition': {
    apply: h => { h.runner.foreign = { registeredPath: ELSEWHERE, pid: 4321, running: true }; },
    codes: ['registered-elsewhere'],
  },
};

for (const [name, { apply, codes }] of Object.entries(refusals)) {
  test(`launchd: a changed credential file is not applied over ${name}`, { skip, timeout: 120000 }, async t => {
    const { h } = await stopped(t, 'launchd');
    const next = await otherCredentialFile(h);
    const definitionBefore = await fs.readFile(h.definitionPath(), 'utf8');
    apply(h);
    const before = h.runner.calls.length;
    const result = await startWith(h, next);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.document.outcome, 'conflict');
    assert.ok(codes.includes(result.document.error.code), `${result.document.error.code} is not one of ${codes.join(', ')}`);
    assert.doesNotMatch(result.document.error.message, /unloadInactive/);
    const verbs = h.runner.calls.slice(before).map(call => call.verb);
    assert.ok(!verbs.some(verb => MUTATING.includes(verb)), `no bootout, bootstrap or kickstart: ${verbs.join(', ')}`);
    assert.equal(await fs.readFile(h.definitionPath(), 'utf8'), definitionBefore, 'the definition was not rewritten');
    assertNoKillRequests(h);
  });
}

test('launchd: a running coordinator with a changed credential file is reported and left alone', { skip, timeout: 120000 }, async t => {
  const h = await createControlledNative(t, 'launchd');
  const first = await h.start(['--timeout', '60']);
  assert.equal(first.document.outcome, 'ready', `${first.stdout}\n${first.stderr}`);
  const next = await otherCredentialFile(h);
  const before = h.runner.calls.length;
  const result = await startWith(h, next);
  assert.equal(result.document.outcome, 'conflict');
  assert.equal(result.document.error.code, 'credential-conflict');
  assert.ok(h.runner.isRunning(h.service()), 'the coordinator still runs');
  assert.ok(!h.runner.calls.slice(before).some(call => MUTATING.includes(call.verb)));
  assert.ok((await fs.readFile(h.definitionPath(), 'utf8')).includes(h.credentialFile));
  assertNoKillRequests(h);
});

// --- launchd: state changes while the refresh is under way ------------------------------------------------------

const racing = {
  'the service becomes running': {
    apply: h => h.runner.respond('print', runningReport(h), forever),
    codes: ['running-context-changed'],
  },
  'the registered path changes': {
    apply: h => { h.runner.foreign = { registeredPath: ELSEWHERE, pid: 4321, running: false }; },
    codes: ['registered-elsewhere'],
  },
  'the manager answer becomes unrecognizable': {
    apply: h => h.runner.respond('print', unrecognized, forever),
    codes: ['state-unknown'],
  },
};

for (const [name, { apply, codes }] of Object.entries(racing)) {
  test(`launchd: refresh stops without further mutation when ${name} after the first inspection`, { skip, timeout: 120000 }, async t => {
    const { h } = await stopped(t, 'launchd');
    const next = await otherCredentialFile(h);
    const definitionBefore = await fs.readFile(h.definitionPath(), 'utf8');
    const before = h.runner.calls.length;
    h.runner.on('after', 'print', () => apply(h));
    const result = await startWith(h, next);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.document.outcome, 'conflict');
    assert.ok(codes.includes(result.document.error.code), `${result.document.error.code} is not one of ${codes.join(', ')}`);
    const verbs = h.runner.calls.slice(before).map(call => call.verb);
    assert.ok(!verbs.some(verb => MUTATING.includes(verb)), `no bootout, bootstrap or kickstart: ${verbs.join(', ')}`);
    assert.equal(await fs.readFile(h.definitionPath(), 'utf8'), definitionBefore, 'the definition was not rewritten');
    assertNoKillRequests(h);
  });

  test(`launchd: refresh stops before bootstrap when ${name} after the registration was booted out`, { skip, timeout: 120000 }, async t => {
    const { h } = await stopped(t, 'launchd');
    const next = await otherCredentialFile(h);
    const definitionBefore = await fs.readFile(h.definitionPath(), 'utf8');
    const before = h.runner.calls.length;
    h.runner.on('after', 'bootout', () => apply(h));
    const result = await startWith(h, next);
    assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.notEqual(result.document.outcome, 'ready');
    assert.equal(result.document.outcome, 'conflict', `${result.stdout}\n${result.stderr}`);
    assert.ok(codes.includes(result.document.error.code), `${result.document.error.code} is not one of ${codes.join(', ')}`);
    const verbs = h.runner.calls.slice(before).map(call => call.verb);
    assert.equal(verbs.filter(verb => verb === 'bootout').length, 1, 'the one proven-inactive unload happened');
    assert.ok(!verbs.includes('bootstrap') && !verbs.includes('kickstart'), `no bootstrap or kickstart after the change: ${verbs.join(', ')}`);
    assert.equal(await fs.readFile(h.definitionPath(), 'utf8'), definitionBefore, 'the new definition was not published');
    assertNoKillRequests(h);
  });
}

// --- systemd: the in-place refresh keeps working ---------------------------------------------------------------

test('systemd: start with a changed credential file path still refreshes the stopped unit in place', { skip, timeout: 120000 }, async t => {
  const { h, firstInstanceId } = await stopped(t, 'systemd');
  const next = await otherCredentialFile(h);
  const before = h.runner.calls.length;
  const result = await startWith(h, next);
  assert.equal(result.document.outcome, 'ready', `${result.stdout}\n${result.stderr}`);
  assert.notEqual(result.document.instance.instanceId, firstInstanceId);
  const definition = await fs.readFile(h.definitionPath(), 'utf8');
  assert.ok(definition.includes(next) && !definition.includes(h.credentialFile), 'the unit on disk carries the new credential path');
  assert.ok(h.service().child.spawnargs.includes(next), 'the new process was launched with the new credential file');
  const verbs = h.runner.calls.slice(before).map(call => call.verb);
  assert.ok(!verbs.includes('link'), `the link is kept: ${verbs.join(', ')}`);
  assert.equal(verbs.filter(verb => verb === 'daemon-reload').length, 1);
  assert.equal(verbs.filter(verb => verb === 'start').length, 1);
  assert.equal((await fs.lstat(h.linkPath())).isSymbolicLink(), true);
  assertNoKillRequests(h);
  const halt = await h.stop(['--timeout', '60']);
  assert.equal(halt.document.outcome, 'stopped', `${halt.stdout}\n${halt.stderr}`);
});
