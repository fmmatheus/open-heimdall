import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TomlError } from 'smol-toml';
import { parseConfiguration, type Configuration } from '../config.js';
import { canonicalPlannedDirectory, parseCoordinatorConfiguration, positiveInteger, type CoordinatorConfiguration } from '../coordinator/config.js';
import { inspectProject, resolveBaseCommit } from '../coordinator/worktrees.js';
import { createDirectories, nodeFileOperations, publishNoClobber, PublishError, type SetupFileOperations } from './publish.js';

/** Explicit setup decisions. Omitted values are taken from existing files or loader defaults. */
export interface SetupInput {
  projectDirectory?: string;
  configPath?: string;
  coordinatorConfigPath?: string;
  plannerModel?: string;
  executorModel?: string;
  quotaProvider?: string;
  opencodeUrl?: string;
  opencodeAuth?: string;
  /** Name of the environment variable that holds the Basic password; never the password itself. */
  passwordEnv?: string;
  stateDirectory?: string;
  globalConcurrency?: number;
  projectConcurrency?: number;
}

export interface SetupOptions {
  environment?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  /** Base for relative paths and the default project; defaults to the process working directory. */
  cwd?: string;
  /** Replaces individual mutating filesystem operations (fault injection in tests). */
  operations?: Partial<SetupFileOperations>;
}

export type SetupErrorCode =
  | 'invalid-input' | 'missing-input' | 'no-git-project' | 'no-commit'
  | 'invalid-destination' | 'invalid-configuration' | 'incomplete-configuration' | 'conflict' | 'identical-destinations'
  | 'destination-exists' | 'write-failed' | 'unexpected';

export class SetupError extends Error {
  constructor(readonly code: SetupErrorCode, message: string, readonly missing: string[] = []) {
    super(message);
    this.name = 'SetupError';
  }
}

export type TargetOutcome = 'created' | 'reused' | 'not-written' | 'failed';
export interface SetupTarget { path: string | null; outcome: TargetOutcome }

/** Result shared by the flag and wizard front ends and the JSON report. */
export interface SetupResult {
  schemaVersion: 1;
  ok: boolean;
  projectDirectory: string | null;
  targets: { coordinator: SetupTarget; project: SetupTarget };
  /** Configuration parent directories this invocation created (mode 0700). */
  createdDirectories: string[];
  verification: { level: 'configuration-validated' | 'none'; unverified: string[] };
  error: { code: SetupErrorCode; message: string; missing: string[] } | null;
  /** Present when one file was published and the other was not: nothing is rolled back; rerun to finish. */
  partial: { created: string[]; incomplete: string[] } | null;
  warnings: string[];
}

export interface PlannedFile {
  path: string;
  action: 'create' | 'reuse';
  /** Complete validated content to publish, or the existing content when reused. */
  content: string;
  /** Missing parent directories, outermost first. */
  directories: string[];
}
export interface SetupPlan { projectDirectory: string; coordinator: PlannedFile; project: PlannedFile }

/** Template model identifiers shipped in examples/heimdall.toml. They are syntactically valid but name no real model. */
export const SHIPPED_PLACEHOLDER_MODELS: readonly string[] = ['anthropic/your-planner-model', 'anthropic/your-executor-model', 'openai/your-executor-model'];
export const UNVERIFIED_BY_SETUP: readonly string[] = ['opencode-connection', 'model-availability', 'provider-login', 'quota'];

const FLAG_FOR_INPUT = {
  plannerModel: '--planner-model', executorModel: '--executor-model', quotaProvider: '--quota-provider', opencodeUrl: '--opencode-url', opencodeAuth: '--opencode-auth',
} as const;

const tomlString = (value: string): string => JSON.stringify(value).replace(/\u007f/g, '\\u007f');
const firstLine = (value: string): string => value.split('\n')[0]!.trim();
const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;

/** Parser failures can quote file content; report only the first line and position. */
export function describe(error: unknown): string {
  if (error instanceof TomlError) return `${firstLine(error.message)} (line ${error.line}, column ${error.column})`;
  if (error instanceof TypeError && error.message === 'Invalid URL') return 'opencode.baseUrl must be a valid URL';
  return error instanceof Error ? firstLine(error.message) : 'unreadable content';
}

function text(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new SetupError('invalid-input', `Invalid setup input: ${name} must be a string`);
  return value;
}

interface ProjectValues { plannerModel: string; executorModel: string; quotaProvider: string; opencodeUrl: string; opencodeAuth: string; passwordEnv?: string }

function renderProject(values: ProjectValues): string {
  return [
    '# Heimdall project configuration. Settings not listed here use built-in defaults.',
    '[workflow]',
    `plannerModel = ${tomlString(values.plannerModel)}`,
    '',
    '[[workflow.executorCandidates]]',
    'key = "primary"',
    `quotaProvider = ${tomlString(values.quotaProvider)}`,
    `model = ${tomlString(values.executorModel)}`,
    '',
    '[opencode]',
    `baseUrl = ${tomlString(values.opencodeUrl)}`,
    `authentication = ${tomlString(values.opencodeAuth)}`,
    ...(values.passwordEnv === undefined ? [] : [`passwordEnvironmentVariable = ${tomlString(values.passwordEnv)}`]),
    '',
  ].join('\n');
}

function renderCoordinator(lines: string[]): string {
  return ['# Heimdall coordinator configuration. Settings not listed here use built-in defaults.', '[coordinator]', ...lines, ''].join('\n');
}

interface Requested {
  plannerModel?: string; executorModel?: string; quotaProvider?: string; opencodeUrl?: string; opencodeAuth?: string; passwordEnv?: string;
  stateDirectory?: string; globalConcurrency?: number; projectConcurrency?: number;
  coordinatorLines: string[];
}

/** Validates every supplied value with the configuration loaders' own rules by parsing a probe document. */
async function validateInput(input: SetupInput, coordinatorFile: string, cwd: string): Promise<Requested> {
  const requested: Requested = { coordinatorLines: [] };
  const plannerModel = text(input.plannerModel, 'plannerModel');
  const executorModel = text(input.executorModel, 'executorModel');
  const quotaProvider = text(input.quotaProvider, 'quotaProvider');
  const opencodeUrl = text(input.opencodeUrl, 'opencodeUrl');
  const opencodeAuth = text(input.opencodeAuth, 'opencodeAuth');
  const passwordEnv = text(input.passwordEnv, 'passwordEnv');
  const stateDirectory = text(input.stateDirectory, 'stateDirectory');
  for (const [name, value] of [['plannerModel', plannerModel], ['executorModel', executorModel]] as const) {
    if (value !== undefined && SHIPPED_PLACEHOLDER_MODELS.includes(value)) throw new SetupError('invalid-input', `Invalid setup input: ${name} ${value} is a placeholder from the shipped template; supply a model available through your OpenCode accounts`);
  }
  if (passwordEnv !== undefined && opencodeAuth !== undefined && opencodeAuth !== 'basic') throw new SetupError('invalid-input', 'Invalid setup input: a password environment variable applies only to basic authentication');
  if ([plannerModel, executorModel, quotaProvider, opencodeUrl, opencodeAuth, passwordEnv].some(value => value !== undefined)) {
    const provider = quotaProvider ?? (executorModel?.startsWith('claude-code/') ? 'claude-code' : 'anthropic');
    const probe = renderProject({
      plannerModel: plannerModel ?? 'probe/planner',
      quotaProvider: provider,
      executorModel: executorModel ?? (provider === 'claude-code' ? 'claude-code/probe' : 'probe/executor'),
      opencodeUrl: opencodeUrl ?? 'http://127.0.0.1:1',
      opencodeAuth: opencodeAuth ?? 'basic',
      ...(passwordEnv === undefined ? {} : { passwordEnv }),
    });
    try { parseConfiguration(probe, { projectDirectory: cwd, file: path.join(cwd, '.heimdall.toml') }); }
    catch (error) { throw new SetupError('invalid-input', `Invalid setup input: ${describe(error)}`); }
    if (plannerModel !== undefined) requested.plannerModel = plannerModel;
    if (executorModel !== undefined) requested.executorModel = executorModel;
    if (quotaProvider !== undefined) requested.quotaProvider = quotaProvider;
    if (opencodeUrl !== undefined) { requested.opencodeUrl = opencodeUrl; }
    if (opencodeAuth !== undefined) requested.opencodeAuth = opencodeAuth;
    if (passwordEnv !== undefined) requested.passwordEnv = passwordEnv;
  }
  const lines: string[] = [];
  try {
    if (stateDirectory !== undefined) lines.push(`stateDirectory = ${tomlString(stateDirectory)}`);
    if (input.globalConcurrency !== undefined) lines.push(`globalConcurrency = ${positiveInteger(input.globalConcurrency, 'globalConcurrency')}`);
    if (input.projectConcurrency !== undefined) lines.push(`projectConcurrency = ${positiveInteger(input.projectConcurrency, 'projectConcurrency')}`);
    const parsed = await parseCoordinatorConfiguration(renderCoordinator(lines), coordinatorFile);
    if (stateDirectory !== undefined) requested.stateDirectory = parsed.stateDirectory;
    if (input.globalConcurrency !== undefined) requested.globalConcurrency = parsed.globalConcurrency;
    if (input.projectConcurrency !== undefined) requested.projectConcurrency = parsed.projectConcurrency;
  } catch (error) {
    const hint = stateDirectory === undefined && describe(error).startsWith('stateDirectory') ? ' (the default state directory is used; choose one with --state-directory)' : '';
    throw new SetupError('invalid-input', `Invalid setup input: ${describe(error)}${hint}`);
  }
  requested.coordinatorLines = lines;
  return requested;
}

async function readExisting(file: string, label: string): Promise<string | null> {
  let stats;
  try { stats = await fs.lstat(file); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new SetupError('invalid-destination', `Cannot inspect ${label} configuration ${file}: ${errorCode(error) ?? 'unreadable'}`);
  }
  if (stats.isSymbolicLink()) throw new SetupError('invalid-destination', `The ${label} configuration ${file} is a symbolic link; setup does not follow or replace symbolic links. Choose another destination.`);
  if (!stats.isFile()) throw new SetupError('invalid-destination', `The ${label} configuration ${file} is not a regular file. Choose another destination.`);
  let handle;
  try {
    handle = await fs.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    if (!(await handle.stat()).isFile()) throw new SetupError('invalid-destination', `The ${label} configuration ${file} is not a regular file. Choose another destination.`);
    return (await handle.readFile()).toString('utf8');
  } catch (error) {
    if (error instanceof SetupError) throw error;
    throw new SetupError('invalid-destination', `Cannot read ${label} configuration ${file}: ${errorCode(error) ?? 'unreadable'}`);
  } finally { await handle?.close(); }
}

/** Missing ancestors of `directory`, outermost first; the nearest existing ancestor must be a directory. */
async function missingDirectories(directory: string, label: string): Promise<string[]> {
  const missing: string[] = [];
  let current = directory;
  while (true) {
    try {
      if (!(await fs.stat(current)).isDirectory()) throw new SetupError('invalid-destination', `${current} is not a directory, so the ${label} configuration cannot be created there`);
      return missing;
    } catch (error) {
      if (error instanceof SetupError) throw error;
      if (errorCode(error) !== 'ENOENT') throw new SetupError('invalid-destination', `Cannot inspect ${current}: ${errorCode(error) ?? 'unreadable'}`);
      try { await fs.lstat(current); throw new SetupError('invalid-destination', `${current} is a dangling symbolic link, so the ${label} configuration cannot be created there`); }
      catch (inner) { if (inner instanceof SetupError) throw inner; }
      const parent = path.dirname(current);
      if (parent === current) throw new SetupError('invalid-destination', `Cannot create the ${label} configuration directory ${directory}`);
      missing.unshift(current);
      current = parent;
    }
  }
}

async function assertDistinct(coordinatorFile: string, projectFile: string): Promise<void> {
  const identify = async (file: string): Promise<string> => path.join(await canonicalPlannedDirectory(path.dirname(file)), path.basename(file));
  let same = false;
  try {
    same = await identify(coordinatorFile) === await identify(projectFile);
    if (!same) {
      const [a, b] = await Promise.all([fs.lstat(coordinatorFile), fs.lstat(projectFile)]);
      same = a.dev === b.dev && a.ino === b.ino;
    }
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw new SetupError('invalid-destination', `Cannot compare configuration destinations: ${errorCode(error) ?? 'unreadable'}`);
  }
  if (same) throw new SetupError('identical-destinations', `The coordinator and project configuration destinations resolve to the same file (${projectFile}). Choose distinct paths with --config and --coordinator-config.`);
}

interface Conflict { file: string; key: string; existing: string; requested: string }
const quote = (value: string | number): string => JSON.stringify(value);

function compareCoordinator(file: string, existing: CoordinatorConfiguration, requested: Requested): Conflict[] {
  const conflicts: Conflict[] = [];
  if (requested.stateDirectory !== undefined && requested.stateDirectory !== existing.stateDirectory) conflicts.push({ file, key: 'coordinator.stateDirectory', existing: quote(existing.stateDirectory), requested: quote(requested.stateDirectory) });
  if (requested.globalConcurrency !== undefined && requested.globalConcurrency !== existing.globalConcurrency) conflicts.push({ file, key: 'coordinator.globalConcurrency', existing: quote(existing.globalConcurrency), requested: quote(requested.globalConcurrency) });
  if (requested.projectConcurrency !== undefined && requested.projectConcurrency !== existing.projectConcurrency) conflicts.push({ file, key: 'coordinator.projectConcurrency', existing: quote(existing.projectConcurrency), requested: quote(requested.projectConcurrency) });
  return conflicts;
}

/**
 * The primary executor is the first `workflow.executorCandidates` entry (or `workflow.executorModel` when the file
 * defines no candidate pool). `--executor-model` and `--quota-provider` are compared with that entry only; further
 * pool entries, variants and limits are preserved and never compared.
 */
function compareProject(file: string, existing: Configuration, requested: Requested): Conflict[] {
  const conflicts: Conflict[] = [];
  const add = (key: string, current: string, wanted: string): void => { conflicts.push({ file, key, existing: current, requested: wanted }); };
  const primary = existing.settings.executorCandidates?.[0];
  if (requested.plannerModel !== undefined && requested.plannerModel !== existing.settings.plannerModel) add('workflow.plannerModel', quote(existing.settings.plannerModel), quote(requested.plannerModel));
  if (requested.executorModel !== undefined) {
    const current = primary?.model ?? existing.settings.executorModel;
    if (requested.executorModel !== current) add(primary ? 'workflow.executorCandidates[0].model' : 'workflow.executorModel', quote(current), quote(requested.executorModel));
  }
  if (requested.quotaProvider !== undefined && requested.quotaProvider !== primary?.quotaProvider) add('workflow.executorCandidates[0].quotaProvider', primary ? quote(primary.quotaProvider) : 'none (the file defines no executorCandidates)', quote(requested.quotaProvider));
  if (requested.opencodeUrl !== undefined && (existing.opencode.baseUrl === undefined || new URL(requested.opencodeUrl).href !== new URL(existing.opencode.baseUrl).href)) add('opencode.baseUrl', existing.opencode.baseUrl === undefined ? 'unset' : quote(existing.opencode.baseUrl), quote(requested.opencodeUrl));
  const authentication = existing.opencode.authentication ?? 'basic';
  if (requested.opencodeAuth !== undefined && requested.opencodeAuth !== authentication) add('opencode.authentication', quote(authentication), quote(requested.opencodeAuth));
  if (requested.passwordEnv !== undefined) {
    if (authentication !== 'basic') throw new SetupError('invalid-input', `Invalid setup input: a password environment variable applies only to basic authentication, but ${file} uses ${authentication}`);
    if (requested.passwordEnv !== existing.opencode.passwordEnvironmentVariable) add('opencode.passwordEnvironmentVariable', quote(existing.opencode.passwordEnvironmentVariable), quote(requested.passwordEnv));
  }
  return conflicts;
}

/** Schema-valid is not setup-complete: the endpoint is optional in the loader and shipped template models are placeholders. */
export function incompleteSettings(existing: Configuration): string[] {
  const missing: string[] = [];
  if (existing.opencode.baseUrl === undefined) missing.push('opencode.baseUrl');
  const placeholder = (model: string | undefined): boolean => model !== undefined && SHIPPED_PLACEHOLDER_MODELS.includes(model);
  if (placeholder(existing.settings.plannerModel)) missing.push('workflow.plannerModel');
  existing.settings.executorCandidates?.forEach((candidate, index) => { if (placeholder(candidate.model)) missing.push(`workflow.executorCandidates[${index}].model`); });
  if (placeholder(existing.settings.executorModel) && !existing.settings.executorCandidates?.some(candidate => candidate.model === existing.settings.executorModel)) missing.push('workflow.executorModel');
  if (placeholder(existing.settings.executorFallbackModel) && !existing.settings.executorCandidates?.some(candidate => candidate.model === existing.settings.executorFallbackModel)) missing.push('workflow.executorFallbackModel');
  return missing;
}

export interface SetupTrace { projectDirectory?: string; coordinatorPath?: string; projectPath?: string }

/** Resolves targets, validates everything and decides what would be created or reused. Writes nothing. */
export async function planSetup(input: SetupInput, options: SetupOptions = {}, trace: SetupTrace = {}): Promise<SetupPlan> {
  const environment = options.environment ?? process.env;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const home = options.homeDirectory ?? os.homedir();
  const coordinatorFile = path.resolve(cwd, input.coordinatorConfigPath ?? environment.HEIMDALL_COORDINATOR_CONFIG ?? path.join(home, '.config', 'heimdall', 'coordinator.toml'));
  trace.coordinatorPath = coordinatorFile;
  const requested = await validateInput(input, coordinatorFile, cwd);

  const selected = path.resolve(cwd, input.projectDirectory ?? '.');
  let projectDirectory: string;
  try { projectDirectory = (await inspectProject(selected)).directory; }
  catch { throw new SetupError('no-git-project', `${selected} is not inside a Git project. Select an existing Git project with --project; setup does not initialize Git.`); }
  trace.projectDirectory = projectDirectory;
  try { await resolveBaseCommit(projectDirectory, 'HEAD'); }
  catch { throw new SetupError('no-commit', `The Git project ${projectDirectory} has no commit. Create an initial commit first; setup does not create commits.`); }
  const projectFile = path.resolve(projectDirectory, input.configPath ?? (environment.HEIMDALL_CONFIG || undefined) ?? '.heimdall.toml');
  trace.projectPath = projectFile;

  await assertDistinct(coordinatorFile, projectFile);
  const [coordinatorContent, projectContent] = [await readExisting(coordinatorFile, 'coordinator'), await readExisting(projectFile, 'project')];

  let coordinatorEffective: CoordinatorConfiguration | undefined;
  if (coordinatorContent !== null) {
    try { coordinatorEffective = await parseCoordinatorConfiguration(coordinatorContent, coordinatorFile); }
    catch (error) { throw new SetupError('invalid-configuration', `The coordinator configuration ${coordinatorFile} is not valid: ${describe(error)}. Setup does not modify existing files; fix it or choose another destination with --coordinator-config.`); }
  }
  let projectEffective: Configuration | undefined;
  if (projectContent !== null) {
    try { projectEffective = parseConfiguration(projectContent, { projectDirectory, file: projectFile }); }
    catch (error) { throw new SetupError('invalid-configuration', `The project configuration ${projectFile} is not valid: ${describe(error)}. Setup does not modify existing files; fix it or choose another destination with --config.`); }
    const missing = incompleteSettings(projectEffective);
    if (missing.length) throw new SetupError('incomplete-configuration', `The existing project configuration ${projectFile} is incomplete for setup; missing decisions: ${missing.join(', ')}. Setup never modifies existing files; choose a new destination with --config (and --coordinator-config if needed) or edit the file yourself.`, missing);
  }

  const conflicts = [
    ...(coordinatorEffective ? compareCoordinator(coordinatorFile, coordinatorEffective, requested) : []),
    ...(projectEffective ? compareProject(projectFile, projectEffective, requested) : []),
  ];
  if (conflicts.length) {
    const details = conflicts.map(conflict => `${conflict.file}: ${conflict.key} is ${conflict.existing}, but ${conflict.requested} was requested`).join('; ');
    throw new SetupError('conflict', `Requested setup conflicts with existing configuration: ${details}. Setup never modifies existing files; omit the option to reuse the existing value or choose a new destination with --config/--coordinator-config.`);
  }

  let projectValues: ProjectValues | undefined;
  if (projectContent === null) {
    const absent = (Object.keys(FLAG_FOR_INPUT) as (keyof typeof FLAG_FOR_INPUT)[]).filter(key => requested[key] === undefined);
    if (absent.length) {
      const flags = absent.map(key => FLAG_FOR_INPUT[key]);
      throw new SetupError('missing-input', `A new project configuration ${projectFile} needs: ${flags.join(', ')}. Supply them as flags; setup does not guess models, quota providers or endpoints.`, flags);
    }
    projectValues = {
      plannerModel: requested.plannerModel!, executorModel: requested.executorModel!, quotaProvider: requested.quotaProvider!,
      opencodeUrl: requested.opencodeUrl!, opencodeAuth: requested.opencodeAuth!, ...(requested.passwordEnv === undefined ? {} : { passwordEnv: requested.passwordEnv }),
    };
  }

  const coordinator: PlannedFile = coordinatorContent === null
    ? { path: coordinatorFile, action: 'create', content: renderCoordinator(requested.coordinatorLines), directories: await missingDirectories(path.dirname(coordinatorFile), 'coordinator') }
    : { path: coordinatorFile, action: 'reuse', content: coordinatorContent, directories: [] };
  const project: PlannedFile = projectValues
    ? { path: projectFile, action: 'create', content: renderProject(projectValues), directories: await missingDirectories(path.dirname(projectFile), 'project') }
    : { path: projectFile, action: 'reuse', content: projectContent!, directories: [] };

  // Every prospective file must pass the loaders' validators before anything is published.
  if (coordinator.action === 'create') {
    try { await parseCoordinatorConfiguration(coordinator.content, coordinatorFile); }
    catch (error) { throw new SetupError('invalid-input', `Invalid setup input: ${describe(error)}`); }
  }
  if (project.action === 'create') {
    try { parseConfiguration(project.content, { projectDirectory, file: projectFile }); }
    catch (error) { throw new SetupError('invalid-input', `Invalid setup input: ${describe(error)}`); }
  }
  return { projectDirectory, coordinator, project };
}

const targetOutcome = (file: PlannedFile): TargetOutcome => file.action === 'reuse' ? 'reused' : 'not-written';

/** Publishes a plan: coordinator file first, then project file. Never overwrites; reports partial outcomes exactly. */
export async function applySetup(plan: SetupPlan, options: SetupOptions = {}): Promise<SetupResult> {
  const operations: SetupFileOperations = { ...nodeFileOperations, ...options.operations };
  const targets = { coordinator: { path: plan.coordinator.path, outcome: targetOutcome(plan.coordinator) }, project: { path: plan.project.path, outcome: targetOutcome(plan.project) } };
  const createdDirectories: string[] = [];
  const warnings: string[] = [];
  const created: string[] = [];
  let error: SetupResult['error'] = null;
  for (const name of ['coordinator', 'project'] as const) {
    const file = plan[name];
    if (file.action === 'reuse') continue;
    try {
      createdDirectories.push(...await createDirectories(file.directories, operations));
      warnings.push(...(await publishNoClobber(file.path, file.content, operations)).warnings);
      targets[name].outcome = 'created';
      created.push(file.path);
    } catch (cause) {
      targets[name].outcome = 'failed';
      const exists = cause instanceof PublishError && cause.kind === 'exists';
      error = exists
        ? { code: 'destination-exists', message: `The ${name} configuration ${file.path} appeared after validation and was not overwritten. Rerun setup to validate and reuse it.`, missing: [] }
        : { code: 'write-failed', message: cause instanceof Error ? cause.message : `Cannot write ${file.path}`, missing: [] };
      break;
    }
  }
  const incomplete = error ? (['coordinator', 'project'] as const).filter(name => targets[name].outcome === 'failed' || targets[name].outcome === 'not-written').map(name => plan[name].path) : [];
  const partial = error && created.length ? { created, incomplete } : null;
  if (error && partial) error = { ...error, message: `${error.message} Created: ${created.join(', ')}. Incomplete: ${incomplete.join(', ')}. Nothing was rolled back; rerun the same setup to finish.` };
  return {
    schemaVersion: 1, ok: error === null, projectDirectory: plan.projectDirectory, targets, createdDirectories,
    verification: { level: error ? 'none' : 'configuration-validated', unverified: [...UNVERIFIED_BY_SETUP] },
    error, partial, warnings,
  };
}

function failure(error: unknown, trace: SetupTrace): SetupResult {
  const known = error instanceof SetupError;
  return {
    schemaVersion: 1, ok: false, projectDirectory: trace.projectDirectory ?? null,
    targets: { coordinator: { path: trace.coordinatorPath ?? null, outcome: 'not-written' }, project: { path: trace.projectPath ?? null, outcome: 'not-written' } },
    createdDirectories: [], verification: { level: 'none', unverified: [...UNVERIFIED_BY_SETUP] },
    error: known
      ? { code: error.code, message: error.message, missing: error.missing }
      : { code: 'unexpected', message: `Setup failed unexpectedly (${errorCode(error) ?? (error instanceof Error ? error.name : 'error')}); no configuration was written`, missing: [] },
    partial: null, warnings: [],
  };
}

/** Plans and applies setup. Failures before the first write are reported with nothing created. */
export async function runSetup(input: SetupInput, options: SetupOptions = {}): Promise<SetupResult> {
  const trace: SetupTrace = {};
  let plan: SetupPlan;
  try { plan = await planSetup(input, options, trace); }
  catch (error) { return failure(error, trace); }
  return applySetup(plan, options);
}
