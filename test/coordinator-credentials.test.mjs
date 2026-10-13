import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { loadCredentialFile, CredentialFileError, isControlVariable } from '../dist/coordinator/credentials.js';
import { createOutputSanitizer, sanitizeProcessOutput } from '../dist/coordinator/output.js';

const posix = process.platform !== 'win32';
const cliUrl = pathToFileURL(path.resolve('dist/coordinator/cli.js')).href;
const cliPath = path.resolve('dist/cli.js');

async function temporaryRoot(t) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hdc-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  return temporary;
}

async function credentialFile(t, content, mode = 0o600) {
  const directory = await temporaryRoot(t);
  const file = path.join(directory, 'credentials.env');
  await fs.writeFile(file, content, { mode });
  await fs.chmod(file, mode);
  return { directory, file };
}

const snapshot = async file => { const stat = await fs.stat(file); return { bytes: (await fs.readFile(file)).toString('hex'), mode: stat.mode, mtimeMs: stat.mtimeMs }; };

test('parses NAME=value lines, comments, blanks and matching quotes into a frozen lookup', async t => {
  const { file } = await credentialFile(t, '# comment\n\nFIRST=plain value  \nSECOND="quoted # value"\r\nTHIRD=\'single\'\nFOURTH=a=b=c\n');
  const before = await snapshot(file);
  const context = await loadCredentialFile(file);
  assert.deepEqual(context.names, ['FIRST', 'SECOND', 'THIRD', 'FOURTH']);
  assert.equal(context.lookup('FIRST'), 'plain value');
  assert.equal(context.lookup('SECOND'), 'quoted # value');
  assert.equal(context.lookup('THIRD'), 'single');
  assert.equal(context.lookup('FOURTH'), 'a=b=c');
  assert.equal(context.lookup('MISSING'), undefined);
  assert.ok(Object.isFrozen(context) && Object.isFrozen(context.names) && Object.isFrozen(context.values()));
  assert.equal(process.env.FIRST, undefined);
  assert.deepEqual(await snapshot(file), before, 'the file is never modified');
});

test('environmentFor carries only the selected variable and the data directory selection', async t => {
  const { file } = await credentialFile(t, 'SYNTHETIC_PASSWORD=synthetic-secret\nOTHER=synthetic-other\n');
  const context = await loadCredentialFile(file);
  const environment = context.environmentFor('SYNTHETIC_PASSWORD', { PATH: '/bin', HOME: '/h', SYNTHETIC_PASSWORD: 'ambient', OPENCHAMBER_DATA_DIR: '/synthetic/data' });
  assert.deepEqual({ ...environment }, { SYNTHETIC_PASSWORD: 'synthetic-secret', OPENCHAMBER_DATA_DIR: '/synthetic/data' });
  assert.deepEqual({ ...context.environmentFor('ABSENT', { SYNTHETIC_PASSWORD: 'ambient' }) }, {});
});

test('rejects malformed content with line numbers only, never contents', { skip: !posix }, async t => {
  const secret = 'synthetic-leak-sentinel';
  const cases = [
    [`GOOD=value\nexport BAD=${secret}\n`, /line 2 is not NAME=value/],
    [`${secret}\n`, /line 1 is not NAME=value/],
    [`1BAD=${secret}\n`, /line 1 is not NAME=value/],
    [`NAME =${secret}\n`, /line 1 is not NAME=value/],
    [`NAME="${secret}\n`, /line 1 has an unterminated/],
    [`NAME="${secret}'\n`, /line 1 has an unterminated/],
    [`NAME=\n`, /line 1 has an empty value/],
    [`NAME=${secret}\u0007\n`, /line 1 has an empty value or a control character/],
    [`NAME=${secret}\nNAME=${secret}2\n`, /NAME is defined more than once \(lines 1 and 2\)/],
  ];
  for (const [content, pattern] of cases) {
    const { file } = await credentialFile(t, content);
    const error = await loadCredentialFile(file).then(() => assert.fail('must reject'), reason => reason);
    assert.ok(error instanceof CredentialFileError);
    assert.match(error.message, pattern);
    assert.ok(!error.message.includes(secret), error.message);
  }
  const { file } = await credentialFile(t, Buffer.from([0xff, 0xfe, 0x41]));
  await assert.rejects(loadCredentialFile(file), /not valid UTF-8/);
});

test('rejects control variables by name only', { skip: !posix }, async t => {
  const names = ['HOME', 'PATH', 'NODE_OPTIONS', 'NODE_PATH', 'HEIMDALL_COORDINATOR_CONFIG', 'OPENCHAMBER_DATA_DIR', 'GIT_DIR', 'GIT_SSH_COMMAND', 'XDG_CONFIG_HOME', 'npm_config_registry', 'NPM_CONFIG_PREFIX', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES'];
  for (const name of names) {
    assert.ok(isControlVariable(name), name);
    const { file } = await credentialFile(t, `${name}=synthetic-leak-sentinel\n`);
    const error = await loadCredentialFile(file).then(() => assert.fail('must reject'), reason => reason);
    assert.match(error.message, new RegExp(`line 1 sets ${name},`));
    assert.ok(!error.message.includes('synthetic-leak-sentinel'));
  }
  for (const name of ['OPENCODE_PASSWORD', 'SYNTHETIC_PASSWORD', 'NODEMAN_TOKEN']) assert.ok(!isControlVariable(name), name);
});

test('rejects symbolic links, directories, pipes, group or other access and oversized files without touching them', { skip: !posix }, async t => {
  const { directory, file } = await credentialFile(t, 'NAME=synthetic-secret\n');
  const link = path.join(directory, 'link.env');
  await fs.symlink(file, link);
  await assert.rejects(loadCredentialFile(link), /must not be a symbolic link/);
  await assert.rejects(loadCredentialFile(directory), /must be a regular file/);
  await assert.rejects(loadCredentialFile(path.join(directory, 'absent.env')), /does not exist/);
  const fifo = path.join(directory, 'pipe.env');
  assert.equal(spawnSync('mkfifo', [fifo]).status, 0);
  await fs.chmod(fifo, 0o600);
  await assert.rejects(loadCredentialFile(fifo), /must be a regular file/);
  const before = await snapshot(file);
  for (const mode of [0o640, 0o604, 0o660, 0o644, 0o666, 0o610]) {
    await fs.chmod(file, mode);
    await assert.rejects(loadCredentialFile(file), /must not be accessible by group or others/, mode.toString(8));
    assert.equal((await fs.stat(file)).mode & 0o777, mode, 'the mode is never repaired');
  }
  await fs.chmod(file, before.mode & 0o777);
  await assert.rejects(loadCredentialFile(file, { uid: (process.getuid?.() ?? 0) + 1 }), /must be owned by the current user/);
  const large = await credentialFile(t, 'NAME=' + 'x'.repeat(70 * 1024) + '\n');
  await assert.rejects(loadCredentialFile(large.file), /larger than/);
  assert.deepEqual({ ...await snapshot(file), mtimeMs: 0 }, { ...before, mtimeMs: 0 });
});

test('a path swapped for a link after opening cannot change what is validated', { skip: !posix }, async t => {
  const { directory, file } = await credentialFile(t, 'NAME=synthetic-secret\n');
  const other = path.join(directory, 'other.env');
  await fs.writeFile(other, 'NAME=synthetic-substituted\n', { mode: 0o600 });
  const context = await loadCredentialFile(file, { hooks: { afterOpen: async () => { await fs.rm(file); await fs.symlink(other, file); } } });
  assert.equal(context.lookup('NAME'), 'synthetic-secret');
});

test('the output sanitizer masks credentials, capabilities and authorization patterns, including short values', () => {
  const sanitize = createOutputSanitizer(() => ['abcd', 'ab', undefined, 'synthetic-owner-token']);
  const text = sanitize('x abcd ab synthetic-owner-token Authorization: Bearer syntheticbearer123 Basic c3ludGhldGljOnNlY3JldA== https://user:pass@example.test/a');
  assert.ok(!/abcd|synthetic-owner-token|syntheticbearer123|c3ludGhldGljOnNlY3JldA|user:pass/.test(text), text);
  assert.ok(!/\bab\b/.test(text), 'a known value is masked whatever its length');
  assert.ok(text.startsWith('x [redacted] [redacted] [redacted] Authorization: Bearer [redacted]'), text);
  assert.equal(createOutputSanitizer(() => { throw new Error('source failed'); })('Bearer syntheticbearer123 kept'), 'Bearer [redacted] kept');
});

test('sanitizeProcessOutput routes writes through the sanitizer and restores the writers', () => {
  const written = [];
  const stream = { write(chunk) { written.push(String(chunk)); return true; } };
  const original = stream.write;
  const restore = sanitizeProcessOutput(text => text.replaceAll('secret-value', '[redacted]'), [stream]);
  stream.write('a secret-value b');
  stream.write(Buffer.from('c secret-value d'));
  restore();
  assert.deepEqual(written, ['a [redacted] b', 'c [redacted] d']);
  assert.equal(stream.write, original);
});

async function serve(t, { environment = {}, envFile, script } = {}) {
  const temporary = await temporaryRoot(t);
  const stateDirectory = path.join(temporary, 's');
  const home = path.join(temporary, 'home');
  await fs.mkdir(home);
  const config = path.join(temporary, 'coordinator.toml');
  await fs.writeFile(config, `[coordinator]\nstateDirectory = ${JSON.stringify(stateDirectory)}\n`);
  const extra = envFile ? ['--env-file', envFile] : [];
  const args = script ? ['--no-warnings', '--input-type=module', '-e', script] : ['--no-warnings', cliPath, 'coordinator', 'serve', '--coordinator-config', config, ...extra];
  const child = spawn(process.execPath, args, { env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, 'c'), XDG_STATE_HOME: path.join(home, 's'), HEIMDALL_COORDINATOR_CONFIG: '', CONFIG: config, ENV_FILE: envFile ?? '', ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', chunk => { output.stdout += chunk; });
  child.stderr.on('data', chunk => { output.stderr += chunk; });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  return { child, output, exited, stateDirectory };
}

test('serve with an invalid credential file fails before creating any coordinator state', { skip: !posix, timeout: 30000 }, async t => {
  const { file } = await credentialFile(t, 'SYNTHETIC_PASSWORD=synthetic-leak-sentinel\n', 0o644);
  const f = await serve(t, { envFile: file });
  const { code } = await f.exited;
  assert.notEqual(code, 0);
  assert.match(f.output.stderr, /must not be accessible by group or others/);
  assert.ok(!(f.output.stdout + f.output.stderr).includes('synthetic-leak-sentinel'));
  await assert.rejects(fs.stat(f.stateDirectory), { code: 'ENOENT' });
});

test('serve rejects --env-file for other commands and without a value', async t => {
  const { file } = await credentialFile(t, 'SYNTHETIC_PASSWORD=synthetic-secret\n');
  for (const args of [['coordinator', 'status', '--env-file', file], ['coordinator', 'serve', '--env-file']]) {
    const result = spawnSync(process.execPath, ['--no-warnings', cliPath, ...args], { encoding: 'utf8' });
    assert.notEqual(result.status, 0, args.join(' '));
  }
});

const failingServe = `import { coordinatorMain } from ${JSON.stringify(cliUrl)};
await coordinatorMain(['serve', '--coordinator-config', process.env.CONFIG, '--env-file', process.env.ENV_FILE], { serviceOptions: { testHooks: { shutdownStage: async stage => {
  if (stage === 'scheduler-stop') throw new Error('injected close failure with ' + process.env.LEAK_VALUE + ' and Bearer syntheticbearer123 at https://user:pass@example.test');
} } } });`;

test('serve output never contains credential values, even in shutdown failure diagnostics', { skip: !posix, timeout: 30000 }, async t => {
  const secret = 'synthetic-leak-sentinel';
  const { file } = await credentialFile(t, `SYNTHETIC_PASSWORD=${secret}\n`);
  const f = await serve(t, { envFile: file, script: failingServe, environment: { LEAK_VALUE: secret } });
  for (let index = 0; index < 1000 && !/Coordinator listening/.test(f.output.stdout); index++) {
    if (f.child.exitCode !== null) assert.fail('child exited: ' + f.output.stderr);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.match(f.output.stdout, /Coordinator listening/);
  f.child.kill('SIGTERM');
  for (let index = 0; index < 1000 && !/did not complete cleanly/.test(f.output.stderr); index++) await new Promise(resolve => setTimeout(resolve, 10));
  f.child.kill('SIGKILL');
  await f.exited;
  const combined = f.output.stdout + f.output.stderr;
  assert.match(f.output.stderr, /injected close failure/);
  assert.ok(!combined.includes(secret), combined);
  assert.ok(!/syntheticbearer123|user:pass/.test(combined), combined);
});
