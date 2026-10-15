import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createSubprocessNative } from './fixtures/lifecycle-subprocess-harness.mjs';
import { parseLaunchctlPrint } from '../dist/coordinator/native/launchd.js';
import { parseSystemctlShow } from '../dist/coordinator/native/systemd.js';

const skip = process.platform === 'win32' ? 'the synthetic native tool runs POSIX services' : false;

for (const manager of ['launchd', 'systemd']) {
  test(`${manager}: synthetic manager publishes inactivity and the main-process exit status together`, { skip, timeout: 120_000 }, async t => {
    const h = await createSubprocessNative(t, manager);
    const started = await h.start(['--timeout', '60']);
    assert.equal(started.document?.outcome, 'ready', `${started.stdout}\n${started.stderr}`);

    // The service has actually exited, but the manager has not published its exit status yet. This deterministic gate
    // covers the scheduling window between reaping the child and writing the manager's state on disk.
    await h.gate('supervisor-exit');
    const stop = h.cli('stop', ['--coordinator-config', h.configFile, '--timeout', '30', '--json']);
    await h.reached('supervisor-exit');
    const state = h.toolState();
    assert.equal(h.toolAlive(state.pid), false, 'the supervisor reaped the coordinator');
    assert.equal(state.exit, null, 'the manager has not published the exit');

    const target = `gui/${process.getuid()}/${h.label}`;
    const output = execFileSync(h.tool, manager === 'launchd'
      ? ['print', target]
      : ['--user', 'show', h.label, '-p', 'LoadState,ActiveState,SubState,MainPID,ExecMainStatus,ExecMainCode,FragmentPath'], { encoding: 'utf8' });
    const inspection = manager === 'launchd' ? parseLaunchctlPrint(output, target) : parseSystemctlShow(output);
    assert.equal(inspection.running, true, 'the manager keeps its last running state until it can publish an exit');
    assert.equal(inspection.pid, state.pid);

    await h.ungate('supervisor-exit');
    const status = await stop.exit;
    const result = JSON.parse(stop.stdout);
    assert.equal(result.outcome, 'stopped', `${stop.stdout}\n${stop.stderr}`);
    assert.equal(status.code, 0);
    assert.deepEqual(h.toolState().exit, { code: 0, signal: null });
    assert.deepEqual(h.violations(), []);
  });
}
