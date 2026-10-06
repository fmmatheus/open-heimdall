import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { cachedQuota, deduplicateUsageFetch } from './quota-cache.js';
import type { CandidateQuotaScore, ExecutorSelection, QuotaEvent, QuotaResult, QuotaSettings, QuotaSnapshot, RawQuotaResult } from './types.js';

export function chooseExecutor(snapshot: QuotaSnapshot, settings: QuotaSettings): ExecutorSelection {
  const weight = settings.fiveHourQuotaWeight ?? 0.6;
  if (!(weight > 0 && weight < 1)) throw new Error('Quota weight must be between zero and one');
  const score = (key: string, exclude: RegExp): CandidateQuotaScore => {
    try {
      const provider = snapshot[key];
      if (!provider || provider.errors?.length || !provider.entries?.length || !Number.isFinite(provider.fetchedAt) || Date.now() - provider.fetchedAt > 60000 || provider.fetchedAt > Date.now() + 5000) throw new Error('Fresh quota unavailable for ' + key);
      const entries = provider.entries.filter(entry => !exclude.test(entry.name));
      if (!entries.length || entries.some(entry => !Number.isFinite(entry.percentRemaining) || entry.percentRemaining < 0 || entry.percentRemaining > 100)) throw new Error('Invalid quota for ' + key);
      const short = entries.filter(entry => /5h|five.hour|five_hour/i.test(entry.name));
      const weekly = entries.filter(entry => /week|7.day|seven.day/i.test(entry.name));
      const weeklyOnly = key === 'openai' && provider.windowCoverage === 'weekly_only';
      if ((!short.length && !weeklyOnly) || !weekly.length) throw new Error('Missing five-hour or weekly quota for ' + key);
      if (provider.codingAllowed === false) throw new Error('Provider reports coding unavailable for ' + key);
      const fiveHour = short.length ? Math.min(...short.map(entry => entry.percentRemaining)) : null;
      const week = Math.min(...weekly.map(entry => entry.percentRemaining));
      const eligible = Math.min(...entries.map(entry => entry.percentRemaining)) >= settings.minQuotaRemainingPercent && (weeklyOnly || (fiveHour !== null && fiveHour > 0)) && week > 0;
      return {
        fiveHour, weekly: week, eligible, reason: eligible ? undefined : 'Below quota reserve',
        score: eligible ? (weeklyOnly ? week : 1 / (weight / fiveHour! + (1 - weight) / week)) : 0,
      };
    } catch (error) { return { eligible: false, score: 0, reason: errorMessage(error) }; }
  };
  const candidates = settings.executorCandidates || [
    { key: 'sonnet', quotaProvider: 'anthropic', model: settings.executorModel },
    { key: 'kimi', quotaProvider: 'kimi', model: settings.executorFallbackModel },
  ];
  for (const candidate of candidates) {
    if (['model', 'variant', 'checkedAt'].includes(candidate.key)) throw new Error('Executor candidate key is a reserved selection field: ' + candidate.key);
  }
  const scores: Record<string, CandidateQuotaScore> = Object.fromEntries(candidates.map(candidate => [
    candidate.key,
    score(candidate.quotaProvider, candidate.quotaProvider === 'anthropic' ? /fable|opus/i : candidate.quotaProvider === 'openai' ? /code.?review/i : /$^/),
  ]));
  let winner: (typeof candidates)[number] | undefined;
  for (const candidate of candidates) {
    if (scores[candidate.key]!.eligible && (!winner || scores[candidate.key]!.score > scores[winner.key]!.score)) winner = candidate;
  }
  if (!winner) throw new Error('No eligible quota provider: ' + candidates.map(candidate => candidate.quotaProvider + ': ' + scores[candidate.key]!.reason).join('; '));
  return { model: winner.model, variant: winner.variant, ...scores, checkedAt: new Date().toISOString() };
}

function errorMessage(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string' && error.message) return error.message;
  return String(error);
}

export const authExpired = (error: unknown): boolean => /\b401\b|token.{0,30}expir|unauthoriz|unauthenticated|not authenticated|not logged in|invalid.{0,15}(token|credential)|authentication.{0,20}(fail|expir)/i.test(String(error));

interface IntegrationApi {
  connection?: {
    active?: (provider: string) => Promise<{ type?: string; [field: string]: unknown } | undefined>;
    resolve?: (connection: unknown) => Promise<{ type?: string; access?: string; expires?: number } | undefined>;
  };
}

export async function refreshClaudeAuth(integration: unknown): Promise<true> {
  const api = integration as IntegrationApi | undefined;
  if (!api?.connection?.active || !api.connection.resolve) throw new Error('Anthropic authentication requires the OpenCode integration API');
  const connection = await api.connection.active('anthropic');
  if (connection?.type !== 'credential') throw new Error('Reconnect Anthropic in OpenChamber, then resume this run');
  // OpenCode owns refresh tokens and persistence. Never copy or mutate auth.json.
  const value = await api.connection.resolve(connection);
  if (value?.type !== 'oauth' || !value.access || (Number.isFinite(value.expires) && value.expires! <= Date.now())) throw new Error('Reconnect Anthropic in OpenChamber, then resume this run');
  return true;
}

interface CodexUsage {
  rate_limit?: {
    primary_window?: { limit_window_seconds?: number; used_percent?: number };
    secondary_window?: unknown;
    allowed?: boolean;
    limit_reached?: boolean;
  };
}

export function codexWindowMetadata(data: unknown): Pick<QuotaResult, 'windowCoverage' | 'codingAllowed'> {
  const rate = (data as CodexUsage | undefined)?.rate_limit;
  const weeklyOnly = rate?.primary_window?.limit_window_seconds === 604800 && Number.isFinite(rate.primary_window.used_percent) && rate.secondary_window === null;
  return {
    windowCoverage: weeklyOnly ? 'weekly_only' : 'unspecified',
    codingAllowed: rate?.allowed === false || rate?.limit_reached === true ? false : rate?.allowed === true ? true : undefined,
  };
}

export function sanitizeQuotaResult(key: string, result: RawQuotaResult): QuotaResult {
  const diagnostics = [
    ...(result.errors || []).map(error => typeof error === 'string' ? error : error.message || ''),
    ...(result.statusDetails || []).filter(detail => ['auth_status', 'message'].includes(detail.key)).map(detail => detail.value),
  ];
  const diagnostic = diagnostics.join(' ');
  const failed = !!result.errors?.length || !result.entries?.length;
  const expired = failed && key === 'anthropic' && authExpired(diagnostic);
  const status = diagnostic.match(/\b(?:HTTP\s*|status[:= ]*)([45]\d{2})\b/i)?.[1];
  const category = expired ? 'authentication' : /timeout|timed out/i.test(diagnostic) ? 'timeout' : status ? 'http_' + status : 'quota_unavailable';
  return {
    fetchedAt: Date.now(), authExpired: expired, errorCode: failed ? category : undefined,
    errors: failed ? [category] : [],
    entries: (result.entries || []).map(entry => ({ name: entry.name, percentRemaining: entry.percentRemaining })),
  };
}

export type QuotaModuleLoader = (file: string) => Promise<unknown>;
export type QuotaModuleResolver = (specifier: string) => string;
const require = createRequire(import.meta.url);
const packageName = '@slkiser/opencode-quota';
const packageVersion = '5.0.1';
const moduleFiles = {
  auth: 'dist/lib/opencode-auth.js',
  anthropic: 'dist/providers/anthropic.js',
  kimi: 'dist/providers/kimi-code.js',
  openai: 'dist/providers/openai.js',
} as const;

// The pinned v5 adapter is the only place that knows dependency-internal paths.
export async function resolveQuotaPackage(packagePath?: string, resolveModule: QuotaModuleResolver = specifier => require.resolve(specifier)): Promise<string> {
  let base = packagePath;
  if (!base) {
    const entry = resolveModule(packageName);
    let directory = path.dirname(entry);
    while (true) {
      try {
        const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')) as { name?: string };
        if (manifest.name === packageName) { base = directory; break; }
      } catch (error) {
        if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error('Cannot locate installed ' + packageName + ' package');
      directory = parent;
    }
  }
  const manifest = JSON.parse(await readFile(path.join(base, 'package.json'), 'utf8')) as { name?: string; version?: string };
  if (manifest.name !== packageName || manifest.version !== packageVersion) throw new Error('Quota requires the pinned official ' + packageName + ' ' + packageVersion + ' package');
  return base;
}

interface CredentialRow {
  id?: string;
  integrationId: string;
  resolveError?: unknown;
  value?: { type?: string; key?: string; access?: string; expires?: number };
}
interface CredentialRequest {
  integrationIds: string[];
  methods?: string[];
  firstOnly?: boolean;
}
interface CredentialSource {
  kind: string;
  readRows: (request: CredentialRequest) => Promise<CredentialRow[]>;
}
interface AuthModule {
  notifyCredentialsChanged: () => void;
  createIntegrationCredentialSource: (integration: unknown) => CredentialSource;
  bindCredentialSource: (source: CredentialSource) => () => void;
}
interface Provider {
  fetch: (options: { config: { requestTimeoutMs: number; providerCacheTtlMs: number } }) => Promise<RawQuotaResult>;
}

export interface QuotaPackageLoaderOptions {
  packagePath?: string;
  load?: QuotaModuleLoader;
  resolveModule?: QuotaModuleResolver;
}

export async function createQuotaPackageLoader({ packagePath, load = file => import(pathToFileURL(file).href), resolveModule }: QuotaPackageLoaderOptions = {}) {
  const base = await resolveQuotaPackage(packagePath, resolveModule);
  return {
    auth: async (): Promise<AuthModule> => await load(path.join(base, moduleFiles.auth)) as AuthModule,
    providers: async (): Promise<[Provider, Provider, Provider]> => {
      const [anthropic, kimi, openai] = await Promise.all([
        load(path.join(base, moduleFiles.anthropic)), load(path.join(base, moduleFiles.kimi)), load(path.join(base, moduleFiles.openai)),
      ]);
      return [
        (anthropic as { anthropicProvider: Provider }).anthropicProvider,
        (kimi as { kimiCodePlanGlobalProvider: Provider }).kimiCodePlanGlobalProvider,
        (openai as { openaiProvider: Provider }).openaiProvider,
      ];
    },
  };
}

export interface QuotaProbeOptions extends Omit<QuotaPackageLoaderOptions, 'packagePath'> {
  integration?: unknown;
  directory?: string;
  workflowRoot?: string;
  cacheDirectory?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export interface QuotaOptions extends QuotaProbeOptions {
  probe?: (settings: QuotaSettings, options: QuotaProbeOptions) => Promise<QuotaSnapshot>;
  log?: (entry: QuotaEvent) => Promise<unknown>;
  logPath?: string;
}

export async function fetchQuota(settings: QuotaSettings, options: QuotaOptions = {}): Promise<QuotaSnapshot> {
  const {
    integration, directory = process.cwd(), workflowRoot = path.join(directory, '.heimdall'),
    probe = probeQuota, logPath = path.join(workflowRoot, 'quota-events.jsonl'),
  } = options;
  if (!(integration as IntegrationApi | undefined)?.connection?.resolve) throw new Error('Quota requires the native OpenCode integration API');
  const log = options.log ?? (async (entry: QuotaEvent) => {
    await mkdir(path.dirname(logPath), { recursive: true, mode: 0o700 });
    await appendFile(logPath, JSON.stringify(entry) + '\n', { mode: 0o600 });
  });
  const result = await probe(settings, { ...options, integration, directory, workflowRoot });
  for (const [provider, value] of Object.entries(result)) {
    if (value?.errors?.length) await log({
      at: new Date().toISOString(), provider, errorCode: value.errorCode || 'quota_unavailable',
      action: value.authExpired ? 'reconnect_in_openchamber' : value.cached ? 'cooldown_skip' : 'exclude_from_selection',
      retryAt: value.retryAt,
    });
  }
  if (result.anthropic?.authExpired) {
    throw new Error('Anthropic authentication unavailable after OpenCode credential resolution. Reconnect Anthropic in OpenChamber, then resume this run.');
  }
  return result;
}

export function createQuota(options: QuotaOptions): (settings: QuotaSettings) => Promise<QuotaSnapshot> {
  return settings => fetchQuota(settings, options);
}

// Serialize temporary credential bindings and fetch observation within this module.
let probeTail: Promise<unknown> = Promise.resolve();
export function probeQuota(settings: QuotaSettings, options: QuotaProbeOptions): Promise<QuotaSnapshot> {
  const pending = probeTail.then(() => performProbe(settings, options));
  probeTail = pending.catch(() => {});
  return pending;
}

type ProviderKey = 'anthropic' | 'kimi' | 'openai';
interface NativeCredential { row?: CredentialRow; token?: string; valid: boolean; scope?: string }

async function performProbe(settings: QuotaSettings, {
  integration, directory = process.cwd(), workflowRoot = path.join(directory, '.heimdall'),
  cacheDirectory = path.join(workflowRoot, 'quota-cache'), load, resolveModule, fetchImpl = globalThis.fetch, now = Date.now,
}: QuotaProbeOptions): Promise<QuotaSnapshot> {
  const loader = await createQuotaPackageLoader({ packagePath: settings.packagePath, load, resolveModule });
  const auth = await loader.auth();
  auth.notifyCredentialsChanged();
  const source = auth.createIntegrationCredentialSource(integration);
  const integrations: Record<ProviderKey, string> = { anthropic: 'anthropic', kimi: 'kimi-code-plan-global', openai: 'openai' };
  const native = {} as Record<ProviderKey, NativeCredential>;
  for (const key of Object.keys(integrations) as ProviderKey[]) {
    const integrationID = integrations[key];
    // Resolve the active account before considering cached quota, without CLI/env fallback.
    const rows = await source.readRows({ integrationIds: [integrationID], methods: [key === 'kimi' ? 'key' : 'oauth'], firstOnly: true });
    const row = rows.find(entry => entry.integrationId === integrationID);
    const token = key === 'kimi' ? row?.value?.key : row?.value?.access;
    const valid = !!row && !row.resolveError && typeof token === 'string' && !!token && (key === 'kimi' || (Number.isFinite(row.value?.expires) && row.value!.expires! > now()));
    native[key] = {
      row, token, valid,
      scope: valid ? createHash('sha256').update(JSON.stringify([integrationID, row?.id, row?.value?.type])).digest('hex') : undefined,
    };
  }
  const unbind = auth.bindCredentialSource({
    kind: source.kind,
    readRows: async request => (Object.keys(native) as ProviderKey[])
      .filter(key => native[key].valid && request.integrationIds.includes(integrations[key]) && (!request.methods || request.methods.includes(key === 'kimi' ? 'key' : 'oauth')))
      .map(key => native[key].row!),
  });
  let retryDelay = 0;
  let openaiMetadata: Pick<QuotaResult, 'windowCoverage' | 'codingAllowed'> = {};
  const observed = new Map<ProviderKey, number>();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const response = await fetchImpl(url, options);
    const key: ProviderKey | undefined = String(url) === 'https://api.anthropic.com/api/oauth/usage' ? 'anthropic'
      : String(url) === 'https://chatgpt.com/backend-api/wham/usage' ? 'openai'
      : /^https:\/\/api\.kimi\.(ai|com)\/coding\/v1\/usages(?:\?|$)/.test(String(url)) ? 'kimi' : undefined;
    const sentToken = new Headers(options?.headers ?? (url instanceof Request ? url.headers : undefined)).get('authorization');
    const matched = key && native[key].valid && sentToken === `Bearer ${native[key].token}`;
    if (matched) observed.set(key, now());
    if (matched && key === 'openai' && response.ok) {
      try { openaiMetadata = codexWindowMetadata(await response.clone().json()); } catch {}
    }
    return response;
  };
  globalThis.fetch = deduplicateUsageFetch(globalThis.fetch, delay => { retryDelay = Math.max(retryDelay, delay); });
  try {
    const [anthropicProvider, kimiProvider, openaiProvider] = await loader.providers();
    const result: QuotaSnapshot = {};
    const providers: [ProviderKey, Provider][] = [['anthropic', anthropicProvider], ['kimi', kimiProvider], ['openai', openaiProvider]];
    await Promise.all(providers.map(async ([key, provider]) => {
      if (!native[key].valid) {
        result[key] = { fetchedAt: now(), authExpired: key === 'anthropic', errorCode: 'native_credential_unavailable', errors: ['native_credential_unavailable'], entries: [] };
        return;
      }
      result[key] = await cachedQuota(key, async () => {
        try {
          const raw = await provider.fetch({ config: { requestTimeoutMs: 10000, providerCacheTtlMs: 0 } });
          const value = sanitizeQuotaResult(key, raw);
          if (!value.errors.length && !observed.has(key)) return { fetchedAt: now(), errorCode: 'fresh_quota_not_observed', errors: ['fresh_quota_not_observed'], entries: [] };
          if (observed.has(key)) value.fetchedAt = observed.get(key)!;
          if (key === 'openai') Object.assign(value, openaiMetadata);
          if (key === 'anthropic' && value.errorCode === 'http_429') value.retryAfterMs = retryDelay;
          return value;
        } catch (error) {
          return sanitizeQuotaResult(key, { errors: [{ message: errorMessage(error) }], entries: [] });
        }
      }, { directory: cacheDirectory, now, scope: native[key].scope });
    }));
    return result;
  } finally {
    globalThis.fetch = originalFetch;
    unbind();
  }
}
