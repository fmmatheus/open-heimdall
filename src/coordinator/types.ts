import type { RunnerSettings, RunState, WorkflowAttempt } from '../workflow/types.js';

export interface ProjectRecord {
  id: string;
  directory: string;
  commonGitDirectory: string;
  configPath: string;
  concurrency: number;
  createdAt: number;
}

/** No passwords or provider credentials are included in a submission snapshot. */
export interface RunSpecification {
  settings: RunnerSettings;
  plannerPrompt: string;
  executorPrompt: string;
  agents: Record<string, string>;
  opencode: { baseUrl: string; passwordEnvironmentVariable: string; authentication?: 'basic' | 'none' };
}

export type RunStatus = 'queued' | 'preparing' | 'running' | 'paused' | 'succeeded' | 'failed' | 'reconciliation-required';
export interface RunRecord {
  id: string;
  projectId: string;
  feature: string;
  baseCommit: string;
  worktreePath: string;
  branch: string;
  specification: RunSpecification;
  status: RunStatus;
  capacityReserved: boolean;
  ownerToken: string | null;
  version: number;
  parentSessionId: string;
  promptMessageId: string;
  launchAction: 'start' | 'resume';
  resolution: string | null;
  checkpoint: RunState | null;
  binding: StartBinding | null;
  resumeBinding: StartBinding | null;
  /** Written before the first native API operation for this admission. */
  launchIntent: boolean;
  reason: string | null;
  createdAt: number;
  updatedAt: number;
}
export interface StartBinding {
  sessionID: string;
  id: string;
  messageID: string;
  agent: string;
}
export type Receipt = WorkflowAttempt & { response: unknown };
export interface CoordinatorEvent {
  sequence: number;
  runId: string | null;
  projectId: string | null;
  type: string;
  at: number;
  payload: Record<string, unknown>;
}

export interface WorktreePlan { namespacePath: string; worktreePath: string; branch: string }
export interface ProjectIdentity { directory: string; commonGitDirectory: string }
export interface ExecutorInspection {
  /** True only after every known parent/child has a complete, idle native observation. */
  idle: boolean;
  status: 'succeeded' | 'paused' | 'failed' | 'unknown';
  reason?: string;
}
export interface ManagedExecutor {
  launch(run: RunRecord): Promise<void>;
  inspect(run: RunRecord): Promise<ExecutorInspection>;
}
