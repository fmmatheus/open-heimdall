import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const call = args => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, HEIMDALL_CONFIG: '' } });
async function project(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-cli-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
test('init refuses to overwrite a configuration and check does not contact a server', async t => {
  const directory = await project(t);
  // Deliberately provide the config path so no ambient application config participates.
  const args = ['--project', directory, '--config', '.heimdall.toml'];
  assert.equal(call(['init', ...args]).status, 0);
  const file = path.join(directory, '.heimdall.toml');
  const original = await fs.readFile(file, 'utf8');
  assert.equal(call(['init', ...args]).status, 1);
  assert.equal(await fs.readFile(file, 'utf8'), original);
  const check = call(['check', ...args]);
  assert.equal(check.status, 0, check.stderr);
  assert.match(check.stdout, /Usage limits disabled/);
  assert.deepEqual(await fs.readdir(directory), ['.heimdall.toml']);
});
test('status reads saved progress without changing the state or lock', async t => {
  const directory = await project(t);
  const args = ['--project', directory, '--config', '.heimdall.toml'];
  assert.equal(call(['init', ...args]).status, 0);
  const root = path.join(directory, '.heimdall');
  const run = path.join(root, 'runs', 'synthetic-run');
  await fs.mkdir(run, { recursive: true });
  const state = JSON.stringify({ id: 'synthetic-run', status: 'running', child: 'synthetic-child' });
  await fs.writeFile(path.join(run, 'state.json'), state);
  await fs.writeFile(path.join(root, 'active.lock'), 'synthetic-lock');
  const result = call(['status', 'synthetic-run', ...args]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), JSON.parse(state));
  assert.equal(await fs.readFile(path.join(run, 'state.json'), 'utf8'), state);
  assert.equal(await fs.readFile(path.join(root, 'active.lock'), 'utf8'), 'synthetic-lock');
  assert.equal(call(['status', '../another-run', ...args]).status, 1);
});
