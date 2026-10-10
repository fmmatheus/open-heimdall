import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { CoordinatorStore } from '../dist/coordinator/store.js';

const execute = promisify(execFile);
const moduleUrl = new URL('../dist/coordinator/store.js', import.meta.url).href;
const specification = {
  settings: { plannerAgent: 'planner', executorAgent: 'executor', plannerModel: 'anthropic/planner', executorModel: 'anthropic/executor', executorFallbackModel: 'kimi/fallback', maxTasks: 10, minQuotaRemainingPercent: 10, tokenLimitsDisabled: true },
  plannerPrompt: 'synthetic-private-prompt', executorPrompt: 'synthetic-executor-prompt',
  agents: { planner: 'synthetic-agent-text' },
  opencode: { baseUrl: 'http://127.0.0.1:9999', passwordEnvironmentVariable: 'SYNTHETIC_PASSWORD' },
};

async function fixture(t, globalConcurrency = 2) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-store-'));
  const databasePath = path.join(directory, 'state', 'coordinator.sqlite');
  const connections = [];
  const open = () => {
    const store = new CoordinatorStore({ databasePath, globalConcurrency });
    connections.push(store);
    return store;
  };
  t.after(async () => {
    for (const store of connections) store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const project = async (name, concurrency = 1) => {
    const checkout = path.join(directory, name);
    const commonGitDirectory = path.join(checkout, '.git');
    const configPath = path.join(checkout, '.heimdall.toml');
    await fs.mkdir(commonGitDirectory, { recursive: true });
    await fs.writeFile(configPath, '[workflow]\n');
    return { directory: checkout, commonGitDirectory, configPath, concurrency };
  };
  const enqueue = (store, project, id, overrides = {}) => store.enqueue({
    id, projectId: project.id, feature: 'synthetic-private-feature', baseCommit: 'a'.repeat(40),
    worktreePath: path.join(directory, 'worktrees', id), branch: 'heimdall/' + id,
    specification, ...overrides,
  });
  return { directory, databasePath, globalConcurrency, open, project, enqueue };
}

function binding(run) {
  return { sessionID: run.parentSessionId, id: 'native-tool-' + run.id, messageID: 'assistant-message-' + run.id, agent: 'adr-orchestrator' };
}
function checkpoint(run, caller = binding(run)) {
  const child = 'synthetic-child-' + run.id;
  return {
    id: run.id, status: 'running', adr: 'feature.md', parent: run.parentSessionId, caller,
    branch: run.branch, baseline: '', index: 0, tasks: [], results: [], phase: 'planner', child,
    settings: specification.settings, usage: { [child]: 42 }, uncachedUsage: { [child]: 21 },
    attempt: { id: 'attempt-' + run.id, phase: 'planner', index: 0, child, status: 'admitted', startedAt: 1000, model: 'anthropic/planner' },
  };
}
async function admitFixture(t, globalConcurrency = 2) {
  const f = await fixture(t, globalConcurrency);
  const store = f.open();
  const project = store.registerProject(await f.project('project'));
  f.enqueue(store, project, 'run-one');
  return { ...f, store, project, run: store.admitNext() };
}

test('project registry uses canonical Git identity and rejects conflicting registrations', async t => {
  const f = await fixture(t);
  const store = f.open();
  const input = await f.project('project');
  const project = store.registerProject(input);
  const alias = path.join(f.directory, 'git-alias');
  await fs.symlink(input.commonGitDirectory, alias, 'dir');
  assert.deepEqual(store.registerProject({ ...input, commonGitDirectory: alias }), project);
  assert.deepEqual(store.getProject(project.id), project);
  assert.equal(store.listProjects().length, 1);
  assert.equal(store.getProject('missing'), null);
  const otherConfig = path.join(input.directory, 'other.toml');
  await fs.writeFile(otherConfig, '[workflow]\n');
  assert.throws(() => store.registerProject({ ...input, configPath: otherConfig }), /different paths/);
  assert.throws(() => store.registerProject({ ...input, concurrency: 2 }), /different paths/);
  const otherCheckout = await f.project('other');
  assert.throws(() => store.registerProject({ ...otherCheckout, commonGitDirectory: input.commonGitDirectory }), /different paths/);
  assert.throws(() => store.registerProject({ ...input, concurrency: 0 }), /positive/);
});

test('SQLite schema is strict and versioned; authoritative global limits cannot diverge', async t => {
  const f = await fixture(t);
  const store = f.open();
  const db = new DatabaseSync(f.databasePath);
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
    const tables = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    assert.equal(tables.length, 6);
    assert.ok(tables.every(row => /STRICT\s*$/i.test(row.sql)));
  } finally { db.close(); }
  assert.throws(() => new CoordinatorStore({ databasePath: f.databasePath, globalConcurrency: 3 }), /persisted/);
  assert.throws(() => new CoordinatorStore({ databasePath: ':memory:', globalConcurrency: 0 }), /positive/);
  const unknownPath = path.join(f.directory, 'unknown.sqlite');
  const unknown = new DatabaseSync(unknownPath);
  unknown.exec('PRAGMA user_version = 99');
  unknown.close();
  assert.throws(() => new CoordinatorStore({ databasePath: unknownPath, globalConcurrency: 2 }), /schema version/);
  store.close();
  store.close();
});

test('enqueue retains exclusive worktree and branch claims and rolls back conflicting requests', async t => {
  const f = await fixture(t);
  const store = f.open();
  const project = store.registerProject(await f.project('project'));
  const run = f.enqueue(store, project, 'one', { feature: "quote'); DROP TABLE projects; --" });
  assert.equal(run.status, 'queued');
  assert.equal(run.capacityReserved, false);
  assert.equal(run.ownerToken, null);
  assert.equal(run.launchIntent, false);
  assert.equal(run.resumeBinding, null);
  assert.match(run.parentSessionId, /^ses_[0-9a-f-]{36}$/);
  assert.match(run.promptMessageId, /^msg_[0-9a-f-]{36}$/);
  assert.equal(store.getRun('missing'), null);
  const events = store.events().length;
  assert.throws(() => f.enqueue(store, project, 'same-path', { worktreePath: run.worktreePath }));
  assert.throws(() => f.enqueue(store, project, 'same-branch', { branch: run.branch }));
  assert.throws(() => f.enqueue(store, { id: 'missing' }, 'missing-project'), /Unknown project/);
  assert.equal(store.listRuns().length, 1);
  assert.equal(store.events().length, events);
  assert.equal(store.listProjects().length, 1);
  let admitted = store.admitNext();
  admitted = store.transition(admitted.id, admitted.ownerToken, admitted.version, 'running');
  store.transition(admitted.id, admitted.ownerToken, admitted.version, 'succeeded', undefined, true);
  assert.throws(() => f.enqueue(store, project, 'retained-path', { worktreePath: run.worktreePath }));
});

test('separate SQLite connections enforce FIFO while skipping saturated projects', async t => {
  const f = await fixture(t, 2);
  const first = f.open();
  const second = f.open();
  const a = first.registerProject(await f.project('a', 1));
  const b = first.registerProject(await f.project('b', 1));
  f.enqueue(first, a, 'a-one');
  f.enqueue(first, a, 'a-two');
  f.enqueue(first, b, 'b-one');
  assert.equal(first.admitNext().id, 'a-one');
  assert.equal(second.admitNext().id, 'b-one');
  assert.equal(first.admitNext(), null);
  let active = first.getRun('a-one');
  active = first.transition(active.id, active.ownerToken, active.version, 'running');
  first.transition(active.id, active.ownerToken, active.version, 'succeeded', undefined, true);
  assert.equal(second.admitNext().id, 'a-two');
  assert.equal(first.listRuns().filter(run => run.capacityReserved).length, 2);
});

test('competing processes cannot exceed global or per-project admission limits', async t => {
  const f = await fixture(t, 2);
  const store = f.open();
  const a = store.registerProject(await f.project('a', 1));
  const b = store.registerProject(await f.project('b', 1));
  for (let index = 0; index < 4; index++) {
    f.enqueue(store, a, 'a-' + index);
    f.enqueue(store, b, 'b-' + index);
  }
  const script = `
    import { CoordinatorStore } from ${JSON.stringify(moduleUrl)};
    const store = new CoordinatorStore({databasePath:process.argv[1],globalConcurrency:2});
    const admitted = [];
    let run;
    while ((run = store.admitNext())) admitted.push({id:run.id,projectId:run.projectId});
    console.log(JSON.stringify(admitted));
    store.close();
  `;
  const results = await Promise.all(Array.from({ length: 4 }, () => execute(process.execPath, ['--input-type=module', '-e', script, f.databasePath])));
  const admitted = results.flatMap(result => JSON.parse(result.stdout));
  assert.equal(admitted.length, 2);
  assert.equal(new Set(admitted.map(run => run.id)).size, 2);
  assert.equal(admitted.filter(run => run.projectId === a.id).length, 1);
  assert.equal(admitted.filter(run => run.projectId === b.id).length, 1);
  assert.equal(store.listRuns().filter(run => run.capacityReserved).length, 2);
});

test('a terminated owner leaves durable capacity and worktree reservations without expiry', async t => {
  const f = await fixture(t, 1);
  const store = f.open();
  const project = store.registerProject(await f.project('project'));
  f.enqueue(store, project, 'first');
  f.enqueue(store, project, 'second');
  const script = `
    import { CoordinatorStore } from ${JSON.stringify(moduleUrl)};
    const store = new CoordinatorStore({databasePath:process.argv[1],globalConcurrency:1});
    console.log(JSON.stringify(store.admitNext()));
    process.exit(0);
  `;
  const result = await execute(process.execPath, ['--input-type=module', '-e', script, f.databasePath]);
  const admitted = JSON.parse(result.stdout);
  const db = new DatabaseSync(f.databasePath);
  db.prepare('UPDATE runs SET updated_at = ? WHERE id = ?').run(1, admitted.id);
  db.close();
  const reopened = f.open();
  assert.equal(reopened.admitNext(), null);
  let uncertain = reopened.getRun(admitted.id);
  uncertain = reopened.transition(uncertain.id, uncertain.ownerToken, uncertain.version, 'reconciliation-required', 'synthetic unknown outcome');
  assert.equal(uncertain.capacityReserved, true);
  assert.equal(reopened.admitNext(), null);
  assert.throws(() => reopened.transition(uncertain.id, uncertain.ownerToken, uncertain.version, 'reconciliation-required', undefined, true), /Invalid run transition|retain capacity/);
  reopened.transition(uncertain.id, uncertain.ownerToken, uncertain.version, 'failed', 'synthetic confirmed idle', true);
  assert.equal(reopened.admitNext().id, 'second');
  assert.throws(() => f.enqueue(reopened, project, 'reuse', { worktreePath: admitted.worktreePath }));
});

test('owner and version guards enforce explicit transitions without implicit capacity release', async t => {
  const { store, run } = await admitFixture(t);
  assert.throws(() => store.transition(run.id, 'other-owner', run.version, 'running'), /owner/);
  assert.throws(() => store.transition(run.id, run.ownerToken, run.version + 1, 'running'), /version/);
  assert.throws(() => store.transition(run.id, run.ownerToken, run.version, 'succeeded', undefined, true), /Invalid run transition/);
  assert.throws(() => store.transition(run.id, run.ownerToken, run.version, 'running', undefined, true), /retain capacity/);
  const running = store.transition(run.id, run.ownerToken, run.version, 'running');
  assert.equal(running.version, run.version + 1);
  assert.equal(running.capacityReserved, true);
  assert.throws(() => store.transition(run.id, run.ownerToken, run.version, 'failed'), /version/);
  const uncertain = store.transition(run.id, run.ownerToken, running.version, 'reconciliation-required');
  assert.equal(uncertain.capacityReserved, true);
  const failed = store.transition(run.id, run.ownerToken, uncertain.version, 'failed', undefined, true);
  assert.equal(failed.capacityReserved, false);
  assert.throws(() => store.transition(run.id, run.ownerToken, failed.version, 'running'), /Invalid run transition/);
});

test('native binding is immutable and checkpoint/receipt writes retain the admission version', async t => {
  const { store, run } = await admitFixture(t);
  const start = binding(run);
  assert.throws(() => store.bindStart(run.id, run.ownerToken, { ...start, sessionID: 'wrong-parent' }), /persisted parent/);
  assert.throws(() => store.bindStart(run.id, run.ownerToken, { ...start, agent: 'executor' }), /adr-orchestrator/);
  const bound = store.bindStart(run.id, run.ownerToken, start);
  assert.notEqual(bound.binding.messageID, run.promptMessageId, 'native tool identity is the assistant message, not the submitted user prompt');
  assert.equal(bound.version, run.version);
  const eventCount = store.events().length;
  assert.deepEqual(store.bindStart(run.id, run.ownerToken, start), bound);
  assert.equal(store.events().length, eventCount);
  assert.throws(() => store.bindStart(run.id, run.ownerToken, { ...start, id: 'different-call' }), /different native/);
  const state = checkpoint(run);
  assert.throws(() => store.saveCheckpoint(run.id, run.ownerToken, { ...state, id: 'another-run' }), /bound/);
  assert.throws(() => store.saveCheckpoint(run.id, run.ownerToken, { ...state, parent: 'another-parent' }), /bound/);
  assert.throws(() => store.saveCheckpoint(run.id, run.ownerToken, { ...state, caller: { ...start, id: 'another-call' } }), /caller/);
  store.saveCheckpoint(run.id, run.ownerToken, state);
  const receipt = { ...state.attempt, response: { status: 'planned', synthetic: true } };
  assert.equal(store.readReceipt(run.id, run.ownerToken, receipt.id), undefined);
  store.writeReceipt(run.id, run.ownerToken, receipt);
  const receiptEvents = store.events().length;
  store.writeReceipt(run.id, run.ownerToken, { response: receipt.response, ...state.attempt });
  assert.equal(store.events().length, receiptEvents);
  assert.deepEqual(store.readReceipt(run.id, run.ownerToken, receipt.id), receipt);
  assert.throws(() => store.writeReceipt(run.id, run.ownerToken, { ...receipt, response: { changed: true } }), /immutable/);
  assert.throws(() => store.writeReceipt(run.id, run.ownerToken, { ...receipt, id: 'another-attempt' }), /checkpoint attempt/);
  assert.throws(() => store.readReceipt(run.id, 'another-owner', receipt.id), /owner/);
  assert.equal(store.getRun(run.id).version, run.version);
  assert.deepEqual(store.getRun(run.id).checkpoint, state);
});

test('resume preserves first binding and receipts while rotating message and admission owner', async t => {
  const { store, run } = await admitFixture(t, 1);
  const start = binding(run);
  store.bindStart(run.id, run.ownerToken, start);
  const state = checkpoint(run);
  state.status = 'paused';
  store.saveCheckpoint(run.id, run.ownerToken, state);
  const receipt = { ...state.attempt, response: { status: 'blocked', reason: 'synthetic blocker' } };
  store.writeReceipt(run.id, run.ownerToken, receipt);
  assert.throws(() => store.queueResume(run.id, 'synthetic resolution'), /released paused/);
  let running = store.transition(run.id, run.ownerToken, run.version, 'running');
  let paused = store.transition(run.id, run.ownerToken, running.version, 'paused', 'synthetic blocker', true);
  assert.throws(() => store.saveCheckpoint(run.id, run.ownerToken, state), /capacity reservation/);
  assert.throws(() => store.readReceipt(run.id, run.ownerToken, receipt.id), /capacity reservation/);
  const queued = store.queueResume(run.id, 'synthetic resolution');
  assert.equal(queued.status, 'queued');
  assert.equal(queued.launchAction, 'resume');
  assert.equal(queued.ownerToken, null);
  assert.equal(queued.parentSessionId, run.parentSessionId);
  assert.notEqual(queued.promptMessageId, run.promptMessageId);
  assert.deepEqual(queued.binding, start);
  assert.equal(queued.resolution, 'synthetic resolution');
  assert.equal(queued.version, paused.version + 1);
  const resumed = store.admitNext();
  assert.equal(resumed.status, 'running');
  assert.notEqual(resumed.ownerToken, run.ownerToken);
  assert.equal(resumed.version, queued.version + 1);
  assert.throws(() => store.saveCheckpoint(run.id, run.ownerToken, state), /owner/);
  assert.throws(() => store.transition(run.id, run.ownerToken, resumed.version, 'paused'), /owner/);
  assert.throws(() => store.writeReceipt(run.id, run.ownerToken, receipt), /owner/);
  assert.deepEqual(store.readReceipt(run.id, resumed.ownerToken, receipt.id), receipt);
  const resumedCaller = { ...start, id: 'new-native-call', messageID: 'new-assistant-message' };
  assert.throws(() => store.bindStart(run.id, resumed.ownerToken, resumedCaller), /different native/);
  const resumedState = { ...state, status: 'running', caller: resumedCaller };
  assert.throws(() => store.saveCheckpoint(run.id, resumed.ownerToken, resumedState), /claimed resume admission/);
  assert.equal(store.bindResume(run.id, resumed.ownerToken, resumedCaller), true);
  store.saveCheckpoint(run.id, resumed.ownerToken, resumedState);
  assert.deepEqual(store.getRun(run.id).binding, start);
  assert.deepEqual(store.getRun(run.id).checkpoint.caller, resumedCaller);
  assert.equal(store.getRun(run.id).version, resumed.version);
});

test('one resume caller consumes each admission, including a second pause and a subsequent admission', async t => {
  const { store, run, open } = await admitFixture(t, 1);
  const original = binding(run);
  assert.throws(() => store.bindResume(run.id, run.ownerToken, original), /not an explicit resume/);
  store.bindStart(run.id, run.ownerToken, original);
  const state = { ...checkpoint(run), status: 'paused' };
  store.saveCheckpoint(run.id, run.ownerToken, state);
  let current = store.transition(run.id, run.ownerToken, run.version, 'running');
  current = store.transition(current.id, current.ownerToken, current.version, 'paused', undefined, true);
  store.queueResume(run.id, 'First explicit resolution');
  const resumed = store.admitNext();
  const caller = { ...original, id: 'resume-call-one', messageID: 'resume-assistant-one' };
  assert.equal(resumed.launchIntent, false);
  assert.equal(resumed.resumeBinding, null);
  assert.throws(() => store.bindResume(run.id, resumed.ownerToken, { ...caller, sessionID: 'different-parent' }), /persisted parent/);
  assert.throws(() => store.bindResume(run.id, resumed.ownerToken, { ...caller, agent: 'executor' }), /adr-orchestrator/);
  assert.equal(store.bindResume(run.id, resumed.ownerToken, caller), true);
  assert.equal(open().bindResume(run.id, resumed.ownerToken, caller), false);
  assert.throws(() => store.bindResume(run.id, resumed.ownerToken, { ...caller, id: 'second-tool-call' }), /different native tool call/);
  store.saveCheckpoint(run.id, resumed.ownerToken, { ...state, caller });
  assert.equal(store.bindResume(run.id, resumed.ownerToken, caller), false, 'another pause does not renew the same approval');
  assert.throws(() => store.saveCheckpoint(run.id, resumed.ownerToken, { ...state, caller: { ...caller, id: 'second-tool-call' } }), /claimed resume admission/);
  assert.equal(store.getRun(run.id).version, resumed.version);
  assert.deepEqual(store.getRun(run.id).binding, original);
  current = store.transition(run.id, resumed.ownerToken, resumed.version, 'paused', undefined, true);
  const queued = store.queueResume(run.id, 'Second explicit resolution');
  assert.equal(queued.resumeBinding, null);
  assert.equal(queued.launchIntent, false);
  assert.throws(() => store.bindResume(run.id, resumed.ownerToken, caller), /owner/);
  const next = store.admitNext();
  const nextCaller = { ...caller, id: 'resume-call-two', messageID: 'resume-assistant-two' };
  assert.notEqual(next.ownerToken, resumed.ownerToken);
  assert.equal(store.bindResume(run.id, next.ownerToken, nextCaller), true);
  assert.equal(store.bindResume(run.id, next.ownerToken, nextCaller), false);
  assert.throws(() => store.bindResume(run.id, resumed.ownerToken, nextCaller), /owner/);
});

test('launch intent is durable and unversioned; failed-preparation release checks it atomically', async t => {
  const { store, run, project, enqueue, open } = await admitFixture(t, 1);
  enqueue(store, project, 'next-run');
  assert.equal(run.launchIntent, false);
  assert.throws(() => store.markLaunchIntent(run.id, 'other-owner'), /owner/);
  let uncertain = store.transition(run.id, run.ownerToken, run.version, 'reconciliation-required');
  const observedVersion = uncertain.version;
  const competing = open();
  competing.markLaunchIntent(run.id, run.ownerToken);
  assert.equal(store.getRun(run.id).launchIntent, true);
  assert.equal(store.getRun(run.id).version, observedVersion);
  const events = store.events().length;
  store.markLaunchIntent(run.id, run.ownerToken);
  assert.equal(store.events().length, events, 'replayed intent does not add a duplicate event');
  assert.throws(() => store.failBeforeLaunch(run.id, run.ownerToken, observedVersion), /idle proof/);
  assert.equal(store.getRun(run.id).capacityReserved, true);
  assert.equal(store.admitNext(), null);
  store.transition(run.id, run.ownerToken, observedVersion, 'failed', 'synthetic idle proof', true);
  const next = store.admitNext();
  assert.equal(next.launchIntent, false);
  assert.throws(() => store.failBeforeLaunch(next.id, next.ownerToken, next.version), /explicit reconciliation/);
  uncertain = store.transition(next.id, next.ownerToken, next.version, 'reconciliation-required');
  assert.throws(() => store.failBeforeLaunch(next.id, 'other-owner', uncertain.version), /owner/);
  assert.throws(() => store.failBeforeLaunch(next.id, next.ownerToken, uncertain.version + 1), /version/);
  const failed = store.failBeforeLaunch(next.id, next.ownerToken, uncertain.version, 'No native operation began');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.capacityReserved, false);
  assert.equal(failed.launchIntent, false);
  assert.equal(failed.version, uncertain.version + 1);
  assert.throws(() => competing.markLaunchIntent(next.id, next.ownerToken), /capacity reservation/);
  assert.throws(() => enqueue(store, project, 'reuse-failed', { worktreePath: next.worktreePath }));
});

test('schema-v1 upgrade conservatively preserves old native intent and consumes an active resume caller', async t => {
  const { store, run, project, enqueue, databasePath, open } = await admitFixture(t, 1);
  store.bindStart(run.id, run.ownerToken, binding(run));
  const state = { ...checkpoint(run), status: 'paused' };
  store.saveCheckpoint(run.id, run.ownerToken, state);
  let current = store.transition(run.id, run.ownerToken, run.version, 'running');
  current = store.transition(run.id, run.ownerToken, current.version, 'paused', undefined, true);
  store.queueResume(run.id, 'Synthetic resolution');
  const resumed = store.admitNext();
  const caller = { ...binding(run), id: 'old-resume-call', messageID: 'old-resume-assistant' };
  store.bindResume(run.id, resumed.ownerToken, caller);
  store.saveCheckpoint(run.id, resumed.ownerToken, { ...state, caller });
  enqueue(store, project, 'never-admitted');
  store.close();
  const old = new DatabaseSync(databasePath);
  old.exec('ALTER TABLE runs DROP COLUMN resume_binding_json; ALTER TABLE runs DROP COLUMN launch_intent; PRAGMA user_version = 1');
  old.close();
  const upgraded = open();
  const migrated = upgraded.getRun(run.id);
  assert.equal(migrated.launchIntent, true);
  assert.equal(migrated.capacityReserved, true);
  assert.equal(migrated.ownerToken, resumed.ownerToken);
  assert.equal(migrated.version, resumed.version);
  assert.deepEqual(migrated.resumeBinding, caller);
  assert.equal(upgraded.bindResume(run.id, resumed.ownerToken, caller), false);
  assert.throws(() => upgraded.bindResume(run.id, resumed.ownerToken, { ...caller, id: 'different-call' }), /different native tool call/);
  assert.equal(upgraded.getRun('never-admitted').launchIntent, false);
  assert.equal(upgraded.getRun('never-admitted').resumeBinding, null);
  assert.equal(upgraded.admitNext(), null);
});

test('events are durable, ordered, cursor-based and omit submission text, responses and owner tokens', async t => {
  const { store, run, open } = await admitFixture(t);
  store.bindStart(run.id, run.ownerToken, binding(run));
  const state = checkpoint(run);
  store.saveCheckpoint(run.id, run.ownerToken, state);
  store.writeReceipt(run.id, run.ownerToken, { ...state.attempt, response: 'synthetic-private-response' });
  const events = store.events();
  assert.ok(events.every((event, index) => index === 0 || events[index - 1].sequence < event.sequence));
  assert.deepEqual(open().events(), events);
  const after = events[1].sequence;
  assert.deepEqual(store.events(after), events.filter(event => event.sequence > after));
  const text = JSON.stringify(events);
  for (const excluded of ['synthetic-private-feature', 'synthetic-private-prompt', 'synthetic-private-response', run.ownerToken]) assert.ok(!text.includes(excluded));
  const saved = events.find(event => event.type === 'checkpoint.saved');
  assert.deepEqual(saved.payload.usage, { reported: 42, uncached: 21 });
  assert.throws(() => store.events(-1), /cursor/);
});

test('event pages are bounded and their sequence cursors preserve every committed event', async t => {
  const f = await fixture(t);
  const store = f.open();
  const project = store.registerProject(await f.project('project'));
  for (let index = 0; index < 502; index++) f.enqueue(store, project, 'paged-' + index);
  const first = store.events();
  assert.equal(first.length, 500);
  const second = store.events(first.at(-1).sequence);
  assert.equal(second.length, 3);
  assert.equal(new Set([...first, ...second].map(event => event.sequence)).size, 503);
  assert.ok(second.every(event => event.sequence > first.at(-1).sequence));
  assert.deepEqual(store.events(second.at(-1).sequence), []);
});

const SECRET = 'sk-live-REPORT-SECRET-0123456789';

function recoveryOf(overrides = {}) {
  return {
    phase: 'executor', index: 0, taskId: 'T1', child: 'synthetic-child', corrections: 1, mode: 'paused', originalAttemptId: 'attempt-1',
    attempts: ['attempt-2'],
    diagnostic: { code: 'report_format', missingFields: ['handoff'], gateIds: ['G2'] },
    ...overrides,
  };
}

test('checkpoint.saved carries only bounded report info and never reasons, replies, secrets or capabilities', async t => {
  const { store, run: admitted } = await admitFixture(t);
  const run = store.transition(admitted.id, admitted.ownerToken, admitted.version, 'running');
  store.bindStart(run.id, run.ownerToken, binding(run));
  const state = {
    ...checkpoint(run), status: 'running', phase: 'executor', reason: 'reason text ' + SECRET,
    reportRecovery: recoveryOf({
      mode: 'correcting', corrections: 1,
      reason: 'raw reason ' + SECRET, rawReply: 'raw reply ' + SECRET, ownerToken: SECRET, capability: SECRET, token: SECRET,
      diagnostic: {
        code: 'report_format', reason: 'diagnostic reason ' + SECRET, reply: SECRET, detail: SECRET,
        missingFields: ['handoff', SECRET, 'evidence', 'password', 'handoff'],
        gateIds: ['G2', 'G10', SECRET, 'g3', 'G0', 'G1; rm -rf', 7, null],
      },
    }),
  };
  store.saveCheckpoint(run.id, run.ownerToken, state);
  const saved = store.events().filter(event => event.type === 'checkpoint.saved').at(-1);
  assert.deepEqual(saved.payload.report, { mode: 'correcting', corrections: 1, limit: 2, code: 'report_format', missingFields: ['handoff', 'evidence'], gateIds: ['G2', 'G10'] });
  assert.deepEqual(Object.keys(saved.payload).sort(), ['child', 'index', 'phase', 'report', 'status', 'usage']);
  const text = JSON.stringify(store.events());
  for (const excluded of [SECRET, 'raw reason', 'raw reply', 'diagnostic reason', 'ownerToken', 'capability', 'rawReply']) assert.ok(!text.includes(excluded), excluded);
  // Statuses are untouched: the run stays running with its capacity reserved while correcting.
  const stored = store.getRun(run.id);
  assert.equal(stored.status, 'running');
  assert.equal(stored.capacityReserved, true);
});

test('checkpoint.saved drops unknown codes and modes, clamps the counter and omits report info without a record', async t => {
  const { store, run: admitted } = await admitFixture(t);
  const run = store.transition(admitted.id, admitted.ownerToken, admitted.version, 'running');
  store.bindStart(run.id, run.ownerToken, binding(run));
  const events = () => store.events().filter(event => event.type === 'checkpoint.saved');
  store.saveCheckpoint(run.id, run.ownerToken, checkpoint(run));
  assert.equal('report' in events().at(-1).payload, false);
  store.saveCheckpoint(run.id, run.ownerToken, { ...checkpoint(run), reportRecovery: recoveryOf({ corrections: 99, diagnostic: { code: 'made_up ' + SECRET, missingFields: 'handoff', gateIds: 'G1' } }) });
  assert.deepEqual(events().at(-1).payload.report, { mode: 'paused', corrections: 2, limit: 2, code: null, missingFields: [], gateIds: [] });
  store.saveCheckpoint(run.id, run.ownerToken, { ...checkpoint(run), reportRecovery: recoveryOf({ mode: 'bogus', corrections: -3 }) });
  assert.equal('report' in events().at(-1).payload, false);
  store.saveCheckpoint(run.id, run.ownerToken, { ...checkpoint(run), reportRecovery: 'not a record' });
  assert.equal('report' in events().at(-1).payload, false);
  const gates = Array.from({ length: 80 }, (_, index) => 'G' + (index + 1));
  store.saveCheckpoint(run.id, run.ownerToken, { ...checkpoint(run), reportRecovery: recoveryOf({ diagnostic: { code: 'correction_exhausted', gateIds: gates } }) });
  assert.equal(events().at(-1).payload.report.gateIds.length, 50);
  assert.equal(store.getRun(run.id).status, 'running');
});
