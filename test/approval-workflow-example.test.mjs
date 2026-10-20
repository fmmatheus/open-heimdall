import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createCoordinatorClient } from '../dist/coordinator/client.js';
import { loadCoordinatorConfiguration } from '../dist/coordinator/config.js';
import { startCoordinatorService, readCoordinatorToken } from '../dist/coordinator/service.js';
import { managedPrompt } from '../dist/coordinator/executor.js';
import { loadConfiguration } from '../dist/config.js';
import { createRunner } from '../dist/workflow/runner.js';
import { createManagedPersistence, readManagedMetadata } from '../dist/opencode/managed.js';
import { createDurableSubmissionGate } from '../dist/workflow/durable-submission.js';
import { SUBMISSION_PROTOCOL } from '../dist/workflow/contracts.js';

/*
 * The portable approval-workflow example (examples/approval-workflow), end to end:
 *
 * - a real, isolated coordinator (SQLite, scheduler, managed git worktree, runtime snapshot, run capabilities);
 * - the real workflow runner and durable submission gate, writing through the real managed persistence;
 * - the real `heimdall coordinator run respond` CLI as the owner's only action;
 * - a scripted stand-in for the native OpenCode session and model. It decides what to do by reading the dispatch prompt,
 *   performs real file edits and Git commits in the worktree, and submits typed results through the gate.
 *
 * Evidence level: fake-model, native-stand-in integration. No OpenCode host, no real model and no OpenChamber UI is involved.
 */

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const example = path.join(repository, 'examples', 'approval-workflow');
const cli = path.join(repository, 'dist', 'cli.js');

const DUMMY_VALUES = ['dummy-token-4f9c2a-not-a-secret', 'dummy-tenant-0001', 'ledger.example.invalid'];
const FEATURE_TEXT_MARKER = 'Move the ledger integration to API v2';

const scrubbed = () => {
  const environment = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  for (const key of Object.keys(environment)) if (key.startsWith('GIT_') && !['GIT_CONFIG_NOSYSTEM', 'GIT_TERMINAL_PROMPT'].includes(key)) delete environment[key];
  return environment;
};
const git = (directory, args) => execFileSync('git', ['-c', 'user.name=Scripted Agent', '-c', 'user.email=agent@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: directory, encoding: 'utf8', env: scrubbed(), stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const nodeIn = (directory, args) => execFileSync(process.execPath, args, { cwd: directory, encoding: 'utf8' }).trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const settingsFile = `[workflow]\nplannerModel = "anthropic/fixture"\nexecutorModel = "anthropic/fixture"\nexecutorFallbackModel = "openai/fixture"\n[opencode]\nbaseUrl = "http://127.0.0.1:4096"\n`;
const quota = async () => ({
  anthropic: { fetchedAt: Date.now(), errors: [], entries: [{ name: '5h', percentRemaining: 80 }, { name: 'Weekly', percentRemaining: 80 }] },
  openai: { fetchedAt: Date.now(), errors: [], entries: [{ name: '5h', percentRemaining: 80 }, { name: 'Weekly', percentRemaining: 80 }] },
});

// --- What the scripted model understands from the dispatch prompt --------------------------------------------------

function ownerDecisionIn(prompt) {
  const header = /^Owner decision on your approval request (\S+) \(task (\S+)\):$/m.exec(prompt);
  if (!header) return undefined;
  const decision = /^Decision: (.+)$/m.exec(prompt)?.[1];
  const feedback = /<<<OWNER FEEDBACK\n([\s\S]*?)\nOWNER FEEDBACK>>>/.exec(prompt)?.[1];
  return { requestId: header[1], taskId: header[2], decision, feedback, scope: /^Scope you asked approval for: (.+)$/m.exec(prompt)?.[1] };
}
const taskIn = prompt => JSON.parse(/^Task: (\{.*\})$/m.exec(prompt)[1]);

const PLAN = {
  status: 'planned', planMarkdown: '# Plan\n1. Add the ledger client.\n2. Migrate the integration to API v2 after owner approval.', factSheet: 'Synthetic ledger integration; dummy environment file only.',
  tasks: [
    { id: 'T1', title: 'Add the ledger client', brief: 'Add integrations/ledger/client.mjs and commit it.', dependsOn: [], dod: ['The client module exists and is committed'] },
    { id: 'T2', title: 'Migrate the integration to API v2', brief: 'Prepare the migration, ask the owner for approval, then apply it, verify it and commit.', dependsOn: ['T1'], dod: ['The configuration targets API v2', 'The dummy environment file is migrated and no value is printed', 'The verification passes and the work is committed'] },
  ],
};

/**
 * A native stand-in: it runs the real workflow runner for one coordinator launch. `agent` is the scripted model; it is
 * called once per dispatch with the prompt it was given and a `submit` bound to that dispatch.
 */
function createNativeStandIn({ coordinator, agent }) {
  const active = new Set();
  const failures = [];
  const dispatches = [];
  const finished = new Map();
  let calls = 0;
  let children = 0;
  const executor = {
    async launch(expected) {
      const worktree = expected.worktreePath;
      const metadata = await readManagedMetadata(worktree);
      const managed = createManagedPersistence(worktree, metadata);
      const run = await managed.getRun();
      // The same arguments the native orchestrator is told to pass to the workflow tool.
      const args = JSON.parse(/arguments:\n(.+)\nReport/.exec(managedPrompt(run))[1]);
      const configuration = await loadConfiguration({ projectDirectory: worktree, configPath: '.heimdall/runtime.toml' });
      const number = ++calls;
      const context = { sessionID: run.parentSessionId, id: `call_${number}`, messageID: `msg_assistant_${number}`, agent: 'adr-orchestrator', signal: new AbortController().signal };
      const authorized = await managed.authorize(args, context);
      const settings = configuration.readSettings ?? configuration.settings;
      const { persistence } = managed;
      const prompts = new Map();
      const origins = new Map();
      const gate = createDurableSubmissionGate({
        runId: run.id, directory: worktree, planRoot: configuration.planRoot, origin: native => origins.get(native.messageID),
        persistence: { load: persistence.load, readSubmission: persistence.readSubmission, writeSubmission: persistence.writeSubmission },
      });
      const backend = {
        assertIdle: async () => {},
        recoverResponse: async () => 'Done; this chat text is for humans only.',
        observeDispatchPrompt: async ({ attemptId }) => prompts.get(attemptId),
        usage: async () => ({ used: 0, uncached: 0 }),
        interrupt: async () => {},
        runSubagent: async (input, runnerContext) => {
          const child = input.child ?? `ses_child_${++children}`;
          await input.onStarted(child);
          const attemptId = /Workflow attempt: (\S+)/.exec(input.prompt)[1];
          const promptId = `prompt_${dispatches.length + 1}`;
          const dispatch = { n: dispatches.length + 1, attemptId, child, promptId, agent: input.agent, prompt: input.prompt, worktree };
          dispatches.push(dispatch);
          prompts.set(attemptId, promptId);
          origins.set(`msg_${promptId}`, promptId);
          // The model starts calling tools once the host has recorded the dispatch prompt.
          for (let waited = 0; (await persistence.load(run.id))?.submissionBinding?.prompt !== promptId; waited += 5) {
            if (runnerContext.signal?.aborted || waited > 5000) throw new Error('The dispatch prompt was never recorded');
            await sleep(5);
          }
          const kind = /^Task: /m.test(input.prompt) ? 'executor-result' : 'planner-plan';
          const submit = async payload => {
            const response = await gate.submit(kind, payload, { sessionID: child, agent: input.agent, messageID: `msg_${promptId}`, id: `call_${dispatch.n}` });
            assert.equal(response.accepted, true, JSON.stringify(response));
            return response;
          };
          await agent({ dispatch, submit, worktree });
          return 'Done; this chat text is for humans only.';
        },
      };
      const runner = createRunner({
        backend, directory: worktree, settings, quota, persistence, protocol: SUBMISSION_PROTOCOL,
        workflowRoot: configuration.workflowRoot, planRoot: configuration.planRoot,
        plannerPromptPath: configuration.plannerPromptPath, executorPromptPath: configuration.executorPromptPath,
        git: args => execFileSync('git', args, { cwd: worktree, encoding: 'utf8', env: scrubbed() }),
      });
      active.add(run.id);
      finished.set(run.id, runner(authorized, context)
        .catch(error => { failures.push(error); })
        .finally(() => { active.delete(run.id); }));
    },
    async inspect(expected) {
      if (active.has(expected.id)) return { idle: false, status: 'unknown', reason: 'The stand-in session is still executing' };
      const checkpoint = coordinator().store.getRun(expected.id).checkpoint;
      if (checkpoint?.status === 'paused') return { idle: true, status: 'paused', reason: checkpoint.reason };
      if (checkpoint?.status === 'completed') return { idle: true, status: 'succeeded' };
      return { idle: true, status: 'failed', reason: 'The stand-in session ended without a checkpoint outcome' };
    },
  };
  return { executor, dispatches, failures, active };
}

// --- The isolated environment ---------------------------------------------------------------------------------------

async function environment(t, agent) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'haw-')));
  const project = path.join(root, 'project');
  const homeDirectory = path.join(root, 'home');
  await fs.mkdir(homeDirectory);
  await fs.cp(path.join(example, 'project'), project, { recursive: true });
  git(project, ['init', '-b', 'main']);
  git(project, ['add', '.']);
  git(project, ['commit', '-m', 'Synthetic ledger integration']);
  await fs.writeFile(path.join(project, '.heimdall.toml'), settingsFile);
  const configFile = path.join(root, 'coordinator.toml');
  await fs.writeFile(configFile, '[coordinator]\nstateDirectory = "state"\n');
  const configuration = await loadCoordinatorConfiguration(configFile);
  let running;
  const standIn = createNativeStandIn({ coordinator: () => running, agent });
  running = await startCoordinatorService({ configuration, executor: standIn.executor, pollIntervalMs: 60000 });
  t.after(async () => {
    await running.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const client = createCoordinatorClient(configuration.endpoint, await readCoordinatorToken(configuration.stateDirectory));
  const registered = await client.request('POST', '/projects', { directory: project });
  const { store, scheduler } = running;
  const ownerCalls = [];
  const ownerCli = args => new Promise((resolve, reject) => {
    ownerCalls.push(args);
    const environmentVariables = scrubbed();
    environmentVariables.HOME = homeDirectory;
    environmentVariables.HEIMDALL_CONFIG = '';
    delete environmentVariables.HEIMDALL_COORDINATOR_CONFIG;
    const child = spawn(process.execPath, [cli, 'coordinator', ...args, '--coordinator-config', configFile], { env: environmentVariables, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
  });
  const sql = (statement, ...values) => {
    const database = new DatabaseSync(path.join(configuration.stateDirectory, 'coordinator.sqlite'));
    try { return database.prepare(statement).all(...values); } finally { database.close(); }
  };
  /** Runs the scheduler until `condition` holds. The tick is what admits, observes and continues runs. */
  const until = async (condition, what) => {
    for (let n = 0; n < 1500; n++) {
      await scheduler.tick();
      if (standIn.failures.length) throw standIn.failures[0];
      if (await condition()) return;
      await sleep(20);
    }
    const runs = store.listRunPage(0).runs ?? [];
    assert.fail(`Timed out waiting for ${what}: ${JSON.stringify(runs.map(run => { const full = store.getRun(run.id); return { status: full.status, reason: full.reason, reserved: full.capacityReserved, checkpoint: full.checkpoint?.status, checkpointReason: full.checkpoint?.reason }; }))}; dispatches ${standIn.dispatches.length}; events ${store.events().map(event => event.type).join(',')}`);
  };
  const feature = await fs.readFile(path.join(example, 'task-spec.md'), 'utf8');
  const submit = async () => (await client.request('POST', '/runs', { projectId: registered.id, feature })).id;
  const parked = id => () => { const run = store.getRun(id); return run.status === 'paused' && !run.capacityReserved; };
  const pendingRequest = id => () => { const request = store.latestApproval(id); return parked(id)() && request?.state === 'pending'; };
  const secretsIn = async () => {
    // Everything the coordinator persists, as raw bytes (database, journal and write-ahead log).
    const files = (await fs.readdir(configuration.stateDirectory)).filter(name => name.startsWith('coordinator.sqlite'));
    assert.ok(files.includes('coordinator.sqlite'));
    const found = [];
    for (const name of files) {
      const bytes = await fs.readFile(path.join(configuration.stateDirectory, name));
      for (const value of DUMMY_VALUES) if (bytes.includes(Buffer.from(value))) found.push(`${name}: ${value}`);
    }
    return found;
  };
  return { root, project, configuration, client, store, scheduler, standIn, submit, until, parked, pendingRequest, ownerCli, ownerCalls, sql, secretsIn, registered };
}

/** The labels of the surfaces that contain `value`. */
const surfacesContain = (surfaces, value) => Object.entries(surfaces).filter(([, text]) => text.includes(value)).map(([label]) => label);

// --- The scripted model --------------------------------------------------------------------------------------------------

const ENV_FILE = 'env/ledger.dummy.env';
const originalEnvironmentFile = await fs.readFile(path.join(example, 'project', ENV_FILE), 'utf8');
const originalConfiguration = await fs.readFile(path.join(example, 'project', 'integrations/ledger/config.json'), 'utf8');

function scriptedAgent({ log, corrections = [] }) {
  const copy = async (worktree, from, to) => {
    await fs.mkdir(path.dirname(path.join(worktree, to)), { recursive: true });
    await fs.copyFile(path.join(example, 'scripted-agent', from), path.join(worktree, to));
  };
  const commit = (worktree, paths, message) => { git(worktree, ['add', ...paths]); git(worktree, ['commit', '-m', message]); return git(worktree, ['rev-parse', 'HEAD']); };
  const proposal = async ({ worktree, submit }, number, answer) => {
    await copy(worktree, `migrate-proposal-${number}.mjs`, 'migrations/ledger-v2.mjs');
    const sha = commit(worktree, ['migrations/ledger-v2.mjs'], `chore(ledger): propose API v2 migration (proposal ${number})`);
    // Read-only checks the agent is already allowed to run: nothing is applied.
    const plan = nodeIn(worktree, ['migrations/ledger-v2.mjs', '--dry-run']);
    const verified = nodeIn(worktree, ['scripts/verify.mjs', '--expect', 'v1']);
    log.push({ proposal: number, plan, verified });
    await submit({
      status: 'approval-required',
      question: `Apply the reviewed API v2 migration (proposal ${number}) to the ledger integration and its dummy environment file?${answer ? ` It addresses your feedback: ${answer}` : ''}`,
      scope: `Apply migrations/ledger-v2.mjs at commit ${sha.slice(0, 12)} to integrations/ledger/config.json and env/ledger.dummy.env only. Nothing else is authorized.`,
      completedWork: `Wrote the migration (proposal ${number}), ran it as a dry run and ran the read-only verification against v1. Nothing was applied.`,
      verification: [`dry run: ${plan.split('\n').length} renames planned, no values printed`, `verification: ${verified.split('\n').at(-1)}`],
      artifacts: ['migrations/ledger-v2.mjs', `commit ${sha.slice(0, 12)}`],
      onApprove: ['Apply the migration to the integration configuration and the dummy environment file', 'Run scripts/verify.mjs --expect v2 and commit the result', 'Submit ordinary evidence for every gate'],
      onRequestChanges: ['Correct the migration within the task scope', 'Do not apply anything', 'Submit a fresh approval request'],
    });
  };
  return async ({ dispatch, submit, worktree }) => {
    if (!/^Task: /m.test(dispatch.prompt)) return submit(PLAN);
    const task = taskIn(dispatch.prompt);
    const owner = ownerDecisionIn(dispatch.prompt);
    log.push({ dispatch: dispatch.n, task: task.id, sawDecision: owner });
    if (task.id === 'T1') {
      await copy(worktree, 'ledger-client.mjs', 'integrations/ledger/client.mjs');
      const sha = commit(worktree, ['integrations/ledger/client.mjs'], 'feat(ledger): add the ledger client');
      return submit({ status: 'completed', summary: 'Added the ledger client.', handoff: 'integrations/ledger/client.mjs resolves variable names only.', evidence: [{ gateId: 'G1', passed: true, detail: `Client committed at ${sha.slice(0, 12)}` }] });
    }
    assert.equal(task.id, 'T2');
    if (!owner) return proposal({ worktree, submit }, 1);
    assert.equal(owner.taskId, 'T2');
    if (owner.decision === 'request-changes') {
      // The gated action is not performed. The agent corrects its own proposal and asks again.
      const configNow = await fs.readFile(path.join(worktree, 'integrations/ledger/config.json'), 'utf8');
      assert.equal(configNow, originalConfiguration, 'the migration must not be applied after requested changes');
      corrections.push(owner.feedback);
      return proposal({ worktree, submit }, 2, 'tenant variable kept, rollback added');
    }
    assert.equal(owner.decision, 'approve');
    // The approval authorizes exactly the scope that was asked for; the agent performs every step itself.
    const applied = nodeIn(worktree, ['migrations/ledger-v2.mjs', '--apply']);
    const verified = nodeIn(worktree, ['scripts/verify.mjs', '--expect', 'v2']);
    const sha = commit(worktree, ['integrations/ledger/config.json', ENV_FILE], 'feat(ledger): migrate the integration to API v2');
    log.push({ applied, verified });
    return submit({
      status: 'completed', summary: 'Applied the approved migration, verified it and committed it.', handoff: 'The integration targets API v2. migrations/ledger-v2.mjs --rollback reverses it.',
      evidence: [
        { gateId: 'G1', passed: true, detail: `Configuration targets v2; ${verified.split('\n').at(-1)}` },
        { gateId: 'G2', passed: true, detail: `Migration reported only variable names: ${applied.split('\n').length} renames` },
        { gateId: 'G3', passed: true, detail: `scripts/verify.mjs --expect v2 exited 0; committed at ${sha.slice(0, 12)}` },
      ],
    });
  };
}

const read = (worktree, file) => fs.readFile(path.join(worktree, file), 'utf8');
const workStatus = worktree => git(worktree, ['status', '--porcelain', '--', '.', ':!.heimdall', ':!.opencode']);
const gitState = worktree => ({ head: git(worktree, ['rev-parse', 'HEAD']), status: workStatus(worktree), log: git(worktree, ['log', '--format=%H %an %s']) });
const eventTypes = e => e.store.events().map(event => event.type);

test('the owner decides once; the agent applies, migrates, verifies and completes the same run', async t => {
  const log = [];
  const e = await environment(t, scriptedAgent({ log }));
  const runId = await e.submit();

  // Task 1 completes, task 2 prepares its work and pauses on a typed request.
  await e.until(e.pendingRequest(runId), 'the approval request');
  const paused = e.store.getRun(runId);
  const request = e.store.latestApproval(runId);
  const worktree = paused.worktreePath;
  assert.equal(paused.checkpoint.index, 1);
  assert.equal(paused.checkpoint.results.length, 1);
  assert.deepEqual(paused.checkpoint.tasks.map(task => task.id), ['T1', 'T2']);
  assert.equal(paused.checkpoint.wait.kind, 'approval');
  assert.equal(request.taskId, 'T2');
  assert.equal(request.taskIndex, 1);
  assert.equal(request.state, 'pending');
  assert.deepEqual(request.request.onApprove.length, 3);
  const shown = await e.client.request('GET', `/runs/${runId}`);
  assert.equal(shown.wait.kind, 'approval');
  assert.equal(shown.wait.requestId, request.requestId);
  assert.equal(shown.wait.state, 'pending');

  // The task is incomplete: the migration is prepared and committed but not applied.
  assert.equal(await read(worktree, 'integrations/ledger/config.json'), originalConfiguration);
  assert.equal(await read(worktree, ENV_FILE), originalEnvironmentFile);
  assert.match(await read(worktree, 'migrations/ledger-v2.mjs'), /--apply/);
  const taskOneCommit = git(worktree, ['log', '--format=%H', '--grep=add the ledger client']);
  assert.match(taskOneCommit, /^[0-9a-f]{40}$/);
  const resultsAtPause = structuredClone(paused.checkpoint.results);
  const attemptAtPause = paused.checkpoint.attempt.id;
  const before = gitState(worktree);
  assert.equal(before.status, '', 'the worktree is clean apart from the run bookkeeping');

  // The old generic path cannot be used to wave the request through.
  await assert.rejects(e.client.request('POST', `/runs/${runId}/resume`, { input: 'approve' }), error => error.statusCode === 409 && error.code === 'approval-pending');

  // The owner's only action: one decision.
  const answered = await e.ownerCli(['run', 'respond', runId, '--request', request.requestId, '--decision', 'approve']);
  assert.equal(answered.status, 0, answered.stderr);
  const ack = JSON.parse(answered.stdout);
  assert.deepEqual({ runId: ack.runId, requestId: ack.requestId, decision: ack.decision, retried: ack.retried, continuation: ack.continuation }, { runId, requestId: request.requestId, decision: 'approve', retried: false, continuation: 'queued' });
  assert.deepEqual(gitState(worktree), before, 'the owner made no edit or commit: the decision is the only change');
  assert.equal(e.ownerCalls.length, 1);
  assert.deepEqual(e.ownerCalls[0].slice(0, 2), ['run', 'respond']);
  assert.equal(e.store.getRun(runId).status, 'queued', 'the decision queued the continuation; it has not executed yet');

  // The agent continues the same unfinished task by itself.
  await e.until(() => e.store.getRun(runId).status === 'succeeded', 'the run to succeed');
  const done = e.store.getRun(runId);
  assert.equal(done.id, runId);
  assert.equal(done.parentSessionId, paused.parentSessionId);
  assert.equal(done.branch, paused.branch);
  assert.equal(done.worktreePath, worktree);
  assert.equal(done.checkpoint.status, 'completed');
  assert.deepEqual(done.checkpoint.tasks, paused.checkpoint.tasks);
  assert.equal(done.checkpoint.results.length, 2);
  assert.deepEqual(done.checkpoint.results[0], resultsAtPause[0], 'the earlier accepted result is preserved unchanged');
  assert.notEqual(done.checkpoint.attempt?.id ?? '', attemptAtPause);
  git(worktree, ['merge-base', '--is-ancestor', taskOneCommit, 'HEAD']);

  // Only an ordinary completed submission finished the task, from a fresh attempt that carries the decision.
  const executorDispatches = e.standIn.dispatches.filter(dispatch => dispatch.agent.includes('executor'));
  assert.equal(executorDispatches.length, 3, 'T1, then T2 twice (request, then continuation)');
  const [, requesting, continuing] = executorDispatches;
  assert.equal(requesting.child, continuing.child, 'the same child continues the same task');
  assert.notEqual(requesting.attemptId, continuing.attemptId);
  assert.match(continuing.prompt, new RegExp(`Owner decision on your approval request ${request.requestId}`));
  assert.match(continuing.prompt, /^Decision: approve$/m);
  assert.match(continuing.prompt, /An approval does not complete any gate/);
  const approval = e.sql('SELECT state, decision, continuation, consumed_attempt_id FROM approval_requests WHERE request_id = ?', request.requestId)[0];
  assert.deepEqual({ state: approval.state, decision: approval.decision, continuation: approval.continuation, consumed: approval.consumed_attempt_id }, { state: 'answered', decision: 'approve', continuation: 'consumed', consumed: continuing.attemptId });

  // The agent performed the integration update, the environment migration and the verification.
  const configuration = JSON.parse(await read(worktree, 'integrations/ledger/config.json'));
  assert.equal(configuration.apiVersion, 'v2');
  assert.deepEqual(configuration.variables, { url: 'LEDGER_BASE_URL', token: 'LEDGER_TOKEN', tenant: 'LEDGER_ACCOUNT' });
  const migrated = await read(worktree, ENV_FILE);
  assert.match(migrated, /^LEDGER_BASE_URL=https:\/\/ledger\.example\.invalid\/v2$/m);
  assert.ok(migrated.includes('LEDGER_TOKEN=dummy-token-4f9c2a-not-a-secret'), 'values moved with their names');
  assert.ok(migrated.includes('LEDGER_ACCOUNT=dummy-tenant-0001'));
  assert.ok(!/^LEDGER_URL=|^LEDGER_API_TOKEN=|^LEDGER_TENANT=/m.test(migrated));
  const verification = execFileSync(process.execPath, ['scripts/verify.mjs', '--expect', 'v2'], { cwd: worktree, encoding: 'utf8' });
  assert.match(verification, /5 of 5 checks passed/);
  assert.equal(workStatus(worktree), '');
  const commits = git(worktree, ['log', '--reverse', '--format=%an|%s']).split('\n');
  assert.deepEqual(commits.slice(-3), [
    'Scripted Agent|feat(ledger): add the ledger client',
    'Scripted Agent|chore(ledger): propose API v2 migration (proposal 1)',
    'Scripted Agent|feat(ledger): migrate the integration to API v2',
  ]);
  assert.ok(commits.every(entry => entry.startsWith('Scripted Agent|') || entry.endsWith('|Synthetic ledger integration')), 'every change after the base was made by the agent');

  // One decision, one queue: no generic resume or guidance was involved.
  const types = eventTypes(e);
  for (const type of ['approval.requested', 'approval.answered', 'approval.continuation_queued', 'approval.consumed']) assert.equal(types.filter(entry => entry === type).length, 1, type);
  assert.equal(types.filter(entry => entry === 'run.response_recorded').length, 0);
  const queued = e.store.events().filter(event => event.type === 'run.resume_queued');
  assert.equal(queued.length, 1);
  assert.equal(queued[0].payload.requestId, request.requestId);

  // Dummy values never reached anything the coordinator keeps, the CLI printed, or the agent was shown and reported.
  const surfaces = {
    'owner CLI stdout': answered.stdout, 'owner CLI stderr': answered.stderr, 'events': JSON.stringify(e.store.events()),
    'run list': JSON.stringify(await e.client.request('GET', '/runs')), 'run detail': JSON.stringify(await e.client.request('GET', `/runs/${runId}`)),
    'approval request': JSON.stringify(e.store.getApproval(runId, request.requestId)), 'agent command output': JSON.stringify(log.map(entry => ({ ...entry, sawDecision: undefined }))),
    'commit messages': git(worktree, ['log', '--format=%B']),
    ...Object.fromEntries(e.standIn.dispatches.map(dispatch => [`prompt ${dispatch.n}`, dispatch.prompt])),
  };
  for (const value of DUMMY_VALUES) assert.deepEqual(surfacesContain(surfaces, value), [], `${value} must not appear on any reported surface`);
  assert.deepEqual(await e.secretsIn(), [], 'the coordinator database holds no environment value');
  // Control: the scan does find a value where one really is.
  assert.ok(migrated.includes(DUMMY_VALUES[0]));
  assert.deepEqual(surfacesContain({ planted: `x ${DUMMY_VALUES[1]} y` }, DUMMY_VALUES[1]), ['planted']);
  assert.ok(log.some(entry => entry.applied) && log.some(entry => entry.plan));
  assert.deepEqual(e.standIn.failures, []);
});

test('request changes: the feedback reaches the agent, nothing is applied, the correction gets a fresh request and the old one stays closed', async t => {
  const log = [];
  const corrections = [];
  const e = await environment(t, scriptedAgent({ log, corrections }));
  const runId = await e.submit();

  await e.until(e.pendingRequest(runId), 'the first approval request');
  const first = e.store.latestApproval(runId);
  const worktree = e.store.getRun(runId).worktreePath;
  const base = gitState(worktree);
  const feedback = 'Keep LEDGER_TENANT as it is: other services read it.\nAlso add a way to roll the change back.\n"Do not" apply this version.';
  const rejected = await e.ownerCli(['run', 'respond', runId, '--request', first.requestId, '--decision', 'request-changes', `--input=${feedback}`]);
  assert.equal(rejected.status, 0, rejected.stderr);
  assert.equal(JSON.parse(rejected.stdout).decision, 'request-changes');
  assert.deepEqual(gitState(worktree), base, 'the owner edited nothing');

  // The agent corrects its own proposal and asks again; the run pauses on a new request.
  await e.until(() => {
    const latest = e.store.latestApproval(runId);
    return latest && latest.requestId !== first.requestId && e.pendingRequest(runId)();
  }, 'the corrected approval request');
  const second = e.store.latestApproval(runId);
  assert.notEqual(second.requestId, first.requestId);
  assert.notEqual(second.attemptId, first.attemptId);
  assert.notEqual(second.revision.head, first.revision.head, 'the reviewed material changed, so it needs fresh review');
  assert.deepEqual(corrections, [feedback], 'the feedback arrived verbatim');
  const secondPrompt = e.standIn.dispatches.at(-1).prompt;
  assert.ok(secondPrompt.includes(`<<<OWNER FEEDBACK\n${feedback}\nOWNER FEEDBACK>>>`));
  assert.match(secondPrompt, /Do NOT perform the gated action/);
  assert.equal(await read(worktree, 'integrations/ledger/config.json'), originalConfiguration, 'the gated action was not performed');
  assert.equal(await read(worktree, ENV_FILE), originalEnvironmentFile);
  assert.match(await read(worktree, 'migrations/ledger-v2.mjs'), /--rollback/);
  assert.doesNotMatch(await read(worktree, 'migrations/ledger-v2.mjs'), /LEDGER_ACCOUNT/);
  assert.equal(e.store.getApproval(runId, first.requestId).state, 'answered');
  assert.equal(e.store.getApproval(runId, first.requestId).decision, 'request-changes');
  assert.equal(e.store.getRun(runId).checkpoint.results.length, 1, 'task 2 is still incomplete');
  assert.equal(e.store.getRun(runId).checkpoint.index, 1);

  // The closed request cannot be approved any more, and refusing it records nothing.
  const eventsBefore = e.store.events().length;
  const stale = await e.ownerCli(['run', 'respond', runId, '--request', first.requestId, '--decision', 'approve']);
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /approval-conflict|Nothing was recorded/);
  assert.equal(e.store.events().length, eventsBefore);
  assert.equal(e.store.getApproval(runId, second.requestId).state, 'pending');

  // Re-review: approving the fresh request lets the agent finish the same run.
  const approved = await e.ownerCli(['run', 'respond', runId, '--request', second.requestId, '--decision', 'approve']);
  assert.equal(approved.status, 0, approved.stderr);
  assert.deepEqual(gitState(worktree).status, '');
  await e.until(() => e.store.getRun(runId).status === 'succeeded', 'the run to succeed');
  const done = e.store.getRun(runId);
  assert.equal(done.checkpoint.results.length, 2);
  assert.equal(e.standIn.dispatches.filter(dispatch => dispatch.agent.includes('executor')).length, 4, 'T1, T2 request, T2 correction, T2 continuation');
  const configuration = JSON.parse(await read(worktree, 'integrations/ledger/config.json'));
  assert.equal(configuration.apiVersion, 'v2');
  assert.equal(configuration.variables.tenant, 'LEDGER_TENANT', 'the owner feedback was honoured');
  assert.match(execFileSync(process.execPath, ['scripts/verify.mjs', '--expect', 'v2'], { cwd: worktree, encoding: 'utf8' }), /5 of 5 checks passed/);
  assert.equal(e.ownerCalls.length, 3, 'request changes, one refused attempt on the closed request, one approval: the owner only ever answered requests');
  assert.ok(e.ownerCalls.every(call => call[0] === 'run' && call[1] === 'respond'));

  // The correction is reversible, as the owner asked: the rollback restores the original environment file.
  const copy = path.join(e.root, 'rollback-check');
  await fs.cp(worktree, copy, { recursive: true, filter: source => !source.includes(`${path.sep}.git`) && !source.includes(`${path.sep}.heimdall`) && !source.includes(`${path.sep}.opencode`) });
  nodeIn(copy, ['migrations/ledger-v2.mjs', '--rollback']);
  assert.equal(await read(copy, ENV_FILE), originalEnvironmentFile);
  assert.match(nodeIn(copy, ['scripts/verify.mjs', '--expect', 'v1']), /5 of 5 checks passed/);

  const types = eventTypes(e);
  assert.equal(types.filter(entry => entry === 'approval.requested').length, 2);
  assert.equal(types.filter(entry => entry === 'approval.answered').length, 2);
  assert.equal(types.filter(entry => entry === 'approval.consumed').length, 2);
  const surfaces = {
    'request-changes stdout': rejected.stdout, 'request-changes stderr': rejected.stderr, 'refused stderr': stale.stderr, 'approve stdout': approved.stdout,
    'events': JSON.stringify(e.store.events()), 'run detail': JSON.stringify(await e.client.request('GET', `/runs/${runId}`)),
    'agent command output': JSON.stringify(log.map(entry => ({ ...entry, sawDecision: undefined }))), 'commit messages': git(worktree, ['log', '--format=%B']),
    ...Object.fromEntries(e.standIn.dispatches.map(dispatch => [`prompt ${dispatch.n}`, dispatch.prompt])),
  };
  for (const value of DUMMY_VALUES) assert.deepEqual(surfacesContain(surfaces, value), [], `${value} must not appear on any reported surface`);
  assert.deepEqual(await e.secretsIn(), []);
  assert.deepEqual(e.standIn.failures, []);
});

test('the example project and spec are synthetic and self-consistent', async () => {
  const files = [];
  const walk = async directory => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(full); else files.push(full);
    }
  };
  await walk(example);
  for (const file of files) {
    const text = await fs.readFile(file, 'utf8');
    assert.doesNotMatch(text, /\/Users\/|\/home\/[a-z]|C:\\\\Users|ses_[A-Za-z0-9]{12,}|sk-[A-Za-z0-9]{10,}/, `${path.relative(repository, file)} contains a personal path or credential-like text`);
  }
  assert.ok((await fs.readFile(path.join(example, 'task-spec.md'), 'utf8')).includes(FEATURE_TEXT_MARKER));
  assert.equal(nodeIn(path.join(example, 'project'), ['scripts/verify.mjs', '--expect', 'v1']).split('\n').at(-1), 'ledger verification: 5 of 5 checks passed');
});
