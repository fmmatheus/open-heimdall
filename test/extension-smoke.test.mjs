import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createCoordinatorClient } from '../dist/coordinator/client.js';
import { startCoordinatorService } from '../dist/coordinator/service.js';
import { readCoordinatorToken } from '../dist/coordinator/token.js';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVICE_TOKEN = 'svc-' + 'd00dfeed'.repeat(8);
const CAP = 200000;

const git = (directory, args) => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commitAll = (directory, message) => { git(directory, ['add', '-A']); git(directory, ['commit', '-m', message]); };

function call(port, target, { method = 'GET', body, token = SERVICE_TOKEN } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method, path: target, headers: token === null ? {} : { Authorization: `Bearer ${token}` } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try { json = JSON.parse(text); } catch { json = undefined; }
        resolve({ status: response.statusCode, text, json, bytes: Buffer.byteLength(text) });
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function settled(store, runId) {
  for (let n = 0; n < 400; n++) {
    const run = store.getRun(runId);
    if (run.status === 'running' || run.status === 'reconciliation-required') return run;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Fixture launch did not settle');
}

test('built service answers run, change, review and diff requests for a real temp coordinator without side effects', async t => {
  // Short paths: Unix socket paths are length limited and the default config location is HOME-relative.
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'hd-sm-')));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const project = path.join(temporary, 'source');
  const state = path.join(temporary, 'state');
  const home = path.join(temporary, 'home');
  await fs.mkdir(project);
  await fs.mkdir(path.join(home, '.config', 'heimdall'), { recursive: true });
  git(project, ['init', '-b', 'main']);
  git(project, ['config', 'user.name', 'Fixture']);
  git(project, ['config', 'user.email', 'fixture@example.invalid']);
  await fs.writeFile(path.join(project, 'README.md'), 'pinned base\n');
  await fs.writeFile(path.join(project, 'edit.txt'), 'original\n');
  await fs.writeFile(path.join(project, 'big.txt'), Array.from({ length: 20000 }, (_, index) => `base line ${index}\n`).join(''));
  commitAll(project, 'fixture');
  await fs.writeFile(path.join(project, '.heimdall.toml'), `[workflow]\nplannerModel = "anthropic/fixture"\nexecutorModel = "anthropic/fixture"\nexecutorFallbackModel = "openai/fixture"\n[opencode]\nbaseUrl = "http://127.0.0.1:4096"\n`);
  await fs.writeFile(path.join(home, '.config', 'heimdall', 'coordinator.toml'), `[coordinator]\nstateDirectory = ${JSON.stringify(state)}\n`);

  const configuration = { stateDirectory: state, endpoint: path.join(state, 'coordinator.sock'), globalConcurrency: 2, projectConcurrency: 1 };
  const executor = { async launch() {}, async inspect() { return { idle: false, status: 'unknown' }; } };
  const service = await startCoordinatorService({ configuration, executor, pollIntervalMs: 60000 });
  t.after(() => service.close());
  const key = await readCoordinatorToken(state);
  const client = createCoordinatorClient(configuration.endpoint, key);
  const registered = await client.request('POST', '/projects', { directory: project });
  const submitted = await client.request('POST', '/runs', { projectId: registered.id, feature: 'Implement the specified feature <img src=x onerror=alert(1)>.' });
  await service.scheduler.tick();
  const run = await settled(service.store, submitted.id);
  assert.equal(run.status, 'running', run.reason ?? '');
  const ownerToken = run.ownerToken;
  assert.ok(ownerToken && ownerToken.length > 8);

  // Committed, staged, unstaged, untracked, deleted and large changes in the managed worktree.
  const checkout = run.worktreePath;
  await fs.writeFile(path.join(checkout, 'edit.txt'), 'original\ncommitted line\n');
  await fs.writeFile(path.join(checkout, 'committed.txt'), 'committed during the run\n');
  commitAll(checkout, 'Agent commit');
  await fs.writeFile(path.join(checkout, 'edit.txt'), 'original\ncommitted line\nuncommitted line\n');
  await fs.writeFile(path.join(checkout, 'untracked.txt'), 'untracked file\n');
  await fs.writeFile(path.join(checkout, 'big.txt'), Array.from({ length: 20000 }, (_, index) => `changed line ${index}\n`).join(''));
  await fs.rm(path.join(checkout, 'README.md'));

  const gitState = () => ({
    status: execFileSync('git', ['status', '--porcelain=v2', '-z', '--untracked-files=all'], { cwd: checkout, encoding: 'utf8' }),
    head: git(checkout, ['rev-parse', 'HEAD']),
    branch: git(checkout, ['symbolic-ref', '--short', 'HEAD']),
    stash: git(checkout, ['stash', 'list']),
    registry: git(project, ['worktree', 'list', '--porcelain']),
    refs: git(project, ['for-each-ref']),
    sourceStatus: git(project, ['status', '--porcelain']),
  });
  const gitBefore = gitState();
  const runBefore = service.store.getRun(run.id);

  const out = await fs.mkdtemp(path.join(temporary, 'ext-'));
  await execFileAsync(process.execPath, [path.join(root, 'scripts', 'build-extension.mjs'), '--out', out], { cwd: root });
  const bundle = path.join(out, 'service', 'main.js');
  const port = await new Promise(resolve => { const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); }); });
  const child = spawn(process.execPath, [bundle], { env: { PATH: process.env.PATH, HOME: home, OPENCHAMBER_SERVICE_PORT: String(port), OPENCHAMBER_SERVICE_TOKEN: SERVICE_TOKEN }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => child.kill());
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  let health;
  for (let attempt = 0; attempt < 100 && !health; attempt++) {
    try { health = await call(port, '/health'); } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  assert.equal(health?.status, 200, output);
  assert.equal((await call(port, '/health', { token: null })).status, 401);

  const responses = [];
  const get = async target => { const response = await call(port, target); responses.push(response); assert.ok(response.bytes < CAP, `${target} is ${response.bytes} bytes`); return response; };

  const status = await get('/status');
  assert.equal(status.status, 200);
  assert.equal(status.json.connected, true);

  const projects = await get('/projects');
  assert.equal(projects.json.projects.length, 1);
  assert.equal(projects.json.projects[0].id, registered.id);

  const runs = await get('/runs');
  assert.equal(runs.json.total, 1);
  assert.equal(runs.json.runs[0].id, run.id);
  assert.equal(runs.json.runs[0].status, 'running');
  assert.equal((await get('/runs?status=succeeded')).json.total, 0);

  const detail = await get(`/runs/${run.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.json.run.id, run.id);
  assert.equal(detail.json.run.status, 'running');

  const changes = await get('/changes');
  assert.equal(changes.status, 200);
  assert.equal(typeof changes.json.cursor, 'string');

  const review = await get(`/runs/${run.id}/review`);
  assert.equal(review.status, 200);
  assert.equal(review.json.state, 'ready');
  assert.equal(review.json.baseCommit, run.baseCommit);
  const reviewed = Object.fromEntries(review.json.files.map(file => [file.path, file.change]));
  assert.deepEqual(reviewed, {
    'README.md': 'deleted', 'big.txt': 'modified', 'committed.txt': 'added', 'edit.txt': 'modified', 'untracked.txt': 'untracked',
  });

  const edit = await get(`/runs/${run.id}/review/file?path=edit.txt`);
  assert.equal(edit.status, 200);
  assert.equal(edit.json.view, 'diff');
  assert.match(edit.text, /committed line/);
  assert.match(edit.text, /uncommitted line/);
  const untracked = await get(`/runs/${run.id}/review/file?path=untracked.txt`);
  assert.equal(untracked.json.view, 'diff');
  assert.match(untracked.text, /untracked file/);
  const big = await get(`/runs/${run.id}/review/file?path=big.txt`);
  assert.equal(big.status, 200);

  // Unrelated paths and unknown routes are rejected; no mutation route is reachable.
  for (const target of [`/runs/${run.id}/review/file?path=../source/README.md`, `/runs/${run.id}/review/file?path=/etc/passwd`]) {
    const rejected = await call(port, target);
    assert.ok(rejected.status >= 400 && rejected.status < 500, `${target}: ${rejected.status}`);
    responses.push(rejected);
  }
  // Generated runtime files (which hold the owner token) are classified without their content ever being read.
  const generated = await call(port, `/runs/${run.id}/review/file?path=.heimdall/managed.json`);
  responses.push(generated);
  assert.equal(generated.json?.view, 'generated');
  assert.equal(generated.json?.text, '');
  for (const [method, target] of [['POST', `/runs/${run.id}/resume`], ['POST', `/runs/${run.id}/reconcile`], ['POST', '/runs'], ['POST', '/projects'], ['DELETE', `/runs/${run.id}`]]) {
    const refused = await call(port, target, { method });
    assert.ok([404, 405].includes(refused.status), `${method} ${target}: ${refused.status}`);
  }

  // No secret ever appears in a response or on the console, and nothing changed.
  for (const response of responses) {
    for (const secret of [key, ownerToken, SERVICE_TOKEN]) assert.equal(response.text.includes(secret), false);
  }
  assert.equal(output, '');
  assert.deepEqual(gitState(), gitBefore);
  const runAfter = service.store.getRun(run.id);
  assert.equal(runAfter.status, runBefore.status);
  assert.equal(runAfter.version, runBefore.version);
  assert.equal(runAfter.updatedAt, runBefore.updatedAt);
});
