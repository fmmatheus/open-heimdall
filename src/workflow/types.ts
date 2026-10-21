import type { ApprovalContext } from './approval-context.js';
import type { ExecutorSelection, QuotaSettings, QuotaSnapshot } from '../policy/types.js';
import type { ContractRef, SubmissionKind, SUBMISSION_PROTOCOL } from './contracts.js';
import type { DispatchPromptSync } from './prompt-sync.js';
import type { SubmissionSupervisor } from './submission-repair.js';

/** The only typed protocol so far. A run without a persisted protocol is a legacy (prose) run. */
export type SubmissionProtocol = typeof SUBMISSION_PROTOCOL;

/** Content identity of the loaded package, computed from its own module location and never from the Git revision. */
export interface RuntimeBuildIdentity {
  packageName: string;
  /** Contract version of every submission kind. */
  contracts: Record<string, number>;
  /** sha256 over the executable files of dist, the prompts and the agent files. */
  dist: string;
  prompts: string;
  agents: string;
  dependencies: {
    /** sha256 of package-lock.json, or null when the package has none. */
    lockfile: string | null;
    /** Installed version of every direct runtime dependency ('missing' when absent). */
    direct: Record<string, string>;
    /** sha256 over the installed version of every locked runtime package. */
    resolved: string;
  };
  /** sha256 over every field above plus the package version and protocol. */
  digest: string;
  /** True when loaded from an immutable run-owned snapshot. Not part of `digest`. */
  snapshot: boolean;
}

/** What the host knows about the code that is executing. `build` is absent on receipts that predate it. */
export interface RuntimeIdentity {
  packageVersion: string;
  protocol: SubmissionProtocol;
  build?: RuntimeBuildIdentity;
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
  /**
   * The native prompt message that started this dispatch, recorded by the host (never the model) when it sends or
   * observes that prompt. A tool call is only accepted when native observation proves it descends from this prompt,
   * so a delayed call from an earlier dispatch to the same child cannot be admitted under a newer one. Null until
   * recorded, and a binding with no recorded prompt authenticates nobody.
   */
  prompt: string | null;
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
  /** The binding's dispatch prompt, proven by native observation of the call; always equal to the binding at acceptance. */
  origin: string;
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
  | 'native_failure' | 'auth_or_quota' | 'correction_exhausted' | 'correction_unsupported' | 'correction_ambiguous'
  | 'submission_missing' | 'submission_unconfirmed'
  | 'submission_repair_exhausted' | 'submission_refused' | 'submission_unsupported' | 'conflicting_work'
  /** A valid approval-required submission: a semantic wait for an owner decision, never a format error. */
  | 'approval_required';

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

/** Why the host stopped offering format repair for an attempt. The run pauses; it never reruns or switches provider. */
export type SubmissionRepairRefusal = 'exhausted' | 'unsupported' | 'auth_or_quota' | 'unavailable';

/**
 * Durable bound on format repair of typed submissions for ONE planner phase or executor task. It lives in the
 * checkpoint, is saved BEFORE any repair feedback is returned, and only real advancement removes it, so it
 * survives interruption, crash and explicit resume. The initial submission is free; at most
 * MAX_SUBMISSION_REPAIRS repairs are granted in total, however many dispatches the task needs.
 */
export interface SubmissionRepairRecord {
  phase: 'planner' | 'executor';
  index: number;
  taskId?: string;
  /** The child session whose restrictions `attempts` name. */
  child?: string | null;
  /** Format-repair opportunities granted so far (feedback returned). */
  repairs: number;
  /** Dispatch attempts that took a reporting-only restriction, so a later invocation can release exactly those owners. */
  attempts: string[];
  /** Set when an attempt's repair was refused. That attempt then pauses and accepts nothing further. */
  refused?: { attemptId: string; code: SubmissionRepairRefusal; reason: string };
  /** Set when an implementation call ran in parallel with, or after, the accepted submission of this attempt. */
  conflict?: { attemptId: string; kind: 'parallel' | 'later'; tool: string };
  /**
   * Set, and saved BEFORE any receipt of the attempt is acknowledged, once the attempt began reporting. From then on the
   * attempt admits no new implementation work, even after a restart that lost every process-local timeline. A conflict
   * found when sealing is saved in the same checkpoint.
   */
  sealed?: { attemptId: string };
  /**
   * An explicit blocked or unpassed outcome that arrived inside a malformed payload. It is recorded as the outcome, never
   * offered for repair, and the attempt then accepts nothing further. Names and gate IDs only, besides the agent's own reason.
   */
  negative?: { attemptId: string; outcome: 'blocked' | 'unfinished'; gateIds: string[]; fields: string[]; reason?: string };
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
  /**
   * Restrict the child under an owner. The returned release is idempotent. `allow` names the one tool id that stays
   * exposed and permitted (exact identity): the owner-bound submission tool of a structured repair.
   */
  restrict: (child: string, owner?: Omit<ReportOnlyOwner, 'child'>, options?: { allow?: string }) => Promise<() => Promise<void>>;
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
  /**
   * Structured runs only. Returns the native user message id of the prompt that carries this attempt's marker once it
   * exists in the child session, or undefined while it does not. Host-observed native state only. A structured run
   * whose backend lacks it pauses before dispatch, because no submission could ever be authenticated.
   */
  observeDispatchPrompt?: (input: { child: string; parent: string; attemptId: string; signal?: AbortSignal }) => Promise<string | undefined>;
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
  /** Identity of the loaded runtime, recorded in the state of runs STARTED by this runner. Defaults to the executing package. */
  runtime?: () => RuntimeIdentity;
  /** Lets the host's first model-context observation of a child trigger the dispatch-prompt watcher without waiting for its poll. */
  promptSync?: DispatchPromptSync;
  /** Shared with the plugin hooks and the submission gate: format repair decisions and the tool-call timeline. */
  supervisor?: SubmissionSupervisor;
}

export interface SavedCompletion extends CompletionResult {
  sessionId: string | null;
  model: string;
  quotaSelection?: ExecutorSelection;
  /** Report-only corrections consumed before this report was accepted. Absent when none ran. */
  reportCorrections?: number;
}

/**
 * What a paused run is semantically waiting for. Set only when a valid structured approval-required submission was admitted
 * for the unfinished executor task `taskId` at `index`, by attempt `attemptId`. It is never set for a generic blocked or
 * unfinished result, a missing submission, a quota/authentication stop or a native form/permission wait, and it is cleared
 * when the task advances, when a run resumes, and whenever the run pauses for any other reason.
 */
export interface RunWait {
  kind: 'approval';
  attemptId: string;
  index: number;
  taskId: string;
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
  /** The loaded runtime when the run started. Set once for new runs only; absent means it was never recorded. */
  runtime?: RuntimeIdentity;
  /** The current typed-submission authority of a structured run. */
  submissionBinding?: SubmissionBinding;
  attempt?: WorkflowAttempt;
  selection?: ExecutorSelection;
  resolution?: string;
  reason?: string;
  /** The typed semantic wait of a paused run, when it is waiting for an owner decision. See `RunWait`. */
  wait?: RunWait;
  /** The owner decision a resumed task received from the coordinator. Kept until the task really advances; see `ApprovalContext`. */
  approval?: ApprovalContext;
  reportRecovery?: ReportRecovery;
  /** Structured runs only: the durable format-repair bound of the current planner phase or executor task. */
  submissionRepair?: SubmissionRepairRecord;
  usage?: Record<string, number>;
  uncachedUsage?: Record<string, number>;
  tokenLimitsDisabled?: boolean;
  taskStartedAt?: number;
  taskElapsedMs?: number;
  timeWarnings?: Record<string, { message: string; at: string }>;
  timeWarningSaveError?: string;
  watchdogReservationAt?: number;
}
