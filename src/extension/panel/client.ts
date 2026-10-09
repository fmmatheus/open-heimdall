import { CONTENT_LIMITS, MATCH_LIMITS, REVIEW_LIMITS, RUN_STATUSES } from '../shared/protocol.js';
import type {
  BlockerContentResponse, ChangeFeed, DirectoryMatch, ProjectsResponse, ReviewFileResponse, ReviewResponse, RunResponse, RunsResponse,
  TaskContentResponse, WireRunStatus,
} from '../shared/protocol.js';

/** The slice of the SDK host the panel uses; injectable so tests can record every request. */
export interface PanelHost {
  serviceRequest(request: { method: 'GET' | 'POST'; path: string; query?: Record<string, string>; body?: string }): Promise<{ status: number; body: string }>;
  serviceStatus(): Promise<{ status: string }>;
}

export const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** The only service routes the panel may request. All are GET. */
const FIXED_PATHS = new Set(['/projects', '/runs', '/changes']);
const RUN_PATH = /^\/runs\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}(?:\/(?:review(?:\/file)?|blocker|tasks\/(?:0|[1-9][0-9]{0,5})))?$/;

export function isAllowedPath(path: string): boolean {
  return FIXED_PATHS.has(path) || RUN_PATH.test(path);
}

/** The single POST route: a pure lookup that compares directories and returns ids only. */
export const MATCH_PATH = '/directories/match';
export const isAllowedPostPath = (path: string): boolean => path === MATCH_PATH;

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
  /** Changed files of the run's managed worktree against its base commit. */
  review(id: string): Promise<ReviewResponse>;
  /**
   * Bounded diff of one file. Callers must pass a path taken from the latest review list; the client only
   * checks that it is well-formed, so a path typed or guessed elsewhere never reaches the service from the store.
   */
  reviewFile(id: string, path: string): Promise<ReviewFileResponse>;
  /**
   * More of one task's recorded text, by 0-based plan position. Only called when the user asks to see more;
   * the answer is checked to belong to the requested run and position.
   */
  taskContent(id: string, index: number): Promise<TaskContentResponse>;
  /** More of the recorded blocker reason and resolution. */
  blockerContent(id: string): Promise<BlockerContentResponse>;
  /** A null cursor asks for the starting cursor; the service answers `resync: true`. */
  changes(cursor: string | null): Promise<ChangeFeed>;
  serviceStatus(): Promise<'stopped' | 'starting' | 'ready' | 'failed' | 'unknown'>;
  /**
   * Canonical-identity lookup of OpenChamber directories. Result is aligned with the input; a directory the
   * service cannot accept (relative, too long, NUL) is never sent and counts as unmatched.
   */
  matchDirectories(directories: string[]): Promise<DirectoryMatch[]>;
}

function expectArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw toError('invalid-response', BAD_RESPONSE);
  return value;
}

function isSendableDirectory(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MATCH_LIMITS.pathChars && !value.includes('\0') && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\'));
}

/** Keep only well-formed ids from a match entry; anything else counts as no match. */
function sanitizeMatch(value: unknown): DirectoryMatch {
  const entry = typeof value === 'object' && value !== null ? value as { projectId?: unknown; runId?: unknown } : {};
  const match: DirectoryMatch = {};
  if (typeof entry.projectId === 'string' && IDENTIFIER.test(entry.projectId)) match.projectId = entry.projectId;
  if (match.projectId !== undefined && typeof entry.runId === 'string' && IDENTIFIER.test(entry.runId)) match.runId = entry.runId;
  return match;
}

function isSendableReviewPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') && new TextEncoder().encode(value).length <= REVIEW_LIMITS.pathBytes;
}

const REVIEW_GIT_FAILURE: Mapped = { category: 'request', message: 'Git could not inspect the managed worktree.', hint: null };

/** A git failure inside one review request is not a connection problem; keep it local to the Review tab. */
function reviewFailure(error: unknown): never {
  const mapped = mapHostFailure(error);
  if (mapped.code === 'internal-error' || mapped.code === 'HTTP_500') throw toError('internal-error', REVIEW_GIT_FAILURE);
  throw mapped;
}

const TASK_INDEX_MAX = 999999;
const TASK_CLIP_KEYS = ['title', 'summary', 'handoff', 'model', 'evidenceCount', 'evidenceText'] as const;
const TASK_STATES = ['done', 'current', 'pending'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const textWithin = (value: unknown, max: number): boolean => typeof value === 'string' && value.length <= max;
const nullableTextWithin = (value: unknown, max: number): boolean => value === null || textWithin(value, max);
const flags = (value: unknown, keys: readonly string[]): boolean => isRecord(value) && keys.every(key => typeof value[key] === 'boolean');

function isEvidence(value: unknown, limits: { gate: number; detail: number }): boolean {
  return isRecord(value)
    && nullableTextWithin(value.gateId, 128)
    && nullableTextWithin(value.gate, limits.gate)
    && (value.passed === null || typeof value.passed === 'boolean')
    && textWithin(value.detail, limits.detail);
}

/** Exact shape check of a task content answer, bound to the run and position that were asked for. */
function isTaskContent(body: Record<string, unknown>, id: string, index: number): boolean {
  const limits = body.limits;
  if (!isRecord(limits)) return false;
  const { title, model, text, gate, detail, evidence } = limits;
  if (![title, model, text, gate, detail, evidence].every(value => typeof value === 'number' && Number.isInteger(value) && value >= 0)) return false;
  if ((model as number) > CONTENT_LIMITS.model || (title as number) > CONTENT_LIMITS.title || (text as number) > CONTENT_LIMITS.text || (gate as number) > CONTENT_LIMITS.gate
    || (detail as number) > CONTENT_LIMITS.detail || (evidence as number) > CONTENT_LIMITS.evidence) return false;
  return body.runId === id
    && body.index === index
    && textWithin(body.taskId, 128)
    && textWithin(body.title, title as number)
    && typeof body.state === 'string' && TASK_STATES.includes(body.state)
    && nullableTextWithin(body.summary, text as number)
    && nullableTextWithin(body.handoff, text as number)
    && nullableTextWithin(body.model, model as number)
    && Array.isArray(body.evidence) && body.evidence.length <= (evidence as number)
    && body.evidence.every(item => isEvidence(item, { gate: gate as number, detail: detail as number }))
    && typeof body.evidenceTotal === 'number' && Number.isInteger(body.evidenceTotal) && body.evidenceTotal >= body.evidence.length
    && flags(body.clipped, TASK_CLIP_KEYS)
    && typeof body.complete === 'boolean';
}

function isBlockerContent(body: Record<string, unknown>, id: string): boolean {
  const limit = body.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 0 || limit > CONTENT_LIMITS.reason) return false;
  return body.runId === id
    && typeof body.status === 'string' && (RUN_STATUSES as readonly string[]).includes(body.status)
    && textWithin(body.reason, limit)
    && typeof body.reasonRecorded === 'boolean'
    && nullableTextWithin(body.resolution, limit)
    && flags(body.clipped, ['reason', 'resolution'])
    && typeof body.complete === 'boolean';
}

const CONTENT_FAILURE: Mapped = { category: 'request', message: 'Heimdall could not load the full text.', hint: null };

/** A failure of one on-demand content request stays local to the text being expanded. */
function contentFailure(error: unknown): never {
  const mapped = mapHostFailure(error);
  if (mapped.code === 'internal-error' || mapped.code === 'HTTP_500') throw toError('internal-error', CONTENT_FAILURE);
  throw mapped;
}

export function createPanelClient(host: PanelHost): PanelClient {
  async function send(request: { method: 'GET' | 'POST'; path: string; query?: Record<string, string>; body?: string }): Promise<Record<string, unknown>> {
    let result: { status: number; body: string };
    try {
      result = await host.serviceRequest(request);
    } catch (error) {
      throw mapHostFailure(error);
    }
    if (typeof result?.status !== 'number' || result.status < 200 || result.status >= 300) throw mapServiceFailure(result?.status, result?.body);
    const parsed = parseObject(result.body);
    if (!parsed) throw toError('invalid-response', BAD_RESPONSE);
    return parsed;
  }

  async function get(path: string, query?: Record<string, string>): Promise<Record<string, unknown>> {
    if (!isAllowedPath(path)) throw toError('BAD_PATH', BAD_RESPONSE);
    return send(query && Object.keys(query).length > 0 ? { method: 'GET', path, query } : { method: 'GET', path });
  }

  async function post(path: string, body: string): Promise<Record<string, unknown>> {
    if (!isAllowedPostPath(path)) throw toError('BAD_PATH', BAD_RESPONSE);
    return send({ method: 'POST', path, body });
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
    async review(id) {
      if (!IDENTIFIER.test(id)) throw toError('not-found', SERVICE_ERRORS['not-found']!);
      let body: Record<string, unknown>;
      try { body = await get(`/runs/${id}/review`); } catch (error) { return reviewFailure(error); }
      if (typeof body.state !== 'string' || !Array.isArray(body.files) || !Array.isArray(body.generated)) throw toError('invalid-response', BAD_RESPONSE);
      return body as unknown as ReviewResponse;
    },
    async reviewFile(id, path) {
      if (!IDENTIFIER.test(id)) throw toError('not-found', SERVICE_ERRORS['not-found']!);
      if (!isSendableReviewPath(path)) throw toError('invalid-request', SERVICE_ERRORS['invalid-request']!);
      let body: Record<string, unknown>;
      try { body = await get(`/runs/${id}/review/file`, { path }); } catch (error) { return reviewFailure(error); }
      if (typeof body.state !== 'string' || typeof body.path !== 'string' || typeof body.text !== 'string') throw toError('invalid-response', BAD_RESPONSE);
      return body as unknown as ReviewFileResponse;
    },
    async taskContent(id, index) {
      if (!IDENTIFIER.test(id)) throw toError('not-found', SERVICE_ERRORS['not-found']!);
      if (!Number.isInteger(index) || index < 0 || index > TASK_INDEX_MAX) throw toError('invalid-request', SERVICE_ERRORS['invalid-request']!);
      let body: Record<string, unknown>;
      try { body = await get(`/runs/${id}/tasks/${index}`); } catch (error) { return contentFailure(error); }
      if (!isTaskContent(body, id, index)) throw toError('invalid-response', BAD_RESPONSE);
      return body as unknown as TaskContentResponse;
    },
    async blockerContent(id) {
      if (!IDENTIFIER.test(id)) throw toError('not-found', SERVICE_ERRORS['not-found']!);
      let body: Record<string, unknown>;
      try { body = await get(`/runs/${id}/blocker`); } catch (error) { return contentFailure(error); }
      if (!isBlockerContent(body, id)) throw toError('invalid-response', BAD_RESPONSE);
      return body as unknown as BlockerContentResponse;
    },
    async changes(cursor) {
      const body = await get('/changes', cursor === null ? undefined : { cursor });
      if (typeof body.cursor !== 'string' || !Array.isArray(body.changedRunIds) || typeof body.resync !== 'boolean') throw toError('invalid-response', BAD_RESPONSE);
      return body as unknown as ChangeFeed;
    },
    async matchDirectories(directories) {
      const matches: DirectoryMatch[] = directories.map(() => ({}));
      const sendable = directories.flatMap((directory, index) => isSendableDirectory(directory) ? [index] : []);
      for (let start = 0; start < sendable.length; start += MATCH_LIMITS.directories) {
        const batch = sendable.slice(start, start + MATCH_LIMITS.directories);
        const body = await post(MATCH_PATH, JSON.stringify({ directories: batch.map(index => directories[index]) }));
        const returned: unknown = body.matches;
        if (!Array.isArray(returned) || returned.length !== batch.length) throw toError('invalid-response', BAD_RESPONSE);
        batch.forEach((index, position) => { matches[index] = sanitizeMatch(returned[position]); });
      }
      return matches;
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
