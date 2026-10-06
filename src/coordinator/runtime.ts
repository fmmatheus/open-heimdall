import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stringify } from 'smol-toml';
import { loadConfiguration } from '../config.js';
import type { ProjectRecord, RunRecord, RunSpecification } from './types.js';

const packageFile = (relative: string) => fileURLToPath(new URL('../../' + relative, import.meta.url));
const git = promisify(execFile);
const roleName = (name: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(name)) throw new Error('Managed agent names must contain only letters, numbers, underscore or hyphen');
  return name;
};

export async function snapshotSpecification(project: ProjectRecord): Promise<RunSpecification> {
  const configuration = await loadConfiguration({ projectDirectory: project.directory, configPath: project.configPath });
  if (!configuration.opencode.baseUrl) throw new Error('Project configuration requires a local OpenCode baseUrl');
  const settings = structuredClone(configuration.settings);
  delete settings.packagePath; // Managed runs use this package's pinned quota adapter.
  const planner = roleName(settings.plannerAgent);
  const executor = roleName(settings.executorAgent);
  if (new Set(['adr-orchestrator', planner, executor]).size !== 3) throw new Error('Orchestrator, planner and executor roles must be distinct');
  const [plannerPrompt, executorPrompt, orchestratorRole, plannerRole, executorRole] = await Promise.all([
    fs.readFile(configuration.plannerPromptPath, 'utf8'), fs.readFile(configuration.executorPromptPath, 'utf8'),
    fs.readFile(packageFile('examples/opencode/agents/adr-orchestrator.md'), 'utf8'),
    fs.readFile(packageFile('examples/opencode/agents/adr-planner.md'), 'utf8'),
    fs.readFile(packageFile('examples/opencode/agents/adr-executor.md'), 'utf8'),
  ]);
  return {
    settings, plannerPrompt, executorPrompt,
    agents: { 'adr-orchestrator': orchestratorRole.replaceAll('resource: adr-planner', `resource: ${planner}`).replaceAll('resource: adr-executor', `resource: ${executor}`), [planner]: plannerRole, [executor]: executorRole },
    opencode: { baseUrl: configuration.opencode.baseUrl, passwordEnvironmentVariable: configuration.opencode.passwordEnvironmentVariable },
  };
}

/** Reject inherited assets before reserving capacity; never overwrite a copied workflow. */
export async function checkRuntimeConflicts(project: ProjectRecord, baseCommit: string, specification: RunSpecification): Promise<void> {
  const { stdout } = await git('git', ['ls-tree', '-r', '-z', '--full-tree', baseCommit, '--', '.heimdall', '.opencode'], { cwd: project.directory, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  const roles = new Set(Object.keys(specification.agents).map(name => `.opencode/agents/${roleName(name)}.md`));
  for (const entry of stdout.split('\0').filter(Boolean)) {
    const tab = entry.indexOf('\t');
    if (tab < 0) throw new Error('Cannot inspect pinned runtime paths');
    const filename = entry.slice(tab + 1);
    const mode = entry.slice(0, 6);
    const ancestor = ['.opencode', '.opencode/agents', '.opencode/plugins'].includes(filename);
    if (filename === '.heimdall' || filename.startsWith('.heimdall/') || filename.startsWith('.opencode/plugins/') || roles.has(filename) || (ancestor && ['120000', '160000'].includes(mode))) {
      throw new Error(`Pinned project already tracks a managed runtime path: ${filename}. Select a development project without these assets; existing workflows are preserved.`);
    }
  }
}

async function directoryInside(checkout: string, relative: string): Promise<string> {
  let current = checkout;
  for (const segment of relative.split('/')) {
    current = path.join(current, segment);
    try { await fs.mkdir(current, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Managed runtime path must be a directory inside its worktree');
  }
  return current;
}

/** Create assets only in a newly claimed checkout; never install or reload a live plugin. */
export async function prepareRuntime(run: RunRecord, endpoint: string): Promise<void> {
  if (!run.ownerToken || !run.capacityReserved) throw new Error('Runtime preparation requires a reserved run');
  const checkout = await fs.realpath(run.worktreePath);
  if (checkout !== path.resolve(run.worktreePath)) throw new Error('Managed checkout must be canonical');
  const root = path.join(checkout, '.heimdall');
  const metadata = { endpoint, runId: run.id, ownerToken: run.ownerToken, parentSessionId: run.parentSessionId };
  if (run.launchAction === 'resume') {
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Managed runtime directory changed');
    const target = path.join(root, 'managed.json');
    const targetStat = await fs.lstat(target);
    if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new Error('Managed runtime binding changed');
    const previous = JSON.parse(await fs.readFile(target, 'utf8')) as typeof metadata;
    if (previous.runId !== run.id || previous.parentSessionId !== run.parentSessionId || previous.endpoint !== endpoint) throw new Error('Managed runtime belongs to another coordinator run');
    const temporary = target + '.' + randomUUID();
    await fs.writeFile(temporary, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, target);
    return;
  }
  await fs.mkdir(root, { mode: 0o700 }); // Existing tracked/runtime state is never overwritten.
  await fs.writeFile(path.join(root, 'managed.json'), JSON.stringify(metadata), { flag: 'wx', mode: 0o600 });
  await fs.writeFile(path.join(root, 'feature.md'), run.feature, { flag: 'wx', mode: 0o600 });
  await fs.writeFile(path.join(root, 'planner.md'), run.specification.plannerPrompt, { flag: 'wx', mode: 0o600 });
  await fs.writeFile(path.join(root, 'executor.md'), run.specification.executorPrompt, { flag: 'wx', mode: 0o600 });
  const runtimeConfig = path.join(root, 'runtime.toml');
  const workflow = Object.fromEntries(Object.entries(run.specification.settings).filter(([, value]) => value !== null && value !== undefined));
  await fs.writeFile(runtimeConfig, stringify({ workflow, paths: { state: '.heimdall/state', plans: '.heimdall/plans', plannerPrompt: '.heimdall/planner.md', executorPrompt: '.heimdall/executor.md' }, opencode: run.specification.opencode }), { flag: 'wx', mode: 0o600 });
  const agents = await directoryInside(checkout, '.opencode/agents');
  for (const [name, content] of Object.entries(run.specification.agents)) await fs.writeFile(path.join(agents, roleName(name) + '.md'), content, { flag: 'wx', mode: 0o600 });
  const plugins = await directoryInside(checkout, '.opencode/plugins');
  const plugin = pathToFileURL(fileURLToPath(new URL('../opencode/plugin.js', import.meta.url))).href;
  await fs.writeFile(path.join(plugins, 'heimdall.ts'), `import { createPlugin } from ${JSON.stringify(plugin)};\nexport default createPlugin({ configPath: ${JSON.stringify(runtimeConfig)} });\n`, { flag: 'wx', mode: 0o600 });
}
