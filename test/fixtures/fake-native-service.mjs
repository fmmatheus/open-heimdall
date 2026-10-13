import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { MANAGER_LABEL_VARIABLE } from '../../dist/coordinator/launch-context.js';
import { nativeServiceNames } from '../../dist/coordinator/native/types.js';

/**
 * Adapter-level stand-in for launchd/systemd. It implements the native adapter interface with the same
 * install/start/inspect semantics, but "starting" spawns the installed `heimdall coordinator serve` entry point as a
 * plain child process with the nonsecret environment the definition would carry. Evidence from it is adapter/CLI
 * evidence; it does not establish launchd or systemd behavior.
 */
export class FakeServiceManager {
  constructor({ behavior = 'serve' } = {}) {
    /** `serve` runs the real coordinator; `hang` never listens; `exit` exits immediately. */
    this.behavior = behavior;
    this.definition = null;
    this.child = null;
    this.exit = null;
    this.calls = [];
    this.spawns = [];
    this.output = { stdout: '', stderr: '' };
    this.installFailure = null;
    this.foreign = null;
    this.externalPid = null;
    this.createAdapter = context => ({ supported: true, manager: 'launchd', adapter: this.adapterFor(context) });
  }

  get spawnCount() { return this.spawns.length; }

  running() { return this.externalPid !== null || (this.child !== null && this.exit === null); }

  adapterFor(context) {
    const manager = this;
    const stateDirectory = context.configuration.stateDirectory;
    const label = nativeServiceNames(stateDirectory).launchdLabel;
    const definitionPath = path.join(stateDirectory, 'service', 'fake-definition.json');
    const description = () => JSON.stringify({ label, arguments: context.arguments, environment: { ...context.environment, [MANAGER_LABEL_VARIABLE]: label }, nodeExecutable: context.nodeExecutable, entryPoint: context.entryPoint });
    const record = name => manager.calls.push(name);
    return {
      identity: () => ({ manager: 'launchd', label, definitionPath }),
      render: description,
      logLocation: () => `fake service output kept in memory (${label})`,
      async remembered() {
        record('remembered');
        if (manager.foreign) return { kind: 'foreign', reason: manager.foreign };
        if (!manager.definition) return { kind: 'absent' };
        return { kind: 'owned', credentialFile: manager.definition.credentialFile, openchamberDataDirectory: manager.definition.openchamberDataDirectory };
      },
      async inspect() {
        record('inspect');
        const running = manager.running();
        return {
          registration: manager.definition ? 'loaded' : 'not-loaded', running,
          pid: manager.externalPid ?? (running ? manager.child.pid : null), lastExitStatus: manager.exit?.code ?? null,
          registeredPath: manager.definition ? definitionPath : null, detail: running ? 'fake service running' : 'fake service not running',
        };
      },
      async registrationOwnership(inspection) {
        if (inspection.registration !== 'loaded') return { kind: 'refused', code: 'state-unknown', reason: 'the fake service is not loaded' };
        if (inspection.registeredPath !== definitionPath) return { kind: 'refused', code: 'registered-elsewhere', reason: `the fake service is registered from ${inspection.registeredPath ?? 'an unreported path'}` };
        if (manager.foreign) return { kind: 'refused', code: 'foreign-definition', reason: manager.foreign };
        return { kind: 'owned' };
      },
      async install() {
        record('install');
        if (manager.installFailure) return manager.installFailure;
        const text = description();
        if (manager.definition && manager.definition.text !== text && manager.running()) {
          return { outcome: 'conflict', registered: false, detail: 'running definition differs', conflicts: [{ code: 'running-context-changed', message: 'The running service uses another launch context.', action: 'Stop the coordinator, then start it again.', changes: ['context'] }] };
        }
        const outcome = manager.definition === null ? 'created' : manager.definition.text === text ? 'unchanged' : 'refreshed';
        manager.definition = { text, credentialFile: context.credentialFile, openchamberDataDirectory: context.openchamberDataDirectory };
        await fs.mkdir(path.dirname(definitionPath), { recursive: true, mode: 0o700 });
        await fs.writeFile(definitionPath, text, { mode: 0o600 });
        return { outcome, registered: outcome === 'created', conflicts: [], detail: 'fake definition installed' };
      },
      async start() {
        record('start');
        if (manager.running()) return { outcome: 'already-running', conflicts: [], detail: 'fake service already running' };
        manager.exit = null;
        const environment = { HOME: context.environment.HOME, ...context.environment, [MANAGER_LABEL_VARIABLE]: label };
        const program = manager.behavior === 'exit' ? ['-e', 'process.exit(3)'] : manager.behavior === 'hang' ? ['-e', 'setInterval(() => {}, 1000)'] : ['--no-warnings', context.entryPoint, ...context.arguments];
        manager.spawns.push({ file: context.nodeExecutable, args: program, environment });
        const child = spawn(context.nodeExecutable, program, { env: environment, stdio: ['ignore', 'pipe', 'pipe'], cwd: path.parse(stateDirectory).root });
        manager.child = child;
        child.stdout.on('data', chunk => { manager.output.stdout += chunk; });
        child.stderr.on('data', chunk => { manager.output.stderr += chunk; });
        manager.exited = new Promise(resolve => child.once('exit', (code, signal) => { manager.exit = { code, signal }; resolve(manager.exit); }));
        return { outcome: 'started', conflicts: [], detail: 'fake service started' };
      },
      async unloadInactive() { return { outcome: 'nothing-to-remove', detail: 'fake' }; },
      async cleanupFixture() { return { outcome: 'nothing-to-remove', detail: 'fake' }; },
    };
  }

  /** Graceful end of a child the test started: SIGTERM, the same signal a foreground coordinator drains on. */
  async terminate() {
    if (this.child && this.exit === null) {
      this.child.kill('SIGTERM');
      await Promise.race([this.exited, new Promise(resolve => setTimeout(resolve, 10000))]);
      if (this.exit === null) this.child.kill('SIGKILL');
      await this.exited;
    }
  }
}
