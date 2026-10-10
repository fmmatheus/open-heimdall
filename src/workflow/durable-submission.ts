import { contractDigest, SUBMISSION_PROTOCOL, validateSubmission } from './contracts.js';
import type { ExecutorOutcome, ExecutorResult, PlannedTask, PlannerOutcome, PlannerPlan, SubmissionRule } from './contracts.js';
import { planDigest, loadPlanSnapshot } from './plan-snapshot.js';
import { runtimeIdentity } from './runtime-identity.js';
import { sameSubmission, submissionKindForPhase } from './submission-store.js';
import { SUBMISSION_DENIAL } from './submission.js';
import type { NativeCallContext, SubmissionGate, SubmissionResponse } from './submission.js';
import type { RunnerPersistence, RunState, RuntimeIdentity, SubmissionBinding, SubmissionReceipt } from './types.js';

export interface DurableSubmissionGateOptions {
  runId: string;
  directory: string;
  planRoot?: string;
  /** The authoritative store: coordinator-backed for managed runs, the local run directory otherwise. */
  persistence: Pick<RunnerPersistence, 'load' | 'readSubmission' | 'writeSubmission'>;
  runtime?: () => RuntimeIdentity;
  now?: () => number;
}

const ACKNOWLEDGEMENT = 'Submission recorded. Stop now; do not call any other tool.';
const unauthorized = (): SubmissionResponse => ({ accepted: false, code: 'unauthorized', repairable: false, errors: [], message: SUBMISSION_DENIAL });
const conflict = (): SubmissionResponse => ({ accepted: false, code: 'conflict', repairable: false, errors: [], message: 'A different submission was already recorded for this attempt; it cannot be replaced.' });

const acknowledge = (receipt: SubmissionReceipt): SubmissionResponse => ({
  accepted: true, kind: receipt.kind, outcome: receipt.outcome as PlannerOutcome | ExecutorOutcome, digest: receipt.digest, message: ACKNOWLEDGEMENT,
});

/**
 * Derives the one binding that may submit from the persisted checkpoint plus the native caller. The agent name is
 * only one of the checks: the session must be the recorded child of the open binding, and the binding must be
 * the current attempt's. Nothing here is process-local, so a rebuilt gate authenticates exactly like the original.
 */
export function authenticateSubmissionCaller(state: RunState | null | undefined, sessionID: string, agent: string): SubmissionBinding | undefined {
  const binding = state?.submissionBinding;
  const attempt = state?.attempt;
  if (!state || !binding || !attempt || state.protocol !== SUBMISSION_PROTOCOL || state.status !== 'running') return undefined;
  if (binding.status !== 'open' || binding.protocol !== SUBMISSION_PROTOCOL || binding.runId !== state.id || binding.parent !== state.parent) return undefined;
  if (attempt.id !== binding.attemptId || attempt.phase !== binding.phase || attempt.index !== binding.index || state.phase !== binding.phase || state.index !== binding.index) return undefined;
  if (attempt.status === 'interrupted' || attempt.status === 'rejected') return undefined;
  if (binding.kind !== submissionKindForPhase(binding.phase) || !binding.child || binding.child !== state.child || binding.child !== attempt.child || sessionID !== binding.child) return undefined;
  const role = binding.phase === 'planner' ? state.settings.plannerAgent : state.settings.executorAgent;
  if (!role || agent !== role) return undefined;
  if (binding.phase === 'executor' && state.tasks[binding.index]?.id !== binding.taskId) return undefined;
  return binding;
}

/** The durable implementation of the submission port: binding from persisted state, receipt persisted before acknowledgement. */
export function createDurableSubmissionGate(options: DurableSubmissionGateOptions): SubmissionGate {
  const { runId, directory, planRoot, persistence, runtime = runtimeIdentity, now = Date.now } = options;
  return {
    async exposed(sessionID, agent) {
      try {
        const state = await persistence.load(runId);
        return authenticateSubmissionCaller(state, sessionID, agent)?.kind;
      } catch { return undefined; } // Fail closed: an unreadable checkpoint exposes nothing.
    },
    async submit(kind, raw, native: NativeCallContext) {
      const state = await persistence.load(runId);
      const binding = authenticateSubmissionCaller(state, native.sessionID, native.agent);
      if (!state || !binding || binding.kind !== kind) return unauthorized();
      // Clone before validation: the receipt keeps exactly what was submitted.
      let rawPayload: unknown;
      try { rawPayload = structuredClone(raw); } catch { rawPayload = undefined; }
      const rule: SubmissionRule = kind === 'planner-plan'
        ? { kind, limit: state.settings.maxTasks }
        : { kind, dodCount: state.tasks[binding.index]?.dod.length ?? 0 };
      const stored = await persistence.readSubmission(runId, binding.attemptId, kind);
      if (stored) return sameSubmission(stored, { ...stored, rawPayload }) ? acknowledge(stored) : conflict();
      const result = validateSubmission(rule, rawPayload);
      if (!result.ok) return { accepted: false, code: 'format', repairable: true, errors: result.errors, message: 'Submission rejected: ' + result.errors.map(error => `${error.path} ${error.message}`).join('; ') };
      let canonical: unknown;
      if (kind === 'planner-plan') {
        const plan = result.value as PlannerPlan;
        if (plan.status === 'planned' && 'artifacts' in plan) {
          const loaded = await loadPlanSnapshot({ directory, planRoot, runId, limit: state.settings.maxTasks });
          if (!loaded.ok) return { accepted: false, code: 'format', repairable: true, errors: loaded.errors, message: 'Submission rejected: ' + loaded.errors.map(error => `${error.path} ${error.message}`).join('; ') };
          const { planMarkdown, factSheet, tasks, sha256 } = loaded.snapshot;
          canonical = { status: 'planned', planMarkdown, factSheet, tasks: structuredClone(tasks), sha256 };
        } else if (plan.status === 'planned') {
          canonical = { status: 'planned', planMarkdown: plan.planMarkdown, factSheet: plan.factSheet, tasks: structuredClone(plan.tasks) as PlannedTask[], sha256: planDigest(plan) };
        } else canonical = structuredClone(plan);
      } else {
        const outcome = result.value as ExecutorResult;
        if (outcome.status === 'completed') {
          const dod = state.tasks[binding.index]!.dod;
          // The gate text is host-owned: only the canonical value carries it, never the raw payload.
          canonical = {
            status: 'completed', taskId: binding.taskId, summary: outcome.summary, handoff: outcome.handoff,
            evidence: outcome.evidence.map(entry => ({ gateId: entry.gateId, gate: dod[Number(entry.gateId.slice(1)) - 1], passed: entry.passed, detail: entry.detail })),
          };
        } else canonical = { ...outcome, taskId: binding.taskId };
      }
      const receipt: SubmissionReceipt = {
        receiptVersion: 1, protocol: SUBMISSION_PROTOCOL, contract: result.contract, kind, runId: binding.runId, phase: binding.phase, index: binding.index,
        ...(binding.taskId === undefined ? {} : { taskId: binding.taskId }), attemptId: binding.attemptId, dispatch: binding.dispatch, parent: binding.parent,
        child: binding.child!, caller: { sessionID: native.sessionID, agent: native.agent, messageID: native.messageID, callId: native.id },
        runtime: runtime(), outcome: result.outcome, rawPayload, canonical, digest: contractDigest(result.contract, canonical), acceptedAt: now(),
      };
      // Durable first: a persistence failure throws here, so no acknowledgement can be returned for an unsaved receipt.
      return acknowledge(await persistence.writeSubmission(runId, receipt));
    },
  };
}
