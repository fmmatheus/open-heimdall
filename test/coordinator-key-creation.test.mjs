import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readCoordinatorToken } from '../dist/coordinator/token.js';

const service = pathToFileURL(fileURLToPath(new URL('../dist/coordinator/service.js', import.meta.url))).href;
const childSource = `
import path from 'node:path';
import { startCoordinatorService } from ${JSON.stringify(service)};
const state = process.argv[1];
const configuration = { stateDirectory: state, endpoint: path.join(state, 'coordinator.sock'), globalConcurrency: 1, projectConcurrency: 1 };
const executor = { async launch() {}, async inspect() { return { idle: false, status: 'unknown' }; } };
const running = await startCoordinatorService({ configuration, executor, pollIntervalMs: 60000 });
process.stdout.write('ready\\n');
process.on('SIGTERM', () => { void running.close().then(() => process.exit(0)); });
setInterval(() => {}, 1000);
`;

async function temporary(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hk-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

/** Starts a service process on the state directory and reports every unusable key read until it is ready. */
async function startAndObserve(t, state) {
  const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', childSource, state], { stdio: ['ignore', 'pipe', 'inherit'] });
  const ready = new Promise((resolve, reject) => {
    child.stdout.once('data', resolve);
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`service exited with ${code} before it was ready`)));
  });
  let done = false;
  const readiness = ready.then(() => { done = true; });
  const unusable = [];
  while (!done) {
    try { await readCoordinatorToken(state); }
    catch (error) { if (error.code !== 'ENOENT') unusable.push(error.message); }
    await new Promise(resolve => setImmediate(resolve));
  }
  await readiness;
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.removeAllListeners('exit');
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  };
  t.after(stop);
  return { unusable, stop };
}

test('a reader never sees the access key before it holds a complete token', async t => {
  const root = await temporary(t);
  const observed = [];
  for (let attempt = 0; attempt < 12; attempt++) {
    const state = path.join(root, `state-${attempt}`);
    await fs.mkdir(state, { mode: 0o700 });
    const started = await startAndObserve(t, state);
    observed.push(...started.unusable);
    assert.match(await readCoordinatorToken(state), /^[a-f0-9]{64}$/);
    await started.stop();
  }
  assert.deepEqual(observed, []);
});

test('the key is private, keeps no pending file, and an existing key is kept across starts', async t => {
  const state = path.join(await temporary(t), 'state');
  await fs.mkdir(state, { mode: 0o700 });
  const first = await startAndObserve(t, state);
  const key = await readCoordinatorToken(state);
  assert.equal((await fs.stat(path.join(state, 'coordinator.key'))).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(state)).filter(name => name.includes('pending')), []);
  await first.stop();
  const second = await startAndObserve(t, state);
  assert.equal(await readCoordinatorToken(state), key);
  await second.stop();
});

test('a pending file left by an interrupted start is replaced', async t => {
  const state = path.join(await temporary(t), 'state');
  await fs.mkdir(state, { mode: 0o700 });
  await fs.writeFile(path.join(state, 'coordinator.key.pending'), '', { mode: 0o600 });
  const started = await startAndObserve(t, state);
  assert.match(await readCoordinatorToken(state), /^[a-f0-9]{64}$/);
  assert.deepEqual((await fs.readdir(state)).filter(name => name.includes('pending')), []);
  await started.stop();
});
