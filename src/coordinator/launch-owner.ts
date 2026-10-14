import { afterStart, clearLaunchAttempt, markLaunchRequested, recordLaunchClient, writeLaunchAttempt } from './lifecycle-launch.js';
import type { LaunchAttempt } from './lifecycle-launch.js';
import type { ClientWitness, LaunchRecord } from './native/types.js';

/**
 * The single writer of one launch attempt's record. A `start` that holds the operation lock creates one owner per
 * attempt and routes every record change through it: the attempt's creation, the publication of its released client,
 * and its settlement (cleared, marked requested or kept).
 *
 * - Changes run one after another, in the order they were asked for. A publication therefore cannot interleave with the
 *   settlement of the attempt, and a clear cannot be followed by a write that recreates the record.
 * - Once the attempt is settled it accepts nothing more, so no late publication can bring a cleared record back.
 * - `close` ends the ownership. It refuses anything new and resolves when everything already accepted has finished; the
 *   command keeps its lock until then, so no write of this attempt can complete after another operation was admitted
 *   and no change can ever touch a newer attempt's record.
 *
 * Which of the three evidence dispositions applies is decided where the evidence is: the runner reports whether the
 * tool was never run, ran to an observed exit, or was left running (`CommandResult.unresolved`), and `afterStart` maps
 * that to clear, requested or keep. The owner only carries it out.
 */
export interface LaunchAttemptOwner {
  /** What `launchNativeService` calls before and after the start request. */
  readonly record: LaunchRecord;
  /** What the runner calls, for a released client, before it may be told to run its tool. */
  readonly witness: ClientWitness;
  /** Refuse further changes; resolves once every change accepted so far has settled. Idempotent. */
  close(): Promise<void>;
}

export function createLaunchAttemptOwner(stateDirectory: string, details: { manager: LaunchAttempt['manager']; label: string; now(): number }): LaunchAttemptOwner {
  let attempt: LaunchAttempt | undefined;
  let tail: Promise<void> = Promise.resolve();
  let closed = false;
  /** Set once the attempt's record was cleared or handed over to observation: nothing of this attempt writes after that. */
  let settled = false;

  const enqueue = <T>(change: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(new Error('the launch attempt is no longer owned by its command'));
    const done = tail.then(change);
    tail = done.then(() => undefined, () => undefined);
    return done;
  };
  const current = (): LaunchAttempt => {
    if (!attempt) throw new Error('no launch attempt is recorded');
    return attempt;
  };

  const record: LaunchRecord = {
    write: () => enqueue(async () => { attempt = await writeLaunchAttempt(stateDirectory, { manager: details.manager, label: details.label, now: details.now() }); }),
    discard: () => enqueue(async () => {
      if (!attempt || settled) return;
      settled = true;
      await clearLaunchAttempt(stateDirectory, attempt.attemptId);
    }),
    finished: start => enqueue(async () => {
      if (!attempt || settled) return;
      settled = true;
      const next = afterStart(start);
      if (next === 'clear') await clearLaunchAttempt(stateDirectory, attempt.attemptId);
      else if (next === 'requested') await markLaunchRequested(stateDirectory, attempt);
    }),
  };
  const witness: ClientWitness = {
    spawned: client => enqueue(async () => {
      const owned = current();
      if (settled) throw new Error('the launch attempt was already settled');
      await recordLaunchClient(stateDirectory, owned, { pid: client.pid, now: details.now() });
    }),
  };
  return {
    record, witness,
    close() { closed = true; return tail; },
  };
}
