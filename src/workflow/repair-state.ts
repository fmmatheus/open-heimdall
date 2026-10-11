import * as fs from 'node:fs/promises';
import type { RunState, SubmissionRepairRecord } from './types.js';

const STICKY = ['sealed', 'conflict', 'negative', 'refused'] as const;

/**
 * The durable submission-repair state only moves forward while one attempt is live. For the active (non-rejected)
 * attempt of an unchanged task, a checkpoint may add markers and raise the repair counter, but never drop a marker
 * (seal, conflict, negative outcome, refusal) or lower the counter, whatever order concurrent updates were computed in.
 *
 * The legitimate removals are not "the same attempt": advancing to another task or phase, a conflicted attempt that is
 * rejected by an explicit resume, and a fresh attempt (whose sealed and negative markers named the previous attempt).
 *
 * Returns the reason for a regression, or undefined when the transition is allowed.
 */
export function repairRegression(previous: RunState | null | undefined, next: RunState): string | undefined {
  const before: SubmissionRepairRecord | undefined = previous?.submissionRepair;
  if (!previous || !before) return undefined;
  if (previous.phase !== next.phase || previous.index !== next.index || previous.results.length !== next.results.length) return undefined;
  const attempt = next.attempt;
  if (!attempt || attempt.status === 'rejected') return undefined;
  const after = next.submissionRepair;
  for (const marker of STICKY) {
    if (before[marker]?.attemptId === attempt.id && after?.[marker]?.attemptId !== attempt.id) return 'it would drop the ' + marker + ' marker of the active attempt';
  }
  if (!after) return before.repairs > 0 || before.attempts.length ? 'it would drop the repair record of the active task' : undefined;
  const sameRecord = after.phase === before.phase && after.index === before.index && after.taskId === before.taskId && after.child === before.child;
  if (sameRecord && after.repairs < before.repairs) return 'it would lower the repair counter from ' + before.repairs + ' to ' + after.repairs;
  return undefined;
}

/** Refuses (fail closed) a checkpoint that would regress the durable repair state of the active attempt. */
export function assertRepairMonotonic(previous: RunState | null | undefined, next: RunState): void {
  const reason = repairRegression(previous, next);
  if (reason) throw new Error('Refused a stale checkpoint: ' + reason);
}

/** The standalone checkpoint store: atomically replaces the run file after the same monotonic check the coordinator applies. */
export async function writeCheckpointFile(file: string, state: RunState): Promise<void> {
  let previous: RunState | undefined;
  try { previous = JSON.parse(await fs.readFile(file, 'utf8')) as RunState; }
  catch (error) { if (typeof error !== 'object' || error === null || (error as { code?: unknown }).code !== 'ENOENT') throw error; }
  assertRepairMonotonic(previous, state);
  await fs.writeFile(file + '.tmp', JSON.stringify(state, null, 2));
  await fs.rename(file + '.tmp', file);
}
