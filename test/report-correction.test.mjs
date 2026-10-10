import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRunner, executorContract } from '../dist/workflow/runner.js';
import { createReportOnlyRegistry, REPORT_ONLY_DENIAL } from '../dist/opencode/report-only.js';
import { createNativeBackend } from '../dist/opencode/native-backend.js';

const allHooks = (registry = createReportOnlyRegistry()) => { for (const hook of ['execute.before', 'context', 'permission.evaluate']) registry.setHook(hook, true); return registry; };
/** Observed child session. Defaults to a terminal child of the fixture parent. */
const observed = (id, over = {}) => ({ session: { id, parentID: 'parent', tokens: { input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } }, outcome: 'succeeded', time: { idle: 10 }, ...(over.session ?? {}) }, active: false, inbox: [], permissions: [], forms: [], ...Object.fromEntries(Object.entries(over).filter(([key]) => key !== 'session')) });

const snapshot = (sonnet = 50, kimi = 40) => Object.fromEntries([['anthropic', sonnet], ['kimi', kimi]].map(([key, n]) => [key, { fetchedAt: Date.now(), entries: [{ name: '5h', percentRemaining: n }, { name: 'Weekly', percentRemaining: n }], errors: [] }]));
const task = { id: 'T2', title: 'Two', brief: 'Do two', dependsOn: [], dod: ['first gate', 'second gate', 'third gate'] };
const plan = { status: 'planned', planMarkdown: '# Plan', factSheet: 'Facts', tasks: [task] };
const entry = (n, extra = {}) => ({ gateId: 'G' + n, gate: task.dod[n - 1], passed: true, detail: 'proved ' + n, ...extra });
const good = (extra = {}) => ({ status: 'completed', taskId: 'T2', summary: 'Done', handoff: 'Next', evidence: [entry(1), entry(2), entry(3)], ...extra });
const noHandoff = () => good({ handoff: '' });
const missingG3 = () => good({ evidence: [entry(1), entry(2)] });
const nativeText = (text, info = {}) => ({ data: { info, parts: [{ type: 'text', text }] } });
const CORRECTION = /^Report-only correction (\d)\/2 for T2/;
const corrections = prompts => prompts.filter(p => CORRECTION.test(p.prompt));

const commonSettings = { plannerAgent: 'adr-planner', executorAgent: 'adr-executor', plannerModel: 'a/p', executorModel: 'a/e', executorFallbackModel: 'k/k3', timeoutMinutes: 1, maxTasks: 10, maxSessionTokens: 60000, maxRunTokens: 300000, minQuotaRemainingPercent: 10 };

/**
 * File-backed (default) or in-memory managed fixture. The fake backend tracks the report-only restriction,
 * asserts a single active child, and records every prompt with the restriction state at send time.
 */
async function fixture(t, responses, opts = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-correction-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const managed = !!opts.managed;
  const root = path.join(directory, managed ? '.heimdall' : '.opencode/adr-workflow');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(directory, 'ADR.md'), 'Spec');
  for (const name of ['planner', 'executor']) await fs.writeFile(path.join(root, name + '.md'), name);
  const settings = { ...commonSettings, ...(managed ? { tokenLimitsDisabled: true } : {}), ...(opts.settings ?? {}) };
  if (!managed) await fs.writeFile(path.join(root, 'settings.json'), JSON.stringify(settings));
  const events = [], prompts = [], tokens = { used: 0 }, controller = { current: new AbortController() };
  let n = 0, active = 0, restricted = 0;
  // `opts.native` runs the REAL native adapter and registry (`observe` supplies the child snapshot). `swapNative` recreates the adapter over a registry.
  let native;
  const makeNative = ({ registry, observe }) => ({ registry, observe, backend: createNativeBackend({ ctx: {}, observe: (...args) => native.observe(...args), reportOnly: registry, verifiedProviders: ['a', 'k'] }) });
  if (opts.native) native = makeNative(opts.native);
  const isRestricted = id => native ? native.registry.has(id) : restricted > 0;
  const fake = opts.reportOnly === false ? undefined : {
    check: async (model, child) => { events.push(['check', model, child]); return opts.check ? opts.check(model, child) : { supported: true }; },
    restrict: async (child, owner) => {
      if (opts.restrictError) throw opts.restrictError;
      restricted++; events.push(['restrict', child]);
      let done = false;
      const release = async () => { if (done) return; done = true; restricted--; events.push(['release', child]); };
      if (opts.registry) { const free = opts.registry.restrict(child, owner && { ...owner, child }); return async () => { free(); await release(); }; }
      return release;
    },
    // A new adapter holds no closure: it can only release through the shared registry owner entry.
    releaseRetained: async input => {
      events.push(['releaseRetained', input.child]);
      if (opts.releaseError) throw opts.releaseError;
      if (!opts.registry) return;
      for (const attemptId of input.attemptIds) restricted -= opts.registry.releaseOwned({ parent: input.parent, child: input.child, attemptId, runId: input.runId });
    },
  };
  const backend = {
    get reportOnly() { return native ? native.backend.reportOnly : fake; },
    assertIdle: async (id, ...rest) => { events.push(['idle', id]); await opts.onIdle?.(id); if (native) await native.backend.assertIdle(id, ...rest); },
    recoverResponse: async (...args) => { events.push(['recover', args[0]]); return opts.recover ? opts.recover(...args) : undefined; },
    usage: async () => ({ used: tokens.used, uncached: tokens.used }),
    interrupt: async child => { events.push(['interrupt', child]); if (opts.interruptError) throw opts.interruptError; },
    runSubagent: async (input, context) => {
      await opts.beforeStart?.(input);
      const id = input.child ?? 's' + ++n;
      await input.onStarted(id);
      assert.equal(active++, 0, 'only one active child prompt at a time');
      const sent = { child: id, prompt: input.prompt, title: input.title, agent: input.agent, model: input.model, variant: input.variant, restricted: isRestricted(id) };
      prompts.push(sent); events.push(['prompt', id, sent.restricted]);
      try {
        const r = responses.shift();
        if (typeof r === 'function') return await r(sent, input, context);
        if (r instanceof Error) throw r;
        return typeof r === 'string' || (r && r.data) ? r : JSON.stringify(r);
      } finally { active--; }
    },
  };
  let checkpoint = null, binding = null;
  const receipts = new Map();
  const store = { get checkpoint() { return checkpoint; }, receipts };
  const persistenceFor = owner => ({
    // Once an owner token is stale, every authoritative write is rejected, as the coordinator does.
    load: async () => structuredClone(checkpoint),
    save: async state => { if (owner.failSave?.(state)) owner.stale = true; if (owner.stale) throw new Error('Owner token is stale'); checkpoint = structuredClone(state); },
    bindStart: async value => { binding ??= structuredClone(value); },
    readReceipt: async (id, attempt) => structuredClone(receipts.get(attempt) ?? null),
    writeReceipt: async (id, receipt) => { if (owner.stale) throw new Error('Owner token is stale'); receipts.set(receipt.id, structuredClone(receipt)); },
  });
  const makeRunner = (owner = {}) => createRunner({
    backend, directory, settings: managed ? settings : undefined, quota: async () => opts.quota ? opts.quota() : snapshot(),
    git: a => a[0] === 'branch' ? 'main\n' : ' M existing.txt\n',
    ...(managed ? { persistence: persistenceFor(owner), workflowRoot: '.heimdall/state', planRoot: '.heimdall/plans', plannerPromptPath: '.heimdall/planner.md', executorPromptPath: '.heimdall/executor.md' } : {}),
  });
  const context = (signal = controller.current.signal) => ({ sessionID: 'parent', id: 'call_1', messageID: 'msg_1', agent: 'adr-orchestrator', abort: signal });
  const start = (run, signal) => run({ action: 'start', adr: 'ADR.md', ...(managed ? { runId: 'reserved' } : {}) }, context(signal));
  const resume = (run, runId, input = 'restate', signal) => run({ action: 'resume', runId, input }, context(signal));
  const runDir = id => path.join(root, managed ? 'state' : '', 'runs', id);
  const statePath = id => path.join(runDir(id), 'state.json');
  const readState = async id => managed ? structuredClone(checkpoint) : JSON.parse(await fs.readFile(statePath(id), 'utf8'));
  const writeState = async (id, state) => { if (managed) checkpoint = structuredClone(state); else await fs.writeFile(statePath(id), JSON.stringify(state)); };
  const attemptFiles = async id => managed ? [...receipts.keys()] : (await fs.readdir(runDir(id))).filter(name => /^attempt-.*\.json$/.test(name));
  return { directory, root, events, prompts, tokens, controller, run: makeRunner(), makeRunner, start, resume, readState, writeState, attemptFiles, runDir, store, active: () => restricted, swapNative: next => { native = makeNative({ observe: native.observe, ...next }); } };
}

test('a format-only completion error is corrected on the same child within the bound and advances exactly once', async t => {
  const f = await fixture(t, [plan, noHandoff(), good()]);
  const result = JSON.parse(await f.start(f.run));
  assert.equal(result.status, 'completed');
  assert.equal(f.prompts.length, 3, 'planner, task, one correction');
  const [, original, correction] = f.prompts;
  assert.equal(correction.child, original.child, 'the correction goes to the same child');
  assert.equal(correction.agent, original.agent);
  assert.equal(correction.model, original.model);
  assert.equal(correction.variant, original.variant);
  assert.equal(original.restricted, false);
  assert.equal(correction.restricted, true, 'the report-only restriction is active during dispatch');
  assert.ok(correction.prompt.endsWith(executorContract(task)), 'the contract footer is last');
  assert.match(correction.prompt, /^Report-only correction 1\/2 for T2/);
  assert.match(correction.prompt, /missing fields: handoff/);
  assert.match(correction.prompt, /\nWorkflow attempt: [0-9a-f-]{36}\n\n=== Executor completion contract/);
  assert.match(correction.prompt, /all tools are disabled/);
  assert.match(correction.title, /report correction 1\/2/);
  const state = await f.readState(result.runId);
  assert.equal(state.results.length, 1, 'advances exactly once');
  assert.equal(state.results[0].reportCorrections, 1);
  assert.equal(state.reportRecovery, undefined, 'the record is removed only by advancement');
  assert.equal(state.index, 1);
  assert.equal((await f.attemptFiles(result.runId)).length, 3, 'planner, rejected original and corrected receipts are all retained');
  assert.deepEqual(f.events.map(e => e[0]).filter(name => ['restrict', 'prompt', 'release'].includes(name)), ['prompt', 'prompt', 'restrict', 'prompt', 'release']);
  assert.equal(f.active(), 0, 'released after the correction');
  const originalId = /Workflow attempt: ([0-9a-f-]{36})/.exec(original.prompt)[1];
  const originalReceipt = JSON.parse(await fs.readFile(path.join(f.runDir(result.runId), 'attempt-' + originalId + '.json'), 'utf8'));
  assert.equal(JSON.parse(originalReceipt.response).handoff, '', 'the rejected original receipt is unchanged');
  const ledger = await fs.readFile(path.join(f.runDir(result.runId), 'ledger.md'), 'utf8');
  assert.equal(ledger.split('## T2').length - 1, 1);
});

test('a second format-only correction is allowed and the cap of two is never exceeded', async t => {
  const f = await fixture(t, [plan, noHandoff(), missingG3(), good()]);
  const result = JSON.parse(await f.start(f.run));
  assert.equal(result.status, 'completed');
  const sent = corrections(f.prompts);
  assert.deepEqual(sent.map(p => CORRECTION.exec(p.prompt)[1]), ['1', '2']);
  assert.match(sent[1].prompt, /missing gate entries: G3/);
  assert.deepEqual(new Set(f.prompts.slice(1).map(p => p.child)).size, 1, 'one child throughout');
  assert.equal((await f.readState(result.runId)).results[0].reportCorrections, 2);
});

const neverCases = [
  ['missing fields together with passed:false', () => good({ handoff: '', evidence: [entry(1), entry(2, { passed: false }), entry(3)] }), 'unfinished_work'],
  ['blocked', () => ({ status: 'blocked', taskId: 'T2', reason: 'Owner must attach the device' }), 'agent_blocked'],
  ['wrong identity', () => good({ taskId: 'T1', handoff: '' }), 'identity_mismatch'],
  ['prose only', () => 'all done, nothing else', 'ambiguous_output'],
  ['truncated output', () => nativeText('{"status":"comp', { finish: 'length' }), 'ambiguous_output'],
  ['duplicate gate ID', () => good({ evidence: [entry(1), entry(1), entry(3)] }), 'ambiguous_output'],
  ['native failure', () => new Error('connection reset by peer'), 'native_failure'],
  ['authentication failure', () => new Error('401 Unauthorized'), 'auth_or_quota'],
  ['quota failure', () => new Error('quota unavailable for this provider'), 'auth_or_quota'],
];
for (const [name, make, code] of neverCases) {
  test('never dispatches a correction: ' + name, async t => {
    const f = await fixture(t, [plan, make()]);
    const paused = JSON.parse(await f.start(f.run));
    assert.equal(paused.status, 'paused');
    assert.equal(f.prompts.length, 2, 'planner and task only');
    assert.deepEqual(f.events.filter(e => ['check', 'restrict'].includes(e[0])), [], 'not even eligible for a capability probe');
    const state = await f.readState(paused.runId);
    assert.equal(state.reportRecovery.diagnostic.code, code);
    assert.equal(state.reportRecovery.corrections, 0);
    assert.deepEqual(state.reportRecovery.attempts, []);
    assert.equal(state.attempt.purpose, undefined);
    assert.deepEqual(state.results, []);
  });
}

test('corrections that still miss a field or gate exhaust the durable cap of two and pause without advancing', async t => {
  const f = await fixture(t, [plan, noHandoff(), noHandoff(), missingG3(), noHandoff(), good()]);
  const paused = JSON.parse(await f.start(f.run));
  assert.equal(paused.status, 'paused');
  assert.equal(corrections(f.prompts).length, 2, 'exactly two corrections');
  assert.match(paused.reason, /^Invalid completion report for T2: automatic report correction is exhausted, still missing gate entries G3\./);
  const state = await f.readState(paused.runId);
  assert.equal(state.reportRecovery.diagnostic.code, 'correction_exhausted');
  assert.equal(state.reportRecovery.corrections, 2);
  assert.equal(state.reportRecovery.mode, 'paused');
  assert.equal(state.reportRecovery.attempts.length, 2);
  assert.deepEqual(state.results, []);
  assert.equal(state.index, 0);
  assert.equal(f.active(), 0);
  // A manual resume may reprompt the idle child with an explicit resolution, but the counter is never reset.
  const resumed = JSON.parse(await f.resume(f.run, paused.runId, 'restate the results'));
  assert.equal(resumed.status, 'paused');
  assert.equal(corrections(f.prompts).length, 2, 'no third automatic correction');
  assert.equal(f.prompts.length, 5, 'one explicit owner reprompt');
  const again = await f.readState(paused.runId);
  assert.equal(again.reportRecovery.corrections, 2, 'manual resume keeps the counter');
  assert.equal(again.reportRecovery.diagnostic.code, 'correction_exhausted');
  const done = JSON.parse(await f.resume(f.run, paused.runId, 'final'));
  assert.equal(done.status, 'completed');
  assert.equal(corrections(f.prompts).length, 2);
  const final = await f.readState(paused.runId);
  assert.equal(final.reportRecovery, undefined);
  assert.equal(final.results[0].reportCorrections, 2);
});

test('unsupported enforcement pauses correction_unsupported with format-only guidance and no dispatch', async t => {
  for (const [label, opts] of [
    ['unverified provider', { check: async () => ({ supported: false, reason: 'Report-only enforcement is not verified for provider "a"' }) }],
    ['capability check throws', { check: async () => { throw new Error('probe exploded'); } }],
    ['no capability', { reportOnly: false }],
    ['restriction cannot be taken', { restrictError: new Error('plugin hooks not registered (context)') }],
  ]) {
    const f = await fixture(t, [plan, noHandoff()], opts);
    const paused = JSON.parse(await f.start(f.run));
    assert.equal(paused.status, 'paused', label);
    assert.equal(f.prompts.length, 2, label + ': no dispatch');
    assert.match(paused.reason, /^Invalid completion report for T2: report-only correction is unsupported here \(.+\), still missing fields handoff\. Resume with guidance to restate the results that already exist/, label);
    const state = await f.readState(paused.runId);
    assert.equal(state.reportRecovery.diagnostic.code, 'correction_unsupported', label);
    assert.equal(state.reportRecovery.corrections, 0, label + ': a refusal consumes nothing');
    assert.deepEqual(state.results, [], label);
    assert.equal(f.active(), 0, label);
  }
});

test('the counter and correction attempt are persisted before dispatch', async t => {
  let seen;
  const f = await fixture(t, [plan, noHandoff(), good()], {
    beforeStart: async input => {
      if (!/report correction/.test(input.title)) return;
      const dir = path.join(f.root, 'runs');
      const [id] = await fs.readdir(dir);
      seen = JSON.parse(await fs.readFile(path.join(dir, id, 'state.json'), 'utf8'));
    },
  });
  const result = JSON.parse(await f.start(f.run));
  assert.equal(result.status, 'completed');
  assert.equal(seen.reportRecovery.corrections, 1);
  assert.equal(seen.reportRecovery.mode, 'correcting');
  assert.equal(seen.attempt.purpose, 'report-correction');
  assert.equal(seen.attempt.status, 'launching');
  assert.equal(seen.attempt.child, seen.child);
  assert.deepEqual(seen.reportRecovery.attempts, [seen.attempt.id]);
  assert.equal(f.prompts.at(-1).prompt.includes('Workflow attempt: ' + seen.attempt.id), true);
});

/** Pauses a run after correction 1 was persisted but its reply never arrived, then returns the saved state. */
async function crashedAfterPersist(t, opts = {}) {
  const f = await fixture(t, [plan, noHandoff(), new Error('connection reset by peer'), good()], opts);
  const paused = JSON.parse(await f.start(f.run));
  assert.equal(paused.status, 'paused');
  const state = await f.readState(paused.runId);
  assert.equal(state.attempt.purpose, 'report-correction');
  assert.equal(state.reportRecovery.corrections, 1);
  // A real crash leaves the attempt launching with the recorded child and no receipt.
  state.attempt.status = 'launching';
  state.status = 'running';
  state.reportRecovery.mode = 'correcting';
  await f.writeState(paused.runId, state);
  return { f, opts, runId: paused.runId, promptsBefore: f.prompts.length };
}

test('restart after persist-before-dispatch pauses correction_ambiguous without a duplicate prompt', async t => {
  const { f, runId, promptsBefore } = await crashedAfterPersist(t);
  const again = JSON.parse(await f.resume(f.run, runId, 'continue'));
  assert.equal(again.status, 'paused');
  assert.match(again.reason, /^Invalid completion report for T2: a previous correction may already have run, so none is repeated automatically\./);
  assert.equal(f.prompts.length, promptsBefore, 'nothing was sent');
  assert.deepEqual(f.events.filter(e => e[0] === 'recover').length, 1);
  const state = await f.readState(runId);
  assert.equal(state.reportRecovery.diagnostic.code, 'correction_ambiguous');
  assert.equal(state.reportRecovery.corrections, 1, 'the counter is not reset');
  assert.equal(state.reportRecovery.mode, 'paused');
  assert.deepEqual(state.results, []);
  assert.equal(f.active(), 0);
  // Only a further explicit owner resume may reprompt the idle child, and the counter still stands.
  const final = JSON.parse(await f.resume(f.run, runId, 'owner reviewed the child'));
  assert.equal(final.status, 'completed');
  assert.equal((await f.readState(runId)).results[0].reportCorrections, 1);
});

test('restart where the admission cannot be bound (recovery throws) pauses correction_ambiguous', async t => {
  const { f, runId, promptsBefore } = await crashedAfterPersist(t, { recover: async () => { throw new Error('cannot bind the attempt'); } });
  const again = JSON.parse(await f.resume(f.run, runId, 'continue'));
  assert.equal(again.status, 'paused');
  assert.equal(f.prompts.length, promptsBefore);
  assert.equal((await f.readState(runId)).reportRecovery.diagnostic.code, 'correction_ambiguous');
});

test('restart with a recoverable correction reply applies it without re-dispatch', async t => {
  const { f, runId, promptsBefore } = await crashedAfterPersist(t, { recover: async (child, parent, attempt) => (assert.equal(attempt.purpose, 'report-correction'), JSON.stringify(good())) });
  const done = JSON.parse(await f.resume(f.run, runId, 'continue'));
  assert.equal(done.status, 'completed');
  assert.equal(f.prompts.length, promptsBefore, 'no re-dispatch');
  const state = await f.readState(runId);
  assert.equal(state.results.length, 1);
  assert.equal(state.results[0].reportCorrections, 1);
  assert.equal(state.reportRecovery, undefined);
});

test('a recovered correction reply that is still format-only continues within the durable cap', async t => {
  const { f, runId, promptsBefore } = await crashedAfterPersist(t, { recover: async () => JSON.stringify(missingG3()) });
  const done = JSON.parse(await f.resume(f.run, runId, 'continue'));
  assert.equal(done.status, 'completed');
  assert.equal(f.prompts.length, promptsBefore + 1);
  assert.match(f.prompts.at(-1).prompt, /^Report-only correction 2\/2 for T2/);
  assert.equal(f.prompts.at(-1).restricted, true);
  assert.equal((await f.readState(runId)).results[0].reportCorrections, 2);
});

test('a busy child on resume dispatches nothing', async t => {
  const { f, opts, runId, promptsBefore } = await crashedAfterPersist(t);
  opts.onIdle = async () => { throw new Error('Child session is still running'); };
  await assert.rejects(f.resume(f.run, runId, 'go'), /still running/);
  assert.equal(f.prompts.length, promptsBefore);
  assert.equal((await f.readState(runId)).reportRecovery.corrections, 1);
});

test('cancellation during a correction interrupts, releases the restriction after termination and keeps the counter', async t => {
  const f = await fixture(t, [plan, noHandoff(), (sent, input, context) => new Promise((_, reject) => {
    context.signal.addEventListener('abort', () => reject(new Error('Native child was interrupted')), { once: true });
    f.controller.current.abort(new Error('owner cancelled'));
  }), good()]);
  const paused = JSON.parse(await f.start(f.run));
  assert.equal(paused.status, 'paused');
  const order = f.events.map(e => e[0]).filter(name => ['restrict', 'prompt', 'interrupt', 'release'].includes(name));
  assert.deepEqual(order, ['prompt', 'prompt', 'restrict', 'prompt', 'interrupt', 'release']);
  const state = await f.readState(paused.runId);
  assert.equal(state.reportRecovery.corrections, 1);
  assert.equal(state.reportRecovery.mode, 'paused');
  assert.deepEqual(state.results, []);
  assert.equal(f.prompts.length, 3, 'no further prompt');
  assert.equal(f.active(), 0);
});

test('an unconfirmed interrupt keeps the restriction in force', async t => {
  const f = await fixture(t, [plan, noHandoff(), (sent, input, context) => new Promise((_, reject) => {
    context.signal.addEventListener('abort', () => reject(new Error('Native child was interrupted')), { once: true });
    f.controller.current.abort(new Error('owner cancelled'));
  })], { interruptError: new Error('Could not confirm child termination') });
  const paused = JSON.parse(await f.start(f.run));
  assert.equal(paused.status, 'paused');
  assert.match(paused.reason, /Could not confirm child termination/);
  assert.equal(f.events.some(e => e[0] === 'release'), false, 'not released without confirmed termination');
  assert.equal(f.active(), 1);
  assert.equal((await f.readState(paused.runId)).reportRecovery.corrections, 1);
});

test('budget exhaustion before a correction pauses without consuming it or dispatching', async t => {
  const f = await fixture(t, [plan, noHandoff(), good()], { onIdle: () => { f.tokens.used = 60000; } });
  const paused = JSON.parse(await f.start(f.run));
  assert.equal(paused.status, 'paused');
  assert.match(paused.reason, /Token budget reached/);
  assert.equal(f.prompts.length, 2);
  assert.equal(f.events.some(e => e[0] === 'restrict'), false);
  const state = await f.readState(paused.runId);
  assert.equal(state.reportRecovery.corrections, 0);
  assert.equal(state.reportRecovery.mode, 'paused');
});

test('quota unavailable or below policy for the selected model pauses auth_or_quota without switching provider', async t => {
  for (const [label, quota] of [
    ['unavailable', (() => { let calls = 0; return () => ++calls >= 3 ? {} : snapshot(); })()],
    ['below the reserve while the fallback is healthy', (() => { let calls = 0; return () => ++calls >= 3 ? snapshot(5, 90) : snapshot(60, 10); })()],
  ]) {
    const f = await fixture(t, [plan, noHandoff(), good()], { quota });
    const paused = JSON.parse(await f.start(f.run));
    assert.equal(paused.status, 'paused', label);
    assert.match(paused.reason, /^Quota unavailable for the selected model a\/e; no report correction was sent/, label);
    assert.equal(f.prompts.length, 2, label);
    const state = await f.readState(paused.runId);
    assert.equal(state.reportRecovery.diagnostic.code, 'auth_or_quota', label);
    assert.equal(state.reportRecovery.corrections, 0, label);
  }
});

test('owner rotation keeps the counter; a stale owner never persists, dispatches or resets anything', async t => {
  const f = await fixture(t, [plan, noHandoff(), missingG3(), good()], { managed: true });
  const stale = { failSave: state => state.reportRecovery?.corrections === 2 };
  const first = f.makeRunner(stale);
  await assert.rejects(f.start(first), /Owner token is stale/);
  assert.equal(corrections(f.prompts).length, 1, 'the stale owner dispatched nothing for correction 2');
  assert.equal(f.store.checkpoint.reportRecovery.corrections, 1, 'the durable counter is unchanged by the failed save');
  assert.equal(f.active(), 0, 'the restriction was released');
  // A new managed adapter (rotated owner token) resumes from the authoritative checkpoint.
  const rotated = f.makeRunner({});
  const done = JSON.parse(await f.resume(rotated, 'reserved', 'continue'));
  assert.equal(done.status, 'completed');
  assert.deepEqual(corrections(f.prompts).map(p => CORRECTION.exec(p.prompt)[1]), ['1', '2'], 'the counter carried over: the next correction is the second');
  assert.equal(f.store.checkpoint.results[0].reportCorrections, 2);
  assert.equal(new Set(f.prompts.slice(1).map(p => p.child)).size, 1);
  assert.equal(f.store.receipts.size, 4);
});

test('a stale owner at the first correction save dispatches nothing and the rotated owner corrects once', async t => {
  const f = await fixture(t, [plan, noHandoff(), good()], { managed: true });
  const stale = { failSave: state => state.reportRecovery?.mode === 'correcting' };
  await assert.rejects(f.start(f.makeRunner(stale)), /Owner token is stale/);
  assert.equal(corrections(f.prompts).length, 0);
  assert.equal(f.store.checkpoint.reportRecovery, undefined);
  assert.equal(f.active(), 0);
  const done = JSON.parse(await f.resume(f.makeRunner({}), 'reserved', 'continue'));
  assert.equal(done.status, 'completed');
  assert.equal(corrections(f.prompts).length, 1);
  assert.equal(f.store.checkpoint.results[0].reportCorrections, 1);
});

test('report-only restriction holds during every correction and implementation files and HEAD are unchanged', async t => {
  const registry = createReportOnlyRegistry();
  for (const hook of ['execute.before', 'context', 'permission.evaluate']) registry.setHook(hook, true);
  const gitIn = (dir, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' });
  const denials = [];
  let headAfterWork;
  const f = await fixture(t, [plan, async sent => {
    // The unrestricted executor does the real work and commits it, then returns an incomplete report.
    await fs.writeFile(path.join(f.directory, 'impl.txt'), 'v1');
    gitIn(f.directory, 'add', 'impl.txt');
    gitIn(f.directory, 'commit', '-m', 'work');
    headAfterWork = gitIn(f.directory, 'rev-parse', 'HEAD').trim();
    assert.equal(registry.has(sent.child), false);
    return JSON.stringify(noHandoff());
  }, async sent => {
    assert.equal(registry.has(sent.child), true, 'restricted while the correction runs');
    const guarded = fn => async () => { if (registry.has(sent.child)) throw new Error(REPORT_ONLY_DENIAL); return fn(); };
    for (const attempt of [
      guarded(() => fs.writeFile(path.join(f.directory, 'impl.txt'), 'v2')),
      guarded(() => gitIn(f.directory, 'commit', '--allow-empty', '-m', 'sneaky')),
      guarded(() => fs.writeFile(path.join(f.directory, 'new.txt'), 'new')),
    ]) await assert.rejects(attempt(), error => (denials.push(error.message), error.message === REPORT_ONLY_DENIAL));
    return JSON.stringify(good());
  }], { registry });
  gitIn(f.directory, 'init', '-q', '-b', 'main');
  const result = JSON.parse(await f.start(f.run));
  assert.equal(result.status, 'completed');
  assert.equal(denials.length, 3);
  assert.equal(gitIn(f.directory, 'rev-parse', 'HEAD').trim(), headAfterWork, 'HEAD unchanged across the correction');
  assert.equal(await fs.readFile(path.join(f.directory, 'impl.txt'), 'utf8'), 'v1');
  await assert.rejects(fs.access(path.join(f.directory, 'new.txt')), { code: 'ENOENT' });
  assert.equal(gitIn(f.directory, 'status', '--porcelain', '--', 'impl.txt').trim(), '');
  assert.equal(registry.has(f.prompts[2].child), false, 'released after the correction');
  const state = await f.readState(result.runId);
  assert.equal(state.results[0].reportCorrections, 1, 'runner-owned checkpoint and receipts updated');
  assert.equal((await f.attemptFiles(result.runId)).length, 3);
});

test('regression: a restriction held after an unconfirmed interrupt is released by a NEW invocation once idle is confirmed, without a plugin restart', async t => {
  const registry = allHooks();
  const opts = { registry, interruptError: new Error('Could not confirm child termination') };
  const f = await fixture(t, [plan, noHandoff(), new Error('connection reset by peer'), good()], opts);
  const paused = JSON.parse(await f.start(f.makeRunner()));
  assert.equal(paused.status, 'paused');
  const child = paused.childSession;
  assert.equal(registry.has(child), true, 'the interrupt was unconfirmed: the restriction stays in force');
  assert.equal(f.active(), 1);
  opts.interruptError = undefined; // The child is now observably idle.
  const ambiguous = JSON.parse(await f.resume(f.makeRunner(), paused.runId, 'I confirmed the child is now idle'));
  assert.equal(ambiguous.status, 'paused');
  assert.equal((await f.readState(paused.runId)).reportRecovery.diagnostic.code, 'correction_ambiguous');
  const done = JSON.parse(await f.resume(f.makeRunner(), paused.runId, 'I inspected the output, continue'));
  assert.equal(done.status, 'completed');
  assert.equal(registry.has(child), false, 'the restriction must be released once idle is confirmed');
  assert.equal(f.active(), 0);
  assert.equal(f.prompts.at(-1).restricted, false, 'the resumed prompt is not restricted');
});

/**
 * Runs through the REAL native adapter and registry: a correction is dispatched, its prompt fails and the interrupt
 * cannot be confirmed, so the run pauses with the restriction still held. `view` drives what the child looks like next.
 */
async function pausedHolding(t, { responses = [plan, noHandoff(), new Error('connection reset by peer'), good()], registry = allHooks(), wrap, ...rest } = {}) {
  const view = { mode: 'idle', grace: 0 };
  const observe = async id => {
    if (view.grace > 0) { view.grace--; return observed(id); }
    if (view.mode === 'busy') return observed(id, { active: true });
    if (view.mode === 'unknown') return observed(id, { session: { outcome: undefined, time: {} } });
    if (view.mode === 'wrong-parent') return observed(id, { session: { parentID: 'someone-else' } });
    return observed(id);
  };
  const opts = { native: { registry: wrap ? wrap(registry) : registry, observe }, interruptError: new Error('Could not confirm child termination'), ...rest };
  const f = await fixture(t, responses, opts);
  const paused = JSON.parse(await f.start(f.makeRunner()));
  assert.equal(paused.status, 'paused');
  assert.equal(registry.count(paused.childSession), 1, 'the unconfirmed interrupt leaves exactly one restriction');
  opts.interruptError = undefined;
  return { f, registry, view, opts, child: paused.childSession, runId: paused.runId, promptsBefore: f.prompts.length };
}

test('a busy, unknown-outcome or wrong-parent child keeps the restriction and dispatches nothing', async t => {
  for (const [mode, message] of [['busy', /Session is active/], ['unknown', /no durable terminal outcome/], ['wrong-parent', /does not belong to this parent/]]) {
    const { f, registry, view, child, runId, promptsBefore } = await pausedHolding(t);
    view.mode = mode;
    await assert.rejects(f.resume(f.makeRunner(), runId, 'go'), message, mode);
    assert.equal(registry.count(child), 1, mode);
    assert.equal(f.prompts.length, promptsBefore, mode);
    view.mode = 'idle';
    const again = JSON.parse(await f.resume(f.makeRunner(), runId, 'go'));
    assert.equal(again.status, 'paused', mode);
    assert.equal(registry.count(child), 0, mode + ': released once idle is proven');
  }
});

test('idle is asserted again immediately before the release: a child that became busy keeps the restriction', async t => {
  const { f, registry, view, child, runId, promptsBefore } = await pausedHolding(t);
  view.mode = 'busy';
  view.grace = 1; // The resume gate passes; the proof taken right before the release does not.
  const paused = JSON.parse(await f.resume(f.makeRunner(), runId, 'go'));
  assert.equal(paused.status, 'paused');
  assert.match(paused.reason, /Session is active/);
  assert.equal(registry.count(child), 1);
  assert.equal(f.prompts.length, promptsBefore);
});

test('a failed release stays in force and pauses without dispatch; a later resume releases it', async t => {
  const fail = { on: true };
  const { f, registry, child, runId, promptsBefore } = await pausedHolding(t, { wrap: real => ({ ...real, releaseOwned: owner => { if (fail.on) throw new Error('release exploded'); return real.releaseOwned(owner); } }) });
  const first = JSON.parse(await f.resume(f.makeRunner(), runId, 'go'));
  assert.equal(first.status, 'paused');
  assert.match(first.reason, /release exploded/);
  assert.equal(registry.count(child), 1);
  assert.equal(f.prompts.length, promptsBefore);
  fail.on = false;
  const second = JSON.parse(await f.resume(f.makeRunner(), runId, 'go'));
  assert.equal(second.status, 'paused');
  assert.equal((await f.readState(runId)).reportRecovery.diagnostic.code, 'correction_ambiguous');
  assert.equal(registry.count(child), 0);
  assert.equal(f.prompts.length, promptsBefore, 'the retry released without dispatching');
  const third = JSON.parse(await f.resume(f.makeRunner(), runId, 'go'));
  assert.equal(third.status, 'completed');
  assert.equal(f.prompts.length, promptsBefore + 1);
  assert.equal(f.prompts.at(-1).restricted, false);
});

test('a stale owner cannot release; the rotated owner releases exactly once', async t => {
  const { f, registry, child, runId, promptsBefore } = await pausedHolding(t, { managed: true });
  const release = registry.releaseOwned;
  let calls = 0, removed = 0;
  registry.releaseOwned = owner => { calls++; const n = release(owner); removed += n; return n; };
  await assert.rejects(f.resume(f.makeRunner({ stale: true }), runId, 'go'), /Owner token is stale/);
  assert.equal(registry.count(child), 1, 'the fenced save failed first, so nothing was released');
  assert.equal(calls, 0);
  assert.equal(f.prompts.length, promptsBefore);
  const rotated = JSON.parse(await f.resume(f.makeRunner({}), runId, 'go'));
  assert.equal(rotated.status, 'paused');
  assert.equal(registry.count(child), 0);
  assert.equal(removed, 1, 'one correction attempt, released once');
  const done = JSON.parse(await f.resume(f.makeRunner({}), runId, 'go'));
  assert.equal(done.status, 'completed');
  assert.equal(removed, 1, 'a later resume of the same run removes nothing more');
});

test('unrelated restrictions on other children, runs and attempts stay in force', async t => {
  const { f, registry, child, runId } = await pausedHolding(t);
  const owner = (over = {}) => ({ parent: 'parent', child, attemptId: 'other-attempt', runId: 'other-run', ...over });
  registry.restrict('unrelated-child', owner({ child: 'unrelated-child' }));
  registry.restrict(child, owner()); // Same child, different run and attempt.
  registry.restrict(child); // Unowned.
  const done = JSON.parse(await f.resume(f.makeRunner(), runId, 'go'));
  assert.equal(done.status, 'paused');
  assert.equal(registry.count('unrelated-child'), 1);
  assert.equal(registry.count(child), 2, 'only this run\'s correction attempt was released');
  assert.equal(registry.releaseOwned(owner()), 1);
  assert.equal(registry.count(child), 1);
  assert.equal(registry.has('unrelated-child'), true);
});

test('a recreated native backend sharing the registry releases what the earlier backend took', async t => {
  const { f, registry, child, runId, promptsBefore } = await pausedHolding(t);
  f.swapNative({ registry }); // A brand new adapter holds no release closure.
  const resumed = JSON.parse(await f.resume(f.makeRunner(), runId, 'go'));
  assert.equal(resumed.status, 'paused');
  assert.equal(registry.has(child), false);
  assert.equal(f.prompts.length, promptsBefore);
});

test('a recreated plugin (fresh registry) neither crashes nor replays the correction, and claims no release', async t => {
  const { f, registry, child, runId, promptsBefore } = await pausedHolding(t);
  const fresh = allHooks();
  f.swapNative({ registry: fresh });
  const resumed = JSON.parse(await f.resume(f.makeRunner(), runId, 'go'));
  assert.equal(resumed.status, 'paused');
  assert.equal((await f.readState(runId)).reportRecovery.diagnostic.code, 'correction_ambiguous', 'durable state still prevents a replay');
  assert.equal(f.prompts.length, promptsBefore, 'no duplicate prompt');
  assert.equal(fresh.has(child), false);
  assert.equal(registry.count(child), 1, 'the old registry was not touched or claimed released');
});

test('a recovered valid report advances exactly once, within the cap, with receipts unchanged', async t => {
  const { f, registry, opts, child, runId, promptsBefore } = await pausedHolding(t, { managed: true });
  opts.recover = async (id, parent, attempt) => (attempt.purpose === 'report-correction' ? JSON.stringify(good()) : undefined);
  const before = structuredClone([...f.store.receipts.entries()]);
  assert.equal(before.length, 2, 'planner and original executor receipts');
  const done = JSON.parse(await f.resume(f.makeRunner(), runId, 'go'));
  assert.equal(done.status, 'completed');
  assert.equal(registry.count(child), 0);
  assert.equal(f.prompts.length, promptsBefore, 'no re-dispatch');
  const state = f.store.checkpoint;
  assert.equal(state.results.length, 1);
  assert.equal(state.results[0].reportCorrections, 1);
  assert.equal(corrections(f.prompts).length, 1);
  assert.ok(state.results[0].reportCorrections <= 2);
  assert.equal(state.reportRecovery, undefined);
  for (const [id, receipt] of before) assert.deepEqual(f.store.receipts.get(id), receipt, 'earlier receipts are byte-identical');
  const correction = [...f.store.receipts.values()].find(receipt => receipt.purpose === 'report-correction');
  assert.deepEqual(JSON.parse(correction.response), good());
  const again = JSON.parse(await f.resume(f.makeRunner(), runId, 'go'));
  assert.equal(again.status, 'completed');
  assert.equal(f.store.checkpoint.results.length, 1, 'a repeated resume advances nothing');
  assert.equal(f.store.receipts.size, 3);
});

test('unresolved work still pauses after the restriction is released', async t => {
  const { f, registry, opts, child, runId } = await pausedHolding(t, { managed: true });
  opts.recover = async () => JSON.stringify({ status: 'blocked', taskId: 'T2', reason: 'the work is not finished' });
  const paused = JSON.parse(await f.resume(f.makeRunner(), runId, 'go'));
  assert.equal(paused.status, 'paused');
  assert.match(paused.reason, /not finished/);
  assert.equal(registry.count(child), 0);
  assert.deepEqual(f.store.checkpoint.results, []);
  assert.equal(f.store.checkpoint.index, 0);
});

test('a legacy checkpoint without reportRecovery or attempt purpose still resumes', async t => {
  const registry = allHooks();
  const f = await fixture(t, [plan, new Error('provider exploded'), good()], { native: { registry, observe: async id => observed(id) } });
  const paused = JSON.parse(await f.start(f.makeRunner()));
  assert.equal(paused.status, 'paused');
  const state = await f.readState(paused.runId);
  delete state.reportRecovery; // A checkpoint saved before report correction existed.
  assert.equal(state.attempt.purpose, undefined);
  await f.writeState(paused.runId, state);
  const done = JSON.parse(await f.resume(f.makeRunner(), paused.runId, 'go'));
  assert.equal(done.status, 'completed');
  assert.equal(registry.count(paused.childSession), 0);
});
