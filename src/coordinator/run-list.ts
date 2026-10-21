import type { RunRecord, RunWaitSummary } from './types.js';

export const RUN_LIST_PAGE_SIZE = 100;
export const RUN_LIST_MAX_BYTES = 1024 * 1024;
export const RUN_LIST_FEATURE_HEAD = 16384;

/** List-only data. Full features, checkpoints and capabilities remain on the run detail routes. */
export interface RunListEntry extends Pick<RunRecord, 'id' | 'projectId' | 'worktreePath' | 'status' | 'createdAt' | 'updatedAt'> {
  feature: string;
  progress: {
    phase: string | null;
    total: number;
    completed: number;
    currentTask: { id: string; title: string } | null;
  };
  /** Bounded summary of what the run is waiting for, or null. Details are on the run detail route. */
  wait: RunWaitSummary | null;
}

export interface RunListPage {
  runs: RunListEntry[];
  total: number;
  /** Immutable insertion cursor, independent of admission order and later updates. */
  nextCursor: number | null;
  /** Fixes the insertion set for a traversal; runs submitted later appear on the next refresh. */
  through: number;
}
