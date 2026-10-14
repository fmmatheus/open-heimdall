import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSubprocessNative, until } from './fixtures/lifecycle-subprocess-harness.mjs';
import { installPublicationBarrier, deferred } from './fixtures/publication-barrier.mjs';
import { lifecycleCommandMain } from '../dist/coordinator/lifecycle-cli.js';
import { createLaunchdAdapter } from '../dist/coordinator/native/launchd.js';
import { createSystemdAdapter } from '../dist/coordinator/native/systemd.js';
import { createExecFileRunner } from '../dist/coordinator/native/types.js';
import { launchClientRunning } from '../dist/coordinator/lifecycle-launch.js';

/**
 * The publication of a launch attempt's client evidence must not outlive the attempt's ownership.
 *
 * A start records its released client in `launch-attempt.json` while that client waits to be told to run its tool. If
 * the command's deadline passes or Ctrl-C arrives while that publication (the final atomic replacement of the record)
 * is still pending, the attempt ends and releases the serialization; a later attempt may then be admitted and record
 * its own live client. The old, cancelled attempt's publication must then not land at all, or must not change what the
 * newer attempt recorded: the newer record stays intact, names the newer live client and keeps `stop` from claiming a
 * stopped coordinator while that client can still deliver. A start that is serialized behind the old attempt (because the
 * old attempt keeps the operation lock until its publication settled) is admitted after it, with the same outcome.
 *
 * The barrier holds only the old attempt's final rename of `launch-attempt.json` (`fixtures/publication-barrier.mjs`);
 * everything else is production code: the lifecycle command, the adapters, the production `createExecFileRunner`, the
 * record functions and the lock. The native tool is the synthetic executable of `fixtures/synthetic-native-tool.mjs`.
 * Mocked-manager evidence: neither launchd nor systemd is operated.
 *
 * The cases collect their observations and report them with `t.diagnostic` before asserting, so a failing run shows
 * what the record held and what `stop` claimed.
 */

const posix = process.platform !== 'win32';
const skip = posix ? false : 'the synthetic native tool runs POSIX services';
const MANAGERS = ['launchd', 'systemd'];
const BUDGET_MS = 1000;
const HARNESS_TOLERANCE_MS = 1500;
const LIMIT_MS = BUDGET_MS + HARNESS_TOLERANCE_MS;
/** After Ctrl-C there is no budget to wait for: the command must end within this time of the signal. */
const INTERRUPT_LIMIT_MS = 1500;
const STOP_CLAIMS = ['stopped', 'already-stopped', 'stop-requested'];
const DESTRUCTIVE = ['stop', 'kill', 'bootout', 'restart', 'disable', 'remove', 'unload'];

const count = (h, verb) => h.verbs().filter(entry => entry === verb).length;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** A finite wait: the promise, or a failure naming what did not happen. */
const within = (promise, milliseconds, what) => {
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not happen within ${milliseconds} ms`)), milliseconds); });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
};

/** An owned inactive definition with a correlated previous clean shutdown. */
async function cleanShutdown(h) {
  const started = await h.start(['--timeout', '60']);
  assert.equal(started.document?.outcome, 'ready', `${started.stdout}\n${started.stderr}`);
  const stopped = await h.stop(['--timeout', '30']);
  assert.equal(stopped.document?.outcome, 'stopped', `${stopped.stdout}\n${stopped.stderr}`);
  assert.equal(h.readRecord(), null, 'a start that was confirmed ready leaves no unresolved attempt');
}

/**
 * The production `start` command, run inside this process with the production adapter and runner over the fixture's
 * synthetic tool (the same wiring `fixtures/lifecycle-cli-entry.mjs` gives a separate process).
 */
async function startInProcess(h, args, signals) {
  const fixture = JSON.parse(fs.readFileSync(path.join(h.root, 'fixture.json'), 'utf8'));
  const createAdapter = context => fixture.manager === 'launchd'
    ? { supported: true, manager: 'launchd', adapter: createLaunchdAdapter({ context, runner: createExecFileRunner(), uid: fixture.uid, launchctl: fixture.tool }) }
    : {
      supported: true,
      manager: 'systemd',
      adapter: createSystemdAdapter({
        context,
        runner: createExecFileRunner(),
        systemctl: fixture.tool,
        environment: { XDG_RUNTIME_DIR: fixture.runtimeDirectory, DBUS_SESSION_BUS_ADDRESS: `unix:path=${fixture.runtimeDirectory}/bus`, XDG_CONFIG_HOME: fixture.configHome },
      }),
    };
  const output = { stdout: '', stderr: '' };
  const startedAt = Date.now();
  const status = await lifecycleCommandMain('start', ['--coordinator-config', h.configFile, '--env-file', h.credentialFile, '--json', ...args], {
    signals,
    streams: { stdout: { write: text => { output.stdout += text; } }, stderr: { write: text => { output.stderr += text; } } },
    dependencies: {
      environment: { HOME: fixture.home, OPENCHAMBER_DATA_DIR: fixture.openchamber },
      platform: fixture.manager === 'launchd' ? 'darwin' : 'linux',
      createAdapter,
      launchOverrides: { nodeExecutable: process.execPath, entryPoint: fixture.entryPoint },
      pollIntervalMs: 20,
      requestTimeoutMs: 3000,
      progress: () => undefined,
    },
  });
  let document = null;
  try { document = JSON.parse(output.stdout); } catch { /* reported by the caller's assertion */ }
  return { status, document, stdout: output.stdout, stderr: output.stderr, elapsedMs: Date.now() - startedAt };
}

/**
 * The first start, with the publication of its client record held. `how`:
 *   timeout   - in this process; the command's own `--timeout 1` deadline passes while the publication is held
 *   interrupt - in this process; Ctrl-C (an AbortSignal through the command's signal handling) arrives while it is held
 *   cli       - in a separate CLI process; the `--timeout 1` deadline passes while the publication is held
 *   kill      - in a separate CLI process; the process is killed while the publication is held
 */
async function startWithHeldPublication(t, h, how) {
  if (how === 'timeout' || how === 'interrupt') {
    const reached = deferred();
    const gate = deferred();
    const landed = deferred();
    const barrier = installPublicationBarrier({
      recordFile: h.recordFile(),
      wait: async published => { reached.resolve(published); await gate.promise; },
      after: async () => { landed.resolve(); },
    });
    t.after(() => { gate.resolve(); barrier.restore(); });
    const signals = new EventEmitter();
    const result = startInProcess(h, ['--timeout', how === 'timeout' ? String(BUDGET_MS / 1000) : '60'], signals);
    const published = await within(reached.promise, 20_000, 'the first start to publish its client record');
    return {
      published, result,
      interrupt: () => signals.emit('SIGINT'),
      release: () => gate.resolve(),
      landed: () => within(landed.promise, 20_000, 'the held publication to be carried out'),
    };
  }
  await h.holdPublication();
  const startedAt = Date.now();
  const command = h.spawnHeldStart(['--timeout', how === 'cli' ? String(BUDGET_MS / 1000) : '60']);
  const { published } = await h.reachedPublication();
  const result = (async () => {
    // The process stays alive while its publication is held; its result is complete once it printed its one document.
    const stdout = await until(() => { try { JSON.parse(command.stdout); return command.stdout; } catch { return null; } }, 'the held start to print its result', 30_000);
    return { document: JSON.parse(stdout), stdout, stderr: command.stderr, elapsedMs: Date.now() - startedAt };
  })();
  // A start that is killed prints nothing; its observer must not outlive the test as an unhandled rejection.
  result.catch(() => undefined);
  return {
    published, result, command,
    release: () => h.releasePublication(),
    landed: () => h.landedPublication(),
  };
}

for (const manager of MANAGERS) {
  for (const how of ['timeout', 'interrupt', 'cli']) {
    const describe = {
      timeout: 'the first start reaches its --timeout 1 deadline (in process)',
      interrupt: 'Ctrl-C ends the first start (in process)',
      cli: 'the first start, in its own CLI process, reaches its --timeout 1 deadline',
    }[how];

    test(`${manager}: while the first start's client publication is held and ${describe}, a newer attempt's live client record is not overwritten, removed or left unprotected`, { skip, timeout: 120_000 }, async t => {
      const h = await createSubprocessNative(t, manager);
      await cleanShutdown(h);
      const startsBefore = count(h, h.startVerb);
      const coordinatorStartsBefore = h.toolState().starts;
      const problems = [];
      const check = (condition, message) => { if (!condition) problems.push(message); };

      // 1. The first start publishes its client record; the final rename of launch-attempt.json is held.
      const first = await startWithHeldPublication(t, h, how);
      assert.ok(first.published.attemptId, 'the held publication names its attempt');
      assert.ok(first.published.client?.pid > 1, 'the held publication names the first start\'s client');
      assert.equal(first.published.phase, 'dispatching');

      // 2. The first start ends while the publication is pending: by its deadline or by Ctrl-C.
      let interruptedAt = null;
      if (how === 'interrupt') { interruptedAt = Date.now(); first.interrupt(); }
      const ended = await within(first.result, LIMIT_MS + 5_000, 'the first start to end');
      const firstEvidence = { how, outcome: ended.document?.outcome ?? null, errorCode: ended.document?.error?.code ?? null, ok: ended.document?.ok ?? null, elapsedMs: ended.elapsedMs, sinceInterruptMs: interruptedAt === null ? null : Date.now() - interruptedAt };
      check(ended.document !== null, `the first start printed no lifecycle document\n${ended.stdout}\n${ended.stderr}`);
      check(ended.document?.ok === false, `the first start ended ok=${ended.document?.ok}; it never reached the manager`);
      if (how === 'interrupt') check(Date.now() - interruptedAt <= INTERRUPT_LIMIT_MS, `the first start took ${Date.now() - interruptedAt} ms to end after Ctrl-C`);
      else check(ended.elapsedMs <= LIMIT_MS, `the first start ran ${ended.elapsedMs} ms for a ${BUDGET_MS} ms budget (limit ${LIMIT_MS} ms)`);
      check(count(h, h.startVerb) === startsBefore, 'the first start\'s client reached the manager although its publication never completed');

      // 3. A second start is admitted. It either records its own live client straight away, or it is serialized behind
      //    the first attempt until that attempt's publication has settled. A held client does not deliver yet.
      await h.predeliver(h.startVerb);
      const second = h.spawnStart(['--timeout', '60']);
      const admitted = await until(
        () => h.reachedPredeliverAll(h.startVerb).length > 0 ? 'its live client is recorded' : /Another lifecycle operation is running/.test(second.stderr) ? 'it waits behind the first attempt' : null,
        'the second start to be admitted or to wait for the first attempt', 20_000);
      const whileHeld = h.readRecord();

      // 4. The old publication is released and lands (or is refused); then the second client must be recorded and held.
      await first.release();
      await first.landed();
      const client = await h.reachedPredeliver(h.startVerb);
      const record = h.readRecord();
      const settled = await sleep(300).then(() => h.readRecord());

      const recordEvidence = (value) => value === null ? null : { attemptId: value.attemptId === first.published.attemptId ? 'the first (cancelled) attempt\'s' : 'another attempt\'s', phase: value.phase, clientPid: value.client?.pid ?? null, clientRunning: value.client ? launchClientRunning(value.client) : null };
      check(record !== null, 'the newer attempt\'s record is gone after the old publication was released: its live client is no longer protected');
      check(record?.attemptId !== first.published.attemptId, 'the old, cancelled attempt\'s publication replaced the newer attempt\'s record');
      check(record?.phase === 'dispatching', `the record of the attempt whose client is held is ${record?.phase ?? 'absent'}`);
      check(record?.client !== undefined && launchClientRunning(record.client), 'the record names no running client');
      check(record?.client !== undefined && h.processGroup(client) === record.client.pid, `the held client ${client} (process group ${h.processGroup(client)}) is not the client the record names (${record?.client?.pid ?? 'none'})`);
      if (whileHeld !== null && whileHeld.attemptId !== first.published.attemptId) {
        check(record?.attemptId === whileHeld.attemptId, 'the record that named the second attempt\'s live client was replaced when the old publication landed');
        check(JSON.stringify(record?.client) === JSON.stringify(whileHeld.client), 'the second attempt\'s recorded client changed when the old publication landed');
      }
      check(settled?.attemptId === record?.attemptId && JSON.stringify(settled?.client) === JSON.stringify(record?.client), 'the record changed after the old publication settled');
      check(h.toolAlive(client), 'the second attempt\'s held client was disturbed');
      check(second.exitStatus === null, `the second start ended early with ${JSON.stringify(second.exitStatus)}: ${second.stdout}`);

      // 5. The second start is killed (its client is not) so it no longer holds the operation lock. While the second
      //    client can still deliver, `stop` claims nothing.
      second.child.kill('SIGKILL');
      await within(second.exit, 10_000, 'the killed second start to end');
      check(h.toolAlive(client), 'the second attempt\'s held client ended with its command');
      const stops = [];
      for (const [name, args] of [['stop', ['--timeout', '5']], ['stop (repeated)', ['--timeout', '5']], ['stop --no-wait', ['--no-wait']]]) {
        const result = await h.stop(args);
        stops.push({ name, outcome: result.document?.outcome ?? null, errorCode: result.document?.error?.code ?? null, exitCode: result.status.code, clientAlive: h.toolAlive(client), record: h.readRecord()?.phase ?? null });
        check(result.document !== null, `${name}: no lifecycle document\n${result.stdout}\n${result.stderr}`);
        check(!STOP_CLAIMS.includes(result.document?.outcome), `${name}: claimed ${result.document?.outcome} while the second attempt's client is held and can still deliver`);
        check(result.document?.ok === false, `${name}: ok is ${result.document?.ok}`);
        check(result.status.code !== 0, `${name}: exit status ${result.status.code}`);
        check(h.readRecord()?.attemptId === record?.attemptId, `${name}: the second attempt's record was removed or replaced`);
      }

      // 6. The held client is released and delivers late: exactly one launch, which settles the attempt.
      await h.release(h.startVerb);
      await until(() => !h.toolAlive(client), 'the released client to finish');
      const delivered = count(h, h.startVerb) - startsBefore;
      const up = await h.coordinatorUp().then(() => true, () => false);
      const coordinatorStarts = h.toolState().starts - coordinatorStartsBefore;
      check(delivered === 1, `the released client delivered ${delivered} start calls`);
      check(up && coordinatorStarts === 1, `the late delivery launched the coordinator ${coordinatorStarts} times (running: ${up})`);
      let finalOutcome = null;
      if (up) {
        const final = await h.stop(['--timeout', '30']);
        finalOutcome = final.document?.outcome ?? null;
        check(finalOutcome === 'stopped', `the stop that followed the late launch returned ${finalOutcome}\n${final.stdout}\n${final.stderr}`);
        check(h.readRecord() === null, 'the authenticated instance did not resolve the attempt');
      }
      check(h.violations().length === 0, `the synthetic tool refused verbs: ${JSON.stringify(h.violations())}`);
      check(h.signals().length === 0, `tool calls were signalled: ${JSON.stringify(h.signals())}`);
      check(!h.verbs().some(verb => DESTRUCTIVE.includes(verb)), 'a destructive native verb was called');

      t.diagnostic(`${manager} client publication held, ${how}: ${JSON.stringify({
        first: firstEvidence, secondAdmission: admitted,
        recordWhileOldPublicationHeld: recordEvidence(whileHeld), recordAfterOldPublicationLanded: recordEvidence(record),
        stops, afterRelease: { delivered, coordinatorLaunches: coordinatorStarts, finalStop: finalOutcome },
      })}`);
      assert.deepEqual(problems, []);
    });
  }

  test(`${manager}: while the first start's client publication is held and its CLI process is killed, the client never runs its tool and a later start recovers`, { skip, timeout: 120_000 }, async t => {
    const h = await createSubprocessNative(t, manager);
    await cleanShutdown(h);
    const startsBefore = count(h, h.startVerb);
    const coordinatorStartsBefore = h.toolState().starts;
    const problems = [];
    const check = (condition, message) => { if (!condition) problems.push(message); };

    await h.predeliver(h.startVerb);
    const first = await startWithHeldPublication(t, h, 'kill');
    const clients = h.startClients();
    assert.equal(clients.length, 1, 'the first start released one client, which is waiting to be told to run its tool');
    first.command.child.kill('SIGKILL');
    await within(first.command.exit, 10_000, 'the killed start to end');

    // The caller died with the publication pending: nothing recorded the client, so nothing may tell it to run.
    await until(() => clients.every(pid => !h.toolAlive(pid)), 'the orphaned start client to end without running its tool');
    check(h.reachedPredeliverAll(h.startVerb).length === 0, 'the start client ran its tool although its command died before the client was recorded');
    check(count(h, h.startVerb) === startsBefore, 'the start client reached the manager');
    check(h.toolState().starts === coordinatorStartsBefore, 'the coordinator was launched');
    check(h.inflight().length === 0, 'a start request is in flight');

    // The death left no client that could deliver, so recovery is possible: the next explicit start launches the coordinator once.
    await h.releasePublication();
    await h.release(h.startVerb);
    const later = await h.start(['--timeout', '60']);
    check(later.document?.outcome === 'ready', `a start after the caller died returned ${later.document?.outcome}\n${later.stdout}\n${later.stderr}`);
    check(h.readRecord() === null, 'the recovered start left an unresolved attempt');
    check(count(h, h.startVerb) - startsBefore === 1, `${count(h, h.startVerb) - startsBefore} start calls reached the manager`);
    check(h.toolState().starts - coordinatorStartsBefore === 1, 'the coordinator was not launched exactly once');
    const stopped = await h.stop(['--timeout', '30']);
    check(stopped.document?.outcome === 'stopped', `the final stop returned ${stopped.document?.outcome}`);
    check(h.violations().length === 0 && h.signals().length === 0, 'the synthetic tool refused verbs or was signalled');
    assert.deepEqual(problems, []);
  });
}
