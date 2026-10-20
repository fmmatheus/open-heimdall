/*
 * Pure rules for the complete approval request behind a shortened card: which card it belongs to, whether it may be used,
 * and what the owner is told. No DOM, no transport.
 */
import type { ApprovalRequestView, RunDetail } from '../shared/protocol.js';

/**
 * The complete approval request of the selected run's pending card, loaded only when the owner asks. It belongs to `key`
 * (run id, request id, reviewed revision and the displayed run version); whenever the card on screen no longer has that key
 * the slice is emptied, so details never describe another run, request, revision or version. Approval of a shortened card
 * is possible only while `status` is `loaded`.
 */
export interface ApprovalDetailsSlice {
  key: string | null;
  status: 'idle' | 'loading' | 'loaded' | 'error';
  /** The validated complete request; set only while `status` is `loaded`. */
  data: ApprovalRequestView | null;
  /** Digest of `data`'s content, sent with the approval so the service can compare it with a fresh complete read. */
  contentDigest: string | null;
  /** Fixed sentence when the complete request could not be loaded or did not match the card. */
  error: string | null;
}

export const EMPTY_APPROVAL_DETAILS: ApprovalDetailsSlice = { key: null, status: 'idle', data: null, contentDigest: null, error: null };

/**
 * What a complete request must be bound to: the pending approval wait of the loaded run detail, at the version drawn.
 * Null when the card has no pending approval request.
 */
export function approvalDetailsKey(detail: Pick<RunDetail, 'id' | 'wait' | 'version'> | null): string | null {
  const wait = detail?.wait ?? null;
  if (detail === null || wait === null || wait.kind !== 'approval' || wait.state !== 'pending') return null;
  return JSON.stringify([detail.id, wait.requestId, wait.revision.head, wait.revision.digest, detail.version]);
}

/** Whether the compact card leaves out part of the request, so it can be approved only after the complete one was loaded. */
export const approvalIsClipped = (detail: Pick<RunDetail, 'wait'> | null): boolean => {
  const wait = detail?.wait ?? null;
  return wait !== null && wait.kind === 'approval' && wait.clipped;
};

export const APPROVAL_DETAIL_NOTICES = {
  mismatch: 'The full request did not match this card (another run, request or revision), so it was not used. Approval stays off.',
} as const;

/**
 * Why a loaded request cannot be used for the card on screen, or null. It must be the same run, request, task and
 * reviewed revision, still pending, and the compact card's revision must be its (shortened) identity. A card whose revision
 * is unknown cannot be bound, so it never validates.
 */
export function completeRequestProblem(view: ApprovalRequestView, detail: Pick<RunDetail, 'id' | 'wait'>): string | null {
  const wait = detail.wait ?? null;
  if (wait === null || wait.kind !== 'approval' || wait.state !== 'pending') return APPROVAL_DETAIL_NOTICES.mismatch;
  if (view.runId !== detail.id || view.requestId !== wait.requestId || view.state !== 'pending' || view.taskId !== wait.taskId) return APPROVAL_DETAIL_NOTICES.mismatch;
  if (wait.revision.head === '' || wait.revision.digest === '') return APPROVAL_DETAIL_NOTICES.mismatch;
  if (view.revision.head.toLowerCase() !== wait.revision.head.toLowerCase() || !view.revision.digest.toLowerCase().startsWith(wait.revision.digest.toLowerCase())) return APPROVAL_DETAIL_NOTICES.mismatch;
  return null;
}
