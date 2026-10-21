import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { startCoordinatorService } from '../dist/coordinator/service.js';
import { loadCoordinatorConfiguration } from '../dist/coordinator/config.js';
import { CANONICAL, COMPACT, hiddenTailRequest, nearLimitRequest } from './fixtures/approval-requests.mjs';
import {
  ACTIVE_STATUSES, DEFAULT_WATCH_BUDGET_SECONDS, DEFAULT_WATCH_INTERVAL_SECONDS, MAX_WATCH_BUDGET_SECONDS,
  WAIT_ENTRY_LIMIT, WAIT_LIST_LIMIT, WAIT_QUESTION_LIMIT, WAIT_TEXT_LIMIT, approvalUnresolved, chooseActiveRun, countStatus, gitEnvironment, limitText, main, parseArguments, parseRunList,
  parseCompleteRequest, projectRun, projectWait, stateKey, stopReasonFor, UsageError, watchRun, watchTiming,
} from '../skills/openheimdall-start/scripts/openheimdall.mjs';

const exec = promisify(execFile);
const checkout = fileURLToPath(new URL('..', import.meta.url));
const skillDirectories = ['openheimdall-start', 'openheimdall-monitor', 'openheimdall-resume'].map(name => path.join(checkout, 'skills', name));
const helperPath = directory => path.join(directory, 'scripts', 'openheimdall.mjs');
const helperFile = helperPath(skillDirectories[0]);
const distCli = path.join(checkout, 'dist', 'cli.js');

// Commands the read-only helper may send to the coordinator command line.
const READ_ONLY_COMMANDS = /^(status --json|project list|run list|run show [A-Za-z0-9_-]+|run approval [A-Za-z0-9_-]+ --request [A-Za-z0-9_-]+)$/;
const MUTATING_WORDS = ['submit', 'resume', 'reconcile', 'add', 'start', 'stop', 'serve', 'logs', 'events'];

// --- Fixtures ----------------------------------------------------------------------------------------------

async function temporaryRoot(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hs-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function isolatedEnvironment(root, extra = {}) {
  const home = path.join(root, 'home');
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid',
    GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid',
    ...extra,
  };
}

// One recording binary for both kinds of test. With FAKE_HEIMDALL_DIR it answers from scenario.json; otherwise it
// forwards to the built command line, so the same argv log covers a real in-process coordinator.
const RECORDER = `import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.HEIMDALL_TEST_LOG, JSON.stringify(argv) + '\\n');
const directory = process.env.FAKE_HEIMDALL_DIR;
if (!directory) {
  process.argv = [process.argv[0], process.env.HEIMDALL_TEST_CLI, ...argv];
  await import(pathToFileURL(process.env.HEIMDALL_TEST_CLI).href);
} else {
  const stripped = [];
  for (let index = 1; index < argv.length; index++) {
    if (argv[index] === '--coordinator-config') { index++; continue; }
    stripped.push(argv[index]);
  }
  const key = stripped.join(' ');
  const scenario = JSON.parse(fs.readFileSync(path.join(directory, 'scenario.json'), 'utf8'));
  let entry = scenario[key];
  if (entry === undefined) { process.stderr.write('Heimdall: Unscripted fake route ' + key + '\\n'); process.exit(1); }
  if (Array.isArray(entry)) {
    const counters = path.join(directory, 'counters.json');
    const seen = fs.existsSync(counters) ? JSON.parse(fs.readFileSync(counters, 'utf8')) : {};
    const index = Math.min(seen[key] ?? 0, entry.length - 1);
    seen[key] = (seen[key] ?? 0) + 1;
    fs.writeFileSync(counters, JSON.stringify(seen));
    entry = entry[index];
  }
  if (entry.stderr !== undefined) { process.stderr.write(entry.stderr); process.exit(entry.code ?? 1); }
  process.stdout.write(entry.stdout ?? JSON.stringify(entry.json, null, 2) + '\\n');
}
`;

async function installBinary(root) {
  const bin = path.join(root, 'bin');
  await fs.mkdir(bin, { recursive: true });
  await fs.mkdir(path.join(root, 'home'), { recursive: true });
  const recorder = path.join(bin, 'recorder.mjs');
  await fs.writeFile(recorder, RECORDER);
  const quote = value => `'${value.replaceAll("'", `'\\''`)}'`;
  const binary = path.join(bin, 'heimdall');
  await fs.writeFile(binary, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(recorder)} "$@"\n`, { mode: 0o755 });
  const log = path.join(root, 'calls.jsonl');
  await fs.writeFile(log, '');
  return {
    binary, log,
    calls: async () => (await fs.readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line)),
    reset: () => fs.writeFile(log, ''),
  };
}

async function fakeFixture(t) {
  const root = await temporaryRoot(t);
  const recorder = await installBinary(root);
  const fakeDirectory = path.join(root, 'fake');
  await fs.mkdir(fakeDirectory);
  const env = isolatedEnvironment(root, { HEIMDALL_BIN: recorder.binary, HEIMDALL_TEST_LOG: recorder.log, FAKE_HEIMDALL_DIR: fakeDirectory });
  const script = async scenario => {
    await fs.rm(path.join(fakeDirectory, 'counters.json'), { force: true });
    await fs.writeFile(path.join(fakeDirectory, 'scenario.json'), JSON.stringify(scenario));
  };
  await script({});
  return { root, env, script, ...recorder };
}

async function gitIn(env, directory, ...args) {
  return (await exec('git', ['-C', directory, ...args], { env })).stdout.trim();
}

/** A disposable repository with two commits on `main`. The returned path is canonical. */
async function makeRepository(env, parent, name) {
  const directory = path.join(parent, name);
  await fs.mkdir(directory, { recursive: true });
  await exec('git', ['-C', directory, 'init', '-q'], { env });
  await gitIn(env, directory, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  for (const text of ['one', 'two']) {
    await fs.writeFile(path.join(directory, 'file.txt'), `${text}\n`);
    await gitIn(env, directory, 'add', '.');
    await gitIn(env, directory, 'commit', '-q', '-m', text);
  }
  return fs.realpath(directory);
}

async function projectRecord(repository, id = 'project-1') {
  return { id, directory: repository, commonGitDirectory: await fs.realpath(path.join(repository, '.git')), configPath: path.join(repository, '.heimdall.toml'), concurrency: 1, createdAt: 1 };
}

function runRecord(overrides = {}) {
  return {
    id: 'run-1', projectId: 'project-1', feature: 'FEATURE-SECRET-BODY', baseCommit: 'a'.repeat(40),
    worktreePath: '/synthetic/worktrees/run-1/checkout', branch: 'heimdall/run/run-1', status: 'running', capacityReserved: true,
    version: 3, parentSessionId: 'ses_parent', launchAction: 'start', resolution: 'RESOLUTION-SECRET', reason: null,
    checkpoint: {
      phase: 'executor', index: 1, status: 'running', adr: 'feature.md',
      tasks: [{ id: 'T1', title: 'First task', brief: 'BRIEF-SECRET', dependsOn: [], dod: [] }, { id: 'T2', title: 'Second task', brief: 'BRIEF-SECRET', dependsOn: ['T1'], dod: [] }],
      results: [{ taskId: 'T1', status: 'completed', summary: 'CHECKPOINT-SECRET', handoff: '', evidence: [] }],
    },
    createdAt: 1700000000000, updatedAt: 1700000100000, settings: { plannerModel: 'SETTINGS-SECRET' },
    ...overrides,
  };
}

async function runHelper(argv, env) {
  const out = [];
  const err = [];
  const exitCode = await main(argv, { env, stdout: { write: text => out.push(text) }, stderr: { write: text => err.push(text) } });
  const text = out.join('');
  return { exitCode, text, stderr: err.join(''), report: text.trim().startsWith('{') && !text.includes('}\n{') ? JSON.parse(text) : undefined, lines: text.split('\n').filter(Boolean) };
}

function assertReadOnly(calls) {
  assert.ok(calls.length > 0);
  for (const argv of calls) {
    assert.equal(argv[0], 'coordinator');
    const stripped = [];
    for (let index = 1; index < argv.length; index++) {
      if (argv[index] === '--coordinator-config') { index++; continue; }
      stripped.push(argv[index]);
    }
    assert.match(stripped.join(' '), READ_ONLY_COMMANDS, `unexpected command ${JSON.stringify(argv)}`);
    for (const word of MUTATING_WORDS) assert.ok(!stripped.includes(word), `mutating word ${word} in ${JSON.stringify(argv)}`);
  }
}

// --- Artifact ----------------------------------------------------------------------------------------------

test('the three helper copies are byte-identical regular files that import only node: built-ins', async () => {
  const contents = [];
  for (const directory of skillDirectories) {
    const file = helperPath(directory);
    for (const entry of [directory, path.join(directory, 'scripts'), file]) assert.equal((await fs.lstat(entry)).isSymbolicLink(), false, `${entry} is a symlink`);
    assert.ok((await fs.lstat(file)).isFile());
    contents.push(await fs.readFile(file));
  }
  assert.ok(contents[0].equals(contents[1]) && contents[0].equals(contents[2]), 'copies differ');
  const source = contents[0].toString('utf8');
  const specifiers = [...source.matchAll(/(?:^|\n)\s*import\s+(?:[^'"\n]*?from\s+)?['"]([^'"]+)['"]/g), ...source.matchAll(/import\(\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
  assert.ok(specifiers.length >= 5);
  for (const specifier of specifiers) assert.match(specifier, /^node:/, `non built-in import ${specifier}`);
  assert.doesNotMatch(source, /require\(/);
});

test('importing the helper has no side effects', async () => {
  const { stdout } = await exec(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(pathToFileURL(helperFile).href)}).then(module => console.log(typeof module.main))`]);
  assert.equal(stdout.trim(), 'function');
});

// --- Pure functions ----------------------------------------------------------------------------------------

test('argument parsing treats every option value as data', () => {
  const awkward = ['with space', `quo'te"d`, '-leading', '--also-leading', '$(x);', 'a=b'];
  for (const value of awkward) {
    const parsed = parseArguments(['context', '--cwd', value, '--base', value, '--coordinator-config', value]);
    assert.deepEqual(parsed.options, { '--cwd': value, '--base': value, '--coordinator-config': value });
  }
  assert.equal(parseArguments(['context', '--cwd=-x=y']).options['--cwd'], '-x=y');
  assert.deepEqual(parseArguments(['snapshot', '--', 'run-1']).positional, ['run-1']);
  assert.deepEqual(parseArguments(['watch', 'run-1', '--budget-seconds', '5']).positional, ['run-1']);
  assert.equal(parseArguments([]).command, 'help');
  for (const bad of [['nope'], ['context', '--unknown', 'x'], ['context', '--cwd'], ['context', '--cwd='], ['context', '--cwd', 'a', '--cwd', 'b'], ['context', 'extra'], ['snapshot', 'a', 'b'], ['snapshot', '--base', 'x'], ['watch', '--base', 'x']]) {
    assert.throws(() => parseArguments(bad), UsageError, JSON.stringify(bad));
  }
});

test('watch timing is finite, defaulted and bounded', () => {
  assert.deepEqual(watchTiming({}), { budgetSeconds: DEFAULT_WATCH_BUDGET_SECONDS, intervalSeconds: DEFAULT_WATCH_INTERVAL_SECONDS });
  assert.ok(Number.isFinite(DEFAULT_WATCH_BUDGET_SECONDS) && DEFAULT_WATCH_BUDGET_SECONDS <= MAX_WATCH_BUDGET_SECONDS);
  assert.deepEqual(watchTiming({ '--budget-seconds': '2.5', '--interval-seconds': '0.5' }), { budgetSeconds: 2.5, intervalSeconds: 0.5 });
  for (const options of [{ '--budget-seconds': String(MAX_WATCH_BUDGET_SECONDS + 1) }, { '--budget-seconds': '0' }, { '--budget-seconds': 'Infinity' }, { '--budget-seconds': 'x' }, { '--interval-seconds': '0' }, { '--interval-seconds': '-1' }, { '--interval-seconds': '99999' }]) {
    assert.throws(() => watchTiming(options), UsageError, JSON.stringify(options));
  }
});

test('run lists are accepted as a bare array or as a page and treated as possibly incomplete', () => {
  const entries = [{ id: 'a', projectId: 'p', status: 'running' }, { id: 'b', projectId: 'p', status: 'succeeded' }, { id: 'c', projectId: 'q', status: 'queued' }];
  assert.deepEqual(parseRunList(entries), { runs: entries, completeness: 'unverified' });
  assert.deepEqual(parseRunList({ runs: entries, total: 3, nextCursor: null, through: 3 }), { runs: entries, completeness: 'complete' });
  assert.equal(parseRunList({ runs: entries, total: 9, nextCursor: 3, through: 9 }).completeness, 'incomplete');
  assert.throws(() => parseRunList({ nothing: true }), /unknown shape/);
  assert.throws(() => parseRunList('text'), /unknown shape/);

  const shapes = [entries, { runs: entries, total: 3, nextCursor: null, through: 3 }];
  for (const shape of shapes) {
    const chosen = chooseActiveRun(shape, 'p');
    assert.equal(chosen.outcome, 'selected');
    assert.equal(chosen.runId, 'a');
    assert.equal(chooseActiveRun(shape, 'other').outcome, 'none');
  }
  const twoActive = [...entries, { id: 'd', projectId: 'p', status: 'paused' }];
  for (const shape of [twoActive, { runs: twoActive, total: 4, nextCursor: null }]) {
    const chosen = chooseActiveRun(shape, 'p');
    assert.equal(chosen.outcome, 'needs-run-id');
    assert.equal(chosen.reason, 'multiple-active-runs');
    assert.deepEqual(chosen.candidates.map(candidate => candidate.id), ['a', 'd']);
  }
  const partial = chooseActiveRun({ runs: entries, total: 250, nextCursor: 3, through: 250 }, 'p');
  assert.equal(partial.outcome, 'needs-run-id');
  assert.equal(partial.reason, 'run-list-incomplete');
  assert.ok(ACTIVE_STATUSES.includes('reconciliation-required') && !ACTIVE_STATUSES.includes('succeeded') && !ACTIVE_STATUSES.includes('failed'));
  assert.equal(chooseActiveRun([{ id: '-flag', projectId: 'p', status: 'running' }], 'p').outcome, 'none', 'IDs that could be read as options are never selected');
});

test('run projection is compact and never carries the feature, checkpoint bodies, resolution or settings', () => {
  const projected = projectRun(runRecord({ status: 'paused', capacityReserved: false, reason: `Blocked\nneeds an owner decision ${'x'.repeat(600)}` }));
  assert.equal(projected.stateClass, 'paused');
  assert.equal(projected.phase, 'executor');
  assert.deepEqual(projected.progress, { completed: 1, total: 2 });
  assert.deepEqual(projected.currentTask, { id: 'T2', title: 'Second task' });
  assert.ok(projected.blocker.length <= 1500 && projected.blocker.startsWith('Blocked needs an owner decision'));
  assert.equal(projected.blockerTruncated, false, 'a blocker within the limit is complete');
  assert.equal(projected.parentSessionId, 'ses_parent');
  assert.equal(projected.updatedAt, new Date(1700000100000).toISOString());
  const text = JSON.stringify(projected);
  for (const secret of ['FEATURE-SECRET', 'RESOLUTION-SECRET', 'CHECKPOINT-SECRET', 'BRIEF-SECRET', 'SETTINGS-SECRET']) assert.ok(!text.includes(secret), secret);

  const states = { queued: 'queued', preparing: 'admitted', running: 'executing', paused: 'paused', succeeded: 'succeeded', failed: 'failed', 'reconciliation-required': 'reconciliation-required' };
  for (const [status, stateClass] of Object.entries(states)) assert.equal(projectRun(runRecord({ status })).stateClass, stateClass);
  assert.equal(projectRun(runRecord({ status: 'running', reason: 'stale' })).blocker, null);
  assert.equal(projectRun(runRecord({ checkpoint: null })).progress, null);
  assert.equal(projectRun(runRecord({ status: 'succeeded' })).currentTask, null);
  assert.equal(projectRun(runRecord({ checkpoint: { ...runRecord().checkpoint, phase: 'planner' } })).currentTask, null);
  assert.equal(projectRun(runRecord({ checkpoint: { ...runRecord().checkpoint, tasks: [{}, {}], index: 0 } })).currentTask.id, 'task-1');
  assert.throws(() => projectRun({}), /unexpected shape/);
});

const approvalWait = (overrides = {}) => ({
  kind: 'approval', requestId: 'apr_run-1_0001', state: 'pending', continuation: 'none', progress: 'none', phase: 'executor', taskIndex: 1, taskId: 'T2', taskTitle: 'Second task',
  attemptId: 'attempt_1', question: 'Ship the migration?', scope: 'Only the reviewed commit', completedWork: 'Migration written', verification: ['unit tests pass'],
  artifacts: ['src/migrate.ts'], onApprove: ['merge the migration'], onRequestChanges: ['fix and ask again'], revision: { head: 'a'.repeat(40), digest: 'b'.repeat(64) },
  response: null, createdAt: 1, clipped: {}, ...overrides,
});
const PAUSE = 'pau_0123456789abcdef0123456789abcdef';

test('the wait of a run is projected as a bounded approval request or a generic pause identity', () => {
  assert.equal(projectWait(undefined), null);
  assert.equal(projectWait(null), null);
  const approval = projectWait(approvalWait());
  assert.deepEqual({ kind: approval.kind, requestId: approval.requestId, state: approval.state, continuation: approval.continuation, progress: approval.progress, taskId: approval.taskId }, { kind: 'approval', requestId: 'apr_run-1_0001', state: 'pending', continuation: 'none', progress: 'none', taskId: 'T2' });
  assert.equal(approval.question, 'Ship the migration?');
  assert.deepEqual(approval.verification, ['unit tests pass']);
  assert.deepEqual(approval.revision, { head: 'a'.repeat(12), digest: 'b'.repeat(12) });
  assert.equal(approval.response, null);
  assert.deepEqual(projectWait({ kind: 'generic', pauseId: PAUSE, reason: 'SECRET-LONG-REASON', reasonClipped: true }), { kind: 'generic', pauseId: PAUSE, reasonClipped: true });
  // Text, lists and entries are bounded however much the coordinator sends, and control characters are removed.
  const huge = projectWait(approvalWait({
    question: `Q\u0000\n${'q'.repeat(50000)}`, scope: 's'.repeat(50000), completedWork: 'w'.repeat(50000), taskTitle: 't'.repeat(5000),
    verification: Array.from({ length: 200 }, () => 'v'.repeat(5000)), artifacts: Array.from({ length: 200 }, () => 'a'.repeat(5000)),
    onApprove: ['x', 7, null, 'y'], onRequestChanges: Array.from({ length: 200 }, () => 'r'.repeat(5000)),
    clipped: { question: true, scope: false, verification: true },
  }));
  assert.ok(huge.question.length <= WAIT_QUESTION_LIMIT && !/[\u0000-\u001f]/.test(huge.question));
  assert.ok(huge.scope.length <= WAIT_TEXT_LIMIT && huge.completedWork.length <= WAIT_TEXT_LIMIT && huge.taskTitle.length <= 200);
  for (const list of [huge.verification, huge.artifacts, huge.onRequestChanges]) {
    assert.equal(list.length, WAIT_LIST_LIMIT);
    assert.ok(list.every(entry => entry.length <= WAIT_ENTRY_LIMIT));
  }
  assert.deepEqual(huge.onApprove, ['x', 'y']);
  assert.deepEqual(huge.clippedFields, ['question', 'verification']);
  assert.ok(JSON.stringify(huge).length < 16 * 1024, 'the whole wait stays small');
  // The owner's feedback is never copied, only the decision and whether feedback exists.
  const answered = projectWait(approvalWait({ state: 'answered', continuation: 'queued', progress: 'queued', response: { decision: 'request-changes', feedback: 'FEEDBACK-SECRET', answeredAt: 1700000000000 } }));
  assert.deepEqual(answered.response, { decision: 'request-changes', answeredAt: new Date(1700000000000).toISOString(), feedbackRecorded: true });
  assert.ok(!JSON.stringify(answered).includes('FEEDBACK-SECRET'));
  // Anything this helper does not know is reported as such rather than guessed.
  for (const odd of ['text', 7, [], { kind: 'mystery' }, { kind: 'generic' }, { kind: 'generic', pauseId: 'bad id' }, { kind: 'approval' }, approvalWait({ requestId: '-bad' }), approvalWait({ state: 'odd' })]) {
    assert.deepEqual(projectWait(odd), { kind: 'unrecognized' }, JSON.stringify(odd));
  }
  assert.equal(projectWait(approvalWait({ continuation: 'odd', progress: 'odd' })).continuation, null);
});

test('a typed request is unresolved until its decision is consumed or it is superseded', () => {
  const unresolved = wait => approvalUnresolved(projectWait(wait));
  assert.equal(unresolved(approvalWait()), true);
  assert.equal(unresolved(approvalWait({ state: 'answered', continuation: 'pending' })), true);
  assert.equal(unresolved(approvalWait({ state: 'answered', continuation: 'queued' })), true);
  assert.equal(unresolved(approvalWait({ state: 'answered', continuation: 'consumed' })), false);
  assert.equal(unresolved(approvalWait({ state: 'superseded', continuation: 'superseded' })), false);
  // A withdrawn decision is owed delivery until a fresh attempt carries it; afterwards it is history.
  for (const progress of ['recorded', 'waiting-for-idle', 'queued', 'executing', 'none']) assert.equal(unresolved(approvalWait({ state: 'answered', continuation: 'superseded', progress })), true, progress);
  assert.equal(unresolved(approvalWait({ state: 'answered', continuation: 'superseded', progress: 'superseded' })), false);
  assert.equal(unresolved(approvalWait({ state: 'answered', continuation: 'superseded', progress: 'junk' })), true, 'an unreadable progress is not assumed to be delivered');
  assert.equal(unresolved({ kind: 'mystery' }), true, 'an unreadable wait is not assumed to be harmless');
  assert.equal(unresolved({ kind: 'generic', pauseId: PAUSE }), false);
  assert.equal(unresolved(null), false);
  assert.equal(unresolved(undefined), false);
});

test('run projections carry the wait and say whether the coordinator reports waits', () => {
  const generic = projectRun(runRecord({ status: 'paused', capacityReserved: false, wait: { kind: 'generic', pauseId: PAUSE, reason: 'Needs an owner decision', reasonClipped: false } }));
  assert.equal(generic.waitReported, true);
  assert.deepEqual(generic.wait, { kind: 'generic', pauseId: PAUSE, reasonClipped: false });
  const none = projectRun(runRecord({ wait: null }));
  assert.equal(none.waitReported, true);
  assert.equal(none.wait, null);
  const older = projectRun(runRecord());
  assert.equal(older.waitReported, false);
  assert.equal(older.wait, null);
  const text = JSON.stringify(projectRun(runRecord({ status: 'paused', capacityReserved: false, wait: approvalWait() })));
  for (const secret of ['FEATURE-SECRET', 'RESOLUTION-SECRET', 'CHECKPOINT-SECRET', 'BRIEF-SECRET', 'SETTINGS-SECRET']) assert.ok(!text.includes(secret), secret);
  const base = projectRun(runRecord({ status: 'paused', capacityReserved: false, wait: approvalWait() }));
  assert.equal(stateKey(base), stateKey(projectRun(runRecord({ status: 'paused', capacityReserved: false, wait: approvalWait(), updatedAt: 1800000000000, version: 9 }))));
  assert.notEqual(stateKey(base), stateKey(projectRun(runRecord({ status: 'paused', capacityReserved: false, wait: approvalWait({ requestId: 'apr_run-1_0002' }) }))));
  assert.notEqual(stateKey(base), stateKey(projectRun(runRecord({ status: 'paused', capacityReserved: false, wait: approvalWait({ state: 'answered', continuation: 'queued' }) }))));
  assert.notEqual(stateKey(base), stateKey(projectRun(runRecord({ status: 'paused', capacityReserved: false, wait: null }))));
});

test('a long blocker keeps its closing question and is flagged only when it is actually cut', () => {
  const question = 'Which format should the export use: plain or json?';
  const long = projectRun(runRecord({ status: 'paused', capacityReserved: false, reason: `${'Context. '.repeat(100)}${question}` }));
  assert.ok(long.blocker.endsWith(question), 'the closing question survives');
  assert.equal(long.blockerTruncated, false);
  const huge = projectRun(runRecord({ status: 'paused', capacityReserved: false, reason: `${'y'.repeat(20000)}${question}` }));
  assert.ok(huge.blocker.length <= 1500, 'still bounded');
  assert.equal(huge.blockerTruncated, true, 'a cut blocker says so');
  assert.equal(projectRun(runRecord({ status: 'running', reason: 'stale' })).blockerTruncated, false);
});

test('state keys ignore bare timestamp refreshes; stop reasons cover paused and terminal states', () => {
  const base = projectRun(runRecord());
  assert.equal(stateKey(base), stateKey(projectRun(runRecord({ updatedAt: 1800000000000, version: 9 }))));
  assert.notEqual(stateKey(base), stateKey(projectRun(runRecord({ checkpoint: { ...runRecord().checkpoint, index: 0, results: [] } }))));
  assert.notEqual(stateKey(base), stateKey(projectRun(runRecord({ capacityReserved: false }))));
  assert.equal(stopReasonFor(base), null);
  assert.equal(stopReasonFor(projectRun(runRecord({ status: 'queued' }))), null);
  assert.equal(stopReasonFor(projectRun(runRecord({ status: 'paused' }))), 'paused');
  for (const status of ['succeeded', 'failed', 'reconciliation-required']) assert.equal(stopReasonFor(projectRun(runRecord({ status }))), `terminal:${status}`);
});

test('status and text helpers', () => {
  assert.deepEqual(countStatus(' M a.txt\0?? b.txt\0R  new.txt\0old.txt\0!! ignored\0?? c.txt\0'), { tracked: 2, untracked: 2 });
  assert.deepEqual(countStatus(''), { tracked: 0, untracked: 0 });
  assert.equal(limitText('a\u0000b\n\tc', 50), 'a b c');
  assert.equal(limitText('x'.repeat(20), 5), 'xxxx…');
});

test('watchRun polls with an injected clock, suppresses repeats and honours every stop condition', async () => {
  const sequence = projections => {
    let index = 0;
    return async () => ({ ok: true, projection: projections[Math.min(index++, projections.length - 1)] });
  };
  const clock = () => {
    let time = 0;
    return { now: () => time, sleep: async milliseconds => { time += milliseconds; } };
  };
  const running = projectRun(runRecord());
  const refreshed = projectRun(runRecord({ updatedAt: 1900000000000 }));
  const paused = projectRun(runRecord({ status: 'paused', capacityReserved: false }));

  let emitted = [];
  let result = await watchRun({ readRun: sequence([running, refreshed, refreshed, paused]), emit: p => emitted.push(p.status), budgetMs: 60000, intervalMs: 1000, ...clock() });
  assert.deepEqual(emitted, ['running', 'paused']);
  assert.equal(result.reason, 'paused');
  assert.equal(result.polls, 4);

  emitted = [];
  result = await watchRun({ readRun: sequence([running]), emit: p => emitted.push(p.status), budgetMs: 5000, intervalMs: 2000, ...clock() });
  assert.equal(result.reason, 'budget');
  assert.equal(result.polls, 4, 'polls at 0, 2, 4 and the clamped final 5 seconds');
  assert.deepEqual(emitted, ['running']);

  result = await watchRun({ readRun: sequence([projectRun(runRecord({ status: 'succeeded' }))]), emit: () => {}, budgetMs: 5000, intervalMs: 1000, ...clock() });
  assert.equal(result.reason, 'terminal:succeeded');
  assert.equal(result.polls, 1);

  let calls = 0;
  result = await watchRun({
    readRun: async () => (++calls === 1 ? { ok: true, projection: running } : { ok: false, kind: 'unavailable', message: 'gone' }),
    emit: () => {}, budgetMs: 60000, intervalMs: 1000, ...clock(),
  });
  assert.equal(result.reason, 'transport-error');
  assert.deepEqual(result.error, { kind: 'unavailable', message: 'gone' });
  assert.equal(result.lastState.status, 'running');

  const controller = new AbortController();
  result = await watchRun({ readRun: sequence([running]), emit: () => controller.abort(), budgetMs: 60000, intervalMs: 1000, signal: controller.signal, ...clock() });
  assert.equal(result.reason, 'interrupted');
});

// --- Helper against a scripted command line ----------------------------------------------------------------

test('special-character paths reach the command line as argv data and never through a shell', async t => {
  const f = await fakeFixture(t);
  const names = ['with space', `quo'te"d name`, '$(x);', '`y` && z', 'tab\there'];
  for (const name of names) {
    const repository = await makeRepository(f.env, f.root, name);
    await f.script({
      'status --json': { json: { schemaVersion: 1, service: 'heimdall-coordinator', status: 'running', acceptingNewRuns: true, queuedRuns: 0, reservedRuns: 0 } },
      'project list': { json: [await projectRecord(repository)] },
    });
    await f.reset();
    const config = '-cfg $(x).toml';
    const result = await runHelper(['context', '--cwd', repository, '--coordinator-config', config], f.env);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(result.report.repository.topLevel, repository);
    assert.equal(result.report.repository.commonGitDirectory, await fs.realpath(path.join(repository, '.git')));
    assert.equal(result.report.project.match, 'one');
    assert.equal(result.report.coordinator.readiness, 'running');
    assert.deepEqual(result.report.coordinator.configuration, { source: 'flag', file: path.join(repository, config) });
    const calls = await f.calls();
    assertReadOnly(calls);
    assert.equal(calls.length, 2);
    for (const argv of calls) {
      const position = argv.indexOf('--coordinator-config');
      assert.equal(argv[position + 1], path.join(repository, config), 'the selected configuration is forwarded as an absolute path to every call');
      assert.equal(argv.at(-2), '--coordinator-config');
    }
  }
});

test('a leading-dash directory and configuration name given on a real command line are data', async t => {
  const f = await fakeFixture(t);
  const repository = await makeRepository(f.env, f.root, '-dash');
  await f.script({
    'status --json': { json: { schemaVersion: 1, service: 'heimdall-coordinator', status: 'running', acceptingNewRuns: true, queuedRuns: 0, reservedRuns: 0 } },
    'project list': { json: [await projectRecord(repository)] },
  });
  const { stdout } = await exec(process.execPath, [helperFile, 'context', '--cwd', '-dash', '--coordinator-config', '-cfg.toml'], { cwd: f.root, env: f.env });
  const report = JSON.parse(stdout);
  assert.equal(report.repository.topLevel, repository);
  assert.equal(report.project.match, 'one');
  for (const argv of await f.calls()) assert.equal(argv[argv.indexOf('--coordinator-config') + 1], path.join(repository, '-cfg.toml'));
});

test('without a flag the configuration source is the environment, then the default, and is reported', async t => {
  const f = await fakeFixture(t);
  const repository = await makeRepository(f.env, f.root, 'repo');
  await f.script({
    'status --json': { json: { schemaVersion: 1, service: 'heimdall-coordinator', status: 'running', acceptingNewRuns: true, queuedRuns: 0, reservedRuns: 0 } },
    'project list': { json: [] },
  });
  const env = { ...f.env, HEIMDALL_COORDINATOR_CONFIG: '/synthetic/env-config.toml' };
  let result = await runHelper(['context', '--cwd', repository], env);
  assert.deepEqual(result.report.coordinator.configuration, { source: 'environment', file: '/synthetic/env-config.toml' });
  result = await runHelper(['context', '--cwd', repository], f.env);
  assert.deepEqual(result.report.coordinator.configuration, { source: 'default', file: path.join(f.env.HOME, '.config', 'heimdall', 'coordinator.toml') });
  for (const argv of await f.calls()) assert.ok(!argv.includes('--coordinator-config'), 'nothing is forwarded when no file was selected');
});

test('context reports coordinator readiness, unavailable coordinators, a missing binary and a dirty tree', async t => {
  const f = await fakeFixture(t);
  const repository = await makeRepository(f.env, f.root, 'repo');
  await fs.writeFile(path.join(repository, 'file.txt'), 'changed\n');
  await fs.writeFile(path.join(repository, 'new.txt'), 'new\n');
  const status = (state, accepting) => ({ json: { schemaVersion: 1, service: 'heimdall-coordinator', status: state, acceptingNewRuns: accepting, queuedRuns: 2, reservedRuns: 1 } });

  await f.script({ 'status --json': status('draining', false), 'project list': { json: [await projectRecord(repository)] } });
  let result = await runHelper(['context', '--cwd', repository], f.env);
  assert.equal(result.report.coordinator.readiness, 'draining');
  assert.equal(result.report.coordinator.acceptingNewRuns, false);
  assert.equal(result.report.coordinator.queuedRuns, 2);
  assert.deepEqual(result.report.repository.changes, { tracked: 1, untracked: 1 });
  assert.ok(result.report.notices.some(notice => /1 changed and 1 untracked/.test(notice)));
  assert.ok(result.report.notices.some(notice => /draining/.test(notice)));

  await f.script({ 'status --json': { stderr: 'Heimdall: Coordinator unavailable: connect ENOENT /x/coordinator.sock\n' }, 'project list': { json: [] } });
  await f.reset();
  result = await runHelper(['context', '--cwd', repository], f.env);
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.coordinator.readiness, 'unavailable');
  assert.equal(result.report.coordinator.error.kind, 'unavailable');
  assert.equal(result.report.project.match, 'unknown');
  assert.equal((await f.calls()).length, 1, 'no project lookup after an unavailable status');

  result = await runHelper(['context', '--cwd', repository], { ...f.env, HEIMDALL_BIN: path.join(f.root, 'does-not-exist') });
  assert.equal(result.report.coordinator.readiness, 'unavailable');
  assert.equal(result.report.coordinator.error.kind, 'not-installed');

  await f.script({ 'status --json': { stdout: '{"status":"running"}\n' } });
  result = await runHelper(['context', '--cwd', repository], f.env);
  assert.equal(result.report.coordinator.readiness, 'unavailable');
  assert.equal(result.report.coordinator.error.kind, 'invalid-response');

  const outside = path.join(f.root, 'plain');
  await fs.mkdir(outside);
  result = await runHelper(['context', '--cwd', outside], f.env);
  assert.equal(result.report.repository, null);
  assert.ok(result.report.notices.some(notice => /not inside a Git worktree/.test(notice)));
  result = await runHelper(['context', '--cwd', path.join(f.root, 'missing')], f.env);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /--cwd must name an existing directory/);
});

test('project matching and run selection report zero, one and many instead of guessing', async t => {
  const f = await fakeFixture(t);
  const repository = await makeRepository(f.env, f.root, 'repo');
  const project = await projectRecord(repository);
  const status = { json: { schemaVersion: 1, service: 'heimdall-coordinator', status: 'running', acceptingNewRuns: true, queuedRuns: 0, reservedRuns: 0 } };

  await f.script({ 'status --json': status, 'project list': { json: [{ ...project, commonGitDirectory: '/elsewhere/.git' }] } });
  let result = await runHelper(['context', '--cwd', repository], f.env);
  assert.equal(result.report.project.match, 'none');
  result = await runHelper(['snapshot', '--cwd', repository], f.env);
  assert.equal(result.exitCode, 0);
  assert.equal(result.report.outcome, 'needs-run-id');
  assert.equal(result.report.reason, 'no-matching-project');

  await f.script({ 'status --json': status, 'project list': { json: [project, { ...project, id: 'project-2' }] } });
  result = await runHelper(['context', '--cwd', repository], f.env);
  assert.equal(result.report.project.match, 'many');
  assert.deepEqual(result.report.project.projects.map(entry => entry.id), ['project-1', 'project-2']);
  result = await runHelper(['watch', '--cwd', repository], f.env);
  assert.equal(result.report.outcome, 'needs-run-id');
  assert.equal(result.report.reason, 'multiple-matching-projects');

  const list = [
    { id: 'old', projectId: 'project-1', status: 'succeeded', updatedAt: 1 },
    { id: 'other-project', projectId: 'project-9', status: 'running', updatedAt: 2 },
    { id: 'run-1', projectId: 'project-1', status: 'running', updatedAt: 3 },
  ];
  const shown = { json: runRecord() };
  for (const shape of [list, { runs: list, total: 3, nextCursor: null, through: 3 }]) {
    await f.script({ 'project list': { json: [project] }, 'run list': { json: shape }, 'run show run-1': shown });
    result = await runHelper(['snapshot', '--cwd', repository], f.env);
    assert.equal(result.report.outcome, 'snapshot', result.text);
    assert.equal(result.report.selection.via, 'sole-active-run');
    assert.equal(result.report.run.runId, 'run-1');
  }

  const second = [...list, { id: 'run-2', projectId: 'project-1', status: 'paused', updatedAt: 4 }];
  for (const shape of [second, { runs: second, total: 4, nextCursor: null, through: 4 }]) {
    await f.script({ 'project list': { json: [project] }, 'run list': { json: shape } });
    result = await runHelper(['snapshot', '--cwd', repository], f.env);
    assert.equal(result.report.outcome, 'needs-run-id');
    assert.equal(result.report.reason, 'multiple-active-runs');
    assert.deepEqual(result.report.candidates.map(entry => entry.id), ['run-1', 'run-2']);
  }

  await f.script({ 'project list': { json: [project] }, 'run list': { json: { runs: list, total: 500, nextCursor: 3, through: 500 } } });
  result = await runHelper(['snapshot', '--cwd', repository], f.env);
  assert.equal(result.report.outcome, 'needs-run-id');
  assert.equal(result.report.reason, 'run-list-incomplete');

  await f.script({ 'project list': { json: [project] }, 'run list': { stderr: 'Heimdall: Coordinator response is too large\n' } });
  result = await runHelper(['snapshot', '--cwd', repository], f.env);
  assert.equal(result.report.outcome, 'needs-run-id');
  assert.equal(result.report.reason, 'run-list-too-large');

  await f.script({ 'project list': { json: [project] }, 'run list': { json: [list[0]] } });
  result = await runHelper(['snapshot', '--cwd', repository], f.env);
  assert.equal(result.report.outcome, 'none');

  await f.script({ 'project list': { json: [project] }, 'run list': { stderr: 'Heimdall: Coordinator unavailable: connect ECONNREFUSED\n' } });
  result = await runHelper(['snapshot', '--cwd', repository], f.env);
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.ok, false);
  assert.equal(result.report.error.kind, 'unavailable');
  assertReadOnly(await f.calls());
});

// --- Ambient Git environment -------------------------------------------------------------------------------

/** Two unrelated repositories with different HEADs, plus an environment that points Git at the second one. */
async function ambientRepositories(t) {
  const f = await fakeFixture(t);
  const a = await makeRepository(f.env, f.root, 'repo-a');
  const b = await makeRepository(f.env, f.root, 'repo-b');
  await fs.writeFile(path.join(b, 'file.txt'), 'three\n');
  await gitIn(f.env, b, 'add', '.');
  await gitIn(f.env, b, 'commit', '-q', '-m', 'three');
  const headA = await gitIn(f.env, a, 'rev-parse', 'HEAD');
  const headB = await gitIn(f.env, b, 'rev-parse', 'HEAD');
  assert.notEqual(headA, headB);
  const poisoned = { ...f.env, GIT_DIR: path.join(b, '.git'), GIT_WORK_TREE: b };
  return { f, a, b, headA, headB, poisoned };
}

test('context reports the selected repository even when the environment points Git at another one', async t => {
  const { f, a, b, headA, poisoned } = await ambientRepositories(t);
  const status = { json: { schemaVersion: 1, service: 'heimdall-coordinator', status: 'running', acceptingNewRuns: true, queuedRuns: 0, reservedRuns: 0 } };
  await f.script({ 'status --json': status, 'project list': { json: [await projectRecord(b, 'project-b'), await projectRecord(a, 'project-a')] } });
  const result = await runHelper(['context', '--cwd', a], poisoned);
  assert.equal(result.exitCode, 0, result.stderr);
  const { report } = result;
  assert.equal(report.repository.topLevel, a);
  assert.equal(report.repository.commonGitDirectory, await fs.realpath(path.join(a, '.git')));
  assert.equal(report.repository.head, headA);
  assert.equal(report.project.match, 'one');
  assert.deepEqual(report.project.projects.map(entry => entry.id), ['project-a']);
  assertReadOnly(await f.calls());
});

test('monitor selection follows the selected repository, and an explicit run ID still wins, under an ambient Git override', async t => {
  const { f, a, b, poisoned } = await ambientRepositories(t);
  const runA = 'run-a';
  const runB = 'run-b';
  const list = [
    { id: runA, projectId: 'project-a', status: 'running', updatedAt: 3 },
    { id: runB, projectId: 'project-b', status: 'running', updatedAt: 4 },
  ];
  await f.script({
    'project list': { json: [await projectRecord(a, 'project-a'), await projectRecord(b, 'project-b')] },
    'run list': { json: list },
    [`run show ${runA}`]: { json: runRecord({ id: runA, projectId: 'project-a', branch: `heimdall/run/${runA}` }) },
    [`run show ${runB}`]: { json: runRecord({ id: runB, projectId: 'project-b', branch: `heimdall/run/${runB}` }) },
  });
  await f.reset();

  let result = await runHelper(['snapshot', '--cwd', a], poisoned);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.report.outcome, 'snapshot', result.text);
  assert.equal(result.report.selection.via, 'sole-active-run');
  assert.equal(result.report.run.runId, runA);
  assert.ok(!result.text.includes(runB), 'the other repository run is never shown');

  result = await runHelper(['watch', '--cwd', a, '--budget-seconds', '0.3', '--interval-seconds', '0.1'], poisoned);
  assert.equal(result.exitCode, 0, result.stderr);
  const events = result.lines.map(line => JSON.parse(line));
  assert.equal(events[0].event, 'watching');
  assert.equal(events[0].via, 'sole-active-run');
  assert.equal(events[0].runId, runA);
  assert.ok(events.filter(event => event.event === 'state').every(event => event.run.runId === runA));
  assert.ok(!result.text.includes(runB));

  const calls = await f.calls();
  assertReadOnly(calls);
  assert.ok(calls.every(argv => argv.at(-1) !== runB || argv.at(-2) !== 'show'), 'run show never reads the other repository run before an explicit ID');

  await f.reset();
  result = await runHelper(['snapshot', runB, '--cwd', a], poisoned);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.report.selection.via, 'explicit');
  assert.equal(result.report.run.runId, runB);
  assert.deepEqual(await f.calls(), [['coordinator', 'run', 'show', runB]]);
});

const LISTED_GIT_VARIABLES = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE', 'GIT_CONFIG', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
];

test('the helper Git environment drops repository-redirecting overrides and keeps everything else', () => {
  const indexed = { GIT_CONFIG_KEY_0: 'core.worktree', GIT_CONFIG_VALUE_0: '/elsewhere', GIT_CONFIG_KEY_1: 'a.b', GIT_CONFIG_VALUE_1: 'c', GIT_CONFIG_KEY_12: 'x.y', GIT_CONFIG_VALUE_12: 'z' };
  const kept = {
    PATH: '/usr/bin', HOME: '/synthetic/home', HEIMDALL_BIN: '/synthetic/bin/heimdall', HEIMDALL_COORDINATOR_CONFIG: '/synthetic/coordinator.toml',
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Synthetic', GIT_OPTIONAL_LOCKS: '1',
  };
  const input = { ...kept, ...Object.fromEntries(LISTED_GIT_VARIABLES.map(name => [name, 'ambient'])), ...indexed };
  const snapshot = structuredClone(input);
  const processBefore = { ...process.env };

  const result = gitEnvironment(input);

  assert.notEqual(result, input);
  assert.deepEqual(input, snapshot, 'the supplied environment is not modified');
  assert.deepEqual({ ...process.env }, processBefore, 'process.env is not modified');
  for (const name of [...LISTED_GIT_VARIABLES, ...Object.keys(indexed)]) assert.ok(!(name in result), `${name} is removed`);
  assert.deepEqual(result, { ...kept, GIT_OPTIONAL_LOCKS: '0' });

  assert.deepEqual(gitEnvironment({}), { GIT_OPTIONAL_LOCKS: '0' });
  assert.equal(gitEnvironment({ GIT_CONFIG_KEY_x: 'kept', GIT_CONFIG_VALUE_: 'kept' }).GIT_CONFIG_KEY_x, 'kept', 'only numerically indexed entries are removed');
});

test('a managed run branch selects its run, and a different run record is not accepted for it', async t => {
  const f = await fakeFixture(t);
  const repository = await makeRepository(f.env, f.root, 'repo');
  await gitIn(f.env, repository, 'checkout', '-q', '-b', 'heimdall/run/run-1');
  await f.script({ 'run show run-1': { json: runRecord() } });
  await f.reset();
  let result = await runHelper(['snapshot', '--cwd', repository], f.env);
  assert.equal(result.report.selection.via, 'managed-branch');
  assert.equal(result.report.run.runId, 'run-1');
  assert.deepEqual((await f.calls()).map(argv => argv[1]), ['run'], 'one run read, no project or list lookups');

  await f.script({ 'run show run-1': { json: runRecord({ branch: 'heimdall/run/another' }) } });
  result = await runHelper(['snapshot', '--cwd', repository], f.env);
  assert.equal(result.report.outcome, 'needs-run-id');
  assert.equal(result.report.reason, 'managed-branch-run-mismatch');

  await f.script({ 'run show run-1': { stderr: 'Heimdall: Run not found\n' } });
  result = await runHelper(['snapshot', '--cwd', repository], f.env);
  assert.equal(result.report.reason, 'managed-branch-run-mismatch');

  result = await runHelper(['snapshot', '-bad', '--cwd', repository], f.env);
  assert.equal(result.exitCode, 2);
  result = await runHelper(['snapshot', 'bad id', '--cwd', repository], f.env);
  assert.equal(result.exitCode, 2);
  assert.match(result.stderr, /RUN_ID/);
});

test('snapshot is one run read, projects a compact report and reports its evidence limits', async t => {
  const f = await fakeFixture(t);
  await f.script({ 'run show run-1': { json: runRecord() } });
  await f.reset();
  const result = await runHelper(['snapshot', 'run-1', '--cwd', f.root], f.env);
  assert.equal(result.exitCode, 0, result.stderr);
  const { run } = result.report;
  assert.equal(run.runId, 'run-1');
  assert.equal(run.stateClass, 'executing');
  assert.equal(run.capacityReserved, true);
  assert.deepEqual(run.progress, { completed: 1, total: 2 });
  assert.deepEqual(run.currentTask, { id: 'T2', title: 'Second task' });
  assert.equal(run.branch, 'heimdall/run/run-1');
  assert.equal(run.worktreePath, '/synthetic/worktrees/run-1/checkout');
  assert.equal(run.parentSessionId, 'ses_parent');
  assert.ok(result.report.limits.some(limit => /not proof that an agent is active/.test(limit)));
  assert.ok(result.report.limits.some(limit => /not necessarily stalled/.test(limit)));
  for (const secret of ['FEATURE-SECRET', 'RESOLUTION-SECRET', 'CHECKPOINT-SECRET', 'BRIEF-SECRET', 'SETTINGS-SECRET']) assert.ok(!result.text.includes(secret), secret);
  const calls = await f.calls();
  assert.deepEqual(calls, [['coordinator', 'run', 'show', 'run-1']]);

  await f.script({ 'run show run-1': { stderr: 'Heimdall: Run not found\n' } });
  const missing = await runHelper(['snapshot', 'run-1', '--cwd', f.root], f.env);
  assert.equal(missing.exitCode, 1);
  assert.equal(missing.report.error.kind, 'not-found');

  await f.script({ 'run show run-1': { json: runRecord({ id: 'run-2' }) } });
  const wrong = await runHelper(['snapshot', 'run-1', '--cwd', f.root], f.env);
  assert.equal(wrong.report.error.kind, 'invalid-response');
});

test('snapshot of a run with a pending approval request is one read that shows the bounded request', async t => {
  const f = await fakeFixture(t);
  await f.script({ 'run show run-1': { json: runRecord({ status: 'paused', capacityReserved: false, reason: 'Approval required for T2', wait: approvalWait({ question: `Ship it? ${'x'.repeat(20000)}` }) }) } });
  await f.reset();
  const result = await runHelper(['snapshot', 'run-1', '--cwd', f.root], f.env);
  assert.equal(result.exitCode, 0, result.stderr);
  const { wait } = result.report.run;
  assert.equal(wait.kind, 'approval');
  assert.equal(wait.requestId, 'apr_run-1_0001');
  assert.equal(wait.state, 'pending');
  assert.ok(wait.question.length <= WAIT_QUESTION_LIMIT);
  assert.deepEqual(wait.onApprove, ['merge the migration']);
  assert.ok(result.text.length < 16 * 1024);
  for (const secret of ['FEATURE-SECRET', 'RESOLUTION-SECRET', 'CHECKPOINT-SECRET', 'BRIEF-SECRET', 'SETTINGS-SECRET']) assert.ok(!result.text.includes(secret), secret);
  const calls = await f.calls();
  assertReadOnly(calls);
  assert.deepEqual(calls, [['coordinator', 'run', 'show', 'run-1']]);
});

// --- Complete approval request ---------------------------------------------------------------------------------

const REQUEST_KEY = 'run approval run-1 --request apr_run-1_0001';
const approvalView = (request, overrides = {}) => ({
  requestId: 'apr_run-1_0001', runId: 'run-1', state: 'pending', continuation: 'none', progress: 'none', taskId: 'T2', taskIndex: 1, attemptId: 'attempt_1',
  revision: { head: 'a'.repeat(40), digest: 'b'.repeat(64) }, ...request, response: null, createdAt: 1700000000000, ...overrides,
});
const requestArguments = (f, extra = []) => ['request', 'run-1', '--request', 'apr_run-1_0001', '--cwd', f.root, ...extra];

test('a wait the coordinator or the helper cut is marked shortened and names the request command; a whole one is not', () => {
  const whole = projectRun(runRecord({ status: 'paused', capacityReserved: false, wait: approvalWait() }));
  assert.equal(whole.wait.shortened, false);
  assert.equal(whole.wait.completeRequest, undefined);
  const flagged = projectRun(runRecord({ status: 'paused', capacityReserved: false, wait: approvalWait({ clipped: { scope: true } }) }));
  assert.equal(flagged.wait.shortened, true);
  assert.equal(flagged.wait.completeRequest.command, 'request run-1 --request apr_run-1_0001');
  assert.match(flagged.wait.completeRequest.note, /do not treat this summary as the full scope/);
  // Text or lists that fit the coordinator's compact limits but not the helper's own are cut by the helper, and say so.
  for (const overrides of [
    { scope: 's'.repeat(WAIT_TEXT_LIMIT + 1) }, { completedWork: 'w'.repeat(WAIT_TEXT_LIMIT + 1) }, { question: 'q'.repeat(WAIT_QUESTION_LIMIT + 1) },
    { verification: Array.from({ length: WAIT_LIST_LIMIT + 1 }, () => 'v') }, { onApprove: ['a'.repeat(WAIT_ENTRY_LIMIT + 1)] }, { artifacts: ['fine', 7] },
  ]) {
    const projected = projectRun(runRecord({ status: 'paused', capacityReserved: false, wait: approvalWait(overrides) }));
    assert.equal(projected.wait.shortened, true, JSON.stringify(Object.keys(overrides)));
    assert.equal(projected.wait.completeRequest.command, 'request run-1 --request apr_run-1_0001');
  }
  // Whitespace collapsing alone loses nothing.
  assert.equal(projectWait(approvalWait({ scope: 'a\n\n  b' })).shortened, false);
  assert.notEqual(stateKey(whole), stateKey(flagged));
});

test('request validates a complete answer against the run, the request and the accepted limits', () => {
  const ask = { runId: 'run-1', requestId: 'apr_run-1_0001' };
  const good = parseCompleteRequest(approvalView(hiddenTailRequest()), ask);
  assert.equal(good.ok, true);
  assert.equal(good.request.scope.length, 1900);
  assert.deepEqual(good.request.task, { id: 'T2', index: 1 });
  assert.deepEqual(good.request.revision, { head: 'a'.repeat(40), digest: 'b'.repeat(64) });
  assert.equal(parseCompleteRequest(approvalView(nearLimitRequest()), ask).ok, true, 'a request exactly at the accepted size is complete');
  const answered = parseCompleteRequest(approvalView(hiddenTailRequest(), { state: 'answered', continuation: 'queued', progress: 'queued', response: { decision: 'request-changes', feedback: 'FEEDBACK-SECRET', answeredAt: 1700000000000 } }), ask);
  assert.deepEqual(answered.request.response, { decision: 'request-changes', answeredAt: new Date(1700000000000).toISOString(), feedbackRecorded: true });
  assert.ok(!JSON.stringify(answered).includes('FEEDBACK-SECRET'));
  const base = hiddenTailRequest();
  const invalid = {
    'another run': approvalView(base, { runId: 'run-2' }),
    'another request': approvalView(base, { requestId: 'apr_other' }),
    'a missing text': approvalView({ ...base, scope: undefined }),
    'a text over the limit': approvalView({ ...base, scope: 's'.repeat(CANONICAL.text + 1) }),
    'a list over the limit': approvalView({ ...base, verification: Array.from({ length: CANONICAL.list + 1 }, () => 'v') }),
    'a list that is not a list': approvalView({ ...base, artifacts: 'x' }),
    'a mistyped entry': approvalView({ ...base, onApprove: ['ok', 7] }),
    'an entry over the limit': approvalView({ ...base, onApprove: ['o'.repeat(CANONICAL.text + 1)] }),
    'a request over the payload limit': approvalView({ ...base, verification: Array.from({ length: 20 }, () => 'v'.repeat(CANONICAL.text)) }),
    'a missing revision': approvalView(base, { revision: undefined }),
    'a revision that is not hexadecimal': approvalView(base, { revision: { head: 'zz', digest: 'b'.repeat(64) } }),
    'an unknown state': approvalView(base, { state: 'odd' }),
    'an unknown progress': approvalView(base, { progress: 'odd' }),
    'a missing task': approvalView(base, { taskId: '' }),
    'a bad task index': approvalView(base, { taskIndex: -1 }),
    'an answered request without a response': approvalView(base, { state: 'answered' }),
    'a response on a pending request': approvalView(base, { response: { decision: 'approve', feedback: null, answeredAt: 1 } }),
    'not an object': 'text',
  };
  for (const [name, value] of Object.entries(invalid)) {
    const result = parseCompleteRequest(value, ask);
    assert.equal(result.ok, false, name);
    assert.equal(result.request, undefined, name);
  }
});

test('request reads the complete request through run approval: tail text, late list entries and order survive, and nothing is mutated', async t => {
  const f = await fakeFixture(t);
  const content = hiddenTailRequest();
  assert.ok(content.scope.length > COMPACT.text && content.verification.length > COMPACT.list);
  await f.script({ [REQUEST_KEY]: { json: approvalView(content) } });
  await f.reset();
  const result = await runHelper(requestArguments(f), f.env);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.report.complete, true);
  assert.equal(result.report.outcome, 'request');
  const { request } = result.report;
  for (const field of ['question', 'scope', 'completedWork', 'verification', 'artifacts', 'onApprove', 'onRequestChanges']) assert.deepEqual(request[field], content[field], field);
  assert.ok(request.scope.includes('ACTION-AFTER-1500'));
  assert.ok(request.verification[12].includes('EVIDENCE-ENTRY-12'));
  assert.ok(request.onApprove[13].includes('PROPOSED-ACTION-13'));
  assert.equal(request.state, 'pending');
  assert.equal(request.revision.digest, 'b'.repeat(64));
  const calls = await f.calls();
  assertReadOnly(calls);
  assert.deepEqual(calls, [['coordinator', 'run', 'approval', 'run-1', '--request', 'apr_run-1_0001']]);

  // The snapshot of the same request is compact, says so, and names this command.
  await f.script({ 'run show run-1': { json: runRecord({ status: 'paused', capacityReserved: false, wait: approvalWait({ scope: content.scope.slice(0, COMPACT.text), clipped: { scope: true } }) }) } });
  const snapshot = await runHelper(['snapshot', 'run-1', '--cwd', f.root], f.env);
  assert.equal(snapshot.report.run.wait.shortened, true);
  assert.ok(!JSON.stringify(snapshot.report.run.wait).includes('ACTION-AFTER-1500'));
  assert.equal(snapshot.report.run.wait.completeRequest.command, 'request run-1 --request apr_run-1_0001');
});

test('request forwards the selected coordinator configuration and an exact-limit request is complete', async t => {
  const f = await fakeFixture(t);
  const content = nearLimitRequest();
  await f.script({ [REQUEST_KEY]: { json: approvalView(content) } });
  await f.reset();
  const config = path.join(f.root, 'coordinator.toml');
  const result = await runHelper(requestArguments(f, ['--coordinator-config', config]), f.env);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.deepEqual(result.report.request.onRequestChanges, content.onRequestChanges);
  assert.equal(result.report.coordinator.configuration.file, config);
  const calls = await f.calls();
  assert.deepEqual(calls, [['coordinator', 'run', 'approval', 'run-1', '--request', 'apr_run-1_0001', '--coordinator-config', config]]);
  assertReadOnly(calls);
});

test('request that cannot read the whole request reports incomplete review information, with no content, and exit status 1', async t => {
  const f = await fakeFixture(t);
  const base = hiddenTailRequest();
  const failures = {
    'an unknown request': { stderr: 'Heimdall: The coordinator at http://x has no approval request apr_run-1_0001 for run run-1.\n', code: 1 },
    'an older command line': { stderr: 'Heimdall: Unknown coordinator command; see --help\n', code: 1 },
    'an older coordinator': { stderr: 'Heimdall: The coordinator at http://x does not support reading an approval request (likely an older version). Nothing was changed.\n', code: 1 },
    'an unavailable coordinator': { stderr: 'Heimdall: Coordinator unavailable\n', code: 1 },
    'output that is not JSON': { stdout: 'not json\n' },
    'an answer for another request': { json: approvalView(base, { requestId: 'apr_other' }) },
    'an answer over the accepted limit': { json: approvalView({ ...base, scope: 's'.repeat(CANONICAL.text + 1) }) },
    'a partial answer': { json: { requestId: 'apr_run-1_0001', runId: 'run-1', question: 'Only this' } },
  };
  for (const [name, entry] of Object.entries(failures)) {
    await f.script({ [REQUEST_KEY]: entry });
    await f.reset();
    const result = await runHelper(requestArguments(f), f.env);
    assert.equal(result.exitCode, 1, name);
    assert.equal(result.report.ok, false, name);
    assert.equal(result.report.complete, false, name);
    assert.equal(result.report.request, undefined, name);
    assert.match(result.report.note, /review information is incomplete/, name);
    assert.ok(!result.text.includes('ACTION-AFTER-1500') && !result.text.includes('Only this'), name);
    assertReadOnly(await f.calls());
  }
  await f.script({ [REQUEST_KEY]: { stderr: 'Heimdall: Unknown coordinator command; see --help\n', code: 1 } });
  assert.equal((await runHelper(requestArguments(f), f.env)).report.error.kind, 'unsupported');
});

test('request arguments are validated before anything is sent', async t => {
  const f = await fakeFixture(t);
  await f.reset();
  for (const argv of [
    ['request', '--cwd', f.root], ['request', 'run-1', '--cwd', f.root], ['request', '--request', 'apr_1', '--cwd', f.root],
    ['request', '-bad', '--request', 'apr_1', '--cwd', f.root], ['request', 'run-1', '--request', '-bad', '--cwd', f.root], ['request', 'run-1', '--request', 'a b', '--cwd', f.root],
    ['request', 'run-1', '--request', 'apr_1', 'extra', '--cwd', f.root], ['request', 'run-1', '--request', 'apr_1', '--decision', 'approve', '--cwd', f.root],
    ['request', 'run-1', '--request', 'apr_1', '--guidance-file', 'x', '--cwd', f.root],
  ]) {
    const result = await runHelper(argv, f.env);
    assert.equal(result.exitCode, 2, JSON.stringify(argv));
    assert.equal(result.text, '');
  }
  assert.deepEqual(await f.calls(), [], 'nothing reached the command line');
});

test('request is listed as a read in the help and the usage of the helper', async () => {
  const out = [];
  assert.equal(await main(['--help'], { stdout: { write: text => out.push(text) } }), 0);
  const help = out.join('');
  assert.match(help, /openheimdall\.mjs request  RUN_ID --request ID/);
  assert.match(help, /context, snapshot, watch, request and inspect-spec only read/);
});

test('watch reports a new, answered and superseded request as changes and stops when the run pauses on one', async t => {
  const f = await fakeFixture(t);
  const at = (wait, extra = {}) => ({ json: runRecord({ wait, ...extra }) });
  await f.script({ 'run show run-1': [at(null), at(approvalWait(), { status: 'paused', capacityReserved: false })] });
  await f.reset();
  const result = await runHelper(['watch', 'run-1', '--cwd', f.root, '--budget-seconds', '30', '--interval-seconds', '0.1'], f.env);
  assert.equal(result.exitCode, 0, result.stderr);
  const events = result.lines.map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.event), ['watching', 'state', 'state', 'stopped']);
  assert.equal(events[2].run.wait.requestId, 'apr_run-1_0001');
  assert.equal(events.at(-1).reason, 'paused');
  assert.equal(events.at(-1).lastState.wait.state, 'pending');
  assertReadOnly(await f.calls());
});

test('watch emits only changes, stops on pause, and issues only run reads', async t => {
  const f = await fakeFixture(t);
  const at = (completed, extra = {}) => ({ json: runRecord({ checkpoint: { ...runRecord().checkpoint, results: Array.from({ length: completed }, (_, index) => ({ taskId: `T${index + 1}` })) }, ...extra }) });
  await f.script({
    'run show run-1': [at(1), at(1, { updatedAt: 1700000200000 }), at(1, { updatedAt: 1700000300000 }), at(2), at(2, { status: 'paused', capacityReserved: false, reason: 'Needs an owner decision' })],
  });
  await f.reset();
  const result = await runHelper(['watch', 'run-1', '--cwd', f.root, '--budget-seconds', '30', '--interval-seconds', '0.1'], f.env);
  assert.equal(result.exitCode, 0, result.stderr);
  const events = result.lines.map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.event), ['watching', 'state', 'state', 'state', 'stopped']);
  assert.deepEqual(events.filter(event => event.event === 'state').map(event => event.run.progress.completed), [1, 2, 2]);
  const stopped = events.at(-1);
  assert.equal(stopped.reason, 'paused');
  assert.equal(stopped.polls, 5);
  assert.equal(stopped.lastState.status, 'paused');
  assert.equal(stopped.lastState.blocker, 'Needs an owner decision');
  assert.equal(events[0].budgetSeconds, 30);
  const calls = await f.calls();
  assertReadOnly(calls);
  assert.equal(calls.length, 5);
  for (const secret of ['FEATURE-SECRET', 'RESOLUTION-SECRET', 'CHECKPOINT-SECRET', 'BRIEF-SECRET', 'SETTINGS-SECRET']) assert.ok(!result.text.includes(secret), secret);
});

test('watch ends within its budget, reports unchanged state once, and stops on a transport error', async t => {
  const f = await fakeFixture(t);
  await f.script({ 'run show run-1': { json: runRecord() } });
  const started = Date.now();
  let result = await runHelper(['watch', 'run-1', '--cwd', f.root, '--budget-seconds', '0.6', '--interval-seconds', '0.1'], f.env);
  const elapsed = Date.now() - started;
  const events = result.lines.map(line => JSON.parse(line));
  assert.equal(result.exitCode, 0);
  assert.ok(elapsed < 8000, `watch ran ${elapsed} ms for a 0.6 s budget`);
  assert.equal(events.filter(event => event.event === 'state').length, 1);
  assert.equal(events.at(-1).reason, 'budget');
  assert.ok(events.at(-1).polls >= 2);
  assert.equal(events.at(-1).lastState.status, 'running');

  await f.script({ 'run show run-1': [{ json: runRecord() }, { stderr: 'Heimdall: Coordinator unavailable: connect ECONNREFUSED /x\n' }] });
  result = await runHelper(['watch', 'run-1', '--cwd', f.root, '--budget-seconds', '30', '--interval-seconds', '0.1'], f.env);
  assert.equal(result.exitCode, 1);
  const stopped = result.lines.map(line => JSON.parse(line)).at(-1);
  assert.equal(stopped.reason, 'transport-error');
  assert.equal(stopped.error.kind, 'unavailable');
  assert.equal(stopped.lastState.status, 'running');

  await f.script({ 'run show run-1': { json: runRecord({ status: 'succeeded', capacityReserved: false }) } });
  result = await runHelper(['watch', 'run-1', '--cwd', f.root, '--budget-seconds', '30'], f.env);
  assert.equal(result.lines.map(line => JSON.parse(line)).at(-1).reason, 'terminal:succeeded');

  assert.equal((await runHelper(['watch', 'run-1', '--cwd', f.root, '--budget-seconds', '99999'], f.env)).exitCode, 2);
});

test('watch stops on SIGINT and SIGTERM with the last known state', { skip: process.platform === 'win32' }, async t => {
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const f = await fakeFixture(t);
    await f.script({ 'run show run-1': { json: runRecord() } });
    const child = spawn(process.execPath, [helperFile, 'watch', 'run-1', '--cwd', f.root], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const exited = new Promise(resolve => child.once('exit', (code, signalName) => resolve({ code, signalName })));
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no state line: ${output}`)), 15000);
      child.stdout.on('data', chunk => { output += chunk; if (output.includes('"event":"state"')) { clearTimeout(timer); resolve(); } });
    });
    child.kill(signal);
    const result = await exited;
    assert.deepEqual(result, { code: 0, signalName: null });
    const stopped = output.split('\n').filter(Boolean).map(line => JSON.parse(line)).at(-1);
    assert.equal(stopped.event, 'stopped');
    assert.equal(stopped.reason, 'interrupted');
    assert.equal(stopped.lastState.status, 'running');
  }
});

// --- Helper against an in-process coordinator --------------------------------------------------------------

const specification = {
  settings: { plannerAgent: 'planner', executorAgent: 'executor', plannerModel: 'anthropic/planner', executorModel: 'anthropic/executor', executorFallbackModel: 'kimi/fallback', maxTasks: 10, minQuotaRemainingPercent: 10, tokenLimitsDisabled: true },
  plannerPrompt: 'PRIVATE-PLANNER-PROMPT', executorPrompt: 'PRIVATE-EXECUTOR-PROMPT', agents: {},
  opencode: { baseUrl: 'http://127.0.0.1:9999', passwordEnvironmentVariable: 'SYNTHETIC_PASSWORD' },
};

async function coordinatorFixture(t) {
  const root = await temporaryRoot(t);
  const recorder = await installBinary(root);
  const configFile = path.join(root, 'coordinator.toml');
  await fs.writeFile(configFile, '[coordinator]\nstateDirectory = "state"\nglobalConcurrency = 2\nprojectConcurrency = 2\n');
  const configuration = await loadCoordinatorConfiguration(configFile);
  let executorCalls = 0;
  const executor = {
    async launch() { executorCalls++; throw new Error('A read must not launch work'); },
    async inspect() { executorCalls++; throw new Error('A read must not inspect work'); },
  };
  const service = await startCoordinatorService({ configuration, executor, pollIntervalMs: 60000 });
  service.scheduler.pauseAdmission();
  t.after(() => service.close());
  const env = isolatedEnvironment(root, { HEIMDALL_BIN: recorder.binary, HEIMDALL_TEST_LOG: recorder.log, HEIMDALL_TEST_CLI: distCli });
  const repository = await makeRepository(env, root, 'repository');
  const linked = path.join(root, 'linked worktree');
  await gitIn(env, repository, 'worktree', 'add', '-q', '-b', 'linked-branch', linked, 'HEAD~1');
  await fs.writeFile(path.join(repository, '.heimdall.toml'), '[workflow]\n');
  const project = service.store.registerProject({ directory: repository, commonGitDirectory: await fs.realpath(path.join(repository, '.git')), configPath: path.join(repository, '.heimdall.toml'), concurrency: 2 });
  const enqueue = (id, feature = `# Fixture ${id}\n\nFEATURE-SECRET-BODY`) => service.store.enqueue({
    id, projectId: project.id, feature, baseCommit: 'a'.repeat(40), worktreePath: path.join(root, 'worktrees', id, 'checkout'), branch: `heimdall/run/${id}`, specification,
  });
  const savePaused = id => {
    enqueue(id);
    let run = service.store.admitNext();
    assert.equal(run.id, id);
    const caller = { sessionID: run.parentSessionId, id: `call-${id}`, messageID: `message-${id}`, agent: 'adr-orchestrator' };
    const saved = {
      id, status: 'running', adr: 'feature.md', parent: run.parentSessionId, caller, branch: run.branch, baseline: '', index: 1,
      tasks: [{ id: 'T1', title: 'First task', brief: 'BRIEF-SECRET', dependsOn: [], dod: [] }, { id: 'T2', title: 'Second task', brief: 'BRIEF-SECRET', dependsOn: ['T1'], dod: [] }],
      results: [{ taskId: 'T1', status: 'completed', summary: 'CHECKPOINT-SECRET', handoff: 'next', evidence: [], model: 'anthropic/executor', sessionId: `child-${id}` }],
      phase: 'executor', child: null, settings: specification.settings, reason: 'Needs an owner decision', resolution: 'RESOLUTION-SECRET',
    };
    service.store.bindStart(id, run.ownerToken, caller);
    service.store.saveCheckpoint(id, run.ownerToken, saved);
    run = service.store.transition(id, run.ownerToken, run.version, 'running');
    return service.store.transition(id, run.ownerToken, run.version, 'paused', 'Needs an owner decision', true);
  };
  const databasePath = path.join(configuration.stateDirectory, 'coordinator.sqlite');
  const sql = (statement, ...values) => {
    const database = new DatabaseSync(databasePath);
    try { return statement.trimStart().toUpperCase().startsWith('SELECT') ? database.prepare(statement).all(...values) : database.prepare(statement).run(...values); }
    finally { database.close(); }
  };
  // A paused, released run with a pending typed approval request, as the coordinator stores one after an executor submission.
  const saveApproval = (id, content = {}) => {
    let run = service.store.admitNext() ?? (enqueue(id), service.store.admitNext());
    assert.equal(run.id, id);
    const caller = { sessionID: run.parentSessionId, id: `call-${id}`, messageID: `message-${id}`, agent: 'adr-orchestrator' };
    const attempt = { id: `attempt_${id}_1`, phase: 'executor', index: 1, child: 'ses_child', status: 'rejected', startedAt: 1, model: 'anthropic/x' };
    const saved = {
      id, status: 'paused', adr: 'feature.md', parent: run.parentSessionId, caller, branch: run.branch, baseline: '', index: 1,
      tasks: [{ id: 'T1', title: 'First task', brief: 'BRIEF-SECRET', dependsOn: [], dod: [] }, { id: 'T2', title: 'Second task', brief: 'BRIEF-SECRET', dependsOn: ['T1'], dod: ['gate'] }],
      results: [{ taskId: 'T1', status: 'completed', summary: 'CHECKPOINT-SECRET', handoff: 'next', evidence: [], model: 'anthropic/executor', sessionId: `child-${id}` }],
      phase: 'executor', child: 'ses_child', settings: specification.settings, attempt, reason: 'Approval required for T2', resolution: 'RESOLUTION-SECRET',
      wait: { kind: 'approval', attemptId: attempt.id, index: 1, taskId: 'T2' }, protocol: 'structured-v1',
    };
    service.store.bindStart(id, run.ownerToken, caller);
    // The request is published before the runner records its pause on it.
    const request = { question: 'Ship the migration?', scope: 'Only the reviewed commit', completedWork: 'Migration written', verification: ['unit tests pass'], artifacts: ['src/migrate.ts'], onApprove: ['merge the migration'], onRequestChanges: ['fix and ask again'], ...content };
    const requestId = `apr_${id}_1`;
    sql(`INSERT INTO approval_requests(run_id, request_id, phase, task_index, task_id, attempt_id, receipt_digest, request_json, revision_json, state, continuation, created_at)
      VALUES (?, ?, 'executor', 1, 'T2', ?, 'digest', ?, ?, 'pending', 'none', 1000)`, id, requestId, attempt.id, JSON.stringify(request), JSON.stringify({ head: 'a'.repeat(40), digest: 'b'.repeat(64) }));
    service.store.saveCheckpoint(id, run.ownerToken, saved);
    run = service.store.transition(id, run.ownerToken, run.version, 'running');
    service.store.transition(id, run.ownerToken, run.version, 'paused', saved.reason, true);
    return { requestId };
  };
  const state = () => ({ runs: service.store.listRuns(), events: service.store.events(), counts: service.store.statusCounts(), approvals: sql('SELECT * FROM approval_requests ORDER BY rowid'), responses: sql('SELECT * FROM run_responses ORDER BY rowid') });
  return { root, env, configFile, repository, linked, project, service, enqueue, savePaused, saveApproval, sql, state, executorCalls: () => executorCalls, ...recorder };
}

test('context against a coordinator resolves the base in the selected linked worktree', async t => {
  const f = await coordinatorFixture(t);
  const mainHead = await gitIn(f.env, f.repository, 'rev-parse', 'HEAD');
  const linkedHead = await gitIn(f.env, f.linked, 'rev-parse', 'HEAD');
  assert.notEqual(mainHead, linkedHead);
  await fs.writeFile(path.join(f.linked, 'untracked.txt'), 'x\n');
  const before = f.state();

  let result = await runHelper(['context', '--cwd', f.linked, '--coordinator-config', f.configFile, '--base', 'HEAD'], f.env);
  assert.equal(result.exitCode, 0, result.stderr);
  const { report } = result;
  assert.equal(report.repository.topLevel, await fs.realpath(f.linked));
  assert.equal(report.repository.branch, 'linked-branch');
  assert.equal(report.repository.commonGitDirectory, await fs.realpath(path.join(f.repository, '.git')));
  assert.equal(report.project.match, 'one');
  assert.equal(report.project.projects[0].id, f.project.id);
  assert.equal(report.base.oid, linkedHead);
  assert.equal(report.base.registeredDirectoryOid, mainHead);
  assert.ok(report.notices.some(notice => /registered project directory/.test(notice)));
  assert.ok(report.notices.some(notice => /untracked/.test(notice)));
  assert.equal(report.coordinator.readiness, 'running');
  assert.equal(report.coordinator.acceptingNewRuns, true);

  result = await runHelper(['context', '--cwd', f.repository, '--coordinator-config', f.configFile, '--base', 'HEAD'], f.env);
  assert.equal(result.report.base.oid, mainHead);
  assert.equal(result.report.base.registeredDirectoryOid, undefined);
  result = await runHelper(['context', '--cwd', f.repository, '--coordinator-config', f.configFile, '--base', '--no-such-revision'], f.env);
  assert.equal(result.report.base.ok, false);
  result = await runHelper(['context', '--cwd', f.repository, '--coordinator-config', f.configFile, '--base', 'main~1'], f.env);
  assert.equal(result.report.base.oid, linkedHead);

  assertReadOnly(await f.calls());
  assert.deepEqual(f.state(), before);
});

test('snapshot and watch read a real coordinator without changing any run, event or reservation', { timeout: 60000 }, async t => {
  const f = await coordinatorFixture(t);
  const paused = f.savePaused('run-paused');
  assert.equal(paused.status, 'paused');
  const queued = f.enqueue('run-queued');
  assert.equal(queued.status, 'queued');
  f.service.store.listRuns();
  const before = f.state();
  const versions = Object.fromEntries(before.runs.map(run => [run.id, run.version]));
  await f.reset();

  const configFlag = ['--coordinator-config', f.configFile];
  let result = await runHelper(['snapshot', 'run-paused', '--cwd', f.linked, ...configFlag], f.env);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.report.run.status, 'paused');
  assert.equal(result.report.run.stateClass, 'paused');
  assert.equal(result.report.run.capacityReserved, false);
  assert.deepEqual(result.report.run.progress, { completed: 1, total: 2 });
  assert.deepEqual(result.report.run.currentTask, { id: 'T2', title: 'Second task' });
  assert.equal(result.report.run.blocker, 'Needs an owner decision');
  assert.equal(result.report.run.branch, 'heimdall/run/run-paused');
  assert.ok(result.report.run.parentSessionId);
  for (const secret of ['FEATURE-SECRET', 'RESOLUTION-SECRET', 'CHECKPOINT-SECRET', 'BRIEF-SECRET', 'PRIVATE-PLANNER-PROMPT', 'PRIVATE-EXECUTOR-PROMPT', 'SYNTHETIC_PASSWORD', 'anthropic/planner']) assert.ok(!result.text.includes(secret), secret);

  result = await runHelper(['snapshot', 'run-queued', '--cwd', f.linked, ...configFlag], f.env);
  assert.equal(result.report.run.stateClass, 'queued');
  assert.equal(result.report.run.currentTask, null);

  result = await runHelper(['snapshot', '--cwd', f.linked, ...configFlag], f.env);
  assert.equal(result.report.outcome, 'needs-run-id', 'a paused run and a queued run are both active');
  assert.equal(result.report.reason, 'multiple-active-runs');
  assert.deepEqual(result.report.candidates.map(entry => entry.id).sort(), ['run-paused', 'run-queued']);

  result = await runHelper(['watch', 'run-paused', '--cwd', f.linked, ...configFlag, '--budget-seconds', '30', '--interval-seconds', '0.1'], f.env);
  let events = result.lines.map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.event), ['watching', 'state', 'stopped']);
  assert.equal(events.at(-1).reason, 'paused');
  assert.equal(events.at(-1).polls, 1);

  result = await runHelper(['watch', 'run-queued', '--cwd', f.linked, ...configFlag, '--budget-seconds', '0.6', '--interval-seconds', '0.1'], f.env);
  events = result.lines.map(line => JSON.parse(line));
  assert.equal(events.filter(event => event.event === 'state').length, 1, 'an unchanged queued run is reported once');
  assert.equal(events.at(-1).reason, 'budget');
  assert.ok(events.at(-1).polls >= 2);

  const calls = await f.calls();
  assertReadOnly(calls);
  assert.ok(calls.some(argv => argv[1] === 'run' && argv[2] === 'list'));
  assert.ok(calls.every(argv => argv.includes('--coordinator-config')), 'every call carries the selected configuration');
  const after = f.state();
  assert.deepEqual(after, before, 'runs, events and counts are unchanged');
  for (const run of after.runs) assert.equal(run.version, versions[run.id], `${run.id} version`);
  assert.equal(f.executorCalls(), 0);
});

test('snapshot and watch of a real pending approval request show it and change nothing', { timeout: 60000 }, async t => {
  const f = await coordinatorFixture(t);
  const { requestId } = f.saveApproval('run-approval', { question: 'Ship the migration? Q-MARKER' });
  const before = f.state();
  assert.equal(before.approvals.length, 1);
  assert.equal(before.approvals[0].state, 'pending');
  await f.reset();
  const configFlag = ['--coordinator-config', f.configFile];

  let result = await runHelper(['snapshot', 'run-approval', '--cwd', f.linked, ...configFlag], f.env);
  assert.equal(result.exitCode, 0, result.stderr);
  const { wait } = result.report.run;
  assert.equal(result.report.run.status, 'paused');
  assert.equal(wait.kind, 'approval');
  assert.equal(wait.requestId, requestId);
  assert.equal(wait.state, 'pending');
  assert.equal(wait.continuation, 'none');
  assert.equal(wait.taskId, 'T2');
  assert.match(wait.question, /Q-MARKER/);
  assert.deepEqual(wait.onRequestChanges, ['fix and ask again']);
  assert.equal(wait.revision.head, 'a'.repeat(12));
  for (const secret of ['FEATURE-SECRET', 'RESOLUTION-SECRET', 'CHECKPOINT-SECRET', 'BRIEF-SECRET', 'PRIVATE-PLANNER-PROMPT', 'SYNTHETIC_PASSWORD']) assert.ok(!result.text.includes(secret), secret);

  result = await runHelper(['watch', 'run-approval', '--cwd', f.linked, ...configFlag, '--budget-seconds', '30', '--interval-seconds', '0.1'], f.env);
  const events = result.lines.map(line => JSON.parse(line));
  assert.deepEqual(events.map(event => event.event), ['watching', 'state', 'stopped']);
  assert.equal(events[1].run.wait.requestId, requestId);
  assert.equal(events.at(-1).reason, 'paused');

  const calls = await f.calls();
  assertReadOnly(calls);
  assert.ok(calls.every(argv => argv.includes('--coordinator-config')));
  const after = f.state();
  assert.deepEqual(after, before, 'runs, events, approval requests and responses are unchanged');
  assert.equal(f.sql('SELECT decision FROM approval_requests WHERE request_id = ?', requestId)[0].decision, null);
  assert.equal(f.executorCalls(), 0);
});

test('request reads a real hidden-tail request in full through the real command line, while the snapshot stays compact, and changes nothing', { timeout: 60000 }, async t => {
  const f = await coordinatorFixture(t);
  const content = hiddenTailRequest();
  const { requestId } = f.saveApproval('run-hidden', content);
  const before = f.state();
  await f.reset();
  const configFlag = ['--coordinator-config', f.configFile];

  const snapshot = await runHelper(['snapshot', 'run-hidden', '--cwd', f.linked, ...configFlag], f.env);
  assert.equal(snapshot.exitCode, 0, snapshot.stderr);
  const { wait } = snapshot.report.run;
  assert.equal(wait.shortened, true);
  assert.ok(wait.clippedFields.includes('scope'));
  assert.ok(!snapshot.text.includes('ACTION-AFTER-1500'), 'the compact wait hides the late action');
  assert.equal(wait.completeRequest.command, `request run-hidden --request ${requestId}`);

  const result = await runHelper(['request', 'run-hidden', '--request', requestId, '--cwd', f.linked, ...configFlag], f.env);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.report.complete, true);
  const { request } = result.report;
  for (const field of ['question', 'scope', 'completedWork', 'verification', 'artifacts', 'onApprove', 'onRequestChanges']) assert.deepEqual(request[field], content[field], field);
  assert.ok(request.scope.includes('ACTION-AFTER-1500') && request.verification[12].includes('EVIDENCE-ENTRY-12') && request.onApprove[13].includes('PROPOSED-ACTION-13'));
  assert.equal(request.revision.head, 'a'.repeat(40));
  for (const secret of ['FEATURE-SECRET', 'RESOLUTION-SECRET', 'CHECKPOINT-SECRET', 'BRIEF-SECRET', 'PRIVATE-PLANNER-PROMPT', 'SYNTHETIC_PASSWORD']) assert.ok(!result.text.includes(secret), secret);

  const missing = await runHelper(['request', 'run-hidden', '--request', 'apr_unknown', '--cwd', f.linked, ...configFlag], f.env);
  assert.equal(missing.exitCode, 1);
  assert.equal(missing.report.complete, false);
  assert.match(missing.report.error.message, /no approval request/);

  const calls = await f.calls();
  assertReadOnly(calls);
  assert.ok(calls.some(argv => argv.includes('approval')));
  assert.deepEqual(f.state(), before, 'runs, events, approval requests and responses are unchanged');
  assert.equal(f.executorCalls(), 0);
});

test('a managed run branch in a real checkout selects its run through the real command line', async t => {
  const f = await coordinatorFixture(t);
  f.enqueue('run-branch');
  await gitIn(f.env, f.repository, 'checkout', '-q', '-b', 'heimdall/run/run-branch');
  const before = f.state();
  const result = await runHelper(['snapshot', '--cwd', f.repository, '--coordinator-config', f.configFile], f.env);
  assert.equal(result.report.selection.via, 'managed-branch');
  assert.equal(result.report.run.runId, 'run-branch');
  assert.deepEqual(f.state(), before);

  const sole = await coordinatorFixture(t);
  sole.enqueue('only-active');
  const found = await runHelper(['snapshot', '--cwd', sole.linked, '--coordinator-config', sole.configFile], sole.env);
  assert.equal(found.report.selection.via, 'sole-active-run');
  assert.equal(found.report.selection.runListCompleteness, 'unverified');
  assert.equal(found.report.run.runId, 'only-active');
});

test('an oversized run list asks for an explicit run ID instead of failing or guessing', { timeout: 60000 }, async t => {
  const f = await coordinatorFixture(t);
  for (let index = 0; index < 20; index++) f.enqueue(`big-${index}`, `# Big ${index}\n\n${'feature-body-'.repeat(9000)}`);
  await assert.rejects(exec(f.env.HEIMDALL_BIN, ['coordinator', 'run', 'list', '--coordinator-config', f.configFile], { env: f.env }), error => /response is too large/.test(error.stderr), 'the fixture reproduces the oversized list');
  const before = f.state();
  await f.reset();
  const result = await runHelper(['snapshot', '--cwd', f.linked, '--coordinator-config', f.configFile], f.env);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.report.outcome, 'needs-run-id');
  assert.equal(result.report.reason, 'run-list-too-large');
  const explicit = await runHelper(['snapshot', 'big-3', '--cwd', f.linked, '--coordinator-config', f.configFile], f.env);
  assert.equal(explicit.report.run.runId, 'big-3');
  assert.ok(!explicit.text.includes('feature-body-'));
  assertReadOnly(await f.calls());
  assert.deepEqual(f.state(), before);
});
