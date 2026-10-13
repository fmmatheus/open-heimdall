import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createSubprocessNative, until } from './fixtures/lifecycle-subprocess-harness.mjs';

/**
 * The requested overall budget bounds the actual life of the lifecycle command, not only the time at which it prints
 * its result. Every case runs the command in its own process (`lifecycle-cli-entry.mjs`) with the production adapters
 * and the production `createExecFileRunner`; the native tool is a synthetic executable that sleeps or waits on a gate
 * file. The subprocess exit is measured from spawn to `close`.
 *
 * Timing contract. `--timeout 1` is a one second budget. A tool call is delayed 4 s, which is what the earlier
 * behaviour waited for (the process exited after about 4.1 s). A command passes when it exits within the budget plus
 * HARNESS_TOLERANCE_MS: process start and module loading (a few hundred ms), the runner's termination grace (at most
 * 500 ms) and scheduling noise on a loaded machine. The sum is well below the delayed tool call, so the earlier
 * behaviour is rejected by a margin of more than one second.
 *
 * Mocked-manager evidence: the synthetic tool is neither launchd nor systemd.
 */

const posix = process.platform !== 'win32';
const skip = posix ? false : 'the synthetic native tool runs POSIX services';
const MANAGERS = ['launchd', 'systemd'];
const BUDGET_MS = 1000;
const HARNESS_TOLERANCE_MS = 1500;
const LIMIT_MS = BUDGET_MS + HARNESS_TOLERANCE_MS;
/** After Ctrl-C there is no budget to wait for: the process must end within this time of the signal. */
const INTERRUPT_LIMIT_MS = 1500;
const TOOL_DELAY_MS = 4000;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const verbsFor = manager => manager === 'launchd'
  ? { first: 'print', inspect: 'print', install: 'bootstrap', start: 'kickstart' }
  : { first: 'show-environment', inspect: 'show', install: 'link', start: 'start' };

const DESTRUCTIVE = ['stop', 'kill', 'bootout', 'restart', 'disable', 'remove', 'unload'];

function describeRun(label, h, handle, extra = {}) {
  return `${label}: ${JSON.stringify({
    elapsedMs: handle.elapsedMs, exit: handle.exitStatus, ...extra,
    toolCalls: h.calls().map(call => `${call.verb}#${call.pid}`), signals: h.signals().map(signal => `${signal.signal}->${signal.verb}#${signal.pid}`),
  })}`;
}

/** The command printed exactly one lifecycle document, it is not a success and the process did not die of a signal. */
function assertOneFailedDocument(result, description) {
  assert.ok(result.document, `${description}: stdout is not exactly one lifecycle document\n${result.stdout}\n${result.stderr}`);
  assert.equal(result.document.ok, false, `${description}: ${result.document.outcome} ${result.document.message}`);
  assert.notEqual(result.status.code, 0, `${description}: exit status`);
  assert.equal(result.status.signal, null, `${description}: the command was killed instead of exiting`);
}

/** Every signal went to a tool client this test's commands started, and never to the coordinator or its supervisor. */
function assertSignalsConfined(h, { except = [] } = {}) {
  const verbOf = new Map(h.calls().map(call => [call.pid, call.verb]));
  const state = h.toolState();
  for (const signal of h.signals()) {
    assert.ok(verbOf.has(signal.pid), `signal ${signal.signal} reached pid ${signal.pid}, which is not a tool call`);
    assert.ok(!except.includes(verbOf.get(signal.pid)), `the ${verbOf.get(signal.pid)} tool call was signalled`);
    assert.notEqual(signal.pid, state.pid, 'the coordinator was signalled');
    assert.notEqual(signal.pid, state.supervisorPid, 'the supervisor was signalled');
  }
  assert.deepEqual(h.violations(), [], 'the synthetic tool refused a verb that could stop, kill or alter the service');
  for (const verb of h.verbs()) assert.ok(!DESTRUCTIVE.includes(verb), `unexpected native verb ${verb}`);
}

async function definitionIdentity(h) {
  try { const stat = await fs.stat(h.definitionPath()); return `${stat.ino}:${stat.mtimeMs}:${stat.size}`; } catch { return null; }
}

/** Samples the owned definition file until the test ends, so any change has a time. */
function watchDefinition(t, h) {
  const samples = [];
  let last;
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    const identity = await definitionIdentity(h);
    if (identity !== last) { samples.push({ at: Date.now(), identity }); last = identity; }
    busy = false;
  }, 10);
  t.after(() => clearInterval(timer));
  return samples;
}

async function recover(h, description) {
  await h.delay(verbsFor(h.manager).inspect, 0);
  await h.delay(verbsFor(h.manager).install, 0);
  const started = await h.start(['--timeout', '60']);
  assert.equal(started.document?.outcome, 'ready', `${description}: a later explicit start works\n${started.stdout}\n${started.stderr}`);
  const stopped = await h.stop(['--timeout', '30']);
  assert.equal(stopped.document?.outcome, 'stopped', `${description}: and stops cleanly\n${stopped.stdout}\n${stopped.stderr}`);
}

for (const manager of MANAGERS) {
  const v = verbsFor(manager);

  test(`${manager}: a start whose installation tool outlasts --timeout exits within the budget`, { skip }, async t => {
    const h = await createSubprocessNative(t, manager);
    await h.delay(v.install, TOOL_DELAY_MS);
    const result = await h.start(['--timeout', '1']);
    t.diagnostic(`${manager} start, ${v.install} delayed ${TOOL_DELAY_MS} ms, budget ${BUDGET_MS} ms, limit ${LIMIT_MS} ms: elapsed ${result.elapsedMs} ms, exit ${JSON.stringify(result.status)}, outcome ${result.document?.outcome}/${result.document?.error?.code}, calls ${h.verbs().join(',')}, signals ${h.signals().map(s => `${s.signal}:${s.verb}`).join(',') || 'none'}`);
    assertOneFailedDocument(result, 'start with a delayed installation');
    assert.ok(result.elapsedMs <= LIMIT_MS, `the command ran ${result.elapsedMs} ms for a ${BUDGET_MS} ms budget (limit ${LIMIT_MS} ms)`);
    assert.equal(result.document.outcome, 'conflict');
    assert.equal(result.document.error.code, 'deadline-exceeded');
    assert.match(result.document.message, /No start was requested and none will be/);
    assert.ok(!h.verbs().includes(v.start), 'no start was requested');
    assert.deepEqual(h.signals().map(signal => signal.verb), [v.install], 'only the installation tool client was ended');
    assertSignalsConfined(h);
    assert.equal(h.readRecord(), null, 'no start was dispatched, so no launch attempt exists');
    await recover(h, 'after the delayed installation');
  });

  test(`${manager}: a start whose manager inspection outlasts --timeout exits within the budget`, { skip }, async t => {
    const h = await createSubprocessNative(t, manager);
    await h.delay(v.inspect, TOOL_DELAY_MS);
    const result = await h.start(['--timeout', '1']);
    t.diagnostic(`${manager} start, ${v.inspect} delayed ${TOOL_DELAY_MS} ms, budget ${BUDGET_MS} ms, limit ${LIMIT_MS} ms: elapsed ${result.elapsedMs} ms, exit ${JSON.stringify(result.status)}, outcome ${result.document?.outcome}/${result.document?.error?.code}, calls ${h.verbs().join(',')}, signals ${h.signals().map(s => `${s.signal}:${s.verb}`).join(',') || 'none'}`);
    assertOneFailedDocument(result, 'start with a delayed inspection');
    assert.ok(result.elapsedMs <= LIMIT_MS, `the command ran ${result.elapsedMs} ms for a ${BUDGET_MS} ms budget (limit ${LIMIT_MS} ms)`);
    assert.equal(result.document.outcome, 'conflict');
    assert.equal(result.document.error.code, 'deadline-exceeded');
    assert.ok(!h.verbs().includes(v.start), 'no start was requested');
    assert.deepEqual(h.signals().map(signal => signal.verb), [v.inspect]);
    assertSignalsConfined(h);
    await recover(h, 'after the delayed inspection');
  });

  test(`${manager}: a stop whose manager inspection outlasts --timeout exits within the budget and leaves the coordinator running`, { skip }, async t => {
    const h = await createSubprocessNative(t, manager);
    const started = await h.start(['--timeout', '60']);
    assert.equal(started.document?.outcome, 'ready', `${started.stdout}\n${started.stderr}`);
    const before = h.toolState();
    await h.delay(v.inspect, TOOL_DELAY_MS);
    const result = await h.stop(['--timeout', '1']);
    t.diagnostic(`${manager} stop, ${v.inspect} delayed ${TOOL_DELAY_MS} ms, budget ${BUDGET_MS} ms, limit ${LIMIT_MS} ms: elapsed ${result.elapsedMs} ms, exit ${JSON.stringify(result.status)}, outcome ${result.document?.outcome}/${result.document?.error?.code}, signals ${h.signals().map(s => `${s.signal}:${s.verb}`).join(',') || 'none'}`);
    assertOneFailedDocument(result, 'stop with a delayed inspection');
    assert.ok(result.elapsedMs <= LIMIT_MS, `the command ran ${result.elapsedMs} ms for a ${BUDGET_MS} ms budget (limit ${LIMIT_MS} ms)`);
    assert.equal(result.document.outcome, 'completion-unknown');
    assert.equal(result.document.error.code, 'deadline-exceeded');
    assert.ok(!['stopped', 'already-stopped', 'stop-requested'].includes(result.document.outcome));
    assert.ok(h.signals().length >= 1 && h.signals().every(signal => signal.verb === v.inspect), 'only the inspection tool client was ended');
    assertSignalsConfined(h);
    const after = h.toolState();
    assert.equal(after.pid, before.pid);
    assert.equal(after.exit, null, 'the coordinator keeps running; nothing was requested of it');
    assert.equal(h.toolAlive(after.pid), true);
    await h.delay(v.inspect, 0);
    const stopped = await h.stop(['--timeout', '30']);
    assert.equal(stopped.document?.outcome, 'stopped', `${stopped.stdout}\n${stopped.stderr}`);
  });

  test(`${manager}: Ctrl-C during a start's installation tool call ends the process promptly with one result`, { skip }, async t => {
    const h = await createSubprocessNative(t, manager);
    await h.gate(v.install);
    const cli = h.spawnStart(['--timeout', '60']);
    const tool = await h.reached(v.install);
    const sentAt = Date.now();
    cli.child.kill('SIGINT');
    await cli.exit;
    const sinceSignal = Date.now() - sentAt;
    t.diagnostic(describeRun(`${manager} start interrupted during ${v.install}`, h, cli, { sinceSignalMs: sinceSignal, limitMs: INTERRUPT_LIMIT_MS, tool }));
    const result = { status: cli.exitStatus, stdout: cli.stdout, stderr: cli.stderr };
    try { result.document = JSON.parse(cli.stdout); } catch { /* reported below */ }
    assert.ok(result.document, `stdout is not exactly one JSON document\n${cli.stdout}`);
    assert.equal(result.document.ok, false);
    assert.equal(result.document.outcome, 'failed');
    assert.equal(result.document.error.code, 'interrupted');
    assert.notEqual(result.status.code, 0);
    assert.equal(result.status.signal, null);
    assert.ok(sinceSignal <= INTERRUPT_LIMIT_MS, `the command took ${sinceSignal} ms to end after Ctrl-C`);
    assert.deepEqual(h.signals().map(signal => ({ verb: signal.verb, pid: signal.pid })), [{ verb: v.install, pid: tool }], 'only the gated tool client was ended');
    assert.equal(h.toolAlive(tool), false);
    assert.ok(!h.verbs().includes(v.start), 'no start was requested');
    assertSignalsConfined(h);
    assert.equal(h.toolState().pid ?? null, null, 'no coordinator was launched');
    await h.ungate(v.install);
    await recover(h, 'after the interrupted installation');
  });

  test(`${manager}: Ctrl-C during a stop's manager inspection ends the process promptly and leaves the coordinator running`, { skip }, async t => {
    const h = await createSubprocessNative(t, manager);
    const started = await h.start(['--timeout', '60']);
    assert.equal(started.document?.outcome, 'ready', `${started.stdout}\n${started.stderr}`);
    const coordinator = h.toolState().pid;
    await h.gate(v.inspect);
    const cli = h.cli('stop', ['--coordinator-config', h.configFile, '--timeout', '60', '--json']);
    const tool = await h.reached(v.inspect);
    const sentAt = Date.now();
    cli.child.kill('SIGINT');
    await cli.exit;
    const sinceSignal = Date.now() - sentAt;
    t.diagnostic(describeRun(`${manager} stop interrupted during ${v.inspect}`, h, cli, { sinceSignalMs: sinceSignal, limitMs: INTERRUPT_LIMIT_MS, tool }));
    let document = null;
    try { document = JSON.parse(cli.stdout); } catch { /* reported below */ }
    assert.ok(document, `stdout is not exactly one JSON document\n${cli.stdout}`);
    assert.equal(document.ok, false);
    assert.equal(document.error.code, 'interrupted');
    assert.ok(!['stopped', 'already-stopped'].includes(document.outcome));
    assert.notEqual(cli.exitStatus.code, 0);
    assert.equal(cli.exitStatus.signal, null);
    assert.ok(sinceSignal <= INTERRUPT_LIMIT_MS, `the command took ${sinceSignal} ms to end after Ctrl-C`);
    assert.deepEqual(h.signals().map(signal => ({ verb: signal.verb, pid: signal.pid })), [{ verb: v.inspect, pid: tool }]);
    assertSignalsConfined(h);
    assert.equal(h.toolState().exit, null);
    assert.equal(h.toolAlive(coordinator), true, 'the coordinator was not signalled');
    await h.ungate(v.inspect);
    const stopped = await h.stop(['--timeout', '30']);
    assert.equal(stopped.document?.outcome, 'stopped', `${stopped.stdout}\n${stopped.stderr}`);
  });

  for (const how of ['timeout', 'interrupt']) {
    // A tool call the command gave up on never turns into a start, and never changes the definition behind another command.
    test(`${manager}: a first tool call released after a ${how} never writes the definition or starts the service`, { skip }, async t => {
      const h = await createSubprocessNative(t, manager);
      await h.gate(v.first);
      const cli = h.spawnStart(how === 'timeout' ? ['--timeout', '1'] : ['--timeout', '60']);
      const tool = await h.reached(v.first);
      if (how === 'interrupt') cli.child.kill('SIGINT');
      await until(() => cli.stdout.trim().endsWith('}'), 'the first command to print its result');
      // Another public lifecycle command begins while the first may still be settling.
      const firstStillRunning = cli.exitStatus === null;
      const second = h.cli('stop', ['--coordinator-config', h.configFile, '--timeout', '10', '--json']);
      await cli.exit;
      await h.ungate(v.first);
      await second.exit;
      await sleep(500);
      t.diagnostic(describeRun(`${manager} pending first call after ${how}`, h, cli, { firstStillRunningWhenSecondBegan: firstStillRunning, secondElapsedMs: second.elapsedMs, definitionWritten: (await definitionIdentity(h)) !== null }));
      const document = JSON.parse(cli.stdout);
      assert.equal(document.ok, false);
      assert.equal(document.error.code, how === 'timeout' ? 'deadline-exceeded' : 'interrupted');
      assert.equal(h.toolAlive(tool), false, 'the released call was ended with the command');
      assert.equal(await definitionIdentity(h), null, 'the late definition write was prevented');
      assert.deepEqual(h.verbs(), [v.first], 'only the gated first tool call ever reached the manager');
      assert.equal(h.readRecord(), null);
      assert.ok(JSON.parse(second.stdout), 'the second command printed one result');
      assertSignalsConfined(h);
    });

    test(`${manager}: an installation tool call released after a ${how} causes no later start and no definition change behind another command`, { skip }, async t => {
      const h = await createSubprocessNative(t, manager);
      const samples = watchDefinition(t, h);
      await h.gate(v.install);
      const cli = h.spawnStart(how === 'timeout' ? ['--timeout', '1'] : ['--timeout', '60']);
      const tool = await h.reached(v.install);
      if (how === 'interrupt') cli.child.kill('SIGINT');
      await until(() => cli.stdout.trim().endsWith('}'), 'the first command to print its result');
      const resultAt = Date.now();
      const firstStillRunning = cli.exitStatus === null;
      const second = h.cli('stop', ['--coordinator-config', h.configFile, '--timeout', '10', '--json']);
      await cli.exit;
      const exitedAt = Date.now();
      const afterExit = await definitionIdentity(h);
      await h.ungate(v.install);
      await second.exit;
      await sleep(600);
      const changesAfterExit = samples.filter(sample => sample.at > exitedAt);
      t.diagnostic(describeRun(`${manager} pending ${v.install} after ${how}`, h, cli, { resultToExitMs: exitedAt - resultAt, firstStillRunningWhenSecondBegan: firstStillRunning, secondElapsedMs: second.elapsedMs, definitionChanges: samples.length, changesAfterFirstExit: changesAfterExit.length }));
      const document = JSON.parse(cli.stdout);
      assert.equal(document.ok, false);
      assert.equal(document.error.code, how === 'timeout' ? 'deadline-exceeded' : 'interrupted');
      assert.equal(h.toolAlive(tool), false, 'the installation tool client was ended with the command');
      assert.ok(!h.verbs().includes(v.start), 'the released installation never turned into a start');
      assert.notEqual(afterExit, null, 'the definition was written before the installation tool ran');
      assert.deepEqual(changesAfterExit, [], 'the definition did not change after the first command ended, nor behind the second command');
      assert.equal(await definitionIdentity(h), afterExit);
      assert.ok(JSON.parse(second.stdout), 'the second command printed one result');
      assert.equal(h.readRecord(), null);
      assertSignalsConfined(h);
    });
  }

  for (const how of ['timeout', 'interrupt']) {
    test(`${manager}: after an already-issued start, a ${how} ends the command without ending the request, and stop claims nothing until it resolves`, { skip }, async t => {
      const h = await createSubprocessNative(t, manager);
      await h.gate(v.start);
      const cli = h.spawnStart(how === 'timeout' ? ['--timeout', '1'] : ['--timeout', '60']);
      const tool = await h.reached(v.start);
      const record = h.readRecord();
      const sentAt = Date.now();
      if (how === 'interrupt') cli.child.kill('SIGINT');
      await cli.exit;
      const sinceSignal = Date.now() - sentAt;
      t.diagnostic(describeRun(`${manager} issued ${v.start} then ${how}`, h, cli, { sinceSignalMs: sinceSignal, budgetMs: how === 'timeout' ? BUDGET_MS : null, limitMs: how === 'timeout' ? LIMIT_MS : INTERRUPT_LIMIT_MS, tool }));
      const document = JSON.parse(cli.stdout);
      assert.equal(document.ok, false);
      assert.equal(document.outcome, 'startup-not-confirmed');
      assert.equal(document.error.code, how === 'timeout' ? 'startup-timeout' : 'interrupted');
      assert.notEqual(cli.exitStatus.code, 0);
      assert.equal(cli.exitStatus.signal, null);
      if (how === 'timeout') assert.ok(cli.elapsedMs <= LIMIT_MS, `the command ran ${cli.elapsedMs} ms for a ${BUDGET_MS} ms budget (limit ${LIMIT_MS} ms)`);
      else assert.ok(sinceSignal <= INTERRUPT_LIMIT_MS, `the command took ${sinceSignal} ms to end after Ctrl-C`);

      // The request is the manager's now: its client was not ended, and the record is what is left of the command.
      assert.equal(h.toolAlive(tool), true, 'the issued start request was not ended');
      assert.deepEqual(h.signals(), [], 'no tool client was signalled');
      assert.ok(record, 'the launch attempt was recorded before the request was issued');
      assert.equal(h.readRecord()?.phase, 'dispatching', 'whether the manager accepted the request is not known');

      const during = await h.stop(['--timeout', '5']);
      assert.ok(during.document, `${during.stdout}\n${during.stderr}`);
      assert.equal(during.document.ok, false);
      assert.equal(during.document.outcome, 'completion-unknown');
      assert.ok(!['stopped', 'already-stopped'].includes(during.document.outcome));
      assert.notEqual(during.status.code, 0);
      assert.ok(h.readRecord(), 'the unresolved attempt is kept');
      assertSignalsConfined(h);

      // The manager lets the request through: the coordinator launches and the attempt resolves by observation.
      await h.ungate(v.start);
      await until(() => !h.toolAlive(tool), 'the released request to finish');
      await h.coordinatorUp();
      const stopped = await h.stop(['--timeout', '30']);
      assert.equal(stopped.document?.outcome, 'stopped', `${stopped.stdout}\n${stopped.stderr}`);
      assert.equal(h.readRecord(), null, 'the authenticated instance resolved the attempt');
      const restarted = await h.start(['--timeout', '60']);
      assert.equal(restarted.document?.outcome, 'ready', `${restarted.stdout}\n${restarted.stderr}`);
      const final = await h.stop(['--timeout', '30']);
      assert.equal(final.document?.outcome, 'stopped', `${final.stdout}\n${final.stderr}`);
      assertSignalsConfined(h);
    });
  }
}
