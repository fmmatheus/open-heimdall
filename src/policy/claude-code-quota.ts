import path from 'node:path';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { retryAfterMs } from './quota-cache.js';
import type { QuotaEntry, QuotaResult } from './types.js';

const executeFile = promisify(execFile);
const usageURL = 'https://api.anthropic.com/api/oauth/usage';
const cacheKey = Symbol.for('heimdall.claude-code.readonly-quota.v1');
const cacheDurationMs = 60000;
const minimumValidityMs = 300000;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** This error contains no store location, command output, account identity or secret. */
export class ClaudeCodeAuthRequired extends Error {
  readonly code = 'claude_auth_required';
  constructor() {
    super('Claude Code authentication needs owner attention before this run can continue.');
    this.name = 'ClaudeCodeAuthRequired';
  }
}

/** Transient input to the probe. Never serialize or log this object. */
export interface ClaudeCodeAccess {
  accessToken: string;
  expiresAt: number;
  scope: string;
}

export interface ClaudeCodeCredentialOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  read?: (file: string, encoding: 'utf8') => Promise<string>;
  execute?: (file: string, args: string[], options: { encoding: 'utf8'; timeout: number; maxBuffer: number }) => Promise<{ stdout: string }>;
}

/** Read the normal selected CLI login in memory; never refresh, copy or write it. */
export async function readClaudeCodeAccess({ env = process.env, platform = process.platform, home = os.homedir(), read = readFile, execute = executeFile }: ClaudeCodeCredentialOptions = {}): Promise<ClaudeCodeAccess> {
  const override = typeof env.CLAUDE_CONFIG_DIR === 'string' && !!env.CLAUDE_CONFIG_DIR.trim();
  const rawDirectory = override ? env.CLAUDE_CONFIG_DIR! : path.join(home, '.claude');
  const directory = path.resolve(rawDirectory);
  const service = override ? 'Claude Code-credentials-' + hash(rawDirectory).slice(0, 8) : 'Claude Code-credentials';
  try {
    const raw = platform === 'darwin'
      ? (await execute('/usr/bin/security', ['find-generic-password', '-s', service, '-w'], { encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024 })).stdout
      : await read(path.join(directory, '.credentials.json'), 'utf8');
    const document: unknown = JSON.parse(raw);
    const value = record(document) && record(document.claudeAiOauth) ? document.claudeAiOauth : undefined;
    if (!value || typeof value.accessToken !== 'string' || !value.accessToken.trim() || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) throw new ClaudeCodeAuthRequired();
    return { accessToken: value.accessToken, expiresAt: value.expiresAt, scope: hash(JSON.stringify([directory, platform === 'darwin' ? service : 'file'])) };
  } catch { throw new ClaudeCodeAuthRequired(); }
}

type ClaudeCodeQuotaEntry = QuotaEntry & { resetTimeIso?: string };
const percent = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100;
function reset(value: unknown): string | undefined {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined;
}

/** Only quota numbers, normalized public window names and valid timestamps leave the probe. */
export function claudeCodeQuotaEntries(payload: unknown): ClaudeCodeQuotaEntry[] {
  const entries: ClaudeCodeQuotaEntry[] = [];
  const add = (name: string, used: unknown, resetsAt: unknown) => {
    if (!percent(used)) return;
    const resetTimeIso = reset(resetsAt);
    entries.push({ name, percentRemaining: 100 - used, ...(resetTimeIso ? { resetTimeIso } : {}) });
  };
  if (!record(payload)) return entries;
  if (Array.isArray(payload.limits) && payload.limits.length) {
    for (const limit of payload.limits) {
      if (!record(limit)) continue;
      if (limit.kind === 'session') add('5h', limit.percent, limit.resets_at);
      else if (limit.kind === 'weekly_all') add('Weekly', limit.percent, limit.resets_at);
      else if (limit.kind === 'weekly_scoped' && record(limit.scope) && record(limit.scope.model) && typeof limit.scope.model.display_name === 'string') {
        // Do not forward arbitrary opaque labels from a provider response.
        const family = /\b(sonnet|opus|haiku|fable)\b/i.exec(limit.scope.model.display_name)?.[1]?.toLowerCase();
        if (family) add((family === 'fable' ? 'Opus' : family[0]!.toUpperCase() + family.slice(1)) + ' Weekly', limit.percent, limit.resets_at);
      }
    }
  } else {
    const fiveHour = record(payload.five_hour) ? payload.five_hour : undefined;
    const sevenDay = record(payload.seven_day) ? payload.seven_day : undefined;
    add('5h', fiveHour?.utilization, fiveHour?.resets_at);
    add('Weekly', sevenDay?.utilization, sevenDay?.resets_at);
  }
  return entries;
}

export interface ClaudeCodeQuotaCacheEntry {
  failures: number;
  retryAt?: number;
  errorCode?: string;
  authRequired?: boolean;
  result?: QuotaResult;
  pending?: Promise<QuotaResult>;
}
export type ClaudeCodeQuotaCache = Map<string, ClaudeCodeQuotaCacheEntry>;
function sharedCache(): ClaudeCodeQuotaCache {
  const global = globalThis as unknown as Record<symbol, unknown>;
  if (!(global[cacheKey] instanceof Map)) global[cacheKey] = new Map();
  return global[cacheKey] as ClaudeCodeQuotaCache;
}

export interface ClaudeCodeQuotaOptions {
  readCredential?: () => Promise<ClaudeCodeAccess>;
  credentialOptions?: ClaudeCodeCredentialOptions;
  fetchImpl?: typeof fetch;
  now?: () => number;
  store?: ClaudeCodeQuotaCache;
  signal?: AbortSignal;
}

const authFailure = (now: number, cached = false): QuotaResult => ({ fetchedAt: now, entries: [], errors: ['claude_auth_required'], authExpired: true, errorCode: 'claude_auth_required', ...(cached ? { cached: true } : {}) });
const failure = (code: string, now: number, extra: Partial<Pick<QuotaResult, 'retryAt' | 'cached'>> = {}): QuotaResult => ({ fetchedAt: now, entries: [], errors: [code], authExpired: false, errorCode: code, ...extra });
const copyResult = (result: QuotaResult, cached = false): QuotaResult => ({ ...result, entries: result.entries.map(entry => ({ ...entry })), errors: [...result.errors], ...(cached ? { cached: true } : {}) });

/** No native integration, credential renewal, login action, disk cache or diagnostic logging. */
export async function readClaudeCodeQuota({ readCredential, credentialOptions, fetchImpl = globalThis.fetch, now = Date.now, store = sharedCache(), signal }: ClaudeCodeQuotaOptions = {}): Promise<QuotaResult> {
  let credential: ClaudeCodeAccess | undefined;
  try { credential = await (readCredential ?? (() => readClaudeCodeAccess(credentialOptions)))(); }
  catch { return authFailure(now()); }
  if (!credential || typeof credential.accessToken !== 'string' || !credential.accessToken.trim() || !Number.isFinite(credential.expiresAt) || credential.expiresAt <= now() + minimumValidityMs || typeof credential.scope !== 'string' || !credential.scope) return authFailure(now());
  const key = hash(JSON.stringify([credential.scope, credential.accessToken]));
  const entry = store.get(key) ?? { failures: 0 };
  if (entry.authRequired) return authFailure(now(), true);
  if (entry.pending) return copyResult(await entry.pending);
  if (entry.retryAt !== undefined && entry.retryAt > now()) return failure(entry.errorCode ?? 'http_429', now(), { retryAt: entry.retryAt, cached: true });
  if (entry.result && now() >= entry.result.fetchedAt && now() - entry.result.fetchedAt < cacheDurationMs) return copyResult(entry.result, true);
  // Install the shared promise before starting fetch, including synchronous fetch failures.
  const pending: Promise<QuotaResult> = Promise.resolve().then(async () => {
    try {
      if (!credential || credential.expiresAt <= now() + minimumValidityMs) return authFailure(now());
      const timeout = AbortSignal.timeout(10000);
      const response = await fetchImpl(usageURL, { method: 'GET', headers: { authorization: 'Bearer ' + credential.accessToken, 'anthropic-beta': 'oauth-2025-04-20' }, signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: 'error' });
      const observedAt = now();
      if (credential.expiresAt <= observedAt + minimumValidityMs) return authFailure(observedAt);
      if (response.status === 401 || response.status === 403) {
        entry.authRequired = true;
        delete entry.result;
        return authFailure(observedAt);
      }
      if (response.status === 429) {
        entry.failures++;
        const delay = Math.max(Math.min(1800000, 300000 * 2 ** Math.min(entry.failures - 1, 10)), retryAfterMs(response.headers.get('retry-after'), observedAt));
        entry.errorCode = 'http_429';
        entry.retryAt = observedAt + delay;
        delete entry.result;
        return failure('http_429', observedAt, { retryAt: entry.retryAt });
      }
      if (!response.ok) return failure(Number.isInteger(response.status) && response.status >= 400 && response.status <= 599 ? 'http_' + response.status : 'quota_unavailable', observedAt);
      let payload: unknown;
      try { payload = await response.json(); } catch { return failure('quota_invalid_response', observedAt); }
      if (credential.expiresAt <= now() + minimumValidityMs) return authFailure(now());
      const entries = claudeCodeQuotaEntries(payload);
      if (!entries.some(entry => entry.name === '5h') || !entries.some(entry => entry.name === 'Weekly')) return failure('quota_missing_windows', observedAt);
      entry.failures = 0;
      entry.retryAt = 0;
      entry.result = { fetchedAt: observedAt, entries, errors: [], authExpired: false };
      return entry.result;
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      return failure(/Timeout|Abort/i.test(name) ? 'timeout' : 'quota_unavailable', now());
    } finally {
      credential = undefined;
      delete entry.pending;
    }
  });
  entry.pending = pending;
  store.set(key, entry);
  return copyResult(await pending);
}

export function createClaudeCodeQuota(options: ClaudeCodeQuotaOptions = {}): () => Promise<QuotaResult> {
  return () => readClaudeCodeQuota(options);
}
