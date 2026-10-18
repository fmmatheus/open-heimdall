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
 * Credential values are masked wherever the process knows them, whatever their length. The values below are synthetic;
 * they are deliberately shorter than any plausible password and one is a prefix of another. Host authentication policy
 * (what a password may be) is not part of this: the file parser accepts any nonempty value and the values authenticate.
 *
 * End-to-end cases run the production adapters against the controlled native runner (mocked manager, real coordinator
 * process and files) with a wrapper entry point that injects failures into the real shutdown stages.
 */

const posix = process.platform !== 'win32';
const skip = posix ? false : 'the controlled native runner spawns POSIX services';
const cliUrl = pathToFileURL(path.resolve('dist/coordinator/cli.js')).href;

const SHORT = ['§', '§¤', 'Q!7'];
const LONG = '§¤-synthetic-long-credential-tail';
const CREDENTIALS = `OPAQUE_REFERENCE_A=${SHORT[0]}\nOPAQUE_REFERENCE_B=${SHORT[1]}\nOPAQUE_REFERENCE_C=${SHORT[2]}\nOPAQUE_REFERENCE_D=${LONG}\n`;
const KNOWN = [...SHORT, LONG];
const PATTERNS = 'Bearer syntheticbearer123 and https://user:pass@example.test/a and Basic c3ludGhldGljOnNlY3JldA==';
const patternLeaks = text => /syntheticbearer123|user:pass|c3ludGhldGljOnNlY3JldA/.test(text);

/** Every known value is absent from `text`. */
function assertMasked(text, label) {
  for (const value of KNOWN) assert.ok(!text.includes(value), `${label}: credential value ${JSON.stringify(value)} is visible in ${JSON.stringify(text)}`);
  assert.ok(!patternLeaks(text), `${label}: a credential-shaped value is visible in ${JSON.stringify(text)}`);
}

/** Collects every path that shows a known value so one run reports all of them. */
function scanner() {
  const leaks = [];
  return {
    check(text, label) {
      const shown = [...KNOWN.filter(value => text.includes(value)).map(value => JSON.stringify(value)), ...(patternLeaks(text) ? ['credential-shaped text'] : [])];
      if (shown.length) leaks.push(`${label}: ${shown.join(', ')}`);
    },
    done() { assert.deepEqual(leaks, [], 'known credential values must be masked on every path'); },
  };
}

// --- Units ------------------------------------------------------------------------------------------------------

test('the output sanitizer masks short, overlapping and long values and keeps unrelated text', () => {
  const sanitize = createOutputSanitizer(() => [...KNOWN, undefined, '']);
  const text = sanitize(`first ${SHORT[0]} second ${SHORT[1]} third ${SHORT[2]} fourth ${LONG} fifth ${PATTERNS} sixth`);
  assertMasked(text, 'output');
  for (const word of ['first', 'second', 'third', 'fourth', 'fifth', 'sixth']) assert.ok(text.includes(word), `${word} is kept in ${text}`);
  assert.equal(sanitize('nothing to hide here'), 'nothing to hide here');
});

test('a longer value is masked as a whole and masking never alters an earlier replacement', () => {
  assert.equal(maskSecrets(`x ${LONG} y`, KNOWN), 'x [redacted] y');
  assert.equal(maskSecrets('abcdef e', ['abcdef', 'e']), '[redacted] [redacted]');
  assert.equal(createOutputSanitizer(() => ['abcdef', 'e'])('abcdef e'), '[redacted] [redacted]');
  assert.equal(sanitizeResultText('abcdef e', ['abcdef', 'e']), '[redacted] [redacted]');
  assert.equal(sanitizeShutdownError('abcdef e', ['abcdef', 'e']), '[redacted] [redacted]');
});

test('process output writers mask short values in strings and buffers', () => {
  const written = [];
  const stream = { write(chunk) { written.push(String(chunk)); return true; } };
  const restore = sanitizeProcessOutput(createOutputSanitizer(() => SHORT), [stream]);
  stream.write(`a ${SHORT[1]} b`);
  stream.write(Buffer.from(`c ${SHORT[2]} d`));
  restore();
  assert.deepEqual(written, ['a [redacted] b', 'c [redacted] d']);
});

test('lifecycle result strings mask short values; structure, typed codes and context stay', () => {
  const secrets = new Set(KNOWN);
  const result = createLifecycleResult({
    command: 'start', outcome: 'failed', message: `Could not start: ${SHORT[0]} rejected, ${SHORT[1]} too`,
    target: { configFile: `/synthetic/${SHORT[2]}/coordinator.toml`, origin: 'flag', stateDirectory: '/synthetic/state', endpoint: '/synthetic/state/coordinator.sock', manager: 'launchd', label: 'synthetic.label' },
    error: { code: 'launch-failed', message: `The manager said ${LONG} and ${SHORT[2]}; ${PATTERNS}` },
    logs: `See /synthetic/logs/${SHORT[0]}.log`,
  }, secrets);
  assertMasked(JSON.stringify(result), 'result');
  assert.equal(result.outcome, 'failed');
  assert.equal(result.error.code, 'launch-failed');
  assert.equal(result.target.manager, 'launchd');
  assert.match(result.message, /^Could not start: \[redacted\] rejected, \[redacted\] too$/);
  assert.match(result.error.message, /^The manager said \[redacted\] and \[redacted\];/);
  // Only field strings change: the rendered document is valid JSON with the same shape.
  const rendered = renderLifecycleJson(result);
  assert.deepEqual(parseLifecycleResult(JSON.parse(rendered)), result);
  assertMasked(rendered, 'rendered JSON');
  assertMasked(renderLifecycleText(result), 'rendered text');
});

test('stored shutdown diagnostics mask short values passed as known secrets', () => {
  const text = sanitizeShutdownError(new Error(`close failed with ${SHORT[0]}, ${SHORT[1]}, ${SHORT[2]} and ${LONG}; ${PATTERNS}`), KNOWN);
  assertMasked(text, 'diagnostic');
  assert.match(text, /^close failed with \[redacted\], \[redacted\], \[redacted\] and \[redacted\];/);
  assert.equal(sanitizeShutdownError(undefined, KNOWN), 'Shutdown failed without a message');
});

// --- Controls: the same values still authenticate from the selected file -----------------------------------------

async function credentialContext(t) {
  const directory = await fs.realpath(await fs.mkdtemp('/tmp/hs-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'credentials.env');
  await fs.writeFile(file, CREDENTIALS, { mode: 0o600 });
  return loadCredentialFile(file);
}

test('short, overlapping and long values are accepted from the selected file and authenticate unchanged', { skip }, async t => {
  const context = await credentialContext(t);
  assert.deepEqual([...context.values()], KNOWN);
  for (const [reference, value] of [['OPAQUE_REFERENCE_A', SHORT[0]], ['OPAQUE_REFERENCE_B', SHORT[1]], ['OPAQUE_REFERENCE_C', SHORT[2]], ['OPAQUE_REFERENCE_D', LONG]]) {
    assert.equal(context.lookup(reference), value);
    const headers = [];
    const fetchImpl = async (url, options = {}) => {
      headers.push(options.headers?.Authorization);
      return Response.json({ version: '2.0.32', pid: 44 });
    };
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
  // A producer writing a credential value on its own, outside any diagnostic path.
  process.stdout.write('producer stdout: ' + message + '\\n');
  process.stderr.write('producer stderr: ' + message + '\\n');
  throw new Error(message);
} } } });
`);
  return { file, inject: value => fs.writeFile(injection, JSON.stringify(value)) };
}

async function fixture(t, manager) {
  const h = await createControlledNative(t, manager, { gracePeriodMs: 3000 });
  await fs.writeFile(h.credentialFile, CREDENTIALS, { mode: 0o600 });
  const wrapper = await wrapperEntry(h);
  const dependencies = { launchOverrides: { nodeExecutable: process.execPath, entryPoint: wrapper.file } };
  await wrapper.inject({ stage: 'none', message: '', failures: 0 });
  return { h, wrapper, dependencies };
}

const injected = token => `injected failure carrying ${SHORT[0]} then ${SHORT[1]} then ${SHORT[2]} then ${LONG} then ${token} then ${PATTERNS}`;

for (const manager of ['launchd', 'systemd']) {
  test(`${manager}: start failure text carries no credential value, whatever its length`, { skip, timeout: 60000 }, async t => {
    const { h } = await fixture(t, manager);
    const scan = scanner();
    const verb = manager === 'launchd' ? 'bootstrap' : 'link';
    h.runner.respond(verb, { exitCode: 5, stdout: '', stderr: `${manager} refused the service: ${injected('')}` }, { times: 2 });
    const args = ['--coordinator-config', h.configFile, '--env-file', h.credentialFile, '--timeout', '30'];

    const json = await h.runJson('start', args);
    assert.equal(json.document.ok, false);
    assert.notEqual(json.status, 0);
    assert.ok(json.document.error.code, 'the typed error code is kept');
    assert.match(json.document.error.message, /refused the service/, 'useful context is kept');
    scan.check(json.stdout, 'start --json streams stdout'); scan.check(json.stderr, 'start --json streams stderr');
    scan.check(JSON.stringify(json.document), 'start parsed result');

    const text = await h.run('start', args);
    assert.notEqual(text.status, 0);
    assert.match(text.stdout + text.stderr, /refused the service/);
    scan.check(text.stdout, 'start text streams stdout'); scan.check(text.stderr, 'start text streams stderr');
    scan.check(JSON.stringify(text.result), 'start text parsed result');
    scan.done();
  });

  test(`${manager}: a drain failure is stored, served and logged without credential values`, { skip, timeout: 60000 }, async t => {
    const { h, wrapper, dependencies } = await fixture(t, manager);
    const scan = scanner();
    const started = await h.start(['--timeout', '30'], { dependencies });
    assert.equal(started.document.outcome, 'ready', `${started.stdout}${started.stderr}`);
    scan.check(started.stdout, 'start streams stdout'); scan.check(started.stderr, 'start streams stderr');
    const token = await readCoordinatorToken(h.stateDirectory);
    const message = injected(token);
    await wrapper.inject({ stage: 'request', message, failures: 1 });

    // The first shutdown request fails its drain; the coordinator stays open with admission disabled.
    const stopped = await h.stop(['--timeout', '30'], { dependencies });
    assert.equal(stopped.document.ok, false, `${stopped.stdout}${stopped.stderr}`);
    scan.check(stopped.stdout, 'stop streams stdout'); scan.check(stopped.stderr, 'stop streams stderr');
    scan.check(JSON.stringify(stopped.document), 'stop parsed result');
    assert.ok(stopped.document.error.code, 'the typed error code is kept');

    const client = await h.client();
    const lifecycle = await client.request('GET', '/lifecycle');
    assert.equal(lifecycle.phase, 'drain-failed');
    assert.match(lifecycle.shutdown.error, /injected failure carrying/, 'useful context is kept');
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
    assert.match(logs.stdout + logs.stderr, /producer stderr: /, 'the injected failure was produced');
    scan.check(logs.stdout, 'process output stdout'); scan.check(logs.stderr, 'process output stderr');
    assert.ok(!(logs.stdout + logs.stderr).includes(token));
    scan.done();
  });

  test(`${manager}: a close failure ends the process with a sanitized diagnostic and no credential values`, { skip, timeout: 60000 }, async t => {
    const { h, wrapper, dependencies } = await fixture(t, manager);
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
    assert.ok(stopped.document.error.code, 'the typed error code is kept');

    const service = h.service();
    await service.exited;
    assert.equal(service.exit.code, 1, 'the coordinator ended with the failure outcome');

    const record = await readShutdownRecord(h.stateDirectory, instanceId);
    assert.equal(record.status, 'close-failed');
    assert.equal(record.stage, 'scheduler-stop');
    assert.match(record.error, /injected failure carrying/, 'useful context is kept');
    scan.check(JSON.stringify(record), 'shutdown record (reader)');
    const directory = path.join(h.stateDirectory, 'lifecycle');
    const raw = await Promise.all((await fs.readdir(directory)).filter(name => name.startsWith('shutdown')).map(name => fs.readFile(path.join(directory, name), 'utf8')));
    scan.check(raw.join('\n'), 'shutdown record (raw file)');
    assert.ok(!raw.join('\n').includes(token));

    const logs = manager === 'launchd' ? await h.runner.logs(h.logPaths()) : h.runner.journal(service);
    assert.match(logs.stderr, /Coordinator shutdown did not complete cleanly: Close failed at scheduler-stop: injected failure carrying/);
    scan.check(logs.stdout, 'process output stdout'); scan.check(logs.stderr, 'process output stderr');
    assert.ok(!(logs.stdout + logs.stderr).includes(token));
    scan.done();
  });
}
