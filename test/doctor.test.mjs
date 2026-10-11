import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { doctorMain, parseDoctorArguments, runLocalChecks, MINIMUM_NODE } from '../dist/doctor/index.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repository, 'dist', 'cli.js');
const SENTINEL = 'sentinel-secret-4d81c0e7a5';
const TOKEN_SENTINEL = 'sentinel-token-92b7e1f3c6';
const DEADLINE_MS = 30000;
const complete = ['--planner-model', 'anthropic/planner-x', '--executor-model', 'openai/executor-x', '--quota-provider', 'openai', '--opencode-url', 'http://127.0.0.1:4096', '--opencode-auth', 'basic'];
const isRoot = process.getuid?.() === 0;

const ORDER = [
  'node.version', 'git.available', 'project.git', 'project.commit', 'runtime.assets', 'runtime.identity', 'runtime.dependencies', 'runtime.quota-package',
  'coordinator.config', 'project.config', 'project.setup', 'paths.state', 'paths.project', 'permissions', 'connection',
];
const ADVISORY = ['permissions', 'connection'];
const STATUSES = ['pass', 'fail', 'warn', 'not-verified', 'skipped'];

/** Fails every network primitive the CLI could use and records the attempt in a file. */
const PRELOAD = `
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import dns from 'node:dns';
import dgram from 'node:dgram';
const record = what => { fs.appendFileSync(process.env.NET_ATTEMPT_LOG, what + '\\n'); throw new Error('network blocked: ' + what); };
globalThis.fetch = () => record('fetch');
net.Socket.prototype.connect = () => record('net.Socket.connect');
net.connect = net.createConnection = () => record('net.connect');
net.Server.prototype.listen = () => record('net.Server.listen');
tls.connect = () => record('tls.connect');
http.request = http.get = () => record('http.request');
https.request = https.get = () => record('https.request');
dns.lookup = () => record('dns.lookup');
dns.resolve = () => record('dns.resolve');
dgram.createSocket = () => record('dgram.createSocket');
`;

/** Isolated HOME, a synthetic committed Git project, a planted credential and a network guard. */
async function sandbox(t, { commit = true, git: initialize = true } = {}) {
  // Short root: the default coordinator state directory must stay within the portable Unix socket limit.
  const root = await fs.realpath(await fs.mkdtemp(path.join(await fs.access('/tmp').then(() => '/tmp', () => os.tmpdir()), 'hd-')));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const tools = path.join(root, 'tools');
  const data = path.join(tools, 'openchamber');
  await Promise.all([home, project, data].map(directory => fs.mkdir(directory, { recursive: true })));
  // Independent of the umask of whoever runs the tests, so the advisory permission check stays quiet for the baseline.
  await Promise.all([root, home, project].map(directory => fs.chmod(directory, 0o700)));
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ desktopLocalPort: 4096, desktopLocalClientToken: TOKEN_SENTINEL }));
  const preload = path.join(tools, 'block-network.mjs');
  await fs.writeFile(preload, PRELOAD);
  const log = path.join(tools, 'network-attempts.log');
  const restore = [];
  t.after(async () => {
    for (const directory of restore) await fs.chmod(directory, 0o700).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  });
  const env = {
    PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR ?? '/tmp', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    OPENCODE_PASSWORD: SENTINEL, OPENCHAMBER_DATA_DIR: data, NET_ATTEMPT_LOG: log,
  };
  if (initialize) {
    const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: project, env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'pipe' });
    git('init', '--quiet');
    if (commit) git('commit', '--quiet', '--allow-empty', '-m', 'initial');
  }
  return {
    root, home, project, tools, preload, log, env, restore,
    coordinatorFile: path.join(home, '.config', 'heimdall', 'coordinator.toml'),
    projectFile: path.join(project, '.heimdall.toml'),
  };
}

const read = file => fs.readFile(file, 'utf8');
const exists = file => fs.access(file).then(() => true, () => false);

/** Every path under the sandbox (except the test tools) with type, size, mode, mtime and link target. */
async function snapshot(s) {
  const entries = {};
  const walk = async directory => {
    // A deliberately unreadable fixture directory is recorded but not entered.
    for (const name of await fs.readdir(directory).catch(() => [])) {
      const full = path.join(directory, name);
      if (full === s.tools) continue;
      const stats = await fs.lstat(full);
      entries[path.relative(s.root, full)] = [stats.isDirectory() ? 'd' : stats.isSymbolicLink() ? 'l' : 'f', stats.size, stats.mode, stats.mtimeMs, stats.isSymbolicLink() ? await fs.readlink(full) : null];
      if (stats.isDirectory()) await walk(full);
    }
  };
  entries['.'] = [(await fs.lstat(s.root)).mode];
  await walk(s.root);
  return entries;
}

async function assertNoNetworkAttempts(s) {
  assert.equal(await exists(s.log), false, `network attempts: ${await exists(s.log) ? await read(s.log) : ''}`);
}
function assertNoSecrets(result) {
  for (const output of [result.stdout, result.stderr]) {
    assert.ok(!output.includes(SENTINEL), 'the password sentinel appeared in output');
    assert.ok(!output.includes(TOKEN_SENTINEL), 'the token sentinel appeared in output');
  }
}

function run(s, command, args, { cwd = s.project, env = {}, input = '' } = {}) {
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--import', s.preload, cli, command, ...args], { cwd, env: { ...s.env, ...env }, encoding: 'utf8', input, timeout: DEADLINE_MS, killSignal: 'SIGKILL' });
  assert.equal(result.error, undefined, `${command} did not finish: ${result.error?.message}`);
  assert.equal(result.signal, null);
  assert.ok(Date.now() - started < DEADLINE_MS);
  assertNoSecrets(result);
  return result;
}

/** A complete, valid setup created by the setup command itself. */
function createSetup(s, extra = []) {
  const result = run(s, 'setup', [...complete, '--no-input', ...extra]);
  assert.equal(result.status, 0, result.stderr);
}

function assertCheckShape(check) {
  assert.deepEqual(Object.keys(check).sort(), ['fatal', 'id', 'message', 'status']);
  assert.equal(typeof check.id, 'string');
  assert.ok(STATUSES.includes(check.status), check.status);
  assert.equal(typeof check.fatal, 'boolean');
  assert.ok(typeof check.message === 'string' && check.message.length > 0);
}

/** The documented schemaVersion 1 document (see the comment at the top of src/doctor/cli.ts). */
function assertSchema(document) {
  assert.deepEqual(Object.keys(document).sort(), ['checks', 'error', 'ok', 'schemaVersion', 'targets', 'verification']);
  assert.equal(document.schemaVersion, 1);
  assert.equal(typeof document.ok, 'boolean');
  assert.deepEqual(Object.keys(document.targets).sort(), ['coordinatorConfig', 'projectConfig', 'projectDirectory', 'stateDirectory']);
  for (const value of Object.values(document.targets)) assert.ok(value === null || typeof value === 'string');
  assert.ok(Array.isArray(document.checks));
  document.checks.forEach(assertCheckShape);
  assert.deepEqual(Object.keys(document.verification).sort(), ['connection', 'local', 'modelAvailability', 'protectedApiAuthorization', 'providerLogin', 'quota']);
  assert.ok(['passed', 'failed'].includes(document.verification.local));
  assert.ok(['not-requested', 'verified', 'failed'].includes(document.verification.connection));
  for (const key of ['protectedApiAuthorization', 'modelAvailability', 'providerLogin', 'quota']) assert.equal(document.verification[key], 'unverified', key);
  assert.equal(document.verification.local, document.ok ? 'passed' : 'failed');
  if (document.error === null) {
    assert.deepEqual(document.checks.map(check => check.id), ORDER);
    assert.equal(document.ok, !document.checks.some(check => check.fatal && check.status === 'fail'));
    for (const check of document.checks) assert.equal(check.fatal, !ADVISORY.includes(check.id), check.id);
    const connection = document.checks.find(check => check.id === 'connection');
    assert.equal(connection.status, 'not-verified', 'connection is verified only by test/doctor-connect.test.mjs');
  } else {
    assert.equal(document.ok, false);
    assert.deepEqual(Object.keys(document.error).sort(), ['code', 'message']);
    assert.ok(['invalid-input', 'unexpected'].includes(document.error.code));
    assert.deepEqual(document.checks, []);
  }
}

const statuses = document => Object.fromEntries(document.checks.map(check => [check.id, check.status]));
const checkOf = (document, id) => document.checks.find(check => check.id === id);

/**
 * Runs doctor in human and JSON mode, requires identical outcomes and exit codes in both, checks the filesystem is untouched
 * and that no network was used, and returns both views.
 */
async function both(s, args = [], options = {}) {
  const before = await snapshot(s);
  const human = run(s, 'doctor', args, options);
  const json = run(s, 'doctor', [...args, '--json'], options);
  const after = await snapshot(s);
  assert.deepEqual(after, before, 'doctor changed the filesystem');
  await assertNoNetworkAttempts(s);
  const document = JSON.parse(json.stdout);
  assert.equal(json.stdout, JSON.stringify(document, null, 2) + '\n');
  assert.equal(json.stderr, '', 'JSON mode wrote to stderr');
  assertSchema(document);
  assert.equal(human.status, json.status);
  assert.equal(json.status, document.ok ? 0 : 1);
  if (document.error === null) {
    const lines = [...human.stdout.matchAll(/^\[(\S+)\] ([\w.-]+)/gm)].map(match => [match[2], match[1]]);
    assert.deepEqual(lines, document.checks.map(check => [check.id, check.status]), 'human report differs from the JSON report');
    assert.match(human.stdout, /Connection verification: not requested/);
    assert.match(human.stdout, /Unverified: protected-API authorization, model availability, provider login and quota\./);
    const failed = document.checks.filter(check => check.fatal && check.status === 'fail').map(check => check.id);
    if (failed.length) assert.ok(human.stderr.includes(failed[0]) && /required checks? failed/.test(human.stderr), human.stderr);
    else assert.equal(human.stderr, '');
  }
  return { human, json, document };
}

const OK_STATUSES = {
  'node.version': 'pass', 'git.available': 'pass', 'project.git': 'pass', 'project.commit': 'pass', 'runtime.assets': 'pass', 'runtime.identity': 'pass',
  'runtime.dependencies': 'pass', 'runtime.quota-package': 'pass', 'coordinator.config': 'pass', 'project.config': 'pass', 'project.setup': 'pass',
  'paths.state': 'pass', 'paths.project': 'pass', 'permissions': 'pass', 'connection': 'not-verified',
};

test('the network guard records an attempted request', async t => {
  const s = await sandbox(t);
  const result = spawnSync(process.execPath, ['--import', s.preload, '-e', "fetch('http://127.0.0.1:9/').catch(() => undefined)"], { env: s.env, encoding: 'utf8', timeout: DEADLINE_MS });
  assert.notEqual(result.status, null);
  assert.equal(await read(s.log), 'fetch\n');
});

test('a setup-created project passes offline, changes nothing and leaves the connection unverified', async t => {
  const s = await sandbox(t);
  createSetup(s);
  const stateDirectory = path.join(s.home, '.local', 'state', 'heimdall');
  assert.equal(await exists(stateDirectory), false);
  const { human, document } = await both(s);
  assert.equal(human.status, 0);
  assert.deepEqual(statuses(document), OK_STATUSES);
  assert.equal(document.ok, true);
  assert.equal(document.verification.local, 'passed');
  assert.equal(document.verification.connection, 'not-requested');
  assert.equal(document.targets.projectDirectory, s.project);
  assert.equal(document.targets.projectConfig, s.projectFile);
  assert.equal(document.targets.coordinatorConfig, s.coordinatorFile);
  assert.equal(document.targets.stateDirectory, stateDirectory);
  // A missing state directory is not a failure and is not created.
  assert.match(checkOf(document, 'paths.state').message, /does not exist yet/);
  assert.equal(await exists(stateDirectory), false);
  assert.equal(await exists(path.join(s.home, '.local')), false);
  assert.equal(await exists(path.join(s.project, '.heimdall')), false);
  const entries = Object.keys(await snapshot(s));
  for (const entry of entries) assert.doesNotMatch(entry, /\.sock$|\.sqlite|\.db$|\.db-|runtime|\.local|\.heimdall\/|\/runs\/|\.tmp$|coordinator\.token/i, `unexpected artifact ${entry}`);
  assert.match(human.stdout, /Local checks passed/);
  assert.match(human.stdout, /Connection verification: not requested/);
  assert.match(human.stdout, /Passing local checks does not show that a run can execute/);
});

test('an existing state directory is checked in place and a missing one is checked through its nearest existing ancestor', async t => {
  const s = await sandbox(t);
  const state = path.join(s.root, 'state');
  createSetup(s, ['--state-directory', state]);
  assert.equal(await exists(state), false);
  let { document } = await both(s);
  assert.equal(document.targets.stateDirectory, state);
  assert.equal(checkOf(document, 'paths.state').status, 'pass');
  assert.match(checkOf(document, 'paths.state').message, new RegExp(`does not exist yet; it can be created under ${s.root}`));
  // Several missing levels below an existing ancestor behave the same.
  await fs.writeFile(s.coordinatorFile, `[coordinator]\nstateDirectory = "${path.join(s.root, 'a', 'b', 'c')}"\n`);
  ({ document } = await both(s));
  assert.equal(checkOf(document, 'paths.state').status, 'pass');
  assert.equal(await exists(path.join(s.root, 'a')), false);
  // An existing state directory is inspected itself.
  await fs.mkdir(state, { mode: 0o700 });
  await fs.writeFile(s.coordinatorFile, `[coordinator]\nstateDirectory = "${state}"\n`);
  await fs.chmod(s.coordinatorFile, 0o600);
  ({ document } = await both(s));
  assert.equal(checkOf(document, 'paths.state').status, 'pass');
  assert.match(checkOf(document, 'paths.state').message, /exists and is accessible/);
  assert.deepEqual(await fs.readdir(state), []);
});

test('invalid project and coordinator configuration are fatal; incomplete setup is fatal', async t => {
  await t.test('malformed project configuration', async t => {
    const s = await sandbox(t);
    createSetup(s);
    await fs.writeFile(s.projectFile, '[workflow\nplannerModel = ');
    const { document, human } = await both(s);
    assert.equal(human.status, 1);
    assert.equal(checkOf(document, 'project.config').status, 'fail');
    assert.equal(checkOf(document, 'project.config').fatal, true);
    assert.match(checkOf(document, 'project.config').message, /is not valid/);
    assert.equal(checkOf(document, 'project.setup').status, 'skipped');
    assert.equal(checkOf(document, 'paths.project').status, 'skipped');
    assert.equal(checkOf(document, 'coordinator.config').status, 'pass');
    assert.equal(document.verification.local, 'failed');
    assert.match(human.stderr, /required check failed: project\.config/);
  });

  await t.test('schema-invalid project configuration', async t => {
    const s = await sandbox(t);
    createSetup(s);
    await fs.writeFile(s.projectFile, '[workflow]\nunknownSetting = 1\n');
    const { document } = await both(s);
    assert.equal(document.ok, false);
    assert.equal(checkOf(document, 'project.config').status, 'fail');
  });

  await t.test('incomplete project configuration (shipped template)', async t => {
    const s = await sandbox(t);
    createSetup(s);
    await fs.copyFile(path.join(repository, 'examples', 'heimdall.toml'), s.projectFile);
    const { document, human } = await both(s);
    assert.equal(human.status, 1);
    assert.equal(checkOf(document, 'project.config').status, 'pass');
    const setup = checkOf(document, 'project.setup');
    assert.equal(setup.status, 'fail');
    assert.equal(setup.fatal, true);
    assert.match(setup.message, /opencode\.baseUrl/);
    assert.match(setup.message, /workflow\.plannerModel/);
    assert.match(human.stderr, /project\.setup/);
  });

  await t.test('missing project configuration', async t => {
    const s = await sandbox(t);
    const { document, human } = await both(s);
    assert.equal(human.status, 1);
    assert.equal(checkOf(document, 'project.config').status, 'fail');
    assert.match(checkOf(document, 'project.config').message, /does not exist/);
    assert.equal(checkOf(document, 'project.setup').status, 'skipped');
    // No coordinator file at the default location: defaults apply, advisory only.
    assert.equal(checkOf(document, 'coordinator.config').status, 'warn');
  });

  await t.test('malformed coordinator configuration', async t => {
    const s = await sandbox(t);
    createSetup(s);
    await fs.writeFile(s.coordinatorFile, '[coordinator]\nglobalConcurrency = 0\n');
    const { document, human } = await both(s);
    assert.equal(human.status, 1);
    assert.equal(checkOf(document, 'coordinator.config').status, 'fail');
    assert.equal(checkOf(document, 'coordinator.config').fatal, true);
    assert.match(checkOf(document, 'coordinator.config').message, /globalConcurrency/);
    assert.equal(checkOf(document, 'paths.state').status, 'skipped');
    assert.equal(checkOf(document, 'project.config').status, 'pass');
  });

  await t.test('explicitly selected coordinator configuration that does not exist', async t => {
    const s = await sandbox(t);
    createSetup(s);
    const absent = path.join(s.root, 'absent.toml');
    for (const [args, env] of [[['--coordinator-config', absent], {}], [[], { HEIMDALL_COORDINATOR_CONFIG: absent }]]) {
      const { document, human } = await both(s, args, { env });
      assert.equal(human.status, 1);
      assert.equal(checkOf(document, 'coordinator.config').status, 'fail');
      assert.match(checkOf(document, 'coordinator.config').message, /does not exist/);
    }
  });

  await t.test('a default coordinator configuration that is absent is advisory when the rest is complete', async t => {
    const s = await sandbox(t);
    createSetup(s);
    await fs.rm(s.coordinatorFile);
    const { document, human } = await both(s);
    assert.equal(human.status, 0);
    assert.equal(checkOf(document, 'coordinator.config').status, 'warn');
    assert.equal(document.ok, true);
  });
});

test('Git problems are fatal and stop dependent checks', async t => {
  await t.test('not a Git project', async t => {
    const s = await sandbox(t, { git: false });
    const { document, human } = await both(s);
    assert.equal(human.status, 1);
    assert.equal(checkOf(document, 'git.available').status, 'pass');
    assert.equal(checkOf(document, 'project.git').status, 'fail');
    assert.equal(checkOf(document, 'project.git').fatal, true);
    assert.equal(checkOf(document, 'project.commit').status, 'skipped');
    assert.equal(checkOf(document, 'project.config').status, 'skipped');
    assert.equal(checkOf(document, 'project.setup').status, 'skipped');
    assert.equal(checkOf(document, 'paths.project').status, 'skipped');
    assert.equal(document.targets.projectDirectory, null);
    assert.equal(document.targets.projectConfig, null);
    assert.match(human.stderr, /project\.git/);
  });

  await t.test('no commit', async t => {
    const s = await sandbox(t, { commit: false });
    // Setup refuses a project without a commit, so write the valid configuration from a committed twin.
    const twin = await sandbox(t);
    createSetup(twin);
    await fs.mkdir(path.dirname(s.coordinatorFile), { recursive: true, mode: 0o700 });
    await fs.copyFile(twin.coordinatorFile, s.coordinatorFile);
    await fs.copyFile(twin.projectFile, s.projectFile);
    await fs.chmod(s.coordinatorFile, 0o600);
    await fs.chmod(s.projectFile, 0o600);
    const { document, human } = await both(s);
    assert.equal(human.status, 1);
    assert.equal(checkOf(document, 'project.git').status, 'pass');
    assert.equal(checkOf(document, 'project.commit').status, 'fail');
    assert.equal(checkOf(document, 'project.commit').fatal, true);
    assert.match(checkOf(document, 'project.commit').message, /has no commit/);
    assert.equal(checkOf(document, 'project.config').status, 'pass');
    assert.equal(checkOf(document, 'project.setup').status, 'pass');
  });

  await t.test('git missing from PATH', async t => {
    const s = await sandbox(t);
    createSetup(s);
    const environment = { ...s.env, PATH: path.join(s.root, 'empty') };
    const result = spawnSync(process.execPath, ['--import', s.preload, cli, 'doctor', '--json'], { cwd: s.project, env: environment, encoding: 'utf8', timeout: DEADLINE_MS });
    assert.equal(result.status, 1);
    const document = JSON.parse(result.stdout);
    assertSchema(document);
    assert.equal(checkOf(document, 'git.available').status, 'fail');
    assert.equal(checkOf(document, 'project.git').status, 'skipped');
    assert.equal(checkOf(document, 'project.commit').status, 'skipped');
  });
});

test('path access problems are fatal', { skip: isRoot ? 'permission checks are meaningless as root' : false }, async t => {
  await t.test('a state ancestor that cannot be inspected', async t => {
    const s = await sandbox(t);
    createSetup(s);
    const locked = path.join(s.root, 'locked');
    await fs.mkdir(locked, { mode: 0o700 });
    await fs.writeFile(s.coordinatorFile, `[coordinator]\nstateDirectory = "${path.join(locked, 'state', 'h')}"\n`);
    await fs.chmod(s.coordinatorFile, 0o600);
    await fs.chmod(locked, 0o000);
    s.restore.push(locked);
    const { document, human } = await both(s);
    assert.equal(human.status, 1);
    assert.equal(checkOf(document, 'coordinator.config').status, 'fail');
    assert.match(checkOf(document, 'coordinator.config').message, /EACCES/);
    assert.equal(checkOf(document, 'paths.state').status, 'skipped');
    assert.equal(checkOf(document, 'paths.state').fatal, true);
  });

  await t.test('a state ancestor that cannot be written, so state could not be created', async t => {
    const s = await sandbox(t);
    createSetup(s);
    const readonly = path.join(s.root, 'readonly');
    await fs.mkdir(readonly, { mode: 0o700 });
    await fs.writeFile(s.coordinatorFile, `[coordinator]\nstateDirectory = "${path.join(readonly, 'state')}"\n`);
    await fs.chmod(s.coordinatorFile, 0o600);
    await fs.chmod(readonly, 0o500);
    s.restore.push(readonly);
    const { document, human } = await both(s);
    assert.equal(human.status, 1);
    const state = checkOf(document, 'paths.state');
    assert.equal(state.status, 'fail');
    assert.equal(state.fatal, true);
    assert.match(state.message, /cannot be created/);
    assert.equal(checkOf(document, 'coordinator.config').status, 'pass');
    assert.match(human.stderr, /paths\.state/);
  });

  await t.test('an existing state directory that is not accessible', async t => {
    const s = await sandbox(t);
    const state = path.join(s.root, 'state');
    createSetup(s, ['--state-directory', state]);
    await fs.mkdir(state, { mode: 0o500 });
    s.restore.push(state);
    const { document } = await both(s);
    assert.equal(checkOf(document, 'paths.state').status, 'fail');
    assert.match(checkOf(document, 'paths.state').message, /not writable/);
  });

  await t.test('a project state directory that is a file', async t => {
    const s = await sandbox(t);
    createSetup(s);
    await fs.appendFile(s.projectFile, '\n[paths]\nstate = "state-file"\n');
    await fs.writeFile(path.join(s.project, 'state-file'), 'x', { mode: 0o600 });
    const { document, human } = await both(s);
    assert.equal(human.status, 1);
    assert.equal(checkOf(document, 'project.config').status, 'pass');
    assert.equal(checkOf(document, 'paths.project').status, 'fail');
    assert.match(checkOf(document, 'paths.project').message, /not a directory/);
  });

  await t.test('a custom prompt path that is missing', async t => {
    const s = await sandbox(t);
    createSetup(s);
    await fs.appendFile(s.projectFile, '\n[paths]\nplannerPrompt = "missing-prompt.md"\n');
    const { document } = await both(s);
    assert.equal(checkOf(document, 'paths.project').status, 'fail');
    assert.match(checkOf(document, 'paths.project').message, /Planner prompt .*missing-prompt\.md does not exist/);
  });
});

test('permission findings are advisory warnings, never repaired', { skip: process.platform === 'win32' ? 'POSIX modes only' : false }, async t => {
  await t.test('group- and world-readable configuration files', async t => {
    const s = await sandbox(t);
    createSetup(s);
    await fs.chmod(s.projectFile, 0o644);
    await fs.chmod(s.coordinatorFile, 0o640);
    const { document, human } = await both(s);
    assert.equal(human.status, 0);
    assert.equal(document.ok, true);
    const permissions = checkOf(document, 'permissions');
    assert.equal(permissions.status, 'warn');
    assert.equal(permissions.fatal, false);
    assert.ok(permissions.message.includes(`Project configuration ${s.projectFile} is readable by group or others (mode 644)`), permissions.message);
    assert.ok(permissions.message.includes(`Coordinator configuration ${s.coordinatorFile} is readable by group or others (mode 640)`), permissions.message);
    assert.match(permissions.message, /never changes permissions/);
    assert.equal((await fs.stat(s.projectFile)).mode & 0o777, 0o644);
    assert.equal((await fs.stat(s.coordinatorFile)).mode & 0o777, 0o640);
    assert.equal(human.stderr, '');
    assert.match(human.stdout, /\[warn\] permissions \(advisory\)/);
  });

  await t.test('configuration file exposure is described by the access it grants', async t => {
    const cases = [
      [0o600, null],
      [0o640, 'readable by group or others'], [0o604, 'readable by group or others'], [0o644, 'readable by group or others'],
      [0o620, 'writable by group or others'], [0o602, 'writable by group or others'], [0o622, 'writable by group or others'],
      [0o660, 'readable and writable by group or others'], [0o606, 'readable and writable by group or others'], [0o666, 'readable and writable by group or others'],
    ];
    for (const [mode, wording] of cases) {
      const octal = mode.toString(8);
      const s = await sandbox(t);
      createSetup(s);
      await fs.chmod(s.projectFile, mode);
      await fs.chmod(s.coordinatorFile, mode);
      const bytes = [await fs.readFile(s.projectFile), await fs.readFile(s.coordinatorFile)];
      const { document, human, json } = await both(s);
      const permissions = checkOf(document, 'permissions');
      // Warnings never change the exit status.
      assert.equal(human.status, 0, octal);
      assert.equal(json.status, 0, octal);
      assert.equal(document.ok, true, octal);
      assert.equal(permissions.fatal, false, octal);
      if (wording === null) {
        assert.equal(permissions.status, 'pass', permissions.message);
        assert.doesNotMatch(permissions.message, /chmod/);
      } else {
        assert.equal(permissions.status, 'warn', octal);
        for (const [label, file] of [['Project configuration', s.projectFile], ['Coordinator configuration', s.coordinatorFile]]) {
          assert.ok(permissions.message.includes(`${label} ${file} is ${wording} (mode ${octal}); consider chmod 600`), permissions.message);
        }
        assert.match(permissions.message, /never changes permissions/);
        assert.match(human.stdout, /\[warn\] permissions \(advisory\)/);
      }
      assert.equal(human.stderr, '', octal);
      // Reported, never repaired.
      assert.equal((await fs.stat(s.projectFile)).mode & 0o777, mode);
      assert.equal((await fs.stat(s.coordinatorFile)).mode & 0o777, mode);
      assert.deepEqual([await fs.readFile(s.projectFile), await fs.readFile(s.coordinatorFile)], bytes);
    }
  });

  await t.test('group-writable state and workflow directories', async t => {
    const s = await sandbox(t);
    const state = path.join(s.root, 'state');
    createSetup(s, ['--state-directory', state]);
    await fs.mkdir(state, { mode: 0o700 });
    await fs.chmod(state, 0o775);
    await fs.mkdir(path.join(s.project, '.heimdall'), { mode: 0o700 });
    await fs.chmod(path.join(s.project, '.heimdall'), 0o777);
    const { document, human } = await both(s);
    assert.equal(human.status, 0);
    assert.equal(checkOf(document, 'paths.state').status, 'pass');
    assert.equal(checkOf(document, 'paths.project').status, 'pass');
    const permissions = checkOf(document, 'permissions');
    assert.equal(permissions.status, 'warn');
    assert.ok(permissions.message.includes(`Directory ${state} is writable by group or others (mode 775)`), permissions.message);
    assert.ok(permissions.message.includes(`Directory ${path.join(s.project, '.heimdall')} is writable by group or others (mode 777)`), permissions.message);
    assert.equal((await fs.stat(state)).mode & 0o777, 0o775);
  });

  await t.test('a sticky world-writable ancestor is not flagged', async t => {
    const s = await sandbox(t);
    const shared = path.join(s.root, 'shared');
    await fs.mkdir(shared, { mode: 0o700 });
    await fs.chmod(shared, 0o1777);
    createSetup(s, ['--state-directory', path.join(shared, 'state')]);
    const { document } = await both(s);
    assert.equal(checkOf(document, 'permissions').status, 'pass');
  });
});

test('selectors follow the setup precedence: flags, then environment, then defaults', async t => {
  const s = await sandbox(t);
  const alternateProject = path.join(s.root, 'alternate.toml');
  const alternateCoordinator = path.join(s.root, 'alternate-coordinator.toml');
  createSetup(s, ['--config', alternateProject, '--coordinator-config', alternateCoordinator]);
  await Promise.all([fs.chmod(alternateProject, 0o600), fs.chmod(alternateCoordinator, 0o600)]);
  // Defaults point at nothing, so the explicit selectors are what makes the report pass.
  let { document } = await both(s, ['--config', alternateProject, '--coordinator-config', alternateCoordinator]);
  assert.equal(document.ok, true);
  assert.equal(document.targets.projectConfig, alternateProject);
  assert.equal(document.targets.coordinatorConfig, alternateCoordinator);
  ({ document } = await both(s, [], { env: { HEIMDALL_CONFIG: alternateProject, HEIMDALL_COORDINATOR_CONFIG: alternateCoordinator } }));
  assert.equal(document.ok, true);
  assert.equal(document.targets.projectConfig, alternateProject);
  // A flag wins over the environment.
  ({ document } = await both(s, ['--config', alternateProject], { env: { HEIMDALL_CONFIG: path.join(s.root, 'wrong.toml'), HEIMDALL_COORDINATOR_CONFIG: alternateCoordinator } }));
  assert.equal(document.ok, true);
  assert.equal(document.targets.projectConfig, alternateProject);
  // --project selects the project from another working directory, a subdirectory resolves to the toplevel.
  await fs.mkdir(path.join(s.project, 'sub'), { mode: 0o700 });
  ({ document } = await both(s, ['--project', path.join(s.project, 'sub'), '--config', alternateProject, '--coordinator-config', alternateCoordinator], { cwd: s.root }));
  assert.equal(document.ok, true);
  assert.equal(document.targets.projectDirectory, s.project);
  // Relative selectors resolve like setup does: the project file against the toplevel, the coordinator file against the cwd.
  ({ document } = await both(s, ['--project', 'project', '--config', 'alternate.toml', '--coordinator-config', 'alternate-coordinator.toml'], { cwd: s.root }));
  assert.equal(document.targets.coordinatorConfig, alternateCoordinator);
  assert.equal(document.targets.projectConfig, path.join(s.project, 'alternate.toml'));
  assert.equal(checkOf(document, 'project.config').status, 'fail');
});

test('JSON reports state what stays unverified without a connection request', async t => {
  const s = await sandbox(t);
  createSetup(s);
  {
    const { document } = await both(s, []);
    assert.deepEqual(document.verification, {
      local: 'passed', connection: 'not-requested',
      protectedApiAuthorization: 'unverified', modelAvailability: 'unverified', providerLogin: 'unverified', quota: 'unverified',
    });
  }
  // A failed local run reports the same unverified items.
  await fs.rm(s.projectFile);
  const { document } = await both(s);
  assert.equal(document.verification.local, 'failed');
  assert.equal(document.verification.connection, 'not-requested');
  for (const key of ['protectedApiAuthorization', 'modelAvailability', 'providerLogin', 'quota']) assert.equal(document.verification[key], 'unverified');
});

test('argument errors, help and secrets', async t => {
  const s = await sandbox(t);
  createSetup(s);
  const before = await snapshot(s);
  const cases = [
    [['--bogus'], /Unknown flag --bogus/],
    [['--connect', '--connect'], /Repeated flag --connect/],
    [['positional'], /Unexpected argument/],
    [['--project'], /--project requires a value/],
    [['--config'], /--config requires a value/],
    [['--coordinator-config', '--connect'], /--coordinator-config requires a value/],
    [['--connect=yes'], /--connect does not take a value/],
    [[`--token=${TOKEN_SENTINEL}`], /Credentials are never accepted as flags --token/],
    [['--password', SENTINEL], /Credentials are never accepted as flags --password/],
    [[`--${SENTINEL}`], /Credentials are never accepted as flags/],
  ];
  for (const [args, pattern] of cases) {
    const human = run(s, 'doctor', args);
    assert.equal(human.status, 1, args.join(' '));
    assert.equal(human.stdout, '');
    assert.match(human.stderr, pattern);
    const json = run(s, 'doctor', [...args, '--json']);
    assert.equal(json.status, 1);
    assert.equal(json.stderr, '');
    const document = JSON.parse(json.stdout);
    assertSchema(document);
    assert.equal(document.error.code, 'invalid-input');
    assert.match(document.error.message, pattern);
  }
  const help = run(s, 'doctor', ['--help', '--json', '--bogus']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^Run offline, read-only diagnostics/);
  assert.match(help.stdout, /--connect/);
  assert.equal(help.stderr, '');
  const top = run(s, '--help', []);
  assert.match(top.stdout, /heimdall doctor \[--project DIRECTORY\]/);
  assert.deepEqual(await snapshot(s), before);
  await assertNoNetworkAttempts(s);
});

test('the human report and the JSON report never contain credentials', async t => {
  const s = await sandbox(t);
  createSetup(s, ['--password-env', 'OPENCODE_PASSWORD']);
  assert.match(await read(s.projectFile), /passwordEnvironmentVariable = "OPENCODE_PASSWORD"/);
  // A credential-bearing path is redacted in every output.
  const secretDirectory = path.join(s.root, SENTINEL);
  await fs.mkdir(secretDirectory, { mode: 0o700 });
  const { human, json } = await both(s, ['--project', secretDirectory]);
  for (const output of [human.stdout, human.stderr, json.stdout, json.stderr]) assert.ok(!output.includes(SENTINEL));
  assert.equal(human.status, 1);
});

test('node version minimum is enforced in-process', async t => {
  const s = await sandbox(t);
  createSetup(s, ['--state-directory', path.join(s.root, 'state')]);
  const out = [], err = [];
  const options = { environment: { ...s.env }, cwd: s.project, homeDirectory: s.home, stdout: { write: text => out.push(text) }, stderr: { write: text => err.push(text) } };
  assert.equal(MINIMUM_NODE, '22.19.0');
  const engines = JSON.parse(await read(path.join(repository, 'package.json'))).engines.node;
  assert.equal(engines, `>=${MINIMUM_NODE}`);
  for (const [version, status] of [['22.19.0', 'pass'], ['22.19.1', 'pass'], ['24.0.0', 'pass'], ['22.18.9', 'fail'], ['20.19.0', 'fail'], ['22.5.0', 'fail']]) {
    out.length = 0; err.length = 0;
    const code = await doctorMain(['--json'], { ...options, nodeVersion: version });
    const document = JSON.parse(out.join(''));
    assert.equal(checkOf(document, 'node.version').status, status, version);
    assert.equal(code, status === 'pass' ? 0 : 1, version);
    assert.equal(document.ok, status === 'pass');
  }
});

test('incomplete or broken installed runtimes are fatal', async t => {
  const s = await sandbox(t);
  createSetup(s, ['--state-directory', path.join(s.root, 'state')]);
  const options = { environment: { ...s.env }, cwd: s.project, homeDirectory: s.home };
  const fake = async (name, { prompts = true, agents = true, templates = true, dist = true, dependencies = {}, modules = [] } = {}) => {
    const root = path.join(s.root, 'packages', name);
    const write = async (relative, text) => { await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true }); await fs.writeFile(path.join(root, relative), text); };
    await write('package.json', JSON.stringify({ name: 'fake-package', version: '1.2.3', dependencies }));
    if (dist) await write('dist/index.js', 'export {};\n');
    if (prompts) await write('prompts/planner.md', '# planner\n');
    if (agents) await write('examples/opencode/agents/adr-planner.md', '# agent\n');
    if (templates) { await write('examples/heimdall.toml', '\n'); await write('examples/coordinator.toml', '\n'); }
    for (const module of modules) await write(`node_modules/${module}/package.json`, JSON.stringify({ name: module, version: '1.0.0' }));
    return root;
  };
  const report = async packageRoot => (await runLocalChecks({}, { ...options, packageRoot })).checks;
  const by = (checks, id) => checks.find(check => check.id === id);

  let checks = await report(await fake('good', { dependencies: { dep: '1.0.0' }, modules: ['dep'] }));
  assert.equal(by(checks, 'runtime.assets').status, 'pass');
  assert.equal(by(checks, 'runtime.identity').status, 'pass');
  assert.equal(by(checks, 'runtime.dependencies').status, 'pass');

  checks = await report(await fake('no-prompts', { prompts: false }));
  assert.equal(by(checks, 'runtime.assets').status, 'fail');
  assert.match(by(checks, 'runtime.assets').message, /prompts has no prompts files/);
  checks = await report(await fake('no-agents', { agents: false }));
  assert.match(by(checks, 'runtime.assets').message, /examples\/opencode\/agents has no agents files/);
  checks = await report(await fake('no-templates', { templates: false }));
  assert.match(by(checks, 'runtime.assets').message, /examples\/heimdall\.toml is missing; examples\/coordinator\.toml is missing/);
  checks = await report(await fake('no-dist', { dist: false }));
  assert.equal(by(checks, 'runtime.assets').status, 'fail');
  assert.equal(by(checks, 'runtime.identity').status, 'fail');
  assert.match(by(checks, 'runtime.identity').message, /no built dist/);
  checks = await report(await fake('missing-dependency', { dependencies: { absent: '1.0.0' } }));
  assert.equal(by(checks, 'runtime.dependencies').status, 'fail');
  assert.equal(by(checks, 'runtime.dependencies').fatal, true);
  assert.equal(by(checks, 'runtime.assets').status, 'pass');
  checks = await report(await fake('nested-missing', { dependencies: { dep: '1.0.0' }, modules: ['dep'] }).then(async root => {
    await fs.writeFile(path.join(root, 'node_modules', 'dep', 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0', dependencies: { gone: '1.0.0' } }));
    return root;
  }));
  assert.equal(by(checks, 'runtime.dependencies').status, 'fail');
  assert.match(by(checks, 'runtime.dependencies').message, /gone/);
  checks = await report(path.join(s.root, 'packages', 'nonexistent'));
  assert.equal(by(checks, 'runtime.assets').status, 'fail');
  assert.equal(by(checks, 'runtime.identity').status, 'fail');
  assert.equal(by(checks, 'runtime.dependencies').status, 'fail');
});

test('required dependencies without a readable package identity make the report not ok, without echoing their content', async t => {
  const s = await sandbox(t);
  createSetup(s, ['--state-directory', path.join(s.root, 'state')]);
  const MANIFEST_SENTINEL = 'sentinel-manifest-content-7f3a91';
  const manifests = [
    ['invalid JSON', `{ "name": "bad", "note": "${MANIFEST_SENTINEL}", `],
    ['an array', JSON.stringify([MANIFEST_SENTINEL])],
    ['a string', JSON.stringify(MANIFEST_SENTINEL)],
    ['null', 'null'],
    ['no version', JSON.stringify({ name: 'bad', note: MANIFEST_SENTINEL })],
    ['an empty version', JSON.stringify({ name: 'bad', version: '', note: MANIFEST_SENTINEL })],
    ['a non-string version', JSON.stringify({ name: 'bad', version: 7, note: MANIFEST_SENTINEL })],
  ];
  // An installed package without a lockfile, in the consumer layout (dependencies beside it) or the global one (inside it).
  const install = async (name, layout) => {
    const modules = layout === 'consumer' ? path.join(s.root, name, 'node_modules') : path.join(s.root, name, 'lib', 'node_modules');
    const root = path.join(modules, 'fake-package');
    const hoisted = layout === 'consumer' ? modules : path.join(root, 'node_modules');
    const write = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };
    await write(path.join(root, 'package.json'), JSON.stringify({ name: 'fake-package', version: '1.2.3', dependencies: { dep: '1.0.0' } }));
    for (const [file, text] of [['dist/index.js', 'export {};\n'], ['prompts/planner.md', '# planner\n'], ['examples/opencode/agents/adr-planner.md', '# agent\n'], ['examples/heimdall.toml', '\n'], ['examples/coordinator.toml', '\n']]) await write(path.join(root, file), text);
    await write(path.join(hoisted, 'dep', 'package.json'), JSON.stringify({ name: 'dep', version: '1.0.0', dependencies: { trans: '1.0.0' } }));
    await write(path.join(hoisted, 'trans', 'package.json'), JSON.stringify({ name: 'trans', version: '1.0.0' }));
    return { root, dep: path.join(hoisted, 'dep', 'package.json'), trans: path.join(hoisted, 'trans', 'package.json') };
  };
  const doctor = async (args, packageRoot) => {
    const out = [], err = [];
    const code = await doctorMain(args, { environment: { ...s.env }, cwd: s.project, homeDirectory: s.home, packageRoot, stdout: { write: text => out.push(text) }, stderr: { write: text => err.push(text) } });
    return { code, stdout: out.join(''), stderr: err.join('') };
  };

  for (const layout of ['consumer', 'global']) {
    const good = await install(`good-${layout}`, layout);
    const ok = JSON.parse((await doctor(['--json'], good.root)).stdout);
    assert.equal(checkOf(ok, 'runtime.dependencies').status, 'pass', layout);

    let index = 0;
    for (const [kind, manifest] of manifests) {
      for (const [role, pick, named] of [['direct', installed => installed.dep, /\(package\) > dep/], ['transitive', installed => installed.trans, /dep > trans/]]) {
        const label = `${layout} ${role} dependency with ${kind}`;
        const installed = await install(`bad-${layout}-${index += 1}`, layout);
        await fs.writeFile(pick(installed), manifest);
        const json = await doctor(['--json'], installed.root);
        const human = await doctor([], installed.root);
        const document = JSON.parse(json.stdout);
        const check = checkOf(document, 'runtime.dependencies');
        assert.equal(check.status, 'fail', label);
        assert.equal(check.fatal, true, label);
        assert.match(check.message, named, label);
        assert.match(check.message, /cannot be identified/, label);
        assert.equal(document.ok, false, label);
        assert.equal(json.code, 1, label);
        assert.equal(human.code, 1, label);
        assert.match(human.stdout, /\[fail\] runtime\.dependencies/, label);
        assert.match(human.stdout, named, label);
        for (const output of [json.stdout, json.stderr, human.stdout, human.stderr]) assert.ok(!output.includes(MANIFEST_SENTINEL), label + ': manifest content leaked');
      }
    }
  }
});

test('local checks reach no network and make no filesystem writes in-process', async t => {
  const s = await sandbox(t);
  createSetup(s, ['--state-directory', path.join(s.root, 'state')]);
  const before = await snapshot(s);
  const originalFetch = globalThis.fetch;
  const attempts = [];
  globalThis.fetch = () => { attempts.push('fetch'); throw new Error('network blocked'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const out = [];
  const code = await doctorMain(['--json'], { environment: { ...s.env }, cwd: s.project, homeDirectory: s.home, stdout: { write: text => out.push(text) }, stderr: { write: () => undefined } });
  assert.equal(code, 0);
  assert.deepEqual(attempts, []);
  assert.deepEqual(await snapshot(s), before);
  assert.equal(JSON.parse(out.join('')).ok, true);
});

test('the doctor module graph imports no network module and uses no mutating filesystem call', async () => {
  const seen = new Set();
  const files = [];
  const visit = async file => {
    if (seen.has(file)) return;
    seen.add(file);
    files.push(file);
    const text = await read(file);
    for (const match of text.matchAll(/(?:import|export)\s[^'";]*?from\s*['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)/g)) await visit(path.resolve(path.dirname(file), match[1] ?? match[2]));
  };
  await visit(path.join(repository, 'dist', 'doctor', 'index.js'));
  for (const name of ['checks.js', 'cli.js']) {
    const text = await read(path.join(repository, 'dist', 'doctor', name));
    assert.doesNotMatch(text, /\b(?:fs|fsPromises)\.(?:writeFile|appendFile|mkdir|rm|rename|unlink|chmod|chown|copyFile|symlink|link|truncate|mkdtemp|utimes)\b/, name);
    assert.doesNotMatch(text, /O_CREAT|O_WRONLY|O_RDWR/, name);
    assert.doesNotMatch(text, /\bfetch\(|XMLHttpRequest|WebSocket/, name);
  }
  for (const file of files.filter(file => file.includes(`${path.sep}doctor${path.sep}`))) {
    const text = await read(file);
    assert.doesNotMatch(text, /from\s*['"](?:node:)?(?:net|http|https|http2|tls|dgram|dns)['"]/, file);
  }
  assert.ok(files.length > 1);
});

test('parseDoctorArguments accepts both flag forms', () => {
  assert.deepEqual(parseDoctorArguments(['--project=/a', '--config', 'b.toml', '--coordinator-config=c.toml', '--connect', '--json']), {
    input: { projectDirectory: '/a', configPath: 'b.toml', coordinatorConfigPath: 'c.toml', connect: true }, json: true, help: false,
  });
  assert.deepEqual(parseDoctorArguments([]), { input: {}, json: false, help: false });
  assert.equal(parseDoctorArguments(['--help']).help, true);
});

test('doctor refuses to run against a missing working directory without throwing', async t => {
  const s = await sandbox(t);
  const missing = path.join(s.root, 'gone');
  const out = [];
  const code = await doctorMain(['--json', '--project', missing], { environment: { ...s.env }, cwd: s.root, homeDirectory: s.home, stdout: { write: text => out.push(text) }, stderr: { write: () => undefined } });
  assert.equal(code, 1);
  const document = JSON.parse(out.join(''));
  assertSchema(document);
  assert.equal(checkOf(document, 'project.git').status, 'fail');
});
