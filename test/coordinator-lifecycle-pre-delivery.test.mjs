import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubprocessNative, until } from './fixtures/lifecycle-subprocess-harness.mjs';

/**
 * A start request whose client has not delivered it to the manager yet. The production runner lets a native start
 * client outlive the lifecycle command that spawned it, so the command can end (deadline, Ctrl-C, kill) while its client
 * is still on its way to the manager: the manager has no job queued, nothing reports the request, and the client can
 * still deliver it and launch the service afterwards. `stop` must not claim `stopped`, `already-stopped` or
 * `stop-requested` while that client may still deliver.
 *
 * Every lifecycle command runs in its own process (`lifecycle-cli-entry.mjs`) with the production adapters and the
 * production `createExecFileRunner`; the native tool is the synthetic executable of
 * `test/fixtures/synthetic-native-tool.mjs`, whose `predeliver/<verb>` control holds a starting call before it is
 * recorded, marked in flight or visible as a queued job. Each case starts from an owned inactive definition with a
 * correlated clean shutdown (start, ready, stop, stopped), holds the next start, ends the invoking command in one of
 * three ways, runs `stop` from other processes while the client is still held, and then releases the client.
 *
 * Expectation: while the held client is alive no `stop` returns a success claim. The cases collect their observations
 * and report them with `t.diagnostic` before asserting, so a failing run still shows the outcomes, the elapsed time of
 * the invoking command and what remained of the attempt.
 *
 * Mocked-manager evidence: the synthetic tool is neither launchd nor systemd. `systemd` is the manager whose
 * start-job probe reports the held client as "no job queued"; `launchd` has no such probe and keeps its record
 * unresolved.
 */

const posix = process.platform !== 'win32';
const skip = posix ? false : 'the synthetic native tool runs POSIX services';
const MANAGERS = ['launchd', 'systemd'];
const BUDGET_MS = 1000;
const HARNESS_TOLERANCE_MS = 1500;
const LIMIT_MS = BUDGET_MS + HARNESS_TOLERANCE_MS;
/** After Ctrl-C there is no budget to wait for: the process must end within this time of the signal. */
const INTERRUPT_LIMIT_MS = 1500;
const STOP_CLAIMS = ['stopped', 'already-stopped', 'stop-requested'];
const DESTRUCTIVE = ['stop', 'kill', 'bootout', 'restart', 'disable', 'remove', 'unload'];

const count = (h, verb) => h.verbs().filter(entry => entry === verb).length;

/** An owned inactive definition with a correlated previous clean shutdown. */
async function cleanShutdown(h) {
  const started = await h.start(['--timeout', '60']);
  assert.equal(started.document?.outcome, 'ready', `${started.stdout}\n${started.stderr}`);
  const stopped = await h.stop(['--timeout', '30']);
  assert.equal(stopped.document?.outcome, 'stopped', `${stopped.stdout}\n${stopped.stderr}`);
  assert.equal(h.readRecord(), null, 'a start that was confirmed ready leaves no unresolved attempt');
}

for (const manager of MANAGERS) {
  test(`${manager}: the pre-delivery hold keeps a start request from the manager until it is released`, { skip }, async t => {
    const h = await createSubprocessNative(t, manager);
    const startsBefore = count(h, h.startVerb);
    await h.predeliver(h.startVerb);
    const invoking = h.spawnStart(['--timeout', '60']);
    const client = await h.reachedPredeliver(h.startVerb);

    // Held: the client exists, but the manager has not received anything from it.
    assert.equal(h.toolAlive(client), true);
    assert.deepEqual(h.inflight(), [], 'no request is marked in flight');
    assert.equal(count(h, h.startVerb), startsBefore, 'the start call is not recorded');
    if (manager === 'systemd') assert.equal(await h.showJob(), '', 'the manager reports no queued job');
    assert.equal(h.readRecord()?.phase, 'dispatching', 'the command recorded the attempt before it asked the manager');
    assert.equal(h.toolState().pid ?? null, null, 'nothing launched the service');
    assert.equal(invoking.exitStatus, null, 'the invoking command is still waiting');

    // Released: an ordinary call. With its own gate it is now received, in flight and visible as a queued job.
    await h.gate(h.startVerb);
    await h.release(h.startVerb);
    assert.equal(await h.reached(h.startVerb), client, 'the held client is the one that delivers');
    assert.deepEqual(h.inflight(), [client], 'the released request is marked in flight');
    assert.equal(count(h, h.startVerb), startsBefore + 1);
    if (manager === 'systemd') assert.equal(await h.showJob(), 'Job=1\n', 'the manager now reports a queued job');
    assert.equal(h.toolState().pid ?? null, null, 'still not launched while the request is held on its gate');

    await h.ungate(h.startVerb);
    const status = await invoking.exit;
    assert.equal(status.code, 0, `${invoking.stdout}\n${invoking.stderr}`);
    assert.equal(JSON.parse(invoking.stdout).outcome, 'ready');
    assert.equal(h.toolState().starts, 1, 'the delivered request launched the coordinator once');
    assert.deepEqual(h.inflight(), []);
    const stopped = await h.stop(['--timeout', '30']);
    assert.equal(stopped.document?.outcome, 'stopped', `${stopped.stdout}\n${stopped.stderr}`);
    assert.deepEqual(h.violations(), []);
    assert.deepEqual(h.signals(), []);
  });

  for (const how of ['timeout', 'interrupt', 'kill']) {
    const describe = {
      timeout: 'the invoking start ends at its --timeout 1 deadline',
      interrupt: 'Ctrl-C ends the invoking start',
      kill: 'the invoking start is killed (its client is not)',
    }[how];

    test(`${manager}: while a start client is held before delivery and ${describe}, stop claims nothing`, { skip }, async t => {
      const h = await createSubprocessNative(t, manager);
      await cleanShutdown(h);
      const startsBefore = count(h, h.startVerb);
      const coordinatorStartsBefore = h.toolState().starts;
      const problems = [];
      const check = (condition, message) => { if (!condition) problems.push(message); };

      await h.predeliver(h.startVerb);
      const invoking = h.spawnStart(how === 'timeout' ? ['--timeout', '1'] : ['--timeout', '60']);
      const client = await h.reachedPredeliver(h.startVerb);
      assert.equal(h.toolAlive(client), true);
      assert.deepEqual(h.inflight(), [], 'the held client has not delivered: no request in flight');
      assert.equal(count(h, h.startVerb), startsBefore, 'the held client has not delivered: the call is not recorded');
      if (manager === 'systemd') assert.equal(await h.showJob(), '', 'the held client has not delivered: no queued job');
      const record = h.readRecord();
      assert.equal(record?.phase, 'dispatching', 'the attempt is recorded before the manager is asked to start');
      assert.equal(record.manager, manager);
      assert.equal(record.label, h.label);

      // End the invoking command. Only its own process is signalled; the detached client keeps running.
      const sentAt = Date.now();
      if (how === 'interrupt') invoking.child.kill('SIGINT');
      if (how === 'kill') invoking.child.kill('SIGKILL');
      const exit = await invoking.exit;
      const sinceSignalMs = Date.now() - sentAt;
      let document = null;
      try { document = JSON.parse(invoking.stdout); } catch { /* reported below */ }
      const invokingEvidence = { how, elapsedMs: invoking.elapsedMs, sinceSignalMs: how === 'timeout' ? null : sinceSignalMs, exit, outcome: document?.outcome ?? null, errorCode: document?.error?.code ?? null };
      if (how === 'kill') {
        assert.equal(exit.signal, 'SIGKILL');
        assert.equal(invoking.stdout, '', 'a killed command prints nothing');
      } else {
        assert.ok(document, `stdout is not exactly one JSON document\n${invoking.stdout}`);
        assert.equal(document.ok, false);
        assert.equal(document.outcome, 'startup-not-confirmed');
        assert.equal(document.error.code, how === 'timeout' ? 'startup-timeout' : 'interrupted');
        assert.notEqual(exit.code, 0);
        assert.equal(exit.signal, null, 'the command exited instead of dying of a signal');
        if (how === 'timeout') assert.ok(invoking.elapsedMs <= LIMIT_MS, `the command ran ${invoking.elapsedMs} ms for a ${BUDGET_MS} ms budget (limit ${LIMIT_MS} ms)`);
        else assert.ok(sinceSignalMs <= INTERRUPT_LIMIT_MS, `the command took ${sinceSignalMs} ms to end after Ctrl-C`);
      }

      // What the command leaves behind: the client is still held and still alive, and the attempt is still recorded.
      assert.equal(h.toolAlive(client), true, 'the held client outlives the invoking command');
      assert.deepEqual(h.signals(), [], 'the client was not signalled');
      assert.equal(h.readRecord()?.phase, 'dispatching', 'whether the manager will ever receive the request is not known');
      assert.deepEqual(h.inflight(), []);

      // Another process asks to stop while the client can still deliver.
      const stops = [];
      for (const [name, args] of [['stop', ['--timeout', '5']], ['stop (repeated)', ['--timeout', '5']], ['stop --no-wait', ['--no-wait']]]) {
        const result = await h.stop(args);
        stops.push({
          name, outcome: result.document?.outcome ?? null, errorCode: result.document?.error?.code ?? null, ok: result.document?.ok ?? null,
          exitCode: result.status.code, elapsedMs: result.elapsedMs, clientAlive: h.toolAlive(client), record: h.readRecord()?.phase ?? null,
        });
        check(result.document !== null, `${name}: no lifecycle document\n${result.stdout}\n${result.stderr}`);
        check(!STOP_CLAIMS.includes(result.document?.outcome), `${name}: claimed ${result.document?.outcome} while the held client is alive and can still deliver`);
        check(result.document?.ok === false, `${name}: ok is ${result.document?.ok}`);
        check(result.status.code !== 0, `${name}: exit status ${result.status.code}`);
      }
      const afterStops = { clientAlive: h.toolAlive(client), record: h.readRecord()?.phase ?? null, inflight: h.inflight().length, startCalls: count(h, h.startVerb) - startsBefore };

      // The client is released and delivers late.
      await h.release(h.startVerb);
      await until(() => !h.toolAlive(client), 'the released client to finish');
      const delivered = count(h, h.startVerb) - startsBefore;
      const up = await h.coordinatorUp().then(() => true, () => false);
      const coordinatorStarts = h.toolState().starts - coordinatorStartsBefore;
      const claimed = stops.some(entry => STOP_CLAIMS.includes(entry.outcome));
      check(delivered === 1, `the released client delivered ${delivered} start calls`);
      check(up && coordinatorStarts === 1, `the late delivery launched the coordinator ${coordinatorStarts} times (running: ${up})`);
      let finalOutcome = null;
      if (up) {
        const final = await h.stop(['--timeout', '30']);
        finalOutcome = final.document?.outcome ?? null;
        check(finalOutcome === 'stopped', `the stop that followed the late launch returned ${finalOutcome}\n${final.stdout}\n${final.stderr}`);
        check(h.readRecord() === null, 'the authenticated instance resolved the attempt');
      }
      const signals = h.signals().map(signal => `${signal.signal}->${signal.verb}`);
      check(h.violations().length === 0, `the synthetic tool refused verbs: ${JSON.stringify(h.violations())}`);
      check(signals.length === 0, `tool calls were signalled: ${signals.join(',')}`);
      check(!h.verbs().some(verb => DESTRUCTIVE.includes(verb)), 'a destructive native verb was called');

      t.diagnostic(`${manager} start held before delivery, ${how}: ${JSON.stringify({
        invoking: invokingEvidence, limitMs: how === 'timeout' ? LIMIT_MS : how === 'interrupt' ? INTERRUPT_LIMIT_MS : null,
        attemptBeforeStops: { phase: record.phase, ownerPidIsInvokingCommand: record.ownerPid === invoking.pid },
        stops, afterStops, stopClaimedWhileClientHeld: claimed,
        afterRelease: { clientDelivered: delivered, coordinatorLaunchedLate: up && coordinatorStarts === 1, coordinatorLaunchedAfterStopClaim: claimed && up && coordinatorStarts === 1, finalStop: finalOutcome },
      })}`);
      assert.deepEqual(problems, []);
    });
  }
}
