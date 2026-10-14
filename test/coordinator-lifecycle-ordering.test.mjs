import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { acquireOperationLock, readStopGeneration } from '../dist/coordinator/lifecycle-lock.js';
import { createControlledNative } from './fixtures/controlled-native-runner.mjs';

/**
 * Ordering between `stop` and an earlier `start`. An accepted stop (and a successful `already-stopped`) is a durable
 * boundary: a start that began waiting before it must not launch afterwards, and a start whose deadline ended or that
 * was interrupted must never issue a native start, nor change the service definition, after another lifecycle
 * operation could have begun. A native launch that was already issued stays unconfirmed and blocks stopped results.
 *
 * The production launchd and systemd adapters run against the controlled native runner, which spawns a real
 * coordinator. This is mocked-manager evidence, never launchd or systemd evidence.
 */

const posix = process.platform !== 'win32';
const skip = posix ? false : 'the controlled native runner spawns POSIX services';
const unwritableSkip = !posix ? skip : process.getuid?.() === 0 ? 'directory permissions do not bind the superuser' : false;
const MANAGERS = ['launchd', 'systemd'];
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const injectedFailure = { exitCode: 1, stdout: '', stderr: 'injected install failure' };

const profile = manager => manager === 'launchd'
  ? { inspect: 'print', launch: 'kickstart', install: 'bootstrap', mutating: ['bootstrap', 'kickstart'] }
  : { inspect: 'show', launch: 'start', install: 'link', mutating: ['link', 'daemon-reload', 'start'] };

async function until(predicate, description, milliseconds = 15_000) {
  const deadline = Date.now() + milliseconds;
  while (!await predicate()) {
    if (Date.now() > deadline) assert.fail(`Timed out waiting for ${description}`);
    await sleep(20);
  }
}

const flag = () => { let fire; const promise = new Promise(resolve => { fire = resolve; }); return { promise, fire }; };

/** Parks the `nth` call of `verb` (or of every verb with '*') before it takes effect, counting from now. */
function holdNth(runner, verb, nth = 1) {
  const reached = flag();
  const released = flag();
  let seen = 0;
  runner.on('before', verb, async call => {
    seen += 1;
    if (seen !== nth) return;
    reached.fire(call);
    await released.promise;
  }, { once: false });
  return { reached: reached.promise, release: released.fire };
}

/**
 * Dependencies for a `start` that is queued behind another lifecycle operation: it reports when it begins waiting for
 * the operation lock and then stays parked until `open()`, so the test decides when it may try the lock again.
 */
function queuedStart() {
  const waiting = flag();
  const gate = flag();
  let open = false;
  return {
    waiting: waiting.promise,
    open() { open = true; gate.fire(); },
    dependencies: {
      progress: text => { if (/waiting for it to finish/.test(text)) waiting.fire(); },
      async sleep(milliseconds, signal) {
        if (!open) await Promise.race([gate.promise, new Promise(resolve => signal?.addEventListener('abort', resolve, { once: true }))]);
        await sleep(milliseconds);
      },
    },
  };
}

async function ready(h, extra = ['--timeout', '60']) {
  const started = await h.start(extra);
  assert.equal(started.document.outcome, 'ready', `${started.stdout}\n${started.stderr}`);
  return started;
}

/** A clean start and stop: the owned definition stays registered and the last instance ended cleanly. */
async function stoppedService(t, manager) {
  const h = await createControlledNative(t, manager);
  const first = await ready(h);
  const halt = await h.stop(['--timeout', '60']);
  assert.equal(halt.document.outcome, 'stopped', `${halt.stdout}\n${halt.stderr}`);
  assert.equal(h.runner.isRunning(h.service()), false);
  return { h, first };
}

async function exited(h) {
  const service = h.service();
  const exit = await Promise.race([service.exited, sleep(20_000).then(() => null)]);
  assert.ok(exit, 'the coordinator exited');
  assert.equal(exit.code, 0);
}

const lifecycleDirectory = h => path.join(h.stateDirectory, 'lifecycle');
async function makeUnwritable(t, h) {
  await fs.chmod(lifecycleDirectory(h), 0o500);
  t.after(() => fs.chmod(lifecycleDirectory(h), 0o700).catch(() => {}));
}
const makeWritable = h => fs.chmod(lifecycleDirectory(h), 0o700);

const launches = h => h.runner.verbs.filter(verb => verb === profile(h.manager).launch).length;

function assertNoForcedStop(h) {
  h.runner.assertNoViolations();
  assert.ok(!h.runner.calls.some(call => call.args.includes('-k')));
  assert.equal(h.runner.cleanupLog.length, 0, 'the harness ended no process');
}

for (const manager of MANAGERS) {
  const p = profile(manager);

  test(`${manager}: a start that waited before a successful --no-wait stop does not launch after the drain finished`, { skip, timeout: 90_000 }, async t => {
    const h = await createControlledNative(t, manager);
    const first = await ready(h);
    const hold = holdNth(h.runner, p.inspect, 1);
    const stop = h.stop(['--no-wait']);
    await hold.reached;
    const queued = queuedStart();
    const start = h.start(['--timeout', '60'], { dependencies: queued.dependencies });
    await queued.waiting;
    assert.equal(await readStopGeneration(h.stateDirectory), 0, 'the start read the ordering state from before the stop');
    hold.release();
    const halted = await stop;
    assert.equal(halted.document.outcome, 'stop-requested', `${halted.stdout}\n${halted.stderr}`);
    assert.equal(halted.status, 0);
    await exited(h);
    queued.open();
    const waited = await start;
    assert.equal(waited.document.outcome, 'conflict', `${waited.stdout}\n${waited.stderr}`);
    assert.equal(waited.document.error.code, 'superseded-by-stop');
    assert.equal(h.service().starts, 1, 'no second coordinator was launched');
    assert.equal(launches(h), 1);
    assert.equal(await readStopGeneration(h.stateDirectory), 1);
    // A later explicit start is the way back.
    const again = await ready(h);
    assert.notEqual(again.document.instance.instanceId, first.document.instance.instanceId);
    assert.equal(h.service().starts, 2);
    assertNoForcedStop(h);
  });

  test(`${manager}: a start that waited before a successful already-stopped does not launch after it`, { skip, timeout: 90_000 }, async t => {
    const { h, first } = await stoppedService(t, manager);
    const generation = await readStopGeneration(h.stateDirectory);
    const hold = holdNth(h.runner, p.inspect, 1);
    const stop = h.stop(['--timeout', '60']);
    await hold.reached;
    const queued = queuedStart();
    const start = h.start(['--timeout', '60'], { dependencies: queued.dependencies });
    await queued.waiting;
    assert.equal(await readStopGeneration(h.stateDirectory), generation, 'the start read the ordering state from before the stop');
    hold.release();
    const again = await stop;
    assert.equal(again.document.outcome, 'already-stopped', `${again.stdout}\n${again.stderr}`);
    queued.open();
    const waited = await start;
    assert.equal(waited.document.outcome, 'conflict', `${waited.stdout}\n${waited.stderr}`);
    assert.equal(waited.document.error.code, 'superseded-by-stop');
    assert.equal(h.service().starts, 1);
    assert.equal(launches(h), 1);
    assert.equal(await readStopGeneration(h.stateDirectory), generation + 1);
    const next = await ready(h);
    assert.notEqual(next.document.instance.instanceId, first.document.instance.instanceId);
    assertNoForcedStop(h);
  });

  test(`${manager}: a stop that cannot record its ordering boundary requests no drain and claims nothing`, { skip: unwritableSkip, timeout: 90_000 }, async t => {
    for (const mode of [['--no-wait'], ['--timeout', '20']]) {
      const h = await createControlledNative(t, manager);
      await ready(h);
      const hold = holdNth(h.runner, p.inspect, 1);
      const started = Date.now();
      const stop = h.stop(mode);
      await hold.reached;
      const queued = queuedStart();
      const start = h.start(['--timeout', '60'], { dependencies: queued.dependencies });
      await queued.waiting;
      await makeUnwritable(t, h);
      hold.release();
      const failed = await stop;
      assert.ok(Date.now() - started < 15_000, 'the stop ended within its bound');
      assert.equal(failed.status, 1, `${mode}: ${failed.stdout}`);
      assert.equal(failed.document.ok, false);
      assert.equal(failed.document.outcome, 'failed');
      assert.equal(failed.document.error.code, 'state-unknown');
      assert.match(failed.document.message, /no drain was requested/);
      assert.doesNotMatch(failed.document.message, /accepted|admission is disabled|stopped cleanly/);
      // The coordinator was not asked to drain: it still accepts runs.
      const client = await h.client();
      assert.equal((await client.request('GET', '/lifecycle')).phase, 'running');
      assert.equal((await client.request('GET', '/status')).acceptingNewRuns, true);
      assert.equal(h.runner.isRunning(h.service()), true);
      // The earlier start did not undo or disturb anything: it finds the running coordinator.
      await makeWritable(h);
      queued.open();
      const waited = await start;
      assert.equal(waited.document.outcome, 'already-running', `${waited.stdout}\n${waited.stderr}`);
      assert.equal(h.service().starts, 1);
      assertNoForcedStop(h);
    }
  });

  test(`${manager}: an already-stopped coordinator whose ordering boundary cannot be recorded is not reported as already-stopped`, { skip: unwritableSkip, timeout: 90_000 }, async t => {
    const { h } = await stoppedService(t, manager);
    await makeUnwritable(t, h);
    const started = Date.now();
    const failed = await h.stop(['--timeout', '20']);
    assert.ok(Date.now() - started < 15_000);
    assert.equal(failed.status, 1, `${failed.stdout}\n${failed.stderr}`);
    assert.equal(failed.document.outcome, 'failed');
    assert.equal(failed.document.error.code, 'state-unknown');
    assert.match(failed.document.message, /ordering/);
    assert.doesNotMatch(failed.document.message, /^The coordinator is already stopped/);
    await makeWritable(h);
    const next = await ready(h);
    assert.equal(next.status, 0);
    assert.equal(h.service().starts, 2);
    assertNoForcedStop(h);
  });

  for (const how of ['deadline', 'interrupt']) {
    test(`${manager}: a start that ${how === 'deadline' ? 'ran out of time' : 'was interrupted'} during install never issues a native start or changes the definition afterwards`, { skip, timeout: 90_000 }, async t => {
      const h = await createControlledNative(t, manager);
      const hold = holdNth(h.runner, '*', 1);
      const signals = new EventEmitter();
      const abandoned = h.start(how === 'deadline' ? ['--timeout', '1'] : ['--timeout', '60'], { signals });
      await hold.reached;
      if (how === 'interrupt') signals.emit('SIGINT');
      const result = await abandoned;
      assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
      assert.ok(!result.document.ok);
      assert.notEqual(result.document.outcome, 'ready');
      assert.match(result.document.message, /No start was requested/);
      // Another lifecycle operation begins while the install call is still pending.
      const queued = flag();
      const other = h.stop(['--timeout', '30'], { dependencies: { progress: text => { if (/waiting for it to finish/.test(text)) queued.fire(); } } });
      await Promise.race([other.then(() => null), queued.promise]);
      hold.release();
      const stopped = await other;
      assert.equal(stopped.document.ok, false, 'there was no instance to stop');
      await sleep(750);
      assert.equal(h.service().starts, 0, 'the abandoned start never launched the coordinator');
      assert.equal(launches(h), 0, `no native start was issued: ${h.runner.verbs.join(', ')}`);
      // The definition was installed by the call that was already under way, before the next operation looked.
      const installed = h.runner.verbs.indexOf(p.install);
      assert.ok(installed >= 0, `the pending install completed: ${h.runner.verbs.join(', ')}`);
      assert.ok(installed < h.runner.verbs.lastIndexOf(p.inspect), `the next operation inspected the service only after the install settled: ${h.runner.verbs.join(', ')}`);
      assert.deepEqual(h.runner.verbs.filter(verb => p.mutating.includes(verb) && verb !== p.install && verb !== 'daemon-reload'), []);
      // Starting explicitly afterwards works.
      const next = await ready(h);
      assert.equal(next.status, 0);
      assertNoForcedStop(h);
    });
  }

  test(`${manager}: a stop that succeeds while an abandoned start's install is pending is not followed by a launch`, { skip, timeout: 90_000 }, async t => {
    const { h, first } = await stoppedService(t, manager);
    const hold = holdNth(h.runner, '*', 1);
    const abandoned = await Promise.all([h.start(['--timeout', '1']), hold.reached]).then(([result]) => result);
    assert.equal(abandoned.document.ok, false);
    const queued = flag();
    const stop = h.stop(['--timeout', '30'], { dependencies: { progress: text => { if (/waiting for it to finish/.test(text)) queued.fire(); } } });
    await Promise.race([stop.then(() => null), queued.promise]);
    hold.release();
    const result = await stop;
    assert.equal(result.document.outcome, 'already-stopped', `${result.stdout}\n${result.stderr}`);
    await sleep(750);
    assert.equal(h.service().starts, 1, 'no launch followed the successful stop');
    assert.equal(launches(h), 1);
    const next = await ready(h);
    assert.notEqual(next.document.instance.instanceId, first.document.instance.instanceId);
    assert.equal(h.service().starts, 2);
    assertNoForcedStop(h);
  });

  test(`${manager}: a failing pending install of an abandoned start leaves nothing to launch`, { skip, timeout: 90_000 }, async t => {
    const h = await createControlledNative(t, manager);
    h.runner.respond(p.install, injectedFailure);
    const hold = holdNth(h.runner, '*', 1);
    const abandoned = await Promise.all([h.start(['--timeout', '1']), hold.reached]).then(([result]) => result);
    assert.equal(abandoned.document.ok, false);
    const stop = h.stop(['--timeout', '30']);
    await sleep(200);
    hold.release();
    const result = await stop;
    assert.equal(result.document.ok, false);
    assert.notEqual(result.document.outcome, 'stopped');
    assert.notEqual(result.document.outcome, 'already-stopped');
    await sleep(750);
    assert.equal(h.service().starts, 0);
    assert.equal(launches(h), 0);
    assertNoForcedStop(h);
  });

  test(`${manager}: a stop whose ordering boundary cannot be recorded is not a success while an abandoned start's install is pending`, { skip: unwritableSkip, timeout: 90_000 }, async t => {
    const { h } = await stoppedService(t, manager);
    const hold = holdNth(h.runner, '*', 1);
    await Promise.all([h.start(['--timeout', '1']), hold.reached]);
    const queued = flag();
    const stop = h.stop(['--timeout', '30'], { dependencies: { progress: text => { if (/waiting for it to finish/.test(text)) queued.fire(); } } });
    await Promise.race([stop.then(() => null), queued.promise]);
    await makeUnwritable(t, h);
    hold.release();
    const result = await stop;
    assert.equal(result.document.ok, false, `${result.stdout}\n${result.stderr}`);
    assert.notEqual(result.document.outcome, 'already-stopped');
    await sleep(750);
    assert.equal(h.service().starts, 1);
    assert.equal(launches(h), 1);
    await makeWritable(h);
    await ready(h);
    assertNoForcedStop(h);
  });

  test(`${manager}: a native launch that was already issued stays unconfirmed and blocks stopped results until it settles`, { skip, timeout: 90_000 }, async t => {
    const { h } = await stoppedService(t, manager);
    const hold = holdNth(h.runner, p.launch, 1);
    const unconfirmed = await Promise.all([h.start(['--timeout', '1']), hold.reached]).then(([result]) => result);
    assert.equal(unconfirmed.document.outcome, 'startup-not-confirmed', `${unconfirmed.stdout}\n${unconfirmed.stderr}`);
    assert.equal(unconfirmed.status, 1);
    // The launch may still land, so a stop must not call the coordinator stopped.
    const blocked = await h.stop(['--timeout', '1']);
    assert.equal(blocked.document.ok, false, `${blocked.stdout}\n${blocked.stderr}`);
    assert.ok(!['stopped', 'already-stopped'].includes(blocked.document.outcome));
    assert.equal(h.service().starts, 1);
    hold.release();
    // Nothing killed or removed the launch: the coordinator comes up and a stop drains it.
    await until(() => h.service().starts === 2, 'the issued launch to land');
    // An explicit start never replaces the earlier record nor issues a second launch; it is a bounded non-success until
    // the launched instance answers, which settles the attempt.
    let next;
    await until(async () => {
      next = await h.start(['--timeout', '60']);
      assert.ok(['ready', 'already-running', 'conflict'].includes(next.document.outcome), `${next.stdout}\n${next.stderr}`);
      return next.document.outcome !== 'conflict';
    }, 'the launched instance to answer an explicit start');
    assert.ok(['ready', 'already-running'].includes(next.document.outcome));
    assert.equal(h.service().starts, 2, 'no second launch was issued');
    const halt = await h.stop(['--timeout', '60']);
    assert.equal(halt.document.outcome, 'stopped', `${halt.stdout}\n${halt.stderr}`);
    assertNoForcedStop(h);
  });
}

test('a start whose stop-ordering record became unreadable while it waited reports an unknown state and launches nothing', { skip, timeout: 60_000 }, async t => {
  const h = await createControlledNative(t, 'launchd');
  const held = await acquireOperationLock(h.stateDirectory, { deadlineAt: Date.now() + 60_000 });
  assert.equal(held.acquired, true);
  t.after(() => held.lock.release());
  const queued = queuedStart();
  const start = h.start(['--timeout', '60'], { dependencies: queued.dependencies });
  await queued.waiting;
  await fs.writeFile(path.join(lifecycleDirectory(h), 'stop-generation.json'), 'not json', { mode: 0o600 });
  held.lock.release();
  queued.open();
  const result = await start;
  assert.equal(result.document.outcome, 'failed', `${result.stdout}\n${result.stderr}`);
  assert.equal(result.document.error.code, 'state-unknown');
  assert.equal(h.service().starts, 0);
  assert.equal(launches(h), 0);
});
