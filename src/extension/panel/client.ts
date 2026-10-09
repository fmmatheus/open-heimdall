import { RUN_STATUSES } from '../shared/protocol.js';
import type { ChangeFeed, ProjectsResponse, RunResponse, RunsResponse, WireRunStatus } from '../shared/protocol.js';

/** The slice of the SDK host the panel uses; injectable so tests can record every request. */
export interface PanelHost {
  serviceRequest(request: { method: 'GET'; path: string; query?: Record<string, string> }): Promise<{ status: number; body: string }>;
  serviceStatus(): Promise<{ status: string }>;
}

export const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The only service routes the panel may request. All are GET. */
const FIXED_PATHS = new Set(['/projects', '/runs', '/changes']);
const RUN_PATH = /^\/runs\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isAllowedPath(path: string): boolean {
  return FIXED_PATHS.has(path) || RUN_PATH.test(path);
}

/**
 * `offline`: the coordinator (or the host link) is not answering; keep retrying.
 * `service-unavailable`: the extension service cannot serve requests until the user changes something.
 * `request`: this one request was refused; the connection itself is fine.
 */
export type FailureCategory = 'offline' | 'service-unavailable' | 'request';

export class PanelError extends Error {
  constructor(
    readonly category: FailureCategory,
    /** Host error code or service error kind; fixed vocabulary, never raw response text. */
    readonly code: string,
    message: string,
    readonly hint: string | null,
  ) {
    super(message);
    this.name = 'PanelError';
  }
}

interface Mapped { category: FailureCategory; message: string; hint: string | null }

const SETTINGS_HINT = 'Allow the local service in Settings → Extensions.';
const START_COORDINATOR_HINT = 'Start the Heimdall coordinator: heimdall coordinator serve';

const HOST_ERRORS: Record<string, Mapped> = {
  NO_SERVICE: { category: 'service-unavailable', message: 'The Heimdall extension service is not installed or not built.', hint: 'Reinstall the extension from Settings → Extensions.' },
  SERVICE_FAILED: { category: 'service-unavailable', message: 'The Heimdall extension service failed to start or stopped.', hint: 'Restart it from Settings → Extensions, then retry.' },
  REQUEST_FAILED: { category: 'service-unavailable', message: 'The Heimdall extension service could not complete the request.', hint: 'Restart it from Settings → Extensions, then retry.' },
  DISABLED: { category: 'service-unavailable', message: 'The Heimdall extension is disabled.', hint: 'Enable Heimdall in Settings → Extensions.' },
  NOT_GRANTED: { category: 'service-unavailable', message: 'The Heimdall extension service has not been allowed to run.', hint: SETTINGS_HINT },
  HOST_TIMEOUT: { category: 'offline', message: 'The Heimdall service did not answer in time.', hint: 'It will retry automatically.' },
  HOST_UNAVAILABLE: { category: 'offline', message: 'OpenChamber could not be reached.', hint: 'It will retry automatically.' },
};

const SERVICE_ERRORS: Record<string, Mapped> = {
  'coordinator-offline': { category: 'offline', message: 'The Heimdall coordinator is not running.', hint: START_COORDINATOR_HINT },
  'coordinator-unauthorized': { category: 'offline', message: 'The Heimdall coordinator refused the service credentials.', hint: 'Restart the coordinator: heimdall coordinator serve' },
  'coordinator-timeout': { category: 'offline', message: 'The Heimdall coordinator did not answer in time.', hint: 'It will retry automatically.' },
  'configuration-invalid': { category: 'service-unavailable', message: 'The Heimdall coordinator configuration is not valid.', hint: 'Check ~/.config/heimdall/coordinator.toml, then retry.' },
  'not-found': { category: 'request', message: 'That Heimdall item no longer exists.', hint: null },
  'invalid-request': { category: 'request', message: 'The Heimdall service rejected the request.', hint: null },
  'coordinator-error': { category: 'offline', message: 'The Heimdall coordinator reported an error.', hint: 'It will retry automatically.' },
};

const GENERIC_HOST: Mapped = { category: 'offline', message: 'The Heimdall service request failed.', hint: 'It will retry automatically.' };
const GENERIC_SERVICE: Mapped = { category: 'service-unavailable', message: 'The Heimdall service returned an unexpected error.', hint: 'Restart it from Settings → Extensions, then retry.' };
const BAD_RESPONSE: Mapped = { category: 'service-unavailable', message: 'The Heimdall service sent an unexpected response.', hint: 'Restart it from Settings → Extensions, then retry.' };

function toError(code: string, mapped: Mapped): PanelError {
  return new PanelError(mapped.category, code, mapped.message, mapped.hint);
}

/** Map any thrown host failure to a fixed message; the original text is never relayed. */
export function mapHostFailure(error: unknown): PanelError {
  if (error instanceof PanelError) return error;
  const code = typeof (error as { code?: unknown } | null)?.code === 'string' ? (error as { code: string }).code : 'UNKNOWN';
  return toError(code, Object.hasOwn(HOST_ERRORS, code) ? HOST_ERRORS[code]! : GENERIC_HOST);
}

function parseObject(body: unknown): Record<string, unknown> | null {
  if (typeof body !== 'string') return null;
  try {
    const value: unknown = JSON.parse(body);
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch { return null; }
}

function mapServiceFailure(status: number, body: unknown): PanelError {
  const error = parseObject(body)?.error;
  const kind = typeof (error as { kind?: unknown } | null)?.kind === 'string' ? (error as { kind: string }).kind : null;
  if (kind !== null && Object.hasOwn(SERVICE_ERRORS, kind)) return toError(kind, SERVICE_ERRORS[kind]!);
  if (status === 401 || status === 403) return toError('unauthorized', { category: 'service-unavailable', message: 'The Heimdall extension service rejected the panel.', hint: 'Restart it from Settings → Extensions, then retry.' });
  if (status === 404) return toError('not-found', SERVICE_ERRORS['not-found']!);
  return toError(kind ?? `HTTP_${status}`, GENERIC_SERVICE);
}

export interface RunFilters { projectId: string | null; status: WireRunStatus | null }

export interface PanelClient {
  projects(): Promise<ProjectsResponse>;
  runs(filters: RunFilters): Promise<RunsResponse>;
  run(id: string): Promise<RunResponse>;
  /** A null cursor asks for the starting cursor; the service answers `resync: true`. */
  changes(cursor: string | null): Promise<ChangeFeed>;
  serviceStatus(): Promise<'stopped' | 'starting' | 'ready' | 'failed' | 'unknown'>;
}

function expectArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw toError('invalid-response', BAD_RESPONSE);
  return value;
}

export function createPanelClient(host: PanelHost): PanelClient {
  async function get(path: string, query?: Record<string, string>): Promise<Record<string, unknown>> {
    if (!isAllowedPath(path)) throw toError('BAD_PATH', BAD_RESPONSE);
    let result: { status: number; body: string };
    try {
      result = await host.serviceRequest(query && Object.keys(query).length > 0 ? { method: 'GET', path, query } : { method: 'GET', path });
    } catch (error) {
      throw mapHostFailure(error);
    }
    if (typeof result?.status !== 'number' || result.status < 200 || result.status >= 300) throw mapServiceFailure(result?.status, result?.body);
    const parsed = parseObject(result.body);
    if (!parsed) throw toError('invalid-response', BAD_RESPONSE);
    return parsed;
  }

  return {
    async projects() {
      const body = await get('/projects');
      expectArray(body.projects);
      return body as unknown as ProjectsResponse;
    },
    async runs(filters) {
      const query: Record<string, string> = {};
      if (filters.projectId !== null && IDENTIFIER.test(filters.projectId)) query.projectId = filters.projectId;
      if (filters.status !== null && (RUN_STATUSES as readonly string[]).includes(filters.status)) query.status = filters.status;
      const body = await get('/runs', query);
      expectArray(body.runs);
      return body as unknown as RunsResponse;
    },
    async run(id) {
      if (!IDENTIFIER.test(id)) throw toError('not-found', SERVICE_ERRORS['not-found']!);
      const body = await get(`/runs/${id}`);
      if (typeof body.run !== 'object' || body.run === null) throw toError('invalid-response', BAD_RESPONSE);
      return body as unknown as RunResponse;
    },
    async changes(cursor) {
      const body = await get('/changes', cursor === null ? undefined : { cursor });
      if (typeof body.cursor !== 'string' || !Array.isArray(body.changedRunIds) || typeof body.resync !== 'boolean') throw toError('invalid-response', BAD_RESPONSE);
      return body as unknown as ChangeFeed;
    },
    async serviceStatus() {
      try {
        const result = await host.serviceStatus();
        return result.status === 'stopped' || result.status === 'starting' || result.status === 'ready' || result.status === 'failed' ? result.status : 'unknown';
      } catch (error) {
        throw mapHostFailure(error);
      }
    },
  };
}
