import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  buildTarball, installConsumer, installGlobal, isolatedEnvironment, removeTarballBuild, runModule, toolVersions,
} from './helpers.mjs';

/*
 * Runtime admission and snapshots from an installed package. The script below runs with its imports resolved from the installed
 * copy (consumer or global), admits that copy, writes a run-owned snapshot into a temporary namespace, verifies it and imports
 * the snapshot's plugin. OpenCode is never contacted.
 */
const probe = `
  import fs from 'node:fs/promises';
  import path from 'node:path';
  import { pathToFileURL } from 'node:url';
  const { root, mode, namespace } = JSON.parse(process.env.RUNTIME_PROBE);
  const dist = file => import(pathToFileURL(path.join(root, 'dist', file)).href);
  const snapshots = await dist('coordinator/runtime-snapshot.js');
  const identity = await dist('workflow/runtime-identity.js');
  const checkout = path.join(namespace, 'checkout');
  const recordFile = path.join(namespace, 'run.json');
  const out = value => process.stdout.write(JSON.stringify(value));
  if (mode === 'create') {
    const runtime = await snapshots.admitRuntime();
    await fs.mkdir(path.join(checkout, '.heimdall'), { recursive: true });
    const run = {
      id: 'run-installed', ownerToken: 'owner', capacityReserved: true, version: 1, parentSessionId: 'ses_installed', promptMessageId: 'msg_installed',
      worktreePath: checkout, launchAction: 'start', resolution: null, checkpoint: null, feature: 'Feature',
      specification: { settings: { plannerAgent: 'adr-planner', executorAgent: 'adr-executor', plannerModel: 'anthropic/planner' }, plannerPrompt: 'p', executorPrompt: 'e', agents: {}, opencode: { baseUrl: 'http://127.0.0.1:4096', passwordEnvironmentVariable: 'SYNTHETIC_PASSWORD' }, runtime },
    };
    const snapshot = await snapshots.createRuntimeSnapshot(run);
    const loader = path.join(checkout, '.opencode/plugins/heimdall.ts');
    await fs.mkdir(path.dirname(loader), { recursive: true });
    await fs.writeFile(loader, snapshots.snapshotLoader(snapshot, path.join(checkout, '.heimdall/runtime.toml'), runtime.identity.build.digest));
    await fs.writeFile(recordFile, JSON.stringify(run));
    out({ snapshot, sourceRoot: snapshots.sourcePackageRoot(), digest: runtime.identity.build.digest, lockfile: runtime.identity.build.dependencies.lockfile, modules: runtime.modules, links: runtime.links, resolvedPackages: identity.installedDependencies(root).entries.length });
  } else {
    const run = JSON.parse(await fs.readFile(recordFile, 'utf8'));
    await snapshots.verifyRuntimeSnapshot(run);
    const snapshot = snapshots.snapshotRoot(run);
    const plugin = await import(pathToFileURL(path.join(snapshot, 'dist/opencode/plugin.js')).href);
    const loaded = await import(pathToFileURL(path.join(snapshot, 'dist/workflow/runtime-identity.js')).href);
    const created = plugin.createPlugin({ expectedRuntime: run.specification.runtime.identity.build.digest });
    out({ verified: true, pluginExport: typeof plugin.createPlugin, created: typeof created, snapshotDigest: loaded.runtimeIdentity().build.digest, snapshotFlag: loaded.runtimeIdentity().build.snapshot });
  }
`;

const run = async (t, install, work, mode, namespace, env) => {
  const result = await runModule(probe, { cwd: work, env: { ...env, RUNTIME_PROBE: JSON.stringify({ root: install.root, mode, namespace }) } });
  return result;
};

const realPath = target => fs.realpath(target);
// The directory a dependency of the package at `from` resolves to, by Node's node_modules lookup.
async function resolveFrom(from, name) {
  for (let directory = from; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'node_modules', name);
    if (await fs.stat(path.join(candidate, 'package.json')).then(() => true, () => false)) return realPath(candidate);
    if (path.dirname(directory) === directory) throw new Error(`${name} does not resolve from ${from}`);
  }
}

describe('installed runtime identity and snapshots', () => {
  let build;
  let environment;
  let work;
  const installs = {};

  before(async () => {
    build = await buildTarball();
    work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-installed-runtime-')));
    environment = await isolatedEnvironment(work);
    installs.consumer = await installConsumer(build.tarball, { env: environment.env, directory: path.join(work, 'consumer') });
    installs.global = await installGlobal(build.tarball, { env: environment.env, prefix: path.join(work, 'global-prefix'), cwd: work });
  });

  after(async () => {
    await fs.rm(work, { recursive: true, force: true });
    await removeTarballBuild();
  });

  for (const layout of ['consumer', 'global']) {
    describe(`${layout} installation`, () => {
      test('admits, snapshots, verifies and imports the plugin from the installed package', async t => {
        const install = installs[layout];
        t.diagnostic(`environment: ${await toolVersions(environment.env)}`);
        await assert.rejects(fs.lstat(path.join(install.root, 'package-lock.json')), /ENOENT/, 'an installed package never ships a lockfile');
        await assert.rejects(fs.lstat(path.join(install.root, 'npm-shrinkwrap.json')), /ENOENT/);
        const namespace = path.join(work, `namespace-${layout}`);
        const created = await run(t, install, work, 'create', namespace, environment.env);
        assert.equal(created.status, 0, created.stderr);
        const report = JSON.parse(created.stdout);
        assert.equal(report.sourceRoot, install.root + path.sep, 'admission describes the installed package, not a checkout');
        assert.equal(report.lockfile, null);
        assert.match(report.digest, /^[0-9a-f]{64}$/);
        assert.ok(report.resolvedPackages > 20, `every resolved dependency is identified (${report.resolvedPackages})`);
        assert.equal(report.snapshot, path.join(namespace, 'runtime'));
        const direct = Object.keys(JSON.parse(await fs.readFile(path.join(install.root, 'package.json'), 'utf8')).dependencies).sort();
        assert.deepEqual(Object.keys(report.links).sort(), direct, 'each direct dependency is linked');
        for (const [name, target] of Object.entries(report.links)) {
          assert.equal(await realPath(target), target, `${name} links to a real directory`);
          assert.equal(await realPath(path.join(report.snapshot, 'node_modules', name)), target, `${name} resolves in the snapshot as it does in the install`);
        }
        const verified = await run(t, install, work, 'verify', namespace, environment.env);
        assert.equal(verified.status, 0, verified.stderr);
        const imported = JSON.parse(verified.stdout);
        assert.deepEqual(imported, { verified: true, pluginExport: 'function', created: 'object', snapshotDigest: report.digest, snapshotFlag: true });
        t.diagnostic(`${layout}: ${report.resolvedPackages} resolved packages, ${Object.keys(report.links).length} linked; digest ${report.digest}; snapshot ${report.snapshot}`);
      });

      for (const change of ['changed', 'removed']) {
        test(`a ${change} transitive dependency makes verification refuse`, async t => {
          // An isolated copy of the whole installation so the shared install used by the other tests is never touched.
          const original = installs[layout];
          const copyRoot = path.join(work, `copy-${layout}-${change}`);
          const top = original.directory;
          await fs.cp(top, copyRoot, { recursive: true, verbatimSymlinks: true });
          const relative = path.relative(top, original.root);
          const install = { ...original, root: path.join(copyRoot, relative) };
          const namespace = path.join(work, `namespace-${layout}-${change}`);
          const created = await run(t, install, work, 'create', namespace, environment.env);
          assert.equal(created.status, 0, created.stderr);
          assert.equal(JSON.parse(created.stdout).sourceRoot, install.root + path.sep);
          const intact = await run(t, install, work, 'verify', namespace, environment.env);
          assert.equal(intact.status, 0, intact.stderr);
          // `zod` is a dependency of @opencode/plugin, not of Heimdall; it may be hoisted or nested wherever npm placed it.
          const plugin = await resolveFrom(install.root, '@opencode/plugin');
          const transitive = await resolveFrom(plugin, 'zod');
          t.diagnostic(`${layout}: ${change} ${path.relative(copyRoot, transitive)} (resolved from ${path.relative(copyRoot, plugin)})`);
          assert.notEqual(transitive, install.root);
          if (change === 'changed') {
            const manifest = JSON.parse(await fs.readFile(path.join(transitive, 'package.json'), 'utf8'));
            await fs.writeFile(path.join(transitive, 'package.json'), JSON.stringify({ ...manifest, version: '0.0.0-tampered' }));
          } else await fs.rm(transitive, { recursive: true });
          const refused = await run(t, install, work, 'verify', namespace, environment.env);
          assert.notEqual(refused.status, 0, 'verification must refuse');
          assert.match(refused.stderr, /Runtime snapshot refused for run run-installed: Runtime dependency identity changed/);
        });
      }
    });
  }
});
