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
    async pause() {
      const paused = { ...state, status: 'paused', attempt: { ...state.attempt, status: 'rejected' }, wait: { kind: 'approval', attemptId: 'attempt_1', index: 0, taskId: 'T1' } };
      await f.client.request('PUT', `/runs/${run.id}/checkpoint`, paused, run.ownerToken);
      f.observation({ idle: true, status: 'paused', reason: 'Approval required' });
      await f.service().scheduler.tick();
      assert.equal(store.getRun(run.id).status, 'paused');
      assert.equal(store.getRun(run.id).capacityReserved, false);
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
  p.sql("UPDATE approval_requests SET continuation = 'consumed' WHERE request_id = ?", p.request.requestId);
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
  await p.f.client.request('PUT', `/runs/${p.run.id}/checkpoint`, { ...p.state, approval: forged, response: forged, wait: { kind: 'approval', attemptId: 'attempt_1', index: 0, taskId: 'T1', ...forged } }, token);
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
  p.sql("UPDATE approval_requests SET continuation = 'consumed' WHERE request_id = ?", p.request.requestId);
  assert.equal((await resume()).status, 'queued');
});

test('a superseded request no longer blocks a guided generic resume', async t => {
  const p = await published(t);
  await p.pause();
  await fs.appendFile(path.join(p.run.worktreePath, 'README.md'), 'changed\n');
  await assert.rejects(p.decide({ decision: 'approve' }), status(409, 'approval-stale'));
  const resumed = await p.f.client.request('POST', `/runs/${p.run.id}/resume`, { input: 'The tree changed; ask again' });
  assert.equal(resumed.status, 'queued');
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
