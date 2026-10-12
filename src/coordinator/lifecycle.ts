import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { COORDINATOR_SERVICE_ID } from './status.js';
import { privateFile } from './token.js';
import type { createCoordinatorClient } from './client.js';

/** Version of the lifecycle contract. It is independent of the `/status` schema version. */
export const COORDINATOR_LIFECYCLE_PROTOCOL = 1;
export const LIFECYCLE_DIRECTORY = 'lifecycle';
export const INSTANCE_RECORD = 'instance.json';

export type CoordinatorMode = 'managed' | 'foreground';
export type CoordinatorPhase = 'running' | 'draining' | 'drain-failed' | 'closing';

/** How this process was launched. A managed instance names its native service manager label. */
export interface LifecycleOptions {
  mode: CoordinatorMode;
  label?: string;
}

/** Identity of one coordinator process. Never reused across restarts. */
export interface CoordinatorInstance {
  instanceId: string;
  pid: number;
  startedAt: number;
  stateDirectory: string;
  endpoint: string;
  mode: CoordinatorMode;
  manager: string | null;
}

export interface CoordinatorShutdownSummary {
  requestedAt: number;
  error: string | null;
}

export interface CoordinatorLifecycle extends CoordinatorInstance {
  lifecycleProtocol: typeof COORDINATOR_LIFECYCLE_PROTOCOL;
  service: typeof COORDINATOR_SERVICE_ID;
  phase: CoordinatorPhase;
  shutdown: CoordinatorShutdownSummary | null;
}

const instanceKeys = ['instanceId', 'pid', 'startedAt', 'stateDirectory', 'endpoint', 'mode', 'manager'] as const;
const recordKeys = ['lifecycleProtocol', 'service', ...instanceKeys] as const;
const documentKeys = [...recordKeys, 'phase', 'shutdown'] as const;
const shutdownKeys = ['requestedAt', 'error'] as const;
const phases: readonly string[] = ['running', 'draining', 'drain-failed', 'closing'];
const managerLabel = /^[A-Za-z0-9][A-Za-z0-9._@:-]{0,254}$/;
const instanceIdentifier = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_ERROR_LENGTH = 2000;

function strictObject(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid coordinator ${name}: expected an object`);
  const input = value as Record<string, unknown>;
  const present = Object.keys(input);
  for (const key of present) if (!keys.includes(key)) throw new Error(`Invalid coordinator ${name}: unexpected field ${key}`);
  for (const key of keys) if (!present.includes(key)) throw new Error(`Invalid coordinator ${name}: missing field ${key}`);
  return input;
}

function integer(value: unknown, field: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid coordinator lifecycle: ${field} must be an integer of at least ${minimum}`);
  return value;
}

function nonemptyText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid coordinator lifecycle: ${field} must be nonempty text`);
  return value;
}

function instanceFrom(input: Record<string, unknown>): CoordinatorInstance {
  const instanceId = input.instanceId;
  if (typeof instanceId !== 'string' || !instanceIdentifier.test(instanceId)) throw new Error('Invalid coordinator lifecycle: instanceId must be a UUID');
  if (input.mode !== 'managed' && input.mode !== 'foreground') throw new Error('Invalid coordinator lifecycle: unknown mode');
  let manager: string | null;
  if (input.manager === null) manager = null;
  else if (typeof input.manager === 'string' && managerLabel.test(input.manager)) manager = input.manager;
  else throw new Error('Invalid coordinator lifecycle: manager must be a service label or null');
  if ((input.mode === 'managed') !== (manager !== null)) throw new Error('Invalid coordinator lifecycle: manager contradicts mode');
  return {
    instanceId, pid: integer(input.pid, 'pid', 1), startedAt: integer(input.startedAt, 'startedAt', 0),
    stateDirectory: nonemptyText(input.stateDirectory, 'stateDirectory'), endpoint: nonemptyText(input.endpoint, 'endpoint'),
    mode: input.mode, manager,
  };
}

function header(input: Record<string, unknown>): void {
  if (input.lifecycleProtocol !== COORDINATOR_LIFECYCLE_PROTOCOL) throw new Error('Invalid coordinator lifecycle: unsupported lifecycleProtocol');
  if (input.service !== COORDINATOR_SERVICE_ID) throw new Error('Invalid coordinator lifecycle: unexpected service');
}

function shutdownFrom(value: unknown): CoordinatorShutdownSummary {
  const input = strictObject(value, shutdownKeys, 'lifecycle shutdown');
  let error: string | null;
  if (input.error === null) error = null;
  else if (typeof input.error === 'string' && input.error.trim() && input.error.length <= MAX_ERROR_LENGTH) error = input.error;
  else throw new Error('Invalid coordinator lifecycle: shutdown error must be null or bounded nonempty text');
  return { requestedAt: integer(input.requestedAt, 'shutdown.requestedAt', 0), error };
}

/** Validate a lifecycle document strictly and return a fresh object holding only the contract fields. */
export function parseCoordinatorLifecycle(value: unknown): CoordinatorLifecycle {
  const input = strictObject(value, documentKeys, 'lifecycle');
  header(input);
  const instance = instanceFrom(input);
  if (typeof input.phase !== 'string' || !phases.includes(input.phase)) throw new Error('Invalid coordinator lifecycle: unknown phase');
  const phase = input.phase as CoordinatorPhase;
  const shutdown = input.shutdown === null ? null : shutdownFrom(input.shutdown);
  if ((phase === 'running') !== (shutdown === null)) throw new Error('Invalid coordinator lifecycle: shutdown contradicts phase');
  if (shutdown && (phase === 'drain-failed') !== (shutdown.error !== null)) throw new Error('Invalid coordinator lifecycle: shutdown error contradicts phase');
  return { lifecycleProtocol: COORDINATOR_LIFECYCLE_PROTOCOL, service: COORDINATOR_SERVICE_ID, ...instance, phase, shutdown };
}

/** Validate the identity record persisted for one coordinator process. */
export function parseCoordinatorInstanceRecord(value: unknown): CoordinatorInstance {
  const input = strictObject(value, recordKeys, 'instance record');
  header(input);
  return instanceFrom(input);
}

/** Describe a new coordinator process. Managed instances must name their native service manager label. */
export function createCoordinatorInstance(input: { stateDirectory: string; endpoint: string; lifecycle?: LifecycleOptions }): CoordinatorInstance {
  const lifecycle = input.lifecycle ?? { mode: 'foreground' as const };
  if (lifecycle.mode !== 'managed' && lifecycle.mode !== 'foreground') throw new Error('Coordinator lifecycle mode must be managed or foreground');
  if (lifecycle.mode === 'managed' && !(typeof lifecycle.label === 'string' && managerLabel.test(lifecycle.label))) throw new Error('A managed coordinator requires a valid service label');
  if (lifecycle.mode === 'foreground' && lifecycle.label !== undefined) throw new Error('A foreground coordinator has no service label');
  return {
    instanceId: randomUUID(), pid: process.pid, startedAt: Date.now(),
    stateDirectory: input.stateDirectory, endpoint: input.endpoint,
    mode: lifecycle.mode, manager: lifecycle.mode === 'managed' ? lifecycle.label! : null,
  };
}

export function buildCoordinatorLifecycle(instance: CoordinatorInstance, state: { phase: CoordinatorPhase; shutdown: CoordinatorShutdownSummary | null }): CoordinatorLifecycle {
  return parseCoordinatorLifecycle({ lifecycleProtocol: COORDINATOR_LIFECYCLE_PROTOCOL, service: COORDINATOR_SERVICE_ID, ...instance, phase: state.phase, shutdown: state.shutdown });
}

/**
 * Create or validate the private lifecycle record directory. An existing directory is never repaired:
 * it must be a real directory owned by this user with no group or other access.
 */
export async function privateLifecycleDirectory(stateDirectory: string): Promise<string> {
  const directory = path.join(stateDirectory, LIFECYCLE_DIRECTORY);
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Coordinator lifecycle path must be a private directory, not a symbolic link or file');
  if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) throw new Error('Coordinator lifecycle directory must belong to this user and have mode 0700');
  return directory;
}

/** Atomically publish the instance record with mode 0600 after validating any record it replaces. */
export async function writeInstanceRecord(stateDirectory: string, instance: CoordinatorInstance): Promise<string> {
  const directory = await privateLifecycleDirectory(stateDirectory);
  const target = path.join(directory, INSTANCE_RECORD);
  try { await privateFile(target); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`Existing coordinator instance record is not private: ${(error as Error).message}`);
  }
  const temporary = path.join(directory, `.${INSTANCE_RECORD}.${randomUUID()}.tmp`);
  const document = { lifecycleProtocol: COORDINATOR_LIFECYCLE_PROTOCOL, service: COORDINATOR_SERVICE_ID, ...instance };
  try {
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
    try { await handle.writeFile(JSON.stringify(document)); await handle.sync(); }
    finally { await handle.close(); }
    await privateFile(temporary);
    await fs.rename(temporary, target);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return target;
}

/** Read the persisted identity record of the last coordinator process that owned this state. */
export async function readInstanceRecord(stateDirectory: string): Promise<CoordinatorInstance> {
  const directory = await privateLifecycleDirectory(stateDirectory);
  const target = path.join(directory, INSTANCE_RECORD);
  await privateFile(target);
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw new Error('Coordinator instance record must be a private regular file');
    let value: unknown;
    try { value = JSON.parse(await handle.readFile('utf8')); }
    catch { throw new Error('Invalid coordinator instance record'); }
    return parseCoordinatorInstanceRecord(value);
  } finally { await handle.close(); }
}

/**
 * Fetch and validate the lifecycle identity of the coordinator behind `client`.
 * An older coordinator without the lifecycle contract answers 404; no signal fallback exists for it.
 */
export async function fetchCoordinatorLifecycle(client: ReturnType<typeof createCoordinatorClient>): Promise<CoordinatorLifecycle> {
  let value: unknown;
  try { value = await client.request('GET', '/lifecycle'); }
  catch (error) {
    if ((error as { statusCode?: number }).statusCode === 404) throw Object.assign(new Error('Coordinator does not support the lifecycle protocol; it was started by an older Heimdall version'), { statusCode: 404 });
    throw error;
  }
  return parseCoordinatorLifecycle(value);
}
