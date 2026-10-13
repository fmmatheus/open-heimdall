import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createSubprocessNative, until } from './fixtures/lifecycle-subprocess-harness.mjs';

/**
 * A native start request that was already issued outlives the command that issued it. These tests run every lifecycle
 * command in its own process, with the production adapters and `createExecFileRunner`, against a synthetic native tool
 * that holds the start verb on a gate. They end the invoking process after the request was dispatched and run `stop`
 * from another process: `stop` must not claim stopped or already-stopped while that request may still land, and the
 * durable launch attempt record must be resolved only by an observation that correlates it with the service.
 *
 * Mocked-manager evidence: the synthetic tool is neither launchd nor systemd.
 */

const posix = process.platform !== 'win32';
const skip = posix ? false : 'the synthetic native tool runs POSIX services';
const MANAGERS = ['launchd', 'systemd'];
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const SUCCESS_CLAIMS = ['stopped', 'already-stopped'];

function assertNoStopClaim(result, description) {
  assert.ok(result.document, `${description}: no lifecycle document\n${result.stdout}\n${result.stderr}`);
  assert.equal(result.document.ok, false, `${description}: ${result.document.outcome} ${result.document.message}`);
  assert.ok(!SUCCESS_CLAIMS.includes(result.document.outcome), `${description}: claimed ${result.document.outcome}`);
  assert.notEqual(result.status.code, 0, `${description}: exit status`);
}

function assertNoDestructiveVerb(h) {
  assert.deepEqual(h.violations(), [], 'the synthetic tool refused a verb that could stop, kill or alter the service');
  assert.deepEqual(h.signals(), [], 'no tool call was terminated by a signal');
  for (const verb of h.verbs()) assert.ok(!['stop', 'kill', 'bootout', 'restart', 'disable'].includes(verb), `unexpected native verb ${verb}`);
}

/** Dispatch a start, wait until the native request is held on its gate, then end the invoking process. */
async function dispatchAndKill(h, extra = ['--timeout', '60']) {
  await h.gate(h.startVerb);
  const invoking = h.spawnStart(extra);
  const tool = await h.reached(h.startVerb);
  const record = h.readRecord();
  invoking.child.kill('SIGKILL');
  await invoking.exit;
  assert.equal(h.toolAlive(tool), true, 'the issued request outlives the invoking process');
  return { tool, record, invoking };
}

for (const manager of MANAGERS) {
  test(`${manager}: a stop from another process never claims stopped while an issued start may still land`, { skip }, async t => {
    const h = await createSubprocessNative(t, manager);
    const { tool, record } = await dispatchAndKill(h);

    // Invoking process and its lock are gone; the record is what is left.
    const first = await h.stop(['--timeout', '5']);
    assertNoStopClaim(first, 'stop while the request is held');
    assert.equal(first.document.outcome, 'completion-unknown');
    assert.equal(first.document.error.code, 'completion-unknown');
    assert.match(first.document.message, /earlier start request/);
    assert.ok(record, 'the launch attempt is recorded before the manager is asked to start');
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.label, h.label);
    assert.equal(record.manager, manager);
    assert.equal(record.phase, 'dispatching');
    assert.equal((await fs.stat(h.recordFile())).mode & 0o777, 0o600, 'the record is private');
    assert.deepEqual(h.readRecord(), record, 'a stop that could not resolve the attempt leaves the record unchanged');

    // Still unresolved on the next ask, and still nothing destructive.
    assertNoStopClaim(await h.stop(['--timeout', '5']), 'second stop while the request is held');
    assertNoDestructiveVerb(h);

    // The manager lets the request through: the coordinator launches without any command watching.
    await h.ungate(h.startVerb);
    await until(() => !h.toolAlive(tool), 'the released request to finish');
    await h.coordinatorUp();

    const stopped = await h.stop(['--timeout', '30']);
    assert.equal(stopped.document.outcome, 'stopped', `${stopped.stdout}\n${stopped.stderr}`);
    assert.equal(stopped.status.code, 0);
    assert.equal(h.readRecord(), null, 'the authenticated instance resolved the attempt');
    assertNoDestructiveVerb(h);

    // After resolution a normal stop is a normal answer, and a later explicit start works.
    const again = await h.stop(['--timeout', '10']);
    assert.equal(again.document.outcome, 'already-stopped', `${again.stdout}\n${again.stderr}`);
    const restarted = await h.start(['--timeout', '60']);
    assert.equal(restarted.document.outcome, 'ready', `${restarted.stdout}\n${restarted.stderr}`);
    assert.equal(h.readRecord(), null);
    const final = await h.stop(['--timeout', '30']);
    assert.equal(final.document.outcome, 'stopped', `${final.stdout}\n${final.stderr}`);
    assertNoDestructiveVerb(h);
  });

  test(`${manager}: a start whose invoking command ended at its deadline leaves a stop without a stopped claim`, { skip }, async t => {
    const h = await createSubprocessNative(t, manager);
    await h.gate(h.startVerb);
    const invoking = h.spawnStart(['--timeout', '2']);
    const tool = await h.reached(h.startVerb);

    // The deadline passes while the request is held; the command reports it truthfully and ends with the deadline, while
    // the request it issued is left to the manager.
    await invoking.exit;
    const report = JSON.parse(invoking.stdout);
    assert.equal(report.outcome, 'startup-not-confirmed');
    assert.equal(h.toolAlive(tool), true, 'the issued start request was not ended');

    const during = await h.stop(['--timeout', '3']);
    assertNoStopClaim(during, 'stop while the start request is unresolved');
    assert.ok(h.readRecord(), 'the launch attempt is recorded before the manager is asked to start');

    await h.ungate(h.startVerb);
    await h.coordinatorUp();
    assert.equal(h.readRecord()?.phase, 'dispatching', 'no process was left to learn that the request was accepted; an observation resolves it');

    const stopped = await h.stop(['--timeout', '30']);
    assert.equal(stopped.document.outcome, 'stopped', `${stopped.stdout}\n${stopped.stderr}`);
    assert.equal(h.readRecord(), null);
    assertNoDestructiveVerb(h);
  });

  test(`${manager}: with no launch attempt recorded stop keeps its earlier answer for a coordinator that never ran`, { skip }, async t => {
    const h = await createSubprocessNative(t, manager);
    assert.equal(h.readRecord(), null);
    const result = await h.stop(['--timeout', '10']);
    assert.equal(result.document.outcome, 'failed', `${result.stdout}\n${result.stderr}`);
    assert.equal(result.document.error.code, 'not-managed');

    const started = await h.start(['--timeout', '60']);
    assert.equal(started.document.outcome, 'ready', `${started.stdout}\n${started.stderr}`);
    assert.equal(h.readRecord(), null, 'a start that was confirmed ready leaves no unresolved attempt');
    const stopped = await h.stop(['--timeout', '30']);
    assert.equal(stopped.document.outcome, 'stopped', `${stopped.stdout}\n${stopped.stderr}`);
    assertNoDestructiveVerb(h);
  });

  test(`${manager}: a start the manager refused is not left as an unresolved attempt`, { skip }, async t => {
    const h = await createSubprocessNative(t, manager);
    await h.failWith(h.startVerb, 1);
    const started = await h.start(['--timeout', '10']);
    assert.equal(started.document.ok, false);
    assert.equal(h.readRecord(), null, 'a request the tool definitively failed cannot still be in flight');
    const stop = await h.stop(['--timeout', '10']);
    assert.equal(stop.document.outcome, 'failed', `${stop.stdout}\n${stop.stderr}`);
    assert.equal(stop.document.error.code, 'not-managed', 'the earlier answer for a coordinator that never ran, not an unresolved launch');
  });
}

test('systemd: an attempt resolves by absence only once the manager reports no queued start job', { skip }, async t => {
  const h = await createSubprocessNative(t, 'systemd');
  const { tool, record } = await dispatchAndKill(h);
  assertNoStopClaim(await h.stop(['--timeout', '5']), 'stop while the start job is queued');
  assert.ok(record);
  assert.deepEqual(h.readRecord(), record);

  // The held request ends without launching anything: nothing is running and no job is queued any more.
  await h.failWith('start', 1);
  await h.ungate('start');
  await until(() => !h.toolAlive(tool), 'the released request to finish');
  const result = await h.stop(['--timeout', '10']);
  assert.equal(result.document.error?.code, 'not-managed', `${result.stdout}\n${result.stderr}`);
  assert.equal(h.readRecord(), null, 'proven inactive with no pending manager job resolves the attempt');
  assertNoDestructiveVerb(h);
});

test('launchd: without queued-request evidence an issued kickstart stays unresolved until a start is run explicitly', { skip }, async t => {
  const h = await createSubprocessNative(t, 'launchd');
  const { tool, record } = await dispatchAndKill(h);
  assert.ok(record, 'the launch attempt is recorded before the manager is asked to start');

  await h.failWith('kickstart', 1);
  await h.ungate('kickstart');
  await until(() => !h.toolAlive(tool), 'the released request to finish');
  // launchd cannot say that nothing of the request is left in flight, so absence alone proves nothing.
  const first = await h.stop(['--timeout', '10']);
  assertNoStopClaim(first, 'stop after the held request ended without a service');
  assert.deepEqual(h.readRecord(), record);

  await sleep(0);
  await fs.rm(`${h.managerDirectory}/fail/kickstart`, { force: true });
  const started = await h.start(['--timeout', '60']);
  assert.equal(started.document.outcome, 'ready', `${started.stdout}\n${started.stderr}`);
  assert.equal(h.readRecord(), null);
  const stopped = await h.stop(['--timeout', '30']);
  assert.equal(stopped.document.outcome, 'stopped', `${stopped.stdout}\n${stopped.stderr}`);
  assertNoDestructiveVerb(h);
});
