import fs from 'node:fs/promises';
import path from 'node:path';
import { MANAGER_LABEL_VARIABLE } from '../launch-context.js';
import type { LaunchContext } from '../launch-context.js';
import { ensurePrivateDirectory, prepareLogFile, readPrivateText, validatePrivateDirectory, writePrivateFile } from './private-files.js';
import { createExecFileRunner, nativeServiceNames } from './types.js';
import type { CleanupResult, CommandRunner, InstallResult, NativeServiceAdapter, RegistrationOwnership, RememberedContext, ServiceConflict, ServiceIdentity, ServiceInspection, StartResult } from './types.js';

export const LAUNCHCTL = '/bin/launchctl';
const DEFINITION_DIRECTORY = 'service';
const LOG_DIRECTORY = 'logs';
const MAXIMUM_DEFINITION_BYTES = 256 * 1024;

const escapeXml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const unescapeXml = (value: string) => value.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const clip = (value: string) => value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 300);

/** Keys of the generated definition. Anything else (WatchPaths, StartInterval, Sockets, ...) is never rendered. */
export interface LaunchdDefinition {
  Label: string;
  ProgramArguments: string[];
  EnvironmentVariables: Record<string, string>;
  RunAtLoad: false;
  KeepAlive: false;
  StandardOutPath: string;
  StandardErrorPath: string;
}

export interface LaunchdPaths { definition: string; serviceDirectory: string; logDirectory: string; standardOut: string; standardError: string }

export function launchdPaths(stateDirectory: string, label: string): LaunchdPaths {
  const serviceDirectory = path.join(stateDirectory, DEFINITION_DIRECTORY);
  const logDirectory = path.join(stateDirectory, LOG_DIRECTORY);
  return {
    serviceDirectory, logDirectory,
    definition: path.join(serviceDirectory, `${label}.plist`),
    standardOut: path.join(logDirectory, 'coordinator.out.log'),
    standardError: path.join(logDirectory, 'coordinator.err.log'),
  };
}

export function launchdDefinition(context: LaunchContext, label: string): LaunchdDefinition {
  const paths = launchdPaths(context.configuration.stateDirectory, label);
  const environment: Record<string, string> = { ...context.environment, [MANAGER_LABEL_VARIABLE]: label };
  return {
    Label: label,
    ProgramArguments: [context.nodeExecutable, context.entryPoint, ...context.arguments],
    EnvironmentVariables: Object.fromEntries(Object.entries(environment).sort(([a], [b]) => a < b ? -1 : 1)),
    RunAtLoad: false,
    KeepAlive: false,
    StandardOutPath: paths.standardOut,
    StandardErrorPath: paths.standardError,
  };
}

export function renderLaunchdPlist(definition: LaunchdDefinition): string {
  const string = (value: string) => `<string>${escapeXml(value)}</string>`;
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>Label</key>', `\t${string(definition.Label)}`,
    '\t<key>ProgramArguments</key>', '\t<array>', ...definition.ProgramArguments.map(argument => `\t\t${string(argument)}`), '\t</array>',
    '\t<key>EnvironmentVariables</key>', '\t<dict>',
    ...Object.entries(definition.EnvironmentVariables).flatMap(([name, value]) => [`\t\t<key>${escapeXml(name)}</key>`, `\t\t${string(value)}`]),
    '\t</dict>',
    '\t<key>RunAtLoad</key>', '\t<false/>',
    '\t<key>KeepAlive</key>', '\t<false/>',
    '\t<key>StandardOutPath</key>', `\t${string(definition.StandardOutPath)}`,
    '\t<key>StandardErrorPath</key>', `\t${string(definition.StandardErrorPath)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

type PlistValue = string | boolean | PlistValue[] | { [key: string]: PlistValue };

/** Parses the subset of property lists this module renders. Anything else throws. */
export function parsePlist(text: string): PlistValue {
  const body = text.replace(/^\s*<\?xml[^>]*\?>/, '').replace(/<!DOCTYPE[^>]*>/, '');
  const tokens: { tag: string; close: boolean; self: boolean; text?: string }[] = [];
  const pattern = /<(\/?)([a-zA-Z]+)(?:\s[^<>]*?)?(\/?)>|([^<]+)/g;
  let match: RegExpExecArray | null;
  let consumed = 0;
  while ((match = pattern.exec(body))) {
    if (match.index !== consumed) throw new Error('Unsupported property list markup');
    consumed = pattern.lastIndex;
    if (match[4] !== undefined) { tokens.push({ tag: '#text', close: false, self: false, text: match[4] }); continue; }
    tokens.push({ tag: match[2]!, close: match[1] === '/', self: match[3] === '/' });
  }
  if (consumed !== body.length) throw new Error('Unsupported property list markup');
  let index = 0;
  // Whitespace between structural tags is skipped; text inside <string> and <key> is read directly by `content`.
  const peek = () => {
    while (tokens[index]?.tag === '#text' && !tokens[index]!.text!.trim()) index++;
    return tokens[index];
  };
  const next = () => { const token = peek(); index++; if (!token) throw new Error('Truncated property list'); return token; };
  const content = (tag: string): string => {
    const first = tokens[index];
    let value = '';
    if (first?.tag === '#text') { value = first.text!; index++; }
    const end = next();
    if (end.tag !== tag || !end.close) throw new Error('Malformed property list');
    return unescapeXml(value);
  };
  const value = (): PlistValue => {
    const token = next();
    if (token.close) throw new Error('Malformed property list');
    if (token.tag === 'true' && token.self) return true;
    if (token.tag === 'false' && token.self) return false;
    if (token.tag === 'string' && !token.self) return content('string');
    if (token.tag === 'string') return '';
    if (token.tag === 'array' && !token.self) {
      const items: PlistValue[] = [];
      while (!(peek()?.tag === 'array' && peek()!.close)) items.push(value());
      index++;
      return items;
    }
    if (token.tag === 'dict' && !token.self) {
      const entries: { [key: string]: PlistValue } = Object.create(null);
      while (!(peek()?.tag === 'dict' && peek()!.close)) {
        const key = next();
        if (key.tag !== 'key' || key.close || key.self) throw new Error('Malformed property list');
        const name = content('key');
        if (name in entries) throw new Error('Duplicate property list key');
        entries[name] = value();
      }
      index++;
      return entries;
    }
    throw new Error('Unsupported property list value');
  };
  const root = next();
  if (root.tag !== 'plist' || root.close) throw new Error('Not a property list');
  const result = value();
  const end = next();
  if (end.tag !== 'plist' || !end.close || peek() !== undefined) throw new Error('Malformed property list');
  return result;
}

/** Read the definition fields this adapter compares; undefined when the text is not an owned Heimdall definition. */
function ownedDefinition(text: string, label: string): LaunchdDefinition | undefined {
  let parsed: PlistValue;
  try { parsed = parsePlist(text); } catch { return undefined; }
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  const record = parsed as { [key: string]: PlistValue };
  const strings = (value: PlistValue | undefined): string[] | undefined => Array.isArray(value) && value.every(item => typeof item === 'string') ? value as string[] : undefined;
  const environment = record.EnvironmentVariables;
  if (record.Label !== label || !strings(record.ProgramArguments) || typeof environment !== 'object' || Array.isArray(environment)) return undefined;
  const variables = environment as { [key: string]: PlistValue };
  if (variables[MANAGER_LABEL_VARIABLE] !== label) return undefined;
  if (!Object.values(variables).every(item => typeof item === 'string')) return undefined;
  return {
    Label: label,
    ProgramArguments: strings(record.ProgramArguments)!,
    EnvironmentVariables: { ...variables } as Record<string, string>,
    RunAtLoad: record.RunAtLoad as false,
    KeepAlive: record.KeepAlive as false,
    StandardOutPath: String(record.StandardOutPath ?? ''),
    StandardErrorPath: String(record.StandardErrorPath ?? ''),
  };
}

function optionValue(argumentsList: readonly string[], option: string): string | null {
  const index = argumentsList.indexOf(option);
  return index >= 0 ? argumentsList[index + 1] ?? null : null;
}

/** Names the launch context elements that differ between an installed and a desired definition. */
export function definitionChanges(installed: LaunchdDefinition, desired: LaunchdDefinition): string[] {
  const changes: string[] = [];
  const [installedNode, installedEntry, ...installedRest] = installed.ProgramArguments;
  const [desiredNode, desiredEntry, ...desiredRest] = desired.ProgramArguments;
  if (installedNode !== desiredNode) changes.push('executable');
  if (installedEntry !== desiredEntry) changes.push('entry-point');
  if (optionValue(installedRest, '--coordinator-config') !== optionValue(desiredRest, '--coordinator-config')
    || installed.EnvironmentVariables.HEIMDALL_COORDINATOR_CONFIG_ORIGIN !== desired.EnvironmentVariables.HEIMDALL_COORDINATOR_CONFIG_ORIGIN) changes.push('configuration');
  if (optionValue(installedRest, '--env-file') !== optionValue(desiredRest, '--env-file')) changes.push('credential-source');
  if (installed.EnvironmentVariables.OPENCHAMBER_DATA_DIR !== desired.EnvironmentVariables.OPENCHAMBER_DATA_DIR) changes.push('data-directory');
  if (installed.EnvironmentVariables.HOME !== desired.EnvironmentVariables.HOME) changes.push('home');
  if (installed.StandardOutPath !== desired.StandardOutPath || installed.StandardErrorPath !== desired.StandardErrorPath) changes.push('logs');
  if (!changes.length && JSON.stringify(installed) !== JSON.stringify(desired)) changes.push('definition');
  return changes;
}

/**
 * `launchctl print` is not a stable machine interface. The result is `unknown` unless the output has the
 * expected shape and a recognized state, and it never reports a process as absent on a guess.
 */
export function parseLaunchctlPrint(output: string, target: string): Omit<ServiceInspection, 'detail'> & { recognized: boolean } {
  const unknown = { recognized: false, registration: 'unknown' as const, running: 'unknown' as const, pid: null, lastExitStatus: null, registeredPath: null };
  const lines = output.split('\n');
  const first = lines.findIndex(line => line.trim());
  if (first < 0 || lines[first]!.trim() !== `${target} = {`) return unknown;
  const properties = new Map<string, string>();
  let indent: number | undefined;
  for (const line of lines.slice(first + 1)) {
    const match = /^(\s+)([^\s=][^=]*?) = (.*)$/.exec(line);
    if (!match) continue;
    const width = match[1]!.length;
    if (indent === undefined || width < indent) indent = width;
  }
  if (indent === undefined) return unknown;
  for (const line of lines.slice(first + 1)) {
    const match = /^(\s+)([^\s=][^=]*?) = (.*)$/.exec(line);
    if (match && match[1]!.length === indent && !properties.has(match[2]!)) properties.set(match[2]!, match[3]!.trim());
  }
  const state = properties.get('state');
  const rawPid = properties.get('pid');
  const pid = rawPid !== undefined && /^\d+$/.test(rawPid) ? Number(rawPid) : null;
  const exit = properties.get('last exit code');
  const lastExitStatus = exit !== undefined && /^\d+/.test(exit) ? Number(/^\d+/.exec(exit)![0]) : null;
  const registeredPath = properties.get('path') ?? null;
  let running: boolean | 'unknown' = 'unknown';
  if (state === 'running') running = true;
  else if (state === 'not running' && pid === null) running = false;
  return { recognized: true, registration: 'loaded', running, pid, lastExitStatus, registeredPath };
}

export interface LaunchdAdapterOptions {
  context: LaunchContext;
  runner?: CommandRunner;
  uid?: number;
  launchctl?: string;
}

export function createLaunchdAdapter(options: LaunchdAdapterOptions): NativeServiceAdapter {
  const { context } = options;
  const runner = options.runner ?? createExecFileRunner();
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error('launchd user services require a POSIX user ID');
  const launchctl = options.launchctl ?? LAUNCHCTL;
  const stateDirectory = context.configuration.stateDirectory;
  const label = nativeServiceNames(stateDirectory).launchdLabel;
  const paths = launchdPaths(stateDirectory, label);
  const domain = `gui/${uid}`;
  const target = `${domain}/${label}`;
  const desired = launchdDefinition(context, label);
  const desiredText = renderLaunchdPlist(desired);

  const identity = (): ServiceIdentity => ({ manager: 'launchd', label, definitionPath: paths.definition });
  const conflict = (code: ServiceConflict['code'], message: string, action: string, changes?: string[]): ServiceConflict => ({ code, message, action, ...(changes ? { changes } : {}) });

  async function inspect(): Promise<ServiceInspection> {
    const result = await runner.run(launchctl, ['print', target]);
    if (result.error) return { registration: 'unknown', running: 'unknown', pid: null, lastExitStatus: null, registeredPath: null, detail: clip(result.error) };
    const combined = `${result.stderr}\n${result.stdout}`;
    if (result.exitCode === 113 && /could not find service/i.test(combined)) {
      return { registration: 'not-loaded', running: false, pid: null, lastExitStatus: null, registeredPath: null, detail: `${label} is not loaded in ${domain}` };
    }
    if (result.exitCode !== 0) return { registration: 'unknown', running: 'unknown', pid: null, lastExitStatus: null, registeredPath: null, detail: `launchctl print exited with ${result.exitCode}: ${clip(combined)}` };
    const parsed = parseLaunchctlPrint(result.stdout, target);
    if (!parsed.recognized) return { registration: 'unknown', running: 'unknown', pid: null, lastExitStatus: null, registeredPath: null, detail: 'launchctl print output was not recognized' };
    const { recognized: _recognized, ...state } = parsed;
    return { ...state, detail: state.running === 'unknown' ? 'launchctl print reported no recognized process state' : state.running ? `${label} is running` : `${label} is loaded and not running` };
  }

  type Existing = { kind: 'absent' } | { kind: 'owned'; definition: LaunchdDefinition; text: string } | { kind: 'foreign'; reason: string };

  async function existingDefinition(): Promise<Existing> {
    try {
      if (!await validatePrivateDirectory(paths.serviceDirectory, 'Heimdall service directory')) return { kind: 'absent' };
      const text = await readPrivateText(paths.definition, 'The service definition', MAXIMUM_DEFINITION_BYTES);
      if (text === null) return { kind: 'absent' };
      const definition = ownedDefinition(text, label);
      return definition ? { kind: 'owned', definition, text } : { kind: 'foreign', reason: 'it is not a Heimdall coordinator definition for this state directory' };
    } catch (error) { return { kind: 'foreign', reason: error instanceof Error ? error.message : 'it could not be validated' }; }
  }

  const foreign = (reason: string): ServiceConflict => conflict('foreign-definition',
    `A service definition exists at ${paths.definition} but ${reason}.`,
    'Inspect or move that file yourself; Heimdall will not overwrite or load it.');

  /** The reported definition path is ours when it is the owned definition or resolves to that same file. */
  async function ownsRegistration(registered: string | null): Promise<boolean> {
    if (!registered) return false;
    if (registered === paths.definition) return true;
    const [real, owned] = await Promise.all([fs.realpath(registered).catch(() => undefined), fs.realpath(paths.definition).catch(() => undefined)]);
    return real !== undefined && real === owned;
  }

  async function registrationOwnership(inspection: ServiceInspection): Promise<RegistrationOwnership> {
    if (inspection.registration !== 'loaded') return { kind: 'refused', code: 'state-unknown', reason: `${label} is not a loaded registration (${inspection.detail})` };
    if (!await ownsRegistration(inspection.registeredPath)) {
      return { kind: 'refused', code: 'registered-elsewhere', reason: `${label} is loaded from ${inspection.registeredPath ?? 'an unreported path'}, not from ${paths.definition}` };
    }
    const existing = await existingDefinition();
    if (existing.kind === 'foreign') return { kind: 'refused', code: 'foreign-definition', reason: `its definition ${paths.definition} ${existing.reason}` };
    if (existing.kind === 'absent') return { kind: 'refused', code: 'registered-elsewhere', reason: `${label} is loaded but its definition file ${paths.definition} is missing` };
    return { kind: 'owned' };
  }

  async function writeAndRegister(existing: Exclude<Existing, { kind: 'foreign' }>, inspection: ServiceInspection): Promise<InstallResult> {
    try {
      await ensurePrivateDirectory(stateDirectory, 'Coordinator state directory', { recursive: true });
      await ensurePrivateDirectory(paths.serviceDirectory, 'Heimdall service directory');
      await ensurePrivateDirectory(paths.logDirectory, 'Heimdall log directory');
      await prepareLogFile(paths.standardOut, 'The standard output log');
      await prepareLogFile(paths.standardError, 'The standard error log');
      if (existing.kind !== 'owned' || existing.text !== desiredText) await writePrivateFile(paths.definition, desiredText);
    } catch (error) {
      return { outcome: 'failed', registered: false, conflicts: [], detail: `Could not prepare the service definition: ${clip(error instanceof Error ? error.message : 'unknown error')}` };
    }
    const outcome = existing.kind === 'absent' ? 'created' : existing.text === desiredText ? 'unchanged' : 'refreshed';
    if (inspection.registration === 'loaded') return { outcome, registered: false, conflicts: [], detail: `${label} is already registered` };
    const bootstrap = await runner.run(launchctl, ['bootstrap', domain, paths.definition]);
    if (bootstrap.error || bootstrap.exitCode !== 0) {
      return { outcome: 'failed', registered: false, conflicts: [], detail: `launchctl bootstrap failed: ${clip(bootstrap.error ?? `${bootstrap.stderr} ${bootstrap.stdout}`)}` };
    }
    return { outcome, registered: true, conflicts: [], detail: `${label} registered from ${paths.definition}` };
  }

  type Unload =
    | { kind: 'done'; outcome: 'removed' | 'nothing-to-remove'; detail: string }
    | { kind: 'refused'; reason: 'running' | 'unknown' | 'elsewhere' | 'definition' | 'bootout-failed'; detail: string; inspection: ServiceInspection };

  /**
   * Unload the registration only while it is proven inactive and owned: loaded from the owned definition, a
   * recognized stopped state with no process, and (when given) the definition file unchanged since the caller
   * read it. The state is read again here, immediately before `bootout`, and nothing is signalled.
   */
  async function unload(expectedText?: string): Promise<Unload> {
    const inspection = await inspect();
    if (inspection.registration === 'not-loaded') return { kind: 'done', outcome: 'nothing-to-remove', detail: `${label} is not loaded` };
    if (inspection.registration !== 'loaded' || inspection.running === 'unknown') {
      return { kind: 'refused', reason: 'unknown', inspection, detail: `Not unloading ${label}: absence of its process is not proven (${inspection.detail})` };
    }
    if (inspection.running !== false) return { kind: 'refused', reason: 'running', inspection, detail: `Not unloading ${label}: it is running` };
    if (!await ownsRegistration(inspection.registeredPath)) {
      return { kind: 'refused', reason: 'elsewhere', inspection, detail: `Not unloading ${label}: it is loaded from ${inspection.registeredPath ?? 'an unreported path'}, not from the owned definition` };
    }
    const existing = await existingDefinition();
    if (existing.kind !== 'owned') return { kind: 'refused', reason: 'definition', inspection, detail: `Not unloading ${label}: its definition file is not an owned Heimdall definition` };
    if (expectedText !== undefined && existing.text !== expectedText) {
      return { kind: 'refused', reason: 'definition', inspection, detail: `Not unloading ${label}: its definition file changed while the refresh was under way` };
    }
    const bootout = await runner.run(launchctl, ['bootout', target]);
    if (bootout.error || bootout.exitCode !== 0) {
      return { kind: 'refused', reason: 'bootout-failed', inspection, detail: `launchctl bootout failed: ${clip(bootout.error ?? `${bootout.stderr} ${bootout.stdout}`)}` };
    }
    return { kind: 'done', outcome: 'removed', detail: `${label} unloaded; the definition file is retained` };
  }

  const stateUnknownConflict = (detail: string, changes: string[]) => conflict('state-unknown',
    `The launchd state of ${label} could not be confirmed while its definition (${changes.join(', ')}) was being refreshed: ${detail}.`,
    'Confirm with `heimdall coordinator status` and `launchctl print ' + target + '`, then retry.', changes);

  /**
   * Replace the owned definition of a loaded, proven-inactive registration. launchd keeps the definition it
   * loaded, so the stale registration is unloaded first, the state is read once more, and only a registration
   * that is gone is replaced by the new definition. A change at any step stops the refresh without further
   * mutation; start then registers and kickstarts the new definition, never with a kill option.
   */
  async function refreshInactive(existing: Extract<Existing, { kind: 'owned' }>, changes: string[]): Promise<InstallResult> {
    const conflicted = (refusal: ServiceConflict): InstallResult => ({ outcome: 'conflict', registered: false, detail: refusal.message, conflicts: [refusal] });
    const unloaded = await unload(existing.text);
    if (unloaded.kind === 'refused') {
      if (unloaded.reason === 'bootout-failed') return { outcome: 'failed', registered: false, conflicts: [], detail: unloaded.detail };
      if (unloaded.reason === 'running') {
        return conflicted(conflict('running-context-changed', `${label} started running while its definition (${changes.join(', ')}) was being refreshed; a loaded running definition is never replaced.`,
          'Stop the coordinator with `heimdall coordinator stop`, wait for a clean shutdown, then start it again.', changes));
      }
      if (unloaded.reason === 'elsewhere') {
        return conflicted(conflict('registered-elsewhere', `${label} is loaded in ${domain} from ${unloaded.inspection.registeredPath ?? 'an unreported path'}, not from ${paths.definition}.`,
          'Remove that registration yourself (launchctl bootout), or stop using the conflicting label; Heimdall will not replace it.'));
      }
      return conflicted(stateUnknownConflict(unloaded.detail, changes));
    }
    const fresh = await inspect();
    if (fresh.registration !== 'not-loaded') {
      if (fresh.registration === 'loaded' && fresh.running === true) {
        return conflicted(conflict('running-context-changed', `${label} is running again after its stale registration was unloaded; a loaded running definition is never replaced.`,
          'Stop the coordinator with `heimdall coordinator stop`, wait for a clean shutdown, then start it again.', changes));
      }
      if (fresh.registration === 'loaded' && fresh.running === false) {
        return conflicted(conflict('registered-elsewhere', `${label} was registered again from ${fresh.registeredPath ?? 'an unreported path'} while its definition was being refreshed.`,
          'Remove that registration yourself (launchctl bootout), or stop using the conflicting label; Heimdall will not replace it.'));
      }
      return conflicted(stateUnknownConflict(fresh.detail, changes));
    }
    return writeAndRegister(existing, fresh);
  }

  async function install(): Promise<InstallResult> {
    const inspection = await inspect();
    if (inspection.registration === 'unknown') {
      return { outcome: 'conflict', registered: false, detail: inspection.detail, conflicts: [conflict('state-unknown',
        `The launchd state of ${label} could not be determined: ${inspection.detail}.`, 'Run `launchctl print ' + target + '` yourself and retry once the state is clear.')] };
    }
    const existing = await existingDefinition();
    if (existing.kind === 'foreign') return { outcome: 'conflict', registered: false, detail: existing.reason, conflicts: [foreign(existing.reason)] };
    if (inspection.registration === 'loaded') {
      if (!await ownsRegistration(inspection.registeredPath)) {
        const conflicts = [conflict('registered-elsewhere',
          `${label} is loaded in ${domain} from ${inspection.registeredPath ?? 'an unreported path'}, not from ${paths.definition}.`,
          'Remove that registration yourself (launchctl bootout), or stop using the conflicting label; Heimdall will not replace it.')];
        return { outcome: 'conflict', registered: false, detail: conflicts[0]!.message, conflicts };
      }
      if (existing.kind === 'absent') {
        const conflicts = [conflict('registered-elsewhere', `${label} is loaded but its definition file ${paths.definition} is missing.`,
          'Stop the service gracefully with `heimdall coordinator stop`, then remove the stale registration.')];
        return { outcome: 'conflict', registered: false, detail: conflicts[0]!.message, conflicts };
      }
      const changes = definitionChanges(existing.definition, desired);
      if (changes.length) {
        if (inspection.running === true) {
          const conflicts = [conflict('running-context-changed',
            `The running coordinator was started with a different ${changes.join(', ')}; a loaded running definition is never replaced.`,
            'Stop the coordinator with `heimdall coordinator stop`, wait for a clean shutdown, then start it again.', changes)];
          return { outcome: 'conflict', registered: false, detail: conflicts[0]!.message, conflicts };
        }
        if (inspection.running === 'unknown') {
          const conflicts = [conflict('state-unknown', `The definition changed (${changes.join(', ')}) but whether ${label} is running could not be determined.`,
            'Confirm with `heimdall coordinator status` and `launchctl print ' + target + '`, then retry.', changes)];
          return { outcome: 'conflict', registered: false, detail: conflicts[0]!.message, conflicts };
        }
        // Loaded from the owned definition with the previous process proven absent: the registration is stale and
        // may be replaced by the new definition. Anything the recheck cannot prove leaves launchd untouched.
        return refreshInactive(existing, changes);
      }
      return { outcome: 'unchanged', registered: false, conflicts: [], detail: `${label} is already registered with the current definition` };
    }
    // Not loaded: the previous process is proven absent from launchd's view, so an owned definition may be refreshed.
    return writeAndRegister(existing, inspection);
  }

  async function start(): Promise<StartResult> {
    const inspection = await inspect();
    if (inspection.registration === 'unknown' || inspection.running === 'unknown') {
      return { outcome: 'conflict', detail: inspection.detail, conflicts: [conflict('state-unknown',
        `The launchd state of ${label} could not be determined: ${inspection.detail}.`, 'Run `launchctl print ' + target + '` yourself and retry once the state is clear.')] };
    }
    if (inspection.registration === 'not-loaded') return { outcome: 'failed', conflicts: [], detail: `${label} is not registered; install it before starting` };
    if (!await ownsRegistration(inspection.registeredPath)) {
      const conflicts = [conflict('registered-elsewhere', `${label} is loaded from ${inspection.registeredPath ?? 'an unreported path'}, not from ${paths.definition}.`,
        'Remove that registration yourself; Heimdall will not start a definition it does not own.')];
      return { outcome: 'conflict', conflicts, detail: conflicts[0]!.message };
    }
    if (inspection.running === true) return { outcome: 'already-running', conflicts: [], detail: `${label} is already running; no start was requested` };
    // Never `-k`: a start request must not terminate an existing instance.
    const kickstart = await runner.run(launchctl, ['kickstart', target]);
    if (kickstart.error || kickstart.exitCode !== 0) return { outcome: 'failed', conflicts: [], detail: `launchctl kickstart failed: ${clip(kickstart.error ?? `${kickstart.stderr} ${kickstart.stdout}`)}`, ...(kickstart.timedOut ? { unresolved: true } : {}) };
    return { outcome: 'started', conflicts: [], detail: `${label} start requested; readiness is not yet confirmed` };
  }

  async function unloadInactive(): Promise<CleanupResult> {
    const unloaded = await unload();
    return unloaded.kind === 'done' ? { outcome: unloaded.outcome, detail: unloaded.detail } : { outcome: 'refused', detail: unloaded.detail };
  }

  async function cleanupFixture(): Promise<CleanupResult> {
    const unloaded = await unloadInactive();
    if (unloaded.outcome === 'refused') return unloaded;
    const existing = await existingDefinition();
    if (existing.kind === 'foreign') return { outcome: 'refused', detail: `Not removing ${paths.definition}: ${existing.reason}` };
    if (existing.kind === 'absent') return { outcome: unloaded.outcome, detail: unloaded.detail };
    await fs.rm(paths.definition, { force: true });
    return { outcome: 'removed', detail: `${label} unloaded and ${paths.definition} removed` };
  }

  async function remembered(): Promise<RememberedContext> {
    const existing = await existingDefinition();
    if (existing.kind !== 'owned') return existing;
    return {
      kind: 'owned',
      credentialFile: optionValue(existing.definition.ProgramArguments.slice(2), '--env-file'),
      openchamberDataDirectory: existing.definition.EnvironmentVariables.OPENCHAMBER_DATA_DIR ?? null,
    };
  }

  const logLocation = () => `Standard output: ${paths.standardOut}; standard error: ${paths.standardError}`;

  return { identity, render: () => desiredText, remembered, logLocation, inspect, registrationOwnership, install, start, unloadInactive, cleanupFixture };
}
