import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readPrivateText, writePrivateFile } from './native/private-files.js';
import { LIFECYCLE_DIRECTORY } from './lifecycle.js';
import type { NativeOwnership, NativeServiceAdapter, StartResult } from './native/types.js';

const RECORD_FILE = 'launch-attempt.json';
const MAXIMUM_RECORD_BYTES = 4096;

/**
 * - `dispatching`: the native start request is about to be issued, is in flight, or its outcome was not recorded
 *   (the invoking process may have died). The manager may still act on it.
 * - `requested`: the manager answered the start request successfully, so no request of this attempt is in flight any
 *   more; whether the service is up, or has since exited, is for observation to say.
 */
export type LaunchAttemptPhase = 'dispatching' | 'requested';

/**
 * Durable evidence that a native start was (or may have been) requested for this target. It lives next to the
 * operation lock, which disappears with the process that held it, and is cleared only once an observation correlates
 * the attempt with the service state: the authenticated instance runs as the owned service's main process, or the
 * service is proven inactive with nothing of this attempt left in flight.
 */
export interface LaunchAttempt {
  schemaVersion: 1;
  attemptId: string;
  manager: 'launchd' | 'systemd';
  label: string;
  /** Milliseconds since the epoch, taken before the request was issued. */
  dispatchedAt: number;
  phase: LaunchAttemptPhase;
  /** Process id of the command that issued the request; informational, never trusted as liveness evidence. */
  ownerPid: number;
}

const recordPath = (stateDirectory: string) => path.join(stateDirectory, LIFECYCLE_DIRECTORY, RECORD_FILE);

function parseAttempt(text: string): LaunchAttempt {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('The launch attempt record is not valid JSON'); }
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const integer = (field: unknown) => typeof field === 'number' && Number.isSafeInteger(field) && field >= 0;
  if (record.schemaVersion !== 1 || typeof record.attemptId !== 'string' || !record.attemptId
    || (record.manager !== 'launchd' && record.manager !== 'systemd') || typeof record.label !== 'string' || !record.label
    || !integer(record.dispatchedAt) || (record.phase !== 'dispatching' && record.phase !== 'requested') || !integer(record.ownerPid)) {
    throw new Error('The launch attempt record is malformed');
  }
  return record as unknown as LaunchAttempt;
}

/** The recorded attempt, or null when none is unresolved. A record that cannot be read is an error, never "none". */
export async function readLaunchAttempt(stateDirectory: string): Promise<LaunchAttempt | null> {
  const text = await readPrivateText(recordPath(stateDirectory), 'The launch attempt record', MAXIMUM_RECORD_BYTES);
  return text === null ? null : parseAttempt(text);
}

/**
 * Record a new attempt (replacing any earlier one) atomically with mode 0600. The caller holds the operation lock and
 * calls this before the native start request can be issued, so a request in flight is never without a record.
 */
export async function writeLaunchAttempt(stateDirectory: string, details: { manager: LaunchAttempt['manager']; label: string; now: number }): Promise<LaunchAttempt> {
  const attempt: LaunchAttempt = {
    schemaVersion: 1, attemptId: randomUUID(), manager: details.manager, label: details.label,
    dispatchedAt: details.now, phase: 'dispatching', ownerPid: process.pid,
  };
  await writePrivateFile(recordPath(stateDirectory), JSON.stringify(attempt));
  return attempt;
}

/** Mark that the manager accepted the request, so nothing of this attempt is still in flight. */
export async function markLaunchRequested(stateDirectory: string, attempt: LaunchAttempt): Promise<void> {
  const current = await readLaunchAttempt(stateDirectory);
  if (current?.attemptId !== attempt.attemptId) return;
  await writePrivateFile(recordPath(stateDirectory), JSON.stringify({ ...current, phase: 'requested' }));
}

/** Remove the record. With `attemptId`, only that attempt's record is removed; a newer attempt stays. */
export async function clearLaunchAttempt(stateDirectory: string, attemptId?: string): Promise<void> {
  if (attemptId !== undefined) {
    const current = await readLaunchAttempt(stateDirectory).catch(() => undefined);
    if (current === null) return;
    if (current !== undefined && current.attemptId !== attemptId) return;
  }
  await fs.rm(recordPath(stateDirectory), { force: true });
}

/**
 * What a finished start request leaves behind. Only a request the manager never received is cleared: a refusal before
 * dispatch, a start that was not needed, and a definitive failure of the tool (it ran and exited nonzero). A success
 * is kept as `requested` until an observation shows the service. A tool that did not finish (`unresolved`) keeps the
 * record `dispatching`, because the manager may still act on a request it already received.
 */
export function afterStart(result: StartResult): 'clear' | 'requested' | 'keep' {
  if (result.outcome === 'started') return 'requested';
  if (result.outcome === 'failed' && result.unresolved) return 'keep';
  return 'clear';
}

export type LaunchAssessment =
  | { kind: 'none' }
  | { kind: 'resolved'; attempt: LaunchAttempt; reason: string }
  | { kind: 'unresolved'; attempt: LaunchAttempt; reason: string };

/**
 * Decide, from one ownership inspection, whether a recorded attempt is still unresolved. Absence of the service is
 * evidence only when nothing of the attempt can still be in flight: the request completed (`requested`), or the
 * manager reports no queued start job. A manager that cannot report queued jobs never resolves a `dispatching`
 * attempt by absence. A running service resolves it only through the authenticated instance, which callers that
 * reached one record with `clearLaunchAttempt` themselves.
 *
 * Reads and clears the record on resolution. Starts, stops and changes nothing in the service manager.
 */
export async function assessLaunchAttempt(stateDirectory: string, adapter: NativeServiceAdapter, ownership: NativeOwnership): Promise<LaunchAssessment> {
  const attempt = await readLaunchAttempt(stateDirectory);
  if (attempt === null) return { kind: 'none' };
  const resolve = async (reason: string): Promise<LaunchAssessment> => {
    await clearLaunchAttempt(stateDirectory, attempt.attemptId);
    return { kind: 'resolved', attempt, reason };
  };
  const unresolved = (reason: string): LaunchAssessment => ({ kind: 'unresolved', attempt, reason });
  const label = adapter.identity().label;
  if (attempt.label !== label) return unresolved(`it was recorded for ${attempt.label}, not ${label}`);
  const { inspection } = ownership;
  if (ownership.kind === 'refused') return unresolved(`the service registration is not confirmed as owned (${ownership.reason})`);
  if (inspection.running === 'unknown') return unresolved(`whether ${label} is running could not be determined (${inspection.detail})`);
  if (inspection.running === true) return unresolved(`${label} runs, but no authenticated coordinator instance confirms it as the started service`);
  if (attempt.phase === 'requested') return resolve(`the service manager accepted the start request and ${label} is not running`);
  if (adapter.startJobPending === undefined) {
    return unresolved(`${attempt.manager} does not report queued start requests, so the request may still be in flight`);
  }
  const pending = await adapter.startJobPending().catch(() => 'unknown' as const);
  if (pending === true) return unresolved(`the service manager still has a start job queued for ${label}`);
  if (pending === 'unknown') return unresolved(`queued start requests of ${label} could not be read`);
  return resolve(`${label} is not running and the service manager has no start request queued for it`);
}

/** The explanation `stop` gives while an attempt is unresolved. */
export function unresolvedLaunchMessage(attempt: LaunchAttempt, reason: string, subject: string): string {
  return `An earlier start request for ${attempt.label} (issued by process ${attempt.ownerPid}) is not resolved: ${reason}. `
    + `It may still launch the coordinator, so ${subject} is not established. Nothing was requested, stopped, killed or restarted. `
    + 'Run `heimdall coordinator status`, and run `heimdall coordinator stop` again once the launch has landed or been ruled out, or `heimdall coordinator start` to start explicitly.';
}
