import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNativeBackend, requireIdle, resolveSubagent, nativeModel } from '../dist/opencode/native-backend.js';

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
