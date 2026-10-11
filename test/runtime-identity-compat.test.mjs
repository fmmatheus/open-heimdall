import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { computeRuntimeIdentity, runtimeMismatch, SNAPSHOT_MARKER } from '../dist/workflow/runtime-identity.js';
import { admitRuntime, snapshotLoader, verifyRuntimeSnapshot } from '../dist/coordinator/runtime-snapshot.js';

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
