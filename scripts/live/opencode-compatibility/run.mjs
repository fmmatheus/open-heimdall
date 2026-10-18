// Real OpenCode host, synthetic local model: exercise native planning, receipts, pause and same-run resume.
// Usage: node scripts/live/opencode-compatibility/run.mjs --opencode /path/to/opencode [--out report.json]
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connect, snapshot, createMessageHistory, supportedOpenCodeVersion } from '../../../dist/opencode/observer.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const args = process.argv.slice(2);
const options = {};
for (let i = 0; i < args.length; i++) { assert.ok(['--opencode', '--out'].includes(args[i])); options[args[i].slice(2)] = args[++i]; }
assert.ok(options.opencode, '--opencode BINARY is required');
const binary = path.resolve(options.opencode);
const root = await fs.mkdtemp('/private/tmp/hc32-');
const project = path.join(root, 'project');
const password = randomUUID();
const env = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: 'en_US.UTF-8', HOME: path.join(root, 'home'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'), XDG_STATE_HOME: path.join(root, 'state'), TMPDIR: path.join(root, 'tmp'), OPENCODE_CONFIG_DIR: path.join(root, 'host'), OPENCODE_DB: path.join(root, 'opencode.db'), OPENCODE_DISABLE_AUTOUPDATE: '1', OPENCODE_DISABLE_MODELS_FETCH: '1', OPENCODE_DISABLE_FFF: '1', OPENCODE_DISABLE_FILEWATCHER: '1', OPENCODE_SERVER_PASSWORD: password, HEIMDALL_COMPAT_PASSWORD: password, HEIMDALL_COMPAT_ROOT: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
let version, child, closed;
let hostClosed = true;
let output = '', failure;
const checks = {};
const controller = new AbortController();
const interrupted = signal => controller.abort(new Error(`Fixture interrupted by ${signal}`));
const interrupt = () => interrupted('SIGINT');
const terminate = () => interrupted('SIGTERM');
process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
const fetchImpl = (url, init = {}) => fetch(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal });
try {
  for (const dir of [project, env.HOME, env.XDG_CONFIG_HOME, env.XDG_DATA_HOME, env.XDG_CACHE_HOME, env.XDG_STATE_HOME, env.TMPDIR, env.OPENCODE_CONFIG_DIR]) await fs.mkdir(dir, { recursive: true });
  version = execFileSync(binary, ['--version'], { env, encoding: 'utf8', timeout: 10000 }).trim();
  assert.ok(version.includes(supportedOpenCodeVersion), `Expected OpenCode ${supportedOpenCodeVersion}, got ${version}`);
  const git = (...argv) => execFileSync('git', ['-C', project, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...argv], { env, encoding: 'utf8', timeout: 10000 });
  git('init', '-q'); git('commit', '--allow-empty', '-qm', 'fixture');
  const plugin = path.join(root, 'plugin'); await fs.mkdir(plugin);
  await fs.writeFile(path.join(plugin, 'package.json'), JSON.stringify({ name: 'heimdall-compatibility-fixture', version: '0.0.0', type: 'module', exports: './index.mjs' }));
  await fs.writeFile(path.join(plugin, 'index.mjs'), `export { default } from ${JSON.stringify(pathToFileURL(path.join(repo, 'scripts/live/opencode-compatibility/fixture-plugin.mjs')).href)};\n`);
  await fs.writeFile(path.join(env.OPENCODE_CONFIG_DIR, 'opencode.json'), JSON.stringify({ plugins: [{ package: plugin }] }));
  const agents = path.join(env.OPENCODE_CONFIG_DIR, 'agents'); await fs.mkdir(agents);
  for (const name of ['adr-orchestrator', 'adr-planner', 'adr-executor']) await fs.copyFile(path.join(repo, 'examples/opencode/agents', `${name}.md`), path.join(agents, `${name}.md`));
  await fs.writeFile(path.join(project, 'task.md'), '# Compatibility fixture\nWrite a marker, then wait for an explicit owner resolution.\n');
  const port = await new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const baseUrl = `http://127.0.0.1:${port}`;
  await fs.writeFile(path.join(project, '.heimdall.toml'), `[workflow]\nplannerModel="compatibility-fixture/chat"\nmaxTasks=2\ntokenLimitsDisabled=true\n[[workflow.executorCandidates]]\nkey="fixture"\nquotaProvider="anthropic"\nmodel="compatibility-fixture/chat"\n[opencode]\nbaseUrl="${baseUrl}"\nauthentication="basic"\npasswordEnvironmentVariable="HEIMDALL_COMPAT_PASSWORD"\n`);
  controller.signal.throwIfAborted();
  child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', String(port)], { cwd: project, env, stdio: ['ignore', 'pipe', 'pipe'] });
  hostClosed = false;
  closed = new Promise(resolve => child.once('close', () => { hostClosed = true; resolve(); }));
  child.once('error', error => { failure ??= error; });
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  let api;
  const startupUntil = Date.now() + 30000;
  while (Date.now() < startupUntil) {
    controller.signal.throwIfAborted();
    if (failure) throw failure;
    assert.equal(child.exitCode, null, 'Isolated server exited early');
    try { api = await connect(project, undefined, { baseUrl, authentication: 'basic', passwordEnvironmentVariable: 'HEIMDALL_COMPAT_PASSWORD', environment: env, fetchImpl, timeoutMilliseconds: 1000 }); break; } catch { await new Promise(resolve => setTimeout(resolve, 200)); }
  }
  assert.ok(api, 'Isolated server did not become ready');
  checks.version = api.version;
  const parent = `ses_${randomUUID().replaceAll('-', '')}`;
  await api.request('/api/session', { method: 'POST', body: { id: parent, agent: 'adr-orchestrator', model: { providerID: 'compatibility-fixture', id: 'chat' }, location: { directory: project }, title: 'Compatibility fixture' } });
  const prompt = async text => {
    const body = { id: `msg_${randomUUID().replaceAll('-', '')}`, text, delivery: 'queue' };
    await api.request(`/api/session/${parent}/prompt`, { method: 'POST', body: { ...body, resume: false } });
    await api.request(`/api/session/${parent}/prompt`, { method: 'POST', body: { ...body, resume: true } });
  };
  const runsDirectory = path.join(project, '.heimdall/runs');
  const wait = async status => {
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      controller.signal.throwIfAborted();
      try {
        const runs = await fs.readdir(runsDirectory);
        assert.equal(runs.length, 1, 'Expected exactly one native fixture run');
        const state = JSON.parse(await fs.readFile(path.join(runsDirectory, runs[0], 'state.json'), 'utf8'));
        const observed = await snapshot(api, parent);
        delete checks.lastObservationError;
        checks.lastWorkflowState = { status: state.status, index: state.index, reason: state.reason, parentOutcome: observed.session.outcome };
        if (state.status === status && !observed.active && !observed.inbox.length && !observed.pendingWork.length) return state;
      } catch (error) { checks.lastObservationError = error.message; }
      assert.equal(child.exitCode, null, 'Isolated host exited during workflow');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    try { checks.parentOnTimeout = await snapshot(api, parent); } catch (error) { checks.parentObservationError = error.message; }
    throw new Error(`Fixture did not reach ${status}`);
  };
  await prompt('Start the compatibility fixture.');
  const paused = await wait('paused');
  assert.equal(paused.results.length, 1); assert.equal(paused.results[0].taskId, 'T1');
  assert.equal(await fs.readFile(path.join(project, 'compatibility-marker.txt'), 'utf8'), 'verified\n');
  checks.nativePause = true;
  const original = { id: paused.id, parent: paused.parent, firstResult: JSON.stringify(paused.results[0]) };
  await prompt('Resume this compatibility fixture with COMPAT_RESUME.');
  const complete = await wait('completed');
  assert.equal(complete.id, original.id); assert.equal(complete.parent, original.parent);
  assert.equal(JSON.stringify(complete.results[0]), original.firstResult);
  assert.deepEqual(complete.results.map(result => result.taskId), ['T1', 'T2']);
  checks.sameRunResume = true; checks.acceptedTasks = complete.results.length;
  const history = createMessageHistory({ directory: project, baseUrl, authentication: 'basic', passwordEnvironmentVariable: 'HEIMDALL_COMPAT_PASSWORD', environment: env, fetchImpl, pageSize: 2 });
  let messages = 0;
  for await (const message of history(complete.results[0].sessionId)) { assert.ok(message.id); messages++; }
  assert.ok(messages > 2); checks.paginatedArchiveMessages = messages;
  const observations = (await fs.readFile(path.join(root, 'observations.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(observations.some(item => item.event === 'length-continuation'));
  checks.nativeLengthContinuation = true;
  checks.pluginLoaded = observations.filter(item => item.event === 'plugin-loaded').map(item => ({ version: item.hostVersion }));
  assert.ok(checks.pluginLoaded.length);
} catch (error) { failure = error; }
finally {
  if (failure) {
    for (const [key, file] of Object.entries({ observations: 'observations.jsonl', hostLog: 'data/opencode/log/opencode.log' })) {
      try { checks[key] = (await fs.readFile(path.join(root, file), 'utf8')).replaceAll(password, '<fixture-password>').replaceAll(root, '<fixture>').slice(-18000); } catch { /* A failed startup may not have created its logs. */ }
    }
  }
  if (child && !hostClosed) {
    child.kill('SIGTERM');
    await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 5000))]);
    if (!hostClosed) { child.kill('SIGKILL'); await Promise.race([closed, new Promise(resolve => setTimeout(resolve, 3000))]); }
  }
  if (!hostClosed) failure ??= new Error('Fixture host termination could not be confirmed; its directory was retained');
  if (hostClosed) await fs.rm(root, { recursive: true, force: true });
  process.off('SIGINT', interrupt); process.off('SIGTERM', terminate);
  const report = JSON.parse(JSON.stringify({ passed: !failure, hostVersion: version, fixture: 'real OpenCode host with synthetic local model and quota; no real credentials or model calls', fixtureRemoved: hostClosed, checks, ...(failure ? { error: failure.message, diagnostic: output.slice(-12000) } : {}) }).replaceAll(password, '<fixture-password>').replaceAll(root, '<fixture>'));
  if (options.out) await fs.writeFile(path.resolve(options.out), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}
if (failure) process.exitCode = 1;
