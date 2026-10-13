import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readShutdownRecord } from '../dist/coordinator/lifecycle.js';
import { parseSystemdUnit } from '../dist/coordinator/native/systemd.js';
import { CLI_ENTRY, createControlledNative } from './fixtures/controlled-native-runner.mjs';

/**
 * The systemd user manager reports a unit linked from outside its search paths with the link source as its
 * `FragmentPath`, so the reported fragment can be the expected user-config link. That pathname is not ownership: the
 * link must resolve, through every hop, to the validated owned definition. These cases place the expected link on a
 * complete foreign unit (or on a missing, looping, unreadable or changing target) while the manager reports the link
 * as the fragment with the authenticated coordinator's own process id, and drive the public lifecycle commands through
 * the production systemd adapter.
 *
 * Evidence label: controlled-runner. The adapter, definitions, lifecycle commands and coordinator process are real;
 * systemd is a stateful stand-in. Nothing here establishes real systemd behavior.
 */

const posix = process.platform !== 'win32';
const skip = posix ? false : 'the controlled native runner spawns POSIX services';
const FOREIGN_ENTRY = '/nonexistent/foreign-entry.js';
const ACTING = ['start', 'link', 'daemon-reload'];

async function started(t) {
  const h = await createControlledNative(t, 'systemd');
  const first = await h.start(['--timeout', '60']);
  assert.equal(first.document.outcome, 'ready', `${first.stdout}\n${first.stderr}`);
  const service = h.service();
  return { h, service, instanceId: first.document.instance.instanceId, owned: await fs.realpath(h.definitionPath()) };
}

/** Start, then stop cleanly: the owned definition stays linked and inactive. */
async function stopped(t) {
  const context = await started(t);
  const halt = await context.h.stop(['--timeout', '60']);
  assert.equal(halt.document.outcome, 'stopped', `${halt.stdout}\n${halt.stderr}`);
  assert.equal(context.h.runner.isRunning(context.service), false);
  return context;
}

/**
 * A complete unit outside every search path that parses as a Heimdall coordinator unit for this state directory and
 * differs from the owned one only in its entry point, so only where the link points tells them apart.
 */
async function foreignUnit(h, name = 'foreign') {
  const owned = (await h.adapter()).render();
  assert.ok(owned.includes(CLI_ENTRY));
  const text = owned.replace(CLI_ENTRY, FOREIGN_ENTRY);
  assert.ok(parseSystemdUnit(text, h.label()), 'the foreign unit is a complete unit');
  const directory = path.join(h.root, name);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, h.label());
  await fs.writeFile(file, text);
  return { file, text };
}

async function relink(h, target) {
  await fs.rm(h.linkPath(), { force: true });
  await fs.symlink(target, h.linkPath());
}

/** A chain of links ending at `target`; the first hop is returned. */
async function chain(h, target, hops, name) {
  let next = target;
  for (let index = hops; index >= 1; index--) {
    const hop = path.join(h.root, `${name}-hop-${index}`);
    await fs.symlink(next, hop);
    next = hop;
  }
  return next;
}

/** The ways the expected link can fail to resolve to the owned definition. */
const unowned = {
  'a complete foreign unit': async h => (await foreignUnit(h)).file,
  'a missing target (dangling link)': async h => path.join(h.root, 'missing', h.label()),
  'a link loop (unresolvable target)': async h => {
    const first = path.join(h.root, 'loop-a');
    const second = path.join(h.root, 'loop-b');
    await fs.symlink(second, first);
    await fs.symlink(first, second);
    return first;
  },
  'two hops ending at a foreign unit': async h => chain(h, (await foreignUnit(h)).file, 2, 'to-foreign'),
};

const showCount = h => h.runner.verbs.filter(verb => verb === 'show').length;

/** The coordinator was neither asked to drain nor touched, and nothing acted on the unit. */
async function assertUndisturbed({ h, service, instanceId }, { startsBefore = 1 } = {}) {
  assert.ok(h.runner.isRunning(service), 'the coordinator process still runs');
  assert.equal(service.exit, null);
  assert.equal(service.starts, startsBefore, 'nothing was started again');
  h.runner.assertNoViolations();
  assert.equal(h.runner.cleanupLog.length, 0, 'the harness ended no process');
  assert.equal(await readShutdownRecord(h.stateDirectory, instanceId), null, 'no shutdown was recorded');
  const lifecycle = await (await h.client()).request('GET', '/lifecycle');
  assert.equal(lifecycle.phase, 'running', 'no shutdown request reached the coordinator');
  assert.equal(lifecycle.shutdown ?? null, null);
  assert.equal(lifecycle.instanceId, instanceId);
}

/** No native call that acts on the unit ran while the expected link named anything but the owned definition. */
function assertOnlyOwnedLinkActed(h, owned, after = 0) {
  for (const call of h.runner.calls.slice(after)) {
    if (!ACTING.includes(call.verb)) continue;
    for (const [unit, target] of Object.entries(call.linkTargets ?? {})) {
      assert.equal(target, owned, `${call.verb} acted on ${unit} while its link resolved to ${target}`);
    }
  }
}

function assertNoRegistrationChange(h, after = 0) {
  const verbs = h.runner.calls.slice(after).map(call => call.verb);
  for (const verb of ['start', 'link', 'daemon-reload']) assert.ok(!verbs.includes(verb), `unexpected ${verb}: ${verbs.join(', ')}`);
}

async function assertForeignKept(h, foreign, expectedTarget = foreign.file) {
  assert.equal(await fs.readFile(foreign.file, 'utf8'), foreign.text, 'the foreign unit was not modified');
  assert.equal(await fs.readlink(h.linkPath()), expectedTarget, 'the link was not replaced');
}

const reported = h => h.service().fragmentPath;

// --- Controls ---------------------------------------------------------------------------------------------------

test('control: the normal owned definition behind the legitimate link is owned: start adopts it and stop drains it', { skip, timeout: 90000 }, async t => {
  const { h, instanceId } = await started(t);
  assert.equal(reported(h), h.linkPath(), 'the manager reports the expected link as the fragment');
  const again = await h.start(['--timeout', '10']);
  assert.equal(again.document.outcome, 'already-running', `${again.stdout}\n${again.stderr}`);
  assert.equal(again.document.instance.instanceId, instanceId);
  const halt = await h.stop(['--timeout', '60']);
  assert.equal(halt.document.outcome, 'stopped', `${halt.stdout}\n${halt.stderr}`);
  h.runner.assertNoViolations();
  assert.equal(h.runner.cleanupLog.length, 0);
});

for (const hops of [1, 2, 3]) {
  test(`control: a link reaching the owned definition through ${hops} extra hop(s) is owned`, { skip, timeout: 90000 }, async t => {
    const { h, instanceId } = await started(t);
    await relink(h, await chain(h, h.definitionPath(), hops, 'to-owned'));
    assert.equal(await fs.realpath(h.linkPath()), await fs.realpath(h.definitionPath()));
    const again = await h.start(['--timeout', '10']);
    assert.equal(again.document.outcome, 'already-running', `${again.stdout}\n${again.stderr}`);
    const halt = await h.stop(['--timeout', '60']);
    assert.equal(halt.document.outcome, 'stopped', `${halt.stdout}\n${halt.stderr}`);
    assert.equal(halt.document.instance.instanceId, instanceId);
    h.runner.assertNoViolations();
  });
}

test('control: a stopped owned unit behind the legitimate link still starts again', { skip, timeout: 120000 }, async t => {
  const { h, owned } = await stopped(t);
  const before = h.runner.calls.length;
  const second = await h.start(['--timeout', '60']);
  assert.equal(second.document.outcome, 'ready', `${second.stdout}\n${second.stderr}`);
  assertOnlyOwnedLinkActed(h, owned, before);
  assert.equal(h.runner.verbs.slice(before).filter(verb => verb === 'start').length, 1);
  const halt = await h.stop(['--timeout', '60']);
  assert.equal(halt.document.outcome, 'stopped', `${halt.stdout}\n${halt.stderr}`);
});

test('control: an owned stopped unit is unlinked through the adapter only when the link resolves to the owned definition', { skip, timeout: 120000 }, async t => {
  const { h } = await stopped(t);
  const adapter = await h.adapter();
  const removed = await adapter.unloadInactive();
  assert.equal(removed.outcome, 'removed', removed.detail);
  await assert.rejects(fs.lstat(h.linkPath()), { code: 'ENOENT' });
  await fs.access(h.definitionPath());
});

// --- Existing managed instance: start, stop, stop --no-wait -----------------------------------------------------

for (const [name, target] of Object.entries(unowned)) {
  test(`start does not adopt a running managed coordinator whose expected link is ${name}`, { skip, timeout: 90000 }, async t => {
    const context = await started(t);
    const { h } = context;
    await relink(h, await target(h));
    assert.equal(reported(h), h.linkPath(), 'the manager still reports the expected link, with the authenticated pid');
    const before = h.runner.calls.length;
    const outcome = await h.start(['--timeout', '10']);
    assert.notEqual(outcome.status, 0, `${outcome.stdout}\n${outcome.stderr}`);
    assert.equal(outcome.document.outcome, 'conflict', `${outcome.stdout}\n${outcome.stderr}`);
    assert.equal(outcome.document.error.code, 'registered-elsewhere');
    assertNoRegistrationChange(h, before);
    await assertUndisturbed(context);
  });

  test(`stop sends no shutdown request when the expected link is ${name}`, { skip, timeout: 90000 }, async t => {
    const context = await started(t);
    const { h } = context;
    await relink(h, await target(h));
    const before = h.runner.calls.length;
    const outcome = await h.stop(['--timeout', '5']);
    assert.notEqual(outcome.status, 0, `${outcome.stdout}\n${outcome.stderr}`);
    assert.equal(outcome.document.outcome, 'conflict', `${outcome.stdout}\n${outcome.stderr}`);
    assert.equal(outcome.document.error.code, 'registered-elsewhere');
    assertNoRegistrationChange(h, before);
    await assertUndisturbed(context);
  });

  test(`stop --no-wait sends no shutdown request when the expected link is ${name}`, { skip, timeout: 90000 }, async t => {
    const context = await started(t);
    const { h } = context;
    await relink(h, await target(h));
    const before = h.runner.calls.length;
    const outcome = await h.stop(['--no-wait']);
    assert.notEqual(outcome.status, 0, `${outcome.stdout}\n${outcome.stderr}`);
    assert.equal(outcome.document.outcome, 'conflict', `${outcome.stdout}\n${outcome.stderr}`);
    assert.equal(outcome.document.error.code, 'registered-elsewhere');
    assertNoRegistrationChange(h, before);
    await assertUndisturbed(context);
  });

  test(`a newly requested start is not ready when the expected link becomes ${name}`, { skip, timeout: 90000 }, async t => {
    const h = await createControlledNative(t, 'systemd');
    // The link changes once the service was started, so the coordinator really answers ready over authenticated IPC.
    h.runner.on('after', 'start', async () => { await relink(h, await target(h)); });
    const outcome = await h.start(['--timeout', '4']);
    assert.notEqual(outcome.status, 0, `${outcome.stdout}\n${outcome.stderr}`);
    assert.notEqual(outcome.document.outcome, 'ready');
    assert.ok(['startup-not-confirmed', 'conflict'].includes(outcome.document.outcome), outcome.document.outcome);
    assert.ok(outcome.document.error, 'a truthful error is reported');
    const service = h.service();
    assert.equal(service.starts, 1);
    assert.ok(h.runner.isRunning(service), 'the started coordinator was left running');
    const lifecycle = await (await h.client()).request('GET', '/lifecycle');
    assert.equal(lifecycle.phase, 'running');
    assert.equal(lifecycle.pid, service.child.pid);
    assert.equal(lifecycle.shutdown ?? null, null);
    assert.equal(await readShutdownRecord(h.stateDirectory, lifecycle.instanceId), null);
    h.runner.assertNoViolations();
    assert.equal(h.runner.cleanupLog.length, 0);
    assert.equal(h.runner.verbs.filter(verb => verb === 'start').length, 1, 'no second start was requested');
  });
}

// --- Inactive unit: no start, refresh, link or unload through an unowned link -----------------------------------

for (const [name, target] of Object.entries(unowned)) {
  test(`start of an inactive unit requests nothing when the expected link is ${name}`, { skip, timeout: 120000 }, async t => {
    const { h } = await stopped(t);
    await relink(h, await target(h));
    const before = h.runner.calls.length;
    const outcome = await h.start(['--timeout', '10']);
    assert.notEqual(outcome.status, 0, `${outcome.stdout}\n${outcome.stderr}`);
    assert.equal(outcome.document.outcome, 'conflict', `${outcome.stdout}\n${outcome.stderr}`);
    assert.equal(outcome.document.error.code, 'registered-elsewhere');
    assertNoRegistrationChange(h, before);
    assert.equal(h.service().starts, 1, 'the unit was not started again');
    h.runner.assertNoViolations();
  });

  test(`a refresh of a changed definition is not applied when the expected link is ${name}`, { skip, timeout: 120000 }, async t => {
    const { h } = await stopped(t);
    const next = path.join(h.root, 'credentials-next.env');
    await fs.writeFile(next, 'OPENCODE_PASSWORD=controlled-native-next-credential\n', { mode: 0o600 });
    await fs.chmod(next, 0o600);
    await relink(h, await target(h));
    const definitionBefore = await fs.readFile(h.definitionPath(), 'utf8');
    const before = h.runner.calls.length;
    const outcome = await h.runJson('start', ['--coordinator-config', h.configFile, '--env-file', next, '--timeout', '10']);
    assert.notEqual(outcome.status, 0, `${outcome.stdout}\n${outcome.stderr}`);
    assert.equal(outcome.document.outcome, 'conflict', `${outcome.stdout}\n${outcome.stderr}`);
    assert.equal(outcome.document.error.code, 'registered-elsewhere');
    assertNoRegistrationChange(h, before);
    assert.equal(await fs.readFile(h.definitionPath(), 'utf8'), definitionBefore, 'the owned definition was not rewritten');
    h.runner.assertNoViolations();
  });

  test(`unloadInactive refuses and keeps the link when it is ${name}`, { skip, timeout: 120000 }, async t => {
    const { h } = await stopped(t);
    const destination = await target(h);
    await relink(h, destination);
    const adapter = await h.adapter();
    const before = h.runner.calls.length;
    const result = await adapter.unloadInactive();
    assert.equal(result.outcome, 'refused', result.detail);
    assert.equal(await fs.readlink(h.linkPath()), destination, 'the link was not removed');
    assertNoRegistrationChange(h, before);
    h.runner.assertNoViolations();
  });
}

test('a first start refuses to link over an unowned link that already occupies the expected path', { skip, timeout: 90000 }, async t => {
  const h = await createControlledNative(t, 'systemd');
  const foreign = await foreignUnit(h);
  await fs.mkdir(path.dirname(h.linkPath()), { recursive: true });
  await fs.symlink(foreign.file, h.linkPath());
  const outcome = await h.start(['--timeout', '10']);
  assert.notEqual(outcome.status, 0, `${outcome.stdout}\n${outcome.stderr}`);
  assert.equal(outcome.document.outcome, 'conflict', `${outcome.stdout}\n${outcome.stderr}`);
  assert.equal(outcome.document.error.code, 'registered-elsewhere');
  assertNoRegistrationChange(h);
  await assertForeignKept(h, foreign);
  h.runner.assertNoViolations();
});

test('an unreadable link target is not ownership', { skip: skip || (process.getuid?.() === 0 ? 'permissions are not enforced for root' : false), timeout: 90000 }, async t => {
  const context = await started(t);
  const { h } = context;
  const locked = path.join(h.root, 'locked');
  await fs.mkdir(locked);
  await fs.copyFile(h.definitionPath(), path.join(locked, h.label()));
  await relink(h, path.join(locked, h.label()));
  await fs.chmod(locked, 0o000);
  try {
    const outcome = await h.stop(['--timeout', '5']);
    assert.equal(outcome.document.outcome, 'conflict', `${outcome.stdout}\n${outcome.stderr}`);
    assert.equal(outcome.document.error.code, 'registered-elsewhere');
    await assertUndisturbed(context);
  } finally { await fs.chmod(locked, 0o700); }
});

// --- A link that changes between the inspection and the action ---------------------------------------------------

/** Run `action` right after the `nth` manager inspection (`show`) returned, before the adapter acts on it. */
function afterShow(h, nth, action) {
  let seen = 0;
  h.runner.on('after', 'show', async () => { seen += 1; if (seen === nth) await action(); }, { once: false });
}

test('start reports a conflict when the link changes after the manager inspected a running owned coordinator', { skip, timeout: 90000 }, async t => {
  const context = await started(t);
  const { h } = context;
  const foreign = await foreignUnit(h);
  const shows = showCount(h);
  afterShow(h, 1, () => relink(h, foreign.file));
  const outcome = await h.start(['--timeout', '10']);
  assert.equal(showCount(h) - shows >= 1, true);
  assert.equal(outcome.document.outcome, 'conflict', `${outcome.stdout}\n${outcome.stderr}`);
  assert.equal(outcome.document.error.code, 'registered-elsewhere');
  await assertForeignKept(h, foreign);
  await assertUndisturbed(context);
});

test('stop sends no request when the link changes between its two ownership checks', { skip, timeout: 90000 }, async t => {
  const context = await started(t);
  const { h } = context;
  const foreign = await foreignUnit(h);
  const shows = showCount(h);
  // The first check passes on the legitimate link; the link changes while the second inspection is returned.
  afterShow(h, 2, () => relink(h, foreign.file));
  const outcome = await h.stop(['--timeout', '5']);
  assert.equal(showCount(h) - shows, 2, 'the stop inspected the unit twice before refusing');
  assert.equal(outcome.document.outcome, 'conflict', `${outcome.stdout}\n${outcome.stderr}`);
  assert.equal(outcome.document.error.code, 'registered-elsewhere');
  await assertForeignKept(h, foreign);
  await assertUndisturbed(context);
});

test('stop --no-wait sends no request when the link changes between its two ownership checks', { skip, timeout: 90000 }, async t => {
  const context = await started(t);
  const { h } = context;
  const foreign = await foreignUnit(h);
  afterShow(h, 2, () => relink(h, foreign.file));
  const outcome = await h.stop(['--no-wait']);
  assert.equal(outcome.document.outcome, 'conflict', `${outcome.stdout}\n${outcome.stderr}`);
  assert.equal(outcome.document.error.code, 'registered-elsewhere');
  await assertUndisturbed(context);
});

test('a first start requests no native start when the link changes after the unit was linked', { skip, timeout: 90000 }, async t => {
  const h = await createControlledNative(t, 'systemd');
  const foreign = await foreignUnit(h);
  // `show` #1 is the install check (not loaded); `show` #2 inspects the linked unit just before the start request.
  afterShow(h, 2, () => relink(h, foreign.file));
  const outcome = await h.start(['--timeout', '6']);
  assert.notEqual(outcome.status, 0, `${outcome.stdout}\n${outcome.stderr}`);
  assert.notEqual(outcome.document.outcome, 'ready');
  assert.equal(outcome.document.outcome, 'conflict', `${outcome.stdout}\n${outcome.stderr}`);
  assert.equal(outcome.document.error.code, 'registered-elsewhere');
  assert.ok(!h.runner.verbs.includes('start'), `no start was requested: ${h.runner.verbs.join(', ')}`);
  assert.equal(h.service().starts, 0);
  assert.ok(!h.runner.isRunning(h.service()));
  await assertForeignKept(h, foreign);
  h.runner.assertNoViolations();
});

test('a refresh requests no rewrite or reload when the link changes after the manager inspected the unit', { skip, timeout: 120000 }, async t => {
  const { h } = await stopped(t);
  const foreign = await foreignUnit(h);
  const next = path.join(h.root, 'credentials-next.env');
  await fs.writeFile(next, 'OPENCODE_PASSWORD=controlled-native-next-credential\n', { mode: 0o600 });
  await fs.chmod(next, 0o600);
  const definitionBefore = await fs.readFile(h.definitionPath(), 'utf8');
  const before = h.runner.calls.length;
  afterShow(h, 1, () => relink(h, foreign.file));
  const outcome = await h.runJson('start', ['--coordinator-config', h.configFile, '--env-file', next, '--timeout', '10']);
  assert.equal(outcome.document.outcome, 'conflict', `${outcome.stdout}\n${outcome.stderr}`);
  assert.equal(outcome.document.error.code, 'registered-elsewhere');
  assertNoRegistrationChange(h, before);
  assert.equal(await fs.readFile(h.definitionPath(), 'utf8'), definitionBefore);
  await assertForeignKept(h, foreign);
});

test('unloadInactive keeps a link that changed after the manager inspected the unit', { skip, timeout: 120000 }, async t => {
  const { h } = await stopped(t);
  const foreign = await foreignUnit(h);
  const adapter = await h.adapter();
  const before = h.runner.calls.length;
  afterShow(h, 1, () => relink(h, foreign.file));
  const result = await adapter.unloadInactive();
  assert.equal(result.outcome, 'refused', result.detail);
  assertNoRegistrationChange(h, before);
  await assertForeignKept(h, foreign);
});

test('a link restored to the owned definition after a refusal is owned again', { skip, timeout: 90000 }, async t => {
  const context = await started(t);
  const { h, instanceId } = context;
  const foreign = await foreignUnit(h);
  await relink(h, foreign.file);
  const refused = await h.stop(['--timeout', '5']);
  assert.equal(refused.document.outcome, 'conflict', `${refused.stdout}\n${refused.stderr}`);
  await relink(h, h.definitionPath());
  const halt = await h.stop(['--timeout', '60']);
  assert.equal(halt.document.outcome, 'stopped', `${halt.stdout}\n${halt.stderr}`);
  assert.equal(halt.document.instance.instanceId, instanceId);
  h.runner.assertNoViolations();
});
