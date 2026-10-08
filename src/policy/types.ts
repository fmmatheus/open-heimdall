export interface ExecutorCandidate {
  key: string;
  quotaProvider: string;
  model: string;
  variant?: string;
}

export interface QuotaSettings {
  plannerModel?: string;
  minQuotaRemainingPercent: number;
  fiveHourQuotaWeight?: number;
  executorCandidates?: ExecutorCandidate[];
  executorModel: string;
  executorFallbackModel: string;
  packagePath?: string;
}

export interface QuotaEntry {
  name: string;
  percentRemaining: number;
}

export interface QuotaResult {
  fetchedAt: number;
  errors: string[];
  entries: QuotaEntry[];
  authExpired?: boolean;
  errorCode?: string;
  cached?: boolean;
  retryAt?: number;
  retryAfterMs?: number;
  windowCoverage?: 'weekly_only' | 'unspecified';
  codingAllowed?: boolean;
}

export type QuotaSnapshot = Record<string, QuotaResult | undefined>;

export interface CandidateQuotaScore {
  eligible: boolean;
  score: number;
  reason?: string;
  fiveHour?: number | null;
  weekly?: number;
}

export interface ExecutorSelection {
  model: string;
  variant?: string;
  checkedAt: string;
  [candidate: string]: CandidateQuotaScore | string | undefined;
}

export interface QuotaEvent {
  at: string;
  provider: string;
  errorCode: string;
  action: 'reconnect_in_openchamber' | 'refresh_claude_code_manually' | 'cooldown_skip' | 'exclude_from_selection';
  retryAt?: number;
}

export interface RawQuotaResult {
  errors?: Array<string | { message?: string }>;
  statusDetails?: Array<{ key: string; value: unknown }>;
  entries?: QuotaEntry[];
}
