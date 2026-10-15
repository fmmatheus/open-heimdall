import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertOrdinaryInstall, buildTarball, checkout, findPackages, installConsumer, installGlobal, isolatedEnvironment,
  listPackages, listTree, readDependencyLock, removeTarballBuild, runBinary, runModule, toolVersions, verifyDependencyTree,
} from './helpers.mjs';

const requiredFiles = [
  'package.json', 'README.md',
  'dist/cli.js', 'dist/index.js', 'dist/opencode/plugin.js', 'dist/coordinator/index.js', 'dist/coordinator/cli.js',
  'dist/vendor/opencode-quota/package.json', 'dist/vendor/opencode-quota/LICENSE',
  'dist/vendor/opencode-quota/dist/lib/opencode-auth.js',
  'dist/vendor/opencode-quota/dist/providers/anthropic.js',
  'dist/vendor/opencode-quota/dist/providers/kimi-code.js',
  'dist/vendor/opencode-quota/dist/providers/openai.js',
  'prompts/planner.md', 'prompts/executor.md',
  'examples/heimdall.toml', 'examples/coordinator.toml',
  'examples/opencode/agents/adr-planner.md', 'examples/opencode/agents/adr-executor.md', 'examples/opencode/agents/adr-orchestrator.md',
  'examples/opencode/commands/adr-run.md', 'examples/opencode/commands/adr-status.md', 'examples/opencode/commands/adr-resume.md',
  'examples/opencode/plugins/heimdall.ts',
  'skills/openheimdall-start/SKILL.md', 'skills/openheimdall-start/scripts/openheimdall.mjs',
  'skills/openheimdall-monitor/SKILL.md', 'skills/openheimdall-monitor/scripts/openheimdall.mjs',
  'skills/openheimdall-resume/SKILL.md', 'skills/openheimdall-resume/scripts/openheimdall.mjs',
];
const forbiddenPrefixes = [
  'dist/openchamber-extension/', 'dist/extension/', 'extension/', 'src/', 'test/', 'scripts/', 'node_modules/', '.heimdall/', '.github/',
];
const forbiddenFiles = ['package-lock.json', 'npm-shrinkwrap.json', 'tsconfig.json', '.heimdall.toml'];

const probeSpecifiers = ['@open-heimdall/core', '@open-heimdall/core/plugin', '@open-heimdall/core/coordinator'];

// Runs in the installed package with fetch replaced by a stub that fails and counts attempts.
function probeSource(installRoot, specifiers) {
  return `
    const attempts = [];
    globalThis.fetch = async (...args) => { attempts.push(String(args[0])); throw new Error('provider contact is not allowed'); };
    const specifiers = ${JSON.stringify(specifiers)};
    const exportsLoaded = {};
    for (const specifier of specifiers) {
      const module = await import(specifier);
      exportsLoaded[specifier] = Object.keys(module).sort();
    }
    const core = await import(specifiers[0]);
    const quota = await import(${JSON.stringify(pathToFileURL(path.join(installRoot, 'dist/policy/quota.js')).href)});
    const base = await quota.resolveQuotaPackage();
    const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(base + '/package.json', 'utf8'));
    const loader = await quota.createQuotaPackageLoader();
    const auth = await loader.auth();
    const providers = await loader.providers();
    const now = Date.now();
    const entries = percent => ({ fetchedAt: now, errors: [], entries: [{ name: '5h', percentRemaining: percent }, { name: 'Weekly', percentRemaining: percent }] });
    const selection = core.chooseExecutor(
      { anthropic: entries(40), openai: entries(90) },
      {
        minQuotaRemainingPercent: 10, fiveHourQuotaWeight: 0.6,
        executorCandidates: [
          { key: 'claude', quotaProvider: 'anthropic', model: 'anthropic/synthetic-claude' },
          { key: 'gpt', quotaProvider: 'openai', model: 'openai/synthetic-gpt', variant: 'max' },
        ],
      },
    );
    process.stdout.write(JSON.stringify({
      exportsLoaded,
      quotaBase: base,
      quotaName: manifest.name,
      quotaVersion: manifest.version,
      auth: ['createIntegrationCredentialSource', 'bindCredentialSource', 'notifyCredentialsChanged'].map(name => typeof auth[name]),
      providers: providers.map(provider => typeof provider.fetch),
      selected: { model: selection.model, variant: selection.variant },
      attempts,
    }));
  `;
}

// Relative static and literal dynamic imports reachable from an entry file.
async function importClosure(root, entries) {
  const seen = new Set();
  const pattern = /(?:import|export)\s[^'"]*?from\s*['"](\.[^'"]*)['"]|import\s*['"](\.[^'"]*)['"]|import\(\s*['"](\.[^'"]*)['"]\s*\)/g;
  const visit = async file => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = await fs.readFile(path.join(root, file), 'utf8');
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      await visit(path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier)));
    }
  };
  for (const entry of entries) await visit(entry);
  return [...seen].sort();
}

describe('installed package', () => {
  let build;
  let environment;
  let work;
  let consumer;
  let global;
  let elsewhere;
  const cleanups = [];

  before(async () => {
    build = await buildTarball();
    work = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-install-')));
    cleanups.push(() => fs.rm(work, { recursive: true, force: true }));
    environment = await isolatedEnvironment(work);
    elsewhere = path.join(work, 'elsewhere');
    await fs.mkdir(elsewhere);
    consumer = await installConsumer(build.tarball, { env: environment.env, directory: path.join(work, 'consumer') });
    global = await installGlobal(build.tarball, { env: environment.env, prefix: path.join(work, 'global-prefix'), cwd: elsewhere });
  });

  after(async () => {
    for (const cleanup of cleanups) await cleanup();
    await removeTarballBuild();
  });

  test('tarball is built from a clean copy and has the intended inventory', async t => {
    t.diagnostic(`environment: ${await toolVersions(environment.env)}`);
    for (const line of build.lines) t.diagnostic(line);
    t.diagnostic(`tarball: ${build.tarball}`);
    t.diagnostic(`inventory: ${build.files.length} files`);
    for (const file of build.files) t.diagnostic(`  ${file}`);
    assert.ok(!path.resolve(build.tarball).startsWith(checkout), 'tarball must not be written into the checkout');
    for (const file of requiredFiles) assert.ok(build.files.includes(file), `missing ${file}`);
    for (const file of build.files) {
      for (const prefix of forbiddenPrefixes) assert.ok(!file.startsWith(prefix), `unexpected ${file}`);
      assert.ok(!forbiddenFiles.includes(file), `unexpected ${file}`);
      assert.ok(!file.endsWith('.map'), `unexpected ${file}`);
    }
    t.diagnostic('inventory assertions: required files present; extension build, sources, tests, node_modules, lockfiles and .heimdall absent');
  });

  test('packed manifest keeps the supported identity and declares only installable dependencies', async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(consumer.root, 'package.json'), 'utf8'));
    assert.equal(manifest.name, '@open-heimdall/core');
    assert.equal(manifest.version, '0.0.0');
    assert.equal(manifest.private, true);
    assert.equal(manifest.dependencies['@opencode/plugin'], '2.0.22');
    assert.equal(manifest.dependencies['@slkiser/opencode-quota'], undefined);
    assert.equal(manifest.devDependencies['@slkiser/opencode-quota'], '5.0.1');
    assert.deepEqual(Object.keys(manifest.exports), ['.', './plugin', './coordinator']);
    assert.equal(manifest.bin.heimdall, './dist/cli.js');
  });

  test('every file the exports and the CLI import is shipped', async () => {
    const manifest = JSON.parse(await fs.readFile(path.join(consumer.root, 'package.json'), 'utf8'));
    const entries = [...Object.values(manifest.exports), manifest.bin.heimdall, './dist/policy/quota.js'].map(file => file.replace(/^\.\//, ''));
    const closure = await importClosure(consumer.root, entries);
    for (const file of ['dist/config.js', 'dist/workflow/runner.js', 'dist/coordinator/service.js', 'dist/coordinator/cli.js', 'dist/opencode/plugin.js']) assert.ok(closure.includes(file), `${file} is part of the import closure`);
    for (const file of closure) assert.ok(build.files.includes(file), `${file} is imported but not packed`);
  });

  for (const layout of ['consumer', 'global']) {
    describe(`${layout} installation`, () => {
      const install = () => layout === 'consumer' ? consumer : global;

      test('uses plain npm commands without overrides, links or forced resolution', async t => {
        const { argv } = install();
        t.diagnostic(`argv: npm ${argv.map(argument => argument === build.tarball ? '<tarball>' : argument).join(' ')}`);
        assertOrdinaryInstall(argv);
        if (layout === 'consumer') {
          assert.deepEqual(argv, ['install', build.tarball]);
          const manifest = JSON.parse(await fs.readFile(path.join(consumer.directory, 'package.json'), 'utf8'));
          for (const key of ['overrides', 'resolutions', 'dependenciesMeta']) assert.equal(manifest[key], undefined, `${key} must not be configured`);
          assert.deepEqual(Object.keys(manifest.dependencies), ['@open-heimdall/core']);
          assert.equal((await fs.lstat(consumer.root)).isSymbolicLink(), false, 'package must be copied, not linked');
        } else {
          assert.deepEqual(argv, ['install', '--global', '--prefix', global.directory, build.tarball]);
          assert.equal((await fs.lstat(global.root)).isSymbolicLink(), false, 'package must be copied, not linked');
        }
      });

      test('resolves one supported @opencode/plugin and no quota package dependency', async t => {
        const { modules } = install();
        const plugins = await findPackages(modules, '@opencode/plugin');
        assert.ok(plugins.length >= 1);
        for (const plugin of plugins) assert.equal(plugin.version, '2.0.22', plugin.location);
        assert.deepEqual(await findPackages(modules, '@slkiser/opencode-quota'), []);
        const listing = await listTree(install(), { env: environment.env, cwd: elsewhere });
        t.diagnostic(`${layout}: npm ${listing.argv.join(' ').replace(install().directory, '<prefix>')} exited ${listing.status}`);
        // npm ls exits nonzero for invalid or missing required dependencies and peers. An optional native
        // package that npm 10 leaves behind after removing its failed optional parent is the one extraneous
        // report the rule accepts (see leftoverOptionalPackages); test/package/tree-validation.test.mjs
        // holds the controls that every other problem is still rejected.
        const lock = await readDependencyLock();
        assert.deepEqual(await verifyDependencyTree({ modules, listing, lock }), []);
        const extraneous = listing.stdout.split('\n').filter(line => /extraneous/.test(line)).map(line => line.trim());
        for (const line of extraneous) t.diagnostic(`${layout}: accepted leftover optional package: ${line}`);
      });

      test('msgpackr loads and round-trips with or without its optional native accelerator', async t => {
        const { modules, directory } = install();
        const copies = await findPackages(modules, 'msgpackr');
        assert.ok(copies.length >= 1, 'msgpackr is installed');
        const installed = new Set((await listPackages(modules)).map(entry => entry.name));
        for (const { location } of copies) {
          const result = await runModule(`
            import { createRequire } from 'node:module';
            const require = createRequire(${JSON.stringify(path.join(location, 'package.json'))});
            let native;
            try { require('msgpackr-extract'); native = 'loaded'; } catch (error) { native = error.code; }
            const { pack, unpack } = require(${JSON.stringify(location)});
            const sample = { text: 'x'.repeat(64), list: [1, 2, 3], nested: { flag: true } };
            console.log(JSON.stringify({ native, same: JSON.stringify(unpack(pack(sample))) === JSON.stringify(sample) }));
          `, { cwd: layout === 'consumer' ? directory : elsewhere, env: environment.env });
          assert.equal(result.status, 0, result.stderr);
          const report = JSON.parse(result.stdout);
          t.diagnostic(`${layout}: msgpackr at ${path.relative(modules, location)}; native accelerator ${report.native}`);
          assert.equal(report.same, true);
          // An accelerator that is not installed must be reported as missing, never as a broken load.
          if (!installed.has('msgpackr-extract')) assert.equal(report.native, 'MODULE_NOT_FOUND');
        }
      });

      test('installed heimdall runs from outside the checkout without configuration', async t => {
        const help = await runBinary(install(), ['--help'], { cwd: elsewhere, env: environment.env });
        assert.equal(help.status, 0, help.stderr);
        for (const command of ['heimdall init', 'heimdall check', 'heimdall status', 'heimdall coordinator --help', 'heimdall --version']) {
          assert.ok(help.stdout.includes(command), `help lists ${command}`);
        }
        const version = await runBinary(install(), ['--version'], { cwd: elsewhere, env: environment.env });
        assert.equal(version.status, 0, version.stderr);
        assert.equal(version.stdout, '0.0.0\n');
        assert.equal(version.stderr, '');
        t.diagnostic(`${layout}: ${install().bin} --version -> ${version.stdout.trim()} (cwd ${elsewhere})`);
        const coordinator = await runBinary(install(), ['coordinator', '--help'], { cwd: elsewhere, env: environment.env });
        assert.equal(coordinator.status, 0, coordinator.stderr);
        assert.match(coordinator.stdout, /coordinator/i);
      });

      test('exports and the quota helper modules load with provider network access disabled', async t => {
        const { root } = install();
        const specifiers = layout === 'consumer'
          ? probeSpecifiers
          : Object.values(JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).exports).map(file => pathToFileURL(path.join(root, file)).href);
        const cwd = layout === 'consumer' ? install().directory : elsewhere;
        const result = await runModule(probeSource(root, specifiers), { cwd, env: environment.env });
        assert.equal(result.status, 0, result.stderr);
        const report = JSON.parse(result.stdout);
        t.diagnostic(`${layout}: loaded ${Object.keys(report.exportsLoaded).length} exports; quota modules from ${report.quotaBase}; selected ${report.selected.model}`);
        assert.deepEqual(Object.keys(report.exportsLoaded), specifiers);
        const core = report.exportsLoaded[specifiers[0]];
        for (const name of ['loadConfiguration', 'chooseExecutor', 'createQuota', 'createObserver']) assert.ok(core.includes(name), `root export ${name}`);
        assert.ok(report.exportsLoaded[specifiers[1]].length > 0);
        assert.ok(report.exportsLoaded[specifiers[2]].length > 0);
        assert.equal(await fs.realpath(report.quotaBase), path.join(await fs.realpath(root), 'dist', 'vendor', 'opencode-quota'));
        assert.equal(report.quotaName, '@slkiser/opencode-quota');
        assert.equal(report.quotaVersion, '5.0.1');
        assert.deepEqual(report.auth, ['function', 'function', 'function']);
        assert.deepEqual(report.providers, ['function', 'function', 'function']);
        assert.deepEqual(report.selected, { model: 'openai/synthetic-gpt', variant: 'max' });
        assert.deepEqual(report.attempts, []);
      });
    });
  }
});
