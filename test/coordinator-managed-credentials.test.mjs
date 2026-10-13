import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createCoordinatorClient } from '../dist/coordinator/client.js';
import { loadCoordinatorConfiguration } from '../dist/coordinator/config.js';
import { readCoordinatorToken } from '../dist/coordinator/token.js';
import { nativeServiceNames } from '../dist/coordinator/native/types.js';
import { MANAGER_LABEL_VARIABLE } from '../dist/coordinator/launch-context.js';

// These tests drive the real chain `coordinatorMain(['serve', ...])` -> `startCoordinatorService` -> production
// `createManagedExecutor` -> `connect` in a child process whose inherited environment plays the service manager's.
// A local stand-in for OpenCode records what each connection sends; it answers every request with an HTTP error so
// that no run ever launches. The only coordinator input is the public command line, IPC and the project file.

const posix = process.platform !== 'win32';
const cliUrl = pathToFileURL(path.resolve('dist/coordinator/cli.js')).href;
const basic = value => 'Basic ' + Buffer.from('opencode:' + value).toString('base64');
const git = (directory, args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const AMBIENT = 'synthetic-ambient-value';
const AMBIENT_CUSTOM = 'synthetic-ambient-custom-value';
const FILE_VALUE = 'synthetic-file-value';
const OPAQUE = 'SYNTHETIC_OPAQUE_REFERENCE';

async function openCodeStandIn(t) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(500, { 'Content-Type': 'application/json' });
    response.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return { requests, port: server.address().port };
}

// A short root keeps the Unix socket path within the platform limit.
async function root(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hmc-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

const childScript = `import { coordinatorMain } from ${JSON.stringify(cliUrl)};
const before = JSON.stringify(process.env);
// The coordinator keeps its environment for its whole life: any later difference is reported, never repaired.
setInterval(() => process.stdout.write(JSON.stringify(process.env) === before ? 'ENV-UNCHANGED\\n' : 'ENV-MUTATED\\n'), 50).unref();
await coordinatorMain(['serve', '--coordinator-config', process.env.CONFIG, ...(process.env.ENV_FILE ? ['--env-file', process.env.ENV_FILE] : [])], { serviceOptions: { pollIntervalMs: 50 } });`;

/**
 * Starts a coordinator child. `managed` adds the manager label variable a native service definition carries;
 * `inherited` is the rest of the manager-provided environment (synthetic password values).
 */
async function scenario(t, { managed, inherited = {}, opencode = '', credentialFile }) {
  const temporary = await root(t);
  const standIn = await openCodeStandIn(t);
  const home = path.join(temporary, 'h');
  await fs.mkdir(home);
  const stateDirectory = path.join(temporary, 's');
  const config = path.join(temporary, 'c.toml');
  await fs.writeFile(config, `[coordinator]\nstateDirectory = ${JSON.stringify(stateDirectory)}\n`);
  const configuration = await loadCoordinatorConfiguration(config);
  const project = path.join(temporary, 'p');
  await fs.mkdir(project);
  git(project, ['init', '-b', 'main']);
  git(project, ['config', 'user.name', 'Fixture']);
  git(project, ['config', 'user.email', 'fixture@example.invalid']);
  await fs.writeFile(path.join(project, 'README.md'), 'base\n');
  git(project, ['add', 'README.md']); git(project, ['commit', '-m', 'fixture']);
  await fs.writeFile(path.join(project, '.heimdall.toml'), `[workflow]\nplannerModel = "anthropic/fixture"\nexecutorModel = "anthropic/fixture"\nexecutorFallbackModel = "openai/fixture"\n[opencode]\nbaseUrl = "http://127.0.0.1:${standIn.port}"\n${opencode}`);
  const label = nativeServiceNames(configuration.stateDirectory).launchdLabel;
  const env = {
    ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, 'c'), XDG_STATE_HOME: path.join(home, 'st'), HEIMDALL_COORDINATOR_CONFIG: '',
    CONFIG: config, ENV_FILE: credentialFile ?? '',
  };
  // Only the child's inherited environment carries the manager marker and the synthetic passwords.
  for (const name of [MANAGER_LABEL_VARIABLE, 'OPENCODE_PASSWORD', 'OPENCHAMBER_DATA_DIR', OPAQUE]) delete env[name];
  Object.assign(env, managed ? { [MANAGER_LABEL_VARIABLE]: label } : {}, inherited);
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', childScript], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', chunk => { output.stdout += chunk; });
  child.stderr.on('data', chunk => { output.stderr += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  for (let index = 0; index < 1500 && !/Coordinator listening/.test(output.stdout); index++) {
    if (child.exitCode !== null) assert.fail('coordinator exited: ' + output.stderr);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.match(output.stdout, /Coordinator listening/);
  const client = createCoordinatorClient(configuration.endpoint, await readCoordinatorToken(configuration.stateDirectory));
  return {
    ...standIn, client, project, output, label, child,
    /** Submits one run and waits until its launch attempt has settled. */
    async submit() {
      const registered = await client.request('POST', '/projects', { directory: project });
      const submitted = await client.request('POST', '/runs', { projectId: registered.id, feature: 'Synthetic feature.' });
      let run;
      for (let index = 0; index < 1500; index++) {
        run = await client.request('GET', '/runs/' + submitted.id);
        if (run.status === 'reconciliation-required') { await new Promise(resolve => setTimeout(resolve, 200)); return run; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.fail('launch did not settle: ' + run?.status);
    },
    /** A failed launch leaves its reservation held, so a graceful drain would wait; the process is ended instead. */
    async stop() {
      child.kill('SIGKILL');
      return { ...(await exited), ...output };
    },
  };
}

async function credentialFile(t, content) {
  const directory = await root(t);
  const file = path.join(directory, 'credentials.env');
  await fs.writeFile(file, content, { mode: 0o600 });
  return file;
}

const secrets = [AMBIENT, AMBIENT_CUSTOM, FILE_VALUE];
const noLeak = (...texts) => { for (const text of texts) for (const secret of secrets) assert.ok(!text.includes(secret), 'a credential value appeared in output'); };

for (const [name, reference, ambient] of [['default reference', 'OPENCODE_PASSWORD', AMBIENT], ['opaque custom reference', OPAQUE, AMBIENT_CUSTOM]]) {
  const opencode = reference === 'OPENCODE_PASSWORD' ? '' : `passwordEnvironmentVariable = "${OPAQUE}"\n`;
  const inherited = { OPENCODE_PASSWORD: AMBIENT, [OPAQUE]: AMBIENT_CUSTOM };

  test(`managed serve without a credential file never uses the inherited password (${name})`, { skip: !posix, timeout: 60000 }, async t => {
    const before = JSON.stringify(process.env);
    const f = await scenario(t, { managed: true, inherited, opencode });
    const run = await f.submit();
    assert.deepEqual(f.requests, [], 'no OpenCode request is made without an authentication source');
    assert.match(run.reason, /credential file/);
    const lifecycle = await f.client.request('GET', '/lifecycle');
    assert.equal(lifecycle.phase, 'running', 'coordinator IPC readiness is unaffected');
    assert.equal(lifecycle.mode, 'managed');
    const result = await f.stop();
    assert.match(result.stdout, /ENV-UNCHANGED/);
    assert.doesNotMatch(result.stdout, /ENV-MUTATED/);
    noLeak(result.stdout, result.stderr, JSON.stringify(run));
    assert.equal(JSON.stringify(process.env), before);
  });

  test(`managed serve with a file lacking the configured reference fails before any request (${name})`, { skip: !posix, timeout: 60000 }, async t => {
    const file = await credentialFile(t, 'SYNTHETIC_UNRELATED_PASSWORD=synthetic-unrelated-value\n');
    const f = await scenario(t, { managed: true, inherited, opencode, credentialFile: file });
    const run = await f.submit();
    assert.deepEqual(f.requests, [], 'a missing reference never falls back to the inherited value');
    assert.match(run.reason, /Set the configured OpenCode password environment variable/);
    assert.equal((await f.client.request('GET', '/lifecycle')).phase, 'running');
    const result = await f.stop();
    noLeak(result.stdout, result.stderr, JSON.stringify(run));
  });

  test(`managed serve with a credential file uses the file value despite a conflicting inherited value (${name})`, { skip: !posix, timeout: 60000 }, async t => {
    const file = await credentialFile(t, `${reference}=${FILE_VALUE}\n`);
    const f = await scenario(t, { managed: true, inherited, opencode, credentialFile: file });
    const run = await f.submit();
    assert.ok(f.requests.length > 0, 'the connection reached the stand-in');
    assert.ok(f.requests.every(request => request.authorization === basic(FILE_VALUE)), 'file value, never the inherited one');
    assert.match(run.reason, /HTTP 500/);
    const result = await f.stop();
    assert.match(result.stdout, /ENV-UNCHANGED/);
    assert.doesNotMatch(result.stdout, /ENV-MUTATED/);
    noLeak(result.stdout, result.stderr, JSON.stringify(run));
  });

  test(`foreground serve without a credential file still authenticates from the environment (${name})`, { skip: !posix, timeout: 60000 }, async t => {
    const f = await scenario(t, { managed: false, inherited, opencode });
    await f.submit();
    assert.ok(f.requests.length > 0);
    assert.ok(f.requests.every(request => request.authorization === basic(ambient)), 'the environment value of the configured reference');
    assert.equal((await f.client.request('GET', '/lifecycle')).mode, 'foreground');
    const result = await f.stop();
    assert.match(result.stdout, /ENV-UNCHANGED/);
    assert.doesNotMatch(result.stdout, /ENV-MUTATED/);
  });

  test(`foreground serve with a credential file stays file-exclusive (${name})`, { skip: !posix, timeout: 60000 }, async t => {
    const file = await credentialFile(t, `${reference}=${FILE_VALUE}\n`);
    const f = await scenario(t, { managed: false, inherited, opencode, credentialFile: file });
    await f.submit();
    assert.ok(f.requests.length > 0);
    assert.ok(f.requests.every(request => request.authorization === basic(FILE_VALUE)));
    await f.stop();
  });
}

test('managed passwordless mode sends no Authorization header', { skip: !posix, timeout: 60000 }, async t => {
  const f = await scenario(t, { managed: true, inherited: { OPENCODE_PASSWORD: AMBIENT }, opencode: 'authentication = "none"\n' });
  await f.submit();
  assert.ok(f.requests.length > 0);
  assert.ok(f.requests.every(request => request.authorization === undefined));
  const result = await f.stop();
  noLeak(result.stdout, result.stderr);
});

test('managed OpenChamber authentication still follows the OPENCHAMBER_DATA_DIR selection', { skip: !posix, timeout: 60000 }, async t => {
  const dataDirectory = await root(t);
  // The stand-in port is only known once the scenario listens, so the desktop settings are written afterwards;
  // they are read at connection time.
  const f = await scenario(t, {
    managed: true, inherited: { OPENCODE_PASSWORD: AMBIENT, OPENCHAMBER_DATA_DIR: dataDirectory },
    opencode: 'authentication = "openchamber"\n',
  });
  await fs.writeFile(path.join(dataDirectory, 'settings.json'), JSON.stringify({ desktopLocalPort: f.port, desktopLocalClientToken: 'synthetic-desktop-token' }));
  await f.submit();
  assert.ok(f.requests.length > 0);
  assert.ok(f.requests.every(request => request.authorization === 'Bearer synthetic-desktop-token'), 'the desktop token read through the nonsecret data directory selection');
  const result = await f.stop();
  noLeak(result.stdout, result.stderr);
});
