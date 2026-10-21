import { InvalidApprovalAnswer, parseApprovalView, validApprovalIdentifier } from './approval-view.js';
import type { ApprovalRequestView } from './approval-view.js';

export interface ApprovalReadRequest { runId: string; requestId: string }

const usage = 'Usage:\n  heimdall coordinator run approval RUN_ID --request REQUEST_ID';

function fail(message: string): never { throw new Error(`${message}\n${usage}`); }

/**
 * Validates the arguments of `run approval` completely before the configuration is read or anything is contacted:
 * both identifiers are required and well formed. Other options are rejected by the caller.
 */
export function parseApprovalReadArguments(runId: string | undefined, options: ReadonlyMap<string, string>): ApprovalReadRequest {
  if (!validApprovalIdentifier(runId)) return fail('run approval requires a valid RUN_ID');
  const requestId = options.get('--request');
  if (requestId === undefined) return fail('run approval requires --request REQUEST_ID');
  if (!validApprovalIdentifier(requestId)) return fail('--request must be a valid REQUEST_ID');
  return { runId, requestId };
}

interface Client { request(method: string, route: string, body?: unknown): Promise<unknown> }

/**
 * Reads one complete approval request: a single authenticated GET that changes nothing. The answer is validated against the
 * run and request asked for and the canonical request limits before it is returned. A request the coordinator does not
 * have, a coordinator without the route (an older version), a refused key and an invalid answer are told apart. Every
 * failure is an ordinary error (exit status 1): a read has no uncertain outcome.
 */
export async function readApproval(client: Client, endpoint: string, request: ApprovalReadRequest): Promise<ApprovalRequestView> {
  const route = `/runs/${encodeURIComponent(request.runId)}/approvals/${encodeURIComponent(request.requestId)}`;
  let answer: unknown;
  try { answer = await client.request('GET', route); }
  catch (error) {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    const code = (error as { code?: unknown }).code;
    const message = error instanceof Error ? error.message : 'unknown error';
    if (typeof statusCode === 'number') {
      if (statusCode === 404 && message === 'Unknown coordinator route') {
        throw new Error(`The coordinator at ${endpoint} does not support reading an approval request (likely an older version). Nothing was changed.`);
      }
      if (statusCode === 404 && code === 'approval-not-found') throw new Error(`The coordinator at ${endpoint} has no approval request ${request.requestId} for run ${request.runId}. Check the identifiers with "heimdall coordinator run show ${request.runId}".`);
      if (statusCode === 404) throw new Error(`The coordinator at ${endpoint} does not know run ${request.runId}.`);
      if (statusCode === 401 || statusCode === 403) throw new Error(`The coordinator at ${endpoint} refused authorization to read the approval request; check the coordinator key.`);
      const detail = typeof code === 'string' ? ` (${statusCode} ${code})` : ` (${statusCode})`;
      throw new Error(`The coordinator refused to return the approval request${detail}: ${message}.`);
    }
    throw new Error(`The approval request could not be read from the coordinator at ${endpoint}: ${message}.`);
  }
  try { return parseApprovalView(answer, request); }
  catch (error) {
    if (error instanceof InvalidApprovalAnswer) throw new Error(`The coordinator at ${endpoint} returned an invalid approval request: ${error.message}. Nothing is shown from it.`);
    throw error;
  }
}
