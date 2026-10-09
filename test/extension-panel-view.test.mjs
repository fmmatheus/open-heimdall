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
  DEFAULT_DETAIL_TAB,
  DETAIL_TABS,
  blockerDisplay,
  budgetText,
  detailNotice,
  shortenedFields,
  taskDisplay,
  currentActionText,
  formatAge,
  formatCount,
  formatLocalTime,
  formatTime,
  friendlyModel,
  lastUpdatedText,
  recordedUsageText,
  summaryInfo,
  summaryModels,
  technicalSections,
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
import { createNavigation } from '../dist/extension/panel/navigation.js';
import { sessionsPresentation, summaryPresentation, taskSessionActions } from '../dist/extension/panel/navigation-view.js';

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

test('no attempt row for finished runs; shown only while preparing or running', () => {
  const none = { planner: choice(null), executor: choice(null), fallback: choice(null), candidates: [], selected: null, current: null };
  for (const status of ['preparing', 'running']) assert.ok(modelRows(none, status).some(row => row.value === 'No attempt recorded'), status);
  for (const status of ['queued', 'paused', 'succeeded', 'failed', 'reconciliation-required']) {
    assert.equal(modelRows(none, status).some(row => row.label === 'Current attempt'), false, status);
  }
  // A recorded attempt is always shown, whatever the status.
  assert.ok(modelRows({ ...none, current: choice('anthropic/sonnet') }, 'succeeded').some(row => row.label === 'Current attempt'));
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
    reasonClipped: false, resolutionClipped: false,
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
  assert.equal(phaseText(run), 'All tasks finished');
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
  assert.deepEqual(detailTabs(detail()).map(tab => [tab.id, tab.count]), [['sessions', undefined], ['tasks', 2], ['review', undefined], ['details', undefined]]);
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

// ----- compact overview and Technical details -----

const FINISHED_AT = Date.parse('2026-03-09T12:00:00Z');
const TOKYO = { locale: 'en-GB', timeZone: 'Asia/Tokyo' };

function succeededRun(overrides = {}) {
  return detail({
    status: 'succeeded', phase: 'succeeded', completed: 5, total: 5, currentTask: null,
    createdAt: Date.parse('2026-03-09T08:15:00Z'), updatedAt: FINISHED_AT,
    models: {
      planner: choice('claude-code/opus', 'high'), executor: choice('claude-code/sonnet'), fallback: choice('anthropic/haiku'),
      candidates: [{ key: 'a', model: 'claude-code/sonnet', variant: null }, { key: 'b', model: 'anthropic/haiku', variant: 'fast' }],
      selected: { ...choice('claude-code/sonnet'), checkedAt: '2026-03-09T11:00:00.123Z' },
      current: null,
    },
    usage: {
      reportedTotal: 1234567, uncachedTotal: 89000,
      sessions: [
        { sessionId: 'ses_planner_1', role: 'planner', reported: 500, uncached: 5 },
        { sessionId: 'ses_task_1', role: 'task', reported: 1000, uncached: 10 },
      ],
    },
    tasks: [{ id: 'T1', title: 'Scaffold', state: 'done', summary: 'did it', handoff: null, evidence: [], sessionId: 'ses_task_1', model: 'claude-code/sonnet', truncated: false }],
    ...overrides,
  });
}

function summaryText(info) {
  return [info.label, info.project, info.badge.label, info.headline, ...info.models, ...info.usage, info.updated, info.blocker?.reason ?? ''].join('\n');
}

test('succeeded run summary: one status label, no model plumbing, no attempt text', () => {
  const info = summaryInfo(succeededRun(), FINISHED_AT + 120_000, TOKYO);
  assert.deepEqual(info.badge, { label: 'Succeeded', tone: 'success' });
  assert.equal(info.headline, '5 of 5 tasks complete; All tasks finished');
  assert.deepEqual(info.models, ['Planner: Opus (configured)', 'Task model: Sonnet (recorded)']);
  assert.deepEqual(info.usage, ['Recorded usage: 1,234,567 reported tokens', 'Budget: 5,000,000 reported tokens']);
  assert.equal(info.updated, 'Updated 2 min ago (9 Mar 2026, 21:00)');
  assert.equal(info.updatedExact, '2026-03-09 12:00 UTC');

  const text = summaryText(info);
  assert.equal(text.match(/Succeeded/g).length, 1, 'status label appears once, in the badge');
  assert.doesNotMatch(text, /Candidate|fallback|No attempt recorded|Current attempt|checked|haiku/i);
  // Each model appears once: the task model is not repeated as an executor or selection row.
  assert.equal(text.match(/Sonnet/g).length, 1);
  assert.equal(text.match(/Opus/g).length, 1);
});

test('action line never repeats the status label', () => {
  const cases = [
    [{ status: 'queued', phase: 'queued', currentTask: null }, 'Queued'],
    [{ status: 'preparing', phase: 'preparing', currentTask: null }, 'Preparing'],
    [{ status: 'running', phase: 'planning', currentTask: null }, 'Planning'],
    [{ status: 'paused', phase: 'paused' }, 'Paused'],
    [{ status: 'failed', phase: 'failed' }, 'Failed'],
    [{ status: 'succeeded', phase: 'succeeded', currentTask: null }, 'Succeeded'],
    [{ status: 'reconciliation-required', phase: 'reconciliation-required' }, 'Needs reconciliation'],
  ];
  for (const [overrides, label] of cases) {
    const run = summary(overrides);
    assert.equal(statusBadge(run).label, label);
    assert.equal(currentActionText(run).toLowerCase().includes(label.toLowerCase()), false, `${label}: ${currentActionText(run)}`);
  }
  assert.equal(currentActionText(summary()), 'T3: Wire the API');
  assert.equal(currentActionText(summary({ status: 'paused', phase: 'paused' })), 'Stopped at T3: Wire the API');
  assert.equal(currentActionText(summary({ phase: 'executing', currentTask: null })), 'No current task recorded');
});

test('summary keeps the recorded blocker reason verbatim, or says none was recorded', () => {
  const paused = succeededRun({
    status: 'paused', phase: 'paused', completed: 2, currentTask: { id: 'T3', title: 'Wire' },
    blocker: { status: 'paused', reason: 'Token budget reached for T3', reasonRecorded: true, resolution: 'Raise maxRunTokens' },
  });
  assert.equal(summaryInfo(paused, NOW).blocker.reason, 'Token budget reached for T3');
  assert.equal(summaryInfo(paused, NOW).blocker.resolution, 'Raise maxRunTokens');
  const silent = succeededRun({ status: 'failed', phase: 'failed', blocker: { status: 'failed', reason: 'x', reasonRecorded: false, resolution: null } });
  assert.equal(summaryInfo(silent, NOW).blocker.reason, 'No reason was recorded');
  assert.equal(summaryInfo(succeededRun(), NOW).blocker, null);
});

test('Technical details keep configured, fallback and candidate models, quota time, commit, branch and sessions', () => {
  const run = succeededRun();
  const sections = technicalSections(run);
  assert.deepEqual(sections.map(entry => entry.title), ['Models', 'Usage', 'Limits', 'Run']);
  const byTitle = Object.fromEntries(sections.map(entry => [entry.title, entry]));

  const models = byTitle.Models.rows;
  const value = label => models.find(row => row.label === label)?.value;
  assert.equal(value('Planner (configured)'), 'claude-code/opus (high)');
  assert.equal(value('Executor (configured)'), 'claude-code/sonnet');
  assert.equal(value('Executor fallback (configured)'), 'anthropic/haiku');
  assert.equal(value('Selected by quota check'), 'claude-code/sonnet · checked 2026-03-09T11:00:00.123Z');
  assert.deepEqual(models.filter(row => row.label === 'Candidate').map(row => row.value), ['claude-code/sonnet', 'anthropic/haiku (fast)']);
  assert.equal(models.some(row => row.label === 'Current attempt'), false, 'no attempt row for a finished run');

  const usage = byTitle.Usage;
  assert.deepEqual(usage.rows.map(row => row.label), ['Reported tokens', 'Uncached', 'Planner session ses_planner_1', 'Task session ses_task_1']);
  assert.equal(usage.rows[0].value, '1,234,567 reported tokens');
  assert.equal(usage.rows[2].value, '500 reported · 5 uncached');
  assert.match(usage.note, /not a live meter/);

  assert.ok(byTitle.Limits.rows.some(row => row.label === 'Timeout'));
  const runRowsByLabel = Object.fromEntries(byTitle.Run.rows.map(row => [row.label, row.value]));
  assert.equal(runRowsByLabel['Run ID'], 'run_1');
  assert.equal(runRowsByLabel['Project ID'], 'proj_a');
  assert.equal(runRowsByLabel['Base commit'], 'a'.repeat(40), 'full commit, not abbreviated');
  assert.equal(runRowsByLabel.Branch, 'heimdall/run/x');
  assert.equal(runRowsByLabel.Created, '2026-03-09 08:15 UTC');
  assert.equal(runRowsByLabel.Updated, '2026-03-09 12:00 UTC');
});

test('Technical details show the missing attempt only while the run is preparing or running', () => {
  const noAttempt = { planner: choice(null), executor: choice(null), fallback: choice(null), candidates: [], selected: null, current: null };
  const text = status => technicalSections(detail({ status, models: noAttempt })).flatMap(entry => entry.rows.map(row => row.value)).join('\n');
  assert.match(text('running'), /No attempt recorded/);
  assert.match(text('preparing'), /No attempt recorded/);
  assert.doesNotMatch(text('succeeded'), /No attempt recorded/);
  assert.doesNotMatch(text('failed'), /No attempt recorded/);
});

test('friendly model labels: provider stripped, families capitalised, unknown shown as recorded', () => {
  assert.equal(friendlyModel('claude-code/opus'), 'Opus');
  assert.equal(friendlyModel('anthropic/Sonnet'), 'Sonnet');
  assert.equal(friendlyModel('haiku'), 'Haiku');
  assert.equal(friendlyModel('openai/gpt-5'), 'gpt-5', 'unknown IDs are stripped, never renamed');
  assert.equal(friendlyModel('anthropic/claude-sonnet-4-5'), 'claude-sonnet-4-5');
  for (const empty of [null, undefined, '', '   ', 'provider/']) assert.equal(friendlyModel(empty), 'Not recorded');
});

test('summary models keep provenance: planner configured; task model recorded, selected, then configured', () => {
  const models = (overrides = {}) => ({
    planner: choice('claude-code/opus'), executor: choice('claude-code/haiku'), fallback: choice(null), candidates: [],
    selected: { ...choice('claude-code/sonnet'), checkedAt: null }, current: choice('claude-code/haiku'), ...overrides,
  });
  const done = (id, model) => ({ id, title: id, state: 'done', summary: null, handoff: null, evidence: [], sessionId: null, model, truncated: false });
  const current = { ...done('T9', 'claude-code/haiku'), state: 'current' };

  // Recorded task result wins; the last done task is used; a current task's in-flight model is not a result.
  let result = summaryModels({ models: models(), tasks: [done('T1', 'claude-code/haiku'), done('T2', 'claude-code/opus'), current] });
  assert.deepEqual(result.task, { label: 'Task model', value: 'Opus', provenance: 'recorded' });
  assert.deepEqual(result.planner, { label: 'Planner', value: 'Opus', provenance: 'configured' });

  result = summaryModels({ models: models(), tasks: [done('T1', null), current] });
  assert.deepEqual(result.task, { label: 'Task model', value: 'Sonnet', provenance: 'selected' });

  result = summaryModels({ models: models({ selected: null }), tasks: [] });
  assert.deepEqual(result.task, { label: 'Task model', value: 'Haiku', provenance: 'configured' });

  // Nothing recorded: reported as such, with no provenance and no invented name.
  result = summaryModels({ models: models({ planner: choice(null), executor: choice(null), selected: null }), tasks: [] });
  assert.deepEqual(result.planner, { label: 'Planner', value: 'Not recorded', provenance: null });
  assert.deepEqual(result.task, { label: 'Task model', value: 'Not recorded', provenance: null });
  assert.deepEqual(summaryInfo(succeededRun({ models: models({ planner: choice(null), executor: choice(null), selected: null }), tasks: [] }), NOW).models, ['Planner: Not recorded', 'Task model: Not recorded']);

  // Unknown IDs show the stripped ID with their provenance.
  result = summaryModels({ models: models({ selected: null, executor: choice('acme/mystery-9') }), tasks: [] });
  assert.deepEqual(result.task, { label: 'Task model', value: 'mystery-9', provenance: 'configured' });
});

test('budget and recorded usage text: unlimited, disabled, limited; no costs or extra precision', () => {
  assert.equal(budgetText(limits({ maxRunTokens: null })), 'Unlimited');
  assert.equal(budgetText(limits({ tokenLimitsDisabled: true, maxRunTokens: 5_000_000 })), 'Unlimited (token limits disabled)');
  assert.equal(budgetText(limits({ maxRunTokens: 5_000_000 })), '5,000,000 reported tokens');
  assert.equal(recordedUsageText({ reportedTotal: 1234567 }), '1,234,567 reported tokens');
  assert.equal(recordedUsageText({ reportedTotal: 0 }), '0 reported tokens');
  assert.equal(recordedUsageText({ reportedTotal: Number.NaN }), 'Not recorded');
  const text = summaryText(summaryInfo(succeededRun(), NOW));
  assert.doesNotMatch(text, /[$€£]|\bcost\b|\bUSD\b|\bprice\b/i);
});

test('local time is deterministic with an injected locale and time zone; UTC stays exact', () => {
  assert.equal(formatLocalTime(FINISHED_AT, TOKYO), '9 Mar 2026, 21:00');
  assert.equal(formatLocalTime(FINISHED_AT, { locale: 'en-GB', timeZone: 'America/Sao_Paulo' }), '9 Mar 2026, 09:00');
  assert.equal(formatLocalTime(FINISHED_AT, { locale: 'en-GB', timeZone: 'UTC' }), '9 Mar 2026, 12:00');
  assert.equal(formatLocalTime(Number.NaN), 'unknown time');
  // An invalid zone falls back to the exact UTC text rather than throwing.
  assert.equal(formatLocalTime(FINISHED_AT, { locale: 'en-GB', timeZone: 'Not/AZone' }), '2026-03-09 12:00 UTC');
  // Without options the viewer's own locale and zone are used (no throw, non-empty, differs from "unknown").
  assert.match(formatLocalTime(FINISHED_AT), /2026/);
  // Exact UTC is unchanged and still reachable in Technical details.
  assert.equal(formatTime(FINISHED_AT), '2026-03-09 12:00 UTC');
  const runRowsByLabel = Object.fromEntries(technicalSections(succeededRun()).find(entry => entry.title === 'Run').rows.map(row => [row.label, row.value]));
  assert.equal(runRowsByLabel.Updated, '2026-03-09 12:00 UTC');
});

test('run list rows add relative and local time when a clock is supplied', () => {
  const run = summary({ updatedAt: FINISHED_AT - 5 * 60_000 });
  assert.equal(runRows([run])[0].subtitle, 'alpha-app · Executing T3: Wire the API', 'unchanged without a clock');
  assert.equal(runRows([run], FINISHED_AT, TOKYO)[0].subtitle, 'alpha-app · Executing T3: Wire the API · 5 min ago (9 Mar 2026, 20:55)');
  assert.doesNotMatch(runRows([run], FINISHED_AT, TOKYO)[0].subtitle, /UTC/);
});

test('detail tabs: sessions, tasks, review, technical details; sessions is the default', () => {
  assert.deepEqual([...DETAIL_TABS], ['sessions', 'tasks', 'review', 'details']);
  assert.equal(DEFAULT_DETAIL_TAB, 'sessions');
  assert.deepEqual(detailTabs(detail()).map(tab => tab.label), ['Sessions', 'Tasks', 'Review', 'Technical details']);
  assert.equal(detailTabs(detail()).find(tab => tab.id === 'tasks').count, 2);
  assert.equal(detailTabs(null).find(tab => tab.id === 'tasks').count, 0);
});

test('panel draws the summary (with a summary-actions slot and hook) before the tabs; only the review tab loads the review', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const main = (await readFile(join(root, 'src', 'extension', 'panel', 'main.ts'), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  const summaryCall = main.indexOf('drawSummary(detail, detailContent);');
  const tabsMount = main.indexOf('mountTabs(tabRoot');
  assert.ok(summaryCall > 0 && tabsMount > summaryCall, 'summary is drawn before the tabs are mounted');
  assert.match(main, /dataset\.slot = 'summary-actions'/);
  assert.match(main, /extensions\.summaryActions\?\.\(detail, slot\)/);
  assert.match(main, /let tab: DetailTabId = DEFAULT_DETAIL_TAB;/);
  assert.match(main, /sessions: drawSessions,[^]*tasks: drawTasks,[^]*review: drawReview,[^]*details: drawTechnical,/);
  const toggles = main.match(/store\.setReviewVisible\([^)]*\)/g) ?? [];
  assert.deepEqual(toggles, ["store.setReviewVisible(tab === 'review')"]);
  // The summary renders exactly one status badge.
  const summaryBody = main.slice(main.indexOf('function drawSummary'), main.indexOf('function drawTechnical'));
  assert.equal((summaryBody.match(/badge\(head/g) ?? []).length, 1);
});

// ----- actionable session navigation -----

const NAV_FORBIDDEN = ['startSession', 'prompt', 'compose', 'attach', 'sessionLink', 'writeFile', 'generate', 'openSurface', 'openUrl'];

function navDetail(overrides = {}) {
  return {
    id: 'run_1', label: 'Add billing', projectId: 'proj_a', projectName: 'alpha-app', status: 'running', phase: 'executing',
    completed: 2, total: 4, currentTask: { id: 'T3', title: 'Wire billing' }, createdAt: 1, updatedAt: 2,
    blocker: null, models: {}, usage: {}, limits: {},
    tasks: [{ id: 'T1', title: 'Schema' }, { id: 'T2', title: 'Service' }, { id: 'T3', title: 'Wire billing' }],
    sessions: { parent: 'ses_parent', current: 'ses_t3', completed: [{ id: 'ses_t1', taskId: 'T1' }, { id: 'ses_t2', taskId: 'T2' }] },
    review: { baseCommit: 'abc', branch: 'b' }, truncated: false,
    ...overrides,
  };
}

/** Recording OpenChamber host and a matcher that knows one directory; forbidden methods throw. */
function navStack({ projects = [{ id: 'oc_1', name: 'alpha', directory: '/work/alpha' }], listed = ['ses_parent', 'ses_t3', 'ses_t1', 'ses_t2'], projectsState = 'ready', failures = {} } = {}) {
  const calls = [];
  const host = {
    async listProjects() { calls.push(['listProjects']); if (failures.listProjects) throw failures.listProjects; return { state: projectsState, projects }; },
    async listSessions(id) { calls.push(['listSessions', id]); if (failures.listSessions) throw failures.listSessions; return { state: 'ready', sessions: listed.map(sid => ({ id: sid })) }; },
    async openSession(id) { calls.push(['openSession', id]); },
    async writeClipboard(text) { calls.push(['writeClipboard', text]); },
  };
  for (const name of NAV_FORBIDDEN) host[name] = () => { calls.push([`FORBIDDEN:${name}`]); throw new Error(name); };
  const matcher = { async matchDirectories(directories) { return directories.map(directory => (directory === '/work/alpha' ? { projectId: 'proj_a' } : {})); } };
  return { calls, navigation: createNavigation({ host, matcher }) };
}

const NAV_PROJECT = { id: 'proj_a', name: 'alpha-app', directory: '/work/alpha' };
const grant = code => Object.assign(new Error('RAW-SECRET'), { code });

test('navigation view: project missing shows one line, Copy and Refresh, a hint and no per-session buttons', async () => {
  const { navigation } = navStack({ projects: [] });
  const view = await navigation.load(navDetail(), NAV_PROJECT);
  const present = sessionsPresentation(view);
  assert.equal(present.state, 'project-not-added');
  assert.equal(present.message, 'Sessions require this project in OpenChamber.');
  assert.equal(present.canCopy, true);
  assert.equal(present.canRefresh, true);
  assert.equal(present.copyText, '/work/alpha');
  assert.equal(present.hint, "Add the copied folder using OpenChamber's project controls.");
  assert.deepEqual([present.primary, present.completed, present.note], [[], [], null]);

  // Without a known folder there is nothing to copy; the hint still tells the user what to do.
  const unknown = sessionsPresentation(await navigation.load(navDetail(), { ...NAV_PROJECT, directory: null }));
  assert.equal(unknown.canCopy, false);
  assert.equal(unknown.copyText, null);
  assert.match(unknown.hint, /project controls/);
  assert.deepEqual(summaryPresentation(view), { actions: [], hint: 'Sessions require this project in OpenChamber.' });
});

test('navigation view: pending, permission, other failure and not-discovered states have distinct fixed texts', async () => {
  const pending = sessionsPresentation(await navStack({ projects: [], projectsState: 'loading' }).navigation.load(navDetail(), NAV_PROJECT));
  assert.equal(pending.state, 'discovering');
  assert.match(pending.message, /still loading sessions/);

  const denied = sessionsPresentation(await navStack({ failures: { listProjects: grant('NOT_GRANTED') } }).navigation.load(navDetail(), NAV_PROJECT));
  assert.equal(denied.state, 'permission-denied');
  assert.equal(denied.message, 'Allow Heimdall to read sessions in Settings → Extensions, then Refresh sessions.');

  const deniedSessions = sessionsPresentation(await navStack({ failures: { listSessions: grant('NOT_GRANTED') } }).navigation.load(navDetail(), NAV_PROJECT));
  assert.equal(deniedSessions.state, 'permission-denied');

  const timeout = sessionsPresentation(await navStack({ failures: { listProjects: grant('HOST_TIMEOUT') } }).navigation.load(navDetail(), NAV_PROJECT));
  const other = sessionsPresentation(await navStack({ failures: { listSessions: grant('BOOM') } }).navigation.load(navDetail(), NAV_PROJECT));
  assert.equal(timeout.state, 'unavailable');
  assert.match(timeout.message, /did not answer in time/);
  assert.equal(other.state, 'unavailable');
  assert.match(other.message, /could not list sessions/);

  const missing = sessionsPresentation(await navStack({ listed: ['ses_parent'] }).navigation.load(navDetail(), NAV_PROJECT));
  assert.equal(missing.state, 'listed');
  assert.equal(missing.note, '3 of 4 recorded sessions are not listed by OpenChamber yet.');
  assert.equal(missing.canRefresh, true);

  const texts = [pending.message, denied.message, timeout.message, other.message, missing.note, sessionsPresentation(null).message];
  assert.equal(new Set(texts).size, texts.length, 'every state says something different');
  for (const present of [pending, denied, deniedSessions, timeout, other]) {
    assert.equal(present.canRefresh, true);
    assert.deepEqual([present.primary, present.completed, present.canCopy, present.copyText], [[], [], false, null]);
  }
  assert.deepEqual(sessionsPresentation(null).message, 'Checking which sessions OpenChamber has loaded…');
});

test('navigation view: no state ever describes a disabled per-session button', async () => {
  const stacks = [
    navStack({ projects: [] }), navStack({ projects: [], projectsState: 'loading' }), navStack({ projects: [], projectsState: 'error' }),
    navStack({ failures: { listProjects: grant('NOT_GRANTED') } }), navStack({ failures: { listSessions: grant('X') } }), navStack({ listed: [] }), navStack({ listed: ['ses_t1'] }), navStack(),
  ];
  for (const { navigation } of stacks) {
    const view = await navigation.load(navDetail(), NAV_PROJECT);
    const present = sessionsPresentation(view);
    const summary = summaryPresentation(view);
    const everyAction = [...present.primary, ...present.completed, ...summary.actions, ...taskSessionActions(view).values()];
    const enabledKeys = new Set(view.targets.filter(entry => entry.enabled && entry.state === 'found').map(entry => entry.target.key));
    for (const entry of everyAction) assert.ok(enabledKeys.has(entry.key), `${view.state}: ${entry.key} is an enabled, found target`);
    assert.equal(JSON.stringify([present, summary]).includes('disabled'), false, view.state);
    if (view.state !== 'listed') assert.deepEqual(everyAction, [], view.state);
  }
});

test('navigation view: listed sessions offer only found actions that open the recorded ids', async () => {
  const { navigation, calls } = navStack();
  const view = await navigation.load(navDetail(), NAV_PROJECT);
  const present = sessionsPresentation(view);
  assert.deepEqual(present.primary.map(action => [action.key, action.text]), [['parent', 'Open parent'], ['current', 'Open current task T3']]);
  assert.deepEqual(present.completed.map(action => [action.key, action.text]), [['completed:ses_t1', 'Open T1: Schema'], ['completed:ses_t2', 'Open T2: Service']]);
  assert.equal(present.note, null);
  assert.equal(present.canRefresh, false);
  assert.equal(summaryPresentation(view).actions.length, 2);

  for (const action of [...present.primary, ...present.completed]) assert.equal((await navigation.open(view, action.key)).ok, true);
  assert.deepEqual(calls.filter(entry => entry[0] === 'openSession').map(entry => entry[1]), ['ses_parent', 'ses_t3', 'ses_t1', 'ses_t2']);

  // A planner is offered only while planning, from the current child.
  const planning = navDetail({ phase: 'planning', currentTask: null, sessions: { parent: 'ses_parent', current: 'ses_plan', completed: [] } });
  const planView = await navStack({ listed: ['ses_parent', 'ses_plan'] }).navigation.load(planning, NAV_PROJECT);
  assert.deepEqual(summaryPresentation(planView).actions.map(action => action.text), ['Open parent', 'Open planner']);
  const paused = await navStack({ listed: ['ses_parent', 'ses_plan'] }).navigation.load({ ...planning, phase: 'paused' }, NAV_PROJECT);
  assert.deepEqual(summaryPresentation(paused).actions.map(action => action.text), ['Open parent']);
});

test('navigation view: partly listed sessions give grouped note, found actions only; unlisted primary gets a hint', async () => {
  const partial = await navStack({ listed: ['ses_t3', 'ses_t1'] }).navigation.load(navDetail(), NAV_PROJECT);
  const present = sessionsPresentation(partial);
  assert.deepEqual(present.primary.map(action => action.key), ['current']);
  assert.deepEqual(present.completed.map(action => action.key), ['completed:ses_t1']);
  assert.equal(present.note, '2 of 4 recorded sessions are not listed by OpenChamber yet.');
  assert.deepEqual([...taskSessionActions(partial).keys()].sort(), ['T1', 'T3']);

  const none = await navStack({ listed: [] }).navigation.load(navDetail(), NAV_PROJECT);
  assert.deepEqual(summaryPresentation(none), { actions: [], hint: "The run's sessions are not listed by OpenChamber yet." });
  assert.equal(sessionsPresentation(none).note, '4 of 4 recorded sessions are not listed by OpenChamber yet.');
  const one = await navStack({ listed: [] }).navigation.load(navDetail({ sessions: { parent: 'ses_parent', current: null, completed: [] } }), NAV_PROJECT);
  assert.equal(sessionsPresentation(one).note, '1 of 1 recorded session is not listed by OpenChamber yet.');
});

test('navigation view: task rows get an Open session action keyed by task id; the current task wins', async () => {
  const view = await navStack().navigation.load(navDetail(), NAV_PROJECT);
  const actions = taskSessionActions(view);
  assert.deepEqual([...actions.entries()].map(([id, action]) => [id, action.key, action.text, action.ariaLabel]), [
    ['T3', 'current', 'Open session', 'Open session for task T3'],
    ['T1', 'completed:ses_t1', 'Open session', 'Open session for task T1'],
    ['T2', 'completed:ses_t2', 'Open session', 'Open session for task T2'],
  ]);
  // A retried current task keeps pointing at the live session, not at an earlier completed attempt.
  const retried = navDetail({ sessions: { parent: null, current: 'ses_new', completed: [{ id: 'ses_old', taskId: 'T3' }] } });
  const retriedActions = taskSessionActions(await navStack({ listed: ['ses_new', 'ses_old'] }).navigation.load(retried, NAV_PROJECT));
  assert.equal(retriedActions.get('T3').key, 'current');
  assert.equal(taskSessionActions(null).size, 0);
});

test('navigation: Copy project folder through the same stack calls writeClipboard once; Refresh only lists', async () => {
  const { navigation, calls } = navStack({ projects: [] });
  const view = await navigation.load(navDetail(), NAV_PROJECT);
  assert.deepEqual((await navigation.copyProjectFolder(view.copyText)), { ok: true, message: 'Copied project folder' });
  assert.deepEqual(calls.filter(entry => entry[0] === 'writeClipboard'), [['writeClipboard', '/work/alpha']]);
  calls.length = 0;
  await navigation.load(navDetail(), NAV_PROJECT);
  assert.deepEqual(calls.map(entry => entry[0]), ['listProjects']);
  assert.deepEqual(calls.filter(entry => entry[0].startsWith('FORBIDDEN')), []);
});

test('panel wiring: one shared navigation load feeds summary actions, the sessions list and task rows with role=status feedback', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const stripped = text => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const main = stripped(await readFile(join(root, 'src', 'extension', 'panel', 'main.ts'), 'utf8'));

  // The listing is started from one place and shared; the tabs only read the shared result.
  assert.equal((main.match(/navigation\.load\(/g) ?? []).length, 1);
  assert.match(main, /ensureNavigation\(detail\);\s*drawSummary\(detail, detailContent\);/);
  assert.match(main, /extensions\.summaryActions = drawSummaryActions;/);
  assert.match(main, /summaryPresentation\(navView\)/);
  assert.match(main, /sessionsPresentation\(navView\)/);
  assert.match(main, /taskSessionActions\(navView\)/);
  // Found actions sit in the summary slot; a hint links to the Sessions tab only when nothing can be opened.
  assert.match(main, /openSession\('summary', entry\.key\)/);
  assert.match(main, /'See Sessions tab'/);
  // Completed sessions are an expandable list; each task row gets its own Open session slot.
  assert.match(main, /node\('details', 'hm-completed'\)/);
  assert.match(main, /Completed task sessions \(/);
  assert.match(main, /openSession\('sessions', entry\.key\)/);
  assert.match(main, /openSession\('tasks', entry\.key\)/);
  assert.match(main, /sessionSlots\.set\(task\.id, sessionSlot\)/);
  // Feedback is a role=status live region; stale listings and actions are discarded.
  assert.match(main, /const target = node\('p', 'hm-meta hm-status'[^\n]*\);\s*target\.setAttribute\('role', 'status'\)/);
  assert.match(main, /if \(gen !== loadGen\) return;/);
  assert.match(main, /if \(epoch === navEpoch\)/);
  // (The diff view legitimately uses role=alert; scope the check to the session navigation code.)
  const navCode = main.slice(0, main.indexOf('function drawDiff'));
  assert.doesNotMatch(navCode, /role', 'alert'/);
  // No disabled per-session buttons are drawn.
  const nav = main.slice(main.indexOf('function drawSessions'), main.indexOf('function drawTasks'));
  assert.doesNotMatch(nav, /disabled/);
  assert.match(main, /Copy project folder/);
  assert.match(main, /Refresh sessions/);

  // Only these host methods are ever used by the panel entry or navigation: none of the forbidden ones.
  const hostCalls = [...main.matchAll(/\bhost\.(\w+)\(/g)].map(entry => entry[1]);
  for (const name of NAV_FORBIDDEN) {
    assert.equal(hostCalls.includes(name), false, name);
    assert.equal(new RegExp(`\\b${name}\\b`).test(main), false, name);
  }
});

/* ---------- on-demand task and blocker text ---------- */

const NO_CLIPS = { title: false, summary: false, handoff: false, model: false, evidenceCount: false, evidenceText: false };
const LIMITS_USED = { title: 2000, model: 1000, text: 32000, gate: 2000, detail: 8000, evidence: 200 };
const clippedTask = (clipped, extra = {}) => ({
  index: 0, id: 'T1', title: 'Scaffold', state: 'done', summary: 'start of the summary…', handoff: null,
  evidence: [{ gateId: 'G1', gate: 'npm test', passed: true, detail: 'ok…' }], sessionId: null, model: null, truncated: true,
  clipped: { ...NO_CLIPS, ...clipped }, ...extra,
});
const loadedTask = (extra = {}) => ({
  runId: 'run_1', index: 0, taskId: 'T1', title: 'Scaffold', state: 'done', summary: 'start of the summary and the rest TAIL-MARKER', handoff: null, model: null,
  evidence: [{ gateId: 'G1', gate: 'npm test', passed: true, detail: 'ok and all of it' }], evidenceTotal: 1, clipped: NO_CLIPS, complete: true,
  limits: LIMITS_USED, fetchedAt: 'x', ...extra,
});
const entryOf = data => ({ loading: false, data, error: null });
const rowOf = clipped => taskRows([clippedTask(clipped)])[0];

test('only shortened fields get a toggle, and rows carry the plan position', () => {
  assert.deepEqual(shortenedFields(NO_CLIPS), []);
  assert.deepEqual(shortenedFields({ ...NO_CLIPS, summary: true, evidenceText: true, evidenceCount: true }), ['summary', 'evidence']);
  const row = rowOf({ summary: true });
  assert.equal(row.index, 0);
  assert.deepEqual(row.shortened, ['summary']);
  const display = taskDisplay(row, undefined, new Set());
  assert.equal(display.summary.toggle.label, 'Show full summary');
  assert.equal(display.summary.toggle.expanded, false);
  assert.equal(display.summary.text, 'start of the summary…');
  assert.match(display.summary.note, /summary is shortened/);
  assert.equal(display.handoff.toggle, null);
  assert.equal(display.title.toggle, null);
  assert.equal(display.evidence.toggle, null);
  assert.equal(display.status, null);
  // Older answers without index or clip flags still render.
  const legacy = taskRows([{ id: 'T9', title: 'x', state: 'pending', summary: null, handoff: null, evidence: [], sessionId: null, model: null, truncated: false }])[0];
  assert.deepEqual([legacy.index, legacy.shortened], [0, []]);
});

test('toggling reveals the loaded text with its tail and hides it again', () => {
  const row = rowOf({ summary: true });
  const loading = taskDisplay(row, { loading: true, data: null, error: null }, new Set(['summary']));
  assert.equal(loading.summary.text, 'start of the summary…', 'nothing is revealed before the text arrives');
  assert.deepEqual(loading.status, { kind: 'loading', text: 'Loading the full text…', refresh: false });

  const shown = taskDisplay(row, entryOf(loadedTask()), new Set(['summary']));
  assert.ok(shown.summary.text.endsWith('TAIL-MARKER'));
  assert.deepEqual(shown.summary.toggle, { label: 'Hide full summary', expanded: true });
  assert.equal(shown.summary.note, null, 'complete text needs no note');
  assert.equal(shown.status, null);

  const hidden = taskDisplay(row, entryOf(loadedTask()), new Set());
  assert.equal(hidden.summary.text, 'start of the summary…');
  assert.equal(hidden.summary.toggle.label, 'Show full summary');
});

test('incomplete content states the limit instead of pretending to be whole', () => {
  const row = rowOf({ summary: true });
  const partial = loadedTask({ summary: 'x'.repeat(31999) + '…', clipped: { ...NO_CLIPS, summary: true }, complete: false });
  const shown = taskDisplay(row, entryOf(partial), new Set(['summary']));
  assert.match(shown.summary.note, /Showing the first 31,999 characters; the rest exceeds what the panel can load\./);

  const evidenceRow = rowOf({ evidenceCount: true });
  const manyEvidence = taskDisplay(evidenceRow, entryOf(loadedTask({ evidenceTotal: 500, clipped: { ...NO_CLIPS, evidenceCount: true }, complete: false })), new Set(['evidence']));
  assert.match(manyEvidence.evidence.note, /Showing 1 of 500 evidence items/);
  assert.equal(manyEvidence.evidence.toggle.label, 'Hide full evidence');
  const revealed = taskDisplay(evidenceRow, entryOf(loadedTask()), new Set(['evidence']));
  assert.equal(revealed.evidence.rows[0].detail, 'ok and all of it');
  assert.equal(taskDisplay(evidenceRow, undefined, new Set()).evidence.rows[0].detail, 'ok…');
});

test('a task whose identity changed is reported and offers a refresh instead of showing other text', () => {
  const row = rowOf({ summary: true });
  const moved = taskDisplay(row, entryOf(loadedTask({ taskId: 'T7', summary: 'SOMEONE ELSE' })), new Set(['summary']));
  assert.equal(moved.summary.text, 'start of the summary…');
  assert.equal(moved.status.kind, 'changed');
  assert.equal(moved.status.refresh, true);
  assert.match(moved.status.text, /task list changed/);
  assert.ok(!JSON.stringify(moved).includes('SOMEONE ELSE'));

  const failed = taskDisplay(row, { loading: false, data: null, error: 'Heimdall could not load the full text.' }, new Set(['summary']));
  assert.deepEqual(failed.status, { kind: 'error', text: 'Heimdall could not load the full text.', refresh: false });
});

test('blocker text can be expanded the same way', () => {
  const info = blockerInfo({ status: 'paused', reason: 'cut…', reasonRecorded: true, resolution: 'Resume…', reasonClipped: true, resolutionClipped: true });
  assert.deepEqual([info.reasonClipped, info.resolutionClipped], [true, true]);
  const before = blockerDisplay(info, null, new Set());
  assert.equal(before.reason.text, 'cut…');
  assert.equal(before.reason.toggle.label, 'Show full reason');
  assert.equal(before.resolution.toggle.label, 'Show full resolution');
  const content = { runId: 'run_1', status: 'paused', reason: 'cut and the REASON-TAIL', reasonRecorded: true, resolution: 'Resume and the RESOLUTION-TAIL', clipped: { reason: false, resolution: true }, complete: false, limit: 32000, fetchedAt: 'x' };
  const after = blockerDisplay(info, entryOf(content), new Set(['reason', 'resolution']));
  assert.ok(after.reason.text.endsWith('REASON-TAIL'));
  assert.equal(after.reason.note, null);
  assert.match(after.resolution.note, /Showing the first 31,999 characters/);
  assert.equal(after.reason.toggle.label, 'Hide full reason');

  const plain = blockerDisplay(blockerInfo({ status: 'paused', reason: 'short', reasonRecorded: true, resolution: null, reasonClipped: false, resolutionClipped: false }), null, new Set());
  assert.equal(plain.reason.toggle, null);
  assert.equal(plain.resolution.toggle, null);
});

test('the shortened-text notice names what was cut and how to see it, never a saved state', () => {
  assert.equal(detailNotice(detail()), null);
  const tasksClipped = detail({ tasks: [clippedTask({ summary: true }), clippedTask({ handoff: true }, { index: 1, id: 'T2' })], truncated: true });
  const notice = detailNotice(tasksClipped);
  assert.match(notice, /Text was shortened in 2 tasks\./);
  assert.match(notice, /expand a task and choose Show full/);

  const blocker = detailNotice(detail({ blocker: { status: 'paused', reason: 'x', reasonRecorded: true, resolution: null, reasonClipped: true, resolutionClipped: false }, truncated: true }));
  assert.match(blocker, /blocker text was shortened/);

  const capped = detailNotice(detail({
    capped: { tasks: true, sessions: false, candidates: true, usageSessions: true }, total: 150, truncated: true,
  }));
  assert.match(capped, /Only the first 2 tasks are listed\. The plan has 150\./);
  assert.match(capped, /model candidates/);
  assert.match(capped, /usage totals still count all of them/);

  assert.match(detailNotice(detail({ truncated: true })), /long values/);
  for (const text of [notice, blocker, capped]) assert.doesNotMatch(text, /saved run state/i);
});

test('the panel sources write run text safely and never mention a saved run state', async () => {
  const dir = fileURLToPath(new URL('../src/extension/panel/', import.meta.url));
  const main = await readFile(join(dir, 'main.ts'), 'utf8');
  const model = await readFile(join(dir, 'view-model.ts'), 'utf8');
  assert.doesNotMatch(main + model, /saved run state/i);
  assert.match(main, /aria-expanded/);
  assert.match(main, /aria-controls/);
  assert.doesNotMatch(main, /innerHTML|insertAdjacentHTML/);
});
