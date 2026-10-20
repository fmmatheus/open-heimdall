import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { CoordinatorStore } from '../dist/coordinator/store.js';
import { CoordinatorError } from '../dist/coordinator/errors.js';
import { contractDigest, contractRef } from '../dist/workflow/contracts.js';
import { openSubmissionBinding, recordDispatchPrompt } from '../dist/workflow/submission-store.js';

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
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 4);
    const tables = db.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    assert.equal(tables.length, 9);
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

test('the recorded runtime identity is set once for new runs and an existing run is never given or stripped of one', async t => {
  const recorded = { packageVersion: '1.2.3', protocol: 'structured-v1', build: { packageName: '@fake/core', digest: 'a'.repeat(64) } };
  const fresh = await admitFixture(t);
  fresh.store.bindStart(fresh.run.id, fresh.run.ownerToken, binding(fresh.run));
  const first = { ...checkpoint(fresh.run), runtime: recorded };
  fresh.store.saveCheckpoint(fresh.run.id, fresh.run.ownerToken, first);
  fresh.store.saveCheckpoint(fresh.run.id, fresh.run.ownerToken, { ...first, status: 'paused', runtime: structuredClone(recorded) });
  assert.throws(() => fresh.store.saveCheckpoint(fresh.run.id, fresh.run.ownerToken, { ...first, runtime: { ...recorded, packageVersion: '9.9.9' } }), /runtime identity is immutable/);
  assert.throws(() => fresh.store.saveCheckpoint(fresh.run.id, fresh.run.ownerToken, { ...first, runtime: undefined }), /runtime identity is immutable/);
  assert.deepEqual(fresh.store.getRun(fresh.run.id).checkpoint.runtime, recorded);
  const legacy = await admitFixture(t);
  legacy.store.bindStart(legacy.run.id, legacy.run.ownerToken, binding(legacy.run));
  legacy.store.saveCheckpoint(legacy.run.id, legacy.run.ownerToken, checkpoint(legacy.run));
  assert.throws(() => legacy.store.saveCheckpoint(legacy.run.id, legacy.run.ownerToken, { ...checkpoint(legacy.run), runtime: recorded }), /runtime identity is immutable/);
  assert.equal(Object.hasOwn(legacy.store.getRun(legacy.run.id).checkpoint, 'runtime'), false, 'an existing run is not retroactively claimed');
});

test('a checkpoint from a stale view can never erase a seal, conflict, outcome or refusal of the active attempt, nor lower its repair counter', async t => {
  const { store, run } = await admitFixture(t);
  store.bindStart(run.id, run.ownerToken, binding(run));
  const base = checkpoint(run);
  const attemptId = base.attempt.id;
  const record = (extra = {}) => ({ phase: 'planner', index: 0, child: base.child, repairs: 1, attempts: [attemptId], ...extra });
  const held = { ...base, submissionRepair: record() };
  store.saveCheckpoint(run.id, run.ownerToken, held);
  const markers = {
    sealed: { attemptId },
    conflict: { attemptId, kind: 'parallel', tool: 'edit' },
    negative: { attemptId, outcome: 'blocked', gateIds: [], fields: [] },
    refused: { attemptId, code: 'unavailable', reason: 'synthetic' },
  };
  for (const [name, marker] of Object.entries(markers)) {
    const durable = { ...base, submissionRepair: record({ [name]: marker }) };
    store.saveCheckpoint(run.id, run.ownerToken, durable);
    // The stale view still holds the pre-marker record and tries to persist it.
    assert.throws(() => store.saveCheckpoint(run.id, run.ownerToken, held), new RegExp('drop the ' + name + ' marker'));
    assert.throws(() => store.saveCheckpoint(run.id, run.ownerToken, { ...base, submissionRepair: undefined }), /drop the .* marker|drop the repair record/);
    assert.deepEqual(store.getRun(run.id).checkpoint.submissionRepair, durable.submissionRepair, 'the refused checkpoint changed nothing');
    // Not a regression: the same record rewritten, a higher counter, and a fresh attempt that supersedes the old one.
    store.saveCheckpoint(run.id, run.ownerToken, { ...durable, status: 'paused' });
    store.saveCheckpoint(run.id, run.ownerToken, { ...base, submissionRepair: record({ [name]: marker, repairs: 2 }) });
    assert.throws(() => store.saveCheckpoint(run.id, run.ownerToken, durable), /lower the repair counter from 2 to 1/);
    store.saveCheckpoint(run.id, run.ownerToken, { ...base, attempt: { ...base.attempt, id: 'fresh-' + name }, submissionRepair: record({ repairs: 2 }) });
    store.saveCheckpoint(run.id, run.ownerToken, { ...base, attempt: { ...base.attempt, status: 'rejected' }, submissionRepair: record({ [name]: marker, repairs: 2 }) });
    store.saveCheckpoint(run.id, run.ownerToken, { ...base, attempt: { ...base.attempt, status: 'rejected' }, submissionRepair: record({ repairs: 2 }) });
    // Reset for the next marker: advancing to another task clears the record.
    store.saveCheckpoint(run.id, run.ownerToken, { ...base, index: 1, attempt: { ...base.attempt, index: 1 } });
    store.saveCheckpoint(run.id, run.ownerToken, { ...held, index: 0 });
    store.saveCheckpoint(run.id, run.ownerToken, held);
  }
  // The same transition guard accepts real advancement: the record is dropped together with the task moving on.
  store.saveCheckpoint(run.id, run.ownerToken, { ...base, submissionRepair: record({ sealed: markers.sealed }) });
  store.saveCheckpoint(run.id, run.ownerToken, { ...base, phase: 'executor', attempt: undefined });
  assert.equal(store.getRun(run.id).checkpoint.submissionRepair, undefined);
});

// --- Schema v4: durable approval requests and owner decisions -------------------------------------------------------------

const revision = { head: 'b'.repeat(40), digest: 'c'.repeat(64) };
const approvalPayload = overrides => ({
  status: 'approval-required', question: 'Ship the change?', scope: 'Merge only the reviewed commit', completedWork: 'Implemented and tested',
  verification: ['npm test: 12 passed'], artifacts: ['src/a.ts'], onApprove: ['Merge the branch'], onRequestChanges: ['Correct and ask again'], ...overrides,
});
/** A structured executor checkpoint with an open submission binding for task T1, attempt `attempt-1`. */
function structuredCheckpoint(run, overrides = {}) {
  const state = {
    ...checkpoint(run), protocol: 'structured-v1', phase: 'executor', child: 'child-session',
    tasks: [{ id: 'T1', title: 'Synthetic task', brief: 'Do it', dependsOn: [], dod: ['gate one'] }],
    attempt: { id: 'attempt-1', phase: 'executor', index: 0, child: 'child-session', status: 'admitted', startedAt: 1000, model: 'anthropic/executor' },
    ...overrides,
  };
  state.submissionBinding = recordDispatchPrompt(openSubmissionBinding(state, 1), 'prompt-1');
  return state;
}
function approvalReceipt(run, state, payload = approvalPayload(), overrides = {}) {
  const canonical = { ...payload, taskId: 'T1' };
  const contract = contractRef('executor-result');
  return {
    receiptVersion: 1, protocol: 'structured-v1', contract, kind: 'executor-result', runId: run.id, phase: 'executor', index: 0, taskId: 'T1',
    attemptId: 'attempt-1', dispatch: 1, parent: state.parent, child: 'child-session', origin: 'prompt-1',
    caller: { sessionID: 'child-session', agent: 'executor', messageID: 'm1', callId: 'c1' }, runtime: { packageVersion: '0.0.0', protocol: 'structured-v1' },
    outcome: 'approval-required', rawPayload: payload, canonical, digest: contractDigest(contract, canonical), acceptedAt: 1, ...overrides,
  };
}
async function approvalFixture(t, payload) {
  const f = await admitFixture(t);
  f.store.bindStart(f.run.id, f.run.ownerToken, binding(f.run));
  const state = structuredCheckpoint(f.run);
  f.store.saveCheckpoint(f.run.id, f.run.ownerToken, state);
  f.run = f.store.transition(f.run.id, f.run.ownerToken, f.run.version, 'running');
  const receipt = approvalReceipt(f.run, state, payload);
  f.store.writeSubmission(f.run.id, f.run.ownerToken, receipt, revision);
  const request = f.store.latestApproval(f.run.id);
  return { ...f, state, receipt, request };
}
/** Mirrors the runner's pause on a valid approval request. */
function pauseOnApproval(f) {
  const paused = { ...f.state, status: 'paused', attempt: { ...f.state.attempt, status: 'rejected' }, wait: { kind: 'approval', attemptId: 'attempt-1', index: 0, taskId: 'T1' } };
  f.store.saveCheckpoint(f.run.id, f.run.ownerToken, paused);
  const current = f.store.getRun(f.run.id);
  f.store.transition(f.run.id, f.run.ownerToken, current.version, 'paused', undefined, true);
  return paused;
}
const rows = (db, table) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }));

test('a v3 database migrates to v4 additively, keeping runs, receipts and submissions byte for byte', async t => {
  const f = await approvalFixture(t);
  f.store.writeReceipt(f.run.id, f.run.ownerToken, { ...f.state.attempt, response: 'synthetic-response' });
  f.store.close();
  const downgrade = new DatabaseSync(f.databasePath);
  downgrade.exec('DROP TABLE approval_requests; DROP TABLE run_responses; PRAGMA user_version = 3');
  const before = Object.fromEntries(['runs', 'receipts', 'submissions', 'events', 'projects', 'worktrees'].map(table => [table, rows(downgrade, table)]));
  downgrade.close();
  assert.ok(before.submissions.length === 1 && before.receipts.length === 1 && before.runs.length === 1);

  const upgraded = f.open();
  assert.equal(upgraded.latestApproval(f.run.id), null, 'no request is invented for old rows');
  upgraded.close();
  const inspect = new DatabaseSync(f.databasePath);
  try {
    assert.equal(inspect.prepare('PRAGMA user_version').get().user_version, 4);
    const names = inspect.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
    assert.ok(names.includes('approval_requests') && names.includes('run_responses'));
    for (const [table, expected] of Object.entries(before)) assert.deepEqual(rows(inspect, table), expected, table + ' is untouched by the migration');
    assert.equal(inspect.prepare('SELECT count(*) AS count FROM approval_requests').get().count, 0);
  } finally { inspect.close(); }
  const again = f.open();
  assert.equal(again.getRun(f.run.id).checkpoint.protocol, 'structured-v1');
  assert.deepEqual(again.readSubmission(f.run.id, f.run.ownerToken, 'attempt-1', 'executor-result'), f.receipt);
});

test('a pending request and an answered response survive closing and reopening the database', async t => {
  const f = await approvalFixture(t);
  pauseOnApproval(f);
  const pending = f.store.getApproval(f.run.id, f.request.requestId);
  assert.equal(pending.state, 'pending');
  f.store.close();
  const reopened = f.open();
  assert.deepEqual(reopened.getApproval(f.run.id, f.request.requestId), pending);
  assert.equal(reopened.approvalWait(reopened.getRun(f.run.id)).state, 'pending');
  const feedback = 'First line\n\n  second line with trailing space \n';
  const ack = reopened.decideApproval(f.run.id, f.request.requestId, { decision: 'request-changes', feedback }, revision);
  assert.equal(ack.retried, false);
  reopened.close();
  const final = f.open();
  const answered = final.getApproval(f.run.id, f.request.requestId);
  assert.equal(answered.state, 'answered');
  assert.equal(answered.decision, 'request-changes');
  assert.equal(answered.feedback, feedback, 'feedback is stored verbatim');
  assert.equal(answered.continuation, 'pending');
  assert.deepEqual(answered.ack, ack);
  assert.deepEqual(final.decideApproval(f.run.id, f.request.requestId, { decision: 'request-changes', feedback }), { ...ack, retried: true });
});

test('an approval-required submission publishes one request bound to the checkpoint identity and the computed revision', async t => {
  const f = await approvalFixture(t);
  assert.match(f.request.requestId, /^apr_[0-9a-f-]{36}$/);
  assert.deepEqual({ runId: f.request.runId, phase: f.request.phase, taskIndex: f.request.taskIndex, taskId: f.request.taskId, attemptId: f.request.attemptId },
    { runId: f.run.id, phase: 'executor', taskIndex: 0, taskId: 'T1', attemptId: 'attempt-1' });
  assert.deepEqual(f.request.revision, revision);
  const { status: _status, ...content } = approvalPayload();
  assert.deepEqual(f.request.request, content, 'the stored content is the validated request without identity or status');
  assert.equal(f.request.state, 'pending');
  assert.equal(f.request.continuation, 'none');
  assert.equal(f.request.decision, null);
  const events = f.store.events().filter(event => event.type === 'approval.requested');
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.requestId, f.request.requestId);
  assert.ok(!JSON.stringify(events).includes('Ship the change?'), 'events carry no request text');
  // An identical duplicate (new call identity and time) returns the stored receipt and publishes nothing.
  const duplicate = approvalReceipt(f.run, f.state, approvalPayload(), { acceptedAt: 99, caller: { ...f.receipt.caller, callId: 'c2', messageID: 'm2' } });
  assert.deepEqual(f.store.writeSubmission(f.run.id, f.run.ownerToken, duplicate, { head: 'd'.repeat(40), digest: 'e'.repeat(64) }), f.receipt);
  assert.equal(f.store.events().filter(event => event.type === 'approval.requested').length, 1);
  assert.deepEqual(f.store.latestApproval(f.run.id), f.request);
  assert.throws(() => f.store.writeSubmission(f.run.id, f.run.ownerToken, approvalReceipt(f.run, f.state, approvalPayload({ question: 'Other?' })), revision), /immutable/);
});

test('an approval request is rejected whole, with its receipt, when it is not valid, matched and measured', async t => {
  const f = await admitFixture(t);
  f.store.bindStart(f.run.id, f.run.ownerToken, binding(f.run));
  const state = structuredCheckpoint(f.run);
  f.store.saveCheckpoint(f.run.id, f.run.ownerToken, state);
  const write = (receipt, measured = revision) => f.store.writeSubmission(f.run.id, f.run.ownerToken, receipt, measured);
  const forged = payload => {
    const canonical = { ...payload, taskId: 'T1' };
    return approvalReceipt(f.run, state, payload, { canonical, digest: contractDigest(contractRef('executor-result'), canonical) });
  };
  assert.throws(() => f.store.writeSubmission(f.run.id, f.run.ownerToken, approvalReceipt(f.run, state)), /review revision/);
  assert.throws(() => write(approvalReceipt(f.run, state), { head: 'zz', digest: 'c'.repeat(64) }), /review revision/);
  assert.throws(() => write(forged(approvalPayload({ question: 'x'.repeat(4001) }))), /contract/);
  assert.throws(() => write(forged(approvalPayload({ artifacts: [] }))), /contract/);
  assert.throws(() => write(forged({ ...approvalPayload(), decision: 'approve' })), /contract/);
  assert.throws(() => write(approvalReceipt(f.run, state, approvalPayload(), { digest: 'f'.repeat(64) })), /submission/);
  assert.throws(() => write(approvalReceipt(f.run, state, approvalPayload(), { outcome: 'completed' })), /does not match/);
  assert.throws(() => write(approvalReceipt(f.run, state, approvalPayload(), { index: 1 })), /checkpoint attempt/);
  assert.throws(() => write(approvalReceipt(f.run, state, approvalPayload(), { attemptId: 'other-attempt' })), /checkpoint attempt/);
  assert.equal(f.store.readSubmission(f.run.id, f.run.ownerToken, 'attempt-1', 'executor-result'), undefined, 'a refused request leaves no receipt');
  assert.equal(f.store.latestApproval(f.run.id), null);
});

test('only the administrator operation answers a request, once, and only for the current checkpoint attempt', async t => {
  const f = await approvalFixture(t);
  const id = f.request.requestId;
  const decide = (input, measured = revision, run = f.run.id, request = id) => f.store.decideApproval(run, request, input, measured);
  const code = (action, expected) => assert.throws(action, error => error instanceof CoordinatorError && error.code === expected && error.status === (expected === 'approval-not-found' ? 404 : 409));
  code(() => decide({ decision: 'approve' }, revision, 'another-run'), 'approval-not-found');
  code(() => decide({ decision: 'approve' }, revision, f.run.id, 'apr_missing'), 'approval-not-found');
  assert.throws(() => decide({ decision: 'maybe' }), /approve or request-changes/);
  assert.throws(() => f.store.decideApproval(f.run.id, id, { decision: 'approve' }), /review revision/);
  const events = f.store.events().length;
  const ack = decide({ decision: 'approve' });
  assert.deepEqual(ack, { runId: f.run.id, requestId: id, decision: 'approve', recordedAt: ack.recordedAt, retried: false, continuation: 'pending', run: { status: 'running', version: f.run.version } });
  assert.equal(f.store.events().filter(event => event.type === 'approval.answered').length, 1);
  assert.equal(f.store.events().length, events + 1, 'one event is committed with the response');
  assert.deepEqual(decide({ decision: 'approve' }, undefined), { ...ack, retried: true });
  code(() => decide({ decision: 'request-changes', feedback: 'no' }), 'approval-conflict');
  assert.equal(f.store.getApproval(f.run.id, id).decision, 'approve', 'a refused response changes nothing');
  assert.equal(f.store.getApproval(f.run.id, id).feedback, null);
  assert.equal(f.store.events().filter(event => event.type === 'approval.answered').length, 1);
});

test('a moved checkpoint or a changed revision supersedes the request and records nothing', async t => {
  for (const [name, change] of [
    ['revision head', (f) => ({ revision: { ...revision, head: 'd'.repeat(40) } })],
    ['revision digest', (f) => ({ revision: { ...revision, digest: 'd'.repeat(64) } })],
    ['task index', (f) => { f.store.saveCheckpoint(f.run.id, f.run.ownerToken, { ...f.state, index: 1, tasks: [...f.state.tasks, { ...f.state.tasks[0], id: 'T2' }] }); return {}; }],
    ['paused without the wait', (f) => { f.store.saveCheckpoint(f.run.id, f.run.ownerToken, { ...f.state, status: 'paused' }); return {}; }],
  ]) {
    const f = await approvalFixture(t);
    const measured = { revision, ...change(f) }.revision;
    assert.throws(() => f.store.decideApproval(f.run.id, f.request.requestId, { decision: 'approve' }, measured), error => error instanceof CoordinatorError && error.code === 'approval-stale', name);
    const stored = f.store.getApproval(f.run.id, f.request.requestId);
    assert.equal(stored.state, 'superseded', name);
    assert.equal(stored.decision, null, name);
    assert.equal(stored.ack, null, name);
    assert.ok(stored.supersededReason, name);
    assert.ok(f.store.events().some(event => event.type === 'approval.superseded'), name);
    // A superseded request can never be answered later, even with the original revision.
    assert.throws(() => f.store.decideApproval(f.run.id, f.request.requestId, { decision: 'approve' }, revision), error => error.code === 'approval-stale', name);
    f.store.close();
  }
});

test('a newer request supersedes an older pending one and the generic resume guard follows the unresolved request', async t => {
  const f = await approvalFixture(t);
  const paused = pauseOnApproval(f);
  const guard = action => assert.throws(action, error => error instanceof CoordinatorError && error.code === 'approval-pending' && error.status === 409);
  guard(() => f.store.queueResume(f.run.id, 'approve'));
  guard(() => f.store.assertNoUnresolvedApproval(f.run.id));
  assert.equal(f.store.getRun(f.run.id).status, 'paused', 'a refused resume changes nothing');
  f.store.decideApproval(f.run.id, f.request.requestId, { decision: 'request-changes', feedback: 'Please revise' }, revision);
  guard(() => f.store.queueResume(f.run.id, 'approve'));
  // Once the continuation is consumed (a later task), the run may be resumed by guidance again.
  const db = new DatabaseSync(f.databasePath);
  db.prepare("UPDATE approval_requests SET continuation = 'consumed' WHERE request_id = ?").run(f.request.requestId);
  db.close();
  f.store.assertNoUnresolvedApproval(f.run.id);
  assert.equal(f.store.queueResume(f.run.id, 'Use guidance').status, 'queued');
  assert.equal(paused.status, 'paused');
});

test('the wait projection is bounded and clipped, and carries no capability, key or specification', async t => {
  const long = 'é'.repeat(2000);
  const f = await approvalFixture(t, approvalPayload({
    question: long, scope: long, completedWork: 'short', verification: Array.from({ length: 20 }, (_, index) => `check ${index} ` + 'é'.repeat(450)),
    artifacts: ['a.txt'], onApprove: ['😀'.repeat(300)], onRequestChanges: ['fix'],
  }));
  pauseOnApproval(f);
  const wait = f.store.approvalWait(f.store.getRun(f.run.id));
  assert.equal(wait.kind, 'approval');
  assert.equal(wait.requestId, f.request.requestId);
  assert.equal(wait.state, 'pending');
  assert.equal(wait.taskTitle, 'Synthetic task');
  assert.equal(wait.taskIndex, 0);
  assert.equal(wait.question.length, 1500);
  assert.equal(wait.clipped.question, true);
  assert.equal(wait.clipped.scope, true);
  assert.equal(wait.clipped.completedWork, false);
  assert.equal(wait.completedWork, 'short');
  assert.equal(wait.verification.length, 10);
  assert.ok(wait.verification.every(entry => entry.length <= 400));
  assert.equal(wait.clipped.verification, true);
  assert.equal(wait.clipped.artifacts, false);
  assert.equal(wait.clipped.onApprove, true);
  assert.ok(!wait.onApprove[0].endsWith('\ud83d'), 'a clip never splits a surrogate pair');
  assert.equal(wait.response, null);
  assert.deepEqual(wait.revision, revision);
  const feedback = 'f'.repeat(4000);
  f.store.decideApproval(f.run.id, f.request.requestId, { decision: 'request-changes', feedback }, revision);
  const answered = f.store.approvalWait(f.store.getRun(f.run.id));
  assert.equal(answered.state, 'answered');
  assert.equal(answered.continuation, 'pending');
  assert.equal(answered.response.decision, 'request-changes');
  assert.equal(answered.response.feedback.length, 1500);
  assert.equal(answered.clipped.feedback, true);
  assert.ok(Buffer.byteLength(JSON.stringify(answered)) < 24 * 1024, 'the projection stays far below the 32 KiB request and the stored full text');
  const text = JSON.stringify(answered);
  for (const secret of [f.run.ownerToken, 'synthetic-private-prompt', 'synthetic-executor-prompt', 'specification', 'ownerToken']) assert.ok(!text.includes(secret), secret);
});
