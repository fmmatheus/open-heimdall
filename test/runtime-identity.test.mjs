import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { computeRuntimeIdentity, runtimeIdentity, runtimeMismatch } from '../dist/workflow/runtime-identity.js';
import { admitRuntime, createRuntimeSnapshot, snapshotLoader, snapshotRoot, sourcePackageRoot, verifyRuntimeSnapshot } from '../dist/coordinator/runtime-snapshot.js';
import { prepareRuntime } from '../dist/coordinator/runtime.js';
import { createManagedExecutor } from '../dist/coordinator/executor.js';
import { createPlugin } from '../dist/opencode/plugin.js';
import { createRunner } from '../dist/workflow/runner.js';

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** A minimal package with the layout of the real one: dist, prompts, agents, a lockfile and installed dependencies. */
async function fakePackage(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-runtime-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'source');
  const write = async (file, content, root = source) => { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), content); };
  await write('package.json', JSON.stringify({ name: '@fake/core', version: '1.2.3', type: 'module', dependencies: { dep: '1.0.0' } }));
  await write('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/dep': { version: '1.0.0' }, 'node_modules/devonly': { version: '1.0.0', dev: true } } }));
  await write('dist/index.js', "export const marker = 'build-one';\n");
  await write('dist/nested/helper.js', 'export const helper = 1;\n');
  await write('dist/opencode/plugin.js', 'export const createPlugin = () => null;\n');
  await write('prompts/planner.md', 'planner prompt\n');
  await write('examples/opencode/agents/adr-planner.md', 'planner agent\n');
  await write('node_modules/dep/package.json', JSON.stringify({ name: 'dep', version: '1.0.0' }));
  await write('node_modules/devonly/package.json', JSON.stringify({ name: 'devonly', version: '1.0.0' }));
  return { base, source, write };
}

/** An admitted run whose managed namespace is `<base>/ns` and whose checkout is `<base>/ns/checkout`. */
async function admittedRun(f, overrides = {}) {
  const runtime = await admitRuntime(f.source);
  const checkout = path.join(f.base, 'ns', 'checkout');
  await fs.mkdir(path.join(checkout, '.heimdall'), { recursive: true });
  return {
    id: 'run-one', ownerToken: 'owner', capacityReserved: true, version: 1, parentSessionId: 'ses_one', promptMessageId: 'msg_one', worktreePath: checkout,
    launchAction: 'start', resolution: null, checkpoint: null, feature: 'Feature',
    specification: { settings: { plannerAgent: 'adr-planner', executorAgent: 'adr-executor', plannerModel: 'anthropic/planner' }, plannerPrompt: 'p', executorPrompt: 'e', agents: { 'adr-planner': 'x' }, opencode: { baseUrl: 'http://127.0.0.1:4096', passwordEnvironmentVariable: 'SYNTHETIC_PASSWORD' }, runtime },
    ...overrides,
  };
}

async function snapshotOf(f) {
  const run = await admittedRun(f);
  const root = await createRuntimeSnapshot(run, f.source);
  const config = path.join(run.worktreePath, '.heimdall/runtime.toml');
  const loader = path.join(run.worktreePath, '.opencode/plugins/heimdall.ts');
  await fs.mkdir(path.dirname(loader), { recursive: true });
  await fs.writeFile(loader, snapshotLoader(root, config, run.specification.runtime.identity.build.digest));
  return { run, root, loader };
}

const writable = async file => { await fs.chmod(file, 0o644); return file; };
const executorFor = (run, calls) => createManagedExecutor({
  getRun: () => run, preflightTimeoutMs: 1000,
  connection: { environment: { SYNTHETIC_PASSWORD: 'synthetic-secret' }, fetchImpl: async () => { calls.push('fetch'); throw new Error('native API must not be contacted'); } },
});

test('identity is computed from the package files and changes only with executable runtime content', async t => {
  const f = await fakePackage(t);
  const first = computeRuntimeIdentity(f.source);
  assert.deepEqual(computeRuntimeIdentity(f.source), first, 'stable when nothing changed');
  assert.equal(first.packageVersion, '1.2.3');
  assert.equal(first.protocol, 'structured-v1');
  assert.equal(first.build.packageName, '@fake/core');
  assert.deepEqual(first.build.contracts, { 'planner-plan': 1, 'executor-result': 1 });
  assert.deepEqual(first.build.dependencies.direct, { dep: '1.0.0' });
  assert.match(first.build.dependencies.lockfile, /^[0-9a-f]{64}$/);
  assert.equal(first.build.snapshot, false);
  // Files that never execute, and development-only packages, are not part of the identity.
  await f.write('dist/index.d.ts', 'export declare const marker: string;\n');
  await f.write('dist/index.js.map', '{}');
  await f.write('node_modules/devonly/package.json', JSON.stringify({ name: 'devonly', version: '2.0.0' }));
  assert.deepEqual(computeRuntimeIdentity(f.source), first);
  const changes = [
    ['dist/index.js', "export const marker = 'build-two';\n", /\(dist\) content changed/, 'dist'],
    ['dist/nested/helper.js', 'export const helper = 2;\n', /\(dist\) content changed/, 'dist'],
    ['dist/added.js', 'export {};\n', /\(dist\) content changed/, 'dist'],
    ['prompts/planner.md', 'changed prompt\n', /prompt content changed/, 'prompts'],
    ['examples/opencode/agents/adr-planner.md', 'changed agent\n', /agent file content changed/, 'agents'],
    ['package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/dep': { version: '1.0.1' } } }), /lockfile changed/, 'dependencies'],
    ['node_modules/dep/package.json', JSON.stringify({ name: 'dep', version: '1.0.5' }), /dependency identity changed/, 'dependencies'],
  ];
  for (const [file, content, reason, field] of changes) {
    const baseline = computeRuntimeIdentity(f.source);
    const original = await fs.readFile(path.join(f.source, file)).catch(() => undefined);
    await f.write(file, content);
    const changed = computeRuntimeIdentity(f.source);
    assert.notEqual(changed.build.digest, baseline.build.digest, file);
    assert.notDeepEqual(changed.build[field], baseline.build[field], file);
    assert.match(runtimeMismatch(baseline, changed), reason, file);
    assert.equal(runtimeMismatch(baseline, baseline), undefined);
    if (original) await fs.writeFile(path.join(f.source, file), original); else await fs.rm(path.join(f.source, file));
    assert.deepEqual(computeRuntimeIdentity(f.source), baseline, file + ' restored');
  }
});

test('the loaded plugin reports the identity of its own package, not the Git revision', async () => {
  const loaded = runtimeIdentity();
  const manifest = JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8'));
  assert.equal(loaded.packageVersion, manifest.version);
  assert.equal(loaded.protocol, 'structured-v1');
  assert.equal(loaded.build.packageName, manifest.name);
  assert.equal(loaded.build.snapshot, false);
  assert.equal(loaded.build.digest, computeRuntimeIdentity(sourcePackageRoot()).build.digest);
  assert.ok(Object.keys(loaded.build.dependencies.direct).length > 0);
  assert.ok(Object.values(loaded.build.dependencies.direct).every(version => /^\d/.test(version)), 'every runtime dependency resolves to an installed version');
  loaded.build.dist = 'mutated';
  assert.notEqual(runtimeIdentity().build.dist, 'mutated', 'callers receive a copy');
});

test('a new standalone run records the loaded runtime and an injected one is recorded verbatim', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-runtime-run-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'ADR.md'), 'Feature specification');
  const settings = { plannerAgent: 'planner', executorAgent: 'executor', plannerModel: 'anthropic/planner', executorModel: 'anthropic/executor', executorFallbackModel: 'kimi/fallback', maxTasks: 10, minQuotaRemainingPercent: 10, tokenLimitsDisabled: true };
  const quota = async () => ({ anthropic: { fetchedAt: Date.now(), errors: [], entries: [{ name: '5h', percentRemaining: 80 }, { name: 'Weekly', percentRemaining: 80 }] } });
  const started = async (workflowRoot, options = {}) => {
    const backend = {
      assertIdle: async () => {}, recoverResponse: async () => undefined, usage: async () => ({ used: 0, uncached: 0 }), interrupt: async () => {},
      runSubagent: async input => { await input.onStarted('child-1'); throw new Error('stop after the run started'); },
    };
    const run = createRunner({ directory, backend, quota, settings, workflowRoot, planRoot: workflowRoot + '-plans', git: args => args[0] === 'branch' ? 'main\n' : '', ...options });
    await run({ action: 'start', adr: 'ADR.md' }, { sessionID: 'parent', signal: new AbortController().signal }).catch(() => {});
    const [id] = await fs.readdir(path.join(directory, workflowRoot, 'runs'));
    return JSON.parse(await fs.readFile(path.join(directory, workflowRoot, 'runs', id, 'state.json'), 'utf8'));
  };
  const state = await started('default-state');
  assert.deepEqual(state.runtime, runtimeIdentity());
  assert.match(state.runtime.build.digest, /^[0-9a-f]{64}$/);
  const injected = { packageVersion: '9.9.9', protocol: 'structured-v1' };
  assert.deepEqual((await started('injected-state', { runtime: () => injected })).runtime, injected);
});

test('an immutable run-owned snapshot is unaffected by a later rebuild of the shared package', async t => {
  const f = await fakePackage(t);
  const { run, root, loader } = await snapshotOf(f);
  const admitted = run.specification.runtime;
  assert.equal(root, snapshotRoot(run));
  assert.equal(root, path.join(f.base, 'ns', 'runtime'));
  assert.ok(!root.startsWith(f.source) && !root.startsWith(run.worktreePath), 'outside the shared package and the mutable checkout');
  assert.equal(admitted.identity.build.snapshot, false);
  const snapshot = computeRuntimeIdentity(root);
  assert.equal(snapshot.build.snapshot, true);
  assert.equal(snapshot.build.digest, admitted.identity.build.digest);
  assert.equal(runtimeMismatch(admitted.identity, snapshot), undefined);
  assert.equal(await fs.readlink(path.join(root, 'node_modules')), admitted.modules);
  for (const file of ['package.json', 'dist/index.js', 'prompts/planner.md', 'examples/opencode/agents/adr-planner.md']) assert.equal((await fs.stat(path.join(root, file))).mode & 0o222, 0, file + ' is read-only');
  await assert.rejects(fs.writeFile(path.join(root, 'dist/index.js'), 'x'), /EACCES/);
  await verifyRuntimeSnapshot(run);
  const loaderText = await fs.readFile(loader, 'utf8');
  assert.ok(loaderText.includes(pathToFileURL(path.join(root, 'dist/opencode/plugin.js')).href));
  assert.ok(loaderText.includes(admitted.identity.build.digest));
  assert.ok(!loaderText.includes(f.source), 'the loader never names the shared package');

  // The shared package is rebuilt after admission.
  await f.write('dist/index.js', "export const marker = 'build-two';\n");
  await f.write('dist/added.js', 'export {};\n');
  await f.write('prompts/planner.md', 'rewritten prompt\n');
  assert.notEqual(computeRuntimeIdentity(f.source).build.digest, admitted.identity.build.digest, 'the shared package really changed');
  assert.equal(await fs.readFile(path.join(root, 'dist/index.js'), 'utf8'), "export const marker = 'build-one';\n");
  assert.equal(await fs.readFile(path.join(root, 'prompts/planner.md'), 'utf8'), 'planner prompt\n');
  assert.equal(computeRuntimeIdentity(root).build.digest, admitted.identity.build.digest);
  assert.equal(await fs.readFile(loader, 'utf8'), loaderText);
  await verifyRuntimeSnapshot(run);
  const executed = execFileSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(pathToFileURL(path.join(root, 'dist/index.js')).href)}).then(module => console.log(module.marker))`], { encoding: 'utf8' }).trim();
  assert.equal(executed, 'build-one', 'the code the run executes is still the admitted build');
});

test('a snapshot is written exclusively and refused when the source changed after admission', async t => {
  const f = await fakePackage(t);
  const run = await admittedRun(f);
  await f.write('dist/index.js', "export const marker = 'late-edit';\n");
  await assert.rejects(createRuntimeSnapshot(run, f.source), /package changed after this run was admitted \(Runtime build \(dist\) content changed\)/);
  const second = await fakePackage(t);
  const fresh = await snapshotOf(second);
  await assert.rejects(createRuntimeSnapshot(fresh.run, second.source), /EEXIST/);
  await verifyRuntimeSnapshot(fresh.run);
});

const tampers = [
  ['edited dist file', /Runtime build \(dist\) content changed/, async s => fs.writeFile(await writable(path.join(s.root, 'dist/index.js')), "export const marker = 'tampered';\n")],
  ['added executable file', /Runtime build \(dist\) content changed/, async s => fs.writeFile(path.join(s.root, 'dist/evil.js'), 'export {};\n')],
  ['removed dist file', /Runtime build \(dist\) content changed/, async s => fs.rm(path.join(s.root, 'dist/nested/helper.js'))],
  ['edited prompt', /prompt content changed/, async s => fs.writeFile(await writable(path.join(s.root, 'prompts/planner.md')), 'tampered\n')],
  ['edited agent file', /agent file content changed/, async s => fs.writeFile(await writable(path.join(s.root, 'examples/opencode/agents/adr-planner.md')), 'tampered\n')],
  ['edited lockfile', /dependency lockfile changed/, async s => fs.writeFile(await writable(path.join(s.root, 'package-lock.json')), '{"lockfileVersion":3,"packages":{}}')],
  ['changed installed dependency version', /dependency identity changed/, async s => s.f.write('node_modules/dep/package.json', JSON.stringify({ name: 'dep', version: '1.0.9' }))],
  ['removed installed dependency', /dependency identity changed/, async s => fs.rm(path.join(s.f.source, 'node_modules/dep'), { recursive: true })],
  ['re-pointed dependency location', /dependency location is not the recorded/, async s => {
    await s.f.write('other/dep/package.json', JSON.stringify({ name: 'dep', version: '1.0.0' }), s.f.base);
    await fs.rm(path.join(s.root, 'node_modules')); await fs.symlink(path.join(s.f.base, 'other'), path.join(s.root, 'node_modules'));
  }],
  ['loader importing the live package', /active plugin loader does not import the admitted snapshot/, async s => fs.writeFile(s.loader, `import { createPlugin } from ${JSON.stringify(pathToFileURL(path.join(s.f.source, 'dist/opencode/plugin.js')).href)};\nexport default createPlugin({});\n`)],
  ['loader without the runtime check', /active plugin loader does not import the admitted snapshot/, async s => fs.writeFile(s.loader, (await fs.readFile(s.loader, 'utf8')).replace(/, expectedRuntime: "[0-9a-f]+"/, ''))],
  ['missing loader', /heimdall.ts is missing/, async s => fs.rm(s.loader)],
  ['missing snapshot', /runtime is missing/, async s => fs.rm(s.root, { recursive: true })],
  ['snapshot of another run', /different admitted runtime/, async s => fs.writeFile(await writable(path.join(s.root, '.heimdall-runtime-snapshot.json')), JSON.stringify({ version: 1, runId: 'another-run' }))],
];
for (const [name, reason, tamper] of tampers) {
  test(`launch and resume refuse a tampered snapshot: ${name}`, async t => {
    const f = await fakePackage(t);
    const s = { f, ...await snapshotOf(f) };
    await verifyRuntimeSnapshot(s.run);
    await tamper(s);
    await assert.rejects(verifyRuntimeSnapshot(s.run), reason);
    for (const launchAction of ['start', 'resume']) {
      const calls = [];
      const run = { ...s.run, launchAction, resolution: launchAction === 'resume' ? 'Resolved' : null };
      await assert.rejects(executorFor(run, calls).launch(run), error => {
        assert.match(error.message, /^Runtime snapshot refused for run run-one: /);
        assert.match(error.message, reason);
        return true;
      });
      assert.deepEqual(calls, [], launchAction + ' refused before any native request');
    }
  });
}

test('resume refuses before rewriting managed metadata, and accepts an intact snapshot', async t => {
  const f = await fakePackage(t);
  const s = await snapshotOf(f);
  const metadata = { endpoint: 'endpoint', runId: 'run-one', ownerToken: 'owner', parentSessionId: 'ses_one' };
  await fs.writeFile(path.join(s.run.worktreePath, '.heimdall/managed.json'), JSON.stringify({ ...metadata, ownerToken: 'older-owner' }));
  const resume = { ...s.run, launchAction: 'resume' };
  await prepareRuntime(resume, 'endpoint');
  assert.equal(JSON.parse(await fs.readFile(path.join(s.run.worktreePath, '.heimdall/managed.json'), 'utf8')).ownerToken, 'owner');
  await fs.writeFile(await writable(path.join(s.root, 'dist/index.js')), 'tampered');
  await fs.writeFile(path.join(s.run.worktreePath, '.heimdall/managed.json'), JSON.stringify({ ...metadata, ownerToken: 'older-owner' }));
  await assert.rejects(prepareRuntime(resume, 'endpoint'), /Runtime snapshot refused for run run-one: Runtime build \(dist\) content changed/);
  assert.equal(JSON.parse(await fs.readFile(path.join(s.run.worktreePath, '.heimdall/managed.json'), 'utf8')).ownerToken, 'older-owner', 'nothing was rewritten');
});

test('preparing a new run copies the package into a run-owned snapshot and generates a loader that imports it', async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-prepare-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const checkout = path.join(base, 'ns', 'checkout');
  await fs.mkdir(checkout, { recursive: true });
  const runtime = await admitRuntime();
  assert.equal(runtime.identity.build.digest, runtimeIdentity().build.digest, 'admission describes the code the coordinator itself loaded');
  const run = {
    id: 'run-new', ownerToken: 'owner', capacityReserved: true, version: 1, parentSessionId: 'ses_new', promptMessageId: 'msg_new', worktreePath: checkout, launchAction: 'start', resolution: null, checkpoint: null, feature: 'Feature',
    specification: { settings: { plannerAgent: 'adr-planner', executorAgent: 'adr-executor', plannerModel: 'anthropic/planner' }, plannerPrompt: 'p', executorPrompt: 'e', agents: { 'adr-planner': 'x' }, opencode: { baseUrl: 'http://127.0.0.1:4096', passwordEnvironmentVariable: 'SYNTHETIC_PASSWORD' }, runtime },
  };
  await prepareRuntime(run, 'endpoint');
  const root = path.join(base, 'ns', 'runtime');
  const loader = await fs.readFile(path.join(checkout, '.opencode/plugins/heimdall.ts'), 'utf8');
  assert.ok(loader.includes(pathToFileURL(path.join(root, 'dist/opencode/plugin.js')).href));
  assert.ok(loader.includes('expectedRuntime') && loader.includes(runtime.identity.build.digest));
  assert.ok(!loader.includes(pathToFileURL(path.join(sourcePackageRoot(), 'dist')).href), 'the live package dist is not imported');
  assert.equal(computeRuntimeIdentity(root).build.digest, runtime.identity.build.digest);
  await verifyRuntimeSnapshot(run);
  await assert.rejects(prepareRuntime(run, 'endpoint'), /EEXIST|exist/, 'an existing runtime is never overwritten');
});

test('a run admitted without a snapshot keeps the live package path and is not pinned', async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-legacy-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const checkout = path.join(base, 'ns', 'checkout');
  await fs.mkdir(checkout, { recursive: true });
  const run = {
    id: 'run-legacy', ownerToken: 'owner', capacityReserved: true, version: 1, parentSessionId: 'ses_old', promptMessageId: 'msg_old', worktreePath: checkout, launchAction: 'start', resolution: null, checkpoint: null, feature: 'Feature',
    specification: { settings: { plannerAgent: 'adr-planner', executorAgent: 'adr-executor', plannerModel: 'anthropic/planner' }, plannerPrompt: 'p', executorPrompt: 'e', agents: { 'adr-planner': 'x' }, opencode: { baseUrl: 'http://127.0.0.1:4096', passwordEnvironmentVariable: 'SYNTHETIC_PASSWORD' } },
  };
  await verifyRuntimeSnapshot(run);
  await prepareRuntime(run, 'endpoint');
  const loader = await fs.readFile(path.join(checkout, '.opencode/plugins/heimdall.ts'), 'utf8');
  assert.ok(loader.includes(pathToFileURL(path.join(sourcePackageRoot(), 'dist/opencode/plugin.js')).href));
  assert.ok(!loader.includes('expectedRuntime'));
  await assert.rejects(fs.lstat(path.join(base, 'ns', 'runtime')), /ENOENT/, 'no snapshot is invented');
  await verifyRuntimeSnapshot({ ...run, launchAction: 'resume' });
  await prepareRuntime({ ...run, launchAction: 'resume' }, 'endpoint');
  await assert.rejects(fs.lstat(path.join(base, 'ns', 'runtime')), /ENOENT/, 'resume does not invent one either');
});

test('the plugin refuses to activate a build other than the one admitted', async () => {
  const context = { location: { directory: path.join(os.tmpdir(), 'heimdall-never-read') } };
  await assert.rejects(createPlugin({ expectedRuntime: '0'.repeat(64) }).setup(context), /does not match the build admitted for this run/);
  await assert.rejects(createPlugin({ expectedRuntime: '' }).setup(context), /does not match the build admitted for this run/);
});

/**
 * An installed package: no package-lock.json, dependencies where npm puts them. `consumer` hoists most of them beside the package
 * in the consumer's node_modules and nests the rest in the package's own node_modules; `global` keeps all of them inside the
 * package, as a global install does. `trans` is only a transitive dependency; `inner` is nested under `nested`.
 */
async function installedPackage(t, layout) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-installed-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const modules = layout === 'consumer' ? path.join(base, 'consumer', 'node_modules') : path.join(base, 'prefix', 'lib', 'node_modules');
  const source = path.join(modules, '@fake', 'core');
  const own = path.join(source, 'node_modules');
  const hoisted = layout === 'consumer' ? modules : own;
  const write = async (file, content, root = source) => { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), content); };
  const manifest = (directory, name, version, dependencies = {}, extra = {}) => write('package.json', JSON.stringify({ name, version, dependencies, ...extra }), directory);
  await write('package.json', JSON.stringify({ name: '@fake/core', version: '1.2.3', type: 'module', dependencies: { dep: '1.0.0', '@sc/scoped': '2.0.0', nested: '3.0.0' }, optionalDependencies: { absent: '1.0.0' } }));
  await write('dist/index.js', "export const marker = 'build-one';\n");
  await write('dist/opencode/plugin.js', 'export const createPlugin = () => null;\n');
  await write('prompts/planner.md', 'planner prompt\n');
  await write('examples/opencode/agents/adr-planner.md', 'planner agent\n');
  await manifest(path.join(hoisted, 'dep'), 'dep', '1.0.0', { trans: '^0.4.0' });
  await manifest(path.join(hoisted, '@sc', 'scoped'), '@sc/scoped', '2.0.0');
  await manifest(path.join(hoisted, 'trans'), 'trans', '0.4.0');
  // Always nested in the package, with a transitive dependency nested one level further.
  await manifest(path.join(own, 'nested'), 'nested', '3.0.0', { inner: '1.0.0', trans: '^0.4.0' });
  await manifest(path.join(own, 'nested', 'node_modules', 'inner'), 'inner', '1.0.0');
  return { base, source, write, hoisted, own, layout, nested: path.join(own, 'nested'), inner: path.join(own, 'nested', 'node_modules', 'inner'), trans: path.join(hoisted, 'trans') };
}

const locklessLayouts = ['consumer', 'global'];

for (const layout of locklessLayouts) {
  test(`${layout} layout: lockless identity covers every resolved transitive dependency`, async t => {
    const f = await installedPackage(t, layout);
    const first = computeRuntimeIdentity(f.source);
    assert.equal(first.build.dependencies.lockfile, null);
    assert.deepEqual(first.build.dependencies.direct, { '@sc/scoped': '2.0.0', dep: '1.0.0', nested: '3.0.0' });
    assert.deepEqual(computeRuntimeIdentity(f.source), first, 'stable');
    const changes = [
      ['hoisted transitive version', () => f.write('package.json', JSON.stringify({ name: 'trans', version: '0.4.1' }), f.trans)],
      ['nested transitive version', () => f.write('package.json', JSON.stringify({ name: 'inner', version: '1.0.1' }), f.inner)],
      ['removed hoisted transitive', () => fs.rm(f.trans, { recursive: true })],
      ['removed nested transitive', () => fs.rm(f.inner, { recursive: true })],
    ];
    for (const [name, change] of changes) {
      const baseline = computeRuntimeIdentity(f.source);
      const files = await Promise.all([f.trans, f.inner].map(directory => fs.readFile(path.join(directory, 'package.json'), 'utf8').catch(() => undefined)));
      await change();
      const changed = computeRuntimeIdentity(f.source);
      assert.deepEqual(changed.build.dependencies.direct, baseline.build.dependencies.direct, name + ': direct dependencies alone would not notice');
      assert.notEqual(changed.build.digest, baseline.build.digest, name);
      assert.match(runtimeMismatch(baseline, changed), /dependency identity changed/, name);
      for (const [index, directory] of [f.trans, f.inner].entries()) if (files[index]) await f.write('package.json', files[index], directory);
      assert.deepEqual(computeRuntimeIdentity(f.source), baseline, name + ' restored');
    }
  });

  test(`${layout} layout: admission records where each dependency really is and refuses an incomplete tree`, async t => {
    const f = await installedPackage(t, layout);
    const admitted = await admitRuntime(f.source);
    assert.deepEqual(admitted.links, {
      '@sc/scoped': path.join(f.hoisted, '@sc', 'scoped'),
      dep: path.join(f.hoisted, 'dep'),
      nested: f.nested,
    });
    assert.equal(admitted.modules, f.own, 'informational: the package\'s own node_modules, which every layout here has');
    await fs.rm(f.trans, { recursive: true });
    await assert.rejects(admitRuntime(f.source), /not installed for this package \(missing: dep > trans, nested > trans\)/);
  });

  test(`${layout} layout: a snapshot links each dependency to its real location and refuses a changed or removed transitive dependency`, async t => {
    const f = await installedPackage(t, layout);
    const s = { f, ...await snapshotOf(f) };
    const admitted = s.run.specification.runtime;
    assert.deepEqual(Object.keys(admitted.links), ['@sc/scoped', 'dep', 'nested']);
    const marker = JSON.parse(await fs.readFile(path.join(s.root, '.heimdall-runtime-snapshot.json'), 'utf8'));
    assert.equal(marker.version, 2);
    assert.deepEqual(marker.links, admitted.links);
    assert.ok((await fs.lstat(path.join(s.root, 'node_modules'))).isDirectory(), 'a plain directory of links, not one symlink');
    assert.equal(await fs.readlink(path.join(s.root, 'node_modules/@sc/scoped')), admitted.links['@sc/scoped']);
    const snapshot = computeRuntimeIdentity(s.root);
    assert.equal(snapshot.build.snapshot, true);
    assert.equal(snapshot.build.digest, admitted.identity.build.digest, 'the snapshot resolves exactly the installed tree');
    await verifyRuntimeSnapshot(s.run);

    for (const [name, change] of [
      ['changed hoisted transitive', () => f.write('package.json', JSON.stringify({ name: 'trans', version: '0.4.9' }), f.trans)],
      ['changed nested transitive', () => f.write('package.json', JSON.stringify({ name: 'inner', version: '1.9.0' }), f.inner)],
      ['removed hoisted transitive', () => fs.rm(f.trans, { recursive: true })],
      ['removed nested transitive', () => fs.rm(f.inner, { recursive: true })],
      ['removed direct dependency', () => fs.rm(path.join(f.hoisted, 'dep'), { recursive: true })],
    ]) {
      const keep = await fakeBackup(f);
      await change();
      await assert.rejects(verifyRuntimeSnapshot(s.run), /dependency identity changed/, name);
      const calls = [];
      await assert.rejects(executorFor({ ...s.run, launchAction: 'resume', resolution: 'Resolved' }, calls).launch({ ...s.run, launchAction: 'resume', resolution: 'Resolved' }), /Runtime snapshot refused for run run-one: /, name);
      assert.deepEqual(calls, [], name + ': refused before any native request');
      await keep();
      await verifyRuntimeSnapshot(s.run);
    }
  });

  test(`${layout} layout: a snapshot is refused when its dependency links are altered`, async t => {
    for (const [name, alter] of [
      ['extra link', async s => fs.symlink(s.f.trans, path.join(s.root, 'node_modules/trans'), 'dir')],
      ['re-pointed link', async s => { await fs.rm(path.join(s.root, 'node_modules/dep')); await fs.symlink(s.f.trans, path.join(s.root, 'node_modules/dep'), 'dir'); }],
      ['removed link', async s => fs.rm(path.join(s.root, 'node_modules/nested'))],
      ['real directory in place of a link', async s => { await fs.rm(path.join(s.root, 'node_modules/dep')); await fs.mkdir(path.join(s.root, 'node_modules/dep')); }],
      ['whole directory replaced by one symlink', async s => { await fs.rm(path.join(s.root, 'node_modules'), { recursive: true }); await fs.symlink(s.f.hoisted, path.join(s.root, 'node_modules'), 'dir'); }],
      ['marker downgraded to version 1', async s => fs.writeFile(await writable(path.join(s.root, '.heimdall-runtime-snapshot.json')), JSON.stringify({ version: 1, runId: s.run.id, identity: s.run.specification.runtime.identity, modules: s.run.specification.runtime.modules }))],
    ]) {
      const f = await installedPackage(t, layout);
      const s = { f, ...await snapshotOf(f) };
      await verifyRuntimeSnapshot(s.run);
      await alter(s);
      await assert.rejects(verifyRuntimeSnapshot(s.run), /dependency location is not the recorded|different admitted runtime/, name);
    }
  });
}

const MANIFEST_SENTINEL = 'sentinel-manifest-content-7f3a91';

/** Package manifests a dependency can have on disk without identifying the package: unparsable, not an object, or no usable version. */
const unidentifiableManifests = [
  ['invalid JSON', `{ "name": "bad", "note": "${MANIFEST_SENTINEL}", `],
  ['an array', JSON.stringify([MANIFEST_SENTINEL])],
  ['a string', JSON.stringify(MANIFEST_SENTINEL)],
  ['null', 'null'],
  ['no version', JSON.stringify({ name: 'bad', note: MANIFEST_SENTINEL })],
  ['an empty version', JSON.stringify({ name: 'bad', version: '', note: MANIFEST_SENTINEL })],
  ['a non-string version', JSON.stringify({ name: 'bad', version: 7, note: MANIFEST_SENTINEL })],
];

for (const layout of locklessLayouts) {
  for (const [kind, manifest] of unidentifiableManifests) {
    for (const [role, target, named] of [
      ['direct dependency', f => path.join(f.hoisted, 'dep'), /unidentifiable: .*\(package\) > dep/],
      ['direct nested dependency', f => f.nested, /unidentifiable: .*\(package\) > nested/],
      ['hoisted transitive dependency', f => f.trans, /unidentifiable: .*dep > trans, nested > trans/],
      ['nested transitive dependency', f => f.inner, /unidentifiable: .*nested > inner/],
    ]) {
      test(`${layout} layout: a ${role} whose package.json is ${kind} is refused, naming it and nothing of its content`, async t => {
        const f = await installedPackage(t, layout);
        await admitRuntime(f.source);
        await fs.writeFile(path.join(target(f), 'package.json'), manifest);
        let failure;
        try { await admitRuntime(f.source); } catch (error) { failure = error; }
        assert.ok(failure, 'the unidentifiable dependency was admitted');
        assert.match(failure.message, named);
        assert.match(failure.message, /cannot be identified/);
        assert.ok(!failure.message.includes(MANIFEST_SENTINEL), 'manifest content leaked into the refusal');
        assert.ok(!JSON.stringify(computeRuntimeIdentity(f.source)).includes(MANIFEST_SENTINEL));
      });
    }
  }

  test(`${layout} layout: absent optional and peer dependencies, and dependency cycles, are still admitted`, async t => {
    const f = await installedPackage(t, layout);
    // `absent` is an optional dependency of the package that is not installed. Add an absent peer and an absent optional deeper down.
    await f.write('package.json', JSON.stringify({ name: 'dep', version: '1.0.0', dependencies: { trans: '^0.4.0' }, optionalDependencies: { ghost: '1.0.0' }, peerDependencies: { phantom: '1.0.0' } }), path.join(f.hoisted, 'dep'));
    // dep <-> trans cycle.
    await f.write('package.json', JSON.stringify({ name: 'trans', version: '0.4.0', dependencies: { dep: '1.0.0' } }), f.trans);
    const admitted = await admitRuntime(f.source);
    assert.deepEqual(Object.keys(admitted.links), ['@sc/scoped', 'dep', 'nested']);
    const identity = computeRuntimeIdentity(f.source);
    assert.deepEqual(computeRuntimeIdentity(f.source), identity, 'stable');
  });

  test(`${layout} layout: an installed optional dependency with an unidentifiable manifest is refused, an absent one is not`, async t => {
    const f = await installedPackage(t, layout);
    const optional = path.join(f.hoisted, 'maybe');
    await f.write('package.json', JSON.stringify({ name: '@fake/core', version: '1.2.3', type: 'module', dependencies: { dep: '1.0.0', '@sc/scoped': '2.0.0', nested: '3.0.0' }, optionalDependencies: { absent: '1.0.0', maybe: '1.0.0' } }));
    await admitRuntime(f.source);
    await f.write('package.json', `{ "note": "${MANIFEST_SENTINEL}", `, optional);
    await assert.rejects(admitRuntime(f.source), error => /unidentifiable: .*\(package\) > maybe/.test(error.message) && !error.message.includes(MANIFEST_SENTINEL));
  });
}

test('a snapshot imports its plugin through the linked dependencies', async t => {
  const f = await installedPackage(t, 'consumer');
  await f.write('dist/opencode/plugin.js', "import { value } from 'nested'; import { inner } from 'nested/inner.js'; export const createPlugin = () => value + inner;\n");
  await f.write('package.json', JSON.stringify({ name: 'nested', version: '3.0.0', type: 'module', main: 'index.js', dependencies: { inner: '1.0.0', trans: '^0.4.0' } }), f.nested);
  await f.write('index.js', "export { inner as value } from 'inner'; \n", f.nested);
  await f.write('inner.js', "export { inner } from 'inner';\n", f.nested);
  await f.write('package.json', JSON.stringify({ name: 'inner', version: '1.0.0', type: 'module', main: 'main.js' }), f.inner);
  await f.write('main.js', "export const inner = 'x';\n", f.inner);
  const { run, root } = await snapshotOf(f);
  await verifyRuntimeSnapshot(run);
  const loaded = execFileSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(pathToFileURL(path.join(root, 'dist/opencode/plugin.js')).href)}).then(module => console.log(module.createPlugin()))`], { encoding: 'utf8' }).trim();
  assert.equal(loaded, 'xx');
});

/** Copies the package.json files of the transitive dependencies a test mutates, and returns a function restoring them. */
async function fakeBackup(f) {
  const targets = [f.trans, f.inner, path.join(f.hoisted, 'dep')];
  const saved = await Promise.all(targets.map(async directory => [directory, await fs.readFile(path.join(directory, 'package.json'), 'utf8')]));
  return async () => { for (const [directory, content] of saved) { await fs.mkdir(directory, { recursive: true }); await fs.writeFile(path.join(directory, 'package.json'), content); } };
}

const contractsModule = (planner, executor) => `export const plannerPlanContract = {\n    kind: 'planner-plan',\n    version: ${planner},\n};\nexport const executorResultContract = {\n    kind: 'executor-result',\n    version: ${executor},\n};\n`;

test('the contract map follows the contracts the measured package declares: executor-result v2 changes the build, v1 packages keep theirs', async t => {
  const f = await fakePackage(t);
  const legacy = computeRuntimeIdentity(f.source);
  assert.deepEqual(legacy.build.contracts, { 'planner-plan': 1, 'executor-result': 1 }, 'a package without a contracts module reports the first published versions');
  await f.write('dist/workflow/contracts.js', contractsModule(1, 1));
  const v1 = computeRuntimeIdentity(f.source);
  assert.deepEqual(v1.build.contracts, { 'planner-plan': 1, 'executor-result': 1 });
  await f.write('dist/workflow/contracts.js', contractsModule(1, 2));
  const v2 = computeRuntimeIdentity(f.source);
  assert.deepEqual(v2.build.contracts, { 'planner-plan': 1, 'executor-result': 2 });
  assert.notEqual(v2.build.digest, v1.build.digest);
  assert.match(runtimeMismatch(v1, v2), /\(dist\) content changed|protocol or contract versions changed/);
  assert.equal(runtimeMismatch(v1, { ...v2, build: { ...v2.build, dist: v1.build.dist } }), 'Runtime protocol or contract versions changed', 'the map alone is a mismatch');
  // A snapshot of the v1 package keeps measuring as v1 after the executing code moved to v2.
  await f.write('dist/workflow/contracts.js', contractsModule(1, 1));
  const run = await admittedRun(f);
  assert.deepEqual(run.specification.runtime.identity.build.contracts, { 'planner-plan': 1, 'executor-result': 1 });
  const root = await createRuntimeSnapshot(run, f.source);
  assert.deepEqual(computeRuntimeIdentity(root).build.contracts, { 'planner-plan': 1, 'executor-result': 1 });
  assert.equal(computeRuntimeIdentity(root).build.digest, run.specification.runtime.identity.build.digest);
  // A contracts module that declares no recognizable version fails closed.
  await f.write('dist/workflow/contracts.js', 'export const nothing = 1;\n');
  assert.throws(() => computeRuntimeIdentity(f.source), /declares no version for planner-plan/);
});

test('the loaded runtime of this repository reports executor-result v2', () => {
  assert.deepEqual(computeRuntimeIdentity(repository).build.contracts, { 'planner-plan': 1, 'executor-result': 2 });
  assert.deepEqual(runtimeIdentity().build.contracts, { 'planner-plan': 1, 'executor-result': 2 });
});
