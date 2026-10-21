import { createHash } from 'node:crypto';
import type { RunRecord } from './types.js';

/** Longest blocker text a generic wait shows. */
export const PAUSE_REASON_LIMIT = 1500;
/** The blocker is identified by its first bytes and its total size, so the identity is cheap to derive in a bounded list query. */
export const PAUSE_REASON_IDENTITY_BYTES = 16384;
const FIELD_BYTES = 512;
/** Longest owner guidance a guarded response accepts. */
export const PAUSE_RESPONSE_LIMIT = 8000;

/** What a paused run without a typed approval request is waiting for. Older runtimes only ever produce this kind of wait. */
export interface GenericWait {
  kind: 'generic';
  /** Stable identity of this pause. A later pause of the same run has a different one. */
  pauseId: string;
  /** The recorded blocker, clipped to a bounded length. */
  reason: string;
  reasonClipped: boolean;
}

/** The fields that identify one pause, as they are stored. Text fields are bounded to their first bytes. */
export interface PauseParts {
  runId: string;
  version: number;
  parent: Uint8Array | null;
  phase: string | null;
  index: number | null;
  attemptId: Uint8Array | null;
  reasonHead: Uint8Array;
  reasonBytes: number;
}

/** Whether a checkpoint status and run status describe a paused checkpoint that a guarded response could continue. */
export function isPausedCheckpoint(run: Pick<RunRecord, 'status' | 'capacityReserved'>, checkpointStatus: unknown): boolean {
  return run.status === 'paused' && !run.capacityReserved && checkpointStatus === 'paused';
}

const bounded = (value: string | null | undefined): Uint8Array | null => value === null || value === undefined ? null : Buffer.from(value, 'utf8').subarray(0, FIELD_BYTES);

/**
 * The identity of a generic pause: a digest of the run, its version, the parent session, the phase and task index, the attempt
 * and the recorded blocker. Any later pause of the same run (a new version, attempt or blocker) has a different identity.
 */
export function pauseIdFor(parts: PauseParts): string {
  const hash = createHash('sha256');
  const field = (label: string, value: Uint8Array | string | number | null) => {
    const bytes = value === null ? Buffer.from('\u0000null') : Buffer.from(typeof value === 'object' ? value : String(value));
    hash.update(`${label}:${bytes.length}:`); hash.update(bytes); hash.update('\n');
  };
  field('run', parts.runId); field('version', parts.version); field('parent', parts.parent); field('phase', parts.phase);
  field('index', parts.index); field('attempt', parts.attemptId); field('blocker', parts.reasonHead); field('blockerBytes', parts.reasonBytes);
  return 'pau_' + hash.digest('hex').slice(0, 32);
}

/** The blocker of a checkpoint, as text. */
export function blockerOf(run: RunRecord): string {
  return run.checkpoint?.reason ?? '';
}

function partsOf(run: RunRecord): PauseParts {
  const state = run.checkpoint;
  const reason = Buffer.from(blockerOf(run), 'utf8');
  return {
    runId: run.id, version: run.version, parent: bounded(state?.parent), phase: state?.phase ?? null,
    index: typeof state?.index === 'number' && Number.isSafeInteger(state.index) ? state.index : null,
    attemptId: bounded(state?.attempt?.id), reasonHead: reason.subarray(0, PAUSE_REASON_IDENTITY_BYTES), reasonBytes: reason.length,
  };
}

/** Clips to at most `limit` UTF-16 units without splitting a surrogate pair. */
export function clipText(value: string, limit: number): { text: string; clipped: boolean } {
  if (value.length <= limit) return { text: value, clipped: false };
  let end = limit;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: value.slice(0, end), clipped: true };
}

/** The identity of the run's current pause, or null when the run is not paused and released on a paused checkpoint. */
export function currentPauseId(run: RunRecord): string | null {
  return run.checkpoint && isPausedCheckpoint(run, run.checkpoint.status) ? pauseIdFor(partsOf(run)) : null;
}

/** The generic wait of a run, or null. Typed approval requests are handled by the caller before this is asked. */
export function genericWaitOf(run: RunRecord): GenericWait | null {
  const pauseId = currentPauseId(run);
  if (pauseId === null) return null;
  const reason = clipText(blockerOf(run), PAUSE_REASON_LIMIT);
  return { kind: 'generic', pauseId, reason: reason.text, reasonClipped: reason.clipped };
}

/** The text a guarded response delivers: it labels the input as owner guidance and not as a typed approval. */
export function labelledGuidance(pauseId: string, input: string): string {
  return `Owner guidance (response to pause ${pauseId}; this is not a typed approval and grants no permission beyond the original task scope):\n${input}`;
}
