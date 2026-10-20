import { APPROVAL_LIST_LIMIT, APPROVAL_PAYLOAD_LIMIT, APPROVAL_TEXT_LIMIT } from '../workflow/contracts.js';
import { PAUSE_RESPONSE_LIMIT } from './pause.js';

/**
 * The complete, read-only view of one approval request. Every text and list is the full recorded content, in order:
 * nothing is clipped here. Only text and data fields are present; acknowledgement internals, receipt digests,
 * checkpoints, keys and capabilities are never copied from the coordinator's answer.
 */
export interface ApprovalRequestView {
  requestId: string;
  runId: string;
  state: 'pending' | 'answered' | 'superseded';
  continuation: 'none' | 'pending' | 'queued' | 'consumed' | 'superseded';
  progress: 'none' | 'recorded' | 'waiting-for-idle' | 'queued' | 'executing' | 'consumed' | 'superseded';
  taskId: string;
  taskIndex: number;
  attemptId: string;
  /** The reviewed revision: full commit and content digest. */
  revision: { head: string; digest: string };
  question: string;
  scope: string;
  completedWork: string;
  verification: string[];
  artifacts: string[];
  onApprove: string[];
  onRequestChanges: string[];
  response: { decision: 'approve' | 'request-changes'; feedback: string | null; answeredAt: number } | null;
  createdAt: number;
}

/** Raised for an answer that is not a valid complete request view. The message is fixed text and never echoes the answer. */
export class InvalidApprovalAnswer extends Error {
  constructor(message: string) { super(message); this.name = 'InvalidApprovalAnswer'; }
}

const STATES = ['pending', 'answered', 'superseded'] as const;
const CONTINUATIONS = ['none', 'pending', 'queued', 'consumed', 'superseded'] as const;
const PROGRESSES = ['none', 'recorded', 'waiting-for-idle', 'queued', 'executing', 'consumed', 'superseded'] as const;
const TEXT_FIELDS = ['question', 'scope', 'completedWork'] as const;
const LIST_FIELDS = ['verification', 'artifacts', 'onApprove', 'onRequestChanges'] as const;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const HEX = /^[0-9a-f]{1,128}$/i;

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (what: string): never => { throw new InvalidApprovalAnswer(`${what} is missing or not valid`); };
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], name: string): T => (typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : invalid(name));
const count = (value: unknown, name: string): number => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : invalid(name));

/**
 * Validates the coordinator's answer to `GET /runs/:id/approvals/:requestId` against the run and request that were asked
 * for and the canonical request limits (text, list entries and payload), and returns a fresh object holding only the
 * view's fields. Any other shape fails with an `InvalidApprovalAnswer`: partial data is never returned.
 */
export function parseApprovalView(value: unknown, expected: { runId: string; requestId: string }): ApprovalRequestView {
  if (!isRecord(value)) return invalid('The answer');
  if (value.runId !== expected.runId) return invalid('The run id');
  if (value.requestId !== expected.requestId) return invalid('The request id');
  const request = value.request;
  if (!isRecord(request)) return invalid('The request content');
  const content: Record<string, string | string[]> = {};
  for (const field of TEXT_FIELDS) {
    const text = request[field];
    if (typeof text !== 'string' || text.length > APPROVAL_TEXT_LIMIT) return invalid(`The ${field} text`);
    content[field] = text;
  }
  for (const field of LIST_FIELDS) {
    const entries = request[field];
    if (!Array.isArray(entries) || entries.length > APPROVAL_LIST_LIMIT) return invalid(`The ${field} list`);
    for (const entry of entries) if (typeof entry !== 'string' || entry.length > APPROVAL_TEXT_LIMIT) return invalid(`An entry of the ${field} list`);
    content[field] = [...entries as string[]];
  }
  if (Buffer.byteLength(JSON.stringify(content), 'utf8') > APPROVAL_PAYLOAD_LIMIT) return invalid('The request size');
  const revision = value.revision;
  if (!isRecord(revision) || typeof revision.head !== 'string' || !HEX.test(revision.head) || typeof revision.digest !== 'string' || !HEX.test(revision.digest)) return invalid('The revision');
  const taskId = value.taskId;
  const attemptId = value.attemptId;
  if (typeof taskId !== 'string' || !taskId || taskId.length > 128) return invalid('The task id');
  if (typeof attemptId !== 'string' || !attemptId || attemptId.length > 128) return invalid('The attempt id');
  const state = oneOf(value.state, STATES, 'The state');
  let response: ApprovalRequestView['response'] = null;
  if (state === 'answered') {
    const decision = oneOf(value.decision, ['approve', 'request-changes'] as const, 'The decision');
    const feedback = value.feedback;
    if (feedback !== null && (typeof feedback !== 'string' || feedback.length > PAUSE_RESPONSE_LIMIT)) return invalid('The feedback');
    response = { decision, feedback: feedback ?? null, answeredAt: count(value.answeredAt, 'The answer time') };
  } else if (value.decision !== null && value.decision !== undefined) return invalid('The decision');
  return {
    requestId: expected.requestId,
    runId: expected.runId,
    state,
    continuation: oneOf(value.continuation, CONTINUATIONS, 'The continuation'),
    progress: oneOf(value.progress, PROGRESSES, 'The progress'),
    taskId,
    taskIndex: count(value.taskIndex, 'The task index'),
    attemptId,
    revision: { head: revision.head, digest: revision.digest },
    question: content.question as string,
    scope: content.scope as string,
    completedWork: content.completedWork as string,
    verification: content.verification as string[],
    artifacts: content.artifacts as string[],
    onApprove: content.onApprove as string[],
    onRequestChanges: content.onRequestChanges as string[],
    response,
    createdAt: count(value.createdAt, 'The creation time'),
  };
}

/** Whether an identifier may be sent to the coordinator as a run or request id. */
export const validApprovalIdentifier = (value: unknown): value is string => typeof value === 'string' && IDENTIFIER.test(value);
