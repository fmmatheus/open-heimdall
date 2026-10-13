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
 * The second suite, "native delayed shutdown", is protocol-fixture evidence on both platforms: the real launchd or
 * systemd user manager runs the production coordinator through test/fixtures/delayed-drain-entry.mjs, which injects
 * a delay into the shutdown. The production `stop --timeout` command runs as its own client process
 * (test/fixtures/native-lifecycle-entry.mjs) and ends within its deadline without a success while the real service
 * keeps running; the accepted shutdown then finishes on its own with a clean exit and a later stop reports
 * `already-stopped`. It is not a held-run idle proof and does not involve a native run.
 *
 * The third suite, "native systemd foreign unit link", is Linux only: real systemd loads the expected user-unit link
 * naming a synthetic foreign unit outside its search paths, and the public start and stop commands must refuse it.
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

/**
 * The environment of every fixture command. HOME, XDG state/data/cache, the OpenChamber directory and the credential
 * file are private to the fixture. On Linux the real XDG_CONFIG_HOME, XDG_RUNTIME_DIR and DBUS_SESSION_BUS_ADDRESS
 * stay visible: `systemctl --user link` is carried out by the user manager, which reads and writes its own
 * configuration home, and the adapter looks for its link there. Only the derived fixture unit is ever placed in it.
 */
function isolatedEnvironment(root, home) {
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    LANG: process.env.LANG ?? 'C.UTF-8',
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    OPENCHAMBER_DATA_DIR: path.join(root, 'openchamber'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  if (process.platform === 'linux') {
    env.XDG_CONFIG_HOME = process.env.XDG_CONFIG_HOME ?? path.join(os.userInfo().homedir, '.config');
    for (const name of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) if (process.env[name]) env[name] = process.env[name];
  } else env.XDG_CONFIG_HOME = path.join(home, '.config');
  return env;
}

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

    const env = isolatedEnvironment(root, fixture.home);
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
    // The controlled crash leaves the unit remembered as failed by the manager although nothing is loaded; forget
    // only that record, for the fixture's own derived unit.
    if (fixture.manager === 'systemd') await systemctl('reset-failed', fixture.adapter.identity().label);
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

/** Manager-reported state of one fixture service, read straight from the real launchd or systemd user manager. */
async function managerState(manager, label, env) {
  if (manager === 'launchd') {
    const print = await run('/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`], { env });
    const field = name => new RegExp(`^\\s*${name} = (.+)$`, 'm').exec(print.stdout)?.[1]?.trim() ?? null;
    return { raw: print, status: print.status, state: field('state'), pid: field('pid'), runs: field('runs'), lastExit: field('last exit code') };
  }
  const properties = ['LoadState', 'ActiveState', 'SubState', 'MainPID', 'ExecMainStatus', 'Result', 'NRestarts', 'InvocationID', 'StateChangeTimestampMonotonic', 'FragmentPath', 'UnitFileState'];
  const shown = await run('/usr/bin/systemctl', ['--user', 'show', label, '--property', properties.join(',')], { env });
  assert.equal(shown.status, 0, shown.stderr);
  return { raw: shown, ...Object.fromEntries(shown.stdout.trim().split('\n').map(line => line.split(/=(.*)/s).slice(0, 2))) };
}

describe('native delayed shutdown (protocol fixture; real launchd or systemd user manager)', () => {
  const fixture = {};
  let cleaned = false;
  const delayed = (name, body) => test(name, { skip, timeout: 180 * SECONDS }, body);
  const serviceEntry = path.join(checkout, 'test', 'fixtures', 'delayed-drain-entry.mjs');
  const clientEntry = path.join(checkout, 'test', 'fixtures', 'native-lifecycle-entry.mjs');
  // The budget of the hurried stop (1000 ms) plus the documented tolerance for process start-up and the final
  // manager inspection, the same tolerance test/coordinator-lifecycle-process-exit.test.mjs applies (2500 ms total).
  const HURRIED_BUDGET_MS = 1000;
  const CLIENT_TOLERANCE_MS = 1500;

  /** The production lifecycle command as its own client PROCESS against the real manager, with the delayed-shutdown service entry. */
  async function lifecycle(command, args) {
    const startedAt = Date.now();
    const result = await run(process.execPath, ['--no-warnings', clientEntry, serviceEntry, command, '--json', '--coordinator-config', fixture.configuration, ...args], { cwd: fixture.cwd, env: fixture.env });
    const elapsed = Date.now() - startedAt;
    assert.ok(!(result.stdout + result.stderr).includes(SENTINEL), `${command} leaked the credential value`);
    let document;
    try { document = JSON.parse(result.stdout); }
    catch { throw new Error(`Expected exactly one JSON document from "${command}" (exit ${result.status}):\n${result.stdout}\n${result.stderr}`); }
    return { status: result.status, document, elapsed, stdout: result.stdout, stderr: result.stderr };
  }

  before(async () => {
    if (!enabled) return;
    const root = await fs.realpath(await fs.mkdtemp(path.join(await fs.access('/tmp').then(() => '/tmp', () => os.tmpdir()), 'hn-')));
    Object.assign(fixture, { root, home: path.join(root, 'home'), state: path.join(root, 'state'), cwd: path.join(root, 'cwd'), configuration: path.join(root, 'coordinator.toml'), credentials: path.join(root, 'credentials.env') });
    await Promise.all([fixture.home, fixture.cwd, path.join(root, 'openchamber')].map(directory => fs.mkdir(directory, { recursive: true, mode: 0o700 })));
    await fs.writeFile(fixture.configuration, `[coordinator]\nstateDirectory = ${JSON.stringify(fixture.state)}\nglobalConcurrency = 1\nprojectConcurrency = 1\n`);
    await fs.writeFile(fixture.credentials, `OPENCODE_PASSWORD=${SENTINEL}\n`, { mode: 0o600 });
    await fs.chmod(fixture.credentials, 0o600);
    fixture.env = isolatedEnvironment(root, fixture.home);
    fixture.context = await resolveLaunchContext({ coordinatorConfig: fixture.configuration, envFile: fixture.credentials }, fixture.env);
    const selection = selectNativeAdapter({ context: fixture.context, environment: fixture.env });
    assert.ok(selection.supported, `no native manager for ${process.platform}: ${selection.message}`);
    fixture.adapter = selection.adapter;
    fixture.manager = selection.manager;
    const inspection = await fixture.adapter.inspect();
    assert.equal(inspection.registration, 'not-loaded', `${fixture.adapter.identity().label} is already registered: ${inspection.detail}`);
  });

  after(async () => {
    if (!enabled || cleaned || !fixture.adapter) return;
    cleaned = true;
    let pending;
    let inspection = await fixture.adapter.inspect();
    if (inspection.running === true) {
      // Graceful shutdown through the production command only; nothing is signaled or force-removed.
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
      process.stderr.write(`native delayed-shutdown cleanup pending: ${pending}; fixture preserved in ${fixture.root}\n`);
      throw new Error(`Cleanup pending: ${pending}. The fixture in ${fixture.root} was preserved and nothing was escalated.`);
    }
    await fs.rm(fixture.root, { recursive: true, force: true });
  });

  delayed('a stop whose shutdown outlasts its deadline reports no success, leaves the service running, and the accepted shutdown completes on its own', async t => {
    const identity = fixture.adapter.identity();
    t.diagnostic(`delayed-shutdown protocol fixture on ${fixture.manager}: ${identity.label} (not a held-run idle proof)`);

    // 1. Explicit start reaches authenticated readiness with an owned registration and a positive main PID.
    const started = await lifecycle('start', ['--timeout', '90', '--env-file', fixture.credentials]);
    assert.equal(started.status, 0, started.stdout);
    assert.equal(started.document.outcome, 'ready', started.stdout);
    const instance = started.document.instance;
    assert.ok(Number.isInteger(instance.pid) && instance.pid > 0, `instance pid ${instance.pid}`);
    const running = await fixture.adapter.inspect();
    assert.deepEqual([running.registration, running.running, running.pid], ['loaded', true, instance.pid]);
    assert.deepEqual(await fixture.adapter.registrationOwnership(running), { kind: 'owned' });
    assert.equal((await fixture.adapter.remembered()).kind, 'owned');
    assert.equal(await probeCoordinatorOwnership(fixture.state), 'held');
    const ipc = createCoordinatorClient(fixture.context.configuration.endpoint, await readCoordinatorToken(fixture.state), { timeoutMs: 3000, deadlineMs: 5000 });
    const ready = await ipc.request('GET', '/lifecycle');
    assert.equal(ready.instanceId, instance.instanceId);
    assert.equal(ready.phase, 'running');
    const before = await managerState(fixture.manager, identity.label, fixture.env);
    if (fixture.manager === 'systemd') {
      assert.equal(before.ActiveState, 'active');
      assert.equal(Number(before.MainPID), instance.pid);
    } else {
      assert.equal(before.state, 'running');
      assert.equal(Number(before.pid), instance.pid);
    }

    // 2. The hurried stop is measured as the invoking client process: it ends within the budget plus the tolerance,
    //    with exactly one JSON document that is not a success.
    const hurried = await lifecycle('stop', ['--timeout', '1']);
    t.diagnostic(`stop --timeout 1 client process ended after ${hurried.elapsed} ms (limit ${HURRIED_BUDGET_MS + CLIENT_TOLERANCE_MS} ms) with ${hurried.document.outcome} (exit ${hurried.status}); message: ${hurried.document.message}`);
    assert.ok(hurried.elapsed <= HURRIED_BUDGET_MS + CLIENT_TOLERANCE_MS, `stop took ${hurried.elapsed} ms for a ${HURRIED_BUDGET_MS} ms deadline`);
    assert.notEqual(hurried.status, 0);
    assert.equal(hurried.document.ok, false);
    assert.notEqual(hurried.document.outcome, 'stopped');
    assert.ok(['still-draining', 'completion-unknown'].includes(hurried.document.outcome), hurried.document.outcome);
    assert.ok(['deadline-exceeded', 'completion-unknown'].includes(hurried.document.error.code), hurried.document.error.code);

    // 3. The deadline ended the command, not the service: the same process is alive, ownership is held, and the manager
    //    shows no stop, kill, restart or removal (same invocation, same main PID, same state-change time, one run).
    const during = await fixture.adapter.inspect();
    assert.deepEqual([during.registration, during.running, during.pid], ['loaded', true, instance.pid]);
    assert.ok(processAlive(instance.pid));
    assert.equal(await probeCoordinatorOwnership(fixture.state), 'held');
    const stopped = await managerState(fixture.manager, identity.label, fixture.env);
    if (fixture.manager === 'systemd') {
      for (const property of ['ActiveState', 'SubState', 'MainPID', 'InvocationID', 'StateChangeTimestampMonotonic', 'NRestarts', 'FragmentPath']) assert.equal(stopped[property], before[property], `${property} changed during the hurried stop`);
      assert.equal(stopped.NRestarts, '0');
    } else {
      for (const property of ['state', 'pid', 'runs']) assert.equal(stopped[property], before[property], `${property} changed during the hurried stop`);
    }
    assert.equal((await exists(identity.definitionPath)), true, 'the registration was not removed');
    const reported = await ipc.request('GET', '/lifecycle').catch(() => null);
    if (reported) {
      assert.equal(reported.instanceId, instance.instanceId, 'the session was not replaced');
      assert.notEqual(reported.phase, 'running', 'the accepted shutdown stays in effect');
    }
    t.diagnostic(`manager state before/after the hurried stop (${fixture.manager}): ${JSON.stringify(fixture.manager === 'systemd' ? { before: { ActiveState: before.ActiveState, MainPID: before.MainPID, InvocationID: before.InvocationID, StateChangeTimestampMonotonic: before.StateChangeTimestampMonotonic }, after: { ActiveState: stopped.ActiveState, MainPID: stopped.MainPID, InvocationID: stopped.InvocationID, StateChangeTimestampMonotonic: stopped.StateChangeTimestampMonotonic } } : { before: { state: before.state, pid: before.pid, runs: before.runs }, after: { state: stopped.state, pid: stopped.pid, runs: stopped.runs } })}`);

    // 4. The accepted shutdown finishes on its own; the manager then reports a clean exit.
    await waitFor('the delayed shutdown to finish', async () => (await fixture.adapter.inspect()).running === false, { timeoutMs: 60 * SECONDS });
    const record = JSON.parse(await fs.readFile(path.join(fixture.state, 'lifecycle', `shutdown-${instance.instanceId}.json`), 'utf8'));
    assert.equal(record.status, 'completed');
    const finishedState = await managerState(fixture.manager, identity.label, fixture.env);
    if (fixture.manager === 'systemd') {
      assert.equal(finishedState.ExecMainStatus, '0', 'the main process exited with status 0');
      assert.equal(finishedState.Result, 'success');
      assert.equal(finishedState.NRestarts, '0');
      assert.equal(finishedState.ActiveState, 'inactive');
    } else {
      assert.equal(finishedState.lastExit, '0', `launchd last exit code: ${finishedState.lastExit}`);
      assert.equal((await fixture.adapter.inspect()).lastExitStatus, 0);
    }
    await waitFor('the service process to be gone', () => !processAlive(instance.pid));
    assert.equal(await probeCoordinatorOwnership(fixture.state), 'free');
    const later = await lifecycle('stop', ['--timeout', '90']);
    assert.equal(later.status, 0, later.stdout);
    assert.equal(later.document.outcome, 'already-stopped');
    t.diagnostic(`self-completed shutdown: record ${record.status}; ${fixture.manager === 'systemd' ? `ExecMainStatus=${finishedState.ExecMainStatus} Result=${finishedState.Result}` : `last exit code = ${finishedState.lastExit}`}; later stop ${later.document.outcome}`);
  });
});

/*
 * Real-systemd foreign-link refusal. The expected user-unit link names a complete synthetic foreign unit that lives
 * outside every unit search path, while a valid, separate, owned definition exists in the fixture state directory.
 * Real systemd loads the unit through the link; the public commands must refuse to start or stop it. Only uniquely
 * derived synthetic identities are used, and the foreign unit is removed afterwards. Evidence class: real-native
 * (systemd user manager), not a controlled runner.
 */
describe('native systemd foreign unit link (real systemd user manager)', () => {
  const fixture = {};
  let cleaned = false;
  const linuxOnly = skip || (process.platform === 'linux' ? false : 'the foreign-link refusal is checked against the systemd user manager on Linux only');
  const foreign = (name, body) => test(name, { skip: linuxOnly, timeout: 120 * SECONDS }, body);
  const clientEntry = path.join(checkout, 'test', 'fixtures', 'native-lifecycle-entry.mjs');

  async function lifecycle(command, args) {
    const result = await run(process.execPath, ['--no-warnings', clientEntry, cli, command, '--json', '--coordinator-config', fixture.configuration, ...args], { cwd: fixture.cwd, env: fixture.env });
    let document;
    try { document = JSON.parse(result.stdout); }
    catch { throw new Error(`Expected exactly one JSON document from "${command}" (exit ${result.status}):\n${result.stdout}\n${result.stderr}`); }
    assert.ok(!(result.stdout + result.stderr).includes(SENTINEL), `${command} leaked the credential value`);
    return { status: result.status, document, stdout: result.stdout, stderr: result.stderr };
  }

  const systemctlUser = (...args) => run('/usr/bin/systemctl', ['--user', ...args], { env: fixture.env });
  async function observe() {
    const shown = await managerState('systemd', fixture.unit, fixture.env);
    const { raw: _raw, ...properties } = shown;
    return {
      properties,
      link: await fs.readlink(fixture.linkPath).catch(() => null),
      foreignText: await fs.readFile(fixture.foreignUnit, 'utf8'),
      ownedText: await fs.readFile(fixture.ownedDefinition, 'utf8'),
      started: await exists(path.join(fixture.foreignDirectory, 'started')),
      lifecycleFiles: await fs.readdir(path.join(fixture.state, 'lifecycle')).catch(() => []),
      endpoint: await exists(fixture.context.configuration.endpoint),
    };
  }
  function assertRefusedUntouched(label, current) {
    assert.deepEqual(current.properties, fixture.initial.properties, `${label}: the unit's manager state changed`);
    assert.equal(current.link, fixture.initial.link, `${label}: the link changed`);
    assert.equal(current.foreignText, fixture.initial.foreignText);
    assert.equal(current.ownedText, fixture.initial.ownedText);
    assert.equal(current.started, false, `${label}: the foreign unit was started`);
    assert.equal(current.endpoint, false, `${label}: no coordinator endpoint exists, so no shutdown request could have been sent`);
    assert.deepEqual(current.lifecycleFiles.filter(name => name.startsWith('shutdown-') || name === 'instance.json' || name === 'launch-attempt.json'), [], `${label}: a shutdown request, instance or launch record was written`);
  }

  before(async () => {
    if (linuxOnly) return;
    const root = await fs.realpath(await fs.mkdtemp(path.join(await fs.access('/tmp').then(() => '/tmp', () => os.tmpdir()), 'hn-')));
    Object.assign(fixture, { root, home: path.join(root, 'home'), state: path.join(root, 'state'), cwd: path.join(root, 'cwd'), foreignDirectory: path.join(root, 'foreign'), configuration: path.join(root, 'coordinator.toml'), credentials: path.join(root, 'credentials.env') });
    await Promise.all([fixture.home, fixture.cwd, fixture.foreignDirectory, path.join(root, 'openchamber')].map(directory => fs.mkdir(directory, { recursive: true, mode: 0o700 })));
    await fs.writeFile(fixture.configuration, `[coordinator]\nstateDirectory = ${JSON.stringify(fixture.state)}\nglobalConcurrency = 1\nprojectConcurrency = 1\n`);
    await fs.writeFile(fixture.credentials, `OPENCODE_PASSWORD=${SENTINEL}\n`, { mode: 0o600 });
    await fs.chmod(fixture.credentials, 0o600);
    fixture.env = isolatedEnvironment(root, fixture.home);
    fixture.context = await resolveLaunchContext({ coordinatorConfig: fixture.configuration, envFile: fixture.credentials }, fixture.env);
    const selection = selectNativeAdapter({ context: fixture.context, environment: fixture.env });
    assert.ok(selection.supported && selection.manager === 'systemd', `no systemd user manager: ${selection.message}`);
    fixture.adapter = selection.adapter;
    fixture.unit = fixture.adapter.identity().label;
    fixture.ownedDefinition = fixture.adapter.identity().definitionPath;
    fixture.linkPath = path.join(fixture.env.XDG_CONFIG_HOME, 'systemd', 'user', fixture.unit);
    fixture.foreignUnit = path.join(fixture.foreignDirectory, fixture.unit);
    const inspection = await fixture.adapter.inspect();
    assert.equal(inspection.registration, 'not-loaded', `${fixture.unit} is already registered: ${inspection.detail}`);
    assert.equal(await exists(fixture.linkPath), false, `${fixture.linkPath} already exists`);
  });

  after(async () => {
    if (linuxOnly || cleaned || !fixture.adapter) return;
    cleaned = true;
    let pending;
    const shown = await managerState('systemd', fixture.unit, fixture.env).catch(error => ({ LoadState: 'unknown', detail: error.message }));
    if (shown.LoadState === 'not-found' && !await exists(fixture.linkPath)) pending = undefined;
    else if (shown.LoadState === 'loaded' && shown.ActiveState !== 'active' && shown.ActiveState !== 'activating' && shown.MainPID === '0'
      && await fs.readlink(fixture.linkPath).catch(() => null) === fixture.foreignUnit) {
      // Only the synthetic foreign unit's own link, proven inactive, is removed.
      await fs.unlink(fixture.linkPath);
      const reloaded = await systemctlUser('daemon-reload');
      const reshown = await managerState('systemd', fixture.unit, fixture.env);
      if (reloaded.status !== 0 || reshown.LoadState !== 'not-found') pending = `${fixture.unit} is still loaded after removing its link`;
    } else pending = `${fixture.unit} is not proven inactive or its link is not the fixture's (LoadState=${shown.LoadState}, ActiveState=${shown.ActiveState}, MainPID=${shown.MainPID})`;
    if (pending) {
      process.stderr.write(`native foreign-link cleanup pending: ${pending}; fixture preserved in ${fixture.root}\n`);
      throw new Error(`Cleanup pending: ${pending}. The fixture in ${fixture.root} was preserved and nothing was escalated.`);
    }
    await fs.rm(fixture.root, { recursive: true, force: true });
  });

  foreign('real systemd loads the expected link to a foreign unit outside its search paths and reports its FragmentPath', async t => {
    // A valid, separate, owned definition exists but is not the one the link names.
    await fs.mkdir(fixture.state, { recursive: true, mode: 0o700 });
    await fs.mkdir(path.dirname(fixture.ownedDefinition), { recursive: true, mode: 0o700 });
    await fs.writeFile(fixture.ownedDefinition, fixture.adapter.render(), { mode: 0o600 });
    assert.equal((await fixture.adapter.remembered()).kind, 'owned');

    // A complete synthetic foreign unit; if anything starts it, it leaves a marker.
    const script = path.join(fixture.foreignDirectory, 'foreign-service.sh');
    await fs.writeFile(script, `#!/bin/sh\necho started > ${path.join(fixture.foreignDirectory, 'started')}\nexec sleep 300\n`, { mode: 0o755 });
    await fs.writeFile(fixture.foreignUnit, `[Unit]\nDescription=Synthetic foreign unit (OpenHeimdall native test fixture)\n\n[Service]\nType=simple\nExecStart=/bin/sh ${script}\n`);
    const linked = await systemctlUser('link', fixture.foreignUnit);
    assert.equal(linked.status, 0, `${linked.stdout}\n${linked.stderr}`);
    const reloaded = await systemctlUser('daemon-reload');
    assert.equal(reloaded.status, 0, reloaded.stderr);

    assert.equal(await fs.readlink(fixture.linkPath), fixture.foreignUnit, 'the expected link names the foreign unit');
    fixture.initial = await observe();
    const properties = fixture.initial.properties;
    t.diagnostic(`real-native systemd: FragmentPath=${properties.FragmentPath} (expected link ${fixture.linkPath}, foreign unit ${fixture.foreignUnit}, owned definition ${fixture.ownedDefinition}); LoadState=${properties.LoadState} ActiveState=${properties.ActiveState} UnitFileState=${properties.UnitFileState}`);
    assert.equal(properties.LoadState, 'loaded');
    assert.equal(properties.ActiveState, 'inactive');
    assert.ok([fixture.linkPath, fixture.foreignUnit].includes(properties.FragmentPath), `unexpected FragmentPath ${properties.FragmentPath}`);
    assert.notEqual(properties.FragmentPath, fixture.ownedDefinition);
    assert.notEqual(await fs.realpath(properties.FragmentPath), await fs.realpath(fixture.ownedDefinition));
    const inspection = await fixture.adapter.inspect();
    assert.equal(inspection.registeredPath, properties.FragmentPath);
    const ownership = await fixture.adapter.registrationOwnership(inspection);
    assert.equal(ownership.kind, 'refused', JSON.stringify(ownership));
    assert.equal(ownership.code, 'registered-elsewhere');
  });

  foreign('public start refuses the foreign unit and mutates nothing', async t => {
    assert.ok(fixture.initial, 'the link case must run first');
    const result = await lifecycle('start', ['--timeout', '30', '--env-file', fixture.credentials]);
    t.diagnostic(`start: exit ${result.status}, outcome ${result.document.outcome}, error ${result.document.error?.code}: ${result.document.message}`);
    assert.notEqual(result.status, 0);
    assert.equal(result.document.ok, false);
    assert.ok(!['ready', 'already-running', 'stopped', 'already-stopped'].includes(result.document.outcome), result.document.outcome);
    assert.equal(result.document.outcome, 'conflict');
    assertRefusedUntouched('start', await observe());
  });

  foreign('public stop refuses the foreign unit, sends no shutdown request and mutates nothing', async t => {
    assert.ok(fixture.initial, 'the link case must run first');
    const result = await lifecycle('stop', ['--timeout', '30']);
    t.diagnostic(`stop: exit ${result.status}, outcome ${result.document.outcome}, error ${result.document.error?.code}: ${result.document.message}`);
    assert.notEqual(result.status, 0);
    assert.equal(result.document.ok, false);
    assert.ok(!['stopped', 'already-stopped'].includes(result.document.outcome), result.document.outcome);
    assertRefusedUntouched('stop', await observe());
  });
});
