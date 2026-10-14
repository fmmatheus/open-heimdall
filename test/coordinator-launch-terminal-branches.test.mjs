import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createExecFileRunner, withClientWitness, withCommandBudget } from '../dist/coordinator/native/types.js';

/**
 * The evidence disposition of every way a released start client can end, observed through the production runner.
 *
 * A witnessed client is a detached process group: a launcher that waits for the go-ahead and then runs the tool. The
 * runner reports one of four dispositions (see `Ending` in `native/types.ts`), and only one of them leaves the request
 * unresolved:
 *
 *   exited         the tool's exit status was observed (also a nonzero one and an exit by signal that was observed)  -> result
 *   not-run        the launcher was never told to run its tool: the tool must never run and the result is definitive
 *   could-not-run  the client or the tool could not be started                                                          -> definitive
 *   left-running   told to run, then ended or abandoned before its exit was seen                                       -> `unresolved`
 *
 * The tool is a small script that records that it ran, then exits, exits by signal, floods its output or waits on a
 * release file. The witness is controlled by the test, so a publication can be held, fail or succeed on demand. Groups
 * the cases leave behind are ended by their exact process group id when the case finishes.
 */

const posix = process.platform !== 'win32';
const skip = posix ? false : 'the released client is a POSIX process group';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const OUTPUT_BOUND = 1024 * 1024;

const TOOL = [
  "const fs = require('node:fs'); const path = require('node:path');",
  'const [mode, dir, status] = process.argv.slice(2);',
  'const mark = name => fs.writeFileSync(path.join(dir, name), String(process.pid));',
  'const pause = milliseconds => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);',
  "const hold = () => { while (!fs.existsSync(path.join(dir, 'release'))) pause(20); };",
  "mark('ran');",
  "if (mode === 'exit') process.exit(Number(status));",
  "if (mode === 'self-kill') process.kill(process.pid, 'SIGKILL');",
  "if (mode === 'flood') {",
  '  const chunk = Buffer.alloc(64 * 1024, 120);',
  '  for (let total = 0; total < 3 * 1024 * 1024;) {',
  '    try { total += fs.writeSync(1, chunk); }',
  "    catch (error) { if (error.code === 'EAGAIN') { pause(5); continue; } break; }",
  '  }',
  '}',
  "if (mode === 'wait' || mode === 'flood') { hold(); mark('finished'); }",
].join('\n');

const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
};

const groupAlive = pid => { try { process.kill(-pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };

async function until(condition, what, milliseconds = 10_000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    const value = await condition();
    if (value) return value;
    await sleep(20);
  }
  throw new Error(`${what} did not happen within ${milliseconds} ms`);
}

/** A scratch directory, a witness the test controls, and the cleanup of every group the case released. */
function scene(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hn-terminal-'));
  const script = path.join(dir, 'tool.cjs');
  fs.writeFileSync(script, TOOL);
  const clients = [];
  const gate = deferred();
  const reached = deferred();
  t.after(() => {
    for (const pid of clients) { try { process.kill(-pid, 'SIGKILL'); } catch { /* already gone */ } }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const exists = name => fs.existsSync(path.join(dir, name));
  return {
    dir, clients, gate, exists,
    /** The witness: records the client, announces it and waits on `gate`. A gate that is already open is not waited for. */
    witness: { async spawned(client) { clients.push(client.pid); reached.resolve(client.pid); await gate.promise; } },
    reached: reached.promise,
    release: () => fs.writeFileSync(path.join(dir, 'release'), ''),
    /** One run of the tool through the production runner, bound by a command budget like a lifecycle command's. */
    run(mode, { status = '0', budgetMs = 30_000, signal, timeoutMs = 30_000, witnessed = true } = {}) {
      const budget = { deadlineAt: Date.now() + budgetMs, now: Date.now, signal };
      const call = () => withCommandBudget(budget, () => createExecFileRunner().run(process.execPath, [script, mode, dir, status], { outlivesCommand: true, timeoutMs }));
      const state = { done: false };
      const result = (witnessed ? withClientWitness(this.witness, call) : call()).then(value => { state.done = true; return value; });
      return { state, result };
    },
  };
}

test('exited: a tool that exits is reported with its status and is not unresolved, only after the publication', { skip }, async t => {
  const s = scene(t);
  const run = s.run('exit', { status: '3' });
  await s.reached;
  await sleep(300);
  assert.equal(s.exists('ran'), false, 'the tool ran before its client was recorded');
  assert.equal(run.state.done, false);
  s.gate.resolve();
  const result = await run.result;
  assert.equal(result.exitCode, 3);
  assert.equal(result.unresolved, undefined);
  assert.equal(result.error, undefined);
  assert.equal(s.exists('ran'), true);
});

test('exited: a tool that does not exist is the launcher\'s nonzero exit, not an unresolved request', { skip }, async t => {
  const s = scene(t);
  s.gate.resolve();
  const budget = { deadlineAt: Date.now() + 30_000, now: Date.now };
  const result = await withCommandBudget(budget, () => withClientWitness(s.witness, () => createExecFileRunner().run(path.join(s.dir, 'missing-tool'), [], { outlivesCommand: true })));
  assert.equal(result.exitCode, 127);
  assert.equal(result.unresolved, undefined);
  assert.match(result.stderr, /could not run/);
});

test('could-not-run: a tool that cannot be spawned is a definitive failure', { skip }, async t => {
  const s = scene(t);
  const budget = { deadlineAt: Date.now() + 30_000, now: Date.now };
  const result = await withCommandBudget(budget, () => createExecFileRunner().run(path.join(s.dir, 'missing-tool'), [], { outlivesCommand: true }));
  assert.equal(result.exitCode, null);
  assert.match(result.error, /could not run: ENOENT/);
  assert.equal(result.unresolved, undefined);
});

test('left-running: a tool that dies of a signal after the go-ahead is unresolved, not a definitive failure', { skip }, async t => {
  const s = scene(t);
  s.gate.resolve();
  const result = await s.run('self-kill').result;
  assert.equal(result.exitCode, null);
  assert.equal(result.unresolved, true);
  assert.match(result.error, /SIGKILL/);
});

test('not-run: a witness that rejects ends the call definitively and the tool never runs', { skip }, async t => {
  const s = scene(t);
  s.witness.spawned = async client => { s.clients.push(client.pid); throw new Error('the record could not be written'); };
  const result = await s.run('wait').result;
  assert.equal(result.exitCode, null);
  assert.match(result.error, /was not run: the client could not be recorded \(the record could not be written\)/);
  assert.equal(result.unresolved, undefined);
  await until(() => s.clients.length === 1 && !groupAlive(s.clients[0]), 'the unrecorded client to end');
  assert.equal(s.exists('ran'), false, 'the tool ran although its client was never recorded');
});

for (const how of ['deadline', 'interruption', 'tool timeout']) {
  test(`not-run: the ${how} while the client's publication is pending ends the call only after the publication settled, and the tool never runs`, { skip }, async t => {
    const s = scene(t);
    const controller = new AbortController();
    const run = s.run('wait', how === 'deadline' ? { budgetMs: 300 } : how === 'tool timeout' ? { timeoutMs: 300 } : { signal: controller.signal });
    await s.reached;
    if (how === 'interruption') controller.abort();
    await sleep(900);
    assert.equal(run.state.done, false, 'the call reported a result while its publication was still pending');
    s.gate.resolve();
    const result = await run.result;
    assert.equal(result.exitCode, null);
    assert.match(result.error, /was not run: /);
    assert.equal(result.unresolved, undefined);
    await until(() => !groupAlive(s.clients[0]), 'the client that was never told to run to end');
    assert.equal(s.exists('ran'), false, 'the tool ran although the call ended before its go-ahead');
  });
}

test('not-run: a launcher that dies before the go-ahead is never told to run, whatever the publication does later', { skip }, async t => {
  const s = scene(t);
  const run = s.run('wait');
  const client = await s.reached;
  process.kill(-client, 'SIGKILL');
  await sleep(500);
  assert.equal(run.state.done, false, 'the call reported a result while its publication was still pending');
  s.gate.resolve();
  const result = await run.result;
  assert.match(result.error, /was not run: the client ended before it was told to run its tool/);
  assert.equal(result.unresolved, undefined);
  assert.equal(s.exists('ran'), false);
});

test('left-running: a launcher that dies after the go-ahead while its tool lives leaves the request unresolved', { skip }, async t => {
  const s = scene(t);
  s.gate.resolve();
  const run = s.run('wait');
  const client = await s.reached;
  const tool = Number(await until(() => s.exists('ran') && fs.readFileSync(path.join(s.dir, 'ran'), 'utf8'), 'the tool to run'));
  assert.notEqual(tool, client, 'the tool is a separate process of the client group');
  process.kill(client, 'SIGKILL');
  const result = await run.result;
  assert.equal(result.unresolved, true);
  assert.match(result.error, /SIGKILL/);
  assert.equal(groupAlive(client), true, 'the tool survives its launcher in the same group');
  s.release();
  await until(() => s.exists('finished'), 'the surviving tool to finish');
});

for (const how of ['deadline', 'interruption']) {
  test(`left-running: the ${how} after the go-ahead leaves the tool running and unresolved, signalling nothing`, { skip }, async t => {
    const s = scene(t);
    s.gate.resolve();
    const controller = new AbortController();
    const run = s.run('wait', how === 'deadline' ? { budgetMs: 700 } : { signal: controller.signal });
    const client = await s.reached;
    await until(() => s.exists('ran'), 'the tool to run');
    if (how === 'interruption') controller.abort();
    const result = await run.result;
    assert.equal(result.unresolved, true);
    assert.match(result.error, /did not finish: /);
    assert.equal(groupAlive(client), true, 'the tool was ended with the command');
    s.release();
    await until(() => s.exists('finished'), 'the released tool to finish');
  });
}

test('left-running: a tool that passes its own timeout is ended through its group and stays unresolved', { skip }, async t => {
  const s = scene(t);
  s.gate.resolve();
  const run = s.run('wait', { timeoutMs: 400 });
  const client = await s.reached;
  const result = await run.result;
  assert.equal(result.unresolved, true);
  assert.match(result.error, /the tool timeout passed/);
  await until(() => !groupAlive(client), 'the timed out client to end');
  assert.equal(s.exists('finished'), false);
});

test('left-running: output past the bound after the go-ahead keeps the tool running, bounded and unresolved', { skip }, async t => {
  const s = scene(t);
  s.gate.resolve();
  const run = s.run('flood');
  const client = await s.reached;
  const result = await run.result;
  assert.equal(result.unresolved, true, 'the overflow was reported as a definitive failure');
  assert.match(result.error, /its output passed the bound/);
  assert.equal(result.exitCode, null);
  assert.ok(result.stdout.length <= OUTPUT_BOUND && result.stderr.length <= OUTPUT_BOUND, 'the captured output is not bounded');
  assert.ok(result.stdout.length > 0, 'the output captured before the bound is kept');
  assert.equal(groupAlive(client), true, 'the overflow ended the client group');
  await until(() => s.exists('ran'), 'the tool to run');
  s.release();
  await until(() => s.exists('finished'), 'the tool that outlived the overflow to finish (it was not signalled)');
});
