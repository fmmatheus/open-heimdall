import http from 'node:http';

/**
 * HTTP/JSON uses a Unix socket or a Windows named pipe, never a public listener.
 * `timeoutMs` bounds socket inactivity; the optional `deadlineMs` bounds total elapsed time per request,
 * so a peer that keeps trickling bytes cannot hold a request open past it. The optional `signal` ends a request
 * early on interruption: the connection is closed and the request rejects with code `aborted`; a signal that is
 * already aborted rejects before any connection is made. Aborting only ends the client's wait: whether the
 * coordinator received the request is unknown to the caller.
 */
export function createCoordinatorClient(endpoint: string, accessToken?: string, options: { timeoutMs?: number; deadlineMs?: number; signal?: AbortSignal } = {}) {
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Coordinator timeout must be a positive integer');
  const deadlineMs = options.deadlineMs;
  if (deadlineMs !== undefined && (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1)) throw new Error('Coordinator deadline must be a positive integer');
  if (!endpoint) throw new Error('A coordinator IPC endpoint is required');
  const signal = options.signal;
  const abortError = () => Object.assign(new Error('Coordinator request aborted'), { code: 'aborted' });
  return {
    async request(method: string, route: string, body?: unknown, ownerToken?: string): Promise<unknown> {
      if (!route.startsWith('/') || route.startsWith('//') || route.includes('#')) throw new Error('Invalid coordinator route');
      const token = ownerToken ?? accessToken;
      if (!token) throw new Error('A coordinator access token is required');
      const payload = body === undefined ? undefined : JSON.stringify(body);
      return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(abortError()); return; }
        let deadlineTimer: NodeJS.Timeout | undefined;
        const onAbort = () => { fail(abortError()); request.destroy(); };
        const settle = () => { clearTimeout(deadlineTimer); signal?.removeEventListener('abort', onAbort); };
        const succeed = (value: unknown) => { settle(); resolve(value); };
        const fail = (error: Error) => { settle(); reject(error); };
        const request = http.request({
          socketPath: endpoint, method, path: route,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(payload === undefined ? {} : { 'Content-Length': Buffer.byteLength(payload) }) },
        }, response => {
          const chunks: Buffer[] = [];
          let size = 0;
          response.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > 2 * 1024 * 1024) response.destroy(new Error('Coordinator response is too large'));
            else chunks.push(chunk);
          });
          response.on('error', fail);
          response.on('end', () => {
            let value: unknown;
            try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch { fail(new Error('Invalid coordinator JSON response')); return; }
            const statusCode = response.statusCode ?? 500;
            if (statusCode >= 400) {
              const message = value && typeof value === 'object' && 'error' in value ? String(value.error) : 'Coordinator request failed';
              const code = value && typeof value === 'object' && 'code' in value && typeof value.code === 'string' ? value.code : undefined;
              fail(Object.assign(new Error(message), { statusCode }, code === undefined ? {} : { code }));
            } else succeed(value);
          });
        });
        request.setTimeout(timeoutMs, () => request.destroy(new Error('Coordinator request timed out')));
        request.on('error', error => fail(new Error(`Coordinator unavailable: ${error.message}`)));
        signal?.addEventListener('abort', onAbort, { once: true });
        if (deadlineMs !== undefined) {
          // Reject directly: once headers have arrived, destroying the request may not emit a request 'error'.
          deadlineTimer = setTimeout(() => {
            fail(new Error(`Coordinator request exceeded its ${deadlineMs} ms deadline`));
            request.destroy();
          }, deadlineMs);
        }
        request.end(payload);
      });
    },
  };
}
