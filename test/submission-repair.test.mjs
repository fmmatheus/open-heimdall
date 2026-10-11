import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRunner } from '../dist/workflow/runner.js';
import { createDurableSubmissionGate } from '../dist/workflow/durable-submission.js';
import { createLocalSubmissionStore } from '../dist/workflow/submission-store.js';
import { createSubmissionSupervisor, MAX_SUBMISSION_REPAIRS } from '../dist/workflow/submission-repair.js';
import { checkpointReportInfo, submissionRepairInfo } from '../dist/workflow/report-info.js';
import { createPlugin } from '../dist/opencode/plugin.js';
import { createReportOnlyRegistry, REPAIR_ONLY_DENIAL, REPORT_ONLY_DENIAL } from '../dist/opencode/report-only.js';
import { loadConfiguration } from '../dist/config.js';
import { SEALED_DENIAL } from '../dist/workflow/submission.js';
import { negativeSignal } from '../dist/workflow/contracts.js';

const RUN = 'run-repair';
const PLAN_TOOL = 'heimdall_submit_plan';
const RESULT_TOOL = 'heimdall_submit_result';
const settings = { plannerAgent: 'adr-planner', executorAgent: 'adr-executor', plannerModel: 'anthropic/planner', executorModel: 'anthropic/executor', executorFallbackModel: 'kimi/fallback', maxTasks: 10, minQuotaRemainingPercent: 10, tokenLimitsDisabled: true };
const task = id => ({ id, title: 'Task ' + id, brief: 'Implement ' + id, dependsOn: [], dod: ['gate for ' + id] });
const plan = (...ids) => ({ status: 'planned', planMarkdown: '# Plan', factSheet: 'Facts', tasks: ids.map(task) });
const completed = (extra = {}) => ({ status: 'completed', summary: 'Done', handoff: 'Handoff', evidence: [{ gateId: 'G1', passed: true, detail: 'verified with a real check' }], ...extra });
const malformed = () => ({ status: 'completed', summary: 'Done' });
const caller = (n = 0) => ({ sessionID: 'ses_parent', id: 'call_' + n, messageID: 'msg_assistant_' + n, agent: 'adr-orchestrator', signal: new AbortController().signal });
const goodQuota = async () => ({ anthropic: { fetchedAt: Date.now(), errors: [], entries: [{ name: '5h', percentRemaining: 80 }, { name: 'Weekly', percentRemaining: 80 }] } });
const SPOKEN = 'All done; this chat text is for humans only.';
const registration = () => ({ dispose: async () => {} });

async function until(condition, signal, what = 'condition') {
  const deadline = Date.now() + 3000;
  while (!(await condition())) {
    if (signal?.aborted) throw new Error('Run cancelled while waiting for ' + what);
    if (Date.now() > deadline) throw new Error('Timed out waiting for ' + what);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/**
 * Structured runner wired to the REAL plugin hooks and submission tools. The scripted "model" calls tools through a
 * host simulation that mirrors OpenCode's order: framework input check, then execute.before hooks, then the tool, then
 * execute.after. Report-only state is the real registry and the capability restricts through it.
 */
async function fixture(t, script, { capability = 'verified', quota = goodQuota, usage, noProtocol = false, interruptFails = false, rebuild } = {}) {
  // `rebuild` is a previous fixture: the same project directory and durable files, with a brand new plugin, supervisor, registry, gate and runner (a restarted host).
  const directory = rebuild ? rebuild.directory : await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-repair-'));
  if (!rebuild) t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, '.heimdall');
  if (!rebuild) {
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, 'feature.md'), 'Synthetic feature');
    await fs.writeFile(path.join(root, 'planner.md'), 'Planner contract');
    await fs.writeFile(path.join(root, 'executor.md'), 'Executor contract');
    await fs.writeFile(path.join(directory, '.heimdall.toml'), '[workflow]\nplannerModel = "anthropic/test-planner"\nexecutorModel = "anthropic/test-executor"\nexecutorFallbackModel = "openai/test-fallback"\n');
  }
  const stateRoot = path.join(root, 'state');
  const local = createLocalSubmissionStore(stateRoot);
  // `crashed` models a dead process: every later save is silently lost. `onSave` can hold or fail a save before it lands.
  const control = { crashed: false, saveFails: false, interruptFails, onSave: undefined };
  const saves = [], dispatches = [], interrupts = [];
  const prompts = new Map(), origins = new Map();
  let children = 0;
  const stateFile = path.join(stateRoot, 'runs', RUN, 'state.json');
  const persistence = {
    load: async () => local.load(RUN),
    save: async state => {
      if (control.crashed) return;
      await control.onSave?.(state);
      if (control.saveFails) throw new Error('fenced: stale owner');
      saves.push(structuredClone(state));
      await fs.writeFile(stateFile + '.tmp', JSON.stringify(state));
      await fs.rename(stateFile + '.tmp', stateFile);
    },
    bindStart: async () => {},
    readReceipt: async () => null,
    writeReceipt: async () => {},
    readSubmission: (...args) => local.readSubmission(...args),
    writeSubmission: (...args) => local.writeSubmission(...args),
    readNativeOutcome: (...args) => local.readNativeOutcome(...args),
    writeNativeOutcome: (...args) => local.writeNativeOutcome(...args),
  };
  const gate = createDurableSubmissionGate({
    runId: RUN, directory, planRoot: '.heimdall/plans', origin: native => origins.get(native.messageID),
    persistence: { load: persistence.load, readSubmission: local.readSubmission, writeSubmission: persistence.writeSubmission },
  });
  const reportOnly = createReportOnlyRegistry();
  const supervisor = createSubmissionSupervisor();
  const tools = new Map(), hooks = new Map();
  const configuration = await loadConfiguration({ projectDirectory: directory });
  const ctx = {
    location: { directory }, integration: {},
    tool: { transform: async apply => { apply({ add: value => { tools.set(value.name, value); } }); return registration(); }, hook: async (name, cb) => { hooks.set('tool.' + name, cb); return registration(); } },
    session: { context: async () => [], hook: async (name, cb) => { hooks.set('session.' + name, cb); return registration(); } },
    rpc: { register: async () => registration() },
    permission: { hook: async (name, cb) => { hooks.set('permission.' + name, cb); return registration(); } },
  };
  const plugin = createPlugin({ configuration, reportOnly, supervisor, submissionGate: gate, observe: async () => assert.fail('no observation') });
  const cleanup = await plugin.setup(ctx);
  t.after(cleanup);
  const checks = [];
  const reportOnlyCapability = capability === 'none' ? undefined : {
    check: async model => { checks.push(model); return capability === 'verified' ? { supported: true } : { supported: false, reason: 'not verified for this provider' }; },
    restrict: async (child, owner, options) => {
      const release = reportOnly.restrict(child, owner && { ...owner, child }, options);
      return async () => { release(); };
    },
    releaseRetained: async ({ child, parent, runId, attemptIds }) => { for (const attemptId of attemptIds) reportOnly.releaseOwned({ parent, child, attemptId, runId }); },
  };
  const backend = {
    ...(reportOnlyCapability ? { reportOnly: reportOnlyCapability } : {}),
    assertIdle: async () => {},
    recoverResponse: async () => SPOKEN,
    observeDispatchPrompt: async ({ attemptId }) => prompts.get(attemptId),
    usage: usage ?? (async () => ({ used: 0, uncached: 0 })),
    interrupt: async () => { interrupts.push('interrupt'); if (control.interruptFails) throw new Error('Could not confirm child termination'); },
    runSubagent: async (input, context) => {
      const child = input.child ?? 'ses_child_' + ++children;
      await input.onStarted(child);
      const attemptId = /Workflow attempt: (\S+)/.exec(input.prompt)[1];
      const promptId = 'prompt_' + (dispatches.length + 1);
      const dispatch = { n: dispatches.length + 1, attemptId, child, promptId, agent: input.agent, prompt: input.prompt };
      dispatches.push(dispatch);
      prompts.set(attemptId, promptId);
      origins.set('msg_' + promptId, promptId);
      if (!noProtocol) await until(async () => (await local.load(RUN))?.submissionBinding?.prompt === promptId, context.signal, 'the recorded dispatch prompt');
      const step = script.shift();
      assert.ok(step, 'unscripted dispatch ' + dispatch.n);
      let calls = 0;
      /** One model tool call through the simulated host. `framework: true` makes input validation fail before any hook. */
      const call = async (tool, value, { framework = false, parallel = false } = {}) => {
        const meta = { sessionID: child, agent: input.agent, messageID: 'msg_' + promptId, id: 'call_' + dispatch.n + '_' + ++calls };
        const event = { tool, ...meta, input: value };
        let outcome;
        if (!framework) {
          try {
            await hooks.get('tool.execute.before')(event);
            const impl = tools.get(tool);
            outcome = { status: 'completed', result: impl ? await impl.execute(value, { ...meta, signal: new AbortController().signal, progress: async () => {} }) : { output: { ran: tool } } };
          } catch (error) { outcome = { status: 'error', error }; }
        } else outcome = { status: 'error', error: new Error('framework input validation failed') };
        await hooks.get('tool.execute.after')({ tool, ...meta, input: value, ...outcome });
        if (outcome.status === 'error') throw outcome.error;
        return outcome.result.output;
      };
      const visible = async names => {
        const event = { sessionID: child, agent: input.agent, tools: Object.fromEntries(names.map(name => [name, {}])) };
        await hooks.get('session.context')(event);
        return Object.keys(event.tools);
      };
      const submitTool = input.agent === settings.plannerAgent ? PLAN_TOOL : RESULT_TOOL;
      return step({ dispatch, call, visible, submitTool, child, input, meta: { sessionID: child, agent: input.agent } });
    },
  };
  let runs = 0;
  const build = options => createRunner({
    directory, backend, settings, quota, persistence, workflowRoot: '.heimdall/state', planRoot: '.heimdall/plans',
    plannerPromptPath: '.heimdall/planner.md', executorPromptPath: '.heimdall/executor.md', git: args => args[0] === 'branch' ? 'heimdall/run\n' : '', supervisor, ...options,
  });
  const run = build(noProtocol ? {} : { protocol: 'structured-v1' });
  return {
    directory, local, saves, dispatches, interrupts, reportOnly, supervisor, hooks, tools, control, checks, gate,
    state: () => local.load(RUN),
    start: () => run({ action: 'start', runId: RUN, adr: '.heimdall/feature.md' }, caller(++runs)).then(JSON.parse),
    resume: (input = 'Resolved') => run({ action: 'resume', runId: RUN, input }, caller(++runs)).then(JSON.parse),
    plansDirectory: path.join(directory, '.heimdall/plans/adr-' + RUN),
  };
}

const speaks = text => async () => text;
const submitOk = (payload, tool) => async ({ call, submitTool }) => {
  const response = await call(tool ?? submitTool, payload);
  assert.equal(response.accepted, true, JSON.stringify(response));
  return SPOKEN;
};

// --- Registry: one exact allowance --------------------------------------------------------------------------

test('a restriction keeps at most the one exact tool id; any restriction without an allowance keeps everything denied', () => {
  const registry = createReportOnlyRegistry();
  for (const name of ['execute.before', 'context', 'permission.evaluate']) registry.setHook(name, true);
  assert.equal(registry.permits('c', RESULT_TOOL), false, 'an unrestricted session is not "permitted": it simply is not restricted');
  const release = registry.restrict('c', { parent: 'p', child: 'c', attemptId: 'a', runId: 'r' }, { allow: RESULT_TOOL });
  assert.equal(registry.has('c'), true);
  assert.equal(registry.permits('c', RESULT_TOOL), true);
  for (const name of [PLAN_TOOL, 'edit', 'write', 'shell', 'bash', 'subagent', 'task', 'mcp__srv__x', 'code_mode.edit', 'foo__' + RESULT_TOOL, RESULT_TOOL + '_2', RESULT_TOOL.toUpperCase(), ' ' + RESULT_TOOL, '', 'x.' + RESULT_TOOL, 'x/' + RESULT_TOOL, 'x:' + RESULT_TOOL]) {
    assert.equal(registry.permits('c', name), false, JSON.stringify(name));
  }
  assert.equal(registry.permits('other', RESULT_TOOL), false);
  // A second restriction with no allowance (the legacy report-only correction) overrides the allowance.
  const full = registry.restrict('c', { parent: 'p', child: 'c', attemptId: 'b', runId: 'r' });
  assert.equal(registry.permits('c', RESULT_TOOL), false);
  full();
  assert.equal(registry.permits('c', RESULT_TOOL), true);
  assert.throws(() => registry.restrict('c', undefined, { allow: '' }), /one exact tool id/);
  release();
  assert.equal(registry.has('c'), false);
  assert.equal(registry.permits('c', RESULT_TOOL), false);
  // Owner-matched release removes exactly the owned restriction.
  registry.restrict('c', { parent: 'p', child: 'c', attemptId: 'a', runId: 'r' }, { allow: RESULT_TOOL });
  assert.equal(registry.releaseOwned({ parent: 'p', child: 'c', attemptId: 'zzz', runId: 'r' }), 0);
  assert.equal(registry.has('c'), true);
  assert.equal(registry.releaseOwned({ parent: 'p', child: 'c', attemptId: 'a', runId: 'r' }), 1);
  assert.equal(registry.has('c'), false);
});

// --- Reporting-only boundary through the real hooks -------------------------------------------------------------

test('the restricted boundary denies edit, write, shell, tests, git, delegation, MCP, code-mode and lookalikes, and lifts after the dispatch', async t => {
  let boundary;
  const f = await fixture(t, [
    submitOk(plan('T1')),
    async ({ call, visible, submitTool, meta }) => {
      assert.equal((await call(submitTool, malformed())).repairable, true);
      const all = ['edit', 'write', 'shell', 'bash', 'test', 'git', 'subagent', 'task', 'mcp__srv__edit', 'code_mode.edit', 'adr_workflow', 'foo__' + RESULT_TOOL, RESULT_TOOL + '_2', PLAN_TOOL, RESULT_TOOL];
      boundary = { visible: await visible(all), denied: {} };
      for (const name of all) {
        if (name === RESULT_TOOL) continue;
        try { await call(name, { command: 'x' }); boundary.denied[name] = 'ran'; }
        catch (error) { boundary.denied[name] = error.message; }
      }
      const evaluate = action => { const event = { sessionID: meta.sessionID, agent: meta.agent, action, resources: [], effect: 'ask' }; f.hooks.get('permission.evaluate')(event); return event.effect; };
      boundary.permissions = Object.fromEntries(['edit', 'bash', 'external_directory', RESULT_TOOL, 'foo__' + RESULT_TOOL].map(action => [action, evaluate(action)]));
      assert.equal((await call(submitTool, completed())).accepted, true);
      return SPOKEN;
    },
  ]);
  assert.equal((await f.start()).status, 'completed');
  assert.deepEqual(boundary.visible, [RESULT_TOOL]);
  for (const [name, message] of Object.entries(boundary.denied)) {
    assert.notEqual(message, 'ran', name + ' ran under the restriction');
    assert.ok(message === REPAIR_ONLY_DENIAL || /submission denied/.test(message), name + ': ' + message);
  }
  assert.equal(boundary.denied.edit, REPAIR_ONLY_DENIAL);
  assert.equal(boundary.denied['foo__' + RESULT_TOOL] === REPAIR_ONLY_DENIAL, true, 'a lookalike is denied by the restriction before it is even identified');
  assert.deepEqual(boundary.permissions, { edit: 'deny', bash: 'deny', external_directory: 'deny', [RESULT_TOOL]: 'ask', ['foo__' + RESULT_TOOL]: 'deny' });
  // The restriction ends with the dispatch: nothing stays restricted.
  assert.equal(f.reportOnly.has('ses_child_2'), false);
  assert.equal((await f.state()).submissionRepair, undefined, 'real advancement removes the repair record');
});

// --- Bounded repair: counter, durability and exhaustion ---------------------------------------------------------

test('the initial submission plus two repairs are allowed, each saved before its feedback, and the third repairable failure pauses', async t => {
  const seen = [];
  const f = await fixture(t, [
    submitOk(plan('T1')),
    async ({ call, submitTool }) => {
      for (let i = 1; i <= 3; i++) {
        const response = await call(submitTool, malformed());
        seen.push({ i, response, saved: (await f.state()).submissionRepair?.repairs, restricted: f.reportOnly.has('ses_child_2') });
      }
      return SPOKEN;
    },
  ]);
  const result = await f.start();
  assert.equal(MAX_SUBMISSION_REPAIRS, 2);
  assert.equal(result.status, 'paused');
  assert.equal(seen[0].response.repairsRemaining, 1);
  assert.equal(seen[1].response.repairsRemaining, 0);
  assert.deepEqual(seen.slice(0, 2).map(entry => entry.saved), [1, 2], 'the counter is durable before each feedback is returned');
  assert.ok(seen.slice(0, 2).every(entry => entry.restricted), 'restricted before feedback');
  assert.equal(seen[2].response.repairable, false);
  assert.match(seen[2].response.message, /no repair is available/);
  assert.match(result.reason, /more often than the bounded repair allows/);
  const state = await f.state();
  assert.equal(state.status, 'paused');
  assert.equal(state.submissionRepair.repairs, 2);
  assert.equal(state.submissionRepair.refused.code, 'exhausted');
  assert.equal(state.reportRecovery.diagnostic.code, 'submission_repair_exhausted');
  assert.equal(f.dispatches.length, 2, 'exhaustion never reruns anything');
  assert.deepEqual(f.interrupts, ['interrupt']);
  assert.equal(f.reportOnly.has('ses_child_2'), false, 'released after confirmed termination');
  // The late/refused attempt can no longer submit.
  const late = await f.gate.submit('executor-result', completed(), { sessionID: 'ses_child_2', agent: 'adr-executor', messageID: 'msg_prompt_2', id: 'late' });
  assert.equal(late.code, 'unauthorized');
  assert.equal(submissionRepairInfo(state.submissionRepair).code, 'submission_repair_exhausted');
});

test('the third attempt is accepted after two repairs and advancement removes the counter', async t => {
  const f = await fixture(t, [submitOk(plan('T1')), async ({ call, submitTool }) => {
    assert.equal((await call(submitTool, malformed())).repairsRemaining, 1);
    assert.equal((await call(submitTool, {})).repairsRemaining, 0);
    assert.equal((await call(submitTool, completed())).accepted, true);
    return SPOKEN;
  }]);
  assert.equal((await f.start()).status, 'completed');
  const state = await f.state();
  assert.equal(state.results.length, 1);
  assert.equal(state.submissionRepair, undefined);
  assert.ok(f.saves.some(s => s.submissionRepair?.repairs === 2));
});

test('the counter survives a crash and an explicit resume: repairs never reset, so the resumed dispatch has what is left', async t => {
  let second;
  const f = await fixture(t, [
    submitOk(plan('T1')),
    async ({ call, submitTool }) => { assert.equal((await call(submitTool, malformed())).repairsRemaining, 1); throw new Error('simulated crash of the child dispatch'); },
    async ({ call, submitTool }) => {
      second = await call(submitTool, malformed());
      return SPOKEN;
    },
  ]);
  const first = await f.start();
  assert.equal(first.status, 'paused');
  let state = await f.state();
  assert.equal(state.submissionRepair.repairs, 1, 'persisted in the pause checkpoint');
  const resumed = await f.resume('Fix the payload');
  assert.equal(resumed.status, 'paused');
  state = await f.state();
  assert.equal(state.submissionRepair.repairs, 2, 'the resumed dispatch continued from 1, not 0');
  assert.equal(second.repairsRemaining, 0);
  assert.equal(f.dispatches.length, 3);
});

test('exhausted counters stay exhausted across a resume: the next malformed call is refused immediately', async t => {
  let refusal;
  const f = await fixture(t, [
    submitOk(plan('T1')),
    async ({ call, submitTool }) => { await call(submitTool, malformed()); await call(submitTool, malformed()); return SPOKEN; },
    async ({ call, submitTool }) => { refusal = await call(submitTool, malformed()); return SPOKEN; },
  ]);
  assert.equal((await f.start()).status, 'paused');
  assert.equal((await f.state()).submissionRepair.repairs, 2);
  const resumed = await f.resume('Try again');
  assert.equal(resumed.status, 'paused');
  assert.equal(refusal.repairable, false);
  assert.equal((await f.state()).submissionRepair.repairs, 2);
  assert.equal(f.dispatches.length, 3, 'one dispatch per explicit resume and no automatic rerun');
});

test('a call the framework rejected before any Heimdall code ran spends a repair, once', async t => {
  const f = await fixture(t, [submitOk(plan('T1')), async ({ call, submitTool }) => {
    await assert.rejects(call(submitTool, 'not an object', { framework: true }), /framework input validation/);
    assert.equal((await f.state()).submissionRepair.repairs, 1, 'counted and saved before the model sees the framework error');
    assert.equal(f.reportOnly.has('ses_child_2'), true);
    await assert.rejects(call(submitTool, 7, { framework: true }), /framework input validation/);
    assert.equal((await f.state()).submissionRepair.repairs, 2);
    assert.equal((await call(submitTool, completed())).accepted, true);
    return SPOKEN;
  }]);
  assert.equal((await f.start()).status, 'completed');
});

test('denied or unauthorized submission calls are not format failures and spend no repair', async t => {
  const f = await fixture(t, [submitOk(plan('T1')), async ({ call, submitTool, child, input }) => {
    // The wrong tool for this kind: denied by the gate, never counted.
    await assert.rejects(call(submitTool === RESULT_TOOL ? PLAN_TOOL : RESULT_TOOL, completed()), /submission denied/);
    assert.equal((await f.state()).submissionRepair, undefined);
    assert.equal(f.reportOnly.has(child), false);
    assert.equal((await call(submitTool, completed())).accepted, true);
    return SPOKEN;
  }]);
  assert.equal((await f.start()).status, 'completed');
});

// --- Planner repair ------------------------------------------------------------------------------------------

test('planner repair is inline typed content: filesystem writes stay disabled and the whole plan is accepted', async t => {
  let writeDenied;
  const f = await fixture(t, [
    async ({ call, submitTool }) => {
      // Artifacts were never written, so the artifact submission cannot be read.
      const bad = await call(submitTool, { status: 'planned', artifacts: true });
      assert.equal(bad.accepted, false);
      assert.equal(bad.repairable, true);
      assert.match(bad.message, /file writes are disabled/);
      assert.match(bad.message, /inline/);
      try { await call('write', { path: path.join(f.plansDirectory, 'plan.md') }); writeDenied = 'ran'; } catch (error) { writeDenied = error.message; }
      await assert.rejects(fs.stat(f.plansDirectory), /ENOENT/, 'nothing was written');
      assert.equal((await call(submitTool, plan('T1'))).accepted, true);
      return SPOKEN;
    },
    submitOk(completed()),
  ]);
  assert.equal((await f.start()).status, 'completed');
  assert.equal(writeDenied, REPAIR_ONLY_DENIAL);
});

// --- Unverifiable enforcement, quota and accounting -----------------------------------------------------------

for (const capability of ['none', 'unsupported']) {
  test(`unverifiable report-only enforcement (${capability}) pauses precisely with no feedback, no restriction and no repair spent`, async t => {
    let response;
    const f = await fixture(t, [submitOk(plan('T1')), async ({ call, submitTool }) => { response = await call(submitTool, malformed()); return SPOKEN; }], { capability });
    const result = await f.start();
    assert.equal(result.status, 'paused');
    assert.match(result.reason, /report-only repair cannot be enforced/);
    assert.equal(response.repairable, false);
    assert.equal(f.reportOnly.has('ses_child_2'), false, 'nothing was restricted');
    const state = await f.state();
    assert.equal(state.submissionRepair.repairs, 0);
    assert.equal(state.submissionRepair.refused.code, 'unsupported');
    assert.equal(state.reportRecovery.diagnostic.code, 'submission_unsupported');
    assert.equal(f.dispatches.length, 2);
  });
}

test('quota and token guards still run for a repair, a refusal spends nothing, and the repair does not reset accounting', async t => {
  let quotaOk = true;
  let used = 10;
  let response;
  const f = await fixture(t, [submitOk(plan('T1')), async ({ call, submitTool }) => {
    quotaOk = false;
    response = await call(submitTool, malformed());
    return SPOKEN;
  }], { quota: async (...args) => quotaOk ? goodQuota(...args) : { anthropic: { fetchedAt: Date.now(), errors: ['quota unavailable'], entries: [] } }, usage: async () => ({ used, uncached: used }) });
  const result = await f.start();
  assert.equal(result.status, 'paused');
  assert.equal(response.repairable, false);
  assert.match(result.reason, /Quota|quota|unavailable/);
  const state = await f.state();
  assert.equal(state.submissionRepair.repairs, 0, 'a refused repair consumes no repair');
  assert.equal(f.reportOnly.has('ses_child_2'), false);
  assert.equal(state.usage.ses_child_2, 10, 'usage accounting is untouched');
  assert.equal(state.reportRecovery.diagnostic.code, 'auth_or_quota');
});

test('the usage guard that runs before every tool also runs before a submission call', async t => {
  let guarded = 0;
  const f = await fixture(t, [submitOk(plan('T1')), async ({ call, submitTool, child }) => {
    assert.equal((await call(submitTool, malformed())).repairsRemaining, 1);
    await call(submitTool, completed());
    return SPOKEN;
  }], { usage: async () => { guarded++; return { used: 1, uncached: 1 }; } });
  assert.equal((await f.start()).status, 'completed');
  assert.ok(guarded >= 4);
});

test('an unconfirmed termination keeps the repair restriction until a later resume proves the child idle and releases exactly it', async t => {
  const f = await fixture(t, [
    submitOk(plan('T1')),
    async ({ call, submitTool }) => { await call(submitTool, malformed()); await call(submitTool, malformed()); await call(submitTool, malformed()); return SPOKEN; },
    submitOk(completed()),
  ], { interruptFails: true });
  const result = await f.start();
  assert.equal(result.status, 'paused');
  assert.match(result.reason, /Could not confirm child termination/);
  assert.equal(f.reportOnly.has('ses_child_2'), true, 'fail closed: still restricted');
  const state = await f.state();
  assert.deepEqual(state.submissionRepair.attempts.length, 1, 'the owner identity is persisted so a later invocation can release it');
  f.control.interruptFails = false;
  assert.equal((await f.resume('Child stopped')).status, 'completed');
  assert.equal(f.reportOnly.has('ses_child_2'), false, 'released by owner after fresh idle proof, before the new dispatch');
});

// --- Conflicting implementation work ------------------------------------------------------------------------

test('an implementation call running in parallel with the accepted submission invalidates admission', async t => {
  const f = await fixture(t, [submitOk(plan('T1')), async ({ call, submitTool, child, meta }) => {
    // An edit starts and has not finished when the submission is accepted.
    void f.supervisor.begin(child, 'call_edit_1', 'edit');
    assert.equal((await call(submitTool, completed())).accepted, true);
    return SPOKEN;
  }, submitOk(completed())]);
  const result = await f.start();
  assert.equal(result.status, 'paused');
  assert.match(result.reason, /ran alongside or after the accepted submission/);
  let state = await f.state();
  assert.equal(state.results.length, 0, 'not advanced');
  assert.equal(state.reportRecovery.diagnostic.code, 'conflicting_work');
  assert.equal(state.submissionRepair.conflict.kind, 'parallel');
  assert.equal(state.submissionRepair.conflict.tool, 'edit');
  assert.equal(checkpointReportInfo(state).code, 'conflicting_work');
  // An explicit resume dispatches a fresh attempt; the receipt of the conflicting attempt is never admitted.
  const resumed = await f.resume('Redo it');
  assert.equal(resumed.status, 'completed');
  assert.equal(f.dispatches.length, 3);
  state = await f.state();
  assert.equal(state.results.length, 1);
});

test('an implementation call that starts after the accepted submission also invalidates admission', async t => {
  const f = await fixture(t, [submitOk(plan('T1')), async ({ call, submitTool }) => {
    assert.equal((await call(submitTool, completed())).accepted, true);
    // The sealed boundary denies it outright: the call never runs, and the refused attempt is still recorded as a conflict.
    await assert.rejects(call('edit', { path: 'x' }), error => error.message === SEALED_DENIAL);
    return SPOKEN;
  }]);
  const result = await f.start();
  assert.equal(result.status, 'paused');
  assert.match(result.reason, /ran alongside or after the accepted submission/);
  const state = await f.state();
  assert.equal(state.results.length, 0);
  assert.equal(state.submissionRepair.conflict.kind, 'later');
});

test('a conflict recorded durably blocks admission of the saved receipt on a later resume too', async t => {
  const f = await fixture(t, [submitOk(plan('T1')), async ({ call, submitTool, child }) => {
    void f.supervisor.begin(child, 'call_edit_1', 'edit');
    assert.equal((await call(submitTool, completed())).accepted, true);
    // The conflict is already durable when the receipt is acknowledged: a crash right here loses nothing.
    const durable = await f.state();
    assert.equal(durable.submissionRepair.conflict.kind, 'parallel');
    assert.equal(durable.submissionRepair.sealed.attemptId, durable.attempt.id);
    assert.ok(await f.local.readSubmission(RUN, durable.attempt.id, 'executor-result'), 'the conflicted receipt exists');
    throw new Error('simulated crash after the conflicting submission');
  }, submitOk(completed())]);
  assert.equal((await f.start()).status, 'paused');
  assert.equal((await f.state()).submissionRepair.conflict.attemptId.length > 0, true);
  const resumed = await f.resume('Redo');
  assert.equal(resumed.status, 'completed');
  assert.equal(f.dispatches.length, 3, 'a fresh attempt ran instead of admitting the conflicting receipt');
});

// --- Negative outcomes take precedence over format repair ---------------------------------------------------------

const unfinishedEvidence = (extra = {}) => ({ gateId: 'G1', passed: false, detail: 'the check failed', ...extra });
const explicitNegatives = [
  ['an unpassed gate with the handoff omitted', { status: 'completed', summary: 'Done', evidence: [unfinishedEvidence()] }, 'unfinished_work', ['G1'], ['handoff'], /Unfinished work for T1: gates G1/],
  ['an unpassed gate with its detail missing', { status: 'completed', summary: 'Done', handoff: 'H', evidence: [{ gateId: 'G1', passed: false }] }, 'unfinished_work', ['G1'], ['detail'], /Unfinished work for T1/],
  ['an unpassed gate beside an out-of-range gate id', { status: 'completed', summary: 'Done', handoff: 'H', evidence: [unfinishedEvidence(), { gateId: 'G9', passed: true, detail: 'y' }] }, 'unfinished_work', ['G1'], ['gateId'], /Unfinished work for T1/],
  ['an unpassed gate with an invalid gate id and an unknown field', { status: 'completed', summary: 'Done', handoff: 'H', extra: 1, evidence: [unfinishedEvidence({ gateId: 'one' })] }, 'unfinished_work', [], ['gateId'], /Unfinished work for T1/],
  ['blocked without a reason', { status: 'blocked' }, 'agent_blocked', [], ['reason'], /the agent reported blocked: Agent blocked without a reason/],
  ['blocked with a blank reason and an unknown field', { status: 'blocked', reason: '  ', note: 1 }, 'agent_blocked', [], ['reason'], /Agent blocked without a reason/],
  ['blocked with its reason and an unknown field', { status: 'blocked', reason: 'Need the owner credentials', extra: 1 }, 'agent_blocked', [], [], /the agent reported blocked: Need the owner credentials/],
];

for (const [name, payload, code, gateIds, fields, reason] of explicitNegatives) {
  test(`${name} is recorded as the outcome and never offered for repair`, async t => {
    const answers = [];
    const f = await fixture(t, [submitOk(plan('T1')), async ({ call, submitTool }) => {
      answers.push(await call(submitTool, payload));
      // The attempt accepts nothing further, not even a valid result.
      await assert.rejects(call(submitTool, completed()), /submission denied/);
      return SPOKEN;
    }, submitOk(completed())]);
    const result = await f.start();
    assert.equal(result.status, 'paused');
    assert.match(result.reason, reason);
    assert.equal(answers[0].accepted, false);
    assert.equal(answers[0].code, 'negative');
    assert.equal(answers[0].repairable, false);
    assert.equal('repairsRemaining' in answers[0], false, 'no repair feedback');
    assert.match(answers[0].message, /No repair is offered/);
    const state = await f.state();
    assert.equal(state.status, 'paused');
    assert.equal(state.results.length, 0, 'nothing advanced');
    assert.equal(state.submissionRepair.repairs, 0, 'no repair was consumed');
    assert.equal(state.submissionRepair.negative.outcome, code === 'agent_blocked' ? 'blocked' : 'unfinished');
    assert.equal(state.reportRecovery.diagnostic.code, code);
    assert.deepEqual(f.checks, [], 'repair enforcement was never needed');
    assert.equal(f.reportOnly.has('ses_child_2'), false);
    assert.equal(f.dispatches.length, 2, 'no automatic rerun');
    assert.equal(await f.local.readSubmission(RUN, state.attempt.id, 'executor-result') ?? null, null, 'no receipt, so nothing could be admitted');
    const info = checkpointReportInfo(state);
    assert.equal(info.code, code);
    assert.equal(info.mode, 'paused');
    assert.deepEqual(info.gateIds, gateIds);
    assert.deepEqual(info.missingFields, fields, 'field diagnostics are preserved');
    assert.doesNotMatch(JSON.stringify(info), /check failed|credentials/, 'the projection carries names and ids only');
  });
}

test('an explicit negative outcome is followed by an owner resume that dispatches a fresh attempt and starts clean', async t => {
  const f = await fixture(t, [submitOk(plan('T1')), async ({ call, submitTool }) => {
    await call(submitTool, { status: 'completed', summary: 'Done', evidence: [unfinishedEvidence()] });
    return SPOKEN;
  }, submitOk(completed())]);
  assert.equal((await f.start()).status, 'paused');
  const paused = await f.state();
  assert.equal(paused.submissionRepair.negative.attemptId, paused.attempt.id);
  assert.equal((await f.resume('Fixed it')).status, 'completed');
  assert.equal(f.dispatches.length, 3);
  assert.equal((await f.state()).results.length, 1);
});

test('a blocked planner payload without a reason is recorded, never repaired and writes nothing', async t => {
  const answers = [];
  const f = await fixture(t, [async ({ call, submitTool }) => { answers.push(await call(submitTool, { status: 'blocked' })); return SPOKEN; }]);
  const result = await f.start();
  assert.equal(result.status, 'paused');
  assert.match(result.reason, /Agent blocked without a reason/);
  assert.equal(answers[0].code, 'negative');
  assert.equal(answers[0].repairable, false);
  const state = await f.state();
  assert.equal(state.phase, 'planner');
  assert.equal(state.submissionRepair.repairs, 0);
  assert.equal(state.submissionRepair.negative.outcome, 'blocked');
  assert.equal(f.dispatches.length, 1);
  assert.deepEqual(f.checks, []);
});

test('a negative outcome after a consumed repair keeps that count and still pauses with the real reason', async t => {
  const answers = [];
  const f = await fixture(t, [submitOk(plan('T1')), async ({ call, submitTool }) => {
    answers.push(await call(submitTool, malformed()));
    answers.push(await call(submitTool, { status: 'completed', summary: 'Done', evidence: [unfinishedEvidence()] }));
    return SPOKEN;
  }]);
  const result = await f.start();
  assert.equal(result.status, 'paused');
  assert.equal(answers[0].repairsRemaining, 1);
  assert.equal(answers[1].code, 'negative');
  assert.equal('repairsRemaining' in answers[1], false);
  assert.match(result.reason, /Unfinished work for T1: gates G1/);
  const state = await f.state();
  assert.equal(state.submissionRepair.repairs, 1, 'the negative outcome neither consumed nor reset a repair');
  assert.equal(checkpointReportInfo(state).code, 'unfinished_work');
  assert.equal(f.reportOnly.has('ses_child_2'), false, 'the restriction ends with the stopped dispatch');
  assert.equal(f.dispatches.length, 2);
});

test('a format-only failure with no explicit negative outcome is still repairable', async t => {
  const f = await fixture(t, [submitOk(plan('T1')), async ({ call, submitTool }) => {
    const first = await call(submitTool, { status: 'completed', summary: 'Done', evidence: [{ gateId: 'G1', passed: true }] });
    assert.equal(first.repairable, true);
    assert.equal(first.code, 'format');
    assert.equal((await call(submitTool, completed())).accepted, true);
    return SPOKEN;
  }]);
  assert.equal((await f.start()).status, 'completed');
});

test('negativeSignal reads only explicit outcomes and carries field names, never submitted text', () => {
  const rule = { kind: 'executor-result', dodCount: 2 };
  const errors = [{ path: '$.handoff', code: 'missing_field', message: 'x' }, { path: '$.evidence[0].detail', code: 'missing_field', message: 'x' }, { path: '$.secret', code: 'unknown_field', message: 'x' }, { path: '$.runId', code: 'identity_field', message: 'x' }];
  assert.deepEqual(negativeSignal(rule, { status: 'completed', evidence: [{ gateId: 'G2', passed: false }, { gateId: 'G1', passed: false }, { gateId: 'G3', passed: false }, { gateId: 'bad', passed: false }] }, errors),
    { outcome: 'unfinished', gateIds: ['G1', 'G2'], fields: ['handoff', 'detail'] });
  assert.equal(negativeSignal(rule, { status: 'completed', evidence: [{ gateId: 'G1', passed: 'false' }, { gateId: 'G2', passed: 0 }, { gateId: 'G3' }] }, errors), undefined, 'only an explicit boolean false counts');
  assert.equal(negativeSignal(rule, 'status: blocked', errors), undefined);
  assert.equal(negativeSignal(rule, { status: 'completed', evidence: 'passed:false' }, errors), undefined);
  assert.deepEqual(negativeSignal({ kind: 'planner-plan', limit: 3 }, { status: 'blocked', reason: 'Owner needed', evidence: [{ passed: false }] }, []), { outcome: 'blocked', gateIds: [], reason: 'Owner needed', fields: [] });
  assert.equal(negativeSignal({ kind: 'planner-plan', limit: 3 }, { status: 'planned', evidence: [{ passed: false }] }, []), undefined, 'a plan has no gates to leave unpassed');
  assert.equal(negativeSignal(rule, { status: 'blocked', reason: { text: 'x' } }, [])?.reason, undefined);
});

// --- Durable conflict boundary ------------------------------------------------------------------------------

test('the reporting boundary is saved before the receipt exists, and a call meeting it while the receipt is persisted is denied', async t => {
  const seen = {};
  const f = await fixture(t, [submitOk(plan('T1')), async ({ call, submitTool, child }) => {
    const original = f.local.writeSubmission;
    f.local.writeSubmission = async (...args) => {
      const durable = (await f.state()).submissionRepair;
      seen.sealedBeforeReceipt = durable?.sealed?.attemptId;
      seen.conflictBeforeReceipt = durable?.conflict;
      // An implementation call that tries to start while the receipt is being persisted meets the sealed boundary.
      seen.admittedDuringWrite = await f.supervisor.begin(child, 'call_edit_window', 'edit');
      return original(...args);
    };
    seen.response = await call(submitTool, completed());
    f.local.writeSubmission = original;
    return SPOKEN;
  }]);
  const result = await f.start();
  assert.equal(seen.response.accepted, true);
  assert.equal(seen.sealedBeforeReceipt, f.dispatches[1].attemptId);
  assert.equal(seen.conflictBeforeReceipt, undefined, 'nothing was running when the boundary was sealed');
  assert.equal(seen.admittedDuringWrite, false);
  assert.equal(result.status, 'paused', 'the refused call invalidates admission instead of silently changing evidence');
  assert.match(result.reason, /ran alongside or after the accepted submission/);
  const state = await f.state();
  assert.equal(state.submissionRepair.conflict.kind, 'later');
  assert.equal(state.results.length, 0);
});

test('work still running when the boundary is sealed is saved as a conflict before the receipt is written', async t => {
  const seen = {};
  const f = await fixture(t, [submitOk(plan('T1')), async ({ call, submitTool, child }) => {
    assert.equal(await f.supervisor.begin(child, 'call_edit_running', 'edit'), true);
    const original = f.local.writeSubmission;
    f.local.writeSubmission = async (...args) => { seen.beforeReceipt = (await f.state()).submissionRepair; return original(...args); };
    await call(submitTool, completed());
    f.local.writeSubmission = original;
    return SPOKEN;
  }]);
  assert.equal((await f.start()).status, 'paused');
  assert.equal(seen.beforeReceipt.sealed.attemptId, f.dispatches[1].attemptId);
  assert.deepEqual(seen.beforeReceipt.conflict, { attemptId: f.dispatches[1].attemptId, kind: 'parallel', tool: 'edit' });
});

test('work that began before the submission and ended while it was processed still conflicts', async t => {
  const f = await fixture(t, [submitOk(plan('T1')), async ({ call, submitTool, child }) => {
    await f.supervisor.begin(child, 'call_edit_short', 'edit');
    const original = f.local.writeSubmission;
    f.local.writeSubmission = async (...args) => { f.supervisor.finished(child, 'call_edit_short'); return original(...args); };
    await call(submitTool, completed());
    f.local.writeSubmission = original;
    return SPOKEN;
  }]);
  const result = await f.start();
  assert.equal(result.status, 'paused');
  assert.equal((await f.state()).submissionRepair.conflict.kind, 'parallel');
});

test('a boundary that cannot be saved fails closed: nothing is acknowledged and later work is denied', async t => {
  const seen = {};
  const f = await fixture(t, [submitOk(plan('T1')), async ({ call, submitTool }) => {
    f.control.saveFails = true;
    seen.error = await call(submitTool, completed()).then(() => undefined, error => error);
    seen.edit = await call('edit', {}).then(() => 'ran', error => error.message);
    return SPOKEN;
  }]);
  await assert.rejects(f.start(), /fenced: stale owner/);
  f.control.saveFails = false;
  assert.match(seen.error.message, /fenced: stale owner/);
  assert.equal(seen.edit, SEALED_DENIAL);
  assert.equal(await f.local.readSubmission(RUN, f.dispatches[1].attemptId, 'executor-result') ?? null, null, 'no receipt was written for an unsaved boundary');
});

test('persisted sealed state denies new implementation work when no process-local timeline survives, and only for that attempt', async t => {
  let sealed;
  const f = await fixture(t, [submitOk(plan('T1')), async ({ call, submitTool }) => {
    assert.equal((await call(submitTool, completed())).accepted, true);
    sealed = await f.state();
    return SPOKEN;
  }]);
  assert.equal((await f.start()).status, 'completed');
  assert.equal(f.supervisor.tracked('ses_child_2'), false, 'the dispatch ended and its timeline is gone');
  const stateFile = path.join(f.directory, '.heimdall/state/runs', RUN, 'state.json');
  const late = { tool: 'edit', sessionID: 'ses_child_2', agent: 'adr-executor', messageID: 'msg_late', id: 'call_late', input: {} };
  // The checkpoint as a crashed or reloaded host would find it: running, with the attempt sealed.
  await fs.writeFile(stateFile, JSON.stringify(sealed));
  await assert.rejects(f.hooks.get('tool.execute.before')(late), error => error.message === SEALED_DENIAL);
  // A different (fresh) attempt is not sealed.
  await fs.writeFile(stateFile, JSON.stringify({ ...sealed, attempt: { ...sealed.attempt, id: 'attempt-fresh' } }));
  await f.hooks.get('tool.execute.before')(late);
  // An unreadable checkpoint cannot prove the boundary is open.
  await fs.writeFile(stateFile, '{ not json');
  await assert.rejects(f.hooks.get('tool.execute.before')(late), error => error.message === SEALED_DENIAL);
  // A planner or executor session of another role agent never reaches the durable check.
  await fs.writeFile(stateFile, JSON.stringify(sealed));
  await f.hooks.get('tool.execute.before')({ ...late, agent: 'adr-orchestrator' });
});

// --- Legacy and projection ----------------------------------------------------------------------------------

test('a legacy unversioned run never registers a repair handler and keeps the prose path', async t => {
  let registered = 0;
  const f = await fixture(t, [async ({ input }) => JSON.stringify({ status: 'planned', planMarkdown: '# Plan', factSheet: 'Facts', tasks: [task('T1')] })], { noProtocol: true });
  const original = f.supervisor.register;
  f.supervisor.register = (...args) => { registered++; return original(...args); };
  const result = await f.start();
  assert.equal(registered, 0);
  assert.equal(result.status, 'paused');
  const state = await f.state();
  assert.equal(state.protocol, undefined);
  assert.equal(state.submissionRepair, undefined);
  assert.equal(state.tasks.length, 1, 'the prose plan was admitted by the legacy path');
});

test('projection renders both the legacy report record and the structured repair record, allowlisted', () => {
  assert.equal(checkpointReportInfo(null), null);
  assert.equal(checkpointReportInfo({}), null);
  const legacy = checkpointReportInfo({ reportRecovery: { mode: 'paused', corrections: 2, diagnostic: { code: 'correction_exhausted', missingFields: ['summary', 'secret'] } } });
  assert.equal(legacy.kind, undefined);
  assert.equal(legacy.corrections, 2);
  assert.deepEqual(legacy.missingFields, ['summary']);
  const idle = checkpointReportInfo({ submissionRepair: { phase: 'executor', index: 0, repairs: 0, attempts: [] } });
  assert.deepEqual(idle, { kind: 'submission', mode: 'idle', corrections: 0, limit: 2, code: null, missingFields: [], gateIds: [] });
  const using = checkpointReportInfo({ submissionRepair: { phase: 'planner', index: 0, repairs: 99, attempts: ['a'], refused: { attemptId: 'a', code: 'exhausted', reason: 'secret reply text' } } });
  assert.equal(using.mode, 'paused');
  assert.equal(using.corrections, 2, 'clamped');
  assert.equal(using.code, 'submission_repair_exhausted');
  assert.doesNotMatch(JSON.stringify(using), /secret/);
  assert.equal(checkpointReportInfo({ submissionRepair: { phase: 'executor', index: 0, repairs: 1, attempts: [], conflict: { attemptId: 'a', kind: 'later', tool: 'edit' } } }).code, 'conflicting_work');
  assert.equal(checkpointReportInfo({ submissionRepair: { phase: 'bogus' }, reportRecovery: { mode: 'idle', corrections: 1 } }).corrections, 1, 'an invalid repair record falls back to the legacy record');
  assert.equal(submissionRepairInfo('nope'), null);
});

// --- Hook details: REPORT_ONLY_DENIAL stays the message of an unallowed (legacy) restriction ---------------------

test('a restriction without an allowance still denies every call with the legacy message and empties the tool list', async t => {
  const f = await fixture(t, []);
  f.reportOnly.restrict('legacy-child');
  await assert.rejects(f.hooks.get('tool.execute.before')({ tool: RESULT_TOOL, sessionID: 'legacy-child', agent: 'adr-executor', messageID: 'm', id: 'c' }), error => error.message === REPORT_ONLY_DENIAL);
  const event = { sessionID: 'legacy-child', agent: 'adr-executor', tools: { [RESULT_TOOL]: {}, edit: {} } };
  await f.hooks.get('session.context')(event);
  assert.deepEqual(event.tools, {});
});

// --- Concurrent submissions: the durable reporting state stays coherent and monotonic -----------------------------
//
// Pinned OpenCode executes the tool calls of one streamed assistant message concurrently, so a malformed call that is
// still awaiting its quota check can overlap a valid submission that seals the boundary. These tests run that race
// through the real plugin hooks, gate, supervisor and runner.

const settled = promise => promise.then(value => ({ value }), error => ({ error }));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MARKERS = ['sealed', 'conflict', 'negative', 'refused'];

/** One quota callback whose next call blocks until released (optionally then failing), to hold a repair's quota check. */
function heldQuota({ failOnRelease = false } = {}) {
  let armed = false, enter, free;
  const entered = new Promise(resolve => { enter = resolve; });
  const released = new Promise(resolve => { free = resolve; });
  return {
    arm: () => { armed = true; },
    entered,
    release: () => free(),
    quota: async (...args) => {
      if (armed) { armed = false; enter(); await released; if (failOnRelease) return { anthropic: { fetchedAt: Date.now(), errors: ['quota unavailable'], entries: [] } }; }
      return goodQuota(...args);
    },
  };
}

/** Every checkpoint written for a task keeps what the previous one held for its active attempt: markers stay, the counter never drops. */
function assertMonotonic(saves) {
  let previous;
  for (const [i, save] of saves.entries()) {
    const before = previous?.submissionRepair;
    if (before && previous.phase === save.phase && previous.index === save.index) {
      const after = save.submissionRepair;
      assert.ok(after, `save ${i} dropped the repair record`);
      assert.ok(after.repairs >= before.repairs, `save ${i} lowered the repair counter ${before.repairs} -> ${after.repairs}`);
      const active = save.attempt && save.attempt.status !== 'rejected' ? save.attempt.id : undefined;
      for (const marker of MARKERS) if (active && before[marker]?.attemptId === active) assert.ok(after[marker], `save ${i} dropped the ${marker} marker`);
    }
    previous = save;
  }
}

/**
 * A malformed call holds at its quota check. Meanwhile one synthetic implementation call is still running when a valid
 * submission is accepted: the boundary seals with a parallel conflict. The quota check is then released. `crash` makes
 * every later save vanish (the host died), so only what was durable at the race point survives.
 */
async function conflictedSealRace(t, { crash = false } = {}) {
  const q = heldQuota();
  const seen = {};
  const f = await fixture(t, [submitOk(plan('T1')), async ({ call, submitTool, child }) => {
    q.arm();
    const repairing = settled(call(submitTool, malformed()));
    await q.entered;
    assert.equal(await f.supervisor.begin(child, 'synthetic_parallel_edit', 'edit'), true);
    seen.accepted = await call(submitTool, completed({ summary: 'Conflicted work' }));
    seen.sealed = await f.state();
    q.release();
    seen.repair = await repairing;
    seen.race = await f.state();
    seen.raceFile = await fs.readFile(path.join(f.directory, '.heimdall/state/runs', RUN, 'state.json'), 'utf8');
    if (crash) f.control.crashed = true;
    return SPOKEN;
  }], { quota: q.quota });
  seen.result = await f.start();
  return { f, seen };
}

test('a malformed call whose quota check is held cannot erase the seal and conflict of a valid submission accepted meanwhile', async t => {
  const { f, seen } = await conflictedSealRace(t);
  const attemptId = f.dispatches[1].attemptId;
  assert.equal(seen.accepted.accepted, true);
  assert.equal(seen.sealed.submissionRepair.sealed.attemptId, attemptId, 'the seal was durable before the receipt was acknowledged');
  assert.equal(seen.sealed.submissionRepair.conflict.kind, 'parallel');
  assert.notEqual(seen.repair.value?.repairable, true, 'no repair feedback after the boundary sealed');
  assert.equal(seen.race.submissionRepair.sealed?.attemptId, attemptId, 'the released repair check kept the durable seal');
  assert.equal(seen.race.submissionRepair.conflict?.attemptId, attemptId, 'and the durable conflict');
  assert.equal(seen.race.submissionRepair.repairs, 0, 'a repair that was never granted is not counted');
  assert.equal(seen.result.status, 'paused');
  assert.match(seen.result.reason, /ran alongside or after the accepted submission/);
  const state = await f.state();
  assert.equal(state.results.length, 0, 'the conflicted receipt was not advanced');
  assert.equal(state.submissionRepair.conflict.kind, 'parallel');
  assert.equal(state.reportRecovery.diagnostic.code, 'conflicting_work');
  assert.equal(f.dispatches.length, 2);
  assert.equal(f.reportOnly.has('ses_child_2'), false, 'no restriction stayed behind');
  assertMonotonic(f.saves);
});

test('crash at the race point (managed-style persistence): the rebuilt host reads the conflict, does not admit the receipt and dispatches fresh work', async t => {
  const { f, seen } = await conflictedSealRace(t, { crash: true });
  const attemptId = f.dispatches[1].attemptId;
  // The durable checkpoint is exactly what existed at the race point: no catch/finally save of the dying process landed.
  assert.equal(await fs.readFile(path.join(f.directory, '.heimdall/state/runs', RUN, 'state.json'), 'utf8'), seen.raceFile);
  const durable = JSON.parse(seen.raceFile);
  assert.equal(durable.submissionRepair.sealed?.attemptId, attemptId, 'the durable seal survived the delayed repair');
  assert.equal(durable.submissionRepair.conflict?.attemptId, attemptId, 'the durable conflict survived the delayed repair');
  assert.ok(await f.local.readSubmission(RUN, attemptId, 'executor-result'), 'the conflicted receipt is durable');
  assert.equal(durable.results.length, 0);
  // A brand new plugin/runner built from durable files only. The fresh dispatch submits nothing.
  const g = await fixture(t, [async () => SPOKEN], { rebuild: f });
  const resumed = await g.resume('Inspect after host restart');
  assert.equal(resumed.status, 'paused', 'the conflicted receipt is not admitted');
  assert.equal(g.dispatches.length, 1, 'a fresh attempt was dispatched instead of replaying the receipt');
  assert.notEqual(g.dispatches[0].attemptId, attemptId);
  const state = await g.state();
  assert.equal(state.results.length, 0, 'zero admitted results');
  assert.equal(state.reportRecovery.diagnostic.code, 'submission_missing');
});

test('crash at the race point, then the ordinary valid receipt of the fresh attempt advances exactly once', async t => {
  const { f, seen } = await conflictedSealRace(t, { crash: true });
  const conflicted = f.dispatches[1].attemptId;
  const g = await fixture(t, [submitOk(completed({ summary: 'Fresh work' }))], { rebuild: f });
  const resumed = await g.resume('Redo it');
  assert.equal(resumed.status, 'completed');
  assert.equal(g.dispatches.length, 1);
  const state = await g.state();
  assert.equal(state.results.length, 1, 'advanced exactly once');
  assert.equal(state.results[0].summary, 'Fresh work', 'from the fresh attempt, never from the conflicted receipt');
  assert.notEqual(state.attempt?.id, conflicted);
  assert.equal(state.submissionRepair, undefined);
  assert.equal(g.saves.filter(save => save.results.length === 1).length >= 1, true);
  assert.equal(JSON.parse(seen.raceFile).results.length, 0);
});

test('a crash after an unconflicted valid acknowledgement replays the receipt once, without a dispatch, and does not advance twice', async t => {
  const f = await fixture(t, [submitOk(plan('T1')), async ({ call, submitTool }) => {
    assert.equal((await call(submitTool, completed({ summary: 'Sealed work' }))).accepted, true);
    f.control.crashed = true;
    return SPOKEN;
  }]);
  await f.start();
  const g = await fixture(t, [], { rebuild: f });
  const resumed = await g.resume('Reconcile');
  assert.equal(resumed.status, 'completed');
  assert.equal(g.dispatches.length, 0);
  const state = await g.state();
  assert.equal(state.results.length, 1);
  assert.equal(state.results[0].summary, 'Sealed work');
});

for (const [name, payload, pattern] of [
  ['an unpassed gate with the handoff omitted', { status: 'completed', summary: 'Done', evidence: [unfinishedEvidence()] }, /Unfinished work for T1: gates G1/],
  ['a blocked report without its reason', { status: 'blocked' }, /Agent blocked without a reason/],
]) {
  test(`${name} racing a held repair is retained: no repair feedback after it and the pause reason is the real outcome`, async t => {
    const q = heldQuota();
    const seen = {};
    const f = await fixture(t, [submitOk(plan('T1')), async ({ call, submitTool, child }) => {
      q.arm();
      const repairing = settled(call(submitTool, malformed()));
      await q.entered;
      seen.negative = await call(submitTool, payload);
      seen.recorded = await f.state();
      q.release();
      seen.repair = await repairing;
      seen.race = await f.state();
      seen.restricted = f.reportOnly.has(child);
      return SPOKEN;
    }, submitOk(completed())], { quota: q.quota });
    const result = await f.start();
    const attemptId = f.dispatches[1].attemptId;
    assert.equal(seen.negative.code, 'negative');
    assert.equal(seen.recorded.submissionRepair.negative.attemptId, attemptId);
    assert.notEqual(seen.repair.value?.repairable, true, 'no repair feedback after the negative outcome');
    assert.equal(seen.race.submissionRepair.negative?.attemptId, attemptId, 'the negative outcome stayed durable');
    assert.equal(seen.race.submissionRepair.repairs, 0, 'no repair was granted or counted');
    assert.equal(seen.restricted, false, 'the implementation tools were not restricted for a repair that was never offered');
    assert.equal(result.status, 'paused');
    assert.match(result.reason, pattern);
    const state = await f.state();
    assert.equal(state.results.length, 0);
    assert.equal(state.submissionRepair.negative.attemptId, attemptId);
    assert.equal(f.dispatches.length, 2, 'no automatic rerun');
    assertMonotonic(f.saves);
  });
}

test('a refusal and a valid seal racing each other keep both markers, acknowledge only a durable seal and never advance', async t => {
  const q = heldQuota({ failOnRelease: true });
  const seen = {};
  const f = await fixture(t, [submitOk(plan('T1')), async ({ call, submitTool }) => {
    q.arm();
    const repairing = settled(call(submitTool, malformed()));
    await q.entered;
    seen.accepted = await call(submitTool, completed({ summary: 'Sealed work' }));
    seen.sealed = await f.state();
    seen.receipt = await f.local.readSubmission(RUN, f.dispatches[1].attemptId, 'executor-result');
    q.release();
    seen.repair = await repairing;
    seen.race = await f.state();
    return SPOKEN;
  }], { quota: q.quota });
  const result = await f.start();
  const attemptId = f.dispatches[1].attemptId;
  assert.equal(seen.accepted.accepted, true);
  assert.equal(seen.sealed.submissionRepair.sealed.attemptId, attemptId, 'acknowledged only after the seal was durable');
  assert.ok(seen.receipt);
  assert.notEqual(seen.repair.value?.repairable, true);
  assert.equal(seen.race.submissionRepair.sealed?.attemptId, attemptId);
  assert.equal(seen.race.submissionRepair.refused?.attemptId, attemptId);
  assert.equal(seen.race.submissionRepair.repairs, 0);
  assert.equal(result.status, 'paused');
  assert.match(result.reason, /Quota|quota/);
  assert.equal((await f.state()).results.length, 0, 'the refused dispatch did not advance');
  assert.equal(f.dispatches.length, 2);
  assertMonotonic(f.saves);
});

test('a repair save that fails while a seal lands keeps the seal and never lowers the durable counter, and nothing is acknowledged without a durable seal', async t => {
  const seen = {};
  let entered, failSave;
  const reached = new Promise(resolve => { entered = resolve; });
  const latch = new Promise(resolve => { failSave = resolve; });
  let failed = false;
  const f = await fixture(t, [submitOk(plan('T1')), async ({ call, submitTool }) => {
    // The save of the first granted repair is held and then fenced, while a valid submission is being accepted.
    f.control.onSave = async state => {
      if (failed || state.submissionRepair?.repairs !== 1 || state.submissionRepair.sealed) return;
      failed = true; entered(); await latch;
      throw new Error('fenced: stale owner');
    };
    const repairing = settled(call(submitTool, malformed()));
    await reached;
    const accepting = settled(call(submitTool, completed({ summary: 'Sealed work' })));
    await sleep(25);
    failSave();
    seen.repair = await repairing;
    seen.accepted = await accepting;
    seen.race = await f.state();
    seen.receipt = await f.local.readSubmission(RUN, f.dispatches[1].attemptId, 'executor-result');
    return SPOKEN;
  }]);
  const result = await f.start();
  const attemptId = f.dispatches[1].attemptId;
  assert.notEqual(seen.repair.value?.repairable, true, 'a repair whose save failed is never granted');
  if (seen.accepted.value?.accepted) {
    assert.equal(seen.race.submissionRepair.sealed?.attemptId, attemptId, 'an acknowledged receipt has a durable seal');
    assert.ok(seen.receipt);
  } else assert.equal(seen.receipt ?? null, null, 'a receipt that was not sealed durably was not written');
  assert.equal(seen.race.submissionRepair.sealed?.attemptId, attemptId, 'the seal landed while the repair save failed');
  assert.equal(result.status, 'paused');
  assert.equal((await f.state()).results.length, 0);
  assert.equal(f.dispatches.length, 2);
  assertMonotonic(f.saves);
});

test('several concurrent malformed calls never exceed the initial submission plus two repairs, with the first held at its quota check', async t => {
  const q = heldQuota();
  const seen = {};
  const f = await fixture(t, [submitOk(plan('T1')), async ({ call, submitTool }) => {
    q.arm();
    const first = settled(call(submitTool, malformed()));
    await q.entered;
    const rest = Array.from({ length: 4 }, () => settled(call(submitTool, malformed())));
    await sleep(25);
    q.release();
    seen.answers = [await first, ...(await Promise.all(rest))];
    seen.state = await f.state();
    return SPOKEN;
  }], { quota: q.quota });
  const result = await f.start();
  const granted = seen.answers.filter(answer => answer.value?.repairable === true);
  assert.equal(granted.length, MAX_SUBMISSION_REPAIRS, 'exactly the allowed repairs were granted');
  assert.equal(seen.state.submissionRepair.repairs, MAX_SUBMISSION_REPAIRS);
  assert.ok(f.saves.every(save => (save.submissionRepair?.repairs ?? 0) <= MAX_SUBMISSION_REPAIRS));
  assert.equal(seen.state.submissionRepair.refused.code, 'exhausted');
  assert.equal(result.status, 'paused');
  assert.equal(f.dispatches.length, 2);
  assertMonotonic(f.saves);
});

test('concurrent malformed calls queued behind a held check are granted nothing once a valid submission sealed the boundary', async t => {
  const q = heldQuota();
  const seen = {};
  const f = await fixture(t, [submitOk(plan('T1')), async ({ call, submitTool }) => {
    q.arm();
    const first = settled(call(submitTool, malformed()));
    await q.entered;
    const rest = Array.from({ length: 3 }, () => settled(call(submitTool, malformed())));
    seen.accepted = await call(submitTool, completed({ summary: 'Sealed work' }));
    q.release();
    seen.answers = [await first, ...(await Promise.all(rest))];
    seen.state = await f.state();
    return SPOKEN;
  }], { quota: q.quota });
  const result = await f.start();
  assert.equal(seen.accepted.accepted, true);
  assert.equal(seen.answers.filter(answer => answer.value?.repairable === true).length, 0, 'no repair after the seal');
  assert.equal(seen.state.submissionRepair.sealed.attemptId, f.dispatches[1].attemptId);
  assert.equal(seen.state.submissionRepair.repairs, 0);
  assert.equal(f.reportOnly.has('ses_child_2'), false);
  assert.equal(result.status, 'completed', 'the valid receipt of an undisturbed boundary advances');
  assert.equal((await f.state()).results.length, 1, 'exactly once');
  assertMonotonic(f.saves);
});

test('the seal completes while a repair quota check stays held: acknowledgement never waits behind it', async t => {
  const q = heldQuota();
  let acknowledged = false;
  const f = await fixture(t, [submitOk(plan('T1')), async ({ call, submitTool }) => {
    q.arm();
    const repairing = settled(call(submitTool, malformed()));
    await q.entered;
    const accepted = await call(submitTool, completed());
    acknowledged = accepted.accepted === true;
    // Only now is the quota check released: the acknowledgement above completed while it was still held.
    q.release();
    await repairing;
    return SPOKEN;
  }], { quota: q.quota });
  assert.equal((await f.start()).status, 'completed');
  assert.equal(acknowledged, true);
});

// --- The persistence layer refuses a stale checkpoint on its own ---------------------------------------------------

test('the standalone checkpoint file refuses a stale view that drops a marker or lowers the counter, and accepts every legitimate transition', async t => {
  const { writeCheckpointFile, repairRegression } = await import('../dist/workflow/repair-state.js');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-checkpoint-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json');
  const base = { id: 'r', phase: 'executor', index: 0, results: [], attempt: { id: 'a1', status: 'admitted' } };
  const record = extra => ({ phase: 'executor', index: 0, taskId: 'T1', child: 'c', repairs: 1, attempts: ['a1'], ...extra });
  const sealed = { ...base, submissionRepair: record({ sealed: { attemptId: 'a1' }, conflict: { attemptId: 'a1', kind: 'parallel', tool: 'edit' } }) };
  await writeCheckpointFile(file, { ...base, submissionRepair: record() });
  await writeCheckpointFile(file, sealed);
  const stale = { ...base, submissionRepair: record() };
  await assert.rejects(writeCheckpointFile(file, stale), /drop the (sealed|conflict) marker/);
  await assert.rejects(writeCheckpointFile(file, { ...base, submissionRepair: record({ sealed: sealed.submissionRepair.sealed, repairs: 0 }) }), /drop the conflict marker/);
  await assert.rejects(writeCheckpointFile(file, { ...base }), /drop the sealed marker/);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), sealed, 'the refused writes left the file untouched');
  assert.equal(repairRegression(sealed, { ...sealed, submissionRepair: record({ ...sealed.submissionRepair, repairs: 0 }) }), 'it would lower the repair counter from 1 to 0');
  // Legitimate transitions: a rejected attempt, a fresh attempt, and real advancement.
  assert.equal(repairRegression(sealed, { ...base, attempt: { id: 'a1', status: 'rejected' }, submissionRepair: record() }), undefined);
  assert.equal(repairRegression(sealed, { ...base, attempt: { id: 'a2', status: 'launching' }, submissionRepair: record() }), undefined);
  assert.equal(repairRegression(sealed, { ...base, index: 1, attempt: undefined }), undefined);
  assert.equal(repairRegression(sealed, { ...base, results: [{}], index: 1, attempt: undefined }), undefined);
  assert.equal(repairRegression(sealed, { ...sealed, submissionRepair: record({ ...sealed.submissionRepair, repairs: 2 }) }), undefined);
});
