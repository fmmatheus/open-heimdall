import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRunner, classifyCompletionFailure, reportPauseReason } from '../dist/workflow/runner.js';

const snapshot = () => Object.fromEntries([['anthropic', 50], ['kimi', 40]].map(([key, n]) => [key, { fetchedAt: Date.now(), entries: [{ name: '5h', percentRemaining: n }, { name: 'Weekly', percentRemaining: n }], errors: [] }]));
const task = { id: 'T2', title: 'Two', brief: 'Do two', dependsOn: [], dod: ['first gate', 'second gate', 'third gate'] };
const plan = { status: 'planned', planMarkdown: '# Plan', factSheet: 'Facts', tasks: [task] };
const entry = (n, extra = {}) => ({ gateId: 'G' + n, gate: task.dod[n - 1], passed: true, detail: 'proved ' + n, ...extra });
const good = (extra = {}) => ({ status: 'completed', taskId: 'T2', summary: 'Done', handoff: 'Next', evidence: [entry(1), entry(2), entry(3)], ...extra });
const without = (value, ...keys) => { const copy = structuredClone(value); for (const key of keys) delete copy[key]; return copy; };
const deepFreeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(deepFreeze); Object.freeze(value); } return value; };
const nativeText = (text, info = {}) => ({ data: { info, parts: [{ type: 'text', text }] } });

const resultCases = [
  ['blocked with a reason', { status: 'blocked', taskId: 'T2', reason: 'Need owner' }, { code: 'agent_blocked' }],
  ['blocked with missing taskId', { status: 'blocked', reason: 'Need owner' }, { code: 'agent_blocked' }],
  ['blocked beats a wrong taskId', { status: 'blocked', taskId: 'T9' }, { code: 'agent_blocked' }],
  ['planned status for an executor', { status: 'planned', taskId: 'T2' }, { code: 'ambiguous_output' }],
  ['wrong taskId', good({ taskId: 'T1' }), { code: 'identity_mismatch' }],
  ['wrong taskId plus missing fields', without(good({ taskId: 'T1' }), 'handoff', 'summary'), { code: 'identity_mismatch' }],
  ['passed:false', good({ evidence: [entry(1), entry(2, { passed: false }), entry(3)] }), { code: 'unfinished_work', gateIds: ['G2'] }],
  ['passed:null', good({ evidence: [entry(1), entry(2, { passed: null }), entry(3)] }), { code: 'unfinished_work', gateIds: ['G2'] }],
  ['passed as a string', good({ evidence: [entry(1, { passed: 'true' }), entry(2), entry(3)] }), { code: 'unfinished_work', gateIds: ['G1'] }],
  ['passed:false beats missing handoff', without(good({ evidence: [entry(1), entry(2, { passed: false }), entry(3, { passed: false })] }), 'handoff'), { code: 'unfinished_work', gateIds: ['G2', 'G3'] }],
  ['unfinished entry with an invalid gate ID lists only valid IDs', good({ evidence: [entry(1), entry(2), { gateId: 'G99', passed: false, detail: 'x' }] }), { code: 'unfinished_work' }],
  ['out-of-range gate ID', good({ evidence: [entry(1), entry(2), entry(4)] }), { code: 'ambiguous_output' }],
  ['malformed gate ID', good({ evidence: [entry(1), entry(2), entry(3, { gateId: 'gate three' })] }), { code: 'ambiguous_output' }],
  ['zero gate ID', good({ evidence: [entry(1), entry(2), entry(3, { gateId: 'G0' })] }), { code: 'ambiguous_output' }],
  ['duplicate gate ID', good({ evidence: [entry(1), entry(1), entry(3)] }), { code: 'ambiguous_output' }],
  ['invalid gate ID with missing handoff', without(good({ evidence: [entry(1), entry(7)] }), 'handoff'), { code: 'ambiguous_output' }],
  ['evidence is not an array', good({ evidence: 'all proved' }), { code: 'ambiguous_output' }],
  ['evidence entry is not an object', good({ evidence: [entry(1), 'G2 done', entry(3)] }), { code: 'ambiguous_output' }],
  ['missing handoff and G2 entry', good({ handoff: '', evidence: [entry(1), entry(3)] }), { code: 'report_format', missingFields: ['handoff'], gateIds: ['G2'] }],
  ['missing taskId', without(good(), 'taskId'), { code: 'report_format', missingFields: ['taskId'] }],
  ['blank summary', good({ summary: '   ' }), { code: 'report_format', missingFields: ['summary'] }],
  ['missing evidence array', without(good(), 'evidence'), { code: 'report_format', missingFields: ['evidence'], gateIds: ['G1', 'G2', 'G3'] }],
  ['empty evidence array', good({ evidence: [] }), { code: 'report_format', gateIds: ['G1', 'G2', 'G3'] }],
  ['entry missing gateId, detail and passed', good({ evidence: [{ gate: 'first gate' }, entry(2), entry(3)] }), { code: 'report_format', missingFields: ['gateId', 'detail', 'passed'], gateIds: ['G1'] }],
  ['entry missing detail', good({ evidence: [entry(1, { detail: ' ' }), entry(2), entry(3)] }), { code: 'report_format', missingFields: ['detail'] }],
  ['entry missing passed', good({ evidence: [entry(1), without(entry(2), 'passed'), entry(3)] }), { code: 'report_format', missingFields: ['passed'] }],
];
for (const [name, result, expected] of resultCases) {
  test('classifies a parsed result: ' + name, () => {
    const diagnostic = classifyCompletionFailure(task, { result: deepFreeze(structuredClone(result)) });
    assert.equal(diagnostic.code, expected.code);
    if (expected.missingFields) assert.deepEqual(diagnostic.missingFields, expected.missingFields); else assert.equal(diagnostic.missingFields, undefined);
    if (expected.gateIds) assert.deepEqual(diagnostic.gateIds, expected.gateIds);
    else if (expected.code !== 'unfinished_work' || name.includes('invalid gate')) assert.equal(diagnostic.gateIds, undefined);
  });
}

test('report_format never fabricates passed proof and leaves the result untouched', () => {
  const original = good({ handoff: '', evidence: [entry(1, { passed: undefined }), entry(3)] });
  const before = JSON.stringify(original);
  const diagnostic = classifyCompletionFailure(task, { result: original });
  assert.equal(diagnostic.code, 'report_format');
  assert.equal(JSON.stringify(original), before);
  assert.ok(original.evidence.every(e => e.passed !== true || e.detail));
  assert.deepEqual(Object.keys(diagnostic).sort(), ['code', 'gateIds', 'missingFields']);
});

const responseCases = [
  ['prose only', nativeText('I finished everything, all good.'), 'ambiguous_output'],
  ['truncated output', nativeText('{"status":"comp', { finish: 'length' }), 'ambiguous_output'],
  ['two conflicting objects in fences', nativeText('```json\n' + JSON.stringify(good()) + '\n```\n```json\n' + JSON.stringify(good({ summary: 'Other' })) + '\n```'), 'ambiguous_output'],
  ['bad fence', nativeText('```json\n{"status":"completed",\n```'), 'ambiguous_output'],
  ['non-object response', 42, 'ambiguous_output'],
  ['native response error', { error: { name: 'APIError', message: 'upstream exploded' } }, 'native_failure'],
  ['native info.error', nativeText('', { error: { message: 'provider crashed' } }), 'native_failure'],
  ['native info.error carrying a 401', nativeText('', { error: { message: '401 Unauthorized' } }), 'auth_or_quota'],
  ['native error beats a parseable body', { error: 'boom', data: { parts: [{ type: 'text', text: JSON.stringify(good()) }] } }, 'native_failure'],
  ['completed JSON missing handoff and G2', JSON.stringify(good({ handoff: undefined, evidence: [entry(1), entry(3)] })), 'report_format'],
  ['blocked JSON with missing taskId', JSON.stringify({ status: 'blocked', reason: 'stuck' }), 'agent_blocked'],
  ['passed:false JSON', JSON.stringify(good({ evidence: [entry(1), entry(2, { passed: false }), entry(3)] })), 'unfinished_work'],
];
for (const [name, response, code] of responseCases) {
  test('classifies a raw response: ' + name, () => {
    assert.equal(classifyCompletionFailure(task, { response }).code, code);
  });
}
test('a completed JSON response keeps missing field names and gate IDs', () => {
  const response = JSON.stringify(good({ handoff: undefined, evidence: [entry(1), entry(3)] }));
  assert.deepEqual(classifyCompletionFailure(task, { response }), { code: 'report_format', missingFields: ['handoff'], gateIds: ['G2'] });
});

const errorCases = [
  ['transport', new Error('connection reset by peer'), 'native_failure'],
  ['non-error value', 'boom', 'native_failure'],
  ['401 auth message', new Error('401 Unauthorized'), 'auth_or_quota'],
  ['manual Claude Code refresh', new Error('Claude Code authentication unavailable. Refresh Claude Code manually, then explicitly resume this run.'), 'auth_or_quota'],
  ['native credential refresh', new Error('Claude authentication expired. Native credential refresh attempted; check provider connection, then resume.'), 'auth_or_quota'],
  ['quota unavailable', new Error('Claude quota unavailable before planning'), 'auth_or_quota'],
  ['truncation message', new Error('Planner/executor output truncated at model output limit.'), 'ambiguous_output'],
  ['invalid response message', new Error('Invalid child response: expected one intact workflow JSON object.'), 'ambiguous_output'],
];
for (const [name, error, code] of errorCases) {
  test('classifies a thrown error: ' + name, () => {
    assert.equal(classifyCompletionFailure(task, { error }).code, code);
  });
}

test('pause reasons are bounded and category specific', () => {
  const reason = diagnostic => reportPauseReason(diagnostic, task, 'detail text');
  assert.match(reason({ code: 'report_format', missingFields: ['handoff'], gateIds: ['G2'] }), /^Invalid completion report for T2.*handoff.*G2.*no new work/);
  assert.match(reason({ code: 'ambiguous_output' }), /^Invalid completion report/);
  assert.match(reason({ code: 'unfinished_work', gateIds: ['G1'] }), /^Unfinished work for T2.*G1/);
  assert.match(reason({ code: 'agent_blocked' }), /^Unfinished work for T2.*detail text/);
  assert.match(reason({ code: 'identity_mismatch' }), /^Wrong task or session identity/);
  assert.match(reason({ code: 'native_failure' }), /^Native\/provider failure: detail text/);
  assert.equal(reason({ code: 'auth_or_quota' }), 'detail text');
  assert.ok(reportPauseReason({ code: 'native_failure' }, task, 'x'.repeat(5000)).length < 400);
  assert.ok(reportPauseReason({ code: 'report_format', gateIds: Array.from({ length: 40 }, (_, i) => 'G' + (i + 1)) }, task).includes('+30 more'));
});

async function fixture(t, responses) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-report-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, '.opencode/adr-workflow');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(directory, 'ADR.md'), 'Spec');
  await fs.writeFile(path.join(root, 'settings.json'), JSON.stringify({ plannerAgent: 'adr-planner', executorAgent: 'adr-executor', plannerModel: 'a/p', executorModel: 'a/e', executorFallbackModel: 'k/k3', timeoutMinutes: 1, maxTasks: 10, maxSessionTokens: 60000, maxRunTokens: 300000, minQuotaRemainingPercent: 10 }));
  for (const name of ['planner', 'executor']) await fs.writeFile(path.join(root, name + '.md'), name);
  const prompts = []; let n = 0;
  const backend = {
    assertIdle: async () => {}, recoverResponse: async () => undefined, usage: async () => ({ used: 0, uncached: 0 }), interrupt: async () => {},
    runSubagent: async input => {
      const id = input.child ?? 's' + ++n;
      await input.onStarted(id);
      prompts.push(input.prompt);
      const r = responses.shift();
      if (r instanceof Error) throw r;
      return typeof r === 'string' || (r && r.data) ? r : JSON.stringify(r);
    },
  };
  const context = { sessionID: 'parent', id: 'call_1', messageID: 'msg_1', agent: 'adr-orchestrator', abort: new AbortController().signal };
  const run = createRunner({ backend, directory, quota: async () => snapshot(), git: a => a[0] === 'branch' ? 'main\n' : ' M existing.txt\n' });
  const statePath = id => path.join(root, 'runs', id, 'state.json');
  const readState = async id => JSON.parse(await fs.readFile(statePath(id), 'utf8'));
  return { root, prompts, run, context, readState, statePath };
}

const SECRET = 'SECRET-RAW-REPLY-TEXT-4242';
const pauseCases = [
  ['missing handoff and G2', () => good({ handoff: '', summary: SECRET, evidence: [entry(1, { detail: SECRET }), entry(3)] }), 'report_format', /^Invalid completion report for T2/, { missingFields: ['handoff'], gateIds: ['G2'] }],
  ['prose only', () => SECRET + ' all done', 'ambiguous_output', /^Invalid completion report for T2/],
  ['truncated', () => nativeText(SECRET, { finish: 'length' }), 'ambiguous_output', /^Invalid completion report for T2/],
  ['unresolved gate', () => good({ summary: SECRET, evidence: [entry(1), entry(2, { passed: false, detail: SECRET }), entry(3)] }), 'unfinished_work', /^Unfinished work for T2.*G2/, { gateIds: ['G2'] }],
  ['agent blocked', () => ({ status: 'blocked', taskId: 'T2', reason: 'Owner must attach the device' }), 'agent_blocked', /^Unfinished work for T2.*Owner must attach the device/],
  ['wrong task', () => good({ taskId: 'T1', summary: SECRET }), 'identity_mismatch', /^Wrong task or session identity/],
  ['backend error', () => new Error('connection reset by peer'), 'native_failure', /^Native\/provider failure: connection reset by peer/],
  ['auth failure', () => new Error('401 Unauthorized'), 'auth_or_quota', /401 Unauthorized/],
];
for (const [name, make, code, reasonPattern, extra = {}] of pauseCases) {
  test('executor rejection pauses with a persisted diagnostic and no advancement: ' + name, async t => {
    const f = await fixture(t, [plan, make()]);
    const paused = JSON.parse(await f.run({ action: 'start', adr: 'ADR.md' }, f.context));
    assert.equal(paused.status, 'paused');
    assert.match(paused.reason, reasonPattern);
    assert.ok(!paused.reason.includes(SECRET), 'no raw reply text in the pause reason');
    assert.ok(paused.reason.length < 2200);
    const state = await f.readState(paused.runId);
    assert.equal(state.status, 'paused');
    assert.equal(state.reason, paused.reason);
    assert.equal(state.index, 0);
    assert.deepEqual(state.results, []);
    assert.equal(state.phase, 'executor');
    assert.equal(state.reportRecovery.phase, 'executor');
    assert.equal(state.reportRecovery.index, 0);
    assert.equal(state.reportRecovery.taskId, 'T2');
    assert.equal(state.reportRecovery.child, state.child);
    assert.equal(state.reportRecovery.corrections, 0);
    assert.equal(state.reportRecovery.mode, 'paused');
    assert.equal(state.reportRecovery.originalAttemptId, state.attempt.id);
    assert.deepEqual(state.reportRecovery.attempts, []);
    assert.equal(state.reportRecovery.diagnostic.code, code);
    for (const [key, value] of Object.entries(extra)) assert.deepEqual(state.reportRecovery.diagnostic[key], value);
    assert.ok(!JSON.stringify(state.reportRecovery).includes(SECRET));
    assert.equal(state.attempt.purpose, undefined);
    const ledger = await fs.readFile(path.join(f.root, 'runs', paused.runId, 'ledger.md'), 'utf8');
    assert.ok(!ledger.includes('T2\n'), 'no ledger entry for the rejected task');
  });
}

test('reportRecovery survives a repeated rejection, keeps its counter, and is removed only by real advancement', async t => {
  const f = await fixture(t, [plan, good({ handoff: '' }), good({ taskId: 'T1' }), good()]);
  const first = JSON.parse(await f.run({ action: 'start', adr: 'ADR.md' }, f.context));
  const before = await f.readState(first.runId);
  assert.equal(before.reportRecovery.diagnostic.code, 'report_format');
  before.reportRecovery.corrections = 1;
  before.reportRecovery.attempts = ['earlier-correction'];
  await fs.writeFile(f.statePath(first.runId), JSON.stringify(before));
  const second = JSON.parse(await f.run({ action: 'resume', runId: first.runId, input: 'try again' }, f.context));
  assert.equal(second.status, 'paused');
  const after = await f.readState(first.runId);
  assert.equal(after.reportRecovery.diagnostic.code, 'identity_mismatch');
  assert.equal(after.reportRecovery.corrections, 1, 'counter is not reset by a manual resume or new attempt id');
  assert.deepEqual(after.reportRecovery.attempts, ['earlier-correction']);
  assert.equal(after.reportRecovery.originalAttemptId, before.reportRecovery.originalAttemptId);
  assert.notEqual(after.attempt.id, before.attempt.id);
  const done = JSON.parse(await f.run({ action: 'resume', runId: first.runId, input: 'final' }, f.context));
  assert.equal(done.status, 'completed');
  const final = await f.readState(first.runId);
  assert.equal(final.reportRecovery, undefined);
  assert.equal(final.results.length, 1);
});

test('a checkpoint without reportRecovery or attempt purpose resumes (legacy)', async t => {
  const f = await fixture(t, [plan, good({ handoff: '' }), good()]);
  const paused = JSON.parse(await f.run({ action: 'start', adr: 'ADR.md' }, f.context));
  const state = await f.readState(paused.runId);
  delete state.reportRecovery;
  delete state.attempt.purpose;
  await fs.writeFile(f.statePath(paused.runId), JSON.stringify(state));
  const resumed = JSON.parse(await f.run({ action: 'resume', runId: paused.runId, input: 'restate' }, f.context));
  assert.equal(resumed.status, 'completed');
  assert.equal((await f.readState(paused.runId)).reportRecovery, undefined);
});

test('a saved admitted receipt that fails to parse persists its diagnostic on resume without a fresh prompt', async t => {
  const f = await fixture(t, [plan, SECRET + ' prose only']);
  const paused = JSON.parse(await f.run({ action: 'start', adr: 'ADR.md' }, f.context));
  const state = await f.readState(paused.runId);
  delete state.reportRecovery;
  state.attempt.status = 'admitted';
  await fs.writeFile(f.statePath(paused.runId), JSON.stringify(state));
  const again = JSON.parse(await f.run({ action: 'resume', runId: paused.runId, input: 'check the saved reply' }, f.context));
  assert.equal(again.status, 'paused');
  assert.match(again.reason, /^Invalid completion report for T2/);
  assert.ok(!again.reason.includes(SECRET));
  assert.equal((await f.readState(paused.runId)).reportRecovery.diagnostic.code, 'ambiguous_output');
  assert.equal(f.prompts.length, 2, 'the saved receipt was applied without another prompt');
});

test('planner failures are not classified for report recovery', async t => {
  const f = await fixture(t, [nativeText('plan prose only')]);
  const paused = JSON.parse(await f.run({ action: 'start', adr: 'ADR.md' }, f.context));
  assert.equal(paused.status, 'paused');
  assert.match(paused.reason, /^Invalid child response/);
  assert.equal((await f.readState(paused.runId)).reportRecovery, undefined);
});
