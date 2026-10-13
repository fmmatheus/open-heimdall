import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { parseCoordinatorStatus } from '../dist/coordinator/status.js';
import { CLI_ENTRY, SENTINEL, createControlledNative } from './fixtures/controlled-native-runner.mjs';

/**
 * Smoke tests for the controlled native runner: the public `coordinator start|stop` commands run through the
 * production launchd and systemd adapters against a stateful stand-in for the manager that really spawns the
 * coordinator from the registered definition. This is mocked-manager evidence, never launchd or systemd evidence.
 */

const posix = process.platform !== 'win32';
const skip = posix ? false : 'the controlled native runner spawns POSIX services';
const managers = [
  { manager: 'launchd', actionVerb: 'kickstart', allowed: ['print', 'bootstrap', 'kickstart'] },
  { manager: 'systemd', actionVerb: 'start', allowed: ['show-environment', 'show', 'link', 'daemon-reload', 'start'] },
];

for (const { manager, actionVerb, allowed } of managers) {
  test(`${manager}: public start, stop and start again drive the production adapter and a real coordinator process`, { skip }, async t => {
    const h = await createControlledNative(t, manager);
    const { runner } = h;
    const adapter = await h.adapter();

    // --- start -> ready ---------------------------------------------------------------------------------------
    const first = await h.start(['--timeout', '60']);
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
    assert.equal(first.document.outcome, 'ready');
    assert.equal(first.document.target.manager, manager);
    assert.equal(first.document.target.label, h.label());
    assert.equal(first.document.instance.mode, 'managed');
    assert.ok(!(first.stdout + first.stderr).includes(SENTINEL), 'no credential value in command output');

    const service = h.service();
    assert.equal(service.starts, 1);
    assert.ok(runner.isRunning(service), 'the registered definition was started as a real process');
    assert.equal(first.document.instance.pid, service.child.pid, 'the instance is the process the manager started');

    // The definition on disk is the one that ran.
    const definition = await fs.readFile(h.definitionPath(), 'utf8');
    assert.ok(!definition.includes(SENTINEL), 'the definition holds no credential value');
    assert.ok(definition.includes(h.credentialFile), 'the definition references the credential file by path');
    assert.ok(definition.includes(CLI_ENTRY), 'the definition runs the built entry point');
    if (manager === 'launchd') {
      assert.match(definition, /<key>RunAtLoad<\/key>\s*<false\/>/);
      assert.match(definition, /<key>KeepAlive<\/key>\s*<false\/>/);
      assert.equal(runner.service(h.label()).registeredPath, h.definitionPath(), 'registered from the owned definition');
    } else {
      assert.match(definition, /^Type=exec$/m);
      assert.match(definition, /^Restart=no$/m);
      assert.doesNotMatch(definition, /\[Install\]/);
      const link = await fs.lstat(h.linkPath());
      assert.ok(link.isSymbolicLink(), 'systemctl link placed a symlink in the user unit directory');
      assert.equal(await fs.realpath(h.linkPath()), await fs.realpath(h.definitionPath()));
    }

    // Independent authenticated readiness, outside the start command.
    const client = await h.client();
    const lifecycle = await client.request('GET', '/lifecycle');
    assert.equal(lifecycle.pid, service.child.pid);
    assert.equal(lifecycle.instanceId, first.document.instance.instanceId);
    assert.equal(lifecycle.mode, 'managed');
    assert.equal(lifecycle.manager, h.label());
    assert.equal(lifecycle.phase, 'running');
    const status = parseCoordinatorStatus(await client.request('GET', '/status'));
    assert.deepEqual({ status: status.status, accepting: status.acceptingNewRuns }, { status: 'running', accepting: true });
    const inspection = await adapter.inspect();
    assert.deepEqual([inspection.registration, inspection.running, inspection.pid], ['loaded', true, service.child.pid]);

    // --- stop -> stopped --------------------------------------------------------------------------------------
    const stopped = await h.stop(['--timeout', '60']);
    assert.equal(stopped.status, 0, `${stopped.stdout}\n${stopped.stderr}`);
    assert.equal(stopped.document.outcome, 'stopped');
    assert.equal(stopped.document.instance.instanceId, first.document.instance.instanceId);
    assert.deepEqual(service.exit && [service.exit.code, service.exit.signal], [0, null], 'the process exited cleanly through the graceful drain');
    const after = await adapter.inspect();
    assert.deepEqual([after.registration, after.running, after.pid, after.lastExitStatus], ['loaded', false, null, 0]);
    assert.equal((await adapter.remembered()).kind, 'owned', 'the owned definition is retained');
    assert.equal(runner.cleanupLog.length, 0, 'the harness ended no process');

    // --- start again -> ready ---------------------------------------------------------------------------------
    const second = await h.start(['--timeout', '60']);
    assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
    assert.equal(second.document.outcome, 'ready');
    assert.notEqual(second.document.instance.instanceId, first.document.instance.instanceId);
    assert.equal(service.starts, 2);
    assert.ok(runner.isRunning(service));
    assert.equal(second.document.instance.pid, service.child.pid);
    const output = manager === 'launchd' ? await runner.logs(h.logPaths()) : runner.journal(service);
    assert.match(output.stdout, /Coordinator listening/, 'the service output was kept where the manager keeps it');

    // --- calls ------------------------------------------------------------------------------------------------
    runner.assertNoViolations();
    const verbs = runner.verbs;
    assert.ok(verbs.every(verb => allowed.includes(verb)), `unexpected verbs: ${[...new Set(verbs)].join(', ')}`);
    assert.equal(verbs.filter(verb => verb === actionVerb).length, 2, 'one explicit start request per public start');
    assert.equal(verbs.filter(verb => verb === (manager === 'launchd' ? 'bootstrap' : 'link')).length, 1, 'the definition is registered once');
    assert.ok(runner.calls.every(call => !call.args.includes('-k') && !call.args.includes('--now') && !call.args.includes('--force')));
  });

  test(`${manager}: injection hooks and barriers reach the production adapter and refused verbs fail`, { skip }, async t => {
    const h = await createControlledNative(t, manager);
    const { runner } = h;
    const adapter = await h.adapter();
    const file = manager === 'launchd' ? runner.launchctl : runner.systemctl;
    const argv = (...args) => manager === 'launchd' ? args : ['--user', ...args];

    assert.equal((await adapter.inspect()).registration, 'not-loaded');

    // Forbidden verbs and options throw, and are recorded.
    const forbidden = manager === 'launchd'
      ? [['kickstart', '-k', `gui/${runner.uid}/${h.label()}`], ['kill', 'TERM', `gui/${runner.uid}/${h.label()}`], ['unload', h.definitionPath()]]
      : [['stop', h.label()], ['restart', h.label()], ['kill', h.label()], ['reset-failed', h.label()], ['enable', h.label()]];
    for (const args of forbidden) await assert.rejects(runner.run(file, argv(...args)), /refused/);
    assert.equal(runner.violations.length, forbidden.length);
    runner.violations.length = 0;

    // A foreign registration of the same label with its own path and pid.
    runner.foreign = { registeredPath: '/elsewhere/definition', pid: 99_991 };
    const foreign = await adapter.inspect();
    assert.deepEqual([foreign.registration, foreign.running, foreign.pid, foreign.registeredPath], ['loaded', true, 99_991, '/elsewhere/definition']);
    runner.foreign = null;

    // Unrecognized output and a failing verb.
    runner.respond(manager === 'launchd' ? 'print' : 'show', { exitCode: 0, stdout: 'not manager output\n', stderr: '' });
    assert.equal((await adapter.inspect()).registration, 'unknown');
    runner.respond(manager === 'launchd' ? 'bootstrap' : 'link', { exitCode: 5, stdout: '', stderr: 'injected failure\n' });
    const refused = await h.start(['--timeout', '10']);
    assert.notEqual(refused.status, 0);
    assert.equal(refused.document.outcome, 'failed');
    assert.equal(h.service().starts, 0, 'a failed registration starts nothing');

    // A barrier between inspection and action: the call is parked, the process does not exist yet, then it is released.
    const hold = runner.hold('before', actionVerb);
    const pending = h.start(['--timeout', '60']);
    const call = await hold.reached;
    assert.equal(call.verb, actionVerb);
    assert.equal(h.service().starts, 0, 'nothing has started while the action is parked');
    hold.release();
    const started = await pending;
    assert.equal(started.document.outcome, 'ready', `${started.stdout}\n${started.stderr}`);

    // Pid injection while the real process runs.
    const pid = h.service().child.pid;
    runner.reportedPid = null;
    assert.deepEqual([(await adapter.inspect()).running, (await adapter.inspect()).pid], [true, null]);
    runner.reportedPid = pid + 1;
    assert.equal((await adapter.inspect()).pid, pid + 1);
    runner.reportedPid = undefined;
    assert.equal((await adapter.inspect()).pid, pid);
    runner.assertNoViolations();
  });
}
