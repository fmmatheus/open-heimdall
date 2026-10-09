/**
 * Opens a run's existing sessions in OpenChamber. Pure logic with the host injected, so it runs in Node tests.
 *
 * Only four host calls are ever made: `listProjects`, `listSessions`, `openSession` and `writeClipboard` (to copy the
 * project folder so the user can add it to OpenChamber). Sessions are opened by the native ids Heimdall already
 * saved, and only after OpenChamber itself lists them. Nothing here creates, prompts or writes anything, and there
 * is no fallback when a session cannot be found: the user gets guidance instead.
 */
import type { DirectoryMatch, RunDetail } from '../shared/protocol.js';
import { PanelError } from './client.js';

/** The slice of the SDK host used for navigation. The SDK's own snapshot types satisfy it structurally. */
export interface NavigationHost {
  listProjects(): Promise<{ state: string; projects: Array<{ id: string; name: string; directory: string }> }>;
  listSessions(projectId: string): Promise<{ state: string; sessions: Array<{ id: string }> }>;
  openSession(sessionId: string): Promise<void>;
  writeClipboard(text: string): Promise<void>;
}

export interface DirectoryMatcher {
  matchDirectories(directories: string[]): Promise<DirectoryMatch[]>;
}

export type TargetKind = 'parent' | 'planner' | 'current' | 'completed';

export interface SessionTarget {
  /** Stable within one detail: `parent`, `planner`, `current` or `completed:<sessionId>`. */
  key: string;
  kind: TargetKind;
  /** The native OpenChamber/OpenCode session id saved by Heimdall. */
  sessionId: string;
  label: string;
  /** Visible text of the open action, e.g. `Open parent`. */
  buttonText: string;
  /** The task this session belongs to, when Heimdall recorded it. */
  taskId: string | null;
}

/** The Heimdall project, as the panel knows it. `directory` is the canonical registered directory when known. */
export interface HeimdallProjectRef { id: string; name: string; directory: string | null }

/** Why a session can or cannot be opened right now. */
export type TargetState = 'found' | 'session-not-discovered' | 'discovering' | 'discovery-failed' | 'permission-denied' | 'project-not-added' | 'unavailable';

export interface TargetView {
  target: SessionTarget;
  state: TargetState;
  enabled: boolean;
  /** Accessible name of the open action. */
  actionLabel: string;
  /** Explicit guidance when the session cannot be opened; null when it can. */
  note: string | null;
}

/** `listed`: the project was found and its sessions were listed; each target says whether it was found. */
export type NavigationState = 'no-sessions' | 'project-not-added' | 'discovering' | 'discovery-failed' | 'permission-denied' | 'unavailable' | 'listed';

export interface NavigationView {
  state: NavigationState;
  title: string;
  message: string | null;
  /** Shown as selectable text so the user can copy it into OpenChamber's add-project flow. */
  copyText: string | null;
  targets: TargetView[];
  /** Re-lists only; it never creates or changes anything. */
  canRefresh: boolean;
}

export interface OpenResult { ok: boolean; message: string | null }

export const PROJECT_MISSING = 'Sessions require this project in OpenChamber.';
export const PERMISSION_DENIED = 'Allow Heimdall to read sessions in Settings → Extensions, then Refresh sessions.';
export const COPIED = 'Copied project folder';
const COPY_FAILED = 'Could not copy the project folder. Select the folder path shown on this page and copy it yourself.';
const COPY_UNKNOWN = 'The project folder is not known, so it cannot be copied.';
/** `writeClipboard` accepts 1 to 32000 characters. */
const CLIPBOARD_LIMIT = 32000;
const NOT_DISCOVERED = 'OpenChamber has not listed this session yet. It may not have loaded this run\'s managed worktree yet. Press Refresh sessions to check again.';
const DISCOVERING = 'OpenChamber is still loading sessions. Press Refresh sessions in a moment.';
const DISCOVERY_FAILED = 'OpenChamber could not list sessions for this project. Press Refresh sessions to try again.';

const text = (value: unknown): string | null => typeof value === 'string' && value !== '' ? value : null;

/** Parent, current task (only while executing) and completed tasks, each once, in that order. */
export function sessionTargets(detail: RunDetail): SessionTarget[] {
  const targets: SessionTarget[] = [];
  const seen = new Set<string>();
  const add = (target: SessionTarget): void => {
    if (seen.has(target.sessionId)) return;
    seen.add(target.sessionId);
    targets.push(target);
  };
  const titles = new Map(detail.tasks.map(task => [task.id, task.title]));
  const named = (id: string | null): string => id === null ? 'task' : titles.has(id) ? `${id}: ${titles.get(id)}` : id;

  const parent = text(detail.sessions.parent);
  if (parent !== null) add({ key: 'parent', kind: 'parent', sessionId: parent, label: 'Parent session', buttonText: 'Open parent', taskId: null });

  const current = text(detail.sessions.current);
  if (current !== null && detail.phase === 'executing') {
    const task = detail.currentTask;
    add({
      key: 'current', kind: 'current', sessionId: current,
      label: task ? `Current task ${task.id}: ${task.title}` : 'Current task',
      buttonText: task ? `Open current task ${task.id}` : 'Open current task',
      taskId: task?.id ?? null,
    });
  } else if (current !== null && detail.phase === 'planning') {
    // The checkpoint child is the planner session only while planning; the runner clears it after each phase.
    add({ key: 'planner', kind: 'planner', sessionId: current, label: 'Planner session', buttonText: 'Open planner', taskId: null });
  }

  for (const entry of detail.sessions.completed) {
    const id = text(entry.id);
    if (id !== null) {
      add({
        key: `completed:${id}`, kind: 'completed', sessionId: id, label: `Completed ${named(entry.taskId)}`,
        buttonText: entry.taskId ? `Open ${named(entry.taskId)}` : 'Open session', taskId: text(entry.taskId),
      });
    }
  }
  return targets;
}

type Failure = 'NOT_GRANTED' | 'HOST_TIMEOUT' | 'other';

function failureOf(error: unknown): Failure {
  const code = typeof (error as { code?: unknown } | null)?.code === 'string' ? (error as { code: string }).code : '';
  return code === 'NOT_GRANTED' ? 'NOT_GRANTED' : code === 'HOST_TIMEOUT' ? 'HOST_TIMEOUT' : 'other';
}

/** Fixed texts only: the raw error is never relayed. */
function failureMessage(error: unknown, doing: string): string {
  if (error instanceof PanelError) return `${error.message}${error.hint ? ` ${error.hint}` : ''}`;
  switch (failureOf(error)) {
    case 'NOT_GRANTED': return `Heimdall has not been allowed to read OpenChamber sessions, so it cannot ${doing}. Allow it in Settings → Extensions, then press Refresh sessions.`;
    case 'HOST_TIMEOUT': return `OpenChamber did not answer in time while trying to ${doing}. Press Refresh sessions to try again.`;
    default: return `OpenChamber could not ${doing}. Press Refresh sessions to try again.`;
  }
}

const actionLabel = (target: SessionTarget): string => `Open ${target.label}`;

function uniform(targets: SessionTarget[], state: TargetState, note: string): TargetView[] {
  return targets.map(target => ({ target, state, enabled: false, actionLabel: actionLabel(target), note }));
}

function view(state: NavigationState, title: string, message: string | null, targets: TargetView[], copyText: string | null = null): NavigationView {
  return { state, title, message, copyText, targets, canRefresh: state !== 'no-sessions' };
}

export interface Navigation {
  /** Resolves the OpenChamber project for the run and checks which of its sessions OpenChamber lists. */
  load(detail: RunDetail, project: HeimdallProjectRef): Promise<NavigationView>;
  /** Opens a target that `load` reported as found. Anything else is refused without calling the host. */
  open(loaded: NavigationView, key: string): Promise<OpenResult>;
  /** Copies the Heimdall project's folder (one `writeClipboard` call) so it can be added in OpenChamber. */
  copyProjectFolder(directory: string | null): Promise<OpenResult>;
}

export function createNavigation(deps: { host: NavigationHost; matcher: DirectoryMatcher }): Navigation {
  const { host, matcher } = deps;

  async function load(detail: RunDetail, project: HeimdallProjectRef): Promise<NavigationView> {
    const targets = sessionTargets(detail);
    if (targets.length === 0) return view('no-sessions', 'Sessions', 'No session ids have been recorded for this run yet.', []);

    const unavailable = (message: string): NavigationView => view('unavailable', 'Sessions unavailable', message, uniform(targets, 'unavailable', message));
    const denied = (): NavigationView => view('permission-denied', 'Permission needed', PERMISSION_DENIED, uniform(targets, 'permission-denied', PERMISSION_DENIED));
    const failed = (error: unknown, doing: string): NavigationView => failureOf(error) === 'NOT_GRANTED' ? denied() : unavailable(failureMessage(error, doing));

    let projects: Awaited<ReturnType<NavigationHost['listProjects']>>;
    try { projects = await host.listProjects(); }
    catch (error) { return failed(error, 'list projects'); }
    const known = Array.isArray(projects?.projects) ? projects.projects : [];

    let matches: DirectoryMatch[] = [];
    if (known.length > 0) {
      try { matches = await matcher.matchDirectories(known.map(entry => entry.directory)); }
      catch (error) { return unavailable(failureMessage(error, 'match projects')); }
    }
    // The project's own directory wins; a registered managed worktree of this very run also reaches its sessions.
    const own = known.find((_, index) => matches[index]?.projectId === project.id && matches[index]?.runId === undefined)
      ?? known.find((_, index) => matches[index]?.projectId === project.id && matches[index]?.runId === detail.id);

    if (!own) {
      if (projects?.state === 'loading') return view('discovering', 'Sessions', DISCOVERING, uniform(targets, 'discovering', DISCOVERING));
      if (projects?.state !== 'ready') return view('discovery-failed', 'Sessions', DISCOVERY_FAILED, uniform(targets, 'discovery-failed', DISCOVERY_FAILED));
      return view('project-not-added', 'Project not added to OpenChamber', PROJECT_MISSING, uniform(targets, 'project-not-added', 'Add the project to OpenChamber first.'), project.directory);
    }

    let sessions: Awaited<ReturnType<NavigationHost['listSessions']>>;
    try { sessions = await host.listSessions(own.id); }
    catch (error) { return failed(error, 'list sessions'); }
    if (sessions?.state === 'loading') return view('discovering', 'Sessions', DISCOVERING, uniform(targets, 'discovering', DISCOVERING));
    if (sessions?.state !== 'ready') return view('discovery-failed', 'Sessions', DISCOVERY_FAILED, uniform(targets, 'discovery-failed', DISCOVERY_FAILED));

    const listed = new Set((Array.isArray(sessions.sessions) ? sessions.sessions : []).map(session => session.id));
    const views = targets.map((target): TargetView => listed.has(target.sessionId)
      ? { target, state: 'found', enabled: true, actionLabel: actionLabel(target), note: null }
      : { target, state: 'session-not-discovered', enabled: false, actionLabel: actionLabel(target), note: NOT_DISCOVERED });
    return view('listed', 'Sessions', null, views);
  }

  async function open(loaded: NavigationView, key: string): Promise<OpenResult> {
    const entry = loaded.targets.find(candidate => candidate.target.key === key);
    if (!entry || !entry.enabled || entry.state !== 'found') return { ok: false, message: 'That session is not available to open yet.' };
    try {
      await host.openSession(entry.target.sessionId);
      return { ok: true, message: null };
    } catch (error) {
      return { ok: false, message: failureMessage(error, 'open that session') };
    }
  }

  async function copyProjectFolder(directory: string | null): Promise<OpenResult> {
    if (typeof directory !== 'string' || directory.trim() === '') return { ok: false, message: COPY_UNKNOWN };
    if (directory.length > CLIPBOARD_LIMIT) return { ok: false, message: COPY_FAILED };
    try {
      await host.writeClipboard(directory);
      return { ok: true, message: COPIED };
    } catch {
      return { ok: false, message: COPY_FAILED };
    }
  }

  return { load, open, copyProjectFolder };
}
