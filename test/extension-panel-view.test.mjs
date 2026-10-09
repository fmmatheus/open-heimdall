import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  ALL_FILTER,
  bannerInfo,
  blockerInfo,
  currentTaskText,
  detailPlaceholder,
  detailTabs,
  emptyInfo,
  evidenceRow,
  formatAge,
  formatCount,
  formatTime,
  lastUpdatedText,
  limitRows,
  listNotice,
  modelRows,
  phaseText,
  progressInfo,
  projectFilterOptions,
  runRows,
  statusBadge,
  statusFilterOptions,
  taskRows,
  usageInfo,
} from '../dist/extension/panel/view-model.js';

const MARKUP = '<img src=x onerror=alert(1)>';
const NOW = Date.parse('2026-03-09T12:00:00Z');

const choice = (model, variant = null) => ({ model, variant });

function summary(overrides = {}) {
  return {
    id: 'run_1', label: 'Add billing', projectId: 'proj_a', projectName: 'alpha-app',
    status: 'running', phase: 'executing', completed: 2, total: 5,
    currentTask: { id: 'T3', title: 'Wire the API' }, createdAt: NOW - 3600_000, updatedAt: NOW - 60_000,
    ...overrides,
  };
}

function limits(overrides = {}) {
  return {
    tokenLimitsDisabled: false,
    maxSessionTokens: 1_000_000, maxRunTokens: 5_000_000, maxPlannerTokens: null,
    maxSessionUncachedTokens: null, maxRunUncachedTokens: 250_000, maxPlannerUncachedTokens: null,
    timeout: { minutes: 90, enforcement: 'warning-only' },
    ...overrides,
  };
}

function detail(overrides = {}) {
  return {
    ...summary(),
    blocker: null,
    models: {
      planner: choice('openai/gpt-5', 'high'), executor: choice('anthropic/sonnet'), fallback: choice(null),
      candidates: [{ key: 'a', model: 'anthropic/sonnet', variant: null }],
      selected: { ...choice('anthropic/sonnet'), checkedAt: '2026-03-09T11:00:00Z' },
      current: choice('anthropic/sonnet'),
    },
    usage: { reportedTotal: 1234567, uncachedTotal: 89000, sessions: [{ sessionId: 'ses_a', role: 'task', reported: 1000, uncached: 10 }] },
    limits: limits(),
    tasks: [
      { id: 'T1', title: 'Scaffold', state: 'done', summary: 'did it', handoff: 'next', evidence: [{ gateId: 'G1', gate: 'npm test', passed: true, detail: 'ok' }], sessionId: 'ses_a', model: 'anthropic/sonnet', truncated: false },
      { id: 'T3', title: 'Wire the API', state: 'current', summary: null, handoff: null, evidence: [], sessionId: null, model: null, truncated: false },
    ],
    sessions: { parent: null, current: null, completed: [] },
    review: { baseCommit: 'a'.repeat(40), branch: 'heimdall/run/x' },
    truncated: false,
    ...overrides,
  };
}

const STATE = {
  connection: 'online', message: null, hint: null, lastSuccessAt: NOW - 1000, stale: false,
  projects: [], runs: [], runsTotal: 0, runsTruncated: false,
  filters: { projectId: null, status: null }, selectedRunId: null, detail: null, detailError: null,
};

test('queued run: waiting for capacity, no progress bar, no task', () => {
  const run = summary({ status: 'queued', phase: 'queued', completed: 0, total: null, currentTask: null });
  assert.deepEqual(statusBadge(run), { label: 'Queued', tone: 'neutral' });
  assert.equal(phaseText(run), 'Queued – waiting for capacity');
  assert.deepEqual(progressInfo(run), { value: null, label: 'Queued – waiting for capacity', tone: 'neutral' });
  assert.equal(currentTaskText(run), 'No task yet');
});

test('preparing run: worktree text and info tone', () => {
  const run = summary({ status: 'preparing', phase: 'preparing', completed: 0, total: null, currentTask: null });
  assert.deepEqual(statusBadge(run), { label: 'Preparing', tone: 'info' });
  assert.equal(phaseText(run), 'Preparing worktree');
  assert.equal(progressInfo(run).label, 'Preparing worktree');
  assert.equal(progressInfo(run).value, null);
});

test('planning run: no task list yet, never a made-up percentage', () => {
  const run = summary({ status: 'running', phase: 'planning', completed: 0, total: null, currentTask: null });
  assert.deepEqual(statusBadge(run), { label: 'Planning', tone: 'primary' });
  assert.equal(phaseText(run), 'Planning – no task list yet');
  assert.deepEqual(progressInfo(run), { value: null, label: 'Planning – no task list yet', tone: 'primary' });
  assert.equal(currentTaskText(run), 'No task yet – the plan is not ready');
});

test('executing run: progress fraction, current task, models, usage and limits', () => {
  const run = detail();
  assert.deepEqual(statusBadge(run), { label: 'Executing', tone: 'primary' });
  assert.equal(phaseText(run), 'Executing T3: Wire the API');
  assert.deepEqual(progressInfo(run), { value: 40, label: '2 of 5 tasks complete', tone: 'primary' });
  assert.equal(currentTaskText(run), 'T3: Wire the API');

  const models = Object.fromEntries(modelRows(run.models).map(row => [row.label, row.value]));
  assert.equal(models['Planner (configured)'], 'openai/gpt-5 (high)');
  assert.equal(models['Executor (configured)'], 'anthropic/sonnet');
  assert.equal(models['Executor fallback (configured)'], 'Not recorded');
  assert.equal(models['Selected by quota check'], 'anthropic/sonnet · checked 2026-03-09T11:00:00Z');
  assert.equal(models['Current attempt'], 'anthropic/sonnet');

  const usage = usageInfo(run.usage);
  assert.equal(usage.reported, '1,234,567 reported tokens');
  assert.equal(usage.uncached, '89,000 uncached reported tokens');
  assert.match(usage.note, /not a live meter/);
  assert.deepEqual(usage.sessions, [{ label: 'Task session ses_a', value: '1,000 reported · 10 uncached' }]);

  const rows = Object.fromEntries(limitRows(run.limits).map(row => [row.label, row.value]));
  assert.equal(rows['Per-session tokens'], '1,000,000 reported tokens');
  assert.equal(rows['Planner tokens'], 'Unlimited');
  assert.equal(rows['Run uncached tokens'], '250,000 reported tokens');
  assert.equal(rows.Timeout, '90 min · warning only, does not stop the run');
});

test('no recorded attempt or selection is reported as such, not invented', () => {
  const rows = modelRows({ planner: choice(null), executor: choice(null), fallback: choice(null), candidates: [], selected: null, current: null });
  assert.deepEqual(rows.map(row => row.value), ['Not recorded', 'Not recorded', 'Not recorded', 'No attempt recorded']);
});

test('limits: disabled token limits and missing timeout', () => {
  const rows = limitRows(limits({ tokenLimitsDisabled: true, timeout: { minutes: null, enforcement: 'warning-only' } }));
  assert.deepEqual(rows.slice(0, 6).map(row => row.value), Array(6).fill('Disabled'));
  assert.equal(rows[6].value, 'None configured');
});

test('paused run: warning badge and recorded reason shown verbatim', () => {
  const run = detail({
    status: 'paused', phase: 'paused',
    blocker: { status: 'paused', reason: 'Token budget reached for T3', reasonRecorded: true, resolution: 'Raise maxRunTokens' },
  });
  assert.deepEqual(statusBadge(run), { label: 'Paused', tone: 'warning' });
  assert.equal(phaseText(run), 'Paused at T3: Wire the API');
  assert.deepEqual(progressInfo(run), { value: 40, label: '2 of 5 tasks complete', tone: 'warning' });
  assert.deepEqual(blockerInfo(run.blocker), {
    title: 'Run is paused', tone: 'warning', reason: 'Token budget reached for T3', resolution: 'Raise maxRunTokens',
  });
});

test('failed run: error badge; a missing reason says so instead of inventing one', () => {
  const run = detail({ status: 'failed', phase: 'failed', blocker: { status: 'failed', reason: 'The coordinator did not record a reason', reasonRecorded: false, resolution: null } });
  assert.deepEqual(statusBadge(run), { label: 'Failed', tone: 'error' });
  assert.equal(phaseText(run), 'Failed at T3: Wire the API');
  const blocker = blockerInfo(run.blocker);
  assert.equal(blocker.title, 'Run failed');
  assert.equal(blocker.tone, 'error');
  assert.equal(blocker.reason, 'No reason was recorded');
  assert.equal(blocker.resolution, null);
  assert.equal(blockerInfo(null), null);
});

test('reconciliation-required run: explicit inspection text and recorded reason', () => {
  const run = detail({
    status: 'reconciliation-required', phase: 'reconciliation-required',
    blocker: { status: 'reconciliation-required', reason: 'Coordinator restarted; inspect this retained run before releasing capacity', reasonRecorded: true, resolution: null },
  });
  assert.deepEqual(statusBadge(run), { label: 'Needs reconciliation', tone: 'warning' });
  assert.match(phaseText(run), /^Reconciliation required/);
  assert.equal(blockerInfo(run.blocker).title, 'Reconciliation required');
  assert.equal(blockerInfo(run.blocker).reason, 'Coordinator restarted; inspect this retained run before releasing capacity');
});

test('succeeded run: complete progress and no current task', () => {
  const run = detail({ status: 'succeeded', phase: 'succeeded', completed: 5, total: 5, currentTask: null });
  assert.deepEqual(statusBadge(run), { label: 'Succeeded', tone: 'success' });
  assert.equal(phaseText(run), 'Succeeded');
  assert.deepEqual(progressInfo(run), { value: 100, label: '5 of 5 tasks complete', tone: 'success' });
  assert.equal(currentTaskText(run), 'All tasks finished');
});

test('a failed run without a task list reports that no list was recorded', () => {
  const run = summary({ status: 'failed', phase: 'failed', completed: 0, total: null, currentTask: null });
  assert.deepEqual(progressInfo(run), { value: null, label: 'No task list was recorded', tone: 'error' });
});

test('evidence: only an explicit true is a pass; missing is unknown', () => {
  assert.equal(evidenceRow({ gateId: 'G1', gate: 'x', passed: true, detail: '' }).outcome, 'passed');
  assert.equal(evidenceRow({ gateId: 'G1', gate: 'x', passed: false, detail: '' }).outcome, 'failed');
  const unknown = evidenceRow({ gateId: null, gate: null, passed: null, detail: 'ran something' });
  assert.equal(unknown.outcome, 'unknown');
  assert.deepEqual(unknown.badge, { label: 'Unknown', tone: 'neutral' });
  assert.equal(evidenceRow({ gateId: 'G1', gate: 'x', passed: undefined, detail: '' }).outcome, 'unknown');
  assert.equal(evidenceRow({ gateId: 'G1', gate: 'x', passed: 'true', detail: '' }).outcome, 'unknown');
});

test('task rows keep done/current/pending states and their recorded text', () => {
  const rows = taskRows([
    ...detail().tasks,
    { id: 'T4', title: 'Docs', state: 'pending', summary: null, handoff: null, evidence: [], sessionId: null, model: null, truncated: true },
  ]);
  assert.deepEqual(rows.map(row => row.badge.label), ['Done', 'Current', 'Pending']);
  assert.equal(rows[0].summary, 'did it');
  assert.equal(rows[0].handoff, 'next');
  assert.equal(rows[0].evidence[0].outcome, 'passed');
  assert.equal(rows[1].evidence.length, 0);
  assert.equal(rows[2].truncated, true);
  assert.deepEqual(detailTabs(detail()).map(tab => [tab.id, tab.count]), [['overview', undefined], ['usage', undefined], ['tasks', 2]]);
});

test('untrusted text stays literal in every view model', () => {
  const run = detail({
    label: MARKUP, projectName: MARKUP,
    currentTask: { id: 'T9', title: MARKUP },
    blocker: { status: 'paused', reason: MARKUP, reasonRecorded: true, resolution: MARKUP },
    models: { planner: choice(MARKUP, MARKUP), executor: choice(MARKUP), fallback: choice(null), candidates: [], selected: null, current: choice(MARKUP) },
    usage: { reportedTotal: 1, uncachedTotal: 1, sessions: [{ sessionId: MARKUP, role: 'unknown', reported: 1, uncached: 1 }] },
    tasks: [{ id: MARKUP, title: MARKUP, state: 'done', summary: MARKUP, handoff: MARKUP, evidence: [{ gateId: MARKUP, gate: MARKUP, passed: true, detail: MARKUP }], sessionId: null, model: MARKUP, truncated: false }],
  });

  const [row] = runRows([run]);
  assert.equal(row.title, MARKUP);
  assert.ok(row.subtitle.startsWith(`${MARKUP} · `));
  assert.ok(row.subtitle.includes(MARKUP, MARKUP.length + 3), 'current task title');
  assert.equal(phaseText(run), `Executing T9: ${MARKUP}`);
  assert.equal(currentTaskText(run), `T9: ${MARKUP}`);
  const blocker = blockerInfo(run.blocker);
  assert.equal(blocker.reason, MARKUP);
  assert.equal(blocker.resolution, MARKUP);
  assert.ok(modelRows(run.models).some(item => item.value === `${MARKUP} (${MARKUP})`));
  assert.ok(usageInfo(run.usage).sessions[0].label.endsWith(MARKUP));
  const [task] = taskRows(run.tasks);
  assert.equal(task.title, MARKUP);
  assert.equal(task.summary, MARKUP);
  assert.equal(task.handoff, MARKUP);
  assert.equal(task.evidence[0].detail, MARKUP);
  assert.equal(task.evidence[0].gate, MARKUP);
  assert.equal(projectFilterOptions([{ id: 'p', name: MARKUP }])[1].label, MARKUP);
  // Nothing was escaped, rewritten or wrapped: the view models hand the raw string to textContent.
  for (const value of [row.title, blocker.reason, task.summary]) assert.equal(value.includes('&lt;'), false);
});

test('run rows carry badge, project, phase and progress fraction', () => {
  const rows = runRows([summary(), summary({ id: 'run_2', status: 'queued', phase: 'queued', completed: 0, total: null, currentTask: null })]);
  assert.deepEqual(rows[0], {
    id: 'run_1', title: 'Add billing', subtitle: 'alpha-app · Executing T3: Wire the API', meta: '2/5',
    badge: { label: 'Executing', tone: 'primary' },
  });
  assert.equal(rows[1].meta, '');
  assert.equal(rows[1].subtitle, 'alpha-app · Queued – waiting for capacity');
});

test('filter options cover every status and all-projects', () => {
  const statuses = statusFilterOptions();
  assert.equal(statuses[0].id, ALL_FILTER);
  assert.deepEqual(statuses.slice(1).map(option => option.id), ['queued', 'preparing', 'running', 'paused', 'succeeded', 'failed', 'reconciliation-required']);
  assert.deepEqual(projectFilterOptions([{ id: 'proj_a', name: 'alpha-app' }]), [
    { id: ALL_FILTER, label: 'All projects' }, { id: 'proj_a', label: 'alpha-app' },
  ]);
});

test('formatting helpers are deterministic', () => {
  assert.equal(formatCount(1234567), '1,234,567');
  assert.equal(formatCount(12), '12');
  assert.equal(formatCount(Number.NaN), 'Not recorded');
  assert.equal(formatTime(Date.parse('2026-03-09T12:34:56Z')), '2026-03-09 12:34 UTC');
  assert.equal(formatAge(NOW - 3000, NOW), 'just now');
  assert.equal(formatAge(NOW - 30_000, NOW), '30 s ago');
  assert.equal(formatAge(NOW - 5 * 60_000, NOW), '5 min ago');
  assert.equal(formatAge(NOW - 3 * 3600_000, NOW), '3 h ago');
  assert.equal(formatAge(NOW - 72 * 3600_000, NOW), '3 d ago');
  assert.equal(formatAge(NOW + 5000, NOW), 'just now');
  assert.equal(lastUpdatedText(null, NOW), 'No data has been loaded yet.');
  assert.equal(lastUpdatedText(NOW - 120_000, NOW), `Last updated 2 min ago (${formatTime(NOW - 120_000)}).`);
});

test('connection banners: connecting, offline, service unavailable, stale, healthy', () => {
  assert.equal(bannerInfo(STATE, NOW), null);
  assert.equal(bannerInfo({ ...STATE, connection: 'connecting', lastSuccessAt: null }, NOW).title, 'Connecting to Heimdall…');

  const offline = bannerInfo({
    ...STATE, connection: 'offline', stale: true, lastSuccessAt: NOW - 90_000,
    message: 'The Heimdall coordinator is not running.', hint: 'Start the Heimdall coordinator: heimdall coordinator serve',
  }, NOW);
  assert.equal(offline.tone, 'warning');
  assert.equal(offline.title, 'The Heimdall coordinator is not running. Showing stale data.');
  assert.match(offline.body, /Last updated 1 min ago \(2026-03-09 11:58 UTC\)\./);
  assert.match(offline.body, /heimdall coordinator serve/);
  assert.deepEqual(offline.action, { label: 'Retry', kind: 'retry' });

  const unavailable = bannerInfo({ ...STATE, connection: 'service-unavailable', stale: false, lastSuccessAt: null, message: 'The Heimdall extension is disabled.', hint: 'Enable Heimdall in Settings → Extensions.' }, NOW);
  assert.equal(unavailable.tone, 'error');
  assert.equal(unavailable.title, 'The Heimdall extension is disabled.');
  assert.match(unavailable.body, /^No data has been loaded yet\. Enable Heimdall/);

  const stale = bannerInfo({ ...STATE, stale: true, lastSuccessAt: NOW - 30_000 }, NOW);
  assert.equal(stale.title, 'Data may be out of date');
  assert.match(stale.body, /Last updated 30 s ago/);
  assert.equal(stale.action.kind, 'retry');
});

test('empty states: loading, no coordinator, no runs, filters match nothing, none when runs exist', () => {
  assert.equal(emptyInfo({ ...STATE, connection: 'connecting', lastSuccessAt: null }).title, 'Loading runs…');

  const offline = emptyInfo({ ...STATE, connection: 'offline', lastSuccessAt: null, message: 'The Heimdall coordinator is not running.', hint: 'Start it.' });
  assert.equal(offline.title, 'No coordinator connection');
  assert.equal(offline.body, 'The Heimdall coordinator is not running. Start it.');
  assert.deepEqual(offline.action, { label: 'Retry', kind: 'retry' });

  assert.equal(emptyInfo({ ...STATE, connection: 'service-unavailable', lastSuccessAt: null, message: 'x', hint: null }).title, 'Heimdall service unavailable');

  const none = emptyInfo(STATE);
  assert.equal(none.title, 'No Heimdall runs yet');
  assert.equal(none.action, null);

  const filtered = emptyInfo({ ...STATE, filters: { projectId: 'proj_a', status: null } });
  assert.equal(filtered.title, 'No runs match these filters');
  assert.deepEqual(filtered.action, { label: 'Clear filters', kind: 'clear-filters' });

  // Offline after a successful load keeps showing "no runs yet" rather than a connection error body.
  assert.equal(emptyInfo({ ...STATE, connection: 'offline', lastSuccessAt: NOW - 1000 }).title, 'No Heimdall runs yet');
  assert.equal(emptyInfo({ ...STATE, runs: [summary()] }), null);
});

test('list and detail notices tie to store state', () => {
  assert.equal(listNotice({ runs: [summary()], runsTotal: 1, runsTruncated: false }), null);
  assert.equal(listNotice({ runs: [summary()], runsTotal: 450, runsTruncated: true }), 'Showing the 1 most recently updated of 450 runs.');
  assert.equal(detailPlaceholder(STATE), 'Select a run to see its details.');
  assert.equal(detailPlaceholder({ ...STATE, selectedRunId: 'run_1' }), 'Loading run…');
  assert.equal(detailPlaceholder({ ...STATE, selectedRunId: 'run_1', detailError: 'This run no longer exists.' }), 'This run no longer exists.');
  assert.equal(detailPlaceholder({ ...STATE, selectedRunId: 'run_1', detail: detail() }), null);
  assert.equal(detailPlaceholder({ ...STATE, selectedRunId: 'run_2', detail: detail() }), 'Loading run…');
});

async function sourceFiles(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sourceFiles(path));
    else if (/\.(ts|tsx|js|mjs|html)$/.test(entry.name)) found.push(path);
  }
  return found;
}

test('panel sources never assign HTML or write documents', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const files = [
    ...await sourceFiles(join(root, 'src', 'extension', 'panel')),
    join(root, 'extension', 'panel', 'index.html'),
  ];
  assert.ok(files.length >= 4);
  const forbidden = /innerHTML|outerHTML|insertAdjacentHTML|document\s*\.\s*write|DOMParser|createContextualFragment|srcdoc|\beval\s*\(|new\s+Function\s*\(/;
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    // Comments may mention the rule; strip them so only executable text is checked.
    const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(code, forbidden, file);
  }
  // Run text goes through textContent; the SDK text component (markdown links and images) is not used for it.
  const main = await readFile(join(root, 'src', 'extension', 'panel', 'main.ts'), 'utf8');
  assert.doesNotMatch(main.replace(/\/\*[\s\S]*?\*\//g, ''), /mountText/);
  assert.match(main, /textContent/);
});

test('panel entry applies the host theme on every ready snapshot and mounts once', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const main = await readFile(join(root, 'src', 'extension', 'panel', 'main.ts'), 'utf8');
  assert.match(main, /host\.onReady\(context => \{\s*[^]*?applyHostReady\(context, document\.documentElement\);\s*if \(mounted\) return;/);
  for (const component of ['mountList', 'mountSelect', 'mountTabs', 'mountBanner', 'mountEmpty', 'mountProgress', 'mountBadge']) {
    assert.match(main, new RegExp(`\\b${component}\\(`), component);
  }
});
