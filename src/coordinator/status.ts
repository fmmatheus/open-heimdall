export const COORDINATOR_STATUS_SCHEMA_VERSION = 1;
export const COORDINATOR_SERVICE_ID = 'heimdall-coordinator';

export interface CoordinatorStatus {
  schemaVersion: typeof COORDINATOR_STATUS_SCHEMA_VERSION;
  service: typeof COORDINATOR_SERVICE_ID;
  status: 'running' | 'draining';
  acceptingNewRuns: boolean;
  queuedRuns: number;
  reservedRuns: number;
}

const keys = ['schemaVersion', 'service', 'status', 'acceptingNewRuns', 'queuedRuns', 'reservedRuns'] as const;

function count(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid coordinator status: ${name} must be a nonnegative integer`);
  return value;
}

/** Validate a coordinator status document strictly and return a fresh object holding only the contract fields. */
export function parseCoordinatorStatus(value: unknown): CoordinatorStatus {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid coordinator status: expected an object');
  const input = value as Record<string, unknown>;
  const present = Object.keys(input);
  for (const key of present) if (!(keys as readonly string[]).includes(key)) throw new Error(`Invalid coordinator status: unexpected field ${key}`);
  for (const key of keys) if (!present.includes(key)) throw new Error(`Invalid coordinator status: missing field ${key}`);
  if (input.schemaVersion !== COORDINATOR_STATUS_SCHEMA_VERSION) throw new Error('Invalid coordinator status: unsupported schemaVersion');
  if (input.service !== COORDINATOR_SERVICE_ID) throw new Error('Invalid coordinator status: unexpected service');
  if (input.status !== 'running' && input.status !== 'draining') throw new Error('Invalid coordinator status: unknown status');
  if (typeof input.acceptingNewRuns !== 'boolean') throw new Error('Invalid coordinator status: acceptingNewRuns must be a boolean');
  if ((input.status === 'running') !== input.acceptingNewRuns) throw new Error('Invalid coordinator status: acceptingNewRuns contradicts status');
  return {
    schemaVersion: COORDINATOR_STATUS_SCHEMA_VERSION,
    service: COORDINATOR_SERVICE_ID,
    status: input.status,
    acceptingNewRuns: input.acceptingNewRuns,
    queuedRuns: count(input.queuedRuns, 'queuedRuns'),
    reservedRuns: count(input.reservedRuns, 'reservedRuns'),
  };
}
