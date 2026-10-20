import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { EventEmitter, once } from 'node:events';
import { createCoordinatorClient } from '../dist/coordinator/client.js';
import { loadCoordinatorConfiguration } from '../dist/coordinator/config.js';
import { startCoordinatorService, readCoordinatorToken } from '../dist/coordinator/service.js';
import { createDurableSubmissionGate } from '../dist/workflow/durable-submission.js';
import { contractDigest, contractRef } from '../dist/workflow/contracts.js';
import { computeReviewRevision, ReviewRevisionError } from '../dist/coordinator/review-revision.js';
import { DatabaseSync } from 'node:sqlite';
import { hiddenTailRequest, nearLimitRequest } from './fixtures/approval-requests.mjs';
import { openSubmissionBinding, recordDispatchPrompt } from '../dist/workflow/submission-store.js';
import { computeRuntimeIdentity, runtimeIdentity } from '../dist/workflow/runtime-identity.js';
import { sourcePackageRoot } from '../dist/coordinator/runtime-snapshot.js';

const git = (directory, args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(t) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hd-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const project = path.join(temporary, 'source');
  const state = path.join(temporary, 'state');
  await fs.mkdir(project);
  git(project, ['init', '-b', 'main']);
  git(project, ['config', 'user.name', 'Fixture']);
  git(project, ['config', 'user.email', 'fixture@example.invalid']);
  await fs.writeFile(path.join(project, 'README.md'), 'pinned base\n');
  git(project, ['add', 'README.md']); git(project, ['commit', '-m', 'fixture']);
  await fs.writeFile(path.join(project, '.heimdall.toml'), `[workflow]\nplannerModel = "anthropic/fixture"\nexecutorModel = "anthropic/fixture"\nexecutorFallbackModel = "openai/fixture"\n[opencode]\nbaseUrl = "http://127.0.0.1:4096"\n`);
  const configuration = { stateDirectory: state, endpoint: path.join(state, 'coordinator.sock'), globalConcurrency: 2, projectConcurrency: 1 };
  const launches = [];
  const launched = new EventEmitter();
  let observation = { idle: false, status: 'unknown' };
  const executor = {
    async launch(run) { launches.push(run); launched.emit('launch'); },
    async inspect() { return observation; },
  };
  let service = await startCoordinatorService({ configuration, executor, pollIntervalMs: 60000 });
  t.after(async () => { if (service) await service.close(); });
  const client = createCoordinatorClient(configuration.endpoint, await readCoordinatorToken(state));
  return {
    temporary, project, state, configuration, client, launches,
    async waitForLaunch(count) {
      while (launches.length < count) await once(launched, 'launch', { signal: AbortSignal.timeout(10000) });
    },
    service: () => service,
    observation: value => { observation = value; },
    async restart() { await service.close(); service = await startCoordinatorService({ configuration, executor, pollIntervalMs: 60000 }); },
    async close() { await service.close(); service = null; },
  };
}
async function settled(store, runId) {
  for (let n = 0; n < 200; n++) {
    const run = store.getRun(runId);
    if (run.status === 'running' || run.status === 'reconciliation-required') return run;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Fixture launch did not settle');
}
async function bindCheckpoint(f, run, status = 'paused') {
  const binding = { sessionID: run.parentSessionId, id: 'native_call', messageID: 'assistant_message', agent: 'adr-orchestrator' };
  await f.client.request('POST', `/runs/${run.id}/binding`, binding, run.ownerToken);
  const state = { id: run.id, status, adr: '.heimdall/feature.md', parent: run.parentSessionId, caller: binding, branch: run.branch, baseline: '', index: 0, tasks: [], results: [], phase: 'planner', child: null, settings: run.specification.settings };
  await f.client.request('PUT', `/runs/${run.id}/checkpoint`, state, run.ownerToken);
  return state;
}

test('IPC submission pins the source, creates one owned runtime, and exposes no capabilities', async t => {
  const f = await fixture(t);
  const before = git(f.project, ['status', '--porcelain']);
  const project = await f.client.request('POST', '/projects', { directory: f.project });
  const submitted = await f.client.request('POST', '/runs', { projectId: project.id, feature: 'Implement the specified feature.' });
  assert.equal(submitted.status, 'queued');
  assert.equal(Object.hasOwn(submitted, 'ownerToken'), false);
  await fs.writeFile(path.join(f.project, 'README.md'), 'source moved\n');
  git(f.project, ['add', 'README.md']); git(f.project, ['commit', '-m', 'move source']);
  await f.service().scheduler.tick();
  const run = await settled(f.service().store, submitted.id);
  assert.equal(run.status, 'running', run.reason ?? '');
  assert.equal(f.launches.length, 1);
  assert.equal(await fs.readFile(path.join(run.worktreePath, 'README.md'), 'utf8'), 'pinned base\n');
  assert.equal(await fs.readFile(path.join(run.worktreePath, '.heimdall/feature.md'), 'utf8'), 'Implement the specified feature.');
  const metadata = JSON.parse(await fs.readFile(path.join(run.worktreePath, '.heimdall/managed.json'), 'utf8'));
  assert.equal(metadata.ownerToken, run.ownerToken);
  assert.equal(metadata.parentSessionId, run.parentSessionId);
  const shim = await fs.readFile(path.join(run.worktreePath, '.opencode/plugins/heimdall.ts'), 'utf8');
  assert.match(shim, /createPlugin/);
  assert.match(shim, /runtime\.toml/);
  assert.equal(git(f.project, ['status', '--porcelain']), before);
  await bindCheckpoint(f, run);
  await assert.rejects(f.client.request('GET', '/projects', undefined, run.ownerToken), /authorization|cannot administer/);
  await assert.rejects(f.client.request('GET', '/runs/' + run.id, undefined, 'wrong-token'), /authorization/);
  const visible = await f.client.request('GET', '/runs/' + run.id);
  assert.equal(Object.hasOwn(visible, 'ownerToken'), false);
  assert.equal(visible.checkpoint.caller.messageID, 'assistant_message');
  const events = await f.client.request('GET', '/events');
  assert.ok(events.some(event => event.type === 'checkpoint.saved'));
  assert.ok(!JSON.stringify(events).includes(run.ownerToken));
});

test('restart retains active ownership; explicit idle reconciliation and resume rotate the capability', async t => {
  const f = await fixture(t);
  const project = await f.client.request('POST', '/projects', { directory: f.project });
  const queued = await f.client.request('POST', '/runs', { projectId: project.id, feature: 'Feature' });
  await f.service().scheduler.tick();
  const run = await settled(f.service().store, queued.id);
  const checkpoint = await bindCheckpoint(f, run);
  await f.restart();
  const retained = f.service().store.getRun(run.id);
  assert.equal(retained.status, 'reconciliation-required');
  assert.equal(retained.capacityReserved, true);
  await f.service().scheduler.tick();
  assert.equal(f.launches.length, 1);
  f.observation({ idle: true, status: 'paused', reason: 'Needs resolution' });
  const reconciled = await f.client.request('POST', `/runs/${run.id}/reconcile`, {});
  assert.equal(reconciled.status, 'paused');
  assert.equal(reconciled.capacityReserved, false);
  const resumed = await f.client.request('POST', `/runs/${run.id}/resume`, { input: 'Use the agreed approach' });
  assert.equal(resumed.status, 'queued');
  await f.service().scheduler.tick();
  const fresh = await settled(f.service().store, run.id);
  // Resumed admission is already running while metadata/launch finish.
  await f.waitForLaunch(2);
  assert.equal(fresh.worktreePath, run.worktreePath);
  assert.equal(fresh.parentSessionId, run.parentSessionId);
  assert.notEqual(fresh.ownerToken, run.ownerToken);
  assert.notEqual(fresh.promptMessageId, run.promptMessageId);
  await assert.rejects(f.client.request('PUT', `/runs/${run.id}/checkpoint`, checkpoint, run.ownerToken), /authorization/);
  const metadata = JSON.parse(await fs.readFile(path.join(run.worktreePath, '.heimdall/managed.json'), 'utf8'));
  assert.equal(metadata.ownerToken, fresh.ownerToken);
});

test('an existing IPC endpoint is never removed or replaced', async t => {
  const f = await fixture(t);
  await f.close();
  await fs.writeFile(f.configuration.endpoint, 'external owner');
  await assert.rejects(startCoordinatorService({ configuration: f.configuration }), /endpoint already exists/);
  assert.equal(await fs.readFile(f.configuration.endpoint, 'utf8'), 'external owner');
});

test('tracked original plugin assets are rejected before queueing or reserving a worktree', async t => {
  const f = await fixture(t);
  const plugins = path.join(f.project, '.opencode/plugins');
  await fs.mkdir(plugins, { recursive: true });
  const original = path.join(plugins, 'adr-workflow.js');
  await fs.writeFile(original, '// Existing workflow remains untouched.\n');
  git(f.project, ['add', '.opencode/plugins/adr-workflow.js']); git(f.project, ['commit', '-m', 'existing workflow']);
  const project = await f.client.request('POST', '/projects', { directory: f.project });
  await assert.rejects(f.client.request('POST', '/runs', { projectId: project.id, feature: 'Feature' }), /already tracks a managed runtime path/);
  assert.equal(f.service().store.listRuns().length, 0);
  await assert.rejects(fs.stat(path.join(f.state, 'worktrees')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(original, 'utf8'), '// Existing workflow remains untouched.\n');
});

test('explicit no-auth settings survive submission snapshots and managed runtime configuration', async t => {
  const f = await fixture(t);
  const configFile = path.join(f.project, '.heimdall.toml');
  await fs.appendFile(configFile, 'authentication = "none"\n');
  const project = await f.client.request('POST', '/projects', { directory: f.project });
  const queued = await f.client.request('POST', '/runs', { projectId: project.id, feature: 'Feature' });
  assert.equal(f.service().store.getRun(queued.id).specification.opencode.authentication, 'none');
  await f.service().scheduler.tick();
  const run = await settled(f.service().store, queued.id);
  const runtime = await fs.readFile(path.join(run.worktreePath, '.heimdall/runtime.toml'), 'utf8');
  assert.match(runtime, /authentication = "none"/);
});

test('relative project registration resolves against the client rather than server cwd', async t => {
  const f = await fixture(t);
  const file = path.join(f.temporary, 'coordinator.toml');
  await fs.writeFile(file, `[coordinator]\nstateDirectory="state"\nglobalConcurrency=2\nprojectConcurrency=1\n`);
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [cli, 'coordinator', 'project', 'add', './source', '--coordinator-config', file], { cwd: f.temporary, encoding: 'utf8' });
  assert.equal(JSON.parse(stdout).directory, f.project);
});

test('coordinator TOML resolves paths against its file and rejects unsupported limits', async t => {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hd-cfg-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const file = path.join(temporary, 'coordinator.toml');
  await fs.writeFile(file, '[coordinator]\nstateDirectory="state"\nglobalConcurrency=3\nprojectConcurrency=2\n');
  const config = await loadCoordinatorConfiguration(file);
  assert.equal(config.stateDirectory, path.join(temporary, 'state'));
  assert.equal(config.globalConcurrency, 3);
  assert.equal(config.projectConcurrency, 2);
  const alias = path.join(temporary, 'alias');
  await fs.symlink(temporary, alias, 'dir');
  const throughAlias = path.join(temporary, 'alias-config.toml');
  await fs.writeFile(throughAlias, '[coordinator]\nstateDirectory="alias/state"\nglobalConcurrency=3\nprojectConcurrency=2\n');
  const aliased = await loadCoordinatorConfiguration(throughAlias);
  assert.equal(aliased.stateDirectory, config.stateDirectory);
  assert.equal(aliased.endpoint, config.endpoint);
  await fs.writeFile(file, '[coordinator]\nglobalConcurrency=0\n');
  await assert.rejects(loadCoordinatorConfiguration(file), /positive integer/);
  await fs.writeFile(file, '[coordinator]\nunknown=true\n');
  await assert.rejects(loadCoordinatorConfiguration(file), /Unknown coordinator setting/);
});

test('owner-fenced submission routes store, replay and refuse by identity; the administrator cannot write them', async t => {
  const f = await fixture(t);
  const project = await f.client.request('POST', '/projects', { directory: f.project });
  const queued = await f.client.request('POST', '/runs', { projectId: project.id, feature: 'Feature' });
  await f.service().scheduler.tick();
  const run = await settled(f.service().store, queued.id);
  const caller = { sessionID: run.parentSessionId, id: 'native_call', messageID: 'assistant_message', agent: 'adr-orchestrator' };
  await f.client.request('POST', `/runs/${run.id}/binding`, caller, run.ownerToken);
  const state = { id: run.id, status: 'running', adr: '.heimdall/feature.md', parent: run.parentSessionId, caller, branch: run.branch, baseline: '', index: 0, tasks: [], results: [], phase: 'planner', child: null, settings: run.specification.settings };
  const structured = { ...state, protocol: 'structured-v1', phase: 'executor', child: 'ses_child', tasks: [{ id: 'T1', title: 'T', brief: 'B', dependsOn: [], dod: ['gate one'] }], attempt: { id: 'attempt_1', phase: 'executor', index: 0, child: 'ses_child', status: 'admitted', startedAt: 1, model: 'anthropic/x' }, settings: { ...state.settings, plannerAgent: 'planner', executorAgent: 'executor', maxTasks: 10 } };
  structured.submissionBinding = recordDispatchPrompt(openSubmissionBinding(structured, 1), 'prompt_1');
  await f.client.request('PUT', `/runs/${run.id}/checkpoint`, structured, run.ownerToken);
  const gate = createDurableSubmissionGate({
    runId: run.id, directory: f.temporary,
    origin: native => ({ msg_1: 'prompt_1', msg_old: 'prompt_0' })[native.messageID], // Stands in for native observation of the child.
    persistence: {
      load: async () => structured,
      readSubmission: async (id, attempt, kind) => f.client.request('GET', `/runs/${id}/submissions/${attempt}/${kind}`, undefined, run.ownerToken),
      writeSubmission: async (id, receipt) => f.client.request('PUT', `/runs/${id}/submissions/${receipt.attemptId}/${receipt.kind}`, receipt, run.ownerToken),
    },
  });
  const raw = { status: 'completed', summary: 'Done', handoff: 'Next', evidence: [{ gateId: 'G1', passed: true, detail: 'proved' }] };
  const native = { sessionID: 'ses_child', agent: 'executor', messageID: 'msg_1', id: 'call_1' };
  const route = `/runs/${run.id}/submissions/attempt_1/executor-result`;
  assert.equal(await f.client.request('GET', route, undefined, run.ownerToken), null);
  const staleCall = await gate.submit('executor-result', raw, { ...native, messageID: 'msg_old', id: 'call_stale' });
  assert.equal(staleCall.code, 'unauthorized', 'a call from another dispatch prompt is not admitted');
  assert.equal(await f.client.request('GET', route, undefined, run.ownerToken), null);
  const ack = await gate.submit('executor-result', raw, native);
  assert.equal(ack.accepted, true);
  const stored = await f.client.request('GET', route, undefined, run.ownerToken);
  assert.equal(stored.digest, ack.digest);
  assert.deepEqual(stored.rawPayload, raw);
  assert.deepEqual(await gate.submit('executor-result', raw, { ...native, id: 'call_2' }), ack);
  assert.equal((await gate.submit('executor-result', { ...raw, summary: 'Changed' }, native)).code, 'conflict');
  assert.deepEqual(await f.client.request('GET', route, undefined, run.ownerToken), stored);
  // Route identity, other owners and the administrator.
  await assert.rejects(f.client.request('PUT', `/runs/${run.id}/submissions/attempt_2/executor-result`, stored, run.ownerToken), /route/);
  await assert.rejects(f.client.request('PUT', `/runs/${run.id}/submissions/attempt_1/planner-plan`, stored, run.ownerToken), /route/);
  await assert.rejects(f.client.request('GET', `/runs/${run.id}/submissions/attempt_1/bogus`, undefined, run.ownerToken), /kind/);
  await assert.rejects(f.client.request('PUT', route, { ...stored, rawPayload: { changed: true } }, run.ownerToken), /immutable/);
  await assert.rejects(f.client.request('GET', route, undefined, 'wrong-token'), /authorization/);
  await assert.rejects(f.client.request('PUT', route, stored), /Unknown coordinator route/);
  const outcome = { outcomeVersion: 1, runId: run.id, phase: 'executor', index: 0, attemptId: 'attempt_1', child: 'ses_child', response: 'text', capturedAt: 1 };
  assert.equal(await f.client.request('GET', `/runs/${run.id}/outcomes/attempt_1`, undefined, run.ownerToken), null);
  assert.deepEqual(await f.client.request('PUT', `/runs/${run.id}/outcomes/attempt_1`, outcome, run.ownerToken), outcome);
  await assert.rejects(f.client.request('PUT', `/runs/${run.id}/outcomes/attempt_2`, outcome, run.ownerToken), /route/);
  await assert.rejects(f.client.request('PUT', `/runs/${run.id}/outcomes/attempt_1`, { ...outcome, response: 'other' }, run.ownerToken), /immutable/);
  // The stored receipt survives a coordinator restart.
  await f.restart();
  assert.deepEqual(f.service().store.readSubmission(run.id, run.ownerToken, 'attempt_1', 'executor-result'), stored);
  const events = JSON.stringify(await f.client.request('GET', '/events'));
  assert.ok(events.includes('submission.saved'));
  assert.ok(!events.includes('proved') && !events.includes(run.ownerToken), 'events carry no submission text or capability');
});

test('a submitted run is admitted with its runtime identity and launched from an immutable run-owned snapshot', async t => {
  const f = await fixture(t);
  const before = git(f.project, ['status', '--porcelain']);
  const project = await f.client.request('POST', '/projects', { directory: f.project });
  const submitted = await f.client.request('POST', '/runs', { projectId: project.id, feature: 'Feature' });
  const loaded = runtimeIdentity();
  assert.equal(Object.hasOwn(submitted, 'specification'), false, 'the specification stays private');
  assert.equal(f.service().store.getRun(submitted.id).specification.runtime.identity.build.digest, loaded.build.digest);
  await f.service().scheduler.tick();
  const run = await settled(f.service().store, submitted.id);
  assert.equal(run.status, 'running', run.reason ?? '');
  const snapshot = path.join(path.dirname(run.worktreePath), 'runtime');
  const shim = await fs.readFile(path.join(run.worktreePath, '.opencode/plugins/heimdall.ts'), 'utf8');
  assert.ok(shim.includes(pathToFileURL(path.join(snapshot, 'dist/opencode/plugin.js')).href), 'the loader imports the snapshot');
  assert.ok(shim.includes(`expectedRuntime: "${loaded.build.digest}"`));
  assert.ok(!shim.includes(pathToFileURL(path.join(sourcePackageRoot(), 'dist/')).href), 'not the live package');
  assert.equal(computeRuntimeIdentity(snapshot).build.digest, loaded.build.digest);
  assert.equal(run.specification.runtime.modules, await fs.realpath(path.join(sourcePackageRoot(), 'node_modules')));
  assert.equal(git(f.project, ['status', '--porcelain']), before, 'the source checkout is untouched');
});

test('a run queued before the coordinator started is admitted by the new instance under the normal admission rules', async t => {
  const f = await fixture(t);
  const project = await f.client.request('POST', '/projects', { directory: f.project });
  const queued = await f.client.request('POST', '/runs', { projectId: project.id, feature: 'Feature' });
  assert.equal(f.service().store.getRun(queued.id).status, 'queued');
  assert.equal(f.launches.length, 0, 'submission alone does not admit');
  await f.restart();
  const waiting = f.service().store.getRun(queued.id);
  assert.equal(waiting.status, 'queued', 'starting the coordinator does not admit by itself');
  assert.equal(waiting.capacityReserved, false);
  assert.equal(f.launches.length, 0);
  await f.service().scheduler.tick();
  const run = await settled(f.service().store, queued.id);
  assert.equal(run.status, 'running', run.reason ?? '');
  await f.waitForLaunch(1);
  assert.equal(f.launches.length, 1);
  assert.equal(f.launches[0].id, queued.id);
});

// --- Approval requests and owner decisions ----------------------------------------------------------------------------

const approvalPayload = overrides => ({
  status: 'approval-required', question: 'Ship the change?', scope: 'Merge only the reviewed commit', completedWork: 'Implemented and tested',
  verification: ['npm test: 12 passed'], artifacts: ['README.md'], onApprove: ['Merge the branch'], onRequestChanges: ['Correct and ask again'], ...overrides,
});
function approvalReceipt(run, state, payload = approvalPayload(), overrides = {}) {
  const canonical = { ...payload, taskId: 'T1' };
  const contract = contractRef('executor-result');
  return {
    receiptVersion: 1, protocol: 'structured-v1', contract, kind: 'executor-result', runId: run.id, phase: 'executor', index: 0, taskId: 'T1',
    attemptId: 'attempt_1', dispatch: 1, parent: state.parent, child: 'ses_child', origin: 'prompt_1',
    caller: { sessionID: 'ses_child', agent: 'executor', messageID: 'msg_1', callId: 'call_1' }, runtime: { packageVersion: '0.0.0', protocol: 'structured-v1' },
    outcome: 'approval-required', rawPayload: payload, canonical, digest: contractDigest(contract, canonical), acceptedAt: 1, ...overrides,
  };
}
const status = (statusCode, code) => error => error.statusCode === statusCode && (code === undefined || error.code === code);

/** A coordinator with a real managed worktree, a structured executor checkpoint and one published approval request. */
async function published(t, { payload = approvalPayload(), prepare, project: configure } = {}) {
  const f = await fixture(t);
  if (configure) await configure(f);
  const project = await f.client.request('POST', '/projects', { directory: f.project });
  const queued = await f.client.request('POST', '/runs', { projectId: project.id, feature: 'Feature' });
  await f.service().scheduler.tick();
  const run = await settled(f.service().store, queued.id);
  if (prepare) await prepare(run.worktreePath);
  const caller = { sessionID: run.parentSessionId, id: 'native_call', messageID: 'assistant_message', agent: 'adr-orchestrator' };
  await f.client.request('POST', `/runs/${run.id}/binding`, caller, run.ownerToken);
  const base = { id: run.id, status: 'running', adr: '.heimdall/feature.md', parent: run.parentSessionId, caller, branch: run.branch, baseline: '', index: 0, tasks: [], results: [], phase: 'planner', child: null, settings: run.specification.settings };
  const state = {
    ...base, protocol: 'structured-v1', phase: 'executor', child: 'ses_child', tasks: [{ id: 'T1', title: 'Synthetic task', brief: 'B', dependsOn: [], dod: ['gate one'] }],
    attempt: { id: 'attempt_1', phase: 'executor', index: 0, child: 'ses_child', status: 'admitted', startedAt: 1, model: 'anthropic/x' },
    settings: { ...base.settings, plannerAgent: 'planner', executorAgent: 'executor', maxTasks: 10 },
  };
  state.submissionBinding = recordDispatchPrompt(openSubmissionBinding(state, 1), 'prompt_1');
  await f.client.request('PUT', `/runs/${run.id}/checkpoint`, state, run.ownerToken);
  const route = `/runs/${run.id}/submissions/attempt_1/executor-result`;
  const receipt = approvalReceipt(run, state, payload);
  await f.client.request('PUT', route, receipt, run.ownerToken);
  const store = f.service().store;
  const request = store.latestApproval(run.id);
  const decide = (input, requestId = request.requestId, runId = run.id) => f.client.request('POST', `/runs/${runId}/approvals/${requestId}/decision`, input);
  return {
    f, project, run, state, receipt, route, request, decide, store, caller,
    inspect: (requestId = request.requestId) => f.client.request('GET', `/runs/${run.id}/approvals/${requestId}`),
    /** The runner's pause on a valid approval request, then the scheduler's proof that the run is idle. */
    async pause({ idle = false } = {}) {
      const paused = { ...state, status: 'paused', attempt: { ...state.attempt, status: 'rejected' }, wait: { kind: 'approval', attemptId: 'attempt_1', index: 0, taskId: 'T1' } };
      await f.client.request('PUT', `/runs/${run.id}/checkpoint`, paused, run.ownerToken);
      f.observation({ idle: true, status: 'paused', reason: 'Approval required' });
      await f.service().scheduler.tick();
      assert.equal(store.getRun(run.id).status, 'paused');
      assert.equal(store.getRun(run.id).capacityReserved, false);
      // Without fresh idle proof at decision time a decision is only recorded; tests of the continuation ask for `idle`.
      if (!idle) f.observation({ idle: false, status: 'unknown' });
      return paused;
    },
    sql(statement, ...values) {
      const database = new DatabaseSync(path.join(f.state, 'coordinator.sqlite'));
      try { return database.prepare(statement).all(...values); } finally { database.close(); }
    },
  };
}
const gitIn = (directory, args) => git(directory, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args]);

test('an approval-required submission publishes exactly one request bound to server-derived identity and revision', async t => {
  const p = await published(t);
  const { request, run } = p;
  assert.match(request.requestId, /^apr_/);
  assert.deepEqual({ runId: request.runId, phase: request.phase, taskIndex: request.taskIndex, taskId: request.taskId, attemptId: request.attemptId, state: request.state }, { runId: run.id, phase: 'executor', taskIndex: 0, taskId: 'T1', attemptId: 'attempt_1', state: 'pending' });
  assert.deepEqual(request.revision, await computeReviewRevision(run.worktreePath, { roles: Object.keys(run.specification.agents) }));
  assert.equal(request.revision.head, git(run.worktreePath, ['rev-parse', 'HEAD']));
  assert.equal(request.request.question, 'Ship the change?');
  assert.equal(Object.hasOwn(request.request, 'status'), false);
  const events = () => p.store.events().filter(event => event.type === 'approval.requested');
  assert.equal(events().length, 1);
  assert.ok(!JSON.stringify(events()).includes('Ship the change?'));
  // An identical duplicate write, with another native call identity, creates nothing.
  const duplicate = approvalReceipt(run, p.state, approvalPayload(), { acceptedAt: 5, caller: { ...p.receipt.caller, callId: 'call_2', messageID: 'msg_2' } });
  assert.deepEqual(await p.f.client.request('PUT', p.route, duplicate, run.ownerToken), p.receipt);
  assert.equal(events().length, 1);
  assert.equal(p.sql('SELECT count(*) AS count FROM approval_requests')[0].count, 1);
  assert.deepEqual(p.store.latestApproval(run.id), request);
  // The request survives a coordinator restart and is still pending.
  await p.f.restart();
  const restarted = p.f.service().store.getApproval(run.id, request.requestId);
  assert.equal(restarted.state, 'pending');
  assert.deepEqual(restarted.revision, request.revision);
});

test('the administrator records approve once; an identical retry returns the stored acknowledgement after the run advances', async t => {
  const p = await published(t);
  await p.pause();
  const ack = await p.decide({ decision: 'approve' });
  assert.deepEqual(Object.keys(ack).sort(), ['continuation', 'decision', 'recordedAt', 'requestId', 'retried', 'run', 'runId']);
  assert.deepEqual({ runId: ack.runId, requestId: ack.requestId, decision: ack.decision, retried: ack.retried, continuation: ack.continuation, status: ack.run.status }, { runId: p.run.id, requestId: p.request.requestId, decision: 'approve', retried: false, continuation: 'pending', status: 'paused' });
  assert.equal(typeof ack.run.version, 'number');
  const recorded = await p.inspect();
  assert.equal(recorded.state, 'answered');
  assert.equal(recorded.decision, 'approve');
  assert.equal(recorded.feedback, null);
  assert.equal(recorded.continuation, 'pending');
  assert.deepEqual(recorded.ack, ack);
  assert.deepEqual(await p.decide({ decision: 'approve' }), { ...ack, retried: true });
  await assert.rejects(p.decide({ decision: 'request-changes', feedback: 'Actually no' }), status(409, 'approval-conflict'));
  assert.equal((await p.inspect()).decision, 'approve');
  assert.equal(p.store.events().filter(event => event.type === 'approval.answered').length, 1);
  // Later advancement: the continuation is consumed, the run is resumed and admitted again.
  p.sql("UPDATE approval_requests SET continuation = 'consumed', consumed_attempt_id = 'attempt_next' WHERE request_id = ?", p.request.requestId);
  p.f.observation({ idle: true, status: 'paused', reason: 'Approval required' });
  const resumed = await p.f.client.request('POST', `/runs/${p.run.id}/resume`, { input: 'Carry on' });
  assert.equal(resumed.status, 'queued');
  await p.f.service().scheduler.tick();
  await settled(p.store, p.run.id);
  await p.f.waitForLaunch(2);
  assert.deepEqual(await p.decide({ decision: 'approve' }), { ...ack, retried: true });
  assert.equal(p.store.events().filter(event => event.type === 'approval.answered').length, 1);
});

test('request-changes stores multiline feedback verbatim; empty, mismatched and unknown fields are refused with nothing recorded', async t => {
  const p = await published(t);
  const feedback = '  Please rename the helper.\n\n- keep the tests\n\ttab and trailing space \n';
  for (const bad of [
    { decision: 'request-changes' }, { decision: 'request-changes', feedback: '' }, { decision: 'request-changes', feedback: ' \n\t ' },
    { decision: 'request-changes', feedback: 7 }, { decision: 'request-changes', feedback: 'x'.repeat(8001) },
    { decision: 'approve', feedback: 'extra' }, { decision: 'approve', feedback: '' }, { decision: 'maybe' }, {}, { decision: 'approve', state: 'answered' },
    { decision: 'approve', revision: { head: 'a', digest: 'b' } },
  ]) await assert.rejects(p.decide(bad), status(400), JSON.stringify(bad).slice(0, 60));
  assert.equal((await p.inspect()).state, 'pending');
  assert.equal(p.store.events().filter(event => event.type === 'approval.answered').length, 0);
  const ack = await p.decide({ decision: 'request-changes', feedback });
  assert.equal(ack.decision, 'request-changes');
  const recorded = await p.inspect();
  assert.equal(recorded.feedback, feedback);
  assert.equal(recorded.state, 'answered');
  assert.deepEqual(await p.decide({ decision: 'request-changes', feedback }), { ...ack, retried: true });
  await assert.rejects(p.decide({ decision: 'request-changes', feedback: feedback.trim() }), status(409, 'approval-conflict'));
  await assert.rejects(p.decide({ decision: 'approve' }), status(409, 'approval-conflict'));
  assert.equal((await p.inspect()).feedback, feedback);
  // A request closed by changes can never later be approved, and the next proposal has its own request.
  assert.equal(p.store.getApproval(p.run.id, p.request.requestId).decision, 'request-changes');
});

test('a decision names this run and an existing request; foreign and unknown requests are not found', async t => {
  const p = await published(t);
  const other = await p.f.client.request('POST', '/runs', { projectId: p.project.id, feature: 'Another feature' });
  await assert.rejects(p.decide({ decision: 'approve' }, p.request.requestId, other.id), status(404, 'approval-not-found'));
  await assert.rejects(p.f.client.request('GET', `/runs/${other.id}/approvals/${p.request.requestId}`), status(404, 'approval-not-found'));
  await assert.rejects(p.decide({ decision: 'approve' }, 'apr_unknown'), status(404, 'approval-not-found'));
  await assert.rejects(p.decide({ decision: 'approve' }, p.request.requestId, 'no-such-run'), status(404));
  await assert.rejects(p.decide({ decision: 'approve' }, 'bad%20id'), status(400));
  assert.equal((await p.inspect()).state, 'pending');
  assert.equal(p.store.getApproval(other.id, p.request.requestId), null);
});

test('the approval read returns a legal long request in full while the run view clips it, and reading changes nothing', async t => {
  for (const [name, content] of [['hidden tail', hiddenTailRequest()], ['near the payload limit', nearLimitRequest()]]) {
    // The request goes through the real contract and publication path, so the stored content is what a legal agent can send.
    const p = await published(t, { payload: approvalPayload(content) });
    const route = `/runs/${p.run.id}/approvals/${p.request.requestId}`;
    const view = await p.f.client.request('GET', route);
    for (const field of ['question', 'scope', 'completedWork', 'verification', 'artifacts', 'onApprove', 'onRequestChanges']) assert.deepEqual(view.request[field], content[field], `${name}: ${field}`);
    const compact = p.store.approvalWait(p.store.getRun(p.run.id));
    assert.equal(compact?.clipped.scope, true, `${name}: the run projection says it clipped the scope`);
    const run = p.store.getRun(p.run.id);
    const before = JSON.stringify({ run: { version: run.version, status: run.status, updatedAt: run.updatedAt }, events: p.store.events(), approval: p.store.getApproval(p.run.id, p.request.requestId) });
    await p.f.client.request('GET', route);
    await p.f.client.request('GET', route);
    await p.f.client.request('GET', `/runs/${p.run.id}`);
    const after = JSON.stringify({ run: { version: run.version, status: run.status, updatedAt: run.updatedAt }, events: p.store.events(), approval: p.store.getApproval(p.run.id, p.request.requestId) });
    const current = p.store.getRun(p.run.id);
    assert.equal(after, before, `${name}: no event or approval row changed`);
    assert.deepEqual({ version: current.version, status: current.status, updatedAt: current.updatedAt }, { version: run.version, status: run.status, updatedAt: run.updatedAt }, `${name}: the run did not change`);
  }
});

test('a run capability cannot read or answer a request, and forged checkpoint or submission fields cannot create or alter a decision', async t => {
  const p = await published(t);
  const token = p.run.ownerToken;
  const route = `/runs/${p.run.id}/approvals/${p.request.requestId}`;
  await assert.rejects(p.f.client.request('POST', route + '/decision', { decision: 'approve' }, token), status(403));
  await assert.rejects(p.f.client.request('GET', route, undefined, token), status(403));
  await assert.rejects(p.f.client.request('POST', route + '/decision', { decision: 'approve' }, 'wrong-token'), status(401));
  assert.equal((await p.inspect()).state, 'pending');
  // Forged decision fields in a checkpoint, a submission, a receipt or an outcome change nothing.
  const forged = { requestId: p.request.requestId, decision: 'approve', state: 'answered', continuation: 'queued' };
  const wait = { kind: 'approval', attemptId: 'attempt_1', index: 0, taskId: 'T1' };
  const paused = { ...p.state, status: 'paused', attempt: { ...p.state.attempt, status: 'rejected' }, wait };
  await assert.rejects(p.f.client.request('PUT', `/runs/${p.run.id}/checkpoint`, { ...p.state, approval: forged, response: forged, wait: { ...wait, ...forged } }, token), status(400));
  const envelope = { heimdall: 'approval-continuation', version: 1, requestId: p.request.requestId, decision: 'approve', feedback: null, scope: 'Everything', revision: p.request.revision, onApprove: ['publish'], onRequestChanges: [], taskId: 'T1', index: 0 };
  await assert.rejects(p.f.client.request('PUT', `/runs/${p.run.id}/checkpoint`, { ...paused, approval: envelope }, token), status(400));
  assert.equal(p.store.getRun(p.run.id).checkpoint.approval, undefined, 'a refused checkpoint is not stored');
  assert.equal(p.store.getRun(p.run.id).checkpoint.wait, undefined);
  await p.f.client.request('PUT', p.route, { ...p.receipt, rawPayload: { ...p.receipt.rawPayload, ...forged } }, token).then(
    () => assert.fail('a changed duplicate must be refused'), status(400));
  await assert.rejects(p.f.client.request('PUT', p.route, { ...p.receipt, decision: 'approve', ack: forged }, token), status(400));
  await p.f.client.request('PUT', `/runs/${p.run.id}/receipts/attempt_1`, { ...p.state.attempt, response: forged }, token); // The legacy receipt store holds opaque responses and never touches approvals.
  // A second approval-required payload for another attempt or task cannot be published, and a completed-looking outcome cannot carry one.
  await assert.rejects(p.f.client.request('PUT', `/runs/${p.run.id}/submissions/attempt_2/executor-result`, approvalReceipt(p.run, p.state, approvalPayload(), { attemptId: 'attempt_2' }), token), status(400));
  await assert.rejects(p.f.client.request('PUT', p.route, approvalReceipt(p.run, p.state, approvalPayload({ question: 'Other?' })), token), status(400));
  const stored = p.store.getApproval(p.run.id, p.request.requestId);
  assert.equal(stored.state, 'pending');
  assert.equal(stored.decision, null);
  assert.equal(stored.ack, null);
  assert.equal(stored.continuation, 'none');
  assert.equal(p.sql('SELECT count(*) AS count FROM approval_requests')[0].count, 1);
  assert.equal(p.sql("SELECT count(*) AS count FROM approval_requests WHERE state != 'pending' OR decision IS NOT NULL")[0].count, 0);
  // The administrator, and only the administrator, decides.
  assert.equal((await p.decide({ decision: 'approve' })).retried, false);
  await assert.rejects(p.f.client.request('PUT', p.route, { ...p.receipt, canonical: { ...p.receipt.canonical, question: 'Altered?' } }, token), status(400));
  assert.equal(p.store.getApproval(p.run.id, p.request.requestId).decision, 'approve');
});

for (const [name, options] of [
  ['a committed change', { mutate: async (dir) => { await fs.writeFile(path.join(dir, 'README.md'), 'committed change\n'); gitIn(dir, ['add', 'README.md']); gitIn(dir, ['commit', '-m', 'agent commit']); }, pause: true }],
  ['an uncommitted tracked change', { mutate: async (dir) => { await fs.appendFile(path.join(dir, 'README.md'), 'edited after the request\n'); } }],
  ['a staged change', { mutate: async (dir) => { await fs.appendFile(path.join(dir, 'README.md'), 'staged\n'); gitIn(dir, ['add', 'README.md']); } }],
  ['a new untracked file', { mutate: async (dir) => { await fs.writeFile(path.join(dir, 'new-file.txt'), 'added after the request\n'); } }],
  ['an edited untracked file', { prepare: async (dir) => { await fs.writeFile(path.join(dir, 'draft.txt'), 'one\n'); }, mutate: async (dir) => { await fs.writeFile(path.join(dir, 'draft.txt'), 'two\n'); }, pause: true }],
  ['a deleted tracked file', { mutate: async (dir) => { await fs.rm(path.join(dir, 'README.md')); } }],
]) {
  test(`${name} supersedes the request, refuses the decision and records nothing`, async t => {
    const p = await published(t, { prepare: options.prepare });
    if (options.pause) await p.pause();
    await options.mutate(p.run.worktreePath);
    await assert.rejects(p.decide({ decision: 'approve' }), status(409, 'approval-stale'));
    const stored = await p.inspect();
    assert.equal(stored.state, 'superseded');
    assert.equal(stored.decision, null);
    assert.equal(stored.ack, null);
    assert.equal(stored.continuation, 'none');
    assert.match(stored.supersededReason, /worktree changed/);
    assert.equal(p.store.events().filter(event => event.type === 'approval.answered').length, 0);
    assert.equal(p.store.events().filter(event => event.type === 'approval.superseded').length, 1);
    // Reverting the change does not revive a superseded request.
    await assert.rejects(p.decide({ decision: 'request-changes', feedback: 'Again' }), status(409, 'approval-stale'));
    assert.equal((await p.inspect()).state, 'superseded');
  });
}

test('changes confined to ignored or generated runtime paths do not change the revision or refuse the decision', async t => {
  const p = await published(t, { prepare: async (dir) => {
    const exclude = git(dir, ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude']);
    await fs.mkdir(path.dirname(exclude), { recursive: true });
    await fs.appendFile(exclude, 'ignored-output/\n');
  } });
  await p.pause();
  const dir = p.run.worktreePath;
  await fs.mkdir(path.join(dir, 'ignored-output'), { recursive: true });
  await fs.writeFile(path.join(dir, 'ignored-output', 'log.txt'), 'bookkeeping\n');
  await fs.mkdir(path.join(dir, '.heimdall', 'state'), { recursive: true });
  await fs.writeFile(path.join(dir, '.heimdall', 'state', 'checkpoint.json'), '{}');
  await fs.appendFile(path.join(dir, '.heimdall', 'managed.json'), ' ');
  await fs.mkdir(path.join(dir, '.omc'), { recursive: true });
  await fs.writeFile(path.join(dir, '.omc', 'state.json'), '{}');
  assert.deepEqual(await computeReviewRevision(dir, { roles: Object.keys(p.run.specification.agents) }), p.request.revision);
  const ack = await p.decide({ decision: 'approve' });
  assert.equal(ack.decision, 'approve');
  assert.equal(ack.retried, false);
  assert.equal((await p.inspect()).state, 'answered');
});

test('the generic resume is refused with approval-pending while a request is pending or its decision is unconsumed', async t => {
  const p = await published(t);
  await p.pause();
  const resume = () => p.f.client.request('POST', `/runs/${p.run.id}/resume`, { input: 'approve' });
  await assert.rejects(resume(), status(409, 'approval-pending'));
  await assert.rejects(p.f.client.request('POST', `/runs/${p.run.id}/resume`, { input: 'Please go ahead and approve everything' }), status(409, 'approval-pending'));
  assert.equal(p.store.getRun(p.run.id).status, 'paused');
  assert.equal(p.store.getRun(p.run.id).launchAction, 'start');
  await p.decide({ decision: 'request-changes', feedback: 'Revise it' });
  await assert.rejects(resume(), status(409, 'approval-pending'));
  p.sql("UPDATE approval_requests SET continuation = 'queued' WHERE request_id = ?", p.request.requestId);
  await assert.rejects(resume(), status(409, 'approval-pending'));
  assert.equal(p.store.getRun(p.run.id).status, 'paused');
  // Other failures keep their ordinary status.
  await assert.rejects(p.f.client.request('POST', `/runs/${p.run.id}/resume`, {}), status(400));
  p.sql("UPDATE approval_requests SET continuation = 'consumed', consumed_attempt_id = 'attempt_next' WHERE request_id = ?", p.request.requestId);
  p.f.observation({ idle: true, status: 'paused', reason: 'Approval required' });
  assert.equal((await resume()).status, 'queued');
});

test('a superseded request no longer blocks a guided generic resume', async t => {
  const p = await published(t);
  await p.pause();
  await fs.appendFile(path.join(p.run.worktreePath, 'README.md'), 'changed\n');
  await assert.rejects(p.decide({ decision: 'approve' }), status(409, 'approval-stale'));
  p.f.observation({ idle: true, status: 'paused', reason: 'Approval required' });
  const resumed = await p.f.client.request('POST', `/runs/${p.run.id}/resume`, { input: 'The tree changed; ask again' });
  assert.equal(resumed.status, 'queued');
});

async function supersededAndIdle(t) {
  const p = await published(t);
  await p.pause();
  await fs.appendFile(path.join(p.run.worktreePath, 'README.md'), 'changed\n');
  await assert.rejects(p.decide({ decision: 'approve' }), status(409, 'approval-stale'));
  assert.equal((await p.inspect()).state, 'superseded');
  p.f.observation({ idle: true, status: 'paused', reason: 'Approval required' });
  return p;
}

test('a released pause on a superseded request has a pause identity, so the guarded and labelled response applies', async t => {
  const p = await supersededAndIdle(t);
  const shown = await p.f.client.request('GET', `/runs/${p.run.id}`);
  assert.equal(shown.wait.kind, 'generic', 'the owner is offered the guarded response, not the unguarded resume');
  assert.match(shown.wait.pauseId, /^pau_/);
  const listed = (await p.f.client.request('GET', '/runs')).find(run => run.id === p.run.id);
  assert.deepEqual([listed.wait.kind, listed.wait.pauseId], ['generic', shown.wait.pauseId]);
  const ack = await p.f.client.request('POST', `/runs/${p.run.id}/respond`, { pauseId: shown.wait.pauseId, input: 'approve' });
  assert.equal(ack.continuation, 'queued');
  const resolution = p.store.getRun(p.run.id).resolution;
  assert.notEqual(resolution, 'approve');
  assert.match(resolution, /not a typed approval/);
  assert.ok(resolution.endsWith('\napprove'));
});

test('an unguarded resume of a run that used typed approvals reaches the agent as labelled guidance, never as bare text', async t => {
  const p = await supersededAndIdle(t);
  const resumed = await p.f.client.request('POST', `/runs/${p.run.id}/resume`, { input: 'approve' });
  assert.equal(resumed.status, 'queued');
  const resolution = p.store.getRun(p.run.id).resolution;
  assert.notEqual(resolution, 'approve', 'a bare approve is not an owner decision');
  assert.match(resolution, /^Owner guidance \(response to pause pau_[0-9a-f]{32}; this is not a typed approval/);
  assert.ok(resolution.endsWith('\napprove'));
});

test('a run without any typed approval keeps its plain resume text', async t => {
  const f = await fixture(t);
  const project = await f.client.request('POST', '/projects', { directory: f.project });
  const queued = await f.client.request('POST', '/runs', { projectId: project.id, feature: 'Feature' });
  await f.service().scheduler.tick();
  const run = await settled(f.service().store, queued.id);
  const store = f.service().store;
  const caller = { sessionID: run.parentSessionId, id: 'native_call', messageID: 'assistant_message', agent: 'adr-orchestrator' };
  await f.client.request('POST', `/runs/${run.id}/binding`, caller, run.ownerToken);
  const paused = { id: run.id, status: 'paused', adr: '.heimdall/feature.md', parent: run.parentSessionId, caller, branch: run.branch, baseline: '', index: 0, tasks: [], results: [], phase: 'planner', child: null, settings: run.specification.settings, reason: 'Blocked: which database?' };
  await f.client.request('PUT', `/runs/${run.id}/checkpoint`, paused, run.ownerToken);
  f.observation({ idle: true, status: 'paused', reason: 'Blocked' });
  await f.service().scheduler.tick();
  assert.equal(store.getRun(run.id).status, 'paused');
  assert.equal((await f.client.request('POST', `/runs/${run.id}/resume`, { input: 'Use PostgreSQL' })).status, 'queued');
  assert.equal(store.getRun(run.id).resolution, 'Use PostgreSQL');
});

test('run projections carry a bounded wait object without capabilities, keys or the specification', async t => {
  const long = 'é'.repeat(2000);
  const p = await published(t, { payload: approvalPayload({
    question: long, scope: 'Scope', verification: Array.from({ length: 20 }, (_, index) => `check ${index} ` + 'é'.repeat(450)), artifacts: ['README.md'],
  }) });
  await p.pause();
  const key = (await fs.readFile(path.join(p.f.state, 'coordinator.key'), 'utf8')).trim();
  const prompt = p.store.getRun(p.run.id).specification.plannerPrompt;
  const single = await p.f.client.request('GET', `/runs/${p.run.id}`);
  const listed = (await p.f.client.request('GET', '/runs')).find(run => run.id === p.run.id);
  for (const view of [single, listed]) {
    const text = JSON.stringify(view);
    assert.ok(!text.includes(p.run.ownerToken) && !text.includes(key) && !text.includes(prompt), 'no capability, key or specification text');
    assert.ok(!Object.hasOwn(view, 'ownerToken') && !Object.hasOwn(view, 'specification') && !Object.hasOwn(view, 'binding'));
    assert.deepEqual(view.wait.requestId, p.request.requestId);
    assert.equal(view.wait.state, 'pending');
    assert.equal(view.wait.continuation, 'none');
    assert.equal(view.wait.taskTitle, 'Synthetic task');
    assert.equal(view.wait.attemptId, 'attempt_1');
    assert.equal(view.wait.question.length, 1500);
    assert.equal(view.wait.clipped.question, true);
    assert.equal(view.wait.verification.length, 10);
    assert.equal(view.wait.clipped.verification, true);
    assert.equal(view.wait.clipped.scope, false);
    assert.deepEqual(view.wait.revision, p.request.revision);
    assert.equal(view.wait.response, null);
    assert.ok(Buffer.byteLength(JSON.stringify(view.wait)) < 24 * 1024);
  }
  // The inspection route returns the full request text.
  assert.equal((await p.inspect()).request.question, long);
  await p.decide({ decision: 'request-changes', feedback: 'line one\nline two' });
  const answered = (await p.f.client.request('GET', `/runs/${p.run.id}`)).wait;
  assert.equal(answered.state, 'answered');
  assert.equal(answered.continuation, 'pending');
  assert.deepEqual({ decision: answered.response.decision, feedback: answered.response.feedback }, { decision: 'request-changes', feedback: 'line one\nline two' });
  assert.equal(typeof answered.response.answeredAt, 'number');
  const plain = await published(t);
  assert.equal(plain.request.state, 'pending');
  const other = await plain.f.client.request('POST', '/runs', { projectId: plain.project.id, feature: 'Another' });
  assert.equal(other.wait, null, 'a run without a request has no wait');
});

test('the review revision is deterministic, content based, bounded and read only', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hd-rev-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  git(directory, ['init', '-b', 'main']);
  await fs.writeFile(path.join(directory, '.gitignore'), 'out/\n');
  await fs.writeFile(path.join(directory, 'a.txt'), 'one\n');
  await fs.writeFile(path.join(directory, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
  git(directory, ['add', '.']);
  gitIn(directory, ['commit', '-m', 'base']);
  const index = await fs.readFile(path.join(directory, '.git', 'index'));
  const first = await computeReviewRevision(directory);
  assert.equal(first.head, git(directory, ['rev-parse', 'HEAD']));
  assert.match(first.digest, /^[a-f0-9]{64}$/);
  assert.deepEqual(await computeReviewRevision(directory), first);
  const changes = [];
  const differs = async (label, action) => {
    await action();
    const next = await computeReviewRevision(directory);
    assert.notEqual(next.digest, first.digest, label);
    changes.push(next.digest);
  };
  await differs('tracked edit', () => fs.writeFile(path.join(directory, 'a.txt'), 'two\n'));
  await fs.writeFile(path.join(directory, 'a.txt'), 'one\n');
  assert.deepEqual(await computeReviewRevision(directory), first, 'reverting restores the revision');
  await differs('binary edit', () => fs.writeFile(path.join(directory, 'blob.bin'), Buffer.from([0, 1, 2, 4])));
  await fs.writeFile(path.join(directory, 'blob.bin'), Buffer.from([0, 1, 2, 3]));
  await differs('untracked file', () => fs.writeFile(path.join(directory, 'u.txt'), 'u\n'));
  await differs('untracked content', () => fs.writeFile(path.join(directory, 'u.txt'), 'v\n'));
  await fs.rm(path.join(directory, 'u.txt'));
  await differs('untracked symlink', () => fs.symlink('a.txt', path.join(directory, 'link')));
  await fs.rm(path.join(directory, 'link'));
  await differs('similarly named runtime directory', () => fs.mkdir(path.join(directory, '.omcx')).then(() => fs.writeFile(path.join(directory, '.omcx', 'f'), 'x')));
  await fs.rm(path.join(directory, '.omcx'), { recursive: true });
  assert.equal(new Set(changes).size, changes.length);
  for (const ignored of ['out/log', '.heimdall/managed.json', '.heimdall/state/x/y', '.omc/a', '.opencode/plugins/heimdall.ts']) {
    await fs.mkdir(path.dirname(path.join(directory, ignored)), { recursive: true });
    await fs.writeFile(path.join(directory, ignored), 'generated ' + ignored);
    assert.deepEqual(await computeReviewRevision(directory), first, ignored);
  }
  await fs.mkdir(path.join(directory, '.opencode', 'agents'), { recursive: true });
  await fs.writeFile(path.join(directory, '.opencode', 'agents', 'executor.md'), 'role');
  assert.deepEqual(await computeReviewRevision(directory, { roles: ['executor'] }), first);
  assert.notDeepEqual(await computeReviewRevision(directory), first, 'an unlisted agent file is feature content');
  await fs.rm(path.join(directory, '.opencode', 'agents'), { recursive: true });
  assert.deepEqual(await fs.readFile(path.join(directory, '.git', 'index')), index, 'measuring never rewrites the index');
  assert.equal(git(directory, ['status', '--porcelain']).includes('a.txt'), false);
  // Bounds fail clearly instead of returning a partial digest.
  await fs.writeFile(path.join(directory, 'big.bin'), Buffer.alloc(64 * 1024, 7));
  await assert.rejects(computeReviewRevision(directory, { maxBytes: 16 * 1024 }), error => error instanceof ReviewRevisionError && error.code === 'revision-too-large');
  await assert.rejects(computeReviewRevision(directory, { maxFiles: 0 }), error => error.code === 'revision-too-large');
  await assert.rejects(computeReviewRevision(directory, { timeoutMs: 1 }), error => error instanceof ReviewRevisionError && error.code === 'revision-timeout');
  const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'hd-rev-plain-'));
  t.after(() => fs.rm(plain, { recursive: true, force: true }));
  await assert.rejects(computeReviewRevision(plain), error => error instanceof ReviewRevisionError && error.code === 'revision-unavailable' && !error.message.includes(plain));
});

// --- Owner decisions: once-only continuation ------------------------------------------------------------------------------

const IDLE = { idle: true, status: 'paused', reason: 'Approval required' };
const ACTIVE = { idle: false, status: 'unknown' };
const context = run => JSON.parse(run.resolution);

test('approve on a paused, idle run queues exactly one resume and the dispatch delivers the decision context once', async t => {
  const p = await published(t);
  const before = p.store.getRun(p.run.id);
  await p.pause({ idle: true });
  const paused = p.store.getRun(p.run.id);
  assert.equal(paused.status, 'paused');
  // A double submission, concurrently: one recorded decision, one queue.
  const acks = await Promise.all([p.decide({ decision: 'approve' }), p.decide({ decision: 'approve' })]);
  assert.deepEqual(acks.map(ack => ack.retried).sort(), [false, true]);
  assert.ok(acks.every(ack => ack.continuation === 'queued' && ack.run.status === 'queued'));
  const queued = p.store.getRun(p.run.id);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.launchAction, 'resume');
  const view = await p.inspect();
  assert.equal(view.progress, 'queued');
  assert.equal(view.continuation, 'queued');
  assert.deepEqual(context(queued), { heimdall: 'approval-continuation', version: 1, requestId: p.request.requestId, decision: 'approve', feedback: null, scope: 'Merge only the reviewed commit', revision: p.request.revision, onApprove: ['Merge the branch'], onRequestChanges: ['Correct and ask again'], taskId: 'T1', index: 0 });
  assert.equal(p.store.events().filter(event => event.type === 'approval.continuation_queued').length, 1);
  // The generic resume cannot replace or race the answered, unconsumed decision.
  await assert.rejects(p.f.client.request('POST', `/runs/${p.run.id}/resume`, { input: 'approve' }), status(409, 'approval-pending'));
  assert.equal(p.store.getRun(p.run.id).resolution, queued.resolution);
  await p.f.service().scheduler.tick();
  const admitted = await settled(p.store, p.run.id);
  await p.f.waitForLaunch(2);
  assert.equal(p.f.launches.length, 2, 'one admission');
  assert.equal(p.f.launches[1].resolution, queued.resolution);
  assert.deepEqual([admitted.id, admitted.parentSessionId, admitted.branch, admitted.worktreePath], [before.id, before.parentSessionId, before.branch, before.worktreePath]);
  assert.notEqual(admitted.ownerToken, before.ownerToken);
  const dispatched = await p.inspect();
  assert.equal(dispatched.continuation, 'consumed');
  assert.equal(dispatched.progress, 'executing', 'dispatched is not delivered: no attempt carried the decision yet');
  assert.equal((await p.f.client.request('GET', `/runs/${p.run.id}`)).wait.progress, 'executing');
  assert.deepEqual(await p.decide({ decision: 'approve' }), { ...acks.find(ack => !ack.retried), retried: true });
  assert.equal(p.store.events().filter(event => event.type === 'approval.consumed').length, 1);
  // The resumed runner carries the decision into its first checkpoint; only then is it delivered and history.
  const claimed = { sessionID: admitted.parentSessionId, id: 'resume_call', messageID: 'resume_message', agent: 'adr-orchestrator' };
  await p.f.client.request('POST', `/runs/${p.run.id}/resume-binding`, claimed, admitted.ownerToken);
  const carrying = { ...p.state, caller: claimed, status: 'running', approval: context(admitted), attempt: { ...p.state.attempt, id: 'attempt_2', status: 'admitted' } };
  await p.f.client.request('PUT', `/runs/${p.run.id}/checkpoint`, carrying, admitted.ownerToken);
  const consumed = await p.inspect();
  assert.equal(consumed.progress, 'consumed');
  assert.equal(p.store.getApproval(p.run.id, p.request.requestId).consumedAttemptId, 'attempt_2');
  const projected = await p.f.client.request('GET', `/runs/${p.run.id}`);
  assert.equal(projected.wait, null, 'a delivered decision is history, not a wait');
});

test('a decision recorded while the run is still running stays pending; the scheduler queues it once after idle proof and open admission', async t => {
  const p = await published(t);
  const ack = await p.decide({ decision: 'request-changes', feedback: 'Use the shorter name' });
  assert.deepEqual({ continuation: ack.continuation, status: ack.run.status }, { continuation: 'pending', status: 'running' });
  assert.equal((await p.inspect()).progress, 'waiting-for-idle');
  const paused = { ...p.state, status: 'paused', attempt: { ...p.state.attempt, status: 'rejected' }, wait: { kind: 'approval', attemptId: 'attempt_1', index: 0, taskId: 'T1' } };
  await p.f.client.request('PUT', `/runs/${p.run.id}/checkpoint`, paused, p.run.ownerToken);
  for (const value of [ACTIVE, { idle: false, status: 'paused' }, { idle: true, status: 'unknown' }]) {
    p.f.observation(value);
    await p.f.service().scheduler.tick();
    const run = p.store.getRun(p.run.id);
    assert.deepEqual({ status: run.status, reserved: run.capacityReserved }, { status: 'running', reserved: true }, 'capacity is not released before complete idle proof');
  }
  p.f.observation(IDLE);
  p.f.service().scheduler.pauseAdmission(); // as while draining
  await p.f.service().scheduler.tick();
  assert.equal(p.store.getRun(p.run.id).status, 'paused');
  assert.equal((await p.inspect()).continuation, 'pending');
  assert.equal(p.f.launches.length, 1);
  await p.f.restart();
  await p.f.service().scheduler.tick();
  await settled(p.f.service().store, p.run.id);
  await p.f.waitForLaunch(2);
  const delivered = context({ resolution: p.f.launches[1].resolution });
  assert.deepEqual({ decision: delivered.decision, feedback: delivered.feedback }, { decision: 'request-changes', feedback: 'Use the shorter name' });
  assert.equal(p.f.service().store.events().filter(event => event.type === 'approval.continuation_queued').length, 1);
});

test('reviewed content changed after acceptance supersedes the decision at dispatch, with or without a restart', async t => {
  const mutations = {
    committed: worktree => { gitIn(worktree, ['commit', '--allow-empty', '-m', 'move the reviewed head']); },
    'uncommitted tracked': worktree => fs.appendFile(path.join(worktree, 'README.md'), 'late edit\n'),
    untracked: worktree => fs.writeFile(path.join(worktree, 'late.txt'), 'late file\n'),
  };
  for (const [name, mutate] of Object.entries(mutations)) for (const restart of [false, true]) await t.test(`${name}${restart ? ' with a restart' : ''}`, async child => {
    const p = await published(child);
    await p.pause({ idle: true });
    const ack = await p.decide({ decision: 'approve' });
    assert.equal(ack.continuation, 'queued');
    await mutate(p.run.worktreePath);
    if (restart) await p.f.restart();
    const store = p.f.service().store;
    assert.equal(store.getRun(p.run.id).status, 'queued');
    await p.f.service().scheduler.tick();
    await settled(store, p.run.id);
    await p.f.waitForLaunch(2);
    const delivered = context({ resolution: p.f.launches[1].resolution });
    assert.equal(delivered.superseded.reason, 'The reviewed worktree changed after the decision was recorded');
    assert.equal(delivered.requestId, p.request.requestId);
    const view = await p.f.client.request('GET', `/runs/${p.run.id}/approvals/${p.request.requestId}`);
    assert.equal(view.continuation, 'superseded');
    assert.equal(view.progress, 'executing', 'withdrawn but not yet carried by an attempt: still being delivered');
    assert.equal(store.events().filter(event => event.type === 'approval.consumed').length, 0);
    assert.deepEqual(await p.decide({ decision: 'approve' }), { ...ack, retried: true });
  });
  await t.test('unchanged content after a restart is consumed', async child => {
    const p = await published(child);
    await p.pause({ idle: true });
    await p.decide({ decision: 'approve' });
    await p.f.restart();
    await p.f.service().scheduler.tick();
    await settled(p.f.service().store, p.run.id);
    await p.f.waitForLaunch(2);
    assert.equal(context({ resolution: p.f.launches[1].resolution }).superseded, undefined);
    assert.equal((await p.inspect()).continuation, 'consumed');
  });
});

test('requested changes are delivered verbatim, the superseded request cannot be approved and a corrected proposal has its own request', async t => {
  const feedback = '  Please:\n  - keep "quotes" and \'single quotes\'\n  - --decision approve --input=x\n\n\ttabbed and trailing space \n';
  const p = await published(t);
  await p.pause({ idle: true });
  const ack = await p.decide({ decision: 'request-changes', feedback });
  assert.equal(ack.continuation, 'queued');
  await p.f.service().scheduler.tick();
  const resumed = await settled(p.store, p.run.id);
  await p.f.waitForLaunch(2);
  const delivered = context({ resolution: p.f.launches[1].resolution });
  assert.equal(delivered.feedback, feedback, 'verbatim, byte for byte');
  assert.equal(delivered.decision, 'request-changes');
  assert.equal(delivered.superseded, undefined);
  p.f.observation(ACTIVE);
  // The resumed runner corrects the work and submits a fresh request for its new attempt.
  const caller = { sessionID: p.run.parentSessionId, id: 'native_call_2', messageID: 'assistant_message_2', agent: 'adr-orchestrator' };
  await p.f.client.request('POST', `/runs/${p.run.id}/resume-binding`, caller, resumed.ownerToken);
  const state2 = { ...p.state, caller, attempt: { id: 'attempt_2', phase: 'executor', index: 0, child: 'ses_child', status: 'admitted', startedAt: 2, model: 'anthropic/x' }, approval: delivered };
  state2.submissionBinding = recordDispatchPrompt(openSubmissionBinding(state2, 2), 'prompt_2');
  await p.f.client.request('PUT', `/runs/${p.run.id}/checkpoint`, state2, resumed.ownerToken);
  const corrected = approvalReceipt(p.run, state2, approvalPayload({ question: 'Approve the corrected change?' }), {
    attemptId: 'attempt_2', dispatch: 2, origin: 'prompt_2', caller: { sessionID: 'ses_child', agent: 'executor', messageID: 'msg_2', callId: 'call_2' },
  });
  await p.f.client.request('PUT', `/runs/${p.run.id}/submissions/attempt_2/executor-result`, corrected, resumed.ownerToken);
  const second = p.store.latestApproval(p.run.id);
  assert.notEqual(second.requestId, p.request.requestId);
  assert.equal(second.request.question, 'Approve the corrected change?');
  assert.equal(second.state, 'pending');
  // The earlier request is closed by changes: it can never be approved, and its stored acknowledgement is unchanged.
  await assert.rejects(p.decide({ decision: 'approve' }), status(409, 'approval-conflict'));
  assert.deepEqual(await p.decide({ decision: 'request-changes', feedback }), { ...ack, retried: true });
  assert.equal(p.store.getApproval(p.run.id, second.requestId).state, 'pending');
  // The new request is answered by its own id and continues once more.
  const paused2 = { ...state2, status: 'paused', attempt: { ...state2.attempt, status: 'rejected' }, wait: { kind: 'approval', attemptId: 'attempt_2', index: 0, taskId: 'T1' } };
  await p.f.client.request('PUT', `/runs/${p.run.id}/checkpoint`, paused2, resumed.ownerToken);
  p.f.observation(IDLE);
  await p.f.service().scheduler.tick();
  assert.equal(p.store.getRun(p.run.id).status, 'paused');
  const approved = await p.decide({ decision: 'approve' }, second.requestId);
  assert.equal(approved.continuation, 'queued');
  assert.equal(context(p.store.getRun(p.run.id)).requestId, second.requestId);
  assert.equal(p.store.events().filter(event => event.type === 'approval.continuation_queued').length, 2);
});

// --- Guarded responses to generic pauses -------------------------------------------------------------------------------

const GUIDANCE = 'Use the agreed approach.\nKeep "quotes" and --option-like text as data.';
/**
 * A run paused by a generic blocker the way an older runtime pauses: no structured protocol, a recorded older package version,
 * one accepted result and an unfinished second task. `pinned: false` also removes the run's admitted runtime snapshot, as
 * on a run submitted before snapshots existed.
 */
async function legacyPause(t, { reason = 'Blocked: which database should the migration target?', pinned = true } = {}) {
  const f = await fixture(t);
  const project = await f.client.request('POST', '/projects', { directory: f.project });
  const queued = await f.client.request('POST', '/runs', { projectId: project.id, feature: 'Legacy feature' });
  await f.service().scheduler.tick();
  const run = await settled(f.service().store, queued.id);
  const caller = { sessionID: run.parentSessionId, id: 'native_call', messageID: 'assistant_message', agent: 'adr-orchestrator' };
  await f.client.request('POST', `/runs/${run.id}/binding`, caller, run.ownerToken);
  const state = {
    id: run.id, status: 'paused', adr: '.heimdall/feature.md', parent: run.parentSessionId, caller, branch: run.branch, baseline: '', index: 1,
    tasks: [{ id: 'T1', title: 'First', brief: 'B', dependsOn: [], dod: ['gate'] }, { id: 'T2', title: 'Second', brief: 'B', dependsOn: ['T1'], dod: ['gate'] }],
    results: [{ taskId: 'T1', status: 'completed', summary: 'Accepted first task', handoff: 'Go on', evidence: [], model: 'anthropic/x', sessionId: 'ses_old' }],
    phase: 'executor', child: 'ses_child', settings: run.specification.settings, runtime: { packageVersion: '0.0.1', protocol: 'structured-v1' },
    attempt: { id: 'attempt_old', phase: 'executor', index: 1, child: 'ses_child', status: 'rejected', startedAt: 1, model: 'anthropic/x' }, reason,
  };
  await f.client.request('PUT', `/runs/${run.id}/checkpoint`, state, run.ownerToken);
  const store = f.service().store;
  const sql = (statement, ...values) => {
    const database = new DatabaseSync(path.join(f.state, 'coordinator.sqlite'));
    try { return database.prepare(statement).all(...values); } finally { database.close(); }
  };
  if (!pinned) {
    await f.service().close();
    sql("UPDATE runs SET specification_json = json_remove(specification_json, '$.runtime') WHERE id = ?", run.id);
    await f.restart();
  }
  f.observation({ idle: true, status: 'paused', reason });
  // A restart retains the run for reconciliation; otherwise the scheduler observes it.
  if (pinned) await f.service().scheduler.tick(); else await f.client.request('POST', `/runs/${run.id}/reconcile`, {});
  const paused = f.service().store.getRun(run.id);
  assert.equal(paused.status, 'paused');
  assert.equal(paused.capacityReserved, false);
  const wait = (await f.client.request('GET', `/runs/${run.id}`)).wait;
  const respond = (body, id = run.id) => f.client.request('POST', `/runs/${id}/respond`, body);
  return { f, run, state, wait, sql, respond, store: () => f.service().store, guidance: () => ({ pauseId: wait.pauseId, input: GUIDANCE }), project, caller };
}
const comparable = run => ({ checkpoint: run.checkpoint, runtime: run.specification.runtime ?? null, branch: run.branch, worktree: run.worktreePath, parent: run.parentSessionId, binding: run.binding });

test('a generic pause is projected with a stable identity and continues through the guarded response with its run unchanged', async t => {
  for (const pinned of [true, false]) {
    const p = await legacyPause(t, { pinned });
    assert.equal(p.wait.kind, 'generic');
    assert.match(p.wait.pauseId, /^pau_[0-9a-f]{32}$/);
    assert.equal(p.wait.reason, 'Blocked: which database should the migration target?');
    assert.equal(p.wait.reasonClipped, false);
    assert.equal((await p.f.client.request('GET', `/runs/${p.run.id}`)).wait.pauseId, p.wait.pauseId, 'the identity is stable between reads');
    assert.equal((await p.f.client.request('GET', '/run-list')).runs.find(run => run.id === p.run.id).wait.pauseId, p.wait.pauseId);
    const before = comparable(p.store().getRun(p.run.id));
    assert.equal(before.checkpoint.protocol, undefined);
    assert.equal(Boolean(before.runtime), pinned);

    const ack = await p.respond(p.guidance());
    assert.deepEqual({ ...ack, recordedAt: undefined }, {
      runId: p.run.id, pauseId: p.wait.pauseId, recordedAt: undefined, retried: false, continuation: 'queued', run: { status: 'queued', version: p.store().getRun(p.run.id).version },
    });
    assert.equal(typeof ack.recordedAt, 'number');
    const queued = p.store().getRun(p.run.id);
    assert.equal(queued.status, 'queued');
    assert.equal(queued.launchAction, 'resume');
    assert.equal(queued.capacityReserved, false);
    assert.match(queued.resolution, /^Owner guidance \(response to pause pau_[0-9a-f]{32}; this is not a typed approval/);
    assert.ok(queued.resolution.endsWith('\n' + GUIDANCE), 'the guidance is delivered verbatim');
    assert.deepEqual(comparable(queued), before, 'snapshot, protocol, task index, accepted results, branch and worktree are unchanged');
    assert.equal(p.sql('SELECT count(*) AS n FROM run_responses WHERE run_id = ?', p.run.id)[0].n, 1);

    // An identical retry returns the stored acknowledgement, also after the run advanced; a different input conflicts.
    const retry = await p.respond(p.guidance());
    assert.deepEqual(retry, { ...ack, retried: true });
    await assert.rejects(p.respond({ pauseId: p.wait.pauseId, input: GUIDANCE + ' ' }), status(409, 'response-conflict'));
    await p.f.service().scheduler.tick();
    const running = await settled(p.store(), p.run.id);
    await p.f.waitForLaunch(2);
    assert.equal(p.f.launches.at(-1).resolution, queued.resolution);
    assert.equal(p.f.launches.at(-1).id, p.run.id);
    assert.equal(running.parentSessionId, p.run.parentSessionId);
    assert.deepEqual(p.store().getRun(p.run.id).checkpoint, before.checkpoint, 'the checkpoint is untouched until the resumed runner saves its own');
    assert.deepEqual(await p.respond(p.guidance()), { ...ack, retried: true }, 'a retry after the run advanced still returns the stored acknowledgement');
    await assert.rejects(p.respond({ pauseId: p.wait.pauseId, input: 'Something else' }), status(409, 'response-conflict'));
    assert.equal(p.sql('SELECT count(*) AS n FROM run_responses WHERE run_id = ?', p.run.id)[0].n, 1);
    assert.equal(p.sql("SELECT count(*) AS n FROM events WHERE run_id = ? AND type = 'run.resume_queued'", p.run.id)[0].n, 1, 'exactly one resume was queued');
    assert.ok(!JSON.stringify(p.sql('SELECT payload_json FROM events WHERE run_id = ?', p.run.id)).includes('agreed approach'), 'events never carry the guidance text');
  }
});

test('a guarded response is refused for a stale pause, an active run, retained capacity or missing idle proof, recording nothing', async t => {
  const p = await legacyPause(t);
  const nothing = () => {
    assert.equal(p.sql('SELECT count(*) AS n FROM run_responses').length, 1);
    assert.equal(p.sql('SELECT count(*) AS n FROM run_responses')[0].n, 0, 'no response is recorded');
    const run = p.store().getRun(p.run.id);
    assert.equal(run.status, 'paused');
    assert.equal(run.launchAction, 'start');
  };
  // Not the run's current pause.
  await assert.rejects(p.respond({ pauseId: 'pau_' + '0'.repeat(32), input: GUIDANCE }), status(409, 'pause-stale'));
  nothing();
  // No fresh complete native idle proof.
  p.f.observation({ idle: false, status: 'unknown' });
  await assert.rejects(p.respond(p.guidance()), status(409, 'pause-not-ready'));
  p.f.observation({ idle: true, status: 'unknown' });
  await assert.rejects(p.respond(p.guidance()), status(409, 'pause-not-ready'));
  p.f.observation({ idle: true, status: 'succeeded' });
  await assert.rejects(p.respond(p.guidance()), status(409, 'pause-not-ready'));
  nothing();
  // A worktree that is not the reserved checkout.
  await fs.rename(p.run.worktreePath, p.run.worktreePath + '.moved');
  p.f.observation({ idle: true, status: 'paused' });
  await assert.rejects(p.respond(p.guidance()), status(409, 'pause-not-ready'));
  await fs.rename(p.run.worktreePath + '.moved', p.run.worktreePath);
  nothing();
  // Retained capacity.
  p.sql('UPDATE runs SET capacity_reserved = 1 WHERE id = ?', p.run.id);
  await assert.rejects(p.respond(p.guidance()), status(409, 'pause-not-ready'));
  p.sql('UPDATE runs SET capacity_reserved = 0 WHERE id = ?', p.run.id);
  // An active run.
  p.sql("UPDATE runs SET status = 'running', capacity_reserved = 1 WHERE id = ?", p.run.id);
  await assert.rejects(p.respond(p.guidance()), status(409, 'pause-not-ready'));
  p.sql("UPDATE runs SET status = 'paused', capacity_reserved = 0 WHERE id = ?", p.run.id);
  nothing();
  // Invalid requests are 400 and unknown runs 404.
  for (const body of [{}, { pauseId: p.wait.pauseId }, { input: GUIDANCE }, { pauseId: p.wait.pauseId, input: '   ' }, { pauseId: p.wait.pauseId, input: 5 }, { pauseId: '', input: GUIDANCE },
    { pauseId: p.wait.pauseId, input: GUIDANCE, extra: 1 }, { pauseId: p.wait.pauseId, input: 'x'.repeat(8001) }]) {
    await assert.rejects(p.respond(body), status(400), JSON.stringify(body).slice(0, 60));
  }
  await assert.rejects(p.respond(p.guidance(), 'missing-run'), status(404));
  nothing();
  // After every refusal the same pause still accepts the response.
  assert.equal((await p.respond(p.guidance())).continuation, 'queued');
});

test('a response for an earlier pause cannot be applied to a later pause of the same run', async t => {
  const p = await legacyPause(t);
  const first = p.wait;
  await p.respond(p.guidance());
  await p.f.service().scheduler.tick();
  const resumed = await settled(p.store(), p.run.id);
  // The resumed attempt pauses again with another blocker.
  const caller = { ...p.caller, id: 'native_call_2', messageID: 'assistant_message_2' };
  await p.f.client.request('POST', `/runs/${p.run.id}/resume-binding`, caller, resumed.ownerToken);
  const second = { ...p.state, caller, reason: 'Blocked again: which schema version?', attempt: { ...p.state.attempt, id: 'attempt_new' } };
  await p.f.client.request('PUT', `/runs/${p.run.id}/checkpoint`, second, resumed.ownerToken);
  p.f.observation({ idle: true, status: 'paused', reason: second.reason });
  await p.f.waitForLaunch(2);
  for (let turn = 0; turn < 200 && p.store().getRun(p.run.id).status !== 'paused'; turn++) { await p.f.service().scheduler.tick(); await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(p.store().getRun(p.run.id).status, 'paused');
  const later = (await p.f.client.request('GET', `/runs/${p.run.id}`)).wait;
  assert.equal(later.kind, 'generic');
  assert.notEqual(later.pauseId, first.pauseId);
  assert.equal(later.reason, second.reason);
  // The earlier identity only returns its own stored acknowledgement or conflicts; it never queues a second resume.
  assert.equal((await p.respond({ pauseId: first.pauseId, input: GUIDANCE })).retried, true);
  await assert.rejects(p.respond({ pauseId: first.pauseId, input: 'New guidance for the new pause' }), status(409, 'response-conflict'));
  assert.equal(p.store().getRun(p.run.id).status, 'paused');
  assert.equal((await p.respond({ pauseId: later.pauseId, input: 'Use schema 4' })).retried, false);
  assert.equal(p.store().getRun(p.run.id).status, 'queued');
});

test('the guarded response is administrator only, survives a restart and is refused while draining', async t => {
  const p = await legacyPause(t);
  await assert.rejects(p.f.client.request('POST', `/runs/${p.run.id}/respond`, p.guidance(), p.run.ownerToken), status(403));
  await assert.rejects(p.f.client.request('POST', `/runs/${p.run.id}/respond`, p.guidance(), 'wrong'), status(401));
  assert.equal(p.sql('SELECT count(*) AS n FROM run_responses')[0].n, 0);
  const ack = await p.respond(p.guidance());
  await p.f.restart();
  assert.deepEqual(await p.respond(p.guidance()), { ...ack, retried: true });
  assert.equal(p.sql('SELECT count(*) AS n FROM run_responses')[0].n, 1);
  assert.equal(p.sql("SELECT count(*) AS n FROM events WHERE type = 'run.resume_queued'")[0].n, 1);
  // While draining nothing is recorded or queued, as for every other mutation; the stored acknowledgement remains unavailable too.
  const q = await legacyPause(t);
  await q.f.service().drain();
  await assert.rejects(q.respond(q.guidance()), status(503));
  assert.equal(q.sql('SELECT count(*) AS n FROM run_responses')[0].n, 0);
  assert.equal(q.store().getRun(q.run.id).status, 'paused');
  await q.f.close();
});

test('the guarded response refuses a typed approval wait while its request is pending or its decision is unconsumed', async t => {
  const p = await published(t);
  await p.pause({ idle: true });
  const wait = (await p.f.client.request('GET', `/runs/${p.run.id}`)).wait;
  assert.equal(wait.kind, 'approval', 'a typed request is never projected as a generic pause');
  const respond = body => p.f.client.request('POST', `/runs/${p.run.id}/respond`, body);
  // Whatever pause identity a client presents, a pending request refuses.
  await assert.rejects(respond({ pauseId: 'pau_' + '1'.repeat(32), input: 'approve' }), status(409, 'approval-pending'));
  await p.decide({ decision: 'request-changes', feedback: 'Revise it' });
  assert.equal(p.store.getRun(p.run.id).status, 'queued', 'the decision queued its own continuation');
  await assert.rejects(respond({ pauseId: 'pau_' + '1'.repeat(32), input: 'approve' }), status(409, 'approval-pending'));
  p.sql("UPDATE approval_requests SET continuation = 'pending' WHERE request_id = ?", p.request.requestId);
  await assert.rejects(respond({ pauseId: 'pau_' + '1'.repeat(32), input: 'approve' }), status(409, 'approval-pending'));
  assert.equal(p.sql('SELECT count(*) AS n FROM run_responses')[0].n, 0);
  assert.equal(p.sql("SELECT count(*) AS n FROM events WHERE type = 'run.response_recorded'")[0].n, 0);
});

test('an altered runtime snapshot refuses the guarded response; the snapshot is never rebuilt or upgraded', async t => {
  const p = await legacyPause(t);
  const root = path.join(path.dirname(p.run.worktreePath), 'runtime');
  const marker = (await fs.readdir(root)).find(name => /marker|snapshot/i.test(name)) ?? (await fs.readdir(root)).find(name => name.startsWith('.'));
  assert.ok(marker, 'the run owns a snapshot marker');
  const before = comparable(p.store().getRun(p.run.id));
  await fs.chmod(path.join(root, marker), 0o600);
  await fs.rm(path.join(root, marker));
  await assert.rejects(p.respond(p.guidance()), error => error.statusCode === 409 && error.code === 'pause-not-ready' && /Runtime snapshot refused/.test(error.message));
  assert.equal(p.sql('SELECT count(*) AS n FROM run_responses')[0].n, 0);
  assert.equal(p.store().getRun(p.run.id).status, 'paused');
  assert.deepEqual(comparable(p.store().getRun(p.run.id)), before);
  assert.deepEqual(await fs.readdir(root).then(names => names.includes(marker)), false, 'nothing recreated the marker');
});
