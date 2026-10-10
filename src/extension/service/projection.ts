import path from 'node:path';
import type { ProjectRecord } from '../../coordinator/types.js';
import { LIMITS, RUN_STATUSES } from '../shared/protocol.js';
import { CONTENT_LIMITS } from '../shared/protocol.js';
import type {
  Blocker, BlockerContentResponse, ContentLimitsUsed, EvidenceView, LimitsView, ListCaps, ModelChoice, ModelsView, ProjectSummary,
  ReportView, RunDetail, RunPhase, RunSummary, SessionUsage, TaskClips, TaskContentResponse, TaskRef, TaskView, UsageView, WireRunStatus,
} from '../shared/protocol.js';
import { reportInfo } from '../../workflow/report-info.js';
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

/** Tracks whether any clipped value in one projection was shortened, and which lists were cut. */
class Budget {
  truncated = false;
  readonly capped: ListCaps = { tasks: false, sessions: false, candidates: false, usageSessions: false };
  /** Clip and say whether this very value was shortened (`text` is null when the value is not a string). */
  info(value: unknown, max: number): { text: string | null; clipped: boolean } {
    const raw = text(value);
    if (raw === undefined) return { text: null, clipped: false };
    const result = clip(raw, max);
    if (result.truncated) this.truncated = true;
    return { text: result.text, clipped: result.truncated };
  }
  clip(value: unknown, max: number): string | null { return this.info(value, max).text; }
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

function blockerOf(run: PublicRun, budget: Budget, limit: number = LIMITS.reason): Blocker | null {
  const status = statusOf(run);
  if (status !== 'paused' && status !== 'failed' && status !== 'reconciliation-required') return null;
  const checkpoint = record(run.checkpoint);
  const recorded = [run.reason, checkpoint?.reason].map(value => text(value)).find(value => value !== undefined && value.trim() !== '');
  const resolution = [run.resolution, checkpoint?.resolution].map(value => text(value)).find(value => value !== undefined && value.trim() !== '');
  const reason = budget.info(recorded, limit);
  const shortResolution = budget.info(resolution, limit);
  return {
    status,
    reason: reason.text ?? NO_REASON,
    reasonRecorded: recorded !== undefined,
    resolution: shortResolution.text,
    reasonClipped: reason.clipped,
    resolutionClipped: shortResolution.clipped,
  };
}

/** Correction state from the checkpoint's `reportRecovery` only, through the shared allowlists. */
function reportOf(run: PublicRun): ReportView | null {
  return reportInfo(record(run.checkpoint)?.reportRecovery);
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
    if (candidates.length >= LIMITS.candidates) { budget.truncated = true; budget.capped.candidates = true; break; }
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
    if (sessions.length >= LIMITS.sessions) { budget.truncated = true; budget.capped.usageSessions = true; continue; }
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
interface Profile { title: number; model: number; text: number; gate: number; detail: number; evidence: number }
const PROFILES: Profile[] = [
  { title: LIMITS.title, model: LIMITS.model, text: LIMITS.text, gate: LIMITS.gate, detail: LIMITS.detail, evidence: LIMITS.evidencePerTask },
  { title: 120, model: LIMITS.model, text: 600, gate: 200, detail: 200, evidence: 10 },
  { title: 80, model: LIMITS.model, text: 200, gate: 80, detail: 100, evidence: 3 },
  { title: 60, model: LIMITS.model, text: 0, gate: 0, detail: 0, evidence: 0 },
];

interface EvidenceResult { items: EvidenceView[]; total: number; countClipped: boolean; textClipped: boolean }

function evidenceOf(value: unknown, budget: Budget, profile: Profile): EvidenceResult {
  const entries = list(value);
  const countClipped = entries.length > profile.evidence;
  if (countClipped) budget.truncated = true;
  let textClipped = false;
  const items = entries.slice(0, profile.evidence).flatMap(entry => {
    const item = record(entry);
    if (!item) return [];
    const gate = budget.info(item.gate, profile.gate);
    const detail = budget.info(item.detail, profile.detail);
    if (gate.clipped || detail.clipped) textClipped = true;
    return [{
      gateId: budget.clip(item.gateId, LIMITS.taskId),
      gate: gate.text,
      passed: typeof item.passed === 'boolean' ? item.passed : null,
      detail: detail.text ?? '',
    }];
  });
  return { items, total: entries.length, countClipped, textClipped };
}

/** What a task's text is built from; read once per projection. */
interface TaskSource {
  checkpoint: Loose | undefined;
  tasks: unknown[];
  results: Loose[];
  index: number | undefined;
  active: boolean;
}

function taskSource(run: PublicRun): TaskSource {
  const checkpoint = record(run.checkpoint);
  return {
    checkpoint,
    tasks: list(checkpoint?.tasks),
    results: list(checkpoint?.results).map(record).filter((item): item is Loose => item !== undefined),
    index: finite(checkpoint?.index),
    active: checkpoint?.phase === 'executor' && statusOf(run) !== 'succeeded',
  };
}

interface TaskBuild { view: TaskView; evidenceTotal: number }

/** One task at its plan position under the given limits; null when that plan entry is not a task record. */
function buildTask(source: TaskSource, position: number, profile: Profile): TaskBuild | null {
  const task = record(source.tasks[position]);
  if (!task) return null;
  const budget = new Budget();
  const id = budget.clipOr(task.id, LIMITS.taskId, `task-${position + 1}`);
  const taskId = text(task.id);
  const result = taskId === undefined ? undefined : source.results.find(item => text(item.taskId) === taskId);
  const state: TaskView['state'] = result ? 'done' : source.active && source.index === position ? 'current' : 'pending';
  const title = budget.info(task.title, profile.title);
  const summary = result ? budget.info(result.summary, profile.text) : { text: null, clipped: false };
  const handoff = result ? budget.info(result.handoff, profile.text) : { text: null, clipped: false };
  const evidence: EvidenceResult = result ? evidenceOf(result.evidence, budget, profile) : { items: [], total: 0, countClipped: false, textClipped: false };
  const model = result ? budget.info(result.model, profile.model)
    : state === 'current' ? budget.info(record(source.checkpoint?.attempt)?.model ?? record(source.checkpoint?.selection)?.model, profile.model)
      : { text: null, clipped: false };
  const clipped: TaskClips = {
    title: title.clipped,
    summary: summary.clipped,
    handoff: handoff.clipped,
    model: model.clipped,
    evidenceCount: evidence.countClipped,
    evidenceText: evidence.textClipped,
  };
  const view: TaskView = {
    index: position,
    id,
    title: title.text ?? '',
    state,
    summary: summary.text,
    handoff: handoff.text,
    evidence: evidence.items,
    sessionId: result ? budget.clip(result.sessionId, LIMITS.identifier)
      : state === 'current' ? budget.clip(source.checkpoint?.child, LIMITS.identifier) : null,
    model: model.text,
    truncated: budget.truncated,
    clipped,
  };
  return { view, evidenceTotal: evidence.total };
}

function tasksOf(run: PublicRun, whole: Budget, profile: Profile): TaskView[] {
  const source = taskSource(run);
  if (source.tasks.length > LIMITS.tasks) { whole.truncated = true; whole.capped.tasks = true; }
  const views: TaskView[] = [];
  for (let position = 0; position < Math.min(source.tasks.length, LIMITS.tasks); position++) {
    const built = buildTask(source, position, profile);
    if (!built) continue;
    if (built.view.truncated) whole.truncated = true;
    views.push(built.view);
  }
  return views;
}

/*
 * On-demand content. The same builders run with larger limits; the limits step down until the response fits
 * `LIMITS.detailBytes`. Even the smallest step keeps more than the first detail profile's text, so a loaded
 * task never shows less than the list did.
 */
const CONTENT_PROFILES: Profile[] = [
  { title: CONTENT_LIMITS.title, model: CONTENT_LIMITS.model, text: CONTENT_LIMITS.text, gate: CONTENT_LIMITS.gate, detail: CONTENT_LIMITS.detail, evidence: CONTENT_LIMITS.evidence },
  { title: 2000, model: 1000, text: 16000, gate: 1000, detail: 4000, evidence: 100 },
  { title: 1000, model: 500, text: 8000, gate: 500, detail: 2000, evidence: 50 },
  { title: 500, model: 400, text: 4000, gate: 300, detail: 1000, evidence: 25 },
  { title: 400, model: 300, text: 2500, gate: 200, detail: 600, evidence: 10 },
];

const usedLimits = (profile: Profile): ContentLimitsUsed => ({ title: profile.title, model: profile.model, text: profile.text, gate: profile.gate, detail: profile.detail, evidence: profile.evidence });

/** Fits the response (envelope included) to `LIMITS.detailBytes`; the envelope is a few hundred bytes at most. */
const fits = (value: unknown): boolean => Buffer.byteLength(JSON.stringify(value)) <= LIMITS.detailBytes;

/** More of one task's recorded text by 0-based plan position; null when there is no task record at that position. */
export function taskContent(run: PublicRun, position: number): Omit<TaskContentResponse, 'fetchedAt'> | null {
  const source = taskSource(run);
  if (!Number.isInteger(position) || position < 0 || position >= source.tasks.length) return null;
  let response: Omit<TaskContentResponse, 'fetchedAt'> | null = null;
  for (const profile of CONTENT_PROFILES) {
    const built = buildTask(source, position, profile);
    if (!built) return null;
    const { view } = built;
    response = {
      runId: clip(String(run.id ?? ''), LIMITS.identifier).text,
      index: position,
      taskId: view.id,
      title: view.title,
      state: view.state,
      summary: view.summary,
      handoff: view.handoff,
      model: view.model,
      evidence: view.evidence,
      evidenceTotal: built.evidenceTotal,
      clipped: view.clipped,
      complete: !Object.values(view.clipped).some(Boolean),
      limits: usedLimits(profile),
    };
    if (fits(response)) break;
  }
  return response;
}

const BLOCKER_LIMITS = [CONTENT_LIMITS.reason, 16000, 8000, 4000, 2500];

/** More of the recorded reason and resolution; null when the run has no blocker. */
export function blockerContent(run: PublicRun): Omit<BlockerContentResponse, 'fetchedAt'> | null {
  let response: Omit<BlockerContentResponse, 'fetchedAt'> | null = null;
  for (const limit of BLOCKER_LIMITS) {
    const blocker = blockerOf(run, new Budget(), limit);
    if (blocker === null) return null;
    response = {
      runId: clip(String(run.id ?? ''), LIMITS.identifier).text,
      status: blocker.status,
      reason: blocker.reason,
      reasonRecorded: blocker.reasonRecorded,
      resolution: blocker.resolution,
      clipped: { reason: blocker.reasonClipped, resolution: blocker.resolutionClipped },
      complete: !blocker.reasonClipped && !blocker.resolutionClipped,
      limit,
    };
    if (fits(response)) break;
  }
  return response;
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
    if (completed.length >= LIMITS.sessions) { budget.truncated = true; budget.capped.sessions = true; break; }
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
      report: reportOf(run),
      models: modelsOf(run, settings, budget),
      usage: usageOf(run, budget),
      limits: limitsOf(run, settings),
      tasks: tasksOf(run, budget, profile),
      sessions: sessionsOf(run, budget),
      review: { baseCommit: budget.clipOr(run.baseCommit, 64, ''), branch: budget.clipOr(run.branch, 200, '') },
      truncated: budget.truncated || profile !== PROFILES[0],
      capped: budget.capped,
    };
    if (Buffer.byteLength(JSON.stringify(detail)) <= LIMITS.detailBytes) break;
  }
  return detail;
}
