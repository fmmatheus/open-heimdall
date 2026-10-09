/**
 * Pure presentation logic for the Review tab: turns the store's review slice into rows, notices and classified
 * diff lines. No DOM and no SDK imports, so it is unit-testable in Node. File names and diff text pass through
 * unchanged; main.ts writes them with textContent only, so markup in a name or a diff is shown literally.
 * Nothing here decides what changed: every count, letter and message comes from the service's answer.
 */
import type { ReviewFileSlice, ReviewSlice } from './store.js';
import { REVIEW_LIMITS } from '../shared/protocol.js';
import type { ReviewChange, ReviewFile, ReviewFileResponse, ReviewResponse, ReviewState } from '../shared/protocol.js';
import { formatCount } from './view-model.js';
import type { Tone } from './view-model.js';

export const REVIEW_TAB_LABEL = 'Review';

/** Shown on every review that is not loading: what is compared, and why Heimdall draws it itself. */
export const COMPARISON_NOTE = 'This compares the run\'s base commit with the current managed worktree, including commits, staged and unstaged edits and untracked files. OpenChamber\'s commit view shows a single commit and cannot represent that baseline, so Heimdall shows the diff here instead.';

export const RUNTIME_GROUP_LABEL = 'Heimdall runtime files';
export const RUNTIME_GROUP_NOTE = 'Written by Heimdall into every managed worktree. They are not feature changes and their contents are not shown.';

/** Largest number of diff lines drawn for one file; the service already caps the text at 64 KiB. */
export const MAX_DIFF_LINES = 2000;

export const STATE_TEXT: Record<Exclude<ReviewState, 'ready'>, { title: string; message: string }> = {
  'queued-no-worktree': { title: 'Nothing to review yet', message: 'This run has not started yet, so there is no worktree to review.' },
  'worktree-missing': { title: 'Worktree is missing', message: 'The managed worktree for this run is missing. It may have been removed, so there is nothing to compare.' },
  'worktree-mismatch': { title: 'Worktree was not inspected', message: 'The managed worktree does not match the coordinator\'s record, so it was not inspected.' },
};

const CHANGE_LETTER: Record<ReviewChange, string> = {
  added: 'A', modified: 'M', deleted: 'D', 'type-changed': 'T', unmerged: 'U', untracked: '?',
};
const CHANGE_LABEL: Record<ReviewChange, string> = {
  added: 'Added', modified: 'Modified', deleted: 'Deleted', 'type-changed': 'Type changed', unmerged: 'Conflict', untracked: 'Untracked',
};

export function shortCommit(oid: string): string {
  return oid === '' ? 'unknown' : oid.slice(0, 12);
}

export function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return 'unknown size';
  if (value < 1024) return `${Math.trunc(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

// ----- file list -----

export interface ChangeCounts { added: number; modified: number; deleted: number; untracked: number; other: number }

export interface ReviewHeader {
  /** First 12 characters of the base commit. */
  baseCommit: string;
  baseCommitFull: string;
  branch: string;
  head: string | null;
  counts: ChangeCounts;
  /** "2 added · 1 modified", or "No changes". */
  summary: string;
  /** "+12 −3" from the files git counted; empty when nothing was counted. */
  lines: string;
  binary: number;
}

export function changeCounts(files: readonly Pick<ReviewFile, 'change'>[]): ChangeCounts {
  const counts: ChangeCounts = { added: 0, modified: 0, deleted: 0, untracked: 0, other: 0 };
  for (const file of files) {
    if (file.change === 'added') counts.added++;
    else if (file.change === 'modified') counts.modified++;
    else if (file.change === 'deleted') counts.deleted++;
    else if (file.change === 'untracked') counts.untracked++;
    else counts.other++;
  }
  return counts;
}

export function reviewHeader(review: ReviewResponse): ReviewHeader {
  const counts = changeCounts(review.files);
  const parts = ([['added', counts.added], ['modified', counts.modified], ['deleted', counts.deleted], ['untracked', counts.untracked], ['other', counts.other]] as const)
    .filter(([, count]) => count > 0)
    .map(([label, count]) => `${formatCount(count)} ${label}`);
  const { additions, deletions } = review.counts;
  return {
    baseCommit: shortCommit(review.baseCommit),
    baseCommitFull: review.baseCommit,
    branch: review.branch,
    head: review.head === null ? null : shortCommit(review.head),
    counts,
    summary: parts.length === 0 ? 'No changes' : parts.join(' · '),
    lines: additions > 0 || deletions > 0 ? `+${formatCount(additions)} −${formatCount(deletions)}` : '',
    binary: review.counts.binary,
  };
}

export interface FileRow {
  /** The path exactly as the service listed it; also the list id. */
  id: string;
  title: string;
  /** Status letter: A, M, D, T, U or ? (untracked). */
  leading: string;
  change: ReviewChange;
  subtitle: string;
  /** "+3 −1", "binary", or the size of an untracked file. */
  meta: string;
}

function fileMeta(file: ReviewFile): string {
  if (file.binary === true) return 'binary';
  if (file.additions !== null && file.deletions !== null) return `+${formatCount(file.additions)} −${formatCount(file.deletions)}`;
  if (file.size !== null) return formatBytes(file.size);
  return '';
}

export function fileRows(files: readonly ReviewFile[]): FileRow[] {
  return files.map(file => ({
    id: file.path,
    title: file.path,
    leading: CHANGE_LETTER[file.change],
    change: file.change,
    subtitle: CHANGE_LABEL[file.change],
    meta: fileMeta(file),
  }));
}

export interface GeneratedGroup {
  label: string;
  note: string;
  /** Always collapsed when first drawn. */
  collapsed: true;
  count: number;
  rows: Array<{ path: string; letter: string; label: string }>;
}

/** Runtime artifacts are listed apart from feature files and are never opened. Null when there are none. */
export function generatedGroup(review: Pick<ReviewResponse, 'generated' | 'counts'>): GeneratedGroup | null {
  if (review.generated.length === 0 && review.counts.generated === 0) return null;
  return {
    label: RUNTIME_GROUP_LABEL,
    note: RUNTIME_GROUP_NOTE,
    collapsed: true,
    count: Math.max(review.counts.generated, review.generated.length),
    rows: review.generated.map(file => ({ path: file.path, letter: CHANGE_LETTER[file.change], label: CHANGE_LABEL[file.change] })),
  };
}

// ----- diff -----

export type DiffLineKind = 'meta' | 'hunk' | 'add' | 'del' | 'context' | 'note';
export interface DiffLine { kind: DiffLineKind; text: string }

/**
 * Classify unified-diff text for styling. Inside a hunk every line is content by its first character, so a
 * deleted line that reads `-- x` is a deletion, not a header; headers exist only before the first `@@`.
 */
export function classifyDiff(text: string): DiffLine[] {
  if (text === '') return [];
  const raw = text.split('\n');
  if (raw[raw.length - 1] === '') raw.pop();
  const lines: DiffLine[] = [];
  let inHunk = false;
  for (const line of raw) {
    if (line.startsWith('diff ')) { inHunk = false; lines.push({ kind: 'meta', text: line }); continue; }
    if (line.startsWith('@@')) { inHunk = true; lines.push({ kind: 'hunk', text: line }); continue; }
    if (!inHunk) { lines.push({ kind: 'meta', text: line }); continue; }
    if (line.startsWith('+')) lines.push({ kind: 'add', text: line });
    else if (line.startsWith('-')) lines.push({ kind: 'del', text: line });
    else if (line.startsWith('\\')) lines.push({ kind: 'note', text: line });
    else lines.push({ kind: 'context', text: line });
  }
  return lines;
}

export interface DiffView {
  path: string;
  mode: 'loading' | 'error' | 'message' | 'diff';
  /** The explanation when there is no diff to draw (binary, missing, ...), or the load error. */
  message: string | null;
  /** Extra sentences shown above the lines: large, truncated, deleted, failed refresh. */
  notices: string[];
  lines: DiffLine[];
  /** "+3 −1 · 1.2 KiB" style summary of the open file, or empty. */
  stats: string;
}

function fileStats(data: ReviewFileResponse): string {
  const parts: string[] = [];
  if (data.additions !== null && data.deletions !== null) parts.push(`+${formatCount(data.additions)} −${formatCount(data.deletions)}`);
  else if (data.additions !== null) parts.push(`+${formatCount(data.additions)}`);
  if (data.size !== null) parts.push(formatBytes(data.size));
  return parts.join(' · ');
}

const VIEW_MESSAGES = {
  binary: 'Binary file – no text diff is shown.',
  missing: 'This file is no longer in the worktree. It may have been removed since the list loaded; refresh the review to update the list.',
  unsupported: 'This path is a symbolic link, a special file or otherwise cannot be shown safely, so its contents are not displayed.',
  generated: 'Heimdall runtime file – its contents are not shown.',
  empty: 'No text changes to show (for example an empty file or a change that only affects the file mode).',
  deletedBinary: 'This binary file was deleted in the worktree – no text diff is shown.',
  deletedNoText: 'This file was deleted in the worktree.',
  deletedNote: 'This file was deleted in the worktree.',
} as const;

export function diffView(file: ReviewFileSlice | null): DiffView | null {
  if (file === null) return null;
  const base = { path: file.path, notices: [] as string[], lines: [] as DiffLine[], stats: '' };
  const data = file.data;
  if (data === null) {
    if (file.error !== null) return { ...base, mode: 'error', message: file.error };
    return { ...base, mode: 'loading', message: 'Loading diff…' };
  }
  const notices = base.notices;
  if (file.error !== null) notices.push(`Could not refresh this diff: ${file.error} Showing the last copy loaded.`);
  const stats = fileStats(data);
  if (data.state !== 'ready') {
    const text = STATE_TEXT[data.state];
    return { ...base, notices, mode: 'message', message: text.message };
  }
  switch (data.view) {
    case 'binary': return { ...base, notices, stats, mode: 'message', message: VIEW_MESSAGES.binary };
    case 'missing': return { ...base, notices, stats, mode: 'message', message: VIEW_MESSAGES.missing };
    case 'unsupported': return { ...base, notices, stats, mode: 'message', message: VIEW_MESSAGES.unsupported };
    case 'generated': return { ...base, notices, stats, mode: 'message', message: VIEW_MESSAGES.generated };
    case 'deleted':
      if (data.text === '') return { ...base, notices, stats, mode: 'message', message: data.binary ? VIEW_MESSAGES.deletedBinary : VIEW_MESSAGES.deletedNoText };
      notices.push(VIEW_MESSAGES.deletedNote);
      break;
    case 'diff': break;
    default: return { ...base, notices, stats, mode: 'message', message: 'The service did not say how to show this file.' };
  }
  let lines = classifyDiff(data.text);
  if (lines.length === 0) return { ...base, notices, stats, mode: 'message', message: VIEW_MESSAGES.empty };
  if (data.large) notices.push(`Large diff: only the first ${formatBytes(REVIEW_LIMITS.diffBytes)} of it are shown.`);
  else if (data.truncated) notices.push('This diff was shortened to fit the response limit.');
  if (lines.length > MAX_DIFF_LINES) {
    notices.push(`Showing the first ${formatCount(MAX_DIFF_LINES)} of ${formatCount(lines.length)} lines.`);
    lines = lines.slice(0, MAX_DIFF_LINES);
  }
  return { ...base, notices, stats, mode: 'diff', message: null, lines };
}

// ----- whole tab -----

export interface ReviewView {
  /** `loading`: nothing to show yet. `error`: the review could not be loaded. `unavailable`: the worktree cannot be inspected. */
  mode: 'loading' | 'error' | 'unavailable' | 'ready';
  title: string | null;
  message: string | null;
  tone: Tone;
  /** Stale and shortened-list notices. */
  notices: string[];
  header: ReviewHeader | null;
  files: FileRow[];
  generated: GeneratedGroup | null;
  /** Shown instead of the file list when a ready review has no feature files. */
  emptyText: string | null;
  note: string;
  diff: DiffView | null;
  selectedPath: string | null;
  refreshing: boolean;
}

export function reviewView(review: ReviewSlice): ReviewView {
  const common = { note: COMPARISON_NOTE, selectedPath: review.selectedPath, refreshing: review.loading && review.data !== null };
  const blank = { header: null, files: [], generated: null, emptyText: null, diff: null, notices: [] as string[] };
  const data = review.data;
  if (data === null) {
    if (review.error !== null) return { ...common, ...blank, mode: 'error', title: 'The review could not be loaded', message: review.error, tone: 'error' };
    return { ...common, ...blank, mode: 'loading', title: null, message: 'Loading review…', tone: 'neutral' };
  }
  const notices: string[] = [];
  if (review.stale && review.error !== null) notices.push(`The latest refresh failed: ${review.error} Showing the last review loaded.`);
  if (data.state !== 'ready') {
    const text = STATE_TEXT[data.state];
    return {
      ...common, ...blank, notices, mode: 'unavailable', title: text.title, message: text.message,
      tone: data.state === 'queued-no-worktree' ? 'neutral' : 'warning',
      header: reviewHeader(data),
    };
  }
  if (data.truncated) notices.push('The change list was shortened to fit its limits, so some changed files may not be listed.');
  return {
    ...common, mode: 'ready', title: null, message: null, tone: 'neutral', notices,
    header: reviewHeader(data),
    files: fileRows(data.files),
    generated: generatedGroup(data),
    emptyText: data.files.length === 0 ? 'No files differ from the base commit.' : null,
    diff: diffView(review.file),
  };
}
