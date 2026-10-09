import { createPanelClient, IDENTIFIER, mapHostFailure } from './client.js';
import type { PanelClient, PanelError, PanelHost, RunFilters } from './client.js';
import { RUN_STATUSES } from '../shared/protocol.js';
import type {
  BlockerContentResponse, ProjectSummary, ReviewFileResponse, ReviewResponse, RunDetail, RunSummary, TaskContentResponse, WireRunStatus,
} from '../shared/protocol.js';

export type ConnectionState = 'connecting' | 'online' | 'offline' | 'service-unavailable';

/** The file whose diff is open in the Review tab. */
export interface ReviewFileSlice {
  path: string;
  loading: boolean;
  data: ReviewFileResponse | null;
  /** Fixed sentence when this file's diff could not be loaded; earlier `data` for the same path is kept. */
  error: string | null;
}

/** Review of the selected run. Everything here belongs to `runId`; selecting another run resets it. */
export interface ReviewSlice {
  runId: string | null;
  /** A review request is in flight; `data` may still hold the previous answer. */
  loading: boolean;
  data: ReviewResponse | null;
  /** Fixed sentence when the review could not be loaded for a reason other than the connection. */
  error: string | null;
  /** The latest refresh failed but `data` from an earlier one is still shown. */
  stale: boolean;
  /** Path of the open file; always one of `data.files`. */
  selectedPath: string | null;
  file: ReviewFileSlice | null;
}

export const EMPTY_REVIEW: ReviewSlice = { runId: null, loading: false, data: null, error: null, stale: false, selectedPath: null, file: null };

/** One piece of on-demand content: requested, loaded or failed. Absent from the slice until the user asks for it. */
export interface ContentEntry<T> {
  loading: boolean;
  data: T | null;
  /** Fixed sentence when loading failed; the user can ask again. */
  error: string | null;
}

/**
 * Full text of shortened task fields and of the blocker, loaded only when the user asks. It belongs to `runId`
 * and is dropped when another run is selected or the run's progress changes.
 */
export interface ContentSlice {
  runId: string | null;
  /** By 0-based plan position. */
  tasks: Readonly<Record<number, ContentEntry<TaskContentResponse>>>;
  blocker: ContentEntry<BlockerContentResponse> | null;
}

export const EMPTY_CONTENT: ContentSlice = { runId: null, tasks: {}, blocker: null };

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
  review: ReviewSlice;
  content: ContentSlice;
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
  /**
   * The Review tab is on screen. While it is, the review of the selected run is loaded and follows the change
   * feed; otherwise nothing review-related is requested.
   */
  setReviewVisible(visible: boolean): void;
  /** Reload the review (and the open file) now. */
  refreshReview(): void;
  /** Open the diff of a file. Ignored unless `path` is in the review list currently held. */
  selectReviewFile(path: string | null): void;
  /**
   * Load more of one task's text, once per run detail. Ignored unless the selected run's detail lists a task at
   * `index` (its 0-based plan position); asking again while loading or after success does nothing.
   */
  loadTaskContent(runId: string, index: number): void;
  /** Load more of the blocker reason and resolution, once per run detail. */
  loadBlockerContent(runId: string): void;
  /** Drop loaded content and reload the selected run now (the task list may have changed). */
  refreshDetail(): void;
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
    review: EMPTY_REVIEW, content: EMPTY_CONTENT, cursor: null, failures: 0, nextAttemptAt: null,
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
  let reviewGen = 0;
  let reviewFileGen = 0;
  // Bumped whenever loaded content is dropped; a content response applies only to the generation it was asked in.
  let contentGen = 0;
  let reviewVisible = false;
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
      // Loaded text stays valid while the run's plan and progress do; when they move, it is dropped.
      const before = state.detail;
      const moved = before === null || before.id !== response.run.id || before.completed !== response.run.completed
        || before.total !== response.run.total || before.status !== response.run.status;
      if (moved) contentGen++;
      update(moved ? { detail: response.run, detailError: null, content: EMPTY_CONTENT } : { detail: response.run, detailError: null });
    } catch (caught) {
      const error = mapHostFailure(caught);
      if (disposed || gen !== detailGen) return;
      if (error.category === 'request') update({ detail: null, detailError: error.message });
      else throw error;
    }
  }

  /** The open file is valid only while it is still in the list the service last returned. */
  function listed(review: ReviewSlice, path: string): boolean {
    return review.data !== null && review.data.files.some(file => file.path === path);
  }

  async function loadReviewFile(path: string, runId: string): Promise<void> {
    // Only paths the service listed are ever requested.
    if (state.review.runId !== runId || !listed(state.review, path)) return;
    const gen = ++reviewFileGen;
    const previous = state.review.file?.path === path ? state.review.file.data : null;
    update({ review: { ...state.review, selectedPath: path, file: { path, loading: true, data: previous, error: null } } });
    try {
      const response = await client.reviewFile(runId, path);
      if (disposed || gen !== reviewFileGen) return;
      if (state.review.runId !== runId || state.review.selectedPath !== path) return;
      update({ review: { ...state.review, file: { path, loading: false, data: response, error: null } } });
    } catch (caught) {
      const error = mapHostFailure(caught);
      if (disposed || gen !== reviewFileGen) return;
      if (state.review.runId !== runId || state.review.selectedPath !== path) return;
      if (error.category === 'request') update({ review: { ...state.review, file: { path, loading: false, data: previous, error: error.message } } });
      else {
        update({ review: { ...state.review, file: { path, loading: false, data: previous, error: error.message } } });
        throw error;
      }
    }
  }

  async function loadReview(): Promise<void> {
    const id = state.selectedRunId;
    if (id === null) return;
    const gen = ++reviewGen;
    const same = state.review.runId === id;
    update({ review: { ...(same ? state.review : EMPTY_REVIEW), runId: id, loading: true } });
    let reopen: string | null = null;
    try {
      const response = await client.review(id);
      if (disposed || gen !== reviewGen || state.selectedRunId !== id) return;
      const open = state.review.selectedPath;
      const keep = open !== null && response.files.some(file => file.path === open);
      update({
        review: {
          runId: id, loading: false, data: response, error: null, stale: false,
          selectedPath: keep ? open : null, file: keep ? state.review.file : null,
        },
      });
      reopen = keep ? open : null;
    } catch (caught) {
      const error = mapHostFailure(caught);
      if (disposed || gen !== reviewGen || state.selectedRunId !== id) return;
      update({ review: { ...state.review, loading: false, error: error.message, stale: state.review.data !== null } });
      if (error.category !== 'request') throw error;
    }
    if (reopen !== null) await loadReviewFile(reopen, id);
  }

  /** The selected run's slice, started afresh when it belonged to another run. */
  const contentOf = (runId: string): ContentSlice => (state.content.runId === runId ? state.content : { ...EMPTY_CONTENT, runId });

  /** Resolves true only when the service answered; skipped and stale loads resolve false. */
  async function loadTaskContent(runId: string, index: number): Promise<boolean> {
    const detail = state.detail;
    // Only tasks the loaded detail lists are ever requested.
    if (disposed || state.selectedRunId !== runId || detail === null || detail.id !== runId) return false;
    if (!detail.tasks.some(task => task.index === index)) return false;
    const existing = contentOf(runId).tasks[index];
    if (existing && (existing.loading || existing.data !== null)) return false;
    const gen = contentGen;
    const put = (entry: ContentEntry<TaskContentResponse>): void => {
      const base = contentOf(runId);
      update({ content: { ...base, tasks: { ...base.tasks, [index]: entry } } });
    };
    put({ loading: true, data: null, error: null });
    try {
      const response = await client.taskContent(runId, index);
      if (disposed || gen !== contentGen || state.content.runId !== runId) return false;
      put({ loading: false, data: response, error: null });
      return true;
    } catch (caught) {
      const error = mapHostFailure(caught);
      if (disposed || gen !== contentGen || state.content.runId !== runId) return false;
      put({ loading: false, data: null, error: error.message });
      if (error.category !== 'request') throw error;
      return false;
    }
  }

  async function loadBlockerContent(runId: string): Promise<boolean> {
    const detail = state.detail;
    if (disposed || state.selectedRunId !== runId || detail === null || detail.id !== runId || detail.blocker === null) return false;
    const existing = contentOf(runId).blocker;
    if (existing && (existing.loading || existing.data !== null)) return false;
    const gen = contentGen;
    const put = (entry: ContentEntry<BlockerContentResponse>): void => { update({ content: { ...contentOf(runId), blocker: entry } }); };
    put({ loading: true, data: null, error: null });
    try {
      const response = await client.blockerContent(runId);
      if (disposed || gen !== contentGen || state.content.runId !== runId) return false;
      put({ loading: false, data: response, error: null });
      return true;
    } catch (caught) {
      const error = mapHostFailure(caught);
      if (disposed || gen !== contentGen || state.content.runId !== runId) return false;
      put({ loading: false, data: null, error: error.message });
      if (error.category !== 'request') throw error;
      return false;
    }
  }

  const reviewLoad = (): void => { void loadReview().then(standaloneSuccess, standaloneFailure); };

  /** Full reload after a resync or the first load. The cursor is taken before the lists. */
  async function fullSync(gen: number, cursor: string | null): Promise<void> {
    if (cursor === null) {
      const feed = await client.changes(null);
      if (disposed || gen !== cycleGen) return;
      cursor = feed.cursor;
    }
    const work = [loadProjects(), loadRuns(), loadDetail()];
    if (reviewVisible && state.selectedRunId !== null) work.push(loadReview());
    await Promise.all(work);
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
          if (state.selectedRunId !== null && feed.changedRunIds.includes(state.selectedRunId)) {
            work.push(loadDetail());
            if (reviewVisible) work.push(loadReview());
          }
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
      detailGen++; reviewGen++; reviewFileGen++; contentGen++;
      // The tab announces itself again once the new run is drawn.
      reviewVisible = false;
      update({ selectedRunId: id, detail: null, detailError: null, review: EMPTY_REVIEW, content: EMPTY_CONTENT });
      if (id !== null) void loadDetail().then(standaloneSuccess, standaloneFailure);
    },
    setReviewVisible(visible) {
      if (disposed || visible === reviewVisible) return;
      reviewVisible = visible;
      if (!visible) return;
      // Entering the tab reloads (earlier data stays on screen meanwhile); the change feed keeps it current while open.
      if (state.selectedRunId !== null) reviewLoad();
    },
    refreshReview() {
      if (disposed || state.selectedRunId === null) return;
      reviewLoad();
    },
    selectReviewFile(path) {
      if (disposed || state.review.runId === null) return;
      const runId = state.review.runId;
      if (path === null) {
        reviewFileGen++;
        update({ review: { ...state.review, selectedPath: null, file: null } });
        return;
      }
      if (!listed(state.review, path)) return;
      void loadReviewFile(path, runId).then(standaloneSuccess, standaloneFailure);
    },
    loadTaskContent(runId, index) {
      if (disposed || !IDENTIFIER.test(runId) || !Number.isInteger(index)) return;
      void loadTaskContent(runId, index).then(answered => { if (answered) standaloneSuccess(); }, standaloneFailure);
    },
    loadBlockerContent(runId) {
      if (disposed || !IDENTIFIER.test(runId)) return;
      void loadBlockerContent(runId).then(answered => { if (answered) standaloneSuccess(); }, standaloneFailure);
    },
    refreshDetail() {
      if (disposed || state.selectedRunId === null) return;
      contentGen++;
      update({ content: EMPTY_CONTENT });
      void loadDetail().then(standaloneSuccess, standaloneFailure);
    },
    dispose() {
      disposed = true;
      cycleGen++; runsGen++; detailGen++; projectsGen++; reviewGen++; reviewFileGen++; contentGen++;
      if (pollTimer !== null) timers.clearTimeout(pollTimer);
      if (staleTimer !== null) timers.clearTimeout(staleTimer);
      pollTimer = null;
      staleTimer = null;
      listeners.clear();
    },
  };
}
