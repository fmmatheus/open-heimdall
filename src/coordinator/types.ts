import type { GenericWait } from './pause.js';
import type { RunnerSettings, RunState, RuntimeIdentity, WorkflowAttempt } from '../workflow/types.js';

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
  opencode: { baseUrl: string; passwordEnvironmentVariable: string; authentication?: 'basic' | 'none' | 'openchamber' };
  /** Expected runtime of a new run, fixed at submission. Absent on runs submitted earlier: they keep the live package path and are not pinned. */
  runtime?: RuntimeSnapshotSpecification;
}
export interface RuntimeSnapshotSpecification {
  /** Identity the immutable snapshot must have, with its build computed from the source package at submission. */
  identity: RuntimeIdentity;
  /** Absolute dependency directory the snapshot resolves packages through. Its installed versions are part of the identity. */
  modules: string;
  /**
   * Real directory of each dependency the package resolves, by package name, for a package identified from its installed tree
   * (no lockfile). The snapshot's node_modules then holds exactly these links instead of one symlink to `modules`, which is
   * how it reproduces nested and hoisted layouts. Absent on records admitted with a lockfile or earlier: those keep the single
   * symlink to `modules`.
   */
  links?: Record<string, string>;
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

export type ApprovalState = 'pending' | 'answered' | 'superseded';
export type ApprovalDecision = 'approve' | 'request-changes';
/**
 * What happens after an owner decision: `pending` is recorded and waiting for idle proof and capacity; `queued` is a resume
 * admission waiting to run; `consumed` is an attempt that received the decision; `superseded` is an authorization that the
 * reviewed material outgrew. `none` is a request that has no decision.
 */
export type ApprovalContinuation = 'none' | 'pending' | 'queued' | 'consumed' | 'superseded';
/**
 * Where an owner decision stands, derived from the request and its run: `recorded` is durable and waiting for the scheduler's
 * idle proof, `waiting-for-idle` has not yet been proven idle or has no released capacity, `queued` is a resume waiting for
 * admission, `executing` is admitted and about to dispatch, `consumed` reached an attempt, `superseded` was withdrawn because
 * the reviewed material changed. `none` is a request without a decision.
 */
export type ApprovalProgress = 'none' | 'recorded' | 'waiting-for-idle' | 'queued' | 'executing' | 'consumed' | 'superseded';
/** The reviewed state, always computed by the coordinator and never supplied by an agent or client. */
export interface ApprovalRevision { head: string; digest: string }
/** Agent-authored request content, re-validated with the executor-result contract when it is stored. */
export interface ApprovalRequestContent {
  question: string;
  scope: string;
  completedWork: string;
  verification: string[];
  artifacts: string[];
  onApprove: string[];
  onRequestChanges: string[];
}
/**
 * The acknowledgement of a recorded owner decision. `retried` is false when the decision was recorded by this call and
 * true when an identical retry received the stored acknowledgement. `continuation` and `run` describe the moment of
 * recording; the approval inspection route reports the current state.
 */
export interface ApprovalAck {
  runId: string;
  requestId: string;
  decision: ApprovalDecision;
  recordedAt: number;
  retried: boolean;
  continuation: ApprovalContinuation;
  run: { status: RunStatus; version: number };
}
/** Server-derived identity, the agent's request, the coordinator's revision and the owner's response. */
export interface ApprovalRecord {
  runId: string;
  requestId: string;
  phase: 'planner' | 'executor';
  taskIndex: number;
  taskId: string;
  attemptId: string;
  /** Digest of the submission receipt the request was published from. */
  receiptDigest: string;
  request: ApprovalRequestContent;
  revision: ApprovalRevision;
  state: ApprovalState;
  decision: ApprovalDecision | null;
  feedback: string | null;
  ack: ApprovalAck | null;
  answeredAt: number | null;
  continuation: ApprovalContinuation;
  continuationAt: number | null;
  /** Message id of the resume admission that carries the decision. */
  continuationMessageId: string | null;
  /** Attempt that consumed the decision. */
  consumedAttemptId: string | null;
  supersededAt: number | null;
  supersededReason: string | null;
  createdAt: number;
}
/** Bounded view of the current request for run projections. Text is clipped; the clipping flags say which fields were. */
export interface ApprovalWait {
  kind: 'approval';
  requestId: string;
  state: ApprovalState;
  continuation: ApprovalContinuation;
  progress: ApprovalProgress;
  phase: 'planner' | 'executor';
  taskIndex: number;
  taskId: string;
  taskTitle: string | null;
  attemptId: string;
  question: string;
  scope: string;
  completedWork: string;
  verification: string[];
  artifacts: string[];
  onApprove: string[];
  onRequestChanges: string[];
  revision: ApprovalRevision;
  response: { decision: ApprovalDecision; feedback: string | null; answeredAt: number } | null;
  createdAt: number;
  clipped: Record<'question' | 'scope' | 'completedWork' | 'verification' | 'artifacts' | 'onApprove' | 'onRequestChanges' | 'taskTitle' | 'feedback', boolean>;
}

/**
 * The acknowledgement of a recorded guarded response to a generic pause. `retried` is false when this call recorded the
 * response and true when an identical retry received the stored acknowledgement. `run` describes the moment of recording.
 */
export interface PauseResponseAck {
  runId: string;
  pauseId: string;
  recordedAt: number;
  retried: boolean;
  continuation: 'queued';
  run: { status: RunStatus; version: number };
}
/** Bounded wait summary of a run list entry. A typed request is summarised by identity and state; `run show` has the full view. */
export interface ApprovalWaitSummary {
  kind: 'approval';
  requestId: string;
  state: ApprovalState;
  continuation: ApprovalContinuation;
  taskId: string;
}
export type RunWaitSummary = ApprovalWaitSummary | GenericWait;

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
