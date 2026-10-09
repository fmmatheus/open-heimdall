import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { adapterErrorMessage, CoordinatorAdapterError } from './coordinator.js';
import type { AdapterErrorKind, CoordinatorAdapter } from './coordinator.js';

/** Stay below the host's 256000 character GUEST_REQUEST_RESPONSE_MAX. */
export const MAX_RESPONSE_BYTES = 200000;
export const MAX_REQUEST_BODY_BYTES = 16 * 1024;

export type ErrorKind = AdapterErrorKind | 'unauthorized' | 'not-found' | 'method-not-allowed' | 'invalid-request' | 'payload-too-large' | 'response-too-large' | 'internal-error';

const FIXED_MESSAGES: Record<string, string> = {
  unauthorized: 'A valid service token is required.',
  'not-found': 'No such Heimdall service route.',
  'method-not-allowed': 'This route does not accept that method.',
  'invalid-request': 'The request is not valid.',
  'payload-too-large': 'The request body is too large.',
  'response-too-large': 'The response would exceed the service size limit.',
  'internal-error': 'The Heimdall service could not complete the request.',
};

/** Handlers throw this for expected failures; the message must already be safe to show. */
export class HttpError extends Error {
  constructor(readonly status: number, readonly kind: ErrorKind, message?: string) {
    super(message ?? FIXED_MESSAGES[kind] ?? adapterErrorMessage(kind as AdapterErrorKind));
    this.name = 'HttpError';
  }
}

export interface RouteContext {
  /** Values of `:name` segments, taken verbatim from the (never percent-decoded) path. */
  params: Record<string, string>;
  query: URLSearchParams;
  /** Parsed JSON body; only present for routes that declare `body`. */
  body?: unknown;
}

/** Handlers return a plain value for 200, or `new Reply(status, body)` for another status. */
export class Reply {
  constructor(readonly status: number, readonly body: unknown) {}
}

export interface Route {
  method: 'GET' | 'POST';
  /** Literal segments or `:name` parameters, e.g. `/runs/:id`. */
  path: string;
  /** POST routes must opt in to a request body; it is capped at this many bytes (default 16 KiB, never more). */
  body?: { maxBytes?: number };
  handler(context: RouteContext): Promise<unknown> | unknown;
}

export interface ExtensionServerOptions {
  token: string;
  adapter: CoordinatorAdapter;
  /** Additional routes registered through the same allowlist table as the built-in ones. */
  routes?: Route[];
  now?: () => Date;
  maxResponseBytes?: number;
}

const digest = (value: string) => createHash('sha256').update(value).digest();

export function builtInRoutes(options: Pick<ExtensionServerOptions, 'adapter' | 'now'>): Route[] {
  const now = options.now ?? (() => new Date());
  return [
    { method: 'GET', path: '/health', handler: () => ({ ok: true }) },
    {
      method: 'GET', path: '/status',
      async handler() {
        const checkedAt = now().toISOString();
        try {
          await options.adapter.projects();
          return { connected: true, checkedAt };
        } catch (error) {
          const kind = error instanceof CoordinatorAdapterError ? error.kind : 'coordinator-error';
          return { connected: false, checkedAt, error: { kind, message: adapterErrorMessage(kind) } };
        }
      },
    },
  ];
}

interface Compiled { route: Route; segments: string[] }

function splitPath(pathname: string): string[] | undefined {
  // No percent-decoding, dot segments or empty segments are ever honoured: such paths never match a route.
  if (!pathname.startsWith('/') || pathname.includes('%') || pathname.includes('\\')) return undefined;
  const segments = pathname === '/' ? [] : pathname.slice(1).split('/');
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return undefined;
  return segments;
}

function matchRoute(segments: string[], route: Compiled): Record<string, string> | undefined {
  if (segments.length !== route.segments.length) return undefined;
  const params: Record<string, string> = {};
  for (let index = 0; index < segments.length; index++) {
    const expected = route.segments[index]!;
    if (expected.startsWith(':')) params[expected.slice(1)] = segments[index]!;
    else if (expected !== segments[index]) return undefined;
  }
  return params;
}

function statusFor(kind: ErrorKind): number {
  switch (kind) {
    case 'not-found': return 404;
    case 'coordinator-timeout': return 504;
    case 'coordinator-offline': case 'coordinator-unauthorized': case 'configuration-invalid': case 'coordinator-error': return 503;
    default: return 500;
  }
}

async function readBody(request: http.IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'payload-too-large');
    chunks.push(chunk as Buffer);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'invalid-request'); }
}

export function createExtensionServer(options: ExtensionServerOptions): http.Server {
  if (!options.token) throw new Error('A service token is required');
  const expected = digest(`Bearer ${options.token}`);
  const maxResponseBytes = Math.min(options.maxResponseBytes ?? MAX_RESPONSE_BYTES, MAX_RESPONSE_BYTES);
  const table: Compiled[] = [...builtInRoutes(options), ...(options.routes ?? [])].map(route => ({ route, segments: route.path.slice(1).split('/').filter(Boolean) }));

  function send(response: http.ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) {
    let payload = JSON.stringify(value);
    if (Buffer.byteLength(payload) > maxResponseBytes) {
      status = 502;
      payload = JSON.stringify({ error: { kind: 'response-too-large', message: FIXED_MESSAGES['response-too-large'] } });
    }
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(payload), ...headers });
    response.end(payload);
  }
  const fail = (response: http.ServerResponse, status: number, kind: ErrorKind, message?: string, headers?: Record<string, string>) =>
    send(response, status, { error: { kind, message: message ?? FIXED_MESSAGES[kind] ?? adapterErrorMessage(kind as AdapterErrorKind) } }, headers);

  async function handle(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !timingSafeEqual(digest(header), expected)) { fail(response, 401, 'unauthorized', undefined, { 'WWW-Authenticate': 'Bearer' }); return; }

    // Split the raw target by hand: WHATWG URL parsing would resolve `%2e%2e` and `..` before the allowlist sees them.
    const target = request.url ?? '/';
    const queryStart = target.indexOf('?');
    const pathname = queryStart === -1 ? target : target.slice(0, queryStart);
    const query = new URLSearchParams(queryStart === -1 ? '' : target.slice(queryStart + 1));
    const segments = splitPath(pathname);
    const candidates = segments ? table.map(route => ({ route: route.route, params: matchRoute(segments, route) })).filter(candidate => candidate.params) : [];
    if (candidates.length === 0) { fail(response, 404, 'not-found'); return; }
    const selected = candidates.find(candidate => candidate.route.method === request.method);
    if (!selected) {
      fail(response, 405, 'method-not-allowed', undefined, { Allow: [...new Set(candidates.map(candidate => candidate.route.method))].join(', ') });
      return;
    }

    const context: RouteContext = { params: selected.params!, query };
    if (selected.route.body) context.body = await readBody(request, Math.min(selected.route.body.maxBytes ?? MAX_REQUEST_BODY_BYTES, MAX_REQUEST_BODY_BYTES));
    const result = await selected.route.handler(context);
    if (result instanceof Reply) send(response, result.status, result.body);
    else send(response, 200, result);
  }

  const server = http.createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent) { response.destroy(); return; }
      if (error instanceof HttpError) fail(response, error.status, error.kind, error.message);
      else if (error instanceof CoordinatorAdapterError) fail(response, statusFor(error.kind), error.kind, error.message);
      else fail(response, 500, 'internal-error');
    });
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

/** The host requires loopback-only binding; there is no way to choose another address. */
export function listenExtensionServer(server: http.Server, port: number): Promise<http.Server> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(server); });
  });
}
