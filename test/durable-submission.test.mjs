import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CoordinatorStore } from '../dist/coordinator/store.js';
import { createDurableSubmissionGate, authenticateSubmissionCaller } from '../dist/workflow/durable-submission.js';
import { createLocalSubmissionStore, openSubmissionBinding, closeSubmissionBinding, sameSubmission } from '../dist/workflow/submission-store.js';

const settings = { plannerAgent: 'planner', executorAgent: 'executor', plannerModel: 'anthropic/planner', executorModel: 'anthropic/executor', executorFallbackModel: 'kimi/fallback', maxTasks: 10, minQuotaRemainingPercent: 10, tokenLimitsDisabled: true };
const specification = { settings, plannerPrompt: 'p', executorPrompt: 'e', agents: {}, opencode: { baseUrl: 'http://127.0.0.1:9999', passwordEnvironmentVariable: 'SYNTHETIC_PASSWORD' } };
const tasks = [{ id: 'T1', title: 'Title', brief: 'Brief', dependsOn: [], dod: ['gate one', 'gate two'] }];
const completed = (extra = {}) => ({ status: 'completed', summary: 'Done', handoff: 'Next', evidence: [{ gateId: 'G1', passed: true, detail: 'proved one' }, { gateId: 'G2', passed: true, detail: 'proved two' }], ...extra });
const plan = { status: 'planned', planMarkdown: '# Plan', factSheet: '# Facts', tasks };
const CHILD = 'ses_child_1';
const caller = (extra = {}) => ({ sessionID: CHILD, agent: 'executor', messageID: 'msg_1', id: 'call_1', ...extra });

/** A structured checkpoint with an open binding for the current attempt. */
function structured(base, phase = 'executor') {
  const state = {
    id: base.id, status: 'running', adr: 'feature.md', parent: base.parent, caller: base.caller, branch: 'branch', baseline: '', index: 0,
    tasks: phase === 'executor' ? structuredClone(tasks) : [], results: [], phase, child: CHILD, protocol: 'structured-v1', settings: { ...settings },
    attempt: { id: 'attempt_1', phase, index: 0, child: CHILD, status: 'admitted', startedAt: 1, model: 'anthropic/x' },
  };
  state.submissionBinding = openSubmissionBinding(state, 1);
  return state;
}

/** Builds a genuine receipt through the gate itself so that fixtures never drift from the real shape. */
async function receiptFor(state, raw = completed(), native = caller()) {
  let captured;
  const gate = createDurableSubmissionGate({
    runId: state.id, directory: os.tmpdir(), now: () => 5000,
    persistence: { load: async () => state, readSubmission: async () => null, writeSubmission: async (_id, receipt) => { captured = receipt; return receipt; } },
  });
  const response = await gate.submit(state.phase === 'planner' ? 'planner-plan' : 'executor-result', raw, native);
  assert.equal(response.accepted, true, JSON.stringify(response));
  return captured;
}

async function coordinator(t, { concurrency = 2 } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-durable-'));
  const databasePath = path.join(directory, 'state', 'coordinator.sqlite');
  const connections = [];
  const open = () => { const store = new CoordinatorStore({ databasePath, globalConcurrency: concurrency }); connections.push(store); return store; };
  t.after(async () => { for (const store of connections) store.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const checkout = path.join(directory, 'project');
  await fs.mkdir(path.join(checkout, '.git'), { recursive: true });
  await fs.writeFile(path.join(checkout, '.heimdall.toml'), '[workflow]\n');
  const store = open();
  const project = store.registerProject({ directory: checkout, commonGitDirectory: path.join(checkout, '.git'), configPath: path.join(checkout, '.heimdall.toml'), concurrency: 1 });
  store.enqueue({ id: 'run-one', projectId: project.id, feature: 'feature', baseCommit: 'a'.repeat(40), worktreePath: path.join(directory, 'worktrees', 'run-one'), branch: 'heimdall/run-one', specification });
  const run = store.admitNext();
  const start = { sessionID: run.parentSessionId, id: 'native-tool', messageID: 'assistant-message', agent: 'adr-orchestrator' };
  const base = { id: run.id, parent: run.parentSessionId, caller: start };
  return { directory, databasePath, open, store, run, start, base, token: run.ownerToken };
}

/** Uniform handle over both authoritative stores so the gate suite runs against each. */
async function coordinatorBackend(t, phase = 'executor') {
  const c = await coordinator(t);
  c.store.bindStart(c.run.id, c.token, c.start);
  const initial = structured(c.base, phase);
  c.store.saveCheckpoint(c.run.id, c.token, initial);
  let store = c.store;
  const persistence = () => ({
    load: async id => store.getRun(id)?.checkpoint ?? null,
    readSubmission: async (id, attempt, kind) => store.readSubmission(id, c.token, attempt, kind) ?? null,
    writeSubmission: async (id, receipt) => store.writeSubmission(id, c.token, receipt),
  });
  return {
    name: 'coordinator', id: c.run.id, directory: c.directory, state: initial, persistence,
    update: async change => { const state = structuredClone(store.getRun(c.run.id).checkpoint); change(state); store.saveCheckpoint(c.run.id, c.token, state); },
    restart: async () => { store.close(); store = c.open(); },
  };
}
async function localBackend(t, phase = 'executor') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-local-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const id = 'run-local';
  const initial = structured({ id, parent: 'ses_parent', caller: { sessionID: 'ses_parent', id: 'c', messageID: 'm', agent: 'adr-orchestrator' } }, phase);
  await fs.mkdir(path.join(root, 'runs', id), { recursive: true });
  const write = state => fs.writeFile(path.join(root, 'runs', id, 'state.json'), JSON.stringify(state));
  await write(initial);
  return {
    name: 'local', id, directory: root, state: initial, persistence: () => createLocalSubmissionStore(root), root,
    update: async change => { const state = JSON.parse(await fs.readFile(path.join(root, 'runs', id, 'state.json'), 'utf8')); change(state); await write(state); },
    restart: async () => {},
  };
}
const backends = [['coordinator', coordinatorBackend], ['local', localBackend]];
const gateOf = (backend, persistence = backend.persistence(), now = (() => { let n = 1000; return () => n++; })()) => createDurableSubmissionGate({ runId: backend.id, directory: backend.directory, persistence, now });

// --- Coordinator store --------------------------------------------------------------------------------------

test('schema v2 upgrades to v3 additively: receipts and checkpoints survive and submissions become writable', async t => {
  const c = await coordinator(t);
  c.store.bindStart(c.run.id, c.token, c.start);
  const state = structured(c.base);
  c.store.saveCheckpoint(c.run.id, c.token, state);
  const legacy = { ...state.attempt, response: { status: 'planned', synthetic: true } };
  c.store.writeReceipt(c.run.id, c.token, legacy);
  const checkpointBefore = c.store.getRun(c.run.id).checkpoint;
  c.store.close();
  const old = new DatabaseSync(c.databasePath);
  assert.equal(old.prepare('PRAGMA user_version').get().user_version, 3);
  old.exec('DROP TABLE submissions; PRAGMA user_version = 2');
  old.close();
  const upgraded = c.open();
  const db = new DatabaseSync(c.databasePath);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
    const table = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'submissions'").get().sql;
    assert.match(table, /STRICT\s*$/i);
    assert.match(table, /PRIMARY KEY \(run_id, attempt_id, kind\)/);
  } finally { db.close(); }
  assert.deepEqual(upgraded.readReceipt(c.run.id, c.token, legacy.id), legacy);
  assert.deepEqual(upgraded.getRun(c.run.id).checkpoint, checkpointBefore);
  assert.equal(upgraded.readSubmission(c.run.id, c.token, 'attempt_1', 'executor-result'), undefined);
  const receipt = await receiptFor(state);
  assert.deepEqual(upgraded.writeSubmission(c.run.id, c.token, receipt), receipt);
  // Reopening at v3 keeps the stored submission; the migration never reruns destructively.
  upgraded.close();
  const reopened = c.open();
  assert.deepEqual(reopened.readSubmission(c.run.id, c.token, 'attempt_1', 'executor-result'), receipt);
});

test('a fresh database is created at schema v3 with the submissions table', async t => {
  const c = await coordinator(t);
  const db = new DatabaseSync(c.databasePath);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
    assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'submissions'").get());
  } finally { db.close(); }
});

test('writeSubmission is idempotent: an identical duplicate returns the first stored receipt', async t => {
  const c = await coordinator(t);
  c.store.bindStart(c.run.id, c.token, c.start);
  const state = structured(c.base);
  c.store.saveCheckpoint(c.run.id, c.token, state);
  const receipt = await receiptFor(state);
  const first = c.store.writeSubmission(c.run.id, c.token, receipt);
  const eventCount = c.store.events().length;
  const repeat = { ...receipt, acceptedAt: receipt.acceptedAt + 9000, runtime: { ...receipt.runtime, packageVersion: '9.9.9' }, caller: { ...receipt.caller, messageID: 'msg_retry', callId: 'call_retry' } };
  assert.equal(sameSubmission(first, repeat), true);
  assert.deepEqual(c.store.writeSubmission(c.run.id, c.token, repeat), first, 'the stored receipt is returned with its original values');
  assert.equal(c.store.events().length, eventCount, 'a duplicate records nothing new');
  const db = new DatabaseSync(c.databasePath);
  try { assert.equal(db.prepare('SELECT count(*) AS n FROM submissions').get().n, 1); } finally { db.close(); }
  assert.deepEqual(c.store.readSubmission(c.run.id, c.token, 'attempt_1', 'executor-result'), first);
  assert.throws(() => c.store.readSubmission(c.run.id, 'stale-owner', 'attempt_1', 'executor-result'), /owner/);
  assert.throws(() => c.store.readSubmission(c.run.id, c.token, 'attempt_1', 'bogus'), /kind/);
});

test('conflict matrix: nothing but the exact, current, owner-bound receipt is ever stored', async t => {
  const c = await coordinator(t);
  const state = structured(c.base);
  const receipt = await receiptFor(state);
  // Without a bound native start there is no authority at all.
  assert.throws(() => c.store.writeSubmission(c.run.id, c.token, receipt), /bound native start/);
  c.store.bindStart(c.run.id, c.token, c.start);
  assert.throws(() => c.store.writeSubmission(c.run.id, c.token, receipt), /saved checkpoint/);
  // A legacy (no protocol) checkpoint cannot take structured submissions, and a protocol cannot be added or dropped later.
  const { protocol: _protocol, submissionBinding: _binding, ...legacy } = state;
  c.store.saveCheckpoint(c.run.id, c.token, legacy);
  assert.throws(() => c.store.writeSubmission(c.run.id, c.token, receipt), /structured protocol/);
  assert.throws(() => c.store.saveCheckpoint(c.run.id, c.token, state), /protocol is immutable/);
  const legacyRun = c.store.getRun(c.run.id);
  assert.equal(legacyRun.checkpoint.protocol, undefined);
  c.store.close();
  // Fresh run for the structured matrix (a protocol is chosen when a run starts).
  const second = await coordinator(t);
  second.store.bindStart(second.run.id, second.token, second.start);
  const live = structured(second.base);
  second.store.saveCheckpoint(second.run.id, second.token, live);
  assert.throws(() => second.store.saveCheckpoint(second.run.id, second.token, { ...live, protocol: undefined }), /protocol is immutable/);
  const good = await receiptFor(live);
  const write = (value, token = second.token) => second.store.writeSubmission(second.run.id, token, value);
  const count = () => { const db = new DatabaseSync(second.databasePath); try { return db.prepare('SELECT count(*) AS n FROM submissions').get().n; } finally { db.close(); } };
  const cases = [
    ['stale owner', () => write(good, 'stale-owner'), /owner/],
    ['other run id', () => second.store.writeSubmission(second.run.id, second.token, { ...good, runId: 'other-run' }), /identity/],
    ['other parent', () => write({ ...good, parent: 'ses_other' }), /does not belong/],
    ['wrong attempt', () => write({ ...good, attemptId: 'attempt_other' }), /checkpoint attempt/],
    ['wrong phase and kind', () => write({ ...good, phase: 'planner', kind: 'planner-plan', contract: { ...good.contract, kind: 'planner-plan' }, taskId: undefined }), /checkpoint attempt/],
    ['wrong task', () => write({ ...good, taskId: 'T9' }), /checkpoint attempt|binding/],
    ['wrong child', () => write({ ...good, child: 'ses_other', caller: { ...good.caller, sessionID: 'ses_other' } }), /bound child/],
    ['caller is not the child', () => write({ ...good, caller: { ...good.caller, sessionID: 'ses_other' } }), /bound child/],
    ['late dispatch', () => write({ ...good, dispatch: 2 }), /dispatch/],
    ['stale dispatch', () => write({ ...good, dispatch: 0 }), /dispatch/],
    ['malformed', () => write({ ...good, digest: '' }), /identity/],
  ];
  for (const [name, attempt, expected] of cases) {
    assert.throws(attempt, expected, name);
    assert.equal(count(), 0, name + ' stored nothing');
  }
  // A closed binding takes nothing, then the exact receipt is stored once the binding is open again.
  second.store.saveCheckpoint(second.run.id, second.token, { ...live, submissionBinding: closeSubmissionBinding(live.submissionBinding) });
  assert.throws(() => write(good), /closed/);
  assert.equal(count(), 0);
  second.store.saveCheckpoint(second.run.id, second.token, live);
  assert.deepEqual(write(good), good);
  // Conflicts after storage never overwrite.
  const conflicting = { ...good, rawPayload: completed({ summary: 'A different summary' }), canonical: { different: true }, digest: 'f'.repeat(64) };
  assert.throws(() => write(conflicting), /immutable/);
  assert.throws(() => write({ ...good, dispatch: 2 }), /immutable/);
  assert.throws(() => write({ ...good, canonical: { ...good.canonical, summary: 'changed' } }), /immutable/);
  assert.throws(() => write(good, 'stale-owner'), /owner/);
  assert.equal(count(), 1);
  assert.deepEqual(second.store.readSubmission(second.run.id, second.token, 'attempt_1', 'executor-result'), good);
  // The binding closing later does not allow replacement either.
  second.store.saveCheckpoint(second.run.id, second.token, { ...live, submissionBinding: closeSubmissionBinding(live.submissionBinding) });
  assert.throws(() => write(conflicting), /immutable/);
  assert.deepEqual(write(good), good, 'an identical replay of a stored receipt is still answered');
});

test('native outcomes live in their own slot, are immutable and never collide with the typed receipt or the legacy receipt', async t => {
  const c = await coordinator(t);
  c.store.bindStart(c.run.id, c.token, c.start);
  const state = structured(c.base);
  c.store.saveCheckpoint(c.run.id, c.token, state);
  const outcome = { outcomeVersion: 1, runId: c.run.id, phase: 'executor', index: 0, attemptId: 'attempt_1', child: CHILD, response: { data: 'final text' }, capturedAt: 7 };
  assert.equal(c.store.readNativeOutcome(c.run.id, c.token, 'attempt_1'), undefined);
  assert.throws(() => c.store.writeNativeOutcome(c.run.id, c.token, { ...outcome, child: 'ses_other' }), /checkpoint attempt/);
  assert.equal(c.store.readNativeOutcome(c.run.id, c.token, 'attempt_1'), undefined);
  assert.deepEqual(c.store.writeNativeOutcome(c.run.id, c.token, outcome), outcome);
  assert.deepEqual(c.store.writeNativeOutcome(c.run.id, c.token, { ...outcome, capturedAt: 99 }), outcome);
  assert.throws(() => c.store.writeNativeOutcome(c.run.id, c.token, { ...outcome, response: 'changed' }), /immutable/);
  assert.throws(() => c.store.writeNativeOutcome(c.run.id, c.token, { ...outcome, attemptId: 'attempt_other' }), /checkpoint attempt/);
  assert.throws(() => c.store.writeNativeOutcome(c.run.id, c.token, { ...outcome, child: 'ses_other' }), /immutable/);
  assert.throws(() => c.store.writeNativeOutcome(c.run.id, 'stale', outcome), /owner/);
  const receipt = await receiptFor(state);
  c.store.writeSubmission(c.run.id, c.token, receipt);
  c.store.writeReceipt(c.run.id, c.token, { ...state.attempt, response: 'legacy' });
  assert.deepEqual(c.store.readNativeOutcome(c.run.id, c.token, 'attempt_1'), outcome);
  assert.deepEqual(c.store.readSubmission(c.run.id, c.token, 'attempt_1', 'executor-result'), receipt);
  assert.equal(c.store.readReceipt(c.run.id, c.token, 'attempt_1').response, 'legacy');
});

// --- Standalone atomic store --------------------------------------------------------------------------------

test('local store writes exclusive complete files, is idempotent and never overwrites', async t => {
  const f = await localBackend(t);
  const store = createLocalSubmissionStore(f.root);
  const receipt = await receiptFor(f.state);
  const file = path.join(f.root, 'runs', f.id, 'submission-attempt_1-executor-result.json');
  await assert.rejects(fs.access(file), { code: 'ENOENT' });
  assert.equal(await store.readSubmission(f.id, 'attempt_1', 'executor-result'), null);
  assert.deepEqual(await store.writeSubmission(f.id, { ...receipt, runId: f.id }), { ...receipt, runId: f.id });
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { ...receipt, runId: f.id });
  const stat = await fs.stat(file);
  assert.equal(stat.mode & 0o077, 0, 'private file');
  const duplicate = { ...receipt, runId: f.id, acceptedAt: 1, caller: { ...receipt.caller, callId: 'again' } };
  assert.deepEqual(await store.writeSubmission(f.id, duplicate), { ...receipt, runId: f.id });
  await assert.rejects(store.writeSubmission(f.id, { ...receipt, rawPayload: completed({ summary: 'changed' }) }), /immutable/);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { ...receipt, runId: f.id });
  const names = await fs.readdir(path.join(f.root, 'runs', f.id));
  assert.deepEqual(names.filter(name => name.endsWith('.tmp')), [], 'no temporary file is left behind');
});

test('local store: concurrent identical writers converge on one receipt; competing payloads leave exactly one winner', async t => {
  const f = await localBackend(t);
  const store = createLocalSubmissionStore(f.root);
  const receipt = await receiptFor(f.state);
  const same = await Promise.all(Array.from({ length: 12 }, (_, n) => store.writeSubmission(f.id, { ...receipt, acceptedAt: receipt.acceptedAt + n })));
  assert.ok(same.every(value => sameSubmission(value, receipt)));
  assert.equal(new Set(same.map(value => value.acceptedAt)).size, 1, 'every writer was answered with the single stored receipt');
  const other = await localBackend(t);
  const second = createLocalSubmissionStore(other.root);
  const left = await receiptFor(other.state, completed({ summary: 'left' }));
  const right = await receiptFor(other.state, completed({ summary: 'right' }));
  const settled = await Promise.allSettled([second.writeSubmission(other.id, left), second.writeSubmission(other.id, right)]);
  assert.equal(settled.filter(value => value.status === 'fulfilled').length, 1);
  assert.match(String(settled.find(value => value.status === 'rejected').reason), /immutable/);
  const winner = settled.find(value => value.status === 'fulfilled').value;
  assert.deepEqual(await second.readSubmission(other.id, 'attempt_1', 'executor-result'), winner);
});

test('local store enforces the same authority checks as the coordinator and rejects unsafe identifiers', async t => {
  const f = await localBackend(t);
  const store = createLocalSubmissionStore(f.root);
  const receipt = await receiptFor(f.state);
  const file = path.join(f.root, 'runs', f.id, 'submission-attempt_1-executor-result.json');
  const cases = [
    ['wrong run', { ...receipt, runId: 'run-other' }, /identity/],
    ['wrong attempt', { ...receipt, attemptId: 'attempt_other' }, /checkpoint attempt/],
    ['wrong phase', { ...receipt, phase: 'planner', kind: 'planner-plan', contract: { ...receipt.contract, kind: 'planner-plan' }, taskId: undefined }, /checkpoint attempt/],
    ['wrong task', { ...receipt, taskId: 'T9' }, /checkpoint attempt|binding/],
    ['wrong child', { ...receipt, child: 'ses_other', caller: { ...receipt.caller, sessionID: 'ses_other' } }, /bound child/],
    ['late dispatch', { ...receipt, dispatch: 3 }, /dispatch/],
    ['wrong parent', { ...receipt, parent: 'ses_other' }, /does not belong/],
  ];
  for (const [name, value, expected] of cases) {
    await assert.rejects(store.writeSubmission(f.id, value), expected, name);
    await assert.rejects(fs.access(file), { code: 'ENOENT' }, name + ' stored nothing');
  }
  await f.update(state => { state.submissionBinding.status = 'closed'; });
  await assert.rejects(store.writeSubmission(f.id, receipt), /closed/);
  await assert.rejects(store.readSubmission('../escape', 'attempt_1', 'executor-result'), /Invalid run id/);
  await assert.rejects(store.readSubmission(f.id, '../escape', 'executor-result'), /Invalid attempt id/);
  await assert.rejects(store.readSubmission(f.id, 'attempt_1', 'bogus'), /kind/);
  await assert.rejects(store.writeSubmission(f.id, { ...receipt, attemptId: 'a/../b' }), /Invalid attempt id|identity/);
  await f.update(state => { delete state.protocol; });
  await assert.rejects(store.writeSubmission(f.id, receipt), /structured protocol/);
  const outcome = { outcomeVersion: 1, runId: f.id, phase: 'executor', index: 0, attemptId: 'attempt_1', child: CHILD, response: 'text', capturedAt: 1 };
  await assert.rejects(store.writeNativeOutcome(f.id, { ...outcome, child: 'ses_other' }), /checkpoint attempt/);
  assert.deepEqual(await store.writeNativeOutcome(f.id, outcome), outcome);
  assert.deepEqual(await store.writeNativeOutcome(f.id, { ...outcome, capturedAt: 2 }), outcome);
  await assert.rejects(store.writeNativeOutcome(f.id, { ...outcome, response: 'other' }), /immutable/);
  await assert.rejects(store.writeNativeOutcome(f.id, { ...outcome, child: 'ses_other' }), /immutable/);
});

// --- Submission gate (both authoritative stores) ------------------------------------------------------------

for (const [name, make] of backends) {
  test(`${name}: gate exposes the submit tool only to the bound child session with the configured role`, async t => {
    const backend = await make(t);
    const gate = gateOf(backend);
    assert.equal(await gate.exposed(CHILD, 'executor'), 'executor-result');
    assert.equal(await gate.exposed(CHILD, 'planner'), undefined, 'right session, wrong role');
    assert.equal(await gate.exposed('ses_forged', 'executor'), undefined, 'agent name alone is never enough');
    assert.equal(await gate.exposed('ses_parent', 'adr-orchestrator'), undefined);
    assert.equal(await gate.exposed('', ''), undefined);
    assert.ok(authenticateSubmissionCaller(backend.state, CHILD, 'executor'));
    assert.equal(authenticateSubmissionCaller(null, CHILD, 'executor'), undefined);
    for (const [label, change] of [
      ['paused run', state => { state.status = 'paused'; }],
      ['closed binding', state => { state.submissionBinding.status = 'closed'; }],
      ['rejected attempt', state => { state.attempt.status = 'rejected'; }],
      ['interrupted attempt', state => { state.attempt.status = 'interrupted'; }],
      ['different child', state => { state.child = 'ses_other'; }],
      ['unbound child', state => { state.submissionBinding.child = null; }],
      ['different attempt', state => { state.attempt.id = 'attempt_2'; }],
      ['different task', state => { state.submissionBinding.taskId = 'T9'; }],
      ['legacy run', state => { delete state.protocol; }],
    ]) {
      const hostile = await make(t);
      try { await hostile.update(change); }
      catch (error) { assert.match(error.message, /protocol is immutable/, label); continue; } // The coordinator refuses to even store it.
      assert.equal(await gateOf(hostile).exposed(CHILD, 'executor'), undefined, label);
      assert.equal((await gateOf(hostile).submit('executor-result', completed(), caller())).code, 'unauthorized', label);
    }
  });

  test(`${name}: gate persists the receipt before acknowledging and keeps raw and canonical values`, async t => {
    const backend = await make(t);
    let persisted = 0;
    const persistence = backend.persistence();
    const watched = { ...persistence, writeSubmission: async (id, receipt) => { const stored = await persistence.writeSubmission(id, receipt); persisted++; return stored; } };
    const gate = gateOf(backend, watched);
    const raw = completed();
    const response = await gate.submit('executor-result', raw, caller());
    assert.equal(response.accepted, true);
    assert.equal(persisted, 1, 'the write completed before the acknowledgement was returned');
    const stored = await persistence.readSubmission(backend.id, 'attempt_1', 'executor-result');
    assert.equal(response.digest, stored.digest);
    assert.equal(response.outcome, 'completed');
    assert.deepEqual({ protocol: stored.protocol, kind: stored.kind, phase: stored.phase, index: stored.index, taskId: stored.taskId, attemptId: stored.attemptId, dispatch: stored.dispatch, child: stored.child, receiptVersion: stored.receiptVersion }, { protocol: 'structured-v1', kind: 'executor-result', phase: 'executor', index: 0, taskId: 'T1', attemptId: 'attempt_1', dispatch: 1, child: CHILD, receiptVersion: 1 });
    assert.equal(stored.parent, backend.state.parent);
    assert.deepEqual(stored.caller, { sessionID: CHILD, agent: 'executor', messageID: 'msg_1', callId: 'call_1' });
    assert.deepEqual(stored.contract, { protocol: 'structured-v1', kind: 'executor-result', version: 1 });
    assert.equal(typeof stored.runtime.packageVersion, 'string');
    assert.equal(stored.runtime.protocol, 'structured-v1');
    assert.deepEqual(stored.rawPayload, raw, 'raw is exactly what was submitted');
    assert.equal('gate' in stored.rawPayload.evidence[0], false);
    assert.deepEqual(stored.canonical.evidence.map(entry => entry.gate), ['gate one', 'gate two'], 'the gate text is host-derived');
    assert.equal(stored.canonical.taskId, 'T1');
  });

  test(`${name}: duplicates replay the same acknowledgement; different payloads conflict and never overwrite`, async t => {
    const backend = await make(t);
    const gate = gateOf(backend);
    const first = await gate.submit('executor-result', completed(), caller());
    const stored = await backend.persistence().readSubmission(backend.id, 'attempt_1', 'executor-result');
    assert.deepEqual(await gate.submit('executor-result', completed(), caller()), first);
    assert.deepEqual(await gate.submit('executor-result', completed(), caller({ messageID: 'msg_retry', id: 'call_retry' })), first);
    const conflict = await gate.submit('executor-result', completed({ summary: 'changed' }), caller());
    assert.equal(conflict.accepted, false);
    assert.equal(conflict.code, 'conflict');
    assert.equal(conflict.repairable, false);
    const blocked = await gate.submit('executor-result', { status: 'blocked', reason: 'later' }, caller());
    assert.equal(blocked.code, 'conflict');
    assert.deepEqual(await backend.persistence().readSubmission(backend.id, 'attempt_1', 'executor-result'), stored);
    assert.equal((await gate.submit('planner-plan', plan, caller())).code, 'unauthorized', 'the other kind is not this binding');
  });

  test(`${name}: a rebuilt gate authenticates replays after a restart and rejects forged callers`, async t => {
    const backend = await make(t);
    const first = await gateOf(backend).submit('executor-result', completed(), caller());
    await backend.restart();
    const rebuilt = gateOf(backend);
    assert.deepEqual(await rebuilt.submit('executor-result', completed(), caller()), first);
    assert.equal(await rebuilt.exposed(CHILD, 'executor'), 'executor-result');
    assert.equal((await rebuilt.submit('executor-result', completed(), caller({ sessionID: 'ses_forged' }))).code, 'unauthorized');
    assert.equal((await rebuilt.submit('executor-result', completed(), caller({ agent: 'planner' }))).code, 'unauthorized');
    assert.equal((await rebuilt.submit('executor-result', completed({ summary: 'changed' }), caller())).code, 'conflict');
    // Once the binding closes (advancement or pause) the stored receipt is sealed and no further call is authenticated.
    await backend.update(state => { state.submissionBinding.status = 'closed'; });
    assert.equal((await gateOf(backend).submit('executor-result', completed(), caller())).code, 'unauthorized');
    assert.equal(await gateOf(backend).exposed(CHILD, 'executor'), undefined);
  });

  test(`${name}: a malformed submission is repairable, is not recorded and does not consume the binding`, async t => {
    const backend = await make(t);
    const gate = gateOf(backend);
    const bad = await gate.submit('executor-result', { status: 'completed', summary: '', handoff: 'x', evidence: [] }, caller());
    assert.equal(bad.accepted, false);
    assert.equal(bad.code, 'format');
    assert.equal(bad.repairable, true);
    assert.ok(bad.errors.length > 0);
    assert.equal(await backend.persistence().readSubmission(backend.id, 'attempt_1', 'executor-result'), null);
    const identity = await gate.submit('executor-result', completed({ taskId: 'T1' }), caller());
    assert.equal(identity.code, 'format', 'model-supplied identity is rejected');
    assert.equal(await backend.persistence().readSubmission(backend.id, 'attempt_1', 'executor-result'), null);
    const fixed = await gate.submit('executor-result', completed(), caller());
    assert.equal(fixed.accepted, true);
  });

  test(`${name}: a persistence failure blocks the acknowledgement and a retry succeeds once storage recovers`, async t => {
    const backend = await make(t);
    const persistence = backend.persistence();
    let failing = true;
    const flaky = { ...persistence, writeSubmission: async (id, receipt) => { if (failing) throw new Error('disk full'); return persistence.writeSubmission(id, receipt); } };
    const gate = gateOf(backend, flaky);
    await assert.rejects(gate.submit('executor-result', completed(), caller()), /disk full/);
    assert.equal(await persistence.readSubmission(backend.id, 'attempt_1', 'executor-result'), null, 'nothing was acknowledged or stored');
    const unreadable = gateOf(backend, { ...persistence, load: async () => { throw new Error('checkpoint unreadable'); } });
    assert.equal(await unreadable.exposed(CHILD, 'executor'), undefined, 'an unreadable checkpoint exposes nothing');
    await assert.rejects(unreadable.submit('executor-result', completed(), caller()), /unreadable/);
    failing = false;
    const response = await gate.submit('executor-result', completed(), caller());
    assert.equal(response.accepted, true);
    assert.equal((await persistence.readSubmission(backend.id, 'attempt_1', 'executor-result')).digest, response.digest);
  });
}

test('planner gate canonicalizes an inline plan with its content hash, and a blocked plan verbatim', async t => {
  const backend = await localBackend(t, 'planner');
  const planner = { ...caller({ agent: 'planner' }) };
  const gate = gateOf(backend);
  assert.equal(await gate.exposed(CHILD, 'planner'), 'planner-plan');
  assert.equal(await gate.exposed(CHILD, 'executor'), undefined);
  const response = await gate.submit('planner-plan', plan, planner);
  assert.equal(response.accepted, true);
  assert.equal(response.outcome, 'planned');
  const stored = await backend.persistence().readSubmission(backend.id, 'attempt_1', 'planner-plan');
  assert.equal(stored.taskId, undefined);
  assert.equal(stored.phase, 'planner');
  assert.deepEqual(stored.rawPayload, plan);
  assert.equal(stored.canonical.status, 'planned');
  assert.match(stored.canonical.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(stored.canonical.tasks, tasks);
  const blocked = await localBackend(t, 'planner');
  const again = await gateOf(blocked).submit('planner-plan', { status: 'blocked', reason: 'Need input' }, planner);
  assert.equal(again.accepted, true);
  assert.deepEqual((await blocked.persistence().readSubmission(blocked.id, 'attempt_1', 'planner-plan')).canonical, { status: 'blocked', reason: 'Need input' });
});

test('planner gate snapshots artifacts from the host-owned plan directory', async t => {
  const backend = await localBackend(t, 'planner');
  const base = path.join(backend.directory, '.omo', 'plans', 'adr-' + backend.id);
  await fs.mkdir(base, { recursive: true });
  await fs.writeFile(path.join(base, 'plan.md'), '# Artifact plan');
  await fs.writeFile(path.join(base, 'facts.md'), '# Artifact facts');
  await fs.writeFile(path.join(base, 'tasks.md'), JSON.stringify(tasks));
  const gate = createDurableSubmissionGate({ runId: backend.id, directory: backend.directory, persistence: backend.persistence() });
  const response = await gate.submit('planner-plan', { status: 'planned', artifacts: true }, caller({ agent: 'planner' }));
  assert.equal(response.accepted, true, JSON.stringify(response));
  const stored = await backend.persistence().readSubmission(backend.id, 'attempt_1', 'planner-plan');
  assert.deepEqual(stored.rawPayload, { status: 'planned', artifacts: true });
  assert.equal(stored.canonical.planMarkdown, '# Artifact plan');
  assert.equal(stored.canonical.factSheet, '# Artifact facts');
  // Later edits to the artifacts cannot change what was acknowledged: the replay answers from the stored receipt.
  await fs.writeFile(path.join(base, 'plan.md'), '# Tampered');
  assert.deepEqual(await gate.submit('planner-plan', { status: 'planned', artifacts: true }, caller({ agent: 'planner' })), response);
  assert.equal((await backend.persistence().readSubmission(backend.id, 'attempt_1', 'planner-plan')).canonical.planMarkdown, '# Artifact plan');
});
