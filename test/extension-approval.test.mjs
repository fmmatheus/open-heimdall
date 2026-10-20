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
import { createPanelStore } from '../dist/extension/panel/store.js';
import { waitCard } from '../dist/extension/panel/view-model.js';

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
  const insertRequest = (runId, requestId, attemptId, createdAt) => sql(`INSERT INTO approval_requests(run_id, request_id, phase, task_index, task_id, attempt_id, receipt_digest, request_json, revision_json, state, continuation, created_at)
    VALUES (?, ?, 'executor', 0, 'T1', ?, 'digest', ?, ?, 'pending', 'none', ?)`, runId, requestId, attemptId, JSON.stringify(REQUEST), JSON.stringify(REVISION), createdAt);
  /** A paused, released, idle run with a pending request (`approval`) or an ordinary blocker. */
  const seed = ({ approval = true, reason = 'Blocked: choose the database' } = {}) => {
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
    coordinator.store.saveCheckpoint(id, run.ownerToken, state);
    const running = coordinator.store.transition(id, run.ownerToken, run.version, 'running');
    coordinator.store.transition(id, running.ownerToken, running.version, 'paused', reason, true);
    const requestId = approval ? `apr_${id}_1` : undefined;
    if (approval) insertRequest(id, requestId, attempt.id, 1000);
    return { id, requestId };
  };
  /** What the agent does after the owner's answer: it resumes, corrects and pauses again with a new request. */
  const republish = (runId, previousRequestId, number, { supersede = false } = {}) => {
    const requestId = `apr_${runId}_${number}`;
    const attemptId = `attempt_${runId}_${number}`;
    const row = sql('SELECT checkpoint_json FROM runs WHERE id = ?', runId)[0];
    const checkpoint = JSON.parse(row.checkpoint_json);
    checkpoint.attempt = { ...checkpoint.attempt, id: attemptId };
    checkpoint.wait = { kind: 'approval', attemptId, index: 0, taskId: 'T1' };
    checkpoint.status = 'paused';
    sql("UPDATE runs SET status = 'paused', capacity_reserved = 0, checkpoint_json = ?, version = version + 1 WHERE id = ?", JSON.stringify(checkpoint), runId);
    if (supersede) sql("UPDATE approval_requests SET state = 'superseded', superseded_at = 2, superseded_reason = 'replaced' WHERE run_id = ? AND request_id = ?", runId, previousRequestId);
    else sql("UPDATE approval_requests SET continuation = 'consumed' WHERE run_id = ? AND request_id = ?", runId, previousRequestId);
    insertRequest(runId, requestId, attemptId, 1000 + number);
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
  return { root, coordinator, server, sql, seed, republish, approvalRow, respondCli, port: server.address().port };
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
