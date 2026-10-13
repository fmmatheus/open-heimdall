import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isolatedEnvironment, listTree, temporaryDirectory, verifyDependencyTree } from './helpers.mjs';

// Controls for the installed-tree rule used by install.test.mjs. Each case builds a small synthetic
// node_modules tree, runs the real `npm ls --all` on it and applies verifyDependencyTree to the result. No
// network or tarball is involved, so the cases behave the same on every platform and npm version.

const platformPackage = `@msgpackr-extract/msgpackr-extract-${process.platform}-${process.arch}`;
const hostRestriction = { os: [process.platform], cpu: [process.arch] };

const baseline = () => ({
  '@open-heimdall/core': {
    version: '0.0.0',
    dependencies: { '@opencode/plugin': '2.0.22', 'dep-a': '^1.0.0' },
    peerDependencies: { 'peer-a': '^1.0.0' },
  },
  '@opencode/plugin': { version: '2.0.22', dependencies: { msgpackr: '^2.0.5' } },
  msgpackr: { version: '2.1.0', optionalDependencies: { 'msgpackr-extract': '^3.0.4' } },
  'dep-a': { version: '1.2.0' },
  'peer-a': { version: '1.2.0' },
});

const baselineLock = () => ({
  packages: {
    '': { name: 'consumer' },
    'node_modules/msgpackr': { version: '2.1.0', optionalDependencies: { 'msgpackr-extract': '^3.0.4' } },
    'node_modules/msgpackr-extract': {
      version: '3.0.4', optional: true,
      optionalDependencies: { [platformPackage]: '3.0.4', '@msgpackr-extract/msgpackr-extract-other-arch': '3.0.4' },
    },
    [`node_modules/${platformPackage}`]: { version: '3.0.4', optional: true, ...hostRestriction },
    'node_modules/@msgpackr-extract/msgpackr-extract-other-arch': { version: '3.0.4', optional: true, os: ['other'], cpu: ['other'] },
  },
});

const leftover = (extra = {}) => ({ [platformPackage]: { version: '3.0.4', ...hostRestriction, ...extra } });

async function buildTree(t, packages) {
  const root = await temporaryDirectory(t, 'tree');
  const { env } = await isolatedEnvironment(root);
  const directory = path.join(root, 'consumer');
  const modules = path.join(directory, 'node_modules');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({
    name: 'heimdall-consumer', version: '1.0.0', private: true, dependencies: { '@open-heimdall/core': '0.0.0' },
  }));
  for (const [name, manifest] of Object.entries(packages)) {
    if (manifest === undefined) continue;
    await fs.mkdir(path.join(modules, name), { recursive: true });
    await fs.writeFile(path.join(modules, name, 'package.json'), JSON.stringify({ name, ...manifest }));
  }
  return { env, directory, modules, install: { layout: 'consumer', directory }, cwd: root };
}

async function inspect(t, packages, lock = baselineLock()) {
  const tree = await buildTree(t, packages);
  const listing = await listTree(tree.install, { env: tree.env, cwd: tree.cwd });
  const problems = await verifyDependencyTree({ modules: tree.modules, listing, lock });
  return { listing, problems };
}

const mentions = (problems, pattern) => problems.some(problem => pattern.test(problem));

describe('installed dependency-tree rule', () => {
  test('a complete tree is accepted', async t => {
    const { listing, problems } = await inspect(t, baseline());
    assert.equal(listing.status, 0, listing.stdout);
    assert.deepEqual(problems, []);
  });

  describe('leftover optional native package', () => {
    test('a host platform package whose failed optional parent was removed is reported extraneous by npm and accepted', async t => {
      const { listing, problems } = await inspect(t, { ...baseline(), ...leftover() });
      assert.match(listing.stdout, new RegExp(`${platformPackage}@3\\.0\\.4 extraneous`));
      assert.equal(listing.status, 0);
      assert.deepEqual(problems, []);
    });

    test('is rejected next to an unrelated extraneous package', async t => {
      const { listing, problems } = await inspect(t, { ...baseline(), ...leftover(), 'left-pad': { version: '1.3.0' } });
      assert.match(listing.stdout, /left-pad@1\.3\.0 extraneous/);
      assert.deepEqual(problems.filter(problem => !/left-pad/.test(problem)), []);
      assert.ok(mentions(problems, /left-pad@1\.3\.0 extraneous/), problems.join('\n'));
    });

    test('is not extraneous, and nothing is accepted, when the optional parent is installed', async t => {
      const packages = { ...baseline(), ...leftover(), 'msgpackr-extract': { version: '3.0.4', optionalDependencies: { [platformPackage]: '3.0.4' } } };
      const { listing, problems } = await inspect(t, packages);
      assert.doesNotMatch(listing.stdout, /extraneous/);
      assert.deepEqual(problems, []);
    });

    test('is rejected when no installed package declares the optional parent', async t => {
      const packages = { ...baseline(), ...leftover() };
      delete packages.msgpackr.optionalDependencies;
      const { listing, problems } = await inspect(t, packages);
      assert.match(listing.stdout, /extraneous/);
      assert.ok(mentions(problems, /extraneous/), problems.join('\n'));
    });

    test('is rejected when the lockfile does not declare it as an optional dependency', async t => {
      const lock = baselineLock();
      delete lock.packages['node_modules/msgpackr-extract'].optionalDependencies[platformPackage];
      const { problems } = await inspect(t, { ...baseline(), ...leftover() }, lock);
      assert.ok(mentions(problems, /extraneous/), problems.join('\n'));
    });

    test('is rejected when its declaring package is not optional in the lockfile', async t => {
      const lock = baselineLock();
      delete lock.packages['node_modules/msgpackr-extract'].optional;
      const { problems } = await inspect(t, { ...baseline(), ...leftover() }, lock);
      assert.ok(mentions(problems, /extraneous/), problems.join('\n'));
    });

    test('is rejected when it is not itself optional in the lockfile', async t => {
      const lock = baselineLock();
      delete lock.packages[`node_modules/${platformPackage}`].optional;
      const { problems } = await inspect(t, { ...baseline(), ...leftover() }, lock);
      assert.ok(mentions(problems, /extraneous/), problems.join('\n'));
    });

    test('is rejected when its platform restriction is missing or does not match this host', async t => {
      for (const extra of [{ os: ['other'] }, { cpu: ['other'] }, { os: undefined }, { cpu: undefined }]) {
        const { problems } = await inspect(t, { ...baseline(), ...leftover(extra) });
        assert.ok(mentions(problems, /extraneous/), `${JSON.stringify(extra)}: ${problems.join('\n')}`);
      }
    });

    test('is rejected for a look-alike package in the same scope', async t => {
      const { problems } = await inspect(t, { ...baseline(), '@msgpackr-extract/msgpackr-extract-evil': { version: '3.0.4', ...hostRestriction } });
      assert.ok(mentions(problems, /msgpackr-extract-evil@3\.0\.4 extraneous/), problems.join('\n'));
    });

    test('a platform package that does not satisfy its installed parent is invalid and rejected', async t => {
      const packages = {
        ...baseline(), ...leftover(),
        'msgpackr-extract': { version: '3.0.4', optionalDependencies: { [platformPackage]: '4.0.0' } },
      };
      const { listing, problems } = await inspect(t, packages);
      assert.match(listing.stdout, /invalid/);
      assert.ok(mentions(problems, /invalid/), problems.join('\n'));
    });
  });

  describe('other problems', () => {
    test('an unrelated extraneous package is rejected', async t => {
      const { listing, problems } = await inspect(t, { ...baseline(), 'left-pad': { version: '1.3.0' } });
      assert.match(listing.stdout, /left-pad@1\.3\.0 extraneous/);
      assert.ok(mentions(problems, /left-pad@1\.3\.0 extraneous/), problems.join('\n'));
    });

    test('a missing required dependency is rejected', async t => {
      const packages = baseline();
      delete packages['dep-a'];
      const { listing, problems } = await inspect(t, packages);
      assert.notEqual(listing.status, 0);
      assert.match(listing.stdout, /UNMET DEPENDENCY dep-a/);
      assert.ok(mentions(problems, /exited [1-9]/) && mentions(problems, /UNMET DEPENDENCY dep-a/), problems.join('\n'));
    });

    test('an invalid required dependency version is rejected', async t => {
      const { listing, problems } = await inspect(t, { ...baseline(), 'dep-a': { version: '2.0.0' } });
      assert.notEqual(listing.status, 0);
      assert.match(listing.stdout, /dep-a@2\.0\.0 invalid/);
      assert.ok(mentions(problems, /dep-a@2\.0\.0 invalid/), problems.join('\n'));
    });

    test('a missing required peer is rejected', async t => {
      const packages = baseline();
      delete packages['peer-a'];
      const { listing, problems } = await inspect(t, packages);
      assert.notEqual(listing.status, 0);
      assert.ok(mentions(problems, /exited [1-9]/), problems.join('\n'));
      assert.ok(mentions(problems, /peer-a/), problems.join('\n'));
    });

    test('an invalid required peer version is rejected', async t => {
      const { listing, problems } = await inspect(t, { ...baseline(), 'peer-a': { version: '2.0.0' } });
      assert.notEqual(listing.status, 0);
      assert.ok(mentions(problems, /peer-a@2\.0\.0 invalid/), `${listing.stdout}\n${problems.join('\n')}`);
    });

    test('an unsupported @opencode/plugin version is rejected even when the manifest range accepts it', async t => {
      const packages = baseline();
      packages['@open-heimdall/core'].dependencies['@opencode/plugin'] = '^2.0.0';
      packages['@opencode/plugin'].version = '2.0.21';
      const { listing, problems } = await inspect(t, packages);
      assert.equal(listing.status, 0, 'npm itself accepts the tree, so only the version rule can reject it');
      assert.ok(mentions(problems, /unsupported @opencode\/plugin 2\.0\.21/), problems.join('\n'));
    });

    test('an unsupported @opencode/plugin version is rejected when npm also reports it invalid', async t => {
      const packages = baseline();
      packages['@opencode/plugin'].version = '2.0.21';
      const { listing, problems } = await inspect(t, packages);
      assert.notEqual(listing.status, 0);
      assert.ok(mentions(problems, /unsupported @opencode\/plugin 2\.0\.21/), problems.join('\n'));
      assert.ok(mentions(problems, /@opencode\/plugin@2\.0\.21 invalid/), problems.join('\n'));
    });

    test('a missing @opencode/plugin is rejected', async t => {
      const packages = baseline();
      delete packages['@opencode/plugin'];
      const { problems } = await inspect(t, packages);
      assert.ok(mentions(problems, /@opencode\/plugin is not installed/), problems.join('\n'));
    });

    test('a nested second @opencode/plugin copy at another version is rejected', async t => {
      const tree = await buildTree(t, baseline());
      const nested = path.join(tree.modules, 'dep-a', 'node_modules', '@opencode', 'plugin');
      await fs.mkdir(nested, { recursive: true });
      await fs.writeFile(path.join(nested, 'package.json'), JSON.stringify({ name: '@opencode/plugin', version: '2.0.21' }));
      const listing = await listTree(tree.install, { env: tree.env, cwd: tree.cwd });
      const problems = await verifyDependencyTree({ modules: tree.modules, listing, lock: baselineLock() });
      assert.ok(mentions(problems, /unsupported @opencode\/plugin 2\.0\.21/), problems.join('\n'));
    });

    test('a declared runtime dependency on the quota package is rejected', async t => {
      const packages = baseline();
      packages['@open-heimdall/core'].dependencies['@slkiser/opencode-quota'] = '5.0.1';
      packages['@slkiser/opencode-quota'] = { version: '5.0.1' };
      const { listing, problems } = await inspect(t, packages);
      assert.equal(listing.status, 0, 'npm itself accepts the tree, so only the quota rule can reject it');
      assert.ok(mentions(problems, /@slkiser\/opencode-quota is installed/), problems.join('\n'));
    });

    test('an installed but undeclared quota package is rejected', async t => {
      const { problems } = await inspect(t, { ...baseline(), '@slkiser/opencode-quota': { version: '5.0.1' } });
      assert.ok(mentions(problems, /@slkiser\/opencode-quota is installed/), problems.join('\n'));
      assert.ok(mentions(problems, /opencode-quota@5\.0\.1 extraneous/), problems.join('\n'));
    });
  });
});
