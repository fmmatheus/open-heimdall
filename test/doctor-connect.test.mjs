import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { doctorMain } from '../dist/doctor/index.js';
import { connect, defaultRequestTimeoutMilliseconds, supportedOpenCodeVersion } from '../dist/opencode/observer.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(repository, 'dist', 'cli.js');
const SENTINEL = 'sentinel-secret-4d81c0e7a5';
const TOKEN_SENTINEL = 'sentinel-token-92b7e1f3c6';
const WRONG_SENTINEL = 'sentinel-wrong-5c3a9e21b8';
const DEADLINE_MS = 30000;
const VALID_INFO = { version: supportedOpenCodeVersion, pid: 4242 };
const UNVERIFIED = ['protected-API authorization', 'model availability', 'provider login', 'quota'];

/** Fixture OpenCode: records every request and answers with the configured handler. */
async function fixtureServer(t, handler) {
  const log = [];
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    log.push({ method: request.method, pathname: url.pathname, authorization: request.headers.authorization, directory: request.headers['x-opencode-directory'], search: url.search });
    handler(request, response, url);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return { log, port: server.address().port, url: `http://127.0.0.1:${server.address().port}` };
}

const json = (response, status, body) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(typeof body === 'string' ? body : JSON.stringify(body)); };
const basic = password => 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
/** Serves the info document, requiring the given Authorization header (undefined: none must be sent). */
const info = (authorization, body = VALID_INFO) => (request, response) => {
  if (request.headers.authorization !== authorization) {
    // The body deliberately echoes credentials so any forwarding of response text would be caught.
    json(response, 401, { error: `unauthorized: ${request.headers.authorization ?? 'none'} ${SENTINEL} ${TOKEN_SENTINEL}` });
    return;
  }
  json(response, 200, body);
};

async function unusedPort() {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** Isolated HOME, a committed Git project, a project configuration for `url` and an OpenChamber data directory. */
async function sandbox(t, { url, authentication = 'basic', openchamber, baseUrl = true } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(await fs.access('/tmp').then(() => '/tmp', () => os.tmpdir()), 'hc-')));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  const data = path.join(root, 'openchamber');
  await Promise.all([home, project, data].map(directory => fs.mkdir(directory, { recursive: true, mode: 0o700 })));
  await Promise.all([root, home, project, data].map(directory => fs.chmod(directory, 0o700)));
  if (openchamber) await fs.writeFile(path.join(data, 'settings.json'), JSON.stringify(openchamber));
  const lines = [
    '[workflow]', 'plannerModel = "anthropic/planner-x"', '',
    '[[workflow.executorCandidates]]', 'key = "primary"', 'quotaProvider = "openai"', 'model = "openai/executor-x"', '',
    '[opencode]', ...(baseUrl ? [`baseUrl = "${url}"`] : []), `authentication = "${authentication}"`, '',
  ];
  await fs.writeFile(path.join(project, '.heimdall.toml'), lines.join('\n'), { mode: 0o600 });
  const gitEnvironment = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: project, env: gitEnvironment, stdio: 'pipe' });
  git('init', '--quiet');
  git('commit', '--quiet', '--allow-empty', '-m', 'initial');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR ?? '/tmp', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', OPENCHAMBER_DATA_DIR: data, OPENCODE_PASSWORD: SENTINEL };
  return { root, home, project, data, env };
}

function assertNoSecrets(...outputs) {
  for (const output of outputs) {
    for (const secret of [SENTINEL, TOKEN_SENTINEL, WRONG_SENTINEL, Buffer.from('opencode:' + SENTINEL).toString('base64'), Buffer.from('opencode:' + WRONG_SENTINEL).toString('base64')]) {
      assert.ok(!output.includes(secret), `a credential appeared in output: ${output.slice(0, 400)}`);
    }
    assert.doesNotMatch(output, /Authorization\s*:|Bearer\s+\S/i);
  }
}

/** Asynchronous spawn: the fixture server shares this process, so its event loop must stay free. */
function execute(s, args, { env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'doctor', ...args], { cwd: s.project, env: { ...s.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('doctor did not finish')); }, DEADLINE_MS);
    child.on('error', reject);
    child.on('close', (status, signal) => { clearTimeout(timer); resolve({ status, signal, stdout, stderr }); });
  });
}

/** Runs human and JSON modes; every output is checked for secrets and the two modes must agree. */
async function doctor(s, args = ['--connect'], options) {
  const human = await execute(s, args, options);
  const machine = await execute(s, [...args, '--json'], options);
  for (const result of [human, machine]) { assert.equal(result.signal, null); assertNoSecrets(result.stdout, result.stderr); }
  const document = JSON.parse(machine.stdout);
  assert.equal(machine.stdout, JSON.stringify(document, null, 2) + '\n');
  assert.equal(machine.stderr, '');
  assert.equal(human.status, machine.status);
  assert.equal(machine.status, document.ok ? 0 : 1);
  return { human, machine, document, connection: document.checks.find(check => check.id === 'connection') };
}

/** The probe asked for the info document and nothing else. */
function assertOnlyInfo(log, count) {
  assert.deepEqual([...new Set(log.map(entry => `${entry.method} ${entry.pathname}`))].filter(Boolean), count === 0 ? [] : ['GET /api/info']);
  assert.equal(log.length, count);
}

/** A connection-only failure: the local checks passed. `localFailed` is for fixtures whose local checks fail as well. */
function assertFailed(result, pattern, { localFailed = false } = {}) {
  const { document, connection, human, machine } = result;
  if (localFailed) {
    assert.equal(machine.status, 1);
    assert.equal(human.status, 1);
    assert.equal(document.ok, false);
    assert.equal(connection.status, 'fail');
    assert.equal(document.verification.local, 'failed');
    assert.equal(document.verification.connection, 'failed');
    assert.match(connection.message, pattern);
    assert.match(human.stdout, /Local checks failed: \d+ required checks? failed\./);
    assert.match(human.stdout, /Connection verification: failed/);
    return;
  }
  assert.equal(machine.status, 1);
  assert.equal(human.status, 1);
  assert.equal(document.ok, false);
  assert.equal(connection.status, 'fail');
  assert.equal(connection.fatal, true);
  assert.equal(document.verification.connection, 'failed');
  assert.match(connection.message, pattern);
  // The local verdict covers the local checks only: a failed connection never turns it into a local failure.
  assert.equal(document.verification.local, 'passed');
  assert.deepEqual(document.checks.filter(check => check.fatal && check.status === 'fail').map(check => check.id), ['connection']);
  assert.match(human.stdout, /Local checks passed \(\d+ passed, \d+ warnings, \d+ skipped\)\./);
  assert.doesNotMatch(human.stdout, /Local checks failed/);
  assert.match(human.stdout, /Connection verification: failed/);
  assert.equal(human.stderr, 'Heimdall doctor: required check failed: connection\n');
  const localChecks = document.checks.filter(check => check.id !== 'connection');
  const localPassed = localChecks.filter(check => check.status === 'pass').length;
  assert.ok(human.stdout.includes(`Local checks passed (${localPassed} passed, `), human.stdout);
  for (const key of ['protectedApiAuthorization', 'modelAvailability', 'providerLogin', 'quota']) assert.equal(document.verification[key], 'unverified');
}

test('basic authentication with the environment password verifies GET /api/info only', async t => {
  const server = await fixtureServer(t, info(basic(SENTINEL)));
  const s = await sandbox(t, { url: server.url });
  const result = await doctor(s);
  const { document, connection, human } = result;
  assert.equal(result.machine.status, 0, result.machine.stdout);
  assert.equal(document.ok, true);
  assert.equal(document.verification.connection, 'verified');
  assert.equal(document.verification.local, 'passed');
  assert.equal(result.human.status, 0);
  assert.equal(human.stderr, '');
  assert.match(human.stdout, /Local checks passed/);
  assert.equal(connection.status, 'pass');
  assert.equal(connection.fatal, true);
  assert.match(connection.message, /GET \/api\/info/);
  assert.match(connection.message, /authentication mode basic/);
  assert.match(connection.message, new RegExp(`OpenCode ${supportedOpenCodeVersion.replaceAll('.', '\\.')} \\(pid 4242\\)`));
  // Success never claims readiness: the unverified items stay listed.
  assert.match(human.stdout, /Connection verification: verified/);
  assert.match(human.stdout, /Unverified: protected-API authorization, model availability, provider login and quota\./);
  for (const item of UNVERIFIED) assert.ok(connection.message.includes(item), item);
  assert.deepEqual(Object.fromEntries(Object.entries(document.verification).filter(([key]) => key !== 'local' && key !== 'connection')), {
    protectedApiAuthorization: 'unverified', modelAvailability: 'unverified', providerLogin: 'unverified', quota: 'unverified',
  });
  assert.doesNotMatch(human.stdout, /ready to run/i);
  // Two runs (human and JSON), one request each, exactly the info route with the project directory.
  assertOnlyInfo(server.log, 2);
  for (const entry of server.log) {
    assert.equal(entry.authorization, basic(SENTINEL));
    assert.equal(entry.directory, encodeURIComponent(s.project));
    assert.equal(new URLSearchParams(entry.search).get('location[directory]'), s.project);
  }
});

test('a custom password variable selects the credential', async t => {
  const server = await fixtureServer(t, info(basic(SENTINEL)));
  const s = await sandbox(t, { url: server.url });
  const file = path.join(s.project, '.heimdall.toml');
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('authentication = "basic"', 'authentication = "basic"\npasswordEnvironmentVariable = "CUSTOM_OPENCODE_SECRET"'));
  delete s.env.OPENCODE_PASSWORD;
  const { document } = await doctor(s, ['--connect'], { env: { CUSTOM_OPENCODE_SECRET: SENTINEL } });
  assert.equal(document.verification.connection, 'verified');
  assertOnlyInfo(server.log, 2);
});

test('basic authentication without the environment password fails before any request', async t => {
  const server = await fixtureServer(t, info(basic(SENTINEL)));
  const s = await sandbox(t, { url: server.url });
  delete s.env.OPENCODE_PASSWORD;
  assertFailed(await doctor(s), /Set the configured OpenCode password environment variable/);
  assertOnlyInfo(server.log, 0);
});

test('basic authentication with a wrong password fails on the 401 without leaking either credential', async t => {
  const server = await fixtureServer(t, info(basic(SENTINEL)));
  const s = await sandbox(t, { url: server.url });
  s.env.OPENCODE_PASSWORD = WRONG_SENTINEL;
  const result = await doctor(s);
  assertFailed(result, /HTTP 401/);
  assertOnlyInfo(server.log, 2);
  assert.ok(server.log.every(entry => entry.authorization === basic(WRONG_SENTINEL)));
});

test('authentication none sends no Authorization header and verifies', async t => {
  const server = await fixtureServer(t, info(undefined));
  const s = await sandbox(t, { url: server.url, authentication: 'none' });
  const { document, connection } = await doctor(s);
  assert.equal(document.verification.connection, 'verified');
  assert.equal(connection.status, 'pass');
  assert.match(connection.message, /authentication mode none/);
  assertOnlyInfo(server.log, 2);
  assert.ok(server.log.every(entry => entry.authorization === undefined));
});

test('authentication none against a server that requires credentials fails', async t => {
  const server = await fixtureServer(t, info(basic(SENTINEL)));
  const s = await sandbox(t, { url: server.url, authentication: 'none' });
  assertFailed(await doctor(s), /HTTP 401/);
  assertOnlyInfo(server.log, 2);
});

test('OpenChamber authentication reads the isolated settings and sends the Desktop token', async t => {
  const server = await fixtureServer(t, info('Bearer ' + TOKEN_SENTINEL));
  const s = await sandbox(t, { url: server.url, authentication: 'openchamber', openchamber: { desktopLocalPort: new URL(server.url).port * 1, desktopLocalClientToken: TOKEN_SENTINEL } });
  // The Basic password in the environment must not be used for this mode.
  const { document, connection } = await doctor(s);
  assert.equal(document.verification.connection, 'verified');
  assert.match(connection.message, /authentication mode openchamber/);
  assertOnlyInfo(server.log, 2);
  assert.ok(server.log.every(entry => entry.authorization === 'Bearer ' + TOKEN_SENTINEL));
});

test('OpenChamber authentication fails for a wrong token', async t => {
  const server = await fixtureServer(t, info('Bearer ' + TOKEN_SENTINEL));
  const s = await sandbox(t, { url: server.url, authentication: 'openchamber', openchamber: { desktopLocalPort: new URL(server.url).port * 1, desktopLocalClientToken: WRONG_SENTINEL } });
  assertFailed(await doctor(s), /HTTP 401/);
  assertOnlyInfo(server.log, 2);
});

test('OpenChamber settings problems fail before any request', async t => {
  const server = await fixtureServer(t, info('Bearer ' + TOKEN_SENTINEL));
  const port = new URL(server.url).port * 1;
  const cases = [
    ['settings file missing', undefined, /OpenChamber Desktop settings unavailable/],
    ['port mismatch', { desktopLocalPort: port + 1, desktopLocalClientToken: TOKEN_SENTINEL }, /must match the Desktop local port/],
    ['token missing', { desktopLocalPort: port }, /local client token is unavailable/],
    ['blank token', { desktopLocalPort: port, desktopLocalClientToken: '   ' }, /local client token is unavailable/],
    ['token with whitespace', { desktopLocalPort: port, desktopLocalClientToken: `${TOKEN_SENTINEL} x` }, /local client token is unavailable/],
    ['settings not an object', [TOKEN_SENTINEL], /Invalid OpenChamber Desktop connection settings/],
  ];
  for (const [name, settings, pattern] of cases) {
    const s = await sandbox(t, { url: server.url, authentication: 'openchamber', openchamber: settings });
    assertFailed(await doctor(s), pattern);
    assertOnlyInfo(server.log, 0);
    assert.ok(name);
  }
});

test('malformed OpenChamber settings fail without echoing their content', async t => {
  const server = await fixtureServer(t, info('Bearer ' + TOKEN_SENTINEL));
  const s = await sandbox(t, { url: server.url, authentication: 'openchamber' });
  await fs.writeFile(path.join(s.data, 'settings.json'), `{ "desktopLocalClientToken": "${TOKEN_SENTINEL}", `);
  assertFailed(await doctor(s), /OpenChamber Desktop settings unavailable/);
  assertOnlyInfo(server.log, 0);
});

test('an unavailable host fails the connection check', async t => {
  const port = await unusedPort();
  const s = await sandbox(t, { url: `http://127.0.0.1:${port}` });
  assertFailed(await doctor(s), /unreachable or timed out/);
});

test('an unresponsive server fails at the overall timeout', async t => {
  const server = await fixtureServer(t, () => undefined);
  const s = await sandbox(t, { url: server.url });
  const started = Date.now();
  const out = [];
  const err = [];
  const code = await doctorMain(['--connect', '--json'], {
    environment: { ...s.env }, cwd: s.project, homeDirectory: s.home,
    connection: { timeoutMilliseconds: 250 },
    stdout: { write: text => out.push(text) }, stderr: { write: text => err.push(text) },
  });
  assert.ok(Date.now() - started < 10000, 'the injected timeout did not apply');
  assert.equal(code, 1);
  const document = JSON.parse(out.join(''));
  assertNoSecrets(out.join(''), err.join(''));
  assert.equal(document.ok, false);
  assert.equal(document.verification.connection, 'failed');
  const connection = document.checks.find(check => check.id === 'connection');
  assert.equal(connection.status, 'fail');
  assert.equal(connection.fatal, true);
  assert.match(connection.message, /unreachable or timed out/);
  assertOnlyInfo(server.log, 1);
});

test('the default probe timeout stays 10000 ms', async () => {
  assert.equal(defaultRequestTimeoutMilliseconds, 10000);
  const requested = [];
  const original = AbortSignal.timeout;
  AbortSignal.timeout = milliseconds => { requested.push(milliseconds); return original.call(AbortSignal, milliseconds); };
  try {
    const api = await connect('/tmp', undefined, {
      baseUrl: 'http://127.0.0.1:4096', authentication: 'none', environment: {},
      fetchImpl: async () => new Response(JSON.stringify(VALID_INFO), { status: 200 }),
    });
    assert.equal(api.version, supportedOpenCodeVersion);
  } finally { AbortSignal.timeout = original; }
  assert.deepEqual(requested, [10000]);
});

test('a redirect is a connection failure and is never followed', async t => {
  for (const status of [301, 302, 307, 308]) {
    const server = await fixtureServer(t, (request, response) => {
      if (request.url.startsWith('/api/info')) { response.writeHead(status, { location: `/api/session/ses_1?token=${TOKEN_SENTINEL}` }); response.end(); return; }
      json(response, 200, VALID_INFO);
    });
    const s = await sandbox(t, { url: server.url });
    assertFailed(await doctor(s), /unreachable or timed out/);
    assertOnlyInfo(server.log, 2);
  }
});

test('an invalid JSON response fails', async t => {
  const server = await fixtureServer(t, (request, response) => json(response, 200, `{ not json ${SENTINEL}`));
  const s = await sandbox(t, { url: server.url });
  assertFailed(await doctor(s), /Invalid OpenCode API JSON response/);
  assertOnlyInfo(server.log, 2);
});

test('an HTTP error status fails', async t => {
  const server = await fixtureServer(t, (request, response) => json(response, 500, { error: SENTINEL }));
  const s = await sandbox(t, { url: server.url });
  assertFailed(await doctor(s), /HTTP 500/);
  assertOnlyInfo(server.log, 2);
});

test('an invalid info document fails', async t => {
  const bodies = [
    ['pid zero', { version: supportedOpenCodeVersion, pid: 0 }],
    ['negative pid', { version: supportedOpenCodeVersion, pid: -3 }],
    ['fractional pid', { version: supportedOpenCodeVersion, pid: 1.5 }],
    ['string pid', { version: supportedOpenCodeVersion, pid: '4242' }],
    ['missing pid', { version: supportedOpenCodeVersion }],
    ['missing version', { pid: 4242 }],
    ['array', [VALID_INFO]],
    ['string', 'ok'],
    ['null', null],
  ];
  for (const [name, body] of bodies) {
    const server = await fixtureServer(t, (request, response) => json(response, 200, JSON.stringify(body)));
    const s = await sandbox(t, { url: server.url });
    assertFailed(await doctor(s), /does not match supported OpenCode 2\.0\.22/);
    assertOnlyInfo(server.log, 2);
    assert.ok(name);
  }
});

test('a wrong OpenCode version fails, with and without the data envelope', async t => {
  for (const body of [{ version: '2.0.21', pid: 4242 }, { version: '2.0.23', pid: 4242 }, { version: '3.0.0', pid: 4242 }, { data: { version: '2.0.21', pid: 4242 } }]) {
    const server = await fixtureServer(t, (request, response) => json(response, 200, body));
    const s = await sandbox(t, { url: server.url });
    assertFailed(await doctor(s), /does not match supported OpenCode 2\.0\.22/);
    assertOnlyInfo(server.log, 2);
  }
  // The documented data envelope with the supported version is accepted.
  const server = await fixtureServer(t, (request, response) => json(response, 200, { data: VALID_INFO }));
  const s = await sandbox(t, { url: server.url });
  assert.equal((await doctor(s)).document.verification.connection, 'verified');
});

test('a missing baseUrl fails the connection check as incomplete configuration', async t => {
  const s = await sandbox(t, { baseUrl: false });
  const result = await doctor(s);
  assertFailed(result, /opencode\.baseUrl is not configured.*incomplete/, { localFailed: true });
});

test('an unavailable project configuration fails the connection check without a request', async t => {
  const server = await fixtureServer(t, info(basic(SENTINEL)));
  const s = await sandbox(t, { url: server.url });
  await fs.rm(path.join(s.project, '.heimdall.toml'));
  const result = await doctor(s);
  assertFailed(result, /project configuration is unavailable/, { localFailed: true });
  assertOnlyInfo(server.log, 0);
});

test('a local failure with a verified connection reports local failed and connection verified', async t => {
  const server = await fixtureServer(t, info(basic(SENTINEL)));
  const s = await sandbox(t, { url: server.url });
  await fs.mkdir(path.join(s.home, '.config', 'heimdall'), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(s.home, '.config', 'heimdall', 'coordinator.toml'), '[coordinator\nstateDirectory = ', { mode: 0o600 });
  const { document, human, machine } = await doctor(s);
  assert.equal(machine.status, 1);
  assert.equal(document.ok, false);
  assert.equal(document.verification.local, 'failed');
  assert.equal(document.verification.connection, 'verified');
  assert.match(human.stdout, /Local checks failed/);
  assert.match(human.stdout, /Connection verification: verified/);
  assert.doesNotMatch(human.stderr, /connection/);
});

test('without --connect nothing is contacted and the connection stays unverified', async t => {
  const server = await fixtureServer(t, info(basic(SENTINEL)));
  const s = await sandbox(t, { url: server.url });
  const result = await doctor(s, []);
  assert.equal(result.machine.status, 0);
  assert.equal(result.document.ok, true);
  assert.equal(result.document.verification.connection, 'not-requested');
  assert.equal(result.connection.status, 'not-verified');
  assert.equal(result.connection.fatal, false);
  assert.match(result.human.stdout, /Connection verification: not requested/);
  assertOnlyInfo(server.log, 0);
  // An unreachable configured endpoint does not fail the offline report either.
  const closed = await sandbox(t, { url: `http://127.0.0.1:${await unusedPort()}` });
  const offline = await doctor(closed, []);
  assert.equal(offline.machine.status, 0);
  assert.equal(offline.connection.status, 'not-verified');
});

test('error causes carrying credentials are never printed', async t => {
  const s = await sandbox(t, { url: 'http://127.0.0.1:4096' });
  const failures = [
    () => { throw Object.assign(new Error(`connect failed ${SENTINEL}`, { cause: new Error(`Authorization: Basic ${Buffer.from('opencode:' + SENTINEL).toString('base64')} ${TOKEN_SENTINEL}`) }), { code: 'ECONNREFUSED' }); },
    () => Promise.reject(new AggregateError([new Error(SENTINEL), new Error(`Bearer ${TOKEN_SENTINEL}`)], `Bearer ${TOKEN_SENTINEL}`)),
  ];
  for (const fetchImpl of failures) {
    for (const args of [['--connect'], ['--connect', '--json']]) {
      const out = [];
      const err = [];
      const code = await doctorMain(args, {
        environment: { ...s.env }, cwd: s.project, homeDirectory: s.home,
        connection: { fetchImpl: async () => fetchImpl() },
        stdout: { write: text => out.push(text) }, stderr: { write: text => err.push(text) },
      });
      assert.equal(code, 1);
      assertNoSecrets(out.join(''), err.join(''));
      assert.match(out.join(''), /unreachable or timed out/);
    }
  }
});

test('an injected fetch that returns credentials in the body does not leak them', async t => {
  const s = await sandbox(t, { url: 'http://127.0.0.1:4096' });
  const out = [];
  const err = [];
  const code = await doctorMain(['--connect', '--json'], {
    environment: { ...s.env }, cwd: s.project, homeDirectory: s.home,
    connection: { fetchImpl: async () => new Response(`${SENTINEL} ${TOKEN_SENTINEL}`, { status: 200 }) },
    stdout: { write: text => out.push(text) }, stderr: { write: text => err.push(text) },
  });
  assert.equal(code, 1);
  assertNoSecrets(out.join(''), err.join(''));
});

test('doctor --connect rejects a credential flag without echoing it', async t => {
  const server = await fixtureServer(t, info(basic(SENTINEL)));
  const s = await sandbox(t, { url: server.url });
  const result = await execute(s, ['--connect', '--password', SENTINEL]);
  assert.equal(result.status, 1);
  assertNoSecrets(result.stdout, result.stderr);
  assertOnlyInfo(server.log, 0);
});
