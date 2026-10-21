import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadCoordinatorConfiguration } from '../dist/coordinator/config.js';
import { startCoordinatorService } from '../dist/coordinator/service.js';
import { createCoordinatorAdapter } from '../dist/extension/service/coordinator.js';
import { createExtensionServer, listenExtensionServer } from '../dist/extension/service/server.js';
import { ACTION_NOTICES, createPanelStore } from '../dist/extension/panel/store.js';
import { waitCard } from '../dist/extension/panel/view-model.js';
import { createPanelClient } from '../dist/extension/panel/client.js';
import { readCoordinatorToken } from '../dist/coordinator/token.js';
import { APPROVAL_FULL_LIMITS } from '../dist/extension/shared/protocol.js';
import { approvalContentDigest } from '../dist/extension/shared/approval-digest.js';
import { APPROVAL_DETAIL_NOTICES } from '../dist/extension/panel/approval-details.js';
import { mountCard } from './fixtures/fake-card-dom.mjs';
import { CANONICAL, COMPACT, hiddenTailRequest, nearLimitRequest } from './fixtures/approval-requests.mjs';

/*
 * The real panel store (the code behind the card's buttons) talks to the real extension service over HTTP with its service
 * token; the service talks to an isolated coordinator over its socket with the coordinator key. Nothing is faked between
 * the button handler and the coordinator's database, except the host hop, which only records and can lose a response.
 */

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const SERVICE_TOKEN = 'svc-' + 'c0ffee11'.repeat(8);
const settings = { plannerAgent: 'planner', executorAgent: 'executor', plannerModel: 'anthropic/planner', executorModel: 'anthropic/executor', executorFallbackModel: 'kimi/fallback', maxTasks: 10, minQuotaRemainingPercent: 10, tokenLimitsDisabled: true };
const specification = { settings, plannerPrompt: 'Synthetic planner', executorPrompt: 'Synthetic executor', agents: {}, opencode: { baseUrl: 'http://127.0.0.1:9999', passwordEnvironmentVariable: 'SYNTHETIC_PASSWORD' } };
const REVISION = { head: 'a'.repeat(40), digest: 'b'.repeat(64) };
const REQUEST = { question: 'Ship the migration?', scope: 'Only the reviewed commit', completedWork: 'Migration written', verification: ['unit tests pass'], artifacts: ['src/migrate.ts', 'deadbeef1234'], onApprove: ['merge the migration'], onRequestChanges: ['fix and ask again'] };

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition, what) {
  for (let n = 0; n < 500; n++) {
    if (condition()) return;
    await sleep(10);
  }
  assert.fail(`Timed out waiting for ${what}`);
}

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hea-')));
  const configFile = path.join(root, 'coordinator.toml');
  await fs.writeFile(configFile, '[coordinator]\nstateDirectory = "state"\n');
  const configuration = await loadCoordinatorConfiguration(configFile);
  const executor = { async launch() {}, async inspect() { return { idle: true, status: 'paused', reason: 'Paused' }; } };
  const coordinator = await startCoordinatorService({ configuration, executor, pollIntervalMs: 60000, scheduler: { revision: async () => REVISION, verifyWorktree: async () => {}, prepare: async () => {} } });
  await fs.mkdir(path.join(root, 'project', '.git'), { recursive: true });
  await fs.writeFile(path.join(root, 'project', '.heimdall.toml'), '[workflow]\n');
  const project = coordinator.store.registerProject({ directory: path.join(root, 'project'), commonGitDirectory: path.join(root, 'project', '.git'), configPath: path.join(root, 'project', '.heimdall.toml'), concurrency: 9 });
  const server = await listenExtensionServer(createExtensionServer({ token: SERVICE_TOKEN, adapter: createCoordinatorAdapter({ configPath: configFile }), configPath: configFile }), 0);
  t.after(async () => {
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
    await coordinator.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const databasePath = path.join(configuration.stateDirectory, 'coordinator.sqlite');
  const sql = (statement, ...values) => {
    const database = new DatabaseSync(databasePath);
    try { return statement.trimStart().toUpperCase().startsWith('SELECT') ? database.prepare(statement).all(...values) : database.prepare(statement).run(...values); }
    finally { database.close(); }
  };
  let counter = 0;
  const insertRequest = (runId, requestId, attemptId, createdAt, request = REQUEST) => sql(`INSERT INTO approval_requests(run_id, request_id, phase, task_index, task_id, attempt_id, receipt_digest, request_json, revision_json, state, continuation, created_at)
    VALUES (?, ?, 'executor', 0, 'T1', ?, 'digest', ?, ?, 'pending', 'none', ?)`, runId, requestId, attemptId, JSON.stringify(request), JSON.stringify(REVISION), createdAt);
  /** A paused, released, idle run with a pending request (`approval`) or an ordinary blocker. */
  const seed = ({ approval = true, reason = 'Blocked: choose the database', request = REQUEST } = {}) => {
    const id = `run-${++counter}`;
    coordinator.store.enqueue({ id, projectId: project.id, feature: '# Feature\nbody', baseCommit: 'c'.repeat(40), worktreePath: path.join(root, 'worktrees', id), branch: `heimdall/${id}`, specification });
    const run = coordinator.store.admitNext();
    assert.equal(run.id, id);
    const caller = { sessionID: run.parentSessionId, id: `call-${id}`, messageID: `message-${id}`, agent: 'adr-orchestrator' };
    const attempt = { id: `attempt_${id}_1`, phase: 'executor', index: 0, child: 'ses_child', status: 'rejected', startedAt: 1, model: 'anthropic/x' };
    const state = {
      id, status: 'paused', adr: 'feature.md', parent: run.parentSessionId, caller, branch: run.branch, baseline: '', index: 0,
      tasks: [{ id: 'T1', title: 'Migrate data', brief: 'B', dependsOn: [], dod: ['gate'] }], results: [], phase: 'executor', child: 'ses_child', settings, attempt, reason,
      ...(approval ? { wait: { kind: 'approval', attemptId: attempt.id, index: 0, taskId: 'T1' }, protocol: 'structured-v1' } : {}),
    };
    coordinator.store.bindStart(id, run.ownerToken, caller);
    // The request is published before the runner records its pause on it.
    const requestId = approval ? `apr_${id}_1` : undefined;
    if (approval) insertRequest(id, requestId, attempt.id, 1000, request);
    coordinator.store.saveCheckpoint(id, run.ownerToken, state);
    const running = coordinator.store.transition(id, run.ownerToken, run.version, 'running');
    coordinator.store.transition(id, running.ownerToken, running.version, 'paused', reason, true);
    return { id, requestId };
  };
  /** What the agent does after the owner's answer: it resumes, corrects and pauses again with a new request. */
  const republish = (runId, previousRequestId, number, { supersede = false, request = REQUEST } = {}) => {
    const requestId = `apr_${runId}_${number}`;
    const attemptId = `attempt_${runId}_${number}`;
    const row = sql('SELECT checkpoint_json FROM runs WHERE id = ?', runId)[0];
    const checkpoint = JSON.parse(row.checkpoint_json);
    checkpoint.attempt = { ...checkpoint.attempt, id: attemptId };
    checkpoint.wait = { kind: 'approval', attemptId, index: 0, taskId: 'T1' };
    checkpoint.status = 'paused';
    sql("UPDATE runs SET status = 'paused', capacity_reserved = 0, checkpoint_json = ?, version = version + 1 WHERE id = ?", JSON.stringify(checkpoint), runId);
    if (supersede) sql("UPDATE approval_requests SET state = 'superseded', superseded_at = 2, superseded_reason = 'replaced' WHERE run_id = ? AND request_id = ?", runId, previousRequestId);
    else sql("UPDATE approval_requests SET continuation = 'consumed', consumed_attempt_id = ? WHERE run_id = ? AND request_id = ?", attemptId, runId, previousRequestId);
    insertRequest(runId, requestId, attemptId, 1000 + number, request);
    return requestId;
  };
  const approvalRow = requestId => sql('SELECT request_id, state, decision, feedback, continuation FROM approval_requests WHERE request_id = ?', requestId)[0];
  const respondCli = args => new Promise((resolve, reject) => {
    const environment = { ...process.env, HOME: root, HEIMDALL_CONFIG: '' };
    delete environment.HEIMDALL_COORDINATOR_CONFIG;
    const child = spawn(process.execPath, [cli, 'coordinator', ...args, '--coordinator-config', configFile], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
  });
  return { root, coordinator, server, sql, seed, republish, approvalRow, respondCli, stateDirectory: configuration.stateDirectory, port: server.address().port };
}

/** The panel host: forwards a request to the service as OpenChamber does, recording every request. */
function hostFor(f, behavior = {}) {
  const requests = [];
  const host = {
    requests,
    behavior,
    async serviceStatus() { return { status: 'ready' }; },
    async serviceRequest(request) {
      requests.push({ method: request.method, path: request.path, body: request.body === undefined ? undefined : JSON.parse(request.body) });
      if (behavior.offline) throw Object.assign(new Error('offline'), { code: 'HOST_UNAVAILABLE' });
      const completeRead = request.method === 'GET' && /\/approvals\/[^/]+$/.test(request.path);
      // A read of a complete request that waits for the test to release it (read at that moment) or is rewritten on the way back.
      if (completeRead && behavior.gateRead) await behavior.gateRead;
      if (request.method === 'GET' && request.path === behavior.gatedRunDetailPath && behavior.gateRunDetail) await behavior.gateRunDetail;
      const write = request.method === 'POST' && request.path !== '/directories/match';
      if (write && behavior.dropBefore) throw Object.assign(new Error('lost'), { code: 'HOST_TIMEOUT' });
      if (write && behavior.gate) await behavior.gate;
      const result = await new Promise((resolve, reject) => {
        const query = request.query && Object.keys(request.query).length > 0 ? `?${new URLSearchParams(request.query)}` : '';
        const outgoing = http.request({ host: '127.0.0.1', port: f.port, method: request.method, path: request.path + query, headers: { Authorization: `Bearer ${SERVICE_TOKEN}`, 'Content-Type': 'application/json' } }, response => {
          const chunks = [];
          response.on('data', chunk => chunks.push(chunk));
          response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        outgoing.on('error', reject);
        outgoing.end(request.body);
      });
      if (write && behavior.dropAfter) throw Object.assign(new Error('lost'), { code: 'HOST_TIMEOUT' });
      if (completeRead && behavior.rewrite) return behavior.rewrite(request, result) ?? result;
      return result;
    },
  };
  return host;
}

/** The store's timers never fire: the tests drive polling-free, so every read is one the test (or a click) asked for. */
const timers = { setTimeout: () => 0, clearTimeout() {} };

async function open(f, runId, behavior) {
  const host = hostFor(f, behavior);
  const store = createPanelStore({ host, timers });
  t_disposables.push(store);
  store.select(runId);
  await until(() => store.getState().detail?.id === runId, 'the run detail');
  return { host, store };
}
const t_disposables = [];
test.afterEach(() => { for (const store of t_disposables.splice(0)) store.dispose(); });

const posts = host => host.requests.filter(request => request.method === 'POST');
const card = store => waitCard(store.getState().detail, store.getState());
const pollDetail = async store => { store.refreshDetail(); await sleep(60); };

test('approve: the Approve button decides exactly this run and request, once, and the card reports a queued continuation honestly', async t => {
  const f = await fixture(t);
  const target = f.seed();
  const other = f.seed();
  const { host, store } = await open(f, target.id);
  const wait = store.getState().detail.wait;
  assert.equal(wait.kind, 'approval');
  assert.equal(wait.requestId, target.requestId);
  assert.equal(wait.state, 'pending');
  assert.equal(card(store).controls.kind, 'decide');
  assert.equal(card(store).controls.approve.disabled, false);

  const version = store.getState().detail.version;
  assert.equal(await store.decideApproval(target.id, target.requestId, 'approve'), 'recorded');

  assert.deepEqual(posts(host), [{ method: 'POST', path: `/runs/${target.id}/approvals/${target.requestId}/decision`, body: { decision: 'approve', displayedVersion: version } }]);
  assert.equal(f.approvalRow(target.requestId).decision, 'approve');
  assert.equal(f.approvalRow(other.requestId).state, 'pending', 'no other run or request was touched');
  const state = store.getState();
  assert.deepEqual({ runId: state.action.ack.runId, requestId: state.action.ack.requestId, decision: state.action.ack.decision }, { runId: target.id, requestId: target.requestId, decision: 'approve' });
  // The panel read the run again from the coordinator: the answered request and its progress, never "running".
  assert.equal(state.detail.wait.state, 'answered');
  assert.equal(state.detail.wait.response.decision, 'approve');
  const view = card(store);
  assert.equal(view.controls, null);
  assert.equal(view.badge.label, 'Approved');
  assert.equal(state.detail.wait.progress, 'queued');
  assert.match(view.status, /queued and has not started/);
  assert.doesNotMatch(view.status, /executing|running|resumed|completed|finished/i);
  const serialised = JSON.stringify(host.requests);
  assert.equal(serialised.includes(SERVICE_TOKEN), false);
});

test('request changes needs feedback; the feedback reaches the agent verbatim; the corrected fresh request is a new card that supersedes nothing', async t => {
  const f = await fixture(t);
  const { id, requestId } = f.seed();
  const { host, store } = await open(f, id);
  assert.equal(await store.decideApproval(id, requestId, 'request-changes', '   '), 'invalid');
  assert.equal(await store.decideApproval(id, requestId, 'request-changes'), 'invalid');
  assert.match(store.getState().action.notice, /Enter the changes you want/);
  assert.equal(await store.decideApproval(id, requestId, 'request-changes', 'x'.repeat(8001)), 'invalid');
  assert.match(store.getState().action.notice, /within 8000 characters/);
  assert.deepEqual(posts(host), [], 'invalid input is never sent');

  const feedback = '--keep it narrow\nSecond "quoted" line, $HOME and `ticks`';
  assert.equal(await store.decideApproval(id, requestId, 'request-changes', feedback), 'recorded');
  assert.equal(posts(host).length, 1);
  assert.equal(posts(host)[0].path, `/runs/${id}/approvals/${requestId}/decision`);
  assert.equal(posts(host)[0].body.decision, 'request-changes');
  assert.equal(posts(host)[0].body.feedback, feedback);
  assert.deepEqual({ ...f.approvalRow(requestId) }, { request_id: requestId, state: 'answered', decision: 'request-changes', feedback, continuation: 'queued' });
  assert.equal(store.getState().detail.wait.response.feedback, feedback);
  assert.equal(card(store).badge.label, 'Changes requested');
  assert.equal(card(store).fields.find(field => field.label === 'Your feedback').text, feedback);

  // The agent resumed, corrected within the task and asked again: a new request id, pending, on the same run.
  const fresh = f.republish(id, requestId, 2);
  await pollDetail(store);
  const next = store.getState().detail.wait;
  assert.equal(next.requestId, fresh);
  assert.equal(next.state, 'pending');
  assert.notEqual(next.requestId, requestId);
  // The earlier request is history: it can no longer be targeted from the panel.
  assert.equal(await store.decideApproval(id, requestId, 'approve'), 'refreshed');
  assert.equal(posts(host).length, 1, 'no second write for the superseded request');

  assert.equal(await store.decideApproval(id, fresh, 'approve'), 'recorded');
  assert.equal(posts(host).length, 2);
  assert.equal(posts(host)[1].path, `/runs/${id}/approvals/${fresh}/decision`);
  assert.equal(f.approvalRow(fresh).decision, 'approve');
  assert.equal(f.approvalRow(requestId).decision, 'request-changes', 'the earlier decision is unchanged');
});

test('a stale card is refused when a newer request replaced it: nothing is recorded and the panel shows the newer request', async t => {
  const f = await fixture(t);
  const { id, requestId } = f.seed();
  const { host, store } = await open(f, id);
  assert.equal(store.getState().detail.wait.requestId, requestId);

  // While the card is open, the agent publishes a newer request (the older one is superseded).
  const newer = f.republish(id, requestId, 2, { supersede: true });
  assert.equal(await store.decideApproval(id, requestId, 'approve'), 'refused');

  // The click targeted the request that was on screen, and only that one; the service refused before the coordinator.
  assert.deepEqual(posts(host).map(request => request.path), [`/runs/${id}/approvals/${requestId}/decision`]);
  assert.equal(f.approvalRow(requestId).state, 'superseded');
  assert.equal(f.approvalRow(requestId).decision, null);
  assert.equal(f.approvalRow(newer).state, 'pending');
  assert.equal(f.approvalRow(newer).decision, null);
  assert.equal(f.sql("SELECT count(*) AS n FROM events WHERE type = 'approval.answered'")[0].n, 0);
  // The card now shows the newer request, with an explanation instead of an applied decision.
  assert.equal(store.getState().detail.wait.requestId, newer);
  assert.match(store.getState().action.notice, /changed since this card was shown/);
  assert.equal(card(store).controls.approve.disabled, false, 'the owner can choose again on the refreshed card');
  assert.equal(await store.decideApproval(id, newer, 'approve'), 'recorded');
  assert.equal(f.approvalRow(newer).decision, 'approve');
});

test('an offline or unverified card refreshes with an explanation instead of sending', async t => {
  const f = await fixture(t);
  const { id, requestId } = f.seed();
  const { host, store } = await open(f, id);
  assert.equal(store.getState().connection, 'online');

  host.behavior.offline = true;
  store.refreshDetail();
  await until(() => store.getState().connection === 'offline', 'the panel to notice the outage');
  const before = host.requests.length;
  assert.equal(card(store).unverified !== null, true, 'the card says its data is the last data read');

  // Offline: the click refreshes (and fails to), explains, and sends nothing.
  assert.equal(await store.decideApproval(id, requestId, 'approve'), 'refreshed');
  assert.deepEqual(host.requests.slice(before).filter(request => request.method === 'POST'), []);
  assert.match(store.getState().action.notice, /may be out of date, so nothing was sent/);
  assert.equal(f.approvalRow(requestId).state, 'pending');

  // Back online but the card is still unverified: the click re-reads the run and still sends nothing.
  host.behavior.offline = false;
  assert.equal(await store.decideApproval(id, requestId, 'approve'), 'refreshed');
  assert.deepEqual(posts(host), []);
  assert.equal(store.getState().connection, 'online');
  assert.equal(f.approvalRow(requestId).state, 'pending');

  // Verified again: now the click is the decision.
  assert.equal(await store.decideApproval(id, requestId, 'approve'), 'recorded');
  assert.equal(posts(host).length, 1);
  assert.equal(f.approvalRow(requestId).decision, 'approve');
});

test('double click: the buttons are disabled while a response is in flight and a second click sends nothing', async t => {
  const f = await fixture(t);
  const { id, requestId } = f.seed();
  const { host, store } = await open(f, id);
  let release;
  host.behavior.gate = new Promise(resolve => { release = resolve; });
  const first = store.decideApproval(id, requestId, 'approve');
  await until(() => store.getState().action.inFlight, 'the response to be in flight');
  const flying = card(store);
  assert.equal(flying.controls.approve.disabled, true);
  assert.equal(flying.controls.requestChanges.disabled, true);
  assert.equal(await store.decideApproval(id, requestId, 'approve'), 'ignored');
  assert.equal(await store.decideApproval(id, requestId, 'request-changes', 'also this'), 'ignored');
  release();
  assert.equal(await first, 'recorded');
  assert.equal(posts(host).length, 1);
  assert.equal(f.approvalRow(requestId).decision, 'approve');
  assert.equal(f.sql("SELECT count(*) AS n FROM events WHERE type = 'approval.answered'")[0].n, 1);
});

test('a lost response is not repeated: the panel reads the run, and a reopened panel shows what the coordinator recorded', async t => {
  const f = await fixture(t);
  const recorded = f.seed();
  const unrecorded = f.seed();

  // The response reached the coordinator and the answer was lost.
  const first = await open(f, recorded.id, { dropAfter: true });
  assert.equal(await first.store.decideApproval(recorded.id, recorded.requestId, 'approve'), 'uncertain');
  assert.equal(posts(first.host).length, 1, 'never resent');
  assert.match(first.store.getState().action.notice, /could not confirm whether your response was recorded/);
  assert.equal(first.store.getState().action.verifying, false, 'the coordinator was read again');
  assert.equal(first.store.getState().detail.wait.state, 'answered');
  assert.equal(f.sql("SELECT count(*) AS n FROM events WHERE type = 'approval.answered' AND run_id = ?", recorded.id)[0].n, 1);

  // Reopen: a new panel reconstructs the decision from the coordinator alone and sends nothing.
  const reopened = await open(f, recorded.id);
  assert.deepEqual(reopened.host.requests.filter(request => request.method === 'POST'), []);
  assert.equal(reopened.store.getState().detail.wait.state, 'answered');
  assert.equal(reopened.store.getState().detail.wait.requestId, recorded.requestId);
  assert.equal(card(reopened.store).badge.label, 'Approved');
  assert.equal(card(reopened.store).controls, null);

  // The response never reached the coordinator: the reopened card is pending and nothing was invented or retried.
  const lost = await open(f, unrecorded.id, { dropBefore: true });
  assert.equal(await lost.store.decideApproval(unrecorded.id, unrecorded.requestId, 'approve'), 'uncertain');
  assert.equal(posts(lost.host).length, 1);
  assert.equal(f.approvalRow(unrecorded.requestId).state, 'pending');
  assert.equal(lost.store.getState().detail.wait.state, 'pending');
  assert.equal(card(lost.store).controls.approve.disabled, false, 'still pending, so the owner may decide again on purpose');
  const again = await open(f, unrecorded.id);
  assert.equal(again.store.getState().detail.wait.state, 'pending');
});

test('a decision issued from the CLI is reflected, and a card that was open is refused instead of double-answered', async t => {
  const f = await fixture(t);
  const { id, requestId } = f.seed();
  const stale = await open(f, id);
  assert.equal(stale.store.getState().detail.wait.state, 'pending');

  const cliAnswer = await f.respondCli(['run', 'respond', id, '--request', requestId, '--decision', 'request-changes', '--input=Please add a rollback step']);
  assert.equal(cliAnswer.status, 0, cliAnswer.stderr);

  // A new panel shows the CLI's decision, with its feedback.
  const reopened = await open(f, id);
  const wait = reopened.store.getState().detail.wait;
  assert.equal(wait.requestId, requestId);
  assert.equal(wait.state, 'answered');
  assert.equal(wait.response.decision, 'request-changes');
  assert.equal(wait.response.feedback, 'Please add a rollback step');
  assert.equal(card(reopened.store).badge.label, 'Changes requested');
  assert.deepEqual(posts(reopened.host), []);

  // The panel that still shows the pending card cannot overwrite or repeat it.
  assert.equal(await stale.store.decideApproval(id, requestId, 'approve'), 'refused');
  assert.deepEqual(posts(stale.host).map(request => request.path), [`/runs/${id}/approvals/${requestId}/decision`]);
  assert.equal(f.approvalRow(requestId).decision, 'request-changes');
  assert.equal(stale.store.getState().detail.wait.state, 'answered');
  assert.equal(f.sql("SELECT count(*) AS n FROM events WHERE type = 'approval.answered'")[0].n, 1);
});

test('Respond and continue answers exactly one generic pause; a stale pause is refused', async t => {
  const f = await fixture(t);
  const { id } = f.seed({ approval: false });
  const { host, store } = await open(f, id);
  const wait = store.getState().detail.wait;
  assert.equal(wait.kind, 'generic');
  assert.equal(card(store).controls.kind, 'respond');
  assert.equal(await store.respondToPause(id, wait.pauseId, '  '), 'invalid');
  assert.deepEqual(posts(host), []);

  const stalePause = 'pau_' + '0'.repeat(32);
  assert.equal(await store.respondToPause(id, stalePause, 'Use PostgreSQL'), 'refreshed', 'a pause that is not the one on screen is never sent');
  assert.deepEqual(posts(host), []);

  const guidance = 'Use PostgreSQL\nand keep "quotes" --safe';
  const version = store.getState().detail.version;
  assert.equal(await store.respondToPause(id, wait.pauseId, guidance), 'recorded');
  assert.deepEqual(posts(host), [{ method: 'POST', path: `/runs/${id}/pause-response`, body: { pauseId: wait.pauseId, input: guidance, displayedVersion: version } }]);
  assert.equal(f.sql('SELECT pause_id FROM run_responses WHERE run_id = ?', id).length, 1);
  assert.ok(f.coordinator.store.getRun(id).resolution.endsWith(`\n${guidance}`));
  assert.equal(store.getState().action.ack.pauseId, wait.pauseId);
  assert.equal(store.getState().action.ack.continuation, 'queued');
});

// --- the complete approval request through the real service and the panel transport ---------------------------------------

/** What a read must never change: every approval row, every run's version and status, and the event log. */
const databaseState = f => JSON.stringify({
  approvals: f.sql('SELECT * FROM approval_requests ORDER BY run_id, request_id'),
  runs: f.sql('SELECT id, status, version, updated_at, resolution, launch_action FROM runs ORDER BY id'),
  events: f.sql('SELECT * FROM events ORDER BY rowid'),
});

test('the panel service returns the complete approval request in order while the run detail still clips; the read changes nothing and exposes no secret', async t => {
  const f = await fixture(t);
  const key = await readCoordinatorToken(f.stateDirectory);
  const cases = [['hidden tail', hiddenTailRequest()], ['near the payload limit', nearLimitRequest()]];
  const seeded = cases.map(([, request]) => f.seed({ request }));
  for (const [index, [name, request]] of cases.entries()) {
    const { id, requestId } = seeded[index];
    const host = hostFor(f);
    const client = createPanelClient(host);
    const capability = f.coordinator.store.getRun(id).ownerToken;
    const before = databaseState(f);

    // The compact detail says it was clipped and hides what lies beyond the limits.
    const detail = (await client.run(id)).run.wait;
    assert.equal(detail.clipped, true, name);
    assert.ok(detail.scope.length <= COMPACT.text + 1, name);
    assert.ok(detail.verification.length <= COMPACT.list, name);
    assert.equal(JSON.stringify(detail).includes('ACTION-AFTER-1500') || JSON.stringify(detail).includes('SCOPE-AFTER-1500'), false, `${name}: the compact scope hides its tail`);

    const answer = await client.approval(id, requestId);
    const view = answer.request;
    for (const field of ['question', 'scope', 'completedWork', 'verification', 'artifacts', 'onApprove', 'onRequestChanges']) assert.deepEqual(view[field], request[field], `${name}: ${field}`);
    assert.deepEqual({ requestId: view.requestId, runId: view.runId, state: view.state, continuation: view.continuation, progress: view.progress, taskId: view.taskId, taskIndex: view.taskIndex, attemptId: view.attemptId, response: view.response, createdAt: view.createdAt },
      { requestId, runId: id, state: 'pending', continuation: 'none', progress: 'none', taskId: 'T1', taskIndex: 0, attemptId: `attempt_${id}_1`, response: null, createdAt: 1000 });
    assert.deepEqual(view.revision, REVISION);
    assert.deepEqual(Object.keys(view).sort(), ['attemptId', 'artifacts', 'completedWork', 'continuation', 'createdAt', 'onApprove', 'onRequestChanges', 'progress', 'question', 'requestId', 'response', 'revision', 'runId', 'scope', 'state', 'taskId', 'taskIndex', 'verification'].sort());
    assert.equal(typeof answer.fetchedAt, 'string');

    // The raw service answer carries no key, capability or internal field.
    const raw = await host.serviceRequest({ method: 'GET', path: `/runs/${id}/approvals/${requestId}` });
    assert.equal(raw.status, 200);
    for (const secret of [key, capability, SERVICE_TOKEN, 'receiptDigest', 'receipt_digest', 'ownerToken', '"ack"', 'checkpoint']) assert.equal(raw.body.includes(secret), false, `${name}: ${secret}`);
    assert.deepEqual(host.requests.map(request => request.method), ['GET', 'GET', 'GET'], 'reads only');
    assert.equal(databaseState(f), before, `${name}: no approval row, run version or event changed`);
  }

  // The recorded response of a decided request is part of the view.
  const decided = f.seed({ request: hiddenTailRequest() });
  const result = await f.respondCli(['run', 'respond', decided.id, '--request', decided.requestId, '--decision', 'request-changes', '--input=Narrow the scope']);
  assert.equal(result.status, 0, result.stderr);
  const afterDecision = databaseState(f);
  const answered = (await createPanelClient(hostFor(f)).approval(decided.id, decided.requestId)).request;
  assert.equal(answered.state, 'answered');
  assert.deepEqual({ decision: answered.response.decision, feedback: answered.response.feedback }, { decision: 'request-changes', feedback: 'Narrow the scope' });
  assert.equal(databaseState(f), afterDecision);

  // Unknown requests, other runs' requests and bad identifiers fail with fixed texts and no coordinator detail.
  const client = createPanelClient(hostFor(f));
  await assert.rejects(client.approval(seeded[0].id, 'apr_missing'), error => error.code === 'not-found' && error.category === 'request');
  await assert.rejects(client.approval(seeded[0].id, seeded[1].requestId), error => error.code === 'not-found');
  await assert.rejects(client.approval('../x', seeded[0].requestId), error => error.code === 'not-found');
  assert.equal(APPROVAL_FULL_LIMITS.text, CANONICAL.text);
  assert.equal(APPROVAL_FULL_LIMITS.entries, CANONICAL.list);
  assert.equal(APPROVAL_FULL_LIMITS.payloadBytes, CANONICAL.payload);
});

test('the approval read requires the service token', async t => {
  const f = await fixture(t);
  const { id, requestId } = f.seed();
  for (const authorization of [undefined, 'Bearer nope', `Bearer ${await readCoordinatorToken(f.stateDirectory)}`]) {
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: f.port, method: 'GET', path: `/runs/${id}/approvals/${requestId}`, headers: authorization === undefined ? {} : { Authorization: authorization } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      request.on('error', reject);
      request.end();
    });
    assert.equal(status, 401, String(authorization));
  }
});

// --- a shortened card is approved only after its complete request was loaded --------------------------------------------

const TAILS = ['ACTION-AFTER-1500', 'WORK-TAIL-1600', 'EVIDENCE-TAIL-700', 'EVIDENCE-ENTRY-12', 'ARTIFACT-ENTRY-11', 'ACTION-ENTRY-TAIL-500', 'PROPOSED-ACTION-13', 'CHANGES-ENTRY-10'];
const cardText = view => JSON.stringify([view.fields, view.lists, view.artifacts]);
const loadedAs = (store, requestId) => store.getState().approvalDetails.status === 'loaded' && store.getState().approvalDetails.data?.requestId === requestId;
const approvalReads = host => host.requests.filter(request => request.method === 'GET' && /\/approvals\/[^/]+$/.test(request.path));

test('a shortened card: Approve stays off and sends nothing until the complete request is loaded; then one decision names exactly this run and request', async t => {
  const f = await fixture(t);
  const target = f.seed({ request: hiddenTailRequest() });
  const other = f.seed({ request: hiddenTailRequest() });
  const { host, store } = await open(f, target.id);
  const screen = mountCard(store);
  t.after(() => screen.dispose());
  const approve = screen.button('Approve and continue');
  const load = screen.button('Load full request');

  // The compact card hides the tail, offers the load action, and Approve is off.
  assert.equal(store.getState().detail.wait.clipped, true);
  const compact = card(store);
  assert.equal(TAILS.some(marker => cardText(compact).includes(marker)), false, 'the compact card hides content beyond its limits');
  assert.equal(compact.complete, false);
  assert.match(compact.clippedNote, /Approve and continue stays off until you load and read the full request/);
  assert.match(compact.clippedNote, new RegExp(`heimdall coordinator run approval ${target.id} --request ${target.requestId}`));
  assert.doesNotMatch(compact.clippedNote, /available through the CLI/);
  assert.equal(load.visible, true);
  assert.equal(approve.props.disabled, true);

  // A click on the disabled button does nothing; the store also refuses the very handler when it is forced.
  assert.equal(approve.click(), false);
  approve.forceClick();
  await sleep(80);
  assert.deepEqual(posts(host), [], 'no decision was sent before the complete request was loaded');
  assert.equal(store.getState().action.notice, ACTION_NOTICES.loadFirst);
  assert.equal(f.approvalRow(target.requestId).state, 'pending');
  assert.deepEqual(approvalReads(host), []);

  // Loading reads exactly this request, then enables Approve.
  assert.equal(load.click(), true);
  assert.equal(load.props.label, 'Loading the full request…');
  await until(() => loadedAs(store, target.requestId), 'the complete request');
  assert.deepEqual(approvalReads(host).map(request => request.path), [`/runs/${target.id}/approvals/${target.requestId}`]);
  const full = card(store);
  assert.equal(full.complete, true);
  for (const marker of TAILS) assert.equal(cardText(full).includes(marker), true, `${marker} is shown in full`);
  const request = hiddenTailRequest();
  assert.equal(full.fields.find(field => field.label === 'Scope of the approval').text, request.scope);
  assert.deepEqual(full.lists.find(list => list.label === 'Verification').items, request.verification);
  assert.deepEqual(full.lists.find(list => list.label === 'If you approve, the agent will').items, request.onApprove);
  assert.deepEqual(full.artifacts, request.artifacts);
  assert.equal(full.fullRequest, null);
  assert.equal(load.visible, false);
  assert.equal(approve.props.disabled, false);
  assert.equal(approve.clickable, true);

  const version = store.getState().detail.version;
  const expected = await approvalContentDigest(request);
  const detailPath = `/runs/${target.id}`;
  const detailReads = () => host.requests.filter(read => read.method === 'GET' && read.path === detailPath).length;
  const readsBeforeDecision = detailReads();
  let releaseDetail;
  host.behavior.gatedRunDetailPath = detailPath;
  host.behavior.gateRunDetail = new Promise(resolve => { releaseDetail = resolve; });
  try {
    assert.equal(approve.click(), true);
    await until(() => store.getState().action.ack !== null && detailReads() === readsBeforeDecision + 1, 'the acknowledged decision with its detail refresh held');
    assert.deepEqual({ runId: store.getState().action.ack.runId, requestId: store.getState().action.ack.requestId, decision: store.getState().action.ack.decision }, { runId: target.id, requestId: target.requestId, decision: 'approve' });
    assert.equal(f.approvalRow(target.requestId).state, 'answered', 'the coordinator durably recorded the decision before the detail refresh');
    assert.equal(store.getState().detail.wait.state, 'pending', 'an acknowledgement does not mean the card detail has refreshed');
    assert.deepEqual(posts(host), [{
      method: 'POST', path: `/runs/${target.id}/approvals/${target.requestId}/decision`,
      body: { decision: 'approve', displayedVersion: version, reviewed: { requestId: target.requestId, revision: REVISION, contentDigest: expected } },
    }]);
    assert.equal(f.approvalRow(target.requestId).decision, 'approve');
    assert.equal(f.approvalRow(other.requestId).state, 'pending', 'no other run or request was touched');
  } finally {
    host.behavior.gateRunDetail = null;
    releaseDetail();
  }
  await until(() => store.getState().action.ack !== null && store.getState().detail.wait.requestId === target.requestId && store.getState().detail.wait.state === 'answered' && store.getState().detail.wait.progress === 'queued', 'the acknowledged decision and refreshed card detail');
  assert.equal(store.getState().detail.wait.state, 'answered');
  assert.equal(store.getState().detail.wait.progress, 'queued');
  assert.equal(JSON.stringify(host.requests).includes(SERVICE_TOKEN), false);
});

test('an untruncated request keeps the ordinary flow: no load action, no reviewed material, one decision', async t => {
  const f = await fixture(t);
  const { id, requestId } = f.seed();
  const { host, store } = await open(f, id);
  const screen = mountCard(store);
  t.after(() => screen.dispose());
  assert.equal(store.getState().detail.wait.clipped, false);
  assert.equal(card(store).fullRequest, null);
  assert.equal(card(store).clippedNote, null);
  assert.equal(screen.button('Load full request').visible, false);
  const approve = screen.button('Approve and continue');
  assert.equal(approve.props.disabled, false);
  const version = store.getState().detail.version;
  assert.equal(approve.click(), true);
  await until(() => f.approvalRow(requestId).decision === 'approve', 'the decision');
  assert.deepEqual(posts(host), [{ method: 'POST', path: `/runs/${id}/approvals/${requestId}/decision`, body: { decision: 'approve', displayedVersion: version } }]);
  assert.deepEqual(approvalReads(host), [], 'the complete request was not read');
});

test('request changes on a shortened card is available without loading and reaches the same operation with its exact identities', async t => {
  const f = await fixture(t);
  const target = f.seed({ request: hiddenTailRequest() });
  const { host, store } = await open(f, target.id);
  const screen = mountCard(store);
  t.after(() => screen.dispose());
  const changes = screen.button('Request changes');
  assert.equal(changes.props.disabled, true, 'needs feedback first, as before');
  const feedback = 'Drop the legacy_users table from the scope.';
  screen.field.type(feedback);
  assert.equal(changes.clickable, true);
  assert.equal(screen.button('Approve and continue').props.disabled, true, 'approval is still off');
  const version = store.getState().detail.version;
  changes.click();
  await until(() => f.approvalRow(target.requestId).decision === 'request-changes', 'the decision');
  assert.deepEqual(posts(host), [{ method: 'POST', path: `/runs/${target.id}/approvals/${target.requestId}/decision`, body: { decision: 'request-changes', feedback, displayedVersion: version } }]);
  assert.deepEqual({ ...f.approvalRow(target.requestId) }, { request_id: target.requestId, state: 'answered', decision: 'request-changes', feedback, continuation: 'queued' });
  assert.deepEqual(approvalReads(host), []);
});

test('details that fail, are unreadable or do not match the card never enable Approve', async t => {
  const f = await fixture(t);
  const target = f.seed({ request: hiddenTailRequest() });
  const wrong = f.seed({ request: hiddenTailRequest() });
  const otherCopy = JSON.parse((await hostFor(f).serviceRequest({ method: 'GET', path: `/runs/${wrong.id}/approvals/${wrong.requestId}` })).body);
  const { host, store } = await open(f, target.id);
  const screen = mountCard(store);
  t.after(() => screen.dispose());
  // The card is drawn again after each read of the run, so the buttons are looked up when they are used.
  const approve = { get props() { return screen.button('Approve and continue').props; }, click: () => screen.button('Approve and continue').click(), forceClick: () => screen.button('Approve and continue').forceClick() };
  const load = { get props() { return screen.button('Load full request').props; }, click: () => screen.button('Load full request').click() };
  const attempts = [];
  const attempt = async (name, setup, check) => {
    Object.assign(host.behavior, { offline: false, rewrite: undefined });
    setup();
    const before = host.requests.length;
    assert.equal(load.click(), true, `${name}: the load action is offered`);
    await until(() => store.getState().approvalDetails.status === 'error', `${name}: the failure`);
    assert.equal(store.getState().approvalDetails.data, null, name);
    assert.equal(store.getState().approvalDetails.contentDigest, null, name);
    assert.equal(card(store).complete, false, name);
    assert.equal(approve.props.disabled, true, `${name}: Approve stays off`);
    assert.equal(approve.click(), false, name);
    approve.forceClick();
    await sleep(60);
    assert.deepEqual(posts(host), [], `${name}: nothing was sent`);
    assert.equal(TAILS.some(marker => cardText(card(store)).includes(marker)), false, `${name}: no unvalidated content on the card`);
    assert.equal(load.props.label, 'Try loading the full request again', name);
    check?.();
    attempts.push([name, host.requests.slice(before).filter(request => request.method === 'GET' && /approvals/.test(request.path)).length]);
    // A fresh read of the run starts again without any details.
    Object.assign(host.behavior, { offline: false, rewrite: undefined });
    store.select(null);
    store.select(target.id);
    await until(() => store.getState().detail?.id === target.id, `${name}: the run again`);
    assert.equal(store.getState().approvalDetails.status, 'idle', name);
  };

  await attempt('offline', () => { host.behavior.offline = true; });
  await attempt('malformed answer', () => { host.behavior.rewrite = (request, result) => ({ status: 200, body: JSON.stringify({ request: { requestId: target.requestId } }) }); });
  await attempt('oversized text', () => { host.behavior.rewrite = (request, result) => { const body = JSON.parse(result.body); body.request.scope = 'x'.repeat(APPROVAL_FULL_LIMITS.text + 1); return { status: 200, body: JSON.stringify(body) }; }; });
  await attempt('another request id', () => { host.behavior.rewrite = (request, result) => { const body = JSON.parse(result.body); body.request.requestId = wrong.requestId; return { status: 200, body: JSON.stringify(body) }; }; });
  await attempt('another run', () => { host.behavior.rewrite = () => ({ status: 200, body: JSON.stringify(otherCopy) }); });
  await attempt('another task', () => { host.behavior.rewrite = (request, result) => { const body = JSON.parse(result.body); body.request.taskId = 'T9'; return { status: 200, body: JSON.stringify(body) }; }; }, () => assert.equal(store.getState().approvalDetails.error, APPROVAL_DETAIL_NOTICES.mismatch));
  await attempt('a request that is no longer pending', () => { host.behavior.rewrite = (request, result) => { const body = JSON.parse(result.body); body.request.state = 'superseded'; return { status: 200, body: JSON.stringify(body) }; }; }, () => assert.equal(store.getState().approvalDetails.error, APPROVAL_DETAIL_NOTICES.mismatch));
  await attempt('another revision', () => { host.behavior.rewrite = (request, result) => { const body = JSON.parse(result.body); body.request.revision = { head: 'd'.repeat(40), digest: 'e'.repeat(64) }; return { status: 200, body: JSON.stringify(body) }; }; }, () => assert.equal(store.getState().approvalDetails.error, APPROVAL_DETAIL_NOTICES.mismatch));
  assert.ok(attempts.every(([, reads]) => reads === 1), JSON.stringify(attempts));
  assert.equal(f.approvalRow(target.requestId).state, 'pending');
  assert.equal(f.approvalRow(wrong.requestId).state, 'pending');

  // The coordinator's own copy changed after the card was drawn: its revision no longer matches the card.
  f.sql('UPDATE approval_requests SET revision_json = ? WHERE request_id = ?', JSON.stringify({ head: 'd'.repeat(40), digest: 'e'.repeat(64) }), target.requestId);
  Object.assign(host.behavior, { rewrite: undefined });
  load.click();
  await until(() => store.getState().approvalDetails.status === 'error', 'the changed revision');
  assert.equal(store.getState().approvalDetails.error, APPROVAL_DETAIL_NOTICES.mismatch);
  assert.equal(approve.props.disabled, true);
  approve.forceClick();
  await sleep(60);
  assert.deepEqual(posts(host), []);
});

test('details never attach to another card: a selection change, a changed request, a new version and late or out-of-order answers', async t => {
  const f = await fixture(t);
  const a = f.seed({ request: hiddenTailRequest() });
  const b = f.seed({ request: hiddenTailRequest() });
  const { host, store } = await open(f, a.id);
  const screen = mountCard(store);
  t.after(() => screen.dispose());
  const keys = [];
  store.subscribe(state => keys.push([state.selectedRunId, state.approvalDetails.key, state.approvalDetails.status, state.approvalDetails.data?.requestId ?? null]));

  // 1. A selection change while the answer for A is on its way: nothing of A reaches B's card.
  let release;
  host.behavior.gateRead = new Promise(resolve => { release = resolve; });
  screen.button('Load full request').click();
  await until(() => approvalReads(host).length === 1, 'the read for A');
  store.select(b.id);
  await until(() => store.getState().detail?.id === b.id, 'the run B');
  assert.equal(store.getState().approvalDetails.status, 'idle');
  host.behavior.gateRead = null;
  release();
  await sleep(120);
  assert.equal(store.getState().approvalDetails.status, 'idle', 'the late answer for A was dropped');
  assert.equal(store.getState().approvalDetails.data, null);
  assert.equal(keys.some(([run, , status, request]) => run === b.id && (status === 'loaded' || request === a.requestId)), false, 'B never held A\'s details');
  assert.equal(card(store).complete, false);
  assert.equal(screen.button('Approve and continue').props.disabled, true);
  screen.button('Approve and continue').forceClick();
  await sleep(60);
  assert.deepEqual(posts(host), [], 'B cannot be approved with A\'s details');

  // 2. Loaded details are dropped when the card moves to another version: the late answer for the old version is ignored.
  host.behavior.gateRead = new Promise(resolve => { release = resolve; });
  screen.button('Load full request').click();
  await until(() => approvalReads(host).length === 2, 'the read for B');
  const oldKey = store.getState().approvalDetails.key;
  f.sql('UPDATE runs SET version = version + 1 WHERE id = ?', b.id);
  store.refreshDetail();
  await until(() => store.getState().approvalDetails.key === null, 'the details to be dropped for the new version');
  host.behavior.gateRead = null;
  release();
  await sleep(120);
  assert.equal(store.getState().approvalDetails.status, 'idle', 'the answer for the old version did not come back');
  assert.equal(keys.some(([, key, status]) => key === oldKey && status === 'loaded'), false);
  assert.equal(screen.button('Approve and continue').props.disabled, true);
  screen.button('Approve and continue').forceClick();
  await sleep(60);
  assert.deepEqual(posts(host), []);

  // 3. Loaded for the current version: Approve works, and names that version.
  screen.button('Load full request').click();
  await until(() => loadedAs(store, b.requestId), 'the complete request of B');
  assert.equal(screen.button('Approve and continue').props.disabled, false);

  // 4. A newer request replaces the one the owner loaded: the details go, the new card is gated again.
  const newer = f.republish(b.id, b.requestId, 2, { supersede: true, request: hiddenTailRequest() });
  store.refreshDetail();
  await until(() => store.getState().detail?.wait?.requestId === newer, 'the newer request');
  assert.equal(store.getState().approvalDetails.status, 'idle');
  assert.equal(card(store).complete, false);
  assert.equal(screen.button('Approve and continue').props.disabled, true);
  screen.button('Approve and continue').forceClick();
  await sleep(60);
  assert.deepEqual(posts(host), []);
  assert.equal(f.approvalRow(b.requestId).decision, null);

  // 5. The reopened panel starts without any details, and a fresh load works for the newer request.
  const reopened = await open(f, b.id);
  assert.equal(reopened.store.getState().approvalDetails.status, 'idle');
  const reopenedScreen = mountCard(reopened.store);
  t.after(() => reopenedScreen.dispose());
  assert.equal(reopenedScreen.button('Approve and continue').props.disabled, true);
  reopenedScreen.button('Load full request').click();
  await until(() => loadedAs(reopened.store, newer), 'the newer request after reopening');
  const version = reopened.store.getState().detail.version;
  reopenedScreen.button('Approve and continue').click();
  await until(() => f.approvalRow(newer).decision === 'approve', 'the decision');
  assert.deepEqual(posts(reopened.host).map(request => [request.path, request.body.displayedVersion]), [[`/runs/${b.id}/approvals/${newer}/decision`, version]]);
  assert.equal(f.approvalRow(a.requestId).state, 'pending');
});

test('the decision route refuses an approval of a shortened card without matching reviewed material, and request changes never needs it', async t => {
  const f = await fixture(t);
  const clipped = f.seed({ request: hiddenTailRequest() });
  const plain = f.seed();
  const second = f.seed({ request: hiddenTailRequest() });
  const host = hostFor(f);
  const raw = async (target, body) => {
    const version = (await host.serviceRequest({ method: 'GET', path: `/runs/${target.id}` }).then(answer => JSON.parse(answer.body))).run.version;
    const answer = await host.serviceRequest({ method: 'POST', path: `/runs/${target.id}/approvals/${target.requestId}/decision`, body: JSON.stringify({ displayedVersion: version, ...body }) });
    return { status: answer.status, body: JSON.parse(answer.body) };
  };
  const contentDigest = await approvalContentDigest(hiddenTailRequest());
  const reviewed = (override = {}) => ({ requestId: clipped.requestId, revision: REVISION, contentDigest, ...override });
  const refused = async (name, body, status, kind) => {
    const answer = await raw(clipped, body);
    assert.equal(answer.status, status, name);
    assert.equal(answer.body.error.kind, kind, name);
    assert.equal(f.approvalRow(clipped.requestId).state, 'pending', `${name}: nothing was recorded`);
    assert.equal(f.sql("SELECT count(*) AS n FROM events WHERE type = 'approval.answered'")[0].n, 0, name);
  };

  await refused('no reviewed material', { decision: 'approve' }, 409, 'review-required');
  await refused('another content digest', { decision: 'approve', reviewed: reviewed({ contentDigest: 'f'.repeat(64) }) }, 409, 'review-mismatch');
  await refused('digest of the compact text', { decision: 'approve', reviewed: reviewed({ contentDigest: await approvalContentDigest({ ...hiddenTailRequest(), scope: hiddenTailRequest().scope.slice(0, 1500) }) }) }, 409, 'review-mismatch');
  await refused('another revision', { decision: 'approve', reviewed: reviewed({ revision: { head: 'd'.repeat(40), digest: REVISION.digest } }) }, 409, 'review-mismatch');
  await refused('another request', { decision: 'approve', reviewed: reviewed({ requestId: plain.requestId }) }, 409, 'review-mismatch');
  await refused('extra field', { decision: 'approve', reviewed: { ...reviewed(), extra: 1 } }, 400, 'invalid-request');
  await refused('malformed digest', { decision: 'approve', reviewed: reviewed({ contentDigest: 'nope' }) }, 400, 'invalid-request');
  await refused('reviewed material on a request-changes decision', { decision: 'request-changes', feedback: 'x', reviewed: reviewed() }, 400, 'invalid-request');

  // The request is replaced by the coordinator's copy after the review: the reviewed digest no longer matches.
  const changed = { ...hiddenTailRequest(), scope: hiddenTailRequest().scope + ' (changed)' };
  f.sql('UPDATE approval_requests SET request_json = ? WHERE request_id = ?', JSON.stringify(changed), clipped.requestId);
  await refused('content changed after the review', { decision: 'approve', reviewed: reviewed() }, 409, 'review-mismatch');
  f.sql('UPDATE approval_requests SET request_json = ? WHERE request_id = ?', JSON.stringify(hiddenTailRequest()), clipped.requestId);

  // An unshortened card needs none, and a wrong one is still refused.
  const wrongPlain = await raw(plain, { decision: 'approve', reviewed: { requestId: plain.requestId, revision: REVISION, contentDigest: 'a'.repeat(64) } });
  assert.deepEqual([wrongPlain.status, wrongPlain.body.error.kind], [409, 'review-mismatch']);
  assert.equal(f.approvalRow(plain.requestId).state, 'pending');

  // Request changes needs no review of the complete request.
  const changes = await raw(clipped, { decision: 'request-changes', feedback: 'Narrow the scope' });
  assert.equal(changes.status, 200);
  assert.equal(f.approvalRow(clipped.requestId).decision, 'request-changes');

  // Matching reviewed material is accepted for a shortened card, and for an unshortened one.
  const ok = await raw(second, { decision: 'approve', reviewed: reviewed({ requestId: second.requestId }) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(f.approvalRow(second.requestId).decision, 'approve');
  const okPlain = await raw(plain, { decision: 'approve', reviewed: { requestId: plain.requestId, revision: REVISION, contentDigest: await approvalContentDigest(REQUEST) } });
  assert.equal(okPlain.status, 200, JSON.stringify(okPlain.body));
  assert.equal(f.approvalRow(plain.requestId).decision, 'approve');
});
