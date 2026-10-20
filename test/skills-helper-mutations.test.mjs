import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { startCoordinatorService } from '../dist/coordinator/service.js';
import { loadCoordinatorConfiguration } from '../dist/coordinator/config.js';
import {
  MAX_GUIDANCE_BYTES, MAX_SPEC_BYTES, RESPONSE_INPUT_LIMIT, UsageError, classifyMutationFailure, classifyRespondFailure, main, parseArguments, runIdCandidates,
} from '../skills/openheimdall-start/scripts/openheimdall.mjs';

const exec = promisify(execFile);
const checkout = fileURLToPath(new URL('..', import.meta.url));
const skillDirectories = ['openheimdall-start', 'openheimdall-monitor', 'openheimdall-resume'].map(name => path.join(checkout, 'skills', name));
const helperPath = directory => path.join(directory, 'scripts', 'openheimdall.mjs');
const helperFile = helperPath(skillDirectories[0]);
const distCli = path.join(checkout, 'dist', 'cli.js');

const READ_ONLY = /^(status --json|project list|run list|run show [A-Za-z0-9_-]+)$/;
const MUTATING = [['project', 'add'], ['run', 'submit'], ['run', 'resume'], ['run', 'respond'], ['run', 'reconcile'], ['start'], ['stop']];

// --- Fixtures ----------------------------------------------------------------------------------------------

async function temporaryRoot(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hm-')));
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

// One recording binary for both kinds of test. With FAKE_HEIMDALL_DIR it answers from scenario.json (a key ending in
// `*` matches any command with that prefix); otherwise it forwards to the built command line, so the same argv log
// covers a real in-process coordinator.
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
  const name = Object.hasOwn(scenario, key) ? key : Object.keys(scenario).find(candidate => candidate.endsWith('*') && key.startsWith(candidate.slice(0, -1)));
  if (name === undefined) { process.stderr.write('Heimdall: Unscripted fake route ' + key + '\\n'); process.exit(1); }
  let entry = scenario[name];
  if (Array.isArray(entry)) {
    const counters = path.join(directory, 'counters.json');
    const seen = fs.existsSync(counters) ? JSON.parse(fs.readFileSync(counters, 'utf8')) : {};
    const index = Math.min(seen[name] ?? 0, entry.length - 1);
    seen[name] = (seen[name] ?? 0) + 1;
    fs.writeFileSync(counters, JSON.stringify(seen));
    entry = entry[index];
  }
  if (entry.stderr !== undefined) { process.stderr.write(entry.stderr); process.exit(entry.code ?? 1); }
  process.stdout.write(entry.stdout ?? JSON.stringify(entry.json, null, 2) + '\\n');
  if (entry.code) process.exitCode = entry.code;
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
    worktreePath: '/synthetic/worktrees/run-1/checkout', branch: 'heimdall/run/run-1', status: 'paused', capacityReserved: false,
    version: 3, parentSessionId: 'ses_parent', launchAction: 'start', resolution: 'RESOLUTION-SECRET', reason: 'Needs an owner decision',
    checkpoint: {
      phase: 'executor', index: 1, status: 'running', adr: 'feature.md',
      tasks: [{ id: 'T1', title: 'First task', brief: 'BRIEF-SECRET', dependsOn: [], dod: [] }, { id: 'T2', title: 'Second task', brief: 'BRIEF-SECRET', dependsOn: ['T1'], dod: [] }],
      results: [{ taskId: 'T1', status: 'completed', summary: 'CHECKPOINT-SECRET', handoff: '', evidence: [] }],
    },
    createdAt: 1700000000000, updatedAt: 1700000100000, settings: { plannerModel: 'SETTINGS-SECRET' },
    ...overrides,
  };
}

const RUNNING = { json: { schemaVersion: 1, service: 'heimdall-coordinator', status: 'running', acceptingNewRuns: true, queuedRuns: 0, reservedRuns: 0 } };
const DRAINING = { json: { schemaVersion: 1, service: 'heimdall-coordinator', status: 'draining', acceptingNewRuns: false, queuedRuns: 1, reservedRuns: 1 } };
const UNAVAILABLE = { stderr: 'Heimdall: Coordinator status request to /x/coordinator.sock failed: Coordinator unavailable: connect ENOENT /x/coordinator.sock\n' };
const SECRETS = ['FEATURE-SECRET', 'RESOLUTION-SECRET', 'CHECKPOINT-SECRET', 'BRIEF-SECRET', 'SETTINGS-SECRET'];

async function runHelper(argv, env, extra = {}) {
  const out = [];
  const err = [];
  const exitCode = await main(argv, { env, stdout: { write: text => out.push(text) }, stderr: { write: text => err.push(text) }, ...extra });
  const text = out.join('');
  return { exitCode, text, stderr: err.join(''), report: text.trim().startsWith('{') ? JSON.parse(text) : undefined };
}

/** The coordinator subcommand of a recorded call without the forwarded configuration. */
function subcommand(argv) {
  assert.equal(argv[0], 'coordinator');
  const stripped = [];
  for (let index = 1; index < argv.length; index++) {
    if (argv[index] === '--coordinator-config') { index++; continue; }
    stripped.push(argv[index]);
  }
  return stripped;
}

const verbOf = argv => {
  const words = subcommand(argv);
  return MUTATING.find(verb => verb.every((word, index) => words[index] === word))?.join(' ');
};
const mutations = calls => calls.map(verbOf).filter(Boolean);
const countOf = (calls, verb) => mutations(calls).filter(entry => entry === verb).length;

/** Every call is a read, and none is a mutation. */
function assertNoMutation(calls) {
  assert.deepEqual(mutations(calls), []);
  for (const argv of calls) assert.match(subcommand(argv).join(' '), READ_ONLY, JSON.stringify(argv));
}

/** After the one allowed mutation at `index`, only reads follow. */
function assertReadsAfter(calls, verb) {
  const index = calls.findIndex(argv => verbOf(argv) === verb);
  assert.ok(index >= 0);
  assert.equal(countOf(calls, verb), 1);
  assert.deepEqual(mutations(calls.slice(index + 1)), []);
  for (const argv of calls.slice(index + 1)) assert.match(subcommand(argv).join(' '), READ_ONLY, JSON.stringify(argv));
}

// --- Artifact and parser -----------------------------------------------------------------------------------

test('the three helper copies stay byte-identical and dependency-free', async () => {
  const contents = [];
  for (const directory of skillDirectories) {
    assert.equal((await fs.lstat(helperPath(directory))).isSymbolicLink(), false);
    contents.push(await fs.readFile(helperPath(directory)));
  }
  assert.ok(contents[0].equals(contents[1]) && contents[0].equals(contents[2]), 'copies differ');
  const source = contents[0].toString('utf8');
  const specifiers = [...source.matchAll(/(?:^|\n)\s*import\s+(?:[^'"\n]*?from\s+)?['"]([^'"]+)['"]/g), ...source.matchAll(/import\(\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
  assert.ok(specifiers.length >= 5);
  for (const specifier of specifiers) assert.match(specifier, /^node:/, specifier);
  assert.doesNotMatch(source, /require\(/);
});

test('start, resume and inspect-spec arguments: flags take no value, guidance sources are exclusive, values stay data', () => {
  assert.deepEqual(parseArguments(['start', '--spec', '--odd file', '--register', '--start-coordinator', '--base', '-x']).options, { '--spec': '--odd file', '--register': true, '--start-coordinator': true, '--base': '-x' });
  assert.deepEqual(parseArguments(['resume', 'run-1', '--guidance-stdin']).options, { '--guidance-stdin': true });
  assert.deepEqual(parseArguments(['resume', 'run-1', '--guidance-file', '--also']).options, { '--guidance-file': '--also' });
  assert.deepEqual(parseArguments(['inspect-spec', 'spec.md']).positional, ['spec.md']);
  for (const bad of [['start', '--register=yes'], ['start', '--spec'], ['start', '--register', '--register'], ['start', 'extra'], ['start', '--guidance-file', 'x'], ['resume', 'a', 'b'], ['resume', 'a', '--spec', 'x'], ['inspect-spec', 'a', 'b'], ['snapshot', '--register'], ['context', '--start-coordinator']]) {
    assert.throws(() => parseArguments(bad), UsageError, JSON.stringify(bad));
  }
});

test('usage mistakes exit 2 before any coordinator call', async t => {
  const f = await fakeFixture(t);
  const cases = [
    ['start', '--cwd', f.root],
    ['resume', '--cwd', f.root, '--guidance-stdin'],
    ['resume', 'run-1', '--cwd', f.root],
    ['resume', 'run-1', '--cwd', f.root, '--guidance-stdin', '--guidance-file', 'x'],
    ['resume', '-bad', '--cwd', f.root, '--guidance-stdin'],
    ['resume', 'bad id', '--cwd', f.root, '--guidance-stdin'],
    ['inspect-spec', '--cwd', f.root],
  ];
  for (const argv of cases) {
    const result = await runHelper(argv, f.env, { stdin: Readable.from([Buffer.from('text')]) });
    assert.equal(result.exitCode, 2, JSON.stringify(argv));
  }
  assert.deepEqual(await f.calls(), []);
});

test('failure classification trusts only the diagnostic and never guesses a refusal', () => {
  const failed = (stderr, extra = {}) => ({ ok: false, kind: 'error', stdout: '', stderr, message: `Command failed: heimdall --input ${stderr}`, ...extra });
  assert.equal(classifyMutationFailure(failed('Heimdall: Coordinator unavailable: connect ENOENT /x/coordinator.sock\n')), 'not-sent');
  assert.equal(classifyMutationFailure(failed('Heimdall: Coordinator unavailable: connect ECONNREFUSED /x\n')), 'not-sent');
  assert.equal(classifyMutationFailure({ ok: false, kind: 'not-installed', stdout: '', stderr: '', message: 'spawn heimdall ENOENT' }), 'not-sent');
  assert.equal(classifyMutationFailure(failed('Heimdall: Project not found\n')), 'rejected');
  assert.equal(classifyMutationFailure(failed('Heimdall: Only a confirmed idle paused run may be resumed\n')), 'rejected');
  for (const stderr of ['Heimdall: Coordinator unavailable: read ECONNRESET\n', 'Heimdall: Coordinator unavailable: socket hang up\n', 'Heimdall: Coordinator unavailable: Coordinator request timed out\n', 'Heimdall: Invalid coordinator JSON response\n', 'Heimdall: Coordinator response is too large\n', 'Heimdall: Something new went wrong\n', '']) {
    assert.equal(classifyMutationFailure(failed(stderr)), 'uncertain', stderr);
  }
  for (const kind of ['timeout', 'aborted', 'response-too-large']) assert.equal(classifyMutationFailure({ ok: false, kind, stdout: '', stderr: '', message: '' }), 'uncertain');
  // The process error message repeats the command line, so guidance that quotes a diagnostic must not change the verdict.
  assert.equal(classifyMutationFailure(failed('Heimdall: Coordinator unavailable: read ECONNRESET\n', { message: 'Command failed: heimdall --input Coordinator unavailable: connect ENOENT Project not found' })), 'uncertain');
});

test('run ID candidates are UUIDs and managed branch names', () => {
  const id = randomUUID();
  assert.deepEqual(runIdCandidates(`see ${id.toUpperCase()} and heimdall/run/abc_1-x and ${id}`), [id, 'abc_1-x']);
  assert.deepEqual(runIdCandidates('nothing here'), []);
});

// --- inspect-spec ------------------------------------------------------------------------------------------

test('inspect-spec reports size, heading and heuristic flags, and refuses unusable files without a command', async t => {
  const f = await fakeFixture(t);
  const write = async (name, content) => { const file = path.join(f.root, name); await fs.writeFile(file, content); return file; };
  const feature = await write('feature spec.md', '# Add a login page\n\nBuild a login form with validation.\n');
  let result = await runHelper(['inspect-spec', 'feature spec.md', '--cwd', f.root], f.env);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.report.usable, true);
  assert.equal(result.report.file, feature);
  assert.equal(result.report.bytes, Buffer.byteLength('# Add a login page\n\nBuild a login form with validation.\n'));
  assert.equal(result.report.firstHeading, 'Add a login page');
  assert.equal(result.report.mentionsExistingRun, false);
  assert.equal(result.report.looksLikeResumeGuidance, false);
  assert.equal(result.report.runLookup, 'none');
  assert.deepEqual(result.report.mutations, []);
  assert.deepEqual(await f.calls(), [], 'a text without run IDs needs no coordinator call');
  assert.ok(!result.text.includes('Build a login form'), 'the text itself is not echoed');

  await write('empty.md', '');
  await write('blank.md', ' \n\t\n');
  await write('big.md', 'x'.repeat(MAX_SPEC_BYTES + 1));
  await fs.mkdir(path.join(f.root, 'a directory'));
  for (const [name, problem] of [['empty.md', 'empty'], ['blank.md', 'empty'], ['big.md', 'too-large']]) {
    result = await runHelper(['inspect-spec', name, '--cwd', f.root], f.env);
    assert.equal(result.exitCode, 0);
    assert.equal(result.report.usable, false);
    assert.equal(result.report.problem, problem, name);
  }
  assert.equal((await runHelper(['inspect-spec', 'big.md', '--cwd', f.root], f.env)).report.bytes, MAX_SPEC_BYTES + 1);
  for (const name of ['missing.md', 'a directory']) {
    result = await runHelper(['inspect-spec', name, '--cwd', f.root], f.env);
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.ok, false);
    assert.match(result.report.reason, /^spec-(unreadable|not-a-file)$/);
  }
  assert.deepEqual(await f.calls(), []);
});

// --- start against a scripted command line -----------------------------------------------------------------

async function startScenario(t, { extra = {}, registered = true } = {}) {
  const f = await fakeFixture(t);
  const repository = await makeRepository(f.env, f.root, 'repo with space');
  const oid = await gitIn(f.env, repository, 'rev-parse', 'HEAD');
  const spec = path.join(repository, 'spec file.md');
  await fs.writeFile(spec, '# Fixture feature\n\nBuild it.\n');
  await gitIn(f.env, repository, 'add', 'spec file.md');
  await gitIn(f.env, repository, 'commit', '-q', '-m', 'spec');
  const head = await gitIn(f.env, repository, 'rev-parse', 'HEAD');
  const queued = runRecord({ id: 'run-new', status: 'queued', capacityReserved: false, baseCommit: head, checkpoint: null, version: 0, reason: null, launchAction: 'start', branch: 'heimdall/run/run-new', worktreePath: '/synthetic/worktrees/run-new/checkout' });
  const project = await projectRecord(repository);
  const scenario = {
    'status --json': RUNNING,
    'project list': { json: registered ? [project] : [] },
    'run submit project-1 *': { json: queued },
    ...extra,
  };
  await f.script(scenario);
  await f.reset();
  const start = (...args) => runHelper(['start', '--cwd', repository, '--spec', 'spec file.md', ...args], f.env);
  return { ...f, repository, oid, head, spec, queued, project, scenario, start };
}

test('start submits exactly once with the intended project and the full base commit', async t => {
  const f = await startScenario(t);
  await fs.writeFile(path.join(f.repository, 'scratch.txt'), 'untracked\n');
  const result = await f.start('--coordinator-config', 'coordinator config.toml');
  assert.equal(result.exitCode, 0, result.stderr);
  const { report } = result;
  assert.equal(report.outcome, 'submitted');
  assert.equal(report.accepted, true);
  assert.equal(report.status, 'queued');
  assert.equal(report.runId, 'run-new');
  assert.equal(report.project.id, 'project-1');
  assert.equal(report.base.oid, f.head);
  assert.match(report.base.oid, /^[0-9a-f]{40}$/);
  assert.equal(report.worktreePath, '/synthetic/worktrees/run-new/checkout');
  assert.equal(report.branch, 'heimdall/run/run-new');
  assert.equal(report.run.stateClass, 'queued');
  assert.match(report.note, /not admitted or started/);
  assert.ok(report.notices.some(notice => /untracked/.test(notice)), 'a dirty tree is called out');
  assert.deepEqual(report.mutationsAttempted, ['run submit']);
  for (const secret of SECRETS) assert.ok(!result.text.includes(secret), secret);

  const calls = await f.calls();
  assert.equal(countOf(calls, 'run submit'), 1);
  assert.deepEqual(mutations(calls), ['run submit']);
  const submit = calls.find(argv => verbOf(argv) === 'run submit');
  assert.deepEqual(submit, ['coordinator', 'run', 'submit', 'project-1', '--feature', f.spec, '--base', f.head, '--coordinator-config', path.join(f.repository, 'coordinator config.toml')]);
  assert.ok(path.isAbsolute(submit[5]) && /^[0-9a-f]{40}$/.test(submit[7]));
  assert.deepEqual(calls.at(-1), submit, 'the submit is the last call');
});

test('start refuses an unusable specification, base or directory before any coordinator call', async t => {
  const f = await startScenario(t);
  const write = (name, content) => fs.writeFile(path.join(f.repository, name), content);
  await write('empty.md', '');
  await write('blank.md', '  \n');
  await write('big.md', 'y'.repeat(MAX_SPEC_BYTES + 1));
  await write('bad utf8.md', Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]));
  await fs.mkdir(path.join(f.repository, 'dir.md'));
  const cases = [
    [['--spec', 'empty.md'], 'spec-empty'], [['--spec', 'blank.md'], 'spec-empty'], [['--spec', 'big.md'], 'spec-too-large'],
    [['--spec', 'bad utf8.md'], 'spec-not-utf8'], [['--spec', 'missing.md'], 'spec-unreadable'], [['--spec', 'dir.md'], 'spec-not-a-file'],
    [['--spec', 'spec file.md', '--base', 'no-such-revision'], 'base-unresolved'],
  ];
  for (const [args, reason] of cases) {
    const result = await runHelper(['start', '--cwd', f.repository, ...args], f.env);
    assert.equal(result.exitCode, 1, reason);
    assert.equal(result.report.outcome, 'refused');
    assert.equal(result.report.reason, reason);
    assert.deepEqual(result.report.mutationsAttempted, []);
  }
  const outside = path.join(f.root, 'plain');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'spec.md'), '# Spec\n');
  const result = await runHelper(['start', '--cwd', outside, '--spec', 'spec.md'], f.env);
  assert.equal(result.report.reason, 'not-a-repository');
  assert.deepEqual(await f.calls(), [], 'no coordinator call of any kind');
});

test('start refuses a draining coordinator and an unavailable one without --start-coordinator', async t => {
  const f = await startScenario(t, { extra: { 'status --json': DRAINING } });
  let result = await f.start();
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.outcome, 'coordinator-draining');
  assert.equal(result.report.readiness, 'draining');
  assert.equal(result.report.acceptingNewRuns, false);
  assertNoMutation(await f.calls());

  await f.script({ ...f.scenario, 'status --json': UNAVAILABLE });
  await f.reset();
  result = await f.start();
  assert.equal(result.report.outcome, 'coordinator-unavailable');
  assert.equal(result.report.canStartCoordinator, true);
  assert.equal(result.report.error.kind, 'unavailable');
  assert.deepEqual((await f.calls()).map(subcommand), [['status', '--json']], 'only the status read');

  // A status failure that is not "unavailable" is never answered by starting a coordinator.
  await f.script({ ...f.scenario, 'status --json': { stderr: 'Heimdall: The coordinator at /x is starting or stopping; try again shortly.\n' }, 'start --json': { json: { outcome: 'ready', ok: true } } });
  await f.reset();
  result = await f.start('--start-coordinator');
  assert.equal(result.report.outcome, 'coordinator-unavailable');
  assert.deepEqual(mutations(await f.calls()), []);
});

test('--start-coordinator starts once, accepts only documented success outcomes and never retries', async t => {
  const f = await startScenario(t);
  const lifecycle = (outcome, ok, extra = {}) => ({ json: { schemaVersion: 1, command: 'start', ok, outcome, message: `Message for ${outcome}`, target: null, instance: null, error: ok ? null : { code: 'synthetic', message: `Refused: ${outcome}` }, logs: null, ...extra }, code: ok ? 0 : 1 });

  for (const outcome of ['ready', 'already-running', 'already-running-foreground']) {
    await f.script({ ...f.scenario, 'status --json': [UNAVAILABLE, RUNNING], 'start --json': lifecycle(outcome, true) });
    await f.reset();
    const result = await f.start('--start-coordinator');
    assert.equal(result.report.outcome, 'submitted', outcome);
    assert.deepEqual(result.report.mutationsAttempted, ['coordinator start', 'run submit']);
    const calls = await f.calls();
    assert.deepEqual(calls.map(subcommand).map(words => words.slice(0, 2).join(' ')), ['status --json', 'start --json', 'status --json', 'project list', 'run submit']);
    assert.deepEqual(mutations(calls), ['start', 'run submit']);
  }

  for (const outcome of ['busy', 'conflict', 'shutdown-in-progress', 'startup-not-confirmed', 'failed', 'surprising-new-outcome']) {
    await f.script({ ...f.scenario, 'status --json': [UNAVAILABLE, RUNNING], 'start --json': lifecycle(outcome, false) });
    await f.reset();
    const result = await f.start('--start-coordinator');
    assert.equal(result.exitCode, 1, outcome);
    assert.equal(result.report.outcome, 'coordinator-start-failed');
    assert.equal(result.report.coordinatorStart.outcome, outcome);
    assert.equal(result.report.coordinatorStart.errorCode, 'synthetic');
    const calls = await f.calls();
    assert.deepEqual(mutations(calls), ['start'], `${outcome}: one start, no retry, no submit`);
    assert.ok(!calls.some(argv => ['stop', 'logs', 'serve'].includes(subcommand(argv)[0])), 'never stop or restart');
  }

  // A success flag with an outcome that is not documented as success, and unreadable output, are failures.
  for (const entry of [lifecycle('mystery', true), { stdout: 'not json\n' }, { stderr: 'Heimdall: spawn failure\n' }]) {
    await f.script({ ...f.scenario, 'status --json': [UNAVAILABLE, RUNNING], 'start --json': entry });
    await f.reset();
    const result = await f.start('--start-coordinator');
    assert.equal(result.report.outcome, 'coordinator-start-failed');
    assert.deepEqual(mutations(await f.calls()), ['start']);
  }

  // A coordinator that reports ready but is still not reachable is not submitted to.
  await f.script({ ...f.scenario, 'status --json': [UNAVAILABLE, UNAVAILABLE], 'start --json': lifecycle('ready', true) });
  await f.reset();
  let result = await f.start('--start-coordinator');
  assert.equal(result.report.outcome, 'coordinator-unavailable');
  assert.deepEqual(mutations(await f.calls()), ['start']);

  // A coordinator that is already ready is not started.
  await f.script(f.scenario);
  await f.reset();
  result = await f.start('--start-coordinator');
  assert.equal(result.report.outcome, 'submitted');
  assert.deepEqual(mutations(await f.calls()), ['run submit']);
});

test('start reuses a matching project, asks when several match and registers only when told to', async t => {
  const f = await startScenario(t);
  let result = await f.start('--register');
  assert.equal(result.report.outcome, 'submitted');
  assert.equal(countOf(await f.calls(), 'project add'), 0, 'a registered project is reused, not added again');

  await f.script({ ...f.scenario, 'project list': { json: [f.project, { ...f.project, id: 'project-2' }] } });
  await f.reset();
  result = await f.start('--register');
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.outcome, 'needs-project');
  assert.deepEqual(result.report.projects.map(project => project.id), ['project-1', 'project-2']);
  assertNoMutation(await f.calls());

  await f.script({ ...f.scenario, 'project list': { json: [] } });
  await f.reset();
  result = await f.start();
  assert.equal(result.report.outcome, 'needs-registration');
  assert.equal(result.report.directory, f.repository);
  assertNoMutation(await f.calls());

  await f.script({ ...f.scenario, 'project list': { json: [] }, 'project add *': { json: f.project } });
  await f.reset();
  result = await f.start('--register');
  assert.equal(result.report.outcome, 'submitted');
  assert.deepEqual(result.report.mutationsAttempted, ['project add', 'run submit']);
  const calls = await f.calls();
  assert.deepEqual(calls.find(argv => verbOf(argv) === 'project add'), ['coordinator', 'project', 'add', f.repository], 'the absolute top-level only: no --limit and no --project-config');
  assert.deepEqual(mutations(calls), ['project add', 'run submit']);
});

test('a registration conflict or lost registration is reported and never replaced, retried or followed by a submit', async t => {
  const f = await startScenario(t, { registered: false });
  const conflict = 'Project already registered with different paths, configuration, or concurrency';
  await f.script({ ...f.scenario, 'project add *': { stderr: `Heimdall: ${conflict}\n` } });
  await f.reset();
  let result = await f.start('--register');
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.outcome, 'registration-rejected');
  assert.equal(result.report.message, conflict);
  assert.deepEqual(mutations(await f.calls()), ['project add']);

  await f.script({ ...f.scenario, 'project add *': { stderr: 'Heimdall: Coordinator unavailable: connect ECONNREFUSED /x\n' } });
  await f.reset();
  result = await f.start('--register');
  assert.equal(result.report.outcome, 'registration-not-sent');
  assert.deepEqual(mutations(await f.calls()), ['project add']);

  await f.script({ ...f.scenario, 'project add *': { stderr: 'Heimdall: Coordinator unavailable: read ECONNRESET\n' } });
  await f.reset();
  result = await f.start('--register');
  assert.equal(result.report.outcome, 'registration-uncertain');
  assert.equal(result.report.inspection.confirmed, false);
  assertReadsAfter(await f.calls(), 'project add');
});

test('a lost submit response is uncertain: one submit, read-only inspection, candidates unconfirmed, no retry', async t => {
  const f = await startScenario(t);
  const later = Date.now() + 120000;
  const list = [
    { ...f.queued, id: 'old-run', createdAt: 1, baseCommit: f.head },
    { ...f.queued, id: 'maybe-ours', createdAt: later, feature: '# Fixture feature\n\nBuild it.\n' },
    { ...f.queued, id: 'someone-else', createdAt: later, baseCommit: 'b'.repeat(40), feature: 'another' },
    { ...f.queued, id: 'other-project', projectId: 'project-9', createdAt: later },
  ];
  for (const stderr of ['Heimdall: Coordinator unavailable: read ECONNRESET\n', 'Heimdall: Coordinator unavailable: Coordinator request timed out\n', 'Heimdall: Invalid coordinator JSON response\n', 'Heimdall: Coordinator response is too large\n', 'Heimdall: A message nobody has seen\n']) {
    await f.script({ ...f.scenario, 'run submit project-1 *': { stderr }, 'run list': { json: list } });
    await f.reset();
    const result = await f.start();
    assert.equal(result.exitCode, 1, stderr);
    assert.equal(result.report.outcome, 'uncertain', stderr);
    assert.equal(result.report.accepted, undefined);
    assert.match(result.report.rule, /Do not repeat it/);
    assert.equal(result.report.inspection.confirmed, false);
    assert.deepEqual(result.report.inspection.candidates.map(candidate => candidate.runId), ['maybe-ours', 'someone-else']);
    assert.deepEqual(result.report.inspection.candidates.map(candidate => candidate.specMatches), [true, false]);
    assert.deepEqual(result.report.inspection.candidates.map(candidate => candidate.baseMatches), [true, false]);
    assert.equal(result.report.runId, undefined, 'no run ID is claimed');
    for (const secret of SECRETS) assert.ok(!result.text.includes(secret), secret);
    const calls = await f.calls();
    assertReadsAfter(calls, 'run submit');
    assert.deepEqual(calls.map(argv => subcommand(argv).slice(0, 2).join(' ')).slice(-2), ['run submit', 'run list']);
  }

  // An inspection that cannot be read is said so; it still is not a retry.
  await f.script({ ...f.scenario, 'run submit project-1 *': { stderr: 'Heimdall: Coordinator unavailable: read ECONNRESET\n' }, 'run list': { stderr: 'Heimdall: Coordinator response is too large\n' } });
  await f.reset();
  let result = await f.start();
  assert.equal(result.report.outcome, 'uncertain');
  assert.equal(result.report.inspection.available, false);
  assert.equal(result.report.inspection.reason, 'response-too-large');
  assertReadsAfter(await f.calls(), 'run submit');

  // A success exit with an answer that is not a queued run is also unconfirmed.
  for (const entry of [{ stdout: 'accepted\n' }, { json: { ...f.queued, status: 'running' } }, { json: { ...f.queued, projectId: 'project-9' } }]) {
    await f.script({ ...f.scenario, 'run submit project-1 *': entry, 'run list': { json: [] } });
    await f.reset();
    result = await f.start();
    assert.equal(result.report.outcome, 'uncertain');
    assertReadsAfter(await f.calls(), 'run submit');
  }
});

test('a submit that provably never left, or that the coordinator refused, is reported as such', async t => {
  const f = await startScenario(t);
  for (const stderr of ['Heimdall: Coordinator unavailable: connect ENOENT /x/coordinator.sock\n', 'Heimdall: Coordinator unavailable: connect ECONNREFUSED /x/coordinator.sock\n']) {
    await f.script({ ...f.scenario, 'run submit project-1 *': { stderr } });
    await f.reset();
    const result = await f.start();
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.outcome, 'not-submitted');
    assert.equal(result.report.inspection, undefined);
    const calls = await f.calls();
    assert.equal(subcommand(calls.at(-1))[1], 'submit', 'nothing follows the submit');
    assert.equal(countOf(calls, 'run submit'), 1);
  }
  for (const message of ['Project not found', 'Feature specification exceeds 128 KiB', 'Coordinator is draining; new work is disabled', 'Pinned project already tracks a managed runtime path: .opencode/plugins/x.js. Select a development project without these assets; existing workflows are preserved.']) {
    await f.script({ ...f.scenario, 'run submit project-1 *': { stderr: `Heimdall: ${message}\n` } });
    await f.reset();
    const result = await f.start();
    assert.equal(result.report.outcome, 'rejected');
    assert.equal(result.report.message, message);
    const calls = await f.calls();
    assert.equal(subcommand(calls.at(-1))[1], 'submit');
    assert.equal(countOf(calls, 'run submit'), 1);
  }
});

// --- resume against a scripted command line ----------------------------------------------------------------

async function resumeScenario(t, extra = {}) {
  const f = await fakeFixture(t);
  const cwd = path.join(f.root, 'work dir');
  await fs.mkdir(cwd);
  const paused = runRecord({ wait: genericWait() });
  const queued = runRecord({ status: 'queued', launchAction: 'resume', reason: null, version: 4, wait: null });
  // `run resume` is scripted to succeed so that any use of it would be visible as a recorded call and a reported success.
  const scenario = { 'run show run-1': [{ json: paused }, { json: queued }], 'run respond run-1 *': { json: pauseAck() }, 'run resume run-1 *': { json: queued }, ...extra };
  await f.script(scenario);
  await f.reset();
  const resume = (guidance, ...args) => runHelper(['resume', 'run-1', '--cwd', cwd, ...args], f.env, guidance === undefined ? {} : { stdin: Readable.from([Buffer.from(guidance)]) });
  return { ...f, cwd, paused, queued, scenario, resume };
}

test('resume refuses runs that are not confirmed idle paused runs and sends nothing', async t => {
  const f = await resumeScenario(t);
  await fs.writeFile(path.join(f.cwd, 'guidance.txt'), 'Use the second approach.');
  const states = [
    [{ status: 'queued' }, 'wait'], [{ status: 'preparing', capacityReserved: true }, 'wait'], [{ status: 'running', capacityReserved: true }, 'wait'],
    [{ status: 'paused', capacityReserved: true }, 'wait'], [{ status: 'reconciliation-required', capacityReserved: true }, 'owner-decision'],
    [{ status: 'succeeded' }, 'none'], [{ status: 'failed' }, 'none'],
  ];
  for (const [overrides, action] of states) {
    await f.script({ ...f.scenario, 'run show run-1': { json: runRecord(overrides) } });
    await f.reset();
    const result = await f.resume(undefined, '--guidance-file', 'guidance.txt');
    assert.equal(result.exitCode, 1, JSON.stringify(overrides));
    assert.equal(result.report.outcome, 'not-resumable');
    assert.equal(result.report.run.status, overrides.status, 'the actual state is reported');
    assert.equal(result.report.next.action, action);
    assert.deepEqual(result.report.mutationsAttempted, []);
    assertNoMutation(await f.calls());
    assert.deepEqual((await f.calls()).map(subcommand), [['run', 'show', 'run-1']]);
    for (const secret of SECRETS) assert.ok(!result.text.includes(secret), secret);
    if (action === 'owner-decision') assert.match(result.report.next.detail, /run reconcile.*separate recovery decision/);
  }
  await f.script({ ...f.scenario, 'run show run-1': { stderr: 'Heimdall: Run not found\n' } });
  await f.reset();
  const missing = await f.resume(undefined, '--guidance-file', 'guidance.txt');
  assert.equal(missing.report.outcome, 'not-found');
  assertNoMutation(await f.calls());
});

test('unusable guidance is refused before any coordinator call', async t => {
  const f = await resumeScenario(t);
  const write = (name, content) => fs.writeFile(path.join(f.cwd, name), content);
  await write('empty.txt', '');
  await write('blank.txt', '\n  \t\n');
  await write('big.txt', 'g'.repeat(MAX_GUIDANCE_BYTES + 1));
  await write('nul.txt', 'before\0after');
  await write('bad utf8.txt', Buffer.from([0x41, 0xff, 0xfe]));
  await fs.mkdir(path.join(f.cwd, 'folder'));
  for (const [name, reason] of [['empty.txt', 'guidance-empty'], ['blank.txt', 'guidance-empty'], ['big.txt', 'guidance-too-large'], ['nul.txt', 'guidance-contains-nul'], ['bad utf8.txt', 'guidance-not-utf8'], ['missing.txt', 'guidance-unreadable'], ['folder', 'guidance-not-a-file']]) {
    const result = await f.resume(undefined, '--guidance-file', name);
    assert.equal(result.exitCode, 1, name);
    assert.equal(result.report.outcome, 'refused');
    assert.equal(result.report.reason, reason);
  }
  for (const [text, reason] of [['', 'guidance-empty'], ['   \n', 'guidance-empty'], ['h'.repeat(MAX_GUIDANCE_BYTES + 1), 'guidance-too-large'], ['a\0b', 'guidance-contains-nul']]) {
    const result = await f.resume(text, '--guidance-stdin');
    assert.equal(result.report.reason, reason);
  }
  assert.deepEqual(await f.calls(), []);
});

test('resume sends guidance verbatim in one guarded response for the displayed pause, however awkward the text', async t => {
  const f = await resumeScenario(t);
  const marker = path.join(f.root, 'shell-ran');
  const texts = [
    '--start-over --force', '-x', '--', '- bullet\n- list',
    `Use "double" and 'single' quotes, $(touch ${marker}); \`touch ${marker}\` && rm -rf *`,
    'line one\nline two\n\n    indented\n', 'CRLF\r\nline\r\n', 'ação ✓ — unicode', '  leading and trailing spaces  ', 'g'.repeat(MAX_GUIDANCE_BYTES),
  ];
  for (const [index, text] of texts.entries()) {
    await f.script(f.scenario);
    await f.reset();
    const viaFile = index % 2 === 0;
    if (viaFile) await fs.writeFile(path.join(f.cwd, 'guidance with "quotes" and spaces.txt'), text);
    const result = viaFile ? await f.resume(undefined, '--guidance-file', 'guidance with "quotes" and spaces.txt') : await f.resume(text, '--guidance-stdin');
    if (text.length > RESPONSE_INPUT_LIMIT) {
      assert.equal(result.report.reason, 'guidance-too-long');
      assert.deepEqual(mutations(await f.calls()), []);
      continue;
    }
    assert.equal(result.exitCode, 0, `${JSON.stringify(text.slice(0, 40))}: ${result.stderr}${result.text}`);
    assert.equal(result.report.outcome, 'resumed');
    assert.equal(result.report.via, 'respond');
    assert.equal(result.report.guidance.bytes, Buffer.byteLength(text));
    assert.ok(!result.text.includes(text.slice(0, 30)) || text.length < 30, `the guidance is not echoed: ${JSON.stringify(text.slice(0, 40))}`);
    const calls = await f.calls();
    assert.equal(countOf(calls, 'run resume'), 0);
    assert.deepEqual(mutations(calls), ['run respond']);
    assert.deepEqual(sentRespond(calls), [['coordinator', 'run', 'respond', 'run-1', '--pause', PAUSE, `--input=${text}`]], 'the displayed pause is named and the guidance arrives byte for byte');
    assert.ok(sentRespond(calls)[0][6].startsWith('--input='), 'the value can never be read as an option');
    assert.deepEqual(calls.map(argv => subcommand(argv).slice(0, 2).join(' ')), ['run show', 'run respond', 'run show']);
  }
  await assert.rejects(fs.access(marker), 'no shell evaluated the guidance');
});

test('resume reads guidance from a real stdin pipe', async t => {
  const f = await resumeScenario(t);
  const guidance = '--- not a flag ---\nsecond line with $HOME and "quotes"\n';
  const child = spawn(process.execPath, [helperFile, 'resume', 'run-1', '--cwd', f.cwd, '--guidance-stdin'], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  child.stdin.end(guidance);
  assert.equal(await exited, 0);
  assert.equal(JSON.parse(output).outcome, 'resumed');
  const calls = await f.calls();
  assert.deepEqual(sentRespond(calls), [['coordinator', 'run', 'respond', 'run-1', '--pause', PAUSE, `--input=${guidance}`]]);
  assert.equal(countOf(calls, 'run resume'), 0);
});

test('resume reports the same run after acceptance: identity, completed results and new status', async t => {
  const f = await resumeScenario(t);
  const result = await f.resume('Pick option B.', '--guidance-stdin');
  const { report } = result;
  assert.equal(report.outcome, 'resumed');
  assert.equal(report.runId, 'run-1');
  assert.equal(report.status, 'queued');
  assert.equal(report.run.launchAction, 'resume');
  assert.deepEqual(report.preserved, { runId: true, worktreePath: true, branch: true, parentSessionId: true });
  assert.deepEqual(report.completedResults, { before: 1, after: 1 });
  assert.equal(report.run.worktreePath, '/synthetic/worktrees/run-1/checkout');
  assert.equal(report.run.parentSessionId, 'ses_parent');
  assert.equal(report.acknowledgement.pauseId, PAUSE);
  assert.match(report.note, /not running until it is admitted/);
  for (const secret of SECRETS) assert.ok(!result.text.includes(secret), secret);

  // The follow-up read failing does not undo the acceptance; the acknowledgement of the response itself is reported.
  await f.script({ ...f.scenario, 'run show run-1': [{ json: f.paused }, { stderr: 'Heimdall: Coordinator unavailable: read ECONNRESET\n' }] });
  await f.reset();
  const degraded = await f.resume('Pick option B.', '--guidance-stdin');
  assert.equal(degraded.report.outcome, 'resumed');
  assert.equal(degraded.report.status, 'queued');
  assert.equal(degraded.report.confirmation.available, false);
  const calls = await f.calls();
  assert.equal(sentRespond(calls).length, 1);
  assert.equal(countOf(calls, 'run resume'), 0);
});

test('a lost guarded resume response is uncertain: one respond, read-only inspection, no retry and no unguarded resume', async t => {
  const f = await resumeScenario(t);
  for (const stderr of ['Heimdall: Coordinator unavailable: read ECONNRESET\n', 'Heimdall: Coordinator unavailable: Coordinator request timed out\n', 'Heimdall: Invalid coordinator JSON response\n', 'Heimdall: Something unexpected\n']) {
    await f.script({ ...f.scenario, 'run respond run-1 *': { stderr }, 'run show run-1': [{ json: f.paused }, { json: f.queued }] });
    await f.reset();
    const result = await f.resume('Owner says: go ahead.', '--guidance-stdin');
    assert.equal(result.exitCode, 1, stderr);
    assert.equal(result.report.outcome, 'uncertain');
    assert.equal(result.report.accepted, undefined);
    assert.match(result.report.rule, /Do not repeat it/);
    assert.equal(result.report.inspection.confirmed, false);
    assert.equal(result.report.inspection.run.status, 'queued', 'the observation is reported without claiming it');
    assert.equal(result.report.before.version, 3);
    assert.equal(result.report.inspection.version, 4);
    const calls = await f.calls();
    assertReadsAfter(calls, 'run respond');
    assert.equal(countOf(calls, 'run resume'), 0);
    assert.deepEqual(calls.map(argv => subcommand(argv).slice(0, 2).join(' ')), ['run show', 'run respond', 'run show']);
    assert.ok(!result.text.includes('go ahead'), 'the guidance is not echoed');
  }
  await f.script({ ...f.scenario, 'run respond run-1 *': { stdout: 'accepted\n' } });
  await f.reset();
  assert.equal((await f.resume('x', '--guidance-stdin')).report.outcome, 'uncertain');
  const calls = await f.calls();
  assertReadsAfter(calls, 'run respond');
  assert.equal(countOf(calls, 'run resume'), 0);
});

test('a guarded resume that never left, or that the coordinator refused, is reported as such and nothing else is sent', async t => {
  const f = await resumeScenario(t);
  await f.script({ ...f.scenario, 'run respond run-1 *': { stderr: 'Heimdall: The coordinator at /x/coordinator.sock is unavailable: connect ECONNREFUSED /x/coordinator.sock. Nothing was sent.\n' } });
  await f.reset();
  let result = await f.resume('go', '--guidance-stdin');
  assert.equal(result.report.outcome, 'not-resumed');
  assert.deepEqual((await f.calls()).map(argv => subcommand(argv).slice(0, 2).join(' ')), ['run show', 'run respond']);

  const refusal = 'Heimdall: The coordinator refused the response (409 pause-stale): This is not the current pause of the run. Nothing was recorded.\n';
  await f.script({ ...f.scenario, 'run respond run-1 *': { stderr: refusal } });
  await f.reset();
  result = await f.resume('go', '--guidance-stdin');
  assert.equal(result.report.outcome, 'rejected');
  assert.deepEqual(result.report.refusal, { status: 409, code: 'pause-stale' });
  const calls = await f.calls();
  assert.equal(sentRespond(calls).length, 1);
  assert.equal(countOf(calls, 'run resume'), 0);
  assert.deepEqual(calls.map(argv => subcommand(argv).slice(0, 2).join(' ')), ['run show', 'run respond']);
});

// --- Helper against an in-process coordinator --------------------------------------------------------------

const specification = {
  settings: { plannerAgent: 'planner', executorAgent: 'executor', plannerModel: 'anthropic/planner', executorModel: 'anthropic/executor', executorFallbackModel: 'kimi/fallback', maxTasks: 10, minQuotaRemainingPercent: 10, tokenLimitsDisabled: true },
  plannerPrompt: 'PRIVATE-PLANNER-PROMPT', executorPrompt: 'PRIVATE-EXECUTOR-PROMPT', agents: {},
  opencode: { baseUrl: 'http://127.0.0.1:9999', passwordEnvironmentVariable: 'SYNTHETIC_PASSWORD' },
};
const REVISION = { head: 'a'.repeat(40), digest: 'b'.repeat(64) };
const APPROVAL_CONTENT = { question: 'Ship the migration?', scope: 'Only the reviewed commit', completedWork: 'Migration written', verification: ['unit tests pass'], artifacts: ['src/migrate.ts'], onApprove: ['merge the migration'], onRequestChanges: ['fix and ask again'] };
const PROJECT_CONFIGURATION = '[workflow]\nplannerModel = "anthropic/fixture"\nexecutorModel = "anthropic/fixture"\nexecutorFallbackModel = "openai/fixture"\n[opencode]\nbaseUrl = "http://127.0.0.1:4096"\n';

async function coordinatorFixture(t, { admission = false } = {}) {
  const root = await temporaryRoot(t);
  const recorder = await installBinary(root);
  const configFile = path.join(root, 'coordinator.toml');
  await fs.writeFile(configFile, '[coordinator]\nstateDirectory = "state"\nglobalConcurrency = 3\nprojectConcurrency = 3\n');
  const configuration = await loadCoordinatorConfiguration(configFile);
  const launches = [];
  let observation = { idle: true, status: 'paused' };
  const executor = {
    async launch(run) { launches.push(run.id); },
    async inspect() { return observation; },
  };
  // Worktree verification is stubbed: the seeded runs have no managed checkout. Admission stays off so queued runs stay queued.
  const service = await startCoordinatorService({ configuration, executor, pollIntervalMs: 60000, scheduler: { verifyWorktree: async () => {}, revision: async () => REVISION, prepare: async () => {} } });
  if (!admission) service.scheduler.pauseAdmission();
  t.after(() => service.close());
  const env = isolatedEnvironment(root, { HEIMDALL_BIN: recorder.binary, HEIMDALL_TEST_LOG: recorder.log, HEIMDALL_TEST_CLI: distCli });
  const repository = await makeRepository(env, root, 'repository');
  await fs.writeFile(path.join(repository, '.heimdall.toml'), PROJECT_CONFIGURATION);
  const linked = path.join(root, 'linked worktree');
  await gitIn(env, repository, 'worktree', 'add', '-q', '-b', 'linked-branch', linked, 'HEAD~1');
  const registerRepository = directory => service.store.registerProject({ directory, commonGitDirectory: path.join(directory, '.git'), configPath: path.join(directory, '.heimdall.toml'), concurrency: 3 });
  const project = registerRepository(repository);
  const enqueue = id => service.store.enqueue({
    id, projectId: project.id, feature: `# Seeded ${id}\n\nFEATURE-SECRET-BODY`, baseCommit: 'a'.repeat(40),
    worktreePath: path.join(root, 'worktrees', id, 'checkout'), branch: `heimdall/run/${id}`, specification,
  });
  const admit = id => {
    enqueue(id);
    const run = service.store.admitNext();
    assert.equal(run.id, id);
    return run;
  };
  const savePaused = (id, { release = true } = {}) => {
    let run = admit(id);
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
    return service.store.transition(id, run.ownerToken, run.version, 'paused', 'Needs an owner decision', release);
  };
  const databasePath = path.join(configuration.stateDirectory, 'coordinator.sqlite');
  const sql = (statement, ...values) => {
    const database = new DatabaseSync(databasePath);
    try { return statement.trimStart().toUpperCase().startsWith('SELECT') ? database.prepare(statement).all(...values) : database.prepare(statement).run(...values); }
    finally { database.close(); }
  };
  // A paused, released run whose checkpoint is a paused one: `approval` publishes a pending typed request, otherwise the pause is generic.
  const saveWaiting = (id, { approval }) => {
    let run = admit(id);
    const caller = { sessionID: run.parentSessionId, id: `call-${id}`, messageID: `message-${id}`, agent: 'adr-orchestrator' };
    const attempt = { id: `attempt_${id}_1`, phase: 'executor', index: 1, child: 'ses_child', status: 'rejected', startedAt: 1, model: 'anthropic/x' };
    const saved = {
      id, status: 'paused', adr: 'feature.md', parent: run.parentSessionId, caller, branch: run.branch, baseline: '', index: 1,
      tasks: [{ id: 'T1', title: 'First task', brief: 'BRIEF-SECRET', dependsOn: [], dod: [] }, { id: 'T2', title: 'Second task', brief: 'BRIEF-SECRET', dependsOn: ['T1'], dod: ['gate'] }],
      results: [{ taskId: 'T1', status: 'completed', summary: 'CHECKPOINT-SECRET', handoff: 'next', evidence: [], model: 'anthropic/executor', sessionId: `child-${id}` }],
      phase: 'executor', child: 'ses_child', settings: specification.settings, attempt, reason: approval ? 'Approval required for T2' : 'Blocked: choose the database', resolution: 'RESOLUTION-SECRET',
      ...(approval ? { wait: { kind: 'approval', attemptId: attempt.id, index: 1, taskId: 'T2' }, protocol: 'structured-v1' } : {}),
    };
    service.store.bindStart(id, run.ownerToken, caller);
    // The request is published before the runner records its pause on it.
    const requestId = approval ? `apr_${id}_1` : undefined;
    if (approval) {
      sql(`INSERT INTO approval_requests(run_id, request_id, phase, task_index, task_id, attempt_id, receipt_digest, request_json, revision_json, state, continuation, created_at)
        VALUES (?, ?, 'executor', 1, 'T2', ?, 'digest', ?, ?, 'pending', 'none', 1000)`, id, requestId, attempt.id, JSON.stringify(APPROVAL_CONTENT), JSON.stringify(REVISION));
    }
    service.store.saveCheckpoint(id, run.ownerToken, saved);
    run = service.store.transition(id, run.ownerToken, run.version, 'running');
    const paused = service.store.transition(id, run.ownerToken, run.version, 'paused', saved.reason, true);
    return { run: paused, requestId };
  };
  const approvalRow = requestId => sql('SELECT request_id, state, decision, feedback, continuation FROM approval_requests WHERE request_id = ?', requestId)[0];
  const state = () => ({ runs: service.store.listRuns(), events: service.store.events(), counts: service.store.statusCounts(), projects: service.store.listProjects(), approvals: sql('SELECT * FROM approval_requests ORDER BY rowid'), responses: sql('SELECT * FROM run_responses ORDER BY rowid') });
  return {
    root, env, configFile, repository, linked, project, service, enqueue, admit, savePaused, state, registerRepository, sql, saveWaiting, approvalRow,
    observe: value => { observation = value; }, launches, ...recorder,
  };
}

test('inspect-spec flags guidance-like text and existing run IDs without changing anything', async t => {
  const f = await coordinatorFixture(t);
  const id = randomUUID();
  f.savePaused(id);
  const before = f.state();
  await f.reset();
  const write = (name, content) => fs.writeFile(path.join(f.linked, name), content);
  const config = ['--coordinator-config', f.configFile, '--cwd', f.linked];

  await write('guidance.md', `Resume run ${id}. It is paused and blocked on a decision.\nDecision: take the second approach.\n`);
  let result = await runHelper(['inspect-spec', 'guidance.md', ...config], f.env);
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.report.mentionsExistingRun, true);
  assert.deepEqual(result.report.existingRunIds, [id]);
  assert.equal(result.report.looksLikeResumeGuidance, true);
  assert.ok(result.report.signals.includes('mentions-resume') && result.report.signals.includes('mentions-existing-run-id'));
  assert.equal(result.report.firstHeading, null);

  await write('branch.md', '# Notes\n\nSee branch heimdall/run/' + id + ' for context.\n');
  result = await runHelper(['inspect-spec', 'branch.md', ...config], f.env);
  assert.equal(result.report.mentionsExistingRun, true);
  assert.equal(result.report.firstHeading, 'Notes');

  await write('unknown.md', `# Reuse of ${randomUUID()}\n\nPlain feature text about a different identifier.\n`);
  result = await runHelper(['inspect-spec', 'unknown.md', ...config], f.env);
  assert.equal(result.report.mentionsExistingRun, false, 'an identifier that is not a run is not an existing run');
  assert.equal(result.report.runLookup, 'checked');
  assert.equal(result.report.looksLikeResumeGuidance, false);

  await write('feature.md', '# Add search\n\nAdd a search box to the header.\n');
  result = await runHelper(['inspect-spec', 'feature.md', ...config], f.env);
  assert.equal(result.report.firstHeading, 'Add search');
  assert.equal(result.report.mentionsExistingRun, false);
  assert.equal(result.report.looksLikeResumeGuidance, false);

  const calls = await f.calls();
  assertNoMutation(calls);
  assert.ok(calls.length >= 3);
  assert.deepEqual(f.state(), before, 'runs, events, projects and counts are unchanged');
});

test('start from a linked worktree creates exactly one run for the registered project at that worktree\'s full commit', async t => {
  const f = await coordinatorFixture(t);
  const mainHead = await gitIn(f.env, f.repository, 'rev-parse', 'HEAD');
  const linkedHead = await gitIn(f.env, f.linked, 'rev-parse', 'HEAD');
  assert.notEqual(mainHead, linkedHead);
  const specText = '# Linked feature\n\nBuild it from the linked worktree.\n';
  await fs.writeFile(path.join(f.linked, 'spec file.md'), specText);
  await fs.writeFile(path.join(f.linked, 'untracked.txt'), 'x\n');
  await f.reset();

  const result = await runHelper(['start', '--cwd', f.linked, '--spec', 'spec file.md', '--coordinator-config', f.configFile], f.env);
  assert.equal(result.exitCode, 0, result.stderr + result.text);
  const { report } = result;
  assert.equal(report.outcome, 'submitted');
  assert.equal(report.status, 'queued');
  assert.equal(report.base.oid, linkedHead, 'HEAD resolved in the selected worktree');
  assert.equal(report.base.recordedCommit, linkedHead);
  assert.match(report.base.oid, /^[0-9a-f]{40}$/);
  assert.equal(report.project.id, f.project.id);
  assert.ok(report.notices.some(notice => /untracked/.test(notice)));
  assert.ok(report.notices.some(notice => /registered project directory/.test(notice)));

  const runs = f.service.store.listRuns();
  assert.equal(runs.length, 1, 'exactly one run');
  const [run] = runs;
  assert.equal(run.id, report.runId);
  assert.equal(run.status, 'queued');
  assert.equal(run.projectId, f.project.id);
  assert.equal(run.baseCommit, linkedHead);
  assert.equal(run.feature, specText);
  assert.equal(run.worktreePath, report.worktreePath);
  assert.equal(run.branch, report.branch);
  assert.equal(f.launches.length, 0);
  for (const secret of ['PRIVATE-PLANNER-PROMPT', 'anthropic/fixture', specText]) assert.ok(!result.text.includes(secret), secret);

  const calls = await f.calls();
  assert.equal(countOf(calls, 'run submit'), 1);
  assert.deepEqual(mutations(calls), ['run submit']);
  const submit = calls.find(argv => verbOf(argv) === 'run submit');
  assert.equal(submit[submit.indexOf('--base') + 1], linkedHead);
  assert.equal(submit[submit.indexOf('--feature') + 1], path.join(await fs.realpath(f.linked), 'spec file.md'));

  // An explicit base is resolved in the selected worktree too, and each start is its own single submit.
  await f.reset();
  const second = await runHelper(['start', '--cwd', f.repository, '--spec', path.join(f.linked, 'spec file.md'), '--base', 'main', '--coordinator-config', f.configFile], f.env);
  assert.equal(second.report.outcome, 'submitted', second.text);
  assert.equal(second.report.base.oid, mainHead);
  assert.equal(f.service.store.listRuns().length, 2);
  assert.equal(f.service.store.getRun(second.report.runId).baseCommit, mainHead);
  assert.equal(countOf(await f.calls(), 'run submit'), 1);
});

test('start from a linked worktree registers the main worktree, never the disposable linked directory', async t => {
  const f = await coordinatorFixture(t);
  const other = await makeRepository(f.env, f.root, 'third repository');
  await fs.writeFile(path.join(other, '.heimdall.toml'), PROJECT_CONFIGURATION);
  const linked = path.join(f.root, 'third linked worktree');
  await gitIn(f.env, other, 'worktree', 'add', '-q', '-b', 'third-linked', linked, 'HEAD~1');
  await fs.writeFile(path.join(linked, 'spec.md'), '# Third\n\nBuild it.\n');
  const before = f.state();
  await f.reset();
  const start = (...args) => runHelper(['start', '--cwd', linked, '--spec', 'spec.md', '--coordinator-config', f.configFile, ...args], f.env);

  let result = await start();
  assert.equal(result.report.outcome, 'needs-registration');
  assert.equal(result.report.directory, other, 'the proposed project directory is the main worktree');
  assertNoMutation(await f.calls());
  assert.deepEqual(f.state(), before);

  await f.reset();
  result = await start('--register');
  assert.equal(result.report.outcome, 'submitted', result.text);
  const calls = await f.calls();
  assert.deepEqual(calls.find(argv => verbOf(argv) === 'project add'), ['coordinator', 'project', 'add', other, '--coordinator-config', f.configFile]);
  const registered = f.service.store.listProjects().find(project => project.directory === other);
  assert.ok(registered, 'the main worktree is the registered directory');
  assert.ok(!f.service.store.listProjects().some(project => project.directory === linked));
  assert.ok(result.report.notices.some(notice => notice.includes(other) && /linked worktree/i.test(notice)));
});

test('start refuses to register when the main worktree cannot be derived from the Git directory', async t => {
  const f = await coordinatorFixture(t);
  const base = path.join(f.root, 'detached git dir');
  const work = path.join(base, 'work');
  await fs.mkdir(work, { recursive: true });
  await exec('git', ['-C', work, 'init', '-q', '--separate-git-dir', path.join(base, 'store.git')], { env: f.env });
  await gitIn(f.env, work, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  await fs.writeFile(path.join(work, 'file.txt'), 'x\n');
  await gitIn(f.env, work, 'add', '.');
  await gitIn(f.env, work, 'commit', '-q', '-m', 'one');
  await fs.writeFile(path.join(work, 'spec.md'), '# Detached\n\nBuild it.\n');
  const before = f.state();
  await f.reset();
  const result = await runHelper(['start', '--cwd', work, '--spec', 'spec.md', '--register', '--coordinator-config', f.configFile], f.env);
  assert.equal(result.report.outcome, 'needs-registration');
  assert.equal(result.report.reason, 'registration-directory-unknown');
  assertNoMutation(await f.calls());
  assert.deepEqual(f.state(), before);
});

test('start registers an unregistered repository only with --register, adds it once with no extra options, and reuses it afterwards', async t => {
  const f = await coordinatorFixture(t);
  const other = await makeRepository(f.env, f.root, 'second repository');
  await fs.writeFile(path.join(other, '.heimdall.toml'), PROJECT_CONFIGURATION);
  await fs.writeFile(path.join(other, 'spec.md'), '# Second\n\nBuild it.\n');
  const otherHead = await gitIn(f.env, other, 'rev-parse', 'HEAD');
  const before = f.state();
  await f.reset();
  const start = (...args) => runHelper(['start', '--cwd', other, '--spec', 'spec.md', '--coordinator-config', f.configFile, ...args], f.env);

  let result = await start();
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.outcome, 'needs-registration');
  assertNoMutation(await f.calls());
  assert.deepEqual(f.state(), before, 'nothing changed without --register');

  await f.reset();
  result = await start('--register');
  assert.equal(result.report.outcome, 'submitted', result.text);
  assert.deepEqual(result.report.mutationsAttempted, ['project add', 'run submit']);
  let calls = await f.calls();
  assert.deepEqual(mutations(calls), ['project add', 'run submit']);
  assert.deepEqual(calls.find(argv => verbOf(argv) === 'project add'), ['coordinator', 'project', 'add', other, '--coordinator-config', f.configFile]);
  const registered = f.service.store.listProjects().find(project => project.directory === other);
  assert.ok(registered);
  assert.equal(f.service.store.listProjects().length, 2);
  assert.equal(result.report.project.id, registered.id);
  assert.equal(f.service.store.getRun(result.report.runId).projectId, registered.id);
  assert.equal(f.service.store.getRun(result.report.runId).baseCommit, otherHead);

  await f.reset();
  result = await start('--register');
  assert.equal(result.report.outcome, 'submitted');
  calls = await f.calls();
  assert.deepEqual(mutations(calls), ['run submit'], 'reuse: no second registration');
  assert.equal(f.service.store.listProjects().length, 2);
  assert.equal(f.service.store.listRuns().length, 2);
});

// --- start under inherited Git overrides ------------------------------------------------------------------

/** A copy of `env` that points Git at another repository, as a hook or wrapper process might. */
const poisonedFor = (env, other) => ({ ...env, GIT_DIR: path.join(other, '.git'), GIT_WORK_TREE: other });

test('start under inherited GIT_DIR and GIT_WORK_TREE submits once for the selected repository and never touches the other one', async t => {
  const f = await fakeFixture(t);
  const a = await makeRepository(f.env, f.root, 'repo a');
  const b = await makeRepository(f.env, f.root, 'repo b');
  await fs.writeFile(path.join(b, 'extra.txt'), 'b\n');
  await gitIn(f.env, b, 'add', '.');
  await gitIn(f.env, b, 'commit', '-q', '-m', 'b only');
  await fs.writeFile(path.join(a, 'spec file.md'), '# Feature A\n\nBuild it in A.\n');
  await gitIn(f.env, a, 'add', 'spec file.md');
  await gitIn(f.env, a, 'commit', '-q', '-m', 'spec');
  const headA = await gitIn(f.env, a, 'rev-parse', 'HEAD');
  const headB = await gitIn(f.env, b, 'rev-parse', 'HEAD');
  assert.notEqual(headA, headB);
  const projectA = await projectRecord(a, 'project-a');
  const projectB = await projectRecord(b, 'project-b');
  const queued = runRecord({ id: 'run-a', projectId: 'project-a', status: 'queued', baseCommit: headA, checkpoint: null, version: 0, reason: null, launchAction: 'start', branch: 'heimdall/run/run-a', worktreePath: '/synthetic/worktrees/run-a/checkout' });
  await f.script({ 'status --json': RUNNING, 'project list': { json: [projectA, projectB] }, 'run submit project-a *': { json: queued } });
  await f.reset();

  const env = poisonedFor(f.env, b);
  const result = await runHelper(['start', '--cwd', a, '--spec', 'spec file.md'], env);
  assert.equal(result.exitCode, 0, result.stderr + result.text);
  assert.equal(result.report.outcome, 'submitted');
  assert.equal(result.report.project.id, 'project-a');
  assert.equal(result.report.base.oid, headA);
  assert.match(result.report.base.oid, /^[0-9a-f]{40}$/);

  const calls = await f.calls();
  assert.deepEqual(mutations(calls), ['run submit'], 'exactly one mutation, and it is the submission');
  const submit = calls.find(argv => verbOf(argv) === 'run submit');
  assert.deepEqual(subcommand(submit), ['run', 'submit', 'project-a', '--feature', path.join(a, 'spec file.md'), '--base', headA]);
  assert.ok(path.isAbsolute(submit[submit.indexOf('--feature') + 1]));
  assert.equal(submit[submit.indexOf('--base') + 1], headA);
  assert.ok(!calls.some(argv => argv.includes('project-b') || argv.some(word => word.includes(b))), 'nothing names the other project or repository');
  assert.equal(countOf(calls, 'project add'), 0);
});

test('start under inherited Git overrides runs only in the selected repository and registers nothing for the other one', async t => {
  const f = await coordinatorFixture(t);
  const b = await makeRepository(f.env, f.root, 'unrelated repository');
  await fs.writeFile(path.join(b, 'extra.txt'), 'b\n');
  await gitIn(f.env, b, 'add', '.');
  await gitIn(f.env, b, 'commit', '-q', '-m', 'b only');
  await fs.writeFile(path.join(b, '.heimdall.toml'), PROJECT_CONFIGURATION);
  const projectB = f.registerRepository(b);
  const headA = await gitIn(f.env, f.repository, 'rev-parse', 'HEAD');
  const headB = await gitIn(f.env, b, 'rev-parse', 'HEAD');
  assert.notEqual(headA, headB);
  const specText = '# Feature A\n\nBuild it in A.\n';
  await fs.writeFile(path.join(f.repository, 'spec.md'), specText);
  const projectsBefore = f.service.store.listProjects();
  assert.equal(projectsBefore.length, 2);
  await f.reset();

  const result = await runHelper(['start', '--cwd', f.repository, '--spec', 'spec.md', '--coordinator-config', f.configFile], poisonedFor(f.env, b));
  assert.equal(result.exitCode, 0, result.stderr + result.text);
  assert.equal(result.report.outcome, 'submitted');
  assert.equal(result.report.project.id, f.project.id);
  assert.equal(result.report.base.oid, headA);

  const runs = f.service.store.listRuns();
  assert.equal(runs.length, 1, 'exactly one new run');
  assert.equal(runs[0].projectId, f.project.id);
  assert.equal(runs[0].baseCommit, headA);
  assert.equal(runs[0].feature, specText);
  assert.ok(!runs.some(run => run.projectId === projectB.id), 'no run for the other repository');
  assert.deepEqual(f.service.store.listProjects(), projectsBefore, 'no project was added or changed');
  assert.deepEqual(mutations(await f.calls()), ['run submit']);
});

test('start from a linked worktree under inherited Git overrides keeps the project identity and the linked HEAD', async t => {
  const f = await coordinatorFixture(t);
  const b = await makeRepository(f.env, f.root, 'unrelated repository');
  await fs.writeFile(path.join(b, 'extra.txt'), 'b\n');
  await gitIn(f.env, b, 'add', '.');
  await gitIn(f.env, b, 'commit', '-q', '-m', 'b only');
  await fs.writeFile(path.join(b, '.heimdall.toml'), PROJECT_CONFIGURATION);
  f.registerRepository(b);
  const mainHead = await gitIn(f.env, f.repository, 'rev-parse', 'HEAD');
  const linkedHead = await gitIn(f.env, f.linked, 'rev-parse', 'HEAD');
  const headB = await gitIn(f.env, b, 'rev-parse', 'HEAD');
  assert.notEqual(linkedHead, mainHead);
  assert.notEqual(linkedHead, headB);
  const specText = '# Linked feature\n\nBuild it from the linked worktree.\n';
  await fs.writeFile(path.join(f.linked, 'spec.md'), specText);
  const projectsBefore = f.service.store.listProjects();
  await f.reset();

  const result = await runHelper(['start', '--cwd', f.linked, '--spec', 'spec.md', '--coordinator-config', f.configFile], poisonedFor(f.env, b));
  assert.equal(result.exitCode, 0, result.stderr + result.text);
  assert.equal(result.report.outcome, 'submitted');
  assert.equal(result.report.project.id, f.project.id);
  assert.equal(result.report.base.oid, linkedHead);

  const runs = f.service.store.listRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].projectId, f.project.id);
  assert.equal(runs[0].baseCommit, linkedHead);
  assert.equal(runs[0].feature, specText);
  assert.deepEqual(f.service.store.listProjects(), projectsBefore);
  assert.deepEqual(mutations(await f.calls()), ['run submit']);
});

test('start --register under inherited Git overrides proposes the main worktree of the selected repository', async t => {
  const f = await coordinatorFixture(t);
  const b = await makeRepository(f.env, f.root, 'unrelated repository');
  await fs.writeFile(path.join(b, '.heimdall.toml'), PROJECT_CONFIGURATION);
  f.registerRepository(b);
  const other = await makeRepository(f.env, f.root, 'third repository');
  await fs.writeFile(path.join(other, '.heimdall.toml'), PROJECT_CONFIGURATION);
  const linked = path.join(f.root, 'third linked worktree');
  await gitIn(f.env, other, 'worktree', 'add', '-q', '-b', 'third-linked', linked, 'HEAD~1');
  await fs.writeFile(path.join(linked, 'spec.md'), '# Third\n\nBuild it.\n');
  await f.reset();

  const result = await runHelper(['start', '--cwd', linked, '--spec', 'spec.md', '--register', '--coordinator-config', f.configFile], poisonedFor(f.env, b));
  assert.equal(result.report.outcome, 'submitted', result.text);
  const calls = await f.calls();
  assert.deepEqual(mutations(calls), ['project add', 'run submit']);
  assert.deepEqual(calls.find(argv => verbOf(argv) === 'project add'), ['coordinator', 'project', 'add', other, '--coordinator-config', f.configFile]);
  assert.ok(!f.service.store.listProjects().some(project => project.directory === linked));
});

test('a registration conflict reported by the coordinator is surfaced verbatim and nothing is replaced or submitted', async t => {
  const fake = await fakeFixture(t);
  const text = 'Project already registered with different paths, configuration, or concurrency';
  const repository = await makeRepository(fake.env, fake.root, 'conflict repository');
  await fs.writeFile(path.join(repository, 'spec.md'), '# Spec\n');
  await fake.script({ 'status --json': RUNNING, 'project list': { json: [] }, 'project add *': { stderr: `Heimdall: ${text}\n` } });
  await fake.reset();
  const result = await runHelper(['start', '--cwd', repository, '--spec', 'spec.md', '--register'], fake.env);
  assert.equal(result.report.outcome, 'registration-rejected');
  assert.equal(result.report.message, text);
  assert.deepEqual(mutations(await fake.calls()), ['project add']);
});

test('resume of a paused run without a pause identity is refused by the real coordinator record and changes nothing', async t => {
  const f = await coordinatorFixture(t);
  const paused = f.savePaused('run-paused');
  assert.equal(paused.status, 'paused');
  assert.equal(paused.capacityReserved, false);
  await fs.writeFile(path.join(f.linked, 'guidance.txt'), '--use the second approach\nand keep $(cwd) literal "quoted"\n');
  const before = f.state();
  await f.reset();

  const shown = await runHelper(['snapshot', 'run-paused', '--cwd', f.linked, '--coordinator-config', f.configFile], f.env);
  assert.notEqual(shown.report.run.wait?.kind, 'generic', 'this paused run carries no generic pause identity');
  await f.reset();
  const result = await runHelper(['resume', 'run-paused', '--cwd', f.linked, '--guidance-file', 'guidance.txt', '--coordinator-config', f.configFile], f.env);
  assert.equal(result.exitCode, 1, result.stderr + result.text);
  assert.equal(result.report.outcome, 'refused');
  assert.equal(result.report.reason, 'pause-identity-unavailable');
  assert.deepEqual(result.report.mutationsAttempted, []);
  assert.match(result.report.message, /matching versions/);
  for (const secret of [...SECRETS, 'PRIVATE-PLANNER-PROMPT']) assert.ok(!result.text.includes(secret), secret);
  const calls = await f.calls();
  assertNoMutation(calls);
  assert.deepEqual(calls.map(subcommand), [['run', 'show', 'run-paused']]);
  assert.deepEqual(f.state(), before, 'the coordinator state is untouched');
  assert.equal(f.service.store.getRun('run-paused').version, paused.version);
  assert.equal(f.service.store.getRun('run-paused').status, 'paused');
});

test('resume of runs that are not confirmed idle paused runs sends nothing, against the real coordinator', async t => {
  const f = await coordinatorFixture(t);
  // admitNext takes the oldest queued run, so the queued run is enqueued last.
  f.admit('run-reserved');
  const heldPaused = f.savePaused('run-held', { release: false });
  f.enqueue('run-queued');
  assert.equal(heldPaused.status, 'paused');
  assert.equal(heldPaused.capacityReserved, true);
  await fs.writeFile(path.join(f.linked, 'guidance.txt'), 'Go ahead.');
  const before = f.state();
  await f.reset();
  for (const [id, status] of [['run-queued', 'queued'], ['run-reserved', 'preparing'], ['run-held', 'paused']]) {
    const result = await runHelper(['resume', id, '--cwd', f.linked, '--guidance-file', 'guidance.txt', '--coordinator-config', f.configFile], f.env);
    assert.equal(result.exitCode, 1, id);
    assert.equal(result.report.outcome, 'not-resumable');
    assert.equal(result.report.run.status, status);
    assert.equal(result.report.next.action, 'wait');
  }
  const calls = await f.calls();
  assertNoMutation(calls);
  assert.equal(calls.length, 3);
  assert.deepEqual(f.state(), before);
});

test('a guard rejection from the real coordinator for a guarded response is reported verbatim and nothing is retried or replaced', async t => {
  const f = await coordinatorFixture(t);
  const { run: paused } = f.saveWaiting('run-busy', { approval: false });
  f.observe({ idle: false, status: 'running' });
  await fs.writeFile(path.join(f.linked, 'guidance.txt'), 'Go ahead.');
  const before = f.state();
  await f.reset();
  const result = await runHelper(['resume', 'run-busy', '--cwd', f.linked, '--guidance-file', 'guidance.txt', '--coordinator-config', f.configFile], f.env);
  assert.equal(result.exitCode, 1, result.text);
  assert.equal(result.report.outcome, 'rejected');
  assert.equal(result.report.via, 'respond');
  assert.equal(result.report.refusal.status >= 400, true);
  const calls = await f.calls();
  assert.equal(countOf(calls, 'run resume'), 0, 'no unguarded resume after a refusal');
  assert.equal(countOf(calls, 'run respond'), 1);
  assert.deepEqual(calls.map(argv => subcommand(argv).slice(0, 2).join(' ')), ['run show', 'run respond']);
  assert.deepEqual(f.state(), before);
  assert.equal(f.service.store.getRun('run-busy').version, paused.version);
});

test('start through the real coordinator rejects a draining coordinator without creating a run', async t => {
  const f = await coordinatorFixture(t);
  await fs.writeFile(path.join(f.linked, 'spec.md'), '# Feature\n');
  const before = f.state();
  // A draining coordinator is exercised with a scripted status; the real one is shown to accept first.
  await f.reset();
  const accepting = await runHelper(['context', '--cwd', f.linked, '--coordinator-config', f.configFile], f.env);
  assert.equal(accepting.report.coordinator.acceptingNewRuns, true);
  const fake = await startScenario(t, { extra: { 'status --json': DRAINING } });
  const result = await fake.start();
  assert.equal(result.report.outcome, 'coordinator-draining');
  assertNoMutation(await fake.calls());
  assert.deepEqual(f.state(), before);
});

// --- respond and approval-aware resume against a scripted command line -------------------------------------

const REQUEST = 'apr_run-1_0001';
const PAUSE = 'pau_0123456789abcdef0123456789abcdef';
const approvalWait = (overrides = {}) => ({
  kind: 'approval', requestId: REQUEST, state: 'pending', continuation: 'none', progress: 'none', phase: 'executor', taskIndex: 1, taskId: 'T2', taskTitle: 'Second task',
  attemptId: 'attempt_1', question: 'Ship the migration?', scope: 'Only the reviewed commit', completedWork: 'Migration written', verification: ['unit tests pass'],
  artifacts: ['src/migrate.ts'], onApprove: ['merge the migration'], onRequestChanges: ['fix and ask again'], revision: { head: 'a'.repeat(40), digest: 'b'.repeat(64) },
  response: null, createdAt: 1, clipped: {}, ...overrides,
});
const genericWait = (overrides = {}) => ({ kind: 'generic', pauseId: PAUSE, reason: 'Needs an owner decision', reasonClipped: false, ...overrides });
const answeredWait = (decision, overrides = {}) => approvalWait({ state: 'answered', continuation: 'queued', progress: 'queued', response: { decision, feedback: decision === 'request-changes' ? 'FEEDBACK-SECRET' : null, answeredAt: 2 }, ...overrides });
const decisionAck = (decision, overrides = {}) => ({ runId: 'run-1', requestId: REQUEST, decision, recordedAt: 1760000000000, retried: false, continuation: 'queued', run: { status: 'queued', version: 4 }, ...overrides });
const pauseAck = (overrides = {}) => ({ runId: 'run-1', pauseId: PAUSE, recordedAt: 1760000000000, retried: false, continuation: 'queued', run: { status: 'queued', version: 4 }, ...overrides });
const sentRespond = calls => calls.filter(argv => verbOf(argv) === 'run respond');
const callNames = calls => calls.map(argv => subcommand(argv).slice(0, 2).join(' '));

async function respondScenario(t, { wait = approvalWait(), overrides = {}, ack = decisionAck('approve'), after, extra = {} } = {}) {
  const f = await fakeFixture(t);
  const cwd = path.join(f.root, 'work dir');
  await fs.mkdir(cwd);
  const paused = runRecord({ wait, ...overrides });
  const queued = runRecord({ status: 'queued', launchAction: 'resume', reason: null, version: 4, wait: after === undefined ? answeredWait('approve') : after });
  const scenario = { 'run show run-1': [{ json: paused }, { json: queued }], 'run respond run-1 *': { json: ack }, 'run resume run-1 *': { json: queued }, ...extra };
  await f.script(scenario);
  await f.reset();
  const respond = (input, ...args) => runHelper(['respond', 'run-1', '--cwd', cwd, ...args], f.env, input === undefined ? {} : { stdin: Readable.from([Buffer.from(input)]) });
  const resume = (input, ...args) => runHelper(['resume', 'run-1', '--cwd', cwd, ...args], f.env, input === undefined ? {} : { stdin: Readable.from([Buffer.from(input)]) });
  return { ...f, cwd, paused, queued, scenario, respond, resume };
}
const APPROVE = ['--request', REQUEST, '--decision', 'approve'];
const CHANGES = ['--request', REQUEST, '--decision', 'request-changes'];

test('respond arguments: one target, an explicit decision, one text source, every value data', () => {
  assert.deepEqual(parseArguments(['respond', 'run-1', ...APPROVE]).options, { '--request': REQUEST, '--decision': 'approve' });
  assert.deepEqual(parseArguments(['respond', 'run-1', '--request=apr_1', '--decision=request-changes', '--feedback-file', '--odd name']).options, { '--request': 'apr_1', '--decision': 'request-changes', '--feedback-file': '--odd name' });
  assert.deepEqual(parseArguments(['respond', 'run-1', '--pause', PAUSE, '--guidance-stdin']).options, { '--pause': PAUSE, '--guidance-stdin': true });
  for (const bad of [['respond', 'a', 'b'], ['respond', 'a', '--input', 'x'], ['respond', 'a', '--spec', 'x'], ['respond', 'a', '--feedback-stdin=1'], ['respond', 'a', '--request', 'x', '--request', 'y'], ['respond', 'a', '--decision']]) {
    assert.throws(() => parseArguments(bad), UsageError, JSON.stringify(bad));
  }
});

test('respond usage mistakes exit 2 before any coordinator call', async t => {
  const f = await respondScenario(t);
  const cases = [
    [], ['--request', REQUEST], ['--pause', PAUSE], [...APPROVE, '--pause', PAUSE], [...APPROVE.slice(0, 2), '--decision', 'maybe'], ['--request', REQUEST, '--decision', 'approve', '--feedback-stdin'],
    [...CHANGES], [...CHANGES, '--feedback-stdin', '--feedback-file', 'x'], [...CHANGES, '--guidance-stdin'], ['--pause', PAUSE], ['--pause', PAUSE, '--decision', 'approve', '--guidance-stdin'],
    ['--pause', PAUSE, '--feedback-stdin'], ['--pause', PAUSE, '--guidance-stdin', '--guidance-file', 'x'], ['--request', '-bad', '--decision', 'approve'], ['--request', 'bad id', '--decision', 'approve'],
    ['--pause', '-bad', '--guidance-stdin'], ['--decision', 'approve'],
  ];
  for (const args of cases) {
    const result = await runHelper(['respond', 'run-1', '--cwd', f.cwd, ...args], f.env, { stdin: Readable.from([Buffer.from('text')]) });
    assert.equal(result.exitCode, 2, JSON.stringify(args));
  }
  for (const argv of [['respond', '--cwd', f.cwd, ...APPROVE], ['respond', '-bad', '--cwd', f.cwd, ...APPROVE], ['respond', 'bad id', '--cwd', f.cwd, ...APPROVE]]) {
    assert.equal((await runHelper(argv, f.env)).exitCode, 2, JSON.stringify(argv));
  }
  assert.deepEqual(await f.calls(), []);
});

test('respond reads the run again and sends nothing unless it still shows exactly what the owner decided on', async t => {
  const cases = [
    ['an older coordinator that reports no waits', { overrides: { wait: undefined } }, APPROVE, 'wait-not-reported'],
    ['a run with no wait', { wait: null }, APPROVE, 'no-approval-request'],
    ['a generic pause', { wait: genericWait() }, APPROVE, 'no-approval-request'],
    ['a different request', { wait: approvalWait({ requestId: 'apr_other_0002' }) }, APPROVE, 'request-mismatch'],
    ['an answered request', { wait: answeredWait('approve') }, APPROVE, 'already-answered'],
    ['a superseded request', { wait: approvalWait({ state: 'superseded' }) }, CHANGES, 'request-superseded'],
    ['a wait the helper cannot read', { wait: { kind: 'mystery' } }, APPROVE, 'no-approval-request'],
  ];
  for (const [name, setup, args, reason] of cases) {
    const f = await respondScenario(t, setup);
    if ('wait' in (setup.overrides ?? {})) await f.script({ ...f.scenario, 'run show run-1': { json: (({ wait, ...rest }) => rest)(f.paused) } });
    const result = await f.respond('Please change the plan.', ...args, ...(args === CHANGES ? ['--feedback-stdin'] : []));
    assert.equal(result.exitCode, 1, name);
    assert.equal(result.report.outcome, 'refused', name);
    assert.equal(result.report.reason, reason, name);
    assert.equal(result.report.sent, false);
    assert.deepEqual(result.report.mutationsAttempted, []);
    const calls = await f.calls();
    assertNoMutation(calls);
    assert.deepEqual(callNames(calls), ['run show'], name);
    assert.ok(!result.text.includes('Please change the plan.'), 'the feedback is not echoed');
  }
  // A pause response is checked against the displayed pause, and never answers a typed request.
  const pauseCases = [
    ['a typed request', { wait: approvalWait() }, 'approval-pending'],
    ['a different pause', { wait: genericWait({ pauseId: 'pau_ffffffffffffffffffffffffffffffff' }) }, 'pause-mismatch'],
    ['no wait', { wait: null }, 'no-generic-pause'],
    ['reserved capacity', { wait: genericWait(), overrides: { capacityReserved: true } }, 'not-paused-and-released'],
    ['a running run', { wait: genericWait(), overrides: { status: 'running' } }, 'not-paused-and-released'],
  ];
  for (const [name, setup, reason] of pauseCases) {
    const f = await respondScenario(t, setup);
    const result = await f.respond('Use the second approach.', '--pause', PAUSE, '--guidance-stdin');
    assert.equal(result.exitCode, 1, name);
    assert.equal(result.report.reason, reason, name);
    assertNoMutation(await f.calls());
    assert.deepEqual(callNames(await f.calls()), ['run show'], name);
    if (reason === 'approval-pending') assert.match(result.report.next.detail, /respond RUN_ID --request apr_run-1_0001/);
  }
  const missing = await respondScenario(t, { extra: { 'run show run-1': { stderr: 'Heimdall: Run not found\n' } } });
  const result = await missing.respond(undefined, ...APPROVE);
  assert.equal(result.report.reason, 'run-not-found');
  assertNoMutation(await missing.calls());
});

test('approve sends exactly one respond for the displayed request, with no text, and reports a queued continuation without calling it done', async t => {
  const f = await respondScenario(t);
  const result = await f.respond(undefined, ...APPROVE);
  assert.equal(result.exitCode, 0, result.stderr + result.text);
  const { report } = result;
  assert.equal(report.outcome, 'queued');
  assert.equal(report.recorded, true);
  assert.equal(report.retried, false);
  assert.equal(report.sent, true);
  assert.deepEqual(report.mutationsAttempted, ['run respond']);
  assert.equal(report.acknowledgement.requestId, REQUEST);
  assert.equal(report.acknowledgement.continuation, 'queued');
  assert.equal(report.run.status, 'queued');
  assert.equal(report.run.wait.state, 'answered');
  assert.equal(report.run.wait.response.decision, 'approve');
  assert.match(report.note, /not running until it is admitted, and the task is not complete/);
  assert.ok(!result.text.includes('FEEDBACK-SECRET'));
  const calls = await f.calls();
  assertReadsAfter(calls, 'run respond');
  assert.deepEqual(callNames(calls), ['run show', 'run respond', 'run show']);
  assert.deepEqual(sentRespond(calls), [['coordinator', 'run', 'respond', 'run-1', '--request', REQUEST, '--decision', 'approve']]);
  assert.ok(!mutations(calls).includes('run resume'), 'approval never goes through the unguarded resume');
});

test('respond reports a recorded decision waiting for idle proof, an identical retry, and an unexpected continuation', async t => {
  let f = await respondScenario(t, { ack: decisionAck('approve', { continuation: 'pending' }) });
  let result = await f.respond(undefined, ...APPROVE);
  assert.equal(result.report.outcome, 'waiting-for-idle');
  assert.match(result.report.note, /once it has proof that the run is idle/);
  f = await respondScenario(t, { ack: decisionAck('approve', { retried: true }) });
  result = await f.respond(undefined, ...APPROVE);
  assert.equal(result.report.outcome, 'queued');
  assert.equal(result.report.retried, true);
  f = await respondScenario(t, { ack: decisionAck('approve', { continuation: 'none' }) });
  result = await f.respond(undefined, ...APPROVE);
  assert.equal(result.report.outcome, 'recorded');
  assert.equal(sentRespond(await f.calls()).length, 1);
  // An acknowledgement for another request, decision or run is not the answer to this call.
  for (const ack of [decisionAck('request-changes'), decisionAck('approve', { requestId: 'apr_other' }), decisionAck('approve', { runId: 'run-2' }), { runId: 'run-1' }, 'accepted']) {
    f = await respondScenario(t, typeof ack === 'string' ? { extra: { 'run respond run-1 *': { stdout: `${ack}\n` } } } : { ack });
    result = await f.respond(undefined, ...APPROVE);
    assert.equal(result.report.outcome, 'uncertain', JSON.stringify(ack));
    assert.equal(sentRespond(await f.calls()).length, 1);
    assertReadsAfter(await f.calls(), 'run respond');
  }
});

test('requested changes and pause guidance reach the coordinator byte for byte as one --input= argument, however awkward', async t => {
  const marker = path.join(await temporaryRoot(t), 'shell-ran');
  const texts = [
    '--start-over --force', '-x', '--', '--input=--also', '- bullet\n- list',
    `Use "double" and 'single' quotes, $(touch ${marker}); \`touch ${marker}\` && rm -rf *`,
    'line one\nline two\n\n    indented\n', 'CRLF\r\nline\r\n', 'ação ✓ — unicode', '  leading and trailing spaces  ', 'g'.repeat(RESPONSE_INPUT_LIMIT),
  ];
  for (const target of ['request', 'pause']) {
    for (const [index, text] of texts.entries()) {
      const f = await respondScenario(t, target === 'request'
        ? { ack: decisionAck('request-changes'), after: answeredWait('request-changes') }
        : { wait: genericWait(), ack: pauseAck(), after: null });
      const viaFile = index % 2 === 0;
      if (viaFile) await fs.writeFile(path.join(f.cwd, 'text with "quotes" and spaces.txt'), text);
      const flag = target === 'request' ? 'feedback' : 'guidance';
      const args = target === 'request' ? CHANGES : ['--pause', PAUSE];
      const result = viaFile ? await f.respond(undefined, ...args, `--${flag}-file`, 'text with "quotes" and spaces.txt') : await f.respond(text, ...args, `--${flag}-stdin`);
      assert.equal(result.exitCode, 0, `${target} ${JSON.stringify(text.slice(0, 40))}: ${result.stderr}${result.text}`);
      assert.equal(result.report.outcome, 'queued');
      assert.equal(result.report[flag].bytes, Buffer.byteLength(text));
      if (text.length > 40) assert.ok(!result.text.includes(text.slice(0, 40)), 'the text is not echoed');
      const calls = await f.calls();
      assert.deepEqual(mutations(calls), ['run respond']);
      assert.equal(sentRespond(calls).length, 1);
      const sent = sentRespond(calls)[0];
      assert.deepEqual(sent, target === 'request'
        ? ['coordinator', 'run', 'respond', 'run-1', '--request', REQUEST, '--decision', 'request-changes', `--input=${text}`]
        : ['coordinator', 'run', 'respond', 'run-1', '--pause', PAUSE, `--input=${text}`]);
      assert.ok(sent.at(-1).startsWith('--input='), 'the value is attached to its option and can never be read as one');
      assertReadsAfter(calls, 'run respond');
    }
  }
  await assert.rejects(fs.access(marker), 'no shell evaluated the text');
});

test('respond reads a real stdin pipe', async t => {
  const f = await respondScenario(t, { ack: decisionAck('request-changes'), after: answeredWait('request-changes') });
  const feedback = '--- not a flag ---\nsecond line with $HOME and "quotes"\n';
  const child = spawn(process.execPath, [helperFile, 'respond', 'run-1', '--cwd', f.cwd, ...CHANGES, '--feedback-stdin'], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  const exited = new Promise(resolve => child.once('exit', code => resolve(code)));
  child.stdin.end(feedback);
  assert.equal(await exited, 0);
  assert.equal(JSON.parse(output).outcome, 'queued');
  assert.equal(sentRespond(await f.calls())[0].at(-1), `--input=${feedback}`);
});

test('unusable feedback or guidance is refused before any coordinator call', async t => {
  const f = await respondScenario(t);
  const write = (name, content) => fs.writeFile(path.join(f.cwd, name), content);
  await write('empty.txt', '');
  await write('blank.txt', '\n  \t\n');
  await write('big.txt', 'f'.repeat(MAX_GUIDANCE_BYTES + 1));
  await write('long.txt', 'f'.repeat(RESPONSE_INPUT_LIMIT + 1));
  await write('nul.txt', 'before\0after');
  await write('bad utf8.txt', Buffer.from([0x41, 0xff, 0xfe]));
  await fs.mkdir(path.join(f.cwd, 'folder'));
  for (const [name, reason] of [['empty.txt', 'empty'], ['blank.txt', 'empty'], ['big.txt', 'too-large'], ['long.txt', 'too-long'], ['nul.txt', 'contains-nul'], ['bad utf8.txt', 'not-utf8'], ['missing.txt', 'unreadable'], ['folder', 'not-a-file']]) {
    const result = await f.respond(undefined, ...CHANGES, '--feedback-file', name);
    assert.equal(result.exitCode, 1, name);
    assert.equal(result.report.outcome, 'refused');
    assert.equal(result.report.reason, `feedback-${reason}`);
    const pause = await f.respond(undefined, '--pause', PAUSE, '--guidance-file', name);
    assert.equal(pause.report.reason, `guidance-${reason}`);
  }
  for (const [text, reason] of [['', 'empty'], ['   \n', 'empty'], ['h'.repeat(RESPONSE_INPUT_LIMIT + 1), 'too-long'], ['a\0b', 'contains-nul']]) {
    assert.equal((await f.respond(text, ...CHANGES, '--feedback-stdin')).report.reason, `feedback-${reason}`);
  }
  assert.deepEqual(await f.calls(), []);
});

test('a lost respond response is uncertain: one respond, read-only inspection, no retry', async t => {
  const stderrs = [
    ['Heimdall: The response may or may not have been recorded: read ECONNRESET. Do not retry blindly. Inspect the run with "heimdall coordinator run show run-1" to see whether the response was recorded and how the run continues.\n', 2],
    ['Heimdall: Coordinator unavailable: read ECONNRESET\n', 1], ['Heimdall: Invalid coordinator JSON response\n', 1], ['Heimdall: Something unexpected\n', 1], ['', 1],
  ];
  for (const [stderr, code] of stderrs) {
    const f = await respondScenario(t, { after: answeredWait('request-changes'), extra: { 'run respond run-1 *': { stderr, code } } });
    await f.script({ ...f.scenario, 'run show run-1': [{ json: f.paused }, { json: f.queued }] });
    const result = await f.respond('Owner says: change the scope.', ...CHANGES, '--feedback-stdin');
    assert.equal(result.exitCode, 1, stderr);
    assert.equal(result.report.outcome, 'uncertain');
    assert.equal(result.report.accepted, undefined);
    assert.equal(result.report.recorded, undefined);
    assert.match(result.report.rule, /Do not repeat it/);
    assert.equal(result.report.inspection.confirmed, false);
    assert.equal(result.report.inspection.run.status, 'queued', 'the observation is reported without claiming it');
    assert.equal(result.report.inspection.run.wait.response.decision, 'request-changes');
    const calls = await f.calls();
    assertReadsAfter(calls, 'run respond');
    assert.deepEqual(callNames(calls), ['run show', 'run respond', 'run show']);
    assert.ok(!result.text.includes('change the scope'), 'the feedback is not echoed');
  }
  const stdoutOnly = await respondScenario(t, { extra: { 'run respond run-1 *': { stdout: 'accepted\n' } } });
  assert.equal((await stdoutOnly.respond(undefined, ...APPROVE)).report.outcome, 'uncertain');
  assertReadsAfter(await stdoutOnly.calls(), 'run respond');
});

test('a respond that never left, or that the coordinator refused or does not know, is reported as such and never retried or replaced', async t => {
  const cases = [
    ['Heimdall: The coordinator at /x/coordinator.sock is unavailable: connect ENOENT /x/coordinator.sock. Nothing was sent.\n', 'not-sent'],
    ['Heimdall: The coordinator refused the response (409 approval-stale): The reviewed work changed. Nothing was recorded.\n', 'coordinator-refused'],
    ['Heimdall: The coordinator refused the response (503): Coordinator is draining. Nothing was recorded.\n', 'coordinator-refused'],
    ['Heimdall: The coordinator at /x/coordinator.sock refused authorization; check the coordinator key. Nothing was recorded.\n', 'coordinator-refused'],
    ['Heimdall: The coordinator at /x/coordinator.sock does not support this response operation (likely an older version). Nothing was sent to resume the run; Heimdall does not fall back to the unguarded "run resume".\n', 'coordinator-unsupported'],
    ['Heimdall: Unknown or repeated option: --request\n', 'coordinator-unsupported'],
  ];
  for (const [stderr, reason] of cases) {
    const f = await respondScenario(t, { extra: { 'run respond run-1 *': { stderr, code: 1 } } });
    const result = await f.respond(undefined, ...APPROVE);
    assert.equal(result.exitCode, 1, reason);
    assert.equal(result.report.outcome, 'refused');
    assert.equal(result.report.reason, reason, stderr);
    assert.equal(result.report.sent, true);
    assert.equal(result.report.inspection, undefined, 'nothing to look for');
    const calls = await f.calls();
    assert.deepEqual(callNames(calls), ['run show', 'run respond'], 'nothing follows the one respond');
    assert.equal(countOf(calls, 'run respond'), 1);
    assert.equal(countOf(calls, 'run resume'), 0, 'no fallback to the unguarded resume');
  }
  const refused = await respondScenario(t, { extra: { 'run respond run-1 *': { stderr: cases[1][0], code: 1 } } });
  assert.deepEqual((await refused.respond(undefined, ...APPROVE)).report.refusal, { status: 409, code: 'approval-stale' });
});

test('respond failure classification trusts only the exit status and the first diagnostic line', () => {
  const failed = (stderr, exitCode = 1, extra = {}) => ({ ok: false, kind: 'error', exitCode, stdout: '', stderr, message: `Command failed: heimdall --input=${stderr}`, ...extra });
  assert.equal(classifyRespondFailure({ ok: false, kind: 'not-installed', stdout: '', stderr: '', message: 'spawn heimdall ENOENT' }), 'not-sent');
  assert.equal(classifyRespondFailure(failed('Heimdall: The coordinator at /x is unavailable: connect ECONNREFUSED /x. Nothing was sent.\n')), 'not-sent');
  assert.equal(classifyRespondFailure(failed('Heimdall: The coordinator refused the response (409 pause-stale): stale. Nothing was recorded.\n')), 'rejected');
  assert.equal(classifyRespondFailure(failed('Heimdall: The coordinator refused the response (400): Invalid body. Nothing was recorded.\n')), 'rejected');
  assert.equal(classifyRespondFailure(failed('Heimdall: The coordinator at /x does not support this response operation (likely an older version). Nothing was sent.\n')), 'unsupported');
  assert.equal(classifyRespondFailure(failed('Heimdall: Unknown coordinator command; see --help\n')), 'unsupported');
  // Exit status 2 is the command line's own uncertain-delivery status, whatever the text says.
  assert.equal(classifyRespondFailure(failed('Heimdall: The coordinator refused the response (409 x): y. Nothing was recorded.\n', 2)), 'uncertain');
  assert.equal(classifyRespondFailure(failed('Heimdall: The response may or may not have been recorded: x\n', 2)), 'uncertain');
  for (const stderr of ['Heimdall: Coordinator unavailable: read ECONNRESET\n', 'Heimdall: Something new\n', '', 'Heimdall: Nothing was sent. The coordinator refused the response (409 x): y\n', 'Heimdall: The response may or may not have been recorded: x. Nothing was sent.\n']) {
    assert.equal(classifyRespondFailure(failed(stderr)), 'uncertain', stderr);
  }
  for (const [kind, exitCode] of [['timeout', null], ['aborted', null], ['response-too-large', null]]) assert.equal(classifyRespondFailure({ ok: false, kind, exitCode, stdout: '', stderr: '', message: '' }), 'uncertain');
  assert.equal(classifyRespondFailure(failed('Heimdall: The coordinator refused the response (409 x): y. Nothing was recorded.\n', null)), 'uncertain');
  // Text inside the process error message (it repeats the command line) cannot change the verdict.
  assert.equal(classifyRespondFailure(failed('Heimdall: Coordinator unavailable: read ECONNRESET\n', 1, { message: 'Command failed: --input=The coordinator refused the response (409 x): y. Nothing was recorded.' })), 'uncertain');
});

test('resume refuses a run with an unresolved typed approval and never turns resume or guidance into an approval', async t => {
  const waits = [
    ['a pending request', approvalWait(), 'owner-decision'],
    ['a recorded decision whose continuation is queued', answeredWait('approve'), 'wait'],
    ['a recorded decision waiting for idle proof', answeredWait('approve', { continuation: 'pending', progress: 'waiting-for-idle' }), 'wait'],
    ['a wait the helper cannot read', { kind: 'mystery' }, 'monitor'],
  ];
  for (const [name, wait, action] of waits) {
    for (const overrides of [{}, { status: 'running', capacityReserved: true }]) {
      const f = await respondScenario(t, { wait, overrides });
      await f.script({ ...f.scenario, 'run show run-1': { json: f.paused } });
      await f.reset();
      for (const words of ['continue', 'resume', 'go ahead and approve it']) {
        await fs.writeFile(path.join(f.cwd, 'guidance.txt'), words);
        const result = await f.resume(undefined, '--guidance-file', 'guidance.txt');
        assert.equal(result.exitCode, 1, name);
        assert.equal(result.report.outcome, 'refused', name);
        assert.equal(result.report.reason, 'approval-pending');
        assert.equal(result.report.next.action, action, name);
        assert.deepEqual(result.report.mutationsAttempted, []);
        if (action === 'owner-decision') assert.match(result.report.next.detail, /explicit approval, or explicit change feedback.*A request to resume or continue is not a decision/);
      }
      const calls = await f.calls();
      assertNoMutation(calls);
      assert.equal(calls.length, 3);
      assert.ok(!JSON.stringify(calls).includes('--decision'), 'no decision was ever sent');
      assert.ok(!JSON.stringify(calls).includes('--request'));
    }
  }
});

const PAUSE_B = 'pau_fedcba9876543210fedcba9876543210';

/** The helper read the run, refused, and the recorded argv holds one read and nothing that could carry the guidance anywhere. */
function assertRefusedBeforeAnyMutation(result, calls, reason, guidance) {
  assert.equal(result.exitCode, 1, result.text);
  assert.equal(result.report.outcome, 'refused');
  assert.equal(result.report.reason, reason);
  assert.equal(result.report.ok, false);
  assert.deepEqual(result.report.mutationsAttempted, []);
  assertNoMutation(calls);
  assert.deepEqual(calls.map(subcommand), [['run', 'show', 'run-1']]);
  assert.equal(countOf(calls, 'run resume'), 0);
  assert.equal(countOf(calls, 'run respond'), 0);
  assert.ok(!JSON.stringify(calls).includes(guidance), 'no guidance was sent anywhere');
  assert.ok(!result.text.includes(guidance), 'the guidance is not echoed');
}

test('resume refuses without a valid guarded pause identity: missing, null, superseded, unknown and malformed waits send nothing', async t => {
  const guidance = 'Use the second approach; GUIDANCE-MARKER.';
  const missing = (({ wait, ...rest }) => rest)(runRecord({ wait: genericWait() }));
  const cases = [
    ['no wait reported (an older coordinator)', missing, 'pause-identity-unavailable'],
    ['a null wait', runRecord({ wait: null }), 'pause-identity-unavailable'],
    ['a superseded request', runRecord({ wait: approvalWait({ state: 'superseded', continuation: 'superseded', progress: 'superseded' }) }), 'pause-identity-unavailable'],
    ['an unknown wait kind', runRecord({ wait: { kind: 'mystery' } }), 'approval-pending'],
    ['a wait that is not an object', runRecord({ wait: 'generic' }), 'approval-pending'],
    ['a generic pause without an identity', runRecord({ wait: { kind: 'generic' } }), 'pause-identity-unavailable'],
    ['a generic pause with a number as identity', runRecord({ wait: genericWait({ pauseId: 7 }) }), 'pause-identity-unavailable'],
    ['a generic pause with an empty identity', runRecord({ wait: genericWait({ pauseId: '' }) }), 'pause-identity-unavailable'],
    ['a generic pause with an identity that looks like an option', runRecord({ wait: genericWait({ pauseId: '--pause' }) }), 'pause-identity-unavailable'],
    ['a generic pause with a spaced identity', runRecord({ wait: genericWait({ pauseId: 'pau one' }) }), 'pause-identity-unavailable'],
  ];
  for (const [name, record, reason] of cases) {
    const f = await resumeScenario(t, { 'run show run-1': { json: record } });
    const result = await f.resume(guidance, '--guidance-stdin');
    assertRefusedBeforeAnyMutation(result, await f.calls(), reason, 'GUIDANCE-MARKER');
    if (reason === 'pause-identity-unavailable') {
      assert.match(result.report.message, /matching versions/, name);
      assert.match(result.report.message, /guarded response/, name);
      assert.match(result.report.message, /unguarded resume is not used/, name);
    }
  }
});

test('resume does not apply guidance written for one pause to another when the run advances after it was read', async t => {
  // The first read shows pause A at version 1 with no usable identity; the run then advances to pause B at version 3.
  // Both a resume and a respond are scripted to succeed, so any mutation would be recorded and reported as success.
  const pauseA = runRecord({ version: 1, reason: 'Pause A' });
  const pauseB = runRecord({ version: 3, reason: 'Pause B', wait: genericWait({ pauseId: PAUSE_B }) });
  const f = await resumeScenario(t, { 'run show run-1': [{ json: pauseA }, { json: pauseB }] });
  const result = await f.resume('Guidance written for pause A. GUIDANCE-MARKER', '--guidance-stdin');
  assertRefusedBeforeAnyMutation(result, await f.calls(), 'pause-identity-unavailable', 'GUIDANCE-MARKER');
  assert.equal(result.report.run.version, undefined, 'the report is of the pause that was read, not a later one');
});

test('resume with a guarded route sends the guidance only to the pause it read; a pause that advanced is left to the coordinator to refuse once', async t => {
  const stale = 'Heimdall: The coordinator refused the response (409 pause-stale): This is not the current pause of the run. Nothing was recorded.\n';
  const pauseA = runRecord({ version: 1, reason: 'Pause A', wait: genericWait() });
  const pauseB = runRecord({ version: 3, reason: 'Pause B', wait: genericWait({ pauseId: PAUSE_B }) });
  const unsupported = 'Heimdall: The coordinator at /x does not support this response operation (likely an older version). Nothing was sent to resume the run; Heimdall does not fall back to the unguarded "run resume".\n';
  for (const [stderr, outcome] of [[stale, 'rejected'], [unsupported, 'rejected']]) {
    const f = await resumeScenario(t, { 'run show run-1': [{ json: pauseA }, { json: pauseB }], 'run respond run-1 *': { stderr } });
    const result = await f.resume('Guidance for pause A.', '--guidance-stdin');
    assert.equal(result.report.outcome, outcome);
    assert.deepEqual(result.report.mutationsAttempted, ['run respond']);
    const calls = await f.calls();
    assert.deepEqual(sentRespond(calls), [['coordinator', 'run', 'respond', 'run-1', '--pause', PAUSE, '--input=Guidance for pause A.']], 'exactly one attempt, aimed at the pause that was read');
    assert.ok(!JSON.stringify(calls).includes(PAUSE_B), 'pause B is never targeted');
    assert.equal(countOf(calls, 'run resume'), 0, 'no unguarded resume after a refusal');
    assert.deepEqual(callNames(calls), ['run show', 'run respond']);
  }
});

test('resume answers a generic pause through the guarded response for exactly that pause, never as an approval', async t => {
  const texts = ['--use the second approach', 'line one\nline two "quoted" $(not run)\n', 'ação ✓'];
  for (const text of texts) {
    const f = await respondScenario(t, { wait: genericWait(), ack: pauseAck(), after: null });
    const result = await f.resume(text, '--guidance-stdin');
    assert.equal(result.exitCode, 0, result.stderr + result.text);
    const { report } = result;
    assert.equal(report.outcome, 'resumed');
    assert.equal(report.via, 'respond');
    assert.deepEqual(report.mutationsAttempted, ['run respond']);
    assert.equal(report.acknowledgement.pauseId, PAUSE);
    assert.deepEqual(report.preserved, { runId: true, worktreePath: true, branch: true, parentSessionId: true });
    assert.deepEqual(report.completedResults, { before: 1, after: 1 });
    const calls = await f.calls();
    assert.deepEqual(mutations(calls), ['run respond']);
    assert.deepEqual(callNames(calls), ['run show', 'run respond', 'run show']);
    assert.deepEqual(sentRespond(calls), [['coordinator', 'run', 'respond', 'run-1', '--pause', PAUSE, `--input=${text}`]]);
    assert.ok(!JSON.stringify(calls).includes('--decision') && !JSON.stringify(calls).includes('--request'), 'guidance is never sent as a decision');
    assert.ok(!mutations(calls).includes('run resume'));
  }
});

test('a guarded resume that fails is reported without falling back to the unguarded resume, and long guidance is refused locally', async t => {
  const failures = [
    ['Heimdall: The coordinator at /x is unavailable: connect ENOENT /x. Nothing was sent.\n', 1, 'not-resumed'],
    ['Heimdall: The coordinator refused the response (409 pause-stale): This is not the current pause of the run. Nothing was recorded.\n', 1, 'rejected'],
    ['Heimdall: The coordinator at /x does not support this response operation (likely an older version). Nothing was sent to resume the run; Heimdall does not fall back to the unguarded "run resume".\n', 1, 'rejected'],
    ['Heimdall: The response may or may not have been recorded: read ECONNRESET. Do not retry blindly.\n', 2, 'uncertain'],
    ['Heimdall: Something unexpected\n', 1, 'uncertain'],
  ];
  for (const [stderr, code, outcome] of failures) {
    const f = await respondScenario(t, { wait: genericWait(), extra: { 'run respond run-1 *': { stderr, code }, 'run show run-1': [{ json: runRecord({ wait: genericWait() }) }, { json: runRecord({ status: 'queued', wait: null }) }] } });
    const result = await f.resume('Use json.', '--guidance-stdin');
    assert.equal(result.exitCode, 1, stderr);
    assert.equal(result.report.outcome, outcome, stderr);
    const calls = await f.calls();
    assert.equal(countOf(calls, 'run respond'), 1);
    assert.deepEqual(sentRespond(calls), [['coordinator', 'run', 'respond', 'run-1', '--pause', PAUSE, '--input=Use json.']]);
    assert.equal(countOf(calls, 'run resume'), 0, 'no fallback to the unguarded resume');
    if (outcome === 'uncertain') { assert.match(result.report.rule, /Do not repeat it/); assertReadsAfter(calls, 'run respond'); }
    else assert.deepEqual(callNames(calls), ['run show', 'run respond']);
  }
  // Long guidance is refused locally, before anything is sent.
  const long = 'g'.repeat(RESPONSE_INPUT_LIMIT + 1);
  const guarded = await respondScenario(t, { wait: genericWait() });
  const refused = await guarded.resume(long, '--guidance-stdin');
  assert.equal(refused.report.outcome, 'refused');
  assert.equal(refused.report.reason, 'guidance-too-long');
  assert.deepEqual(callNames(await guarded.calls()), ['run show']);
  assert.deepEqual(refused.report.mutationsAttempted, []);
});

// --- respond against a real coordinator ----------------------------------------------------------------------

test('approve through the real command line and coordinator records the decision once and queues the same run', async t => {
  const f = await coordinatorFixture(t, { admission: true });
  const { requestId } = f.saveWaiting('run-approval', { approval: true });
  const configFlag = ['--coordinator-config', f.configFile];
  await f.reset();
  const snapshot = await runHelper(['snapshot', 'run-approval', '--cwd', f.linked, ...configFlag], f.env);
  assert.equal(snapshot.report.run.wait.kind, 'approval');
  assert.equal(snapshot.report.run.wait.requestId, requestId);
  assert.equal(snapshot.report.run.wait.state, 'pending');
  assert.equal(snapshot.report.run.wait.question, 'Ship the migration?');
  assertNoMutation(await f.calls());
  const before = f.state();
  await f.reset();

  const result = await runHelper(['respond', 'run-approval', '--cwd', f.linked, '--request', requestId, '--decision', 'approve', ...configFlag], f.env);
  assert.equal(result.exitCode, 0, result.stderr + result.text);
  assert.equal(result.report.outcome, 'queued');
  assert.equal(result.report.run.status, 'queued');
  assert.equal(result.report.run.wait.response.decision, 'approve');
  assert.equal(f.approvalRow(requestId).decision, 'approve');
  assert.equal(f.approvalRow(requestId).state, 'answered');
  const calls = await f.calls();
  assert.deepEqual(mutations(calls), ['run respond']);
  assert.deepEqual(callNames(calls), ['run show', 'run respond', 'run show']);
  assert.equal(f.service.store.getRun('run-approval').launchAction, 'resume');
  assert.equal(f.service.store.getRun('run-approval').version, before.runs.find(run => run.id === 'run-approval').version + 1);
  assert.equal(f.launches.length, 0);

  // The decision is recorded: another respond is refused locally and a resume cannot replace it.
  await f.reset();
  const again = await runHelper(['respond', 'run-approval', '--cwd', f.linked, '--request', requestId, '--decision', 'request-changes', '--feedback-stdin', ...configFlag], f.env, { stdin: Readable.from([Buffer.from('too late')]) });
  assert.equal(again.report.reason, 'already-answered');
  const resumed = await runHelper(['resume', 'run-approval', '--cwd', f.linked, '--guidance-stdin', ...configFlag], f.env, { stdin: Readable.from([Buffer.from('continue')]) });
  assert.equal(resumed.report.outcome, 'refused');
  assert.equal(resumed.report.reason, 'approval-pending');
  assertNoMutation(await f.calls());
  assert.equal(f.approvalRow(requestId).decision, 'approve');
});

test('requested changes reach the real coordinator verbatim, however awkward the feedback', async t => {
  const f = await coordinatorFixture(t, { admission: true });
  const feedbacks = ['--keep the scope small\n"quoted" and \'single\'\n- bullet $(not run)\n', 'ação ✓ — unicode\r\nCRLF line\n'];
  const requests = feedbacks.map((_, index) => f.saveWaiting(`run-changes-${index}`, { approval: true }).requestId);
  for (const [index, feedback] of feedbacks.entries()) {
    const requestId = requests[index];
    await fs.writeFile(path.join(f.linked, 'feedback.txt'), feedback);
    await f.reset();
    const result = await runHelper(['respond', `run-changes-${index}`, '--cwd', f.linked, '--request', requestId, '--decision', 'request-changes', '--feedback-file', 'feedback.txt', '--coordinator-config', f.configFile], f.env);
    assert.equal(result.exitCode, 0, result.stderr + result.text);
    assert.equal(result.report.outcome, 'queued');
    const row = f.approvalRow(requestId);
    assert.equal(row.decision, 'request-changes');
    assert.equal(row.feedback, feedback, 'stored byte for byte');
    assert.equal(countOf(await f.calls(), 'run respond'), 1);
    assert.ok(!result.text.includes('quoted'), 'the feedback is not echoed');
  }
});

test('a decision recorded while the coordinator does not admit work is reported as waiting for idle proof, not as queued', async t => {
  const f = await coordinatorFixture(t);
  const { requestId } = f.saveWaiting('run-waiting', { approval: true });
  await f.reset();
  const result = await runHelper(['respond', 'run-waiting', '--cwd', f.linked, '--request', requestId, '--decision', 'approve', '--coordinator-config', f.configFile], f.env);
  assert.equal(result.exitCode, 0, result.stderr + result.text);
  assert.equal(result.report.outcome, 'waiting-for-idle');
  assert.equal(result.report.run.status, 'paused');
  assert.equal(result.report.run.wait.state, 'answered');
  assert.equal(result.report.run.wait.continuation, 'pending');
  assert.match(result.report.note, /Nothing is running yet, and the task is not complete/);
  assert.equal(f.approvalRow(requestId).decision, 'approve');
  assert.equal(countOf(await f.calls(), 'run respond'), 1);
  assert.equal(f.launches.length, 0);
});

test('respond refuses a request of another run and a stale display, and the real coordinator is unchanged', async t => {
  const f = await coordinatorFixture(t);
  const first = f.saveWaiting('run-first', { approval: true });
  const second = f.saveWaiting('run-second', { approval: true });
  const before = f.state();
  await f.reset();
  const configFlag = ['--coordinator-config', f.configFile];
  const wrongRun = await runHelper(['respond', 'run-first', '--cwd', f.linked, '--request', second.requestId, '--decision', 'approve', ...configFlag], f.env);
  assert.equal(wrongRun.report.reason, 'request-mismatch');
  const asPause = await runHelper(['respond', 'run-first', '--cwd', f.linked, '--pause', 'pau_0123456789abcdef0123456789abcdef', '--guidance-stdin', ...configFlag], f.env, { stdin: Readable.from([Buffer.from('go')]) });
  assert.equal(asPause.report.reason, 'approval-pending');
  const bare = await runHelper(['resume', 'run-first', '--cwd', f.linked, '--guidance-stdin', ...configFlag], f.env, { stdin: Readable.from([Buffer.from('resume')]) });
  assert.equal(bare.report.reason, 'approval-pending');
  assertNoMutation(await f.calls());
  assert.deepEqual(f.state(), before);
  assert.equal(f.approvalRow(first.requestId).state, 'pending');
});

test('resume answers a real generic pause through the guarded response and keeps the run', async t => {
  const f = await coordinatorFixture(t);
  const { run: paused } = f.saveWaiting('run-generic', { approval: false });
  const checkpoint = structuredClone(paused.checkpoint);
  const guidance = '--use the second approach\nand keep $(cwd) literal "quoted"\n';
  await fs.writeFile(path.join(f.linked, 'guidance.txt'), guidance);
  const configFlag = ['--coordinator-config', f.configFile];
  await f.reset();
  const snapshot = await runHelper(['snapshot', 'run-generic', '--cwd', f.linked, ...configFlag], f.env);
  assert.equal(snapshot.report.run.wait.kind, 'generic');
  assert.match(snapshot.report.run.wait.pauseId, /^pau_[0-9a-f]{32}$/);
  assertNoMutation(await f.calls());
  await f.reset();

  const result = await runHelper(['resume', 'run-generic', '--cwd', f.linked, '--guidance-file', 'guidance.txt', ...configFlag], f.env);
  assert.equal(result.exitCode, 0, result.stderr + result.text);
  assert.equal(result.report.outcome, 'resumed');
  assert.equal(result.report.via, 'respond');
  assert.deepEqual(result.report.preserved, { runId: true, worktreePath: true, branch: true, parentSessionId: true });
  const after = f.service.store.getRun('run-generic');
  assert.equal(after.status, 'queued');
  assert.equal(after.launchAction, 'resume');
  assert.equal(after.worktreePath, paused.worktreePath);
  assert.equal(after.branch, paused.branch);
  assert.deepEqual(after.checkpoint, checkpoint, 'the checkpoint and accepted results are untouched');
  assert.ok(after.resolution.includes(guidance), 'the guidance arrives verbatim');
  assert.match(after.resolution, /not a typed approval/);
  const calls = await f.calls();
  assert.deepEqual(mutations(calls), ['run respond']);
  assert.deepEqual(f.sql('SELECT run_id FROM run_responses').map(row => row.run_id), ['run-generic']);
  assert.equal(f.sql('SELECT COUNT(*) AS n FROM approval_requests')[0].n, 0, 'guidance never becomes an approval');
});
