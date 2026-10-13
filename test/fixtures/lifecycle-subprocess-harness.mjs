import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseLifecycleResult } from '../../dist/coordinator/lifecycle-result.js';
import { nativeServiceNames } from '../../dist/coordinator/native/types.js';
import { launchdPaths } from '../../dist/coordinator/native/launchd.js';
import { systemdPaths } from '../../dist/coordinator/native/systemd.js';

/**
 * Subprocess lifecycle harness. Every lifecycle command runs in its OWN process (`lifecycle-cli-entry.mjs`) with the
 * production adapter and the production `createExecFileRunner`; the native tool is an explicit synthetic executable
 * (`synthetic-native-tool.mjs`) that keeps its state in files and can hold any verb on a gate file. A test can
 * therefore end the invoking process while its native start request is still being processed, run another command from a
 * different process, and only then let the request through.
 *
 * Evidence is mocked-manager evidence: the lifecycle commands, adapters, runner, definitions, lock, record files and
 * the coordinator process are real; launchd and systemd themselves are not. Harness cleanup (ending the processes it
 * started) is not product behavior.
 */

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI_ENTRY = path.join(repository, 'dist', 'cli.js');
const ENTRY = path.join(repository, 'test', 'fixtures', 'lifecycle-cli-entry.mjs');
const TOOL = path.join(repository, 'test', 'fixtures', 'synthetic-native-tool.mjs');
export const SENTINEL = 'lifecycle-subprocess-synthetic-credential';

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const lines = file => { try { return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch { return []; } };

export async function until(predicate, description, milliseconds = 20_000) {
  const deadline = Date.now() + milliseconds;
  while (true) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`);
    await sleep(25);
  }
}

export async function createSubprocessNative(t, manager) {
  if (manager !== 'launchd' && manager !== 'systemd') throw new Error(`Unknown manager ${manager}`);
  const root = await fsp.realpath(await fsp.mkdtemp('/tmp/hl-'));
  const home = path.join(root, 'home');
  const openchamber = path.join(root, 'openchamber');
  const configHome = path.join(root, 'xdg-config');
  const runtimeDirectory = path.join(root, 'run');
  const managerDirectory = path.join(root, 'manager');
  const stateDirectory = path.join(root, 'state');
  for (const directory of [home, openchamber, runtimeDirectory, managerDirectory]) await fsp.mkdir(directory, { mode: 0o700 });
  for (const directory of ['gates', 'reached', 'delay', 'fail', 'inflight']) await fsp.mkdir(path.join(managerDirectory, directory));
  const configFile = path.join(root, 'coordinator.toml');
  await fsp.writeFile(configFile, `[coordinator]\nstateDirectory = ${JSON.stringify(stateDirectory)}\nglobalConcurrency = 1\nprojectConcurrency = 1\n`);
  const credentialFile = path.join(root, 'credentials.env');
  await fsp.writeFile(credentialFile, `OPENCODE_PASSWORD=${SENTINEL}\n`, { mode: 0o600 });
  await fsp.chmod(credentialFile, 0o600);

  const kind = manager === 'launchd' ? 'launchctl' : 'systemctl';
  const uid = process.getuid();
  const toolConfig = path.join(root, 'tool.json');
  await fsp.writeFile(toolConfig, JSON.stringify({ kind, managerDirectory, configHome, uid }));
  const tool = path.join(root, kind);
  await fsp.writeFile(tool, `#!/bin/sh\nexec '${process.execPath}' '${TOOL}' '${toolConfig}' "$@"\n`, { mode: 0o755 });
  await fsp.chmod(tool, 0o755);
  const fixturePath = path.join(root, 'fixture.json');
  await fsp.writeFile(fixturePath, JSON.stringify({ manager, tool, uid, home, openchamber, configHome, runtimeDirectory, entryPoint: CLI_ENTRY }));

  const names = nativeServiceNames(stateDirectory);
  const label = manager === 'launchd' ? names.launchdLabel : names.systemdUnit;
  const startVerb = manager === 'launchd' ? 'kickstart' : 'start';
  const spawned = [];

  t.after(async () => {
    for (const cli of spawned) if (cli.exitStatus === null) cli.child.kill('SIGKILL');
    // Harness cleanup: end what the synthetic manager started, gracefully first.
    for (const name of await fsp.readdir(path.join(managerDirectory, 'inflight')).catch(() => [])) {
      const pid = Number(name.split('.')[1]);
      if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
    const state = toolState();
    if (state.supervisorPid && alive(state.supervisorPid)) process.kill(state.supervisorPid, 'SIGTERM');
    const ended = await until(() => !state.pid || !alive(state.pid), 'the coordinator to end', 12_000).then(() => true, () => false);
    if (!ended && state.pid && alive(state.pid)) process.kill(state.pid, 'SIGKILL');
    await fsp.rm(root, { recursive: true, force: true });
  });

  const toolState = () => { try { return JSON.parse(fs.readFileSync(path.join(managerDirectory, 'state.json'), 'utf8')); } catch { return {}; } };

  /** Start a lifecycle command in its own process. `exit` resolves with the status once the process has ended. */
  function cli(command, args = []) {
    const child = spawn(process.execPath, [ENTRY, fixturePath, command, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: home } });
    const handle = { child, pid: child.pid, stdout: '', stderr: '', exitStatus: null };
    child.stdout.on('data', chunk => { handle.stdout += chunk; });
    child.stderr.on('data', chunk => { handle.stderr += chunk; });
    handle.exit = new Promise(resolve => child.once('close', (code, signal) => { handle.exitStatus = { code, signal }; resolve(handle.exitStatus); }));
    spawned.push(handle);
    return handle;
  }

  /** Run a command to completion in its own process and parse the one JSON document it prints. */
  async function runJson(command, args = []) {
    const handle = cli(command, [...args, '--json']);
    const status = await handle.exit;
    let document = null;
    try { document = parseLifecycleResult(JSON.parse(handle.stdout)); } catch { /* the caller's assertion reports the output */ }
    return { status, stdout: handle.stdout, stderr: handle.stderr, document };
  }

  const harness = {
    manager, kind, root, home, stateDirectory, configFile, credentialFile, managerDirectory, label, startVerb, tool,
    cli, runJson,
    start: (extra = []) => runJson('start', ['--coordinator-config', configFile, '--env-file', credentialFile, ...extra]),
    stop: (extra = []) => runJson('stop', ['--coordinator-config', configFile, ...extra]),
    /** Spawn `start` without waiting for it. */
    spawnStart: (extra = []) => cli('start', ['--coordinator-config', configFile, '--env-file', credentialFile, '--json', ...extra]),
    recordFile: () => path.join(stateDirectory, 'lifecycle', 'launch-attempt.json'),
    readRecord: () => { try { return JSON.parse(fs.readFileSync(path.join(stateDirectory, 'lifecycle', 'launch-attempt.json'), 'utf8')); } catch { return null; } },
    definitionPath: () => manager === 'launchd'
      ? launchdPaths(stateDirectory, label).definition
      : systemdPaths(stateDirectory, label).definition,
    // --- gates and evidence of the synthetic tool ---
    gate: verb => fsp.writeFile(path.join(managerDirectory, 'gates', verb), ''),
    ungate: verb => fsp.rm(path.join(managerDirectory, 'gates', verb), { force: true }),
    failWith: (verb, status) => fsp.writeFile(path.join(managerDirectory, 'fail', verb), String(status)),
    /** Resolves with the pid of a tool call that is waiting on the gate of `verb`. */
    async reached(verb) {
      return until(async () => {
        const name = (await fsp.readdir(path.join(managerDirectory, 'reached')).catch(() => [])).find(entry => entry.startsWith(`${verb}.`));
        return name ? Number(name.split('.')[1]) : null;
      }, `a ${verb} call to reach its gate`);
    },
    toolAlive: pid => alive(pid),
    calls: () => lines(path.join(managerDirectory, 'calls.jsonl')),
    verbs: () => lines(path.join(managerDirectory, 'calls.jsonl')).map(call => call.verb),
    signals: () => lines(path.join(managerDirectory, 'signals.jsonl')),
    violations: () => lines(path.join(managerDirectory, 'violations.jsonl')),
    toolState,
    /** Resolves once the service the synthetic manager launched is running. */
    runningPid: () => until(() => { const state = toolState(); return state.pid && state.exit === null && alive(state.pid) ? state.pid : null; }, 'the launched coordinator to run'),
    /** Resolves once the launched coordinator's endpoint exists, so a lifecycle command can reach it. */
    async coordinatorUp() {
      const pid = await harness.runningPid();
      await until(() => fs.existsSync(path.join(stateDirectory, 'coordinator.sock')), 'the coordinator endpoint');
      return pid;
    },
  };
  return harness;
}
