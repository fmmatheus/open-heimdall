import type { RunState } from './types.js';

/** Recognizes current and previously recorded children independently of their current agent role. */
export function isWorkflowChild(state: RunState | null | undefined, sessionID: string): boolean {
  if (!state || !sessionID || state.parent === sessionID) return false;
  return state.child === sessionID || state.attempt?.child === sessionID || state.submissionBinding?.child === sessionID
    || state.reportRecovery?.child === sessionID || state.submissionRepair?.child === sessionID
    || Object.hasOwn(state.usage ?? {}, sessionID) || Object.hasOwn(state.uncachedUsage ?? {}, sessionID)
    || state.results?.some(result => result.sessionId === sessionID) === true;
}

/** Persisted authority for ordinary implementation tools, including legacy runs without typed submissions. */
export function childExecutionBlocked(state: RunState | null | undefined, sessionID: string, agent?: string): boolean {
  if (!isWorkflowChild(state, sessionID)) return false;
  if (!state || state.status !== 'running' || state.child !== sessionID) return true;
  const attempt = state.attempt;
  if (!attempt || attempt.child !== sessionID || !['launching', 'admitted'].includes(attempt.status)
    || attempt.phase !== state.phase || attempt.index !== state.index) return true;
  const role = state.phase === 'planner' ? state.settings?.plannerAgent : state.phase === 'executor' ? state.settings?.executorAgent : undefined;
  if (!role || (agent !== undefined && agent !== role)) return true;
  const binding = state.submissionBinding;
  if (binding && (binding.status !== 'open' || binding.attemptId !== attempt.id || binding.child !== sessionID
    || binding.phase !== state.phase || binding.index !== state.index || binding.runId !== state.id || binding.parent !== state.parent)) return true;
  const repair = state.submissionRepair;
  return [repair?.sealed, repair?.refused, repair?.negative, repair?.conflict].some(value => value?.attemptId === attempt.id);
}
