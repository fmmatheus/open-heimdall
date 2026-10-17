import { contractDigest, SUBMISSION_PROTOCOL, validateSubmission } from './contracts.js';
import type { ExecutorOutcome, ExecutorResult, PlannedTask, PlannerOutcome, PlannerPlan, SubmissionRule } from './contracts.js';
import { planDigest, loadPlanSnapshot } from './plan-snapshot.js';
import { runtimeIdentity } from './runtime-identity.js';
import { sameSubmission, submissionKindForPhase } from './submission-store.js';
import { ORIGIN_REASONS, originUnverifiedDenial, rejectedSubmission, SUBMISSION_DENIAL } from './submission.js';
import type { NativeCallContext, OriginReason, SubmissionGate, SubmissionResponse } from './submission.js';
import type { RunnerPersistence, RunState, RuntimeIdentity, SubmissionBinding, SubmissionReceipt } from './types.js';
import { childExecutionBlocked, isWorkflowChild } from './child-ownership.js';

/**
 * Proves, from native observation of the bound child session, which dispatch prompt a tool call descends from.
 * Returns the native prompt message id, or undefined when that cannot be established. Implementations must use
 * host-observed native state only (never a model-supplied attempt or generation). The gate denies a call whose resolved
 * origin differs from the binding's prompt as plain unauthorized, and one whose origin is missing, unresolved or
 * throwing as an unverifiable-origin denial (an OriginProofError carries the bounded reason).
 */
export type NativeOriginResolver = (native: NativeCallContext, binding: SubmissionBinding) => Promise<string | undefined> | string | undefined;

export interface DurableSubmissionGateOptions {
  runId: string;
  directory: string;
  planRoot?: string;
  /** The authoritative store: coordinator-backed for managed runs, the local run directory otherwise. */
  persistence: Pick<RunnerPersistence, 'load' | 'readSubmission' | 'writeSubmission'>;
  /** Maps a native call to its dispatch prompt. Absent means no call can be proven current, so every submit fails closed. */
  origin?: NativeOriginResolver;
  runtime?: () => RuntimeIdentity;
  now?: () => number;
}

const ACKNOWLEDGEMENT = 'Submission recorded. Stop now; do not call any other tool.';
const unauthorized = (): SubmissionResponse => ({ accepted: false, code: 'unauthorized', repairable: false, errors: [], message: SUBMISSION_DENIAL });
const unverifiedOrigin = (origin: OriginReason): SubmissionResponse => ({ accepted: false, code: 'unauthorized', repairable: false, errors: [], message: originUnverifiedDenial(origin), origin });
/** The bounded reason of an origin-proof failure. Error text is never used: anything unrecognized is `unverifiable`. */
const originReasonOf = (error: unknown): OriginReason => {
  const reason = error instanceof Error && error.name === 'OriginProofError' ? (error as { reason?: unknown }).reason : undefined;
  return (ORIGIN_REASONS as readonly unknown[]).includes(reason) ? reason as OriginReason : 'unverifiable';
};
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
  // A refused repair ends this attempt's right to submit, even if a call races the pause.
  if (state.submissionRepair?.refused?.attemptId === attempt.id) return undefined;
  // So does a recorded blocked or unpassed outcome: it is the attempt's result and nothing may replace it.
  if (state.submissionRepair?.negative?.attemptId === attempt.id) return undefined;
  if (!binding.prompt) return undefined; // No host-recorded dispatch prompt: nothing can be proven current.
  if (binding.kind !== submissionKindForPhase(binding.phase) || !binding.child || binding.child !== state.child || binding.child !== attempt.child || sessionID !== binding.child) return undefined;
  const role = binding.phase === 'planner' ? state.settings.plannerAgent : state.settings.executorAgent;
  if (!role || agent !== role) return undefined;
  if (binding.phase === 'executor' && state.tasks[binding.index]?.id !== binding.taskId) return undefined;
  return binding;
}

/** The durable implementation of the submission port: binding from persisted state, receipt persisted before acknowledgement. */
export function createDurableSubmissionGate(options: DurableSubmissionGateOptions): SubmissionGate {
  const { runId, directory, planRoot, persistence, origin, runtime = runtimeIdentity, now = Date.now } = options;
  return {
    async owns(sessionID) {
      try { return isWorkflowChild(await persistence.load(runId), sessionID); }
      catch { return false; }
    },
    async exposed(sessionID, agent) {
      try {
        const state = await persistence.load(runId);
        return authenticateSubmissionCaller(state, sessionID, agent)?.kind;
      } catch { return undefined; } // Fail closed: an unreadable checkpoint exposes nothing.
    },
    async sealed(sessionID, agent) {
      let state: RunState | null | undefined;
      try { state = await persistence.load(runId); } catch { return true; } // Fail closed: an unreadable checkpoint cannot prove the boundary is open.
      if (childExecutionBlocked(state, sessionID, agent)) return true;
      const attempt = state?.attempt;
      const sealed = state?.submissionRepair?.sealed;
      if (!state || state.protocol !== SUBMISSION_PROTOCOL || state.status !== 'running' || !attempt || !sealed) return false;
      return sealed.attemptId === attempt.id && state.child === sessionID;
    },
    async submit(kind, raw, native: NativeCallContext, boundary) {
      const state = await persistence.load(runId);
      const binding = authenticateSubmissionCaller(state, native.sessionID, native.agent);
      if (!state || !binding || binding.kind !== kind) return unauthorized();
      // A delayed call from an earlier dispatch on the same reused child passes the session/agent checks above, so its
      // native origin must also resolve to this binding's recorded dispatch prompt. Unverifiable origin fails closed.
      // A proven origin that differs is another dispatch (plain denial); one that cannot be proven is reported distinctly.
      let proven: string | undefined;
      let unverified: OriginReason = 'unverifiable';
      try { proven = origin ? await origin(native, binding) : undefined; } catch (error) { unverified = originReasonOf(error); }
      if (!proven) return unverifiedOrigin(unverified);
      if (proven !== binding.prompt) return unauthorized();
      // Clone before validation: the receipt keeps exactly what was submitted.
      let rawPayload: unknown;
      try { rawPayload = structuredClone(raw); } catch { rawPayload = undefined; }
      const rule: SubmissionRule = kind === 'planner-plan'
        ? { kind, limit: state.settings.maxTasks }
        : { kind, dodCount: state.tasks[binding.index]?.dod.length ?? 0 };
      const stored = await persistence.readSubmission(runId, binding.attemptId, kind);
      if (stored) return sameSubmission(stored, { ...stored, rawPayload }) ? acknowledge(stored) : conflict();
      const result = validateSubmission(rule, rawPayload);
      if (!result.ok) return rejectedSubmission(rule, rawPayload, result.errors);
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
        child: binding.child!, origin: binding.prompt!, caller: { sessionID: native.sessionID, agent: native.agent, messageID: native.messageID, callId: native.id },
        runtime: runtime(), outcome: result.outcome, rawPayload, canonical, digest: contractDigest(result.contract, canonical), acceptedAt: now(),
      };
      // Close the reporting boundary durably first. Work still running is recorded in the same save, so a crash after the
      // receipt can never leave evidence that changed after it unmarked. A failed seal throws: nothing is acknowledged.
      await boundary?.seal();
      // Durable first: a persistence failure throws here, so no acknowledgement can be returned for an unsaved receipt.
      return acknowledge(await persistence.writeSubmission(runId, receipt));
    },
  };
}
