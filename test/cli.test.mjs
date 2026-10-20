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
  const seed = ({ reason = 'Blocked: choose the database', approval = false } = {}) => {
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
          .run(id, requestId, attempt.id, JSON.stringify({ question: 'Ship it?', scope: 'The reviewed commit', completedWork: 'Done', verification: ['tests pass'], artifacts: ['README.md'], onApprove: ['merge'], onRequestChanges: ['fix'] }), JSON.stringify(REVISION));
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
