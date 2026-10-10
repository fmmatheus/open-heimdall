import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { CoordinatorAdapterError } from '../dist/extension/service/coordinator.js';
import { createExtensionServer, listenExtensionServer } from '../dist/extension/service/server.js';
import { blockerContent, detailRun, phaseOf, runLabel, summarizeRun, taskContent } from '../dist/extension/service/projection.js';
import { createChangeTracker } from '../dist/extension/service/events.js';
import { summaryInfo } from '../dist/extension/panel/view-model.js';

const SERVICE_TOKEN = 'svc-' + 'c3d4e5f6'.repeat(8);
const OWNER_TOKEN = 'OWNER-TOKEN-SECRET';
const PROMPT_MESSAGE = 'PROMPT-MESSAGE-SECRET';
const WORKTREE = '/state/worktrees/proj_a/run_secret/checkout';
const BODY_MARKER = 'FEATURE-BODY-MARKER';
const BRIEF_MARKER = 'TASK-BRIEF-MARKER';
const FORBIDDEN = [OWNER_TOKEN, PROMPT_MESSAGE, WORKTREE, BODY_MARKER, BRIEF_MARKER, 'worktreePath', 'ownerToken', 'promptMessageId', 'brief'];

const project = { id: 'proj_a', directory: '/work/alpha-app', commonGitDirectory: '/work/alpha-app/.git', configPath: '/work/alpha-app/.heimdall.toml', concurrency: 1, createdAt: 1000 };
const otherProject = { id: 'proj_b', directory: '/work/beta', commonGitDirectory: '/work/beta/.git', configPath: '/work/beta/.heimdall.toml', concurrency: 2, createdAt: 2000 };

const settings = {
  plannerAgent: 'adr-planner', executorAgent: 'adr-executor', plannerModel: 'anthropic/planner', plannerVariant: 'high', maxTasks: 8,
  timeoutMinutes: 45, tokenLimitsDisabled: false, maxSessionTokens: 100000, maxRunTokens: 500000, maxPlannerTokens: 50000,
  maxSessionUncachedTokens: 40000, maxRunUncachedTokens: 200000, maxPlannerUncachedTokens: 20000,
  executorModel: 'openai/exec', executorFallbackModel: 'anthropic/fallback', minQuotaRemainingPercent: 10,
  executorCandidates: [
    { key: 'a', quotaProvider: 'openai', model: 'openai/exec', variant: 'high' },
    { key: 'b', quotaProvider: 'anthropic', model: 'anthropic/fallback' },
  ],
};

const tasks = count => Array.from({ length: count }, (_, index) => ({ id: `T${index + 1}`, title: `Task number ${index + 1}`, brief: `${BRIEF_MARKER} ${index + 1}`, dependsOn: [], dod: [`gate ${index + 1}`] }));
const result = (index, extra = {}) => ({
  status: 'completed', taskId: `T${index}`, summary: `Done ${index}`, handoff: `Handoff ${index}`, sessionId: `child-${index}`, model: 'openai/exec',
  evidence: [{ gateId: `G${index}`, gate: `gate ${index}`, passed: true, detail: `proved ${index}` }], ...extra,
});

function makeRun(overrides = {}) {
  return {
    id: 'run_1', projectId: 'proj_a', feature: `# Add dark mode\n\n${BODY_MARKER} details follow.\n`, baseCommit: 'abc1234', worktreePath: WORKTREE,
    branch: 'heimdall/run/run_1', status: 'queued', capacityReserved: false, ownerToken: OWNER_TOKEN, version: 1, parentSessionId: 'ses_parent',
    promptMessageId: PROMPT_MESSAGE, launchAction: 'start', resolution: null, checkpoint: null, resumeBinding: null, launchIntent: false,
    reason: null, createdAt: Date.UTC(2026, 0, 5), updatedAt: Date.UTC(2026, 0, 6), settings, ...overrides,
  };
}

function checkpoint(overrides = {}) {
  return {
    id: 'run_1', status: 'running', adr: 'feature.md', parent: 'ses_parent', caller: { sessionID: 'ses_parent' }, branch: 'heimdall/run/run_1', baseline: 'abc1234',
    index: 0, tasks: [], results: [], phase: 'planner', child: null, settings, ...overrides,
  };
}

const fixtures = {
  queued: () => makeRun(),
  preparing: () => makeRun({ status: 'preparing', capacityReserved: true }),
  planning: () => makeRun({ status: 'running', checkpoint: checkpoint({ child: 'planner-1', usage: { 'planner-1': 700 }, uncachedUsage: { 'planner-1': 70 } }) }),
  planningNoCheckpoint: () => makeRun({ status: 'running' }),
  executing: () => makeRun({
    status: 'running',
    checkpoint: checkpoint({
      phase: 'executor', index: 2, tasks: tasks(5), results: [result(1), result(2)], child: 'child-3',
      attempt: { id: 'att', phase: 'executor', index: 2, child: 'child-3', status: 'admitted', startedAt: 1, model: 'openai/exec', variant: 'high' },
      selection: { model: 'openai/exec', variant: 'high', checkedAt: '2026-01-06T00:00:00.000Z', a: { score: 1 } },
      usage: { 'child-1': 100, 'child-2': 200, 'child-3': 50, 'planner-1': 1000 }, uncachedUsage: { 'child-1': 10, 'child-2': 20, 'child-3': 5, 'planner-1': 100 },
    }),
  }),
  paused: () => makeRun({
    status: 'paused', reason: 'Executor quota is below the minimum', resolution: 'Resume after the quota window resets',
    checkpoint: checkpoint({ status: 'paused', phase: 'executor', index: 1, tasks: tasks(3), results: [result(1)] }),
  }),
  failed: () => makeRun({ status: 'failed', checkpoint: checkpoint({ status: 'paused', phase: 'executor', index: 0, tasks: tasks(2), reason: 'Task T1 reported blocked' }) }),
  failedNoReason: () => makeRun({ status: 'failed' }),
  reconciliation: () => makeRun({ status: 'reconciliation-required', reason: 'Coordinator restarted; inspect this retained run before releasing capacity', checkpoint: checkpoint({ phase: 'executor', index: 1, tasks: tasks(2), results: [result(1)] }) }),
  succeeded: () => makeRun({
    status: 'succeeded',
    checkpoint: checkpoint({ status: 'completed', phase: 'executor', index: 3, tasks: tasks(3), results: [result(1), result(2), result(3)], usage: { 'child-1': 1, 'child-2': 2, 'child-3': 3 } }),
  }),
};

test('summaries cover every run status without throwing', () => {
  const rows = Object.fromEntries(Object.entries(fixtures).map(([name, build]) => [name, summarizeRun(build(), project)]));
  assert.equal(rows.queued.status, 'queued');
  assert.equal(rows.queued.phase, 'queued');
  assert.equal(rows.queued.total, null);
  assert.equal(rows.queued.completed, 0);
  assert.equal(rows.queued.currentTask, null);
  assert.equal(rows.queued.projectName, 'alpha-app');
  assert.equal(rows.queued.projectId, 'proj_a');
  assert.equal(rows.preparing.phase, 'preparing');
  assert.equal(rows.planning.phase, 'planning');
  assert.equal(rows.planning.total, null);
  assert.equal(rows.planningNoCheckpoint.phase, 'planning');
  assert.equal(rows.executing.phase, 'executing');
  assert.equal(rows.executing.status, 'running');
  assert.equal(rows.executing.completed, 2);
  assert.equal(rows.executing.total, 5);
  assert.deepEqual(rows.executing.currentTask, { id: 'T3', title: 'Task number 3' });
  assert.equal(rows.paused.phase, 'paused');
  assert.equal(rows.paused.completed, 1);
  assert.equal(rows.paused.total, 3);
  assert.equal(rows.failed.phase, 'failed');
  assert.equal(rows.reconciliation.phase, 'reconciliation-required');
  assert.equal(rows.succeeded.phase, 'succeeded');
  assert.equal(rows.succeeded.completed, 3);
  assert.equal(rows.succeeded.total, 3);
  assert.equal(rows.succeeded.currentTask, null, 'a finished run has no current task');
  assert.equal(rows.executing.createdAt, Date.UTC(2026, 0, 5));
  assert.equal(rows.executing.updatedAt, Date.UTC(2026, 0, 6));
  for (const row of Object.values(rows)) assert.ok(row.label.length > 0);
});

test('phase comes from the recorded status, not from session activity', () => {
  // A running run whose checkpoint is in the planner phase, or which has no tasks yet, is planning.
  assert.equal(phaseOf(makeRun({ status: 'running', checkpoint: checkpoint({ phase: 'executor', tasks: [] }) })), 'planning');
  assert.equal(phaseOf(makeRun({ status: 'running', checkpoint: checkpoint({ phase: 'planner', tasks: tasks(2) }) })), 'planning');
  // Finished executor work does not make a paused or failed run successful.
  const done = checkpoint({ status: 'completed', phase: 'executor', index: 2, tasks: tasks(2), results: [result(1), result(2)] });
  assert.equal(phaseOf(makeRun({ status: 'paused', checkpoint: done })), 'paused');
  assert.equal(phaseOf(makeRun({ status: 'reconciliation-required', checkpoint: done })), 'reconciliation-required');
  assert.equal(summarizeRun(makeRun({ status: 'failed', checkpoint: done }), project).status, 'failed');
});

test('run labels come from the feature heading or first line with a non-UUID fallback', () => {
  assert.equal(runLabel('# Add dark mode\n\nBody text', project), 'Add dark mode');
  assert.equal(runLabel('Intro paragraph here\n\n## Real Heading ##\n', project), 'Real Heading', 'a heading wins over an earlier paragraph');
  assert.equal(runLabel('\n\n   Plain   first\tline   with   gaps  \nsecond line', project), 'Plain first line with gaps');
  assert.equal(runLabel('```\n# not a heading\n```\n\n# Real one', project), 'Real one', 'fenced code is skipped');
  assert.equal(runLabel('x'.repeat(500), project).length, 120);
  assert.ok(runLabel('y'.repeat(500), project).endsWith('…'));
  assert.equal(runLabel('# Emoji \u{1F600}'.padEnd(300, '\u{1F600}'), project).length <= 120, true);
  assert.equal(runLabel('Bad‮\u0000text\u0007', project), 'Bad text');

  const uuid = '5907b2db-f21a-429b-bcf4-47b7ae27b472';
  for (const feature of ['', '   \n\n  ', undefined, null, 42, uuid, `# ${uuid}`]) {
    const label = runLabel(feature, project, Date.UTC(2026, 2, 9));
    assert.equal(label, 'alpha-app run 2026-03-09', `fallback for ${JSON.stringify(feature)}`);
    assert.doesNotMatch(label, /[0-9a-f]{8}-[0-9a-f]{4}/i);
  }
  assert.equal(runLabel('', undefined, Date.UTC(2026, 2, 9)), 'project run 2026-03-09');
  assert.equal(summarizeRun(makeRun({ feature: '' }), project).label, 'alpha-app run 2026-01-05');
  assert.equal(summarizeRun(makeRun({ id: uuid, feature: uuid }), project).label, 'alpha-app run 2026-01-05');
});

test('detail projections report status, progress, models, usage, limits and tasks', () => {
  const detail = detailRun(fixtures.executing(), project);
  assert.equal(detail.status, 'running');
  assert.equal(detail.phase, 'executing');
  assert.equal(detail.completed, 2);
  assert.equal(detail.total, 5);
  assert.deepEqual(detail.currentTask, { id: 'T3', title: 'Task number 3' });
  assert.equal(detail.blocker, null);
  assert.deepEqual(detail.review, { baseCommit: 'abc1234', branch: 'heimdall/run/run_1' });

  assert.deepEqual(detail.models.planner, { model: 'anthropic/planner', variant: 'high' });
  assert.deepEqual(detail.models.executor, { model: 'openai/exec', variant: null });
  assert.deepEqual(detail.models.fallback, { model: 'anthropic/fallback', variant: null });
  assert.deepEqual(detail.models.candidates, [{ key: 'a', model: 'openai/exec', variant: 'high' }, { key: 'b', model: 'anthropic/fallback', variant: null }]);
  assert.deepEqual(detail.models.selected, { model: 'openai/exec', variant: 'high', checkedAt: '2026-01-06T00:00:00.000Z' });
  assert.deepEqual(detail.models.current, { model: 'openai/exec', variant: 'high' });
  assert.doesNotMatch(JSON.stringify(detail.models), /score/, 'candidate quota scores are not relayed');

  assert.equal(detail.usage.reportedTotal, 1350);
  assert.equal(detail.usage.uncachedTotal, 135);
  const roles = Object.fromEntries(detail.usage.sessions.map(item => [item.sessionId, item.role]));
  assert.deepEqual(roles, { 'child-1': 'task', 'child-2': 'task', 'child-3': 'task', 'planner-1': 'unknown' });
  assert.deepEqual(detail.usage.sessions.find(item => item.sessionId === 'child-2'), { sessionId: 'child-2', role: 'task', reported: 200, uncached: 20 });

  assert.deepEqual(detail.limits, {
    tokenLimitsDisabled: false, maxSessionTokens: 100000, maxRunTokens: 500000, maxPlannerTokens: 50000,
    maxSessionUncachedTokens: 40000, maxRunUncachedTokens: 200000, maxPlannerUncachedTokens: 20000,
    timeout: { minutes: 45, enforcement: 'warning-only' },
  });

  assert.deepEqual(detail.tasks.map(task => [task.id, task.state]), [['T1', 'done'], ['T2', 'done'], ['T3', 'current'], ['T4', 'pending'], ['T5', 'pending']]);
  assert.equal(detail.tasks[0].summary, 'Done 1');
  assert.equal(detail.tasks[0].handoff, 'Handoff 1');
  assert.deepEqual(detail.tasks[0].evidence, [{ gateId: 'G1', gate: 'gate 1', passed: true, detail: 'proved 1' }]);
  assert.equal(detail.tasks[0].sessionId, 'child-1');
  assert.equal(detail.tasks[2].sessionId, 'child-3');
  assert.equal(detail.tasks[2].model, 'openai/exec');
  assert.equal(detail.tasks[2].summary, null);
  assert.equal(detail.tasks[3].sessionId, null);
  assert.deepEqual(detail.sessions, { parent: 'ses_parent', current: 'child-3', completed: [{ id: 'child-1', taskId: 'T1' }, { id: 'child-2', taskId: 'T2' }] });
  assert.equal(detail.truncated, false);

  const disabled = detailRun(makeRun({ status: 'running', settings: { ...settings, tokenLimitsDisabled: true, timeoutMinutes: null, maxRunTokens: null } }), project);
  assert.equal(disabled.limits.tokenLimitsDisabled, true);
  assert.equal(disabled.limits.maxRunTokens, null);
  assert.deepEqual(disabled.limits.timeout, { minutes: null, enforcement: 'warning-only' });
});

test('queued, preparing and planning runs project without a checkpoint or task list', () => {
  for (const name of ['queued', 'preparing', 'planningNoCheckpoint']) {
    const detail = detailRun(fixtures[name](), project);
    assert.deepEqual(detail.tasks, [], name);
    assert.equal(detail.total, null, name);
    assert.equal(detail.blocker, null, name);
    assert.deepEqual(detail.usage, { reportedTotal: 0, uncachedTotal: 0, sessions: [] }, name);
    assert.equal(detail.models.selected, null, name);
    assert.equal(detail.models.current, null, name);
    assert.equal(detail.sessions.current, null, name);
  }
  const planning = detailRun(fixtures.planning(), project);
  assert.equal(planning.phase, 'planning');
  assert.deepEqual(planning.tasks, []);
  assert.deepEqual(planning.usage.sessions, [{ sessionId: 'planner-1', role: 'planner', reported: 700, uncached: 70 }]);
  assert.equal(planning.sessions.current, 'planner-1');
});

test('blockers use only recorded reasons and say so when none was recorded', () => {
  const paused = detailRun(fixtures.paused(), project);
  assert.deepEqual(paused.blocker, { status: 'paused', reason: 'Executor quota is below the minimum', reasonRecorded: true, resolution: 'Resume after the quota window resets', reasonClipped: false, resolutionClipped: false });
  assert.equal(paused.currentTask.id, 'T2');
  assert.equal(paused.tasks[1].state, 'current');

  const failed = detailRun(fixtures.failed(), project);
  assert.equal(failed.blocker.status, 'failed');
  assert.equal(failed.blocker.reason, 'Task T1 reported blocked', 'checkpoint.reason is used when the run has none');
  assert.equal(failed.blocker.reasonRecorded, true);

  const none = detailRun(fixtures.failedNoReason(), project);
  assert.equal(none.blocker.reasonRecorded, false);
  assert.match(none.blocker.reason, /did not record a reason/);
  assert.equal(none.blocker.resolution, null);

  const reconcile = detailRun(fixtures.reconciliation(), project);
  assert.equal(reconcile.blocker.status, 'reconciliation-required');
  assert.match(reconcile.blocker.reason, /Coordinator restarted/);

  // A blocker is never invented for healthy or finished runs, even when a stale reason is present.
  assert.equal(detailRun(makeRun({ status: 'succeeded', reason: 'stale' }), project).blocker, null);
  assert.equal(detailRun(makeRun({ status: 'running', reason: 'stale' }), project).blocker, null);
});

test('succeeded detail lists every result with its evidence', () => {
  const detail = detailRun(fixtures.succeeded(), project);
  assert.equal(detail.phase, 'succeeded');
  assert.deepEqual(detail.tasks.map(task => task.state), ['done', 'done', 'done']);
  assert.ok(detail.tasks.every(task => task.evidence.length === 1 && task.evidence[0].passed === true));
  assert.equal(detail.usage.reportedTotal, 6);
  assert.equal(detail.currentTask, null);
  assert.equal(detail.blocker, null);
});

test('evidence that did not pass stays visible and unset flags stay unset', () => {
  const run = fixtures.succeeded();
  run.checkpoint.results[0].evidence = [{ gateId: 'G1', gate: 'g', passed: false, detail: 'failed hard' }, { detail: 'free text only' }, 'not an object'];
  const evidence = detailRun(run, project).tasks[0].evidence;
  assert.deepEqual(evidence, [
    { gateId: 'G1', gate: 'g', passed: false, detail: 'failed hard' },
    { gateId: null, gate: null, passed: null, detail: 'free text only' },
  ]);
});

test('malformed or unknown fields never throw', () => {
  const garbage = [
    makeRun({ feature: undefined, settings: null, checkpoint: {} }),
    makeRun({ status: 'running', checkpoint: { phase: 'executor', tasks: 'bad', results: {}, usage: [1], uncachedUsage: 'x', index: 'two', attempt: 7, selection: [] } }),
    makeRun({ status: 'running', checkpoint: { phase: 'executor', index: 1, tasks: [null, 3, { id: 9, title: {} }], results: [null, 'x', { taskId: 9, evidence: 'no' }], usage: { a: 'many', b: -5, c: Infinity } } }),
    makeRun({ status: 'strange', createdAt: 'yesterday', updatedAt: NaN, baseCommit: null, branch: undefined, parentSessionId: 5 }),
    { id: 'x' },
  ];
  for (const run of garbage) {
    const summary = summarizeRun(run, undefined);
    const detail = detailRun(run, undefined);
    assert.equal(typeof summary.label, 'string');
    assert.equal(summary.projectName, 'unknown project');
    assert.equal(detail.id, summary.id);
    JSON.stringify(detail);
  }
  const weird = detailRun(garbage[2], project);
  assert.equal(weird.usage.reportedTotal, 0, 'non-numeric and negative usage counts are ignored');
});

test('projected JSON excludes the feature body, worktree path, owner tokens and checkpoint dumps', () => {
  for (const [name, build] of Object.entries(fixtures)) {
    const summary = JSON.stringify(summarizeRun(build(), project));
    const detail = JSON.stringify(detailRun(build(), project));
    for (const forbidden of FORBIDDEN) {
      assert.ok(!summary.includes(forbidden), `${name} summary leaks ${forbidden}`);
      assert.ok(!detail.includes(forbidden), `${name} detail leaks ${forbidden}`);
    }
    for (const key of ['"checkpoint"', '"specification"', '"binding"', '"feature"', '"caller"', '"quotaSelection"']) {
      assert.ok(!detail.includes(key), `${name} detail carries ${key}`);
    }
  }
});

function oversizedRun() {
  const huge = 'Z'.repeat(150000);
  const many = count => Array.from({ length: count }, (_, index) => ({ gateId: `G${index}`, gate: huge, passed: true, detail: huge }));
  const taskList = tasks(150).map(task => ({ ...task, title: `${'T'.repeat(5000)}` }));
  return makeRun({
    feature: `# ${'Heading '.repeat(300)}\n${BODY_MARKER} ${huge}\n`.padEnd(131072, 'x'),
    status: 'paused', reason: huge, resolution: huge,
    checkpoint: checkpoint({
      phase: 'executor', index: 100, tasks: taskList,
      results: taskList.slice(0, 100).map((task, index) => ({ ...result(index + 1), taskId: task.id, summary: huge, handoff: huge, evidence: many(200) })),
      usage: Object.fromEntries(Array.from({ length: 300 }, (_, index) => [`child-${index}`, index])),
    }),
  });
}

test('oversized runs are truncated into bounded projections', () => {
  const run = oversizedRun();
  assert.ok(run.feature.length >= 131072 && run.checkpoint.results[0].summary.length >= 150000, 'fixture is genuinely large');
  const summary = summarizeRun(run, project);
  assert.ok(summary.label.length <= 120);
  assert.ok(summary.label.startsWith('Heading Heading'));
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 1500);

  const detail = detailRun(run, project);
  const json = JSON.stringify(detail);
  assert.ok(Buffer.byteLength(json) <= 150000, `detail is ${Buffer.byteLength(json)} bytes`);
  assert.equal(detail.truncated, true);
  assert.ok(detail.tasks.length <= 100);
  assert.ok(detail.blocker.reason.length <= 2000 && detail.blocker.resolution.length <= 2000);
  assert.ok(detail.usage.sessions.length <= 100);
  assert.ok(!json.includes(BODY_MARKER) && !json.includes('Z'.repeat(3000)));
  assert.equal(detail.usage.reportedTotal, (299 * 300) / 2, 'totals still count every session');

  // A moderately large run keeps full detail within the first profile and flags only what it cut.
  const moderate = fixtures.succeeded();
  moderate.checkpoint.results[0].summary = 'S'.repeat(5000);
  moderate.checkpoint.results[0].evidence = Array.from({ length: 80 }, (_, index) => ({ gateId: `G${index}`, gate: 'g', passed: true, detail: 'D'.repeat(1000) }));
  const view = detailRun(moderate, project);
  assert.equal(view.truncated, true);
  assert.equal(view.tasks[0].truncated, true);
  assert.equal(view.tasks[0].summary.length, 2000);
  assert.equal(view.tasks[0].evidence.length, 50);
  assert.equal(view.tasks[0].evidence[0].detail.length, 600);
  assert.equal(view.tasks[1].truncated, false);
});

/* ---------- routes ---------- */

function makeAdapter({ projects = [project, otherProject], runs = [], events = [] } = {}) {
  const state = { projects, runs, events, calls: [], eventFailures: 0 };
  return {
    state,
    async projects() { state.calls.push('projects'); return state.projects; },
    async runs() { state.calls.push('runs'); return state.runs; },
    async run(id) {
      state.calls.push(`run:${id}`);
      const found = state.runs.find(run => run.id === id);
      if (!found) throw new CoordinatorAdapterError('not-found');
      return found;
    },
    async events(after) {
      state.calls.push(`events:${after}`);
      return state.events.filter(event => event.sequence > after).slice(0, 500);
    },
  };
}

const event = (sequence, runId, type = 'run.transitioned') => ({ sequence, runId, projectId: runId ? 'proj_a' : null, type, at: sequence, payload: {} });

async function listening(t, options) {
  const server = await listenExtensionServer(createExtensionServer({ token: SERVICE_TOKEN, ...options }), 0);
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return server;
}

function call(server, target) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: server.address().port, method: 'GET', path: target, headers: { Authorization: `Bearer ${SERVICE_TOKEN}` } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode, text, json: JSON.parse(text) });
      });
    });
    request.on('error', reject);
    request.end();
  });
}

const routeRuns = () => [
  makeRun({ id: 'run_q', projectId: 'proj_a', status: 'queued', updatedAt: 100, createdAt: 10, feature: '# Queued one' }),
  makeRun({ id: 'run_p', projectId: 'proj_a', status: 'paused', updatedAt: 300, createdAt: 30, feature: '# Paused one', reason: 'needs input', checkpoint: checkpoint({ status: 'paused', phase: 'executor', tasks: tasks(2) }) }),
  makeRun({ id: 'run_b', projectId: 'proj_b', status: 'paused', updatedAt: 200, createdAt: 20, feature: '# Beta paused' }),
  makeRun({ id: 'run_s', projectId: 'proj_b', status: 'succeeded', updatedAt: 50, createdAt: 5, feature: '# Beta done' }),
];

test('GET /projects lists projects without fetching runs', async t => {
  const adapter = makeAdapter({ runs: routeRuns() });
  const server = await listening(t, { adapter, now: () => new Date('2026-02-03T04:05:06.000Z') });
  const response = await call(server, '/projects');
  assert.equal(response.status, 200);
  assert.equal(response.json.fetchedAt, '2026-02-03T04:05:06.000Z');
  assert.deepEqual(response.json.projects.map(item => [item.id, item.name]), [['proj_a', 'alpha-app'], ['proj_b', 'beta']]);
  assert.ok(!response.text.includes('commonGitDirectory') && !response.text.includes('configPath'));
  assert.deepEqual(adapter.state.calls, ['projects']);
});

test('GET /runs filters by project and status and sorts by recent activity', async t => {
  const adapter = makeAdapter({ runs: routeRuns() });
  const server = await listening(t, { adapter });
  const ids = async target => (await call(server, target)).json.runs.map(item => item.id);

  assert.deepEqual(await ids('/runs'), ['run_p', 'run_b', 'run_q', 'run_s']);
  assert.deepEqual(await ids('/runs?projectId=proj_a'), ['run_p', 'run_q']);
  assert.deepEqual(await ids('/runs?status=paused'), ['run_p', 'run_b']);
  assert.deepEqual(await ids('/runs?projectId=proj_b&status=paused'), ['run_b']);
  assert.deepEqual(await ids('/runs?projectId=proj_b&status=failed'), []);
  assert.deepEqual(await ids('/runs?projectId=&status='), ['run_p', 'run_b', 'run_q', 'run_s']);

  const full = await call(server, '/runs');
  assert.equal(full.json.total, 4);
  assert.equal(full.json.truncated, false);
  assert.equal(typeof full.json.fetchedAt, 'string');
  assert.deepEqual(full.json.runs.find(item => item.id === 'run_p'), summarizeRun(routeRuns()[1], project));
  assert.equal(full.json.runs.find(item => item.id === 'run_b').projectName, 'beta');
  for (const forbidden of FORBIDDEN) assert.ok(!full.text.includes(forbidden), `list leaks ${forbidden}`);

  for (const bad of ['/runs?status=done', '/runs?status=Paused', '/runs?status=paused&status=failed', '/runs?projectId=..%2Fx', '/runs?projectId=a%20b', `/runs?projectId=${'a'.repeat(129)}`]) {
    const response = await call(server, bad);
    assert.equal(response.status, 400, bad);
    assert.equal(response.json.error.kind, 'invalid-request');
  }
  const unknown = await call(server, '/runs?projectId=proj_missing');
  assert.equal(unknown.status, 404);
  assert.equal(unknown.json.error.kind, 'not-found');
});

test('GET /runs caps the list size and flags the truncation', async t => {
  const runs = Array.from({ length: 450 }, (_, index) => makeRun({ id: `run_${index}`, updatedAt: index, feature: `# ${'Long label '.repeat(30)}${index}` }));
  const adapter = makeAdapter({ runs });
  const server = await listening(t, { adapter });
  const response = await call(server, '/runs');
  assert.equal(response.status, 200);
  assert.equal(response.json.runs.length, 200);
  assert.equal(response.json.total, 450);
  assert.equal(response.json.truncated, true);
  assert.equal(response.json.runs[0].id, 'run_449', 'the most recently updated runs are kept');
  assert.ok(Buffer.byteLength(response.text) < 200000);
});

test('GET /runs/:id returns a bounded detail, and 404 for unknown or malformed ids', async t => {
  const runs = [...routeRuns(), { ...oversizedRun(), id: 'run_big' }];
  const adapter = makeAdapter({ runs });
  const server = await listening(t, { adapter });

  const found = await call(server, '/runs/run_p');
  assert.equal(found.status, 200);
  assert.equal(found.json.run.id, 'run_p');
  assert.equal(found.json.run.blocker.reason, 'needs input');
  assert.equal(found.json.run.projectName, 'alpha-app');
  assert.equal(typeof found.json.fetchedAt, 'string');
  for (const forbidden of FORBIDDEN) assert.ok(!found.text.includes(forbidden), `detail leaks ${forbidden}`);

  const big = await call(server, '/runs/run_big');
  assert.equal(big.status, 200);
  assert.ok(Buffer.byteLength(big.text) < 200000, `${Buffer.byteLength(big.text)} bytes`);
  assert.equal(big.json.run.truncated, true);
  assert.ok(!big.text.includes(BODY_MARKER));

  for (const target of ['/runs/run_unknown', '/runs/' + 'a'.repeat(129), '/runs/a%2Fb', '/runs/..']) {
    const missing = await call(server, target);
    assert.equal(missing.status, 404, target);
    assert.equal(missing.json.error.kind, 'not-found');
  }
});

test('GET /changes returns a cursor, changed run ids and project changes', async t => {
  const adapter = makeAdapter({ events: [event(1, 'run_old'), event(2, null, 'project.registered'), event(3, 'run_old')] });
  const server = await listening(t, { adapter });

  const first = await call(server, '/changes');
  assert.equal(first.status, 200);
  assert.equal(first.json.resync, true, 'a client without a cursor reloads everything');
  assert.deepEqual(first.json.changedRunIds, []);
  assert.match(first.json.cursor, /^[a-f0-9]{12}:3$/);
  assert.equal(first.json.more, false);
  assert.equal(typeof first.json.fetchedAt, 'string');

  const idle = await call(server, `/changes?cursor=${first.json.cursor}`);
  assert.deepEqual([idle.json.resync, idle.json.changedRunIds, idle.json.projectsChanged, idle.json.cursor], [false, [], false, first.json.cursor]);

  adapter.state.events.push(event(4, 'run_a'), event(5, 'run_b'), event(6, 'run_a', 'checkpoint.saved'));
  const changed = await call(server, `/changes?cursor=${first.json.cursor}`);
  assert.equal(changed.json.resync, false);
  assert.deepEqual(changed.json.changedRunIds, ['run_a', 'run_b']);
  assert.equal(changed.json.projectsChanged, false);
  assert.match(changed.json.cursor, /:6$/);

  // Re-polling from the old cursor still sees the same changes; the new cursor sees none.
  assert.deepEqual((await call(server, `/changes?cursor=${first.json.cursor}`)).json.changedRunIds, ['run_a', 'run_b']);
  assert.deepEqual((await call(server, `/changes?cursor=${changed.json.cursor}`)).json.changedRunIds, []);

  adapter.state.events.push(event(7, null, 'project.registered'), event(8, 'run_c', 'run.queued'));
  const projects = await call(server, `/changes?cursor=${changed.json.cursor}`);
  assert.equal(projects.json.projectsChanged, true);
  assert.deepEqual(projects.json.changedRunIds, ['run_c']);
  assert.match(projects.json.cursor, /:8$/);

  // The panel never has to ask for history from sequence 0 once the service is caught up.
  assert.equal(adapter.state.calls.filter(call_ => call_ === 'events:0').length, 1);
  assert.ok(!adapter.state.calls.includes('runs'), 'change polling does not fetch the run list');
});

test('GET /changes asks for a resync after a service restart or an unusable cursor', async t => {
  const adapter = makeAdapter({ events: [event(1, 'run_a')] });
  const first = await listening(t, { adapter });
  const cursor = (await call(first, '/changes')).json.cursor;
  adapter.state.events.push(event(2, 'run_a'));
  assert.equal((await call(first, `/changes?cursor=${cursor}`)).json.resync, false);

  // A new server object is a new service generation with empty memory, like a restarted service.
  const restarted = await listening(t, { adapter });
  const afterRestart = await call(restarted, `/changes?cursor=${cursor}`);
  assert.equal(afterRestart.status, 200);
  assert.equal(afterRestart.json.resync, true);
  assert.deepEqual(afterRestart.json.changedRunIds, []);
  assert.notEqual(afterRestart.json.cursor.split(':')[0], cursor.split(':')[0]);
  assert.match(afterRestart.json.cursor, /:2$/);
  assert.equal((await call(restarted, `/changes?cursor=${afterRestart.json.cursor}`)).json.resync, false);

  // A cursor from the future of this generation cannot be honoured either.
  const future = `${afterRestart.json.cursor.split(':')[0]}:99`;
  assert.equal((await call(restarted, `/changes?cursor=${future}`)).json.resync, true);

  for (const bad of ['nonsense', 'abc:1', '0123456789ab:-1', '0123456789ab:1:2']) {
    const response = await call(restarted, `/changes?cursor=${encodeURIComponent(bad)}`);
    assert.equal(response.status, 400, bad);
    assert.equal(response.json.error.kind, 'invalid-request');
  }
});

test('change tracking pages long event backlogs and asks for a resync when there are too many changes', async () => {
  const backlog = Array.from({ length: 6200 }, (_, index) => event(index + 1, `run_${index % 3}`));
  const adapter = makeAdapter({ events: backlog });
  const tracker = createChangeTracker({ adapter, generation: 'aaaaaaaaaaaa' });

  const first = await tracker.poll(undefined);
  assert.equal(first.resync, true);
  assert.equal(first.more, true, 'history beyond the page budget is finished by a later poll');
  assert.equal(first.cursor, 'aaaaaaaaaaaa:5000');
  assert.equal(adapter.state.calls.filter(item => item.startsWith('events:')).length, 10, 'bounded pages per poll');

  const second = await tracker.poll(first.cursor);
  assert.equal(second.resync, true, 'the baseline moved past the old cursor');
  assert.equal(second.more, false);
  assert.equal(second.cursor, 'aaaaaaaaaaaa:6200');
  assert.deepEqual(await tracker.poll(second.cursor), { cursor: second.cursor, changedRunIds: [], projectsChanged: false, resync: false, more: false });

  for (let index = 0; index < 250; index++) adapter.state.events.push(event(6201 + index, `fresh_${index}`));
  const flood = await tracker.poll(second.cursor);
  assert.equal(flood.resync, true, 'more distinct changed runs than can be listed');
  assert.deepEqual(flood.changedRunIds, []);
  assert.equal(flood.cursor, 'aaaaaaaaaaaa:6450');

  // Concurrent polls are serialised and agree.
  adapter.state.events.push(event(6451, 'run_x'));
  const [left, right] = await Promise.all([tracker.poll(flood.cursor), tracker.poll(flood.cursor)]);
  assert.deepEqual(left, right);
  assert.deepEqual(left.changedRunIds, ['run_x']);
});

test('a failed coordinator call surfaces as a service error and leaves the cursor usable', async t => {
  const adapter = makeAdapter({ events: [event(1, 'run_a')] });
  const server = await listening(t, { adapter });
  const cursor = (await call(server, '/changes')).json.cursor;
  const original = adapter.events;
  adapter.events = async () => { throw new CoordinatorAdapterError('coordinator-offline'); };
  const failed = await call(server, `/changes?cursor=${cursor}`);
  assert.equal(failed.status, 503);
  assert.equal(failed.json.error.kind, 'coordinator-offline');
  adapter.events = original;
  adapter.state.events.push(event(2, 'run_z'));
  const recovered = await call(server, `/changes?cursor=${cursor}`);
  assert.equal(recovered.json.resync, false);
  assert.deepEqual(recovered.json.changedRunIds, ['run_z']);
});

test('projection routes are read-only GET routes', async t => {
  const adapter = makeAdapter({ runs: routeRuns() });
  const server = await listening(t, { adapter });
  for (const target of ['/projects', '/runs', '/runs/run_p', '/changes', '/runs/run_p/tasks/0', '/runs/run_p/blocker']) {
    const response = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: target, headers: { Authorization: `Bearer ${SERVICE_TOKEN}` } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      request.on('error', reject);
      request.end();
    });
    assert.equal(response, 405, target);
  }
  assert.deepEqual(adapter.state.calls, []);
});

/* ---------- per-field shortening and on-demand content ---------- */

const NO_CLIPS = { title: false, summary: false, handoff: false, model: false, evidenceCount: false, evidenceText: false };

test('detail flags exactly which fields of a task were shortened', () => {
  const run = fixtures.succeeded();
  run.checkpoint.results[0].summary = 'S'.repeat(5000);
  run.checkpoint.results[1].handoff = 'H'.repeat(5000);
  run.checkpoint.results[2].evidence = Array.from({ length: 80 }, (_, index) => ({ gateId: `G${index}`, gate: 'g', passed: true, detail: 'D'.repeat(1000) }));
  const view = detailRun(run, project);
  assert.deepEqual(view.tasks.map(task => task.index), [0, 1, 2]);
  assert.deepEqual(view.tasks[0].clipped, { ...NO_CLIPS, summary: true });
  assert.deepEqual(view.tasks[1].clipped, { ...NO_CLIPS, handoff: true });
  assert.deepEqual(view.tasks[2].clipped, { ...NO_CLIPS, evidenceCount: true, evidenceText: true });
  assert.deepEqual(view.tasks.map(task => task.truncated), [true, true, true], 'the combined flag stays');

  const clean = detailRun(fixtures.succeeded(), project);
  assert.deepEqual(clean.tasks.map(task => task.clipped), [NO_CLIPS, NO_CLIPS, NO_CLIPS]);
  assert.deepEqual(clean.capped, { tasks: false, sessions: false, candidates: false, usageSessions: false });
  assert.equal(clean.blocker, null);
});

test('blocker and capped-list flags are reported separately', () => {
  const run = fixtures.paused();
  run.reason = 'R'.repeat(5000);
  const paused = detailRun(run, project);
  assert.equal(paused.blocker.reasonClipped, true);
  assert.equal(paused.blocker.resolutionClipped, false);
  assert.equal(paused.truncated, true);

  const big = detailRun(oversizedRun(), project);
  assert.equal(big.capped.tasks, true);
  assert.equal(big.capped.usageSessions, true);
  assert.equal(big.blocker.reasonClipped && big.blocker.resolutionClipped, true);
});

test('taskContent returns longer text and says whether anything is still cut', () => {
  const run = fixtures.succeeded();
  run.checkpoint.results[0].summary = 'S'.repeat(5000) + 'TAIL-MARKER';
  const listed = detailRun(run, project).tasks[0];
  assert.equal(listed.clipped.summary, true);
  assert.ok(!listed.summary.includes('TAIL-MARKER'));

  const full = taskContent(run, 0);
  assert.equal(full.complete, true);
  assert.equal(full.index, 0);
  assert.equal(full.taskId, 'T1');
  assert.equal(full.runId, 'run_1');
  assert.ok(full.summary.endsWith('TAIL-MARKER'));
  assert.deepEqual(full.clipped, NO_CLIPS);
  assert.equal(full.evidenceTotal, 1);

  const short = taskContent(fixtures.succeeded(), 1);
  assert.equal(short.complete, true);
  assert.equal(short.summary, 'Done 2');
});

test('taskContent fits the byte budget for a 1 MB summary and reports it as incomplete', () => {
  const run = fixtures.succeeded();
  run.checkpoint.results[0].summary = 'S'.repeat(1_000_000);
  const content = taskContent(run, 0);
  assert.equal(content.complete, false);
  assert.equal(content.clipped.summary, true);
  assert.ok(content.summary.length > 5000 && content.summary.length <= content.limits.text);
  assert.ok(Buffer.byteLength(JSON.stringify({ ...content, fetchedAt: '2026-01-01T00:00:00.000Z' })) <= 200000);
});

test('taskContent is null for positions without a task and never carries internals', () => {
  assert.equal(taskContent(fixtures.succeeded(), 3), null);
  assert.equal(taskContent(fixtures.succeeded(), -1), null);
  assert.equal(taskContent(fixtures.succeeded(), 1.5), null);
  assert.equal(taskContent(fixtures.queued(), 0), null);
  const text = JSON.stringify(taskContent(fixtures.succeeded(), 0));
  for (const forbidden of FORBIDDEN) assert.ok(!text.includes(forbidden), `task content leaks ${forbidden}`);
});

test('blockerContent returns the recorded text, only for blocked runs', () => {
  const run = fixtures.paused();
  run.reason = 'R'.repeat(5000) + 'REASON-TAIL';
  const content = blockerContent(run);
  assert.equal(content.complete, true);
  assert.ok(content.reason.endsWith('REASON-TAIL'));
  assert.equal(content.resolution, 'Resume after the quota window resets');
  assert.equal(content.status, 'paused');

  const huge = fixtures.paused();
  huge.reason = 'R'.repeat(1_000_000);
  huge.resolution = 'X'.repeat(1_000_000);
  const bounded = blockerContent(huge);
  assert.equal(bounded.complete, false);
  assert.deepEqual(bounded.clipped, { reason: true, resolution: true });
  assert.ok(Buffer.byteLength(JSON.stringify({ ...bounded, fetchedAt: '2026-01-01T00:00:00.000Z' })) <= 200000);

  assert.equal(blockerContent(fixtures.succeeded()), null);
  assert.equal(blockerContent(makeRun({ status: 'running', reason: 'stale' })), null);
  const none = blockerContent(fixtures.failedNoReason());
  assert.equal(none.reasonRecorded, false);
  for (const forbidden of FORBIDDEN) assert.ok(!JSON.stringify(content).includes(forbidden), `blocker content leaks ${forbidden}`);
});

test('content routes serve bounded GET answers and reject bad input', async t => {
  const big = makeRun({ ...fixtures.succeeded(), id: 'run_big' });
  big.checkpoint.results[0].summary = 'S'.repeat(1_000_000);
  const paused = makeRun({ ...fixtures.paused(), id: 'run_paused' });
  paused.reason = 'R'.repeat(3000) + 'REASON-TAIL';
  const adapter = makeAdapter({ runs: [big, paused, makeRun({ ...fixtures.succeeded(), id: 'run_ok' })] });
  const server = await listening(t, { adapter });

  const large = await call(server, '/runs/run_big/tasks/0');
  assert.equal(large.status, 200);
  assert.ok(Buffer.byteLength(large.text) < 200000, `${Buffer.byteLength(large.text)} bytes`);
  assert.equal(large.json.complete, false);
  assert.equal(large.json.clipped.summary, true);
  assert.equal(typeof large.json.fetchedAt, 'string');

  const short = await call(server, '/runs/run_ok/tasks/1');
  assert.equal(short.status, 200);
  assert.equal(short.json.complete, true);
  assert.equal(short.json.summary, 'Done 2');
  assert.equal(short.json.taskId, 'T2');
  for (const forbidden of FORBIDDEN) assert.ok(!short.text.includes(forbidden) && !large.text.includes(forbidden), `route leaks ${forbidden}`);

  const blocker = await call(server, '/runs/run_paused/blocker');
  assert.equal(blocker.status, 200);
  assert.equal(blocker.json.complete, true);
  assert.ok(blocker.json.reason.endsWith('REASON-TAIL'));

  for (const target of ['/runs/run_ok/tasks/abc', '/runs/run_ok/tasks/-1', '/runs/run_ok/tasks/01', '/runs/run_ok/tasks/1.5', '/runs/run_ok/tasks/1e2', '/runs/run_ok/tasks/1234567']) {
    const bad = await call(server, target);
    assert.equal(bad.status, 400, target);
    assert.equal(bad.json.error.kind, 'invalid-request');
  }
  for (const target of ['/runs/run_ok/tasks/3', '/runs/run_ok/tasks/99999', '/runs/run_unknown/tasks/0', '/runs/run_ok/blocker', '/runs/run_unknown/blocker', `/runs/${'a'.repeat(129)}/blocker`, `/runs/${'a'.repeat(129)}/tasks/0`]) {
    const missing = await call(server, target);
    assert.equal(missing.status, 404, target);
    assert.equal(missing.json.error.kind, 'not-found');
  }
});

/* ---------- gaps: large blocker route, exclusion of internals, remaining flags ---------- */

const COORDINATOR_KEY = 'COORDINATOR-KEY-SECRET';
const RUNTIME_MARKER = 'RUNTIME-FILE-CONTENTS-SECRET';
const RAW_KEYS = ['"checkpoint"', '"specification"', '"binding"', '"caller"', '"quotaSelection"', '"resumeBinding"', '"feature"', '"settings"'];

/** A run whose unprojected fields all carry markers: none of them may reach a content response. */
function leakyRun(overrides = {}) {
  const run = makeRun({
    ...fixtures.paused(), id: 'run_leaky',
    binding: { sessionID: 'ses_parent', coordinatorKey: COORDINATOR_KEY },
    resumeBinding: { sessionID: 'ses_parent', coordinatorKey: COORDINATOR_KEY },
    ...overrides,
  });
  run.checkpoint.coordinatorKey = COORDINATOR_KEY;
  run.checkpoint.caller = { sessionID: 'ses_parent', coordinatorKey: COORDINATOR_KEY };
  run.checkpoint.specification = { body: BODY_MARKER };
  run.checkpoint.quotaSelection = { key: COORDINATOR_KEY };
  run.checkpoint.runtimeFiles = { '.heimdall/managed.json': RUNTIME_MARKER, '.omc/project-memory.json': RUNTIME_MARKER };
  run.checkpoint.results[0].ownerToken = OWNER_TOKEN;
  run.checkpoint.results[0].runtimeFile = RUNTIME_MARKER;
  return run;
}

test('content routes return strictly more of a 1 MB blocker than the detail clip, bounded, and complete for short text', async t => {
  const huge = makeRun({ ...fixtures.paused(), id: 'run_hugeblock', reason: 'R'.repeat(1_000_000) + 'REASON-TAIL', resolution: 'X'.repeat(1_000_000) + 'RESOLUTION-TAIL' });
  const adapter = makeAdapter({ runs: [huge, makeRun({ ...fixtures.paused(), id: 'run_shortblock' })] });
  const server = await listening(t, { adapter });
  const listed = detailRun(huge, project).blocker;
  assert.equal(listed.reasonClipped && listed.resolutionClipped, true);

  const response = await call(server, '/runs/run_hugeblock/blocker');
  assert.equal(response.status, 200);
  assert.ok(Buffer.byteLength(response.text) < 200000, `${Buffer.byteLength(response.text)} bytes`);
  assert.equal(response.json.complete, false);
  assert.deepEqual(response.json.clipped, { reason: true, resolution: true });
  assert.ok(response.json.reason.length > listed.reason.length && response.json.reason.length > 2000, 'strictly more reason than the detail shows');
  assert.ok(response.json.resolution.length > listed.resolution.length && response.json.resolution.length > 2000, 'strictly more resolution than the detail shows');
  assert.ok(response.json.reason.length <= response.json.limit && response.json.resolution.length <= response.json.limit);

  const short = await call(server, '/runs/run_shortblock/blocker');
  assert.equal(short.status, 200);
  assert.equal(short.json.complete, true);
  assert.deepEqual(short.json.clipped, { reason: false, resolution: false });
  assert.equal(short.json.resolution, 'Resume after the quota window resets');

  const task = fixtures.succeeded();
  task.id = 'run_hugetask';
  task.checkpoint.results[0].summary = 'S'.repeat(1_000_000);
  const taskServer = await listening(t, { adapter: makeAdapter({ runs: [task] }) });
  const taskResponse = await call(taskServer, '/runs/run_hugetask/tasks/0');
  const listedTask = detailRun(task, project).tasks[0];
  assert.equal(taskResponse.json.complete, false);
  assert.ok(taskResponse.json.summary.length > listedTask.summary.length, 'strictly more summary than the detail shows');
});

test('content responses never carry keys, tokens, prompts, raw checkpoint keys or runtime-file contents', async t => {
  const leaky = leakyRun();
  const adapter = makeAdapter({ runs: [leaky] });
  const server = await listening(t, { adapter });
  const forbidden = [...FORBIDDEN, COORDINATOR_KEY, RUNTIME_MARKER, 'coordinatorKey', 'runtimeFile', 'ownerToken', 'project-memory', 'managed.json', ...RAW_KEYS];
  const responses = [
    await call(server, '/runs/run_leaky/blocker'),
    await call(server, '/runs/run_leaky/tasks/0'),
    await call(server, '/runs/run_leaky/tasks/1'),
  ];
  assert.deepEqual(responses.map(response => response.status), [200, 200, 200]);
  for (const response of responses) {
    for (const item of forbidden) assert.ok(!response.text.includes(item), `content response leaks ${item}`);
  }
  // The same holds for the functions behind the routes, for every position the plan lists.
  const direct = [blockerContent(leaky), ...[0, 1, 2].map(index => taskContent(leaky, index))].map(value => JSON.stringify(value));
  for (const text of direct) for (const item of forbidden) assert.ok(!text.includes(item), `projection leaks ${item}`);
});

test('every remaining task, blocker and list limit is flagged separately', () => {
  const run = fixtures.succeeded();
  run.checkpoint.tasks[0].title = 'T'.repeat(500);
  run.checkpoint.results[1].model = 'M'.repeat(500);
  const view = detailRun(run, project);
  assert.deepEqual(view.tasks[0].clipped, { ...NO_CLIPS, title: true });
  assert.deepEqual(view.tasks[1].clipped, { ...NO_CLIPS, model: true });
  assert.deepEqual(view.tasks[2].clipped, NO_CLIPS);
  const full = taskContent(run, 0);
  assert.equal(full.title.length, 500);
  assert.equal(full.clipped.title, false);
  assert.equal(taskContent(run, 1).model.length, 500);

  const resolution = fixtures.paused();
  resolution.resolution = 'Q'.repeat(5000);
  const onlyResolution = detailRun(resolution, project).blocker;
  assert.equal(onlyResolution.reasonClipped, false);
  assert.equal(onlyResolution.resolutionClipped, true);

  const many = fixtures.succeeded();
  many.checkpoint.results = Array.from({ length: 130 }, (_, index) => result(index + 1, { taskId: 'T1', sessionId: `child-${index}` }));
  many.settings = { ...settings, executorCandidates: Array.from({ length: 30 }, (_, index) => ({ key: `k${index}`, quotaProvider: 'openai', model: `openai/model-${index}` })) };
  const capped = detailRun(many, project);
  assert.equal(capped.capped.sessions, true);
  assert.equal(capped.capped.candidates, true);
  assert.equal(capped.sessions.completed.length, 100);
  assert.equal(capped.models.candidates.length, 20);
  assert.equal(capped.capped.tasks, false);
  assert.equal(capped.truncated, true);
});

const REPORT_SECRET = 'sk-live-REPORT-SECRET-0123456789';
const RAW_REPLY = 'RAW-REPLY-MARKER {"status":"completed"}';

const executingWithReport = (reportRecovery, extra = {}) => makeRun({
  status: 'running',
  checkpoint: checkpoint({
    phase: 'executor', index: 0, tasks: tasks(2), child: 'child-1', reportRecovery,
    attempt: { id: 'att', phase: 'executor', index: 0, child: 'child-1', status: 'admitted', startedAt: 1, model: 'openai/exec', purpose: 'report-correction' },
  }),
  ...extra,
});

test('detail projects bounded report state from the checkpoint and null without a record', () => {
  assert.equal(detailRun(fixtures.executing(), project).report, null);
  const correcting = detailRun(executingWithReport({
    phase: 'executor', index: 0, taskId: 'T1', child: 'child-1', corrections: 1, mode: 'correcting', originalAttemptId: 'a1', attempts: ['a2'],
    diagnostic: { code: 'report_format', missingFields: ['handoff'], gateIds: ['G2'] },
  }), project);
  assert.deepEqual(correcting.report, { mode: 'correcting', corrections: 1, limit: 2, code: 'report_format', missingFields: ['handoff'], gateIds: ['G2'] });
  assert.equal(correcting.status, 'running');
});

test('report projection drops unknown codes and fields and never carries raw replies, reasons or secrets', () => {
  const hostile = {
    phase: 'executor', index: 0, taskId: 'T1', child: 'child-1', corrections: 7, mode: 'paused', originalAttemptId: 'a1', attempts: ['a2'],
    reason: REPORT_SECRET, rawReply: RAW_REPLY, ownerToken: REPORT_SECRET,
    diagnostic: { code: 'report_format ' + REPORT_SECRET, reason: REPORT_SECRET, reply: RAW_REPLY, missingFields: ['handoff', REPORT_SECRET, RAW_REPLY], gateIds: ['G2', REPORT_SECRET, '<script>'] },
  };
  const run = executingWithReport(hostile, { status: 'paused', reason: 'Invalid completion report for T1' });
  const detail = detailRun(run, project);
  assert.deepEqual(detail.report, { mode: 'paused', corrections: 2, limit: 2, code: null, missingFields: ['handoff'], gateIds: ['G2'] });
  const text = JSON.stringify(detail);
  for (const leaked of [REPORT_SECRET, 'RAW-REPLY-MARKER', '<script>', 'rawReply']) assert.ok(!text.includes(leaked), leaked);
  assert.equal(detailRun(executingWithReport({ mode: 'weird' }), project).report, null);
  assert.equal(detailRun(executingWithReport('x'), project).report, null);
});

test('GET /runs/:id serves report state through the real service route without leaking report internals', async t => {
  const reportRecovery = {
    phase: 'executor', index: 0, taskId: 'T1', child: 'child-1', corrections: 2, mode: 'paused', originalAttemptId: 'a1', attempts: ['a2', 'a3'],
    reason: REPORT_SECRET, rawReply: RAW_REPLY,
    diagnostic: { code: 'correction_exhausted', reason: REPORT_SECRET, missingFields: ['handoff', 'evidence'], gateIds: ['G3'] },
  };
  const runs = [
    executingWithReport(reportRecovery, { id: 'run_r', status: 'paused', updatedAt: 500, reason: 'Invalid completion report for T1: automatic report correction is exhausted' }),
    { ...fixtures.executing(), id: 'run_plain' },
  ];
  const server = await listening(t, { adapter: makeAdapter({ runs }) });
  const found = await call(server, '/runs/run_r');
  assert.equal(found.status, 200);
  assert.deepEqual(found.json.run.report, { mode: 'paused', corrections: 2, limit: 2, code: 'correction_exhausted', missingFields: ['handoff', 'evidence'], gateIds: ['G3'] });
  for (const leaked of [REPORT_SECRET, 'RAW-REPLY-MARKER', 'rawReply', 'originalAttemptId', 'attempts', ...FORBIDDEN]) assert.ok(!found.text.includes(leaked), leaked);
  // The panel's view model reads the very JSON the route served.
  const info = summaryInfo(found.json.run, Date.UTC(2026, 0, 7));
  assert.equal(info.blocker.title, 'Report correction exhausted');
  assert.equal(info.blocker.category.kind, 'correction-exhausted');
  assert.match(info.blocker.category.missing, /fields handoff, evidence and gate entries G3/);
  assert.equal((await call(server, '/runs/run_plain')).json.run.report, null);
  const list = await call(server, '/runs');
  assert.ok(!list.text.includes('"report"'), 'the list stays summary-only');
});
