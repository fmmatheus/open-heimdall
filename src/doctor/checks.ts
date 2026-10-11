import { execFile } from 'node:child_process';
import { constants as fsConstants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { parseConfiguration, type Configuration } from '../config.js';
import { parseCoordinatorConfiguration, type CoordinatorConfiguration } from '../coordinator/config.js';
import { admitRuntime, sourcePackageRoot } from '../coordinator/runtime-snapshot.js';
import type { ConnectionOptions } from '../opencode/observer.js';
import { gitEnvironment, inspectProject, resolveBaseCommit } from '../coordinator/worktrees.js';
import { moduleFiles as quotaModuleFiles, resolveQuotaPackage } from '../policy/quota.js';
import { describe, incompleteSettings } from '../setup/core.js';
import { computeRuntimeIdentity, installedDependencies, listRuntimeFiles, RUNTIME_ASSETS } from '../workflow/runtime-identity.js';

/** The supported Node.js minimum; keep in step with `engines.node` in package.json. */
export const MINIMUM_NODE = '22.19.0';

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'not-verified' | 'skipped';

/**
 * `fatal` marks a required check: a `fail` status on it makes the report not ok. Advisory checks (`fatal: false`) never do.
 * Statuses other than `fail` never change the exit status.
 */
export interface DoctorCheck { id: string; status: CheckStatus; fatal: boolean; message: string }

/** Explicit selectors; omitted values follow the same environment precedence as `heimdall setup`. */
export interface DoctorInput {
  projectDirectory?: string;
  configPath?: string;
  coordinatorConfigPath?: string;
  connect?: boolean;
}

export interface DoctorOptions {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  /** Base for relative paths and the default project; defaults to the process working directory. */
  cwd?: string;
  /** The package whose runtime assets are checked; defaults to the package this module runs from. */
  packageRoot?: string;
  /** Overrides the running Node.js version (tests). */
  nodeVersion?: string;
  /** Test seams for the `--connect` probe; production uses the global fetch, the default settings location and 10 s. */
  connection?: Pick<ConnectionOptions, 'fetchImpl' | 'timeoutMilliseconds' | 'openchamber'>;
}

export interface DoctorTargets {
  projectDirectory: string | null;
  projectConfig: string | null;
  coordinatorConfig: string | null;
  stateDirectory: string | null;
}

/** What local checks established and what they deliberately leave open. */
export interface DoctorVerification {
  local: 'passed' | 'failed';
  /** `not-requested` unless `--connect` was passed; then `verified` or `failed`. */
  connection: 'not-requested' | 'verified' | 'failed';
  protectedApiAuthorization: 'unverified';
  modelAvailability: 'unverified';
  providerLogin: 'unverified';
  quota: 'unverified';
}

export interface DoctorReport {
  schemaVersion: 1;
  ok: boolean;
  targets: DoctorTargets;
  checks: DoctorCheck[];
  verification: DoctorVerification;
  error: { code: 'invalid-input' | 'unexpected'; message: string } | null;
}

const execute = promisify(execFile);
const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;
const reason = (error: unknown): string => errorCode(error) ?? (error instanceof Error ? error.name : 'error');

function compareVersions(actual: string, minimum: string): number {
  const left = actual.split('.').map(part => Number.parseInt(part, 10) || 0);
  const right = minimum.split('.').map(part => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < 3; index += 1) if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) - (right[index] ?? 0);
  return 0;
}

interface Inspected { path: string; exists: boolean; stats: Stats }

/** Nearest existing ancestor (or the path itself) through `stat`. Throws for anything but absence. */
async function nearestExisting(target: string): Promise<Inspected> {
  let current = path.resolve(target);
  while (true) {
    try { return { path: current, exists: current === path.resolve(target), stats: await fs.stat(current) }; }
    catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      try { await fs.lstat(current); throw Object.assign(new Error('dangling symbolic link'), { code: 'DANGLING' }); }
      catch (inner) { if (errorCode(inner) === 'DANGLING') throw inner; }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

const accessible = (target: string, mode: number): Promise<boolean> => fs.access(target, mode).then(() => true, () => false);

interface DirectoryFinding { status: 'pass' | 'fail'; message: string; existing: string; present: boolean; mode: number | null }

/**
 * A directory the product reads and writes. A missing directory is fine when its nearest existing ancestor is a directory
 * it could be created in (absence before first start is not a failure). Only `stat` and `access` are used.
 */
async function inspectDirectory(label: string, target: string): Promise<DirectoryFinding> {
  let found: Inspected;
  try { found = await nearestExisting(target); }
  catch (error) { return { status: 'fail', message: `${label} ${target} cannot be inspected: ${errorCode(error) === 'DANGLING' ? 'a path component is a dangling symbolic link' : reason(error)}`, existing: target, present: false, mode: null }; }
  const fail = (message: string): DirectoryFinding => ({ status: 'fail', message, existing: found.path, present: found.exists, mode: found.stats.mode });
  if (!found.stats.isDirectory()) return fail(`${label} ${target} cannot exist: ${found.path} is not a directory`);
  if (found.exists) {
    for (const [mode, word] of [[fsConstants.R_OK, 'readable'], [fsConstants.W_OK, 'writable'], [fsConstants.X_OK, 'searchable']] as const) {
      if (!await accessible(found.path, mode)) return fail(`${label} ${target} exists but is not ${word} by this user`);
    }
    return { status: 'pass', message: `${label} ${target} exists and is accessible`, existing: found.path, present: true, mode: found.stats.mode };
  }
  for (const [mode, word] of [[fsConstants.W_OK, 'writable'], [fsConstants.X_OK, 'searchable']] as const) {
    if (!await accessible(found.path, mode)) return fail(`${label} ${target} does not exist yet and cannot be created: ${found.path} is not ${word} by this user`);
  }
  return { status: 'pass', message: `${label} ${target} does not exist yet; it can be created under ${found.path}`, existing: found.path, present: false, mode: found.stats.mode };
}

async function readRegularFile(file: string): Promise<{ content: string } | { problem: 'absent' | 'unusable'; detail: string }> {
  let stats: Stats;
  try { stats = await fs.stat(file); }
  catch (error) { return errorCode(error) === 'ENOENT' ? { problem: 'absent', detail: 'does not exist' } : { problem: 'unusable', detail: `cannot be inspected (${reason(error)})` }; }
  if (!stats.isFile()) return { problem: 'unusable', detail: 'is not a regular file' };
  try { return { content: await fs.readFile(file, 'utf8') }; }
  catch (error) { return { problem: 'unusable', detail: `cannot be read (${reason(error)})` }; }
}

export function resolveDoctorTargets(input: DoctorInput, options: DoctorOptions = {}): { cwd: string; selectedProject: string; coordinatorFile: string; explicitCoordinator: boolean; environment: NodeJS.ProcessEnv } {
  const environment = options.environment ?? process.env;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const home = options.homeDirectory ?? os.homedir();
  const explicit = input.coordinatorConfigPath ?? environment.HEIMDALL_COORDINATOR_CONFIG;
  return {
    cwd, environment, explicitCoordinator: explicit !== undefined,
    selectedProject: path.resolve(cwd, input.projectDirectory ?? '.'),
    coordinatorFile: path.resolve(cwd, explicit ?? path.join(home, '.config', 'heimdall', 'coordinator.toml')),
  };
}

/**
 * Runs every offline, read-only local check. Nothing here writes, creates, changes permissions, starts a process other than
 * `git` read commands, or opens a network connection. Never throws for a problem the report can describe.
 */
export async function runLocalChecks(input: DoctorInput, options: DoctorOptions = {}): Promise<{ checks: DoctorCheck[]; targets: DoctorTargets; projectDirectory?: string; configuration?: Configuration }> {
  const checks: DoctorCheck[] = [];
  const targets: DoctorTargets = { projectDirectory: null, projectConfig: null, coordinatorConfig: null, stateDirectory: null };
  const add = (id: string, status: CheckStatus, fatal: boolean, message: string): void => { checks.push({ id, status, fatal, message }); };
  const { selectedProject, coordinatorFile, explicitCoordinator, environment } = resolveDoctorTargets(input, options);
  const packageRoot = options.packageRoot ?? sourcePackageRoot();

  // Node.js
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  if (compareVersions(nodeVersion, MINIMUM_NODE) >= 0) add('node.version', 'pass', true, `Node.js ${nodeVersion} satisfies the supported minimum ${MINIMUM_NODE}`);
  else add('node.version', 'fail', true, `Node.js ${nodeVersion} is older than the supported minimum ${MINIMUM_NODE}; install a supported Node.js`);

  // Git and the project
  let gitAvailable = false;
  try {
    const { stdout } = await execute('git', ['--version'], { encoding: 'utf8', env: gitEnvironment(), timeout: 10000 });
    gitAvailable = true;
    add('git.available', 'pass', true, stdout.trim() || 'git is available');
  } catch (error) { add('git.available', 'fail', true, `git is not available on PATH (${reason(error)}); install Git`); }

  let projectDirectory: string | undefined;
  if (!gitAvailable) add('project.git', 'skipped', true, 'Git is unavailable, so the project cannot be inspected');
  else {
    try {
      projectDirectory = (await inspectProject(selectedProject)).directory;
      targets.projectDirectory = projectDirectory;
      add('project.git', 'pass', true, `Canonical Git project ${projectDirectory}`);
    } catch { add('project.git', 'fail', true, `${selectedProject} is not inside a Git project. Select an existing Git project with --project; doctor does not initialize Git.`); }
  }
  if (projectDirectory === undefined) add('project.commit', 'skipped', true, 'There is no Git project to inspect');
  else {
    try { await resolveBaseCommit(projectDirectory, 'HEAD'); add('project.commit', 'pass', true, 'The Git project has an existing commit'); }
    catch { add('project.commit', 'fail', true, `The Git project ${projectDirectory} has no commit. Create an initial commit first; doctor does not create commits.`); }
  }

  // Installed runtime
  const assetProblems: string[] = [];
  for (const asset of RUNTIME_ASSETS) {
    try { if (!listRuntimeFiles(packageRoot, asset).length) assetProblems.push(`${asset.directory} has no ${asset.name} files`); }
    catch (error) { assetProblems.push(`${asset.directory} cannot be listed (${reason(error)})`); }
  }
  for (const template of ['examples/heimdall.toml', 'examples/coordinator.toml']) {
    if (!await fs.stat(path.join(packageRoot, template)).then(stats => stats.isFile(), () => false)) assetProblems.push(`${template} is missing`);
  }
  if (assetProblems.length) add('runtime.assets', 'fail', true, `Installed runtime assets are incomplete: ${assetProblems.join('; ')}`);
  else add('runtime.assets', 'pass', true, 'Built code, prompts, agent files and configuration templates are present');

  try {
    const identity = computeRuntimeIdentity(packageRoot);
    add('runtime.identity', 'pass', true, `Package ${identity.build?.packageName}@${identity.packageVersion} identity is computable (digest ${identity.build?.digest.slice(0, 12)})`);
  } catch (error) { add('runtime.identity', 'fail', true, `The installed package identity cannot be computed: ${describe(error)}`); }

  try {
    const installed = installedDependencies(packageRoot);
    if (installed.missing.length || installed.unidentified.length) {
      const problems: string[] = [];
      if (installed.missing.length) problems.push(`Required runtime dependencies are not installed: ${installed.missing.join(', ')}`);
      if (installed.unidentified.length) problems.push(`Installed runtime dependencies cannot be identified (unidentifiable: ${installed.unidentified.join(', ')}); each needs a readable package.json with a version`);
      add('runtime.dependencies', 'fail', true, problems.join('. '));
    } else {
      await admitRuntime(packageRoot);
      add('runtime.dependencies', 'pass', true, `The package's declared dependencies and ${installed.entries.length} installed runtime packages resolve`);
    }
  } catch (error) { add('runtime.dependencies', 'fail', true, `Runtime dependencies do not resolve: ${describe(error)}`); }

  try {
    const base = await resolveQuotaPackage();
    const absent: string[] = [];
    for (const file of Object.values(quotaModuleFiles)) if (!await fs.stat(path.join(base, file)).then(stats => stats.isFile(), () => false)) absent.push(file);
    if (absent.length) add('runtime.quota-package', 'fail', true, `The pinned quota package is incomplete (missing ${absent.join(', ')})`);
    else add('runtime.quota-package', 'pass', true, 'The pinned quota package version is installed with its provider modules. Quota itself is not queried.');
  } catch (error) { add('runtime.quota-package', 'fail', true, `The pinned quota package is unavailable: ${describe(error)}`); }

  // Coordinator configuration
  let coordinator: CoordinatorConfiguration | undefined;
  targets.coordinatorConfig = coordinatorFile;
  const coordinatorSource = await readRegularFile(coordinatorFile);
  if ('content' in coordinatorSource) {
    try {
      coordinator = await parseCoordinatorConfiguration(coordinatorSource.content, coordinatorFile);
      add('coordinator.config', 'pass', true, `Coordinator configuration ${coordinatorFile} is valid (global concurrency ${coordinator.globalConcurrency}, project concurrency ${coordinator.projectConcurrency})`);
    } catch (error) { add('coordinator.config', 'fail', true, `The coordinator configuration ${coordinatorFile} is not valid: ${describe(error)}`); }
  } else if (coordinatorSource.problem === 'absent' && !explicitCoordinator) {
    try {
      coordinator = await parseCoordinatorConfiguration('', coordinatorFile);
      add('coordinator.config', 'warn', true, `No coordinator configuration at ${coordinatorFile}; built-in defaults apply. Run heimdall setup to create it.`);
    } catch (error) { add('coordinator.config', 'fail', true, `The built-in coordinator defaults are not usable: ${describe(error)}. Run heimdall setup --state-directory DIRECTORY.`); }
  } else add('coordinator.config', 'fail', true, `The coordinator configuration ${coordinatorFile} ${coordinatorSource.detail}. Create it with heimdall setup.`);

  // Project configuration and its setup completeness
  let configuration: Configuration | undefined;
  let projectFile: string | undefined;
  if (projectDirectory === undefined) {
    add('project.config', 'skipped', true, 'The project configuration is located inside the Git project, which was not found');
    add('project.setup', 'skipped', true, 'There is no project configuration to inspect');
  } else {
    projectFile = path.resolve(projectDirectory, input.configPath ?? (environment.HEIMDALL_CONFIG || undefined) ?? '.heimdall.toml');
    targets.projectConfig = projectFile;
    const source = await readRegularFile(projectFile);
    if ('content' in source) {
      try {
        configuration = parseConfiguration(source.content, { projectDirectory, file: projectFile });
        add('project.config', 'pass', true, `Project configuration ${projectFile} is valid`);
      } catch (error) { add('project.config', 'fail', true, `The project configuration ${projectFile} is not valid: ${describe(error)}`); }
    } else add('project.config', 'fail', true, `The project configuration ${projectFile} ${source.detail}. Create it with heimdall setup.`);
    if (!configuration) add('project.setup', 'skipped', true, 'The project configuration is unavailable');
    else {
      const missing = incompleteSettings(configuration);
      if (missing.length) add('project.setup', 'fail', true, `The project configuration is incomplete for setup; missing decisions: ${missing.join(', ')}. Edit the file or choose a new destination with heimdall setup --config.`);
      else add('project.setup', 'pass', true, 'The project configuration has real models and an OpenCode endpoint');
    }
  }

  // Configured paths: absence is fine, access problems are not
  const directories: DirectoryFinding[] = [];
  if (!coordinator) add('paths.state', 'skipped', true, 'The coordinator configuration is unavailable, so its state directory is unknown');
  else {
    targets.stateDirectory = coordinator.stateDirectory;
    const state = await inspectDirectory('Coordinator state directory', coordinator.stateDirectory);
    directories.push(state);
    add('paths.state', state.status, true, state.message);
  }
  if (!configuration) add('paths.project', 'skipped', true, 'The project configuration is unavailable, so its paths are unknown');
  else {
    const findings = [await inspectDirectory('Workflow state directory', configuration.workflowRoot)];
    if (configuration.planRoot !== configuration.workflowRoot) findings.push(await inspectDirectory('Plan directory', configuration.planRoot));
    directories.push(...findings);
    const problems: string[] = [];
    for (const [label, file] of [['Planner prompt', configuration.plannerPromptPath], ['Executor prompt', configuration.executorPromptPath]] as const) {
      const prompt = await fs.stat(file).then(stats => stats.isFile() ? undefined : 'is not a regular file', error => errorCode(error) === 'ENOENT' ? 'does not exist' : `cannot be inspected (${reason(error)})`);
      if (prompt === undefined && !await accessible(file, fsConstants.R_OK)) problems.push(`${label} ${file} is not readable`);
      else if (prompt !== undefined) problems.push(`${label} ${file} ${prompt}`);
    }
    const failed = findings.filter(finding => finding.status === 'fail').map(finding => finding.message);
    if (failed.length || problems.length) add('paths.project', 'fail', true, [...failed, ...problems].join('; '));
    else add('paths.project', 'pass', true, findings.map(finding => finding.message).join('; '));
  }

  // Advisory permission findings: reported, never repaired
  const findings: string[] = [];
  if (process.platform !== 'win32') {
    const files: [string, string | undefined][] = [['Project configuration', projectFile], ['Coordinator configuration', coordinatorFile]];
    for (const [label, file] of files) {
      if (!file) continue;
      const stats = await fs.stat(file).catch(() => undefined);
      if (!stats?.isFile()) continue;
      const readable = (stats.mode & 0o044) !== 0;
      const writable = (stats.mode & 0o022) !== 0;
      if (readable || writable) {
        const access = readable && writable ? 'readable and writable' : writable ? 'writable' : 'readable';
        findings.push(`${label} ${file} is ${access} by group or others (mode ${(stats.mode & 0o777).toString(8).padStart(3, '0')}); consider chmod 600`);
      }
    }
    const seen = new Set<string>();
    for (const directory of directories) {
      if (directory.mode === null || seen.has(directory.existing)) continue;
      seen.add(directory.existing);
      if ((directory.mode & 0o022) !== 0 && (directory.mode & 0o1000) === 0) findings.push(`Directory ${directory.existing} is writable by group or others (mode ${(directory.mode & 0o777).toString(8).padStart(3, '0')}); consider chmod go-w`);
    }
  }
  if (findings.length) add('permissions', 'warn', false, `${findings.join('; ')}. Advisory only; doctor never changes permissions.`);
  else add('permissions', 'pass', false, 'No configuration files readable or writable by group or others, and no group- or world-writable directories, were found');

  return { checks, targets, ...(projectDirectory === undefined ? {} : { projectDirectory }), ...(configuration === undefined ? {} : { configuration }) };
}
