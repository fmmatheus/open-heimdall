#!/usr/bin/env node
// Behavior evaluation kit for the OpenHeimdall skills. See README.md in this directory.
//
//   node scripts/live/skills-eval/run-eval.mjs selftest
//   node scripts/live/skills-eval/run-eval.mjs prepare --out DIRECTORY [--prompt ID] [--arm with|without]
//   node scripts/live/skills-eval/run-eval.mjs run --model PROVIDER/MODEL --pass-env NAME[,NAME] [--auto]
//        [--arm with|without|both] [--prompt ID] [--timeout SECONDS] [--out DIRECTORY]
//
// `selftest` and `prepare` need no model and no credentials. `run` calls `opencode run` and therefore needs a
// model environment that the operator supplies explicitly through --pass-env.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..', '..');
const helper = path.join(repoRoot, 'skills', 'openheimdall-start', 'scripts', 'openheimdall.mjs');
const { prompts } = JSON.parse(fs.readFileSync(path.join(here, 'prompts.json'), 'utf8'));

const RUN_ID = '3f2a9c1e-7b64-4d0a-9e58-1c2d3e4f5a6b';
const PROJECT_ID = 'project-eval';
const SPEC = `# Add a greeting file

Create \`greeting.txt\` containing the word \`hello\` and a newline, then commit it.

## Tasks

1. Add \`greeting.txt\`.
2. Add \`format.txt\` in the output format the owner chooses (plain or json). Stop and ask the owner which one.
`;
const GUIDANCE = `# Answer for the paused run ${RUN_ID}

The run is paused on the output format question. Use \`json\`.

Resume the run, create \`format.txt\` containing exactly the word \`json\` and a newline, and finish the remaining work.
`;

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = { arm: 'both' };
  for (let index = 0; index < rest.length; index++) {
    const name = rest[index];
    if (name === '--auto') { options.auto = true; continue; }
    if (!['--out', '--prompt', '--arm', '--model', '--pass-env', '--timeout', '--opencode'].includes(name)) throw new Error(`Unknown argument: ${name}`);
    const value = rest[++index];
    if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
    options[name.slice(2)] = value;
  }
  return { command, options };
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: os.tmpdir(), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'Eval', GIT_AUTHOR_EMAIL: 'eval@example.invalid', GIT_COMMITTER_NAME: 'Eval', GIT_COMMITTER_EMAIL: 'eval@example.invalid' },
  }).trim();
}

/** Build an isolated sandbox: HOME/XDG/OPENCODE_CONFIG_DIR, a synthetic Git project, the fake heimdall and its state. */
export function createSandbox(root, { scenario, withSkills }) {
  const sandbox = fs.mkdtempSync(path.join(root, 'sandbox-'));
  const dirs = Object.fromEntries(['home', 'config', 'xdg-config', 'xdg-data', 'xdg-cache', 'xdg-state', 'tmp', 'bin', 'shim', 'project'].map(name => [name, path.join(sandbox, name)]));
  for (const directory of Object.values(dirs)) fs.mkdirSync(directory, { recursive: true });
  dirs.project = fs.realpathSync(dirs.project);

  fs.copyFileSync(path.join(here, 'fake-heimdall', 'heimdall'), path.join(dirs.bin, 'heimdall'));
  fs.chmodSync(path.join(dirs.bin, 'heimdall'), 0o755);
  if (withSkills) fs.cpSync(path.join(repoRoot, 'skills'), path.join(dirs.config, 'skills'), { recursive: true, errorOnExist: true });

  git(dirs.project, ['init', '--quiet', '--initial-branch=main']);
  fs.mkdirSync(path.join(dirs.project, 'specs'));
  fs.mkdirSync(path.join(dirs.project, 'guidance'));
  fs.writeFileSync(path.join(dirs.project, 'README.md'), '# Synthetic evaluation project\n');
  fs.writeFileSync(path.join(dirs.project, 'specs', 'add-greeting.md'), SPEC);
  fs.writeFileSync(path.join(dirs.project, 'guidance', 'pick-format.md'), GUIDANCE);
  git(dirs.project, ['add', '.']);
  git(dirs.project, ['commit', '--quiet', '-m', 'Initial commit']);
  const head = git(dirs.project, ['rev-parse', 'HEAD']);
  const commonGitDirectory = fs.realpathSync(git(dirs.project, ['rev-parse', '--path-format=absolute', '--git-common-dir']));

  fs.writeFileSync(path.join(dirs.shim, 'state.json'), JSON.stringify({
    scenario, runId: RUN_ID, baseCommit: head, createdAt: Date.now() - 300000, worktreePath: path.join(sandbox, 'worktrees', RUN_ID),
    project: { id: PROJECT_ID, directory: dirs.project, commonGitDirectory, concurrency: 1, configPath: path.join(dirs.project, '.heimdall', 'project.toml'), createdAt: 1 },
  }, null, 2));
  fs.writeFileSync(path.join(dirs.shim, 'calls.jsonl'), '');

  const env = {
    PATH: [dirs.bin, path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
    HOME: dirs.home, XDG_CONFIG_HOME: dirs['xdg-config'], XDG_DATA_HOME: dirs['xdg-data'], XDG_CACHE_HOME: dirs['xdg-cache'], XDG_STATE_HOME: dirs['xdg-state'],
    TMPDIR: dirs.tmp, OPENCODE_CONFIG_DIR: dirs.config, EVAL_SHIM_DIR: dirs.shim, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  };
  return { sandbox, dirs, env, head, callsFile: path.join(dirs.shim, 'calls.jsonl') };
}

export function readCalls(callsFile) {
  return fs.readFileSync(callsFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

/** Count recorded mutating coordinator calls by subcommand, e.g. { 'run submit': 1 }. */
export function countMutations(calls) {
  const counts = {};
  for (const call of calls) {
    if (!call.mutating) continue;
    const words = call.argv.filter(word => word !== 'coordinator');
    const key = words[0] === 'project' || words[0] === 'run' ? `${words[0]} ${words[1]}` : words[0];
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

/** Allowed range for one policy entry: an exact count, or { min, max }. Throws on a malformed entry. */
function allowedRange(key, allowance) {
  const isCount = value => Number.isInteger(value) && value >= 0;
  if (isCount(allowance)) return { min: allowance, max: allowance };
  if (allowance && typeof allowance === 'object' && !Array.isArray(allowance) && isCount(allowance.min) && isCount(allowance.max) && allowance.min <= allowance.max
    && Object.keys(allowance).every(name => name === 'min' || name === 'max')) return allowance;
  throw new Error(`Malformed mutation policy for "${key}": expected a non-negative integer or { min, max }`);
}

/** Validate the shape of a mutation policy: an object mapping mutation keys to a count or { min, max }. */
export function validateMutationPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new Error('Malformed mutation policy: expected an object');
  for (const [key, allowance] of Object.entries(policy)) allowedRange(key, allowance);
}

/**
 * Keys of the complete recorded mutation map that violate the policy. Every key not listed in the policy is allowed
 * zero times, so an unexpected mutating command is reported even when the policy never mentions it.
 */
export function mutationViolations(mutations, policy) {
  validateMutationPolicy(policy);
  const violations = [];
  for (const key of new Set([...Object.keys(mutations), ...Object.keys(policy)])) {
    const { min, max } = key in policy ? allowedRange(key, policy[key]) : { min: 0, max: 0 };
    const count = mutations[key] ?? 0;
    if (count < min || count > max) violations.push(key);
  }
  return violations;
}

/** True when the complete recorded mutation map satisfies the policy. */
export function mutationsMeetPolicy(mutations, policy) {
  return mutationViolations(mutations, policy).length === 0;
}

function helperRun(box, args, extra = {}) {
  const result = spawnSync(process.execPath, [helper, ...args, '--cwd', box.dirs.project], {
    encoding: 'utf8', env: { ...box.env, HEIMDALL_BIN: path.join(box.dirs.bin, 'heimdall') }, ...extra,
  });
  // `watch` writes one compact JSON document per line; every other operation writes a single pretty-printed document.
  const lines = () => result.stdout.split('\n').filter(line => line.startsWith('{') && line.endsWith('}')).map(line => JSON.parse(line));
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json: () => JSON.parse(result.stdout), lines };
}

// --- selftest ----------------------------------------------------------------------------------------------

function selftest() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openheimdall-skills-eval-'));
  const results = [];
  const check = (name, fn) => { fn(); results.push(name); };
  try {
    check('shim: --help prints the coordinator usage and a read-only status call is recorded', () => {
      const box = createSandbox(root, { scenario: 'ready', withSkills: false });
      const out = spawnSync(path.join(box.dirs.bin, 'heimdall'), ['coordinator', '--help'], { encoding: 'utf8', env: box.env });
      assert.match(out.stdout, /heimdall coordinator run resume RUN_ID --input RESOLUTION/);
      const status = spawnSync(path.join(box.dirs.bin, 'heimdall'), ['coordinator', 'status', '--json'], { encoding: 'utf8', env: box.env });
      assert.equal(JSON.parse(status.stdout).acceptingNewRuns, true);
      assert.deepEqual(countMutations(readCalls(box.callsFile)), {});
    });

    check('start-from-spec: helper submits exactly once and the run is queued', () => {
      const box = createSandbox(root, { scenario: 'ready', withSkills: false });
      const result = helperRun(box, ['start', '--spec', 'specs/add-greeting.md']);
      assert.equal(result.status, 0, result.stderr);
      const report = result.json();
      assert.equal(report.outcome, 'submitted');
      assert.equal(report.runId, RUN_ID);
      assert.deepEqual(countMutations(readCalls(box.callsFile)), { 'run submit': 1 });
      const submit = readCalls(box.callsFile).find(call => call.mutating);
      assert.deepEqual(submit.argv.slice(0, 5), ['coordinator', 'run', 'submit', PROJECT_ID, '--feature']);
      assert.equal(submit.argv[6], '--base');
      assert.equal(submit.argv[7], box.head);
    });

    check('snapshot-status: read-only report of the queued run', () => {
      const box = createSandbox(root, { scenario: 'queued', withSkills: false });
      const result = helperRun(box, ['snapshot']);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.json().run.status, 'queued');
      assert.deepEqual(countMutations(readCalls(box.callsFile)), {});
    });

    check('watch-for-minutes: bounded read-only watch stops when the run pauses', () => {
      const box = createSandbox(root, { scenario: 'progress', withSkills: false });
      const result = helperRun(box, ['watch', '--budget-seconds', '20', '--interval-seconds', '0.1']);
      assert.equal(result.status, 0, result.stderr);
      const stopped = result.lines().at(-1);
      assert.equal(stopped.event, 'stopped');
      assert.equal(stopped.reason, 'paused');
      assert.deepEqual(countMutations(readCalls(box.callsFile)), {});
    });

    check('resume-with-guidance: helper resumes the same run once with the labeled guidance', () => {
      const box = createSandbox(root, { scenario: 'paused', withSkills: false });
      const result = helperRun(box, ['resume', RUN_ID, '--guidance-file', 'guidance/pick-format.md']);
      assert.equal(result.status, 0, result.stderr);
      const report = result.json();
      assert.equal(report.outcome, 'resumed');
      assert.equal(report.preserved.runId, true);
      assert.deepEqual(report.completedResults, { before: 1, after: 1 });
      assert.deepEqual(countMutations(readCalls(box.callsFile)), { 'run resume': 1 });
      const resume = readCalls(box.callsFile).find(call => call.mutating);
      assert.equal(resume.argv[2], 'resume');
      assert.equal(resume.argv[3], RUN_ID);
      assert.equal(resume.argv[4], '--input');
      assert.match(resume.argv[5], /^Owner guidance for resuming this run/);
    });

    check('boundary-guidance-as-spec: inspect-spec flags the guidance file and nothing is mutated', () => {
      const box = createSandbox(root, { scenario: 'paused', withSkills: false });
      const result = helperRun(box, ['inspect-spec', 'guidance/pick-format.md']);
      assert.equal(result.status, 0, result.stderr);
      const report = result.json();
      assert.equal(report.looksLikeResumeGuidance, true);
      assert.deepEqual(report.existingRunIds, [RUN_ID]);
      assert.deepEqual(countMutations(readCalls(box.callsFile)), {});
    });

    check('resume refused for a run that is not paused (no mutating call)', () => {
      const box = createSandbox(root, { scenario: 'queued', withSkills: false });
      const result = helperRun(box, ['resume', RUN_ID, '--guidance-file', 'guidance/pick-format.md']);
      assert.equal(result.status, 1);
      assert.equal(result.json().outcome, 'not-resumable');
      assert.deepEqual(countMutations(readCalls(box.callsFile)), {});
    });

    check('sandbox: skills present only in the with-skills arm; no path outside the sandbox is used by the environment', () => {
      const withSkills = createSandbox(root, { scenario: 'ready', withSkills: true });
      const without = createSandbox(root, { scenario: 'ready', withSkills: false });
      assert.deepEqual(fs.readdirSync(path.join(withSkills.dirs.config, 'skills')).sort(), ['openheimdall-monitor', 'openheimdall-resume', 'openheimdall-start']);
      assert.deepEqual(fs.readdirSync(without.dirs.config), []);
      for (const [name, value] of Object.entries(withSkills.env)) {
        if (name === 'PATH' || name.startsWith('GIT_CONFIG')) continue;
        assert.ok(value.startsWith(withSkills.sandbox), `${name} escapes the sandbox`);
      }
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  process.stdout.write(`${JSON.stringify({ selftest: 'passed', checks: results }, null, 2)}\n`);
}

// --- model-backed run --------------------------------------------------------------------------------------

/** Skill loads seen in `opencode run --format json` output. The event shape is matched loosely on purpose. */
export function extractSkillLoads(text) {
  const loads = new Set();
  for (const match of text.matchAll(/<skill_content name=\\?"([A-Za-z0-9-]+)\\?"/g)) loads.add(match[1]);
  for (const match of text.matchAll(/"tool"\s*:\s*"skill"[\s\S]{0,400}?\\?"name\\?"\s*:\s*\\?"(openheimdall-[a-z]+)\\?"/g)) loads.add(match[1]);
  return [...loads].sort();
}

function runModel(options, box, prompt, outFile) {
  const opencode = options.opencode ?? execFileSync('which', ['opencode'], { encoding: 'utf8' }).trim();
  const env = { ...box.env };
  for (const name of options['pass-env'].split(',').map(item => item.trim()).filter(Boolean)) {
    if (process.env[name] === undefined) throw new Error(`--pass-env names ${name}, which is not set`);
    env[name] = process.env[name];
  }
  const args = ['run', '--standalone', '--format', 'json', '--model', options.model, ...(options.auto ? ['--auto'] : []), prompt.text];
  return new Promise(resolve => {
    const child = spawn(opencode, args, { cwd: box.dirs.project, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), Number(options.timeout ?? 300) * 1000);
    child.on('close', code => { clearTimeout(timer); fs.writeFileSync(outFile, output); resolve({ exitCode: code, output }); });
  });
}

async function runAll(options) {
  if (!options.model) throw new Error('--model PROVIDER/MODEL is required for run');
  if (!options['pass-env']) throw new Error('--pass-env NAME[,NAME] is required: name the environment variables that carry approved credentials');
  const out = path.resolve(options.out ?? fs.mkdtempSync(path.join(os.tmpdir(), 'openheimdall-skills-eval-out-')));
  fs.mkdirSync(out, { recursive: true });
  const arms = options.arm === 'both' ? ['with', 'without'] : [options.arm];
  const selected = prompts.filter(prompt => !options.prompt || prompt.id === options.prompt);
  if (selected.length === 0) throw new Error(`No prompt with id ${options.prompt}`);
  for (const prompt of selected) {
    try { validateMutationPolicy(prompt.expect?.mutationPolicy); } catch (error) { throw new Error(`${prompt.id}: ${error.message}`); }
  }
  const rows = [];
  for (const arm of arms) {
    for (const prompt of selected) {
      const box = createSandbox(out, { scenario: prompt.scenario, withSkills: arm === 'with' });
      const result = await runModel(options, box, prompt, path.join(out, `${arm}-${prompt.id}.log`));
      const calls = readCalls(box.callsFile);
      const mutations = countMutations(calls);
      const skills = extractSkillLoads(result.output);
      const expected = prompt.expect;
      const mutationOk = mutationsMeetPolicy(mutations, expected.mutationPolicy);
      const skillOk = expected.anySkill ? skills.some(name => expected.skills.includes(name)) : expected.skills.every(name => skills.includes(name));
      rows.push({ arm, prompt: prompt.id, exitCode: result.exitCode, skillsLoaded: skills, mutations, mutationExpectationMet: mutationOk, skillExpectationMet: skillOk, argv: calls.map(call => call.argv.join(' ')) });
      fs.rmSync(box.sandbox, { recursive: true, force: true });
    }
  }
  fs.writeFileSync(path.join(out, 'results.json'), `${JSON.stringify(rows, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ out, rows }, null, 2)}\n`);
}

// --- main --------------------------------------------------------------------------------------------------

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const { command, options } = parseArguments(process.argv.slice(2));
    if (command === 'selftest') selftest();
    else if (command === 'prepare') {
      if (!options.out) throw new Error('--out DIRECTORY is required');
      fs.mkdirSync(options.out, { recursive: true });
      const selected = prompts.filter(prompt => !options.prompt || prompt.id === options.prompt);
      const arms = options.arm === 'both' ? ['with', 'without'] : [options.arm];
      const created = arms.flatMap(arm => selected.map(prompt => {
        const box = createSandbox(path.resolve(options.out), { scenario: prompt.scenario, withSkills: arm === 'with' });
        return { arm, prompt: prompt.id, sandbox: box.sandbox, project: box.dirs.project, env: Object.keys(box.env) };
      }));
      process.stdout.write(`${JSON.stringify(created, null, 2)}\n`);
    } else if (command === 'run') await runAll(options);
    else throw new Error('Usage: run-eval.mjs selftest | prepare --out DIR | run --model P/M --pass-env NAMES [--auto] [--arm with|without|both] [--prompt ID] [--timeout S] [--out DIR]');
  } catch (error) {
    process.stderr.write(`run-eval: ${error.message}\n`);
    process.exitCode = 1;
  }
}
