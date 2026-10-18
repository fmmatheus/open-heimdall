import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadCredentialFile } from '../dist/coordinator/credentials.js';
import { createOutputSanitizer, sanitizeProcessOutput } from '../dist/coordinator/output.js';
import { createLifecycleResult, parseLifecycleResult, renderLifecycleJson, renderLifecycleText, sanitizeResultText } from '../dist/coordinator/lifecycle-result.js';
import { readShutdownRecord, sanitizeShutdownError } from '../dist/coordinator/lifecycle.js';
import { maskSecrets } from '../dist/redaction.js';
import { connect } from '../dist/opencode/observer.js';
import { readCoordinatorToken } from '../dist/coordinator/token.js';
import { createControlledNative } from './fixtures/controlled-native-runner.mjs';

/**
 * A credential value that collides with the syntax of a credential-shaped pattern must not disable that pattern: `B`
 * occurs in `Bearer` and `Basic`, `:` in `://`, `e` in the `[redacted]` marker. Every span is located on the original
 * text, so the payload of an Authorization value or of URL user information is masked whether or not a known value
 * overlaps its syntax. The values and payloads are synthetic. Accepting such values is not at issue here: the file
 * parser takes any nonempty value and they authenticate unchanged.
 *
 * End-to-end cases run the production adapters against the controlled native runner (mocked manager, real coordinator
 * process and files) with a wrapper entry point that injects failures into the real shutdown stages.
 */

const posix = process.platform !== 'win32';
const skip = posix ? false : 'the controlled native runner spawns POSIX services';
const cliUrl = pathToFileURL(path.resolve('dist/coordinator/cli.js')).href;

const BEARER = 'Bearer syntheticbearer123';
const BASIC = 'Basic c3ludGhldGljOnNlY3JldA==';
const URL_CREDENTIALS = 'scheme://syntheticuser:syntheticpassword@example.test/path';
const PATTERNS = `${BEARER} then ${URL_CREDENTIALS} then ${BASIC}`;
const PAYLOADS = ['syntheticbearer123', 'c3ludGhldGljOnNlY3JldA', 'syntheticuser', 'syntheticpassword'];
const payloadLeaks = text => PAYLOADS.filter(payload => text.includes(payload));

/** No credential payload is visible in `text`. */
function assertPayloadsMasked(text, label) {
  assert.deepEqual(payloadLeaks(text), [], `${label}: a credential payload is visible in ${JSON.stringify(text)}`);
}

/** Collects every path that shows a payload so one run reports all of them. */
function scanner() {
  const leaks = [];
  return {
    check(text, label) { const shown = payloadLeaks(text); if (shown.length) leaks.push(`${label}: ${shown.join(', ')}`); },
    done() { assert.deepEqual(leaks, [], 'credential payloads must be masked on every path'); },
  };
}

/** Every helper that masks diagnostic text, so one case covers them all. */
const surfaces = {
  maskSecrets: (text, known) => maskSecrets(text, known),
  outputSanitizer: (text, known) => createOutputSanitizer(() => known)(text),
  resultText: (text, known) => sanitizeResultText(text, known),
  shutdownError: (text, known) => sanitizeShutdownError(new Error(text), known),
};

// --- Collisions: the pattern masks survive a known value that overlaps their syntax ------------------------------

for (const [name, apply] of Object.entries(surfaces)) {
  test(`collision: ${name} masks Bearer and Basic payloads when the known value is B`, () => {
    const text = apply(`first ${BEARER} second ${BASIC} third`, ['B']);
    assertPayloadsMasked(text, name);
    assert.match(text, /^first Bearer \[redacted\] second Basic \[redacted\] third$/, 'the stable markers and context are kept');
  });

  test(`collision: ${name} masks URL user information when the known value is a colon`, () => {
    const text = apply(`failed to reach ${URL_CREDENTIALS} today`, [':']);
    assertPayloadsMasked(text, name);
    assert.match(text, /^failed to reach scheme:\/\/\[redacted\]@example\.test\/path today$/, 'the scheme separator marker and the host are kept');
  });

  test(`collision: ${name} masks every pattern when the known values are B and a colon together`, () => {
    const text = apply(`one ${PATTERNS} two`, ['B', ':']);
    assertPayloadsMasked(text, name);
    assert.match(text, /^one Bearer \[redacted\] then scheme:\/\/\[redacted\]@example\.test\/path then Basic \[redacted\] two$/);
  });
}

test('collision: a capability is masked whole when a known value is a hexadecimal digit', () => {
  const capability = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
  for (const apply of [surfaces.resultText, surfaces.shutdownError]) {
    const text = apply(`token ${capability} end`, ['a', '1']);
    assert.ok(!/[0-9a-f]{8}/i.test(text.replaceAll('[redacted]', '')), `a fragment of the capability is visible in ${text}`);
    assert.equal(text, 'token [redacted] end');
  }
});

test('collision: the producer writers mask payloads in strings and buffers when the known values collide', () => {
  const written = [];
  const stream = { write(chunk) { written.push(String(chunk)); return true; } };
  const restore = sanitizeProcessOutput(createOutputSanitizer(() => ['B', ':']), [stream]);
  stream.write(`a ${BEARER} b\n`);
  stream.write(Buffer.from(`c ${URL_CREDENTIALS} d ${BASIC}\n`));
  restore();
  assertPayloadsMasked(written.join(''), 'producer writer');
  assert.deepEqual(written, ['a Bearer [redacted] b\n', 'c scheme://[redacted]@example.test/path d Basic [redacted]\n']);
});

test('collision: result fields mask payloads while outcome, error code and structure stay', () => {
  const result = createLifecycleResult({
    command: 'stop', outcome: 'failed', message: `Stop failed after ${BEARER}`,
    target: { configFile: `/synthetic/${URL_CREDENTIALS}/coordinator.toml`, origin: 'flag', stateDirectory: '/synthetic/state', endpoint: '/synthetic/state/coordinator.sock', manager: 'launchd', label: 'synthetic.label' },
    error: { code: 'drain-failed', message: `Drain failed with ${BASIC} at ${URL_CREDENTIALS}` },
    logs: `See ${URL_CREDENTIALS}`,
  }, ['B', ':']);
  assertPayloadsMasked(JSON.stringify(result), 'result');
  assert.equal(result.outcome, 'failed');
  assert.equal(result.error.code, 'drain-failed');
  assert.equal(result.command, 'stop');
  assert.equal(result.target.manager, 'launchd');
  assert.equal(result.message, 'Stop failed after Bearer [redacted]');
  assert.equal(result.error.message, 'Drain failed with Basic [redacted] at scheme://[redacted]@example.test/path');
  const rendered = renderLifecycleJson(result);
  assert.deepEqual(parseLifecycleResult(JSON.parse(rendered)), result);
  assertPayloadsMasked(rendered, 'rendered JSON');
  assertPayloadsMasked(renderLifecycleText(result), 'rendered text');
});

// --- Controls: nothing changes where there is no collision -------------------------------------------------------

for (const [name, apply] of Object.entries(surfaces)) {
  test(`control: ${name} masks every pattern without a known value`, () => {
    for (const known of [[], [''], ['unrelated-credential']]) {
      const text = apply(`one ${PATTERNS} two`, known);
      assertPayloadsMasked(text, name);
      assert.match(text, /^one Bearer \[redacted\] then scheme:\/\/\[redacted\]@example\.test\/path then Basic \[redacted\] two$/);
    }
  });

  test(`control: ${name} masks the known value e without altering a marker`, () => {
    assert.equal(apply('eee', ['e']), '[redacted][redacted][redacted]');
    assert.equal(apply('abcdef e', ['abcdef', 'e']), '[redacted] [redacted]');
    assert.equal(apply('nothing here', ['q']), 'nothing here');
  });

  test(`collision: ${name} keeps the payload masks and markers intact when the known value is e`, () => {
    const text = apply(`one ${BEARER} two ${URL_CREDENTIALS}`, ['e']);
    assertPayloadsMasked(text, name);
    // The scheme and host contain the known value too, so only the shape of the user information marker is asserted.
    assert.match(text, /^on\[redacted\] Bearer \[redacted\] two .*:\/\/\[redacted\]@/);
  });

  test(`collision: ${name} keeps the Bearer marker whole when the known values are e and B`, () => {
    const text = apply(`one ${BEARER} two`, ['e', 'B']);
    assert.equal(text, 'on[redacted] Bearer [redacted] two');
  });

  test(`collision: ${name} masks partially overlapping values as one`, () => {
    assert.equal(apply('x abcdey', ['abcd', 'bcde']), 'x [redacted]y');
  });

  test(`control: ${name} masks longer, contained and metacharacter values as written`, () => {
    assert.equal(apply('x abcdefgh y abc z', ['abc', 'abcdefgh']), 'x [redacted] y [redacted] z');
    const metacharacters = ['.*', 'a+b', '(x)|[y]', '\\d', '$&', '^', '?{1}'];
    assert.equal(
      apply('pre .* a+b (x)|[y] \\d $& ^ ?{1} post', metacharacters),
      'pre [redacted] [redacted] [redacted] [redacted] [redacted] [redacted] [redacted] post',
    );
    // The metacharacters are literal: ordinary text that the unescaped patterns would match stays.
    assert.equal(apply('abbb xxyy 123 ab', metacharacters), 'abbb xxyy 123 ab');
  });
}

test('control: one, two and three character values are accepted from a private file and authenticate unchanged', { skip }, async t => {
  const values = ['B', ':', 'e', 'B:', '§¤', 'Q!7'];
  const directory = await fs.realpath(await fs.mkdtemp('/tmp/hr-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'credentials.env');
  await fs.writeFile(file, values.map((value, index) => `OPAQUE_REFERENCE_${index}=${value}\n`).join(''), { mode: 0o600 });
  const context = await loadCredentialFile(file);
  assert.deepEqual([...context.values()], values);
  for (const [index, value] of values.entries()) {
    const reference = `OPAQUE_REFERENCE_${index}`;
    assert.equal(context.lookup(reference), value);
    const headers = [];
    const fetchImpl = async (url, options = {}) => { headers.push(options.headers?.Authorization); return Response.json({ version: '2.0.32', pid: 44 }); };
    await connect('/synthetic/project', undefined, {
      baseUrl: 'http://127.0.0.1:4096', authentication: 'basic', passwordEnvironmentVariable: reference, environment: context.environmentFor(reference, {}), fetchImpl,
    });
    assert.ok(headers.length > 0);
    assert.ok(headers.every(header => header === 'Basic ' + Buffer.from('opencode:' + value).toString('base64')), `${JSON.stringify(value)} authenticates from the file`);
  }
});

// --- End to end ---------------------------------------------------------------------------------------------------

/** An entry point that runs the real coordinator and fails real shutdown stages with the text found in `inject.json`. */
async function wrapperEntry(h) {
  const file = path.join(h.root, 'wrapper.mjs');
  const injection = path.join(h.root, 'inject.json');
  await fs.writeFile(file, `import fs from 'node:fs';
import { coordinatorMain } from ${JSON.stringify(cliUrl)};
const read = () => JSON.parse(fs.readFileSync(${JSON.stringify(injection)}, 'utf8'));
let requests = 0;
await coordinatorMain(process.argv.slice(3), { serviceOptions: { testHooks: { shutdownStage: async stage => {
  const { message, stage: target, failures } = read();
  if (stage !== target) return;
  if (stage === 'request' && ++requests > failures) return;
  // A producer writing the pattern payloads on its own, outside any diagnostic path.
  process.stdout.write('producer stdout: ' + message + '\\n');
  process.stderr.write('producer stderr: ' + message + '\\n');
  throw new Error(message);
} } } });
`);
  return { file, inject: value => fs.writeFile(injection, JSON.stringify(value)) };
}

const VARIANTS = [
  { name: 'colliding values', credentials: 'OPAQUE_REFERENCE_A=B\nOPAQUE_REFERENCE_B=:\n' },
  { name: 'no colliding value (control)', credentials: 'OPAQUE_REFERENCE_A=control-credential-unrelated-to-the-patterns\n' },
];

async function fixture(t, manager, credentials) {
  const h = await createControlledNative(t, manager, { gracePeriodMs: 3000 });
  await fs.writeFile(h.credentialFile, credentials, { mode: 0o600 });
  const wrapper = await wrapperEntry(h);
  const dependencies = { launchOverrides: { nodeExecutable: process.execPath, entryPoint: wrapper.file } };
  await wrapper.inject({ stage: 'none', message: '', failures: 0 });
  return { h, wrapper, dependencies };
}

const injected = token => `injected failure carrying ${token} then ${PATTERNS}`;
const MARKERS = [/Bearer \[redacted\]/, /scheme:\/\/\[redacted\]@example\.test/, /Basic \[redacted\]/];

for (const manager of ['launchd', 'systemd']) {
  for (const variant of VARIANTS) {
    test(`${manager} (${variant.name}): start failure text carries no credential payload`, { skip, timeout: 60000 }, async t => {
      const { h } = await fixture(t, manager, variant.credentials);
      const scan = scanner();
      const verb = manager === 'launchd' ? 'bootstrap' : 'link';
      h.runner.respond(verb, { exitCode: 5, stdout: '', stderr: `${manager} refused the service: ${injected('')}` }, { times: 2 });
      const args = ['--coordinator-config', h.configFile, '--env-file', h.credentialFile, '--timeout', '30'];

      const json = await h.runJson('start', args);
      assert.equal(json.document.ok, false);
      assert.notEqual(json.status, 0);
      assert.ok(json.document.error.code, 'the typed error code is kept');
      assert.match(json.document.error.message, /refused the service/, 'useful context is kept');
      for (const marker of MARKERS) assert.match(json.document.error.message, marker);
      scan.check(json.stdout, 'start --json streams stdout'); scan.check(json.stderr, 'start --json streams stderr');
      scan.check(JSON.stringify(json.document), 'start parsed result');

      const text = await h.run('start', args);
      assert.notEqual(text.status, 0);
      assert.match(text.stdout + text.stderr, /refused the service/);
      scan.check(text.stdout, 'start text streams stdout'); scan.check(text.stderr, 'start text streams stderr');
      scan.check(JSON.stringify(text.result), 'start text parsed result');
      assert.equal(text.result.error.code, json.document.error.code, 'the typed error code is the same in both renderings');
      scan.done();
    });

    test(`${manager} (${variant.name}): a drain failure is stored, served and logged without credential payloads`, { skip, timeout: 60000 }, async t => {
      const { h, wrapper, dependencies } = await fixture(t, manager, variant.credentials);
      const scan = scanner();
      const started = await h.start(['--timeout', '30'], { dependencies });
      assert.equal(started.document.outcome, 'ready', `${started.stdout}${started.stderr}`);
      scan.check(started.stdout, 'start streams stdout'); scan.check(started.stderr, 'start streams stderr');
      const token = await readCoordinatorToken(h.stateDirectory);
      await wrapper.inject({ stage: 'request', message: injected(token), failures: 1 });

      // The first shutdown request fails its drain; the coordinator stays open with admission disabled.
      const stopped = await h.stop(['--timeout', '30'], { dependencies });
      assert.equal(stopped.document.ok, false, `${stopped.stdout}${stopped.stderr}`);
      scan.check(stopped.stdout, 'stop streams stdout'); scan.check(stopped.stderr, 'stop streams stderr');
      scan.check(JSON.stringify(stopped.document), 'stop parsed result');
      assert.ok(stopped.document.error.code, 'the original failure code is observable');
      assert.notEqual(stopped.document.outcome, 'ready');

      const client = await h.client();
      const lifecycle = await client.request('GET', '/lifecycle');
      assert.equal(lifecycle.phase, 'drain-failed');
      assert.match(lifecycle.shutdown.error, /injected failure carrying/, 'useful context is kept');
      for (const marker of MARKERS) assert.match(lifecycle.shutdown.error, marker);
      scan.check(JSON.stringify(lifecycle), '/lifecycle response');
      assert.ok(!JSON.stringify(lifecycle).includes(token), 'the capability is masked too');

      const record = await readShutdownRecord(h.stateDirectory, lifecycle.instanceId);
      assert.equal(record.status, 'drain-failed');
      scan.check(JSON.stringify(record), 'shutdown record (reader)');
      const directory = path.join(h.stateDirectory, 'lifecycle');
      const raw = await Promise.all((await fs.readdir(directory)).filter(name => name.startsWith('shutdown')).map(name => fs.readFile(path.join(directory, name), 'utf8')));
      assert.ok(raw.length > 0, 'a shutdown record file exists');
      scan.check(raw.join('\n'), 'shutdown record (raw file)');
      assert.ok(!raw.join('\n').includes(token));

      const logs = manager === 'launchd' ? await h.runner.logs(h.logPaths()) : h.runner.journal(h.service());
      assert.match(logs.stdout + logs.stderr, /producer stderr/, 'the injected failure was produced');
      scan.check(logs.stdout, 'process output stdout'); scan.check(logs.stderr, 'process output stderr');
      for (const marker of MARKERS) assert.match(logs.stderr, marker, 'the producer stream keeps the stable markers');
      assert.ok(!(logs.stdout + logs.stderr).includes(token));
      scan.done();
    });

    test(`${manager} (${variant.name}): a close failure ends the process with a sanitized diagnostic and no credential payloads`, { skip, timeout: 60000 }, async t => {
      const { h, wrapper, dependencies } = await fixture(t, manager, variant.credentials);
      const scan = scanner();
      const started = await h.start(['--timeout', '30'], { dependencies });
      assert.equal(started.document.outcome, 'ready', `${started.stdout}${started.stderr}`);
      const token = await readCoordinatorToken(h.stateDirectory);
      const client = await h.client();
      const { instanceId } = await client.request('GET', '/lifecycle');
      await wrapper.inject({ stage: 'scheduler-stop', message: injected(token), failures: 0 });

      const stopped = await h.stop(['--timeout', '30'], { dependencies });
      assert.equal(stopped.document.ok, false, `${stopped.stdout}${stopped.stderr}`);
      scan.check(stopped.stdout, 'stop streams stdout'); scan.check(stopped.stderr, 'stop streams stderr');
      scan.check(JSON.stringify(stopped.document), 'stop parsed result');
      assert.ok(stopped.document.error.code, 'the original failure code is observable');

      const service = h.service();
      await service.exited;
      assert.equal(service.exit.code, 1, 'the coordinator ended with the failure outcome');

      const record = await readShutdownRecord(h.stateDirectory, instanceId);
      assert.equal(record.status, 'close-failed');
      assert.equal(record.stage, 'scheduler-stop');
      assert.match(record.error, /injected failure carrying/, 'useful context is kept');
      for (const marker of MARKERS) assert.match(record.error, marker);
      scan.check(JSON.stringify(record), 'shutdown record (reader)');
      const directory = path.join(h.stateDirectory, 'lifecycle');
      const raw = await Promise.all((await fs.readdir(directory)).filter(name => name.startsWith('shutdown')).map(name => fs.readFile(path.join(directory, name), 'utf8')));
      scan.check(raw.join('\n'), 'shutdown record (raw file)');
      assert.ok(!raw.join('\n').includes(token));

      const logs = manager === 'launchd' ? await h.runner.logs(h.logPaths()) : h.runner.journal(service);
      assert.match(logs.stderr, /Coordinator shutdown did not complete cleanly.*Close failed at scheduler-stop.*injected failure carrying/);
      scan.check(logs.stdout, 'process output stdout'); scan.check(logs.stderr, 'process output stderr');
      assert.ok(!(logs.stdout + logs.stderr).includes(token));
      scan.done();
    });
  }
}
