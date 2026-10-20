import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { loadCoordinatorConfiguration } from '../dist/coordinator/config.js';
import { startCoordinatorService } from '../dist/coordinator/service.js';
import { CANONICAL, COMPACT, hiddenTailRequest, nearLimitRequest, submissionBytes } from './fixtures/approval-requests.mjs';

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
test('--version prints the package version without configuration', async () => {
  const manifest = JSON.parse(await fs.readFile(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  const result = call(['--version']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `${manifest.version}\n`);
  assert.match(call(['--help']).stdout, /heimdall --version/);
});

// --- heimdall coordinator run respond ----------------------------------------------------------------------------------
// The real CLI runs as a child process against an isolated coordinator served by this process. HOME and the coordinator
// selectors are isolated, so no ambient configuration, key or state participates.

const runSettings = { plannerAgent: 'planner', executorAgent: 'executor', plannerModel: 'anthropic/planner', executorModel: 'anthropic/executor', executorFallbackModel: 'kimi/fallback', maxTasks: 10, minQuotaRemainingPercent: 10, tokenLimitsDisabled: true };
const runSpecification = { settings: runSettings, plannerPrompt: 'Synthetic planner', executorPrompt: 'Synthetic executor', agents: {}, opencode: { baseUrl: 'http://127.0.0.1:9999', passwordEnvironmentVariable: 'SYNTHETIC_PASSWORD' } };
const REVISION = { head: 'a'.repeat(40), digest: 'b'.repeat(64) };
const DEFAULT_REQUEST = { question: 'Ship it?', scope: 'The reviewed commit', completedWork: 'Done', verification: ['tests pass'], artifacts: ['README.md'], onApprove: ['merge'], onRequestChanges: ['fix'] };

function respondCli(home, args, extraEnvironment = {}) {
  const environment = { ...process.env, HOME: home, HEIMDALL_CONFIG: '' };
  delete environment.HEIMDALL_COORDINATOR_CONFIG;
  Object.assign(environment, extraEnvironment);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'coordinator', ...args], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    child.stdout.on('data', chunk => out.push(chunk));
    child.stderr.on('data', chunk => err.push(chunk));
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
  });
}

/** A coordinator with seeded runs: a typed approval request per id and generic pauses, all paused, released and idle. */
async function coordinatorFor(t, name) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hdr-')));
  const configFile = path.join(root, `${name}.toml`);
  await fs.writeFile(configFile, '[coordinator]\nstateDirectory = "state"\n');
  const configuration = await loadCoordinatorConfiguration(configFile);
  const executor = { async launch() {}, async inspect() { return { idle: true, status: 'paused', reason: 'Paused' }; } };
  const service = await startCoordinatorService({ configuration, executor, pollIntervalMs: 60000, scheduler: { revision: async () => REVISION, verifyWorktree: async () => {}, prepare: async () => {} } });
  t.after(async () => { await service.close(); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, 'project', '.git'), { recursive: true });
  await fs.writeFile(path.join(root, 'project', '.heimdall.toml'), '[workflow]\n');
  const project = service.store.registerProject({ directory: path.join(root, 'project'), commonGitDirectory: path.join(root, 'project', '.git'), configPath: path.join(root, 'project', '.heimdall.toml'), concurrency: 5 });
  let counter = 0;
  const seed = ({ reason = 'Blocked: choose the database', approval = false, request = DEFAULT_REQUEST } = {}) => {
    const id = `${name}-run-${++counter}`;
    service.store.enqueue({ id, projectId: project.id, feature: '# Feature', baseCommit: 'c'.repeat(40), worktreePath: path.join(root, 'worktrees', id), branch: `heimdall/${id}`, specification: runSpecification });
    const run = service.store.admitNext();
    assert.equal(run.id, id);
    let requestId;
    const caller = { sessionID: run.parentSessionId, id: `call-${id}`, messageID: `message-${id}`, agent: 'adr-orchestrator' };
    const attempt = { id: `attempt_${id}`, phase: 'executor', index: 0, child: 'ses_child', status: 'rejected', startedAt: 1, model: 'anthropic/x' };
    const state = {
      id, status: 'paused', adr: 'feature.md', parent: run.parentSessionId, caller, branch: run.branch, baseline: '', index: 0,
      tasks: [{ id: 'T1', title: 'First task', brief: 'B', dependsOn: [], dod: ['gate'] }], results: [], phase: 'executor', child: 'ses_child', settings: runSettings, attempt, reason,
      ...(approval ? { wait: { kind: 'approval', attemptId: attempt.id, index: 0, taskId: 'T1' }, protocol: 'structured-v1' } : {}),
    };
    service.store.bindStart(id, run.ownerToken, caller);
    // The request is published before the runner records its pause on it.
    if (approval) {
      requestId = `apr_${id}`;
      const database = new DatabaseSync(path.join(configuration.stateDirectory, 'coordinator.sqlite'));
      try {
        database.prepare(`INSERT INTO approval_requests(run_id, request_id, phase, task_index, task_id, attempt_id, receipt_digest, request_json, revision_json, state, continuation, created_at)
          VALUES (?, ?, 'executor', 0, 'T1', ?, 'digest', ?, ?, 'pending', 'none', 1)`)
          .run(id, requestId, attempt.id, JSON.stringify(request), JSON.stringify(REVISION));
      } finally { database.close(); }
    }
    service.store.saveCheckpoint(id, run.ownerToken, state);
    const running = service.store.transition(id, run.ownerToken, run.version, 'running');
    service.store.transition(id, running.ownerToken, running.version, 'paused', reason, true);
    return { id, requestId };
  };
  const rows = (statement, ...values) => {
    const database = new DatabaseSync(path.join(configuration.stateDirectory, 'coordinator.sqlite'));
    try { return database.prepare(statement).all(...values); } finally { database.close(); }
  };
  return { root, configFile, configuration, service, seed, rows, home: root, args: (...rest) => [...rest, '--coordinator-config', configFile] };
}

test('run respond approves a typed request through the real CLI: JSON acknowledgement on stdout, nothing on stderr, retries idempotent', async t => {
  const c = await coordinatorFor(t, 'one');
  const { id, requestId } = c.seed({ approval: true });
  const shown = JSON.parse((await respondCli(c.home, c.args('run', 'show', id))).stdout);
  assert.equal(shown.wait.kind, 'approval');
  assert.equal(shown.wait.requestId, requestId);
  const first = await respondCli(c.home, c.args('run', 'respond', id, '--request', requestId, '--decision', 'approve'));
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stderr, '');
  const ack = JSON.parse(first.stdout);
  assert.deepEqual({ ...ack, recordedAt: undefined }, { runId: id, requestId, decision: 'approve', recordedAt: undefined, retried: false, continuation: 'queued', run: { status: 'queued', version: ack.run.version } });
  assert.equal(first.stdout, JSON.stringify(ack, null, 2) + '\n');
  assert.equal(c.service.store.getRun(id).status, 'queued');
  assert.equal(c.rows('SELECT decision, feedback, state FROM approval_requests WHERE request_id = ?', requestId)[0].decision, 'approve');
  // An identical retry (also in the equivalent --option=value spelling) returns the stored acknowledgement and queues nothing more.
  const retry = await respondCli(c.home, c.args('run', 'respond', id, `--request=${requestId}`, '--decision=approve'));
  assert.equal(retry.status, 0, retry.stderr);
  assert.deepEqual(JSON.parse(retry.stdout), { ...ack, retried: true });
  assert.equal(c.rows("SELECT count(*) AS n FROM events WHERE type = 'run.resume_queued'")[0].n, 1);
  // A different decision conflicts: exit 1, a diagnostic on stderr and nothing on stdout.
  const conflict = await respondCli(c.home, c.args('run', 'respond', id, '--request', requestId, '--decision', 'request-changes', '--input', 'Actually no'));
  assert.equal(conflict.status, 1);
  assert.equal(conflict.stdout, '');
  assert.match(conflict.stderr, /approval-conflict/);
  assert.match(conflict.stderr, /Nothing was recorded/);
  assert.match(conflict.stderr, /^Heimdall: /);
});

test('run respond passes multiline, quoted and option-like feedback as data through --input=VALUE', async t => {
  const c = await coordinatorFor(t, 'two');
  const feedbacks = [
    '--keep the scope narrow\nSecond line with "double" and \'single\' quotes, $HOME, `backticks`, a=b and --decision approve',
    '-x leading single dash',
    '  indented and trailing  ',
  ];
  const seeded = feedbacks.map(() => c.seed({ approval: true })); // Seeded first: a queued run would be the next one admitted.
  const sticky = c.seed({ approval: true });
  for (const [index, feedback] of feedbacks.entries()) {
    const { id, requestId } = seeded[index];
    const result = await respondCli(c.home, c.args('run', 'respond', id, '--request', requestId, '--decision', 'request-changes', `--input=${feedback}`));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).decision, 'request-changes');
    const row = c.rows('SELECT decision, feedback FROM approval_requests WHERE request_id = ?', requestId)[0];
    assert.equal(row.decision, 'request-changes');
    assert.equal(row.feedback, feedback, 'the feedback is stored byte for byte');
  }
  // The separate-argument form still rejects a value that begins with "--" instead of guessing, and points at --input=VALUE.
  const { id, requestId } = sticky;
  const before = c.rows('SELECT count(*) AS n FROM events')[0].n;
  const separate = await respondCli(c.home, c.args('run', 'respond', id, '--request', requestId, '--decision', 'request-changes', '--input', '--sneaky'));
  assert.equal(separate.status, 1);
  assert.match(separate.stderr, /--input requires a value \(write --input=VALUE/);
  assert.equal(c.rows('SELECT count(*) AS n FROM events')[0].n, before);
  assert.equal(c.rows('SELECT state FROM approval_requests WHERE request_id = ?', requestId)[0].state, 'pending');
});

test('run respond rejects incomplete and ambiguous arguments before any request or configuration is touched', async t => {
  const c = await coordinatorFor(t, 'three');
  const { id, requestId } = c.seed({ approval: true });
  const absent = path.join(c.root, 'absent.toml'); // Reading it would fail first, so a usage message proves nothing was loaded.
  const cases = {
    'no target': [['run', 'respond', id, '--decision', 'approve'], /requires --request REQUEST_ID .* or --pause PAUSE_ID/],
    'request and pause': [['run', 'respond', id, '--request', requestId, '--pause', 'pau_x', '--decision', 'approve'], /not both/],
    'missing decision': [['run', 'respond', id, '--request', requestId], /requires --decision approve or --decision request-changes/],
    'unknown decision': [['run', 'respond', id, '--request', requestId, '--decision', 'maybe'], /--decision must be approve or request-changes/],
    'feedback with approve': [['run', 'respond', id, '--request', requestId, '--decision', 'approve', '--input', 'ok'], /Approving takes no --input/],
    'request-changes without feedback': [['run', 'respond', id, '--request', requestId, '--decision', 'request-changes'], /requires --input FEEDBACK/],
    'blank feedback': [['run', 'respond', id, '--request', requestId, '--decision', 'request-changes', '--input', '   '], /--input must not be blank/],
    'oversize feedback': [['run', 'respond', id, '--request', requestId, '--decision', 'request-changes', `--input=${'x'.repeat(8001)}`], /exceeds 8000 characters/],
    'decision with pause': [['run', 'respond', id, '--pause', 'pau_x', '--decision', 'approve', '--input', 'go'], /--decision applies to --request only/],
    'pause without guidance': [['run', 'respond', id, '--pause', 'pau_x'], /--pause requires --input GUIDANCE/],
    'missing run id': [['run', 'respond', '--request', requestId, '--decision', 'approve'], /requires a valid RUN_ID/],
    'invalid run id': [['run', 'respond', '../x', '--request', requestId, '--decision', 'approve'], /requires a valid RUN_ID/],
    'extra positional': [['run', 'respond', id, 'another', '--request', requestId, '--decision', 'approve'], /Invalid coordinator arguments/],
    'repeated option': [['run', 'respond', id, '--request', requestId, '--request', requestId, '--decision', 'approve'], /Unknown or repeated option: --request/],
    'unrelated option': [['run', 'respond', id, '--request', requestId, '--decision', 'approve', '--feature', 'f'], /--feature does not apply/],
    'json flag': [['run', 'respond', id, '--request', requestId, '--decision', 'approve', '--json'], /--json does not apply/],
    'empty inline value': [['run', 'respond', id, '--request=', '--decision', 'approve'], /--request requires a value/],
  };
  const before = c.rows('SELECT count(*) AS n FROM events')[0].n;
  for (const [name, [args, pattern]] of Object.entries(cases)) {
    const result = await respondCli(c.home, [...args, '--coordinator-config', absent]);
    assert.equal(result.status, 1, `${name}: ${result.stderr}`);
    assert.equal(result.stdout, '', name);
    assert.match(result.stderr, pattern, name);
    assert.doesNotMatch(result.stderr, /ENOENT/, `${name}: validated before the configuration was read`);
  }
  assert.equal(c.rows('SELECT count(*) AS n FROM events')[0].n, before);
  assert.equal(c.rows('SELECT state FROM approval_requests WHERE request_id = ?', requestId)[0].state, 'pending');
  assert.match((await respondCli(c.home, ['run', 'respond', id, '--request', requestId, '--coordinator-config', absent])).stderr, /Usage:\n {2}heimdall coordinator run respond/);
});

test('run respond uses the coordinator selected by --coordinator-config, and only that one', async t => {
  const a = await coordinatorFor(t, 'alpha');
  const b = await coordinatorFor(t, 'bravo');
  const onA = a.seed({ approval: true });
  const onB = b.seed({ approval: true });
  // A request id of one coordinator is unknown to the other: selection decides which one is contacted.
  const wrong = await respondCli(a.home, a.args('run', 'respond', onB.id, '--request', onB.requestId, '--decision', 'approve'));
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /Run not found/);
  const right = await respondCli(a.home, b.args('run', 'respond', onB.id, '--request', onB.requestId, '--decision', 'approve'));
  assert.equal(right.status, 0, right.stderr);
  assert.equal(b.rows('SELECT state FROM approval_requests WHERE request_id = ?', onB.requestId)[0].state, 'answered');
  assert.equal(a.rows('SELECT state FROM approval_requests WHERE request_id = ?', onA.requestId)[0].state, 'pending');
  // The environment selector works as well, and the flag wins over it.
  const viaEnvironment = await respondCli(a.home, ['run', 'respond', onA.id, '--request', onA.requestId, '--decision', 'approve'], { HEIMDALL_COORDINATOR_CONFIG: a.configFile });
  assert.equal(viaEnvironment.status, 0, viaEnvironment.stderr);
  assert.equal(a.rows('SELECT state FROM approval_requests WHERE request_id = ?', onA.requestId)[0].state, 'answered');
  // No coordinator is running for this configuration: nothing was sent, and the message says so.
  const idle = path.join(a.root, 'idle.toml');
  await fs.writeFile(idle, '[coordinator]\nstateDirectory = "idle-s"\n');
  await fs.mkdir(path.join(a.root, 'idle-s'), { mode: 0o700 });
  await fs.writeFile(path.join(a.root, 'idle-s', 'coordinator.key'), 'f'.repeat(64), { mode: 0o600 });
  const unavailable = await respondCli(a.home, ['run', 'respond', onA.id, '--request', onA.requestId, '--decision', 'approve', '--coordinator-config', idle]);
  assert.equal(unavailable.status, 1);
  assert.match(unavailable.stderr, /unavailable/);
  assert.match(unavailable.stderr, /Nothing was sent/);
});

test('run respond continues a generic pause with owner guidance, refuses a stale pause, and leaves run resume as it was', async t => {
  const c = await coordinatorFor(t, 'four');
  // Seeded first: a queued run would be the next one admitted.
  const { id } = c.seed({ reason: 'Blocked: which database?' });
  const typed = c.seed({ approval: true });
  const plain = c.seed();
  const list = JSON.parse((await respondCli(c.home, c.args('run', 'list'))).stdout);
  const pauseId = list.find(run => run.id === id).wait.pauseId;
  const shown = JSON.parse((await respondCli(c.home, c.args('run', 'show', id))).stdout);
  assert.deepEqual({ kind: shown.wait.kind, pauseId: shown.wait.pauseId, reason: shown.wait.reason }, { kind: 'generic', pauseId, reason: 'Blocked: which database?' });
  const guidance = '--use PostgreSQL\nand keep "quotes"';
  const stale = await respondCli(c.home, c.args('run', 'respond', id, '--pause', 'pau_' + '0'.repeat(32), `--input=${guidance}`));
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /pause-stale/);
  assert.equal(c.service.store.getRun(id).status, 'paused');
  const result = await respondCli(c.home, c.args('run', 'respond', id, '--pause', pauseId, `--input=${guidance}`));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const ack = JSON.parse(result.stdout);
  assert.deepEqual({ ...ack, recordedAt: undefined }, { runId: id, pauseId, recordedAt: undefined, retried: false, continuation: 'queued', run: { status: 'queued', version: ack.run.version } });
  assert.ok(c.service.store.getRun(id).resolution.endsWith('\n' + guidance));
  const retry = await respondCli(c.home, c.args('run', 'respond', id, '--pause', pauseId, `--input=${guidance}`));
  assert.deepEqual(JSON.parse(retry.stdout), { ...ack, retried: true });
  const conflict = await respondCli(c.home, c.args('run', 'respond', id, '--pause', pauseId, '--input', 'other'));
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /response-conflict/);
  // A typed approval wait is never answered through the guided pause path, and run resume keeps its own guard.
  const refused = await respondCli(c.home, c.args('run', 'respond', typed.id, '--pause', 'pau_' + '1'.repeat(32), '--input', 'approve'));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /approval-pending/);
  const resume = await respondCli(c.home, c.args('run', 'resume', typed.id, '--input', 'approve'));
  assert.equal(resume.status, 1);
  assert.match(resume.stderr, /approval-pending|waiting for an owner decision/);
  // run resume still accepts its documented spelling for an ordinary pause.
  const resumed = await respondCli(c.home, c.args('run', 'resume', plain.id, '--input', 'Use the agreed approach'));
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).status, 'queued');
});

/** A stand-in coordinator on the endpoint of its own state directory that answers as `behave` says and records every request. */
async function standIn(t, behave) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hdo-')));
  const state = path.join(root, 'state');
  await fs.mkdir(state, { mode: 0o700 });
  await fs.writeFile(path.join(state, 'coordinator.key'), 'e'.repeat(64), { mode: 0o600 });
  const configFile = path.join(root, 'old.toml');
  await fs.writeFile(configFile, '[coordinator]\nstateDirectory = "state"\n');
  const requests = [];
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      requests.push({ method: request.method, url: request.url, body: Buffer.concat(chunks).toString('utf8') });
      behave(request, response);
    });
  });
  await new Promise(resolve => server.listen(path.join(state, 'coordinator.sock'), resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  return { root, requests, args: (...rest) => [...rest, '--coordinator-config', configFile] };
}
const send = (response, status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };

test('an older coordinator without the operation is reported as unsupported and run resume is never used instead', async t => {
  const old = await standIn(t, (_request, response) => send(response, 404, { error: 'Unknown coordinator route' }));
  const attempts = {
    approval: ['run', 'respond', 'run-1', '--request', 'apr_1', '--decision', 'approve'],
    feedback: ['run', 'respond', 'run-1', '--request', 'apr_1', '--decision', 'request-changes', '--input=Please revise'],
    pause: ['run', 'respond', 'run-1', '--pause', 'pau_1', '--input=Use PostgreSQL'],
  };
  for (const [name, args] of Object.entries(attempts)) {
    const result = await respondCli(old.root, old.args(...args));
    assert.equal(result.status, 1, name);
    assert.equal(result.stdout, '', name);
    assert.match(result.stderr, /does not support this response operation \(likely an older version\)/, name);
    assert.match(result.stderr, /does not fall back to the unguarded "run resume"/, name);
  }
  assert.equal(old.requests.length, 3);
  assert.deepEqual(old.requests.map(request => request.method + ' ' + request.url), [
    'POST /runs/run-1/approvals/apr_1/decision', 'POST /runs/run-1/approvals/apr_1/decision', 'POST /runs/run-1/respond',
  ]);
  assert.ok(old.requests.every(request => !request.url.endsWith('/resume')), 'the unguarded resume was never requested');
  assert.deepEqual(JSON.parse(old.requests[1].body), { decision: 'request-changes', feedback: 'Please revise' });
  assert.deepEqual(JSON.parse(old.requests[2].body), { pauseId: 'pau_1', input: 'Use PostgreSQL' });
  // A coordinator that does not know the run is an ordinary refusal and not an unsupported operation.
  const missing = await standIn(t, (_request, response) => send(response, 404, { error: 'Run not found' }));
  const notFound = await respondCli(missing.root, missing.args(...attempts.pause));
  assert.equal(notFound.status, 1);
  assert.match(notFound.stderr, /refused the response \(404\): Run not found\. Nothing was recorded/);
  assert.doesNotMatch(notFound.stderr, /older version/);
});

test('an uncertain delivery exits 2 and tells the user to inspect the run instead of retrying', async t => {
  for (const [name, behave] of Object.entries({
    'connection dropped after the request': (request, _response) => request.socket.destroy(),
    'unreadable answer': (_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('not json'); },
  })) {
    const dropped = await standIn(t, behave);
    const result = await respondCli(dropped.root, dropped.args('run', 'respond', 'run-9', '--request', 'apr_9', '--decision', 'approve'));
    assert.equal(result.status, 2, name);
    assert.equal(result.stdout, '', name);
    assert.match(result.stderr, /may or may not have been recorded/, name);
    assert.match(result.stderr, /Do not retry blindly/, name);
    assert.match(result.stderr, /heimdall coordinator run show run-9/, name);
    assert.equal(dropped.requests.length, 1, name);
  }
  // A coordinator that answers refuses cleanly: a draining coordinator is exit status 1 with nothing recorded.
  const draining = await standIn(t, (_request, response) => send(response, 503, { error: 'Coordinator is draining; new work is disabled' }));
  const refused = await respondCli(draining.root, draining.args('run', 'respond', 'run-9', '--pause', 'pau_9', '--input', 'go on'));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /refused the response \(503\): Coordinator is draining/);
});

test('the coordinator help documents run respond, its inline option syntax and its exit statuses', () => {
  const help = call(['coordinator', '--help']);
  assert.equal(help.status, 0);
  for (const fragment of [
    'heimdall coordinator run respond RUN_ID --request REQUEST_ID --decision approve',
    'heimdall coordinator run respond RUN_ID --request REQUEST_ID --decision request-changes --input FEEDBACK',
    'heimdall coordinator run respond RUN_ID --pause PAUSE_ID --input GUIDANCE',
    '--input=VALUE', 'Exit status: 0 when the response was', '2 when', 'run show',
  ]) assert.ok(help.stdout.includes(fragment), fragment);
  assert.match(help.stdout, /heimdall coordinator run resume RUN_ID --input RESOLUTION/);
});

// --- heimdall coordinator run approval ---------------------------------------------------------------------------------
// One complete approval request, read through the real CLI parser and dispatcher. Compact projections (run show, run list)
// keep clipping; the read returns the full recorded content in order. Exit status: 0 for a valid request, 1 for every failure.

/** What a read must never change: every approval row, every run's version and status, and the event log. */
const snapshot = c => JSON.stringify({
  approvals: c.rows('SELECT * FROM approval_requests ORDER BY run_id, request_id'),
  runs: c.rows('SELECT id, status, version, updated_at, resolution, launch_action FROM runs ORDER BY id'),
  events: c.rows('SELECT * FROM events ORDER BY rowid'),
});
const VIEW_FIELDS = ['attemptId', 'completedWork', 'continuation', 'createdAt', 'onApprove', 'onRequestChanges', 'progress', 'question', 'artifacts', 'requestId', 'response', 'revision', 'runId', 'scope', 'state', 'taskId', 'taskIndex', 'verification'].sort();

test('run approval returns the complete request in order while run show and run list still clip honestly, and reads change nothing', async t => {
  const c = await coordinatorFor(t, 'read');
  const tail = hiddenTailRequest();
  const near = nearLimitRequest();
  assert.equal(tail.scope.length, 1900);
  assert.ok(tail.scope.indexOf('ACTION-AFTER-1500') > COMPACT.text, 'the distinctive action is beyond the compact text limit');
  assert.equal(submissionBytes(near), CANONICAL.payload, 'the near-limit request is exactly at the payload limit');
  const cases = [['hidden tail', tail], ['near the payload limit', near]];
  const seeded = cases.map(([, request]) => c.seed({ approval: true, request }));
  for (const [index, [name, request]] of cases.entries()) {
    const { id, requestId } = seeded[index];
    const before = snapshot(c);

    // The compact projections clip, and say so.
    const shown = JSON.parse((await respondCli(c.home, c.args('run', 'show', id))).stdout).wait;
    assert.equal(shown.kind, 'approval', name);
    assert.ok(shown.scope.length <= COMPACT.text, name);
    assert.equal(shown.clipped.scope, true, name);
    assert.ok(shown.verification.length <= COMPACT.list && shown.onApprove.length <= COMPACT.list, name);
    assert.ok(shown.verification.concat(shown.artifacts, shown.onApprove, shown.onRequestChanges).every(entry => entry.length <= COMPACT.entry), name);
    const markers = [...JSON.stringify(request).matchAll(/[A-Z]+(?:-[A-Z0-9]+)*-(?:AFTER-1500|TAIL-\d+|ENTRY-\d+|END)|PROPOSED-ACTION-13|LAST-ENTRY/g)].map(match => match[0]);
    assert.ok(markers.length >= 3, `${name}: markers`);
    const compact = JSON.stringify(shown);
    assert.ok(markers.some(marker => !compact.includes(marker)), `${name}: the compact view hides at least one distinctive marker`);
    const listed = (await respondCli(c.home, c.args('run', 'list'))).stdout;
    const listedWait = JSON.parse(listed).find(run => run.id === id).wait;
    assert.equal(listedWait.kind, 'approval', name);
    assert.ok(listedWait.scope.length <= COMPACT.text, name);
    assert.equal(listedWait.clipped.scope, true, name);
    assert.ok(markers.some(marker => !JSON.stringify(listedWait).includes(marker)), `${name}: the listed view hides at least one marker`);

    // The read returns everything, in order.
    const read = await respondCli(c.home, c.args('run', 'approval', id, '--request', requestId));
    assert.equal(read.status, 0, read.stderr);
    assert.equal(read.stderr, '');
    const view = JSON.parse(read.stdout);
    assert.equal(read.stdout, JSON.stringify(view, null, 2) + '\n');
    assert.deepEqual(Object.keys(view).sort(), VIEW_FIELDS, 'only text and data fields');
    for (const field of ['question', 'scope', 'completedWork', 'verification', 'artifacts', 'onApprove', 'onRequestChanges']) assert.deepEqual(view[field], request[field], `${name}: ${field}`);
    for (const marker of markers) assert.ok(read.stdout.includes(marker), `${name}: ${marker}`);
    assert.deepEqual({ requestId: view.requestId, runId: view.runId, state: view.state, continuation: view.continuation, progress: view.progress, taskId: view.taskId, taskIndex: view.taskIndex, response: view.response }, { requestId, runId: id, state: 'pending', continuation: 'none', progress: 'none', taskId: 'T1', taskIndex: 0, response: null });
    assert.deepEqual(view.revision, REVISION);
    assert.doesNotMatch(read.stdout, /receiptDigest|"ack"|ownerToken|coordinator\.key/);
    assert.equal(snapshot(c), before, `${name}: show, list and approval changed nothing`);
  }
  // A decided request reports the recorded response.
  const decided = c.seed({ approval: true });
  assert.equal((await respondCli(c.home, c.args('run', 'respond', decided.id, '--request', decided.requestId, '--decision', 'request-changes', '--input=Narrow the scope'))).status, 0);
  const afterDecision = snapshot(c);
  const answered = JSON.parse((await respondCli(c.home, c.args('run', 'approval', decided.id, '--request', decided.requestId))).stdout);
  assert.equal(answered.state, 'answered');
  assert.deepEqual({ decision: answered.response.decision, feedback: answered.response.feedback }, { decision: 'request-changes', feedback: 'Narrow the scope' });
  assert.equal(snapshot(c), afterDecision);
  // The equivalent --option=value spelling reads the same request.
  assert.deepEqual(JSON.parse((await respondCli(c.home, c.args('run', 'approval', decided.id, `--request=${decided.requestId}`))).stdout), answered);
});

test('run approval rejects incomplete and ambiguous arguments before the configuration is read or any request is sent', async t => {
  const idle = await standIn(t, (_request, response) => send(response, 200, {}));
  const absent = path.join(idle.root, 'absent.toml'); // Reading it would fail first, so a usage message proves nothing was loaded.
  const cases = {
    'missing run id': [['run', 'approval', '--request', 'apr_1'], /requires a valid RUN_ID/],
    'invalid run id': [['run', 'approval', '../x', '--request', 'apr_1'], /requires a valid RUN_ID/],
    'missing request': [['run', 'approval', 'run-1'], /requires --request REQUEST_ID/],
    'invalid request': [['run', 'approval', 'run-1', '--request', '../x'], /--request must be a valid REQUEST_ID/],
    'overlong request': [['run', 'approval', 'run-1', `--request=${'a'.repeat(129)}`], /--request must be a valid REQUEST_ID/],
    'empty inline request': [['run', 'approval', 'run-1', '--request='], /--request requires a value/],
    'extra positional': [['run', 'approval', 'run-1', 'run-2', '--request', 'apr_1'], /Invalid coordinator arguments/],
    'repeated request': [['run', 'approval', 'run-1', '--request', 'apr_1', '--request', 'apr_2'], /Unknown or repeated option: --request/],
    'json flag': [['run', 'approval', 'run-1', '--request', 'apr_1', '--json'], /--json does not apply/],
    'decision option': [['run', 'approval', 'run-1', '--request', 'apr_1', '--decision', 'approve'], /--decision does not apply/],
    'input option': [['run', 'approval', 'run-1', '--request', 'apr_1', '--input', 'x'], /--input does not apply/],
    'pause option': [['run', 'approval', 'run-1', '--request', 'apr_1', '--pause', 'pau_1'], /--pause does not apply/],
    'unknown option': [['run', 'approval', 'run-1', '--request', 'apr_1', '--follow'], /Unknown or repeated option: --follow/],
  };
  for (const [name, [args, pattern]] of Object.entries(cases)) {
    const result = await respondCli(idle.root, [...args, '--coordinator-config', absent]);
    assert.equal(result.status, 1, `${name}: ${result.stderr}`);
    assert.equal(result.stdout, '', name);
    assert.match(result.stderr, pattern, name);
    assert.doesNotMatch(result.stderr, /ENOENT/, `${name}: validated before the configuration was read`);
  }
  assert.match((await respondCli(idle.root, ['run', 'approval', 'run-1', '--coordinator-config', absent])).stderr, /Usage:\n {2}heimdall coordinator run approval RUN_ID --request REQUEST_ID/);
  // Even with a reachable coordinator selected, an invalid invocation sends nothing.
  for (const [name, [args]] of Object.entries(cases)) {
    const result = await respondCli(idle.root, idle.args(...args));
    assert.equal(result.status, 1, name);
  }
  assert.equal(idle.requests.length, 0, 'no argument error reached the coordinator');
});

test('run approval distinguishes an unknown request, an older coordinator, a refused key and an unavailable coordinator, each with exit status 1', async t => {
  const c = await coordinatorFor(t, 'outcomes');
  const one = c.seed({ approval: true });
  const other = c.seed({ approval: true });
  const before = snapshot(c);
  const unknownRequest = await respondCli(c.home, c.args('run', 'approval', one.id, '--request', 'apr_missing'));
  assert.equal(unknownRequest.status, 1);
  assert.equal(unknownRequest.stdout, '');
  assert.match(unknownRequest.stderr, /has no approval request apr_missing for run /);
  assert.match(unknownRequest.stderr, /^Heimdall: /);
  // A request id of another run is not found for this one.
  const crossed = await respondCli(c.home, c.args('run', 'approval', one.id, '--request', other.requestId));
  assert.equal(crossed.status, 1);
  assert.equal(crossed.stdout, '');
  assert.match(crossed.stderr, /has no approval request/);
  const unknownRun = await respondCli(c.home, c.args('run', 'approval', 'run-nope', '--request', one.requestId));
  assert.equal(unknownRun.status, 1);
  assert.equal(unknownRun.stdout, '');
  assert.match(unknownRun.stderr, /does not know run run-nope/);
  assert.equal(snapshot(c), before);

  const old = await standIn(t, (_request, response) => send(response, 404, { error: 'Unknown coordinator route' }));
  const older = await respondCli(old.root, old.args('run', 'approval', 'run-1', '--request', 'apr_1'));
  assert.equal(older.status, 1);
  assert.equal(older.stdout, '');
  assert.match(older.stderr, /does not support reading an approval request \(likely an older version\)/);
  assert.doesNotMatch(older.stderr, /has no approval request|does not know run/);
  assert.deepEqual(old.requests.map(request => `${request.method} ${request.url}`), ['GET /runs/run-1/approvals/apr_1']);
  assert.equal(old.requests[0].body, '', 'a read sends no body');

  for (const status of [401, 403]) {
    const refusing = await standIn(t, (_request, response) => send(response, status, { error: 'Administrator authorization required' }));
    const refused = await respondCli(refusing.root, refusing.args('run', 'approval', 'run-1', '--request', 'apr_1'));
    assert.equal(refused.status, 1, String(status));
    assert.equal(refused.stdout, '', String(status));
    assert.match(refused.stderr, /refused authorization to read the approval request; check the coordinator key/, String(status));
  }
  const failing = await standIn(t, (_request, response) => send(response, 500, { error: 'Coordinator request failed' }));
  const failed = await respondCli(failing.root, failing.args('run', 'approval', 'run-1', '--request', 'apr_1'));
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /refused to return the approval request \(500\)/);
  const dropped = await standIn(t, (request, _response) => request.socket.destroy());
  const lost = await respondCli(dropped.root, dropped.args('run', 'approval', 'run-1', '--request', 'apr_1'));
  assert.equal(lost.status, 1, 'a read has no uncertain outcome');
  assert.equal(lost.stdout, '');

  const idle = path.join(c.root, 'idle.toml');
  await fs.writeFile(idle, '[coordinator]\nstateDirectory = "idle-s"\n');
  await fs.mkdir(path.join(c.root, 'idle-s'), { mode: 0o700 });
  await fs.writeFile(path.join(c.root, 'idle-s', 'coordinator.key'), 'f'.repeat(64), { mode: 0o600 });
  const unavailable = await respondCli(c.home, ['run', 'approval', one.id, '--request', one.requestId, '--coordinator-config', idle]);
  assert.equal(unavailable.status, 1);
  assert.equal(unavailable.stdout, '');
  assert.match(unavailable.stderr, /could not be read from the coordinator/);
});

test('run approval refuses an answer that is not a valid complete request and prints nothing from it', async t => {
  const valid = () => ({
    runId: 'run-1', requestId: 'apr_1', phase: 'executor', taskIndex: 0, taskId: 'T1', attemptId: 'attempt_1', receiptDigest: 'SECRET-DIGEST',
    request: { ...DEFAULT_REQUEST }, revision: REVISION, state: 'pending', decision: null, feedback: null, ack: { ownerToken: 'SECRET-TOKEN' },
    answeredAt: null, continuation: 'none', continuationAt: null, continuationMessageId: null, consumedAttemptId: null, supersededAt: null, supersededReason: null,
    createdAt: 1, progress: 'none',
  });
  const withRequest = change => ({ ...valid(), request: { ...DEFAULT_REQUEST, ...change } });
  const over = withRequest({ scope: 'x'.repeat(CANONICAL.text + 1) });
  const bad = {
    'a different request id': { ...valid(), requestId: 'apr_other' },
    'a different run id': { ...valid(), runId: 'run-other' },
    'text beyond the limit': over,
    'an entry beyond the limit': withRequest({ verification: ['y'.repeat(CANONICAL.text + 1)] }),
    'too many entries': withRequest({ artifacts: Array.from({ length: CANONICAL.list + 1 }, (_, index) => `a${index}`) }),
    'a payload beyond the limit': withRequest({ verification: Array.from({ length: 20 }, () => 'z'.repeat(CANONICAL.text)) }),
    'a non-text entry': withRequest({ onApprove: ['ok', 7] }),
    'a missing list': withRequest({ onRequestChanges: undefined }),
    'an unknown state': { ...valid(), state: 'maybe' },
    'an unknown progress': { ...valid(), progress: 'soon' },
    'an answered state without a decision': { ...valid(), state: 'answered' },
    'a decision on a pending request': { ...valid(), decision: 'approve' },
    'a malformed revision': { ...valid(), revision: { head: 'not hex!', digest: 'b'.repeat(64) } },
    'a missing request body': { ...valid(), request: null },
    'an array': [valid()],
    'null': null,
  };
  for (const [name, answer] of Object.entries(bad)) {
    const stub = await standIn(t, (_request, response) => send(response, 200, answer));
    const result = await respondCli(stub.root, stub.args('run', 'approval', 'run-1', '--request', 'apr_1'));
    assert.equal(result.status, 1, name);
    assert.equal(result.stdout, '', name);
    assert.match(result.stderr, /returned an invalid approval request: .* is missing or not valid\. Nothing is shown from it\./, name);
    assert.doesNotMatch(result.stderr, /SECRET|xxxxxxxx|zzzzzzzz/, name);
    assert.equal(stub.requests.length, 1, name);
  }
  // A valid answer from the same stand-in is printed without the fields a view does not carry.
  const good = await standIn(t, (_request, response) => send(response, 200, valid()));
  const printed = await respondCli(good.root, good.args('run', 'approval', 'run-1', '--request', 'apr_1'));
  assert.equal(printed.status, 0, printed.stderr);
  assert.deepEqual(Object.keys(JSON.parse(printed.stdout)).sort(), VIEW_FIELDS);
  assert.doesNotMatch(printed.stdout, /SECRET/);
  // An unreadable body is a failure too, with nothing on stdout.
  const garbled = await standIn(t, (_request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('not json'); });
  const unreadable = await respondCli(garbled.root, garbled.args('run', 'approval', 'run-1', '--request', 'apr_1'));
  assert.equal(unreadable.status, 1);
  assert.equal(unreadable.stdout, '');
});

test('run approval reads from the coordinator selected by --coordinator-config, and only that one', async t => {
  const a = await coordinatorFor(t, 'sel-a');
  const b = await coordinatorFor(t, 'sel-b');
  const onA = a.seed({ approval: true, request: { ...DEFAULT_REQUEST, question: 'Question on A?' } });
  const onB = b.seed({ approval: true, request: { ...DEFAULT_REQUEST, question: 'Question on B?' } });
  const wrong = await respondCli(a.home, a.args('run', 'approval', onB.id, '--request', onB.requestId));
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /does not know run /);
  const right = await respondCli(a.home, b.args('run', 'approval', onB.id, '--request', onB.requestId));
  assert.equal(right.status, 0, right.stderr);
  assert.equal(JSON.parse(right.stdout).question, 'Question on B?');
  // The environment selector works as well, and the flag wins over it.
  const viaEnvironment = await respondCli(a.home, ['run', 'approval', onA.id, '--request', onA.requestId], { HEIMDALL_COORDINATOR_CONFIG: a.configFile });
  assert.equal(JSON.parse(viaEnvironment.stdout).question, 'Question on A?');
  const flagWins = await respondCli(a.home, b.args('run', 'approval', onB.id, '--request', onB.requestId), { HEIMDALL_COORDINATOR_CONFIG: a.configFile });
  assert.equal(JSON.parse(flagWins.stdout).question, 'Question on B?');
  assert.equal(a.rows("SELECT count(*) AS n FROM approval_requests WHERE state = 'pending'")[0].n, 1);
  assert.equal(b.rows("SELECT count(*) AS n FROM approval_requests WHERE state = 'pending'")[0].n, 1);
});

test('the coordinator help lists run approval, its read-only behavior and its exit statuses', () => {
  const help = call(['coordinator', '--help']).stdout;
  assert.ok(help.includes('heimdall coordinator run approval RUN_ID --request REQUEST_ID'));
  assert.match(help, /run approval prints one\ncomplete request as JSON on stdout/);
  assert.match(help, /It is read-only and honors\n--coordinator-config/);
  assert.match(help, /Exit status: 0 when a valid request was printed; 1 with a diagnostic on stderr/);
  assert.match(help, /heimdall coordinator run respond RUN_ID --request REQUEST_ID --decision approve/);
});
