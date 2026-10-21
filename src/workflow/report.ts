import { authExpired } from '../policy/quota.js';
import type { ReportDiagnostic, ReportRecovery, WorkflowResult, WorkflowTask } from './types.js';

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
const nonempty = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
const GATE_LIMIT = 50;

import { REPORT_FIELDS } from './report-info.js';
export { REPORT_FIELDS };

const gateNumber = (id: unknown): number => {
  const match = typeof id === 'string' ? /^G([1-9][0-9]*)$/.exec(id) : null;
  return match ? Number(match[1]) : 0;
};
const gateList = (numbers: Iterable<number>): string[] => [...new Set(numbers)].sort((a, b) => a - b).slice(0, GATE_LIMIT).map(n => 'G' + n);

/** A thrown error that carries no reply: native, transport, auth or quota. Never repairable. */
export function classifyError(error: unknown): ReportDiagnostic {
  const message = error instanceof Error ? error.message : String(error);
  if (authExpired(message) || /quota.{0,30}unavailab|unavailab.{0,30}quota|authentication unavailable|credential refresh/i.test(message)) return { code: 'auth_or_quota' };
  if (/output truncated|Invalid child response/i.test(message)) return { code: 'ambiguous_output' };
  return { code: 'native_failure' };
}

/**
 * Classifies an already-parsed reply that did not pass validation. Semantic signals win over envelope
 * omissions so a refusal, wrong identity or unresolved gate is never offered for format repair.
 * Pure: the reply is only read, and missing proof is never turned into passed proof.
 */
export function classifyResult(result: WorkflowResult, task: WorkflowTask): ReportDiagnostic {
  if (result.status === 'blocked') return { code: 'agent_blocked' };
  if (result.status !== 'completed') return { code: 'ambiguous_output' };
  if (result.taskId !== undefined && result.taskId !== task.id) return { code: 'identity_mismatch' };
  const evidence: unknown = result.evidence;
  if (evidence !== undefined && !Array.isArray(evidence)) return { code: 'ambiguous_output' };
  const entries: unknown[] = evidence ?? [];
  if (!entries.every(isRecord)) return { code: 'ambiguous_output' };
  const records = entries as Record<string, unknown>[];
  const unfinished = records.filter(e => e.passed !== undefined && e.passed !== true);
  if (unfinished.length) {
    const gateIds = gateList(unfinished.map(e => gateNumber(e.gateId)).filter(n => n >= 1 && n <= task.dod.length));
    return { code: 'unfinished_work', ...(gateIds.length ? { gateIds } : {}) };
  }
  const seen = new Set<number>();
  for (const entry of records) {
    if (entry.gateId === undefined) continue;
    const n = gateNumber(entry.gateId);
    if (n < 1 || n > task.dod.length || seen.has(n)) return { code: 'ambiguous_output' };
    seen.add(n);
  }
  const missing = new Set<string>();
  if (result.taskId === undefined) missing.add('taskId');
  if (!nonempty(result.summary)) missing.add('summary');
  if (!nonempty(result.handoff)) missing.add('handoff');
  if (evidence === undefined) missing.add('evidence');
  for (const entry of records) {
    if (entry.gateId === undefined) missing.add('gateId');
    if (!nonempty(entry.detail)) missing.add('detail');
    if (entry.passed === undefined) missing.add('passed');
  }
  const gateIds = gateList(task.dod.map((_, i) => i + 1).filter(n => !seen.has(n)));
  const missingFields = REPORT_FIELDS.filter(field => missing.has(field));
  if (!missingFields.length && !gateIds.length) return { code: 'ambiguous_output' };
  return { code: 'report_format', ...(missingFields.length ? { missingFields: [...missingFields] } : {}), ...(gateIds.length ? { gateIds } : {}) };
}

/** Bounded text: collapses whitespace and cuts at a fixed length. */
export const bounded = (text: string, limit: number): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? flat.slice(0, limit - 1) + '…' : flat;
};
const gates = (ids: string[] | undefined) => ids?.length ? ids.slice(0, 10).join(', ') + (ids.length > 10 ? ' (+' + (ids.length - 10) + ' more)' : '') : '';

/**
 * Pause reason for a structured run whose typed submission is absent or cannot be applied. `subject` is a task id or
 * "the plan". Neither text invites a format repair: the final chat text is never a result in a structured run.
 */
export function submissionPauseReason(code: 'submission_missing' | 'submission_unconfirmed', subject: string, detail = ''): string {
  if (code === 'submission_missing') {
    // For a missing submission `detail` is the bounded reason a denied call's native origin could not be verified.
    const unverified = detail ? 'A submission call was denied because its native origin could not be verified against the current dispatch (' + bounded(detail, 60) + '); its payload was not evaluated. ' : '';
    return 'No valid submission was recorded for ' + subject + ': the child ended without a successful call to its submission tool (refusal, omission, a limit, or a rejected call). ' + unverified
      + 'Its final chat text is not a result and was not parsed. Inspect the child session, then resume with guidance to submit the result through the tool; nothing was advanced.';
  }
  return 'A submission was recorded for ' + subject + ' but the child\'s successful stop could not be confirmed' + (detail ? ' (' + bounded(detail, 300) + ')' : '') + ', so it was not applied. '
    + 'Reconcile the child session (it must be idle with an empty inbox and a final stop); the recorded submission is kept and a resume applies it without redoing the work.';
}

const SUBJECT_ACTION = ' Inspect the child session, then resume with guidance; nothing was advanced and no repair is repeated automatically.';

/**
 * Pause reason for a typed submission whose bounded format repair ended, or whose evidence can no longer be trusted.
 * `subject` is a task id or "the plan"; `detail` is a bounded host-owned reason, never submitted content.
 */
export function submissionRepairPauseReason(code: 'submission_repair_exhausted' | 'submission_refused' | 'submission_unsupported' | 'conflicting_work', subject: string, detail = ''): string {
  const suffix = detail ? ' (' + bounded(detail, 300) + ')' : '';
  switch (code) {
    case 'submission_repair_exhausted':
      return 'The submission for ' + subject + ' was rejected as malformed more often than the bounded repair allows (initial plus two repairs)' + suffix + '.' + SUBJECT_ACTION;
    case 'submission_unsupported':
      return 'The submission for ' + subject + ' was rejected as malformed, but report-only repair cannot be enforced for this model or host' + suffix + ', so no repair was offered.' + SUBJECT_ACTION;
    case 'conflicting_work':
      return 'Implementation work ran alongside or after the accepted submission for ' + subject + suffix + ', so the evidence may have changed after its receipt and was not admitted.' + SUBJECT_ACTION;
    default:
      return 'The submission for ' + subject + ' was rejected as malformed and no repair could be offered' + suffix + '.' + SUBJECT_ACTION;
  }
}

/**
 * Pause reason for a rejected executor report. Contains only the category, field names, gate IDs and the
 * agent's own blocked reason or the provider error text (`detail`), never any part of a reply.
 */
export function reportPauseReason(diagnostic: ReportDiagnostic, task: WorkflowTask, detail = ''): string {
  const fields = diagnostic.missingFields?.join(', ');
  const ids = gates(diagnostic.gateIds);
  const stillMissing = fields || ids ? ', still missing ' + [fields && 'fields ' + fields, ids && 'gate entries ' + ids].filter(Boolean).join(' and ') : '';
  const formatOnly = ' Resume with guidance to restate the results that already exist in the final completion contract: no new work, tests or file changes.';
  switch (diagnostic.code) {
    case 'report_format':
      return 'Invalid completion report for ' + task.id + ': the reply was valid completion intent but omitted ' + [fields && 'fields ' + fields, ids && 'gate entries ' + ids].filter(Boolean).join(' and ') + '.' + formatOnly;
    case 'ambiguous_output':
      return 'Invalid completion report for ' + task.id + ': the reply was truncated, not exactly one JSON object, or had invalid or duplicate gate IDs.' + formatOnly;
    case 'unfinished_work':
      return 'Unfinished work for ' + task.id + ': ' + (ids ? 'gates ' + ids + ' were reported unresolved' : 'evidence was reported unresolved') + '. Resolve the work or the owner decision before resuming.';
    case 'agent_blocked':
      return 'Unfinished work for ' + task.id + ': the agent reported blocked: ' + (detail ? bounded(detail, 2000) : 'no reason given');
    case 'approval_required':
      // `detail` is the host-built reason 'Approval required for <taskId>: <question>', already bounded.
      return bounded(detail || 'Approval required for ' + task.id, 2000);
    case 'identity_mismatch':
      return 'Wrong task or session identity: the reply did not identify ' + task.id + '. Check the child session and branch before resuming.';
    case 'auth_or_quota':
      return bounded(detail || 'Native/provider failure: authentication or quota unavailable.', 500);
    case 'correction_exhausted':
      return 'Invalid completion report for ' + task.id + ': automatic report correction is exhausted' + stillMissing + '.' + formatOnly;
    case 'correction_unsupported':
      return 'Invalid completion report for ' + task.id + ': report-only correction is unsupported here' + (detail ? ' (' + bounded(detail, 300) + ')' : '') + stillMissing + '.' + formatOnly;
    case 'correction_ambiguous':
      return 'Invalid completion report for ' + task.id + ': a previous correction may already have run, so none is repeated automatically.' + formatOnly;
    case 'submission_missing':
    case 'submission_unconfirmed':
      return submissionPauseReason(diagnostic.code, task.id, detail);
    case 'submission_repair_exhausted':
    case 'submission_refused':
    case 'submission_unsupported':
    case 'conflicting_work':
      return detail || submissionRepairPauseReason(diagnostic.code, task.id);
    default:
      return 'Native/provider failure: ' + bounded(detail || 'the executor did not return a reply', 300);
  }
}

/** Creates or updates the durable record for this task and child, preserving its counter and attempt list. */
export function pauseReportRecovery(existing: ReportRecovery | undefined, key: { index: number; taskId: string; child: string | null; attemptId: string }, diagnostic: ReportDiagnostic): ReportRecovery {
  const base: ReportRecovery = existing && existing.phase === 'executor' && existing.index === key.index && existing.taskId === key.taskId && existing.child === key.child
    ? existing
    : { phase: 'executor', index: key.index, taskId: key.taskId, child: key.child, corrections: 0, mode: 'paused', originalAttemptId: key.attemptId, attempts: [] };
  return { ...base, mode: 'paused', diagnostic };
}
