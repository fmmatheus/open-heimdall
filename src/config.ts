import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'smol-toml';
import type { RunnerSettings } from './workflow/types.js';
import type { ExecutorCandidate } from './policy/types.js';

export interface Configuration {
  projectDirectory: string;
  configPath: string;
  workflowRoot: string;
  plannerPromptPath: string;
  executorPromptPath: string;
  planRoot: string;
  settings: RunnerSettings;
  readSettings?: () => Promise<RunnerSettings>;
  opencode: { baseUrl?: string; passwordEnvironmentVariable: string; authentication?: 'basic' | 'none' | 'openchamber' };
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
function table(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!record(value)) throw new Error(`${name} must be a TOML table`);
  return value;
}
function keys(value: Record<string, unknown>, allowed: string[], name: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${name} setting: ${key}`);
}
function text(value: unknown, name: string, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a nonempty string`);
  return value;
}
function model(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^[^/#\s]+\/[^#\s]+$/.test(result)) throw new Error(`${name} must use provider/model syntax`);
  return result;
}
function number(value: unknown, name: string, fallback?: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be between ${min} and ${max}`);
  return value;
}
function candidate(value: unknown, index: number): ExecutorCandidate {
  const row = table(value, `workflow.executorCandidates[${index}]`);
  keys(row, ['key', 'quotaProvider', 'model', 'variant'], 'executor candidate');
  const provider = text(row.quotaProvider, 'quotaProvider');
  if (!['anthropic', 'claude-code', 'openai', 'kimi'].includes(provider)) throw new Error('quotaProvider must be anthropic, claude-code, openai, or kimi');
  const key = text(row.key, 'candidate key');
  if (!/^[A-Za-z0-9_-]+$/.test(key) || ['model', 'variant', 'checkedAt'].includes(key)) throw new Error('Executor candidate key is invalid or reserved');
  const result: ExecutorCandidate = { key, quotaProvider: provider, model: model(row.model, 'candidate model') };
  if ((provider === 'claude-code') !== result.model.startsWith('claude-code/')) throw new Error('Claude Code candidates must pair quotaProvider claude-code with a claude-code/model');
  if (row.variant !== undefined) {
    result.variant = text(row.variant, 'candidate variant');
    if (result.variant.includes('#')) throw new Error('candidate variant cannot contain #');
  }
  return result;
}

export async function loadConfiguration({ projectDirectory = process.cwd(), configPath }: { projectDirectory?: string; configPath?: string } = {}): Promise<Configuration> {
  const directory = path.resolve(projectDirectory);
  const file = path.resolve(directory, configPath ?? '.heimdall.toml');
  let content: string;
  try { content = await fs.readFile(file, 'utf8'); }
  catch (cause) { throw new Error(`Cannot read Heimdall configuration ${file}. Create it with heimdall init.`, { cause }); }
  const document = parse(content, { unsafeKeyBehaviour: 'throw' });
  keys(document, ['workflow', 'paths', 'opencode'], 'top-level');
  const workflow = table(document.workflow, 'workflow');
  const paths = table(document.paths, 'paths');
  const opencode = table(document.opencode, 'opencode');
  keys(workflow, ['plannerAgent', 'executorAgent', 'plannerModel', 'plannerVariant', 'executorModel', 'executorFallbackModel', 'executorCandidates', 'maxTasks', 'minQuotaRemainingPercent', 'fiveHourQuotaWeight', 'tokenLimitsDisabled', 'timeoutMinutes', 'maxSessionTokens', 'maxRunTokens', 'maxPlannerTokens', 'maxSessionUncachedTokens', 'maxRunUncachedTokens', 'maxPlannerUncachedTokens', 'packagePath'], 'workflow');
  keys(paths, ['state', 'plans', 'plannerPrompt', 'executorPrompt'], 'paths');
  keys(opencode, ['baseUrl', 'passwordEnvironmentVariable', 'authentication'], 'opencode');
  let candidates: ExecutorCandidate[] | undefined;
  if (workflow.executorCandidates !== undefined) {
    if (!Array.isArray(workflow.executorCandidates) || workflow.executorCandidates.length === 0) throw new Error('executorCandidates must be a nonempty array');
    candidates = workflow.executorCandidates.map(candidate);
    if (new Set(candidates.map(row => row.key)).size !== candidates.length) throw new Error('Executor candidate keys must be unique');
  }
  const first = candidates?.[0]?.model;
  const fallback = candidates?.[1]?.model ?? first;
  const maxTasks = number(workflow.maxTasks, 'maxTasks', 10, 1, 10);
  if (!Number.isInteger(maxTasks)) throw new Error('maxTasks must be an integer');
  if (workflow.tokenLimitsDisabled !== undefined && typeof workflow.tokenLimitsDisabled !== 'boolean') throw new Error('tokenLimitsDisabled must be boolean');
  const settings: RunnerSettings = {
    plannerAgent: text(workflow.plannerAgent, 'plannerAgent', 'adr-planner'),
    executorAgent: text(workflow.executorAgent, 'executorAgent', 'adr-executor'),
    plannerModel: model(workflow.plannerModel, 'plannerModel'),
    executorModel: model(workflow.executorModel ?? first, 'executorModel'),
    executorFallbackModel: model(workflow.executorFallbackModel ?? fallback, 'executorFallbackModel'),
    maxTasks,
    minQuotaRemainingPercent: number(workflow.minQuotaRemainingPercent, 'minQuotaRemainingPercent', 10, 0, 100),
    fiveHourQuotaWeight: number(workflow.fiveHourQuotaWeight, 'fiveHourQuotaWeight', 0.6, 0, 1),
    tokenLimitsDisabled: workflow.tokenLimitsDisabled ?? true,
    ...(candidates ? { executorCandidates: candidates } : {}),
  };
  if (!(settings.fiveHourQuotaWeight! > 0 && settings.fiveHourQuotaWeight! < 1)) throw new Error('fiveHourQuotaWeight must be strictly between 0 and 1');
  if (workflow.plannerVariant !== undefined) {
    settings.plannerVariant = text(workflow.plannerVariant, 'plannerVariant');
    if (settings.plannerVariant.includes('#')) throw new Error('plannerVariant cannot contain #');
  }
  if (workflow.timeoutMinutes !== undefined) settings.timeoutMinutes = number(workflow.timeoutMinutes, 'timeoutMinutes', undefined, Number.MIN_VALUE);
  const caps = ['maxSessionTokens', 'maxRunTokens', 'maxPlannerTokens', 'maxSessionUncachedTokens', 'maxRunUncachedTokens', 'maxPlannerUncachedTokens'] as const;
  for (const cap of caps) if (workflow[cap] !== undefined) settings[cap] = number(workflow[cap], cap, undefined, 1);
  if (!settings.tokenLimitsDisabled && (settings.maxSessionTokens === undefined || settings.maxRunTokens === undefined)) throw new Error('Enabled token limits require maxSessionTokens and maxRunTokens');
  if (workflow.packagePath !== undefined) settings.packagePath = path.resolve(directory, text(workflow.packagePath, 'packagePath'));
  const workflowRoot = path.resolve(directory, text(paths.state, 'paths.state', '.heimdall'));
  const planRoot = path.resolve(directory, text(paths.plans, 'paths.plans', path.join(workflowRoot, 'plans')));
  const relativePlans = path.relative(directory, planRoot);
  if (relativePlans === '..' || relativePlans.startsWith('..' + path.sep) || path.isAbsolute(relativePlans)) throw new Error('paths.plans must remain inside the project; configure it explicitly when state is external');
  const authentication = opencode.authentication ?? 'basic';
  if (authentication !== 'basic' && authentication !== 'none' && authentication !== 'openchamber') throw new Error('opencode.authentication must be basic, none, or openchamber');
  const passwordEnvironmentVariable = text(opencode.passwordEnvironmentVariable, 'opencode.passwordEnvironmentVariable', 'OPENCODE_PASSWORD');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(passwordEnvironmentVariable)) throw new Error('passwordEnvironmentVariable must be an environment variable name');
  const baseUrl = opencode.baseUrl === undefined ? undefined : text(opencode.baseUrl, 'opencode.baseUrl');
  if (baseUrl !== undefined) {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('opencode.baseUrl must be a local HTTP(S) origin without embedded credentials');
  }
  const configuration: Configuration = {
    projectDirectory: directory, configPath: file, workflowRoot, settings,
    plannerPromptPath: paths.plannerPrompt === undefined ? fileURLToPath(new URL('../prompts/planner.md', import.meta.url)) : path.resolve(directory, text(paths.plannerPrompt, 'paths.plannerPrompt')),
    executorPromptPath: paths.executorPrompt === undefined ? fileURLToPath(new URL('../prompts/executor.md', import.meta.url)) : path.resolve(directory, text(paths.executorPrompt, 'paths.executorPrompt')),
    planRoot,
    opencode: { ...(baseUrl ? { baseUrl } : {}), passwordEnvironmentVariable, authentication },
  };
  configuration.readSettings = async () => {
    const current = await loadConfiguration({ projectDirectory: directory, configPath: file });
    for (const key of ['workflowRoot', 'planRoot', 'plannerPromptPath', 'executorPromptPath'] as const) {
      if (current[key] !== configuration[key]) throw new Error('Changing workflow paths requires reloading the plugin; existing run locations are preserved');
    }
    if (current.settings.plannerAgent !== settings.plannerAgent || current.settings.executorAgent !== settings.executorAgent || current.opencode.authentication !== configuration.opencode.authentication || current.opencode.baseUrl !== configuration.opencode.baseUrl || current.opencode.passwordEnvironmentVariable !== configuration.opencode.passwordEnvironmentVariable) throw new Error('Changing native roles or connection settings requires reloading the plugin');
    return current.settings;
  };
  return configuration;
}
