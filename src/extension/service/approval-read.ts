import { parseApprovalView } from '../../coordinator/approval-view.js';
import type { ApprovalRequestView } from '../shared/protocol.js';
import { CoordinatorAdapterError } from './coordinator.js';
import type { CoordinatorAdapter } from './coordinator.js';
import { cleanText } from './projection.js';

/**
 * One approval request with all of its recorded content: read from the coordinator, validated against the canonical
 * request limits and projected to text and data. An answer that does not validate is never used, even in part. Shared by
 * the read route and by the approval route, which re-reads the request before it accepts a decision on a shortened card.
 */
export async function readCompleteApproval(adapter: CoordinatorAdapter, runId: string, requestId: string): Promise<ApprovalRequestView> {
  const answer = await adapter.approval(runId, requestId);
  let view;
  try { view = parseApprovalView(answer, { runId, requestId }); }
  catch { throw new CoordinatorAdapterError('approval-unreadable'); }
  const lines = (entries: string[]) => entries.map(cleanText);
  return {
    ...view,
    taskId: cleanText(view.taskId),
    attemptId: cleanText(view.attemptId),
    question: cleanText(view.question),
    scope: cleanText(view.scope),
    completedWork: cleanText(view.completedWork),
    verification: lines(view.verification),
    artifacts: lines(view.artifacts),
    onApprove: lines(view.onApprove),
    onRequestChanges: lines(view.onRequestChanges),
    response: view.response === null ? null : { ...view.response, feedback: view.response.feedback === null ? null : cleanText(view.response.feedback) },
  };
}
