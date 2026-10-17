import { Plugin } from '@opencode/plugin';
import { createCoordinatorClient } from '../coordinator/client.js';
import { childExecutionBlocked, isWorkflowChild } from '../workflow/child-ownership.js';
import { authenticateSubmissionCaller } from '../workflow/durable-submission.js';
import { submissionKindOfTool } from '../workflow/contracts.js';
import { createManagedPersistence, readManagedMetadata } from './managed.js';

export const OWNERSHIP_DENIAL = 'Heimdall denied this tool call: this child has no active workflow ownership. Stop now and wait for an explicit coordinator resume.';
export const BACKGROUND_DENIAL = 'Heimdall managed children must run work in the foreground; background work is not allowed.';
const workflowTool = (name: string) => /^(?:.*[.:/]|.*__)?adr_workflow$/.test(name);
const delegationTool = (name: string) => ['subagent', 'task', 'call_omo_agent', 'session_goal', 'session_goals', 'opencode', 'adr_workflow']
  .some(leaf => name === leaf || ['__', '.', ':', '/'].some(separator => name.endsWith(separator + leaf)));

/** A namespaced or nested tool call must not bypass the same foreground-only policy. */
export function requestsBackgroundWork(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([key, item]) => ((key === 'background' || key === 'run_in_background') && item === true) || requestsBackgroundWork(item, seen));
}

export interface OwnershipGuardOptions {
  /** Test seam: production always uses the authenticated local coordinator client. */
  client?: typeof createCoordinatorClient;
}

/**
 * Installed independently of a run's pinned runtime. Every call reads current coordinator authority, so a legacy
 * child that wakes after a pause cannot regain implementation access through its older workflow plugin.
 */
export function createOwnershipGuard(options: OwnershipGuardOptions = {}): Plugin.Plugin {
  return Plugin.define({
    id: 'heimdall.ownership',
    async setup(ctx) {
      const directory = ctx.location.directory;
      const identity = await readManagedMetadata(directory);
      if (!identity) return;
      const registrations: Array<{ dispose(): Promise<void> }> = [];
      type Access = 'allow' | 'child' | 'deny';
      const deny = () => 'deny' as const;
      const trustedParentDispatch = async (event: {
        sessionID: string; agent?: string; action: string; resources: readonly string[];
        source?: { type: string; id: string; messageID: string };
      }): Promise<boolean> => {
        if (event.sessionID !== identity.parentSessionId || event.action !== 'subagent' || event.agent !== 'adr-orchestrator'
          || event.source?.type !== 'tool' || !event.source.id || !event.source.messageID || event.resources.length !== 1) return false;
        try {
          const current = await readManagedMetadata(directory);
          if (!current || current.endpoint !== identity.endpoint || current.runId !== identity.runId || current.parentSessionId !== identity.parentSessionId) return false;
          const native = await ctx.session.get({ sessionID: event.sessionID as never });
          if (!native || native.id !== event.sessionID) return false;
          const run = await createManagedPersistence(directory, current, options.client?.(current.endpoint)).getRun();
          const state = run.checkpoint, attempt = state?.attempt, caller = state?.caller;
          const active = run.status === 'running' || (run.status === 'preparing' && run.launchIntent === true);
          if (!active || !run.capacityReserved || run.ownerToken !== current.ownerToken || !state || state.status !== 'running'
            || state.id !== current.runId || state.parent !== current.parentSessionId || !attempt?.id
            || !['launching', 'admitted'].includes(attempt.status) || !['planner', 'executor'].includes(state.phase)
            || !Number.isSafeInteger(state.index) || state.index < 0 || attempt.phase !== state.phase || attempt.index !== state.index
            || state.child !== attempt.child) return false;
          if (caller?.sessionID !== event.sessionID || caller.agent !== event.agent || caller.id !== event.source.id || caller.messageID !== event.source.messageID) return false;
          const role = state.phase === 'planner' ? state.settings.plannerAgent : state.settings.executorAgent;
          return !!role && event.resources[0] === role;
        } catch { return false; }
      };
      const classify = async (sessionID: string, agent: string | undefined): Promise<(tool: string) => Access> => {
        try {
          const current = await readManagedMetadata(directory);
          if (!current || current.endpoint !== identity.endpoint || current.runId !== identity.runId || current.parentSessionId !== identity.parentSessionId) return deny;
          // Role names alone confer no ownership. Native session ancestry determines the exact scope of this guard.
          const native = await ctx.session.get({ sessionID: sessionID as never });
          if (!native || native.id !== sessionID) return deny;
          if (sessionID === identity.parentSessionId) return tool => workflowTool(tool) ? 'allow' : 'deny';
          if (native.parentID !== identity.parentSessionId) {
            // A delegated grandchild must not escape through a different immediate parent. Only native ancestry is trusted.
            const visited = new Set<string>([sessionID]);
            let ancestor = native;
            for (let depth = 0; depth < 64; depth++) {
              const parent = ancestor.parentID;
              if (!parent) return () => 'allow';
              if (parent === identity.parentSessionId || visited.has(parent)) return deny;
              visited.add(parent);
              ancestor = await ctx.session.get({ sessionID: parent });
              if (!ancestor || ancestor.id !== parent) return deny;
            }
            return deny;
          }
          const managed = createManagedPersistence(directory, current, options.client?.(current.endpoint));
          const run = await managed.getRun();
          const state = run.checkpoint;
          // Native inference may reach its first tool before launch() returns and the scheduler marks it running.
          const active = run.status === 'running' || (run.status === 'preparing' && run.launchIntent === true);
          if (!active || run.capacityReserved !== true || run.ownerToken !== current.ownerToken
            || !state || state.id !== current.runId || state.parent !== current.parentSessionId || !isWorkflowChild(state, sessionID)) return deny;
          const bound = agent !== undefined ? authenticateSubmissionCaller(state, sessionID, agent)?.kind : undefined;
          const implementation = childExecutionBlocked(state, sessionID, agent) ? 'deny' : 'child';
          return tool => {
            if (delegationTool(tool)) return 'deny';
            const kind = submissionKindOfTool(tool);
            if (kind && bound === kind && state.submissionRepair?.conflict?.attemptId !== state.attempt?.id) return 'child';
            return implementation;
          };
        } catch { return deny; } // An owned child never implements against unavailable or unverifiable authority.
      };
      registrations.push(await ctx.tool.hook('execute.before', async event => {
        const access = (await classify(event.sessionID, event.agent))(event.tool);
        if (access === 'deny') throw new Error(OWNERSHIP_DENIAL);
        if (access === 'child' && requestsBackgroundWork(event.input)) throw new Error(BACKGROUND_DENIAL);
      }));
      registrations.push(await ctx.session.hook('context', async event => {
        const access = await classify(event.sessionID, event.agent);
        for (const name of Object.keys(event.tools)) if (access(name) === 'deny') delete event.tools[name];
      }));
      if (ctx.permission?.hook) registrations.push(await ctx.permission.hook('evaluate', async event => {
        // The workflow invokes the native executor inside its admitted adr_workflow call. Its permission action is
        // subagent, but its host-provided source is the outer workflow call. This grants no model-facing parent tool.
        if (await trustedParentDispatch(event)) return;
        if ((await classify(event.sessionID, event.agent))(event.action) !== 'deny') return;
        event.effect = 'deny';
        event.message = OWNERSHIP_DENIAL;
      }));
      return async () => {
        for (const registration of registrations.reverse()) await registration.dispose();
      };
    },
  });
}

export default createOwnershipGuard();
