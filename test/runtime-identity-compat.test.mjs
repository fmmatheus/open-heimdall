import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { computeRuntimeIdentity, runtimeMismatch, SNAPSHOT_MARKER } from '../dist/workflow/runtime-identity.js';
import { admitRuntime, createRuntimeSnapshot, snapshotLoader, verifyRuntimeSnapshot } from '../dist/coordinator/runtime-snapshot.js';

/*
 * Identities and the version-1 snapshot layout frozen from the lockfile-mode algorithm. The expected values below were computed
 * once, before any change to dependency location or lockless identification, and must never be regenerated to make a change
 * pass: snapshots persisted by earlier runs are verified against exactly these digests. They also cover the submission
 * contract versions, so a deliberate contract change is the only legitimate reason to touch them.
 */
const frozen = {
  flat: {
    packageVersion: '1.2.3', protocol: 'structured-v1',
    build: {
      packageName: '@fake/core', contracts: { 'planner-plan': 1, 'executor-result': 1 },
      dist: '6682d6de92dbbe8a9603109581c75994114601d39d5d851f1f4f4eef23178f79',
      prompts: '66c934ad7ea54da273c2d0efecd5be5664910f6495c5c139149e4eb0805f4eab',
      agents: '0c2d982be04949f2358963a50cbed0a57222a1d0a97de6ef071c06d564413bb2',
      dependencies: { lockfile: '4bb6b9cb74946ef879f5f2bdb8dd9b4ec9ffeea2724117e78adad98533714191', direct: { dep: '1.0.0' }, resolved: '315ea5e664a92af1e95243c9e38a128b6fdefa0590bbba08c1686780c786ef96' },
      digest: 'ee423157f2be032596c4d1d109ff15b744a8f0592177746eed5627e219e89b33', snapshot: false,
    },
  },
  nested: {
    packageVersion: '1.2.3', protocol: 'structured-v1',
    build: {
      packageName: '@fake/core', contracts: { 'planner-plan': 1, 'executor-result': 1 },
      dist: '6682d6de92dbbe8a9603109581c75994114601d39d5d851f1f4f4eef23178f79',
      prompts: '66c934ad7ea54da273c2d0efecd5be5664910f6495c5c139149e4eb0805f4eab',
      agents: '0c2d982be04949f2358963a50cbed0a57222a1d0a97de6ef071c06d564413bb2',
      dependencies: { lockfile: '8871dc574e6b5f69558b21a35dd09d41581137c005b2600f1c8bef365f89aaad', direct: { '@sc/pkg': '2.0.0', dep: '1.0.0' }, resolved: '6f9c452f564ef2293592666b4ace3ab24fe4c741c3f86f1e963ffebb608c3850' },
      digest: '4eb7e9133c81e06c50ddb6eab92e73f12f067aa326493dc15ea56256edb07434', snapshot: false,
    },
  },
};

const sources = {
  flat: {
    'package.json': { name: '@fake/core', version: '1.2.3', type: 'module', dependencies: { dep: '1.0.0' } },
    'package-lock.json': { lockfileVersion: 3, packages: { '': {}, 'node_modules/dep': { version: '1.0.0' }, 'node_modules/devonly': { version: '1.0.0', dev: true } } },
    'node_modules/dep/package.json': { name: 'dep', version: '1.0.0' },
    'node_modules/devonly/package.json': { name: 'devonly', version: '1.0.0' },
  },
  nested: {
    'package.json': { name: '@fake/core', version: '1.2.3', type: 'module', dependencies: { dep: '1.0.0', '@sc/pkg': '2.0.0' } },
    'package-lock.json': { lockfileVersion: 3, packages: { '': {}, 'node_modules/dep': { version: '1.0.0' }, 'node_modules/dep/node_modules/sub': { version: '3.1.0' }, 'node_modules/@sc/pkg': { version: '2.0.0' }, 'node_modules/@sc/opt': { version: '1.0.0', optional: true }, 'node_modules/trans': { version: '0.4.0' }, 'node_modules/devonly': { version: '1.0.0', dev: true } } },
    'node_modules/dep/package.json': { name: 'dep', version: '1.0.0' },
    'node_modules/dep/node_modules/sub/package.json': { name: 'sub', version: '3.1.0' },
    'node_modules/@sc/pkg/package.json': { name: '@sc/pkg', version: '2.0.0' },
    'node_modules/trans/package.json': { name: 'trans', version: '0.4.0' },
  },
};
const text = {
  'dist/index.js': "export const marker = 'build-one';\n",
  'dist/nested/helper.js': 'export const helper = 1;\n',
  'dist/opencode/plugin.js': 'export const createPlugin = () => null;\n',
  'prompts/planner.md': 'planner prompt\n',
  'examples/opencode/agents/adr-planner.md': 'planner agent\n',
};

async function fixture(t, kind) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-frozen-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const source = path.join(base, 'source');
  const files = { ...text, ...Object.fromEntries(Object.entries(sources[kind]).map(([file, value]) => [file, JSON.stringify(value)])) };
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await fs.writeFile(path.join(source, file), content);
  }
  return { base, source, files };
}

for (const kind of Object.keys(frozen)) {
  test(`lockfile-mode identity is byte-identical to the frozen ${kind} digest`, async t => {
    const { source } = await fixture(t, kind);
    assert.deepEqual(computeRuntimeIdentity(source), frozen[kind]);
    const admitted = await admitRuntime(source);
    assert.deepEqual(admitted.identity, frozen[kind]);
    assert.equal(admitted.modules, await fs.realpath(path.join(source, 'node_modules')));
    assert.equal(admitted.links, undefined, 'a lockfile package keeps the single-directory dependency location');
  });

  test(`a version-1 snapshot of the ${kind} fixture still verifies, and is still refused when tampered`, async t => {
    const f = await fixture(t, kind);
    const modules = await fs.realpath(path.join(f.source, 'node_modules'));
    const checkout = path.join(f.base, 'ns', 'checkout');
    const root = path.join(f.base, 'ns', 'runtime');
    await fs.mkdir(path.join(checkout, '.heimdall'), { recursive: true });
    // Laid out exactly as a version-1 snapshot is: read-only copies, one node_modules symlink to the recorded directory, version-1 marker.
    for (const [file, content] of Object.entries(f.files)) {
      if (file.startsWith('node_modules/')) continue;
      await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await fs.writeFile(path.join(root, file), content, { mode: 0o444 });
    }
    await fs.symlink(modules, path.join(root, 'node_modules'), 'dir');
    await fs.writeFile(path.join(root, SNAPSHOT_MARKER), JSON.stringify({ version: 1, runId: 'run-frozen', identity: frozen[kind], modules }), { mode: 0o444 });
    const config = path.join(checkout, '.heimdall/runtime.toml');
    const loader = path.join(checkout, '.opencode/plugins/heimdall.ts');
    await fs.mkdir(path.dirname(loader), { recursive: true });
    await fs.writeFile(loader, snapshotLoader(root, config, frozen[kind].build.digest));
    const run = {
      id: 'run-frozen', worktreePath: checkout,
      specification: { settings: {}, plannerPrompt: 'p', executorPrompt: 'e', agents: {}, opencode: { baseUrl: 'http://127.0.0.1:4096', passwordEnvironmentVariable: 'SYNTHETIC_PASSWORD' }, runtime: { identity: frozen[kind], modules } },
    };
    const snapshot = computeRuntimeIdentity(root);
    assert.equal(snapshot.build.snapshot, true);
    assert.equal(snapshot.build.digest, frozen[kind].build.digest);
    assert.equal(runtimeMismatch(frozen[kind], snapshot), undefined);
    await verifyRuntimeSnapshot(run);
    await fs.writeFile(path.join(f.source, 'node_modules/dep/package.json'), JSON.stringify({ name: 'dep', version: '1.0.9' }));
    await assert.rejects(verifyRuntimeSnapshot(run), /dependency identity changed/);
  });
}

/*
 * Legacy lockless version-1 runtime. The expected identity below was produced by compiling the runtime-identity module exactly as
 * it was before installed-package support (commit 8f3bd7e, src/workflow/runtime-identity.ts with its contracts module) in a
 * temporary directory outside this repository and running its computeRuntimeIdentity over a synthetic package installed at
 * node_modules/@fake/core, with no package-lock.json and its direct dependencies hoisted beside it. In that algorithm a package
 * without a lockfile is identified by the installed versions of its direct dependencies alone. These constants must never be
 * regenerated from the current code: version-1 snapshots admitted by that code are verified against exactly this value.
 */
const legacyLockless = {
  packageVersion: '1.2.3', protocol: 'structured-v1',
  build: {
    packageName: '@fake/core', contracts: { 'planner-plan': 1, 'executor-result': 1 },
    dist: '6682d6de92dbbe8a9603109581c75994114601d39d5d851f1f4f4eef23178f79',
    prompts: '66c934ad7ea54da273c2d0efecd5be5664910f6495c5c139149e4eb0805f4eab',
    agents: '0c2d982be04949f2358963a50cbed0a57222a1d0a97de6ef071c06d564413bb2',
    dependencies: { lockfile: null, direct: { '@sc/pkg': '2.0.0', dep: '1.0.0' }, resolved: '254a99201242b0acdfb28d81ae070674227022d00d1e251dca334fb7c21ab5ef' },
    digest: '81e48dfa1030fef7b2a589a68aac9c88bacab92a0920258368437bb4b167ba5c', snapshot: false,
  },
};

/*
 * Version-2 identity of the installed-package layouts (lockless, dependency graph identified from the installed tree), recorded
 * from the build at 6aff533 before the legacy-format handling was added. Both layouts were computed separately and are equal
 * because the description of the tree does not depend on where packages sit. Never regenerate these from the code under test.
 */
const frozenInstalled = {
  packageVersion: '1.2.3', protocol: 'structured-v1',
  build: {
    packageName: '@fake/core', contracts: { 'planner-plan': 1, 'executor-result': 1 },
    dist: '6c59e4c940af49d8e784e4a35bdea14f0d59500b88a6af8ffd0ade9635419730',
    prompts: '66c934ad7ea54da273c2d0efecd5be5664910f6495c5c139149e4eb0805f4eab',
    agents: '0c2d982be04949f2358963a50cbed0a57222a1d0a97de6ef071c06d564413bb2',
    dependencies: { lockfile: null, direct: { '@sc/scoped': '2.0.0', dep: '1.0.0', nested: '3.0.0' }, resolved: 'ea960389d3e05c8ddda0b706bcd7824ecff4b4d8f61d45f835a453ad4c64548e' },
    digest: '180fa89764053a49bed0064c6bb157f7d34da650c32735a1ba004e576f7ffed7', snapshot: false,
  },
};

const json = value => JSON.stringify(value);
const writeFiles = async (root, files) => {
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
};
const writable = async file => { await fs.chmod(file, 0o644); return file; };
const runRecord = (id, checkout, runtime) => ({
  id, worktreePath: checkout,
  specification: { settings: {}, plannerPrompt: 'p', executorPrompt: 'e', agents: {}, opencode: { baseUrl: 'http://127.0.0.1:4096', passwordEnvironmentVariable: 'SYNTHETIC_PASSWORD' }, runtime },
});

/** Every entry below `root` with its type, mode and content (or link target): what "unchanged" means for a snapshot. */
async function treeState(root) {
  const state = {};
  const walk = async relative => {
    for (const entry of await fs.readdir(path.join(root, relative), { withFileTypes: true })) {
      const next = relative ? relative + '/' + entry.name : entry.name;
      const target = path.join(root, next);
      const stat = await fs.lstat(target);
      if (entry.isSymbolicLink()) state[next] = { link: await fs.readlink(target) };
      else if (entry.isDirectory()) { state[next] = { directory: true }; await walk(next); }
      else state[next] = { mode: stat.mode & 0o777, content: (await fs.readFile(target)).toString('base64') };
    }
  };
  await walk('');
  return state;
}

/** The package an earlier release admitted: installed at node_modules/@fake/core, dependencies hoisted beside it, no lockfile. */
async function legacyPackage(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-legacy-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const modules = path.join(base, 'consumer', 'node_modules');
  const source = path.join(modules, '@fake', 'core');
  const manifest = { name: '@fake/core', version: '1.2.3', type: 'module', dependencies: { dep: '1.0.0', '@sc/pkg': '2.0.0' } };
  const files = { ...text, 'package.json': json(manifest) };
  await writeFiles(source, files);
  await writeFiles(modules, {
    'dep/package.json': json({ name: 'dep', version: '1.0.0', dependencies: { trans: '^0.4.0' } }),
    '@sc/pkg/package.json': json({ name: '@sc/pkg', version: '2.0.0' }),
    'trans/package.json': json({ name: 'trans', version: '0.4.0' }),
  });
  return { base, modules, source, files, checkout: path.join(base, 'ns', 'checkout'), root: path.join(base, 'ns', 'runtime') };
}

async function writeLoader(f, digest) {
  const config = path.join(f.checkout, '.heimdall/runtime.toml');
  const loader = path.join(f.checkout, '.opencode/plugins/heimdall.ts');
  await fs.mkdir(path.dirname(loader), { recursive: true });
  await fs.writeFile(loader, snapshotLoader(f.root, config, digest));
  return loader;
}

/** A version-1 snapshot laid out by hand exactly as the earlier release wrote it. */
async function legacySnapshot(t) {
  const f = await legacyPackage(t);
  await fs.mkdir(path.join(f.checkout, '.heimdall'), { recursive: true });
  for (const [file, content] of Object.entries(f.files)) {
    await fs.mkdir(path.dirname(path.join(f.root, file)), { recursive: true });
    await fs.writeFile(path.join(f.root, file), content, { mode: 0o444 });
  }
  await fs.symlink(f.modules, path.join(f.root, 'node_modules'), 'dir');
  const marker = path.join(f.root, SNAPSHOT_MARKER);
  await fs.writeFile(marker, json({ version: 1, runId: 'run-legacy', identity: legacyLockless, modules: f.modules }), { mode: 0o444 });
  const loader = await writeLoader(f, legacyLockless.build.digest);
  const run = runRecord('run-legacy', f.checkout, { identity: legacyLockless, modules: f.modules });
  return { ...f, marker, loader, run };
}

test('a version-1 lockless snapshot admitted by an earlier release verifies unchanged', async t => {
  const s = await legacySnapshot(t);
  assert.equal(s.run.specification.runtime.links, undefined);
  assert.equal(s.run.specification.runtime.identity.build.dependencies.lockfile, null);
  const before = { tree: await treeState(s.root), loader: await fs.readFile(s.loader, 'utf8'), checkout: await treeState(s.checkout), run: structuredClone(s.run) };
  const snapshot = computeRuntimeIdentity(s.root);
  assert.equal(snapshot.build.snapshot, true, 'the hand-built layout is recognised as a snapshot');
  await verifyRuntimeSnapshot(s.run);
  assert.deepEqual(await treeState(s.root), before.tree, 'every snapshot file, mode and link is untouched');
  assert.deepEqual(JSON.parse(await fs.readFile(s.marker, 'utf8')), { version: 1, runId: 'run-legacy', identity: legacyLockless, modules: s.modules });
  assert.equal(await fs.readFile(s.loader, 'utf8'), before.loader);
  assert.deepEqual(await treeState(s.checkout), before.checkout);
  assert.deepEqual(s.run, before.run, 'the persisted record is not rewritten');
});

for (const [name, expected, change] of [
  ['a changed direct dependency version', /dependency identity changed/, f => fs.writeFile(path.join(f.modules, 'dep/package.json'), json({ name: 'dep', version: '1.0.9' }))],
  ['a removed direct dependency', /dependency identity changed/, f => fs.rm(path.join(f.modules, 'dep'), { recursive: true })],
  ['a changed scoped direct dependency version', /dependency identity changed/, f => fs.writeFile(path.join(f.modules, '@sc/pkg/package.json'), json({ name: '@sc/pkg', version: '2.0.1' }))],
  ['a changed dist file', /Runtime build \(dist\) content changed/, async f => fs.writeFile(await writable(path.join(f.root, 'dist/index.js')), "export const marker = 'tampered';\n")],
  ['an added dist file', /Runtime build \(dist\) content changed/, f => fs.writeFile(path.join(f.root, 'dist/extra.js'), 'export const extra = 1;\n')],
  ['a removed dist file', /Runtime build \(dist\) content changed/, f => fs.rm(path.join(f.root, 'dist/nested/helper.js'))],
  ['a changed prompt file', /Runtime prompt content changed/, async f => fs.writeFile(await writable(path.join(f.root, 'prompts/planner.md')), 'tampered prompt\n')],
  ['an added prompt file', /Runtime prompt content changed/, f => fs.writeFile(path.join(f.root, 'prompts/extra.md'), 'extra\n')],
  ['a removed prompt file', /Runtime prompt content changed/, f => fs.rm(path.join(f.root, 'prompts/planner.md'))],
  ['a changed agent file', /Runtime agent file content changed/, async f => fs.writeFile(await writable(path.join(f.root, 'examples/opencode/agents/adr-planner.md')), 'tampered agent\n')],
  ['an added agent file', /Runtime agent file content changed/, f => fs.writeFile(path.join(f.root, 'examples/opencode/agents/extra.md'), 'extra\n')],
  ['a removed agent file', /Runtime agent file content changed/, f => fs.rm(path.join(f.root, 'examples/opencode/agents/adr-planner.md'))],
  ['an altered recorded loader', /active plugin loader does not import the admitted snapshot/, f => fs.writeFile(f.loader, snapshotLoader(f.root, '/elsewhere/runtime.toml', legacyLockless.build.digest))],
  ['a dependency location pointing elsewhere', /dependency location is not the recorded/, async f => {
    const other = path.join(f.base, 'other-modules');
    await fs.cp(f.modules, other, { recursive: true });
    await fs.rm(path.join(f.root, 'node_modules'));
    await fs.symlink(other, path.join(f.root, 'node_modules'), 'dir');
  }],
  ['an altered recorded dependency location', /snapshot belongs to a different admitted runtime/, async f => fs.writeFile(await writable(f.marker), json({ version: 1, runId: 'run-legacy', identity: legacyLockless, modules: path.join(f.base, 'other-modules') }))],
  ['a marker for a different run', /snapshot belongs to a different admitted runtime/, async f => fs.writeFile(await writable(f.marker), json({ version: 1, runId: 'run-other', identity: legacyLockless, modules: f.modules }))],
]) {
  test(`a legacy version-1 lockless snapshot is refused after ${name}`, async t => {
    const s = await legacySnapshot(t);
    await verifyRuntimeSnapshot(s.run);
    await change(s);
    await assert.rejects(verifyRuntimeSnapshot(s.run), error => {
      assert.match(error.message, /^Runtime snapshot refused for run run-legacy: /);
      assert.match(error.message, expected);
      return true;
    });
  });
}

test('a legacy lockless run admitted but not yet snapshotted is copied and verified by its recorded format', async t => {
  const f = await legacyPackage(t);
  await fs.mkdir(path.join(f.checkout, '.heimdall'), { recursive: true });
  const run = runRecord('run-legacy', f.checkout, { identity: legacyLockless, modules: f.modules });
  const root = await createRuntimeSnapshot(run, f.source);
  assert.equal(root, f.root);
  const marker = JSON.parse(await fs.readFile(path.join(root, SNAPSHOT_MARKER), 'utf8'));
  assert.deepEqual(marker, { version: 1, runId: 'run-legacy', identity: legacyLockless, modules: f.modules });
  await writeLoader(f, legacyLockless.build.digest);
  await verifyRuntimeSnapshot(run);
});

/** Installed package fixtures as in runtime-identity.test.mjs: hoisted dep/@sc/scoped/trans, nested/inner nested in the package. */
async function installedFixture(t, layout) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-frozen-v2-')));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const modules = layout === 'consumer' ? path.join(base, 'consumer', 'node_modules') : path.join(base, 'prefix', 'lib', 'node_modules');
  const source = path.join(modules, '@fake', 'core');
  const own = path.join(source, 'node_modules');
  const hoisted = layout === 'consumer' ? modules : own;
  const manifest = (name, version, dependencies = {}) => json({ name, version, dependencies });
  await writeFiles(source, {
    'package.json': json({ name: '@fake/core', version: '1.2.3', type: 'module', dependencies: { dep: '1.0.0', '@sc/scoped': '2.0.0', nested: '3.0.0' }, optionalDependencies: { absent: '1.0.0' } }),
    'dist/index.js': "export const marker = 'build-one';\n",
    'dist/opencode/plugin.js': 'export const createPlugin = () => null;\n',
    'prompts/planner.md': 'planner prompt\n',
    'examples/opencode/agents/adr-planner.md': 'planner agent\n',
  });
  await writeFiles(hoisted, {
    'dep/package.json': manifest('dep', '1.0.0', { trans: '^0.4.0' }),
    '@sc/scoped/package.json': manifest('@sc/scoped', '2.0.0'),
    'trans/package.json': manifest('trans', '0.4.0'),
  });
  await writeFiles(own, {
    'nested/package.json': manifest('nested', '3.0.0', { inner: '1.0.0', trans: '^0.4.0' }),
    'nested/node_modules/inner/package.json': manifest('inner', '1.0.0'),
  });
  const checkout = path.join(base, 'ns', 'checkout');
  await fs.mkdir(path.join(checkout, '.heimdall'), { recursive: true });
  return {
    base, source, own, hoisted, checkout, layout,
    trans: path.join(hoisted, 'trans'), inner: path.join(own, 'nested', 'node_modules', 'inner'),
    manifest: (directory, name, version) => writeFiles(directory, { 'package.json': manifest(name, version) }),
  };
}

for (const layout of ['consumer', 'global']) {
  /** Admit, snapshot and wire the loader the way the coordinator does for a new run. */
  const installedSnapshot = async t => {
    const f = await installedFixture(t, layout);
    const runtime = await admitRuntime(f.source);
    const run = runRecord('run-v2', f.checkout, runtime);
    const root = await createRuntimeSnapshot(run, f.source);
    const loader = await writeLoader({ ...f, root }, runtime.identity.build.digest);
    return { ...f, runtime, run, root, loader, marker: path.join(root, SNAPSHOT_MARKER) };
  };

  test(`${layout} layout: version-2 identity, links and snapshot match the values recorded by 6aff533`, async t => {
    const s = await installedSnapshot(t);
    assert.deepEqual(computeRuntimeIdentity(s.source), frozenInstalled);
    assert.deepEqual(s.runtime.identity, frozenInstalled);
    assert.deepEqual(s.runtime.links, {
      '@sc/scoped': path.join(s.hoisted, '@sc', 'scoped'),
      dep: path.join(s.hoisted, 'dep'),
      nested: path.join(s.own, 'nested'),
    });
    const marker = JSON.parse(await fs.readFile(s.marker, 'utf8'));
    assert.equal(marker.version, 2);
    assert.deepEqual(marker.links, s.runtime.links);
    const snapshot = computeRuntimeIdentity(s.root);
    assert.equal(snapshot.build.snapshot, true);
    assert.equal(snapshot.build.digest, frozenInstalled.build.digest);
    assert.equal(runtimeMismatch(frozenInstalled, snapshot), undefined);
    const before = await treeState(s.root);
    await verifyRuntimeSnapshot(s.run);
    assert.deepEqual(await treeState(s.root), before);
  });

  for (const [name, change] of [
    ['a changed hoisted transitive dependency', s => s.manifest(s.trans, 'trans', '0.4.9')],
    ['a removed hoisted transitive dependency', s => fs.rm(s.trans, { recursive: true })],
    ['a changed nested transitive dependency', s => s.manifest(s.inner, 'inner', '1.9.0')],
    ['a removed nested transitive dependency', s => fs.rm(s.inner, { recursive: true })],
    ['a removed direct dependency', s => fs.rm(path.join(s.hoisted, 'dep'), { recursive: true })],
  ]) {
    test(`${layout} layout: a version-2 snapshot is refused after ${name}, never by the legacy calculation`, async t => {
      const s = await installedSnapshot(t);
      await verifyRuntimeSnapshot(s.run);
      await change(s);
      await assert.rejects(verifyRuntimeSnapshot(s.run), /^Error: Runtime snapshot refused for run run-v2: Runtime dependency identity changed/);
    });
  }

  test(`${layout} layout: a version-2 snapshot is refused when a dependency link is changed`, async t => {
    const s = await installedSnapshot(t);
    await fs.rm(path.join(s.root, 'node_modules/dep'));
    await fs.symlink(s.trans, path.join(s.root, 'node_modules/dep'), 'dir');
    await assert.rejects(verifyRuntimeSnapshot(s.run), /dependency location is not the recorded dependency links/);
  });

  test(`${layout} layout: a version-2 marker downgraded to version 1 is refused`, async t => {
    const s = await installedSnapshot(t);
    await fs.writeFile(await writable(s.marker), json({ version: 1, runId: 'run-v2', identity: s.runtime.identity, modules: s.runtime.modules }));
    await assert.rejects(verifyRuntimeSnapshot(s.run), /dependency location is not the recorded dependency links/);
  });

  test(`${layout} layout: stripping the links from the record and the marker does not select the legacy calculation`, async t => {
    const s = await installedSnapshot(t);
    // A version-2 identity with its links removed, a version-1 marker and a single node_modules symlink: the shape a legacy
    // snapshot has. The recorded identity is a dependency-graph identity, so the legacy direct-versions calculation cannot match it.
    const stripped = runRecord('run-v2', s.checkout, { identity: s.runtime.identity, modules: s.runtime.modules });
    await fs.rm(path.join(s.root, 'node_modules'), { recursive: true });
    await fs.symlink(s.runtime.modules, path.join(s.root, 'node_modules'), 'dir');
    await fs.writeFile(await writable(s.marker), json({ version: 1, runId: 'run-v2', identity: s.runtime.identity, modules: s.runtime.modules }));
    await assert.rejects(verifyRuntimeSnapshot(stripped), /^Error: Runtime snapshot refused for run run-v2: Runtime dependency identity changed/);
  });
}
