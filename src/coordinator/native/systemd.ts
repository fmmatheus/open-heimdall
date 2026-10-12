import fs from 'node:fs/promises';
import path from 'node:path';
import { MANAGER_LABEL_VARIABLE } from '../launch-context.js';
import type { LaunchContext } from '../launch-context.js';
import { ensurePrivateDirectory, readPrivateText, validatePrivateDirectory, writePrivateFile } from './private-files.js';
import { createExecFileRunner, nativeServiceNames } from './types.js';
import type { CleanupResult, CommandRunner, InstallResult, NativeServiceAdapter, RememberedContext, ServiceConflict, ServiceIdentity, ServiceInspection, StartResult } from './types.js';

const SYSTEMCTL_CANDIDATES = ['/usr/bin/systemctl', '/bin/systemctl', '/usr/local/bin/systemctl'];
const DEFINITION_DIRECTORY = 'service';
const MAXIMUM_DEFINITION_BYTES = 256 * 1024;
const START_TIMEOUT_MS = 30000;
const SHOW_PROPERTIES = 'LoadState,ActiveState,SubState,MainPID,ExecMainStatus,ExecMainCode,FragmentPath';
const DEFINITION_MARKER = '# Managed by OpenHeimdall: loaded without being enabled; started only by an explicit start.';

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;
const clip = (value: string) => value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 300);

/** Resolve `systemctl` from fixed system locations rather than from PATH. Undefined when none is executable. */
export async function resolveSystemctl(candidates: readonly string[] = SYSTEMCTL_CANDIDATES): Promise<string | undefined> {
  for (const candidate of candidates) {
    try { await fs.access(candidate, 1); return candidate; } catch { /* try the next location */ }
  }
  return undefined;
}

// --- Unit-file quoting ---------------------------------------------------------------------------------------

function requireNoControl(value: string, what: string): void {
  if (CONTROL_CHARACTERS.test(value)) throw new Error(`${what} contains a control character and cannot be written to a unit file`);
}

/**
 * Quote one `ExecStart=` word. Inside double quotes backslash and the quote are backslash-escaped, and `$` and `%`
 * are doubled so neither environment-variable nor specifier expansion applies. The word stays literal.
 */
export function quoteExecWord(value: string): string {
  requireNoControl(value, 'A service argument');
  return `"${value.replace(/[\\"]/g, match => `\\${match}`).replace(/\$/g, () => '$$').replace(/%/g, () => '%%')}"`;
}

/** Quote one `Environment=` assignment. Specifiers expand there but `$` does not, so only `%` is doubled. */
export function quoteEnvironmentAssignment(name: string, value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`Invalid environment variable name ${name}`);
  requireNoControl(value, `The value of ${name}`);
  return `"${`${name}=${value}`.replace(/[\\"]/g, match => `\\${match}`).replace(/%/g, () => '%%')}"`;
}

const SIMPLE_ESCAPES: Record<string, string> = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"', "'": "'", s: ' ' };

/** Splits a unit-file value into words using systemd's quoting rules: whitespace, quotes and C-style escapes. */
export function splitUnitWords(value: string): string[] {
  const words: string[] = [];
  let index = 0;
  while (index < value.length) {
    while (index < value.length && /\s/.test(value[index]!)) index++;
    if (index >= value.length) break;
    let word = '';
    let quote: string | null = null;
    for (; index < value.length; index++) {
      const character = value[index]!;
      if (character === '\\') {
        const escaped = value[++index];
        if (escaped === undefined) throw new Error('Unit value ends with a dangling backslash');
        if (escaped in SIMPLE_ESCAPES) { word += SIMPLE_ESCAPES[escaped]; continue; }
        if (escaped === 'x') {
          const digits = /^[0-9a-fA-F]{2}/.exec(value.slice(index + 1));
          if (!digits) throw new Error('Invalid \\x escape in unit value');
          word += String.fromCharCode(parseInt(digits[0], 16));
          index += 2;
          continue;
        }
        const octal = /^[0-7]{3}/.exec(value.slice(index));
        if (octal) { word += String.fromCharCode(parseInt(octal[0], 8)); index += 2; continue; }
        throw new Error(`Unsupported escape \\${escaped} in unit value`);
      }
      if (quote) { if (character === quote) quote = null; else word += character; continue; }
      if (character === '"' || character === "'") { quote = character; continue; }
      if (/\s/.test(character)) break;
      word += character;
    }
    if (quote) throw new Error('Unterminated quote in unit value');
    words.push(word);
  }
  return words;
}

function undoSpecifiers(word: string, expandsVariables: boolean): string {
  let result = '';
  for (let index = 0; index < word.length; index++) {
    const character = word[index]!;
    if (character === '%' || (expandsVariables && character === '$')) {
      if (word[index + 1] !== character) throw new Error('The unit value is not a literal: it contains an unescaped expansion');
      result += character;
      index++;
    } else result += character;
  }
  return result;
}

/** The literal command line `ExecStart=` runs: the words with `$$` and `%%` collapsed. Throws on unescaped expansions. */
export function parseExecStart(value: string): string[] {
  return splitUnitWords(value).map(word => undoSpecifiers(word, true));
}

// --- Definition ----------------------------------------------------------------------------------------------

/** The variable parts of the generated unit. Everything else is fixed policy. */
export interface SystemdDefinition {
  unit: string;
  execStart: string[];
  environment: Record<string, string>;
}

export interface SystemdPaths { definition: string; serviceDirectory: string }

export function systemdPaths(stateDirectory: string, unit: string): SystemdPaths {
  const serviceDirectory = path.join(stateDirectory, DEFINITION_DIRECTORY);
  return { serviceDirectory, definition: path.join(serviceDirectory, unit) };
}

export function systemdDefinition(context: LaunchContext, unit: string): SystemdDefinition {
  const environment: Record<string, string> = { ...context.environment, [MANAGER_LABEL_VARIABLE]: unit };
  return {
    unit,
    execStart: [context.nodeExecutable, context.entryPoint, ...context.arguments],
    environment: Object.fromEntries(Object.entries(environment).sort(([a], [b]) => a < b ? -1 : 1)),
  };
}

/**
 * Render the unit. There is no `[Install]` section, so it cannot be enabled. `Type=exec` with `Restart=no` keeps the
 * coordinator a foreground main process the manager never restarts, and KillMode/TimeoutStopSec stay at their defaults.
 * Only nonsecret values reach `Environment=`; credentials are read by the coordinator from its own file.
 */
export function renderSystemdUnit(definition: SystemdDefinition): string {
  return [
    DEFINITION_MARKER,
    '[Unit]',
    'Description=OpenHeimdall coordinator',
    '',
    '[Service]',
    'Type=exec',
    'Restart=no',
    `ExecStart=${definition.execStart.map(quoteExecWord).join(' ')}`,
    `Environment=${Object.entries(definition.environment).map(([name, value]) => quoteEnvironmentAssignment(name, value)).join(' ')}`,
    'StandardOutput=journal',
    'StandardError=journal',
    '',
  ].join('\n');
}

/** Read back an owned definition; undefined when the text is not exactly the unit shape this module renders. */
export function parseSystemdUnit(text: string, unit: string): SystemdDefinition | undefined {
  try {
    const lines = text.split('\n');
    if (lines[0] !== DEFINITION_MARKER) return undefined;
    const sections: Record<string, Map<string, string>> = {};
    let current: Map<string, string> | undefined;
    for (const line of lines.slice(1)) {
      if (!line.trim() || line.startsWith('#') || line.startsWith(';')) continue;
      const header = /^\[([A-Za-z]+)\]$/.exec(line);
      if (header) {
        if (header[1] !== 'Unit' && header[1] !== 'Service') return undefined;
        if (sections[header[1]]) return undefined;
        current = sections[header[1]] = new Map();
        continue;
      }
      const separator = line.indexOf('=');
      if (!current || separator < 1) return undefined;
      const key = line.slice(0, separator);
      if (current.has(key)) return undefined;
      current.set(key, line.slice(separator + 1));
    }
    const service = sections.Service;
    if (!service || !sections.Unit) return undefined;
    const fixed: [string, string][] = [['Type', 'exec'], ['Restart', 'no'], ['StandardOutput', 'journal'], ['StandardError', 'journal']];
    if (service.size !== fixed.length + 2 || fixed.some(([key, expected]) => service.get(key) !== expected)) return undefined;
    const execStart = parseExecStart(service.get('ExecStart') ?? '');
    if (!execStart.length) return undefined;
    const environment: Record<string, string> = {};
    for (const word of splitUnitWords(service.get('Environment') ?? '')) {
      const assignment = undoSpecifiers(word, false);
      const equals = assignment.indexOf('=');
      if (equals < 1) return undefined;
      environment[assignment.slice(0, equals)] = assignment.slice(equals + 1);
    }
    if (environment[MANAGER_LABEL_VARIABLE] !== unit) return undefined;
    return { unit, execStart, environment };
  } catch { return undefined; }
}

function optionValue(argumentsList: readonly string[], option: string): string | null {
  const index = argumentsList.indexOf(option);
  return index >= 0 ? argumentsList[index + 1] ?? null : null;
}

/** Names the launch context elements that differ between an installed and a desired definition. */
export function systemdDefinitionChanges(installed: SystemdDefinition, desired: SystemdDefinition): string[] {
  const changes: string[] = [];
  const [installedNode, installedEntry, ...installedRest] = installed.execStart;
  const [desiredNode, desiredEntry, ...desiredRest] = desired.execStart;
  if (installedNode !== desiredNode) changes.push('executable');
  if (installedEntry !== desiredEntry) changes.push('entry-point');
  if (optionValue(installedRest, '--coordinator-config') !== optionValue(desiredRest, '--coordinator-config')
    || installed.environment.HEIMDALL_COORDINATOR_CONFIG_ORIGIN !== desired.environment.HEIMDALL_COORDINATOR_CONFIG_ORIGIN) changes.push('configuration');
  if (optionValue(installedRest, '--env-file') !== optionValue(desiredRest, '--env-file')) changes.push('credential-source');
  if (installed.environment.OPENCHAMBER_DATA_DIR !== desired.environment.OPENCHAMBER_DATA_DIR) changes.push('data-directory');
  if (installed.environment.HOME !== desired.environment.HOME) changes.push('home');
  if (!changes.length && JSON.stringify(installed) !== JSON.stringify(desired)) changes.push('definition');
  return changes;
}

// --- Manager state -------------------------------------------------------------------------------------------

/**
 * Parse `systemctl --user show` output. The state is `unknown` unless LoadState and ActiveState are recognized, and a
 * process is reported absent only for a recognized stopped state with no main PID.
 */
export function parseSystemctlShow(output: string): Omit<ServiceInspection, 'detail'> & { recognized: boolean; loadState: string } {
  const unknown = { recognized: false, loadState: '', registration: 'unknown' as const, running: 'unknown' as const, pid: null, lastExitStatus: null, registeredPath: null };
  const properties = new Map<string, string>();
  for (const line of output.split('\n')) {
    const separator = line.indexOf('=');
    if (separator > 0 && !properties.has(line.slice(0, separator))) properties.set(line.slice(0, separator), line.slice(separator + 1).trim());
  }
  const loadState = properties.get('LoadState');
  const activeState = properties.get('ActiveState');
  if (loadState === undefined || activeState === undefined) return unknown;
  const rawPid = properties.get('MainPID');
  const pid = rawPid !== undefined && /^\d+$/.test(rawPid) ? Number(rawPid) : null;
  const exit = properties.get('ExecMainStatus');
  const lastExitStatus = exit !== undefined && /^\d+$/.test(exit) ? Number(exit) : null;
  const registeredPath = properties.get('FragmentPath') || null;
  if (loadState === 'not-found') {
    return { recognized: true, loadState, registration: 'not-loaded', running: pid === null || pid === 0 ? false : 'unknown', pid: pid || null, lastExitStatus, registeredPath };
  }
  if (loadState !== 'loaded') return { ...unknown, recognized: true, loadState, registeredPath };
  let running: boolean | 'unknown' = 'unknown';
  if (['active', 'activating', 'reloading', 'deactivating', 'refreshing'].includes(activeState)) running = true;
  else if ((activeState === 'inactive' || activeState === 'failed') && pid === 0) running = false;
  return { recognized: true, loadState, registration: 'loaded', running, pid: pid || null, lastExitStatus, registeredPath };
}

export interface UserManagerStatus { available: boolean; reason: string }

export const MANAGER_UNAVAILABLE_ACTION = 'Run the command from a login session that provides a systemd user manager and user bus (for example a desktop session or an SSH login through pam_systemd), '
  + 'where XDG_RUNTIME_DIR is set and `systemctl --user show-environment` succeeds. Heimdall does not change linger or login settings, does not use sudo '
  + 'and does not fall back to a detached process; run `heimdall coordinator serve` in the foreground if you need the coordinator now.';

export interface SystemdAdapterOptions {
  context: LaunchContext;
  runner?: CommandRunner;
  /** Absolute systemctl path. Resolved from fixed system locations when omitted. */
  systemctl?: string;
  /** Environment consulted for the user runtime directory, bus address and config home. Defaults to the process environment. */
  environment?: NodeJS.ProcessEnv;
}

/**
 * Check that a systemd user manager and user bus are usable, without changing anything. No login, linger or
 * privilege change is attempted when they are not.
 */
export async function checkUserManager(runner: CommandRunner, systemctl: string | undefined, environment: NodeJS.ProcessEnv): Promise<UserManagerStatus> {
  if (!systemctl) return { available: false, reason: 'systemctl was not found in /usr/bin, /bin or /usr/local/bin' };
  const runtime = environment.XDG_RUNTIME_DIR;
  if (!runtime || !path.isAbsolute(runtime)) return { available: false, reason: 'XDG_RUNTIME_DIR is not set to an absolute path, so there is no user runtime directory' };
  if (!environment.DBUS_SESSION_BUS_ADDRESS) {
    const bus = await fs.stat(path.join(runtime, 'bus')).catch(() => undefined);
    if (!bus?.isSocket()) return { available: false, reason: `DBUS_SESSION_BUS_ADDRESS is not set and ${path.join(runtime, 'bus')} is not a socket, so there is no user bus` };
  }
  const result = await runner.run(systemctl, ['--user', 'show-environment']);
  if (result.error) return { available: false, reason: clip(result.error) };
  if (result.exitCode !== 0) return { available: false, reason: `systemctl --user show-environment exited with ${result.exitCode}: ${clip(`${result.stderr} ${result.stdout}`)}` };
  return { available: true, reason: 'the systemd user manager answered' };
}

export function createSystemdAdapter(options: SystemdAdapterOptions): NativeServiceAdapter {
  const { context } = options;
  const runner = options.runner ?? createExecFileRunner();
  const environment = options.environment ?? process.env;
  const stateDirectory = context.configuration.stateDirectory;
  const unit = nativeServiceNames(stateDirectory).systemdUnit;
  const paths = systemdPaths(stateDirectory, unit);
  const configHome = environment.XDG_CONFIG_HOME && path.isAbsolute(environment.XDG_CONFIG_HOME) ? environment.XDG_CONFIG_HOME : path.join(context.home, '.config');
  /** Where `systemctl --user link` places the symlink to the owned definition. */
  const linkPath = path.join(configHome, 'systemd', 'user', unit);
  const desired = systemdDefinition(context, unit);
  const desiredText = renderSystemdUnit(desired);
  let systemctlPromise: Promise<string | undefined> | undefined;
  const systemctlPath = () => systemctlPromise ??= options.systemctl ? Promise.resolve(options.systemctl) : resolveSystemctl();

  const identity = (): ServiceIdentity => ({ manager: 'systemd', label: unit, definitionPath: paths.definition });
  const conflict = (code: ServiceConflict['code'], message: string, action: string, changes?: string[]): ServiceConflict => ({ code, message, action, ...(changes ? { changes } : {}) });
  const unavailable = (reason: string): ServiceConflict => conflict('manager-unavailable', `The systemd user manager is not usable: ${reason}.`, MANAGER_UNAVAILABLE_ACTION);

  async function run(args: readonly string[], timeoutMs?: number) {
    const systemctl = await systemctlPath();
    if (!systemctl) return { exitCode: null, stdout: '', stderr: '', error: 'systemctl was not found' };
    return runner.run(systemctl, ['--user', ...args], timeoutMs ? { timeoutMs } : undefined);
  }

  const preflight = async () => checkUserManager(runner, await systemctlPath(), environment);

  async function showUnit(): Promise<ServiceInspection> {
    const result = await run(['show', unit, '-p', SHOW_PROPERTIES]);
    if (result.error) return { registration: 'unknown', running: 'unknown', pid: null, lastExitStatus: null, registeredPath: null, detail: clip(result.error) };
    if (result.exitCode !== 0) return { registration: 'unknown', running: 'unknown', pid: null, lastExitStatus: null, registeredPath: null, detail: `systemctl show exited with ${result.exitCode}: ${clip(`${result.stderr} ${result.stdout}`)}` };
    const parsed = parseSystemctlShow(result.stdout);
    if (!parsed.recognized) return { registration: 'unknown', running: 'unknown', pid: null, lastExitStatus: null, registeredPath: null, detail: 'systemctl show output was not recognized' };
    const { recognized: _recognized, loadState, ...state } = parsed;
    if (state.registration === 'unknown' && loadState) return { ...state, detail: `${unit} has LoadState=${clip(loadState)}, which is not usable` };
    return { ...state, detail: state.running === 'unknown' ? 'systemctl show reported no recognized process state' : state.running ? `${unit} is running` : state.registration === 'not-loaded' ? `${unit} is not loaded` : `${unit} is loaded and not running` };
  }

  async function inspect(): Promise<ServiceInspection> {
    const manager = await preflight();
    if (!manager.available) return { registration: 'unknown', running: 'unknown', pid: null, lastExitStatus: null, registeredPath: null, detail: manager.reason };
    return showUnit();
  }

  /** The reported fragment is ours when it is the owned definition, its user-config link, or resolves to the definition. */
  async function ownsFragment(registered: string | null): Promise<boolean> {
    if (!registered) return false;
    if (registered === paths.definition || registered === linkPath) return true;
    const [real, owned] = await Promise.all([fs.realpath(registered).catch(() => undefined), fs.realpath(paths.definition).catch(() => undefined)]);
    return real !== undefined && real === owned;
  }

  type Existing = { kind: 'absent' } | { kind: 'owned'; definition: SystemdDefinition; text: string } | { kind: 'foreign'; reason: string };

  async function existingDefinition(): Promise<Existing> {
    try {
      if (!await validatePrivateDirectory(paths.serviceDirectory, 'Heimdall service directory')) return { kind: 'absent' };
      const text = await readPrivateText(paths.definition, 'The service definition', MAXIMUM_DEFINITION_BYTES);
      if (text === null) return { kind: 'absent' };
      const definition = parseSystemdUnit(text, unit);
      return definition ? { kind: 'owned', definition, text } : { kind: 'foreign', reason: 'it is not a Heimdall coordinator unit for this state directory' };
    } catch (error) { return { kind: 'foreign', reason: error instanceof Error ? error.message : 'it could not be validated' }; }
  }

  const foreign = (reason: string): ServiceConflict => conflict('foreign-definition',
    `A service definition exists at ${paths.definition} but ${reason}.`,
    'Inspect or move that file yourself; Heimdall will not overwrite or load it.');

  const failed = (detail: string, conflicts: ServiceConflict[] = []): InstallResult => ({ outcome: 'failed', registered: false, conflicts, detail });
  const conflicted = (conflicts: ServiceConflict[]): InstallResult => ({ outcome: 'conflict', registered: false, conflicts, detail: conflicts[0]!.message });

  async function writeDefinition(existing: Exclude<Existing, { kind: 'foreign' }>): Promise<string | undefined> {
    try {
      await ensurePrivateDirectory(stateDirectory, 'Coordinator state directory', { recursive: true });
      await ensurePrivateDirectory(paths.serviceDirectory, 'Heimdall service directory');
      if (existing.kind !== 'owned' || existing.text !== desiredText) await writePrivateFile(paths.definition, desiredText);
      return undefined;
    } catch (error) { return `Could not prepare the service definition: ${clip(error instanceof Error ? error.message : 'unknown error')}`; }
  }

  async function reload(): Promise<string | undefined> {
    const result = await run(['daemon-reload']);
    return result.error || result.exitCode !== 0 ? `systemctl daemon-reload failed: ${clip(result.error ?? `${result.stderr} ${result.stdout}`)}` : undefined;
  }

  /**
   * Make an owned inactive definition loadable without enabling it: `systemctl --user link` places a symlink to the
   * private definition in the user unit directory (it creates no WantedBy links), then daemon-reload makes the
   * manager read it. A refresh of an already linked definition only rewrites the file and reloads.
   */
  async function install(): Promise<InstallResult> {
    const manager = await preflight();
    if (!manager.available) return failed(manager.reason, [unavailable(manager.reason)]);
    const inspection = await showUnit();
    if (inspection.registration === 'unknown') {
      return conflicted([conflict('state-unknown', `The systemd state of ${unit} could not be determined: ${inspection.detail}.`, `Run \`systemctl --user show ${unit}\` yourself and retry once the state is clear.`)]);
    }
    const existing = await existingDefinition();
    if (existing.kind === 'foreign') return conflicted([foreign(existing.reason)]);

    if (inspection.registration === 'loaded') {
      if (!await ownsFragment(inspection.registeredPath)) {
        return conflicted([conflict('registered-elsewhere',
          `${unit} is loaded from ${inspection.registeredPath ?? 'an unreported path'}, not from ${paths.definition}.`,
          'Remove or rename that unit yourself; Heimdall will not replace a unit it does not own.')]);
      }
      if (existing.kind === 'absent') {
        return conflicted([conflict('registered-elsewhere', `${unit} is loaded but its definition file ${paths.definition} is missing.`,
          'Stop the service gracefully with `heimdall coordinator stop`, then remove the stale link yourself.')]);
      }
      const changes = systemdDefinitionChanges(existing.definition, desired);
      if (!changes.length && existing.text === desiredText) return { outcome: 'unchanged', registered: false, conflicts: [], detail: `${unit} is already registered with the current definition` };
      if (inspection.running === true) {
        return conflicted([conflict('running-context-changed',
          `The running coordinator was started with a different ${changes.join(', ') || 'definition'}; a live unit is never replaced.`,
          'Stop the coordinator with `heimdall coordinator stop`, wait for a clean shutdown, then start it again.', changes)]);
      }
      if (inspection.running === 'unknown') {
        return conflicted([conflict('state-unknown', `The definition changed (${changes.join(', ') || 'text'}) but whether ${unit} is running could not be determined.`,
          `Confirm with \`heimdall coordinator status\` and \`systemctl --user show ${unit}\`, then retry.`, changes)]);
      }
      // Inactive with the main process proven absent: the owned definition may be refreshed in place.
      const writeFailure = await writeDefinition(existing);
      if (writeFailure) return failed(writeFailure);
      const reloadFailure = await reload();
      if (reloadFailure) return failed(reloadFailure);
      return { outcome: 'refreshed', registered: false, conflicts: [], detail: `${unit} definition refreshed while inactive` };
    }

    const writeFailure = await writeDefinition(existing);
    if (writeFailure) return failed(writeFailure);
    const link = await run(['link', paths.definition]);
    if (link.error || link.exitCode !== 0) return failed(`systemctl link failed: ${clip(link.error ?? `${link.stderr} ${link.stdout}`)}`);
    const reloadFailure = await reload();
    if (reloadFailure) return failed(reloadFailure);
    return { outcome: existing.kind === 'absent' ? 'created' : 'refreshed', registered: true, conflicts: [], detail: `${unit} linked from ${paths.definition} without being enabled` };
  }

  async function start(): Promise<StartResult> {
    const manager = await preflight();
    if (!manager.available) return { outcome: 'failed', detail: manager.reason, conflicts: [unavailable(manager.reason)] };
    const inspection = await showUnit();
    if (inspection.registration === 'unknown' || inspection.running === 'unknown') {
      return { outcome: 'conflict', detail: inspection.detail, conflicts: [conflict('state-unknown',
        `The systemd state of ${unit} could not be determined: ${inspection.detail}.`, `Run \`systemctl --user show ${unit}\` yourself and retry once the state is clear.`)] };
    }
    if (inspection.registration === 'not-loaded') return { outcome: 'failed', conflicts: [], detail: `${unit} is not registered; install it before starting` };
    if (!await ownsFragment(inspection.registeredPath)) {
      const conflicts = [conflict('registered-elsewhere', `${unit} is loaded from ${inspection.registeredPath ?? 'an unreported path'}, not from ${paths.definition}.`,
        'Remove or rename that unit yourself; Heimdall will not start a unit it does not own.')];
      return { outcome: 'conflict', conflicts, detail: conflicts[0]!.message };
    }
    if (inspection.running === true) return { outcome: 'already-running', conflicts: [], detail: `${unit} is already running; no start was requested` };
    const started = await run(['start', unit], START_TIMEOUT_MS);
    if (started.error || started.exitCode !== 0) return { outcome: 'failed', conflicts: [], detail: `systemctl start failed: ${clip(started.error ?? `${started.stderr} ${started.stdout}`)}` };
    return { outcome: 'started', conflicts: [], detail: `${unit} start requested; readiness is not yet confirmed` };
  }

  /** Remove the user-config link of an owned, proven-inactive unit. The private definition file is retained. */
  async function unloadInactive(): Promise<CleanupResult> {
    const inspection = await inspect();
    if (inspection.registration === 'not-loaded') return { outcome: 'nothing-to-remove', detail: `${unit} is not loaded` };
    if (inspection.registration !== 'loaded' || inspection.running !== false) return { outcome: 'refused', detail: `Not unlinking ${unit}: absence of its process is not proven (${inspection.detail})` };
    if (!await ownsFragment(inspection.registeredPath)) return { outcome: 'refused', detail: `Not unlinking ${unit}: it is loaded from ${inspection.registeredPath ?? 'an unreported path'}, not from the owned definition` };
    const existing = await existingDefinition();
    if (existing.kind !== 'owned') return { outcome: 'refused', detail: `Not unlinking ${unit}: its definition file is not an owned Heimdall definition` };
    const link = await fs.lstat(linkPath).catch(() => undefined);
    if (!link?.isSymbolicLink() || await fs.realpath(linkPath).catch(() => undefined) !== await fs.realpath(paths.definition).catch(() => null)) {
      return { outcome: 'refused', detail: `Not unlinking ${unit}: ${linkPath} is not a link to the owned definition` };
    }
    await fs.unlink(linkPath);
    const reloadFailure = await reload();
    if (reloadFailure) return { outcome: 'refused', detail: `${linkPath} was removed but ${reloadFailure}` };
    return { outcome: 'removed', detail: `${unit} unlinked; the definition file is retained` };
  }

  async function cleanupFixture(): Promise<CleanupResult> {
    const unloaded = await unloadInactive();
    if (unloaded.outcome === 'refused') return unloaded;
    const existing = await existingDefinition();
    if (existing.kind === 'foreign') return { outcome: 'refused', detail: `Not removing ${paths.definition}: ${existing.reason}` };
    if (existing.kind === 'absent') return { outcome: unloaded.outcome, detail: unloaded.detail };
    await fs.rm(paths.definition, { force: true });
    return { outcome: 'removed', detail: `${unit} unlinked and ${paths.definition} removed` };
  }

  async function remembered(): Promise<RememberedContext> {
    const existing = await existingDefinition();
    if (existing.kind !== 'owned') return existing;
    return {
      kind: 'owned',
      credentialFile: optionValue(existing.definition.execStart.slice(2), '--env-file'),
      openchamberDataDirectory: existing.definition.environment.OPENCHAMBER_DATA_DIR ?? null,
    };
  }

  const logLocation = () => `systemd journal of the user unit ${unit} (journalctl --user -u ${unit})`;

  return { identity, render: () => desiredText, remembered, logLocation, inspect, install, start, unloadInactive, cleanupFixture };
}
