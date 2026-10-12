import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  CONFIG_ORIGIN_VARIABLE, MANAGER_LABEL_VARIABLE, implicitDefaultMarkerApplies, managerLabelFromEnvironment, resolveLaunchContext, selectConfigurationFile,
} from '../dist/coordinator/launch-context.js';
import { defaultCoordinatorConfigurationFile, loadCoordinatorConfiguration } from '../dist/coordinator/config.js';
import {
  createLaunchdAdapter, definitionChanges, launchdDefinition, launchdPaths, parseLaunchctlPrint, parsePlist, renderLaunchdPlist,
} from '../dist/coordinator/native/launchd.js';
import { createExecFileRunner, launchNativeService, nativeServiceNames } from '../dist/coordinator/native/types.js';

const posix = process.platform !== 'win32';
const UID = 501;
// Short roots keep the state directory's Unix socket path within its portable limit.
const SPECIAL_STATE = '\'s"$;&<`';
const SPECIAL_ENTRY_DIRECTORY = 'my dir \'q\' "d" $HOME `x`; & <t>';

async function temporaryRoot(t) {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/hd-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

/** A state directory with special characters, a configuration selecting it, and a stand-in installed entry point. */
async function fixture(t, { entryName = 'cli.js' } = {}) {
  const root = await temporaryRoot(t);
  const stateDirectory = path.join(root, SPECIAL_STATE);
  await fs.mkdir(stateDirectory, { mode: 0o700 });
  await fs.chmod(stateDirectory, 0o700);
  const configFile = path.join(root, 'coordinator.toml');
  await fs.writeFile(configFile, `[coordinator]\nstateDirectory = ${JSON.stringify(stateDirectory)}\n`);
  const entryDirectory = path.join(root, SPECIAL_ENTRY_DIRECTORY);
  await fs.mkdir(entryDirectory);
  const entryPoint = path.join(entryDirectory, entryName);
  await fs.writeFile(entryPoint, '// stand-in entry point\n');
  const home = path.join(root, 'home');
  await fs.mkdir(home);
  return { root, stateDirectory, configFile, entryPoint, entryDirectory, home };
}

const contextFor = (f, extra = {}, environment = {}) => resolveLaunchContext(
  { coordinatorConfig: f.configFile, entryPoint: f.entryPoint, ...extra },
  { HOME: f.home, ...environment },
);

/** Stateful launchctl stand-in. Records every invocation; refuses options that could stop a running instance. */
function fakeLaunchd({ label, uid = UID } = {}) {
  const target = label ? `gui/${uid}/${label}` : null;
  const state = { loaded: false, running: false, path: null, pid: 4242, printOverride: null, failBootstrap: false, failKickstart: false, calls: [] };
  const runner = {
    state,
    async run(file, args) {
      state.calls.push({ file, args: [...args] });
      const [verb, ...rest] = args;
      assert.equal(file, '/bin/launchctl');
      assert.ok(!args.includes('-k'), 'a start request must never ask launchd to kill a running instance');
      assert.ok(!['kill', 'stop', 'remove', 'unload', 'load', 'enable', 'disable'].includes(verb), `unexpected launchctl verb ${verb}`);
      if (verb === 'print') {
        if (state.printOverride) return state.printOverride;
        if (!state.loaded) return { exitCode: 113, stdout: '', stderr: `Could not find service "${rest[0].split('/').pop()}" in domain for user gui: ${UID}\n` };
        return { exitCode: 0, stderr: '', stdout: [
          `${target ?? rest[0]} = {`,
          `\tactive count = ${state.running ? 1 : 0}`,
          `\tpath = ${state.path}`,
          '\ttype = LaunchAgent',
          `\tstate = ${state.running ? 'running' : 'not running'}`,
          '\n\targuments = {', '\t\t/some/node', '\t\tstate = not-the-service-state', '\t}',
          '\n\tenvironment = {', '\t\tHOME => /home/x', '\t}',
          ...(state.running ? [`\tpid = ${state.pid}`] : ['\tlast exit code = (never exited)']),
          '}', '',
        ].join('\n') };
      }
      if (verb === 'bootstrap') {
        if (state.failBootstrap) return { exitCode: 5, stdout: '', stderr: 'Bootstrap failed: 5: Input/output error\n' };
        assert.equal(rest[0], `gui/${uid}`);
        state.loaded = true; state.running = false; state.path = rest[1];
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (verb === 'kickstart') {
        if (state.failKickstart) return { exitCode: 113, stdout: '', stderr: 'kickstart failed\n' };
        state.running = true;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (verb === 'bootout') { state.loaded = false; state.running = false; state.path = null; return { exitCode: 0, stdout: '', stderr: '' }; }
      throw new Error(`unhandled launchctl verb ${verb}`);
    },
  };
  return runner;
}

const verbs = runner => runner.state.calls.map(call => call.args[0]);
const mode = async file => (await fs.stat(file)).mode & 0o777;

async function adapterFor(f, { extra, environment, runner } = {}) {
  const context = await contextFor(f, extra, environment);
  const label = nativeServiceNames(context.configuration.stateDirectory).launchdLabel;
  const fake = runner ?? fakeLaunchd({ label });
  return { context, label, fake, adapter: createLaunchdAdapter({ context, runner: fake, uid: UID }), paths: launchdPaths(context.configuration.stateDirectory, label) };
}

test('launch context resolves exact literal program arguments independent of the working directory', async t => {
  const f = await fixture(t);
  const original = process.cwd();
  t.after(() => process.chdir(original));
  const outsideA = await fs.realpath(await fs.mkdtemp('/tmp/hd-cwd-'));
  const outsideB = await fs.realpath(await fs.mkdtemp('/tmp/hd-cwd-'));
  t.after(() => Promise.all([outsideA, outsideB].map(dir => fs.rm(dir, { recursive: true, force: true }))));
  process.chdir(f.root);
  const first = await resolveLaunchContext({ coordinatorConfig: 'coordinator.toml', entryPoint: f.entryPoint }, { HOME: f.home });
  process.chdir(outsideA);
  const second = await resolveLaunchContext({ coordinatorConfig: path.join(f.root, 'coordinator.toml'), entryPoint: f.entryPoint }, { HOME: f.home });
  process.chdir(outsideB);
  const third = await resolveLaunchContext({ coordinatorConfig: path.join(f.root, 'coordinator.toml'), entryPoint: f.entryPoint }, { HOME: f.home });
  assert.deepEqual(first, second);
  assert.deepEqual(second, third);
  assert.equal(first.nodeExecutable, process.execPath);
  assert.ok(path.isAbsolute(first.nodeExecutable));
  assert.equal(first.entryPoint, await fs.realpath(f.entryPoint));
  assert.deepEqual(first.arguments, ['coordinator', 'serve', '--coordinator-config', f.configFile]);
  assert.equal(first.configuration.stateDirectory, f.stateDirectory);
  assert.deepEqual(first.environment, { HOME: f.home, [CONFIG_ORIGIN_VARIABLE]: 'flag' });
});

test('launch context entry point is the real path of the installed dist/cli.js', async t => {
  const f = await fixture(t);
  const link = path.join(f.root, 'link-cli.js');
  await fs.symlink(f.entryPoint, link);
  const context = await contextFor(f, { entryPoint: link });
  assert.equal(context.entryPoint, await fs.realpath(f.entryPoint));
  const actual = await resolveLaunchContext({ coordinatorConfig: f.configFile }, { HOME: f.home });
  assert.equal(actual.entryPoint, await fs.realpath(path.resolve(import.meta.dirname, '../dist/cli.js')));
  await assert.rejects(contextFor(f, { entryPoint: path.join(f.root, 'missing.js') }), /entry point was not found/);
  await assert.rejects(contextFor(f, { entryPoint: f.entryDirectory }), /not a file/);
  await assert.rejects(contextFor(f, { nodeExecutable: path.join(f.root, 'no-node') }), /Node executable is not available/);
  await assert.rejects(contextFor(f, { entryPoint: 'relative.js' }), /absolute path/);
});

test('configuration origin is recorded as flag, env or implicit-default', async t => {
  const f = await fixture(t);
  const byFlag = await resolveLaunchContext({ coordinatorConfig: f.configFile, entryPoint: f.entryPoint }, { HOME: f.home });
  assert.equal(byFlag.configuration.origin, 'flag');
  assert.equal(byFlag.environment[CONFIG_ORIGIN_VARIABLE], 'flag');
  const byEnvironment = await resolveLaunchContext({ entryPoint: f.entryPoint }, { HOME: f.home, HEIMDALL_COORDINATOR_CONFIG: f.configFile });
  assert.equal(byEnvironment.configuration.origin, 'env');
  assert.equal(byEnvironment.environment[CONFIG_ORIGIN_VARIABLE], 'env');
  assert.deepEqual(byEnvironment.arguments, ['coordinator', 'serve', '--coordinator-config', f.configFile]);
  // The flag takes precedence over the environment, matching the loader.
  const both = await resolveLaunchContext({ coordinatorConfig: f.configFile, entryPoint: f.entryPoint }, { HOME: f.home, HEIMDALL_COORDINATOR_CONFIG: path.join(f.root, 'other.toml') });
  assert.equal(both.configuration.origin, 'flag');
  assert.throws(() => selectConfigurationFile(undefined, { HEIMDALL_COORDINATOR_CONFIG: '' }), /set but empty/);
  assert.throws(() => selectConfigurationFile('', {}), /nonempty/);
});

test('explicit configuration selections fail when the file is absent; the implicit default stays optional', { skip: !posix }, async t => {
  const f = await fixture(t);
  const missing = path.join(f.root, 'absent.toml');
  await assert.rejects(resolveLaunchContext({ coordinatorConfig: missing, entryPoint: f.entryPoint }, { HOME: f.home }), { code: 'ENOENT' });
  await assert.rejects(resolveLaunchContext({ entryPoint: f.entryPoint }, { HOME: f.home, HEIMDALL_COORDINATOR_CONFIG: missing }), { code: 'ENOENT' });

  const previousHome = process.env.HOME;
  const previousSelection = process.env.HEIMDALL_COORDINATOR_CONFIG;
  t.after(() => { process.env.HOME = previousHome; if (previousSelection === undefined) delete process.env.HEIMDALL_COORDINATOR_CONFIG; else process.env.HEIMDALL_COORDINATOR_CONFIG = previousSelection; });
  process.env.HOME = f.home;
  delete process.env.HEIMDALL_COORDINATOR_CONFIG;
  const defaultFile = defaultCoordinatorConfigurationFile();
  assert.equal(defaultFile, path.join(f.home, '.config', 'heimdall', 'coordinator.toml'));
  await assert.rejects(fs.stat(defaultFile));

  const implicit = await resolveLaunchContext({ entryPoint: f.entryPoint }, { HOME: f.home });
  assert.equal(implicit.configuration.origin, 'implicit-default');
  assert.equal(implicit.configuration.file, defaultFile);
  assert.equal(implicit.environment[CONFIG_ORIGIN_VARIABLE], 'implicit-default');
  assert.equal(implicit.configuration.stateDirectory, path.join(f.home, '.local', 'state', 'heimdall'));
  assert.deepEqual(implicit.arguments, ['coordinator', 'serve', '--coordinator-config', defaultFile]);

  // The serve process receives the resolved default plus the marker and treats it exactly like no selector.
  assert.equal(implicitDefaultMarkerApplies(defaultFile, { [CONFIG_ORIGIN_VARIABLE]: 'implicit-default' }), true);
  assert.equal(implicitDefaultMarkerApplies(defaultFile, {}), false);
  assert.equal(implicitDefaultMarkerApplies(defaultFile, { [CONFIG_ORIGIN_VARIABLE]: 'flag' }), false);
  assert.equal(implicitDefaultMarkerApplies(defaultFile, { [CONFIG_ORIGIN_VARIABLE]: 'env' }), false);
  assert.equal(implicitDefaultMarkerApplies(missing, { [CONFIG_ORIGIN_VARIABLE]: 'implicit-default' }), false, 'the marker cannot make another file optional');
  assert.equal(implicitDefaultMarkerApplies(undefined, { [CONFIG_ORIGIN_VARIABLE]: 'implicit-default' }), false);
  const optional = await loadCoordinatorConfiguration(defaultFile, { implicitDefault: true });
  assert.equal(optional.stateDirectory, implicit.configuration.stateDirectory);
  await assert.rejects(loadCoordinatorConfiguration(defaultFile), { code: 'ENOENT' });
});

test('implicit default carries a real default file and keeps a malformed file fatal', { skip: !posix }, async t => {
  const f = await fixture(t);
  const previousHome = process.env.HOME;
  t.after(() => { process.env.HOME = previousHome; });
  process.env.HOME = f.home;
  const defaultFile = defaultCoordinatorConfigurationFile();
  await fs.mkdir(path.dirname(defaultFile), { recursive: true });
  await fs.writeFile(defaultFile, '[coordinator]\nbogus = 1\n');
  await assert.rejects(loadCoordinatorConfiguration(defaultFile, { implicitDefault: true }), /Unknown coordinator setting/);
  await fs.writeFile(defaultFile, `[coordinator]\nstateDirectory = ${JSON.stringify(f.stateDirectory)}\n`);
  const context = await resolveLaunchContext({ entryPoint: f.entryPoint }, { HOME: f.home });
  assert.equal(context.configuration.stateDirectory, f.stateDirectory);
});

test('the native service marker accepts only labels derived from this state directory', async t => {
  const f = await fixture(t);
  const names = nativeServiceNames(f.stateDirectory);
  assert.equal(managerLabelFromEnvironment(f.stateDirectory, {}), undefined);
  assert.equal(managerLabelFromEnvironment(f.stateDirectory, { [MANAGER_LABEL_VARIABLE]: '' }), undefined);
  assert.equal(managerLabelFromEnvironment(f.stateDirectory, { [MANAGER_LABEL_VARIABLE]: names.launchdLabel }), names.launchdLabel);
  assert.throws(() => managerLabelFromEnvironment(f.stateDirectory, { [MANAGER_LABEL_VARIABLE]: 'dev.openheimdall.coordinator.other' }), /does not belong/);
  assert.notEqual(nativeServiceNames(path.join(f.root, 'elsewhere')).launchdLabel, names.launchdLabel);
});

test('credential file input is carried as a path only and never as contents', async t => {
  const f = await fixture(t);
  const secretFile = path.join(f.root, 'credentials.env');
  await fs.writeFile(secretFile, 'OPENCODE_SERVER_PASSWORD=synthetic-secret-value-123\n', { mode: 0o600 });
  const { adapter, context } = await adapterFor(f, { extra: { envFile: secretFile } });
  assert.equal(context.credentialFile, secretFile);
  assert.deepEqual(context.arguments.slice(-2), ['--env-file', secretFile]);
  const text = adapter.render();
  assert.ok(!text.includes('synthetic-secret-value-123'));
  assert.ok(!text.includes('OPENCODE_SERVER_PASSWORD'));
  await assert.rejects(contextFor(f, { envFile: path.join(f.root, 'absent.env') }));
});

test('plist renders the exact policy and literal arguments for paths with spaces, quotes and metacharacters', async t => {
  const f = await fixture(t);
  const { adapter, context, label, paths } = await adapterFor(f, { environment: { OPENCHAMBER_DATA_DIR: path.join(f.root, 'data dir') } });
  const text = adapter.render();
  const parsed = parsePlist(text);
  assert.deepEqual(Object.keys(parsed).sort(), ['EnvironmentVariables', 'KeepAlive', 'Label', 'ProgramArguments', 'RunAtLoad', 'StandardErrorPath', 'StandardOutPath']);
  assert.equal(parsed.Label, label);
  assert.equal(parsed.RunAtLoad, false);
  assert.equal(parsed.KeepAlive, false);
  assert.deepEqual(parsed.ProgramArguments, [process.execPath, await fs.realpath(f.entryPoint), 'coordinator', 'serve', '--coordinator-config', f.configFile]);
  assert.ok(parsed.ProgramArguments[1].includes(SPECIAL_ENTRY_DIRECTORY));
  assert.equal(parsed.EnvironmentVariables.OPENCHAMBER_DATA_DIR, path.join(f.root, 'data dir'));
  assert.deepEqual({ ...parsed.EnvironmentVariables }, {
    HOME: f.home, [CONFIG_ORIGIN_VARIABLE]: 'flag', [MANAGER_LABEL_VARIABLE]: label, OPENCHAMBER_DATA_DIR: path.join(f.root, 'data dir'),
  });
  assert.equal(parsed.StandardOutPath, paths.standardOut);
  assert.equal(parsed.StandardErrorPath, paths.standardError);
  assert.ok(paths.standardOut.startsWith(f.stateDirectory + path.sep) && paths.standardError.startsWith(f.stateDirectory + path.sep));
  for (const forbidden of ['WatchPaths', 'StartInterval', 'StartCalendarInterval', 'Sockets', 'QueueDirectories', 'StartOnMount', 'LaunchEvents', 'ThrottleInterval', 'AbandonProcessGroup']) {
    assert.ok(!text.includes(`<key>${forbidden}</key>`), `${forbidden} must not be rendered`);
  }
  assert.match(text, /<key>RunAtLoad<\/key>\s*<false\/>/);
  assert.match(text, /<key>KeepAlive<\/key>\s*<false\/>/);
  // Arguments are elements of an array: no shell, no command string, no interpolation.
  assert.ok(!/\/bin\/(ba|z)?sh|<string>-c<\/string>/.test(text));
  assert.ok(text.includes('&quot;') && text.includes('&apos;') && text.includes('&amp;') && text.includes('&lt;'));
  assert.deepEqual(parsePlist(renderLaunchdPlist(launchdDefinition(context, label))), parsed);
  if (process.platform === 'darwin') {
    const file = path.join(f.root, 'lint.plist');
    await fs.writeFile(file, text);
    assert.match(execFileSync('/usr/bin/plutil', ['-lint', file], { encoding: 'utf8' }), /OK/);
    const converted = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));
    assert.deepEqual(converted.ProgramArguments, parsed.ProgramArguments);
    assert.equal(converted.RunAtLoad, false);
    assert.equal(converted.KeepAlive, false);
  }
});

test('plist carries no secrets even when the environment holds them', async t => {
  const f = await fixture(t);
  const { adapter } = await adapterFor(f, { environment: { OPENCODE_SERVER_PASSWORD: 'synthetic-password-xyz', PATH: '/usr/bin', ANTHROPIC_API_KEY: 'synthetic-key-abc' } });
  const text = adapter.render();
  for (const leaked of ['synthetic-password-xyz', 'synthetic-key-abc', 'OPENCODE_SERVER_PASSWORD', 'ANTHROPIC_API_KEY']) assert.ok(!text.includes(leaked));
});

test('install creates the private definition, directories and log files, then registers without starting', { skip: !posix }, async t => {
  const f = await fixture(t);
  const { adapter, fake, label, paths } = await adapterFor(f);
  const result = await adapter.install();
  assert.equal(result.outcome, 'created');
  assert.equal(result.registered, true);
  assert.deepEqual(fake.state.calls.map(call => call.args), [['print', `gui/${UID}/${label}`], ['bootstrap', `gui/${UID}`, paths.definition]]);
  assert.equal(await fs.readFile(paths.definition, 'utf8'), adapter.render());
  assert.equal(paths.definition, path.join(f.stateDirectory, 'service', `${label}.plist`));
  assert.ok(!paths.definition.includes('LaunchAgents'), 'the definition lives in private state, not the shared LaunchAgents directory');
  assert.equal(await mode(paths.definition), 0o600);
  assert.equal(await mode(paths.serviceDirectory), 0o700);
  assert.equal(await mode(paths.logDirectory), 0o700);
  assert.equal(await mode(paths.standardOut), 0o600);
  assert.equal(await mode(paths.standardError), 0o600);
  assert.equal(fake.state.running, false, 'install never starts the service');
});

test('start is an explicit kickstart without kill-existing and only after bootstrap', { skip: !posix }, async t => {
  const f = await fixture(t);
  const { adapter, fake, label } = await adapterFor(f);
  const launched = await launchNativeService(adapter);
  assert.equal(launched.outcome, 'started');
  assert.deepEqual(fake.state.calls.map(call => call.args), [
    ['print', `gui/${UID}/${label}`],
    ['bootstrap', `gui/${UID}`, adapter.identity().definitionPath],
    ['print', `gui/${UID}/${label}`],
    ['kickstart', `gui/${UID}/${label}`],
  ]);
  assert.ok(!verbs(fake).some(verb => ['bootout', 'kill', 'stop'].includes(verb)));
  assert.equal(fake.state.running, true);
  assert.ok(fake.state.calls.every(call => call.file === '/bin/launchctl' && call.args.every(argument => typeof argument === 'string')));
});

test('start does not touch a service that is already running', { skip: !posix }, async t => {
  const f = await fixture(t);
  const { adapter, fake } = await adapterFor(f);
  await launchNativeService(adapter);
  fake.state.calls.length = 0;
  const again = await launchNativeService(adapter);
  assert.equal(again.outcome, 'already-running');
  assert.equal(again.install.outcome, 'unchanged');
  assert.ok(verbs(fake).every(verb => verb === 'print'), `only read-only calls expected, saw ${verbs(fake)}`);
});

test('a definition left on disk after the user session ended is reused and re-registered unchanged', { skip: !posix }, async t => {
  const f = await fixture(t, { entryName: 'cli.js' });
  const first = await adapterFor(f);
  await first.adapter.install();
  const before = await fs.readFile(first.paths.definition, 'utf8');
  const second = await adapterFor(f);
  const result = await second.adapter.install();
  assert.equal(result.outcome, 'unchanged');
  assert.equal(result.registered, true);
  assert.deepEqual(verbs(second.fake), ['print', 'bootstrap']);
  assert.equal(await fs.readFile(first.paths.definition, 'utf8'), before, 'special characters round-trip through the owned-definition check');
});

test('a loaded running definition is never replaced when the launch context changed', { skip: !posix }, async t => {
  const f = await fixture(t);
  const first = await adapterFor(f);
  await launchNativeService(first.adapter);
  const before = await fs.readFile(first.paths.definition, 'utf8');
  const otherEntry = path.join(f.entryDirectory, 'other-cli.js');
  await fs.writeFile(otherEntry, '// another install\n');
  const changed = await adapterFor(f, { extra: { entryPoint: otherEntry }, runner: first.fake });
  first.fake.state.calls.length = 0;
  const result = await changed.adapter.install();
  assert.equal(result.outcome, 'conflict');
  assert.equal(result.conflicts[0].code, 'running-context-changed');
  assert.deepEqual(result.conflicts[0].changes, ['entry-point']);
  assert.match(result.conflicts[0].action, /heimdall coordinator stop/);
  assert.equal(await fs.readFile(first.paths.definition, 'utf8'), before);
  assert.deepEqual(verbs(first.fake), ['print']);
  const launched = await launchNativeService(changed.adapter);
  assert.equal(launched.outcome, 'install-conflict');
  assert.equal(launched.start, null);
  assert.ok(!verbs(first.fake).some(verb => verb !== 'print'));
});

test('context changes are named by element', { skip: !posix }, async t => {
  const f = await fixture(t);
  const base = await adapterFor(f);
  const baseDefinition = launchdDefinition(base.context, base.label);
  const variants = [
    [{ ...base.context, nodeExecutable: '/another/node' }, 'executable'],
    [{ ...base.context, arguments: ['coordinator', 'serve', '--coordinator-config', '/other.toml'] }, 'configuration'],
    [{ ...base.context, environment: { ...base.context.environment, [CONFIG_ORIGIN_VARIABLE]: 'env' } }, 'configuration'],
    [{ ...base.context, arguments: [...base.context.arguments, '--env-file', '/c.env'] }, 'credential-source'],
    [{ ...base.context, environment: { ...base.context.environment, OPENCHAMBER_DATA_DIR: '/d' } }, 'data-directory'],
    [{ ...base.context, environment: { ...base.context.environment, HOME: '/h' } }, 'home'],
  ];
  for (const [context, expected] of variants) assert.ok(definitionChanges(baseDefinition, launchdDefinition(context, base.label)).includes(expected), expected);
  assert.deepEqual(definitionChanges(baseDefinition, baseDefinition), []);
});

test('an inactive stale registration is refreshed only after its absence is proven and unloaded', { skip: !posix }, async t => {
  const f = await fixture(t);
  const first = await adapterFor(f);
  await first.adapter.install();
  assert.equal(first.fake.state.loaded, true);
  const otherEntry = path.join(f.entryDirectory, 'next-cli.js');
  await fs.writeFile(otherEntry, '// next install\n');
  const next = await adapterFor(f, { extra: { entryPoint: otherEntry }, runner: first.fake });
  const stale = await next.adapter.install();
  assert.equal(stale.outcome, 'conflict');
  assert.equal(stale.conflicts[0].code, 'inactive-registration-stale');
  assert.equal(first.fake.state.loaded, true, 'install alone never unloads');
  const unloaded = await next.adapter.unloadInactive();
  assert.equal(unloaded.outcome, 'removed');
  assert.ok(first.fake.state.calls.some(call => call.args[0] === 'bootout' && call.args[1] === `gui/${UID}/${first.label}`));
  const refreshed = await next.adapter.install();
  assert.equal(refreshed.outcome, 'refreshed');
  assert.equal(refreshed.registered, true);
  assert.equal(await fs.readFile(first.paths.definition, 'utf8'), next.adapter.render());
  assert.equal(await mode(first.paths.definition), 0o600);
});

test('unloadInactive refuses while the process is running or its state is unknown, and never signals', { skip: !posix }, async t => {
  const f = await fixture(t);
  const { adapter, fake } = await adapterFor(f);
  await launchNativeService(adapter);
  fake.state.calls.length = 0;
  const running = await adapter.unloadInactive();
  assert.equal(running.outcome, 'refused');
  assert.deepEqual(verbs(fake), ['print']);
  fake.state.printOverride = { exitCode: 0, stdout: 'completely different format', stderr: '' };
  const unknown = await adapter.unloadInactive();
  assert.equal(unknown.outcome, 'refused');
  assert.ok(!verbs(fake).includes('bootout'));
  fake.state.printOverride = null;
  fake.state.running = false;
  fake.state.loaded = false;
  assert.equal((await adapter.unloadInactive()).outcome, 'nothing-to-remove');
});

test('unrecognized launchctl output is unknown and blocks every mutating call', { skip: !posix }, async t => {
  const f = await fixture(t);
  const { adapter, fake } = await adapterFor(f);
  const outputs = [
    { exitCode: 0, stdout: 'completely different format', stderr: '' },
    { exitCode: 0, stdout: '', stderr: '' },
    { exitCode: 1, stdout: '', stderr: 'Operation not permitted' },
    { exitCode: 113, stdout: '', stderr: 'something else entirely' },
    { exitCode: null, stdout: '', stderr: '', error: '/bin/launchctl could not run: ENOENT' },
  ];
  for (const output of outputs) {
    fake.state.printOverride = output;
    fake.state.calls.length = 0;
    const inspection = await adapter.inspect();
    assert.equal(inspection.registration, 'unknown');
    assert.equal(inspection.running, 'unknown');
    const install = await adapter.install();
    assert.equal(install.outcome, 'conflict');
    assert.equal(install.conflicts[0].code, 'state-unknown');
    const started = await adapter.start();
    assert.equal(started.outcome, 'conflict');
    assert.deepEqual(new Set(verbs(fake)), new Set(['print']));
  }
  await assert.rejects(fs.stat(adapter.identity().definitionPath), { code: 'ENOENT' });
});

test('launchctl print parsing recognizes only the expected shape and never guesses absence', () => {
  const target = 'gui/501/dev.example';
  const loaded = state => `${target} = {\n\tactive count = 0\n\tpath = /p.plist\n\tstate = ${state}\n\targuments = {\n\t\tstate = nested\n\t}\n}\n`;
  const stopped = parseLaunchctlPrint(loaded('not running'), target);
  assert.deepEqual([stopped.recognized, stopped.registration, stopped.running, stopped.pid, stopped.registeredPath], [true, 'loaded', false, null, '/p.plist']);
  const running = parseLaunchctlPrint(loaded('running').replace('\n}\n', '\n\tpid = 99\n}\n'), target);
  assert.deepEqual([running.running, running.pid], [true, 99]);
  const unrecognizedState = parseLaunchctlPrint(loaded('spawn scheduled'), target);
  assert.equal(unrecognizedState.running, 'unknown');
  const notRunningWithPid = parseLaunchctlPrint(loaded('not running').replace('\n}\n', '\n\tpid = 99\n}\n'), target);
  assert.equal(notRunningWithPid.running, 'unknown');
  const exited = parseLaunchctlPrint(loaded('not running').replace('\n}\n', '\n\tlast exit code = 78\n}\n'), target);
  assert.equal(exited.lastExitStatus, 78);
  assert.equal(parseLaunchctlPrint('', target).recognized, false);
  assert.equal(parseLaunchctlPrint(`gui/501/other = {\n\tstate = running\n}\n`, target).recognized, false);
  assert.equal(parseLaunchctlPrint(`${target} = {\n}\n`, target).recognized, false);
});

test('a label loaded from another definition is reported and left alone', { skip: !posix }, async t => {
  const f = await fixture(t);
  const { adapter, fake, label } = await adapterFor(f);
  fake.state.loaded = true;
  fake.state.path = '/Users/someone/Library/LaunchAgents/other.plist';
  const install = await adapter.install();
  assert.equal(install.outcome, 'conflict');
  assert.equal(install.conflicts[0].code, 'registered-elsewhere');
  const started = await adapter.start();
  assert.equal(started.outcome, 'conflict');
  assert.equal(started.conflicts[0].code, 'registered-elsewhere');
  assert.deepEqual(new Set(verbs(fake)), new Set(['print']));
  assert.ok(install.conflicts[0].message.includes(label));
});

test('a foreign file at the definition path is never overwritten or loaded', { skip: !posix }, async t => {
  const f = await fixture(t);
  const { adapter, fake, paths } = await adapterFor(f);
  await fs.mkdir(paths.serviceDirectory, { mode: 0o700 });
  await fs.chmod(paths.serviceDirectory, 0o700);
  await fs.writeFile(paths.definition, '<plist version="1.0"><dict><key>Label</key><string>someone.else</string></dict></plist>\n', { mode: 0o600 });
  const before = await fs.readFile(paths.definition, 'utf8');
  const result = await adapter.install();
  assert.equal(result.outcome, 'conflict');
  assert.equal(result.conflicts[0].code, 'foreign-definition');
  assert.equal(await fs.readFile(paths.definition, 'utf8'), before);
  assert.deepEqual(new Set(verbs(fake)), new Set(['print']));
  assert.equal((await adapter.unloadInactive()).outcome, 'nothing-to-remove');
  assert.equal((await adapter.cleanupFixture()).outcome, 'refused');
  assert.equal(await fs.readFile(paths.definition, 'utf8'), before, 'fixture cleanup must not delete a file it does not own');
});

test('a definition with group or other access is rejected rather than repaired', { skip: !posix }, async t => {
  const f = await fixture(t);
  const first = await adapterFor(f);
  await first.adapter.install();
  await fs.chmod(first.paths.definition, 0o644);
  const second = await adapterFor(f);
  const result = await second.adapter.install();
  assert.equal(result.outcome, 'conflict');
  assert.equal(result.conflicts[0].code, 'foreign-definition');
  assert.equal(await mode(first.paths.definition), 0o644);
  await fs.chmod(first.paths.definition, 0o600);
  await fs.chmod(first.paths.serviceDirectory, 0o755);
  const third = await adapterFor(f);
  assert.equal((await third.adapter.install()).outcome, 'conflict');
  assert.equal(await mode(first.paths.serviceDirectory), 0o755);
});

test('log files are private regular files that are appended to and never followed through symlinks', { skip: !posix }, async t => {
  const f = await fixture(t);
  const preserved = await adapterFor(f);
  await fs.mkdir(preserved.paths.logDirectory, { mode: 0o700 });
  await fs.chmod(preserved.paths.logDirectory, 0o700);
  await fs.writeFile(preserved.paths.standardOut, 'earlier output\n', { mode: 0o600 });
  assert.equal((await preserved.adapter.install()).outcome, 'created');
  assert.equal(await fs.readFile(preserved.paths.standardOut, 'utf8'), 'earlier output\n');
  assert.equal(await mode(preserved.paths.standardOut), 0o600);

  const loose = await fixture(t);
  const looseAdapter = await adapterFor(loose);
  await fs.mkdir(looseAdapter.paths.logDirectory, { mode: 0o700 });
  await fs.chmod(looseAdapter.paths.logDirectory, 0o700);
  await fs.writeFile(looseAdapter.paths.standardError, '', { mode: 0o644 });
  await fs.chmod(looseAdapter.paths.standardError, 0o644);
  const rejected = await looseAdapter.adapter.install();
  assert.equal(rejected.outcome, 'failed');
  assert.deepEqual(verbs(looseAdapter.fake), ['print'], 'nothing is registered when the log destination is unsafe');
  assert.equal(await mode(looseAdapter.paths.standardError), 0o644);

  const linked = await fixture(t);
  const linkedAdapter = await adapterFor(linked);
  const victim = path.join(linked.root, 'victim.txt');
  await fs.writeFile(victim, 'untouched\n');
  await fs.mkdir(linkedAdapter.paths.logDirectory, { mode: 0o700 });
  await fs.chmod(linkedAdapter.paths.logDirectory, 0o700);
  await fs.symlink(victim, linkedAdapter.paths.standardOut);
  const refused = await linkedAdapter.adapter.install();
  assert.equal(refused.outcome, 'failed');
  assert.match(refused.detail, /symbolic link/);
  assert.equal(await fs.readFile(victim, 'utf8'), 'untouched\n');
  assert.deepEqual(verbs(linkedAdapter.fake), ['print']);

  const directory = await fixture(t);
  const directoryAdapter = await adapterFor(directory);
  const target = path.join(directory.root, 'elsewhere');
  await fs.mkdir(target, { mode: 0o700 });
  await fs.symlink(target, directoryAdapter.paths.logDirectory);
  assert.equal((await directoryAdapter.adapter.install()).outcome, 'failed');
});

test('bootstrap and kickstart failures are reported without further mutation', { skip: !posix }, async t => {
  const f = await fixture(t);
  const { adapter, fake } = await adapterFor(f);
  fake.state.failBootstrap = true;
  const failed = await adapter.install();
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.registered, false);
  assert.deepEqual(verbs(fake), ['print', 'bootstrap']);
  fake.state.failBootstrap = false;
  assert.equal((await adapter.install()).registered, true);
  fake.state.failKickstart = true;
  fake.state.calls.length = 0;
  const start = await adapter.start();
  assert.equal(start.outcome, 'failed');
  assert.deepEqual(verbs(fake), ['print', 'kickstart']);
});

test('start refuses when the label is not registered', { skip: !posix }, async t => {
  const f = await fixture(t);
  const { adapter, fake } = await adapterFor(f);
  const start = await adapter.start();
  assert.equal(start.outcome, 'failed');
  assert.deepEqual(verbs(fake), ['print']);
});

test('fixture cleanup unloads a proven-stopped service and removes only the owned definition', { skip: !posix }, async t => {
  const f = await fixture(t);
  const { adapter, fake, paths } = await adapterFor(f);
  await adapter.install();
  const removed = await adapter.cleanupFixture();
  assert.equal(removed.outcome, 'removed');
  assert.equal(fake.state.loaded, false);
  await assert.rejects(fs.stat(paths.definition), { code: 'ENOENT' });

  await adapter.install();
  fake.state.running = true;
  fake.state.calls.length = 0;
  const refused = await adapter.cleanupFixture();
  assert.equal(refused.outcome, 'refused');
  assert.deepEqual(verbs(fake), ['print']);
  assert.ok((await fs.stat(paths.definition)).isFile());
});

test('service names derive deterministically from the canonical state directory', () => {
  const a = nativeServiceNames('/state/a');
  assert.deepEqual(a, nativeServiceNames('/state/a'));
  assert.notEqual(a.launchdLabel, nativeServiceNames('/state/b').launchdLabel);
  assert.match(a.launchdLabel, /^dev\.openheimdall\.coordinator\.[0-9a-f]{24}$/);
  assert.match(a.systemdUnit, /^heimdall-coordinator-[0-9a-f]{24}\.service$/);
});

test('the default runner passes arguments literally without a shell', { skip: !posix }, async () => {
  const runner = createExecFileRunner();
  const literal = 'a b \'q\' "d" $HOME `x`; & <t>';
  const result = await runner.run('/bin/echo', [literal]);
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout.trimEnd(), literal);
  const failed = await runner.run('/bin/sh', ['-c', 'exit 7']);
  assert.equal(failed.exitCode, 7);
  const missing = await runner.run('/nonexistent/tool', []);
  assert.equal(missing.exitCode, null);
  assert.ok(missing.error);
});
