import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRunner } from '../dist/workflow/runner.js';
import { createDurableSubmissionGate } from '../dist/workflow/durable-submission.js';
import { createLocalSubmissionStore } from '../dist/workflow/submission-store.js';
import { SUBMISSION_TOOL_IDS } from '../dist/workflow/contracts.js';
import { renderApprovalContext, supersedeApprovalContext } from '../dist/workflow/approval-context.js';

const RUN = 'run-structured';
const settings = { plannerAgent: 'adr-planner', executorAgent: 'adr-executor', plannerModel: 'anthropic/planner', executorModel: 'anthropic/executor', executorFallbackModel: 'kimi/fallback', maxTasks: 10, minQuotaRemainingPercent: 10, tokenLimitsDisabled: true };
const task = id => ({ id, title: 'Task ' + id, brief: 'Implement ' + id, dependsOn: [], dod: ['gate for ' + id] });
const plan = (...ids) => ({ status: 'planned', planMarkdown: '# Plan', factSheet: 'Facts', tasks: ids.map(task) });
const completed = (extra = {}) => ({ status: 'completed', summary: 'Done', handoff: 'Handoff', evidence: [{ gateId: 'G1', passed: true, detail: 'verified with a real check' }], ...extra });
const caller = (n = 0) => ({ sessionID: 'ses_parent', id: 'call_' + n, messageID: 'msg_assistant_' + n, agent: 'adr-orchestrator', signal: new AbortController().signal });
const quota = async () => ({ anthropic: { fetchedAt: Date.now(), errors: [], entries: [{ name: '5h', percentRemaining: 80 }, { name: 'Weekly', percentRemaining: 80 }] } });
const SPOKEN = 'All done; this chat text is for humans only.';

async function until(condition, signal, what = 'condition') {
  const deadline = Date.now() + 3000;
  while (!(await condition())) {
    if (signal?.aborted) throw new Error('Run cancelled while waiting for ' + what);
    if (Date.now() > deadline) throw new Error('Timed out waiting for ' + what);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/**
 * Standalone-shaped structured runner with injected persistence, backend and durable gate. The "model" is a script
 * of steps, one per dispatch. Crashes are injected by making a persistence operation (and every later one) throw.
 */
async function fixture(t, script, { backendOverrides = {}, noProtocol = false, plannerArtifacts = false } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-structured-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, '.heimdall');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'feature.md'), 'Synthetic feature');
  await fs.writeFile(path.join(root, 'planner.md'), 'Planner contract');
  await fs.writeFile(path.join(root, 'executor.md'), 'Executor contract');
  const stateRoot = path.join(root, 'state');
  const local = createLocalSubmissionStore(stateRoot);
  const control = { crashed: false, crashOn: undefined, idle: true, outcome: 'succeeded', finish: 'stop', recoverError: undefined };
  const saves = [], events = [], dispatches = [], receipts = new Map();
  const prompts = new Map(), origins = new Map();
  let children = 0;
  const wrap = (op, fn) => async (...args) => {
    if (control.crashed) throw new Error('simulated crash: the process is gone (' + op + ')');
    const point = control.crashOn;
    const hit = point?.op === op && point.matches(...args);
    if (hit && !point.after) { control.crashed = true; control.crashOn = undefined; throw new Error('simulated crash before ' + op); }
    const out = await fn(...args);
    if (hit && point.after) { control.crashed = true; control.crashOn = undefined; throw new Error('simulated crash after ' + op); }
    return out;
  };
  const stateFile = path.join(stateRoot, 'runs', RUN, 'state.json');
  const persistence = {
    load: async () => local.load(RUN),
    save: wrap('save', async state => {
      saves.push(structuredClone(state));
      await fs.writeFile(stateFile + '.tmp', JSON.stringify(state));
      await fs.rename(stateFile + '.tmp', stateFile);
    }),
    bindStart: async () => {},
    readReceipt: async (_id, attempt) => structuredClone(receipts.get(attempt) ?? null),
    writeReceipt: async (_id, receipt) => { receipts.set(receipt.id, structuredClone(receipt)); },
    readSubmission: wrap('readSubmission', (...args) => local.readSubmission(...args)),
    writeSubmission: wrap('writeSubmission', (...args) => local.writeSubmission(...args)),
    readNativeOutcome: (...args) => local.readNativeOutcome(...args),
    writeNativeOutcome: wrap('writeNativeOutcome', (...args) => local.writeNativeOutcome(...args)),
  };
  const gate = createDurableSubmissionGate({
    runId: RUN, directory, planRoot: '.heimdall/plans', origin: native => origins.get(native.messageID),
    persistence: { load: persistence.load, readSubmission: local.readSubmission, writeSubmission: persistence.writeSubmission },
  });
  const backend = {
    assertIdle: async () => { if (!control.idle) throw new Error('Session is active, awaiting input, or has no durable terminal outcome; resolve it before resuming'); },
    recoverResponse: async () => {
      if (control.recoverError) throw control.recoverError;
      if (control.finish === 'length') throw new Error('Planner/executor output truncated at model output limit. Recover artifacts before resuming');
      return control.outcome === 'succeeded' ? SPOKEN : undefined;
    },
    observeDispatchPrompt: async ({ attemptId }) => prompts.get(attemptId),
    usage: async () => ({ used: 0, uncached: 0 }),
    interrupt: async () => { events.push('interrupt'); },
    runSubagent: async (input, context) => {
      const child = input.child ?? 'ses_child_' + ++children;
      await input.onStarted(child);
      const attemptId = /Workflow attempt: (\S+)/.exec(input.prompt)[1];
      const promptId = 'prompt_' + (dispatches.length + 1);
      const dispatch = { n: dispatches.length + 1, attemptId, child, promptId, agent: input.agent, prompt: input.prompt };
      dispatches.push(dispatch);
      prompts.set(attemptId, promptId);
      origins.set('msg_' + promptId, promptId);
      // The model only starts calling tools once the host has recorded the dispatch prompt (native latency).
      await until(async () => (await local.load(RUN))?.submissionBinding?.prompt === promptId, context.signal, 'the recorded dispatch prompt');
      const step = script.shift();
      assert.ok(step, 'unscripted dispatch ' + dispatch.n);
      const kind = input.agent === settings.plannerAgent ? 'planner-plan' : 'executor-result';
      const submit = (payload, extra = {}) => gate.submit(kind, payload, { sessionID: child, agent: input.agent, messageID: 'msg_' + promptId, id: 'call_' + dispatch.n, ...extra });
      return step({ dispatch, submit, input, child });
    },
    ...backendOverrides,
  };
  let runs = 0;
  const build = options => createRunner({
    directory, backend, settings, quota, persistence, workflowRoot: '.heimdall/state', planRoot: '.heimdall/plans',
    plannerPromptPath: '.heimdall/planner.md', executorPromptPath: '.heimdall/executor.md', git: args => args[0] === 'branch' ? 'heimdall/run\n' : '', ...options,
  });
  const run = build(noProtocol ? {} : { protocol: 'structured-v1' });
  const f = {
    directory, local, control, saves, events, dispatches, receipts, gate, build, run,
    state: () => local.load(RUN),
    start: (runner = run) => runner({ action: 'start', runId: RUN, adr: '.heimdall/feature.md' }, caller(++runs)).then(JSON.parse),
    resume: (input = 'Resolved', runner = run) => runner({ action: 'resume', runId: RUN, input }, caller(++runs)).then(JSON.parse),
    submission: async (attemptId, kind) => local.readSubmission(RUN, attemptId, kind),
    restart: () => { control.crashed = false; },
    executorDispatches: () => dispatches.filter(d => d.agent === settings.executorAgent),
    advancements: () => saves.filter(s => s.status === 'running' && s.phase === 'executor' && s.attempt === undefined && s.child === null && s.results.length > 0),
  };
  return f;
}

// Steps of the scripted model. Each receives { submit, child, dispatch }.
const submits = (payload, spoken = SPOKEN) => async ({ submit }) => {
  const response = await submit(payload);
  assert.equal(response.accepted, true, JSON.stringify(response));
  return spoken;
};
const speaks = text => async () => text;

test('planner and executor advance exactly once, from durable receipts and confirmed idle, with a structured prompt', async t => {
  const f = await fixture(t, [submits(plan('T1')), submits(completed())]);
  const result = await f.start();
  assert.equal(result.status, 'completed');
  const state = await f.state();
  assert.equal(state.protocol, 'structured-v1');
  assert.equal(state.results.length, 1);
  assert.equal(state.results[0].taskId, 'T1');
  assert.equal(state.results[0].sessionId, 'ses_child_2');
  assert.equal(state.results[0].evidence[0].gate, 'gate for T1', 'the host-owned gate text comes from the canonical receipt');
  assert.equal(state.index, 1);
  assert.equal(f.advancements().length, 1, 'one executor advancement save');
  assert.deepEqual(f.dispatches.map(d => d.agent), ['adr-planner', 'adr-executor']);
  // Both receipts are durable, bound to their attempt and dispatch prompt, and the legacy receipt key is never written.
  for (const d of f.dispatches) {
    const kind = d.agent === 'adr-planner' ? 'planner-plan' : 'executor-result';
    const receipt = await f.submission(d.attemptId, kind);
    assert.equal(receipt.origin, d.promptId); assert.equal(receipt.child, d.child); assert.equal(receipt.dispatch, d.n);
    const outcome = await f.local.readNativeOutcome(RUN, d.attemptId);
    assert.equal(outcome.response, SPOKEN, 'the final chat text is kept only as the native outcome');
  }
  assert.equal(f.receipts.size, 0, 'no legacy WorkflowReceipt is written for a structured run');
  assert.equal(state.submissionBinding.status, 'closed');
  // Prompts: tool submission and stop after acknowledgement; no prose JSON contract.
  const [planner, executor] = f.dispatches.map(d => d.prompt);
  assert.match(planner, new RegExp(SUBMISSION_TOOL_IDS['planner-plan']));
  assert.match(executor, new RegExp(SUBMISSION_TOOL_IDS['executor-result']));
  for (const prompt of [planner, executor]) {
    assert.match(prompt, /After the tool acknowledges the submission, stop/);
    assert.doesNotMatch(prompt, /Return the specified JSON as your final answer|Executor completion contract/);
  }
  assert.match(executor, /G1 = gate for T1/);
  assert.match(planner, /Planning artifact directory: .*adr-run-structured/);
});

test('the binding is saved with the attempt before any child exists, bound to the child before prompt admission, then recorded and closed', async t => {
  const f = await fixture(t, [submits(plan('T1')), speaks(SPOKEN)]);
  assert.equal((await f.start()).status, 'paused');
  assert.ok(f.saves.every(state => state.protocol === 'structured-v1'));
  const planning = f.saves.filter(state => state.attempt?.phase === 'planner' && state.submissionBinding);
  assert.equal(planning[0].submissionBinding.child, null);
  assert.equal(planning[0].submissionBinding.status, 'open');
  assert.equal(planning[0].submissionBinding.prompt, null, 'no call is authenticated before the host records the prompt');
  const bound = planning.findIndex(state => state.submissionBinding.child === state.child && state.child !== null);
  assert.ok(bound > 0, 'the child is bound and saved before the prompt is recorded');
  assert.equal(planning[bound].submissionBinding.prompt, null);
  assert.equal(planning.at(-1).submissionBinding.prompt, 'prompt_1');
  const executing = f.saves.filter(state => state.attempt?.phase === 'executor' && state.submissionBinding?.status === 'open');
  assert.equal(executing[0].submissionBinding.taskId, 'T1');
  assert.ok(executing[0].submissionBinding.dispatch > planning[0].submissionBinding.dispatch, 'every dispatch generation rises');
  const state = await f.state();
  assert.equal(state.status, 'paused');
  assert.equal(state.submissionBinding.status, 'closed', 'a paused run accepts no late submission');
  // Closed binding: the gate now refuses even the bound child.
  const late = await f.gate.submit('executor-result', completed(), { sessionID: 'ses_child_2', agent: 'adr-executor', messageID: 'msg_prompt_2', id: 'late' });
  assert.equal(late.accepted, false); assert.equal(late.code, 'unauthorized');
});

test('a resume keeps the protocol the run started with, even when the runner has none selected', async t => {
  const f = await fixture(t, [submits(plan('T1')), speaks(SPOKEN), submits(completed())]);
  assert.equal((await f.start()).status, 'paused');
  const plain = f.build({});
  const resumed = await f.resume('Resolved', plain);
  assert.equal(resumed.status, 'completed');
  const state = await f.state();
  assert.equal(state.protocol, 'structured-v1');
  assert.equal(state.results.length, 1);
});

test('prose JSON without a submission never admits a plan or advances a task', async t => {
  const prose = { status: 'planned', planMarkdown: '# Plan', factSheet: 'Facts', tasks: [task('T1')] };
  const planning = await fixture(t, [speaks(JSON.stringify(prose))]);
  const paused = await planning.start();
  assert.equal(paused.status, 'paused');
  assert.match(paused.reason, /No valid submission was recorded for the plan/);
  assert.doesNotMatch(paused.reason, /restate|repair|correction/i);
  let state = await planning.state();
  assert.equal(state.phase, 'planner'); assert.deepEqual(state.tasks, []);
  await assert.rejects(fs.access(path.join(planning.directory, '.heimdall/state/runs', RUN, 'tasks.json')), { code: 'ENOENT' });
  assert.equal(state.attempt.status, 'rejected');

  const legacyShaped = { status: 'completed', taskId: 'T1', summary: 'Done', handoff: 'H', evidence: [{ gateId: 'G1', gate: 'gate for T1', passed: true, detail: 'Proved' }] };
  const executing = await fixture(t, [submits(plan('T1')), speaks('```json\n' + JSON.stringify(legacyShaped) + '\n```')]);
  const stopped = await executing.start();
  assert.equal(stopped.status, 'paused');
  assert.match(stopped.reason, /No valid submission was recorded for T1/);
  assert.doesNotMatch(stopped.reason, /restate|repair|correction/i);
  state = await executing.state();
  assert.equal(state.index, 0); assert.deepEqual(state.results, []);
  assert.equal(state.reportRecovery.diagnostic.code, 'submission_missing');
  assert.equal(executing.advancements().length, 0);
  assert.match((await executing.local.readNativeOutcome(RUN, executing.dispatches[1].attemptId)).response, /"taskId":"T1"/, 'the chat text is stored as the native outcome only');
});

test('a rejected submission call records nothing, and the child that then stops pauses as a missing submission', async t => {
  const f = await fixture(t, [submits(plan('T1')), async ({ submit }) => {
    const response = await submit({ status: 'completed', summary: 'Done', handoff: 'H', evidence: [] });
    assert.equal(response.accepted, false); assert.equal(response.code, 'format');
    return SPOKEN;
  }]);
  const result = await f.start();
  assert.equal(result.status, 'paused');
  assert.match(result.reason, /No valid submission was recorded for T1/);
  assert.equal(await f.submission(f.dispatches[1].attemptId, 'executor-result'), null);
});

test('blocked and unfinished submissions pause with their own reason and never invite a repair', async t => {
  const blocked = await fixture(t, [submits(plan('T1')), submits({ status: 'blocked', reason: 'Attach the phone' })]);
  const stopped = await blocked.start();
  assert.equal(stopped.status, 'paused');
  assert.match(stopped.reason, /agent reported blocked: Attach the phone/);
  assert.doesNotMatch(stopped.reason, /restate|repair|correction/i);
  assert.equal((await blocked.state()).reportRecovery.diagnostic.code, 'agent_blocked');
  assert.equal((await blocked.state()).index, 0);

  const unfinished = await fixture(t, [submits(plan('T1')), submits(completed({ evidence: [{ gateId: 'G1', passed: false, detail: 'tests still red' }] }))]);
  const open = await unfinished.start();
  assert.equal(open.status, 'paused');
  assert.match(open.reason, /Unfinished work for T1: gates G1 were reported unresolved/);
  assert.doesNotMatch(open.reason, /restate|repair|correction/i);
  const state = await unfinished.state();
  assert.equal(state.reportRecovery.diagnostic.code, 'unfinished_work');
  assert.deepEqual(state.reportRecovery.diagnostic.gateIds, ['G1']);
  assert.deepEqual(state.results, []);

  const planBlocked = await fixture(t, [submits({ status: 'blocked', reason: 'Need a decision' })]);
  const planPause = await planBlocked.start();
  assert.equal(planPause.status, 'paused'); assert.match(planPause.reason, /Need a decision/);
  assert.equal((await planBlocked.state()).phase, 'planner');
});

test('explicit resume after a blocked submission redispatches the same child with a fresh dispatch and keeps the receipt history', async t => {
  const f = await fixture(t, [submits(plan('T1')), submits({ status: 'blocked', reason: 'Owner input' }), submits(completed())]);
  assert.equal((await f.start()).status, 'paused');
  const resumed = await f.resume('Owner supplied it');
  assert.equal(resumed.status, 'completed');
  const [, first, second] = f.dispatches;
  assert.equal(second.child, first.child, 'the paused task resumes on the same child');
  assert.ok(second.n > first.n);
  const history = [await f.submission(first.attemptId, 'executor-result'), await f.submission(second.attemptId, 'executor-result')];
  assert.deepEqual(history.map(r => r?.outcome), ['blocked', 'completed'], 'the blocked receipt stays after the rebinding');
  assert.deepEqual(history.map(r => r.dispatch), [first.n, second.n]);
  assert.equal((await f.state()).results.length, 1);
  assert.equal(f.advancements().length, 1);
});

test('a missing submission pauses actionably and a later explicit resume can still complete', async t => {
  const f = await fixture(t, [submits(plan('T1')), speaks('I refuse to continue.'), submits(completed())]);
  const paused = await f.start();
  assert.equal(paused.status, 'paused');
  assert.match(paused.reason, /refusal, omission, a limit, or a rejected call/);
  assert.equal((await f.resume()).status, 'completed');
  assert.equal(f.executorDispatches().length, 2);
});

test('a late call from an earlier dispatch on the reused child cannot bind to the newest attempt', async t => {
  let staleResponse;
  const f = await fixture(t, [submits(plan('T1')), submits({ status: 'blocked', reason: 'Owner input' }), async ({ submit }) => {
    // A delayed call still carries the origin of the first executor dispatch.
    staleResponse = await submit(completed(), { messageID: 'msg_prompt_2', id: 'call_stale' });
    const fresh = await submit(completed());
    assert.equal(fresh.accepted, true);
    return SPOKEN;
  }]);
  assert.equal((await f.start()).status, 'paused');
  assert.equal((await f.resume()).status, 'completed');
  assert.equal(staleResponse.accepted, false); assert.equal(staleResponse.code, 'unauthorized');
  const [, first, second] = f.dispatches;
  assert.equal((await f.submission(first.attemptId, 'executor-result')).outcome, 'blocked', 'the earlier receipt is untouched');
  const receipt = await f.submission(second.attemptId, 'executor-result');
  assert.equal(receipt.origin, second.promptId); assert.equal(receipt.caller.callId, 'call_3');
});

// --- Crash boundaries ----------------------------------------------------------------------------------------

test('crash (a) before the receipt is persisted: nothing is acknowledged or admitted, and a resume redispatches without double advancement', async t => {
  const f = await fixture(t, [submits(plan('T1')), submits(completed()), submits(completed())]);
  f.control.crashOn = { op: 'writeSubmission', after: false, matches: (_id, receipt) => receipt.kind === 'executor-result' };
  await assert.rejects(f.start(), /simulated crash/);
  const [, first] = f.dispatches;
  assert.equal(await f.submission(first.attemptId, 'executor-result'), null);
  assert.equal((await f.state()).index, 0);
  assert.equal((await f.state()).results.length, 0);
  f.restart();
  assert.equal((await f.resume('Retry')).status, 'completed');
  // Without any receipt there is nothing to recover: the unacknowledged attempt is redone once, and advances once.
  assert.equal(f.executorDispatches().length, 2);
  assert.equal((await f.state()).results.length, 1);
  assert.equal(f.advancements().length, 1);
});

test('crash (b) after the receipt is persisted but before acknowledgement: the receipt is applied without redispatch', async t => {
  const f = await fixture(t, [submits(plan('T1')), async ({ submit }) => { await submit(completed()); return SPOKEN; }]);
  f.control.crashOn = { op: 'writeSubmission', after: true, matches: (_id, receipt) => receipt.kind === 'executor-result' };
  await assert.rejects(f.start(), /simulated crash/);
  const [, first] = f.dispatches;
  assert.equal((await f.submission(first.attemptId, 'executor-result')).outcome, 'completed');
  assert.equal((await f.state()).results.length, 0, 'not advanced by the dying process');
  f.restart();
  assert.equal((await f.resume('Recover')).status, 'completed');
  assert.equal(f.dispatches.length, 2, 'recovery never redispatches implementation');
  assert.equal((await f.state()).results.length, 1);
  assert.equal(f.advancements().length, 1);
});

test('crash (c) after acknowledgement but before the child stops: nothing advances until the child is confirmed stopped', async t => {
  const f = await fixture(t, [submits(plan('T1')), async ({ submit }) => {
    assert.equal((await submit(completed())).accepted, true);
    f.control.idle = false; // The child keeps running after the acknowledgement.
    throw new Error('Native child was interrupted');
  }]);
  const paused = await f.start();
  assert.equal(paused.status, 'paused');
  assert.equal((await f.state()).results.length, 0);
  assert.equal((await f.submission(f.dispatches[1].attemptId, 'executor-result')).outcome, 'completed');
  // Still running: the explicit resume is refused before anything is admitted or dispatched.
  await assert.rejects(f.resume('Too early'), /active|awaiting input|terminal outcome/);
  assert.equal((await f.state()).results.length, 0); assert.equal(f.dispatches.length, 2);
  // Stopped but not successfully: still no advancement.
  f.control.idle = true; f.control.outcome = 'interrupted';
  const unconfirmed = await f.resume('Check again');
  assert.equal(unconfirmed.status, 'paused'); assert.match(unconfirmed.reason, /could not be confirmed/);
  assert.equal((await f.state()).results.length, 0);
  // Confirmed stop: the saved receipt is applied once, without redispatch.
  f.control.outcome = 'succeeded';
  assert.equal((await f.resume('Now stopped')).status, 'completed');
  assert.equal(f.dispatches.length, 2);
  assert.equal(f.advancements().length, 1);
});

test('crash (d) before the checkpoint advancement is saved: the receipt replays and advances exactly once', async t => {
  const f = await fixture(t, [submits(plan('T1')), submits(completed())]);
  f.control.crashOn = { op: 'save', after: false, matches: state => state.status === 'running' && state.index === 1 && state.attempt === undefined };
  await assert.rejects(f.start(), /simulated crash/);
  const disk = await f.state();
  assert.equal(disk.index, 0); assert.ok(disk.attempt, 'the checkpoint still holds the attempt');
  f.restart();
  assert.equal((await f.resume('Recover')).status, 'completed');
  assert.equal(f.dispatches.length, 2);
  assert.equal((await f.state()).results.length, 1);
  assert.equal(f.advancements().length, 1);
});

test('crash (e) after the checkpoint advancement is saved: the next task runs and the finished task is neither redone nor advanced twice', async t => {
  const f = await fixture(t, [submits(plan('T1', 'T2')), submits(completed()), submits(completed())]);
  f.control.crashOn = { op: 'save', after: true, matches: state => state.status === 'running' && state.index === 1 && state.attempt === undefined };
  await assert.rejects(f.start(), /simulated crash/);
  assert.equal((await f.state()).index, 1);
  f.restart();
  assert.equal((await f.resume('Recover')).status, 'completed');
  const state = await f.state();
  assert.deepEqual(state.results.map(r => r.taskId), ['T1', 'T2']);
  assert.equal(f.executorDispatches().filter(d => d.prompt.includes('"id":"T1"')).length, 1, 'T1 is never redispatched');
  assert.equal(f.executorDispatches().length, 2);
});

test('a receipt followed by interruption, truncation or a native failure pauses without advancing and a later confirmed stop applies it', async t => {
  const f = await fixture(t, [submits(plan('T1')), async ({ submit }) => { await submit(completed()); throw new Error('Native child was interrupted'); }]);
  const interrupted = await f.start();
  assert.equal(interrupted.status, 'paused'); assert.match(interrupted.reason, /Native\/provider failure/);
  assert.equal((await f.state()).results.length, 0);
  f.control.finish = 'length';
  const truncated = await f.resume('After truncation');
  assert.equal(truncated.status, 'paused');
  assert.match(truncated.reason, /could not be confirmed.*truncated/);
  assert.doesNotMatch(truncated.reason, /restate|repair|correction/i);
  f.control.finish = 'stop'; f.control.outcome = 'failed';
  const failed = await f.resume('After failure');
  assert.equal(failed.status, 'paused'); assert.match(failed.reason, /could not be confirmed/);
  assert.equal((await f.state()).results.length, 0); assert.equal(f.dispatches.length, 2);
  f.control.outcome = 'succeeded';
  assert.equal((await f.resume('Finally stopped')).status, 'completed');
  assert.equal(f.dispatches.length, 2); assert.equal(f.advancements().length, 1);
});

test('a receipt followed by an auth or quota failure stays a real failure, not an unconfirmed stop', async t => {
  const f = await fixture(t, [submits(plan('T1')), async ({ submit }) => {
    assert.equal((await submit(completed())).accepted, true);
    f.control.recoverError = new Error('Claude Code authentication unavailable. Refresh Claude Code manually, then explicitly resume this run.');
    return SPOKEN;
  }]);
  const result = await f.start();
  assert.equal(result.status, 'paused');
  assert.match(result.reason, /authentication unavailable/);
  assert.doesNotMatch(result.reason, /could not be confirmed/);
  assert.equal((await f.state()).reportRecovery.diagnostic.code, 'auth_or_quota');
  assert.equal((await f.state()).results.length, 0);
});

test('an unconfirmed planner stop pauses with the plan reason and keeps the receipt for the resume', async t => {
  const f = await fixture(t, [submits(plan('T1')), submits(completed())]);
  f.control.outcome = 'interrupted';
  const paused = await f.start();
  assert.equal(paused.status, 'paused');
  assert.match(paused.reason, /submission was recorded for the plan but the child's successful stop could not be confirmed/);
  assert.equal((await f.state()).phase, 'planner');
  assert.equal((await f.submission(f.dispatches[0].attemptId, 'planner-plan')).outcome, 'planned');
  f.control.outcome = 'succeeded';
  assert.equal((await f.resume('Stopped now')).status, 'completed');
  assert.equal(f.dispatches.length, 2, 'the planner is not dispatched again');
});

test('a plan submitted through the fixed artifact directory is admitted from its immutable snapshot, not from later file edits', async t => {
  let files;
  const f = await fixture(t, [async ({ submit }) => {
    const base = path.join(files, '.heimdall/plans/adr-' + RUN);
    await fs.mkdir(base, { recursive: true });
    await fs.writeFile(path.join(base, 'plan.md'), '# Plan from files');
    await fs.writeFile(path.join(base, 'facts.md'), 'Facts from files');
    await fs.writeFile(path.join(base, 'tasks.md'), JSON.stringify([task('T1')]));
    const response = await submit({ status: 'planned', artifacts: true });
    assert.equal(response.accepted, true, JSON.stringify(response));
    // Edits after the acknowledgement cannot change the acknowledged plan.
    await fs.writeFile(path.join(base, 'tasks.md'), JSON.stringify([task('T9')]));
    return SPOKEN;
  }, submits(completed())]);
  files = f.directory;
  assert.equal((await f.start()).status, 'completed');
  const state = await f.state();
  assert.deepEqual(state.tasks.map(x => x.id), ['T1']);
  assert.equal(await fs.readFile(path.join(f.directory, '.heimdall/state/runs', RUN, 'plan.md'), 'utf8'), '# Plan from files');
});

// --- Authentication and capability ---------------------------------------------------------------------------

test('a backend that cannot observe the dispatch prompt pauses before anything is dispatched', async t => {
  const f = await fixture(t, [], { backendOverrides: { observeDispatchPrompt: undefined } });
  const paused = await f.start();
  assert.equal(paused.status, 'paused');
  assert.match(paused.reason, /cannot observe the dispatch prompt/);
  assert.equal(f.dispatches.length, 0);
});

test('a failed prompt observation stops the dispatch fail closed and nothing is accepted', async t => {
  const f = await fixture(t, [], { backendOverrides: { observeDispatchPrompt: async () => { throw new Error('Child session does not belong to this parent'); } } });
  const paused = await f.start();
  assert.equal(paused.status, 'paused');
  assert.match(paused.reason, /does not belong to this parent/);
  assert.equal(await f.submission(f.dispatches[0].attemptId, 'planner-plan'), null);
  assert.equal((await f.state()).phase, 'planner');
});

test('a run without a selected protocol keeps the legacy prose path', async t => {
  const f = await fixture(t, [], { noProtocol: true, backendOverrides: {
    runSubagent: async input => { await input.onStarted(input.child ?? 'ses_legacy'); return JSON.stringify(input.agent === 'adr-planner' ? plan('T1') : { status: 'completed', taskId: 'T1', summary: 'S', handoff: 'H', evidence: [{ gateId: 'G1', passed: true, detail: 'Proved' }] }); },
  } });
  assert.equal((await f.start()).status, 'completed');
  const state = await f.state();
  assert.ok(!('protocol' in state) && !('submissionBinding' in state));
  assert.equal(f.receipts.size, 2, 'legacy receipts are still written under the legacy key');
});

// --- Typed approval-required wait ------------------------------------------------------------------------------

const approvalRequest = (extra = {}) => ({
  status: 'approval-required', question: 'Approve the renaming of the public export?', scope: 'Rename export only in src/index.ts and its tests',
  completedWork: 'Prepared the rename and ran the unit tests', verification: ['unit tests: 12 passed'], artifacts: ['src/index.ts', 'commit abc1234'],
  onApprove: ['Rename the export', 'Re-run the unit tests'], onRequestChanges: ['Adjust the rename within the same scope and submit a fresh request'], ...extra,
});

test('an approval-required submission pauses the run on a semantic wait without completing, advancing, repairing or reprompting', async t => {
  const f = await fixture(t, [submits(plan('T1')), submits(approvalRequest()), submits(completed())]);
  const paused = await f.start();
  assert.equal(paused.status, 'paused');
  assert.equal(paused.reason, 'Approval required for T1: Approve the renaming of the public export?');
  const state = await f.state();
  const attemptId = f.dispatches[1].attemptId;
  assert.equal(state.status, 'paused');
  assert.deepEqual(state.wait, { kind: 'approval', attemptId, index: 0, taskId: 'T1' });
  assert.equal(state.reason, paused.reason);
  assert.equal(state.index, 0, 'the task index does not advance');
  assert.deepEqual(state.results, [], 'no result is added and no gate turns green');
  assert.equal(f.advancements().length, 0);
  assert.equal(state.reportRecovery.corrections, 0, 'no report correction is consumed');
  assert.equal(state.reportRecovery.mode, 'paused');
  assert.equal(state.reportRecovery.diagnostic.code, 'approval_required');
  assert.equal(state.submissionRepair, undefined, 'no submission repair is counted');
  assert.equal(state.attempt.status, 'rejected', 'the attempt is finished and is not reprompted');
  assert.equal(f.executorDispatches().length, 1, 'the child is not reprompted');
  assert.equal(state.submissionBinding.status, 'closed', 'a paused run accepts no late submission');
  const receipt = await f.submission(attemptId, 'executor-result');
  assert.equal(receipt.outcome, 'approval-required');
  assert.deepEqual(receipt.contract, { protocol: 'structured-v1', kind: 'executor-result', version: 2 });
  assert.equal(receipt.canonical.taskId, 'T1');
  assert.equal(receipt.canonical.onApprove[0], 'Rename the export');
  const late = await f.gate.submit('executor-result', completed(), { sessionID: f.dispatches[1].child, agent: 'adr-executor', messageID: 'msg_prompt_2', id: 'late' });
  assert.equal(late.accepted, false);
  assert.equal(state.phase, 'executor');
  // Nothing runs on its own: a later explicit resume clears the wait and redispatches the same unfinished task.
  const resumed = await f.resume('Owner decision recorded');
  assert.equal(resumed.status, 'completed');
  assert.equal((await f.state()).wait, undefined);
});

test('advancement clears a wait', async t => {
  const f = await fixture(t, [submits(plan('T1', 'T2')), submits(approvalRequest()), submits(completed()), submits(completed())]);
  await f.start();
  assert.equal((await f.state()).wait.taskId, 'T1');
  assert.equal((await f.resume('Approved')).status, 'completed');
  const state = await f.state();
  assert.equal(state.index, 2);
  assert.equal(state.wait, undefined);
  assert.equal(f.saves.filter(save => save.wait).every(save => save.status === 'paused'), true, 'a wait is only ever recorded on a paused checkpoint');
});

test('generic blocked, unfinished, missing-submission and quota pauses never set a wait or become approvals', async t => {
  // The reason text mentions approval: nothing is ever parsed from it.
  const blocked = await fixture(t, [submits(plan('T1')), submits({ status: 'blocked', reason: 'Approval required: please approve the migration' })]);
  assert.equal((await blocked.start()).status, 'paused');
  assert.equal((await blocked.state()).wait, undefined);
  assert.equal((await blocked.state()).reportRecovery.diagnostic.code, 'agent_blocked');

  const unfinished = await fixture(t, [submits(plan('T1')), submits(completed({ evidence: [{ gateId: 'G1', passed: false, detail: 'approval-required: waiting for sign-off' }] }))]);
  assert.equal((await unfinished.start()).status, 'paused');
  assert.equal((await unfinished.state()).wait, undefined);
  assert.equal((await unfinished.state()).reportRecovery.diagnostic.code, 'unfinished_work');

  const missing = await fixture(t, [submits(plan('T1')), speaks('{"status":"approval-required","question":"Approve?"}')]);
  const stopped = await missing.start();
  assert.equal(stopped.status, 'paused');
  assert.match(stopped.reason, /No valid submission was recorded for T1/);
  assert.equal((await missing.state()).wait, undefined);
  assert.equal((await missing.state()).reportRecovery.diagnostic.code, 'submission_missing');

  const quota = await fixture(t, [submits(plan('T1')), async ({ submit }) => {
    assert.equal((await submit(completed())).accepted, true);
    quota.control.recoverError = new Error('Claude Code authentication unavailable. Refresh Claude Code manually, then explicitly resume this run.');
    return SPOKEN;
  }]);
  assert.equal((await quota.start()).status, 'paused');
  assert.equal((await quota.state()).wait, undefined);
  assert.equal((await quota.state()).reportRecovery.diagnostic.code, 'auth_or_quota');

  // A planner cannot ask for approval: the payload is a format error and the planner never waits.
  const planner = await fixture(t, [async ({ submit }) => {
    const response = await submit(approvalRequest());
    assert.deepEqual([response.accepted, response.code, response.repairable], [false, 'format', true]);
    return SPOKEN;
  }]);
  assert.equal((await planner.start()).status, 'paused');
  assert.equal((await planner.state()).wait, undefined);
});

test('a stale wait is cleared when the next pause has another reason', async t => {
  const f = await fixture(t, [submits(plan('T1')), submits(approvalRequest()), submits({ status: 'blocked', reason: 'Need the staging credentials' })]);
  await f.start();
  assert.equal((await f.state()).wait.taskId, 'T1');
  assert.equal((await f.resume('Approved')).status, 'paused');
  const state = await f.state();
  assert.equal(state.wait, undefined, 'a blocked pause never carries the earlier approval wait');
  assert.equal(state.reportRecovery.diagnostic.code, 'agent_blocked');
});

// --- Owner decisions delivered by the coordinator's resume ----------------------------------------------------------------

const decisionEnvelope = (overrides = {}) => renderApprovalContext({
  requestId: 'apr_synthetic_1', decision: 'approve', feedback: null, scope: 'Rename export only in src/index.ts and its tests',
  revision: { head: 'a'.repeat(40), digest: 'b'.repeat(64) }, onApprove: ['Rename the export', 'Re-run the unit tests'],
  onRequestChanges: ['Adjust the rename within the same scope and submit a fresh request'], taskId: 'T2', index: 1, ...overrides,
});

test('an approval decision continues the same task with a fresh attempt and binding, and completes only by an ordinary submission', async t => {
  let during;
  const f = await fixture(t, [
    submits(plan('T1', 'T2')), submits(completed()), submits(approvalRequest()),
    async ({ submit }) => {
      during = await f.state(); // The decision has been delivered; nothing is complete yet.
      const response = await submit(completed());
      assert.equal(response.accepted, true, JSON.stringify(response));
      return SPOKEN;
    },
  ]);
  assert.equal((await f.start()).status, 'paused');
  const waiting = await f.state();
  assert.equal(waiting.index, 1);
  assert.equal(waiting.wait.taskId, 'T2');
  const earlier = { results: structuredClone(waiting.results), parent: waiting.parent, branch: waiting.branch, tasks: structuredClone(waiting.tasks), id: waiting.id };
  const before = f.executorDispatches();
  const asked = before.at(-1);
  const resumed = await f.resume(decisionEnvelope());
  assert.equal(resumed.status, 'completed');
  const [, , , second] = f.dispatches;
  assert.equal(second.child, asked.child, 'the same child continues the task');
  assert.notEqual(second.attemptId, asked.attemptId, 'a fresh attempt');
  assert.ok(second.n > asked.n, 'a fresh dispatch binding');
  assert.equal(during.index, 1);
  assert.equal(during.results.length, 1, 'the approval itself completed nothing');
  assert.equal(during.wait, undefined);
  assert.equal(during.resolution, undefined, 'a structured decision is not kept as free text');
  assert.equal(during.approval.requestId, 'apr_synthetic_1');
  assert.equal(during.approval.decision, 'approve');
  assert.equal(during.attempt.id, second.attemptId);
  assert.equal(during.submissionBinding.dispatch, second.n, 'the submission binding is reopened for the new dispatch');
  assert.equal(second.prompt.includes('Owner decision on your approval request apr_synthetic_1 (task T2):'), true);
  assert.match(second.prompt, /Decision: approve/);
  assert.match(second.prompt, /Scope you asked approval for: Rename export only in src\/index\.ts and its tests/);
  assert.match(second.prompt, /  - Rename the export\n  - Re-run the unit tests/);
  assert.match(second.prompt, /An approval does not complete any gate/);
  assert.equal(second.prompt.includes('Owner resolution:'), false);
  const final = await f.state();
  assert.equal(final.approval, undefined, 'the decision ends with the task');
  assert.deepEqual({ results: final.results.slice(0, 1), parent: final.parent, branch: final.branch, tasks: final.tasks, id: final.id }, earlier);
  assert.equal(final.results.length, 2);
  assert.equal(final.index, 2);
  assert.equal((await f.submission(second.attemptId, 'executor-result')).outcome, 'completed');
  assert.equal((await f.submission(asked.attemptId, 'executor-result')).outcome, 'approval-required');
});

test('requested changes reach the child verbatim, forbid the gated action, and a corrected proposal asks again', async t => {
  const feedback = '  Do not rename it yet.\n\n"Quote": keep `src/index.ts` as is\n--decision approve --input=x\n\ttabbed  \n';
  let corrected;
  const f = await fixture(t, [
    submits(plan('T1')), submits(approvalRequest()),
    async ({ submit }) => { corrected = await submit(approvalRequest({ question: 'Approve the corrected rename?' })); return SPOKEN; },
    submits(completed()),
  ]);
  assert.equal((await f.start()).status, 'paused');
  const changes = decisionEnvelope({ decision: 'request-changes', feedback, taskId: 'T1', index: 0 });
  const second = await f.resume(changes);
  assert.equal(second.status, 'paused');
  assert.equal(corrected.accepted, true);
  const [, , revised] = f.dispatches;
  assert.equal(revised.prompt.includes('<<<OWNER FEEDBACK\n' + feedback + '\nOWNER FEEDBACK>>>'), true, 'verbatim, between fixed markers');
  assert.match(revised.prompt, /Decision: request-changes/);
  assert.match(revised.prompt, /Do NOT perform the gated action/);
  assert.match(revised.prompt, /submit a fresh approval request; this request cannot be approved any more/);
  assert.match(revised.prompt, /  - Adjust the rename within the same scope/);
  const state = await f.state();
  assert.equal(state.status, 'paused');
  assert.equal(state.wait.taskId, 'T1');
  assert.equal(state.wait.attemptId, revised.attemptId, 'the corrected proposal is a new attempt that is waiting for its own decision');
  assert.notEqual(state.wait.attemptId, f.dispatches[1].attemptId);
  assert.equal(state.approval.decision, 'request-changes', 'the context stays until the task really advances or a newer decision replaces it');
  assert.equal(state.index, 0);
  assert.deepEqual(state.results, []);
  // The next decision replaces the context; a generic text resume keeps it.
  const approved = await f.resume(decisionEnvelope({ requestId: 'apr_synthetic_2', taskId: 'T1', index: 0 }));
  assert.equal(approved.status, 'completed');
  const last = f.dispatches.at(-1);
  assert.match(last.prompt, /apr_synthetic_2/);
  assert.equal(last.prompt.includes('OWNER FEEDBACK'), false);
});

test('a superseded decision tells the child to keep its work and ask again, and a mismatched or damaged envelope is refused', async t => {
  const f = await fixture(t, [submits(plan('T1')), submits(approvalRequest()), submits(completed())]);
  assert.equal((await f.start()).status, 'paused');
  const waiting = await f.state();
  const saves = f.saves.length;
  for (const bad of [
    decisionEnvelope({ taskId: 'T9', index: 0 }), decisionEnvelope({ taskId: 'T1', index: 3 }), decisionEnvelope({ taskId: 'T2', index: 1 }),
    JSON.stringify({ heimdall: 'approval-continuation', version: 1, requestId: 'apr_x', decision: 'approve' }),
    JSON.stringify({ ...JSON.parse(decisionEnvelope({ taskId: 'T1', index: 0 })), extra: true }),
    JSON.stringify({ ...JSON.parse(decisionEnvelope({ taskId: 'T1', index: 0 })), decision: 'request-changes', feedback: ' ' }),
  ]) await assert.rejects(f.resume(bad), /approval continuation|Malformed|does not match/);
  assert.equal(f.saves.length, saves, 'a refused decision changes nothing');
  assert.deepEqual(await f.state(), waiting);
  const resumed = await f.resume(supersedeApprovalContext(JSON.parse(decisionEnvelope({ taskId: 'T1', index: 0 })), 'The reviewed worktree changed after the decision was recorded'));
  assert.equal(resumed.status, 'completed');
  const prompt = f.dispatches.at(-1).prompt;
  assert.match(prompt, /Decision: SUPERSEDED/);
  assert.match(prompt, /Keep your work, do NOT perform the gated action, and submit a fresh approval request/);
  assert.equal(prompt.includes('You keep every remaining action'), false, 'a withdrawn approval lists no authorized actions');
});

test('other resolutions keep the free-text behavior, with or without a prior decision, and an unmanaged runner never trusts an envelope', async t => {
  const f = await fixture(t, [submits(plan('T1')), submits(approvalRequest()), submits({ status: 'blocked', reason: 'Need access' }), submits(completed())]);
  await f.start();
  assert.equal((await f.resume(decisionEnvelope({ taskId: 'T1', index: 0 }))).status, 'paused');
  assert.equal((await f.state()).approval.decision, 'approve');
  assert.equal((await f.resume('Access granted')).status, 'completed');
  const prompt = f.dispatches.at(-1).prompt;
  assert.match(prompt, /Owner resolution: Access granted/);
  assert.match(prompt, /Owner decision on your approval request apr_synthetic_1/, 'the earlier decision is still in force until the task advances');
  const plain = await fixture(t, [submits(plan('T1')), submits(approvalRequest()), submits(completed())]);
  await plain.start();
  const noPersistence = plain.build({ protocol: 'structured-v1', persistence: undefined });
  const envelope = decisionEnvelope({ taskId: 'T1', index: 0 });
  assert.equal((await plain.resume(envelope, noPersistence)).status, 'completed');
  const unmanaged = plain.dispatches.at(-1).prompt;
  assert.equal(unmanaged.includes('Owner resolution: ' + envelope), true, 'only a coordinator-managed run reads the envelope; here it is plain text');
  assert.equal(unmanaged.includes('Owner decision on your approval request'), false);
  assert.equal((await plain.state()).approval, undefined);
});
