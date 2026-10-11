import type { Plugin } from '@opencode/plugin';

/** The native API contract used by the extracted workflow. */
export type NativeContext = Pick<Plugin.Context, 'tool' | 'session'>;
export type NativeTool = Awaited<ReturnType<NativeContext['tool']['list']>>[number];
export type NativeToolContext = Parameters<NativeTool['execute']>[1];

export interface ObservedSession {
  id: string;
  parentID?: string;
  outcome?: string;
  time?: { idle?: number };
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  location?: { directory?: string };
}

export interface SessionSnapshot {
  session: ObservedSession;
  active: boolean;
  inbox: unknown[];
  permissions: unknown[];
  forms: unknown[];
  messages: unknown[];
}

export type SessionObserver = (id: string, signal?: AbortSignal) => Promise<SessionSnapshot>;

/** A projected message of the full session archive. Only the identity fields are validated by the reader. */
export interface HistoryMessage {
  id: string;
  type: string;
  [key: string]: unknown;
}

/**
 * The complete projected message archive of a session in native order (newest first), independent of compaction.
 * Implementations throw an OriginProofError instead of ever truncating or reordering the history.
 */
export type MessageHistory = (sessionID: string, signal?: AbortSignal) => AsyncIterable<HistoryMessage>;

/** Bounded reasons a submission origin cannot be proven. They never carry transcript text. */
export type OriginFailure =
  | 'history_unavailable' | 'page_malformed' | 'cursor_repeated' | 'duplicate_message' | 'scan_exhausted'
  | 'call_not_found' | 'agent_mismatch' | 'call_mismatch' | 'prompt_not_found';

export class OriginProofError extends Error {
  readonly reason: OriginFailure;
  constructor(reason: OriginFailure) {
    super('Submission origin could not be verified (' + reason + ')');
    this.name = 'OriginProofError';
    this.reason = reason;
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  raw?: boolean;
}

export interface SessionAPI {
  request(route: string, options?: RequestOptions): Promise<unknown>;
  version?: string;
  pid?: number;
}
