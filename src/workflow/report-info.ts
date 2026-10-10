/**
 * Bounded, allowlisted view of a durable `reportRecovery` record for events and the extension. It carries a
 * mode, a counter, a code, fixed field names and gate IDs only: never reason text, replies or secrets.
 * Anything that is not on an allowlist is dropped, whatever the stored record says.
 */

/** Fixed names a diagnostic may carry. Anything else never reaches a checkpoint, event or UI. */
export const REPORT_FIELDS = ['taskId', 'summary', 'handoff', 'evidence', 'gateId', 'detail', 'passed'] as const;

export const REPORT_CODES = [
  'report_format', 'unfinished_work', 'agent_blocked', 'identity_mismatch', 'ambiguous_output',
  'native_failure', 'auth_or_quota', 'correction_exhausted', 'correction_unsupported', 'correction_ambiguous',
] as const;

export const REPORT_MODES = ['idle', 'correcting', 'paused'] as const;

/** Automatic corrections allowed per task. */
export const REPORT_CORRECTION_LIMIT = 2;
const GATE_ID = /^G[1-9][0-9]{0,5}$/;
const LIST_LIMIT = 50;

export interface ReportInfo {
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
