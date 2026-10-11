import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setupMain } from '../dist/setup/index.js';
import { loadConfiguration } from '../dist/config.js';
import { loadCoordinatorConfiguration } from '../dist/coordinator/config.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repository, 'dist', 'cli.js');
const SENTINEL = 'sentinel-secret-9f3c1a7e42';
const TOKEN_SENTINEL = 'sentinel-token-5b8d02c6a1';
const DEADLINE_MS = 30000;
const complete = ['--planner-model', 'anthropic/planner-x', '--executor-model', 'openai/executor-x', '--quota-provider', 'openai', '--opencode-url', 'http://127.0.0.1:4096', '--opencode-auth', 'basic'];
const BASELINE = ['home/', 'project/'];
const FLAGS = ['--project', '--config', '--coordinator-config', '--planner-model', '--executor-model', '--quota-provider', '--opencode-url', '--opencode-auth', '--password-env', '--state-directory', '--global-concurrency', '--project-concurrency', '--no-input', '--json', '--help'];

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
  const root = await fs.realpath(await fs.mkdtemp(path.join(await fs.access('/tmp').then(() => '/tmp', () => os.tmpdir()), 'hc-')));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const tools = path.join(root, 'tools');
  const data = path.join(root, 'tools', 'openchamber');
  await Promise.all([home, project, data].map(directory => fs.mkdir(directory, { recursive: true })));
  await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify({ desktopLocalPort: 4096, desktopLocalClientToken: TOKEN_SENTINEL }));
  const preload = path.join(tools, 'block-network.mjs');
  await fs.writeFile(preload, PRELOAD);
  const log = path.join(tools, 'network-attempts.log');
  t.after(async () => { await fs.chmod(project, 0o700).catch(() => undefined); await fs.rm(root, { recursive: true, force: true }); });
  const env = {
    PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR ?? '/tmp', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    OPENCODE_PASSWORD: SENTINEL, OPENCHAMBER_DATA_DIR: data, NET_ATTEMPT_LOG: log,
  };
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: project, env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'pipe' });
  if (initialize) {
    git('init', '--quiet');
    if (commit) git('commit', '--quiet', '--allow-empty', '-m', 'initial');
  }
  return {
    root, home, project, tools, preload, log, env,
    coordinatorFile: path.join(home, '.config', 'heimdall', 'coordinator.toml'),
    projectFile: path.join(project, '.heimdall.toml'),
  };
}

async function tree(root) {
  const entries = [];
  const walk = async directory => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git' || (directory === root && entry.name === 'tools')) continue;
      const full = path.join(directory, entry.name);
      entries.push(path.relative(root, full) + (entry.isDirectory() ? '/' : entry.isSymbolicLink() ? '@' : ''));
      if (entry.isDirectory()) await walk(full);
    }
  };
  await walk(root);
  return entries.sort();
}
const read = file => fs.readFile(file, 'utf8');
const exists = file => fs.access(file).then(() => true, () => false);

async function assertNoNetworkAttempts(s) {
  assert.equal(await exists(s.log), false, `network attempts: ${await exists(s.log) ? await read(s.log) : ''}`);
}
function assertNoSecrets(result) {
  for (const output of [result.stdout, result.stderr]) {
    assert.ok(!output.includes(SENTINEL), 'the password sentinel appeared in output');
    assert.ok(!output.includes(TOKEN_SENTINEL), 'the token sentinel appeared in output');
  }
}
function assertNoServiceArtifacts(entries) {
  for (const entry of entries) {
    assert.doesNotMatch(entry, /\.sock\/?$|\.sqlite|\.db\/?$|\.db-|runtime|snapshot|\.local|\.heimdall\/|\/runs\/|\.tmp$|coordinator\.token/i, `unexpected artifact ${entry}`);
  }
}

/** Runs `heimdall setup` with a finite deadline, isolated environment and the network guard. */
function setup(s, args, { cwd = s.project, input = '', env = {}, timeout = DEADLINE_MS } = {}) {
  const started = Date.now();
  const result = spawnSync(process.execPath, ['--import', s.preload, cli, 'setup', ...args], { cwd, env: { ...s.env, ...env }, encoding: 'utf8', input, timeout, killSignal: 'SIGKILL' });
  assert.equal(result.error, undefined, `setup did not finish: ${result.error?.message}`);
  assert.equal(result.signal, null);
  assert.ok(Date.now() - started < timeout);
  assertNoSecrets(result);
  return result;
}

const OUTCOMES = ['created', 'reused', 'not-written', 'failed'];
const CODES = ['invalid-input', 'missing-input', 'no-git-project', 'no-commit', 'invalid-destination', 'invalid-configuration', 'incomplete-configuration', 'conflict', 'identical-destinations', 'destination-exists', 'write-failed', 'unexpected'];
const isStringArray = value => Array.isArray(value) && value.every(item => typeof item === 'string');

/** The documented schemaVersion 1 document (see the comment at the top of src/setup/cli.ts). */
function assertSchema(document) {
  assert.deepEqual(Object.keys(document).sort(), ['createdDirectories', 'error', 'ok', 'partial', 'projectDirectory', 'schemaVersion', 'targets', 'verification', 'warnings']);
  assert.equal(document.schemaVersion, 1);
  assert.equal(typeof document.ok, 'boolean');
  assert.ok(document.projectDirectory === null || typeof document.projectDirectory === 'string');
  assert.deepEqual(Object.keys(document.targets).sort(), ['coordinator', 'project']);
  for (const target of Object.values(document.targets)) {
    assert.deepEqual(Object.keys(target).sort(), ['outcome', 'path']);
    assert.ok(target.path === null || typeof target.path === 'string');
    assert.ok(OUTCOMES.includes(target.outcome), target.outcome);
  }
  assert.ok(isStringArray(document.createdDirectories));
  assert.deepEqual(Object.keys(document.verification).sort(), ['level', 'unverified']);
  assert.ok(['configuration-validated', 'none'].includes(document.verification.level));
  assert.deepEqual(document.verification.unverified, ['opencode-connection', 'model-availability', 'provider-login', 'quota']);
  assert.ok(isStringArray(document.warnings));
  if (document.error === null) {
    assert.equal(document.ok, true);
    assert.equal(document.verification.level, 'configuration-validated');
    assert.equal(document.partial, null);
    for (const target of Object.values(document.targets)) assert.ok(['created', 'reused'].includes(target.outcome));
  } else {
    assert.equal(document.ok, false);
    assert.deepEqual(Object.keys(document.error).sort(), ['code', 'message', 'missing']);
    assert.ok(CODES.includes(document.error.code), document.error.code);
    assert.ok(typeof document.error.message === 'string' && document.error.message.length > 0);
    assert.ok(isStringArray(document.error.missing));
    assert.equal(document.verification.level, 'none');
  }
  if (document.partial !== null) {
    assert.deepEqual(Object.keys(document.partial).sort(), ['created', 'incomplete']);
    assert.ok(isStringArray(document.partial.created) && document.partial.created.length > 0);
    assert.ok(isStringArray(document.partial.incomplete) && document.partial.incomplete.length > 0);
  }
}

/** JSON mode: stdout is exactly one pretty-printed document and stderr is empty. */
function jsonDocument(result) {
  assert.equal(result.stderr, '');
  const document = JSON.parse(result.stdout);
  assert.equal(result.stdout, JSON.stringify(document, null, 2) + '\n', 'stdout must contain only the JSON document');
  assertSchema(document);
  assert.equal(result.status, document.ok ? 0 : 1);
  return document;
}

test('setup --help and the top-level help describe every flag; other commands keep their help', async t => {
  const s = await sandbox(t);
  const direct = setup(s, ['--help']);
  assert.equal(direct.status, 0);
  assert.equal(direct.stderr, '');
  const top = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8', env: { ...s.env, HEIMDALL_CONFIG: '' } });
  assert.equal(top.status, 0);
  for (const flag of FLAGS) {
    assert.ok(direct.stdout.includes(flag), `setup --help lacks ${flag}`);
    assert.ok(top.stdout.includes(flag), `heimdall --help lacks ${flag}`);
  }
  assert.match(top.stdout, /heimdall setup \[flags\]/);
  for (const line of ['heimdall init [--project DIRECTORY] [--config FILE]', 'heimdall check', 'heimdall status RUN_ID', 'heimdall coordinator --help', 'heimdall --version']) assert.ok(top.stdout.includes(line), line);
  // --help wins over everything else and never writes
  const ignoring = setup(s, ['--json', '--bogus', '--help']);
  assert.equal(ignoring.status, 0);
  assert.equal(ignoring.stdout, direct.stdout);
  assert.match(direct.stdout, /heimdall doctor --connect/);
  assert.deepEqual(await tree(s.root), BASELINE);
  await assertNoNetworkAttempts(s);
});

test('complete flags create both files that the loaders accept; a repeat reuses them byte-identically', async t => {
  const s = await sandbox(t);
  const state = path.join(s.root, 'state');
  const args = [...complete, '--state-directory', state, '--global-concurrency', '3'];
  const first = setup(s, args);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '');
  assert.match(first.stdout, /setup complete/);
  assert.ok(first.stdout.includes(`Coordinator configuration: ${s.coordinatorFile} (created)`));
  assert.ok(first.stdout.includes(`Project configuration: ${s.projectFile} (created)`));
  assert.match(first.stdout, /unverified/);
  for (const word of ['OpenCode connection', 'model availability', 'provider login', 'quota']) assert.ok(first.stdout.includes(word), word);
  assert.ok(first.stdout.includes('heimdall doctor --connect'));

  const configuration = await loadConfiguration({ projectDirectory: s.project, configPath: s.projectFile });
  assert.equal(configuration.settings.plannerModel, 'anthropic/planner-x');
  assert.equal(configuration.settings.executorCandidates.length, 1);
  assert.equal(configuration.settings.executorCandidates[0].model, 'openai/executor-x');
  assert.equal(configuration.settings.executorCandidates[0].quotaProvider, 'openai');
  assert.equal(configuration.opencode.baseUrl, 'http://127.0.0.1:4096');
  assert.equal(configuration.opencode.authentication, 'basic');
  assert.equal(configuration.opencode.passwordEnvironmentVariable, 'OPENCODE_PASSWORD');
  const coordinator = await loadCoordinatorConfiguration(s.coordinatorFile);
  assert.equal(coordinator.stateDirectory, state);
  assert.equal(coordinator.globalConcurrency, 3);
  assert.equal(coordinator.projectConcurrency, 1);
  assert.equal((await fs.stat(s.coordinatorFile)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(s.projectFile)).mode & 0o777, 0o600);
  const entries = await tree(s.root);
  assert.deepEqual(entries, ['home/', 'home/.config/', 'home/.config/heimdall/', 'home/.config/heimdall/coordinator.toml', 'project/', 'project/.heimdall.toml']);
  assert.equal(await exists(state), false, 'setup must not create coordinator state');
  assertNoServiceArtifacts(entries);

  const before = [await read(s.coordinatorFile), await read(s.projectFile)];
  const times = [(await fs.stat(s.coordinatorFile)).mtimeMs, (await fs.stat(s.projectFile)).mtimeMs];
  const repeat = setup(s, args);
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.ok(repeat.stdout.includes(`Coordinator configuration: ${s.coordinatorFile} (reused (unchanged))`));
  assert.ok(repeat.stdout.includes(`Project configuration: ${s.projectFile} (reused (unchanged))`));
  assert.deepEqual([await read(s.coordinatorFile), await read(s.projectFile)], before);
  assert.deepEqual([(await fs.stat(s.coordinatorFile)).mtimeMs, (await fs.stat(s.projectFile)).mtimeMs], times);
  assert.deepEqual(await tree(s.root), entries);
  await assertNoNetworkAttempts(s);
});

test('--json prints exactly one schemaVersion 1 document for creation and for reuse', async t => {
  const s = await sandbox(t);
  const created = jsonDocument(setup(s, [...complete, '--password-env', 'OPENCODE_PASSWORD', '--json']));
  assert.equal(created.ok, true);
  assert.equal(created.projectDirectory, s.project);
  assert.deepEqual(created.targets, { coordinator: { path: s.coordinatorFile, outcome: 'created' }, project: { path: s.projectFile, outcome: 'created' } });
  assert.deepEqual(created.createdDirectories, [path.join(s.home, '.config'), path.join(s.home, '.config', 'heimdall')]);
  assert.equal(created.verification.level, 'configuration-validated');
  assert.equal(created.error, null);
  assert.equal(created.partial, null);
  const text = await read(s.projectFile);
  assert.match(text, /passwordEnvironmentVariable = "OPENCODE_PASSWORD"/);
  assert.ok(!text.includes(SENTINEL));
  const reused = jsonDocument(setup(s, [...complete, '--json']));
  assert.equal(reused.ok, true);
  assert.deepEqual(reused.targets.coordinator.outcome, 'reused');
  assert.deepEqual(reused.targets.project.outcome, 'reused');
  assert.deepEqual(reused.createdDirectories, []);
  assert.equal(await read(s.projectFile), text);
  await assertNoNetworkAttempts(s);
});

test('the default project is the Git project of the working directory; environment variables select files and flags override them', async t => {
  const s = await sandbox(t);
  const nested = path.join(s.project, 'packages', 'inner');
  await fs.mkdir(nested, { recursive: true });
  const envConfig = path.join(s.root, 'env-project.toml');
  const envCoordinator = path.join(s.root, 'env-coordinator.toml');
  const viaEnvironment = jsonDocument(setup(s, [...complete, '--json'], { cwd: nested, env: { HEIMDALL_CONFIG: envConfig, HEIMDALL_COORDINATOR_CONFIG: envCoordinator } }));
  assert.equal(viaEnvironment.projectDirectory, s.project);
  assert.equal(viaEnvironment.targets.project.path, envConfig);
  assert.equal(viaEnvironment.targets.coordinator.path, envCoordinator);
  const flagConfig = path.join(s.root, 'flag-project.toml');
  const flagCoordinator = path.join(s.root, 'flag-coordinator.toml');
  const viaFlags = jsonDocument(setup(s, [...complete, '--json', '--config', flagConfig, '--coordinator-config', flagCoordinator], { cwd: nested, env: { HEIMDALL_CONFIG: envConfig, HEIMDALL_COORDINATOR_CONFIG: envCoordinator } }));
  assert.equal(viaFlags.targets.project.path, flagConfig);
  assert.equal(viaFlags.targets.coordinator.path, flagCoordinator);
  // Default resolution: .heimdall.toml in the Git toplevel and the coordinator file under HOME.
  const viaDefaults = jsonDocument(setup(s, [...complete, '--json'], { cwd: nested }));
  assert.equal(viaDefaults.projectDirectory, s.project);
  assert.equal(viaDefaults.targets.project.path, s.projectFile);
  assert.equal(viaDefaults.targets.coordinator.path, s.coordinatorFile);
  await assertNoNetworkAttempts(s);
});

test('a directory outside Git and a repository without a commit fail without writing', async t => {
  const plain = await sandbox(t, { git: false });
  const noCommit = await sandbox(t, { commit: false });
  for (const [s, code] of [[plain, 'no-git-project'], [noCommit, 'no-commit']]) {
    const before = await tree(s.root);
    const document = jsonDocument(setup(s, [...complete, '--json']));
    assert.equal(document.ok, false);
    assert.equal(document.error.code, code);
    assert.deepEqual(document.targets.coordinator.outcome, 'not-written');
    assert.deepEqual(document.targets.project.outcome, 'not-written');
    const human = setup(s, [...complete]);
    assert.equal(human.status, 1);
    assert.equal(human.stdout, '');
    assert.ok(human.stderr.includes(`(${code})`), human.stderr);
    assert.deepEqual(await tree(s.root), before);
    await assertNoNetworkAttempts(s);
  }
});

test('missing inputs under --no-input, --json and non-interactive stdin fail fast, name the flags and write nothing', async t => {
  const s = await sandbox(t);
  const before = await tree(s.root);
  const allFlags = ['--planner-model', '--executor-model', '--quota-provider', '--opencode-url', '--opencode-auth'];
  const invocations = [[['--no-input'], false], [['--json'], true], [[], false], [['--no-input', '--json'], true], [['--planner-model', 'a/b', '--no-input'], false]];
  for (const [args, json] of invocations) {
    const started = Date.now();
    const result = setup(s, args, { timeout: 20000, input: 'ignored typed answers\n' });
    assert.ok(Date.now() - started < 20000);
    assert.equal(result.status, 1, `${args.join(' ')}: ${result.stderr}`);
    const expected = args.includes('--planner-model') ? allFlags.slice(1) : allFlags;
    if (json) {
      const document = jsonDocument(result);
      assert.equal(document.error.code, 'missing-input');
      assert.deepEqual(document.error.missing, expected);
      assert.deepEqual(document.targets.coordinator.outcome, 'not-written');
    } else {
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /\(missing-input\)/);
      for (const flag of expected) assert.ok(result.stderr.includes(flag), `${flag} in ${result.stderr}`);
      if (args.includes('--planner-model')) assert.ok(!/needs:[^.]*--planner-model/.test(result.stderr));
      assert.match(result.stderr, /heimdall setup --help/);
    }
    assert.deepEqual(await tree(s.root), before);
  }
  await assertNoNetworkAttempts(s);
});

test('an open, never-written stdin does not make a headless run wait', async t => {
  const s = await sandbox(t);
  const child = spawn(process.execPath, ['--import', s.preload, cli, 'setup'], { cwd: s.project, env: s.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const outcome = await new Promise(resolve => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('hung'); }, 20000);
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  child.stdin.destroy();
  assert.notEqual(outcome, 'hung', 'the headless run waited for input');
  assert.equal(outcome.code, 1);
  assert.match(stderr, /missing-input/);
  assert.deepEqual(await tree(s.root), BASELINE);
  await assertNoNetworkAttempts(s);
});

test('argument errors are reported without echoing values, in JSON as one document, and write nothing', async t => {
  const s = await sandbox(t);
  const cases = [
    [['--bogus'], /Unknown flag --bogus/],
    [['--bogus=value-1234'], /Unknown flag --bogus/],
    [['--planner-model', 'a/b', '--planner-model', 'c/d'], /Repeated flag --planner-model/],
    [['--json', '--json'], /Repeated flag --json/],
    [['--planner-model'], /--planner-model requires a value/],
    [['--planner-model', '--executor-model', 'a/b'], /--planner-model requires a value/],
    [['--no-input=1'], /--no-input does not take a value/],
    [['positional-value'], /Unexpected argument/],
    [['--global-concurrency', 'many'], /--global-concurrency must be a positive whole number/],
    [['--password', SENTINEL], /Credentials are never accepted as flags --password/],
    [[`--token=${TOKEN_SENTINEL}`], /Credentials are never accepted as flags --token/],
    [['--opencode-password', SENTINEL], /Credentials are never accepted as flags --opencode-password/],
    [['--api-key', SENTINEL], /Credentials are never accepted as flags --api-key/],
  ];
  const before = await tree(s.root);
  for (const [args, pattern] of cases) {
    if (args.includes('--json')) {
      const document = jsonDocument(setup(s, args));
      assert.match(document.error.message, pattern);
      continue;
    }
    const human = setup(s, args);
    assert.equal(human.status, 1, args.join(' '));
    assert.equal(human.stdout, '');
    assert.match(human.stderr, pattern);
    for (const value of ['value-1234', 'positional-value', SENTINEL, TOKEN_SENTINEL]) assert.ok(!human.stderr.includes(value), `${value} echoed`);
    const json = jsonDocument(setup(s, [...args, '--json']));
    assert.equal(json.error.code, 'invalid-input');
    assert.match(json.error.message, pattern);
    assert.deepEqual(await tree(s.root), before);
  }
  await assertNoNetworkAttempts(s);
});

test('invalid values, conflicts and incomplete configuration return structured errors without changing files', async t => {
  const s = await sandbox(t);
  const created = setup(s, [...complete, '--state-directory', path.join(s.root, 'state'), '--json']);
  assert.equal(jsonDocument(created).ok, true);
  const files = [await read(s.coordinatorFile), await read(s.projectFile)];
  const before = await tree(s.root);
  const conflict = jsonDocument(setup(s, ['--planner-model', 'anthropic/other-planner', '--json']));
  assert.equal(conflict.error.code, 'conflict');
  assert.match(conflict.error.message, /workflow\.plannerModel/);
  assert.equal(conflict.targets.project.outcome, 'not-written');
  const conflictHuman = setup(s, ['--global-concurrency', '5']);
  assert.equal(conflictHuman.status, 1);
  assert.match(conflictHuman.stderr, /\(conflict\).*coordinator\.globalConcurrency/);
  const invalid = jsonDocument(setup(s, ['--planner-model', 'not a model', '--json']));
  assert.equal(invalid.error.code, 'invalid-input');
  const placeholder = jsonDocument(setup(s, ['--planner-model', 'anthropic/your-planner-model', '--json']));
  assert.equal(placeholder.error.code, 'invalid-input');
  const identical = jsonDocument(setup(s, [...complete, '--coordinator-config', s.projectFile, '--json']));
  assert.equal(identical.error.code, 'identical-destinations');
  assert.deepEqual([await read(s.coordinatorFile), await read(s.projectFile)], files);
  assert.deepEqual(await tree(s.root), before);

  // The shipped template parses but is incomplete: the endpoint and models are undecided.
  const template = path.join(s.root, 'template.toml');
  await fs.copyFile(path.join(repository, 'examples', 'heimdall.toml'), template);
  const incomplete = jsonDocument(setup(s, ['--config', template, '--json']));
  assert.equal(incomplete.error.code, 'incomplete-configuration');
  assert.ok(incomplete.error.missing.includes('opencode.baseUrl'));
  assert.ok(incomplete.error.missing.includes('workflow.plannerModel'));
  assert.equal(incomplete.targets.project.path, template);
  assert.equal(incomplete.targets.project.outcome, 'not-written');
  const incompleteHuman = setup(s, ['--config', template]);
  assert.equal(incompleteHuman.status, 1);
  assert.match(incompleteHuman.stderr, /incomplete-configuration/);
  assert.equal(await read(template), await read(path.join(repository, 'examples', 'heimdall.toml')));
  await assertNoNetworkAttempts(s);
});

/**
 * A HOME whose default state directory yields a coordinator socket path above the portable 100-byte limit, with
 * a short, explicitly selected state directory. `existing` pre-creates the coordinator and project files.
 */
async function longHomeSandbox(t, { existing }) {
  const s = await sandbox(t);
  const home = path.join(s.root, 'h'.repeat(90));
  const state = path.join(s.root, 'state');
  await fs.mkdir(home);
  const coordinatorFile = path.join(home, '.config', 'heimdall', 'coordinator.toml');
  assert.ok(Buffer.byteLength(path.join(home, '.local', 'state', 'heimdall', 'coordinator.sock')) > 100, 'the default socket path must exceed the limit');
  const env = { HOME: home };
  if (existing) {
    await fs.mkdir(path.dirname(coordinatorFile), { recursive: true });
    await fs.writeFile(coordinatorFile, `[coordinator]\nstateDirectory = ${JSON.stringify(state)}\nglobalConcurrency = 2\n`, { mode: 0o600 });
    await fs.writeFile(s.projectFile, ['[workflow]', 'plannerModel = "anthropic/planner-x"', '', '[[workflow.executorCandidates]]', 'key = "primary"', 'quotaProvider = "openai"', 'model = "openai/executor-x"', '', '[opencode]', 'baseUrl = "http://127.0.0.1:4096"', 'authentication = "basic"', ''].join('\n'), { mode: 0o600 });
  }
  return { ...s, home, state, env, coordinatorFile };
}

const fileState = async file => ({ bytes: await fs.readFile(file), mtimeMs: (await fs.stat(file)).mtimeMs });

test('an existing coordinator file with a short state directory is reused under a HOME whose default socket path is too long', async t => {
  const s = await longHomeSandbox(t, { existing: true });
  const before = { tree: await tree(s.root), coordinator: await fileState(s.coordinatorFile), project: await fileState(s.projectFile) };
  const unchanged = async () => {
    assert.deepEqual(await tree(s.root), before.tree);
    assert.deepEqual(await fileState(s.coordinatorFile), before.coordinator);
    assert.deepEqual(await fileState(s.projectFile), before.project);
  };

  const reused = jsonDocument(setup(s, ['--no-input', '--json'], { env: s.env }));
  assert.equal(reused.ok, true, JSON.stringify(reused.error));
  assert.deepEqual(reused.targets, { coordinator: { path: s.coordinatorFile, outcome: 'reused' }, project: { path: s.projectFile, outcome: 'reused' } });
  assert.deepEqual(reused.createdDirectories, []);
  await unchanged();

  // Equivalent spellings of the existing state directory (and of its concurrency) are not conflicts.
  const configDirectory = path.dirname(s.coordinatorFile);
  const spellings = [s.state, path.relative(configDirectory, s.state), `${s.state}/.`, `${s.state}/sub/..`];
  for (const spelling of spellings) {
    const same = jsonDocument(setup(s, ['--no-input', '--json', '--state-directory', spelling, '--global-concurrency', '2', '--project-concurrency', '1'], { env: s.env }));
    assert.equal(same.ok, true, `${spelling}: ${JSON.stringify(same.error)}`);
    assert.deepEqual([same.targets.coordinator.outcome, same.targets.project.outcome], ['reused', 'reused']);
    await unchanged();
  }

  // Conflicting values still fail before any write.
  for (const [flags, key] of [
    [['--state-directory', path.join(s.root, 'other-state')], 'coordinator.stateDirectory'],
    [['--global-concurrency', '3'], 'coordinator.globalConcurrency'],
    [['--project-concurrency', '4'], 'coordinator.projectConcurrency'],
  ]) {
    const conflict = jsonDocument(setup(s, ['--no-input', '--json', ...flags], { env: s.env }));
    assert.equal(conflict.error.code, 'conflict', JSON.stringify(conflict.error));
    assert.ok(conflict.error.message.includes(key), conflict.error.message);
    assert.deepEqual([conflict.targets.coordinator.outcome, conflict.targets.project.outcome], ['not-written', 'not-written']);
    await unchanged();
  }

  // A supplied value must still pass the loader rules: a state directory that is too long is invalid even though reuse is possible.
  const tooLong = jsonDocument(setup(s, ['--no-input', '--json', '--state-directory', path.join(s.root, 's'.repeat(100))], { env: s.env }));
  assert.equal(tooLong.error.code, 'invalid-input', JSON.stringify(tooLong.error));
  assert.match(tooLong.error.message, /too long/);
  const invalidConcurrency = jsonDocument(setup(s, ['--no-input', '--json', '--global-concurrency', '0'], { env: s.env }));
  assert.equal(invalidConcurrency.error.code, 'invalid-input', JSON.stringify(invalidConcurrency.error));
  await unchanged();
  await assertNoNetworkAttempts(s);
});

test('a new coordinator file needs a usable state directory when the default socket path is too long', async t => {
  const s = await longHomeSandbox(t, { existing: false });
  const before = await tree(s.root);
  const args = ['--no-input', '--json', ...complete];

  const rejected = jsonDocument(setup(s, args, { env: s.env }));
  assert.equal(rejected.error.code, 'invalid-input', JSON.stringify(rejected.error));
  assert.match(rejected.error.message, /too long/);
  assert.match(rejected.error.message, /--state-directory/);
  assert.deepEqual([rejected.targets.coordinator.outcome, rejected.targets.project.outcome], ['not-written', 'not-written']);
  assert.deepEqual(await tree(s.root), before, 'nothing may be created');
  assert.equal(await exists(s.coordinatorFile), false);
  assert.equal(await exists(s.projectFile), false);

  const created = jsonDocument(setup(s, [...args, '--state-directory', s.state], { env: s.env }));
  assert.equal(created.ok, true, JSON.stringify(created.error));
  assert.deepEqual([created.targets.coordinator.outcome, created.targets.project.outcome], ['created', 'created']);
  assert.match(await read(s.coordinatorFile), /stateDirectory/);
  const coordinator = await loadCoordinatorConfiguration(s.coordinatorFile);
  assert.equal(coordinator.stateDirectory, s.state);
  await assertNoNetworkAttempts(s);
});

test('a failure after the first file was published reports a partial outcome and a rerun finishes it', { skip: process.getuid?.() === 0 ? 'permissions do not restrict root' : false }, async t => {
  const s = await sandbox(t);
  await fs.chmod(s.project, 0o555);
  let document;
  let human;
  try {
    human = setup(s, [...complete]);
    // Start over from a clean home so the JSON run also publishes the coordinator file first.
    await fs.rm(path.join(s.home, '.config'), { recursive: true });
    document = jsonDocument(setup(s, [...complete, '--json']));
  } finally { await fs.chmod(s.project, 0o700); }
  assert.equal(document.ok, false);
  assert.equal(document.error.code, 'write-failed');
  assert.deepEqual(document.targets.project.outcome, 'failed');
  assert.deepEqual(document.partial, { created: [s.coordinatorFile], incomplete: [s.projectFile] });
  assert.equal(document.verification.level, 'none');
  assert.equal(await exists(s.projectFile), false);
  assert.equal(human.status, 1);
  assert.equal(human.stdout, '');
  assert.match(human.stderr, /Partial outcome: created .*coordinator\.toml; incomplete .*\.heimdall\.toml/);
  assert.deepEqual((await fs.readdir(s.project)).filter(name => name !== '.git'), [], 'no truncated final or temporary file remains');
  const coordinatorText = await read(s.coordinatorFile);
  const rerun = jsonDocument(setup(s, [...complete, '--json']));
  assert.equal(rerun.ok, true);
  assert.equal(rerun.targets.coordinator.outcome, 'reused');
  assert.equal(rerun.targets.project.outcome, 'created');
  assert.equal(await read(s.coordinatorFile), coordinatorText);
  await loadConfiguration({ projectDirectory: s.project, configPath: s.projectFile });
  await assertNoNetworkAttempts(s);
});

test('credentials in the environment, OpenChamber settings, URLs and paths never reach stdout or stderr', async t => {
  const s = await sandbox(t);
  const before = await tree(s.root);
  const attempts = [
    // a pasted credential given as the variable name
    [...complete, '--password-env', SENTINEL],
    // user information in the endpoint
    ['--planner-model', 'a/b', '--executor-model', 'c/d', '--quota-provider', 'openai', '--opencode-url', `http://user:${SENTINEL}@127.0.0.1:4096`, '--opencode-auth', 'basic'],
    // a message that names the selected path, which here equals the planted credential
    [...complete, '--project', path.join(s.root, SENTINEL)],
    // the configured variable name resolves to the sentinel in the environment
    [...complete.slice(0, -2), '--opencode-auth', 'none', '--password-env', 'OPENCODE_PASSWORD'],
    [...complete.slice(0, -2), '--opencode-auth', 'openchamber'],
  ];
  for (const args of attempts.slice(0, 4)) {
    for (const json of [false, true]) {
      const result = setup(s, json ? [...args, '--json'] : args);
      assert.equal(result.status, 1, args.join(' '));
      if (json) assert.equal(jsonDocument(result).ok, false);
      else assert.equal(result.stdout, '');
    }
  }
  const pathResult = jsonDocument(setup(s, [...attempts[2], '--json']));
  assert.equal(pathResult.error.code, 'no-git-project');
  assert.ok(pathResult.error.message.includes('[redacted]'));
  assert.deepEqual(await tree(s.root), before);
  // openchamber authentication stores no token and reads no OpenChamber settings
  const openchamber = jsonDocument(setup(s, [...attempts[4], '--json']));
  assert.equal(openchamber.ok, true);
  for (const file of [s.projectFile, s.coordinatorFile]) {
    const text = await read(file);
    assert.ok(!text.includes(SENTINEL) && !text.includes(TOKEN_SENTINEL));
  }
  assert.match(await read(s.projectFile), /authentication = "openchamber"/);
  await assertNoNetworkAttempts(s);
});

test('the network guard records attempts, and setup leaves no service artifacts', async t => {
  const s = await sandbox(t);
  const probe = spawnSync(process.execPath, ['--import', s.preload, '-e', "fetch('http://127.0.0.1:1').catch(() => {})"], { env: s.env, encoding: 'utf8', timeout: DEADLINE_MS });
  assert.equal(probe.status, 1);
  assert.match(await read(s.log), /fetch/);
  await fs.rm(s.log);
  const result = setup(s, [...complete, '--json']);
  assert.equal(jsonDocument(result).ok, true);
  await assertNoNetworkAttempts(s);
  assertNoServiceArtifacts(await tree(s.root));
  assert.equal(await exists(path.join(s.home, '.local')), false);
  assert.equal(await exists(path.join(s.project, '.heimdall')), false);
});

/** In-process mode selection with injected streams. */
function streams({ stdinTTY, stdoutTTY }) {
  const out = []; const err = [];
  return { out, err, stdin: { isTTY: stdinTTY }, stdout: { isTTY: stdoutTTY, write: text => out.push(text) }, stderr: { isTTY: false, write: text => err.push(text) } };
}

test('the prompt hook runs only in an interactive terminal without --no-input or --json', async t => {
  const s = await sandbox(t);
  const answers = Object.fromEntries([['plannerModel', 'anthropic/planner-x'], ['executorModel', 'openai/executor-x'], ['quotaProvider', 'openai'], ['opencodeUrl', 'http://127.0.0.1:4096'], ['opencodeAuth', 'basic']]);
  const run = async (args, io, prompt) => {
    const captured = streams(io);
    const status = await setupMain(args, { ...captured, prompt, environment: s.env, cwd: s.project, homeDirectory: s.home });
    return { status, ...captured };
  };
  let calls = 0;
  const hook = async ({ input }) => { calls += 1; return { ...input, ...answers }; };

  for (const [args, io] of [
    [['--no-input'], { stdinTTY: true, stdoutTTY: true }],
    [['--json'], { stdinTTY: true, stdoutTTY: true }],
    [[], { stdinTTY: false, stdoutTTY: true }],
    [[], { stdinTTY: true, stdoutTTY: false }],
  ]) {
    const result = await run(args, io, hook);
    assert.equal(result.status, 1);
    assert.equal(calls, 0, `${args.join(' ')} prompted`);
    assert.match(result.err.join('') + result.out.join(''), /missing-input/);
  }
  assert.deepEqual(await tree(s.root), BASELINE);

  // Without a hook an interactive terminal behaves like a headless run.
  const hookless = await run([], { stdinTTY: true, stdoutTTY: true }, undefined);
  assert.equal(hookless.status, 1);

  // Cancellation leaves nothing behind and exits nonzero.
  const cancelled = await run([], { stdinTTY: true, stdoutTTY: true }, async () => { calls += 1; return null; });
  assert.equal(cancelled.status, 1);
  assert.equal(calls, 1);
  assert.match(cancelled.err.join(''), /cancelled/);
  assert.deepEqual(await tree(s.root), BASELINE);

  const answered = await run([], { stdinTTY: true, stdoutTTY: true }, hook);
  assert.equal(answered.status, 0, answered.err.join(''));
  assert.equal(calls, 2);
  assert.match(answered.out.join(''), /setup complete/);
  await loadConfiguration({ projectDirectory: s.project, configPath: s.projectFile });
});
