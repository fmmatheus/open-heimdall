import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createSubprocessNative } from './fixtures/lifecycle-subprocess-harness.mjs';
import { deferred } from './fixtures/publication-barrier.mjs';
import { lifecycleCommandMain } from '../dist/coordinator/lifecycle-cli.js';
import { createLaunchdAdapter } from '../dist/coordinator/native/launchd.js';
import { createSystemdAdapter } from '../dist/coordinator/native/systemd.js';
import { createExecFileRunner } from '../dist/coordinator/native/types.js';
import { launchClientRunning, writeLaunchAttempt } from '../dist/coordinator/lifecycle-launch.js';

/**
 * A start that gives up on its assessment of an earlier launch attempt must not let that assessment change the launch
 * attempt record after the start has released the operation lock.
 *
 * `start` first settles an earlier recorded attempt (here: one whose command ended before it started a client, which the
 * assessment resolves by removing the record). If the command's deadline passes while that removal is still pending, the
 * start ends. A later start admitted at that point records its own live client; the earlier assessment's removal must
 * then not land on the newer record, or `stop` would claim a stopped coordinator while that client can still deliver.
 *
 * The barrier holds only the first removal of the record file. Everything else is production code: the lifecycle
 * command, the adapters, the production `createExecFileRunner`, the record functions and the lock. The native tool is
 * the synthetic executable of `fixtures/synthetic-native-tool.mjs`. Mocked-manager evidence: neither launchd nor systemd
 * is operated.
 */

const posix = process.platform !== 'win32';
const skip = posix ? false : 'the synthetic native tool runs POSIX services';
const MANAGERS = ['launchd', 'systemd'];
const STOP_CLAIMS = ['stopped', 'already-stopped', 'stop-requested'];

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

/** A finite wait: the promise, or a failure naming what did not happen. */
const within = (promise, milliseconds, what) => {
  let timer;
  const expired = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not happen within ${milliseconds} ms`)), milliseconds); });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
};

/** Holds the first `fs.rm` of `recordFile` (through the default export the record code calls) until `gate` resolves. */
function holdFirstRemoval({ recordFile, gate, reached, landed }) {
  const original = fsp.rm;
  let held = false;
  fsp.rm = async function rm(target, ...rest) {
    if (held || path.resolve(String(target)) !== recordFile) return original.call(this, target, ...rest);
    held = true;
    reached.resolve();
    await gate.promise;
    try { return await original.call(this, target, ...rest); }
    finally { landed.resolve(); }
  };
  return () => { fsp.rm = original; };
}

/** The production `start` command, run inside this process with the production adapter and runner over the fixture's tool. */
async function startInProcess(h, args) {
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
  const status = await lifecycleCommandMain('start', ['--coordinator-config', h.configFile, '--env-file', h.credentialFile, '--json', ...args], {
    signals: new EventEmitter(),
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
  return { status, document, stdout: output.stdout, stderr: output.stderr };
}

for (const manager of MANAGERS) {
  test(`${manager}: a start that gave up on assessing an earlier attempt does not remove the record of the newer attempt that followed`, { skip, timeout: 120_000 }, async t => {
    const h = await createSubprocessNative(t, manager);
    const problems = [];
    const check = (condition, message) => { if (!condition) problems.push(message); };

    // An owned inactive definition after a clean shutdown, then the record of an attempt whose command ended before it
    // started a client: the next start resolves it by removing the record.
    const started = await h.start(['--timeout', '60']);
    assert.equal(started.document?.outcome, 'ready', `${started.stdout}\n${started.stderr}`);
    const stopped = await h.stop(['--timeout', '30']);
    assert.equal(stopped.document?.outcome, 'stopped', `${stopped.stdout}\n${stopped.stderr}`);
    const earlier = await writeLaunchAttempt(h.stateDirectory, { manager, label: h.label, now: Date.now() });
    assert.equal(h.readRecord()?.attemptId, earlier.attemptId, 'the earlier attempt is recorded');

    const gate = deferred();
    const reached = deferred();
    const landed = deferred();
    const restore = holdFirstRemoval({ recordFile: h.recordFile(), gate, reached, landed });
    t.after(() => { gate.resolve(); restore(); });

    // 1. The first start's assessment reaches the removal of the earlier record, which is held; its deadline passes.
    const first = startInProcess(h, ['--timeout', '1']);
    await within(reached.promise, 20_000, 'the first start to reach the removal of the earlier record');
    const ended = await within(first, 10_000, 'the first start to end');
    check(ended.document?.ok === false, `the first start ended ok=${ended.document?.ok}; it never reached the manager`);
    check(ended.document?.error?.code === 'deadline-exceeded', `the first start ended with ${ended.document?.error?.code}`);

    // 2. A second start is admitted (now, or once the abandoned assessment has settled) and records its own live client,
    //    which is held before it delivers.
    await h.predeliver(h.startVerb);
    const second = startInProcess(h, ['--timeout', '60']);
    second.catch(() => undefined);
    await sleep(500);

    // 3. The held removal is released and lands.
    gate.resolve();
    await within(landed.promise, 20_000, 'the held removal to be carried out');
    const client = await h.reachedPredeliver(h.startVerb);
    const record = h.readRecord();
    const settled = await sleep(300).then(() => h.readRecord());
    check(record !== null, 'the newer attempt\'s record was removed by the earlier assessment: its live client is no longer protected');
    check(record?.attemptId !== earlier.attemptId, 'the earlier attempt\'s record is still present');
    check(record?.client !== undefined && launchClientRunning(record.client), 'the record names no running client');
    check(record?.client !== undefined && h.processGroup(client) === record.client.pid, `the held client ${client} is not the client the record names (${record?.client?.pid ?? 'none'})`);
    check(settled?.attemptId === record?.attemptId, 'the record changed after the earlier assessment settled');
    check(h.toolAlive(client), 'the second attempt\'s held client was disturbed');

    // 4. While the second client can still deliver, `stop` claims nothing.
    const stop = await h.stop(['--timeout', '5']);
    check(!STOP_CLAIMS.includes(stop.document?.outcome), `stop claimed ${stop.document?.outcome} while the second attempt's client is held and can still deliver`);
    check(stop.document?.ok === false, `stop reported ok=${stop.document?.ok}`);
    check(h.toolAlive(client), 'the second attempt\'s client ended during stop');

    // 5. The client is released and delivers; the second start completes and the coordinator is stopped.
    await h.release(h.startVerb);
    const ended2 = await within(second, 60_000, 'the second start to end');
    check(ended2.document?.outcome === 'ready', `the second start returned ${ended2.document?.outcome}\n${ended2.stdout}`);
    const final = await h.stop(['--timeout', '30']);
    check(final.document?.outcome === 'stopped', `the final stop returned ${final.document?.outcome}`);
    check(h.violations().length === 0 && h.signals().length === 0, 'the synthetic tool refused verbs or was signalled');

    t.diagnostic(`${manager} abandoned assessment: ${JSON.stringify({ first: ended.document?.error?.code ?? null, record: record === null ? null : { sameAsEarlier: record.attemptId === earlier.attemptId, clientPid: record.client?.pid ?? null }, stop: stop.document?.outcome ?? null, second: ended2.document?.outcome ?? null })}`);
    assert.deepEqual(problems, []);
  });
}
