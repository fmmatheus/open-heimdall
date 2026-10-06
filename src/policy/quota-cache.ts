import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { QuotaResult } from './types.js';

export interface QuotaCacheOptions {
  directory: string;
  now?: () => number;
  scope?: string;
}

interface CacheRecord {
  result?: QuotaResult;
  failures?: number;
  retryAt?: number;
  scope?: string;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

export function retryAfterMs(value: string | null | undefined, now = Date.now()): number {
  if (!value?.trim()) return 0;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay > 0 ? delay : 0;
}

const unavailable = (code: string, now: number, retryAt?: number): QuotaResult => ({
  fetchedAt: now, errorCode: code, errors: [code], entries: [], retryAt,
});

export async function cachedQuota(
  key: string,
  fetchFresh: () => Promise<QuotaResult>,
  { directory, now = Date.now, scope }: QuotaCacheOptions,
): Promise<QuotaResult> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const scopeKey = scope === undefined ? undefined : createHash('sha256').update(String(scope)).digest('hex');
  const suffix = scopeKey === undefined ? '' : '.' + scopeKey;
  const file = path.join(directory, key + suffix + '.json');
  const lock = file + '.lock';
  const read = async (): Promise<CacheRecord> => {
    try { return JSON.parse(await fs.readFile(file, 'utf8')) as CacheRecord; }
    catch (error) {
      if (hasErrorCode(error, 'ENOENT') || error instanceof SyntaxError) return {};
      throw error;
    }
  };
  const reuse = (entry: CacheRecord): QuotaResult | undefined => {
    if (entry.scope !== scopeKey) return;
    if (entry.retryAt !== undefined && entry.retryAt > now()) {
      return { ...unavailable(entry.result?.errorCode || 'cooldown', now(), entry.retryAt), cached: true };
    }
    if (entry.result && !entry.result.errors?.length && now() - entry.result.fetchedAt >= 0 && now() - entry.result.fetchedAt < 60000) {
      return { ...entry.result, cached: true };
    }
  };
  let saved = await read();
  let ready = reuse(saved);
  if (ready) return ready;
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(lock, 'wx', 0o600);
    await handle.writeFile(String(process.pid));
  } catch (error) {
    if (!hasErrorCode(error, 'EEXIST')) throw error;
    // A crashed worker cannot leave the provider permanently locked.
    const stat = await fs.stat(lock).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > 120000) await fs.unlink(lock).catch(() => {});
    return unavailable('probe_in_progress', now());
  }
  try {
    saved = await read();
    ready = reuse(saved);
    if (ready) return ready;
    const result = await fetchFresh();
    const limited = result.errorCode === 'http_429';
    const failures = limited ? (saved.failures || 0) + 1 : 0;
    const delay = limited
      ? Math.max(Math.min(1800000, 300000 * 2 ** Math.min(failures - 1, 10)), result.retryAfterMs || 0)
      : result.errors?.length && !result.authExpired ? 60000 : 0;
    const record: CacheRecord = {
      result, failures, retryAt: delay ? now() + delay : 0,
      ...(scopeKey === undefined ? {} : { scope: scopeKey }),
    };
    const temp = file + '.' + process.pid + '.tmp';
    await fs.writeFile(temp, JSON.stringify(record), { mode: 0o600 });
    await fs.rename(temp, file);
    return { ...result, ...(record.retryAt ? { retryAt: record.retryAt } : {}) };
  } finally {
    await handle.close();
    await fs.unlink(lock);
  }
}

interface SavedResponse {
  body: ArrayBuffer;
  status: number;
  statusText: string;
  headers: [string, string][];
}

// Response reuse is limited to one probe; authorization never reaches disk.
export function deduplicateUsageFetch(fetchImpl: typeof fetch, onRetryAfter: (delay: number) => void): typeof fetch {
  const requests = new Map<string, Promise<SavedResponse>>();
  return async (url, options = {}) => {
    if (String(url) !== 'https://api.anthropic.com/api/oauth/usage') return fetchImpl(url, options);
    const key = new Headers(options.headers).get('authorization') || '';
    if (!requests.has(key)) {
      requests.set(key, (async () => {
        const response = await fetchImpl(url, options);
        if (response.status === 429) onRetryAfter(retryAfterMs(response.headers.get('retry-after')));
        const body = await response.arrayBuffer();
        return { body, status: response.status, statusText: response.statusText, headers: [...response.headers] };
      })());
    }
    const saved = await requests.get(key)!;
    return new Response(saved.body.slice(0), saved);
  };
}
