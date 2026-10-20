import { APPROVAL_LIMITS, RUN_STATUSES } from '../shared/protocol.js';
import type {
  ApprovalContinuation, ApprovalDecisionAck, ApprovalDecisionResponse, PauseResponseAck, PauseResponseResponse, ResponseAck, WireRunStatus,
} from '../shared/protocol.js';
import { CONTENT_DIGEST, approvalContentDigest } from '../shared/approval-digest.js';
import type { ReviewedBinding } from '../shared/approval-digest.js';
import { readCompleteApproval } from './approval-read.js';
import type { CoordinatorAdapter } from './coordinator.js';
import { HttpError } from './server.js';
import type { Route } from './server.js';

/*
 * The only two writes of the extension. Each forwards exactly one owner response to the same coordinator operation the
 * CLI uses (`run respond`), after checking that the card the owner clicked still describes the run. Nothing here
 * pauses, stops, cancels, reconciles or resumes a run, and no route accepts a method, path or run capability from the caller.
 */

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CONTINUATIONS: readonly string[] = ['none', 'pending', 'queued', 'consumed', 'superseded'];

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const bad = (message: string): never => { throw new HttpError(400, 'invalid-request', message); };

/** Exactly the allowed keys, so a body cannot carry fields the coordinator would later learn to honour. */
function exactKeys(body: Record<string, unknown>, allowed: readonly string[]): void {
  for (const key of Object.keys(body)) if (!allowed.includes(key)) bad(`The field ${key.slice(0, 40)} is not accepted.`);
}

function displayedVersion(body: Record<string, unknown>): number {
  const value = body.displayedVersion;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return bad('displayedVersion must be a whole number.');
  return value;
}

function boundedInput(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') return bad(`${name} must not be empty.`);
  if (value.length > APPROVAL_LIMITS.input) return bad(`${name} may have at most ${APPROVAL_LIMITS.input} characters.`);
  return value;
}

export interface DecisionRequest { decision: 'approve' | 'request-changes'; feedback?: string; displayedVersion: number; reviewed?: ReviewedBinding }
export interface PauseRequest { pauseId: string; input: string; displayedVersion: number }

const HEX = /^[0-9a-f]{1,128}$/i;

/** The reviewed material an approval of a shortened card names: exactly its request, revision and content digest. */
function reviewedBinding(value: unknown): ReviewedBinding {
  if (!isRecord(value)) return bad('reviewed must be an object.');
  exactKeys(value, ['requestId', 'revision', 'contentDigest']);
  const { requestId, revision, contentDigest } = value;
  if (typeof requestId !== 'string' || !IDENTIFIER.test(requestId)) return bad('reviewed.requestId is not valid.');
  if (!isRecord(revision)) return bad('reviewed.revision must be an object.');
  exactKeys(revision, ['head', 'digest']);
  if (typeof revision.head !== 'string' || !HEX.test(revision.head) || typeof revision.digest !== 'string' || !HEX.test(revision.digest)) return bad('reviewed.revision is not valid.');
  if (typeof contentDigest !== 'string' || !CONTENT_DIGEST.test(contentDigest)) return bad('reviewed.contentDigest is not valid.');
  return { requestId, revision: { head: revision.head, digest: revision.digest }, contentDigest };
}

export function parseDecisionRequest(body: unknown): DecisionRequest {
  if (!isRecord(body)) return bad('The request body must be an object.');
  exactKeys(body, ['decision', 'feedback', 'displayedVersion', 'reviewed']);
  const version = displayedVersion(body);
  if (body.decision === 'approve') {
    if (body.feedback !== undefined) return bad('Approving takes no feedback.');
    if (body.reviewed !== undefined) return { decision: 'approve', displayedVersion: version, reviewed: reviewedBinding(body.reviewed) };
    return { decision: 'approve', displayedVersion: version };
  }
  if (body.reviewed !== undefined) return bad('Requesting changes takes no reviewed material.');
  if (body.decision === 'request-changes') return { decision: 'request-changes', feedback: boundedInput(body.feedback, 'feedback'), displayedVersion: version };
  return bad('decision must be approve or request-changes.');
}

export function parsePauseRequest(body: unknown): PauseRequest {
  if (!isRecord(body)) return bad('The request body must be an object.');
  exactKeys(body, ['pauseId', 'input', 'displayedVersion']);
  const version = displayedVersion(body);
  if (typeof body.pauseId !== 'string' || !IDENTIFIER.test(body.pauseId)) return bad('pauseId is not valid.');
  return { pauseId: body.pauseId, input: boundedInput(body.input, 'input'), displayedVersion: version };
}

/** An answer the panel cannot read means the response may have been recorded: say so instead of guessing. */
function unreadable(): never { throw new HttpError(502, 'delivery-uncertain'); }

function readAck(value: unknown, runId: string): ResponseAck {
  if (!isRecord(value) || value.runId !== runId || typeof value.retried !== 'boolean') return unreadable();
  const recordedAt = value.recordedAt;
  const continuation = value.continuation;
  const run = value.run;
  if (typeof recordedAt !== 'number' || !Number.isFinite(recordedAt) || typeof continuation !== 'string' || !CONTINUATIONS.includes(continuation)) return unreadable();
  if (!isRecord(run) || typeof run.status !== 'string' || !(RUN_STATUSES as readonly string[]).includes(run.status) || typeof run.version !== 'number' || !Number.isSafeInteger(run.version)) return unreadable();
  return {
    runId,
    recordedAt,
    retried: value.retried,
    continuation: continuation as ApprovalContinuation,
    run: { status: run.status as WireRunStatus, version: run.version },
  };
}

const CONTENT_FIELDS = ['question', 'scope', 'completedWork', 'verification', 'artifacts', 'onApprove', 'onRequestChanges'] as const;

/**
 * Whether the compact request the coordinator reported for this wait leaves out any of the content: a clipping flag, or a
 * text, entry or list over the compact limits (an older coordinator reports no flags).
 */
function compactIsClipped(wait: Record<string, unknown>): boolean {
  const flags = isRecord(wait.clipped) ? wait.clipped : {};
  if (CONTENT_FIELDS.some(field => flags[field] === true)) return true;
  return CONTENT_FIELDS.some(field => {
    const value = wait[field];
    if (typeof value === 'string') return value.length > APPROVAL_LIMITS.text;
    return Array.isArray(value) && (value.length > APPROVAL_LIMITS.entries || value.some(entry => typeof entry === 'string' && entry.length > APPROVAL_LIMITS.entry));
  });
}

const same = (a: { head: string; digest: string }, b: { head: string; digest: string }): boolean => a.head.toLowerCase() === b.head.toLowerCase() && a.digest.toLowerCase() === b.digest.toLowerCase();

export function actionRoutes(options: { adapter: CoordinatorAdapter; now?: () => Date }): Route[] {
  const { adapter } = options;
  const now = options.now ?? (() => new Date());

  /** The card must still describe the run: same version, same pending target. Otherwise nothing is sent. */
  async function current(runId: string, shown: number) {
    const run = await adapter.run(runId);
    if (run.version !== shown) throw new HttpError(409, 'stale-card');
    return isRecord(run.wait) ? run.wait : null;
  }

  return [
    {
      method: 'POST', path: '/runs/:id/approvals/:requestId/decision', body: { maxBytes: APPROVAL_LIMITS.bodyBytes },
      async handler({ params, body }): Promise<ApprovalDecisionResponse> {
        const runId = params.id!;
        const requestId = params.requestId!;
        // Rejected before the coordinator is consulted.
        if (!IDENTIFIER.test(runId) || !IDENTIFIER.test(requestId)) throw new HttpError(404, 'not-found', 'No such Heimdall run or request.');
        const request = parseDecisionRequest(body);
        const wait = await current(runId, request.displayedVersion);
        if (!wait || wait.kind !== 'approval' || wait.requestId !== requestId || wait.state !== 'pending') throw new HttpError(409, 'stale-card');
        // An approval of a shortened card must name the complete request that was reviewed; the coordinator's current copy is
        // read again and has to match it exactly. A binding sent for an unshortened card is checked the same way.
        if (request.decision === 'approve' && (request.reviewed !== undefined || compactIsClipped(wait))) {
          if (request.reviewed === undefined) throw new HttpError(409, 'review-required');
          const complete = await readCompleteApproval(adapter, runId, requestId);
          const reviewed = request.reviewed;
          const raw = isRecord(wait.revision) ? wait.revision : null;
          if (complete.state !== 'pending' || reviewed.requestId !== requestId || !same(reviewed.revision, complete.revision)
            || (raw !== null && typeof raw.head === 'string' && typeof raw.digest === 'string' && !same({ head: raw.head, digest: raw.digest }, complete.revision))
            || reviewed.contentDigest !== await approvalContentDigest(complete)) throw new HttpError(409, 'review-mismatch');
        }
        const answer = await adapter.decideApproval(runId, requestId, request.decision === 'approve' ? { decision: 'approve' } : { decision: 'request-changes', feedback: request.feedback });
        const ack = readAck(answer, runId);
        const record = answer as Record<string, unknown>;
        if (record.requestId !== requestId || record.decision !== request.decision) unreadable();
        const result: ApprovalDecisionAck = { ...ack, requestId, decision: request.decision };
        return { ack: result, fetchedAt: now().toISOString() };
      },
    },
    {
      method: 'POST', path: '/runs/:id/pause-response', body: { maxBytes: APPROVAL_LIMITS.bodyBytes },
      async handler({ params, body }): Promise<PauseResponseResponse> {
        const runId = params.id!;
        if (!IDENTIFIER.test(runId)) throw new HttpError(404, 'not-found', 'No such Heimdall run.');
        const request = parsePauseRequest(body);
        const wait = await current(runId, request.displayedVersion);
        if (!wait || wait.kind !== 'generic' || wait.pauseId !== request.pauseId) throw new HttpError(409, 'stale-card');
        const answer = await adapter.respondToPause(runId, { pauseId: request.pauseId, input: request.input });
        const ack = readAck(answer, runId);
        if ((answer as Record<string, unknown>).pauseId !== request.pauseId) unreadable();
        const result: PauseResponseAck = { ...ack, pauseId: request.pauseId };
        return { ack: result, fetchedAt: now().toISOString() };
      },
    },
  ];
}
