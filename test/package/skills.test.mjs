import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  buildTarball, checkout, installConsumer, installGlobal, isolatedEnvironment, removeTarballBuild, runBinary, runProcess, toolVersions,
} from './helpers.mjs';

/*
 * The skills shipped in the tarball, as installed by plain npm commands. Each installed skill directory is copied on its own
 * into a temporary personal skills directory and a temporary project `.opencode/skills` directory, the way a user would install
 * it by hand, and the copied helper is run from that location against the installed `heimdall` binary and an isolated,
 * unavailable coordinator. Hosts that load skills are not exercised here.
 */

const skillNames = ['openheimdall-start', 'openheimdall-monitor', 'openheimdall-resume'];
const skillFiles = ['SKILL.md', 'scripts/openheimdall.mjs'];
const lifecycleScripts = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare', 'prepack', 'postpack'];

// Short root: the default coordinator state directory must stay within the portable Unix socket path limit.
async function shortDirectory() {
  const base = await fs.access('/tmp').then(() => '/tmp', () => os.tmpdir());
  return await fs.realpath(await fs.mkdtemp(path.join(base, 'hs-')));
}

function syntheticProject(directory, home) {
  const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: directory, env, stdio: 'pipe' });
  git('init', '--quiet');
  git('commit', '--quiet', '--allow-empty', '-m', 'initial');
}

// Every path below a directory with its type, so a before/after comparison shows any created, removed or retyped entry.
async function tree(directory) {
  const found = [];
  const visit = async current => {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const location = path.join(current, entry.name);
      found.push(`${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f'} ${path.relative(directory, location)}`);
      if (entry.isDirectory()) await visit(location);
    }
  };
  await visit(directory);
  return found.sort();
}

const REQUEST = 'apr_pkg_0001';
const PAUSE = 'pau_0123456789abcdef0123456789abcdef';
// A request longer than the compact wait shows: a scope action after character 1,500 and list entries after the tenth.
const LATE_SCOPE = `Authorizes the reviewed commit only. ${'Nothing else is touched. '.repeat(70)}LATE-ACTION-AFTER-1500: also drop the legacy table.`;
const LATE_CHECKS = Array.from({ length: 14 }, (_, index) => `check-${index}: passed${index === 12 ? ' LATE-CHECK-ENTRY-12' : ''}`);
const LATE_APPROVE = Array.from({ length: 12 }, (_, index) => (index === 11 ? 'LATE-APPROVE-ENTRY-11: purge the cache' : `approve-step-${index}`));
const FULL_REVISION = { head: 'a'.repeat(40), digest: 'b'.repeat(64) };

/**
 * A stand-in coordinator on a Unix socket, with the coordinator key file the installed command line reads. It records every
 * request. `kind` chooses the pause it reports: a typed approval request or a generic pause. After the one response it
 * accepts, it reports the run queued with the answered request. `drop` closes the connection on a response without answering.
 */
async function stubCoordinator(root, name, { kind = 'approval', drop = false } = {}) {
  const directory = path.join(root, name);
  const state = path.join(directory, 's');
  await fs.mkdir(state, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(state, 'coordinator.key'), 'd'.repeat(64), { mode: 0o600 });
  const configFile = path.join(directory, 'coordinator.toml');
  await fs.writeFile(configFile, '[coordinator]\nstateDirectory = "s"\n');
  const requests = [];
  let answered = null;
  const record = () => ({
    id: 'run-1', projectId: 'project-pkg', status: answered ? 'queued' : 'paused', capacityReserved: false, version: answered ? 4 : 3, branch: 'heimdall/run/run-1',
    worktreePath: '/synthetic/worktrees/run-1/checkout', baseCommit: 'a'.repeat(40), parentSessionId: 'ses_parent', launchAction: answered ? 'resume' : 'start', createdAt: 1700000000000, updatedAt: 1700000100000,
    reason: 'Approval required', checkpoint: { phase: 'executor', index: 1, status: 'paused', tasks: [{ id: 'T1', title: 'First' }, { id: 'T2', title: 'Second' }], results: [{ taskId: 'T1' }] },
    wait: kind === 'approval'
      ? { kind: 'approval', requestId: REQUEST, state: answered ? 'answered' : 'pending', continuation: answered ? 'queued' : 'none', progress: answered ? 'queued' : 'none', taskId: 'T2', taskTitle: 'Second', question: 'Ship the migration?', scope: 'Only the reviewed commit', completedWork: 'Migration written', verification: ['tests pass'], artifacts: ['src/migrate.ts'], onApprove: ['merge'], onRequestChanges: ['fix'], revision: { head: 'a'.repeat(40), digest: 'b'.repeat(64) }, response: answered ? { decision: answered.decision, feedback: answered.feedback ?? null, answeredAt: 2 } : null, clipped: {} }
      : (answered ? null : { kind: 'generic', pauseId: PAUSE, reason: 'Needs an owner decision', reasonClipped: false }),
  });
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      const entry = { method: request.method, url: request.url, body: text ? JSON.parse(text) : undefined };
      requests.push(entry);
      const reply = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (request.method === 'GET' && request.url === '/runs/run-1') { reply(200, record()); return; }
      if (request.method === 'GET' && request.url === `/runs/run-1/approvals/${REQUEST}`) {
        if (kind !== 'approval') { reply(404, { error: 'Approval request not found', code: 'approval-not-found' }); return; }
        // The coordinator's own wire shape: the request content nested, the decision and feedback beside it.
        reply(200, {
          requestId: REQUEST, runId: 'run-1', state: answered ? 'answered' : 'pending', continuation: answered ? 'queued' : 'none', progress: answered ? 'queued' : 'none',
          taskId: 'T2', taskIndex: 1, attemptId: 'attempt_pkg_1', revision: FULL_REVISION, createdAt: 1700000000000,
          request: { question: 'Ship the migration?', scope: LATE_SCOPE, completedWork: 'Migration written', verification: LATE_CHECKS, artifacts: ['src/migrate.ts'], onApprove: LATE_APPROVE, onRequestChanges: ['fix'] },
          decision: answered ? answered.decision ?? null : null, feedback: answered ? answered.feedback ?? null : null, answeredAt: answered ? 2 : null,
        });
        return;
      }
      if (request.method === 'POST' && (request.url === `/runs/run-1/approvals/${REQUEST}/decision` || request.url === '/runs/run-1/respond')) {
        if (drop) { request.socket.destroy(); return; }
        answered = request.url.endsWith('/decision') ? { decision: entry.body.decision, feedback: entry.body.feedback } : { input: entry.body.input };
        const ack = { runId: 'run-1', recordedAt: 1760000000000, retried: false, continuation: 'queued', run: { status: 'queued', version: 4 } };
        reply(200, request.url.endsWith('/decision') ? { ...ack, requestId: REQUEST, decision: entry.body.decision } : { ...ack, pauseId: entry.body.pauseId });
        return;
      }
      reply(404, { error: 'Unknown coordinator route' });
    });
  });
  await new Promise(resolve => server.listen(path.join(state, 'coordinator.sock'), resolve));
  return {
    configFile, requests,
    lines: () => requests.map(entry => `${entry.method} ${entry.url}`),
    close: async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
  };
}

// Copies one skill directory to a target that must not exist, which is how installing a skill by hand works.
async function copySkill(source, target) {
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true, errorOnExist: true, force: false });
}

describe('installed skills', () => {
  let build;
  let environment;
  let work;
  const projects = {};
  const installs = {};

  before(async () => {
    build = await buildTarball();
    work = await shortDirectory();
    environment = await isolatedEnvironment(work);
    const elsewhere = path.join(work, 'elsewhere');
    await fs.mkdir(elsewhere);
    installs.consumer = await installConsumer(build.tarball, { env: environment.env, directory: path.join(work, 'consumer') });
    installs.global = await installGlobal(build.tarball, { env: environment.env, prefix: path.join(work, 'global-prefix'), cwd: elsewhere });
    for (const layout of ['consumer', 'global']) {
      projects[layout] = path.join(work, `project-${layout}`);
      await fs.mkdir(projects[layout]);
      syntheticProject(projects[layout], environment.home);
    }
  });

  after(async () => {
    await fs.rm(work, { recursive: true, force: true });
    await removeTarballBuild();
  });

  test('the tarball inventory lists exactly the six skill files', async t => {
    t.diagnostic(`environment: ${await toolVersions(environment.env)}`);
    const packed = build.files.filter(file => file.startsWith('skills/'));
    for (const file of packed) t.diagnostic(`packed ${file}`);
    const expected = skillNames.flatMap(name => skillFiles.map(file => `skills/${name}/${file}`)).sort();
    assert.deepEqual(packed, expected);
  });

  test('the tarball ships the modules behind run respond that the installed skills call', () => {
    for (const file of ['dist/coordinator/respond.js', 'dist/coordinator/pause.js', 'dist/coordinator/cli.js', 'dist/coordinator/approval-read.js', 'dist/coordinator/approval-view.js']) assert.ok(build.files.includes(file), `${file} is packed`);
    assert.equal(build.files.filter(file => file.startsWith('skills/')).length, 6, 'no skill gained a file');
  });

  test('no npm lifecycle script installs or references skills', async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(installs.consumer.root, 'package.json'), 'utf8'));
    assert.ok(manifest.files.includes('skills'));
    for (const [name, script] of Object.entries(manifest.scripts ?? {})) {
      assert.doesNotMatch(script, /skills?\b/i, `script ${name} must not reference skills`);
    }
    for (const name of lifecycleScripts) {
      if (manifest.scripts?.[name] !== undefined) assert.doesNotMatch(manifest.scripts[name], /skill|\.opencode|\.config/i, `lifecycle script ${name}`);
    }
  });

  for (const layout of ['consumer', 'global']) {
    describe(`${layout} installation`, () => {
      const install = () => installs[layout];
      const project = () => projects[layout];
      const env = extra => ({ ...environment.env, HEIMDALL_BIN: install().bin, ...extra });

      test('each installed skill directory is complete, regular files only', async () => {
        for (const name of skillNames) {
          const directory = path.join(install().root, 'skills', name);
          assert.deepEqual(await tree(directory), ['d scripts', 'f SKILL.md', 'f scripts/openheimdall.mjs']);
          const skill = await fs.readFile(path.join(directory, 'SKILL.md'), 'utf8');
          assert.match(skill, new RegExp(`^---\\nname: ${name}\\n`));
        }
        const [first, ...rest] = await Promise.all(skillNames.map(name => fs.readFile(path.join(install().root, 'skills', name, 'scripts', 'openheimdall.mjs'))));
        for (const copy of rest) assert.ok(first.equals(copy), 'helper copies are identical');
      });

      test('installing skills copies each directory independently and runs nothing from npm', async t => {
        const personal = path.join(work, `${layout}-personal`, 'skills');
        const projectSkills = path.join(project(), '.opencode', 'skills');
        for (const name of skillNames) {
          const source = path.join(install().root, 'skills', name);
          for (const target of [path.join(personal, name), path.join(projectSkills, name)]) {
            await copySkill(source, target);
            assert.deepEqual(await tree(target), await tree(source));
            // A second copy onto an installed skill is refused, so an existing skill is never overwritten.
            await assert.rejects(copySkill(source, target), { code: 'ERR_FS_CP_EEXIST' });
          }
        }
        assert.deepEqual((await fs.readdir(personal)).sort(), [...skillNames].sort());
        assert.deepEqual((await fs.readdir(projectSkills)).sort(), [...skillNames].sort());
        // Neither npm installation placed anything in the isolated HOME's skills locations.
        for (const candidate of ['.config/opencode', '.opencode', '.claude', '.agents']) {
          await assert.rejects(fs.access(path.join(environment.home, candidate)), { code: 'ENOENT' }, `${candidate} is not created by installation`);
        }
        t.diagnostic(`${layout}: copied ${skillNames.length} skills to ${personal} and ${projectSkills}`);
      });

      test('the installed helpers and command line document the same respond syntax', async () => {
        const cli = await runBinary(install(), ['coordinator', '--help'], { cwd: work, env: env() });
        assert.equal(cli.status, 0, cli.stderr);
        for (const line of [
          'heimdall coordinator run respond RUN_ID --request REQUEST_ID --decision approve',
          'heimdall coordinator run respond RUN_ID --request REQUEST_ID --decision request-changes --input FEEDBACK',
          'heimdall coordinator run respond RUN_ID --pause PAUSE_ID --input GUIDANCE',
          'heimdall coordinator run approval RUN_ID --request REQUEST_ID',
        ]) assert.ok(cli.stdout.includes(line), line);
        for (const name of skillNames) {
          const helper = path.join(install().root, 'skills', name, 'scripts', 'openheimdall.mjs');
          const help = await runProcess(process.execPath, [helper, '--help'], { cwd: work, env: env() });
          assert.equal(help.status, 0, help.stderr);
          for (const line of [
            'openheimdall.mjs respond  RUN_ID --request ID --decision approve',
            'openheimdall.mjs respond  RUN_ID --request ID --decision request-changes (--feedback-file FILE | --feedback-stdin)',
            'openheimdall.mjs respond  RUN_ID --pause ID (--guidance-file FILE | --guidance-stdin)',
            'openheimdall.mjs request  RUN_ID --request ID',
          ]) assert.ok(help.stdout.includes(line), `${name}: ${line}`);
          // Incomplete or ambiguous arguments are a usage error, never a request.
          const usage = await runProcess(process.execPath, [helper, 'respond', 'run-1', '--request', REQUEST, '--cwd', work], { cwd: work, env: env() });
          assert.equal(usage.status, 2, name);
          assert.match(usage.stderr, /--request requires --decision/);
        }
      });

      test('respond runs through the installed command line against the selected coordinator, with the text as data and no input file', async t => {
        const stubs = await shortDirectory();
        t.after(() => fs.rm(stubs, { recursive: true, force: true }));
        const selected = await stubCoordinator(stubs, 'selected');
        const ambient = await stubCoordinator(stubs, 'ambient');
        t.after(async () => { await selected.close(); await ambient.close(); });
        const empty = path.join(stubs, 'empty cwd');
        await fs.mkdir(empty);
        const helper = path.join(install().root, 'skills', 'openheimdall-resume', 'scripts', 'openheimdall.mjs');
        // The environment names one coordinator; the flag names another. The flag wins, as it does for the command line itself.
        const withAmbient = env({ HEIMDALL_COORDINATOR_CONFIG: ambient.configFile });
        const flag = ['--coordinator-config', selected.configFile];

        const approve = await runProcess(process.execPath, [helper, 'respond', 'run-1', '--cwd', empty, '--request', REQUEST, '--decision', 'approve', ...flag], { cwd: empty, env: withAmbient });
        assert.equal(approve.status, 0, approve.stderr + approve.stdout);
        assert.equal(JSON.parse(approve.stdout).outcome, 'queued');
        assert.deepEqual(selected.lines(), ['GET /runs/run-1', `POST /runs/run-1/approvals/${REQUEST}/decision`, 'GET /runs/run-1']);
        assert.deepEqual(selected.requests[1].body, { decision: 'approve' }, 'an approval carries no text');
        assert.deepEqual(ambient.requests, [], 'the coordinator named by the environment is not contacted when a flag is given');
        assert.deepEqual(await fs.readdir(empty), [], 'nothing was needed on disk');

        // Without the flag the environment's coordinator is the one that is contacted.
        const read = await runProcess(process.execPath, [helper, 'snapshot', 'run-1', '--cwd', empty], { cwd: empty, env: withAmbient });
        assert.equal(read.status, 0, read.stderr);
        assert.deepEqual(ambient.lines(), ['GET /runs/run-1']);
        assert.equal(selected.requests.length, 3);
        t.diagnostic(`${layout}: respond selected the flagged coordinator and no other`);
      });

      test('requested changes and pause guidance cross the installed command line byte for byte, once', async t => {
        const stubs = await shortDirectory();
        t.after(() => fs.rm(stubs, { recursive: true, force: true }));
        const helper = path.join(install().root, 'skills', 'openheimdall-resume', 'scripts', 'openheimdall.mjs');
        const text = '--keep the scope small\n"quoted" and \'single\' $(not run) `not run`\n- bullet\r\nação ✓\n';
        const changes = await stubCoordinator(stubs, 'changes');
        t.after(() => changes.close());
        const requested = await runProcess(process.execPath, [helper, 'respond', 'run-1', '--cwd', stubs, '--request', REQUEST, '--decision', 'request-changes', '--feedback-stdin', '--coordinator-config', changes.configFile], { cwd: stubs, env: env(), input: text });
        assert.equal(requested.status, 0, requested.stderr + requested.stdout);
        assert.equal(JSON.parse(requested.stdout).outcome, 'queued');
        const posts = changes.requests.filter(entry => entry.method === 'POST');
        assert.equal(posts.length, 1);
        assert.deepEqual(posts[0].body, { decision: 'request-changes', feedback: text }, 'the feedback arrives unchanged');

        const generic = await stubCoordinator(stubs, 'generic', { kind: 'generic' });
        t.after(() => generic.close());
        const resumed = await runProcess(process.execPath, [helper, 'resume', 'run-1', '--cwd', stubs, '--guidance-stdin', '--coordinator-config', generic.configFile], { cwd: stubs, env: env(), input: text });
        assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout);
        const report = JSON.parse(resumed.stdout);
        assert.equal(report.outcome, 'resumed');
        assert.equal(report.via, 'respond');
        assert.deepEqual(generic.lines(), ['GET /runs/run-1', 'POST /runs/run-1/respond', 'GET /runs/run-1'], 'the guarded response, never the unguarded resume');
        assert.deepEqual(generic.requests[1].body, { pauseId: PAUSE, input: text });
      });

      test('a resume of a pending approval, and a lost response, send nothing more', async t => {
        const stubs = await shortDirectory();
        t.after(() => fs.rm(stubs, { recursive: true, force: true }));
        const helper = path.join(install().root, 'skills', 'openheimdall-resume', 'scripts', 'openheimdall.mjs');
        const pending = await stubCoordinator(stubs, 'pending');
        t.after(() => pending.close());
        const refused = await runProcess(process.execPath, [helper, 'resume', 'run-1', '--cwd', stubs, '--guidance-stdin', '--coordinator-config', pending.configFile], { cwd: stubs, env: env(), input: 'continue' });
        assert.equal(refused.status, 1);
        assert.equal(JSON.parse(refused.stdout).reason, 'approval-pending');
        assert.deepEqual(pending.lines(), ['GET /runs/run-1'], 'a bare resume is never turned into a decision');

        const lossy = await stubCoordinator(stubs, 'lossy', { drop: true });
        t.after(() => lossy.close());
        const lost = await runProcess(process.execPath, [helper, 'respond', 'run-1', '--cwd', stubs, '--request', REQUEST, '--decision', 'approve', '--coordinator-config', lossy.configFile], { cwd: stubs, env: env() });
        assert.equal(lost.status, 1);
        const report = JSON.parse(lost.stdout);
        assert.equal(report.outcome, 'uncertain');
        assert.equal(report.inspection.confirmed, false);
        assert.deepEqual(lossy.lines(), ['GET /runs/run-1', `POST /runs/run-1/approvals/${REQUEST}/decision`, 'GET /runs/run-1'], 'one response, then only a read');
      });

      test('the installed helper request reads the complete request outside the checkout, through the installed command line and the selected coordinator, and only reads', async t => {
        const stubs = await shortDirectory();
        t.after(() => fs.rm(stubs, { recursive: true, force: true }));
        const selected = await stubCoordinator(stubs, 'selected');
        const ambient = await stubCoordinator(stubs, 'ambient');
        t.after(async () => { await selected.close(); await ambient.close(); });
        const empty = path.join(stubs, 'empty cwd');
        await fs.mkdir(empty);
        assert.ok(!empty.startsWith(checkout), 'the working directory is outside the checkout');
        assert.ok(path.relative(install().root, empty).startsWith('..'), 'the working directory is outside the installation');
        for (const name of ['openheimdall-monitor', 'openheimdall-resume']) {
          const helper = path.join(install().root, 'skills', name, 'scripts', 'openheimdall.mjs');
          selected.requests.length = 0;
          const read = await runProcess(process.execPath, [helper, 'request', 'run-1', '--cwd', empty, '--request', REQUEST, '--coordinator-config', selected.configFile], { cwd: empty, env: env({ HEIMDALL_COORDINATOR_CONFIG: ambient.configFile }) });
          assert.equal(read.status, 0, read.stderr + read.stdout);
          const report = JSON.parse(read.stdout);
          assert.equal(report.complete, true, name);
          assert.equal(report.request.scope, LATE_SCOPE, 'the whole scope, including the late action');
          assert.deepEqual(report.request.verification, LATE_CHECKS);
          assert.deepEqual(report.request.onApprove, LATE_APPROVE);
          assert.deepEqual(report.request.revision, FULL_REVISION);
          assert.deepEqual(selected.lines(), [`GET /runs/run-1/approvals/${REQUEST}`], `${name}: one read, no other request`);
          assert.deepEqual(ambient.requests, [], 'the coordinator named by the environment is not contacted when a flag is given');
        }
        assert.deepEqual(await fs.readdir(empty), [], 'nothing was written');

        // The installed command line itself prints the same complete request.
        const direct = await runBinary(install(), ['coordinator', 'run', 'approval', 'run-1', '--request', REQUEST, '--coordinator-config', selected.configFile], { cwd: empty, env: env() });
        assert.equal(direct.status, 0, direct.stderr);
        assert.equal(JSON.parse(direct.stdout).scope, LATE_SCOPE);

        // A request the coordinator does not have is reported as incomplete review information, never as a summary.
        const generic = await stubCoordinator(stubs, 'generic', { kind: 'generic' });
        t.after(() => generic.close());
        const helper = path.join(install().root, 'skills', 'openheimdall-monitor', 'scripts', 'openheimdall.mjs');
        const missing = await runProcess(process.execPath, [helper, 'request', 'run-1', '--cwd', empty, '--request', REQUEST, '--coordinator-config', generic.configFile], { cwd: empty, env: env() });
        assert.equal(missing.status, 1);
        const failed = JSON.parse(missing.stdout);
        assert.equal(failed.complete, false);
        assert.equal(failed.request, undefined);
        assert.match(failed.note, /review information is incomplete/);
        assert.ok(generic.requests.every(entry => entry.method === 'GET'), 'only reads');
        t.diagnostic(`${layout}: the installed request command read the complete request from the flagged coordinator only`);
      });

      test('the installed monitor helper shows a pending request and only reads', async t => {
        const stubs = await shortDirectory();
        t.after(() => fs.rm(stubs, { recursive: true, force: true }));
        const stub = await stubCoordinator(stubs, 'monitor');
        t.after(() => stub.close());
        const helper = path.join(install().root, 'skills', 'openheimdall-monitor', 'scripts', 'openheimdall.mjs');
        const snapshot = await runProcess(process.execPath, [helper, 'snapshot', 'run-1', '--cwd', stubs, '--coordinator-config', stub.configFile], { cwd: stubs, env: env() });
        assert.equal(snapshot.status, 0, snapshot.stderr);
        const { wait } = JSON.parse(snapshot.stdout).run;
        assert.equal(wait.requestId, REQUEST);
        assert.equal(wait.question, 'Ship the migration?');
        assert.deepEqual(stub.lines(), ['GET /runs/run-1']);
      });

      for (const place of ['personal', 'project']) {
        test(`the ${place} copy of each helper runs from its installed location`, async t => {
          for (const name of skillNames) {
            const base = place === 'personal' ? path.join(work, `${layout}-personal`, 'skills') : path.join(project(), '.opencode', 'skills');
            const helper = path.join(base, name, 'scripts', 'openheimdall.mjs');
            const help = await runProcess(process.execPath, [helper, '--help'], { cwd: work, env: env() });
            assert.equal(help.status, 0, help.stderr);
            assert.match(help.stdout, /openheimdall\.mjs context/);

            const homeBefore = await tree(environment.home);
            const projectBefore = (await tree(project())).filter(entry => !entry.includes('.opencode'));
            const gitBefore = execFileSync('git', ['status', '--porcelain=v1', '--ignored'], { cwd: project(), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: environment.home } });
            const context = await runProcess(process.execPath, [helper, 'context', '--cwd', project()], { cwd: work, env: env() });
            assert.equal(context.status, 0, context.stderr);
            const report = JSON.parse(context.stdout);
            assert.equal(report.ok, true);
            assert.equal(report.command, 'context');
            assert.equal(report.coordinator.readiness, 'unavailable');
            assert.equal(report.coordinator.acceptingNewRuns, false);
            assert.equal(await fs.realpath(report.repository.topLevel), await fs.realpath(project()));
            assert.equal(report.repository.changes.tracked, 0);
            assert.deepEqual(await tree(environment.home), homeBefore, 'context creates nothing in HOME');
            assert.deepEqual((await tree(project())).filter(entry => !entry.includes('.opencode')), projectBefore);
            assert.equal(execFileSync('git', ['status', '--porcelain=v1', '--ignored'], { cwd: project(), encoding: 'utf8', env: { PATH: process.env.PATH, HOME: environment.home } }), gitBefore);
            t.diagnostic(`${layout}/${place}/${name}: readiness ${report.coordinator.readiness}`);
          }
        });
      }
    });
  }
});
