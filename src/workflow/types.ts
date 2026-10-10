import type { ExecutorSelection, QuotaSettings, QuotaSnapshot } from '../policy/types.js';

/** The established runner settings. Omitted time warnings and disabled caps are unlimited. */
export interface RunnerSettings extends QuotaSettings {
  plannerAgent: string;
  executorAgent: string;
  plannerModel: string;
  plannerVariant?: string;
  maxTasks: number;
  timeoutMinutes?: number | null;
  tokenLimitsDisabled?: boolean;
  maxSessionTokens?: number | null;
  maxRunTokens?: number | null;
  maxPlannerTokens?: number | null;
  maxPlannerUncachedTokens?: number | null;
  maxSessionUncachedTokens?: number | null;
  maxRunUncachedTokens?: number | null;
}

export interface WorkflowTask {
  id: string;
  title: string;
  brief: string;
  dependsOn: string[];
  dod: string[];
}

export interface CompletionEvidence {
  gateId?: string;
  gate?: string;
  passed?: boolean;
  detail: string;
}

/** Untrusted child output is validated before plan admission or task advancement. */
export interface WorkflowResult {
  status: string;
  artifacts?: boolean;
  planMarkdown?: string;
  factSheet?: string;
  tasks?: WorkflowTask[];
  taskId?: string;
  summary?: string;
  handoff?: string;
  evidence?: CompletionEvidence[];
  reason?: string;
  [field: string]: unknown;
}

export interface PlanResult extends WorkflowResult {
  status: 'planned';
  planMarkdown: string;
  factSheet: string;
  tasks: WorkflowTask[];
}

export interface CompletionResult extends WorkflowResult {
  status: 'completed';
  taskId: string;
  summary: string;
  handoff: string;
  evidence: CompletionEvidence[];
}

export interface WorkflowAttempt {
  id: string;
  phase: 'planner' | 'executor';
  index: number;
  child: string | null;
  status: 'launching' | 'admitted' | 'interrupted' | 'rejected';
  startedAt: number;
  model: string;
  variant?: string;
  /** Absent means a task attempt, so checkpoints saved before report correction stay valid. */
  purpose?: 'task' | 'report-correction';
}

/** Bounded reasons an executor completion report was not accepted. Only report_format is repairable. */
export type ReportDiagnosticCode =
  | 'report_format' | 'unfinished_work' | 'agent_blocked' | 'identity_mismatch' | 'ambiguous_output'
  | 'native_failure' | 'auth_or_quota' | 'correction_exhausted' | 'correction_unsupported' | 'correction_ambiguous';

/** Field names and gate IDs only: never reply text. */
export interface ReportDiagnostic {
  code: ReportDiagnosticCode;
  missingFields?: string[];
  gateIds?: string[];
}

/** Durable per-task completion-report recovery record. Removed only when the task really advances. */
export interface ReportRecovery {
  phase: 'executor';
  index: number;
  taskId: string;
  child: string | null;
  corrections: number;
  mode: 'idle' | 'correcting' | 'paused';
  originalAttemptId: string;
  attempts: string[];
  diagnostic?: ReportDiagnostic;
}

export interface ProgressUpdate {
  title?: string;
  runId?: string;
  childSession?: string | null;
  warning?: string;
  [field: string]: unknown;
}

export interface RunnerContext {
  sessionID: string;
  id?: string;
  messageID?: string;
  agent?: string;
  signal?: AbortSignal;
  abort?: AbortSignal;
  progress?: (update: ProgressUpdate) => void | Promise<void>;
  metadata?: (update: { title?: string; metadata: ProgressUpdate }) => unknown;
}

export interface SubagentInput {
  child: string | null;
  parent: string;
  agent: string;
  model: string;
  variant?: string;
  title: string;
  prompt: string;
  onStarted: (id: string) => Promise<void>;
  currentChild: () => string | null;
}

export interface RunnerBackend {
  assertIdle: (id: string, parent?: string, signal?: AbortSignal) => Promise<unknown>;
  recoverResponse: (child: string, parent: string, attempt: WorkflowAttempt) => Promise<unknown>;
  usage: (child: string) => Promise<{ used: number; uncached: number }>;
  interrupt: (child: string, parent: string) => Promise<unknown>;
  runSubagent: (input: SubagentInput, context: RunnerContext) => Promise<unknown>;
}

export interface RunArguments {
  action: 'start' | 'resume' | 'status';
  adr?: string;
  runId?: string;
  input?: string;
  onLaunch?: () => Promise<void> | void;
  recovery?: { child: string; expectedReservationAt: number };
}

export interface WorkflowReceipt extends WorkflowAttempt { response: unknown }

/** Authoritative managed-run storage. The local file backend remains the default. */
export interface RunnerPersistence {
  load(runId: string): Promise<RunState | null>;
  save(state: RunState): Promise<void>;
  readReceipt(runId: string, attemptId: string): Promise<WorkflowReceipt | null>;
  writeReceipt(runId: string, receipt: WorkflowReceipt): Promise<void>;
  bindStart(binding: Required<Pick<RunnerContext, 'sessionID' | 'id' | 'messageID' | 'agent'>>): Promise<void>;
}

export interface RunnerOptions {
  persistence?: RunnerPersistence;
  backend: RunnerBackend;
  directory: string;
  quota: (settings: RunnerSettings) => Promise<QuotaSnapshot>;
  authRefresh?: () => Promise<unknown>;
  guards?: Map<string, () => Promise<void>>;
  git?: (args: string[]) => string;
  /** Injected settings are read on every invocation, including resume. */
  settings?: RunnerSettings | (() => RunnerSettings | Promise<RunnerSettings>);
  /** Paths may be absolute or relative to directory. Omitted paths retain the legacy layout. */
  workflowRoot?: string;
  settingsPath?: string;
  plannerPromptPath?: string;
  executorPromptPath?: string;
  planRoot?: string;
}

export interface SavedCompletion extends CompletionResult {
  sessionId: string | null;
  model: string;
  quotaSelection?: ExecutorSelection;
}

export interface RunState {
  id: string;
  status: 'running' | 'paused' | 'completed';
  adr: string;
  parent: string;
  caller: Pick<RunnerContext, 'sessionID' | 'id' | 'messageID' | 'agent'>;
  branch: string;
  baseline: string;
  index: number;
  tasks: WorkflowTask[];
  results: SavedCompletion[];
  phase: 'planner' | 'executor';
  child: string | null;
  settings: RunnerSettings;
  attempt?: WorkflowAttempt;
  selection?: ExecutorSelection;
  resolution?: string;
  reason?: string;
  reportRecovery?: ReportRecovery;
  usage?: Record<string, number>;
  uncachedUsage?: Record<string, number>;
  tokenLimitsDisabled?: boolean;
  taskStartedAt?: number;
  taskElapsedMs?: number;
  timeWarnings?: Record<string, { message: string; at: string }>;
  timeWarningSaveError?: string;
  watchdogReservationAt?: number;
}
