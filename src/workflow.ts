import type { Plugin } from '@opencode/plugin';
import { createRunner } from './workflow/runner.js';
import { createNativeBackend } from './opencode/native-backend.js';
import { createObserver } from './opencode/observer.js';
import { createQuota, refreshClaudeAuth } from './policy/quota.js';
import type { Configuration } from './config.js';
import type { SessionObserver } from './opencode/types.js';
import type { ReportOnlyRegistry } from './opencode/report-only.js';
import type { RunnerBackend, RunnerOptions } from './workflow/types.js';

export interface WorkflowOptions {
  configuration: Configuration;
  ctx?: Pick<Plugin.Context, 'tool' | 'session' | 'integration'>;
  observe?: SessionObserver;
  guards?: Map<string, () => Promise<void>>;
  reportOnly?: ReportOnlyRegistry;
  backend?: RunnerBackend;
  quota?: RunnerOptions['quota'];
  authRefresh?: RunnerOptions['authRefresh'];
  git?: RunnerOptions['git'];
  persistence?: RunnerOptions['persistence'];
}

/** Compose the extracted workflow without starting or changing an OpenCode server. */
export function createWorkflow(options: WorkflowOptions): ReturnType<typeof createRunner> {
  const { configuration, ctx } = options;
  let backend = options.backend;
  if (!backend) {
    if (!ctx) throw new Error('A native OpenCode context or injected backend is required');
    const observe = options.observe ?? createObserver({ directory: configuration.projectDirectory, ...configuration.opencode });
    backend = createNativeBackend({ ctx, observe, reportOnly: options.reportOnly });
  }
  return createRunner({
    backend, directory: configuration.projectDirectory, settings: configuration.readSettings ?? configuration.settings,
    workflowRoot: configuration.workflowRoot, planRoot: configuration.planRoot,
    plannerPromptPath: configuration.plannerPromptPath, executorPromptPath: configuration.executorPromptPath,
    quota: options.quota ?? createQuota({ integration: ctx?.integration, directory: configuration.projectDirectory, workflowRoot: configuration.workflowRoot }),
    authRefresh: options.authRefresh ?? (ctx ? () => refreshClaudeAuth(ctx.integration) : undefined),
    guards: options.guards, git: options.git, persistence: options.persistence,
  });
}
