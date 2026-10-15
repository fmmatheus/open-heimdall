import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildTarball, installConsumer, installGlobal, isolatedEnvironment, removeTarballBuild, runProcess, toolVersions,
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
