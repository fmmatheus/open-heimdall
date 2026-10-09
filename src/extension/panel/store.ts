import { createPanelClient, IDENTIFIER, mapHostFailure } from './client.js';
import type { PanelClient, PanelError, PanelHost, RunFilters } from './client.js';
import { RUN_STATUSES } from '../shared/protocol.js';
import type { ProjectSummary, RunDetail, RunSummary, WireRunStatus } from '../shared/protocol.js';

export type ConnectionState = 'connecting' | 'online' | 'offline' | 'service-unavailable';

export interface PanelState {
  connection: ConnectionState;
  /** Fixed user-facing sentence about the connection; null while online. */
  message: string | null;
  /** What the user can do about `message`; null when nothing is needed. */
  hint: string | null;
  lastSuccessAt: number | null;
  /** Data on screen is older than the last good poll: the last poll failed, or it is over two poll intervals old. */
  stale: boolean;
  projects: ProjectSummary[];
  runs: RunSummary[];
  runsTotal: number;
  runsTruncated: boolean;
  filters: RunFilters;
  selectedRunId: string | null;
  detail: RunDetail | null;
  /** Set when the selected run could not be loaded for a reason other than the connection. */
  detailError: string | null;
  cursor: string | null;
  /** Consecutive failed polls; drives the backoff. */
  failures: number;
  /** When the next automatic attempt will run (store clock), or null. */
  nextAttemptAt: number | null;
}

export interface Timers {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PanelStoreOptions {
  host: PanelHost;
  timers?: Timers;
  now?: () => number;
  pollIntervalMs?: number;
  maxBackoffMs?: number;
  /** Delay before the next poll when the service says more changes are waiting. */
  morePollMs?: number;
}

export interface PanelStore {
  getState(): PanelState;
  subscribe(listener: (state: PanelState) => void): () => void;
  /** Begin polling. Idempotent. */
  start(): void;
  /** Manual retry: run a poll cycle now. */
  retry(): void;
  setFilters(filters: Partial<RunFilters>): void;
  select(runId: string | null): void;
  /** Stop all timers and ignore every in-flight response. */
  dispose(): void;
}

export const DEFAULT_POLL_INTERVAL_MS = 3000;
export const DEFAULT_MAX_BACKOFF_MS = 30000;

const realTimers: Timers = {
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: handle => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Delay after `failures` consecutive failures: base, 2x, 4x ... capped. */
export function backoffDelay(failures: number, baseMs: number, capMs: number): number {
  if (failures <= 0) return baseMs;
  return Math.min(capMs, baseMs * 2 ** Math.min(failures - 1, 30));
}

function sanitizeFilters(filters: RunFilters): RunFilters {
  return {
    projectId: filters.projectId !== null && IDENTIFIER.test(filters.projectId) ? filters.projectId : null,
    status: filters.status !== null && (RUN_STATUSES as readonly string[]).includes(filters.status) ? filters.status as WireRunStatus : null,
  };
}

export function createPanelStore(options: PanelStoreOptions): PanelStore {
  const client: PanelClient = createPanelClient(options.host);
  const timers = options.timers ?? realTimers;
  const now = options.now ?? Date.now;
  const pollMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const capMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
  const moreMs = options.morePollMs ?? 250;

  let state: PanelState = {
    connection: 'connecting', message: null, hint: null, lastSuccessAt: null, stale: false,
    projects: [], runs: [], runsTotal: 0, runsTruncated: false,
    filters: { projectId: null, status: null }, selectedRunId: null, detail: null, detailError: null,
    cursor: null, failures: 0, nextAttemptAt: null,
  };
  const listeners = new Set<(state: PanelState) => void>();
  let disposed = false;
  let started = false;
  let pollTimer: unknown = null;
  let staleTimer: unknown = null;
  let cycleRunning = false;
  // Generation counters: a response applies only if no newer request of its kind started meanwhile.
  let cycleGen = 0;
  let runsGen = 0;
  let detailGen = 0;
  let projectsGen = 0;

  function update(patch: Partial<PanelState>): void {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener(state);
  }

  function clearPollTimer(): void {
    if (pollTimer !== null) timers.clearTimeout(pollTimer);
    pollTimer = null;
    if (!disposed) state = { ...state, nextAttemptAt: null };
  }

  function schedule(delayMs: number): void {
    clearPollTimer();
    if (disposed) return;
    pollTimer = timers.setTimeout(() => { pollTimer = null; void runCycle(); }, delayMs);
    update({ nextAttemptAt: now() + delayMs });
  }

  function armStaleTimer(): void {
    if (staleTimer !== null) timers.clearTimeout(staleTimer);
    staleTimer = null;
    if (disposed || state.lastSuccessAt === null) return;
    // Fires just after the data turns two intervals old.
    const remaining = state.lastSuccessAt + 2 * pollMs - now();
    staleTimer = timers.setTimeout(() => {
      staleTimer = null;
      if (state.lastSuccessAt !== null && now() - state.lastSuccessAt > 2 * pollMs && !state.stale) update({ stale: true });
    }, Math.max(1, remaining + 1));
  }

  function markSuccess(): void {
    update({ connection: 'online', message: null, hint: null, stale: false, lastSuccessAt: now(), failures: 0 });
    armStaleTimer();
  }

  function recordFailure(error: PanelError, patch: Partial<PanelState> = {}): void {
    update({
      connection: error.category === 'service-unavailable' ? 'service-unavailable' : 'offline',
      message: error.message,
      hint: error.hint,
      stale: state.lastSuccessAt !== null,
      ...patch,
    });
  }

  async function loadProjects(): Promise<void> {
    const gen = ++projectsGen;
    let response;
    try { response = await client.projects(); }
    catch (error) { if (disposed || gen !== projectsGen) return; throw error; }
    if (disposed || gen !== projectsGen) return;
    update({ projects: response.projects });
  }

  async function loadRuns(): Promise<void> {
    const gen = ++runsGen;
    let response;
    try { response = await client.runs(state.filters); }
    catch (error) { if (disposed || gen !== runsGen) return; throw error; }
    if (disposed || gen !== runsGen) return;
    update({ runs: response.runs, runsTotal: response.total, runsTruncated: response.truncated });
  }

  async function loadDetail(): Promise<void> {
    const id = state.selectedRunId;
    const gen = ++detailGen;
    if (id === null) return;
    try {
      const response = await client.run(id);
      if (disposed || gen !== detailGen) return;
      update({ detail: response.run, detailError: null });
    } catch (caught) {
      const error = mapHostFailure(caught);
      if (disposed || gen !== detailGen) return;
      if (error.category === 'request') update({ detail: null, detailError: error.message });
      else throw error;
    }
  }

  /** Full reload after a resync or the first load. The cursor is taken before the lists. */
  async function fullSync(gen: number, cursor: string | null): Promise<void> {
    if (cursor === null) {
      const feed = await client.changes(null);
      if (disposed || gen !== cycleGen) return;
      cursor = feed.cursor;
    }
    await Promise.all([loadProjects(), loadRuns(), loadDetail()]);
    if (disposed || gen !== cycleGen) return;
    update({ cursor });
  }

  async function runCycle(): Promise<void> {
    if (disposed) return;
    const gen = ++cycleGen;
    cycleRunning = true;
    let next = pollMs;
    try {
      if (state.cursor === null) {
        await fullSync(gen, null);
      } else {
        const feed = await client.changes(state.cursor);
        if (disposed || gen !== cycleGen) return;
        if (feed.resync) {
          await fullSync(gen, feed.cursor);
        } else {
          const work: Array<Promise<void>> = [];
          if (feed.projectsChanged) work.push(loadProjects());
          if (feed.changedRunIds.length > 0) work.push(loadRuns());
          if (state.selectedRunId !== null && feed.changedRunIds.includes(state.selectedRunId)) work.push(loadDetail());
          await Promise.all(work);
          if (disposed || gen !== cycleGen) return;
          update({ cursor: feed.cursor });
        }
        if (feed.more) next = moreMs;
      }
      if (disposed || gen !== cycleGen) return;
      markSuccess();
      cycleRunning = false;
      schedule(next);
    } catch (caught) {
      if (disposed || gen !== cycleGen) return;
      const failures = state.failures + 1;
      recordFailure(mapHostFailure(caught), { failures });
      cycleRunning = false;
      schedule(backoffDelay(failures, pollMs, capMs));
    } finally {
      if (gen === cycleGen) cycleRunning = false;
    }
  }

  /** A failure from a user-triggered request: show it, and make sure a retry is scheduled. */
  function standaloneFailure(caught: unknown): void {
    const error = mapHostFailure(caught);
    recordFailure(error);
    if (pollTimer === null && !cycleRunning) {
      const failures = state.failures + 1;
      update({ failures });
      schedule(backoffDelay(failures, pollMs, capMs));
    }
  }

  function standaloneSuccess(): void {
    if (state.connection !== 'online' || state.stale) markSuccess();
    else update({ lastSuccessAt: now() });
    armStaleTimer();
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    start() {
      if (started || disposed) return;
      started = true;
      void runCycle();
    },
    retry() {
      if (disposed) return;
      started = true;
      clearPollTimer();
      // Supersede any in-flight cycle so its late result cannot overwrite the retry.
      void runCycle();
    },
    setFilters(filters) {
      if (disposed) return;
      const merged = sanitizeFilters({ ...state.filters, ...filters });
      if (merged.projectId === state.filters.projectId && merged.status === state.filters.status) return;
      update({ filters: merged });
      void loadRuns().then(standaloneSuccess, caught => {
        const error = mapHostFailure(caught);
        if (error.category === 'request' && state.filters.projectId !== null) {
          // The filtered project is gone; fall back to all projects.
          update({ filters: { ...state.filters, projectId: null }, message: error.message, hint: null });
          void loadRuns().then(standaloneSuccess, standaloneFailure);
        } else standaloneFailure(caught);
      });
    },
    select(runId) {
      if (disposed) return;
      if (runId !== null && !IDENTIFIER.test(runId)) return;
      const id = runId;
      if (id === state.selectedRunId) return;
      detailGen++;
      update({ selectedRunId: id, detail: null, detailError: null });
      if (id !== null) void loadDetail().then(standaloneSuccess, standaloneFailure);
    },
    dispose() {
      disposed = true;
      cycleGen++; runsGen++; detailGen++; projectsGen++;
      if (pollTimer !== null) timers.clearTimeout(pollTimer);
      if (staleTimer !== null) timers.clearTimeout(staleTimer);
      pollTimer = null;
      staleTimer = null;
      listeners.clear();
    },
  };
}
