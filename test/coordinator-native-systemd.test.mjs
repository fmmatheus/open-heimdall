import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { CONFIG_ORIGIN_VARIABLE, MANAGER_LABEL_VARIABLE, managerLabelFromEnvironment, resolveLaunchContext } from '../dist/coordinator/launch-context.js';
import {
  checkUserManager, createSystemdAdapter, parseExecStart, parseSystemctlShow, parseSystemdUnit, quoteEnvironmentAssignment, quoteExecWord,
  renderSystemdUnit, splitUnitWords, systemdDefinition, systemdPaths,
} from '../dist/coordinator/native/systemd.js';
import { createExecFileRunner, launchNativeService, nativeServiceNames } from '../dist/coordinator/native/types.js';
import { selectNativeAdapter, selectNativeManager } from '../dist/coordinator/native/platform.js';

const SYSTEMCTL = '/usr/bin/systemctl';
const RUNTIME = '/run/user/1000';
// Backslash, quotes, $, %, ; and spaces must all survive as literal characters.
const SPECIAL_STATE = '\'s"$;&<`%h\\';
const SPECIAL_ENTRY_DIRECTORY = 'my dir \'q\' "d" $HOME ${X} %h %% ; \\ back\\\\slash';
const SPECIAL_HOME = 'home $USER %u ; "q" \\';

async function temporaryRoot(t) {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/hd-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function fixture(t) {
  const root = await temporaryRoot(t);
  const stateDirectory = path.join(root, SPECIAL_STATE);
  await fs.mkdir(stateDirectory, { mode: 0o700 });
  await fs.chmod(stateDirectory, 0o700);
  const configFile = path.join(root, 'coordinator.toml');
  await fs.writeFile(configFile, `[coordinator]\nstateDirectory = ${JSON.stringify(stateDirectory)}\n`);
  const entryDirectory = path.join(root, SPECIAL_ENTRY_DIRECTORY);
  await fs.mkdir(entryDirectory);
  const entryPoint = path.join(entryDirectory, 'cli.js');
  await fs.writeFile(entryPoint, '// stand-in entry point\n');
  const home = path.join(root, SPECIAL_HOME);
  await fs.mkdir(home);
  const configHome = path.join(root, 'cfg');
  return { root, stateDirectory, configFile, entryPoint, entryDirectory, home, configHome };
}

const contextFor = (f, extra = {}, environment = {}) => resolveLaunchContext(
  { coordinatorConfig: f.configFile, entryPoint: f.entryPoint, ...extra },
  { HOME: f.home, ...environment },
);

const FORBIDDEN_VERBS = ['stop', 'kill', 'disable', 'enable', 'mask', 'unmask', 'restart', 'reload-or-restart', 'try-restart', 'try-reload-or-restart', 'reset-failed', 'isolate', 'revert', 'edit', 'set-property', 'poweroff', 'reboot', 'start-transient', 'enable-linger'];

function showText(state) {
  return [
    `LoadState=${state.loadState}`, `ActiveState=${state.active}`, `SubState=${state.sub}`, `MainPID=${state.pid}`,
    'ExecMainStatus=0', 'ExecMainCode=0', `FragmentPath=${state.fragment}`, '',
  ].join('\n');
}

/** Stateful `systemctl --user` stand-in. Records every call and refuses anything that could stop, kill or enable. */
function fakeSystemd({ linkPath } = {}) {
  const state = {
    loaded: false, loadState: 'not-found', active: 'inactive', sub: 'dead', pid: 0, fragment: '',
    userManager: true, showOverride: null, failLink: false, failStart: false, calls: [],
  };
  const runner = {
    state,
    async run(file, args) {
      state.calls.push({ file, args: [...args] });
      assert.equal(file, SYSTEMCTL, 'only the resolved absolute systemctl may run: no loginctl, sudo or shell');
      const [scope, verb, ...rest] = args;
      assert.equal(scope, '--user');
      assert.ok(!FORBIDDEN_VERBS.includes(verb), `unexpected systemctl verb ${verb}`);
      assert.ok(!args.includes('--now') && !args.includes('--force'), 'no --now or --force option may be passed');
      assert.ok(!args.includes('--system') && !args.includes('--global'), 'only the user manager is addressed');
      if (verb === 'show-environment') {
        return state.userManager ? { exitCode: 0, stdout: 'HOME=/x\n', stderr: '' } : { exitCode: 1, stdout: '', stderr: 'Failed to connect to bus: No medium found\n' };
      }
      if (verb === 'show') {
        if (state.showOverride) return state.showOverride;
        assert.deepEqual(rest.slice(1), ['-p', 'LoadState,ActiveState,SubState,MainPID,ExecMainStatus,ExecMainCode,FragmentPath']);
        return { exitCode: 0, stderr: '', stdout: showText(state) };
      }
      if (verb === 'link') {
        if (state.failLink) return { exitCode: 1, stdout: '', stderr: 'Failed to link unit: File exists\n' };
        assert.equal(rest.length, 1);
        await fs.mkdir(path.dirname(linkPath), { recursive: true });
        await fs.symlink(rest[0], linkPath);
        state.loaded = true; state.loadState = 'loaded'; state.active = 'inactive'; state.sub = 'dead'; state.pid = 0; state.fragment = linkPath;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (verb === 'daemon-reload') {
        if (!(await fs.lstat(linkPath).catch(() => undefined))) { state.loaded = false; state.loadState = 'not-found'; state.fragment = ''; }
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      if (verb === 'start') {
        if (state.failStart) return { exitCode: 1, stdout: '', stderr: 'Job for unit failed.\n' };
        assert.equal(rest[0].endsWith('.service'), true);
        state.active = 'active'; state.sub = 'running'; state.pid = 4242;
        return { exitCode: 0, stdout: '', stderr: '' };
      }
      throw new Error(`unhandled systemctl verb ${verb}`);
    },
  };
  return runner;
}

const verbs = runner => runner.state.calls.map(call => call.args[1]);
const mode = async file => (await fs.stat(file)).mode & 0o777;

function userEnvironment(f, extra = {}) {
  return { XDG_RUNTIME_DIR: RUNTIME, DBUS_SESSION_BUS_ADDRESS: `unix:path=${RUNTIME}/bus`, XDG_CONFIG_HOME: f.configHome, ...extra };
}

async function adapterFor(f, { extra, contextEnvironment, environment, runner } = {}) {
  const context = await contextFor(f, extra, contextEnvironment);
  const unit = nativeServiceNames(context.configuration.stateDirectory).systemdUnit;
  const paths = systemdPaths(context.configuration.stateDirectory, unit);
  const linkPath = path.join(f.configHome, 'systemd', 'user', unit);
  const fake = runner ?? fakeSystemd({ linkPath });
  const adapter = createSystemdAdapter({ context, runner: fake, systemctl: SYSTEMCTL, environment: environment ?? userEnvironment(f) });
  return { context, unit, paths, linkPath, fake, adapter };
}

// --- Rendered unit -------------------------------------------------------------------------------------------

test('rendered unit is a Type=exec, Restart=no, journal-logging unit that cannot be enabled and carries only nonsecret environment', async t => {
  const f = await fixture(t);
  const credentialFile = path.join(f.root, 'credentials.env');
  await fs.writeFile(credentialFile, 'OPENCODE_PASSWORD=sentinel-secret-value\n', { mode: 0o600 });
  const dataDirectory = path.join(f.root, 'openchamber data');
  await fs.mkdir(dataDirectory);
  const context = await contextFor(f, { envFile: credentialFile }, { OPENCHAMBER_DATA_DIR: dataDirectory, OPENCODE_PASSWORD: 'ambient-secret-value', PATH: '/should/not/appear', SECRET_TOKEN: 'tok' });
  const unit = nativeServiceNames(context.configuration.stateDirectory).systemdUnit;
  const text = renderSystemdUnit(systemdDefinition(context, unit));

  assert.match(text, /^Type=exec$/m);
  assert.match(text, /^Restart=no$/m);
  assert.match(text, /^StandardOutput=journal$/m);
  assert.match(text, /^StandardError=journal$/m);
  assert.doesNotMatch(text, /\[Install\]/);
  assert.doesNotMatch(text, /WantedBy|RequiredBy|Alias=|Also=|DefaultInstance/);
  assert.doesNotMatch(text, /KillMode|TimeoutStopSec|KillSignal|SendSIGKILL|Restart=(?!no$)|RemainAfterExit|ExecStop|ExecReload/m);
  assert.doesNotMatch(text, /sentinel-secret-value|ambient-secret-value|should\/not\/appear|SECRET_TOKEN|OPENCODE_PASSWORD/);
  assert.match(text, /credentials\.env/, 'only the credential file path, never its content');
  assert.deepEqual(text.split('\n').filter(line => /^\[.+\]$/.test(line)), ['[Unit]', '[Service]']);

  const parsed = parseSystemdUnit(text, unit);
  assert.ok(parsed);
  assert.deepEqual(Object.keys(parsed.environment).sort(), ['HEIMDALL_COORDINATOR_CONFIG_ORIGIN', 'HEIMDALL_COORDINATOR_MANAGER_LABEL', 'HOME', 'OPENCHAMBER_DATA_DIR']);
  assert.deepEqual(parsed.environment, {
    HOME: f.home, OPENCHAMBER_DATA_DIR: dataDirectory, [CONFIG_ORIGIN_VARIABLE]: 'flag', [MANAGER_LABEL_VARIABLE]: unit,
  });
  assert.equal(managerLabelFromEnvironment(f.stateDirectory, parsed.environment), unit, 'the unit name is a valid managed lifecycle identity');
});

test('ExecStart round-trips paths with spaces, quotes, $, %, ; and backslashes as literal arguments', async t => {
  const f = await fixture(t);
  const context = await contextFor(f);
  const unit = nativeServiceNames(context.configuration.stateDirectory).systemdUnit;
  const text = renderSystemdUnit(systemdDefinition(context, unit));
  const line = text.split('\n').find(candidate => candidate.startsWith('ExecStart='));
  const environmentLine = text.split('\n').find(candidate => candidate.startsWith('Environment='));
  assert.ok(line && environmentLine);

  const expected = [context.nodeExecutable, await fs.realpath(f.entryPoint), 'coordinator', 'serve', '--coordinator-config', f.configFile];
  assert.deepEqual(parseExecStart(line.slice('ExecStart='.length)), expected);
  for (const special of [' ', "'", '"', '$', '%', ';', '\\']) assert.ok(context.entryPoint.includes(special), `fixture path contains ${JSON.stringify(special)}`);
  assert.ok(context.configuration.stateDirectory.includes('%h') && context.configuration.stateDirectory.includes('\\'));

  // `$` and `%` are doubled so systemd performs no variable or specifier expansion; quotes and backslashes are escaped.
  assert.ok(line.includes('$$HOME') && line.includes('$${X}') && line.includes('%%h') && line.includes('%%%%'));
  assert.doesNotMatch(line.replace(/\$\$/g, '').replace(/%%/g, ''), /[$%]/, 'no single expansion character remains');
  assert.ok(line.includes('\\"d\\"') && line.includes('\\\\ back'));
  const unescapedQuotes = line.slice('ExecStart='.length).replace(/\\./g, '').split('"').length - 1;
  assert.equal(unescapedQuotes, expected.length * 2, 'every word is wrapped in exactly one pair of double quotes');

  const roundTrip = parseSystemdUnit(text, unit);
  assert.deepEqual(roundTrip.execStart, expected);
  assert.equal(roundTrip.environment.HOME, f.home, 'HOME with $, % and backslash round-trips through Environment=');
  assert.ok(environmentLine.includes('%%u') && environmentLine.includes('$USER'), 'Environment= doubles % but leaves $ literal');
  assert.equal(renderSystemdUnit(roundTrip), text);
});

test('quoting unit words is exact for each metacharacter and rejects values that cannot be literal', () => {
  assert.equal(quoteExecWord('a $b %c "d" \\e; f\'g'), '"a $$b %%c \\"d\\" \\\\e; f\'g"');
  assert.equal(quoteExecWord(''), '""');
  assert.equal(quoteEnvironmentAssignment('HOME', '/h $x %y "z" \\'), '"HOME=/h $x %%y \\"z\\" \\\\"');
  assert.deepEqual(parseExecStart('"a" "b c" \'d\' e\\sf "$$" "%%" ""'), ['a', 'b c', 'd', 'e f', '$', '%', '']);
  assert.deepEqual(splitUnitWords('  one   "two  three"  '), ['one', 'two  three']);
  assert.throws(() => parseExecStart('"$HOME"'), /unescaped expansion/);
  assert.throws(() => parseExecStart('"%h"'), /unescaped expansion/);
  assert.throws(() => parseExecStart('"unterminated'), /Unterminated/);
  assert.throws(() => quoteExecWord('line\nbreak'), /control character/);
  assert.throws(() => quoteEnvironmentAssignment('bad-name', 'x'), /Invalid environment variable name/);
  for (const value of ['plain', 'a b', 'q"uote', "s'ingle", 'back\\slash', 'd$ollar', 'p%ct', 'semi;colon', '$$', '%%', '\\"', 'a  b']) {
    assert.deepEqual(parseExecStart(quoteExecWord(value)), [value], `round trip of ${JSON.stringify(value)}`);
  }
});

test('an altered or foreign unit text is not recognized as an owned definition', async t => {
  const f = await fixture(t);
  const context = await contextFor(f);
  const unit = nativeServiceNames(context.configuration.stateDirectory).systemdUnit;
  const text = renderSystemdUnit(systemdDefinition(context, unit));
  assert.ok(parseSystemdUnit(text, unit));
  assert.equal(parseSystemdUnit(`${text}\n[Install]\nWantedBy=default.target\n`, unit), undefined);
  assert.equal(parseSystemdUnit(text.replace('Restart=no', 'Restart=always'), unit), undefined);
  assert.equal(parseSystemdUnit(text.replace('Type=exec', 'Type=simple'), unit), undefined);
  assert.equal(parseSystemdUnit(text.replace('StandardOutput=journal', 'StandardOutput=file:/tmp/x'), unit), undefined);
  assert.equal(parseSystemdUnit(text.replace(/^# Managed.*\n/, ''), unit), undefined);
  assert.equal(parseSystemdUnit(text, 'other.service'), undefined);
  assert.equal(parseSystemdUnit('[Service]\nExecStart=/bin/true\n', unit), undefined);
});

// --- Manager state parsing -----------------------------------------------------------------------------------

test('systemctl show parsing reports absence only for recognized stopped states', () => {
  const show = fields => Object.entries({ LoadState: 'loaded', ActiveState: 'inactive', SubState: 'dead', MainPID: '0', ExecMainStatus: '0', ExecMainCode: '0', FragmentPath: '/f', ...fields }).map(([k, v]) => `${k}=${v}`).join('\n');
  assert.deepEqual(parseSystemctlShow(show({})), { recognized: true, loadState: 'loaded', registration: 'loaded', running: false, pid: null, lastExitStatus: 0, registeredPath: '/f' });
  assert.equal(parseSystemctlShow(show({ ActiveState: 'failed', SubState: 'failed', ExecMainStatus: '3' })).running, false);
  assert.equal(parseSystemctlShow(show({ ActiveState: 'failed', ExecMainStatus: '3' })).lastExitStatus, 3);
  for (const active of ['active', 'activating', 'deactivating', 'reloading']) assert.equal(parseSystemctlShow(show({ ActiveState: active, MainPID: '77' })).running, true, active);
  assert.equal(parseSystemctlShow(show({ ActiveState: 'active', MainPID: '77' })).pid, 77);
  assert.equal(parseSystemctlShow(show({ ActiveState: 'inactive', MainPID: '55' })).running, 'unknown', 'inactive with a main PID is not proof of absence');
  assert.equal(parseSystemctlShow(show({ ActiveState: 'wat' })).running, 'unknown');
  assert.equal(parseSystemctlShow(show({ MainPID: 'abc' })).running, 'unknown');
  assert.equal(parseSystemctlShow(show({ LoadState: 'masked' })).registration, 'unknown');
  assert.equal(parseSystemctlShow(show({ LoadState: 'error' })).registration, 'unknown');
  const missing = parseSystemctlShow(show({ LoadState: 'not-found', FragmentPath: '' }));
  assert.equal(missing.registration, 'not-loaded');
  assert.equal(missing.running, false);
  assert.equal(parseSystemctlShow('').recognized, false);
  assert.equal(parseSystemctlShow('garbage\nLoadState=loaded\n').recognized, false);
});

// --- Unavailable user manager -------------------------------------------------------------------------------

test('an unavailable user manager or bus returns actionable guidance with no fallback and no login-setting changes', async t => {
  const f = await fixture(t);
  const cases = [
    ['no runtime directory', userEnvironment(f, { XDG_RUNTIME_DIR: undefined }), null, /XDG_RUNTIME_DIR/],
    ['relative runtime directory', userEnvironment(f, { XDG_RUNTIME_DIR: 'run/user' }), null, /XDG_RUNTIME_DIR/],
    ['no bus', userEnvironment(f, { XDG_RUNTIME_DIR: path.join(f.root, 'no-runtime'), DBUS_SESSION_BUS_ADDRESS: undefined }), null, /DBUS_SESSION_BUS_ADDRESS is not set/],
    ['manager refuses', userEnvironment(f), { userManager: false }, /exited with 1.*Failed to connect to bus/],
  ];
  for (const [name, environment, flags, reason] of cases) {
    const { adapter, fake, paths, linkPath } = await adapterFor(f, { environment });
    Object.assign(fake.state, flags ?? {});

    const install = await adapter.install();
    assert.equal(install.outcome, 'failed', name);
    assert.equal(install.registered, false, name);
    assert.match(install.detail, reason, name);
    assert.equal(install.conflicts.length, 1, name);
    assert.equal(install.conflicts[0].code, 'manager-unavailable', name);
    assert.match(install.conflicts[0].message, /systemd user manager is not usable/, name);
    assert.match(install.conflicts[0].action, /login session.*systemd user manager and user bus/, name);
    assert.match(install.conflicts[0].action, /does not change linger or login settings, does not use sudo and does not fall back to a detached process/, name);
    assert.match(install.conflicts[0].action, /heimdall coordinator serve/, name);

    const start = await adapter.start();
    assert.equal(start.outcome, 'failed', name);
    assert.equal(start.conflicts[0].code, 'manager-unavailable', name);
    assert.match(start.detail, reason, name);

    const inspection = await adapter.inspect();
    assert.equal(inspection.registration, 'unknown', name);
    assert.equal(inspection.running, 'unknown', name);

    const launched = await launchNativeService(adapter);
    assert.equal(launched.outcome, 'install-failed', name);
    assert.equal(launched.start, null, name);

    // Nothing but the read-only environment probe ran, and nothing was written or linked.
    assert.ok(verbs(fake).every(verb => verb === 'show-environment'), `${name}: ${verbs(fake)}`);
    assert.equal(await fs.stat(paths.definition).catch(() => null), null, name);
    assert.equal(await fs.stat(paths.serviceDirectory).catch(() => null), null, name);
    assert.equal(await fs.lstat(linkPath).catch(() => null), null, name);
  }
});

test('a missing systemctl is reported as an unavailable manager', async () => {
  const environment = { XDG_RUNTIME_DIR: RUNTIME, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x' };
  const never = { async run() { throw new Error('nothing may run without systemctl'); } };
  const status = await checkUserManager(never, undefined, environment);
  assert.equal(status.available, false);
  assert.match(status.reason, /systemctl was not found/);
  const refusing = { async run() { return { exitCode: null, stdout: '', stderr: '', error: `${SYSTEMCTL} could not run: ENOENT` }; } };
  assert.equal((await checkUserManager(refusing, SYSTEMCTL, environment)).available, false);
  const working = { async run(file, args) { assert.deepEqual([file, ...args], [SYSTEMCTL, '--user', 'show-environment']); return { exitCode: 0, stdout: '', stderr: '' }; } };
  assert.equal((await checkUserManager(working, SYSTEMCTL, environment)).available, true);
});

test('a user bus socket under the runtime directory is accepted when DBUS_SESSION_BUS_ADDRESS is unset', async t => {
  const root = await temporaryRoot(t);
  const { createServer } = await import('node:net');
  const server = createServer();
  await new Promise(resolve => server.listen(path.join(root, 'bus'), resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const working = { async run() { return { exitCode: 0, stdout: '', stderr: '' }; } };
  assert.equal((await checkUserManager(working, SYSTEMCTL, { XDG_RUNTIME_DIR: root })).available, true);
});

// --- Install, start and refresh -----------------------------------------------------------------------------

test('install links the private definition without enabling it, and start only starts the unit', async t => {
  const f = await fixture(t);
  const { adapter, fake, paths, linkPath, unit } = await adapterFor(f);

  const installed = await adapter.install();
  assert.equal(installed.outcome, 'created');
  assert.equal(installed.registered, true);
  assert.deepEqual(verbs(fake), ['show-environment', 'show', 'link', 'daemon-reload']);
  assert.deepEqual(fake.state.calls[2].args, ['--user', 'link', paths.definition]);
  assert.equal(await mode(paths.definition), 0o600);
  assert.equal(await mode(paths.serviceDirectory), 0o700);
  assert.equal(await fs.readFile(paths.definition, 'utf8'), adapter.render());
  assert.equal(await fs.readlink(linkPath), paths.definition, 'the user unit directory only links to the private definition');
  assert.deepEqual(adapter.identity(), { manager: 'systemd', label: unit, definitionPath: paths.definition });

  fake.state.calls.length = 0;
  const started = await adapter.start();
  assert.equal(started.outcome, 'started');
  assert.deepEqual(verbs(fake), ['show-environment', 'show', 'start']);
  assert.deepEqual(fake.state.calls[2].args, ['--user', 'start', unit]);

  const inspection = await adapter.inspect();
  assert.equal(inspection.registration, 'loaded');
  assert.equal(inspection.running, true);
  assert.equal(inspection.pid, 4242);
  assert.equal(inspection.registeredPath, linkPath);

  // A second start of the running unit changes nothing and sends no stop, restart or kill request.
  fake.state.calls.length = 0;
  const again = await adapter.start();
  assert.equal(again.outcome, 'already-running');
  assert.deepEqual(verbs(fake), ['show-environment', 'show']);
  const reinstall = await adapter.install();
  assert.equal(reinstall.outcome, 'unchanged');
  assert.equal(verbs(fake).includes('link'), false);
  assert.equal(verbs(fake).includes('daemon-reload'), false);
});

test('launchNativeService installs then starts without any stop, kill, disable or enable request', async t => {
  const f = await fixture(t);
  const { adapter, fake } = await adapterFor(f);
  const result = await launchNativeService(adapter);
  assert.equal(result.outcome, 'started');
  assert.deepEqual(verbs(fake), ['show-environment', 'show', 'link', 'daemon-reload', 'show-environment', 'show', 'start']);
  const second = await launchNativeService(adapter);
  assert.equal(second.outcome, 'already-running');
  for (const verb of verbs(fake)) assert.ok(!FORBIDDEN_VERBS.includes(verb), verb);
  for (const call of fake.state.calls) assert.equal(call.file, SYSTEMCTL);
});

test('a stopped retained definition is started again without relinking', async t => {
  const f = await fixture(t);
  const { adapter, fake, unit } = await adapterFor(f);
  await adapter.install();
  fake.state.active = 'inactive'; fake.state.sub = 'dead'; fake.state.pid = 0;
  fake.state.calls.length = 0;
  assert.equal((await launchNativeService(adapter)).outcome, 'started');
  assert.deepEqual(verbs(fake), ['show-environment', 'show', 'show-environment', 'show', 'start']);
  assert.deepEqual(fake.state.calls.at(-1).args, ['--user', 'start', unit]);
  // A unit that failed on its last run is startable too.
  fake.state.active = 'failed'; fake.state.sub = 'failed'; fake.state.pid = 0;
  fake.state.calls.length = 0;
  assert.equal((await adapter.start()).outcome, 'started');
});

test('start before install reports the unit as not registered and starts nothing', async t => {
  const f = await fixture(t);
  const { adapter, fake } = await adapterFor(f);
  const result = await adapter.start();
  assert.equal(result.outcome, 'failed');
  assert.match(result.detail, /not registered/);
  assert.equal(verbs(fake).includes('start'), false);
});

test('start failures and link failures are reported without further mutation', async t => {
  const f = await fixture(t);
  const { adapter, fake } = await adapterFor(f);
  fake.state.failLink = true;
  const failedInstall = await adapter.install();
  assert.equal(failedInstall.outcome, 'failed');
  assert.match(failedInstall.detail, /systemctl link failed.*File exists/);
  assert.equal(verbs(fake).includes('daemon-reload'), false);
  fake.state.failLink = false;
  await adapter.install();
  fake.state.failStart = true;
  const failedStart = await adapter.start();
  assert.equal(failedStart.outcome, 'failed');
  assert.match(failedStart.detail, /systemctl start failed/);
});

test('refresh is refused while the unit is active and never rewrites or reloads a live definition', async t => {
  const f = await fixture(t);
  const first = await adapterFor(f);
  await launchNativeService(first.adapter);
  const before = await fs.readFile(first.paths.definition, 'utf8');
  const bytes = await fs.stat(first.paths.definition);

  const dataDirectory = path.join(f.root, 'new-data');
  await fs.mkdir(dataDirectory);
  const changed = await adapterFor(f, { contextEnvironment: { OPENCHAMBER_DATA_DIR: dataDirectory }, runner: first.fake });
  first.fake.state.calls.length = 0;
  const refused = await changed.adapter.install();
  assert.equal(refused.outcome, 'conflict');
  assert.equal(refused.registered, false);
  assert.equal(refused.conflicts[0].code, 'running-context-changed');
  assert.deepEqual(refused.conflicts[0].changes, ['data-directory']);
  assert.match(refused.conflicts[0].action, /heimdall coordinator stop/);
  assert.deepEqual(verbs(first.fake), ['show-environment', 'show']);
  assert.equal(await fs.readFile(first.paths.definition, 'utf8'), before);
  assert.equal((await fs.stat(first.paths.definition)).ino, bytes.ino);

  // The same holds while the unit is stopping.
  first.fake.state.active = 'deactivating'; first.fake.state.sub = 'stop-sigterm';
  const stopping = await changed.adapter.install();
  assert.equal(stopping.conflicts[0].code, 'running-context-changed');
  assert.equal(await fs.readFile(first.paths.definition, 'utf8'), before);
  assert.equal(verbs(first.fake).includes('daemon-reload'), false);
  assert.equal((await changed.adapter.start()).outcome, 'already-running');
});

test('refresh with unknown activity is refused and an inactive definition is refreshed only after proven absence', async t => {
  const f = await fixture(t);
  const first = await adapterFor(f);
  await first.adapter.install();
  const before = await fs.readFile(first.paths.definition, 'utf8');
  const dataDirectory = path.join(f.root, 'new-data');
  await fs.mkdir(dataDirectory);
  const changed = await adapterFor(f, { contextEnvironment: { OPENCHAMBER_DATA_DIR: dataDirectory }, runner: first.fake });

  // Inactive but with a main PID: absence is not proven.
  first.fake.state.pid = 31;
  first.fake.state.calls.length = 0;
  const unknown = await changed.adapter.install();
  assert.equal(unknown.outcome, 'conflict');
  assert.equal(unknown.conflicts[0].code, 'state-unknown');
  assert.equal(await fs.readFile(first.paths.definition, 'utf8'), before);
  assert.equal(verbs(first.fake).includes('daemon-reload'), false);

  first.fake.state.pid = 0;
  first.fake.state.calls.length = 0;
  const refreshed = await changed.adapter.install();
  assert.equal(refreshed.outcome, 'refreshed');
  assert.deepEqual(verbs(first.fake), ['show-environment', 'show', 'daemon-reload']);
  const after = await fs.readFile(first.paths.definition, 'utf8');
  assert.notEqual(after, before);
  assert.equal(after, changed.adapter.render());
  assert.equal(await mode(first.paths.definition), 0o600);
  assert.equal(await fs.readlink(first.linkPath), first.paths.definition);
});

test('unrecognized or unusable manager answers are treated as unknown and block every mutation', async t => {
  const f = await fixture(t);
  const { adapter, fake, paths } = await adapterFor(f);
  const outputs = [
    { exitCode: 0, stdout: 'something unexpected\n', stderr: '' },
    { exitCode: 0, stdout: 'LoadState=masked\nActiveState=inactive\nSubState=dead\nMainPID=0\nFragmentPath=\n', stderr: '' },
    { exitCode: 1, stdout: '', stderr: 'Failed to get properties\n' },
    { exitCode: null, stdout: '', stderr: '', error: 'systemctl did not finish in time' },
  ];
  for (const output of outputs) {
    fake.state.showOverride = output;
    fake.state.calls.length = 0;
    const install = await adapter.install();
    assert.equal(install.outcome, 'conflict');
    assert.equal(install.conflicts[0].code, 'state-unknown');
    const start = await adapter.start();
    assert.equal(start.outcome, 'conflict');
    assert.equal(start.conflicts[0].code, 'state-unknown');
    assert.deepEqual(verbs(fake).filter(verb => !['show-environment', 'show'].includes(verb)), []);
    assert.equal(await fs.stat(paths.definition).catch(() => null), null);
  }
});

// --- Conflicts ----------------------------------------------------------------------------------------------

test('a unit loaded from a foreign fragment path is a conflict and is never started or replaced', async t => {
  const f = await fixture(t);
  const { adapter, fake, paths, unit } = await adapterFor(f);
  await adapter.install();
  const owned = await fs.readFile(paths.definition, 'utf8');
  const foreignPath = `/etc/systemd/user/${unit}`;
  Object.assign(fake.state, { loaded: true, loadState: 'loaded', fragment: foreignPath });
  fake.state.calls.length = 0;

  const install = await adapter.install();
  assert.equal(install.outcome, 'conflict');
  assert.equal(install.conflicts[0].code, 'registered-elsewhere');
  assert.match(install.conflicts[0].message, new RegExp(foreignPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(install.conflicts[0].action, /Remove or rename that unit yourself/);
  const start = await adapter.start();
  assert.equal(start.outcome, 'conflict');
  assert.equal(start.conflicts[0].code, 'registered-elsewhere');
  const launched = await launchNativeService(adapter);
  assert.equal(launched.outcome, 'install-conflict');
  assert.deepEqual(verbs(fake).filter(verb => !['show-environment', 'show'].includes(verb)), []);
  assert.equal(await fs.readFile(paths.definition, 'utf8'), owned);

  // A fragment that is missing from an unrelated registration is also not ours.
  fake.state.fragment = '';
  assert.equal((await adapter.start()).outcome, 'conflict');
  const cleanup = await adapter.unloadInactive();
  assert.equal(cleanup.outcome, 'refused');
});

test('a fragment path that resolves to the owned definition is accepted', async t => {
  const f = await fixture(t);
  const { adapter, fake, paths } = await adapterFor(f);
  await adapter.install();
  const alias = path.join(f.root, 'alias.service');
  await fs.symlink(paths.definition, alias);
  fake.state.fragment = alias;
  assert.equal((await adapter.start()).outcome, 'started');
});

test('a foreign file at the definition path is reported and left untouched', async t => {
  const f = await fixture(t);
  const { adapter, fake, paths } = await adapterFor(f);
  await fs.mkdir(paths.serviceDirectory, { mode: 0o700 });
  await fs.writeFile(paths.definition, '[Service]\nExecStart=/bin/sh -c "echo mine"\n', { mode: 0o600 });
  const install = await adapter.install();
  assert.equal(install.outcome, 'conflict');
  assert.equal(install.conflicts[0].code, 'foreign-definition');
  assert.equal(await fs.readFile(paths.definition, 'utf8'), '[Service]\nExecStart=/bin/sh -c "echo mine"\n');
  assert.deepEqual(verbs(fake).filter(verb => !['show-environment', 'show'].includes(verb)), []);

  await fs.chmod(paths.definition, 0o644);
  const insecure = await adapter.install();
  assert.equal(insecure.outcome, 'conflict');
  assert.equal(await mode(paths.definition), 0o644, 'existing permissions are validated, never repaired');
});

test('an insecure service directory is rejected without repair', async t => {
  const f = await fixture(t);
  const { adapter, fake, paths } = await adapterFor(f);
  await fs.mkdir(paths.serviceDirectory, { mode: 0o755 });
  await fs.chmod(paths.serviceDirectory, 0o755);
  const install = await adapter.install();
  assert.equal(install.outcome, 'conflict');
  assert.equal(install.conflicts[0].code, 'foreign-definition');
  assert.equal(await mode(paths.serviceDirectory), 0o755);
  assert.equal(verbs(fake).includes('link'), false);
});

// --- Cleanup ------------------------------------------------------------------------------------------------

test('fixture cleanup unlinks only an owned, proven-inactive unit and never signals a process', async t => {
  const f = await fixture(t);
  const { adapter, fake, paths, linkPath } = await adapterFor(f);
  await launchNativeService(adapter);
  fake.state.calls.length = 0;
  const refused = await adapter.cleanupFixture();
  assert.equal(refused.outcome, 'refused');
  assert.equal(await fs.readlink(linkPath), paths.definition);
  assert.deepEqual(verbs(fake), ['show-environment', 'show']);

  fake.state.active = 'inactive'; fake.state.sub = 'dead'; fake.state.pid = 0;
  const removed = await adapter.cleanupFixture();
  assert.equal(removed.outcome, 'removed');
  assert.equal(await fs.lstat(linkPath).catch(() => null), null);
  assert.equal(await fs.stat(paths.definition).catch(() => null), null);
  for (const verb of verbs(fake)) assert.ok(!FORBIDDEN_VERBS.includes(verb), verb);
  assert.equal((await adapter.cleanupFixture()).outcome, 'nothing-to-remove');
});

test('the unit name is derived from the canonical state directory so isolated state gets its own unit', async t => {
  const f = await fixture(t);
  const other = await fixture(t);
  const a = await adapterFor(f);
  const b = await adapterFor(other);
  assert.notEqual(a.unit, b.unit);
  assert.match(a.unit, /^heimdall-coordinator-[0-9a-f]{24}\.service$/);
});

// --- Platform selection --------------------------------------------------------------------------------------

test('platform selector picks launchd on darwin, systemd on linux and reports other platforms as unsupported', async t => {
  assert.deepEqual(selectNativeManager('darwin'), { supported: true, manager: 'launchd' });
  assert.deepEqual(selectNativeManager('linux'), { supported: true, manager: 'systemd' });
  for (const platform of ['win32', 'freebsd', 'sunos', 'aix', 'openbsd']) {
    const selection = selectNativeManager(platform);
    assert.equal(selection.supported, false, platform);
    assert.equal(selection.platform, platform);
    assert.match(selection.message, new RegExp(`${platform} is not supported`));
    assert.match(selection.message, /macOS \(launchd\) and Linux \(systemd user manager\)/);
    assert.match(selection.message, /heimdall coordinator serve/);
  }
  assert.equal(selectNativeManager().supported, process.platform === 'darwin' || process.platform === 'linux');

  const f = await fixture(t);
  const context = await contextFor(f);
  const noRun = { async run() { throw new Error('selecting an adapter must not run a native tool'); } };
  const linux = selectNativeAdapter({ context, platform: 'linux', runner: noRun, systemctl: SYSTEMCTL, environment: userEnvironment(f) });
  assert.equal(linux.supported, true);
  assert.equal(linux.manager, 'systemd');
  assert.equal(linux.adapter.identity().manager, 'systemd');
  assert.equal(linux.adapter.identity().label, nativeServiceNames(context.configuration.stateDirectory).systemdUnit);
  const darwin = selectNativeAdapter({ context, platform: 'darwin', runner: noRun, uid: 501 });
  assert.equal(darwin.supported, true);
  assert.equal(darwin.manager, 'launchd');
  assert.equal(darwin.adapter.identity().manager, 'launchd');
  assert.equal(darwin.adapter.identity().label, nativeServiceNames(context.configuration.stateDirectory).launchdLabel);
  const unsupported = selectNativeAdapter({ context, platform: 'win32', runner: noRun });
  assert.equal(unsupported.supported, false);
  assert.equal('adapter' in unsupported, false);
  assert.match(unsupported.message, /win32 is not supported/);
});

test('the adapter source invokes only the allowed read, link, reload and start verbs and no other tool', async () => {
  const source = await fs.readFile(path.resolve(import.meta.dirname, '../src/coordinator/native/systemd.ts'), 'utf8');
  const invoked = [...source.matchAll(/\brun\(\[([^\]]*)\]/g)].map(match => match[1].split(',')[0].trim().replace(/'/g, ''));
  assert.deepEqual([...new Set(invoked)].sort(), ['daemon-reload', 'link', 'show', 'start']);
  assert.doesNotMatch(source, /loginctl|enable-linger|child_process|['"`/]sudo['"`]|spawn\(|execSync|execFile\(/);
  assert.doesNotMatch(source, /--now|--force|--system|--global/);
});

test('the default runner reports a missing tool as an error result without throwing', async () => {
  const result = await createExecFileRunner().run('/nonexistent/systemctl', ['--user', 'show-environment']);
  assert.equal(result.exitCode, null);
  assert.ok(result.error);
});
