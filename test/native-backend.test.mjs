import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReportOnlyRegistry, VERIFIED_REPORT_ONLY_PROVIDERS } from '../dist/opencode/report-only.js';
import { createNativeBackend, createNativeOriginResolver, requireIdle, resolveSubagent, nativeModel } from '../dist/opencode/native-backend.js';
import { OriginProofError } from '../dist/opencode/types.js';
import { SUBMISSION_TOOL_IDS } from '../dist/workflow/contracts.js';

const idle = () => ({ session: { id: 'child', parentID: 'parent', tokens: { input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } }, outcome: 'succeeded', time: { idle: 10 } }, active: false, inbox: [], permissions: [], forms: [] });
const context = () => ({ id: 'call_1', messageID: 'msg_1', sessionID: 'parent', agent: 'adr-orchestrator', signal: new AbortController().signal, progress: async () => {} });
const input = (events, child) => ({ parent: 'parent', child, agent: 'adr-executor', model: 'openai/gpt-5.6-sol', variant: 'max', title: 'T1', prompt: 'Implement T1', currentChild: () => 'child', onStarted: async id => { assert.equal(id, 'child'); events.push('persisted'); } });

test('native foreground execution links a fresh child, persists before prompt, and passes exact model variant', async () => {
  const events = [];
  const ctx = { tool: { list: async () => [{ id: 'native.subagent', name: 'native.subagent', execute: async (args, call) => {
    assert.deepEqual(args, { agent: 'adr-executor', description: 'T1', prompt: 'Implement T1', model: 'openai/gpt-5.6-sol#max', background: false });
    assert.equal(call.sessionID, 'parent');
    await call.progress({ sessionID: 'child', status: 'running' });
    events.push('prompted');
    return { output: { sessionID: 'child', status: 'completed', output: '{"status":"completed"}' } };
  } }] }, session: { get: async () => idle().session, context: async () => [{ type: 'assistant', finish: 'stop', time: { completed: 20 } }] } };
  const backend = createNativeBackend({ ctx, directory: '/project', observe: async () => idle() });
  assert.equal(await backend.runSubagent(input(events), context()), '{"status":"completed"}');
  assert.deepEqual(events, ['persisted', 'prompted']);
  assert.deepEqual(await backend.usage('child'), { used: 20, uncached: 15 });
});

test('resume passes the existing child and foreground backgrounding cannot advance', async () => {
  const ctx = { tool: { list: async () => [{ id: 'subagent', name: 'subagent', execute: async (args, call) => {
    assert.equal(args.sessionID, 'child');
    await call.progress({ sessionID: 'child', status: 'running' });
    return { output: { sessionID: 'child', status: 'running', output: 'Backgrounded' } };
  } }] } };
  const backend = createNativeBackend({ ctx, directory: '/project', observe: async () => idle() });
  await assert.rejects(backend.runSubagent(input([], 'child'), context()), /foreground completion/);
});

test('no active entry alone does not prove safe resume; pending and terminal states fail closed', () => {
  for (const field of ['inbox', 'permissions', 'forms']) {
    const value = idle(); value[field] = [{}];
    assert.throws(() => requireIdle(value, 'child', 'parent'), /awaiting input/);
  }
  const unknown = idle(); delete unknown.session.outcome;
  assert.throws(() => requireIdle(unknown, 'child', 'parent'), /terminal outcome/);
  const active = idle(); active.active = true;
  assert.throws(() => requireIdle(active, 'child', 'parent'), /active/);
  assert.throws(() => requireIdle(idle(), 'child', 'different-parent'), /belong/);
});

test('cancellation verifies empty inbox and durable termination even for false interrupt acknowledgement', async () => {
  let polls = 0;
  const ctx = { session: { interrupt: async () => ({ interrupted: false }) } };
  const backend = createNativeBackend({ ctx, directory: '/project', pause: async () => {}, observe: async () => {
    const value = idle(); if (++polls === 1) value.inbox = [{}]; return value;
  } });
  await backend.interrupt('child', 'parent');
  assert.equal(polls, 2);
  const blocked = createNativeBackend({ ctx, directory: '/project', cancellationWaitMs: 0, observe: async () => ({ ...idle(), inbox: [{}] }) });
  await assert.rejects(blocked.interrupt('child', 'parent'), /empty inbox/);
});

test('ambiguous/missing native tool and malformed model overrides are rejected', async () => {
  await assert.rejects(resolveSubagent({ list: async () => [] }), /exactly one/);
  await assert.rejects(resolveSubagent({ list: async () => ['subagent', 'x.subagent'].map(name => ({ name, id: name, execute() {} })) }), /exactly one/);
  for (const value of ['model', 'p/m#max', '/m']) assert.throws(() => nativeModel(value));
  assert.equal(nativeModel('anthropic/claude-sonnet-4-6'), 'anthropic/claude-sonnet-4-6');
});

test('crash recovery binds final native output to its exact persisted attempt', async () => {
  const messages = [{ type: 'user', text: 'Implement\nWorkflow attempt: attempt-1' }, { type: 'assistant', time: { completed: 20 }, finish: 'stop', content: [{ type: 'text', text: '{"status":"completed"}' }] }];
  const ctx = { session: { context: async () => messages } };
  const backend = createNativeBackend({ ctx, directory: '/project', observe: async () => idle() });
  assert.equal(await backend.recoverResponse('child', 'parent', { id: 'attempt-1', startedAt: 10 }), '{"status":"completed"}');
  await assert.rejects(backend.recoverResponse('child', 'parent', { id: 'different', startedAt: 10 }), /bind completed/);
  messages[1].finish = 'length';
  await assert.rejects(backend.recoverResponse('child', 'parent', { id: 'attempt-1', startedAt: 10 }), /truncated/);
});

test('a created child with no admitted messages is safe to reuse; unknown prior work is not', async () => {
  const pristine = idle();
  delete pristine.session.outcome; delete pristine.session.time.idle;
  pristine.session.tokens = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };
  pristine.messages = [];
  const backend = createNativeBackend({ ctx: { session: { interrupt: async () => ({ interrupted: false }) } }, directory: '/project', cancellationWaitMs: 0, observe: async () => pristine });
  await backend.assertIdle('child', 'parent');
  await backend.interrupt('child', 'parent');
  pristine.messages.push({ type: 'user', text: 'Already admitted' });
  await assert.rejects(backend.assertIdle('child', 'parent'), /terminal outcome/);
});

test('foreground native output cannot hide a truncated final response', async () => {
  const ctx = { tool: { list: async () => [{ id: 'subagent', name: 'subagent', execute: async (args, call) => {
    await call.progress({ sessionID: 'child', status: 'running' });
    return { output: { sessionID: 'child', status: 'completed', output: '{"status":"completed"}' } };
  } }] }, session: { context: async () => [{ type: 'assistant', finish: 'length', time: { completed: 20 } }] } };
  const backend = createNativeBackend({ ctx, directory: '/project', observe: async () => idle() });
  await assert.rejects(backend.runSubagent(input([]), context()), /truncated/);
});

const allHooks = registry => { for (const name of ['execute.before', 'context', 'permission.evaluate']) registry.setHook(name, true); return registry; };

test('report-only capability is absent without a registry and the default verified set is exactly claude-code', async () => {
  const backend = createNativeBackend({ ctx: {}, observe: async () => idle() });
  assert.equal(backend.reportOnly, undefined);
  assert.deepEqual([...VERIFIED_REPORT_ONLY_PROVIDERS], ['claude-code']);
});

test('report-only check fails closed with exact reasons: no hooks, non-verified provider, bad model', async () => {
  const registry = createReportOnlyRegistry();
  const backend = createNativeBackend({ ctx: {}, observe: async () => idle(), reportOnly: registry, verifiedProviders: ['openai'] });
  assert.deepEqual(await backend.reportOnly.check('openai/gpt-5', 'child'), { supported: false, reason: 'Report-only enforcement is unavailable: Heimdall plugin hooks are not registered (execute.before, context, permission.evaluate)' });
  registry.setHook('execute.before', true); registry.setHook('context', true);
  assert.deepEqual(await backend.reportOnly.check('openai/gpt-5', 'child'), { supported: false, reason: 'Report-only enforcement is unavailable: Heimdall plugin hooks are not registered (permission.evaluate)' });
  allHooks(registry);
  assert.deepEqual(await backend.reportOnly.check('claude-code/opus', 'child'), { supported: false, reason: 'Report-only enforcement is not verified for provider "claude-code"' });
  assert.deepEqual(await backend.reportOnly.check('anthropic/claude#high', 'child'), { supported: false, reason: 'Report-only enforcement is not verified for provider "anthropic"' });
  assert.deepEqual(await backend.reportOnly.check('not-a-model', 'child'), { supported: false, reason: 'Report-only enforcement cannot identify the provider of model "not-a-model"' });
  assert.deepEqual(await backend.reportOnly.check('openai/gpt-5.6-sol#max', 'child'), { supported: true });
  // The shipped default set is only claude-code: with all hooks, openai is still unsupported by default.
  const defaults = createNativeBackend({ ctx: {}, observe: async () => idle(), reportOnly: allHooks(createReportOnlyRegistry()) });
  assert.deepEqual(await defaults.reportOnly.check('openai/gpt-5', 'child'), { supported: false, reason: 'Report-only enforcement is not verified for provider "openai"' });
  assert.deepEqual(await defaults.reportOnly.check('claude-code/sonnet', 'child'), { supported: true });
});

test('report-only restrict registers the child and the release is idempotent; restrict fails closed without hooks', async () => {
  const registry = createReportOnlyRegistry();
  const backend = createNativeBackend({ ctx: {}, observe: async () => idle(), reportOnly: registry, verifiedProviders: ['openai'] });
  await assert.rejects(backend.reportOnly.restrict('child'), /plugin hooks not registered/);
  allHooks(registry);
  await assert.rejects(backend.reportOnly.restrict(''), /child session is required/);
  const first = await backend.reportOnly.restrict('child');
  const second = await backend.reportOnly.restrict('child');
  assert.equal(registry.has('child'), true);
  await first(); await first();
  assert.equal(registry.has('child'), true, 'a repeated release must not drop the second holder');
  await second(); await second();
  assert.equal(registry.has('child'), false);
  assert.equal(registry.has('other'), false);
});

test('report-only restrictions are released by owner identity, idempotently, without touching other holders', async () => {
  const registry = allHooks(createReportOnlyRegistry());
  const backend = createNativeBackend({ ctx: {}, observe: async () => idle(), reportOnly: registry, verifiedProviders: ['openai'] });
  const owner = attemptId => ({ parent: 'parent', attemptId, runId: 'run' });
  const first = await backend.reportOnly.restrict('child', owner('a1'));
  await backend.reportOnly.restrict('child', owner('a2'));
  await backend.reportOnly.restrict('child'); // Unowned.
  await backend.reportOnly.restrict('other', { ...owner('a1'), runId: 'other-run' });
  assert.equal(registry.count('child'), 3);
  // A recreated adapter holds no closure and releases through the shared registry.
  const recreated = createNativeBackend({ ctx: {}, observe: async () => idle(), reportOnly: registry, verifiedProviders: ['openai'] });
  await recreated.reportOnly.releaseRetained({ child: 'child', parent: 'parent', runId: 'run', attemptIds: ['a1'] });
  assert.equal(registry.count('child'), 2);
  for (let i = 0; i < 3; i++) await recreated.reportOnly.releaseRetained({ child: 'child', parent: 'parent', runId: 'run', attemptIds: ['a1'] });
  assert.equal(registry.count('child'), 2, 'repeating the cleanup never drops another holder or goes negative');
  await first(); await first();
  assert.equal(registry.count('child'), 2, 'the original closure is a no-op once the owner entry is gone');
  // Wrong parent, wrong run or unknown attempt release nothing.
  await recreated.reportOnly.releaseRetained({ child: 'child', parent: 'someone-else', runId: 'run', attemptIds: ['a2'] });
  await recreated.reportOnly.releaseRetained({ child: 'child', parent: 'parent', runId: 'other-run', attemptIds: ['a2'] });
  await recreated.reportOnly.releaseRetained({ child: 'child', parent: 'parent', runId: 'run', attemptIds: ['nope'] });
  assert.equal(registry.count('child'), 2);
  await recreated.reportOnly.releaseRetained({ child: 'child', parent: 'parent', runId: 'run', attemptIds: ['a2', 'a1'] });
  assert.equal(registry.count('child'), 1, 'only the unowned holder remains');
  assert.equal(registry.count('other'), 1);
  assert.equal(registry.releaseOwned({ parent: 'parent', child: 'unknown', attemptId: 'x' }), 0);
  assert.throws(() => registry.restrict('child', { parent: 'parent', child: 'other', attemptId: 'x' }), /must name its parent, child and attempt/);
});

const TOOL = SUBMISSION_TOOL_IDS['executor-result'];
const call = { sessionID: 'child', agent: 'adr-executor', messageID: 'msg_asst', id: 'call_1' };
/** A newest-first archive, as the supported message-history reader yields it. */
const archive = (...messages) => async function* (sessionID) { assert.equal(sessionID, 'child'); yield* messages; };
const assistant = (overrides = {}) => ({ type: 'assistant', id: 'msg_asst', agent: 'adr-executor', content: [{ type: 'tool', id: 'call_1', name: TOOL }], ...overrides });
const user = id => ({ type: 'user', id, text: 'a prompt' });
const reason = promise => promise.then(() => 'resolved', error => error instanceof OriginProofError ? error.reason : 'other:' + error.message);

test('origin resolves to the nearest real user prompt before the carrying assistant, across every other record type', async () => {
  const resolve = createNativeOriginResolver(archive(
    assistant({ id: 'msg_later', agent: 'other' }), { type: 'compaction', id: 'c2', status: 'completed' }, assistant(), { type: 'assistant', id: 'msg_mid', agent: 'adr-executor', content: [] },
    { type: 'synthetic', id: 's1' }, { type: 'system', id: 'sy' }, { type: 'skill', id: 'sk' }, { type: 'shell', id: 'sh' }, { type: 'agent-switched', id: 'sw' }, { type: 'idle', id: 'i' }, { type: 'compaction', id: 'c1', status: 'completed' },
    user('msg_dispatch'), user('msg_older'),
  ));
  assert.equal(await resolve(call, { kind: 'executor-result' }), 'msg_dispatch');
  // The carrying message may list no tool calls yet (not available): the id and agent still bind it.
  assert.equal(await createNativeOriginResolver(archive(assistant({ content: [] }), user('msg_dispatch')))(call, { kind: 'executor-result' }), 'msg_dispatch');
});

test('origin proof fails closed with a bounded reason for each unprovable relationship', async () => {
  const binding = { kind: 'executor-result' };
  const prove = (history, native = call, bound = binding) => reason(createNativeOriginResolver(history)(native, bound));
  assert.equal(await prove(archive(user('u'), { type: 'assistant', id: 'msg_other', agent: 'adr-executor' })), 'call_not_found');
  assert.equal(await prove(archive()), 'call_not_found');
  assert.equal(await prove(archive({ ...assistant(), type: 'user' }, user('u'))), 'call_not_found');
  assert.equal(await prove(archive(assistant(), { type: 'compaction', id: 'c' }, { type: 'synthetic', id: 's' })), 'prompt_not_found');
  assert.equal(await prove(archive(assistant({ agent: 'adr-planner' }), user('u'))), 'agent_mismatch');
  assert.equal(await prove(archive(assistant({ content: [{ type: 'tool', id: 'call_9', name: TOOL }] }), user('u'))), 'call_mismatch');
  assert.equal(await prove(archive(assistant({ content: [{ type: 'text', text: 'hi' }, { type: 'tool', id: 'call_1', name: 'bash' }] }), user('u'))), 'call_mismatch');
  assert.equal(await prove(archive(assistant({ content: [{ type: 'tool', id: 'call_1', name: 'namespaced__' + TOOL }] }), user('u'))), 'call_mismatch');
  // A real submission tool of the other kind is not this binding's tool.
  assert.equal(await prove(archive(assistant(), user('u')), call, { kind: 'planner-plan' }), 'call_mismatch');
  // Reader failures keep their own reason and carry no transcript text.
  const failing = async function* () { throw new OriginProofError('page_malformed'); };
  assert.equal(await prove(failing), 'page_malformed');
  const error = await createNativeOriginResolver(archive(assistant({ agent: 'x' })))(call, { kind: 'executor-result' }).catch(value => value);
  assert.match(error.message, /agent_mismatch/);
  assert.ok(!error.message.includes('a prompt'));
});

test('the resolver stops reading the archive once the prompt is found', async () => {
  let pulled = 0;
  const lazy = async function* () { for (const message of [assistant(), user('msg_dispatch'), user('msg_older'), user('msg_oldest')]) { pulled++; yield message; } };
  assert.equal(await createNativeOriginResolver(lazy)(call, { kind: 'executor-result' }), 'msg_dispatch');
  assert.equal(pulled, 2);
});

test('binding a completed child output to its attempt uses the full archive when the active context lost the prompt', async () => {
  const final = { type: 'assistant', id: 'a', finish: 'stop', content: [{ type: 'text', text: '{"status":"completed"}' }], time: { completed: 20 } };
  const prompt = { type: 'user', id: 'u', text: 'Workflow attempt: attempt-1\nDo it' };
  const ctx = { session: { context: async () => [{ type: 'compaction', id: 'c' }, final] } };
  const observe = async () => idle();
  const attempt = { id: 'attempt-1', startedAt: 10 };
  const compacted = createNativeBackend({ ctx, observe });
  await assert.rejects(compacted.recoverResponse('child', 'parent', attempt), /bind completed/);
  const full = createNativeBackend({ ctx, observe, history: async function* () { yield final; yield { type: 'compaction', id: 'c' }; yield prompt; } });
  assert.equal(await full.recoverResponse('child', 'parent', attempt), '{"status":"completed"}');
  await assert.rejects(full.recoverResponse('child', 'parent', { id: 'different', startedAt: 10 }), /bind completed/);
  const broken = createNativeBackend({ ctx, observe, history: async function* () { throw new OriginProofError('history_unavailable'); } });
  await assert.rejects(broken.recoverResponse('child', 'parent', attempt), /history_unavailable/);
});

const dispatchInput = { child: 'child', parent: 'parent', attemptId: 'attempt-1' };
const markerPrompt = (id, attempt = 'attempt-1') => ({ type: 'user', id, text: 'Workflow attempt: ' + attempt + '\nDo it' });

test('dispatch prompt observation keeps the active context as the primary path and never reads the archive when it holds the prompt', async () => {
  let scans = 0;
  const history = async function* () { scans++; yield markerPrompt('msg_archived'); };
  const ctx = { session: { context: async () => [markerPrompt('msg_old', 'attempt-0'), markerPrompt('msg_prompt'), { type: 'assistant', id: 'a' }] } };
  const backend = createNativeBackend({ ctx, observe: async () => idle(), history });
  assert.equal(await backend.observeDispatchPrompt(dispatchInput), 'msg_prompt');
  assert.equal(scans, 0);
});

test('dispatch prompt observation falls back to the newest marker prompt of the archive only when compaction removed it from the context', async () => {
  const ctx = { session: { context: async () => [{ type: 'compaction', id: 'c' }, { type: 'assistant', id: 'a' }, { type: 'user', id: 'msg_other', text: 'Workflow attempt: attempt-0' }] } };
  const archive = [
    { type: 'assistant', id: 'a2' }, { type: 'compaction', id: 'c' }, markerPrompt('msg_resumed'), { type: 'assistant', id: 'a1' },
    markerPrompt('msg_first'), { type: 'user', id: 'msg_noise', text: 'Workflow attempt: attempt-0' },
  ];
  const seen = [];
  const history = async function* (sessionID, signal) { seen.push([sessionID, signal]); yield* archive; };
  const signal = new AbortController().signal;
  const backend = createNativeBackend({ ctx, observe: async () => idle(), history });
  assert.equal(await backend.observeDispatchPrompt({ ...dispatchInput, signal }), 'msg_resumed', 'newest first');
  assert.deepEqual(seen, [['child', signal]]);
  // The child must still belong to this parent before anything is read.
  await assert.rejects(backend.observeDispatchPrompt({ ...dispatchInput, parent: 'someone-else' }), /belong/);
});

test('dispatch prompt observation yields nothing when neither the context nor the archive holds the marker prompt, and fails as before without an archive', async () => {
  const ctx = { session: { context: async () => [{ type: 'compaction', id: 'c' }, { type: 'user', id: 'msg_other', text: 'Workflow attempt: attempt-0' }] } };
  const missing = async function* () { yield { type: 'assistant', id: 'a' }; yield { type: 'user', id: 'msg_other', text: 'Workflow attempt: attempt-0' }; yield { type: 'user', id: '', text: 'Workflow attempt: attempt-1' }; yield { type: 'user', id: 'msg_notext' }; };
  assert.equal(await createNativeBackend({ ctx, observe: async () => idle(), history: missing }).observeDispatchPrompt(dispatchInput), undefined);
  assert.equal(await createNativeBackend({ ctx, observe: async () => idle() }).observeDispatchPrompt(dispatchInput), undefined);
  // An archive that cannot be read proves nothing: the poll simply keeps waiting, exactly as for an absent context prompt.
  const broken = async function* () { throw new OriginProofError('history_unavailable'); };
  assert.equal(await createNativeBackend({ ctx, observe: async () => idle(), history: broken }).observeDispatchPrompt(dispatchInput), undefined);
  // Anything else (an abort, say) still surfaces.
  const aborted = async function* () { throw new Error('aborted'); };
  await assert.rejects(createNativeBackend({ ctx, observe: async () => idle(), history: aborted }).observeDispatchPrompt(dispatchInput), /aborted/);
});

test('dispatch prompt archive scans for one attempt are spaced so the runner poll cannot rescan every few milliseconds', async () => {
  let scans = 0;
  const history = async function* () { scans++; yield { type: 'assistant', id: 'a' }; };
  const ctx = { session: { context: async () => [] } };
  const backend = createNativeBackend({ ctx, observe: async () => idle(), history });
  await backend.observeDispatchPrompt(dispatchInput);
  await backend.observeDispatchPrompt(dispatchInput);
  assert.equal(scans, 1);
  await backend.observeDispatchPrompt({ ...dispatchInput, attemptId: 'attempt-2' });
  assert.equal(scans, 2, 'another attempt is scanned independently');
});
