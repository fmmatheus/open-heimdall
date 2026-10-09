import { createCoordinatorClient } from '../../coordinator/client.js';
import { loadCoordinatorConfiguration } from '../../coordinator/config.js';
import type { CoordinatorConfiguration } from '../../coordinator/config.js';
import { readCoordinatorToken } from '../../coordinator/token.js';
import type { CoordinatorEvent, ProjectRecord, RunRecord } from '../../coordinator/types.js';

export type PublicRun = Omit<RunRecord, 'ownerToken' | 'specification' | 'binding'> & { settings: unknown };

export type AdapterErrorKind =
  | 'coordinator-offline'
  | 'coordinator-unauthorized'
  | 'coordinator-timeout'
  | 'configuration-invalid'
  | 'not-found'
  | 'coordinator-error';

/** Fixed texts: nothing from the underlying failure (paths, keys, headers, stacks) reaches the panel. */
const MESSAGES: Record<AdapterErrorKind, string> = {
  'coordinator-offline': 'The Heimdall coordinator is not running or cannot be reached.',
  'coordinator-unauthorized': 'The Heimdall coordinator rejected the access key.',
  'coordinator-timeout': 'The Heimdall coordinator did not answer in time.',
  'configuration-invalid': 'The Heimdall coordinator configuration or access key is invalid.',
  'not-found': 'The requested Heimdall record was not found.',
  'coordinator-error': 'The Heimdall coordinator could not complete the request.',
};

export class CoordinatorAdapterError extends Error {
  readonly kind: AdapterErrorKind;
  constructor(kind: AdapterErrorKind) {
    super(MESSAGES[kind]);
    this.name = 'CoordinatorAdapterError';
    this.kind = kind;
  }
}

export const adapterErrorMessage = (kind: AdapterErrorKind): string => MESSAGES[kind];

/** Only the read half of the coordinator client is ever needed here. */
export interface ReadClient {
  request(method: string, route: string): Promise<unknown>;
}

export interface CoordinatorAdapterOptions {
  configPath?: string;
  loadConfiguration?: (configPath?: string) => Promise<CoordinatorConfiguration>;
  readToken?: (stateDirectory: string) => Promise<string>;
  clientFactory?: (endpoint: string, token: string, options: { timeoutMs: number }) => ReadClient;
  timeoutMs?: number;
}

export interface CoordinatorAdapter {
  projects(): Promise<ProjectRecord[]>;
  runs(): Promise<PublicRun[]>;
  run(id: string): Promise<PublicRun>;
  events(after: number): Promise<CoordinatorEvent[]>;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function classify(error: unknown): AdapterErrorKind {
  if (error instanceof CoordinatorAdapterError) return error.kind;
  const message = error instanceof Error ? error.message : '';
  if (/timed out/i.test(message)) return 'coordinator-timeout';
  if (/^Coordinator unavailable/i.test(message)) return 'coordinator-offline';
  if (/authorization required|cannot administer/i.test(message)) return 'coordinator-unauthorized';
  if (/not found/i.test(message)) return 'not-found';
  return 'coordinator-error';
}

export function createCoordinatorAdapter(options: CoordinatorAdapterOptions = {}): CoordinatorAdapter {
  const loadConfiguration = options.loadConfiguration ?? loadCoordinatorConfiguration;
  const readToken = options.readToken ?? readCoordinatorToken;
  const clientFactory = options.clientFactory ?? ((endpoint, token, clientOptions) => createCoordinatorClient(endpoint, token, clientOptions));
  const timeoutMs = options.timeoutMs ?? 8000;
  let client: ReadClient | undefined;

  /** Configuration and key are read lazily and dropped after any failure so a restarted coordinator is picked up. */
  async function connect(): Promise<ReadClient> {
    if (client) return client;
    let configuration: CoordinatorConfiguration;
    try { configuration = await loadConfiguration(options.configPath); }
    catch { throw new CoordinatorAdapterError('configuration-invalid'); }
    let token: string;
    try { token = await readToken(configuration.stateDirectory); }
    catch (error) {
      // No key yet means the coordinator has never started in this state directory.
      throw new CoordinatorAdapterError((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' ? 'coordinator-offline' : 'configuration-invalid');
    }
    client = clientFactory(configuration.endpoint, token, { timeoutMs });
    return client;
  }

  async function get<T>(route: string): Promise<T> {
    try {
      return await (await connect()).request('GET', route) as T;
    } catch (error) {
      const kind = classify(error);
      if (kind !== 'not-found') client = undefined;
      throw new CoordinatorAdapterError(kind);
    }
  }

  return {
    projects: () => get<ProjectRecord[]>('/projects'),
    runs: () => get<PublicRun[]>('/runs'),
    run(id: string) {
      if (typeof id !== 'string' || !IDENTIFIER.test(id)) return Promise.reject(new CoordinatorAdapterError('not-found'));
      return get<PublicRun>(`/runs/${id}`);
    },
    events(after: number) {
      if (!Number.isSafeInteger(after) || after < 0) return Promise.reject(new CoordinatorAdapterError('coordinator-error'));
      return get<CoordinatorEvent[]>(`/events?after=${after}`);
    },
  };
}
