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
import { startCoordinatorService } from '../dist/coordinator/service.js';
import { loadCoordinatorConfiguration } from '../dist/coordinator/config.js';
import {
  GUIDANCE_HEADER, MAX_GUIDANCE_BYTES, MAX_SPEC_BYTES, UsageError, classifyMutationFailure, main, parseArguments, runIdCandidates,
} from '../skills/openheimdall-start/scripts/openheimdall.mjs';

const exec = promisify(execFile);
const checkout = fileURLToPath(new URL('..', import.meta.url));
const skillDirectories = ['openheimdall-start', 'openheimdall-monitor', 'openheimdall-resume'].map(name => path.join(checkout, 'skills', name));
const helperPath = directory => path.join(directory, 'scripts', 'openheimdall.mjs');
const helperFile = helperPath(skillDirectories[0]);
const distCli = path.join(checkout, 'dist', 'cli.js');

const READ_ONLY = /^(status --json|project list|run list|run show [A-Za-z0-9_-]+)$/;
const MUTATING = [['project', 'add'], ['run', 'submit'], ['run', 'resume'], ['run', 'reconcile'], ['start'], ['stop']];

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
  const paused = runRecord();
  const queued = runRecord({ status: 'queued', launchAction: 'resume', reason: null, version: 4 });
  const scenario = { 'run show run-1': [{ json: paused }, { json: queued }], 'run resume run-1 *': { json: queued }, ...extra };
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

test('resume sends guidance verbatim in one labeled message, however awkward the text', async t => {
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
    assert.equal(result.exitCode, 0, `${JSON.stringify(text.slice(0, 40))}: ${result.stderr}${result.text}`);
    assert.equal(result.report.outcome, 'resumed');
    assert.equal(result.report.guidance.bytes, Buffer.byteLength(text));
    assert.ok(!result.text.includes(text.slice(0, 30)) || text.length < 30, `the guidance is not echoed: ${JSON.stringify(text.slice(0, 40))}`);
    const calls = await f.calls();
    assert.equal(countOf(calls, 'run resume'), 1);
    assert.deepEqual(mutations(calls), ['run resume']);
    const resume = calls.find(argv => verbOf(argv) === 'run resume');
    assert.deepEqual(resume.slice(0, 5), ['coordinator', 'run', 'resume', 'run-1', '--input']);
    assert.equal(resume[5], `${GUIDANCE_HEADER}\n${text}`, 'header line, then the guidance byte for byte');
    assert.ok(!resume[5].startsWith('-'), 'the value can never be read as an option');
    assert.equal(resume.length, 6);
    assert.deepEqual(calls.map(argv => subcommand(argv).slice(0, 2).join(' ')), ['run show', 'run resume', 'run show']);
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
  const resume = (await f.calls()).find(argv => verbOf(argv) === 'run resume');
  assert.equal(resume[5], `${GUIDANCE_HEADER}\n${guidance}`);
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
  assert.match(report.note, /not running until it is admitted/);
  for (const secret of SECRETS) assert.ok(!result.text.includes(secret), secret);

  // The follow-up read failing does not undo the acceptance; the answer to the resume itself is reported.
  await f.script({ ...f.scenario, 'run show run-1': [{ json: f.paused }, { stderr: 'Heimdall: Coordinator unavailable: read ECONNRESET\n' }] });
  await f.reset();
  const degraded = await f.resume('Pick option B.', '--guidance-stdin');
  assert.equal(degraded.report.outcome, 'resumed');
  assert.equal(degraded.report.confirmation.available, false);
  assert.equal((await f.calls()).filter(argv => verbOf(argv) === 'run resume').length, 1);
});

test('a lost resume response is uncertain: one resume, read-only inspection, no retry', async t => {
  const f = await resumeScenario(t);
  for (const stderr of ['Heimdall: Coordinator unavailable: read ECONNRESET\n', 'Heimdall: Coordinator unavailable: Coordinator request timed out\n', 'Heimdall: Invalid coordinator JSON response\n', 'Heimdall: Something unexpected\n']) {
    await f.script({ ...f.scenario, 'run resume run-1 *': { stderr }, 'run show run-1': [{ json: f.paused }, { json: f.queued }] });
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
    assertReadsAfter(calls, 'run resume');
    assert.deepEqual(calls.map(argv => subcommand(argv).slice(0, 2).join(' ')), ['run show', 'run resume', 'run show']);
    assert.ok(!result.text.includes('go ahead'), 'the guidance is not echoed');
  }
  await f.script({ ...f.scenario, 'run resume run-1 *': { stdout: 'accepted\n' } });
  await f.reset();
  assert.equal((await f.resume('x', '--guidance-stdin')).report.outcome, 'uncertain');
  assertReadsAfter(await f.calls(), 'run resume');
});

test('a resume that never left, or that the coordinator refused, is reported as such', async t => {
  const f = await resumeScenario(t);
  await f.script({ ...f.scenario, 'run resume run-1 *': { stderr: 'Heimdall: Coordinator unavailable: connect ECONNREFUSED /x\n' } });
  await f.reset();
  let result = await f.resume('go', '--guidance-stdin');
  assert.equal(result.report.outcome, 'not-resumed');
  assert.deepEqual((await f.calls()).map(argv => subcommand(argv).slice(0, 2).join(' ')), ['run show', 'run resume']);

  const guard = 'Only a confirmed idle paused run may be resumed';
  await f.script({ ...f.scenario, 'run resume run-1 *': { stderr: `Heimdall: ${guard}\n` } });
  await f.reset();
  result = await f.resume('go', '--guidance-stdin');
  assert.equal(result.report.outcome, 'rejected');
  assert.equal(result.report.message, guard);
  assert.equal(countOf(await f.calls(), 'run resume'), 1);
});

// --- Helper against an in-process coordinator --------------------------------------------------------------

const specification = {
  settings: { plannerAgent: 'planner', executorAgent: 'executor', plannerModel: 'anthropic/planner', executorModel: 'anthropic/executor', executorFallbackModel: 'kimi/fallback', maxTasks: 10, minQuotaRemainingPercent: 10, tokenLimitsDisabled: true },
  plannerPrompt: 'PRIVATE-PLANNER-PROMPT', executorPrompt: 'PRIVATE-EXECUTOR-PROMPT', agents: {},
  opencode: { baseUrl: 'http://127.0.0.1:9999', passwordEnvironmentVariable: 'SYNTHETIC_PASSWORD' },
};
const PROJECT_CONFIGURATION = '[workflow]\nplannerModel = "anthropic/fixture"\nexecutorModel = "anthropic/fixture"\nexecutorFallbackModel = "openai/fixture"\n[opencode]\nbaseUrl = "http://127.0.0.1:4096"\n';

async function coordinatorFixture(t) {
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
  const service = await startCoordinatorService({ configuration, executor, pollIntervalMs: 60000, scheduler: { verifyWorktree: async () => {} } });
  service.scheduler.pauseAdmission();
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
  const state = () => ({ runs: service.store.listRuns(), events: service.store.events(), counts: service.store.statusCounts(), projects: service.store.listProjects() });
  return {
    root, env, configFile, repository, linked, project, service, enqueue, admit, savePaused, state, registerRepository,
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

test('resume through the real coordinator keeps the run, checkout, parent session and completed results', async t => {
  const f = await coordinatorFixture(t);
  const paused = f.savePaused('run-paused');
  assert.equal(paused.status, 'paused');
  assert.equal(paused.capacityReserved, false);
  const checkpoint = structuredClone(paused.checkpoint);
  assert.equal(checkpoint.results.length, 1);
  assert.ok(paused.binding);
  await fs.writeFile(path.join(f.linked, 'guidance.txt'), '--use the second approach\nand keep $(cwd) literal "quoted"\n');
  const message = `${GUIDANCE_HEADER}\n--use the second approach\nand keep $(cwd) literal "quoted"\n`;
  await f.reset();

  const result = await runHelper(['resume', 'run-paused', '--cwd', f.linked, '--guidance-file', 'guidance.txt', '--coordinator-config', f.configFile], f.env);
  assert.equal(result.exitCode, 0, result.stderr + result.text);
  const { report } = result;
  assert.equal(report.outcome, 'resumed');
  assert.equal(report.runId, 'run-paused');
  assert.equal(report.status, 'queued');
  assert.deepEqual(report.preserved, { runId: true, worktreePath: true, branch: true, parentSessionId: true });
  assert.deepEqual(report.completedResults, { before: 1, after: 1 });
  for (const secret of [...SECRETS, 'PRIVATE-PLANNER-PROMPT']) assert.ok(!result.text.includes(secret), secret);

  const after = f.service.store.getRun('run-paused');
  assert.equal(after.id, paused.id);
  assert.equal(after.worktreePath, paused.worktreePath);
  assert.equal(after.branch, paused.branch);
  assert.equal(after.parentSessionId, paused.parentSessionId);
  assert.equal(after.status, 'queued');
  assert.equal(after.launchAction, 'resume');
  assert.equal(after.resolution, message, 'the labeled message arrives verbatim as the resolution');
  assert.deepEqual(after.checkpoint, checkpoint, 'the checkpoint and its completed results are untouched');
  assert.deepEqual(after.binding, paused.binding);
  assert.equal(after.version, paused.version + 1);
  assert.equal(f.service.store.listRuns().length, 1);
  assert.equal(f.launches.length, 0);

  const calls = await f.calls();
  assert.deepEqual(calls.map(argv => subcommand(argv).slice(0, 2).join(' ')), ['run show', 'run resume', 'run show']);
  assert.equal(countOf(calls, 'run resume'), 1);
  const resume = calls.find(argv => verbOf(argv) === 'run resume');
  assert.equal(resume[5], message);

  // The run is queued now, so a second resume is refused locally and sends nothing.
  await f.reset();
  const again = await runHelper(['resume', 'run-paused', '--cwd', f.linked, '--guidance-file', 'guidance.txt', '--coordinator-config', f.configFile], f.env);
  assert.equal(again.report.outcome, 'not-resumable');
  assert.equal(again.report.run.status, 'queued');
  assertNoMutation(await f.calls());
  assert.equal(f.service.store.getRun('run-paused').version, after.version);
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

test('a guard rejection from the real coordinator is reported verbatim and nothing is retried', async t => {
  const f = await coordinatorFixture(t);
  const paused = f.savePaused('run-busy');
  f.observe({ idle: false, status: 'running' });
  await fs.writeFile(path.join(f.linked, 'guidance.txt'), 'Go ahead.');
  const before = f.state();
  await f.reset();
  const result = await runHelper(['resume', 'run-busy', '--cwd', f.linked, '--guidance-file', 'guidance.txt', '--coordinator-config', f.configFile], f.env);
  assert.equal(result.exitCode, 1);
  assert.equal(result.report.outcome, 'rejected');
  assert.equal(result.report.message, 'Native parent and children must be confirmed idle before resume');
  const calls = await f.calls();
  assert.equal(countOf(calls, 'run resume'), 1);
  assert.deepEqual(calls.map(argv => subcommand(argv).slice(0, 2).join(' ')), ['run show', 'run resume']);
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
