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
