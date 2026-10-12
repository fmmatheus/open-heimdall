import fs from 'node:fs/promises';
import path from 'node:path';
import type { Configuration } from '../config.js';
import { createDurableSubmissionGate } from '../workflow/durable-submission.js';
import { createLocalSubmissionStore } from '../workflow/submission-store.js';
import { SUBMISSION_DENIAL } from '../workflow/submission.js';
import type { SubmissionGate } from '../workflow/submission.js';
import type { RunnerPersistence } from '../workflow/types.js';
import { createManagedPersistence, readManagedMetadata } from './managed.js';
import type { ManagedMetadata } from './managed.js';
import { createNativeOriginResolver } from './native-backend.js';
import { createMessageHistory } from './observer.js';
import type { MessageHistory } from './types.js';

const SAFE = /^[A-Za-z0-9_-]+$/;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The production submission gate. Nothing here is process-local authority: every call re-derives the run and its
 * authoritative store (the active owner's coordinator checkpoint for a managed run, the local checkpoint of the run
 * that holds the workflow lock otherwise), and origin is proven from the complete native message archive (not the compacted context).
 */
export function createNativeSubmissionGate({ configuration, history, metadata }: {
  configuration: Configuration;
  /** The complete message archive used to prove call origin. Defaults to the supported OpenCode message-history API. */
  history?: MessageHistory;
  metadata?: ManagedMetadata;
}): SubmissionGate {
  const directory = configuration.projectDirectory;
  const roles = () => [configuration.settings.plannerAgent, configuration.settings.executorAgent];
  const workflowRoot = path.resolve(directory, configuration.workflowRoot);
  const origin = createNativeOriginResolver(history ?? createMessageHistory({ directory, ...configuration.opencode }));
  const local = createLocalSubmissionStore(workflowRoot);
  const build = (runId: string, persistence: Pick<RunnerPersistence, 'load' | 'readSubmission' | 'writeSubmission'>) =>
    createDurableSubmissionGate({ runId, directory, planRoot: configuration.planRoot, persistence, origin });
  /** Throws when no active run can be identified: callers treat that as "expose nothing / unauthorized". */
  const resolve = async (): Promise<SubmissionGate> => {
    if (metadata) {
      const current = await readManagedMetadata(directory);
      // The active admission-owner binding: a changed run, parent or endpoint is a different workflow.
      if (!current || current.runId !== metadata.runId || current.parentSessionId !== metadata.parentSessionId || current.endpoint !== metadata.endpoint) throw new Error('Managed workflow identity changed');
      return build(current.runId, createManagedPersistence(directory, current).persistence);
    }
    // The runner records the run id it owns in the exclusive workflow lock, so the lock holder is the only candidate.
    const lock: unknown = JSON.parse(await fs.readFile(path.join(workflowRoot, 'active.lock'), 'utf8'));
    if (!record(lock) || typeof lock.runId !== 'string' || !SAFE.test(lock.runId)) throw new Error('No active workflow run');
    return build(lock.runId, local);
  };
  return {
    async exposed(sessionID, agent) {
      if (!roles().includes(agent)) return undefined;
      try { return await (await resolve()).exposed(sessionID, agent); } catch { return undefined; }
    },
    async sealed(sessionID, agent) {
      if (!roles().includes(agent)) return false;
      // No identifiable active run means there is no boundary to protect; an unreadable checkpoint of an identified run is sealed.
      let gate: SubmissionGate;
      try { gate = await resolve(); } catch { return false; }
      return await gate.sealed?.(sessionID, agent) ?? false;
    },
    async submit(kind, raw, native, boundary) {
      let gate: SubmissionGate;
      try { gate = await resolve(); }
      catch { return { accepted: false, code: 'unauthorized', repairable: false, errors: [], message: SUBMISSION_DENIAL }; }
      return gate.submit(kind, raw, native, boundary);
    },
  };
}
