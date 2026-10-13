import { maskSecrets } from '../redaction.js';
import type { ConfigurationOrigin } from './launch-context.js';
import type { CoordinatorMode } from './lifecycle.js';

/** Version of the document `heimdall coordinator start|stop --json` prints. It is independent of `/status` and the lifecycle protocol. */
export const LIFECYCLE_RESULT_SCHEMA_VERSION = 1;

export type LifecycleCommand = 'start' | 'stop';

/**
 * - `ready`: this command started the managed coordinator and it answered the authenticated readiness checks.
 * - `already-running`: the matching managed coordinator was already ready; it was not changed.
 * - `already-running-foreground`: a matching foreground (`serve`) coordinator is ready; nothing was registered.
 * - `shutdown-in-progress`: the matching coordinator is draining or closing; it was not restarted.
 * - `startup-not-confirmed`: a launch was requested but readiness was not established; the instance may still start.
 * - `stop-requested`: the matching coordinator acknowledged a drain request (`stop --no-wait`); it has not necessarily exited.
 * - `stopped`: clean completion evidence for the requested instance and a confirmed clean exit.
 * - `already-stopped`: absence and clean prior ownership were established; nothing was running.
 * - `still-draining`: the wait ended while the coordinator was still draining; it keeps draining.
 * - `completion-unknown`: completion or exit could not be established.
 * - `busy`: another lifecycle operation for the same target held the operation lock for the whole bounded wait.
 * - `conflict`: a foreign registration, mismatched target, changed context or unverifiable endpoint prevented the operation.
 * - `failed`: the operation could not be performed (arguments, configuration, credentials, platform or service manager).
 */
export const LIFECYCLE_OUTCOMES = [
  'ready', 'already-running', 'already-running-foreground', 'shutdown-in-progress', 'startup-not-confirmed',
  'stop-requested', 'stopped', 'already-stopped', 'still-draining', 'completion-unknown', 'busy', 'conflict', 'failed',
] as const;
export type LifecycleOutcome = typeof LIFECYCLE_OUTCOMES[number];

/** Outcomes that mean the requested result was established (exit status 0). */
export const SUCCESS_OUTCOMES: readonly LifecycleOutcome[] = ['ready', 'already-running', 'already-running-foreground', 'stop-requested', 'stopped', 'already-stopped'];

export const LIFECYCLE_ERROR_CODES = [
  'invalid-arguments', 'invalid-configuration', 'invalid-credentials', 'invalid-launch-context', 'unsupported-platform', 'manager-unavailable',
  'launch-failed', 'busy', 'superseded-by-stop', 'context-conflict', 'credential-conflict', 'data-directory-conflict', 'target-mismatch',
  'foreign-registration', 'foreign-definition', 'registered-elsewhere', 'state-unknown', 'inactive-registration-stale', 'running-context-changed',
  'endpoint-unreachable', 'endpoint-refused', 'endpoint-transitioning', 'endpoint-invalid', 'endpoint-not-ready', 'unsupported-lifecycle-protocol',
  'shutdown-in-progress', 'startup-timeout', 'service-exited', 'deadline-exceeded', 'interrupted', 'not-implemented', 'internal',
  'not-managed', 'foreground-coordinator', 'instance-mismatch', 'drain-failed', 'completion-unknown', 'crashed-after-acknowledgement', 'shutdown-failed',
] as const;
export type LifecycleErrorCode = typeof LIFECYCLE_ERROR_CODES[number];

export interface LifecycleTarget {
  configFile: string;
  origin: ConfigurationOrigin;
  stateDirectory: string;
  endpoint: string;
  manager: 'launchd' | 'systemd' | null;
  label: string | null;
}

/** The coordinator instance the result observed, when one answered a validated lifecycle request. */
export interface ObservedInstance { instanceId: string; pid: number; mode: CoordinatorMode }

export interface LifecycleResult {
  schemaVersion: typeof LIFECYCLE_RESULT_SCHEMA_VERSION;
  command: LifecycleCommand;
  /** True exactly when the process exits 0. */
  ok: boolean;
  outcome: LifecycleOutcome;
  /** One-line human summary. */
  message: string;
  /** Null when the arguments or configuration did not resolve to a target. */
  target: LifecycleTarget | null;
  instance: ObservedInstance | null;
  /** Null exactly when `ok`. */
  error: { code: LifecycleErrorCode; message: string } | null;
  /** Where to read process logs when the operation did not complete, otherwise null. */
  logs: string | null;
}

export interface LifecycleResultInput {
  command: LifecycleCommand;
  outcome: LifecycleOutcome;
  message: string;
  target?: LifecycleTarget | null;
  instance?: ObservedInstance | null;
  error?: { code: LifecycleErrorCode; message: string } | null;
  logs?: string | null;
}

export const isSuccessOutcome = (outcome: LifecycleOutcome): boolean => SUCCESS_OUTCOMES.includes(outcome);

const MAXIMUM_TEXT_LENGTH = 2000;

/** Masks known secrets of any length and credential-shaped values, removes control characters and bounds the length. */
export function sanitizeResultText(text: string, secrets: Iterable<string> = []): string {
  const clean = maskSecrets(text, secrets)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\b[0-9a-f]{64}\b/gi, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return clean.length > MAXIMUM_TEXT_LENGTH ? `${clean.slice(0, MAXIMUM_TEXT_LENGTH - 3)}...` : clean;
}

/** Build a result whose invariants hold and whose every string is sanitized with `secrets`. */
export function createLifecycleResult(input: LifecycleResultInput, secrets: Iterable<string> = []): LifecycleResult {
  const known = [...secrets];
  const clean = (text: string) => sanitizeResultText(text, known);
  const ok = isSuccessOutcome(input.outcome);
  const error = input.error ?? null;
  if (ok && error) throw new Error('A successful lifecycle result cannot carry an error');
  if (!ok && !error) throw new Error('A failed lifecycle result requires an error');
  const target = input.target ?? null;
  return {
    schemaVersion: LIFECYCLE_RESULT_SCHEMA_VERSION,
    command: input.command,
    ok,
    outcome: input.outcome,
    message: clean(input.message),
    target: target ? {
      configFile: clean(target.configFile), origin: target.origin, stateDirectory: clean(target.stateDirectory), endpoint: clean(target.endpoint),
      manager: target.manager, label: target.label === null ? null : clean(target.label),
    } : null,
    instance: input.instance ? { instanceId: input.instance.instanceId, pid: input.instance.pid, mode: input.instance.mode } : null,
    error: error ? { code: error.code, message: clean(error.message) } : null,
    logs: input.logs ? clean(input.logs) : null,
  };
}

/** Exit status: 0 when the requested result was established, 2 for unusable arguments, 1 otherwise. */
export function lifecycleExitCode(result: LifecycleResult): number {
  if (result.ok) return 0;
  return result.error?.code === 'invalid-arguments' ? 2 : 1;
}

export function renderLifecycleJson(result: LifecycleResult): string {
  return JSON.stringify(result, null, 2) + '\n';
}

/** Human rendering: a successful result goes to stdout, a failure to stderr. */
export function renderLifecycleText(result: LifecycleResult): string {
  const lines = [result.message];
  if (result.instance) lines.push(`Instance ${result.instance.instanceId} (pid ${result.instance.pid}, ${result.instance.mode}).`);
  if (!result.ok && result.error && result.error.message !== result.message) lines.push(result.error.message);
  if (result.logs) lines.push(result.logs);
  return lines.join('\n') + '\n';
}

const resultKeys = ['schemaVersion', 'command', 'ok', 'outcome', 'message', 'target', 'instance', 'error', 'logs'];
const targetKeys = ['configFile', 'origin', 'stateDirectory', 'endpoint', 'manager', 'label'];

function exactKeys(value: unknown, keys: readonly string[], name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid lifecycle result: ${name} must be an object`);
  const present = Object.keys(value);
  if (present.length !== keys.length || !keys.every(key => present.includes(key))) throw new Error(`Invalid lifecycle result: ${name} must have exactly ${keys.join(', ')}`);
  return value as Record<string, unknown>;
}

/** Strictly validate a lifecycle result document, for consumers and tests of the documented contract. */
export function parseLifecycleResult(value: unknown): LifecycleResult {
  const input = exactKeys(value, resultKeys, 'document');
  if (input.schemaVersion !== LIFECYCLE_RESULT_SCHEMA_VERSION) throw new Error('Invalid lifecycle result: unsupported schemaVersion');
  if (input.command !== 'start' && input.command !== 'stop') throw new Error('Invalid lifecycle result: unknown command');
  if (typeof input.outcome !== 'string' || !(LIFECYCLE_OUTCOMES as readonly string[]).includes(input.outcome)) throw new Error('Invalid lifecycle result: unknown outcome');
  const outcome = input.outcome as LifecycleOutcome;
  if (input.ok !== isSuccessOutcome(outcome)) throw new Error('Invalid lifecycle result: ok contradicts outcome');
  if (typeof input.message !== 'string' || !input.message) throw new Error('Invalid lifecycle result: message must be nonempty text');
  let target: LifecycleTarget | null = null;
  if (input.target !== null) {
    const fields = exactKeys(input.target, targetKeys, 'target');
    if (!['flag', 'env', 'implicit-default'].includes(String(fields.origin))) throw new Error('Invalid lifecycle result: unknown target origin');
    if (fields.manager !== null && fields.manager !== 'launchd' && fields.manager !== 'systemd') throw new Error('Invalid lifecycle result: unknown manager');
    for (const key of ['configFile', 'stateDirectory', 'endpoint']) if (typeof fields[key] !== 'string') throw new Error(`Invalid lifecycle result: target ${key} must be text`);
    if (fields.label !== null && typeof fields.label !== 'string') throw new Error('Invalid lifecycle result: target label must be text or null');
    target = fields as unknown as LifecycleTarget;
  }
  let instance: ObservedInstance | null = null;
  if (input.instance !== null) {
    const fields = exactKeys(input.instance, ['instanceId', 'pid', 'mode'], 'instance');
    if (typeof fields.instanceId !== 'string' || !Number.isSafeInteger(fields.pid) || (fields.mode !== 'managed' && fields.mode !== 'foreground')) throw new Error('Invalid lifecycle result: malformed instance');
    instance = fields as unknown as ObservedInstance;
  }
  let error: LifecycleResult['error'] = null;
  if (input.error !== null) {
    const fields = exactKeys(input.error, ['code', 'message'], 'error');
    if (typeof fields.code !== 'string' || !(LIFECYCLE_ERROR_CODES as readonly string[]).includes(fields.code) || typeof fields.message !== 'string' || !fields.message) throw new Error('Invalid lifecycle result: malformed error');
    error = fields as unknown as LifecycleResult['error'];
  }
  if ((error === null) !== (input.ok === true)) throw new Error('Invalid lifecycle result: error contradicts ok');
  if (input.logs !== null && typeof input.logs !== 'string') throw new Error('Invalid lifecycle result: logs must be text or null');
  return { schemaVersion: LIFECYCLE_RESULT_SCHEMA_VERSION, command: input.command, ok: input.ok as boolean, outcome, message: input.message, target, instance, error, logs: input.logs as string | null };
}
