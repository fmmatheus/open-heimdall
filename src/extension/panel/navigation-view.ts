/**
 * What the panel draws for session navigation, as plain data. Pure and Node-testable: `main.ts` only turns the
 * result into DOM. Only enabled actions are ever returned, never a disabled per-session button; sessions that
 * cannot be opened are summarised in one short note with a single Refresh action.
 */
import type { NavigationState, NavigationView, TargetView } from './navigation.js';
import { PERMISSION_DENIED, PROJECT_MISSING } from './navigation.js';

/** An enabled action that opens one session OpenChamber lists. */
export interface SessionAction {
  /** Key understood by `Navigation.open`. */
  key: string;
  /** Visible button text. */
  text: string;
  /** Accessible name; includes the task or session it opens. */
  ariaLabel: string;
}

export interface SessionsPresentation {
  state: NavigationState | 'checking';
  /** Main line; fixed text per state. */
  message: string | null;
  /** Follow-up instruction under the buttons. */
  hint: string | null;
  /** The project folder, shown as selectable text; only in the project-missing state. */
  copyText: string | null;
  /** Show the Copy project folder button. */
  canCopy: boolean;
  /** Show the Refresh sessions button. */
  canRefresh: boolean;
  /** One grouped line for recorded sessions OpenChamber does not list yet. */
  note: string | null;
  /** Parent, planner and current task sessions that can be opened. */
  primary: SessionAction[];
  /** Completed task sessions that can be opened. */
  completed: SessionAction[];
}

export const CHECKING = 'Checking which sessions OpenChamber has loaded…';
export const NO_SESSIONS = 'No session ids have been recorded for this run yet.';
export const ADD_FOLDER_HINT = 'Add the copied folder using OpenChamber\'s project controls.';
export const ADD_FOLDER_UNKNOWN_HINT = 'Add this project\'s folder using OpenChamber\'s project controls.';

const OPENABLE = (entry: TargetView): boolean => entry.enabled && entry.state === 'found';

function action(entry: TargetView): SessionAction {
  return { key: entry.target.key, text: entry.target.buttonText, ariaLabel: entry.actionLabel };
}

/** `k of n recorded sessions are not listed by OpenChamber yet.` */
export function notListedNote(missing: number, total: number): string {
  return `${missing} of ${total} recorded ${total === 1 ? 'session is' : 'sessions are'} not listed by OpenChamber yet.`;
}

const empty = (state: SessionsPresentation['state'], message: string | null): SessionsPresentation => ({
  state, message, hint: null, copyText: null, canCopy: false, canRefresh: false, note: null, primary: [], completed: [],
});

/** The Sessions tab. `view` is null while the first listing is in flight. */
export function sessionsPresentation(view: NavigationView | null): SessionsPresentation {
  if (view === null) return empty('checking', CHECKING);
  switch (view.state) {
    case 'no-sessions': return empty('no-sessions', NO_SESSIONS);
    case 'project-not-added': {
      const known = view.copyText !== null && view.copyText.trim() !== '';
      return {
        ...empty('project-not-added', PROJECT_MISSING),
        copyText: known ? view.copyText : null,
        canCopy: known,
        canRefresh: true,
        hint: known ? ADD_FOLDER_HINT : ADD_FOLDER_UNKNOWN_HINT,
      };
    }
    case 'discovering': return { ...empty('discovering', view.message), canRefresh: true };
    case 'permission-denied': return { ...empty('permission-denied', PERMISSION_DENIED), canRefresh: true };
    case 'discovery-failed': return { ...empty('discovery-failed', view.message), canRefresh: true };
    case 'unavailable': return { ...empty('unavailable', view.message), canRefresh: true };
    case 'listed': {
      const found = view.targets.filter(OPENABLE);
      const missing = view.targets.length - found.length;
      return {
        ...empty('listed', null),
        primary: found.filter(entry => entry.target.kind !== 'completed').map(action),
        completed: found.filter(entry => entry.target.kind === 'completed').map(action),
        note: missing > 0 ? notListedNote(missing, view.targets.length) : null,
        canRefresh: missing > 0,
      };
    }
  }
}

export interface SummaryPresentation {
  /** Open planner / current task / parent, only for sessions OpenChamber lists. */
  actions: SessionAction[];
  /** One line shown instead when nothing can be opened; the Sessions tab has the details. */
  hint: string | null;
}

const SUMMARY_HINTS: Partial<Record<NavigationState, string>> = {
  'project-not-added': PROJECT_MISSING,
  discovering: 'OpenChamber is still loading sessions.',
  'permission-denied': 'Heimdall needs permission to read sessions.',
  'discovery-failed': 'Sessions could not be listed.',
  unavailable: 'Sessions could not be listed.',
};

/** The run summary above the tabs. */
export function summaryPresentation(view: NavigationView | null): SummaryPresentation {
  if (view === null || view.state === 'no-sessions') return { actions: [], hint: null };
  if (view.state !== 'listed') return { actions: [], hint: SUMMARY_HINTS[view.state] ?? null };
  const primary = view.targets.filter(entry => entry.target.kind !== 'completed');
  const found = primary.filter(OPENABLE).map(action);
  if (found.length > 0) return { actions: found, hint: null };
  return { actions: [], hint: primary.length > 0 ? 'The run\'s sessions are not listed by OpenChamber yet.' : null };
}

/** Task id -> the session that belongs to it, for the Tasks tab. Only openable sessions; the current task wins. */
export function taskSessionActions(view: NavigationView | null): Map<string, SessionAction> {
  const result = new Map<string, SessionAction>();
  if (view === null || view.state !== 'listed') return result;
  const rank = (entry: TargetView): number => entry.target.kind === 'current' ? 1 : 0;
  for (const entry of view.targets) {
    const taskId = entry.target.taskId;
    if (taskId === null || !OPENABLE(entry)) continue;
    const previous = result.get(taskId);
    if (previous !== undefined && rank(view.targets.find(candidate => candidate.target.key === previous.key)!) > rank(entry)) continue;
    result.set(taskId, { key: entry.target.key, text: 'Open session', ariaLabel: `Open session for task ${taskId}` });
  }
  return result;
}
