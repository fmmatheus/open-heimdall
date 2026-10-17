import { negativeSignal, validateSubmission } from './contracts.js';
import type { ContractError, ExecutorOutcome, PlannerOutcome, SubmissionKind, SubmissionRule } from './contracts.js';

/** Native call context supplied by OpenCode. Identity decisions use only this and durable host state. */
export interface NativeCallContext {
  readonly sessionID: string;
  readonly agent: string;
  readonly messageID: string;
  readonly id: string;
}

export type SubmissionResponse =
  | { accepted: true; kind: SubmissionKind; outcome: PlannerOutcome | ExecutorOutcome; digest: string; message: string }
  | { accepted: false; code: 'format'; repairable: true; errors: ContractError[]; message: string }
  | {
    /** An explicit blocked or unpassed outcome inside a payload that was also malformed. Never repairable. */
    accepted: false; code: 'negative'; repairable: false; outcome: 'blocked' | 'unfinished';
    gateIds: string[]; fields: string[]; reason?: string; errors: ContractError[]; message: string;
  }
  | {
    /** `origin` is set only when the caller is the bound child but its native origin could not be verified; the payload was not evaluated. */
    accepted: false; code: 'unauthorized'; repairable: false; errors: []; message: string; origin?: OriginReason;
  }
  | { accepted: false; code: 'conflict'; repairable: false; errors: []; message: string };

/**
 * Bounded reasons a call's native origin cannot be verified. The first nine mirror the OpenCode origin-proof failures;
 * `unverifiable` stands for anything else (no resolver, an undefined origin, an unexpected error). Never transcript text.
 */
export const ORIGIN_REASONS = [
  'history_unavailable', 'page_malformed', 'cursor_repeated', 'duplicate_message', 'scan_exhausted',
  'call_not_found', 'agent_mismatch', 'call_mismatch', 'prompt_not_found', 'unverifiable',
] as const;
export type OriginReason = typeof ORIGIN_REASONS[number];

/**
 * The reporting boundary of the dispatch that owns a submission. `seal` closes it durably BEFORE a receipt is
 * acknowledged: from then on no new implementation work is admitted and any work still running is recorded as a
 * conflict. It rejects when the seal could not be saved, and the submission then fails closed.
 */
export interface SubmissionBoundary {
  seal(): Promise<void>;
}

/**
 * Port between the native submission tools and whatever owns binding and persistence. The durable
 * implementation lives with the runner; the in-memory one below is for tests.
 */
export interface SubmissionGate {
  /** Whether durable workflow history identifies this native session as a workflow child. */
  owns?(sessionID: string): boolean | Promise<boolean>;
  /** The kind a session may submit right now, or undefined when the session is not the bound child. */
  exposed(sessionID: string, agent: string): SubmissionKind | undefined | Promise<SubmissionKind | undefined>;
  submit(kind: SubmissionKind, raw: unknown, native: NativeCallContext, boundary?: SubmissionBoundary): Promise<SubmissionResponse>;
  /**
   * True when the child has no current execution ownership or already sealed its reporting boundary. This also
   * fences paused, completed and superseded children after the process-local dispatch was removed.
   */
  sealed?(sessionID: string, agent?: string): boolean | Promise<boolean>;
}

export const SUBMISSION_DENIAL = 'Heimdall submission denied: this session is not the bound child for this submission kind.';
/** Denial for a call by the bound child whose native origin could not be proven current. It is not a format error and spends no repair. */
export const originUnverifiedDenial = (reason: OriginReason): string =>
  'Heimdall submission denied: the native origin of this call could not be verified against the current dispatch (' + reason + '). The payload was not evaluated; this is not a format error.';
export const SEALED_DENIAL = 'Heimdall denied this tool call: the reporting boundary for this attempt is sealed, so no further implementation work is allowed. Stop now.';

/** Exposes nothing and accepts nothing. The default when no gate is injected. */
export const closedSubmissionGate: SubmissionGate = {
  exposed: () => undefined,
  submit: async () => ({ accepted: false, code: 'unauthorized', repairable: false, errors: [], message: SUBMISSION_DENIAL }),
};

const describeErrors = (errors: ContractError[]) => errors.map(error => `${error.path} ${error.message}`).join('; ');

/**
 * The response for a payload that failed validation. An explicit blocked or unpassed outcome takes precedence over any
 * format error: it is a negative result to record and pause on, never one to repair.
 */
export function rejectedSubmission(rule: SubmissionRule, raw: unknown, errors: ContractError[]): SubmissionResponse {
  const negative = negativeSignal(rule, raw, errors);
  if (negative) {
    return {
      accepted: false, code: 'negative', repairable: false, outcome: negative.outcome, gateIds: negative.gateIds, fields: negative.fields,
      ...(negative.reason === undefined ? {} : { reason: negative.reason }), errors,
      message: 'Reported ' + negative.outcome + ' work was recorded as such and no format repair is offered: ' + describeErrors(errors),
    };
  }
  return { accepted: false, code: 'format', repairable: true, errors, message: 'Submission rejected: ' + describeErrors(errors) };
}

export interface MemoryBinding {
  sessionID: string;
  agent: string;
  rule: SubmissionRule;
}

export interface MemorySubmission {
  kind: SubmissionKind;
  sessionID: string;
  raw: unknown;
  response: SubmissionResponse;
}

/** Test-only gate: one active binding per kind; rebinding a kind makes the previous session stale. */
export function createMemorySubmissionGate() {
  const bindings = new Map<SubmissionKind, MemoryBinding>();
  const submissions: MemorySubmission[] = [];
  const match = (sessionID: string, agent: string): MemoryBinding | undefined =>
    [...bindings.values()].find(binding => binding.sessionID === sessionID && binding.agent === agent);
  const gate: SubmissionGate = {
    exposed: (sessionID, agent) => match(sessionID, agent)?.rule.kind,
    async submit(kind, raw, native) { // Owns no durable state, so it has no reporting boundary to seal.
      const binding = match(native.sessionID, native.agent);
      if (!binding || binding.rule.kind !== kind) return { accepted: false, code: 'unauthorized', repairable: false, errors: [], message: SUBMISSION_DENIAL };
      const result = validateSubmission(binding.rule, raw);
      const response: SubmissionResponse = result.ok
        ? { accepted: true, kind, outcome: result.outcome, digest: result.digest, message: 'Submission recorded. Stop now; do not call any other tool.' }
        : rejectedSubmission(binding.rule, raw, result.errors);
      submissions.push({ kind, sessionID: native.sessionID, raw, response });
      return response;
    },
  };
  return {
    gate,
    submissions,
    bind(binding: MemoryBinding) { bindings.set(binding.rule.kind, binding); },
    release(kind: SubmissionKind) { bindings.delete(kind); },
  };
}
