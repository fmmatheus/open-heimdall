import { submissionKindOfTool } from './contracts.js';
import type { ContractError, SubmissionKind } from './contracts.js';
import type { SubmissionRepairRefusal } from './types.js';

/**
 * Format-repair opportunities per planner phase or executor task, after the initial submission. The count is
 * persisted in the checkpoint BEFORE feedback is returned, so a crash or an explicit resume never grants more.
 */
export const MAX_SUBMISSION_REPAIRS = 2;

export interface RepairRequest {
  kind: SubmissionKind;
  /** Absent for a call the framework rejected before Heimdall's tool ran: the handler then uses its current attempt. */
  attemptId?: string;
  errors: ContractError[];
}

export type RepairDecision =
  | { feedback: true; used: number; remaining: number }
  | { feedback: false; code: SubmissionRepairRefusal; message: string };

export interface ConflictInfo {
  /** `parallel`: an implementation call was running when the submission was accepted. `later`: one started afterwards. */
  kind: 'parallel' | 'later';
  tool: string;
}

/** Implemented by the runner for the one dispatch it is currently waiting on. */
export interface RepairHandler {
  /**
   * Counts one format rejection and, if a repair remains, takes the owner-bound reporting-only restriction and saves
   * the counter, in that order, before answering. A refusal pauses the dispatch; it never reruns anything.
   */
  reject(request: RepairRequest): Promise<RepairDecision>;
  /** Called once when the tool timeline shows implementation work that can change evidence after its receipt. */
  conflict(info: ConflictInfo): void;
}

/**
 * Shared, process-local meeting point between the plugin hooks, the submission gate and the runner. It carries no
 * authority: admission still comes from the durable binding and receipt. It records which implementation tool calls
 * ran next to an accepted submission so the runner can refuse to admit evidence that changed after its receipt.
 */
export interface SubmissionSupervisor {
  /** Registers the repair handler of a running dispatch for its child and starts a fresh tool timeline. */
  register(child: string, handler: RepairHandler): () => void;
  reject(child: string, request: RepairRequest): Promise<RepairDecision>;
  /** An implementation (non-submission) tool call is about to run. */
  started(sessionID: string, callId: string, tool: string): void;
  finished(sessionID: string, callId: string): void;
  /** A submission tool call began / ended; `accepted` is true only for an acknowledged submission. */
  submitting(sessionID: string, callId: string): void;
  submitted(sessionID: string, callId: string, accepted: boolean): void;
  conflict(child: string): ConflictInfo | undefined;
}

interface Timeline {
  handler: RepairHandler;
  inflight: Map<string, string>;
  submitting: Set<string>;
  /** The first implementation call that started while a submission call was being processed. */
  overlap?: string;
  accepted: boolean;
  conflict?: ConflictInfo;
}

export function createSubmissionSupervisor(): SubmissionSupervisor {
  const timelines = new Map<string, Timeline>();
  const flag = (timeline: Timeline, info: ConflictInfo) => {
    if (timeline.conflict) return;
    timeline.conflict = info;
    try { timeline.handler.conflict(info); } catch { /* the in-memory flag still pauses admission */ }
  };
  return {
    register(child, handler) {
      const timeline: Timeline = { handler, inflight: new Map(), submitting: new Set(), accepted: false };
      timelines.set(child, timeline);
      return () => { if (timelines.get(child) === timeline) timelines.delete(child); };
    },
    async reject(child, request) {
      const timeline = timelines.get(child);
      if (!timeline) return { feedback: false, code: 'unavailable', message: 'No running workflow dispatch owns this child, so no repair can be granted.' };
      return timeline.handler.reject(request);
    },
    started(sessionID, callId, tool) {
      const timeline = timelines.get(sessionID);
      if (!timeline || submissionKindOfTool(tool)) return;
      timeline.inflight.set(callId, tool);
      if (timeline.accepted) flag(timeline, { kind: 'later', tool });
      else if (timeline.submitting.size) timeline.overlap ??= tool;
    },
    finished(sessionID, callId) { timelines.get(sessionID)?.inflight.delete(callId); },
    submitting(sessionID, callId) { timelines.get(sessionID)?.submitting.add(callId); },
    submitted(sessionID, callId, accepted) {
      const timeline = timelines.get(sessionID);
      if (!timeline) return;
      timeline.submitting.delete(callId);
      if (!accepted) { if (!timeline.submitting.size) timeline.overlap = undefined; return; }
      if (timeline.accepted) return;
      timeline.accepted = true;
      const running = [...timeline.inflight.values()][0] ?? timeline.overlap;
      if (running !== undefined) flag(timeline, { kind: 'parallel', tool: running });
    },
    conflict: child => timelines.get(child)?.conflict,
  };
}
