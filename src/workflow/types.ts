import type { ExecutorSelection, QuotaSettings, QuotaSnapshot } from '../policy/types.js';
import type { ContractRef, SubmissionKind, SUBMISSION_PROTOCOL } from './contracts.js';

/** The only typed protocol so far. A run without a persisted protocol is a legacy (prose) run. */
export type SubmissionProtocol = typeof SUBMISSION_PROTOCOL;

/** What the host knows about the code that is executing. T6 extends this with a runtime asset identity. */
export interface RuntimeIdentity {
  packageVersion: string;
  protocol: SubmissionProtocol;
}

/**
 * Durable authority for one typed submission, stored inside the checkpoint so it is reconstructable after a
 * restart. `child` is null until the native child id is recorded; `dispatch` increases with every prompt sent
 * to the same child for the same attempt.
 */
export interface SubmissionBinding {
  protocol: SubmissionProtocol;
  kind: SubmissionKind;
  runId: string;
  phase: 'planner' | 'executor';
  index: number;
  taskId?: string;
  attemptId: string;
  dispatch: number;
  parent: string;
  child: string | null;
  status: 'open' | 'closed';
}

/** Native call identity as delivered by OpenCode; never taken from the model-supplied payload. */
export interface SubmissionCaller {
  sessionID: string;
  agent: string;
  messageID: string;
  callId: string;
}

/**
 * Host-generated, immutable record of one accepted typed submission. `rawPayload` is the exact submitted value
 * cloned before validation; `canonical` is the validated, normalized value (plans carry their snapshot hash,
 * executor evidence carries the host-derived gate text).
 */
export interface SubmissionReceipt {
  receiptVersion: 1;
  protocol: SubmissionProtocol;
  contract: ContractRef;
  kind: SubmissionKind;
  runId: string;
  phase: 'planner' | 'executor';
  index: number;
  taskId?: string;
  attemptId: string;
  dispatch: number;
  parent: string;
  child: string;
  caller: SubmissionCaller;
  runtime: RuntimeIdentity;
  outcome: string;
  rawPayload: unknown;
  canonical: unknown;
  digest: string;
  acceptedAt: number;
}

/**
 * The native turn result of a structured attempt, kept in its own slot so a later final-response capture
 * can never conflict with the typed receipt or with the immutable legacy WorkflowReceipt key.
 */
export interface NativeOutcome {
  outcomeVersion: 1;
  runId: string;
  phase: 'planner' | 'executor';
  index: number;
  attemptId: string;
  child: string;
  response: unknown;
  capturedAt: number;
}

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

export type ReportOnlyCheck = { supported: true } | { supported: false; reason: string };

/** Identity of one report-only restriction: the correction attempt that took it. */
export interface ReportOnlyOwner {
  parent: string;
  child: string;
  /** The report-correction attempt ID that took the restriction. */
  attemptId: string;
  runId?: string;
}

/** Fail-closed capability: deny every tool call for a child while it writes a report. */
export interface ReportOnlyCapability {
  /** Whether enforcement is verified for this model's provider. Never throws for unsupported. */
  check: (model: string, child: string) => Promise<ReportOnlyCheck>;
  /** Restrict the child under an owner. The returned release is idempotent. */
  restrict: (child: string, owner?: Omit<ReportOnlyOwner, 'child'>) => Promise<() => Promise<void>>;
  /**
   * Release restrictions that outlived the invocation (and backend instance) that took them. Releases only entries
   * owned by the named correction attempts of this child/parent/run, is idempotent, and may be retried after a throw.
   * The caller must have fresh idle proof for the child.
   */
  releaseRetained: (input: { child: string; parent: string; runId?: string; attemptIds: string[] }) => Promise<void>;
}

export interface RunnerBackend {
  /** Absent means report-only enforcement is unsupported (safe-pause fallback). */
  reportOnly?: ReportOnlyCapability;
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
  /** Typed submissions live in their own slot, keyed by run + attempt + kind. */
  readSubmission(runId: string, attemptId: string, kind: SubmissionKind): Promise<SubmissionReceipt | null>;
  /** Immutable and idempotent. Resolves to the stored receipt; a conflicting write rejects and never overwrites. */
  writeSubmission(runId: string, receipt: SubmissionReceipt): Promise<SubmissionReceipt>;
  readNativeOutcome(runId: string, attemptId: string): Promise<NativeOutcome | null>;
  writeNativeOutcome(runId: string, outcome: NativeOutcome): Promise<NativeOutcome>;
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
  /** Protocol selected for runs STARTED by this runner. A resumed run always keeps the protocol it started with. */
  protocol?: SubmissionProtocol;
}

export interface SavedCompletion extends CompletionResult {
  sessionId: string | null;
  model: string;
  quotaSelection?: ExecutorSelection;
  /** Report-only corrections consumed before this report was accepted. Absent when none ran. */
  reportCorrections?: number;
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
  /** Set once when the run starts and never changed. Absent means the legacy prose protocol. */
  protocol?: SubmissionProtocol;
  /** The current typed-submission authority of a structured run. */
  submissionBinding?: SubmissionBinding;
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
