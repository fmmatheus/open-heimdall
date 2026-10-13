import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readShutdownRecord } from '../dist/coordinator/lifecycle.js';
import { createControlledNative } from './fixtures/controlled-native-runner.mjs';

/**
 * Managed ownership must be proven positively before `start` reports readiness or an existing managed instance,
 * and before `stop` sends a shutdown request: the expected registration is loaded, it resolves to the owned
 * definition, its main process is known, and that process id is the authenticated coordinator instance's.
 * A disk definition, a process id or an answering authenticated endpoint alone is never ownership.
 *
 * The production launchd and systemd adapters run against the controlled native runner, which spawns a real
 * coordinator. This is mocked-manager evidence, never launchd or systemd evidence.
 */

const posix = process.platform !== 'win32';
const skip = posix ? false : 'the controlled native runner spawns POSIX services';
const managers = [
  { manager: 'launchd', actionVerb: 'kickstart', inspectVerb: 'print' },
  { manager: 'systemd', actionVerb: 'start', inspectVerb: 'show' },
];
const ok = stdout => ({ exitCode: 0, stdout, stderr: '' });
const ELSEWHERE = '/elsewhere/definition';

/** Manager output reporting the label as loaded from `registeredPath` with the given state and process id. */
function managerReport(h, { registeredPath, state, pid }) {
  const { runner } = h;
  if (h.manager === 'launchd') {
    return call => ok([`${call.args[1]} = {`, ...(registeredPath ? [`\tpath = ${registeredPath}`] : []), `\tstate = ${state}`, ...(pid ? [`\tpid = ${pid}`] : []), '}', ''].join('\n'));
  }
  return () => ok(runner.showText({ loadState: 'loaded', active: state, sub: 'running', pid: pid ?? 0, status: 0, code: 0, fragment: registeredPath ?? '' }));
}

const ownedReportedPath = h => h.manager === 'launchd' ? h.definitionPath() : h.linkPath();
const forever = { times: 100_000 };

/** Ways the manager's evidence can fail to prove ownership of the running coordinator. */
const evidence = {
  'a registration loaded from another definition with the matching process id': {
    apply: (h, pid) => { h.runner.foreign = { registeredPath: ELSEWHERE, pid, running: true }; },
    codes: ['registered-elsewhere'],
  },
  'an unrecognized registration state': {
    apply: h => h.runner.respond(h.manager === 'launchd' ? 'print' : 'show', ok('not manager output\n'), forever),
    codes: ['state-unknown', 'registered-elsewhere'],
  },
  'an unknown running state': {
    apply: (h, pid) => h.runner.respond(h.manager === 'launchd' ? 'print' : 'show', managerReport(h, { registeredPath: ownedReportedPath(h), state: h.manager === 'launchd' ? 'starting' : 'weird', pid: 0 }), forever),
    codes: ['state-unknown', 'registered-elsewhere'],
  },
  'a loaded registration with no reported definition path': {
    apply: (h, pid) => h.runner.respond(h.manager === 'launchd' ? 'print' : 'show', managerReport(h, { registeredPath: null, state: h.manager === 'launchd' ? 'running' : 'active', pid }), forever),
    codes: ['registered-elsewhere'],
  },
  'a running service with no main process id': {
    apply: h => { h.runner.reportedPid = null; },
    codes: ['state-unknown'],
  },
  'a running service whose process id differs from the answering instance': {
    apply: (h, pid) => { h.runner.reportedPid = pid + 1; },
    codes: ['registered-elsewhere'],
  },
};

async function started(t, manager) {
  const h = await createControlledNative(t, manager);
  const first = await h.start(['--timeout', '60']);
  assert.equal(first.document.outcome, 'ready', `${first.stdout}\n${first.stderr}`);
  const service = h.service();
  return { h, service, pid: service.child.pid, instanceId: first.document.instance.instanceId };
}

/** The coordinator was neither asked to drain nor touched: it runs, admits runs, and left no shutdown evidence. */
async function assertUndisturbed({ h, service, instanceId }) {
  assert.ok(h.runner.isRunning(service), 'the coordinator process still runs');
  assert.equal(service.exit, null);
  h.runner.assertNoViolations();
  assert.ok(!h.runner.verbs.some(verb => ['bootout', 'stop', 'kill', 'remove', 'unload'].includes(verb)), `unexpected verbs: ${h.runner.verbs.join(', ')}`);
  assert.equal(h.runner.cleanupLog.length, 0, 'the harness ended no process');
  assert.equal(await readShutdownRecord(h.stateDirectory, instanceId), null, 'no shutdown was recorded');
  h.runner.foreign = null;
  h.runner.reportedPid = undefined;
  h.runner.responses.length = 0;
  const lifecycle = await (await h.client()).request('GET', '/lifecycle');
  assert.equal(lifecycle.phase, 'running');
  assert.equal(lifecycle.instanceId, instanceId);
  await fs.access(h.definitionPath());
}

for (const { manager, actionVerb, inspectVerb } of managers) {
  for (const [name, { apply, codes }] of Object.entries(evidence)) {
    test(`${manager}: start does not adopt a running managed coordinator on ${name}`, { skip, timeout: 60000 }, async t => {
      const context = await started(t, manager);
      const { h, pid } = context;
      apply(h, pid);
      const outcome = await h.start(['--timeout', '10']);
      assert.notEqual(outcome.status, 0, `${outcome.stdout}\n${outcome.stderr}`);
      assert.equal(outcome.document.outcome, 'conflict');
      assert.ok(codes.includes(outcome.document.error.code), `${outcome.document.error.code} is not one of ${codes.join(', ')}`);
      assert.equal(h.service().starts, 1, 'nothing was started again');
      await assertUndisturbed(context);
    });

    test(`${manager}: stop sends no shutdown request on ${name}`, { skip, timeout: 60000 }, async t => {
      const context = await started(t, manager);
      const { h, pid } = context;
      apply(h, pid);
      const outcome = await h.stop(['--timeout', '5']);
      assert.notEqual(outcome.status, 0, `${outcome.stdout}\n${outcome.stderr}`);
      assert.equal(outcome.document.outcome, 'conflict');
      assert.ok(codes.includes(outcome.document.error.code), `${outcome.document.error.code} is not one of ${codes.join(', ')}`);
      await assertUndisturbed(context);
    });

    test(`${manager}: a newly requested start is not ready on ${name}`, { skip, timeout: 60000 }, async t => {
      const h = await createControlledNative(t, manager);
      // The change appears once the service was started, so the coordinator really answers ready over authenticated IPC.
      h.runner.on('after', actionVerb, () => apply(h, h.service().child.pid));
      const outcome = await h.start(['--timeout', '4']);
      const document = outcome.document;
      assert.notEqual(outcome.status, 0, `${outcome.stdout}\n${outcome.stderr}`);
      assert.notEqual(document.outcome, 'ready');
      assert.ok(['startup-not-confirmed', 'conflict'].includes(document.outcome), document.outcome);
      assert.ok(document.error, 'a truthful error is reported');
      // The coordinator itself is healthy and answers; only the ownership evidence is missing.
      h.runner.foreign = null;
      h.runner.reportedPid = undefined;
      h.runner.responses.length = 0;
      const lifecycle = await (await h.client()).request('GET', '/lifecycle');
      assert.equal(lifecycle.phase, 'running');
      assert.equal(lifecycle.pid, h.service().child.pid);
      // Nothing was unloaded, removed, signalled or stopped.
      h.runner.assertNoViolations();
      assert.ok(!h.runner.verbs.some(verb => ['bootout', 'stop', 'kill', 'remove', 'unload'].includes(verb)), `unexpected verbs: ${h.runner.verbs.join(', ')}`);
      assert.ok(h.runner.isRunning(h.service()));
      assert.equal(h.runner.cleanupLog.length, 0);
      await fs.access(h.definitionPath());
    });
  }

  test(`${manager}: stop refuses when ownership changes between inspection and the shutdown request`, { skip, timeout: 60000 }, async t => {
    const changes = [
      ['the registration is replaced by another definition', (h, pid) => { h.runner.foreign = { registeredPath: ELSEWHERE, pid, running: true }; }],
      ['the service manager now reports another process', (h, pid) => { h.runner.reportedPid = pid + 1; }],
      ['the service manager can no longer report a process id', h => { h.runner.reportedPid = null; }],
    ];
    for (const [name, change] of changes) {
      await t.test(name, async subtest => {
        const context = await started(subtest, manager);
        const { h, pid } = context;
        // Parked after the first inspection has answered "owned" and before any request is sent.
        h.runner.on('after', inspectVerb, () => change(h, pid));
        const outcome = await h.stop(['--timeout', '5']);
        assert.notEqual(outcome.status, 0, `${outcome.stdout}\n${outcome.stderr}`);
        assert.equal(outcome.document.outcome, 'conflict');
        assert.ok(['registered-elsewhere', 'state-unknown'].includes(outcome.document.error.code), outcome.document.error.code);
        await assertUndisturbed(context);
      });
    }
  });

  // --- Controls: ownership that is legitimate must keep working -------------------------------------------------

  test(`${manager}: control: an owned service is recognized, a repeated start changes nothing and stop completes cleanly`, { skip, timeout: 60000 }, async t => {
    const { h, service, instanceId } = await started(t, manager);
    const again = await h.start(['--timeout', '10']);
    assert.equal(again.document.outcome, 'already-running', `${again.stdout}\n${again.stderr}`);
    assert.equal(again.document.instance.instanceId, instanceId);
    assert.equal(service.starts, 1);
    const stopped = await h.stop(['--timeout', '60']);
    assert.equal(stopped.document.outcome, 'stopped', `${stopped.stdout}\n${stopped.stderr}`);
    assert.deepEqual([service.exit.code, service.exit.signal], [0, null]);
    h.runner.assertNoViolations();
    assert.equal(h.runner.cleanupLog.length, 0);
  });

  test(`${manager}: control: a definition path reported through an alias link to the owned definition is owned`, { skip, timeout: 60000 }, async t => {
    const { h, service, instanceId } = await started(t, manager);
    const alias = path.join(h.root, 'alias-definition');
    await fs.symlink(h.definitionPath(), alias);
    if (manager === 'launchd') service.registeredPath = alias;
    else service.fragmentPath = alias;
    const again = await h.start(['--timeout', '10']);
    assert.equal(again.document.outcome, 'already-running', `${again.stdout}\n${again.stderr}`);
    assert.equal(again.document.instance.instanceId, instanceId);
    const stopped = await h.stop(['--timeout', '60']);
    assert.equal(stopped.document.outcome, 'stopped', `${stopped.stdout}\n${stopped.stderr}`);
    h.runner.assertNoViolations();
  });

  test(`${manager}: control: an owned service started with a previous credential file context is recognized and stops cleanly`, { skip, timeout: 60000 }, async t => {
    const { h, service, instanceId } = await started(t, manager);
    const other = path.join(h.root, 'other-credentials.env');
    await fs.writeFile(other, 'OPENCODE_PASSWORD=another-synthetic-credential\n', { mode: 0o600 });
    await fs.chmod(other, 0o600);
    // Ownership is recognized, so the changed context is reported as a context conflict and nothing is changed.
    const conflict = await h.run('start', ['--coordinator-config', h.configFile, '--env-file', other, '--json']);
    assert.equal(JSON.parse(conflict.stdout).error.code, 'credential-conflict', `${conflict.stdout}\n${conflict.stderr}`);
    // Stop verifies the registration that started the process, not the context of the command that stops it.
    const otherData = path.join(h.root, 'other-openchamber');
    await fs.mkdir(otherData, { mode: 0o700 });
    const stopped = await h.stop(['--timeout', '60'], { dependencies: { environment: { HOME: h.home, OPENCHAMBER_DATA_DIR: otherData } } });
    assert.equal(stopped.document.outcome, 'stopped', `${stopped.stdout}\n${stopped.stderr}`);
    assert.equal(stopped.document.instance.instanceId, instanceId);
    assert.deepEqual([service.exit.code, service.exit.signal], [0, null]);
    h.runner.assertNoViolations();
    assert.equal(h.runner.cleanupLog.length, 0);
  });
}

test('systemd: control: the legitimate user-config link of the owned definition is the reported fragment and is owned', { skip, timeout: 60000 }, async t => {
  const { h, service, instanceId } = await started(t, 'systemd');
  assert.equal(service.fragmentPath, h.linkPath());
  assert.ok((await fs.lstat(h.linkPath())).isSymbolicLink());
  assert.equal(await fs.realpath(h.linkPath()), await fs.realpath(h.definitionPath()));
  const again = await h.start(['--timeout', '10']);
  assert.equal(again.document.outcome, 'already-running', `${again.stdout}\n${again.stderr}`);
  assert.equal(again.document.instance.instanceId, instanceId);
  const stopped = await h.stop(['--timeout', '60']);
  assert.equal(stopped.document.outcome, 'stopped', `${stopped.stdout}\n${stopped.stderr}`);
  h.runner.assertNoViolations();
});
