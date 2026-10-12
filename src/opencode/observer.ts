import * as fs from 'node:fs/promises';
import path from 'node:path';
import { readDesktopConnection } from './openchamber.js';
import type { DesktopClientConnection, DesktopConnectionOptions } from './openchamber.js';
import { OriginProofError } from './types.js';
import type { HistoryMessage, MessageHistory, ObservedSession, SessionAPI, SessionObserver, SessionSnapshot } from './types.js';

export const supportedOpenCodeVersion = '2.0.22';
export type OpenCodeAuthentication = 'basic' | 'none' | 'openchamber';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function localURL(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Configure a local OpenCode HTTP URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Configure a local OpenCode HTTP URL without credentials, path, query, or fragment');
  }
  return url;
}

/** Per-request deadline; callers may shorten it (tests) but the default is the supported behavior. */
export const defaultRequestTimeoutMilliseconds = 10000;

export function createAPI({ baseUrl, password, authentication = 'basic', desktop, directory, fetchImpl = fetch, timeoutMilliseconds = defaultRequestTimeoutMilliseconds }: {
  baseUrl: string;
  password?: string;
  authentication?: OpenCodeAuthentication;
  desktop?: DesktopClientConnection;
  directory: string;
  fetchImpl?: typeof fetch;
  timeoutMilliseconds?: number;
}): SessionAPI {
  const base = localURL(baseUrl);
  if (!['basic', 'none', 'openchamber'].includes(authentication) || !directory || (authentication === 'basic' && (typeof password !== 'string' || !password))) throw new Error('Invalid configured OpenCode connection');
  if (authentication === 'openchamber' && (base.protocol !== 'http:' || !desktop || !Number.isInteger(desktop.port) || Number(base.port || 80) !== desktop.port || !desktop.token || /[\x00-\x20\x7f]/.test(desktop.token))) throw new Error('Invalid configured OpenChamber Desktop connection');
  const headers = {
    'Content-Type': 'application/json',
    ...(authentication === 'basic' ? { Authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64') } : {}),
    ...(authentication === 'openchamber' ? { Authorization: 'Bearer ' + desktop!.token, 'x-opencode-directory-encoding': 'uri' } : {}),
    'x-opencode-directory': encodeURIComponent(directory),
  };
  return {
    async request(route, { method = 'GET', body, signal, raw = false } = {}) {
      if (!route.startsWith('/api/') || route.startsWith('//') || route.includes('#')) throw new Error('V2 API route required');
      const url = new URL(route, base);
      if (url.origin !== base.origin || !url.pathname.startsWith('/api/')) throw new Error('V2 API route required');
      url.searchParams.set('location[directory]', directory);
      const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMilliseconds)]) : AbortSignal.timeout(timeoutMilliseconds);
      let response: Response;
      try {
        response = await fetchImpl(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: timeout, redirect: 'error' });
      } catch { throw new Error('OpenCode API unreachable or timed out'); }
      if (!response.ok) throw Object.assign(new Error('OpenCode API HTTP ' + response.status), { status: response.status });
      if (response.status === 204) return null;
      let value: unknown;
      try { value = await response.json(); } catch { throw new Error('Invalid OpenCode API JSON response'); }
      return !raw && record(value) && Object.hasOwn(value, 'data') ? value.data : value;
    },
  };
}

export interface ConnectionOptions {
  authentication?: OpenCodeAuthentication;
  baseUrl?: string;
  passwordEnvironmentVariable?: string;
  environment?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  readFS?: Pick<typeof fs, 'realpath'>;
  openchamber?: DesktopConnectionOptions;
  /** Per-request deadline; defaults to 10000 ms. */
  timeoutMilliseconds?: number;
}

/** Uses the explicit loopback endpoint and only its selected authentication source. */
export async function connect(directory: string, sessionID?: string, {
  baseUrl,
  authentication = 'basic',
  passwordEnvironmentVariable = 'OPENCODE_PASSWORD',
  environment = process.env,
  fetchImpl = fetch,
  readFS = fs,
  openchamber,
  timeoutMilliseconds,
}: ConnectionOptions = {}): Promise<SessionAPI> {
  if (!baseUrl) throw new Error('Configure opencode.baseUrl before executing a workflow');
  if (!['basic', 'none', 'openchamber'].includes(authentication)) throw new Error('Invalid OpenCode authentication mode');
  const password = authentication === 'basic' ? environment[passwordEnvironmentVariable] : undefined;
  if (authentication === 'basic' && (typeof password !== 'string' || !password)) throw new Error('Set the configured OpenCode password environment variable');
  const desktop = authentication === 'openchamber' ? await readDesktopConnection(localURL(baseUrl), environment, openchamber) : undefined;
  const api = createAPI({ baseUrl, password, authentication, desktop, directory, fetchImpl, ...(timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds }) });
  const info = await api.request('/api/info');
  if (!record(info) || info.version !== supportedOpenCodeVersion || !Number.isInteger(info.pid) || (info.pid as number) < 1) {
    throw new Error('Configured server does not match supported OpenCode ' + supportedOpenCodeVersion);
  }
  if (sessionID) {
    const session = await api.request('/api/session/' + encodeURIComponent(sessionID));
    if (!record(session) || session.id !== sessionID) throw new Error('OpenCode session identity could not be verified');
    if (!record(session.location) || typeof session.location.directory !== 'string') throw new Error('OpenCode session project could not be verified');
    const canonical = async (value: string) => readFS.realpath(value).catch(() => path.resolve(value));
    if (path.resolve(session.location.directory) !== path.resolve(directory) && await canonical(session.location.directory) !== await canonical(directory)) {
      throw new Error('OpenCode session belongs to a different project');
    }
  }
  return { ...api, version: info.version as string, pid: info.pid as number };
}

export async function snapshot(api: SessionAPI, id: string, { limit = 5, signal }: { limit?: number; signal?: AbortSignal } = {}): Promise<SessionSnapshot> {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Invalid session observation limit');
  const base = '/api/session/' + encodeURIComponent(id);
  const [session, active, inbox, permissions, forms, messages] = await Promise.all([
    base, '/api/session/active', base + '/inbox', base + '/permission', base + '/form', base + '/message?order=desc&limit=' + limit,
  ].map(route => api.request(route, { signal })));
  if (!record(session) || session.id !== id || !record(session.time) || !record(active) || !Array.isArray(inbox) || !Array.isArray(permissions) || !Array.isArray(forms) || !Array.isArray(messages)) {
    throw new Error('Cannot verify complete V2 session state');
  }
  if (active[id] && (!record(active[id]) || active[id].type !== 'running')) throw new Error('Unknown V2 execution status');
  return { session: session as unknown as ObservedSession, active: !!active[id], inbox, permissions, forms, messages };
}

export function createObserver({ directory, ...connection }: ConnectionOptions & { directory: string }): SessionObserver {
  return async (id, signal) => snapshot(await connect(directory, id, connection), id, { signal });
}

/** The server's maximum page size for `session.message.list`. */
export const MESSAGE_HISTORY_PAGE_SIZE = 200;
/** 200 000 messages: far beyond a bounded workflow child, yet a hard stop so a misbehaving server cannot hold a scan open. */
export const MESSAGE_HISTORY_MAX_PAGES = 1000;

/**
 * Reads the complete projected message archive of a session, newest first, through the supported
 * `GET /api/session/:id/message` route. Unlike the plugin context (which starts after the latest completed
 * compaction) this retains every message.
 *
 * Pinned 2.0.22 contract (`@opencode/protocol` `session.message.list`): `order` (asc|desc) applies to the first page
 * only; later pages send just the opaque `cursor` returned by the previous response (plus `limit` and the same
 * `type` filter, never `order`); the response envelope is `{ data: Message[], cursor: { previous?, next? } }` and
 * "items keep the requested order across pages". The pinned typings do not state which cursor continues toward older
 * items for `order=desc`; `cursor.next` is followed as the continuation of the requested order. That direction is
 * not provable from the packages and is confirmed by the live smoke with a small page size.
 *
 * The scan is lazy: it stops fetching as soon as the consumer stops. It never sorts, deduplicates or truncates, and
 * throws an OriginProofError for an unreachable or failing API, a malformed envelope, a cursor seen before, a message
 * id seen twice, or a scan longer than `maxPages`.
 */
export function createMessageHistory({ directory, pageSize = MESSAGE_HISTORY_PAGE_SIZE, maxPages = MESSAGE_HISTORY_MAX_PAGES, ...connection }: ConnectionOptions & {
  directory: string;
  pageSize?: number;
  maxPages?: number;
}): MessageHistory {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MESSAGE_HISTORY_PAGE_SIZE || !Number.isInteger(maxPages) || maxPages < 1) throw new Error('Invalid message history bounds');
  return async function* (sessionID, signal) {
    let api: SessionAPI;
    try { api = await connect(directory, sessionID, connection); } catch { throw new OriginProofError('history_unavailable'); }
    const base = '/api/session/' + encodeURIComponent(sessionID) + '/message';
    const cursors = new Set<string>();
    const ids = new Set<string>();
    let cursor: string | undefined;
    for (let page = 1; ; page++) {
      const route = base + '?' + (cursor === undefined ? 'order=desc&limit=' + pageSize : 'cursor=' + encodeURIComponent(cursor) + '&limit=' + pageSize);
      let value: unknown;
      try { value = await api.request(route, { signal, raw: true }); } catch { throw new OriginProofError('history_unavailable'); }
      if (!record(value) || !Array.isArray(value.data) || !record(value.cursor)) throw new OriginProofError('page_malformed');
      // The server reports an absent cursor as `null` (the empty page past the end carries `{ previous: null, next: null }`).
      const next = value.cursor.next ?? undefined;
      const previous = value.cursor.previous ?? undefined;
      if ((next !== undefined && (typeof next !== 'string' || !next)) || (previous !== undefined && typeof previous !== 'string')) throw new OriginProofError('page_malformed');
      // The whole page is validated before any of it is consumed.
      for (const item of value.data) {
        if (!record(item) || typeof item.id !== 'string' || !item.id || typeof item.type !== 'string') throw new OriginProofError('page_malformed');
        if (ids.has(item.id)) throw new OriginProofError('duplicate_message');
        ids.add(item.id);
      }
      yield* value.data as HistoryMessage[];
      if (next === undefined || value.data.length === 0) return;
      if (cursors.has(next) || next === cursor) throw new OriginProofError('cursor_repeated');
      if (page >= maxPages) throw new OriginProofError('scan_exhausted');
      cursors.add(next);
      cursor = next;
    }
  };
}
