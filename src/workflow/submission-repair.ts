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
  /** `parallel`: an implementation call was running when the reporting boundary was sealed. `later`: one tried to start afterwards. */
  kind: 'parallel' | 'later';
  tool: string;
}

/** An explicit blocked or unpassed outcome found in a payload. Field names and gate IDs only, besides the agent's own reason. */
export interface NegativeReport {
  kind: SubmissionKind;
  outcome: 'blocked' | 'unfinished';
  gateIds: string[];
  fields: string[];
  reason?: string;
}

/** Implemented by the runner for the one dispatch it is currently waiting on. */
export interface RepairHandler {
  /**
   * Counts one format rejection and, if a repair remains, takes the owner-bound reporting-only restriction and saves
   * the counter, in that order, before answering. A refusal pauses the dispatch; it never reruns anything.
   */
  reject(request: RepairRequest): Promise<RepairDecision>;
  /**
   * Records the blocked or unpassed outcome as this attempt's result, never consuming a repair, and pauses the run with the
   * real reason. Resolves once the outcome is saved; rejects when it could not be, and the dispatch stops either way.
   */
  negative(report: NegativeReport): Promise<void>;
  /**
   * Saves the sealed reporting boundary of the attempt, together with `conflict` when implementation work was still running.
   * Resolves only once it is durable; rejects when it could not be saved, and the dispatch then stops (fail closed).
   */
  seal(conflict?: ConflictInfo): Promise<void>;
  /** Saves a conflict found after the boundary was sealed: implementation work tried to start. */
  conflict(info: ConflictInfo): Promise<void>;
}

/**
 * Shared, process-local meeting point between the plugin hooks, the submission gate and the runner. It carries no
 * authority: admission still comes from the durable binding and receipt, and the sealed boundary is saved before it
 * matters. It tracks implementation tool calls so the boundary can tell, at the moment it is sealed, what is still running.
 */
export interface SubmissionSupervisor {
  /** Registers the repair handler of a running dispatch for its child and starts a fresh tool timeline. */
  register(child: string, handler: RepairHandler): () => void;
  /** True while a running dispatch owns this child. */
  tracked(sessionID: string): boolean;
  reject(child: string, request: RepairRequest): Promise<RepairDecision>;
  negative(child: string, report: NegativeReport): Promise<void>;
  /**
   * An implementation (non-submission) tool call is about to run. Registered synchronously, before the first await, so a
   * seal can never miss it. Resolves false when the boundary is already sealed: the call must be denied, and a call
   * refused after the seal is also recorded as a conflict so the evidence is never silently admitted.
   */
  begin(sessionID: string, callId: string, tool: string): Promise<boolean>;
  finished(sessionID: string, callId: string): void;
  /** A submission call began. False once a blocked or unpassed outcome closed the attempt: nothing more is accepted. */
  submitting(sessionID: string, callId: string): boolean;
  submitted(sessionID: string, callId: string): void;
  /** Closes the reporting boundary and saves it. Rejects when it could not be saved (fail closed) or no dispatch owns the child. */
  seal(sessionID: string): Promise<void>;
  conflict(child: string): ConflictInfo | undefined;
}

interface Timeline {
  handler: RepairHandler;
  inflight: Map<string, string>;
  submitting: Set<string>;
  /** The first implementation call that was running at any point while a submission call was being processed. */
  overlap?: string;
  /** Set synchronously when sealing begins, before it is saved; sealing stays in force even if the save fails. */
  sealed: boolean;
  /** A blocked or unpassed outcome closed the attempt. */
  closed: boolean;
  conflict?: ConflictInfo;
}

export function createSubmissionSupervisor(): SubmissionSupervisor {
  const timelines = new Map<string, Timeline>();
  return {
    register(child, handler) {
      const timeline: Timeline = { handler, inflight: new Map(), submitting: new Set(), sealed: false, closed: false };
      timelines.set(child, timeline);
      return () => { if (timelines.get(child) === timeline) timelines.delete(child); };
    },
    tracked: sessionID => timelines.has(sessionID),
    async reject(child, request) {
      const timeline = timelines.get(child);
      if (!timeline) return { feedback: false, code: 'unavailable', message: 'No running workflow dispatch owns this child, so no repair can be granted.' };
      return timeline.handler.reject(request);
    },
    async negative(child, report) {
      const timeline = timelines.get(child);
      if (!timeline) throw new Error('No running workflow dispatch owns this child, so the reported outcome cannot be recorded.');
      timeline.closed = true;
      timeline.sealed = true;
      await timeline.handler.negative(report);
    },
    async begin(sessionID, callId, tool) {
      const timeline = timelines.get(sessionID);
      if (!timeline || submissionKindOfTool(tool)) return true;
      if (!timeline.sealed) {
        timeline.inflight.set(callId, tool);
        if (timeline.submitting.size) timeline.overlap ??= tool;
        return true;
      }
      if (timeline.closed) return false;
      const info: ConflictInfo = { kind: 'later', tool };
      timeline.conflict ??= info;
      try { await timeline.handler.conflict(timeline.conflict); } catch { /* the call is denied and the in-memory flag still pauses admission */ }
      return false;
    },
    finished(sessionID, callId) { timelines.get(sessionID)?.inflight.delete(callId); },
    submitting(sessionID, callId) {
      const timeline = timelines.get(sessionID);
      if (!timeline) return true;
      if (timeline.closed) return false;
      timeline.submitting.add(callId);
      // Work already running when a submission starts counts as overlapping it even if it ends before the seal.
      if (!timeline.sealed && timeline.inflight.size) timeline.overlap ??= [...timeline.inflight.values()][0];
      return true;
    },
    submitted(sessionID, callId) {
      const timeline = timelines.get(sessionID);
      if (!timeline) return;
      timeline.submitting.delete(callId);
      if (!timeline.sealed && !timeline.submitting.size) timeline.overlap = undefined;
    },
    async seal(sessionID) {
      const timeline = timelines.get(sessionID);
      if (!timeline) throw new Error('No running workflow dispatch owns this child, so the reporting boundary cannot be sealed.');
      if (timeline.closed) throw new Error('The attempt already recorded a blocked or unpassed outcome and accepts nothing further.');
      // Synchronous from here to the save: no implementation call can be admitted between the snapshot and the seal.
      timeline.sealed = true;
      const running = [...timeline.inflight.values()][0] ?? timeline.overlap;
      if (running !== undefined) timeline.conflict ??= { kind: 'parallel', tool: running };
      await timeline.handler.seal(timeline.conflict);
    },
    conflict: child => timelines.get(child)?.conflict,
  };
}
