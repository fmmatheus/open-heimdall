import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createCoordinatorClient } from '../../dist/coordinator/client.js';
import { lifecycleCommandMain } from '../../dist/coordinator/lifecycle-cli.js';
import { resolveLaunchContext } from '../../dist/coordinator/launch-context.js';
import { COORDINATOR_LIFECYCLE_PROTOCOL } from '../../dist/coordinator/lifecycle.js';
import { selectNativeAdapter } from '../../dist/coordinator/native/platform.js';
import { nativeServiceNames } from '../../dist/coordinator/native/types.js';
import { probeCoordinatorOwnership } from '../../dist/coordinator/ownership.js';
import { parseCoordinatorStatus } from '../../dist/coordinator/status.js';
import { readCoordinatorToken } from '../../dist/coordinator/token.js';

/*
 * Native lifecycle integration suite. It drives the production `heimdall coordinator start|stop|logs` commands against
 * the real user service manager of the host (launchd on macOS, the systemd user manager on Linux).
 *
 * It runs only when HEIMDALL_NATIVE_LIFECYCLE=1 and the host provides a usable user manager (`npm run test:native`;
 * the provisioning checks live in .github/workflows/test.yml). Without the variable every test is reported as
 * skipped, which is not a pass. With it, a missing manager fails the suite instead of skipping it.
 *
 * Isolation. The coordinator state directory lives in a fresh temporary directory and HOME, XDG state/cache/data and
 * the OpenChamber data directory are private to the fixture. The production identity logic derives the launchd label
 * and systemd unit from the canonical state directory, so every run gets labels that exist nowhere else. The suite
 * refuses to proceed unless the derived names differ from those of the real default state directory and nothing is
 * registered under them. No project is registered, no OpenCode server is contacted and no agent runs. The credential
 * file holds a synthetic opaque value that is never used to authenticate anything.
 *
 * Cleanup removes only registrations and files proven stopped. A fixture that cannot be proven stopped is preserved
 * and the suite fails with "cleanup pending", naming the label and directory; nothing is killed or force-removed.
 *
 * What this suite establishes is native-manager behavior of the coordinator lifecycle with an empty state. The
 * delayed-drain behavior with a held run is established by coordinator tests with a synthetic executor
 * (test/coordinator-stop-logs.test.mjs) and the fake service manager there is adapter/CLI evidence only.
 *
 * The second suite, "native delayed drain", is protocol-fixture evidence: the real launchd runs the production
 * coordinator through test/fixtures/delayed-drain-entry.mjs, which injects a delay into the shutdown. It shows that
 * the production `stop --timeout` command ends within its deadline without a success while the real service keeps
 * draining, and that a later stop reports the clean stop. It does not involve a native run.
 */

const enabled = process.env.HEIMDALL_NATIVE_LIFECYCLE === '1';
const skip = enabled ? false : 'HEIMDALL_NATIVE_LIFECYCLE=1 is not set: native launchd/systemd lifecycle checks were not run';

const exec = promisify(execFile);
const checkout = fileURLToPath(new URL('../..', import.meta.url));
const cli = path.join(checkout, 'dist', 'cli.js');
const SENTINEL = 'hn-native-synthetic-credential-value';
const SECONDS = 1000;

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const exists = file => fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

async function waitFor(description, probe, { timeoutMs = 30 * SECONDS, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await probe();
    if (last) return last;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${description}`);
    await sleep(intervalMs);
  }
}

function run(file, args, { cwd, env, timeoutMs = 120 * SECONDS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  });
}

const processAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };

// One skipped test per case keeps the skip visible in the report; hooks do nothing unless the suite is enabled.
const native = (name, body) => test(name, { skip }, body);

describe('native coordinator lifecycle (launchd or systemd user manager)', () => {
  const fixture = {};
  let cleaned = false;

  const json = async (args, options) => {
    const result = await run(process.execPath, ['--no-warnings', cli, 'coordinator', ...args], { cwd: fixture.cwd, env: fixture.env, ...options });
    let document;
    try { document = JSON.parse(result.stdout); }
    catch { throw new Error(`Expected one JSON document from "${args.join(' ')}" (exit ${result.status}):\n${result.stdout}\n${result.stderr}`); }
    assert.ok(!(result.stdout + result.stderr).includes(SENTINEL), `${args[0]} leaked the credential value`);
    return { ...result, document };
  };
  const start = (extra = []) => json(['start', '--json', '--timeout', '90', '--coordinator-config', fixture.configuration, '--env-file', fixture.credentials, ...extra]);
  const stop = (extra = []) => json(['stop', '--json', '--coordinator-config', fixture.configuration, ...extra]);
  const plain = args => run(process.execPath, ['--no-warnings', cli, 'coordinator', ...args, '--coordinator-config', fixture.configuration], { cwd: fixture.cwd, env: fixture.env });

  const instanceRecord = async () => JSON.parse(await fs.readFile(path.join(fixture.state, 'lifecycle', 'instance.json'), 'utf8'));
  const client = async () => createCoordinatorClient(fixture.context.configuration.endpoint, await readCoordinatorToken(fixture.state), { timeoutMs: 5000, deadlineMs: 10000 });
  async function servingProcesses() {
    const { stdout } = await exec('ps', ['-ax', '-o', 'pid=,command=']);
    return stdout.split('\n').filter(line => line.includes('coordinator serve') && line.includes(fixture.configuration));
  }

  // Native manager state for the fixture's derived name only.
  async function systemctl(...args) {
    const result = await run('/usr/bin/systemctl', ['--user', ...args], { env: fixture.env });
    return result;
  }
  async function lingerState() {
    if (process.platform !== 'linux') return null;
    const result = await run('loginctl', ['show-user', String(process.getuid()), '--property=Linger'], { env: fixture.env }).catch(() => undefined);
    return result?.status === 0 ? result.stdout.trim() : null;
  }

  before(async () => {
    if (!enabled) return;
    const base = await fs.access('/tmp').then(() => '/tmp', () => os.tmpdir());
    // Short root: the coordinator endpoint must fit the portable Unix socket path limit.
    const root = await fs.realpath(await fs.mkdtemp(path.join(base, 'hn-')));
    Object.assign(fixture, {
      root, home: path.join(root, 'home'), state: path.join(root, 'state'), cwd: path.join(root, 'cwd'),
      configuration: path.join(root, 'coordinator.toml'), credentials: path.join(root, 'credentials.env'),
    });
    await Promise.all([fixture.home, fixture.cwd, path.join(root, 'openchamber')].map(directory => fs.mkdir(directory, { recursive: true, mode: 0o700 })));
    await fs.writeFile(fixture.configuration, `[coordinator]\nstateDirectory = ${JSON.stringify(fixture.state)}\nglobalConcurrency = 1\nprojectConcurrency = 1\n`);
    await fs.writeFile(fixture.credentials, `OPENCODE_PASSWORD=${SENTINEL}\n`, { mode: 0o600 });
    await fs.chmod(fixture.credentials, 0o600);

    const env = {
      PATH: process.env.PATH ?? '',
      HOME: fixture.home,
      TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
      LANG: process.env.LANG ?? 'C.UTF-8',
      XDG_STATE_HOME: path.join(fixture.home, '.local', 'state'),
      XDG_DATA_HOME: path.join(fixture.home, '.local', 'share'),
      XDG_CACHE_HOME: path.join(fixture.home, '.cache'),
      OPENCHAMBER_DATA_DIR: path.join(root, 'openchamber'),
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    };
    if (process.platform === 'linux') {
      // `systemctl --user link` is carried out by the user manager, which reads and writes its own configuration
      // home. The adapter looks for its link there, so the real XDG_CONFIG_HOME must stay visible. Only the derived
      // fixture unit is ever placed in it.
      env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME ?? path.join(os.userInfo().homedir, '.config');
      for (const name of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) if (process.env[name]) env[name] = process.env[name];
    } else env.XDG_CONFIG_HOME = path.join(fixture.home, '.config');
    fixture.env = env;

    fixture.context = await resolveLaunchContext({ coordinatorConfig: fixture.configuration, envFile: fixture.credentials }, env);
    const selection = selectNativeAdapter({ context: fixture.context, environment: env });
    assert.ok(selection.supported, `no native manager for ${process.platform}: ${selection.message}`);
    fixture.adapter = selection.adapter;
    fixture.manager = selection.manager;
    fixture.linger = await lingerState();
  });

  after(async () => {
    if (!enabled || cleaned || !fixture.adapter) return;
    cleaned = true;
    let pending;
    let inspection = await fixture.adapter.inspect();
    if (inspection.running === true) {
      // Graceful shutdown through the production command only; nothing is signaled or force-removed.
      await stop(['--timeout', '60']).catch(() => undefined);
      inspection = await fixture.adapter.inspect();
    }
    if (inspection.registration === 'not-loaded' && !await exists(fixture.adapter.identity().definitionPath)) {
      pending = undefined;
    } else if (inspection.running === false) {
      const result = await fixture.adapter.cleanupFixture();
      if (result.outcome === 'refused') pending = result.detail;
      else if ((await fixture.adapter.inspect()).registration === 'loaded') pending = `${fixture.adapter.identity().label} is still registered after cleanup`;
    } else pending = `${fixture.adapter.identity().label} is not proven stopped (${inspection.detail})`;
    if (pending) {
      process.stderr.write(`native lifecycle cleanup pending: ${pending}; fixture preserved in ${fixture.root}\n`);
      throw new Error(`Cleanup pending: ${pending}. The fixture in ${fixture.root} was preserved and nothing was escalated.`);
    }
    await fs.rm(fixture.root, { recursive: true, force: true });
  });

  native('fixture names are derived from the isolated state directory and nothing is registered or defined yet', async t => {
    const names = nativeServiceNames(fixture.state);
    const identity = fixture.adapter.identity();
    assert.equal(identity.label, fixture.manager === 'launchd' ? names.launchdLabel : names.systemdUnit);
    assert.match(identity.label, fixture.manager === 'launchd' ? /^dev\.openheimdall\.coordinator\.[0-9a-f]{24}$/ : /^heimdall-coordinator-[0-9a-f]{24}\.service$/);
    assert.equal(fixture.context.configuration.stateDirectory, fixture.state);
    assert.ok(fixture.state.startsWith(fixture.root), 'the state directory is inside the temporary fixture');
    // Never the identity of the real default state directory (or of any state the process environment points at).
    const realDefault = nativeServiceNames(path.join(await fs.realpath(os.userInfo().homedir), '.local', 'state', 'heimdall'));
    assert.notEqual(names.identity, realDefault.identity);
    assert.ok(identity.definitionPath.startsWith(fixture.state), 'the definition lives in the fixture state directory');
    assert.equal(await exists(fixture.state), false, 'the state directory does not exist before the first start');
    const inspection = await fixture.adapter.inspect();
    assert.equal(inspection.registration, 'not-loaded', `${identity.label} is already registered: ${inspection.detail}`);
    assert.equal(inspection.running, false);
    t.diagnostic(`${fixture.manager} fixture ${identity.label}; state ${fixture.state}`);
  });

  native('simultaneous starts register one definition and leave one owned, ready coordinator', async t => {
    const results = await Promise.all([start(), start(), start()]);
    const outcomes = results.map(result => result.document.outcome);
    t.diagnostic(`simultaneous start outcomes: ${outcomes.join(', ')}`);
    assert.equal(outcomes.filter(outcome => outcome === 'ready').length, 1, outcomes.join());
    for (const result of results) {
      assert.ok(['ready', 'already-running', 'busy'].includes(result.document.outcome), JSON.stringify(result.document));
      assert.equal(result.status === 0, result.document.ok);
    }
    const winner = results.find(result => result.document.outcome === 'ready').document;
    assert.equal(winner.target.manager, fixture.manager);
    assert.equal(winner.target.label, fixture.adapter.identity().label);
    assert.equal(winner.instance.mode, 'managed');
    for (const result of results) if (result.document.instance) assert.equal(result.document.instance.instanceId, winner.instance.instanceId);
    fixture.first = winner.instance;

    const inspection = await fixture.adapter.inspect();
    assert.equal(inspection.registration, 'loaded');
    assert.equal(inspection.running, true);
    assert.equal(inspection.pid, fixture.first.pid, 'the manager runs the process the coordinator reports');
    assert.equal(await probeCoordinatorOwnership(fixture.state), 'held');
    assert.equal((await servingProcesses()).length, 1, 'exactly one coordinator process serves this fixture');

    // Independent authenticated readiness, outside the start command.
    const ipc = await client();
    const lifecycle = await ipc.request('GET', '/lifecycle');
    assert.equal(lifecycle.lifecycleProtocol, COORDINATOR_LIFECYCLE_PROTOCOL);
    assert.equal(lifecycle.instanceId, fixture.first.instanceId);
    assert.equal(lifecycle.mode, 'managed');
    assert.equal(lifecycle.manager, fixture.adapter.identity().label);
    assert.equal(lifecycle.phase, 'running');
    const status = parseCoordinatorStatus(await ipc.request('GET', '/status'));
    assert.deepEqual({ status: status.status, queued: status.queuedRuns, reserved: status.reservedRuns, accepting: status.acceptingNewRuns }, { status: 'running', queued: 0, reserved: 0, accepting: true }, 'an empty state registers no work');
  });

  native('a repeated start reports the same running instance and starts no second process', async () => {
    const result = await start();
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.document.outcome, 'already-running');
    assert.equal(result.document.instance.instanceId, fixture.first.instanceId);
    assert.equal((await fixture.adapter.inspect()).pid, fixture.first.pid);
    assert.equal((await servingProcesses()).length, 1);
  });

  native('the service survives the invoking command and has no controlling terminal', async () => {
    assert.ok(processAlive(fixture.first.pid), 'the service outlives every start command');
    const { stdout } = await exec('ps', ['-o', 'ppid=,pgid=,tty=', '-p', String(fixture.first.pid)]);
    const [parent, group, terminal] = stdout.trim().split(/\s+/);
    const own = await exec('ps', ['-o', 'pgid=', '-p', String(process.pid)]);
    assert.notEqual(Number(parent), process.pid, 'not a child of the test process');
    assert.notEqual(group, own.stdout.trim(), 'not in the test process group');
    assert.match(terminal ?? '', /^\?+$/, `the service has a controlling terminal: ${terminal}`);
  });

  native('startup policy is explicit-only: no automatic start, restart, login or linger', async t => {
    const identity = fixture.adapter.identity();
    const definition = await fs.readFile(identity.definitionPath, 'utf8');
    assert.ok(!definition.includes(SENTINEL), 'the definition holds no credential value');
    assert.ok(definition.includes(fixture.context.credentialFile), 'the definition references the credential file by path');
    if (fixture.manager === 'launchd') {
      assert.match(definition, /<key>RunAtLoad<\/key>\s*<false\/>/);
      assert.match(definition, /<key>KeepAlive<\/key>\s*<false\/>/);
      for (const key of ['StartInterval', 'StartCalendarInterval', 'WatchPaths', 'QueueDirectories', 'StartOnMount', 'Sockets', 'LaunchEvents']) assert.ok(!definition.includes(`<key>${key}</key>`), `${key} must not be rendered`);
      const print = await run('/bin/launchctl', ['print', `gui/${process.getuid()}/${identity.label}`]);
      assert.equal(print.status, 0, print.stderr);
      assert.doesNotMatch(print.stdout, /\bkeepalive\b/i, 'the loaded job asks for no keep-alive');
      assert.doesNotMatch(print.stdout, /\brunatload\b/i, 'the loaded job asks for no run-at-load');
      t.diagnostic('launchd: RunAtLoad=false and KeepAlive=false in the definition; neither appears in the loaded job');
    } else {
      assert.doesNotMatch(definition, /\[Install\]|WantedBy|Restart=(?!no)/);
      const shown = await systemctl('show', identity.label, '--property=UnitFileState,Restart,ActiveState');
      assert.equal(shown.status, 0, shown.stderr);
      const properties = Object.fromEntries(shown.stdout.trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2)));
      assert.equal(properties.Restart, 'no');
      assert.ok(!/^enabled/.test(properties.UnitFileState ?? ''), `the unit must not be enabled: ${properties.UnitFileState}`);
      assert.equal(properties.ActiveState, 'active');
      assert.equal(await lingerState(), fixture.linger, 'linger was not changed');
      t.diagnostic(`systemd: UnitFileState=${properties.UnitFileState} Restart=${properties.Restart}; linger ${fixture.linger ?? 'not readable'} before and after`);
    }
  });

  native('a clean CLI stop completes, leaves an inactive owned definition and a released lock', async () => {
    const result = await stop(['--timeout', '90']);
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.document.outcome, 'stopped');
    assert.equal(result.document.instance.instanceId, fixture.first.instanceId);
    const record = JSON.parse(await fs.readFile(path.join(fixture.state, 'lifecycle', `shutdown-${fixture.first.instanceId}.json`), 'utf8'));
    assert.equal(record.status, 'completed');
    await waitFor('the service process to be gone', () => !processAlive(fixture.first.pid));
    const inspection = await waitFor('the manager to report the service stopped', async () => { const current = await fixture.adapter.inspect(); return current.running === false ? current : undefined; });
    if (inspection.lastExitStatus !== null) assert.equal(inspection.lastExitStatus, 0, 'the main process exited cleanly');
    assert.equal(await probeCoordinatorOwnership(fixture.state), 'free');
    assert.ok(await exists(fixture.adapter.identity().definitionPath), 'the definition is retained');
    assert.equal((await fixture.adapter.remembered()).kind, 'owned');
    assert.equal((await servingProcesses()).length, 0);
    const status = await plain(['status']);
    assert.notEqual(status.status, 0, 'a stopped coordinator does not answer status');
  });

  native('a repeated stop reports that the coordinator is already stopped', async () => {
    const result = await stop();
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.document.outcome, 'already-stopped');
  });

  native('logs stay readable after stop and carry no credential value', async () => {
    const result = await plain(['logs', '--lines', '50']);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(!(result.stdout + result.stderr).includes(SENTINEL));
    if (fixture.manager === 'launchd') assert.match(result.stdout, /Coordinator listening at/, 'the service output was captured in the private log file');
  });

  // launchd keeps the definition it loaded, so applying a changed credential file to a stopped service needs the
  // stale registration replaced; `start` does that itself, without any manual launchctl step.
  test('launchd: start after a clean stop applies a changed credential file path to the stopped definition', {
    skip: skip || (process.platform === 'darwin' ? false : 'launchd refresh is checked on macOS only'),
  }, async t => {
    const identity = fixture.adapter.identity();
    const target = `gui/${process.getuid()}/${identity.label}`;
    const next = path.join(fixture.root, 'credentials-next.env');
    await fs.writeFile(next, 'OPENCODE_PASSWORD=hn-native-synthetic-next-credential\n', { mode: 0o600 });
    await fs.chmod(next, 0o600);
    const withFile = file => json(['start', '--json', '--timeout', '90', '--coordinator-config', fixture.configuration, '--env-file', file]);

    // Start, then a confirmed clean stop: the owned definition stays registered with the old credential path.
    const first = await withFile(fixture.credentials);
    assert.equal(first.document.outcome, 'ready', `${first.stdout}\n${first.stderr}`);
    const halted = await stop(['--timeout', '90']);
    assert.equal(halted.document.outcome, 'stopped', `${halted.stdout}\n${halted.stderr}`);
    await waitFor('the manager to report the service stopped', async () => (await fixture.adapter.inspect()).running === false);
    const before = await run('/bin/launchctl', ['print', target]);
    assert.equal(before.status, 0, before.stderr);
    assert.ok(before.stdout.includes(fixture.credentials), 'the loaded registration still names the previous credential file');

    // A changed credential path is applied by start itself.
    const refreshed = await withFile(next);
    assert.equal(refreshed.status, 0, `${refreshed.stdout}\n${refreshed.stderr}`);
    assert.equal(refreshed.document.outcome, 'ready');
    assert.notEqual(refreshed.document.instance.instanceId, first.document.instance.instanceId);
    const definition = await fs.readFile(identity.definitionPath, 'utf8');
    assert.ok(definition.includes(next) && !definition.includes(fixture.credentials), 'the definition on disk carries the new credential path');
    assert.equal((await fixture.adapter.remembered()).credentialFile, next);
    const after = await run('/bin/launchctl', ['print', target]);
    assert.equal(after.status, 0, after.stderr);
    assert.ok(after.stdout.includes(next) && !after.stdout.includes(fixture.credentials), 'the loaded registration names only the new credential file');
    const inspection = await fixture.adapter.inspect();
    assert.deepEqual([inspection.registration, inspection.running, inspection.pid], ['loaded', true, refreshed.document.instance.pid]);
    const lifecycle = await (await client()).request('GET', '/lifecycle');
    assert.equal(lifecycle.instanceId, refreshed.document.instance.instanceId);
    assert.equal(lifecycle.phase, 'running');
    assert.ok(!(refreshed.stdout + refreshed.stderr).includes('hn-native-synthetic-next-credential'));

    // Graceful stop; only the proven-inactive fixture registration remains for the suite's cleanup.
    const final = await stop(['--timeout', '90']);
    assert.equal(final.document.outcome, 'stopped', `${final.stdout}\n${final.stderr}`);
    await waitFor('the manager to report the service stopped', async () => (await fixture.adapter.inspect()).running === false);
    t.diagnostic(`launchd refresh: ${first.document.instance.instanceId} -> ${refreshed.document.instance.instanceId} with a changed credential file path`);
  });

  native('a later explicit start brings up a new instance', async () => {
    const result = await start();
    assert.equal(result.status, 0, result.stdout);
    assert.equal(result.document.outcome, 'ready');
    assert.notEqual(result.document.instance.instanceId, fixture.first.instanceId);
    assert.notEqual(result.document.instance.pid, fixture.first.pid);
    fixture.second = result.document.instance;
    assert.equal((await fixture.adapter.inspect()).pid, fixture.second.pid);
  });

  native('a controlled crash of the service process is not relaunched', async t => {
    const record = await instanceRecord();
    const inspection = await fixture.adapter.inspect();
    assert.equal(record.pid, fixture.second.pid);
    assert.equal(inspection.pid, record.pid, 'only the process the manager runs for this fixture is signaled');
    process.kill(record.pid, 'SIGKILL');
    await waitFor('the killed process to be gone', () => !processAlive(record.pid));
    await waitFor('the manager to report the service stopped', async () => (await fixture.adapter.inspect()).running === false);
    // A relaunch policy would act within moments; observe for a bounded period.
    for (let attempt = 0; attempt < 10; attempt++) {
      await sleep(500);
      assert.equal((await fixture.adapter.inspect()).running, false, 'the manager relaunched the coordinator');
    }
    assert.equal((await servingProcesses()).length, 0);
    assert.equal(await probeCoordinatorOwnership(fixture.state), 'free', 'the operating system released the ownership lock');
    const completion = await fs.readFile(path.join(fixture.state, 'lifecycle', `shutdown-${fixture.second.instanceId}.json`), 'utf8').catch(() => null);
    assert.equal(completion, null, 'a killed instance publishes no clean-shutdown record');
    t.diagnostic('crash left the endpoint file in place; no stale-socket repair is claimed or attempted');
  });

  test('previously queued work follows normal admission after startup', { skip: 'the managed service always runs the production executor; admission after a restart with a synthetic executor is covered by test/coordinator-service.test.mjs ("a run queued before the coordinator started ...")' }, () => {});
});

describe('native delayed drain (protocol fixture; launchd on macOS)', () => {
  const fixture = {};
  let cleaned = false;
  const darwinOnly = skip || (process.platform === 'darwin' ? false : 'the delayed-drain fixture is checked against launchd on macOS only');
  const delayed = (name, body) => test(name, { skip: darwinOnly, timeout: 180 * SECONDS }, body);

  /** The production lifecycle command in this process, against the real launchd, with the delayed-drain service entry. */
  async function lifecycle(command, args) {
    let stdout = '';
    const startedAt = Date.now();
    const status = await lifecycleCommandMain(command, ['--json', '--coordinator-config', fixture.configuration, ...args], {
      streams: { stdout: { write: text => { stdout += text; } }, stderr: { write: () => {} } },
      dependencies: { environment: fixture.env, launchOverrides: { nodeExecutable: process.execPath, entryPoint: path.join(checkout, 'test', 'fixtures', 'delayed-drain-entry.mjs') } },
    });
    const document = JSON.parse(stdout);
    assert.ok(!stdout.includes(SENTINEL), `${command} leaked the credential value`);
    return { status, document, elapsed: Date.now() - startedAt };
  }

  before(async () => {
    if (darwinOnly) return;
    const root = await fs.realpath(await fs.mkdtemp(path.join(await fs.access('/tmp').then(() => '/tmp', () => os.tmpdir()), 'hn-')));
    Object.assign(fixture, { root, home: path.join(root, 'home'), state: path.join(root, 'state'), configuration: path.join(root, 'coordinator.toml'), credentials: path.join(root, 'credentials.env') });
    await Promise.all([fixture.home, path.join(root, 'openchamber')].map(directory => fs.mkdir(directory, { recursive: true, mode: 0o700 })));
    await fs.writeFile(fixture.configuration, `[coordinator]\nstateDirectory = ${JSON.stringify(fixture.state)}\nglobalConcurrency = 1\nprojectConcurrency = 1\n`);
    await fs.writeFile(fixture.credentials, `OPENCODE_PASSWORD=${SENTINEL}\n`, { mode: 0o600 });
    await fs.chmod(fixture.credentials, 0o600);
    fixture.env = {
      PATH: process.env.PATH ?? '', HOME: fixture.home, TMPDIR: process.env.TMPDIR ?? os.tmpdir(), LANG: process.env.LANG ?? 'C.UTF-8',
      XDG_STATE_HOME: path.join(fixture.home, '.local', 'state'), XDG_DATA_HOME: path.join(fixture.home, '.local', 'share'),
      XDG_CACHE_HOME: path.join(fixture.home, '.cache'), XDG_CONFIG_HOME: path.join(fixture.home, '.config'),
      OPENCHAMBER_DATA_DIR: path.join(root, 'openchamber'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    };
    fixture.context = await resolveLaunchContext({ coordinatorConfig: fixture.configuration, envFile: fixture.credentials }, fixture.env);
    const selection = selectNativeAdapter({ context: fixture.context, environment: fixture.env });
    assert.ok(selection.supported, `no native manager for ${process.platform}: ${selection.message}`);
    fixture.adapter = selection.adapter;
    const inspection = await fixture.adapter.inspect();
    assert.equal(inspection.registration, 'not-loaded', `${fixture.adapter.identity().label} is already registered: ${inspection.detail}`);
  });

  after(async () => {
    if (darwinOnly || cleaned || !fixture.adapter) return;
    cleaned = true;
    let pending;
    let inspection = await fixture.adapter.inspect();
    if (inspection.running === true) {
      await lifecycle('stop', ['--timeout', '90']).catch(() => undefined);
      inspection = await fixture.adapter.inspect();
    }
    if (inspection.registration === 'not-loaded' && !await exists(fixture.adapter.identity().definitionPath)) pending = undefined;
    else if (inspection.running === false) {
      const result = await fixture.adapter.cleanupFixture();
      if (result.outcome === 'refused') pending = result.detail;
      else if ((await fixture.adapter.inspect()).registration === 'loaded') pending = `${fixture.adapter.identity().label} is still registered after cleanup`;
    } else pending = `${fixture.adapter.identity().label} is not proven stopped (${inspection.detail})`;
    if (pending) {
      process.stderr.write(`native delayed-drain cleanup pending: ${pending}; fixture preserved in ${fixture.root}\n`);
      throw new Error(`Cleanup pending: ${pending}. The fixture in ${fixture.root} was preserved and nothing was escalated.`);
    }
    await fs.rm(fixture.root, { recursive: true, force: true });
  });

  delayed('a stop whose drain outlasts its deadline reports no success, leaves the service draining, and a later stop completes', async t => {
    const started = await lifecycle('start', ['--timeout', '90', '--env-file', fixture.credentials]);
    assert.equal(started.document.outcome, 'ready', JSON.stringify(started.document));
    const instance = started.document.instance;

    const hurried = await lifecycle('stop', ['--timeout', '1']);
    t.diagnostic(`stop --timeout 1 ended after ${hurried.elapsed} ms with ${hurried.document.outcome} (exit ${hurried.status})`);
    assert.ok(hurried.elapsed <= 1000 + 1500, `stop took ${hurried.elapsed} ms for a 1000 ms deadline`);
    assert.notEqual(hurried.status, 0);
    assert.equal(hurried.document.ok, false);
    assert.notEqual(hurried.document.outcome, 'stopped');
    assert.ok(['still-draining', 'completion-unknown'].includes(hurried.document.outcome), hurried.document.outcome);
    assert.ok(['deadline-exceeded', 'completion-unknown'].includes(hurried.document.error.code), hurried.document.error.code);
    t.diagnostic(`message: ${hurried.document.message}`);

    // The deadline ended the command, not the service: the real manager still runs the same process, which keeps draining.
    const inspection = await fixture.adapter.inspect();
    assert.equal(inspection.running, true);
    assert.equal(inspection.pid, instance.pid);
    assert.ok(processAlive(instance.pid));
    assert.equal(await probeCoordinatorOwnership(fixture.state), 'held');
    const reported = await createCoordinatorClient(fixture.context.configuration.endpoint, await readCoordinatorToken(fixture.state), { timeoutMs: 3000, deadlineMs: 5000 }).request('GET', '/lifecycle').catch(() => null);
    if (reported) {
      assert.equal(reported.instanceId, instance.instanceId);
      assert.notEqual(reported.phase, 'running', 'the accepted drain stays in effect');
    }

    // The accepted drain finishes on its own; the service manager then reports the process gone with a clean exit.
    await waitFor('the delayed shutdown to finish', async () => (await fixture.adapter.inspect()).running === false, { timeoutMs: 60 * SECONDS });
    const record = JSON.parse(await fs.readFile(path.join(fixture.state, 'lifecycle', `shutdown-${instance.instanceId}.json`), 'utf8'));
    assert.equal(record.status, 'completed');
    assert.equal((await fixture.adapter.inspect()).lastExitStatus, 0);
    // A later stop reports the completed clean shutdown; it does not claim to have stopped anything itself.
    const finished = await lifecycle('stop', ['--timeout', '90']);
    assert.equal(finished.status, 0, JSON.stringify(finished.document));
    assert.equal(finished.document.outcome, 'already-stopped');
    await waitFor('the service process to be gone', () => !processAlive(instance.pid));
    assert.equal(await probeCoordinatorOwnership(fixture.state), 'free');
  });
});
