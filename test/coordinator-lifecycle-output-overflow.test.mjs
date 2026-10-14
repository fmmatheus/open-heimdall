import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createSubprocessNative, until } from './fixtures/lifecycle-subprocess-harness.mjs';
import { launchClientRunning } from '../dist/coordinator/lifecycle-launch.js';

/**
 * A start client that overflows its output bound must not lose the protection of what it left behind.
 *
 * The production runner reads the output of a released start client (its launcher and the native tool the launcher
 * runs). When a stream passes the runner's bound it stops reading. That ends the runner's interest in the launcher, not
 * the tool: the tool is a separate process of the same detached group, holding the request it has not delivered yet,
 * and it can still reach the manager afterwards. The overflow is therefore not proof that no start request exists. The
 * attempt's record must keep protecting the client, `start` must not answer with a definitive failure, and `stop` must
 * not claim `stopped`, `already-stopped` or `stop-requested` while the launcher or the tool can still deliver. Another
 * explicit start must neither replace that evidence nor add a second request.
 *
 * Each case floods one stream (`stdout` or `stderr`) with more than two MiB before the tool is held on its pre-delivery
 * gate (`flood/<verb>` of `fixtures/synthetic-native-tool.mjs`), so the overflow happens on that stream independently of
 * the other. The launcher and the tool are tracked separately: whichever is still alive counts. The lifecycle commands
 * run in their own CLI processes (`fixtures/lifecycle-cli-entry.mjs`) with the production adapters, runner and record
 * functions. Mocked-manager evidence: neither launchd nor systemd is operated.
 *
 * The cases collect their observations and report them with `t.diagnostic` before asserting, so a failing run shows
 * what `start` and `stop` claimed and what was still alive.
 */

const posix = process.platform !== 'win32';
const skip = posix ? false : 'the synthetic native tool runs POSIX services';
const MANAGERS = ['launchd', 'systemd'];
const STREAMS = ['stdout', 'stderr'];
const BUDGET_MS = 2000;
const HARNESS_TOLERANCE_MS = 1500;
const LIMIT_MS = BUDGET_MS + HARNESS_TOLERANCE_MS;
const STOP_CLAIMS = ['stopped', 'already-stopped', 'stop-requested'];
const DESTRUCTIVE = ['stop', 'kill', 'bootout', 'restart', 'disable', 'remove', 'unload'];

const count = (h, verb) => h.verbs().filter(entry => entry === verb).length;
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** An owned inactive definition with a correlated previous clean shutdown. */
async function cleanShutdown(h) {
  const started = await h.start(['--timeout', '60']);
  assert.equal(started.document?.outcome, 'ready', `${started.stdout}\n${started.stderr}`);
  const stopped = await h.stop(['--timeout', '30']);
  assert.equal(stopped.document?.outcome, 'stopped', `${stopped.stdout}\n${stopped.stderr}`);
  assert.equal(h.readRecord(), null, 'a start that was confirmed ready leaves no unresolved attempt');
}

for (const manager of MANAGERS) {
  for (const stream of STREAMS) {
    test(`${manager}: a start client whose ${stream} overflows the output bound keeps its launcher and tool protected while the tool can still deliver`, { skip, timeout: 120_000 }, async t => {
      const h = await createSubprocessNative(t, manager);
      await cleanShutdown(h);
      const startsBefore = count(h, h.startVerb);
      const coordinatorStartsBefore = h.toolState().starts;
      const problems = [];
      const check = (condition, message) => { if (!condition) problems.push(message); };

      // 1. The start's client floods `stream` and then waits, as a tool whose request the manager has not received yet.
      await h.flood(h.startVerb, stream);
      await h.predeliver(h.startVerb);
      const first = h.spawnStart(['--timeout', String(BUDGET_MS / 1000)]);
      const tool = await h.reachedPredeliver(h.startVerb);
      // The client is a detached process group led by its launcher, so the group of the held tool names the launcher. The
      // overflow may already have ended the launcher by now; the group id still identifies it.
      const launcher = h.processGroup(tool);
      assert.ok(launcher !== null && launcher !== tool && launcher !== process.pid && launcher > 1, `the held tool (${tool}) belongs to the process group ${launcher} of its launcher`);
      const launchers = [launcher];

      // 2. The command ends within its budget; the overflow must not turn into a definitive answer.
      const exit = await Promise.race([first.exit, new Promise(resolve => setTimeout(() => resolve(null), LIMIT_MS + 20_000))]);
      check(exit !== null, 'the first start did not end');
      let document = null;
      try { document = JSON.parse(first.stdout); } catch { /* reported below */ }
      check(document !== null, `the first start printed no lifecycle document\n${first.stdout}\n${first.stderr}`);
      check(first.elapsedMs === null || first.elapsedMs <= LIMIT_MS, `the first start ran ${first.elapsedMs} ms for a ${BUDGET_MS} ms budget (limit ${LIMIT_MS} ms)`);
      const toolAlive = alive(tool);
      const launcherAlive = launchers.some(alive);
      const record = h.readRecord();
      const anythingCanDeliver = toolAlive || launcherAlive;
      check(count(h, h.startVerb) === startsBefore, 'a request reached the manager although the tool is held');
      if (anythingCanDeliver) {
        check(document?.outcome !== 'failed', `start answered ${document?.outcome} (${document?.error?.code ?? 'no code'}): the overflow was taken as proof that nothing can deliver, but the ${toolAlive ? 'tool' : 'launcher'} is alive`);
        check(document?.ok === false, `start ok is ${document?.ok}`);
        check(record !== null, 'the attempt record was cleared while the launcher or the tool can still deliver');
        check(record?.client !== undefined && launchClientRunning(record.client), 'the record names no client group that is still running');
      }

      // 3. `stop`, repeated and without waiting, claims nothing while anything can still deliver.
      const stops = [];
      for (const [name, args] of [['stop', ['--timeout', '5']], ['stop (repeated)', ['--timeout', '5']], ['stop --no-wait', ['--no-wait']]]) {
        if (!(alive(tool) || launchers.some(alive))) break;
        const result = await h.stop(args);
        stops.push({ name, outcome: result.document?.outcome ?? null, errorCode: result.document?.error?.code ?? null, exitCode: result.status.code, toolAlive: alive(tool), launcherAlive: launchers.some(alive), record: h.readRecord()?.phase ?? null });
        check(result.document !== null, `${name}: no lifecycle document\n${result.stdout}\n${result.stderr}`);
        if (alive(tool) || launchers.some(alive)) {
          check(!STOP_CLAIMS.includes(result.document?.outcome), `${name}: claimed ${result.document?.outcome} while the ${alive(tool) ? 'tool' : 'launcher'} can still deliver`);
          check(result.document?.ok === false, `${name}: ok is ${result.document?.ok}`);
          check(result.status.code !== 0, `${name}: exit status ${result.status.code}`);
          check(h.readRecord() !== null, `${name}: the attempt record was removed`);
        }
      }

      // 4. Another explicit start replaces nothing and adds no second request while anything can still deliver.
      let second = null;
      if (alive(tool) || launchers.some(alive)) {
        fs.rmSync(path.join(h.managerDirectory, 'flood', h.startVerb), { force: true });
        const recordBefore = h.readRecord();
        const result = await h.start(['--timeout', String(BUDGET_MS / 1000)]);
        second = { outcome: result.document?.outcome ?? null, errorCode: result.document?.error?.code ?? null, exitCode: result.status.code };
        const stillHeld = alive(tool) || launchers.some(alive);
        if (stillHeld) {
          check(result.document?.outcome !== 'ready' && result.document?.ok === false, `a second start answered ${result.document?.outcome} while the first client can still deliver`);
          check(h.reachedPredeliverAll(h.startVerb).length === 1, `${h.reachedPredeliverAll(h.startVerb).length} clients are held: the second start issued another request`);
          check(h.readRecord()?.attemptId === recordBefore?.attemptId, 'the second start replaced the attempt record');
        }
      }

      // 5. The held tool is released and delivers late, or it was ended before: the outcome is consistent either way.
      await h.release(h.startVerb);
      await until(() => !alive(tool), 'the released tool to finish').catch(() => problems.push('the released tool did not finish'));
      const delivered = count(h, h.startVerb) - startsBefore;
      const coordinatorStarts = h.toolState().starts - coordinatorStartsBefore;
      const up = await h.coordinatorUp().then(() => true, () => false);
      check(delivered <= 1, `${delivered} start calls reached the manager`);
      check(coordinatorStarts === delivered, `${delivered} start calls launched the coordinator ${coordinatorStarts} times`);
      let finalOutcome = null;
      if (up) {
        const final = await h.stop(['--timeout', '30']);
        finalOutcome = final.document?.outcome ?? null;
        check(finalOutcome === 'stopped', `the stop that followed the late launch returned ${finalOutcome}\n${final.stdout}\n${final.stderr}`);
        check(h.readRecord() === null, 'the authenticated instance did not resolve the attempt');
      }
      check(h.violations().length === 0, `the synthetic tool refused verbs: ${JSON.stringify(h.violations())}`);
      check(!h.verbs().some(verb => DESTRUCTIVE.includes(verb)), 'a destructive native verb was called');

      t.diagnostic(`${manager} ${stream} overflow: ${JSON.stringify({
        first: { outcome: document?.outcome ?? null, errorCode: document?.error?.code ?? null, ok: document?.ok ?? null, exitCode: exit?.code ?? null, elapsedMs: first.elapsedMs },
        afterFirst: { tool, toolAlive, launchers, launcherAlive, record: record === null ? null : { phase: record.phase, clientPid: record.client?.pid ?? null, clientRunning: record.client ? launchClientRunning(record.client) : null } },
        stops, secondStart: second, afterRelease: { delivered, coordinatorLaunches: coordinatorStarts, finalStop: finalOutcome },
      })}`);
      assert.deepEqual(problems, []);
    });
  }
}
