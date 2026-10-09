import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  COMPARISON_NOTE,
  MAX_DIFF_LINES,
  RUNTIME_GROUP_LABEL,
  STATE_TEXT,
  changeCounts,
  classifyDiff,
  diffView,
  fileRows,
  formatBytes,
  generatedGroup,
  reviewHeader,
  reviewView,
  shortCommit,
} from '../dist/extension/panel/review-view.js';
import { detailTabs } from '../dist/extension/panel/view-model.js';
import { EMPTY_REVIEW, createPanelStore } from '../dist/extension/panel/store.js';

const MARKUP = '<img src=x onerror=alert(1)>';
const BASE = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const flush = async () => { for (let i = 0; i < 8; i += 1) await new Promise(resolve => setImmediate(resolve)); };

const file = (path, change = 'modified', extra = {}) => ({ path, change, additions: 1, deletions: 0, binary: false, size: null, ...extra });

function review(overrides = {}) {
  const files = overrides.files ?? [file('src/a.ts'), file('src/b.ts', 'added')];
  const generated = overrides.generated ?? [];
  return {
    state: 'ready', message: null, baseCommit: BASE, branch: 'heimdall/run/run_1', head: HEAD, files, generated,
    counts: { files: files.length, generated: generated.length, additions: 2, deletions: 0, binary: 0 },
    truncated: false, fetchedAt: 'x', ...overrides,
  };
}

function fileResponse(overrides = {}) {
  return {
    state: 'ready', message: null, baseCommit: BASE, path: 'src/a.ts', change: 'modified', view: 'diff', binary: false,
    large: false, truncated: false, additions: 1, deletions: 1, size: null,
    text: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n', fetchedAt: 'x',
    ...overrides,
  };
}

const slice = (overrides = {}) => ({ ...EMPTY_REVIEW, runId: 'run_1', ...overrides });
const fileSlice = (path, data, extra = {}) => ({ path, loading: false, data, error: null, ...extra });

// ----- view models -----

test('Review is a tab of the run detail', () => {
  assert.deepEqual(detailTabs(null).map(tab => tab.id), ['sessions', 'tasks', 'review', 'details']);
  assert.equal(detailTabs(null).find(tab => tab.id === 'review').label, 'Review');
});

test('ready review: baseline header, change counts and file rows with status letters and +/- counts', () => {
  const view = reviewView(slice({
    data: review({
      files: [
        file('a.ts', 'added', { additions: 10, deletions: 0 }),
        file('b.ts', 'modified', { additions: 3, deletions: 2 }),
        file('c.ts', 'deleted', { additions: 0, deletions: 7 }),
        file('d.png', 'modified', { additions: null, deletions: null, binary: true }),
        file('e.ts', 'untracked', { additions: null, deletions: null, binary: null, size: 2048 }),
        file('f.ts', 'unmerged', { additions: null, deletions: null }),
        file('g.ts', 'type-changed', { additions: null, deletions: null }),
      ],
      counts: { files: 7, generated: 0, additions: 13, deletions: 9, binary: 1 },
    }),
  }));
  assert.equal(view.mode, 'ready');
  assert.equal(view.header.baseCommit, 'a'.repeat(12));
  assert.equal(view.header.baseCommitFull, BASE);
  assert.equal(view.header.branch, 'heimdall/run/run_1');
  assert.equal(view.header.head, 'b'.repeat(12));
  assert.deepEqual(view.header.counts, { added: 1, modified: 2, deleted: 1, untracked: 1, other: 2 });
  assert.equal(view.header.summary, '1 added · 2 modified · 1 deleted · 1 untracked · 2 other');
  assert.equal(view.header.lines, '+13 −9');
  assert.equal(view.header.binary, 1);
  assert.deepEqual(view.files.map(row => [row.id, row.leading, row.meta]), [
    ['a.ts', 'A', '+10 −0'], ['b.ts', 'M', '+3 −2'], ['c.ts', 'D', '+0 −7'], ['d.png', 'M', 'binary'],
    ['e.ts', '?', '2.0 KiB'], ['f.ts', 'U', ''], ['g.ts', 'T', ''],
  ]);
  assert.deepEqual(view.files.map(row => row.subtitle), ['Added', 'Modified', 'Deleted', 'Modified', 'Untracked', 'Conflict', 'Type changed']);
  assert.equal(view.emptyText, null);
  assert.equal(view.generated, null);
});

test('a ready review with no changes says so', () => {
  const view = reviewView(slice({ data: review({ files: [], counts: { files: 0, generated: 0, additions: 0, deletions: 0, binary: 0 } }) }));
  assert.equal(view.header.summary, 'No changes');
  assert.equal(view.header.lines, '');
  assert.equal(view.emptyText, 'No files differ from the base commit.');
  assert.deepEqual(view.files, []);
});

test('the comparison note explains baseCommit to worktree and why the commit view is not used', () => {
  const view = reviewView(slice({ data: review() }));
  assert.equal(view.note, COMPARISON_NOTE);
  assert.match(COMPARISON_NOTE, /base commit/);
  assert.match(COMPARISON_NOTE, /current managed worktree/);
  assert.match(COMPARISON_NOTE, /staged and unstaged/);
  assert.match(COMPARISON_NOTE, /untracked/);
  assert.match(COMPARISON_NOTE, /commit view/);
  assert.match(COMPARISON_NOTE, /cannot represent that baseline/);
});

test('generated runtime artifacts are a separate collapsed group and never in the file list', () => {
  const generated = [file('.heimdall/managed.json', 'untracked', { additions: null, deletions: null }), file('.opencode/plugins/heimdall.ts', 'untracked', { additions: null, deletions: null })];
  const view = reviewView(slice({ data: review({ files: [file('src/a.ts')], generated, counts: { files: 1, generated: 2, additions: 1, deletions: 0, binary: 0 } }) }));
  assert.deepEqual(view.files.map(row => row.id), ['src/a.ts']);
  assert.equal(view.generated.label, RUNTIME_GROUP_LABEL);
  assert.equal(view.generated.label, 'Runtime metadata (not feature changes)');
  assert.equal(view.generated.collapsed, true);
  assert.equal(view.generated.count, 2);
  assert.deepEqual(view.generated.rows.map(row => row.path), ['.heimdall/managed.json', '.opencode/plugins/heimdall.ts']);
  assert.match(view.generated.note, /contents are not shown/);
  assert.match(view.generated.note, /Heimdall/);
  assert.match(view.generated.note, /\.heimdall/);
  assert.match(view.generated.note, /\.omc/);
  assert.equal(view.header.counts.untracked, 0, 'generated files are not feature counts');
  // The count reflects what exists even when the listing was shortened.
  assert.equal(generatedGroup({ generated: [], counts: { generated: 5 } }).count, 5);
  assert.equal(generatedGroup({ generated: [], counts: { generated: 0 } }), null);
});

test('queued, worktree-missing and worktree-mismatch states explain themselves without a file list', () => {
  for (const [state, tone] of [['queued-no-worktree', 'neutral'], ['worktree-missing', 'warning'], ['worktree-mismatch', 'warning']]) {
    const view = reviewView(slice({ data: review({ state, message: 'x', head: null, files: [], generated: [], counts: { files: 0, generated: 0, additions: 0, deletions: 0, binary: 0 } }) }));
    assert.equal(view.mode, 'unavailable', state);
    assert.equal(view.title, STATE_TEXT[state].title);
    assert.equal(view.message, STATE_TEXT[state].message);
    assert.equal(view.tone, tone);
    assert.equal(view.header.baseCommit, 'a'.repeat(12), 'the recorded baseline is still shown');
    assert.equal(view.header.head, null);
    assert.deepEqual(view.files, []);
    assert.equal(view.diff, null);
    assert.equal(view.note, COMPARISON_NOTE);
  }
  assert.match(STATE_TEXT['queued-no-worktree'].message, /has not started/);
  assert.match(STATE_TEXT['worktree-missing'].message, /missing/);
  assert.match(STATE_TEXT['worktree-mismatch'].message, /does not match/);
});

test('loading, error and stale states', () => {
  assert.equal(reviewView(EMPTY_REVIEW).mode, 'loading');
  assert.equal(reviewView(slice({ loading: true })).message, 'Loading review…');
  const failed = reviewView(slice({ error: 'Git could not inspect the managed worktree.' }));
  assert.equal(failed.mode, 'error');
  assert.equal(failed.message, 'Git could not inspect the managed worktree.');
  assert.equal(failed.tone, 'error');

  const stale = reviewView(slice({ data: review(), error: 'That Heimdall item no longer exists.', stale: true }));
  assert.equal(stale.mode, 'ready');
  assert.match(stale.notices[0], /latest refresh failed/);
  assert.match(stale.notices[0], /Showing the last review loaded/);

  const refreshing = reviewView(slice({ data: review(), loading: true }));
  assert.equal(refreshing.refreshing, true);
  assert.equal(refreshing.mode, 'ready');

  const shortened = reviewView(slice({ data: review({ truncated: true }) }));
  assert.match(shortened.notices[0], /shortened/);
});

test('diff lines are classified; inside a hunk "-- x" is a deletion and "+++ x" an addition', () => {
  const lines = classifyDiff('diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,4 +1,4 @@ fn\n ctx\n--- x\n-gone\n+++ y\n+new\n\\ No newline at end of file\n\n');
  assert.deepEqual(lines.map(line => line.kind), ['meta', 'meta', 'meta', 'meta', 'hunk', 'context', 'del', 'del', 'add', 'add', 'note', 'context']);
  assert.equal(lines[6].text, '--- x');
  assert.equal(lines[8].text, '+++ y');
  assert.deepEqual(classifyDiff(''), []);
  // A second file header leaves the hunk again.
  assert.deepEqual(classifyDiff('@@ -1 +1 @@\n-a\ndiff --git a/y b/y\n--- a/y\n').map(line => line.kind), ['hunk', 'del', 'meta', 'meta']);
});

test('text diff view carries classified lines and stats', () => {
  const view = diffView(fileSlice('src/a.ts', fileResponse()));
  assert.equal(view.mode, 'diff');
  assert.equal(view.stats, '+1 −1');
  assert.deepEqual(view.notices, []);
  assert.deepEqual(view.lines.map(line => line.kind), ['meta', 'meta', 'meta', 'hunk', 'context', 'del', 'add']);
  assert.equal(diffView(null), null);
});

test('binary file: explicit message, no lines', () => {
  const view = diffView(fileSlice('d.png', fileResponse({ path: 'd.png', view: 'binary', binary: true, text: '', additions: null, deletions: null, size: 4096 })));
  assert.equal(view.mode, 'message');
  assert.match(view.message, /Binary file/);
  assert.deepEqual(view.lines, []);
  assert.equal(view.stats, '4.0 KiB');
});

test('deleted file: removed lines shown with a note; a binary or textless deletion gets a message', () => {
  const text = 'diff --git a/gone b/gone\ndeleted file mode 100644\n--- a/gone\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n';
  const withText = diffView(fileSlice('gone', fileResponse({ path: 'gone', change: 'deleted', view: 'deleted', text })));
  assert.equal(withText.mode, 'diff');
  assert.deepEqual(withText.lines.filter(line => line.kind === 'del').map(line => line.text), ['-one', '-two']);
  assert.match(withText.notices[0], /deleted/);

  const binary = diffView(fileSlice('gone.png', fileResponse({ path: 'gone.png', change: 'deleted', view: 'deleted', binary: true, text: '' })));
  assert.equal(binary.mode, 'message');
  assert.match(binary.message, /binary file was deleted/);

  const plain = diffView(fileSlice('gone', fileResponse({ path: 'gone', change: 'deleted', view: 'deleted', text: '' })));
  assert.equal(plain.mode, 'message');
  assert.match(plain.message, /deleted/);
});

test('agent runtime metadata is excluded from the change summary and counted only in its collapsed group', async () => {
  const runtime = ['.omc/project-memory.json', '.omc/sessions/abc.json'].map(name => file(name, 'untracked', { additions: null, deletions: null }));
  const feature = [file('src/new-feature.ts', 'untracked', { additions: null, deletions: null, size: 30 }), file('src/a.ts')];
  const view = reviewView(slice({ data: review({ files: feature, generated: runtime, counts: { files: 2, generated: 2, additions: 1, deletions: 0, binary: 0 } }) }));
  assert.deepEqual(view.files.map(row => row.id), ['src/new-feature.ts', 'src/a.ts']);
  assert.equal(view.generated.count, 2);
  assert.equal(view.generated.collapsed, true);
  assert.deepEqual(view.generated.rows.map(row => row.path), ['.omc/project-memory.json', '.omc/sessions/abc.json']);
  assert.deepEqual(view.header.counts, { added: 0, modified: 1, deleted: 0, untracked: 1, other: 0 });
  assert.equal(view.header.summary, '1 modified · 1 untracked');
  assert.doesNotMatch(view.header.summary, /3|4/);

  // Only runtime metadata changed: nothing counts as a feature change, yet the group is still offered.
  const only = reviewView(slice({ data: review({ files: [], generated: runtime, counts: { files: 0, generated: 2, additions: 0, deletions: 0, binary: 0 } }) }));
  assert.equal(only.header.summary, 'No changes');
  assert.equal(only.emptyText, 'No files differ from the base commit.');
  assert.equal(only.generated.count, 2);

  // The panel draws the group closed, and the "Changed files (N)" title counts feature rows only.
  const main = await readFile(join(fileURLToPath(new URL('..', import.meta.url)), 'src', 'extension', 'panel', 'main.ts'), 'utf8');
  assert.match(main, /node\('details', 'hm-generated'\)/);
  assert.doesNotMatch(main, /generatedBox\.open\s*=\s*true|generatedBox\.setAttribute\('open'/);
  assert.match(main, /`Changed files \(\$\{view\.files\.length\}\)`/);
  assert.doesNotMatch(main, /Changed files \(\$\{[^}]*generated/);
});

test('missing, unsupported and generated files each get an explicit message', () => {
  const missing = diffView(fileSlice('x', fileResponse({ path: 'x', change: 'untracked', view: 'missing', text: '' })));
  assert.equal(missing.mode, 'message');
  assert.match(missing.message, /no longer in the worktree/);
  assert.match(missing.message, /refresh the review/);
  const unsupported = diffView(fileSlice('x', fileResponse({ path: 'x', change: 'untracked', view: 'unsupported', text: '' })));
  assert.match(unsupported.message, /symbolic link/);
  const generated = diffView(fileSlice('.heimdall/x', fileResponse({ path: '.heimdall/x', view: 'generated', text: '' })));
  assert.match(generated.message, /Runtime metadata file/);
  assert.match(generated.message, /contents are not shown/);
  assert.equal(diffView(fileSlice('x', fileResponse({ view: 'diff', text: '' }))).mode, 'message');
  assert.match(diffView(fileSlice('x', fileResponse({ view: 'diff', text: '' }))).message, /No text changes/);
});

test('large and truncated diffs are flagged with how much is shown', () => {
  const large = diffView(fileSlice('big', fileResponse({ path: 'big', large: true, truncated: true })));
  assert.equal(large.mode, 'diff');
  assert.equal(large.notices.length, 1);
  assert.match(large.notices[0], /Large diff: only the first 64\.0 KiB/);

  const shortened = diffView(fileSlice('big', fileResponse({ path: 'big', truncated: true })));
  assert.match(shortened.notices[0], /shortened to fit the response limit/);

  const body = `@@ -1 +1 @@\n${Array.from({ length: MAX_DIFF_LINES + 50 }, (_, index) => `+line ${index}`).join('\n')}\n`;
  const capped = diffView(fileSlice('long', fileResponse({ path: 'long', text: body })));
  assert.equal(capped.lines.length, MAX_DIFF_LINES);
  assert.match(capped.notices.at(-1), /Showing the first 2,000 of 2,051 lines/);
});

test('diff states: loading, error, kept copy after a failed refresh, and non-ready worktree', () => {
  const loading = diffView({ path: 'a', loading: true, data: null, error: null });
  assert.equal(loading.mode, 'loading');
  const failed = diffView({ path: 'a', loading: false, data: null, error: 'That Heimdall item no longer exists.' });
  assert.equal(failed.mode, 'error');
  assert.equal(failed.message, 'That Heimdall item no longer exists.');
  const kept = diffView(fileSlice('src/a.ts', fileResponse(), { error: 'Git could not inspect the managed worktree.' }));
  assert.equal(kept.mode, 'diff');
  assert.match(kept.notices[0], /Could not refresh this diff: Git could not inspect/);
  const gone = diffView(fileSlice('src/a.ts', fileResponse({ state: 'worktree-missing', view: null, text: '' })));
  assert.equal(gone.mode, 'message');
  assert.equal(gone.message, STATE_TEXT['worktree-missing'].message);
});

test('file names and diff text stay literal in every view model', () => {
  const name = `dir/${MARKUP}.ts`;
  const view = reviewView(slice({
    data: review({ files: [file(name)], generated: [file(`.heimdall/${MARKUP}`)], counts: { files: 1, generated: 1, additions: 1, deletions: 0, binary: 0 } }),
    selectedPath: name,
    file: fileSlice(name, fileResponse({ path: name, text: `@@ -1 +1 @@\n-${MARKUP}\n+<script>alert(1)</script>\n` })),
  }));
  assert.equal(view.files[0].id, name);
  assert.equal(view.files[0].title, name);
  assert.equal(view.generated.rows[0].path, `.heimdall/${MARKUP}`);
  assert.equal(view.diff.path, name);
  assert.deepEqual(view.diff.lines.map(line => line.text), ['@@ -1 +1 @@', `-${MARKUP}`, '+<script>alert(1)</script>']);
  for (const line of view.diff.lines) assert.equal(line.text.includes('&lt;'), false);
});

test('small helpers', () => {
  assert.equal(shortCommit(BASE), 'a'.repeat(12));
  assert.equal(shortCommit(''), 'unknown');
  assert.equal(formatBytes(12), '12 B');
  assert.equal(formatBytes(1536), '1.5 KiB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MiB');
  assert.deepEqual(changeCounts([{ change: 'added' }, { change: 'unmerged' }]), { added: 1, modified: 0, deleted: 0, untracked: 0, other: 1 });
  assert.deepEqual(fileRows([]), []);
  assert.equal(reviewHeader(review()).head, 'b'.repeat(12));
});

// ----- store: recording fake host -----

function inertTimers() {
  const pending = [];
  return {
    setTimeout(callback) { pending.push(callback); return pending.length; },
    clearTimeout() {},
    fire: async () => { const due = pending.splice(0); for (const callback of due) callback(); await flush(); },
  };
}

function fixture() {
  const timers = inertTimers();
  const service = {
    requests: [],
    runs: new Set(['run_1', 'run_2']),
    reviews: { run_1: review({ files: [file('src/a.ts'), file(`dir/${MARKUP}.ts`), file('d.png', 'modified', { binary: true, additions: null, deletions: null })], generated: [file('.heimdall/managed.json', 'untracked')] }), run_2: review({ files: [file('other.ts')] }) },
    files: {},
    hold: null,
    fail: null,
    feed: { sequence: 0, ids: [] },
  };
  const reply = (status, body) => ({ status, body: JSON.stringify(body) });
  const detail = id => ({ id, label: id, projectId: 'p', projectName: 'p', status: 'running', phase: 'executing', completed: 0, total: 1, currentTask: null, createdAt: 1, updatedAt: 2, blocker: null, tasks: [], truncated: false });
  const host = {
    async serviceRequest(request) {
      service.requests.push(structuredClone(request));
      if (service.hold) await service.hold(request);
      if (service.fail) {
        const failure = service.fail(request);
        if (failure) return failure;
      }
      const query = request.query ?? {};
      if (request.path === '/changes') {
        return reply(200, { cursor: `aaaaaaaaaaaa:${service.feed.sequence}`, changedRunIds: query.cursor ? service.feed.ids : [], projectsChanged: false, resync: !query.cursor, more: false, fetchedAt: 'x' });
      }
      if (request.path === '/projects') return reply(200, { projects: [], fetchedAt: 'x' });
      if (request.path === '/runs') return reply(200, { runs: [], total: 0, truncated: false, fetchedAt: 'x' });
      let match = /^\/runs\/([^/]+)$/.exec(request.path);
      if (match) return service.runs.has(match[1]) ? reply(200, { run: detail(match[1]), fetchedAt: 'x' }) : reply(404, { error: { kind: 'not-found', message: 'x' } });
      match = /^\/runs\/([^/]+)\/review$/.exec(request.path);
      if (match) return reply(200, service.reviews[match[1]]);
      match = /^\/runs\/([^/]+)\/review\/file$/.exec(request.path);
      if (match) return reply(200, service.files[`${match[1]}:${query.path}`] ?? fileResponse({ path: query.path }));
      return reply(404, { error: { kind: 'not-found', message: 'x' } });
    },
    async serviceStatus() { return { status: 'ready' }; },
  };
  const store = createPanelStore({ host, timers, now: () => 1_000_000, pollIntervalMs: 3000 });
  const reviewRequests = () => service.requests.filter(request => /\/review/.test(request.path));
  const fileRequests = () => service.requests.filter(request => request.path.endsWith('/review/file'));
  return { store, service, timers, reviewRequests, fileRequests };
}

async function openReview(fx, id = 'run_1') {
  fx.store.select(id);
  await flush();
  fx.store.setReviewVisible(true);
  await flush();
}

test('the review loads only while its tab is visible and uses the run review route', async () => {
  const fx = fixture();
  fx.store.select('run_1');
  await flush();
  assert.deepEqual(fx.reviewRequests(), [], 'nothing review-related before the tab is shown');

  fx.store.setReviewVisible(true);
  await flush();
  assert.deepEqual(fx.reviewRequests().map(request => [request.method, request.path, request.query]), [['GET', '/runs/run_1/review', undefined]]);
  const state = fx.store.getState().review;
  assert.equal(state.runId, 'run_1');
  assert.equal(state.loading, false);
  assert.equal(state.data.files.length, 3);
  assert.equal(state.error, null);

  fx.store.setReviewVisible(false);
  fx.store.refreshReview();
  await flush();
  assert.equal(fx.reviewRequests().length, 2, 'refresh is explicit and still allowed; hiding alone requests nothing');
  fx.store.dispose();
});

test('file diffs are requested only for paths the review list returned', async () => {
  const fx = fixture();
  await openReview(fx);
  const listed = fx.store.getState().review.data.files.map(entry => entry.path);

  // Anything not in the returned list never reaches the host: traversal, absolute, generated, unknown, empty.
  for (const bad of ['../../etc/passwd', '/etc/passwd', '.heimdall/managed.json', 'src/unknown.ts', 'src/', '', 'src/a.ts\0', 'SRC/A.TS']) fx.store.selectReviewFile(bad);
  await flush();
  assert.deepEqual(fx.fileRequests(), []);
  assert.equal(fx.store.getState().review.selectedPath, null);

  fx.store.selectReviewFile('src/a.ts');
  await flush();
  fx.store.selectReviewFile(`dir/${MARKUP}.ts`);
  await flush();
  fx.store.selectReviewFile('d.png');
  await flush();

  assert.deepEqual(fx.fileRequests().map(request => [request.method, request.path, request.query]), [
    ['GET', '/runs/run_1/review/file', { path: 'src/a.ts' }],
    ['GET', '/runs/run_1/review/file', { path: `dir/${MARKUP}.ts` }],
    ['GET', '/runs/run_1/review/file', { path: 'd.png' }],
  ]);
  for (const request of fx.fileRequests()) assert.ok(listed.includes(request.query.path), request.query.path);
  for (const request of fx.service.requests) {
    assert.equal(request.method, 'GET');
    assert.equal(Object.hasOwn(request, 'body'), false);
    assert.deepEqual(Object.keys(request.query ?? {}).filter(key => key !== 'path' && key !== 'cursor'), []);
  }
  assert.equal(fx.store.getState().review.selectedPath, 'd.png');
  assert.equal(fx.store.getState().review.file.data.path, 'd.png');
  fx.store.dispose();
});

test('a file diff is not requested before any review is loaded or after the list is gone', async () => {
  const fx = fixture();
  fx.store.select('run_1');
  await flush();
  fx.store.selectReviewFile('src/a.ts');
  await flush();
  assert.deepEqual(fx.fileRequests(), []);

  fx.store.setReviewVisible(true);
  await flush();
  fx.store.select(null);
  fx.store.selectReviewFile('src/a.ts');
  await flush();
  assert.deepEqual(fx.fileRequests(), []);
  assert.deepEqual(fx.store.getState().review, EMPTY_REVIEW);
  fx.store.dispose();
});

test('a slower earlier file response cannot replace a newer selection', async () => {
  const fx = fixture();
  await openReview(fx);
  const release = [];
  fx.service.hold = request => (request.path.endsWith('/review/file') ? new Promise(resolve => release.push(resolve)) : undefined);
  fx.service.files['run_1:src/a.ts'] = fileResponse({ path: 'src/a.ts', text: '@@ -1 +1 @@\n+first\n' });
  fx.service.files['run_1:d.png'] = fileResponse({ path: 'd.png', view: 'binary', binary: true, text: '' });

  fx.store.selectReviewFile('src/a.ts');
  fx.store.selectReviewFile('d.png');
  await flush();
  assert.equal(release.length, 2);
  release[1]();
  await flush();
  release[0]();
  await flush();

  const state = fx.store.getState().review;
  assert.equal(state.selectedPath, 'd.png');
  assert.equal(state.file.path, 'd.png');
  assert.equal(state.file.data.view, 'binary');
  assert.equal(state.file.loading, false);
  fx.store.dispose();
});

test('switching runs drops the old review and ignores its late responses', async () => {
  const fx = fixture();
  fx.store.select('run_1');
  await flush();
  const release = [];
  fx.service.hold = request => (request.path.endsWith('/review') ? new Promise(resolve => release.push(resolve)) : undefined);
  fx.store.setReviewVisible(true);
  await flush();
  assert.equal(fx.store.getState().review.loading, true);

  fx.store.select(null);
  fx.store.select('run_2');
  await flush();
  fx.store.setReviewVisible(true);
  await flush();
  for (const resolve of release) resolve();
  await flush();

  const state = fx.store.getState().review;
  assert.equal(state.runId, 'run_2');
  assert.deepEqual(state.data.files.map(entry => entry.path), ['other.ts']);
  fx.store.dispose();
});

test('a failed refresh keeps the last review on screen as stale; a rejected request stays local to the tab', async () => {
  const fx = fixture();
  await openReview(fx);
  fx.service.fail = request => (request.path.endsWith('/review') ? { status: 404, body: JSON.stringify({ error: { kind: 'not-found', message: 'RAW-SECRET' } }) } : null);
  fx.store.refreshReview();
  await flush();
  let state = fx.store.getState();
  assert.equal(state.review.data.files.length, 3);
  assert.equal(state.review.stale, true);
  assert.equal(state.review.error, 'That Heimdall item no longer exists.');
  assert.equal(state.connection, 'online', 'a refused review request is not a connection failure');
  assert.equal(JSON.stringify(state).includes('RAW-SECRET'), false);
  assert.equal(reviewView(state.review).mode, 'ready');
  assert.match(reviewView(state.review).notices[0], /Showing the last review loaded/);

  // A git failure inside the service is reported on the tab, not as a broken service.
  fx.service.fail = request => (request.path.endsWith('/review') ? { status: 500, body: JSON.stringify({ error: { kind: 'internal-error', message: 'RAW-SECRET' } }) } : null);
  fx.store.refreshReview();
  await flush();
  state = fx.store.getState();
  assert.equal(state.review.error, 'Git could not inspect the managed worktree.');
  assert.equal(state.connection, 'online');

  // Recovery clears the error.
  fx.service.fail = null;
  fx.store.refreshReview();
  await flush();
  state = fx.store.getState();
  assert.equal(state.review.error, null);
  assert.equal(state.review.stale, false);
  fx.store.dispose();
});

test('an unreachable coordinator is a connection failure and keeps the last review', async () => {
  const fx = fixture();
  await openReview(fx);
  fx.service.fail = () => ({ status: 503, body: JSON.stringify({ error: { kind: 'coordinator-offline', message: 'RAW-SECRET' } }) });
  fx.store.refreshReview();
  await flush();
  const state = fx.store.getState();
  assert.equal(state.connection, 'offline');
  assert.equal(state.review.data.files.length, 3);
  assert.equal(state.review.stale, true);
  assert.equal(JSON.stringify(state).includes('RAW-SECRET'), false);
  fx.store.dispose();
});

test('a file that disappears from the refreshed list is closed, one that remains is reloaded', async () => {
  const fx = fixture();
  await openReview(fx);
  fx.store.selectReviewFile('src/a.ts');
  await flush();
  const before = fx.fileRequests().length;

  fx.store.refreshReview();
  await flush();
  assert.equal(fx.fileRequests().length, before + 1, 'the open file is refreshed with the list');
  assert.equal(fx.store.getState().review.selectedPath, 'src/a.ts');

  fx.service.reviews.run_1 = review({ files: [file('only.ts')] });
  fx.store.refreshReview();
  await flush();
  assert.equal(fx.fileRequests().length, before + 1, 'no request for a path that is no longer listed');
  assert.equal(fx.store.getState().review.selectedPath, null);
  assert.equal(fx.store.getState().review.file, null);
  fx.store.dispose();
});

test('a failed file diff is reported on the file, and the list stays usable', async () => {
  const fx = fixture();
  await openReview(fx);
  fx.service.fail = request => (request.path.endsWith('/review/file') ? { status: 400, body: JSON.stringify({ error: { kind: 'invalid-request', message: 'RAW-SECRET' } }) } : null);
  fx.store.selectReviewFile('src/a.ts');
  await flush();
  const state = fx.store.getState();
  assert.equal(state.review.file.error, 'The Heimdall service rejected the request.');
  assert.equal(state.review.file.data, null);
  assert.equal(state.connection, 'online');
  assert.equal(diffView(state.review.file).mode, 'error');
  assert.equal(JSON.stringify(state).includes('RAW-SECRET'), false);
  fx.store.dispose();
});

test('the change feed refreshes the review of the selected run only while the tab is visible', async () => {
  const fx = fixture();
  fx.store.start();
  await flush();
  fx.store.select('run_1');
  await flush();
  fx.store.setReviewVisible(true);
  await flush();
  assert.equal(fx.reviewRequests().length, 1);

  fx.service.feed = { sequence: 1, ids: ['run_1'] };
  await fx.timers.fire();
  assert.equal(fx.reviewRequests().length, 2, 'selected run changed: review reloaded');

  fx.service.feed = { sequence: 2, ids: ['run_2'] };
  await fx.timers.fire();
  assert.equal(fx.reviewRequests().length, 2, 'another run changed: nothing');

  fx.store.setReviewVisible(false);
  const count = fx.reviewRequests().length;
  fx.service.feed = { sequence: 3, ids: ['run_1'] };
  await fx.timers.fire();
  assert.equal(fx.reviewRequests().length, count, 'tab hidden: no review request');
  fx.store.dispose();
});

test('the client validates review requests before touching the host', async () => {
  const { createPanelClient, isAllowedPath } = await import('../dist/extension/panel/client.js');
  const requests = [];
  const client = createPanelClient({
    async serviceRequest(request) { requests.push(request); return { status: 200, body: '{}' }; },
    async serviceStatus() { return { status: 'ready' }; },
  });
  await assert.rejects(client.review('../x'), error => error.name === 'PanelError' && error.category === 'request');
  await assert.rejects(client.reviewFile('run_1', ''), error => error.category === 'request');
  await assert.rejects(client.reviewFile('run_1', 'a\0b'), error => error.category === 'request');
  await assert.rejects(client.reviewFile('run_1', 'a'.repeat(1025)), error => error.category === 'request');
  await assert.rejects(client.reviewFile('a/b', 'x'), error => error.category === 'request');
  assert.equal(requests.length, 0);
  // A well-formed request with a malformed answer is refused, not trusted.
  await assert.rejects(client.review('run_1'), error => error.code === 'invalid-response');
  await assert.rejects(client.reviewFile('run_1', 'src/a.ts'), error => error.code === 'invalid-response');
  assert.equal(isAllowedPath('/runs/run_1/review'), true);
  assert.equal(isAllowedPath('/runs/run_1/review/file'), true);
  assert.equal(isAllowedPath('/runs/run_1/review/../x'), false);
});

// ----- static checks -----

test('panel sources do not use openCommit, deep links or HTML assignment for review', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const names = ['main.ts', 'review-view.ts', 'store.ts', 'client.ts', 'navigation.ts', 'view-model.ts'];
  for (const name of names) {
    const text = await readFile(join(root, 'src', 'extension', 'panel', name), 'utf8');
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, /openCommit/, name);
    assert.doesNotMatch(code, /openchamber:\/\//i, name);
    assert.doesNotMatch(code, /innerHTML|outerHTML|insertAdjacentHTML|DOMParser|createContextualFragment|srcdoc/, name);
  }
  const main = await readFile(join(root, 'src', 'extension', 'panel', 'main.ts'), 'utf8');
  assert.match(main, /hm-diff-line/);
  assert.match(main, /node\('span', 'hm-diff-line', line\.text\)/);
  assert.match(main, /mountList\(listSlot/);
});
