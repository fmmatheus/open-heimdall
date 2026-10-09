/**
 * Wire types shared by the guest service and the panel. Pure types and constants: no Node imports, so the
 * panel bundle can use it. Every text field here is already truncated by the service; the panel still renders
 * it as text only.
 */

export const LIMITS = {
  label: 120,
  projectName: 120,
  taskId: 120,
  title: 200,
  text: 2000,
  gate: 600,
  detail: 600,
  reason: 2000,
  identifier: 128,
  model: 200,
  evidencePerTask: 50,
  tasks: 100,
  sessions: 100,
  candidates: 20,
  runsPerList: 200,
  changedRunIds: 200,
  /** Safety margin under the service's 200000 byte response cap for list responses. */
  listBytes: 180000,
  /** A run detail is shrunk, profile by profile, until it fits this many bytes (response cap is 200000). */
  detailBytes: 150000,
  /** Scan only the head of a feature when deriving its label; the body can be 128 KiB. */
  labelScan: 16384,
} as const;

export const RUN_STATUSES = ['queued', 'preparing', 'running', 'paused', 'succeeded', 'failed', 'reconciliation-required'] as const;
export type WireRunStatus = typeof RUN_STATUSES[number];

export type RunPhase = 'queued' | 'preparing' | 'planning' | 'executing' | 'paused' | 'succeeded' | 'failed' | 'reconciliation-required';

export interface ProjectSummary {
  id: string;
  name: string;
  directory: string;
  concurrency: number;
  createdAt: number;
}

export interface TaskRef { id: string; title: string }

export interface RunSummary {
  id: string;
  label: string;
  projectId: string;
  projectName: string;
  status: WireRunStatus;
  phase: RunPhase;
  completed: number;
  /** Null until a plan exists. */
  total: number | null;
  currentTask: TaskRef | null;
  createdAt: number;
  updatedAt: number;
}

export interface Blocker {
  status: WireRunStatus;
  /** The recorded reason, or a fixed sentence saying none was recorded; never invented. */
  reason: string;
  reasonRecorded: boolean;
  resolution: string | null;
}

export interface ModelChoice { model: string | null; variant: string | null }

export interface ModelsView {
  planner: ModelChoice;
  executor: ModelChoice;
  fallback: ModelChoice;
  candidates: Array<{ key: string; model: string; variant: string | null }>;
  selected: (ModelChoice & { checkedAt: string | null }) | null;
  /** Model of the attempt currently recorded in the checkpoint. */
  current: ModelChoice | null;
}

export interface SessionUsage {
  sessionId: string;
  role: 'planner' | 'task' | 'unknown';
  reported: number;
  uncached: number;
}

export interface UsageView {
  /** Cumulative counts recorded in the checkpoint; not live precision. */
  reportedTotal: number;
  uncachedTotal: number;
  sessions: SessionUsage[];
}

export interface LimitsView {
  tokenLimitsDisabled: boolean;
  maxSessionTokens: number | null;
  maxRunTokens: number | null;
  maxPlannerTokens: number | null;
  maxSessionUncachedTokens: number | null;
  maxRunUncachedTokens: number | null;
  maxPlannerUncachedTokens: number | null;
  timeout: { minutes: number | null; enforcement: 'warning-only' };
}

export interface EvidenceView {
  gateId: string | null;
  gate: string | null;
  passed: boolean | null;
  detail: string;
}

export interface TaskView {
  id: string;
  title: string;
  state: 'done' | 'current' | 'pending';
  summary: string | null;
  handoff: string | null;
  evidence: EvidenceView[];
  sessionId: string | null;
  model: string | null;
  truncated: boolean;
}

export interface SessionRef { id: string; taskId: string | null }

export interface SessionsView {
  parent: string | null;
  current: string | null;
  completed: SessionRef[];
}

export interface RunDetail extends RunSummary {
  blocker: Blocker | null;
  models: ModelsView;
  usage: UsageView;
  limits: LimitsView;
  tasks: TaskView[];
  sessions: SessionsView;
  review: { baseCommit: string; branch: string };
  /** True when any text, list or task in this projection was shortened. */
  truncated: boolean;
}

export interface ProjectsResponse { projects: ProjectSummary[]; fetchedAt: string }
export interface RunsResponse { runs: RunSummary[]; total: number; truncated: boolean; fetchedAt: string }
export interface RunResponse { run: RunDetail; fetchedAt: string }

export interface ChangeFeed {
  /** `<generation>:<sequence>`; opaque to the panel. */
  cursor: string;
  changedRunIds: string[];
  projectsChanged: boolean;
  /** The panel must reload its lists: unknown cursor, service restart, or too many changes to list. */
  resync: boolean;
  /** The service stopped paging coordinator events early; poll again soon. */
  more: boolean;
  fetchedAt: string;
}

export interface ErrorBody { error: { kind: string; message: string } }
