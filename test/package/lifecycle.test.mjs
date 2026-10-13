import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildTarball, installConsumer, installGlobal, isolatedEnvironment, removeTarballBuild, runBinary, runModule, toolVersions,
} from './helpers.mjs';

/*
 * `heimdall coordinator start|stop|logs` run through the installed bin of an ordinary consumer install and an ordinary global
 * install, from working directories outside the checkout, with HOME, state, npm prefix and cache all isolated.
 *
 * Nothing here starts a coordinator or touches a native service manager. The tests establish that:
 *   - installing the package and running `heimdall setup` register and start no service and write no service definition,
 *   - help, argument, configuration and credential failures fail before any side effect,
 *   - the service definition rendered by the installed package would run the absolute Node executable on the realpath of
 *     the installed `dist/cli.js`, and the native manager reports nothing registered for the isolated state directory.
 * Native registration, readiness and stop are exercised by test/native/lifecycle.native.test.mjs.
 */

const SENTINEL = 'hp-lifecycle-sentinel-credential';

// Short root: the default coordinator state directory must stay within the portable Unix socket path limit.
async function shortDirectory() {
  const base = await fs.access('/tmp').then(() => '/tmp', () => os.tmpdir());
  return await fs.realpath(await fs.mkdtemp(path.join(base, 'hl-')));
}

function syntheticProject(directory, home) {
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: directory, env, stdio: 'pipe' });
  git('init', '--quiet');
  git('commit', '--quiet', '--allow-empty', '-m', 'initial');
}

const exists = file => fs.lstat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });

// Service definitions and native-manager directories anywhere below `root`, without following symbolic links. Package
// contents (node_modules) and the npm cache are not part of what a user's installation registers.
async function serviceEvidence(root) {
  const found = [];
  const visit = async directory => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === 'npm-cache' || entry.name === '_cacache') continue;
      const location = path.join(directory, entry.name);
      if (/\.(plist|service)$/.test(entry.name) || ['LaunchAgents', 'LaunchDaemons', 'systemd'].includes(entry.name)) found.push(location);
      if (entry.isDirectory()) await visit(location);
    }
  };
  await visit(root);
  return found;
}

// Node prints an ExperimentalWarning for node:sqlite on child process stderr; it is not part of the CLI contract.
const quiet = stderr => stderr.split('\n').filter(line => line && !/ExperimentalWarning|--trace-warnings/.test(line)).join('\n');

const probe = `
  import { pathToFileURL } from 'node:url';
  import path from 'node:path';
  const { root, realDefault } = JSON.parse(process.env.LAUNCH_PROBE);
  const dist = file => import(pathToFileURL(path.join(root, 'dist', file)).href);
  const { resolveLaunchContext } = await dist('coordinator/launch-context.js');
  const { nativeServiceNames } = await dist('coordinator/native/types.js');
  const { selectNativeAdapter } = await dist('coordinator/native/platform.js');
  const { launchdDefinition, renderLaunchdPlist } = await dist('coordinator/native/launchd.js');
  const { systemdDefinition, renderSystemdUnit, parseExecStart } = await dist('coordinator/native/systemd.js');
  const context = await resolveLaunchContext({}, process.env);
  const names = nativeServiceNames(context.configuration.stateDirectory);
  const launchd = launchdDefinition(context, names.launchdLabel);
  const systemd = systemdDefinition(context, names.systemdUnit);
  const unitText = renderSystemdUnit(systemd);
  const execLine = unitText.split('\\n').find(line => line.startsWith('ExecStart='));
  const selection = selectNativeAdapter({ context });
  const inspection = selection.supported ? await selection.adapter.inspect() : null;
  process.stdout.write(JSON.stringify({
    nodeExecutable: context.nodeExecutable,
    entryPoint: context.entryPoint,
    stateDirectory: context.configuration.stateDirectory,
    names,
    defaultIdentity: nativeServiceNames(realDefault).identity,
    manager: selection.supported ? selection.manager : null,
    launchdArguments: launchd.ProgramArguments,
    plist: renderLaunchdPlist(launchd),
    unitText,
    execStart: systemd.execStart,
    execStartRoundTrip: parseExecStart(execLine.slice('ExecStart='.length)),
    inspection,
  }));
`;

describe('installed heimdall coordinator lifecycle commands', () => {
  let build;
  let work;
  let environment;
  const installs = {};

  before(async () => {
    build = await buildTarball();
    work = await shortDirectory();
    environment = await isolatedEnvironment(work);
    installs.consumer = await installConsumer(build.tarball, { env: environment.env, directory: path.join(work, 'consumer') });
    const elsewhere = path.join(work, 'elsewhere');
    await fs.mkdir(elsewhere);
    installs.global = await installGlobal(build.tarball, { env: environment.env, prefix: path.join(work, 'global-prefix'), cwd: elsewhere });
  });

  after(async () => {
    if (work) await fs.rm(work, { recursive: true, force: true });
    await removeTarballBuild();
  });

  test('installing the package registers no service and creates no definition', async t => {
    t.diagnostic(`environment: ${await toolVersions(environment.env)}`);
    for (const layout of ['consumer', 'global']) {
      const install = installs[layout];
      assert.ok(await exists(install.bin), `${layout}: bin ${install.bin} installed`);
    }
    const evidence = await serviceEvidence(work);
    assert.deepEqual(evidence, [], 'installation created service definitions or native manager directories');
    assert.equal(await exists(path.join(environment.home, 'Library')), false, 'installation touched HOME/Library');
    assert.equal(await exists(path.join(environment.home, '.local', 'state', 'heimdall')), false, 'installation created a coordinator state directory');
    t.diagnostic('after install: no *.plist, *.service, LaunchAgents or systemd entries below the isolated HOME, npm prefix and consumer');
  });

  for (const layout of ['consumer', 'global']) {
    test(`${layout} install: setup registers nothing; help, argument and configuration failures happen outside the checkout without side effects`, async t => {
      const install = installs[layout];
      const sandbox = path.join(work, `run-${layout}`);
      const home = path.join(sandbox, 'home');
      const project = path.join(sandbox, 'project');
      const openchamber = path.join(sandbox, 'openchamber');
      const cwd = path.join(sandbox, 'a directory with spaces');
      await Promise.all([home, project, openchamber, cwd].map(directory => fs.mkdir(directory, { recursive: true, mode: 0o700 })));
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
      // Unset, not empty: the defaults under HOME must apply, and an empty selection is itself an error.
      for (const name of ['HEIMDALL_CONFIG', 'HEIMDALL_COORDINATOR_CONFIG', 'OPENCODE_PASSWORD']) delete env[name];
      // Lets the read-only native inspection below see a user manager when the host has one.
      for (const name of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS']) if (process.env[name]) env[name] = process.env[name];
      const options = { cwd, env };
      const stateDirectory = path.join(await fs.realpath(home), '.local', 'state', 'heimdall');
      assert.ok(!cwd.startsWith(await fs.realpath(path.resolve(import.meta.dirname, '..', '..'))), 'commands run outside the checkout');

      const setup = await runBinary(install, [
        'setup', '--no-input', '--json', '--project', project,
        '--planner-model', 'anthropic/planner-x', '--executor-model', 'openai/executor-x', '--quota-provider', 'openai',
        '--opencode-url', 'http://127.0.0.1:9', '--opencode-auth', 'none',
      ], options);
      assert.equal(setup.status, 0, `${setup.stdout}\n${setup.stderr}`);
      const configurationFile = path.join(home, '.config', 'heimdall', 'coordinator.toml');
      assert.ok(await exists(configurationFile), 'setup wrote the coordinator configuration');
      const noService = async label => {
        assert.deepEqual(await serviceEvidence(sandbox), [], `${label}: a service definition or manager directory exists`);
        assert.equal(await exists(stateDirectory), false, `${label}: the coordinator state directory was created`);
      };
      await noService('after setup');

      // Help for every lifecycle command.
      for (const command of ['start', 'stop', 'logs']) {
        const help = await runBinary(install, ['coordinator', command, '--help'], options);
        assert.equal(help.status, 0, help.stderr);
        assert.match(help.stdout, new RegExp(`^heimdall coordinator ${command} `), `${command} help starts with its usage line`);
        assert.equal(quiet(help.stderr), '');
      }
      await noService('after help');

      // Argument failures: exit 2 before (an existing file stands in for the stray --env-file value: Node itself rejects
      // a nonexistent --env-file anywhere on its command line before the script runs) any configuration, state or manager is consulted.
      for (const args of [
        ['start', '--bogus'], ['start', '--timeout', '0'], ['start', '--timeout', 'abc', '--json'], ['start', 'extra'], ['start', '--lines', '5'],
        ['stop', '--no-wait', '--timeout', '5'], ['stop', '--env-file', configurationFile], ['logs', '--lines', '0'], ['logs', '--json'], ['logs', '--follow', '--follow'],
      ]) {
        const result = await runBinary(install, ['coordinator', ...args], options);
        assert.equal(result.status, 2, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
        if (args.includes('--json') && args[0] !== 'logs') {
          const document = JSON.parse(result.stdout);
          assert.equal(document.ok, false);
          assert.equal(document.error.code, 'invalid-arguments');
          assert.equal(document.target, null);
        } else assert.equal(result.stdout, '', `${args.join(' ')} wrote to stdout`);
      }
      await noService('after argument failures');

      // Configuration failures: an absent or invalid explicitly selected file fails before any launch.
      const missing = path.join(cwd, 'missing coordinator.toml');
      const invalid = path.join(cwd, 'invalid.toml');
      await fs.writeFile(invalid, 'stateDirectory = [not valid');
      for (const [label, args, extra] of [
        ['missing flag file', ['start', '--coordinator-config', missing, '--json'], {}],
        ['invalid flag file', ['start', '--coordinator-config', invalid, '--json'], {}],
        ['missing environment file', ['start', '--json'], { HEIMDALL_COORDINATOR_CONFIG: missing }],
        ['missing file for stop', ['stop', '--coordinator-config', missing, '--json'], {}],
      ]) {
        const result = await runBinary(install, ['coordinator', ...args], { cwd, env: { ...env, ...extra } });
        assert.equal(result.status, 1, `${label}: ${result.stdout}${result.stderr}`);
        const document = JSON.parse(result.stdout);
        assert.equal(document.ok, false, label);
        assert.equal(document.error.code, 'invalid-configuration', label);
        assert.equal(document.target, null, label);
      }
      const missingLogs = await runBinary(install, ['coordinator', 'logs', '--coordinator-config', missing], options);
      assert.equal(missingLogs.status, 1);
      assert.equal(missingLogs.stdout, '');
      await noService('after configuration failures');

      // Credential failure: a group-readable file is refused before any launch, and its value is never echoed.
      const loose = path.join(cwd, 'loose.env');
      await fs.writeFile(loose, `OPENCODE_PASSWORD=${SENTINEL}\n`, { mode: 0o644 });
      await fs.chmod(loose, 0o644);
      const credentials = await runBinary(install, ['coordinator', 'start', '--env-file', loose, '--json'], options);
      assert.equal(credentials.status, 1, `${credentials.stdout}${credentials.stderr}`);
      assert.equal(JSON.parse(credentials.stdout).error.code, 'invalid-credentials');
      assert.ok(!(credentials.stdout + credentials.stderr).includes(SENTINEL), 'credential value leaked');
      await noService('after credential failure');

      // Nothing has run yet, so stop and logs have nothing to act on and change nothing.
      const stop = await runBinary(install, ['coordinator', 'stop', '--json'], options);
      assert.equal(stop.status, 1, `${stop.stdout}${stop.stderr}`);
      assert.equal(JSON.parse(stop.stdout).error.code, 'not-managed');
      const logs = await runBinary(install, ['coordinator', 'logs'], options);
      assert.equal(logs.status, 1);
      assert.equal(logs.stdout, '');
      assert.match(logs.stderr, /no logs/i);
      await noService('after stop and logs on an unused state directory');

      // The definition the installed package would register: absolute Node, realpath of the installed entry point.
      const realDefault = path.join(await fs.realpath(os.userInfo().homedir), '.local', 'state', 'heimdall');
      const rendered = await runModule(probe, { cwd, env: { ...env, LAUNCH_PROBE: JSON.stringify({ root: install.root, realDefault }) } });
      assert.equal(rendered.status, 0, rendered.stderr);
      const result = JSON.parse(rendered.stdout);
      const entry = await fs.realpath(path.join(install.root, 'dist', 'cli.js'));
      assert.equal(result.entryPoint, entry);
      assert.equal(await fs.realpath(install.bin), entry, 'the installed bin resolves to the same entry point');
      assert.ok(path.isAbsolute(result.nodeExecutable), 'Node is referenced by absolute path');
      assert.equal(result.nodeExecutable, process.execPath);
      assert.ok(entry.startsWith(await fs.realpath(install.directory)), 'entry point is inside the installation');
      assert.ok(!entry.startsWith(await fs.realpath(path.resolve(import.meta.dirname, '..', '..'))), 'entry point is not in the checkout');
      assert.deepEqual(result.launchdArguments.slice(0, 2), [process.execPath, entry]);
      assert.deepEqual(result.launchdArguments.slice(2, 5), ['coordinator', 'serve', '--coordinator-config']);
      assert.deepEqual(result.execStart.slice(0, 2), [process.execPath, entry]);
      assert.deepEqual(result.execStartRoundTrip, result.execStart, 'the rendered ExecStart reads back as the same literal words');
      assert.ok(result.plist.includes(`<string>${entry}</string>`));
      assert.match(result.plist, /<key>RunAtLoad<\/key>\s*<false\/>/);
      assert.match(result.plist, /<key>KeepAlive<\/key>\s*<false\/>/);
      assert.doesNotMatch(result.unitText, /\[Install\]|WantedBy|Restart=(?!no)/);
      assert.equal(result.stateDirectory, stateDirectory);

      // Production identity logic on the isolated state: unique names, and not those of the real default state.
      assert.match(result.names.launchdLabel, /^dev\.openheimdall\.coordinator\.[0-9a-f]{24}$/);
      assert.match(result.names.systemdUnit, /^heimdall-coordinator-[0-9a-f]{24}\.service$/);
      assert.notEqual(result.names.identity, result.defaultIdentity, 'the fixture identity must differ from the real default state');

      // Read-only native inspection of the derived, fixture-unique name: nothing is registered or running.
      assert.ok(result.inspection, `no native manager for ${process.platform}`);
      assert.notEqual(result.inspection.registration, 'loaded', result.inspection.detail);
      assert.notEqual(result.inspection.running, true, result.inspection.detail);
      if (result.manager === 'launchd') assert.equal(result.inspection.registration, 'not-loaded', result.inspection.detail);
      t.diagnostic(`${layout}: ${result.manager} inspection of ${result.manager === 'launchd' ? result.names.launchdLabel : result.names.systemdUnit}: ${result.inspection.registration}/${String(result.inspection.running)} (${result.inspection.detail})`);
      await noService('after rendering and read-only inspection');
    });
  }
});
