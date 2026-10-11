import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runSetup, planSetup } from '../dist/setup/index.js';
import { loadConfiguration } from '../dist/config.js';
import { loadCoordinatorConfiguration } from '../dist/coordinator/config.js';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const complete = { plannerModel: 'anthropic/planner-x', executorModel: 'openai/executor-x', quotaProvider: 'openai', opencodeUrl: 'http://127.0.0.1:4096', opencodeAuth: 'basic' };

/** Isolated HOME/Git/Heimdall environment with a synthetic Git project that has one commit. */
async function sandbox(t, { commit = true, git: initialize = true } = {}) {
  // Short root: the coordinator socket path under the isolated HOME must stay within the portable Unix limit.
  const root = await fs.realpath(await fs.mkdtemp(path.join(await fs.access('/tmp').then(() => '/tmp', () => os.tmpdir()), 'hs-')));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  await fs.mkdir(home);
  await fs.mkdir(project);
  const saved = { ...process.env };
  Object.assign(process.env, { HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  for (const name of Object.keys(process.env)) if (name.startsWith('HEIMDALL_')) delete process.env[name];
  t.after(async () => {
    for (const name of Object.keys(process.env)) if (!(name in saved)) delete process.env[name];
    Object.assign(process.env, saved);
    await fs.rm(root, { recursive: true, force: true });
  });
  const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd: project, env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdio: 'pipe' });
  if (initialize) {
    git('init', '--quiet');
    if (commit) git('commit', '--quiet', '--allow-empty', '-m', 'initial');
  }
  const options = { environment: {}, homeDirectory: home, cwd: root };
  return {
    root, home, project, options,
    coordinatorFile: path.join(home, '.config', 'heimdall', 'coordinator.toml'),
    projectFile: path.join(project, '.heimdall.toml'),
    run: (input = {}, extra = {}) => runSetup({ projectDirectory: project, ...input }, { ...options, ...extra }),
  };
}

async function tree(root) {
  const entries = [];
  const walk = async directory => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(directory, entry.name);
      entries.push(path.relative(root, full) + (entry.isDirectory() ? '/' : entry.isSymbolicLink() ? '@' : ''));
      if (entry.isDirectory()) await walk(full);
    }
  };
  await walk(root);
  return entries.sort();
}
const mode = async file => (await fs.stat(file)).mode & 0o777;
const read = file => fs.readFile(file, 'utf8');

async function assertRejected(s, input, code, pattern, extra) {
  const before = await tree(s.root);
  const result = await s.run(input, extra);
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.error.code, code, result.error.message);
  if (pattern) assert.match(result.error.message, pattern);
  for (const target of Object.values(result.targets)) assert.notEqual(target.outcome, 'created');
  assert.equal(result.partial, null);
  assert.equal(result.verification.level, 'none');
  assert.deepEqual(await tree(s.root), before, 'a rejected setup must not create anything');
  return result;
}

test('complete inputs create both files that the loaders accept with loader defaults', async t => {
  const s = await sandbox(t);
  const before = await tree(s.root);
  const result = await s.run(complete);
  assert.equal(result.ok, true);
  assert.equal(result.schemaVersion, 1);
  assert.equal(result.projectDirectory, s.project);
  assert.deepEqual(result.targets, { coordinator: { path: s.coordinatorFile, outcome: 'created' }, project: { path: s.projectFile, outcome: 'created' } });
  assert.equal(result.error, null);
  assert.equal(result.partial, null);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.verification.level, 'configuration-validated');
  assert.deepEqual(result.verification.unverified, ['opencode-connection', 'model-availability', 'provider-login', 'quota']);

  const configuration = await loadConfiguration({ projectDirectory: s.project, configPath: s.projectFile });
  assert.equal(configuration.settings.plannerModel, 'anthropic/planner-x');
  assert.deepEqual(configuration.settings.executorCandidates, [{ key: 'primary', quotaProvider: 'openai', model: 'openai/executor-x' }]);
  assert.equal(configuration.settings.executorModel, 'openai/executor-x');
  assert.equal(configuration.settings.maxTasks, 10);
  assert.equal(configuration.settings.tokenLimitsDisabled, true);
  assert.deepEqual(configuration.opencode, { baseUrl: 'http://127.0.0.1:4096', passwordEnvironmentVariable: 'OPENCODE_PASSWORD', authentication: 'basic' });
  const coordinator = await loadCoordinatorConfiguration(s.coordinatorFile);
  assert.equal(coordinator.globalConcurrency, 1);
  assert.equal(coordinator.projectConcurrency, 1);
  assert.equal(coordinator.stateDirectory, path.join(s.home, '.local', 'state', 'heimdall'));
  assert.doesNotMatch(await read(s.coordinatorFile), /Concurrency|stateDirectory/);

  assert.equal(await mode(s.projectFile), 0o600);
  assert.equal(await mode(s.coordinatorFile), 0o600);
  assert.deepEqual(result.createdDirectories, [path.join(s.home, '.config'), path.join(s.home, '.config', 'heimdall')]);
  for (const directory of result.createdDirectories) assert.equal(await mode(directory), 0o700);
  assert.deepEqual((await tree(s.root)).filter(entry => !before.includes(entry)), ['home/.config/', 'home/.config/heimdall/', 'home/.config/heimdall/coordinator.toml', 'project/.heimdall.toml'], 'only the two files and their new parent directories appear');
});

test('explicit coordinator settings and password environment names are written; existing directories keep their permissions', async t => {
  const s = await sandbox(t);
  await fs.chmod(s.project, 0o755);
  const result = await s.run({ ...complete, passwordEnv: 'MY_OPENCODE_PASSWORD', stateDirectory: 'state', globalConcurrency: 3, projectConcurrency: 2, configPath: 'conf/new/heimdall.toml', coordinatorConfigPath: path.join(s.root, 'coord', 'c.toml') });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(result.createdDirectories, [path.join(s.root, 'coord'), path.join(s.project, 'conf'), path.join(s.project, 'conf', 'new')]);
  assert.equal(await mode(s.project), 0o755, 'an existing directory is never chmodded');
  for (const directory of result.createdDirectories) assert.equal(await mode(directory), 0o700);
  const coordinator = await loadCoordinatorConfiguration(path.join(s.root, 'coord', 'c.toml'));
  assert.deepEqual([coordinator.globalConcurrency, coordinator.projectConcurrency, coordinator.stateDirectory], [3, 2, path.join(s.root, 'coord', 'state')]);
  const configuration = await loadConfiguration({ projectDirectory: s.project, configPath: path.join(s.project, 'conf', 'new', 'heimdall.toml') });
  assert.equal(configuration.opencode.passwordEnvironmentVariable, 'MY_OPENCODE_PASSWORD');
  assert.equal((await tree(s.root)).some(entry => entry.endsWith('.tmp')), false);
});

test('a repeated identical setup reuses both files byte for byte', async t => {
  const s = await sandbox(t);
  assert.equal((await s.run(complete)).ok, true);
  const [coordinator, project, before] = [await fs.readFile(s.coordinatorFile), await fs.readFile(s.projectFile), await tree(s.root)];
  const [coordinatorStat, projectStat] = [await fs.stat(s.coordinatorFile), await fs.stat(s.projectFile)];
  for (const input of [complete, {}, { projectDirectory: s.project }]) {
    const again = await s.run(input);
    assert.equal(again.ok, true, JSON.stringify(again.error));
    assert.deepEqual([again.targets.coordinator.outcome, again.targets.project.outcome], ['reused', 'reused']);
    assert.deepEqual(again.createdDirectories, []);
    assert.equal(again.verification.level, 'configuration-validated');
  }
  assert.deepEqual(await fs.readFile(s.coordinatorFile), coordinator);
  assert.deepEqual(await fs.readFile(s.projectFile), project);
  assert.equal((await fs.stat(s.coordinatorFile)).mtimeMs, coordinatorStat.mtimeMs);
  assert.equal((await fs.stat(s.projectFile)).mtimeMs, projectStat.mtimeMs);
  assert.deepEqual(await tree(s.root), before);
});

const richProject = `# hand edited
[workflow]
plannerModel = "anthropic/rich-planner"
plannerVariant = "high"
maxTasks = 4
minQuotaRemainingPercent = 25
fiveHourQuotaWeight = 0.4
tokenLimitsDisabled = false
maxSessionTokens = 40000
maxRunTokens = 200000
timeoutMinutes = 45

[[workflow.executorCandidates]]
key = "first"
quotaProvider = "claude-code"
model = "claude-code/sonnet"
variant = "fast"

[[workflow.executorCandidates]]
key = "second"
quotaProvider = "kimi"
model = "kimi-code-plan-global/k2"

[paths]
state = "runtime/state"
plans = "runtime/state/plans"

[opencode]
baseUrl = "http://localhost:4321"
authentication = "openchamber"
`;
const richCoordinator = `[coordinator]
globalConcurrency = 3
projectConcurrency = 2
stateDirectory = "state-dir"
`;

test('rich existing files are reused byte for byte and explicit matching inputs are accepted', async t => {
  const s = await sandbox(t);
  const coordinatorFile = path.join(s.root, 'conf', 'coordinator.toml');
  await fs.mkdir(path.dirname(coordinatorFile));
  await fs.writeFile(coordinatorFile, richCoordinator);
  await fs.writeFile(s.projectFile, richProject);
  const before = await tree(s.root);
  const base = { coordinatorConfigPath: coordinatorFile };
  for (const input of [
    {},
    { plannerModel: 'anthropic/rich-planner', executorModel: 'claude-code/sonnet', quotaProvider: 'claude-code', opencodeUrl: 'http://localhost:4321/', opencodeAuth: 'openchamber' },
    { globalConcurrency: 3, projectConcurrency: 2, stateDirectory: 'state-dir' },
    { stateDirectory: path.join(s.root, 'conf', 'state-dir') },
  ]) {
    const result = await s.run({ ...base, ...input });
    assert.equal(result.ok, true, JSON.stringify(result.error));
    assert.deepEqual([result.targets.coordinator.outcome, result.targets.project.outcome], ['reused', 'reused']);
  }
  assert.equal(await read(coordinatorFile), richCoordinator);
  assert.equal(await read(s.projectFile), richProject);
  assert.deepEqual(await tree(s.root), before);
  // The primary candidate is the first pool entry; later entries are preserved but never compared.
  const second = await s.run({ ...base, executorModel: 'kimi-code-plan-global/k2', quotaProvider: 'kimi' });
  assert.equal(second.error.code, 'conflict');
  assert.match(second.error.message, /executorCandidates\[0\]\.model is "claude-code\/sonnet", but "kimi-code-plan-global\/k2" was requested/);
});

const legacyProject = model => `[workflow]
plannerModel = "anthropic/p"
executorModel = "${model}"
executorFallbackModel = "${model}"
[opencode]
baseUrl = "http://127.0.0.1:4096"
`;

test('legacy files without a candidate pool are compared by the effective primary candidate', async t => {
  for (const [model, provider, other] of [['anthropic/sonnet-x', 'anthropic', 'openai'], ['claude-code/sonnet', 'claude-code', 'anthropic']]) {
    const s = await sandbox(t);
    assert.equal((await s.run({ plannerModel: 'anthropic/p', executorModel: model, quotaProvider: provider, opencodeUrl: 'http://127.0.0.1:4096', opencodeAuth: 'basic', stateDirectory: path.join(s.root, 'st') })).ok, true);
    const content = legacyProject(model);
    await fs.writeFile(s.projectFile, content);
    const before = await tree(s.root);
    const bytes = [await fs.readFile(s.coordinatorFile), await fs.readFile(s.projectFile)];
    const mtimes = [(await fs.stat(s.coordinatorFile)).mtimeMs, (await fs.stat(s.projectFile)).mtimeMs];
    for (const input of [{ quotaProvider: provider }, { executorModel: model, quotaProvider: provider }, { executorModel: model }]) {
      const result = await s.run(input);
      assert.equal(result.ok, true, JSON.stringify(result.error));
      assert.deepEqual([result.targets.coordinator.outcome, result.targets.project.outcome], ['reused', 'reused']);
    }
    assert.deepEqual(await tree(s.root), before);
    assert.deepEqual([await fs.readFile(s.coordinatorFile), await fs.readFile(s.projectFile)], bytes);
    assert.deepEqual([(await fs.stat(s.coordinatorFile)).mtimeMs, (await fs.stat(s.projectFile)).mtimeMs], mtimes);
    assert.equal(await read(s.projectFile), content);
    for (const wrong of [other, 'kimi']) {
      const result = await assertRejected(s, { quotaProvider: wrong }, 'conflict');
      assert.ok(result.error.message.includes(`${s.projectFile}: effective quota provider of workflow.executorModel is ${JSON.stringify(provider)}, but ${JSON.stringify(wrong)} was requested`), result.error.message);
    }
    const otherModel = model.startsWith('claude-code/') ? 'claude-code/other' : 'anthropic/other';
    const differentModel = await assertRejected(s, { executorModel: otherModel, quotaProvider: provider }, 'conflict');
    assert.ok(differentModel.error.message.includes(`${s.projectFile}: workflow.executorModel is ${JSON.stringify(model)}, but ${JSON.stringify(otherModel)} was requested`), differentModel.error.message);
    assert.deepEqual(await tree(s.root), before);
    assert.equal(await read(s.projectFile), content);
  }
});

test('a rich candidate pool compares only the first candidate model and provider', async t => {
  const s = await sandbox(t);
  const coordinatorFile = path.join(s.root, 'conf', 'coordinator.toml');
  await fs.mkdir(path.dirname(coordinatorFile));
  await fs.writeFile(coordinatorFile, richCoordinator);
  await fs.writeFile(s.projectFile, richProject);
  const before = await tree(s.root);
  const base = { coordinatorConfigPath: coordinatorFile };
  for (const input of [{ quotaProvider: 'claude-code' }, { executorModel: 'claude-code/sonnet', quotaProvider: 'claude-code' }]) {
    assert.equal((await s.run({ ...base, ...input })).ok, true);
  }
  assert.equal(await read(s.projectFile), richProject);
  assert.deepEqual(await tree(s.root), before);
  // The second candidate's provider and model are not the primary ones.
  const secondProvider = await assertRejected(s, { ...base, quotaProvider: 'kimi' }, 'conflict');
  assert.ok(secondProvider.error.message.includes(`${s.projectFile}: workflow.executorCandidates[0].quotaProvider is "claude-code", but "kimi" was requested`), secondProvider.error.message);
  const derived = await assertRejected(s, { ...base, quotaProvider: 'anthropic' }, 'conflict');
  assert.match(derived.error.message, /executorCandidates\[0\]\.quotaProvider is "claude-code", but "anthropic" was requested/);
  assert.equal(await read(s.projectFile), richProject);
  assert.deepEqual(await tree(s.root), before);
});

test('explicit values equal to loader defaults and equivalent paths are accepted', async t => {
  const s = await sandbox(t);
  const content = '[workflow]\nplannerModel = "anthropic/p"\nexecutorModel = "anthropic/e"\nexecutorFallbackModel = "anthropic/e"\n[opencode]\nbaseUrl = "http://[::1]:4096"\n';
  await fs.writeFile(s.projectFile, content);
  await fs.mkdir(path.dirname(s.coordinatorFile), { recursive: true });
  await fs.writeFile(s.coordinatorFile, '[coordinator]\n');
  for (const input of [
    { opencodeAuth: 'basic', passwordEnv: 'OPENCODE_PASSWORD', opencodeUrl: 'http://[::1]:4096/', globalConcurrency: 1, projectConcurrency: 1 },
    { stateDirectory: path.join(s.home, '.local', 'state', 'heimdall') },
    { stateDirectory: path.join(s.home, '.local', 'state', '..', 'state', 'heimdall') },
    { executorModel: 'anthropic/e' },
  ]) {
    const result = await s.run(input);
    assert.equal(result.ok, true, JSON.stringify(result.error));
  }
  assert.equal(await read(s.projectFile), content);
  // Without a candidate pool the primary candidate is derived from executorModel: an anthropic/ model uses the anthropic provider.
  assert.equal((await s.run({ executorModel: 'anthropic/e', quotaProvider: 'anthropic' })).ok, true);
  assert.equal(await read(s.projectFile), content);
  const result = await s.run({ quotaProvider: 'openai' });
  assert.equal(result.error.code, 'conflict');
  assert.match(result.error.message, /effective quota provider of workflow\.executorModel is "anthropic", but "openai" was requested/);

  const relative = path.join(s.root, 'rel', 'coordinator.toml');
  await fs.mkdir(path.dirname(relative));
  await fs.writeFile(relative, '[coordinator]\nstateDirectory = "../shared/state"\n');
  for (const stateDirectory of ['../shared/state', path.join(s.root, 'shared', 'state')]) {
    assert.equal((await s.run({ coordinatorConfigPath: relative, stateDirectory })).ok, true);
  }
  const different = await s.run({ coordinatorConfigPath: relative, stateDirectory: 'shared/state' });
  assert.equal(different.error.code, 'conflict');
  assert.match(different.error.message, new RegExp(`${relative.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: coordinator\\.stateDirectory is`));
});

test('inputs that disagree with existing files fail with file, key and both values before any write', async t => {
  const s = await sandbox(t);
  assert.equal((await s.run({ ...complete, globalConcurrency: 2 })).ok, true);
  const cases = [
    [{ plannerModel: 'anthropic/other' }, s.projectFile, 'workflow.plannerModel', '"anthropic/planner-x"', '"anthropic/other"'],
    [{ executorModel: 'openai/other' }, s.projectFile, 'workflow.executorCandidates[0].model', '"openai/executor-x"', '"openai/other"'],
    [{ quotaProvider: 'kimi' }, s.projectFile, 'workflow.executorCandidates[0].quotaProvider', '"openai"', '"kimi"'],
    [{ opencodeUrl: 'http://127.0.0.1:4097' }, s.projectFile, 'opencode.baseUrl', '"http://127.0.0.1:4096"', '"http://127.0.0.1:4097"'],
    [{ opencodeAuth: 'none' }, s.projectFile, 'opencode.authentication', '"basic"', '"none"'],
    [{ passwordEnv: 'OTHER_PASSWORD' }, s.projectFile, 'opencode.passwordEnvironmentVariable', '"OPENCODE_PASSWORD"', '"OTHER_PASSWORD"'],
    [{ globalConcurrency: 1 }, s.coordinatorFile, 'coordinator.globalConcurrency', '2', '1'],
    [{ projectConcurrency: 4 }, s.coordinatorFile, 'coordinator.projectConcurrency', '1', '4'],
    [{ stateDirectory: path.join(s.root, 'elsewhere') }, s.coordinatorFile, 'coordinator.stateDirectory', JSON.stringify(path.join(s.home, '.local', 'state', 'heimdall')), JSON.stringify(path.join(s.root, 'elsewhere'))],
  ];
  const files = [await fs.readFile(s.coordinatorFile), await fs.readFile(s.projectFile)];
  for (const [input, file, key, existing, requested] of cases) {
    const result = await assertRejected(s, { ...complete, ...input }, 'conflict');
    assert.ok(result.error.message.includes(`${file}: ${key} is ${existing}, but ${requested} was requested`), result.error.message);
    assert.match(result.error.message, /--config\/--coordinator-config/);
  }
  assert.ok((await assertRejected(s, { passwordEnv: 'OTHER_PASSWORD', opencodeAuth: 'none' }, 'invalid-input')).error.message.includes('basic'));
  assert.deepEqual([await fs.readFile(s.coordinatorFile), await fs.readFile(s.projectFile)], files);
  const noPassword = await sandbox(t);
  await fs.writeFile(noPassword.projectFile, '[workflow]\nplannerModel = "a/p"\nexecutorModel = "a/e"\nexecutorFallbackModel = "a/e"\n[opencode]\nbaseUrl = "http://127.0.0.1:1"\nauthentication = "none"\n');
  await assertRejected(noPassword, { passwordEnv: 'X' }, 'invalid-input', /applies only to basic authentication/);
});

test('existing files lacking an endpoint or using shipped placeholder models are incomplete and left untouched', async t => {
  const s = await sandbox(t);
  const template = await read(path.join(repository, 'examples', 'heimdall.toml'));
  await fs.writeFile(s.projectFile, template);
  const result = await assertRejected(s, complete, 'incomplete-configuration', /--config/);
  assert.deepEqual(result.error.missing, ['opencode.baseUrl', 'workflow.plannerModel', 'workflow.executorCandidates[0].model']);
  assert.ok(result.error.message.includes(s.projectFile));
  assert.equal(result.targets.project.path, s.projectFile);
  assert.equal(await read(s.projectFile), template, 'preserved byte for byte');
  assert.equal((await assertRejected(s, {}, 'incomplete-configuration')).partial, null);

  const real = '[workflow]\nplannerModel = "anthropic/p"\n[[workflow.executorCandidates]]\nkey = "a"\nquotaProvider = "anthropic"\nmodel = "anthropic/e"\n';
  await fs.writeFile(s.projectFile, real);
  assert.deepEqual((await assertRejected(s, {}, 'incomplete-configuration')).error.missing, ['opencode.baseUrl']);
  await fs.writeFile(s.projectFile, real + '[[workflow.executorCandidates]]\nkey = "b"\nquotaProvider = "openai"\nmodel = "openai/your-executor-model"\n[opencode]\nbaseUrl = "http://127.0.0.1:4096"\n');
  assert.deepEqual((await assertRejected(s, {}, 'incomplete-configuration')).error.missing, ['workflow.executorCandidates[1].model']);
  await fs.writeFile(s.projectFile, '[workflow]\nplannerModel = "anthropic/your-planner-model"\nexecutorModel = "anthropic/your-executor-model"\nexecutorFallbackModel = "anthropic/your-executor-model"\n[opencode]\nbaseUrl = "http://127.0.0.1:4096"\n');
  assert.deepEqual((await assertRejected(s, {}, 'incomplete-configuration')).error.missing, ['workflow.plannerModel', 'workflow.executorModel', 'workflow.executorFallbackModel']);
});

test('invalid models, endpoints, authentication, environment names and claude-code pairings are rejected without writes', async t => {
  const s = await sandbox(t);
  const invalid = [
    [{ plannerModel: 'planner' }, /plannerModel must use provider\/model syntax/],
    [{ plannerModel: 'anthropic/your-planner-model' }, /placeholder/],
    [{ executorModel: 'openai/your-executor-model' }, /placeholder/],
    [{ executorModel: 'anthropic/your-executor-model' }, /placeholder/],
    [{ executorModel: 'executor' }, /model must use provider\/model syntax/],
    [{ plannerModel: 'a/b#c' }, /provider\/model syntax/],
    [{ quotaProvider: 'bogus' }, /quotaProvider must be/],
    [{ quotaProvider: 'claude-code' }, /Claude Code candidates must pair/],
    [{ quotaProvider: 'anthropic', executorModel: 'claude-code/sonnet' }, /Claude Code candidates must pair/],
    [{ quotaProvider: 'claude-code', executorModel: 'anthropic/sonnet' }, /Claude Code candidates must pair/],
    [{ opencodeUrl: 'https://example.com' }, /local HTTP\(S\) origin/],
    [{ opencodeUrl: 'http://127.0.0.1:4096/api' }, /local HTTP\(S\) origin/],
    [{ opencodeUrl: 'not a url' }, /valid URL/],
    [{ opencodeAuth: 'token' }, /authentication must be basic, none, or openchamber/],
    [{ passwordEnv: 'bad-name' }, /environment variable name/],
    [{ passwordEnv: 'has space' }, /environment variable name/],
    [{ opencodeAuth: 'openchamber', passwordEnv: 'OPENCODE_PASSWORD' }, /only to basic authentication/],
    [{ plannerModel: 42 }, /plannerModel must be a string/],
    [{ globalConcurrency: 0 }, /globalConcurrency must be a positive integer/],
    [{ globalConcurrency: 1.5 }, /globalConcurrency must be a positive integer/],
    [{ projectConcurrency: -1 }, /projectConcurrency must be a positive integer/],
    [{ projectConcurrency: '2' }, /projectConcurrency must be a positive integer/],
    [{ stateDirectory: '   ' }, /stateDirectory must be a nonempty path/],
    [{ stateDirectory: '/' + 'x'.repeat(120) }, /too long for a portable Unix socket path/],
  ];
  for (const [input, pattern] of invalid) await assertRejected(s, { ...complete, ...input }, 'invalid-input', pattern);
  const credentials = await assertRejected(s, { ...complete, opencodeUrl: 'http://user:secretpw@127.0.0.1:4096' }, 'invalid-input', /without embedded credentials/);
  assert.equal(JSON.stringify(credentials).includes('secretpw'), false, 'credential-bearing input is never echoed');
  const pairing = await s.run({ ...complete, executorModel: 'claude-code/sonnet', quotaProvider: 'claude-code' });
  assert.equal(pairing.ok, true, JSON.stringify(pairing.error));
});

test('new project files require every decision and name the flags that supply them', async t => {
  const s = await sandbox(t);
  const flags = ['--planner-model', '--executor-model', '--quota-provider', '--opencode-url', '--opencode-auth'];
  assert.deepEqual((await assertRejected(s, {}, 'missing-input', /--planner-model.*--opencode-auth/)).error.missing, flags);
  for (const key of Object.keys(complete)) {
    const { [key]: _omitted, ...rest } = complete;
    const result = await assertRejected(s, rest, 'missing-input');
    assert.equal(result.error.missing.length, 1);
  }
  const partial = await assertRejected(s, { plannerModel: 'anthropic/p', opencodeAuth: 'none' }, 'missing-input');
  assert.deepEqual(partial.error.missing, ['--executor-model', '--quota-provider', '--opencode-url']);
});

test('a complete existing project needs no inputs and the missing coordinator file is created from defaults', async t => {
  const s = await sandbox(t);
  await fs.writeFile(s.projectFile, richProject);
  const result = await s.run({});
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual([result.targets.coordinator.outcome, result.targets.project.outcome], ['created', 'reused']);
  assert.equal(await read(s.projectFile), richProject);
  const coordinator = await loadCoordinatorConfiguration(s.coordinatorFile);
  assert.deepEqual([coordinator.globalConcurrency, coordinator.projectConcurrency], [1, 1]);
});

test('malformed, schema-invalid, symlink, directory and unreadable-parent destinations fail without writes', async t => {
  const secret = 'secretpw';
  for (const target of ['project', 'coordinator']) {
    const s = await sandbox(t);
    await fs.mkdir(path.dirname(s.coordinatorFile), { recursive: true });
    const file = target === 'project' ? s.projectFile : s.coordinatorFile;
    const other = target === 'project' ? s.coordinatorFile : s.projectFile;
    const input = target === 'project' ? complete : { ...complete };

    await fs.writeFile(file, `broken = [ "${secret}"\n`);
    const malformed = await assertRejected(s, input, 'invalid-configuration', new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(JSON.stringify(malformed).includes(secret), false, 'file content is not quoted back');
    assert.equal(await fs.stat(other).then(() => true, () => false), false, 'the other target was not created');

    await fs.writeFile(file, target === 'project' ? '[workflow]\nplannerModel = "x"\n' : '[coordinator]\nbogus = 1\n');
    await assertRejected(s, input, 'invalid-configuration');
    await fs.writeFile(file, target === 'project' ? `${richProject}\n[unknown]\n` : '[server]\nport = 1\n');
    await assertRejected(s, input, 'invalid-configuration');

    await fs.rm(file);
    const real = path.join(s.root, 'real.toml');
    await fs.writeFile(real, richProject);
    await fs.symlink(real, file);
    await assertRejected(s, input, 'invalid-destination', /symbolic link/);
    assert.equal(await read(real), richProject);
    await fs.rm(file);
    await fs.symlink(path.join(s.root, 'dangling.toml'), file);
    await assertRejected(s, input, 'invalid-destination', /symbolic link/);
    await fs.rm(file);

    await fs.mkdir(file);
    await assertRejected(s, input, 'invalid-destination', /not a regular file/);
    await fs.rmdir(file);

    const blocked = path.join(s.root, 'blocked');
    await fs.writeFile(blocked, 'file');
    await assertRejected(s, target === 'project' ? { ...input, configPath: path.join(blocked, 'sub', 'x.toml') } : { ...input, coordinatorConfigPath: path.join(blocked, 'sub', 'x.toml') }, 'invalid-destination');
  }
});

test('destinations that resolve to the same file are rejected before any write', async t => {
  const s = await sandbox(t);
  const shared = path.join(s.project, 'one.toml');
  await assertRejected(s, { ...complete, configPath: shared, coordinatorConfigPath: shared }, 'identical-destinations', /same file/);
  await fs.mkdir(path.join(s.root, 'real'));
  await fs.symlink(path.join(s.root, 'real'), path.join(s.root, 'alias'));
  await assertRejected(s, { ...complete, configPath: path.join(s.root, 'real', 'x.toml'), coordinatorConfigPath: path.join(s.root, 'alias', 'x.toml') }, 'identical-destinations');
  await assertRejected(s, { ...complete, configPath: path.join(s.root, 'real', 'y', 'x.toml'), coordinatorConfigPath: path.join(s.root, 'alias', 'y', '..', 'y', 'x.toml') }, 'identical-destinations');
  await fs.writeFile(path.join(s.root, 'real', 'h.toml'), richProject);
  await fs.link(path.join(s.root, 'real', 'h.toml'), path.join(s.root, 'real', 'h2.toml'));
  await assertRejected(s, { configPath: path.join(s.root, 'real', 'h.toml'), coordinatorConfigPath: path.join(s.root, 'real', 'h2.toml') }, 'identical-destinations');
});

test('the project must be an existing Git project with a commit; Git is never initialized', async t => {
  const plain = await sandbox(t, { git: false });
  const error = await assertRejected(plain, complete, 'no-git-project', /does not initialize Git/);
  assert.equal(error.projectDirectory, null);
  assert.equal(await fs.stat(path.join(plain.project, '.git')).then(() => true, () => false), false);
  await assertRejected(plain, { ...complete, projectDirectory: path.join(plain.root, 'missing') }, 'no-git-project');

  const empty = await sandbox(t, { commit: false });
  await assertRejected(empty, complete, 'no-commit', /does not create commits/);

  const s = await sandbox(t);
  await fs.mkdir(path.join(s.project, 'packages', 'app'), { recursive: true });
  const result = await s.run({ ...complete, projectDirectory: path.join(s.project, 'packages', 'app') });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.projectDirectory, s.project, 'the Git toplevel is the project');
  assert.equal(result.targets.project.path, s.projectFile);
  const current = await sandbox(t);
  const cwd = path.join(current.project, 'sub');
  await fs.mkdir(cwd);
  const implicit = await runSetup(complete, { ...current.options, cwd });
  assert.equal(implicit.ok, true, JSON.stringify(implicit.error));
  assert.equal(implicit.projectDirectory, current.project, 'defaults to the current Git project');
});

test('configuration locations follow explicit, environment, then default precedence', async t => {
  const s = await sandbox(t);
  const environment = { HEIMDALL_CONFIG: 'from-env.toml', HEIMDALL_COORDINATOR_CONFIG: path.join(s.root, 'env-coordinator.toml') };
  const planned = await planSetup({ projectDirectory: s.project, ...complete }, { ...s.options, environment });
  assert.equal(planned.project.path, path.join(s.project, 'from-env.toml'));
  assert.equal(planned.coordinator.path, environment.HEIMDALL_COORDINATOR_CONFIG);
  assert.equal(planned.project.action, 'create');
  const explicit = await planSetup({ projectDirectory: s.project, ...complete, configPath: 'explicit.toml', coordinatorConfigPath: 'rel/coordinator.toml' }, { ...s.options, environment });
  assert.equal(explicit.project.path, path.join(s.project, 'explicit.toml'));
  assert.equal(explicit.coordinator.path, path.join(s.root, 'rel', 'coordinator.toml'), 'relative coordinator paths resolve against the working directory');
  const blank = await planSetup({ projectDirectory: s.project, ...complete }, { ...s.options, environment: { HEIMDALL_CONFIG: '' } });
  assert.equal(blank.project.path, s.projectFile, 'an empty HEIMDALL_CONFIG is ignored like the CLI does');
  assert.equal(blank.coordinator.path, s.coordinatorFile);
  assert.deepEqual(await tree(s.root), ['home/', 'project/'], 'planning writes nothing');
  const result = await s.run(complete, { environment });
  assert.equal(result.ok, true);
  assert.equal((await loadConfiguration({ projectDirectory: s.project, configPath: 'from-env.toml' })).settings.plannerModel, 'anthropic/planner-x');
});

const sorted = async directory => (await fs.readdir(directory)).sort();

test('a destination created after validation is never overwritten', async t => {
  const s = await sandbox(t);
  const intruder = async (target, existing, created) => {
    if (created === target) await fs.writeFile(created, 'intruder = true\n');
    return fs.link(existing, created);
  };
  // First published file.
  const first = await s.run(complete, { operations: { link: (existing, created) => intruder(s.coordinatorFile, existing, created) } });
  assert.equal(first.ok, false);
  assert.equal(first.error.code, 'destination-exists');
  assert.equal(first.targets.coordinator.outcome, 'failed');
  assert.equal(first.targets.project.outcome, 'not-written');
  assert.equal(first.partial, null);
  assert.equal(await read(s.coordinatorFile), 'intruder = true\n');
  assert.deepEqual(await sorted(path.dirname(s.coordinatorFile)), ['coordinator.toml'], 'own temporary file removed');
  assert.deepEqual(await sorted(s.project), ['.git'], 'the project file was not attempted after the failure');

  // Second published file: the first is reported as created, the intruder is untouched.
  const t2 = await sandbox(t);
  const second = await t2.run(complete, { operations: { link: (existing, created) => intruder(t2.projectFile, existing, created) } });
  assert.equal(second.error.code, 'destination-exists');
  assert.deepEqual([second.targets.coordinator.outcome, second.targets.project.outcome], ['created', 'failed']);
  assert.deepEqual(second.partial, { created: [t2.coordinatorFile], incomplete: [t2.projectFile] });
  assert.equal(await read(t2.projectFile), 'intruder = true\n');
  assert.deepEqual(await sorted(t2.project), ['.git', '.heimdall.toml']);
  // Rerunning validates and reuses what the other process created.
  const rerun = await t2.run(complete);
  assert.equal(rerun.error.code, 'invalid-configuration');
  assert.equal(await read(t2.projectFile), 'intruder = true\n');
});

test('a failed write leaves no empty or truncated final file and no temporary file', async t => {
  const s = await sandbox(t);
  const created = [];
  const failing = {
    createTemporary: async (file, fileMode) => {
      const handle = await fs.open(file, 'wx', fileMode);
      created.push(file);
      return {
        writeFile: async data => { await handle.writeFile(data.slice(0, 10), 'utf8'); throw Object.assign(new Error('simulated disk failure'), { code: 'ENOSPC' }); },
        sync: () => handle.sync(),
        close: () => handle.close(),
      };
    },
  };
  const result = await s.run(complete, { operations: failing });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'write-failed');
  assert.match(result.error.message, /simulated disk failure/);
  assert.deepEqual([result.targets.coordinator.outcome, result.targets.project.outcome], ['failed', 'not-written']);
  assert.equal(result.partial, null);
  assert.equal(created.length, 1, 'a temporary file was attempted');
  assert.equal(await fs.stat(created[0]).then(() => true, () => false), false, 'own temporary file removed');
  assert.equal(await fs.stat(s.coordinatorFile).then(() => true, () => false), false, 'no final file');
  assert.deepEqual(await sorted(path.dirname(s.coordinatorFile)), []);
  assert.deepEqual(result.createdDirectories, [path.join(s.home, '.config'), path.join(s.home, '.config', 'heimdall')], 'directories created before the failure are reported');
  const clean = await s.run(complete);
  assert.equal(clean.ok, true);
  assert.deepEqual(clean.createdDirectories, []);
  assert.deepEqual([clean.targets.coordinator.outcome, clean.targets.project.outcome], ['created', 'created']);
});

test('a failure after the first file is published reports the exact partial outcome and a rerun finishes', async t => {
  const s = await sandbox(t);
  const failing = { link: async (existing, created) => { if (created === s.projectFile) throw Object.assign(new Error('simulated I/O error'), { code: 'EIO' }); return fs.link(existing, created); } };
  const result = await s.run(complete, { operations: failing });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'write-failed');
  assert.deepEqual([result.targets.coordinator.outcome, result.targets.project.outcome], ['created', 'failed']);
  assert.deepEqual(result.partial, { created: [s.coordinatorFile], incomplete: [s.projectFile] });
  assert.ok(result.error.message.includes(`Created: ${s.coordinatorFile}`));
  assert.ok(result.error.message.includes(`Incomplete: ${s.projectFile}`));
  assert.match(result.error.message, /rerun/i);
  assert.equal(result.verification.level, 'none');
  assert.equal(await fs.stat(s.projectFile).then(() => true, () => false), false);
  assert.equal((await tree(s.root)).some(entry => entry.endsWith('.tmp')), false, 'own temporary file removed, the created file kept');
  const createdContent = await fs.readFile(s.coordinatorFile);

  const rerun = await s.run(complete);
  assert.equal(rerun.ok, true, JSON.stringify(rerun.error));
  assert.deepEqual([rerun.targets.coordinator.outcome, rerun.targets.project.outcome], ['reused', 'created']);
  assert.deepEqual(await fs.readFile(s.coordinatorFile), createdContent);
  assert.equal((await loadConfiguration({ projectDirectory: s.project })).settings.plannerModel, 'anthropic/planner-x');
});

test('a failed temporary-file unlink after publishing is a warning, not a failure', async t => {
  const s = await sandbox(t);
  const result = await s.run(complete, { operations: { unlink: async () => { throw Object.assign(new Error('cannot unlink'), { code: 'EPERM' }); } } });
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 2);
  assert.match(result.warnings[0], /Could not remove temporary file/);
});

test('setup performs no network access and imports no network module', async t => {
  const s = await sandbox(t);
  const original = globalThis.fetch;
  const attempts = [];
  globalThis.fetch = (...args) => { attempts.push(args); throw new Error('network is forbidden in setup'); };
  t.after(() => { globalThis.fetch = original; });
  const before = await tree(s.root);
  assert.equal((await s.run({ ...complete, opencodeAuth: 'openchamber' })).ok, true);
  assert.deepEqual(attempts, []);
  assert.deepEqual((await tree(s.root)).filter(entry => !before.includes(entry)), ['home/.config/', 'home/.config/heimdall/', 'home/.config/heimdall/coordinator.toml', 'project/.heimdall.toml'], 'no state directory, socket, database, snapshot or other file');
  assert.equal(await fs.stat(path.join(s.home, '.local')).then(() => true, () => false), false);
  assert.equal(await fs.stat(path.join(s.project, '.heimdall')).then(() => true, () => false), false);

  // Static: every local module reachable from the setup entry point.
  const distribution = path.join(repository, 'dist');
  const seen = new Set();
  const pending = [path.join(distribution, 'setup', 'index.js')];
  const external = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = await read(file);
    // The quota policy modules are imported only for executorCandidates; they hold the provider usage fetchers, which setup never calls.
    // Their member calls such as provider.fetch(...) are allowed, a direct fetch(...) call is not.
    const pattern = file.startsWith(path.join(distribution, 'policy') + path.sep) ? /(?<![.\w])fetch\s*\(|XMLHttpRequest|WebSocket|EventSource/ : /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource/;
    assert.doesNotMatch(source, pattern, file);
    for (const [, specifier] of source.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)) {
      if (specifier.startsWith('.')) pending.push(path.resolve(path.dirname(file), specifier));
      else external.add(specifier.replace(/^node:/, ''));
    }
  }
  const relative = [...seen].map(file => path.relative(distribution, file)).sort();
  for (const expected of ['config.js', path.join('coordinator', 'config.js'), path.join('coordinator', 'worktrees.js'), path.join('setup', 'core.js'), path.join('setup', 'publish.js')]) assert.ok(relative.includes(expected), expected);
  for (const forbidden of ['http', 'https', 'http2', 'net', 'tls', 'dgram', 'dns', 'dns/promises', 'undici', 'ws']) assert.equal(external.has(forbidden), false, `imports ${forbidden}`);
  assert.deepEqual([...external].filter(name => !name.startsWith('fs') && !['path', 'os', 'crypto', 'url', 'child_process', 'util', 'readline/promises'].includes(name)), ['smol-toml']);
});
