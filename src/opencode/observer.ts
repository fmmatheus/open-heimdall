import * as fs from 'node:fs/promises';
import path from 'node:path';
import type { ObservedSession, SessionAPI, SessionObserver, SessionSnapshot } from './types.js';

export const supportedOpenCodeVersion = '2.0.22';
export type OpenCodeAuthentication = 'basic' | 'none';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function localURL(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Configure a local OpenCode HTTP URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Configure a local OpenCode HTTP URL without credentials, path, query, or fragment');
  }
  return url;
}

export function createAPI({ baseUrl, password, authentication = 'basic', directory, fetchImpl = fetch }: {
  baseUrl: string;
  password?: string;
  authentication?: OpenCodeAuthentication;
  directory: string;
  fetchImpl?: typeof fetch;
}): SessionAPI {
  const base = localURL(baseUrl);
  if (!['basic', 'none'].includes(authentication) || !directory || (authentication === 'basic' && (typeof password !== 'string' || !password))) throw new Error('Invalid configured OpenCode connection');
  const headers = {
    'Content-Type': 'application/json',
    ...(authentication === 'basic' ? { Authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64') } : {}),
    'x-opencode-directory': encodeURIComponent(directory),
  };
  return {
    async request(route, { method = 'GET', body, signal, raw = false } = {}) {
      if (!route.startsWith('/api/') || route.startsWith('//') || route.includes('#')) throw new Error('V2 API route required');
      const url = new URL(route, base);
      if (url.origin !== base.origin || !url.pathname.startsWith('/api/')) throw new Error('V2 API route required');
      url.searchParams.set('location[directory]', directory);
      const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000);
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
}

/** Uses the explicit loopback endpoint; no-auth connections never resolve a password. */
export async function connect(directory: string, sessionID?: string, {
  baseUrl,
  authentication = 'basic',
  passwordEnvironmentVariable = 'OPENCODE_PASSWORD',
  environment = process.env,
  fetchImpl = fetch,
  readFS = fs,
}: ConnectionOptions = {}): Promise<SessionAPI> {
  if (!baseUrl) throw new Error('Configure opencode.baseUrl before executing a workflow');
  if (!['basic', 'none'].includes(authentication)) throw new Error('Invalid OpenCode authentication mode');
  const password = authentication === 'basic' ? environment[passwordEnvironmentVariable] : undefined;
  if (authentication === 'basic' && (typeof password !== 'string' || !password)) throw new Error('Set the configured OpenCode password environment variable');
  const api = createAPI({ baseUrl, password, authentication, directory, fetchImpl });
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
