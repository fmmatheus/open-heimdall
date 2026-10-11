import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfiguration } from '../dist/config.js';
import { loadCoordinatorConfiguration } from '../dist/coordinator/config.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repository, 'dist', 'cli.js');
const driver = path.join(repository, 'test', 'pty', 'driver.py');
const SENTINEL = 'sentinel-secret-9f3c1a7e42';
const RUN_DEADLINE_SECONDS = 40;

// The wizard needs a real terminal. The driver uses Python's pty module, which exists on macOS and Linux.
function ptyAvailability() {
  if (process.platform === 'win32') return 'pseudo-terminals are not available on Windows';
  const probe = spawnSync('python3', ['-I', '-c', 'import pty, select, os; assert hasattr(os, "waitstatus_to_exitcode")'], { encoding: 'utf8', timeout: 20000 });
  if (probe.error || probe.status !== 0) return `python3 with the pty module is unavailable (${probe.error?.message ?? probe.stderr.trim()})`;
  return null;
}
const unavailable = ptyAvailability();
const skip = unavailable === null ? false : `PTY tests skipped: ${unavailable}`;
if (unavailable !== null) console.error(`# ${skip}`);

/** Fails every network primitive and records the attempt. */
const PRELOAD = `
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import dns from 'node:dns';
const record = what => { fs.appendFileSync(process.env.NET_ATTEMPT_LOG, what + '\\n'); throw new Error('network blocked: ' + what); };
globalThis.fetch = () => record('fetch');
net.Socket.prototype.connect = () => record('net.Socket.connect');
net.connect = net.createConnection = () => record('net.connect');
net.Server.prototype.listen = () => record('net.Server.listen');
tls.connect = () => record('tls.connect');
http.request = http.get = () => record('http.request');
https.request = https.get = () => record('https.request');
dns.lookup = () => record('dns.lookup');
`;

async function sandbox(t) {
  // Short root: the default coordinator state directory must stay within the portable Unix socket limit.
  const root = await fs.realpath(await fs.mkdtemp(path.join(await fs.access('/tmp').then(() => '/tmp', () => os.tmpdir()), 'hw-')));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const tools = path.join(root, 'tools');
  await Promise.all([home, project, tools].map(directory => fs.mkdir(directory, { recursive: true })));
  const preload = path.join(tools, 'block-network.mjs');
  await fs.writeFile(preload, PRELOAD);
  const log = path.join(tools, 'network-attempts.log');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR ?? '/tmp', TERM: 'xterm', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    OPENCODE_PASSWORD: SENTINEL, NET_ATTEMPT_LOG: log,
  };
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: project, env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'pipe' });
  git('init', '--quiet');
  git('commit', '--quiet', '--allow-empty', '-m', 'initial');
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
      entries.push(path.relative(root, full) + (entry.isDirectory() ? '/' : ''));
      if (entry.isDirectory()) await walk(full);
    }
  };
  await walk(root);
  return entries.sort();
}
const read = file => fs.readFile(file, 'utf8');
const exists = file => fs.access(file).then(() => true, () => false);

/** Runs `heimdall setup` on a pseudo-terminal, answering the scripted prompts, within a finite deadline. */
function wizard(s, args, steps, { cwd = s.project, env = s.env } = {}) {
  const specification = {
    argv: [process.execPath, '--import', s.preload, cli, 'setup', ...args], cwd, env, steps, deadline: RUN_DEADLINE_SECONDS,
  };
  const started = Date.now();
  const run = spawnSync('python3', ['-I', driver, JSON.stringify(specification)], { encoding: 'utf8', timeout: (RUN_DEADLINE_SECONDS + 20) * 1000, killSignal: 'SIGKILL' });
  assert.equal(run.error, undefined, `terminal driver failed: ${run.error?.message}`);
  assert.equal(run.status, 0, `terminal driver exited ${run.status}: ${run.stderr}`);
  assert.ok(Date.now() - started < (RUN_DEADLINE_SECONDS + 20) * 1000);
  const result = JSON.parse(run.stdout);
  assert.equal(result.timedOut, false, `the wizard did not finish within ${RUN_DEADLINE_SECONDS}s:\n${result.output}`);
  assert.equal(result.failedStep, null, `step ${result.failedStep} never matched:\n${result.output}`);
  assert.ok(!result.output.includes(SENTINEL), 'the password sentinel appeared in the terminal output');
  return result;
}

function headless(s, args) {
  const result = spawnSync(process.execPath, ['--import', s.preload, cli, 'setup', ...args, '--no-input'], { cwd: s.project, env: s.env, encoding: 'utf8', input: '', timeout: 30000, killSignal: 'SIGKILL' });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

async function assertNoNetworkAttempts(s) {
  assert.equal(await exists(s.log), false, `network attempts: ${await exists(s.log) ? await read(s.log) : ''}`);
}

const prompt = text => ({ expect: `${text}$` });
const answer = (text, reply) => ({ ...prompt(text), send: `${reply}\r` });
const PLANNER = 'Planner model: ';
const EXECUTOR = 'Executor model: ';
const QUOTA = 'Quota provider \\(name or number\\): ';
const URL_PROMPT = 'OpenCode URL: ';
const AUTH = 'Authentication \\(name or number\\): ';
const PASSWORD_VARIABLE = 'Environment variable \\[OPENCODE_PASSWORD\\]: ';

/** Labels of the questions the wizard actually asked: explanations end with a period; a question line ends where the user types. */
const promptLabels = output => [...new Set(output.split('\n').map(line => /^(Planner model|Executor model|Quota provider \(name or number\)|OpenCode URL|Authentication \(name or number\)|Environment variable \[[A-Z_]+\]|Project directory): /.exec(line)?.[1]).filter(Boolean))].sort();

const FLAGS = ['--planner-model', 'anthropic/planner-x', '--executor-model', 'openai/executor-x', '--quota-provider', 'openai', '--opencode-url', 'http://127.0.0.1:4096'];

test('the wizard corrects invalid answers and writes the same files as equivalent flags', { skip }, async t => {
  const interactive = await sandbox(t);
  const result = wizard(interactive, [], [
    answer(PLANNER, 'planner-without-provider'),
    answer(PLANNER, 'anthropic/planner-x'),
    answer(EXECUTOR, 'openai/executor-x'),
    answer(QUOTA, 'unknown-provider'),
    answer(QUOTA, 'openai'),
    answer(URL_PROMPT, 'http://example.com:4096'),
    answer(URL_PROMPT, 'http://127.0.0.1:4096'),
    answer(AUTH, 'digest'),
    answer(AUTH, '1'),
    answer(PASSWORD_VARIABLE, ''),
  ]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /Invalid setup input/, 'an invalid answer must be explained');
  assert.match(result.output, /Choose one of: anthropic, claude-code, openai, kimi/);
  assert.match(result.output, /Heimdall setup complete/);
  assert.match(result.output, /configuration validated only/);
  assert.match(result.output, new RegExp(`Coordinator configuration: ${interactive.coordinatorFile.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(will be created\\)`), 'targets are shown first');
  assert.ok(result.output.indexOf('will be created') < result.output.indexOf(PLANNER.trim()), 'targets precede the first question');
  for (const description of ['anthropic - ', 'claude-code - ', 'openai - ', 'kimi - ', 'basic - ', 'none - ', 'openchamber - ']) assert.ok(result.output.includes(description), `missing description ${description}`);

  // Only the required decisions are asked; there is no credential prompt and no optional-setting prompt.
  assert.deepEqual(promptLabels(result.output), [
    'Authentication (name or number)', 'Environment variable [OPENCODE_PASSWORD]', 'Executor model', 'OpenCode URL', 'Planner model', 'Quota provider (name or number)',
  ]);
  assert.doesNotMatch(result.output, /state ?directory|concurrency|variant|fallback/i, 'optional settings must not be prompted');
  assert.doesNotMatch(result.output, /^(Password|Token|Secret)[^\n]*: ?\S*$/im, 'credentials must not be requested');

  const flagged = await sandbox(t);
  headless(flagged, [...FLAGS, '--opencode-auth', 'basic', '--password-env', 'OPENCODE_PASSWORD']);
  assert.equal(await read(interactive.projectFile), await read(flagged.projectFile), 'project configuration must equal the equivalent flags');
  assert.equal(await read(interactive.coordinatorFile), await read(flagged.coordinatorFile), 'coordinator configuration must equal the equivalent flags');
  assert.deepEqual(await tree(interactive.root), await tree(flagged.root));
  const configuration = await loadConfiguration({ projectDirectory: interactive.project });
  assert.equal(configuration.settings.plannerModel, 'anthropic/planner-x');
  assert.equal(configuration.settings.executorCandidates[0].model, 'openai/executor-x');
  assert.equal(configuration.settings.executorCandidates[0].quotaProvider, 'openai');
  assert.equal(configuration.opencode.baseUrl, 'http://127.0.0.1:4096');
  assert.equal(configuration.opencode.authentication, 'basic');
  assert.equal(configuration.opencode.passwordEnvironmentVariable, 'OPENCODE_PASSWORD');
  assert.equal((await loadCoordinatorConfiguration(interactive.coordinatorFile)).globalConcurrency, 1);
  assert.ok(!(await read(interactive.projectFile)).includes(SENTINEL));
  assert.deepEqual((await tree(interactive.root)).filter(entry => /\.sock|\.sqlite|\.db|runtime|snapshot|\.local|\.tmp$/.test(entry)), []);
  await assertNoNetworkAttempts(interactive);
});

test('the wizard asks only the decisions that flags leave open and no password variable without basic authentication', { skip }, async t => {
  const interactive = await sandbox(t);
  const result = wizard(interactive, FLAGS, [answer(AUTH, 'none')]);
  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.output, /Planner model: $|Executor model: $|OpenCode URL: $|Quota provider \(name/m, 'answered flags are not asked again');
  assert.doesNotMatch(result.output, /Environment variable/);
  const flagged = await sandbox(t);
  headless(flagged, [...FLAGS, '--opencode-auth', 'none']);
  assert.equal(await read(interactive.projectFile), await read(flagged.projectFile));
  assert.equal(await read(interactive.coordinatorFile), await read(flagged.coordinatorFile));
  assert.doesNotMatch(await read(interactive.projectFile), /passwordEnvironmentVariable/);
  await assertNoNetworkAttempts(interactive);
});

test('a project directory is asked only when the working directory is not a Git project', { skip }, async t => {
  const interactive = await sandbox(t);
  const notGit = path.join(interactive.root, 'elsewhere');
  await fs.mkdir(notGit);
  const result = wizard(interactive, [...FLAGS, '--opencode-auth', 'none'], [
    answer('Project directory: ', notGit),
    answer('Project directory: ', interactive.project),
  ], { cwd: notGit });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /is not inside a Git project/);
  assert.equal((await loadConfiguration({ projectDirectory: interactive.project })).opencode.authentication, 'none');
  assert.equal(await exists(path.join(notGit, '.heimdall.toml')), false);
  // An explicit --project that is not a Git project is never prompted for.
  const explicit = await sandbox(t);
  const missing = path.join(explicit.root, 'elsewhere');
  await fs.mkdir(missing);
  const refused = wizard(explicit, [...FLAGS, '--opencode-auth', 'none', '--project', missing], []);
  assert.equal(refused.status, 1);
  assert.doesNotMatch(refused.output, /Project directory: /);
  assert.match(refused.output, /not inside a Git project/);
});

for (const [name, key, label] of [['Ctrl-C', '\x03', 'interrupt'], ['end of input', '\x04', 'EOF']]) {
  test(`${name} in the middle of the wizard cancels without writing anything (${label})`, { skip }, async t => {
    const s = await sandbox(t);
    const before = await tree(s.root);
    const result = wizard(s, [], [
      answer(PLANNER, 'anthropic/planner-x'),
      answer(EXECUTOR, 'openai/executor-x'),
      { ...prompt(QUOTA), send: key },
    ]);
    assert.notEqual(result.status, 0, result.output);
    assert.equal(result.status, 1);
    assert.match(result.output, /Heimdall setup cancelled; no configuration was written\./);
    assert.doesNotMatch(result.output, /Heimdall setup complete/);
    assert.deepEqual(await tree(s.root), before, 'no file or directory may be created');
    assert.equal(await exists(s.projectFile), false);
    assert.equal(await exists(s.coordinatorFile), false);
    assert.equal(await exists(path.dirname(s.coordinatorFile)), false);
    await assertNoNetworkAttempts(s);
  });
}

test('an incomplete existing project configuration is never prompted for and explains how to choose another destination', { skip }, async t => {
  const s = await sandbox(t);
  const template = await fs.readFile(path.join(repository, 'examples', 'heimdall.toml'), 'utf8');
  await fs.writeFile(s.projectFile, template, { mode: 0o600 });
  const before = await tree(s.root);
  const result = wizard(s, [], []);
  assert.equal(result.status, 1, result.output);
  assert.doesNotMatch(result.output, /Planner model|Executor model|Quota provider|OpenCode URL|Authentication|Environment variable/, 'no prompt may appear');
  assert.match(result.output, /incomplete-configuration/);
  assert.match(result.output, /opencode\.baseUrl/);
  assert.match(result.output, /choose a new destination with --config/);
  assert.equal(await read(s.projectFile), template, 'the existing file is preserved');
  assert.deepEqual(await tree(s.root), before);
  assert.equal(await exists(s.coordinatorFile), false);
  await assertNoNetworkAttempts(s);
});

test('a complete existing configuration is reused without any prompt', { skip }, async t => {
  const s = await sandbox(t);
  headless(s, [...FLAGS, '--opencode-auth', 'none']);
  const project = await read(s.projectFile);
  const coordinator = await read(s.coordinatorFile);
  const result = wizard(s, [], []);
  assert.equal(result.status, 0, result.output);
  assert.doesNotMatch(result.output, /Planner model|Executor model|Quota provider \(name|OpenCode URL: |Authentication \(name/);
  assert.match(result.output, /found existing configuration; nothing was changed/);
  assert.equal(await read(s.projectFile), project);
  assert.equal(await read(s.coordinatorFile), coordinator);
});

// A synthetic credential held by a variable whose name no heuristic recognises. It also names a directory, so the
// target summary the wizard prints would reveal it. The scripted answers never contain the value, so the terminal
// output measured here is produced by the program alone.
const OPAQUE_VALUE = 'zq-opaque-3e6a90d4f1b7';

for (const [label, flags] of [['--password-env NAME', ['--password-env', 'OPAQUE']], ['--password-env=NAME', ['--password-env=OPAQUE']]]) {
  test(`the wizard's target summary and result redact the variable named by ${label}`, { skip }, async t => {
    const s = await sandbox(t);
    const target = path.join(s.project, OPAQUE_VALUE, 'project.toml');
    const result = wizard(s, [...FLAGS, '--config', target, ...flags], [answer(AUTH, 'basic')], { env: { ...s.env, OPAQUE: OPAQUE_VALUE } });
    assert.equal(result.status, 0, result.output);
    assert.ok(!result.output.includes(OPAQUE_VALUE), `the referenced credential appeared in the terminal output:\n${result.output}`);
    assert.ok(result.output.includes('[redacted]'));
    assert.match(result.output, /Heimdall setup complete/);
    // A path that carries no credential stays readable.
    assert.ok(result.output.includes(`Coordinator configuration: ${s.coordinatorFile} (will be created)`), result.output);
    assert.equal((await loadConfiguration({ projectDirectory: s.project, configPath: target })).opencode.passwordEnvironmentVariable, 'OPAQUE');
    await assertNoNetworkAttempts(s);
  });
}
