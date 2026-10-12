import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultCoordinatorConfigurationFile, loadCoordinatorConfiguration } from './config.js';
import { loadCredentialFile } from './credentials.js';
import { nativeServiceNames } from './native/types.js';

/**
 * How the coordinator configuration was selected. The origin decides whether a missing file is an error:
 * only the implicit default is optional.
 */
export type ConfigurationOrigin = 'flag' | 'env' | 'implicit-default';

/**
 * Internal, undocumented markers a native service definition carries to its `serve` process. They hold
 * nonsecret values only and are not command line options.
 */
export const CONFIG_ORIGIN_VARIABLE = 'HEIMDALL_COORDINATOR_CONFIG_ORIGIN';
export const MANAGER_LABEL_VARIABLE = 'HEIMDALL_COORDINATOR_MANAGER_LABEL';

export interface ConfigurationSelection { origin: ConfigurationOrigin; file: string }

/** Mirrors the loader precedence: flag, then `HEIMDALL_COORDINATOR_CONFIG`, then the default location. */
export function selectConfigurationFile(flag: string | undefined, environment: NodeJS.ProcessEnv = process.env): ConfigurationSelection {
  if (flag !== undefined) {
    if (!flag) throw new Error('--coordinator-config requires a nonempty path');
    return { origin: 'flag', file: path.resolve(flag) };
  }
  const selected = environment.HEIMDALL_COORDINATOR_CONFIG;
  if (selected !== undefined) {
    if (!selected) throw new Error('HEIMDALL_COORDINATOR_CONFIG is set but empty; unset it or name a coordinator configuration file');
    return { origin: 'env', file: path.resolve(selected) };
  }
  return { origin: 'implicit-default', file: path.resolve(defaultCoordinatorConfigurationFile()) };
}

/**
 * Whether `serve` should treat the passed `--coordinator-config` as the optional implicit default. The marker is
 * honored only for the exact default file, so a stray variable cannot make an explicit selection optional.
 */
export function implicitDefaultMarkerApplies(flag: string | undefined, environment: NodeJS.ProcessEnv = process.env): boolean {
  return flag !== undefined
    && environment[CONFIG_ORIGIN_VARIABLE] === 'implicit-default'
    && path.resolve(flag) === path.resolve(defaultCoordinatorConfigurationFile());
}

/**
 * The native manager label carried by a service definition, or undefined for a foreground process.
 * A label that does not derive from this state directory is rejected rather than trusted.
 */
export function managerLabelFromEnvironment(stateDirectory: string, environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const label = environment[MANAGER_LABEL_VARIABLE];
  if (label === undefined || label === '') return undefined;
  const names = nativeServiceNames(stateDirectory);
  if (label !== names.launchdLabel && label !== names.systemdUnit) throw new Error('The native service marker does not belong to this coordinator state directory');
  return label;
}

/** Everything a native service needs to start the installed coordinator identically from any working directory. */
export interface LaunchContext {
  nodeExecutable: string;
  /** Real path of the installed package's `dist/cli.js`. */
  entryPoint: string;
  home: string;
  configuration: ConfigurationSelection & { stateDirectory: string; endpoint: string };
  /** Canonical path of the selected private credential file; the file is read by the coordinator at each launch. */
  credentialFile: string | null;
  /** Resolved `OPENCHAMBER_DATA_DIR`, when one was set. */
  openchamberDataDirectory: string | null;
  /** Literal arguments after the entry point. */
  arguments: string[];
  /** Nonsecret environment for the service, excluding the manager label the adapter adds. */
  environment: Record<string, string>;
}

export interface LaunchContextOptions {
  /** Value of `--coordinator-config`. */
  coordinatorConfig?: string;
  /** Value of `--env-file`. */
  envFile?: string;
  /** Test seams for installed-package layout; production resolves both from the running process. */
  nodeExecutable?: string;
  entryPoint?: string;
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

function literalPath(value: string, name: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
  if (CONTROL_CHARACTERS.test(value)) throw new Error(`${name} contains a control character and cannot be passed to a service definition`);
  return value;
}

async function installedEntryPoint(override: string | undefined): Promise<string> {
  const candidate = override ?? fileURLToPath(new URL('../cli.js', import.meta.url));
  literalPath(candidate, 'The Heimdall entry point');
  let real: string;
  try { real = await fs.realpath(candidate); }
  catch { throw new Error(`The installed Heimdall entry point was not found at ${candidate}; reinstall the package`); }
  const stat = await fs.stat(real);
  if (!stat.isFile()) throw new Error(`The installed Heimdall entry point is not a file: ${real}`);
  return literalPath(real, 'The Heimdall entry point');
}

async function nodeExecutable(override: string | undefined): Promise<string> {
  const candidate = literalPath(override ?? process.execPath, 'The Node executable');
  try { await fs.access(candidate, constants.X_OK); }
  catch { throw new Error(`The Node executable is not available at ${candidate}`); }
  return candidate;
}

/**
 * Resolve the exact, literal launch description for the coordinator service. The configuration is loaded
 * through the existing loader, so an absent flag- or environment-selected file fails while an absent implicit
 * default keeps the loader defaults. Nothing here depends on the working directory after resolution.
 */
export async function resolveLaunchContext(options: LaunchContextOptions = {}, environment: NodeJS.ProcessEnv = process.env): Promise<LaunchContext> {
  const selection = selectConfigurationFile(options.coordinatorConfig, environment);
  const configuration = await loadCoordinatorConfiguration(selection.file, { implicitDefault: selection.origin === 'implicit-default' });
  literalPath(configuration.stateDirectory, 'The coordinator state directory');
  literalPath(configuration.endpoint, 'The coordinator endpoint');
  literalPath(selection.file, 'The coordinator configuration file');

  let credentialFile: string | null = null;
  if (options.envFile !== undefined) {
    if (!options.envFile) throw new Error('--env-file requires a nonempty path');
    const requested = path.resolve(options.envFile);
    await loadCredentialFile(requested);
    credentialFile = literalPath(await fs.realpath(requested), 'The credential file');
  }

  const rawData = environment.OPENCHAMBER_DATA_DIR;
  const openchamberDataDirectory = typeof rawData === 'string' && rawData.trim() ? literalPath(path.resolve(rawData.trim()), 'OPENCHAMBER_DATA_DIR') : null;
  const home = literalPath(environment.HOME || os.homedir(), 'HOME');

  const serveArguments = ['coordinator', 'serve', '--coordinator-config', selection.file];
  if (credentialFile) serveArguments.push('--env-file', credentialFile);
  const serviceEnvironment: Record<string, string> = { HOME: home, [CONFIG_ORIGIN_VARIABLE]: selection.origin };
  if (openchamberDataDirectory) serviceEnvironment.OPENCHAMBER_DATA_DIR = openchamberDataDirectory;

  return {
    nodeExecutable: await nodeExecutable(options.nodeExecutable),
    entryPoint: await installedEntryPoint(options.entryPoint),
    home,
    configuration: { ...selection, stateDirectory: configuration.stateDirectory, endpoint: configuration.endpoint },
    credentialFile,
    openchamberDataDirectory,
    arguments: serveArguments,
    environment: serviceEnvironment,
  };
}
