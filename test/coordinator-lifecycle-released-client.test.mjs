import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { createSubprocessNative, until } from './fixtures/lifecycle-subprocess-harness.mjs';
import { launchMayStillDeliver, launchClientRunning } from '../dist/coordinator/lifecycle-launch.js';

/**
 * The released start client of a launch attempt is recorded durably before it can deliver, and a recorded client that
 * may still deliver keeps the attempt unresolved: through `stop` with no endpoint, through `stop --no-wait`, and after a
 * graceful drain. Every lifecycle command runs in its own process with the production adapters and runner; the native
 * tool is the synthetic executable of `test/fixtures/synthetic-native-tool.mjs`, so this is mocked-manager evidence.
 */

const posix = process.platform !== 'win32';
const skip = posix ? false : 'the synthetic native tool runs POSIX services';
const MANAGERS = ['launchd', 'systemd'];
const SUCCESS_CLAIMS = ['stopped', 'already-stopped'];

/** A process group that stays alive until the test ends it: the stand-in for a released client that has not finished. */
function liveClient(t) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
  child.unref();
  const end = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
  t.after(end);
  return { pid: child.pid, end, gone: () => until(() => !launchClientRunning({ pid: child.pid, spawnedAt: 0 }), 'the client group to end') };
}

function writeRecord(h, fields) {
  const record = { schemaVersion: 1, attemptId: 'attempt-under-test', manager: h.manager, label: h.label, dispatchedAt: Date.now(), phase: 'dispatching', ownerPid: 2147483646, ...fields };
  fs.writeFileSync(h.recordFile(), JSON.stringify(record), { mode: 0o600 });
  return record;
}

async function startedCoordinator(h) {
  const started = await h.start(['--timeout', '60']);
  assert.equal(started.document?.outcome, 'ready', `${started.stdout}\n${started.stderr}`);
  assert.equal(h.readRecord(), null);
}

async function cleanShutdown(h) {
  await startedCoordinator(h);
  const stopped = await h.stop(['--timeout', '30']);
  assert.equal(stopped.document?.outcome, 'stopped', `${stopped.stdout}\n${stopped.stderr}`);
}

test('the record helpers treat only an absent process group and a manager answer as completion', { skip }, async t => {
  const client = liveClient(t);
  const attempt = fields => ({ schemaVersion: 1, attemptId: 'a', manager: 'systemd', label: 'x', dispatchedAt: 0, phase: 'dispatching', ownerPid: 2147483646, ...fields });
  assert.equal(launchClientRunning({ pid: client.pid, spawnedAt: 0 }), true);
  assert.match(launchMayStillDeliver(attempt({ client: { pid: client.pid, spawnedAt: 0 } })), /still running/);
  assert.match(launchMayStillDeliver(attempt({})), /no record of the start client/, 'a record without a client is never resolved');
  assert.equal(launchMayStillDeliver(attempt({ phase: 'requested' })), null, 'a request the manager answered has no client left');
  client.end();
  await client.gone();
  assert.equal(launchMayStillDeliver(attempt({ client: { pid: client.pid, spawnedAt: 0 } })), null, 'only an absent process group proves the client finished');
});

for (const manager of MANAGERS) {
  test(`${manager}: the client is recorded, as the leader of its own process group, before its tool runs`, { skip }, async t => {
    const h = await createSubprocessNative(t, manager);
    await h.predeliver(h.startVerb);
    const invoking = h.spawnStart(['--timeout', '60']);
    const tool = await h.reachedPredeliver(h.startVerb);

    // The tool runs only after the client was told to run it, which happens after the record was written.
    const record = h.readRecord();
    assert.equal(record?.phase, 'dispatching');
    assert.ok(Number.isInteger(record.client?.pid) && record.client.pid > 1, 'the record names the client');
    assert.ok(Number.isInteger(record.client.spawnedAt));
    assert.equal(execFileSync('ps', ['-o', 'pgid=', '-p', String(tool)]).toString().trim(), String(record.client.pid), 'the tool runs inside the recorded process group');
    assert.equal(launchClientRunning(record.client), true);
    assert.notEqual(record.client.pid, process.pid);
    assert.deepEqual(h.inflight(), []);
    assert.equal(h.verbs().filter(verb => verb === h.startVerb).length, 0, 'the manager has received nothing');

    await h.release(h.startVerb);
    const status = await invoking.exit;
    assert.equal(status.code, 0, `${invoking.stdout}\n${invoking.stderr}`);
    assert.equal(h.readRecord(), null, 'a start confirmed ready leaves no unresolved attempt');
    await until(() => !launchClientRunning(record.client), 'the client group to end');
    const stopped = await h.stop(['--timeout', '30']);
    assert.equal(stopped.document?.outcome, 'stopped', `${stopped.stdout}\n${stopped.stderr}`);
    assert.deepEqual(h.violations(), []);
    assert.deepEqual(h.signals(), []);
  });

  test(`${manager}: a drain does not end in stopped while a recorded client may still deliver`, { skip }, async t => {
    const h = await createSubprocessNative(t, manager);
    await startedCoordinator(h);
    const client = liveClient(t);
    const record = writeRecord(h, { client: { pid: client.pid, spawnedAt: Date.now() } });

    const drained = await h.stop(['--timeout', '30']);
    assert.ok(drained.document, `${drained.stdout}\n${drained.stderr}`);
    assert.equal(drained.document.outcome, 'completion-unknown', drained.document.message);
    assert.equal(drained.document.ok, false);
    assert.notEqual(drained.status.code, 0);
    assert.match(drained.document.message, /completed a clean shutdown/);
    assert.match(drained.document.message, /earlier start request/);
    assert.deepEqual(h.readRecord(), record, 'the unresolved attempt is kept');

    // The coordinator is stopped by now, and the client is still out there: nothing may be claimed.
    const again = await h.stop(['--timeout', '10']);
    assert.ok(!SUCCESS_CLAIMS.includes(again.document?.outcome), `${again.stdout}\n${again.stderr}`);
    const noWait = await h.stop(['--no-wait']);
    assert.ok(!['stopped', 'already-stopped', 'stop-requested'].includes(noWait.document?.outcome), `${noWait.stdout}\n${noWait.stderr}`);
    assert.deepEqual(h.readRecord(), record);

    client.end();
    await client.gone();
    const final = await h.stop(['--timeout', '10']);
    if (manager === 'systemd') {
      assert.equal(final.document?.outcome, 'already-stopped', `${final.stdout}\n${final.stderr}`);
      assert.equal(h.readRecord(), null, 'client gone, no queued job and the service inactive resolve the attempt');
    } else {
      assert.equal(final.document?.outcome, 'completion-unknown', 'launchd cannot report queued requests, so the attempt stays unresolved');
      assert.deepEqual(h.readRecord(), record);
    }
    assert.deepEqual(h.violations(), []);
    assert.deepEqual(h.signals(), []);
  });

  test(`${manager}: stop --no-wait accepts the drain but says a recorded client may still launch the coordinator`, { skip }, async t => {
    const h = await createSubprocessNative(t, manager);
    await startedCoordinator(h);
    const client = liveClient(t);
    const record = writeRecord(h, { client: { pid: client.pid, spawnedAt: Date.now() } });

    const requested = await h.stop(['--no-wait']);
    assert.equal(requested.document?.outcome, 'stop-requested', `${requested.stdout}\n${requested.stderr}`);
    assert.match(requested.document.message, /earlier start request/);
    assert.match(requested.document.message, /may still launch the coordinator/);
    assert.deepEqual(h.readRecord(), record, 'the unresolved attempt is kept');
    assert.deepEqual(h.violations(), []);
    assert.deepEqual(h.signals(), []);
  });

  test(`${manager}: records without client evidence stay unresolved unless the manager answered`, { skip }, async t => {
    const h = await createSubprocessNative(t, manager);
    await cleanShutdown(h);

    // A record written before clients were recorded: nothing proves that no client can still deliver.
    const dispatching = writeRecord(h, {});
    const unresolved = await h.stop(['--timeout', '10']);
    assert.equal(unresolved.document?.outcome, 'completion-unknown', `${unresolved.stdout}\n${unresolved.stderr}`);
    assert.match(unresolved.document.message, /no record of the start client/);
    const noWait = await h.stop(['--no-wait']);
    assert.equal(noWait.document?.outcome, 'completion-unknown', `${noWait.stdout}\n${noWait.stderr}`);
    assert.deepEqual(h.readRecord(), dispatching, 'reading the record leaves it unchanged');

    // A malformed client entry is unreadable evidence, never "no client".
    writeRecord(h, { client: { pid: 1, spawnedAt: 0 } });
    const malformed = await h.stop(['--timeout', '10']);
    assert.equal(malformed.document?.outcome, 'completion-unknown', `${malformed.stdout}\n${malformed.stderr}`);
    assert.equal(malformed.document.error.code, 'state-unknown');
    assert.match(malformed.document.message, /cannot be used/);

    // The manager answered the request: no client is left to deliver it.
    writeRecord(h, { phase: 'requested' });
    const answered = await h.stop(['--timeout', '10']);
    assert.equal(answered.document?.outcome, 'already-stopped', `${answered.stdout}\n${answered.stderr}`);
    assert.equal(h.readRecord(), null);
    assert.deepEqual(h.violations(), []);
    assert.deepEqual(h.signals(), []);
  });
}
