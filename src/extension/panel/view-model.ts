/**
 * Pure presentation logic for the panel: turns store state and wire DTOs into labels, tones and rows.
 * No DOM and no SDK runtime imports, so it is unit-testable in Node. Text that came from a run (labels,
 * tasks, summaries, evidence, reasons, model names) passes through unchanged; main.ts renders it with
 * textContent only. Nothing here infers a result: a missing value is reported as missing.
 */
import type { PanelState } from './store.js';
import { RUN_STATUSES } from '../shared/protocol.js';
import type {
  Blocker,
  EvidenceView,
  LimitsView,
  ModelChoice,
  ModelsView,
  RunDetail,
  RunSummary,
  TaskView,
  UsageView,
  WireRunStatus,
} from '../shared/protocol.js';

/** Same vocabulary as the SDK badge tones; redeclared so this module stays free of SDK imports. */
export type Tone = 'neutral' | 'primary' | 'success' | 'warning' | 'error' | 'info';

export interface Badge { label: string; tone: Tone }

export const NO_REASON_TEXT = 'No reason was recorded';
export const NOT_RECORDED = 'Not recorded';

/** Select value standing for "no filter"; the store uses null. */
export const ALL_FILTER = '__all__';

export function statusBadge(run: Pick<RunSummary, 'status' | 'phase'>): Badge {
  switch (run.status) {
    case 'queued': return { label: 'Queued', tone: 'neutral' };
    case 'preparing': return { label: 'Preparing', tone: 'info' };
    case 'running': return { label: run.phase === 'planning' ? 'Planning' : 'Executing', tone: 'primary' };
    case 'paused': return { label: 'Paused', tone: 'warning' };
    case 'succeeded': return { label: 'Succeeded', tone: 'success' };
    case 'failed': return { label: 'Failed', tone: 'error' };
    case 'reconciliation-required': return { label: 'Needs reconciliation', tone: 'warning' };
  }
}

/** One line describing what the run is doing, from saved state only. */
export function phaseText(run: Pick<RunSummary, 'status' | 'phase' | 'currentTask'>): string {
  const task = run.currentTask ? `${run.currentTask.id}: ${run.currentTask.title}` : null;
  switch (run.phase) {
    case 'queued': return 'Queued – waiting for capacity';
    case 'preparing': return 'Preparing worktree';
    case 'planning': return 'Planning – no task list yet';
    case 'executing': return task ? `Executing ${task}` : 'Executing';
    case 'paused': return task ? `Paused at ${task}` : 'Paused';
    case 'succeeded': return 'Succeeded';
    case 'failed': return task ? `Failed at ${task}` : 'Failed';
    case 'reconciliation-required': return 'Reconciliation required – inspect the retained run before it is released';
  }
}

export interface ProgressInfo {
  /** 0-100, or null when there is nothing to measure. */
  value: number | null;
  label: string;
  tone: Tone;
}

export function progressInfo(run: Pick<RunSummary, 'status' | 'phase' | 'completed' | 'total'>): ProgressInfo {
  if (run.status === 'queued') return { value: null, label: 'Queued – waiting for capacity', tone: 'neutral' };
  if (run.status === 'preparing') return { value: null, label: 'Preparing worktree', tone: 'info' };
  if (run.total === null) {
    return run.phase === 'planning'
      ? { value: null, label: 'Planning – no task list yet', tone: 'primary' }
      : { value: null, label: 'No task list was recorded', tone: statusBadge({ status: run.status, phase: run.phase }).tone };
  }
  const value = run.total > 0 ? Math.max(0, Math.min(100, Math.round((run.completed / run.total) * 100))) : 0;
  return { value, label: `${run.completed} of ${run.total} tasks complete`, tone: statusBadge({ status: run.status, phase: run.phase }).tone };
}

/** Compact fraction for list rows, or an empty string when there is no plan. */
export function progressFraction(run: Pick<RunSummary, 'completed' | 'total'>): string {
  return run.total === null ? '' : `${run.completed}/${run.total}`;
}

export function formatCount(value: number): string {
  if (!Number.isFinite(value)) return NOT_RECORDED;
  return String(Math.trunc(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** UTC so the output does not depend on the viewer's locale or time zone. */
export function formatTime(ms: number): string {
  if (!Number.isFinite(ms)) return 'unknown time';
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function formatAge(ms: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

export interface ListRow {
  id: string;
  title: string;
  subtitle: string;
  meta: string;
  badge: Badge;
}

export function runRows(runs: readonly RunSummary[]): ListRow[] {
  return runs.map(run => ({
    id: run.id,
    title: run.label,
    subtitle: `${run.projectName} · ${phaseText(run)}`,
    meta: progressFraction(run),
    badge: statusBadge(run),
  }));
}

export interface FilterOption { id: string; label: string }

export function projectFilterOptions(projects: ReadonlyArray<{ id: string; name: string }>): FilterOption[] {
  return [{ id: ALL_FILTER, label: 'All projects' }, ...projects.map(project => ({ id: project.id, label: project.name }))];
}

export const STATUS_FILTER_LABELS: Record<WireRunStatus, string> = {
  queued: 'Queued',
  preparing: 'Preparing',
  running: 'Running',
  paused: 'Paused',
  succeeded: 'Succeeded',
  failed: 'Failed',
  'reconciliation-required': 'Needs reconciliation',
};

export function statusFilterOptions(): FilterOption[] {
  return [{ id: ALL_FILTER, label: 'All statuses' }, ...RUN_STATUSES.map(status => ({ id: status, label: STATUS_FILTER_LABELS[status] }))];
}

// ----- detail -----

export function modelChoiceText(choice: ModelChoice | null): string {
  if (choice === null || choice.model === null || choice.model === '') return NOT_RECORDED;
  return choice.variant ? `${choice.model} (${choice.variant})` : choice.model;
}

export interface LabeledRow { label: string; value: string }

export function modelRows(models: ModelsView): LabeledRow[] {
  const rows: LabeledRow[] = [
    { label: 'Planner (configured)', value: modelChoiceText(models.planner) },
    { label: 'Executor (configured)', value: modelChoiceText(models.executor) },
    { label: 'Executor fallback (configured)', value: modelChoiceText(models.fallback) },
  ];
  if (models.selected) {
    const checked = models.selected.checkedAt ? ` · checked ${models.selected.checkedAt}` : '';
    rows.push({ label: 'Selected by quota check', value: `${modelChoiceText(models.selected)}${checked}` });
  }
  rows.push({ label: 'Current attempt', value: models.current ? modelChoiceText(models.current) : 'No attempt recorded' });
  for (const candidate of models.candidates) {
    rows.push({ label: 'Candidate', value: modelChoiceText({ model: candidate.model, variant: candidate.variant }) });
  }
  return rows;
}

export interface UsageInfo {
  reported: string;
  uncached: string;
  /** Reminder that counts are cumulative checkpoint totals, not a live meter. */
  note: string;
  sessions: Array<{ label: string; value: string }>;
}

const ROLE_LABELS = { planner: 'Planner session', task: 'Task session', unknown: 'Session' } as const;

export function usageInfo(usage: UsageView): UsageInfo {
  return {
    reported: `${formatCount(usage.reportedTotal)} reported tokens`,
    uncached: `${formatCount(usage.uncachedTotal)} uncached reported tokens`,
    note: 'Totals recorded in saved checkpoints; not a live meter.',
    sessions: usage.sessions.map(session => ({
      label: `${ROLE_LABELS[session.role]} ${session.sessionId}`,
      value: `${formatCount(session.reported)} reported · ${formatCount(session.uncached)} uncached`,
    })),
  };
}

export function limitRows(limits: LimitsView): LabeledRow[] {
  const token = (value: number | null): string => {
    if (limits.tokenLimitsDisabled) return 'Disabled';
    return value === null ? 'Unlimited' : `${formatCount(value)} reported tokens`;
  };
  const rows: LabeledRow[] = [
    { label: 'Per-session tokens', value: token(limits.maxSessionTokens) },
    { label: 'Run tokens', value: token(limits.maxRunTokens) },
    { label: 'Planner tokens', value: token(limits.maxPlannerTokens) },
    { label: 'Per-session uncached tokens', value: token(limits.maxSessionUncachedTokens) },
    { label: 'Run uncached tokens', value: token(limits.maxRunUncachedTokens) },
    { label: 'Planner uncached tokens', value: token(limits.maxPlannerUncachedTokens) },
  ];
  const minutes = limits.timeout.minutes;
  rows.push({
    label: 'Timeout',
    value: minutes === null ? 'None configured' : `${formatCount(minutes)} min · warning only, does not stop the run`,
  });
  return rows;
}

export interface BlockerInfo {
  title: string;
  tone: Tone;
  /** The recorded reason, verbatim, or NO_REASON_TEXT. */
  reason: string;
  resolution: string | null;
}

const BLOCKER_TITLES: Partial<Record<WireRunStatus, string>> = {
  paused: 'Run is paused',
  failed: 'Run failed',
  'reconciliation-required': 'Reconciliation required',
};

export function blockerInfo(blocker: Blocker | null): BlockerInfo | null {
  if (blocker === null) return null;
  return {
    title: BLOCKER_TITLES[blocker.status] ?? 'Run is blocked',
    tone: blocker.status === 'failed' ? 'error' : 'warning',
    reason: blocker.reasonRecorded && blocker.reason !== '' ? blocker.reason : NO_REASON_TEXT,
    resolution: blocker.resolution,
  };
}

export type EvidenceOutcome = 'passed' | 'failed' | 'unknown';

export interface EvidenceRow {
  outcome: EvidenceOutcome;
  badge: Badge;
  gateId: string;
  gate: string;
  detail: string;
}

/** Only an explicit `true` is a pass; a missing flag is unknown, never a pass. */
export function evidenceRow(evidence: EvidenceView): EvidenceRow {
  const outcome: EvidenceOutcome = evidence.passed === true ? 'passed' : evidence.passed === false ? 'failed' : 'unknown';
  const badge: Badge = outcome === 'passed' ? { label: 'Passed', tone: 'success' }
    : outcome === 'failed' ? { label: 'Failed', tone: 'error' }
      : { label: 'Unknown', tone: 'neutral' };
  return { outcome, badge, gateId: evidence.gateId ?? '', gate: evidence.gate ?? '', detail: evidence.detail };
}

export interface TaskRow {
  id: string;
  title: string;
  badge: Badge;
  summary: string | null;
  handoff: string | null;
  evidence: EvidenceRow[];
  model: string | null;
  truncated: boolean;
}

const TASK_BADGES: Record<TaskView['state'], Badge> = {
  done: { label: 'Done', tone: 'success' },
  current: { label: 'Current', tone: 'primary' },
  pending: { label: 'Pending', tone: 'neutral' },
};

export function taskRows(tasks: readonly TaskView[]): TaskRow[] {
  return tasks.map(task => ({
    id: task.id,
    title: task.title,
    badge: TASK_BADGES[task.state],
    summary: task.summary,
    handoff: task.handoff,
    evidence: task.evidence.map(evidenceRow),
    model: task.model,
    truncated: task.truncated,
  }));
}

export function currentTaskText(detail: Pick<RunDetail, 'status' | 'phase' | 'currentTask'>): string {
  if (detail.currentTask) return `${detail.currentTask.id}: ${detail.currentTask.title}`;
  switch (detail.phase) {
    case 'queued':
    case 'preparing': return 'No task yet';
    case 'planning': return 'No task yet – the plan is not ready';
    case 'succeeded': return 'All tasks finished';
    default: return 'No current task recorded';
  }
}

export const DETAIL_TABS = ['overview', 'usage', 'tasks'] as const;
export type DetailTabId = typeof DETAIL_TABS[number];

export function detailTabs(detail: Pick<RunDetail, 'tasks'> | null): Array<{ id: DetailTabId; label: string; count?: number }> {
  return [
    { id: 'overview', label: 'Overview' },
    { id: 'usage', label: 'Usage & limits' },
    { id: 'tasks', label: 'Tasks', count: detail?.tasks.length ?? 0 },
  ];
}

export function truncationNotice(detail: Pick<RunDetail, 'truncated'>): string | null {
  return detail.truncated ? 'Some text or lists in this run were shortened to fit. Open the saved run state for the full record.' : null;
}

// ----- connection, stale and empty states -----

export interface ActionInfo { label: string; kind: 'retry' | 'clear-filters' }

export interface BannerInfo {
  tone: 'info' | 'warning' | 'error';
  title: string;
  body: string;
  action: ActionInfo | null;
}

export function lastUpdatedText(lastSuccessAt: number | null, now: number): string {
  return lastSuccessAt === null
    ? 'No data has been loaded yet.'
    : `Last updated ${formatAge(lastSuccessAt, now)} (${formatTime(lastSuccessAt)}).`;
}

type StateForBanner = Pick<PanelState, 'connection' | 'message' | 'hint' | 'stale' | 'lastSuccessAt'>;

export function bannerInfo(state: StateForBanner, now: number): BannerInfo | null {
  const updated = lastUpdatedText(state.lastSuccessAt, now);
  switch (state.connection) {
    case 'connecting':
      return { tone: 'info', title: 'Connecting to Heimdall…', body: 'Waiting for the first response from the Heimdall extension service.', action: null };
    case 'offline':
    case 'service-unavailable': {
      const base = state.message ?? 'Heimdall is unreachable.';
      const hint = state.hint ? ` ${state.hint}` : '';
      return {
        tone: state.connection === 'offline' ? 'warning' : 'error',
        title: state.stale ? `${base} Showing stale data.` : base,
        body: `${updated}${hint}`,
        action: { label: 'Retry', kind: 'retry' },
      };
    }
    case 'online':
      return state.stale
        ? { tone: 'warning', title: 'Data may be out of date', body: `The last refresh did not complete in time. ${updated}`, action: { label: 'Retry', kind: 'retry' } }
        : null;
  }
}

export interface EmptyInfo { title: string; body: string; action: ActionInfo | null }

type StateForEmpty = Pick<PanelState, 'connection' | 'message' | 'hint' | 'runs' | 'filters' | 'lastSuccessAt'>;

/** What to show in place of the run list when it has nothing to list; null when there are runs. */
export function emptyInfo(state: StateForEmpty): EmptyInfo | null {
  if (state.runs.length > 0) return null;
  if (state.connection === 'connecting') {
    return { title: 'Loading runs…', body: 'Waiting for the Heimdall extension service.', action: null };
  }
  if (state.lastSuccessAt === null && (state.connection === 'offline' || state.connection === 'service-unavailable')) {
    const hint = state.hint ? ` ${state.hint}` : '';
    return {
      title: state.connection === 'offline' ? 'No coordinator connection' : 'Heimdall service unavailable',
      body: `${state.message ?? 'Heimdall is unreachable.'}${hint}`,
      action: { label: 'Retry', kind: 'retry' },
    };
  }
  if (state.filters.projectId !== null || state.filters.status !== null) {
    return {
      title: 'No runs match these filters',
      body: 'Clear the project or status filter to see every run.',
      action: { label: 'Clear filters', kind: 'clear-filters' },
    };
  }
  return { title: 'No Heimdall runs yet', body: 'Runs submitted to the Heimdall coordinator appear here.', action: null };
}

export function listNotice(state: Pick<PanelState, 'runs' | 'runsTotal' | 'runsTruncated'>): string | null {
  return state.runsTruncated ? `Showing the ${state.runs.length} most recently updated of ${state.runsTotal} runs.` : null;
}

type StateForDetail = Pick<PanelState, 'selectedRunId' | 'detail' | 'detailError'>;

/** Message for the detail pane while there is no detail to draw; null once it can be drawn. */
export function detailPlaceholder(state: StateForDetail): string | null {
  if (state.selectedRunId === null) return 'Select a run to see its details.';
  if (state.detail !== null && state.detail.id === state.selectedRunId) return null;
  return state.detailError ?? 'Loading run…';
}
