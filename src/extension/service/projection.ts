import path from 'node:path';
import type { ProjectRecord } from '../../coordinator/types.js';
import { LIMITS, RUN_STATUSES } from '../shared/protocol.js';
import type {
  Blocker, EvidenceView, LimitsView, ModelChoice, ModelsView, ProjectSummary, RunDetail, RunPhase, RunSummary,
  SessionUsage, TaskRef, TaskView, UsageView, WireRunStatus,
} from '../shared/protocol.js';
import type { PublicRun } from './coordinator.js';

/*
 * Projections read coordinator data defensively: any field may be missing or have an unexpected type and
 * nothing here throws. Status meaning comes only from the coordinator's recorded status, never from session idleness.
 */

type Loose = Record<string, unknown>;

const record = (value: unknown): Loose | undefined => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Loose : undefined);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const finite = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const count = (value: unknown): number => {
  const number = finite(value);
  return number !== undefined && number >= 0 ? number : 0;
};

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface Clipped { text: string; truncated: boolean }

/** Shorten without splitting a surrogate pair; control and bidirectional override characters become spaces. */
function clip(value: string, max: number): Clipped {
  if (value.length <= max) return { text: value.replace(CONTROL, ' '), truncated: false };
  if (max <= 0) return { text: '', truncated: true };
  let end = max - 1;
  const code = value.charCodeAt(end - 1);
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: `${value.slice(0, end).replace(CONTROL, ' ')}…`, truncated: true };
}

/** Tracks whether any clipped value in one projection was shortened. */
class Budget {
  truncated = false;
  clip(value: unknown, max: number): string | null {
    const raw = text(value);
    if (raw === undefined) return null;
    const result = clip(raw, max);
    if (result.truncated) this.truncated = true;
    return result.text;
  }
  clipOr(value: unknown, max: number, fallback: string): string { return this.clip(value, max) ?? fallback; }
}

const collapse = (value: string) => value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();

export const projectName = (directory: string): string => clip(collapse(path.basename(directory || '') || 'project'), LIMITS.projectName).text;

function dateOf(timestamp: unknown): string {
  const value = finite(timestamp);
  const date = value === undefined ? new Date(0) : new Date(value);
  return Number.isNaN(date.getTime()) ? '1970-01-01' : date.toISOString().slice(0, 10);
}

/**
 * First Markdown heading of the feature, else its first non-blank line, whitespace collapsed and capped.
 * Never a bare UUID and never produced by a model.
 */
export function runLabel(feature: unknown, project: { directory?: string } | undefined, createdAt?: unknown): string {
  const fallback = () => clip(`${project?.directory ? projectName(project.directory) : 'project'} run ${dateOf(createdAt)}`, LIMITS.label).text;
  const head = (text(feature) ?? '').slice(0, LIMITS.labelScan).replace(/\r\n?/g, '\n');
  let heading: string | undefined;
  let firstLine: string | undefined;
  let fenced = false;
  for (const line of head.split('\n')) {
    const trimmed = line.trim();
    if (/^(```|~~~)/.test(trimmed)) { fenced = !fenced; continue; }
    if (trimmed === '') continue;
    if (fenced) continue;
    const match = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(trimmed);
    if (match && collapse(match[1]!) !== '') { heading = match[1]; break; }
    firstLine ??= trimmed;
  }
  const chosen = collapse(heading ?? firstLine ?? '');
  if (chosen === '' || UUID.test(chosen)) return fallback();
  return clip(chosen, LIMITS.label).text;
}

export function summarizeProject(project: ProjectRecord): ProjectSummary {
  return {
    id: clip(String(project.id ?? ''), LIMITS.identifier).text,
    name: projectName(String(project.directory ?? '')),
    directory: clip(String(project.directory ?? ''), 1000).text,
    concurrency: count(project.concurrency),
    createdAt: count(project.createdAt),
  };
}

const STATUSES = new Set<string>(RUN_STATUSES);
const statusOf = (run: PublicRun): WireRunStatus => (STATUSES.has(run.status) ? run.status : 'failed');

export function phaseOf(run: PublicRun): RunPhase {
  const status = statusOf(run);
  if (status !== 'running') return status;
  const checkpoint = record(run.checkpoint);
  if (!checkpoint || checkpoint.phase === 'planner' || list(checkpoint.tasks).length === 0) return 'planning';
  return 'executing';
}

function currentTaskOf(run: PublicRun, budget: Budget): TaskRef | null {
  const checkpoint = record(run.checkpoint);
  if (!checkpoint || checkpoint.phase !== 'executor' || statusOf(run) === 'succeeded') return null;
  const tasks = list(checkpoint.tasks);
  const index = finite(checkpoint.index);
  if (index === undefined || !Number.isInteger(index) || index < 0 || index >= tasks.length) return null;
  const task = record(tasks[index]);
  if (!task) return null;
  return { id: budget.clipOr(task.id, LIMITS.taskId, `task-${index + 1}`), title: budget.clipOr(task.title, LIMITS.title, '') };
}

export function summarizeRun(run: PublicRun, project: { directory?: string } | undefined): RunSummary {
  const budget = new Budget();
  const checkpoint = record(run.checkpoint);
  const tasks = list(checkpoint?.tasks);
  return {
    id: clip(String(run.id ?? ''), LIMITS.identifier).text,
    label: runLabel(run.feature, project, run.createdAt),
    projectId: clip(String(run.projectId ?? ''), LIMITS.identifier).text,
    projectName: project?.directory ? projectName(project.directory) : 'unknown project',
    status: statusOf(run),
    phase: phaseOf(run),
    completed: list(checkpoint?.results).length,
    total: tasks.length > 0 ? tasks.length : null,
    currentTask: currentTaskOf(run, budget),
    createdAt: count(run.createdAt),
    updatedAt: count(run.updatedAt),
  };
}

const NO_REASON = 'The coordinator did not record a reason for this status.';

function blockerOf(run: PublicRun, budget: Budget): Blocker | null {
  const status = statusOf(run);
  if (status !== 'paused' && status !== 'failed' && status !== 'reconciliation-required') return null;
  const checkpoint = record(run.checkpoint);
  const recorded = [run.reason, checkpoint?.reason].map(value => text(value)).find(value => value !== undefined && value.trim() !== '');
  const resolution = [run.resolution, checkpoint?.resolution].map(value => text(value)).find(value => value !== undefined && value.trim() !== '');
  return {
    status,
    reason: recorded === undefined ? NO_REASON : budget.clipOr(recorded, LIMITS.reason, NO_REASON),
    reasonRecorded: recorded !== undefined,
    resolution: resolution === undefined ? null : budget.clip(resolution, LIMITS.reason),
  };
}

const choice = (model: unknown, variant: unknown, budget: Budget): ModelChoice => ({
  model: budget.clip(model, LIMITS.model),
  variant: budget.clip(variant, LIMITS.model),
});

function settingsOf(run: PublicRun): Loose {
  return record(run.settings) ?? record(record(run.checkpoint)?.settings) ?? {};
}

function modelsOf(run: PublicRun, settings: Loose, budget: Budget): ModelsView {
  const checkpoint = record(run.checkpoint);
  const selection = record(checkpoint?.selection);
  const attempt = record(checkpoint?.attempt);
  const candidates: ModelsView['candidates'] = [];
  for (const entry of list(settings.executorCandidates)) {
    const candidate = record(entry);
    const model = budget.clip(candidate?.model, LIMITS.model);
    if (!candidate || model === null) continue;
    if (candidates.length >= LIMITS.candidates) { budget.truncated = true; break; }
    candidates.push({ key: budget.clipOr(candidate.key, LIMITS.model, model), model, variant: budget.clip(candidate.variant, LIMITS.model) });
  }
  return {
    planner: choice(settings.plannerModel, settings.plannerVariant, budget),
    executor: choice(settings.executorModel, undefined, budget),
    fallback: choice(settings.executorFallbackModel, undefined, budget),
    candidates,
    selected: selection && text(selection.model) !== undefined
      ? { ...choice(selection.model, selection.variant, budget), checkedAt: budget.clip(selection.checkedAt, 64) }
      : null,
    current: attempt && text(attempt.model) !== undefined ? choice(attempt.model, attempt.variant, budget) : null,
  };
}

function usageOf(run: PublicRun, budget: Budget): UsageView {
  const checkpoint = record(run.checkpoint);
  const reported = record(checkpoint?.usage) ?? {};
  const uncached = record(checkpoint?.uncachedUsage) ?? {};
  const taskSessions = new Set(list(checkpoint?.results).map(result => text(record(result)?.sessionId)).filter((id): id is string => id !== undefined));
  const child = text(checkpoint?.child);
  const phase = checkpoint?.phase;
  const ids = [...new Set([...Object.keys(reported), ...Object.keys(uncached)])];
  const sessions: SessionUsage[] = [];
  let reportedTotal = 0;
  let uncachedTotal = 0;
  for (const id of ids) {
    reportedTotal += count(reported[id]);
    uncachedTotal += count(uncached[id]);
    if (sessions.length >= LIMITS.sessions) { budget.truncated = true; continue; }
    const role: SessionUsage['role'] = taskSessions.has(id) ? 'task'
      : id === child ? (phase === 'planner' ? 'planner' : phase === 'executor' ? 'task' : 'unknown')
        : 'unknown';
    sessions.push({ sessionId: clip(id, LIMITS.identifier).text, role, reported: count(reported[id]), uncached: count(uncached[id]) });
  }
  return { reportedTotal, uncachedTotal, sessions };
}

function limitOf(value: unknown): number | null {
  const number = finite(value);
  return number !== undefined && number >= 0 ? number : null;
}

function limitsOf(run: PublicRun, settings: Loose): LimitsView {
  const checkpoint = record(run.checkpoint);
  return {
    tokenLimitsDisabled: checkpoint?.tokenLimitsDisabled === true || settings.tokenLimitsDisabled === true,
    maxSessionTokens: limitOf(settings.maxSessionTokens),
    maxRunTokens: limitOf(settings.maxRunTokens),
    maxPlannerTokens: limitOf(settings.maxPlannerTokens),
    maxSessionUncachedTokens: limitOf(settings.maxSessionUncachedTokens),
    maxRunUncachedTokens: limitOf(settings.maxRunUncachedTokens),
    maxPlannerUncachedTokens: limitOf(settings.maxPlannerUncachedTokens),
    timeout: { minutes: limitOf(settings.timeoutMinutes), enforcement: 'warning-only' },
  };
}

/** Per-task text limits; detailRun steps down through these until the whole projection fits its byte budget. */
interface Profile { title: number; text: number; gate: number; detail: number; evidence: number }
const PROFILES: Profile[] = [
  { title: LIMITS.title, text: LIMITS.text, gate: LIMITS.gate, detail: LIMITS.detail, evidence: LIMITS.evidencePerTask },
  { title: 120, text: 600, gate: 200, detail: 200, evidence: 10 },
  { title: 80, text: 200, gate: 80, detail: 100, evidence: 3 },
  { title: 60, text: 0, gate: 0, detail: 0, evidence: 0 },
];

function evidenceOf(value: unknown, budget: Budget, profile: Profile): EvidenceView[] {
  const items = list(value);
  if (items.length > profile.evidence) budget.truncated = true;
  return items.slice(0, profile.evidence).flatMap(entry => {
    const item = record(entry);
    if (!item) return [];
    return [{
      gateId: budget.clip(item.gateId, LIMITS.taskId),
      gate: budget.clip(item.gate, profile.gate),
      passed: typeof item.passed === 'boolean' ? item.passed : null,
      detail: budget.clipOr(item.detail, profile.detail, ''),
    }];
  });
}

function tasksOf(run: PublicRun, whole: Budget, profile: Profile): TaskView[] {
  const checkpoint = record(run.checkpoint);
  const tasks = list(checkpoint?.tasks);
  const results = list(checkpoint?.results).map(record).filter((item): item is Loose => item !== undefined);
  const index = finite(checkpoint?.index);
  const active = checkpoint?.phase === 'executor' && statusOf(run) !== 'succeeded';
  if (tasks.length > LIMITS.tasks) whole.truncated = true;
  return tasks.slice(0, LIMITS.tasks).flatMap((entry, position) => {
    const task = record(entry);
    if (!task) return [];
    const budget = new Budget();
    const id = budget.clipOr(task.id, LIMITS.taskId, `task-${position + 1}`);
    const taskId = text(task.id);
    const result = taskId === undefined ? undefined : results.find(item => text(item.taskId) === taskId);
    const state: TaskView['state'] = result ? 'done' : active && index === position ? 'current' : 'pending';
    const view: TaskView = {
      id,
      title: budget.clipOr(task.title, profile.title, ''),
      state,
      summary: result ? budget.clip(result.summary, profile.text) : null,
      handoff: result ? budget.clip(result.handoff, profile.text) : null,
      evidence: result ? evidenceOf(result.evidence, budget, profile) : [],
      sessionId: result ? budget.clip(result.sessionId, LIMITS.identifier)
        : state === 'current' ? budget.clip(checkpoint?.child, LIMITS.identifier) : null,
      model: result ? budget.clip(result.model, LIMITS.model)
        : state === 'current' ? budget.clip(record(checkpoint?.attempt)?.model ?? record(checkpoint?.selection)?.model, LIMITS.model) : null,
      truncated: budget.truncated,
    };
    if (budget.truncated) whole.truncated = true;
    return [view];
  });
}

function sessionsOf(run: PublicRun, budget: Budget): RunDetail['sessions'] {
  const checkpoint = record(run.checkpoint);
  const seen = new Set<string>();
  const completed: RunDetail['sessions']['completed'] = [];
  for (const entry of list(checkpoint?.results)) {
    const result = record(entry);
    const id = text(result?.sessionId);
    if (!result || id === undefined || seen.has(id)) continue;
    seen.add(id);
    if (completed.length >= LIMITS.sessions) { budget.truncated = true; break; }
    completed.push({ id: clip(id, LIMITS.identifier).text, taskId: budget.clip(result.taskId, LIMITS.taskId) });
  }
  return {
    parent: budget.clip(run.parentSessionId, LIMITS.identifier),
    current: budget.clip(checkpoint?.child, LIMITS.identifier),
    completed,
  };
}

/**
 * Detail projection. Deliberately omits the feature body, worktreePath, owner tokens, prompt message ids,
 * binding data and the raw checkpoint.
 */
export function detailRun(run: PublicRun, project: { directory?: string } | undefined): RunDetail {
  const settings = settingsOf(run);
  const summary = summarizeRun(run, project);
  let detail!: RunDetail;
  for (const profile of PROFILES) {
    const budget = new Budget();
    detail = {
      ...summary,
      blocker: blockerOf(run, budget),
      models: modelsOf(run, settings, budget),
      usage: usageOf(run, budget),
      limits: limitsOf(run, settings),
      tasks: tasksOf(run, budget, profile),
      sessions: sessionsOf(run, budget),
      review: { baseCommit: budget.clipOr(run.baseCommit, 64, ''), branch: budget.clipOr(run.branch, 200, '') },
      truncated: budget.truncated || profile !== PROFILES[0],
    };
    if (Buffer.byteLength(JSON.stringify(detail)) <= LIMITS.detailBytes) break;
  }
  return detail;
}
