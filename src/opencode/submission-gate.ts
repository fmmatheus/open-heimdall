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
import { isWorkflowChild } from '../workflow/child-ownership.js';
import type { createCoordinatorClient } from '../coordinator/client.js';

const SAFE = /^[A-Za-z0-9_-]+$/;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The production submission gate. Nothing here is process-local authority: every call re-derives the run and its
 * authoritative store (the active owner's coordinator checkpoint for a managed run, the local checkpoint of the run
 * that holds the workflow lock otherwise), and origin is proven from the complete native message archive (not the compacted context).
 */
export function createNativeSubmissionGate({ configuration, history, metadata, nativeSession, coordinatorClient }: {
  configuration: Configuration;
  /** The complete message archive used to prove call origin. Defaults to the supported OpenCode message-history API. */
  history?: MessageHistory;
  metadata?: ManagedMetadata;
  /** Native ancestry from the host's session API, never from the calling agent or tool input. */
  nativeSession?: (sessionID: string) => Promise<{ id: string; parentID?: string }>;
  /** Test seam for the authenticated coordinator transport. */
  coordinatorClient?: ReturnType<typeof createCoordinatorClient>;
}): SubmissionGate {
  const directory = configuration.projectDirectory;
  const roles = () => [configuration.settings.plannerAgent, configuration.settings.executorAgent];
  const workflowRoot = path.resolve(directory, configuration.workflowRoot);
  const origin = createNativeOriginResolver(history ?? createMessageHistory({ directory, ...configuration.opencode }));
  const local = createLocalSubmissionStore(workflowRoot);
  const build = (runId: string, persistence: Pick<RunnerPersistence, 'load' | 'readSubmission' | 'writeSubmission'>) =>
    createDurableSubmissionGate({ runId, directory, planRoot: configuration.planRoot, persistence, origin });
  const managed = async () => {
    const current = await readManagedMetadata(directory);
    if (!metadata || !current || current.runId !== metadata.runId || current.parentSessionId !== metadata.parentSessionId || current.endpoint !== metadata.endpoint) throw new Error('Managed workflow identity changed');
    return { current, persistence: createManagedPersistence(directory, current, coordinatorClient).persistence };
  };
  const scope = async (sessionID: string): Promise<'direct' | 'descendant' | 'unrelated'> => {
    if (!metadata || sessionID === metadata.parentSessionId) return 'unrelated';
    if (!nativeSession) throw new Error('Native managed ancestry is unavailable');
    const visited = new Set<string>();
    let id = sessionID;
    for (let depth = 0; depth < 64; depth++) {
      if (visited.has(id)) throw new Error('Native managed ancestry contains a cycle');
      visited.add(id);
      const session = await nativeSession(id);
      if (!session || session.id !== id) throw new Error('Native managed ancestry is unverifiable');
      if (!session.parentID) return 'unrelated';
      if (session.parentID === metadata.parentSessionId) return id === sessionID ? 'direct' : 'descendant';
      id = session.parentID;
    }
    throw new Error('Native managed ancestry exceeds the verified bound');
  };
  const closedOwned: SubmissionGate = {
    owns: () => true, sealed: () => true, exposed: () => undefined,
    submit: async () => ({ accepted: false, code: 'unauthorized', repairable: false, errors: [], message: SUBMISSION_DENIAL }),
  };
  /** Throws when no active run can be identified: callers treat that as "expose nothing / unauthorized". */
  const resolve = async (): Promise<SubmissionGate> => {
    if (metadata) {
      const { current, persistence } = await managed();
      return build(current.runId, persistence);
    }
    // The runner records the run id it owns in the exclusive workflow lock, so the lock holder is the only candidate.
    const lock: unknown = JSON.parse(await fs.readFile(path.join(workflowRoot, 'active.lock'), 'utf8'));
    if (!record(lock) || typeof lock.runId !== 'string' || !SAFE.test(lock.runId)) throw new Error('No active workflow run');
    return build(lock.runId, local);
  };
  // A paused standalone run has released active.lock. Its saved children still belong to it and cannot regain
  // implementation tools merely because the host reloaded the plugin or another workflow owns the lock.
  const childRuns = new Map<string, string>();
  const resolveChild = async (sessionID: string): Promise<SubmissionGate | undefined> => {
    if (metadata) {
      // Establish scope before reading managed metadata or coordinator state. An outage must not fence a proven unrelated tree.
      const ancestry = await scope(sessionID);
      if (ancestry === 'unrelated') return undefined;
      childRuns.set(sessionID, metadata.runId);
      if (ancestry === 'descendant') return closedOwned;
      const { current, persistence } = await managed();
      return build(current.runId, { ...persistence, async load(runId) {
        const state = await persistence.load(runId);
        if (!state || state.id !== current.runId || state.parent !== current.parentSessionId || !isWorkflowChild(state, sessionID)) throw new Error('Managed child has no authoritative checkpoint ownership');
        return state;
      } });
    }
    const known = childRuns.get(sessionID);
    if (known) return build(known, local);
    let entries;
    try { entries = await fs.readdir(path.join(workflowRoot, 'runs'), { withFileTypes: true }); }
    catch (error) { if (record(error) && error.code === 'ENOENT') return undefined; throw error; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !SAFE.test(entry.name)) continue;
      const state = await local.load(entry.name);
      if (isWorkflowChild(state, sessionID)) {
        childRuns.set(sessionID, entry.name);
        return build(entry.name, local);
      }
    }
    return undefined;
  };
  return {
    async owns(sessionID) {
      if (metadata) {
        try { return await scope(sessionID) !== 'unrelated'; }
        catch { return sessionID !== metadata.parentSessionId; }
      }
      try { return await (await resolveChild(sessionID))?.owns?.(sessionID) ?? false; }
      catch { return childRuns.has(sessionID); }
    },
    async exposed(sessionID, agent) {
      if (!roles().includes(agent)) return undefined;
      try { return await (await (metadata ? resolveChild(sessionID) : resolve()))?.exposed(sessionID, agent); } catch { return undefined; }
    },
    async sealed(sessionID, agent) {
      if (metadata && sessionID === metadata.parentSessionId) return false;
      // The native identity, not the current role name, owns the fence. Switching agents cannot reopen a paused child.
      try { return await (await resolveChild(sessionID))?.sealed?.(sessionID, agent) ?? false; }
      catch { return metadata ? sessionID !== metadata.parentSessionId : childRuns.has(sessionID) || (agent !== undefined && roles().includes(agent)); }
    },
    async submit(kind, raw, native, boundary) {
      let gate: SubmissionGate;
      try {
        const resolved = await (metadata ? resolveChild(native.sessionID) : resolve());
        if (!resolved) throw new Error('This native session is outside the managed workflow');
        gate = resolved;
      }
      catch { return { accepted: false, code: 'unauthorized', repairable: false, errors: [], message: SUBMISSION_DENIAL }; }
      return gate.submit(kind, raw, native, boundary);
    },
  };
}
