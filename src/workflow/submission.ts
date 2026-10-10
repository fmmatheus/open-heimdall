import { validateSubmission } from './contracts.js';
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
  | { accepted: false; code: 'unauthorized' | 'conflict'; repairable: false; errors: []; message: string };

/**
 * Port between the native submission tools and whatever owns binding and persistence. The durable
 * implementation lives with the runner; the in-memory one below is for tests.
 */
export interface SubmissionGate {
  /** The kind a session may submit right now, or undefined when the session is not the bound child. */
  exposed(sessionID: string, agent: string): SubmissionKind | undefined | Promise<SubmissionKind | undefined>;
  submit(kind: SubmissionKind, raw: unknown, native: NativeCallContext): Promise<SubmissionResponse>;
}

export const SUBMISSION_DENIAL = 'Heimdall submission denied: this session is not the bound child for this submission kind.';

/** Exposes nothing and accepts nothing. The default when no gate is injected. */
export const closedSubmissionGate: SubmissionGate = {
  exposed: () => undefined,
  submit: async () => ({ accepted: false, code: 'unauthorized', repairable: false, errors: [], message: SUBMISSION_DENIAL }),
};

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
    async submit(kind, raw, native) {
      const binding = match(native.sessionID, native.agent);
      if (!binding || binding.rule.kind !== kind) return { accepted: false, code: 'unauthorized', repairable: false, errors: [], message: SUBMISSION_DENIAL };
      const result = validateSubmission(binding.rule, raw);
      const response: SubmissionResponse = result.ok
        ? { accepted: true, kind, outcome: result.outcome, digest: result.digest, message: 'Submission recorded. Stop now; do not call any other tool.' }
        : { accepted: false, code: 'format', repairable: true, errors: result.errors, message: 'Submission rejected: ' + result.errors.map(error => `${error.path} ${error.message}`).join('; ') };
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
