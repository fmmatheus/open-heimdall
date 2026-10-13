import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCoordinatorClient } from '../../dist/coordinator/client.js';
import { lifecycleCommandMain } from '../../dist/coordinator/lifecycle-cli.js';
import { lifecycleExitCode, parseLifecycleResult, renderLifecycleJson } from '../../dist/coordinator/lifecycle-result.js';
import { resolveLaunchContext } from '../../dist/coordinator/launch-context.js';
import { createLaunchdAdapter, launchdPaths, parsePlist } from '../../dist/coordinator/native/launchd.js';
import { createSystemdAdapter, parseSystemdUnit, systemdPaths } from '../../dist/coordinator/native/systemd.js';
import { nativeServiceNames } from '../../dist/coordinator/native/types.js';
import { readCoordinatorToken } from '../../dist/coordinator/token.js';

/**
 * Controlled native runner. The PRODUCTION `createLaunchdAdapter` and `createSystemdAdapter` run unchanged against a
 * stateful `CommandRunner` that stands in for `launchctl` / `systemctl --user`. Unlike a pure fake, "starting" the
 * service really spawns the coordinator from the definition the manager has registered (read from disk, the way the
 * manager reads it), keeps its output where the manager would, and reports the real child pid and exit status.
 *
 * Evidence from this module is mocked-manager evidence: the adapters, definitions, lifecycle commands, coordinator
 * process and state files are real; launchd and systemd themselves are not. It never establishes native behavior.
 *
 * The runner refuses everything that could stop or alter a running service (kill options, stop, restart, enable, ...).
 * A refused call is recorded in `violations` and also throws, so a test fails even if production code swallows the error.
 * Children are ended only by `shutdown()`, which test cleanup calls; that is harness cleanup, not product behavior.
 */

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CLI_ENTRY = path.join(repository, 'dist', 'cli.js');
export const LAUNCHCTL = '/bin/launchctl';
export const SYSTEMCTL = '/usr/bin/systemctl';
export const SENTINEL = 'controlled-native-synthetic-credential';

const LAUNCHCTL_FORBIDDEN = ['kill', 'stop', 'remove', 'unload', 'load', 'enable', 'disable', 'reboot', 'shutdown', 'start', 'submit', 'attach', 'debug'];
const SYSTEMCTL_FORBIDDEN = ['stop', 'kill', 'disable', 'enable', 'mask', 'unmask', 'restart', 'reload-or-restart', 'try-restart', 'try-reload-or-restart', 'reset-failed', 'isolate', 'revert', 'edit', 'set-property', 'poweroff', 'reboot', 'start-transient', 'enable-linger', 'reload'];

const ok = (stdout = '') => ({ exitCode: 0, stdout, stderr: '' });
const failure = (exitCode, stderr) => ({ exitCode, stdout: '', stderr });

/**
 * Behavior shared by both managers: call recording, forbidden-verb policy, injected responses, barriers, child tracking.
 *
 * Injection hooks (all synchronous to set, usable from inside barrier callbacks):
 * - `foreign = { registeredPath, pid, running = true }`: the label reports as registered from another path with another pid.
 * - `reportedPid`: `undefined` reports the real child pid, `null` reports a running service without a pid, a number
 *   reports that (mismatched) pid.
 * - `respond(verb, result, { times })`: the next `times` calls to `verb` return `result` without any effect (verb
 *   failures, unknown/unrecognized output, `{ error }` results). `result` may be a function of the recorded call.
 * - `on(when, verb, callback, { once })` / `hold(when, verb)`: async barriers `'before'` or `'after'` any verb (`'*'` = all)
 *   so a test can change state between an inspection and the action that follows it.
 */
class ControlledRunner {
  constructor({ gracePeriodMs = 10_000 } = {}) {
    this.gracePeriodMs = gracePeriodMs;
    this.calls = [];
    this.violations = [];
    this.cleanupLog = [];
    this.services = new Map();
    this.foreign = null;
    this.reportedPid = undefined;
    this.barriers = [];
    this.responses = [];
  }

  /** The verb of each call, in order. */
  get verbs() { return this.calls.map(call => call.verb); }

  service(name) {
    let service = this.services.get(name);
    if (!service) {
      service = { name, child: null, exit: null, starts: 0, output: { stdout: '', stderr: '' }, ...this.initialService() };
      this.services.set(name, service);
    }
    return service;
  }

  /** The only service the runner knows, for single-service tests. */
  get only() {
    if (this.services.size !== 1) throw new Error(`Expected exactly one service, found ${this.services.size}`);
    return [...this.services.values()][0];
  }

  /** True while the real child process of `service` has not exited. */
  isRunning(service) { return service.child !== null && service.exit === null; }

  on(when, verb, callback, { once = true } = {}) {
    if (when !== 'before' && when !== 'after') throw new Error(`Unknown barrier position ${when}`);
    this.barriers.push({ when, verb, callback, once });
  }

  /** A barrier that parks the matching call: `reached` resolves with the call, and the call continues after `release()`. */
  hold(when, verb) {
    let release;
    let reach;
    const released = new Promise(resolve => { release = resolve; });
    const reached = new Promise(resolve => { reach = resolve; });
    this.on(when, verb, async call => { reach(call); await released; });
    return { reached, release };
  }

  respond(verb, result, { times = 1 } = {}) { this.responses.push({ verb, result, times }); }

  violation(message) {
    this.violations.push(message);
    throw new Error(`Controlled native runner refused: ${message}`);
  }

  assertNoViolations() {
    if (this.violations.length) throw new Error(`Controlled native runner refused calls: ${this.violations.join('; ')}`);
  }

  async fire(when, call) {
    for (const barrier of [...this.barriers]) {
      if (barrier.when !== when || (barrier.verb !== '*' && barrier.verb !== call.verb)) continue;
      if (barrier.once) this.barriers.splice(this.barriers.indexOf(barrier), 1);
      await barrier.callback(call);
    }
  }

  async run(file, args) {
    const call = { file, args: [...args], verb: this.verbOf(args), result: null };
    this.calls.push(call);
    this.checkPolicy(file, call);
    await this.fire('before', call);
    const response = this.responses.find(candidate => candidate.verb === call.verb && candidate.times > 0);
    let result;
    if (response) {
      response.times -= 1;
      result = typeof response.result === 'function' ? await response.result(call) : response.result;
    } else result = await this.handle(call);
    call.result = result;
    await this.fire('after', call);
    return result;
  }

  /**
   * Spawn the service's real process. Resolves once the process exists and rejects when it cannot be started.
   * `stdio` is `[stdin, stdout, stderr]`; pipes are collected into `service.output`.
   */
  spawnChild(service, program, argv, env, stdio) {
    return new Promise((resolve, reject) => {
      const child = spawn(program, argv, { env, cwd: '/', stdio });
      service.child = child;
      service.exit = null;
      service.starts += 1;
      service.output = { stdout: '', stderr: '' };
      service.exited = new Promise(done => {
        child.once('exit', (code, signal) => { service.exit = { code, signal }; done(service.exit); });
      });
      child.once('error', error => {
        service.exit ??= { code: 127, signal: null, error: error.message };
        reject(error);
      });
      child.stdout?.on('data', chunk => { service.output.stdout += chunk; });
      child.stderr?.on('data', chunk => { service.output.stderr += chunk; });
      child.once('spawn', () => resolve(child));
    });
  }

  /**
   * Harness cleanup: ask every still-running child to end gracefully (SIGTERM, the signal a foreground coordinator
   * drains on) and kill only one that ignores it past the grace period. Each action is logged in `cleanupLog`.
   */
  async shutdown() {
    for (const service of this.services.values()) {
      if (!this.isRunning(service)) continue;
      this.cleanupLog.push(`harness cleanup: SIGTERM ${service.name} pid ${service.child.pid}`);
      service.child.kill('SIGTERM');
      let timer;
      await Promise.race([service.exited, new Promise(resolve => { timer = setTimeout(resolve, this.gracePeriodMs); })]);
      clearTimeout(timer);
      if (service.exit === null) {
        this.cleanupLog.push(`harness cleanup: SIGKILL ${service.name} pid ${service.child.pid} (no exit within ${this.gracePeriodMs} ms)`);
        service.child.kill('SIGKILL');
        await service.exited;
      }
    }
  }
}

// --- launchd ---------------------------------------------------------------------------------------------------

/** Stateful `launchctl` stand-in: print, bootstrap, kickstart and bootout of a `gui/<uid>` user domain. */
export class ControlledLaunchctl extends ControlledRunner {
  constructor({ uid = process.getuid(), launchctl = LAUNCHCTL, ...options } = {}) {
    super(options);
    this.uid = uid;
    this.launchctl = launchctl;
  }

  initialService() { return { registeredPath: null }; }

  verbOf(args) { return args[0]; }

  checkPolicy(file, call) {
    const { args, verb } = call;
    if (file !== this.launchctl) this.violation(`only ${this.launchctl} may run, not ${file}`);
    if (args.includes('-k')) this.violation('a start request must never ask launchd to kill a running instance (-k)');
    if (LAUNCHCTL_FORBIDDEN.includes(verb)) this.violation(`launchctl ${verb} could stop, alter or load a service`);
    if (!['print', 'bootstrap', 'kickstart', 'bootout'].includes(verb)) this.violation(`unhandled launchctl verb ${verb}`);
  }

  labelOf(target) {
    if (!target.startsWith(`gui/${this.uid}/`)) this.violation(`target ${target} is not in the user domain gui/${this.uid}`);
    return target.slice(`gui/${this.uid}/`.length);
  }

  /** `launchctl print` text in the shape the adapter parses (path, state, pid, last exit code). */
  render(target, { registeredPath, running, pid, exit }) {
    const exitText = exit === null ? '(never exited)' : exit.code !== null ? String(exit.code) : '(signal)';
    return [
      `${target} = {`,
      `\tactive count = ${running ? 1 : 0}`,
      `\tpath = ${registeredPath}`,
      '\ttype = LaunchAgent',
      `\tstate = ${running ? 'running' : 'not running'}`,
      '\n\targuments = {', '\t\t/some/node', '\t\tstate = not-the-service-state', '\t}',
      '\n\tenvironment = {', '\t\tHOME => /home/x', '\t}',
      ...(running ? (pid === null ? [] : [`\tpid = ${pid}`]) : [`\tlast exit code = ${exitText}`]),
      '}', '',
    ].join('\n');
  }

  async handle(call) {
    const [verb, ...rest] = call.args;
    const target = rest[0] ?? '';
    if (verb === 'print') {
      const label = this.labelOf(target);
      if (this.foreign) {
        return ok(this.render(target, { registeredPath: this.foreign.registeredPath, running: this.foreign.running ?? true, pid: this.foreign.pid ?? null, exit: null }));
      }
      const service = this.service(label);
      if (service.registeredPath === null) return failure(113, `Could not find service "${label}" in domain for user gui: ${this.uid}\n`);
      const running = this.isRunning(service);
      const pid = running ? (this.reportedPid !== undefined ? this.reportedPid : service.child.pid) : null;
      return ok(this.render(target, { registeredPath: service.registeredPath, running, pid, exit: service.exit }));
    }
    if (verb === 'bootstrap') {
      const [domain, plistPath] = rest;
      if (domain !== `gui/${this.uid}`) this.violation(`bootstrap domain ${domain} is not gui/${this.uid}`);
      let parsed;
      try { parsed = parsePlist(await fsp.readFile(plistPath, 'utf8')); } catch { return failure(5, 'Bootstrap failed: 5: Input/output error\n'); }
      if (typeof parsed !== 'object' || Array.isArray(parsed) || typeof parsed.Label !== 'string') return failure(5, 'Bootstrap failed: 5: Input/output error\n');
      if (this.foreign || this.service(parsed.Label).registeredPath !== null) return failure(5, 'Bootstrap failed: 5: Input/output error\n');
      const service = this.service(parsed.Label);
      service.registeredPath = plistPath;
      service.exit = null;
      service.child = null;
      return ok();
    }
    if (verb === 'kickstart') {
      const label = this.labelOf(target);
      if (this.foreign) this.violation(`kickstart of ${target}, which is registered from another definition`);
      const service = this.service(label);
      if (service.registeredPath === null) return failure(113, `Could not find service "${label}" in domain for user gui: ${this.uid}\n`);
      if (this.isRunning(service)) return ok();
      // The registered definition is read from disk at start, so a refreshed file is what runs.
      let definition;
      try { definition = parsePlist(await fsp.readFile(service.registeredPath, 'utf8')); } catch { return failure(5, 'Service cannot load in requested session\n'); }
      const [program, ...argv] = definition.ProgramArguments;
      const descriptors = [];
      try {
        for (const file of [definition.StandardOutPath, definition.StandardErrorPath]) descriptors.push(file ? fs.openSync(file, 'a') : 'ignore');
      } catch {
        for (const descriptor of descriptors) if (typeof descriptor === 'number') fs.closeSync(descriptor);
        return failure(5, 'Service cannot load in requested session\n');
      }
      try { await this.spawnChild(service, program, argv, definition.EnvironmentVariables ?? {}, ['ignore', ...descriptors]); }
      catch { /* a program that cannot run exits with a failure status, as a launchd job does */ }
      finally { for (const descriptor of descriptors) if (typeof descriptor === 'number') fs.closeSync(descriptor); }
      return ok();
    }
    if (verb === 'bootout') {
      const label = this.labelOf(target);
      if (this.foreign) this.violation(`bootout of ${target}, which is registered from another definition`);
      const service = this.service(label);
      if (service.registeredPath === null) return failure(3, 'Boot-out failed: 3: No such process\n');
      if (this.isRunning(service)) this.violation(`bootout of the running service ${label} would terminate it`);
      service.registeredPath = null;
      return ok();
    }
    return this.violation(`unhandled launchctl verb ${verb}`);
  }

  /** The service output kept in the definition's log files. */
  async logs(paths) {
    const read = file => fsp.readFile(file, 'utf8').catch(() => '');
    return { stdout: await read(paths.standardOut), stderr: await read(paths.standardError) };
  }
}

// --- systemd ---------------------------------------------------------------------------------------------------

/** Stateful `systemctl --user` stand-in: show-environment, show, link, daemon-reload and start. */
export class ControlledSystemctl extends ControlledRunner {
  constructor({ configHome, systemctl = SYSTEMCTL, ...options }) {
    super(options);
    if (!configHome || !path.isAbsolute(configHome)) throw new Error('configHome must be an absolute isolated XDG_CONFIG_HOME');
    this.configHome = configHome;
    this.systemctl = systemctl;
    /** False makes `show-environment` fail, as without a user manager. */
    this.userManager = true;
  }

  initialService() { return { loadState: 'not-found', fragmentPath: null, definition: null }; }

  verbOf(args) { return args[1]; }

  linkPathOf(unit) { return path.join(this.configHome, 'systemd', 'user', unit); }

  checkPolicy(file, call) {
    const { args, verb } = call;
    if (file !== this.systemctl) this.violation(`only ${this.systemctl} may run, not ${file}`);
    if (args[0] !== '--user') this.violation('only the user manager is addressed');
    if (args.includes('--system') || args.includes('--global') || args.includes('--now') || args.includes('--force')) this.violation(`unexpected option in ${args.join(' ')}`);
    if (SYSTEMCTL_FORBIDDEN.includes(verb)) this.violation(`systemctl ${verb} could stop, kill, restart or enable a service`);
    if (!['show-environment', 'show', 'link', 'daemon-reload', 'start'].includes(verb)) this.violation(`unhandled systemctl verb ${verb}`);
  }

  /** Re-read the unit from its user-config link. A missing link unloads an inactive unit. */
  async load(service) {
    const linkPath = this.linkPathOf(service.name);
    let text;
    try { text = await fsp.readFile(linkPath, 'utf8'); }
    catch {
      if (!this.isRunning(service)) Object.assign(service, { loadState: 'not-found', fragmentPath: null, definition: null });
      return;
    }
    const definition = parseSystemdUnit(text, service.name);
    if (!definition) { Object.assign(service, { loadState: 'bad-setting', fragmentPath: linkPath, definition: null }); return; }
    Object.assign(service, { loadState: 'loaded', fragmentPath: linkPath, definition });
  }

  showText({ loadState, active, sub, pid, status, code, fragment }) {
    return [`LoadState=${loadState}`, `ActiveState=${active}`, `SubState=${sub}`, `MainPID=${pid}`, `ExecMainStatus=${status}`, `ExecMainCode=${code}`, `FragmentPath=${fragment}`, ''].join('\n');
  }

  async handle(call) {
    const [, verb, ...rest] = call.args;
    if (verb === 'show-environment') {
      return this.userManager ? ok('HOME=/home/x\n') : failure(1, 'Failed to connect to bus: No medium found\n');
    }
    if (verb === 'show') {
      const unit = rest[0];
      if (rest[1] !== '-p') this.violation(`show must request explicit properties: ${call.args.join(' ')}`);
      if (this.foreign) {
        return ok(this.showText({ loadState: 'loaded', active: this.foreign.running === false ? 'inactive' : 'active', sub: this.foreign.running === false ? 'dead' : 'running', pid: this.foreign.pid ?? 0, status: 0, code: 0, fragment: this.foreign.registeredPath }));
      }
      const service = this.service(unit);
      if (service.loadState !== 'loaded') {
        return ok(this.showText({ loadState: service.loadState, active: 'inactive', sub: 'dead', pid: 0, status: 0, code: 0, fragment: service.fragmentPath ?? '' }));
      }
      if (this.isRunning(service)) {
        return ok(this.showText({ loadState: 'loaded', active: 'active', sub: 'running', pid: this.reportedPid !== undefined ? this.reportedPid ?? 0 : service.child.pid, status: 0, code: 0, fragment: service.fragmentPath }));
      }
      const exit = service.exit;
      const clean = exit === null || exit.code === 0;
      return ok(this.showText({
        loadState: 'loaded', active: clean ? 'inactive' : 'failed', sub: clean ? 'dead' : 'failed', pid: 0,
        status: exit?.code ?? 0, code: exit === null ? 0 : exit.code !== null ? 1 : 2, fragment: service.fragmentPath,
      }));
    }
    if (verb === 'link') {
      const [definitionPath] = rest;
      if (rest.length !== 1 || !path.isAbsolute(definitionPath)) this.violation(`link needs one absolute definition path: ${call.args.join(' ')}`);
      const unit = path.basename(definitionPath);
      const linkPath = this.linkPathOf(unit);
      await fsp.mkdir(path.dirname(linkPath), { recursive: true });
      try { await fsp.symlink(definitionPath, linkPath); } catch { return failure(1, 'Failed to link unit: File exists\n'); }
      await this.load(this.service(unit));
      return ok();
    }
    if (verb === 'daemon-reload') {
      for (const service of this.services.values()) if (service.loadState !== 'not-found' || service.definition) await this.load(service);
      return ok();
    }
    if (verb === 'start') {
      const unit = rest[0];
      if (this.foreign) this.violation(`start of ${unit}, which is loaded from another definition`);
      const service = this.service(unit);
      if (service.loadState !== 'loaded') return failure(5, `Failed to start ${unit}: Unit ${unit} not found.\n`);
      if (this.isRunning(service)) return ok();
      // The definition the manager last loaded is what runs, which is not necessarily what is on disk now.
      const [program, ...argv] = service.definition.execStart;
      try { await this.spawnChild(service, program, argv, service.definition.environment, ['ignore', 'pipe', 'pipe']); }
      catch (error) { return failure(1, `Job for ${unit} failed: ${error.message}\n`); }
      return ok();
    }
    return this.violation(`unhandled systemctl verb ${verb}`);
  }

  /** The unit's output as `journalctl --user -u` would show it. */
  journal(service = this.only) { return service.output; }
}

// --- Harness ---------------------------------------------------------------------------------------------------

function capture() {
  const out = { stdout: '', stderr: '' };
  return { out, streams: { stdout: { write: text => { out.stdout += text; } }, stderr: { write: text => { out.stderr += text; } } } };
}

/**
 * An isolated user, state directory and coordinator configuration with the production lifecycle commands wired to
 * the production adapter of `manager` through a controlled runner. Short `/tmp/hl-*` roots keep the endpoint's Unix
 * socket path within its portable limit. Test cleanup ends the services it started, then removes the root.
 *
 * `h.platform` must be passed to the lifecycle commands (it selects launchd or systemd naming); `h.dependencies()`
 * does so. Pass `h.runner` hooks to inject faults.
 */
export async function createControlledNative(t, manager, { gracePeriodMs, uid, state = 'state' } = {}) {
  if (manager !== 'launchd' && manager !== 'systemd') throw new Error(`Unknown manager ${manager}`);
  const root = await fsp.realpath(await fsp.mkdtemp('/tmp/hl-'));
  const home = path.join(root, 'home');
  const openchamber = path.join(root, 'openchamber');
  const configHome = path.join(root, 'xdg-config');
  const runtimeDirectory = path.join(root, 'run');
  await Promise.all([home, openchamber].map(directory => fsp.mkdir(directory, { mode: 0o700 })));
  const stateDirectory = path.join(root, state);
  const configFile = path.join(root, 'coordinator.toml');
  await fsp.writeFile(configFile, `[coordinator]\nstateDirectory = ${JSON.stringify(stateDirectory)}\nglobalConcurrency = 1\nprojectConcurrency = 1\n`);
  const credentialFile = path.join(root, 'credentials.env');
  await fsp.writeFile(credentialFile, `OPENCODE_PASSWORD=${SENTINEL}\n`, { mode: 0o600 });
  await fsp.chmod(credentialFile, 0o600);

  const platform = manager === 'launchd' ? 'darwin' : 'linux';
  const runner = manager === 'launchd'
    ? new ControlledLaunchctl({ gracePeriodMs, uid })
    : new ControlledSystemctl({ gracePeriodMs, configHome });
  /** The adapter-side environment for systemd: an absolute runtime directory, a synthetic bus address and an isolated config home. */
  const adapterEnvironment = { XDG_RUNTIME_DIR: runtimeDirectory, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDirectory}/bus`, XDG_CONFIG_HOME: configHome };
  const createAdapter = context => manager === 'launchd'
    ? { supported: true, manager, adapter: createLaunchdAdapter({ context, runner, uid: runner.uid }) }
    : { supported: true, manager, adapter: createSystemdAdapter({ context, runner, systemctl: runner.systemctl, environment: adapterEnvironment }) };

  t.after(async () => {
    await runner.shutdown();
    await fsp.rm(root, { recursive: true, force: true });
  });

  const lifecycleEnvironment = { HOME: home, OPENCHAMBER_DATA_DIR: openchamber };
  const dependencies = (overrides = {}) => ({
    environment: lifecycleEnvironment, platform, createAdapter,
    launchOverrides: { nodeExecutable: process.execPath, entryPoint: CLI_ENTRY }, pollIntervalMs: 20, requestTimeoutMs: 3000, ...overrides,
  });

  /** Run a public lifecycle command in-process; the result carries captured output and the structured result. */
  async function run(command, args, { signals, dependencies: overrides } = {}) {
    const { out, streams } = capture();
    let result = null;
    const status = await lifecycleCommandMain(command, args, { streams, signals, onResult: value => { result = value; }, dependencies: dependencies(overrides) });
    return { status, ...out, result };
  }

  /** JSON mode: stdout is exactly one document and it satisfies the documented contract. */
  async function runJson(command, args, options) {
    const outcome = await run(command, [...args, '--json'], options);
    const document = parseLifecycleResult(JSON.parse(outcome.stdout));
    if (outcome.stdout !== renderLifecycleJson(document)) throw new Error('stdout must be exactly one lifecycle document');
    if (outcome.status !== lifecycleExitCode(document)) throw new Error(`exit status ${outcome.status} does not match the document`);
    return { ...outcome, document };
  }

  const harness = {
    manager, platform, runner, root, home, stateDirectory, configFile, credentialFile, openchamber, configHome, adapterEnvironment, createAdapter, dependencies,
    endpoint: path.join(stateDirectory, 'coordinator.sock'),
    run, runJson,
    start: (extra = [], options) => runJson('start', ['--coordinator-config', configFile, '--env-file', credentialFile, ...extra], options),
    stop: (extra = [], options) => runJson('stop', ['--coordinator-config', configFile, ...extra], options),
    /** The launch context the lifecycle commands resolve, for building a production adapter next to the commands. */
    context: (extra = {}) => resolveLaunchContext({ coordinatorConfig: configFile, envFile: credentialFile, entryPoint: CLI_ENTRY, ...extra }, lifecycleEnvironment),
    /** The production adapter for the same launch context, sharing this harness's runner. */
    async adapter(extra) { return createAdapter(await harness.context(extra)).adapter; },
    names: () => nativeServiceNames(stateDirectory),
    /** The label (launchd) or unit (systemd) of this fixture. */
    label: () => manager === 'launchd' ? nativeServiceNames(stateDirectory).launchdLabel : nativeServiceNames(stateDirectory).systemdUnit,
    definitionPath: () => manager === 'launchd'
      ? launchdPaths(stateDirectory, nativeServiceNames(stateDirectory).launchdLabel).definition
      : systemdPaths(stateDirectory, nativeServiceNames(stateDirectory).systemdUnit).definition,
    logPaths: () => launchdPaths(stateDirectory, nativeServiceNames(stateDirectory).launchdLabel),
    linkPath: () => path.join(configHome, 'systemd', 'user', nativeServiceNames(stateDirectory).systemdUnit),
    /** The service record of this fixture's label, created empty if the manager has not seen it yet. */
    service: () => runner.service(harness.label()),
    /** An authenticated IPC client, independent of the lifecycle commands. */
    async client() { return createCoordinatorClient(harness.endpoint, await readCoordinatorToken(stateDirectory), { timeoutMs: 5000, deadlineMs: 10000 }); },
  };
  return harness;
}
