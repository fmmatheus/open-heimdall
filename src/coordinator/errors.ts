/** Stable machine-readable reasons for a refused approval operation. */
export type CoordinatorErrorCode =
  /** The request or response contradicts what is already recorded (a different decision, an answered or foreign request). */
  | 'approval-conflict'
  /** The reviewed material or its checkpoint moved on; the request is superseded and cannot be answered. */
  | 'approval-stale'
  /** A generic operation would bypass an unresolved approval request or an unconsumed owner decision. */
  | 'approval-pending'
  | 'approval-not-found';

/**
 * A refusal that clients are meant to distinguish. The service maps it to its status and `code`; any other error keeps the
 * service's generic 400 response.
 */
export class CoordinatorError extends Error {
  readonly status: number;
  readonly code: CoordinatorErrorCode;
  constructor(status: 404 | 409, code: CoordinatorErrorCode, message: string) {
    super(message);
    this.name = 'CoordinatorError';
    this.status = status;
    this.code = code;
  }
}
