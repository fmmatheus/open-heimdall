/**
 * Bounded, allowlisted view of a durable `reportRecovery` record for events and the extension. It carries a
 * mode, a counter, a code, fixed field names and gate IDs only: never reason text, replies or secrets.
 * Anything that is not on an allowlist is dropped, whatever the stored record says.
 */

/** Fixed names a diagnostic may carry. Anything else never reaches a checkpoint, event or UI. */
export const REPORT_FIELDS = ['taskId', 'summary', 'handoff', 'evidence', 'gateId', 'detail', 'passed', 'reason'] as const;

export const REPORT_CODES = [
  'report_format', 'unfinished_work', 'agent_blocked', 'identity_mismatch', 'ambiguous_output',
  'native_failure', 'auth_or_quota', 'correction_exhausted', 'correction_unsupported', 'correction_ambiguous',
  'submission_missing', 'submission_unconfirmed', 'submission_repair_exhausted', 'submission_refused',
  'submission_unsupported', 'conflicting_work', 'approval_required',
] as const;

export const REPORT_MODES = ['idle', 'correcting', 'paused'] as const;

/** Automatic corrections allowed per task. */
export const REPORT_CORRECTION_LIMIT = 2;
/** Format repairs of a typed submission allowed per planner phase or executor task. Mirrors MAX_SUBMISSION_REPAIRS. */
export const SUBMISSION_REPAIR_LIMIT = 2;
const GATE_ID = /^G[1-9][0-9]{0,5}$/;
const LIST_LIMIT = 50;

export interface ReportInfo {
  /** Present (as `submission`) only for format repairs of typed submissions; the legacy prose-report view omits it. */
  kind?: 'submission';
  mode: typeof REPORT_MODES[number];
  corrections: number;
  limit: number;
  code: typeof REPORT_CODES[number] | null;
  missingFields: string[];
  gateIds: string[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Null when `value` is not a report-recovery record. Never throws. */
export function reportInfo(value: unknown): ReportInfo | null {
  if (!isRecord(value)) return null;
  const mode = REPORT_MODES.find(candidate => candidate === value.mode);
  if (mode === undefined) return null;
  const counter = typeof value.corrections === 'number' && Number.isInteger(value.corrections) ? value.corrections : 0;
  const diagnostic = isRecord(value.diagnostic) ? value.diagnostic : {};
  const fields = Array.isArray(diagnostic.missingFields) ? diagnostic.missingFields : [];
  const gates = Array.isArray(diagnostic.gateIds) ? diagnostic.gateIds : [];
  return {
    mode,
    corrections: Math.max(0, Math.min(REPORT_CORRECTION_LIMIT, counter)),
    limit: REPORT_CORRECTION_LIMIT,
    code: REPORT_CODES.find(candidate => candidate === diagnostic.code) ?? null,
    missingFields: REPORT_FIELDS.filter(field => fields.includes(field)),
    gateIds: [...new Set(gates.filter((id): id is string => typeof id === 'string' && GATE_ID.test(id)))].slice(0, LIST_LIMIT),
  };
}

const REPAIR_REFUSALS: Record<string, typeof REPORT_CODES[number]> = {
  exhausted: 'submission_repair_exhausted', unsupported: 'submission_unsupported', auth_or_quota: 'auth_or_quota', unavailable: 'submission_refused',
};

/**
 * Allowlisted view of a structured run's durable `submissionRepair` record: the count of repairs used, a refusal or
 * conflict code, never any submitted value. Null when `value` is not such a record. Never throws.
 */
export function submissionRepairInfo(value: unknown): ReportInfo | null {
  if (!isRecord(value) || (value.phase !== 'planner' && value.phase !== 'executor')) return null;
  const used = typeof value.repairs === 'number' && Number.isInteger(value.repairs) ? value.repairs : 0;
  const refused = isRecord(value.refused) && typeof value.refused.code === 'string' ? REPAIR_REFUSALS[value.refused.code] : undefined;
  const conflicting = isRecord(value.conflict);
  // An explicit blocked or unpassed outcome is the real failure and wins: it carries its own allowlisted diagnostics.
  const negative = isRecord(value.negative) && (value.negative.outcome === 'blocked' || value.negative.outcome === 'unfinished') ? value.negative : undefined;
  const fields = negative && Array.isArray(negative.fields) ? negative.fields : [];
  const gates = negative && Array.isArray(negative.gateIds) ? negative.gateIds : [];
  return {
    kind: 'submission',
    mode: negative || refused || conflicting ? 'paused' : used > 0 ? 'correcting' : 'idle',
    corrections: Math.max(0, Math.min(SUBMISSION_REPAIR_LIMIT, used)),
    limit: SUBMISSION_REPAIR_LIMIT,
    code: negative ? (negative.outcome === 'blocked' ? 'agent_blocked' : 'unfinished_work') : conflicting ? 'conflicting_work' : refused ?? null,
    missingFields: REPORT_FIELDS.filter(field => fields.includes(field)),
    gateIds: [...new Set(gates.filter((id): id is string => typeof id === 'string' && GATE_ID.test(id)))].slice(0, LIST_LIMIT),
  };
}

/** The repair or correction state of a checkpoint: a structured run's repair record wins, then the legacy report record. */
export function checkpointReportInfo(checkpoint: unknown): ReportInfo | null {
  if (!isRecord(checkpoint)) return null;
  // A recorded approval wait is the pause's real category: the repair record of that attempt only counts its (unspent) repairs.
  if (isRecord(checkpoint.wait) && checkpoint.wait.kind === 'approval') {
    const waiting = reportInfo(checkpoint.reportRecovery);
    if (waiting?.code === 'approval_required') return waiting;
  }
  return submissionRepairInfo(checkpoint.submissionRepair) ?? reportInfo(checkpoint.reportRecovery);
}
