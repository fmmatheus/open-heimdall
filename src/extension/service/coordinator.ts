import { createCoordinatorClient } from '../../coordinator/client.js';
import { loadCoordinatorConfiguration } from '../../coordinator/config.js';
import type { CoordinatorConfiguration } from '../../coordinator/config.js';
import { readCoordinatorToken } from '../../coordinator/token.js';
import type { CoordinatorEvent, ProjectRecord, RunRecord } from '../../coordinator/types.js';
import type { ApprovalWait } from '../../coordinator/types.js';
import type { GenericWait } from '../../coordinator/pause.js';
import type { RunListEntry, RunListPage } from '../../coordinator/run-list.js';

export type PublicRun = Omit<RunRecord, 'ownerToken' | 'specification' | 'binding'> & { settings: unknown; wait?: ApprovalWait | GenericWait | null };

/** The two owner responses the panel may send. Bodies are validated by the routes before they reach the adapter. */
export interface ApprovalDecisionBody { decision: 'approve' | 'request-changes'; feedback?: string }
export interface PauseResponseBody { pauseId: string; input: string }

export type AdapterErrorKind =
  | 'coordinator-offline'
  | 'coordinator-unauthorized'
  | 'coordinator-timeout'
  | 'coordinator-response-too-large'
  | 'coordinator-incompatible'
  | 'configuration-invalid'
  | 'not-found'
  | 'coordinator-error'
  /** A response was sent and no answer arrived: it may or may not have been recorded. */
  | 'delivery-uncertain'
  | 'stale-card'
  | 'approval-stale'
  | 'approval-conflict'
  | 'approval-pending'
  | 'pause-stale'
  | 'pause-not-ready'
  | 'response-conflict'
  | 'response-refused'
  | 'coordinator-unsupported'
  | 'coordinator-draining';

/** Fixed texts: nothing from the underlying failure (paths, keys, headers, stacks) reaches the panel. */
const MESSAGES: Record<AdapterErrorKind, string> = {
  'coordinator-offline': 'The Heimdall coordinator could not be reached.',
  'coordinator-unauthorized': 'The Heimdall coordinator rejected the access key.',
  'coordinator-timeout': 'The Heimdall coordinator did not answer in time.',
  'coordinator-response-too-large': 'The Heimdall coordinator response is too large to load.',
  'coordinator-incompatible': 'The Heimdall coordinator does not support this runs list.',
  'configuration-invalid': 'The Heimdall coordinator configuration or access key is invalid.',
  'not-found': 'The requested Heimdall record was not found.',
  'coordinator-error': 'The Heimdall coordinator could not complete the request.',
  'delivery-uncertain': 'The coordinator did not confirm the response. It may or may not have been recorded; check the run before sending it again.',
  'stale-card': 'The run changed since this card was shown. Nothing was sent; refresh to see the current request.',
  'approval-stale': 'This request is no longer current: the run or the reviewed material changed. Nothing was recorded.',
  'approval-conflict': 'A different decision was already recorded for this request.',
  'approval-pending': 'This run waits on an approval request; answer that request instead. Nothing was recorded.',
  'pause-stale': 'The run has paused again since this card was shown. Nothing was recorded.',
  'pause-not-ready': 'The run is not ready to continue yet (it must be paused, released and idle). Nothing was recorded.',
  'response-conflict': 'Different guidance was already recorded for this pause.',
  'response-refused': 'The coordinator refused the response. Nothing was recorded.',
  'coordinator-unsupported': 'The Heimdall coordinator does not support owner responses (likely an older version). Nothing was sent.',
  'coordinator-draining': 'The Heimdall coordinator is draining and does not accept responses. Nothing was recorded.',
};

export class CoordinatorAdapterError extends Error {
  readonly kind: AdapterErrorKind;
  constructor(kind: AdapterErrorKind) {
    super(MESSAGES[kind]);
    this.name = 'CoordinatorAdapterError';
    this.kind = kind;
  }
}

export const adapterErrorMessage = (kind: AdapterErrorKind): string => MESSAGES[kind];

/** The coordinator client as used here: GET for everything, and POST only for the two response routes built below. */
export interface ReadClient {
  request(method: string, route: string, body?: unknown): Promise<unknown>;
}

export interface CoordinatorAdapterOptions {
  configPath?: string;
  loadConfiguration?: (configPath?: string) => Promise<CoordinatorConfiguration>;
  readToken?: (stateDirectory: string) => Promise<string>;
  clientFactory?: (endpoint: string, token: string, options: { timeoutMs: number }) => ReadClient;
  timeoutMs?: number;
}

export interface CoordinatorAdapter {
  /** The one approval write: the coordinator's decision operation for exactly this run and request. */
  decideApproval(runId: string, requestId: string, body: ApprovalDecisionBody): Promise<unknown>;
  /** The other write: the coordinator's guarded response to exactly this pause. */
  respondToPause(runId: string, body: PauseResponseBody): Promise<unknown>;
  projects(): Promise<ProjectRecord[]>;
  runs(): Promise<Array<PublicRun | RunListEntry>>;
  run(id: string): Promise<PublicRun>;
  events(after: number): Promise<CoordinatorEvent[]>;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Connection failures that happen before anything was written to the coordinator. */
const NOT_SENT = new Set(['ENOENT', 'ECONNREFUSED', 'EACCES', 'EPERM', 'ENOTSOCK']);

/**
 * Maps the failure of a response request to a fixed kind. The coordinator's own text is never relayed. A refusal that
 * carries a status means nothing was recorded; a failure with no answer after the request was written is uncertain.
 */
function classifyWrite(error: unknown): AdapterErrorKind {
  if (error instanceof CoordinatorAdapterError) return error.kind;
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : '';
  if (typeof status === 'number') {
    if (status === 401 || status === 403) return 'coordinator-unauthorized';
    if (status === 404) return /^Unknown coordinator route$/.test(message) ? 'coordinator-unsupported' : 'not-found';
    if (status === 503) return /draining/i.test(message) ? 'coordinator-draining' : 'coordinator-offline';
    if (status === 409 && typeof code === 'string') {
      if (code === 'approval-stale' || code === 'approval-conflict' || code === 'approval-pending' || code === 'pause-stale' || code === 'pause-not-ready' || code === 'response-conflict') return code;
    }
    if (status === 400 || status === 409) return 'response-refused';
    return 'coordinator-error';
  }
  if (typeof code === 'string' && NOT_SENT.has(code)) return 'coordinator-offline';
  // Written (or possibly written) with no answer: timeouts, resets and unreadable answers.
  return 'delivery-uncertain';
}

function classify(error: unknown): AdapterErrorKind {
  if (error instanceof CoordinatorAdapterError) return error.kind;
  const message = error instanceof Error ? error.message : '';
  const code = (error as { code?: unknown } | null)?.code;
  if ((error as { statusCode?: unknown } | null)?.statusCode === 404) return 'not-found';
  // Older clients wrapped local response failures as “unavailable”; they do not establish coordinator liveness.
  if (code === 'response-too-large' || /Coordinator response is too large/i.test(message)) return 'coordinator-response-too-large';
  if (/timed out/i.test(message)) return 'coordinator-timeout';
  if (/^Coordinator unavailable/i.test(message)) return 'coordinator-offline';
  if (/authorization required|cannot administer/i.test(message)) return 'coordinator-unauthorized';
  if (/not found/i.test(message)) return 'not-found';
  return 'coordinator-error';
}

export function createCoordinatorAdapter(options: CoordinatorAdapterOptions = {}): CoordinatorAdapter {
  const loadConfiguration = options.loadConfiguration ?? loadCoordinatorConfiguration;
  const readToken = options.readToken ?? readCoordinatorToken;
  const clientFactory = options.clientFactory ?? ((endpoint, token, clientOptions) => createCoordinatorClient(endpoint, token, clientOptions));
  const timeoutMs = options.timeoutMs ?? 8000;
  let client: ReadClient | undefined;

  /** Configuration and key are read lazily and dropped after any failure so a restarted coordinator is picked up. */
  async function connect(): Promise<ReadClient> {
    if (client) return client;
    let configuration: CoordinatorConfiguration;
    try { configuration = await loadConfiguration(options.configPath); }
    catch { throw new CoordinatorAdapterError('configuration-invalid'); }
    let token: string;
    try { token = await readToken(configuration.stateDirectory); }
    catch (error) {
      // No key yet means the coordinator has never started in this state directory.
      throw new CoordinatorAdapterError((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ? 'coordinator-offline' : 'configuration-invalid');
    }
    client = clientFactory(configuration.endpoint, token, { timeoutMs });
    return client;
  }

  async function get<T>(route: string): Promise<T> {
    try {
      return await (await connect()).request('GET', route) as T;
    } catch (error) {
      const kind = classify(error);
      if (kind !== 'not-found') client = undefined;
      throw new CoordinatorAdapterError(kind);
    }
  }

  /** The only POST: callers pass a route built from validated identifiers and a body already validated by the route. */
  async function post(route: string, body: unknown): Promise<unknown> {
    try {
      return await (await connect()).request('POST', route, body);
    } catch (error) {
      const kind = classifyWrite(error);
      // A refusal means the connection is fine; anything else may mean a restarted coordinator.
      if (!['stale-card', 'approval-stale', 'approval-conflict', 'approval-pending', 'pause-stale', 'pause-not-ready', 'response-conflict', 'response-refused', 'not-found', 'coordinator-unsupported', 'coordinator-draining'].includes(kind)) client = undefined;
      throw new CoordinatorAdapterError(kind);
    }
  }

  return {
    decideApproval(runId, requestId, body) {
      if (!IDENTIFIER.test(runId) || !IDENTIFIER.test(requestId)) return Promise.reject(new CoordinatorAdapterError('not-found'));
      return post(`/runs/${runId}/approvals/${requestId}/decision`, body.decision === 'approve' ? { decision: 'approve' } : { decision: 'request-changes', feedback: body.feedback });
    },
    respondToPause(runId, body) {
      if (!IDENTIFIER.test(runId) || !IDENTIFIER.test(body.pauseId)) return Promise.reject(new CoordinatorAdapterError('not-found'));
      return post(`/runs/${runId}/respond`, { pauseId: body.pauseId, input: body.input });
    },
    projects: () => get<ProjectRecord[]>('/projects'),
    async runs() {
      const runs: RunListEntry[] = [];
      let after = 0;
      let through: number | undefined;
      do {
        let page: RunListPage;
        try { page = await get<RunListPage>(`/run-list?after=${after}${through === undefined ? '' : `&through=${through}`}`); }
        catch (error) {
          if (error instanceof CoordinatorAdapterError && error.kind === 'not-found') throw new CoordinatorAdapterError('coordinator-incompatible');
          throw error;
        }
        if (!page || !Array.isArray(page.runs) || !Number.isSafeInteger(page.through) || page.through < 0
          || (through !== undefined && page.through !== through)
          || (page.nextCursor !== null && (!Number.isSafeInteger(page.nextCursor) || page.nextCursor <= after || page.nextCursor > page.through))) {
          throw new CoordinatorAdapterError('coordinator-error');
        }
        runs.push(...page.runs);
        through = page.through;
        if (page.nextCursor === null) return runs;
        after = page.nextCursor;
      } while (true);
    },
    run(id: string) {
      if (typeof id !== 'string' || !IDENTIFIER.test(id)) return Promise.reject(new CoordinatorAdapterError('not-found'));
      return get<PublicRun>(`/runs/${id}`);
    },
    events(after: number) {
      if (!Number.isSafeInteger(after) || after < 0) return Promise.reject(new CoordinatorAdapterError('coordinator-error'));
      return get<CoordinatorEvent[]>(`/events?after=${after}`);
    },
  };
}
