import { PAUSE_RESPONSE_LIMIT } from './pause.js';

/** Exit status of `run respond` when the request may or may not have reached the coordinator. */
export const RESPOND_UNCERTAIN_EXIT_STATUS = 2;
/** The longest feedback or guidance the coordinator accepts. */
export const RESPOND_INPUT_LIMIT = PAUSE_RESPONSE_LIMIT;

export type RespondRequest =
  | { kind: 'decision'; runId: string; requestId: string; decision: 'approve' | 'request-changes'; feedback?: string }
  | { kind: 'pause'; runId: string; pauseId: string; input: string };

/** Raised after a request that may have been applied: the outcome must be read from the coordinator, not guessed. */
export class UncertainDeliveryError extends Error {
  readonly exitCode = RESPOND_UNCERTAIN_EXIT_STATUS;
  constructor(message: string) { super(message); this.name = 'UncertainDeliveryError'; }
}

const identifier = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const usage = 'Usage:\n'
  + '  heimdall coordinator run respond RUN_ID --request REQUEST_ID --decision approve\n'
  + '  heimdall coordinator run respond RUN_ID --request REQUEST_ID --decision request-changes --input FEEDBACK\n'
  + '  heimdall coordinator run respond RUN_ID --pause PAUSE_ID --input GUIDANCE';

function fail(message: string): never { throw new Error(`${message}\n${usage}`); }

/**
 * Validates the arguments of `run respond` completely before anything is contacted. Never guesses between a request and a
 * pause, never prompts, and never infers a missing decision.
 */
export function parseRespondArguments(runId: string | undefined, options: ReadonlyMap<string, string>): RespondRequest {
  if (!runId || !identifier.test(runId)) fail('run respond requires a valid RUN_ID');
  const request = options.get('--request');
  const pause = options.get('--pause');
  const decision = options.get('--decision');
  const input = options.get('--input');
  if (request !== undefined && pause !== undefined) fail('Choose one target: --request REQUEST_ID for an approval request or --pause PAUSE_ID for a generic pause, not both');
  if (request === undefined && pause === undefined) fail('run respond requires --request REQUEST_ID (approval request) or --pause PAUSE_ID (generic pause)');
  const text = (name: string, value: string): string => {
    if (!value.trim()) fail(`${name} must not be blank`);
    if (value.length > RESPOND_INPUT_LIMIT) fail(`${name} exceeds ${RESPOND_INPUT_LIMIT} characters`);
    return value;
  };
  if (request !== undefined) {
    if (!identifier.test(request)) fail('--request must be a valid REQUEST_ID');
    if (decision === undefined) fail('--request requires --decision approve or --decision request-changes');
    if (decision !== 'approve' && decision !== 'request-changes') fail('--decision must be approve or request-changes');
    if (decision === 'approve') {
      if (input !== undefined) fail('Approving takes no --input; use --decision request-changes to send feedback');
      return { kind: 'decision', runId, requestId: request, decision };
    }
    if (input === undefined) fail('--decision request-changes requires --input FEEDBACK');
    return { kind: 'decision', runId, requestId: request, decision, feedback: text('--input', input) };
  }
  if (decision !== undefined) fail('--decision applies to --request only; a generic pause takes --input GUIDANCE');
  if (!identifier.test(pause!)) fail('--pause must be a valid PAUSE_ID');
  if (input === undefined) fail('--pause requires --input GUIDANCE');
  return { kind: 'pause', runId, pauseId: pause!, input: text('--input', input) };
}

interface Client { request(method: string, route: string, body?: unknown): Promise<unknown> }

/** Failures that happen before a request reaches the coordinator: nothing was sent and nothing was applied. */
const NOT_SENT = new Set(['ENOENT', 'ECONNREFUSED', 'EACCES', 'EPERM', 'ENOTSOCK']);

/**
 * Sends one response and returns the coordinator's acknowledgement. A refusal (the coordinator answered with a status) is an
 * ordinary error and means nothing was recorded. A failure after the request was written, with no answer, is uncertain and
 * is reported with how to find the outcome. A 404 for an unknown route means an older coordinator: it is reported as
 * unsupported and the run is never resumed through the unguarded operation.
 */
export async function sendResponse(client: Client, endpoint: string, response: RespondRequest): Promise<unknown> {
  const run = encodeURIComponent(response.runId);
  const [route, body] = response.kind === 'decision'
    ? [`/runs/${run}/approvals/${encodeURIComponent(response.requestId)}/decision`, response.decision === 'approve' ? { decision: 'approve' } : { decision: 'request-changes', feedback: response.feedback }]
    : [`/runs/${run}/respond`, { pauseId: response.pauseId, input: response.input }];
  try { return await client.request('POST', route, body); }
  catch (error) {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    const code = (error as { code?: unknown }).code;
    const message = error instanceof Error ? error.message : 'unknown error';
    if (typeof statusCode === 'number') {
      if (statusCode === 404 && message === 'Unknown coordinator route') {
        throw new Error(`The coordinator at ${endpoint} does not support this response operation (likely an older version). Nothing was sent to resume the run; Heimdall does not fall back to the unguarded "run resume".`);
      }
      if (statusCode === 401 || statusCode === 403) throw new Error(`The coordinator at ${endpoint} refused authorization; check the coordinator key. Nothing was recorded.`);
      const detail = typeof code === 'string' ? ` (${statusCode} ${code})` : ` (${statusCode})`;
      throw new Error(`The coordinator refused the response${detail}: ${message}. Nothing was recorded.`);
    }
    if (typeof code === 'string' && NOT_SENT.has(code)) throw new Error(`The coordinator at ${endpoint} is unavailable: ${message}. Nothing was sent.`);
    throw new UncertainDeliveryError(
      `The response may or may not have been recorded: ${message}. Do not retry blindly. Inspect the run with "heimdall coordinator run show ${response.runId}" `
      + 'to see whether the response was recorded and how the run continues. An identical retry is answered from the stored record and is never applied twice, but inspect first.',
    );
  }
}
