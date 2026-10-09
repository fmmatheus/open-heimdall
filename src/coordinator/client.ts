import http from 'node:http';

/** HTTP/JSON uses a Unix socket or a Windows named pipe, never a public listener. */
export function createCoordinatorClient(endpoint: string, accessToken?: string, options: { timeoutMs?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('Coordinator timeout must be a positive integer');
  if (!endpoint) throw new Error('A coordinator IPC endpoint is required');
  return {
    async request(method: string, route: string, body?: unknown, ownerToken?: string): Promise<unknown> {
      if (!route.startsWith('/') || route.startsWith('//') || route.includes('#')) throw new Error('Invalid coordinator route');
      const token = ownerToken ?? accessToken;
      if (!token) throw new Error('A coordinator access token is required');
      const payload = body === undefined ? undefined : JSON.stringify(body);
      return new Promise((resolve, reject) => {
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
          response.on('error', reject);
          response.on('end', () => {
            let value: unknown;
            try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch { reject(new Error('Invalid coordinator JSON response')); return; }
            if ((response.statusCode ?? 500) >= 400) {
              const message = value && typeof value === 'object' && 'error' in value ? String(value.error) : 'Coordinator request failed';
              reject(new Error(message));
            } else resolve(value);
          });
        });
        request.setTimeout(timeoutMs, () => request.destroy(new Error('Coordinator request timed out')));
        request.on('error', error => reject(new Error(`Coordinator unavailable: ${error.message}`)));
        request.end(payload);
      });
    },
  };
}
