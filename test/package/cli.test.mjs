import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildTarball, installConsumer, installGlobal, isolatedEnvironment, removeTarballBuild, runBinary, runModule, toolVersions,
} from './helpers.mjs';

/*
 * `heimdall setup` and `heimdall doctor` run through the installed bin of an ordinary consumer install and an ordinary global
 * install. The project is a synthetic committed Git repository, HOME and configuration are isolated, and the only server
 * contacted is a loopback fixture that requires no credentials. The files setup writes are validated by the loaders of the
 * installed package, not by the checkout's build.
 */

const VERSION = '2.0.32';
const planner = 'anthropic/planner-x';
const executor = 'openai/executor-x';

// Short root: the default coordinator state directory must stay within the portable Unix socket path limit.
async function shortDirectory() {
  const base = await fs.access('/tmp').then(() => '/tmp', () => os.tmpdir());
  return await fs.realpath(await fs.mkdtemp(path.join(base, 'hp-')));
}

// An OpenCode stand-in that records every request and accepts any caller without credentials.
async function fixtureServer() {
  const log = [];
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    log.push({ method: request.method, pathname: new URL(request.url, 'http://127.0.0.1').pathname, authorization: request.headers.authorization });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ version: VERSION, pid: 4242 }));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    log,
    url: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

// A project directory with one empty commit, created with a Git environment that ignores the developer's configuration.
function syntheticProject(directory, home) {
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: directory, env, stdio: 'pipe' });
  git('init', '--quiet');
  git('commit', '--quiet', '--allow-empty', '-m', 'initial');
}

// Loads the written files with the installed package's own loaders.
const loaders = `
  import { pathToFileURL } from 'node:url';
  import path from 'node:path';
  const { root, project, coordinator } = JSON.parse(process.env.LOADER_PROBE);
  const dist = file => import(pathToFileURL(path.join(root, 'dist', file)).href);
  const { loadConfiguration } = await dist('config.js');
  const { loadCoordinatorConfiguration } = await dist('coordinator/config.js');
  const configuration = await loadConfiguration({ projectDirectory: project });
  const coordinatorConfiguration = await loadCoordinatorConfiguration(coordinator);
  process.stdout.write(JSON.stringify({
    plannerModel: configuration.settings.plannerModel,
    executorCandidates: configuration.settings.executorCandidates.map(candidate => candidate.model),
    baseUrl: configuration.opencode.baseUrl,
    authentication: configuration.opencode.authentication,
    globalConcurrency: coordinatorConfiguration.globalConcurrency,
  }));
`;

describe('installed heimdall setup and doctor', () => {
  let build;
  let work;
  let environment;
  let fixture;
  const installs = {};

  before(async () => {
    build = await buildTarball();
    work = await shortDirectory();
    environment = await isolatedEnvironment(work);
    fixture = await fixtureServer();
    installs.consumer = await installConsumer(build.tarball, { env: environment.env, directory: path.join(work, 'consumer') });
    const elsewhere = path.join(work, 'elsewhere');
    await fs.mkdir(elsewhere);
    installs.global = await installGlobal(build.tarball, { env: environment.env, prefix: path.join(work, 'global-prefix'), cwd: elsewhere });
  });

  after(async () => {
    await fixture?.close();
    if (work) await fs.rm(work, { recursive: true, force: true });
    await removeTarballBuild();
  });

  for (const layout of ['consumer', 'global']) {
    test(`${layout} install: coordinator run respond validates first, reports an older coordinator as unsupported and distinguishes uncertain delivery`, async t => {
      const install = installs[layout];
      const sandbox = path.join(work, `respond-${layout}`);
      const home = path.join(sandbox, 'home');
      const state = path.join(sandbox, 's');
      await fs.mkdir(home, { recursive: true, mode: 0o700 });
      await fs.mkdir(state, { recursive: true, mode: 0o700 });
      await fs.writeFile(path.join(state, 'coordinator.key'), 'd'.repeat(64), { mode: 0o600 });
      const configFile = path.join(sandbox, 'old.toml');
      await fs.writeFile(configFile, '[coordinator]\nstateDirectory = "s"\n');
      const env = { ...environment.env, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
      for (const name of ['HEIMDALL_CONFIG', 'HEIMDALL_COORDINATOR_CONFIG']) delete env[name];
      const options = { cwd: sandbox, env };
      const seen = [];
      let mode = 'unsupported';
      const server = http.createServer((request, response) => {
        request.resume();
        request.on('end', () => {
          seen.push(`${request.method} ${request.url}`);
          if (mode === 'drop') { request.socket.destroy(); return; }
          response.writeHead(404, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'Unknown coordinator route' }));
        });
      });
      await new Promise(resolve => server.listen(path.join(state, 'coordinator.sock'), resolve));
      t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });

      const help = await runBinary(install, ['coordinator', '--help'], options);
      assert.equal(help.status, 0);
      assert.match(help.stdout, /heimdall coordinator run respond RUN_ID --request REQUEST_ID --decision request-changes --input FEEDBACK/);
      assert.match(help.stdout, /heimdall coordinator run respond RUN_ID --pause PAUSE_ID --input GUIDANCE/);
      assert.ok(help.stdout.includes('heimdall coordinator run approval RUN_ID --request REQUEST_ID'), 'the installed help lists run approval');

      const invalid = await runBinary(install, ['coordinator', 'run', 'respond', 'run-1', '--request', 'apr_1', '--decision', 'approve', '--input', 'x', '--coordinator-config', configFile], options);
      assert.equal(invalid.status, 1);
      assert.equal(invalid.stdout, '');
      assert.match(invalid.stderr, /Approving takes no --input/);
      assert.deepEqual(seen, [], 'invalid arguments fail before any request');

      const unsupported = await runBinary(install, ['coordinator', 'run', 'respond', 'run-1', '--pause', 'pau_1', '--input=--use the other database', '--coordinator-config', configFile], options);
      assert.equal(unsupported.status, 1, unsupported.stderr);
      assert.equal(unsupported.stdout, '');
      assert.match(unsupported.stderr, /does not support this response operation/);
      assert.deepEqual(seen, ['POST /runs/run-1/respond'], 'one guarded request and no fallback to run resume');

      const unreadable = await runBinary(install, ['coordinator', 'run', 'approval', 'run-1', '--request', 'apr_1', '--coordinator-config', configFile], options);
      assert.equal(unreadable.status, 1, unreadable.stderr);
      assert.equal(unreadable.stdout, '');
      assert.match(unreadable.stderr, /does not support reading an approval request/);
      assert.deepEqual(seen.slice(1), ['GET /runs/run-1/approvals/apr_1'], 'one read and nothing else');

      mode = 'drop';
      const uncertain = await runBinary(install, ['coordinator', 'run', 'respond', 'run-1', '--request', 'apr_1', '--decision', 'approve', '--coordinator-config', configFile], options);
      assert.equal(uncertain.status, 2, uncertain.stderr);
      assert.match(uncertain.stderr, /may or may not have been recorded/);
      assert.match(uncertain.stderr, /heimdall coordinator run show run-1/);
      t.diagnostic(`${layout}: installed ${install.bin} run respond exit statuses 1, 1 and 2 as documented`);
    });
  }

  for (const layout of ['consumer', 'global']) {
    test(`${layout} install: setup --no-input --json, offline doctor and doctor --connect`, async t => {
      const install = installs[layout];
      t.diagnostic(`environment: ${await toolVersions(environment.env)}`);
      const sandbox = path.join(work, `run-${layout}`);
      const home = path.join(sandbox, 'home');
      const project = path.join(sandbox, 'project');
      const openchamber = path.join(sandbox, 'openchamber');
      await Promise.all([home, project, openchamber].map(directory => fs.mkdir(directory, { recursive: true, mode: 0o700 })));
      await Promise.all([sandbox, home, project, openchamber].map(directory => fs.chmod(directory, 0o700)));
      syntheticProject(project, home);
      const env = {
        ...environment.env,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, '.config'),
        XDG_STATE_HOME: path.join(home, '.local', 'state'),
        OPENCHAMBER_DATA_DIR: openchamber,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
      };
      // Unset, not empty: the defaults under HOME must apply.
      for (const name of ['HEIMDALL_CONFIG', 'HEIMDALL_COORDINATOR_CONFIG', 'OPENCODE_PASSWORD']) delete env[name];
      const options = { cwd: project, env };
      const requestsBefore = fixture.log.length;

      const setup = await runBinary(install, [
        'setup', '--no-input', '--json', '--project', project,
        '--planner-model', planner, '--executor-model', executor, '--quota-provider', 'openai',
        '--opencode-url', fixture.url, '--opencode-auth', 'none',
      ], options);
      assert.equal(setup.status, 0, `${setup.stdout}\n${setup.stderr}`);
      assert.equal(setup.stderr, '');
      const created = JSON.parse(setup.stdout);
      assert.equal(created.schemaVersion, 1);
      assert.equal(created.ok, true);
      assert.equal(created.error, null);
      const projectFile = path.join(project, '.heimdall.toml');
      const coordinatorFile = path.join(home, '.config', 'heimdall', 'coordinator.toml');
      for (const file of [projectFile, coordinatorFile]) assert.ok((await fs.stat(file)).isFile(), `${file} exists`);
      t.diagnostic(`${layout}: ${install.bin} setup wrote ${projectFile} and ${coordinatorFile}`);

      const loaded = await runModule(loaders, { cwd: sandbox, env: { ...env, LOADER_PROBE: JSON.stringify({ root: install.root, project, coordinator: coordinatorFile }) } });
      assert.equal(loaded.status, 0, loaded.stderr);
      assert.deepEqual(JSON.parse(loaded.stdout), {
        plannerModel: planner,
        executorCandidates: [executor],
        baseUrl: fixture.url,
        authentication: 'none',
        globalConcurrency: 1,
      });
      assert.equal(fixture.log.length, requestsBefore, 'setup must not contact the server');

      const offline = await runBinary(install, ['doctor', '--project', project, '--json'], options);
      assert.equal(offline.status, 0, `${offline.stdout}\n${offline.stderr}`);
      assert.equal(offline.stderr, '');
      const offlineReport = JSON.parse(offline.stdout);
      assert.equal(offlineReport.ok, true);
      assert.equal(offlineReport.error, null);
      assert.equal(offlineReport.verification.local, 'passed');
      assert.equal(offlineReport.verification.connection, 'not-requested');
      assert.deepEqual(offlineReport.checks.filter(check => check.fatal && check.status === 'fail'), []);
      for (const id of ['runtime.assets', 'runtime.identity', 'runtime.dependencies', 'runtime.quota-package', 'project.config']) {
        assert.equal(offlineReport.checks.find(check => check.id === id)?.status, 'pass', id);
      }
      assert.equal(fixture.log.length, requestsBefore, 'offline doctor must not contact the server');
      t.diagnostic(`${layout}: offline doctor checks ${offlineReport.checks.map(check => `${check.id}=${check.status}`).join(' ')}`);

      const connected = await runBinary(install, ['doctor', '--connect', '--project', project, '--json'], options);
      assert.equal(connected.status, 0, `${connected.stdout}\n${connected.stderr}`);
      assert.equal(connected.stderr, '');
      const connectedReport = JSON.parse(connected.stdout);
      assert.equal(connectedReport.ok, true);
      assert.equal(connectedReport.verification.connection, 'verified');
      assert.equal(connectedReport.checks.find(check => check.id === 'connection')?.status, 'pass');
      for (const key of ['protectedApiAuthorization', 'modelAvailability', 'providerLogin', 'quota']) assert.equal(connectedReport.verification[key], 'unverified');
      const requests = fixture.log.slice(requestsBefore);
      assert.deepEqual(requests.map(entry => `${entry.method} ${entry.pathname}`), ['GET /api/info']);
      assert.equal(requests[0].authorization, undefined, 'authentication none sends no credentials');
      t.diagnostic(`${layout}: doctor --connect verified GET /api/info against ${fixture.url}`);
    });
  }
});
