import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createQuotaPackageLoader, resolveQuotaPackage } from '../dist/policy/quota.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quota loader '));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const base = path.join(directory, 'node_modules', '@slkiser', 'opencode-quota');
  await fs.mkdir(path.join(base, 'dist', 'lib'), { recursive: true });
  await fs.mkdir(path.join(base, 'dist', 'providers'), { recursive: true });
  const manifest = { name: '@slkiser/opencode-quota', version: '5.0.1', type: 'module', exports: { '.': './dist/index.js' } };
  await fs.writeFile(path.join(base, 'package.json'), JSON.stringify(manifest));
  await fs.writeFile(path.join(base, 'dist', 'index.js'), 'export {};');
  await fs.writeFile(path.join(base, 'dist', 'lib', 'opencode-auth.js'), `
    export function notifyCredentialsChanged() { throw Error('no credential actions in loader test'); }
    export function createIntegrationCredentialSource() { throw Error('no credential actions in loader test'); }
    export function bindCredentialSource() { throw Error('no credential actions in loader test'); }
  `);
  for (const [file, name] of [['anthropic', 'anthropicProvider'], ['kimi-code', 'kimiCodePlanGlobalProvider'], ['openai', 'openaiProvider']]) {
    await fs.writeFile(path.join(base, 'dist', 'providers', file + '.js'), `export const ${name} = { fetch() { throw Error('no provider calls in loader test'); } };`);
  }
  const resolver = createRequire(path.join(directory, 'consumer.mjs'));
  return { directory, base, manifest, resolver };
}

test('installed pinned quota package resolves independently of the caller working directory', async t => {
  t.mock.method(globalThis, 'fetch', async () => assert.fail('loader must not make HTTP requests'));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'quota-unrelated-cwd-'));
  const previous = process.cwd();
  try {
    process.chdir(directory);
    const base = await resolveQuotaPackage();
    const manifest = JSON.parse(await fs.readFile(path.join(base, 'package.json'), 'utf8'));
    assert.equal(manifest.name, '@slkiser/opencode-quota');
    assert.equal(manifest.version, '5.0.1');
    const loader = await createQuotaPackageLoader();
    const auth = await loader.auth();
    assert.equal(typeof auth.createIntegrationCredentialSource, 'function');
    assert.equal(typeof auth.bindCredentialSource, 'function');
    assert.equal(typeof auth.notifyCredentialsChanged, 'function');
    const providers = await loader.providers();
    assert.equal(providers.length, 3);
    for (const provider of providers) assert.equal(typeof provider.fetch, 'function');
  } finally {
    process.chdir(previous);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('package entry resolution supports export maps and paths containing spaces', async t => {
  const { base, resolver } = await fixture(t);
  assert.throws(() => resolver.resolve('@slkiser/opencode-quota/package.json'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
  const resolveModule = specifier => resolver.resolve(specifier);
  assert.equal(await resolveQuotaPackage(undefined, resolveModule), await fs.realpath(base));
  const loader = await createQuotaPackageLoader({ resolveModule });
  assert.equal(typeof (await loader.auth()).bindCredentialSource, 'function');
  assert.equal((await loader.providers()).length, 3);
  const configured = await createQuotaPackageLoader({ packagePath: base, resolveModule: () => assert.fail('configured package must not use default resolution') });
  assert.equal((await configured.providers()).length, 3);
});

test('quota loader rejects a different package name or version before importing provider modules', async t => {
  const { base, manifest } = await fixture(t);
  for (const replacement of [{ ...manifest, version: '5.0.2' }, { ...manifest, name: 'other-package' }]) {
    await fs.writeFile(path.join(base, 'package.json'), JSON.stringify(replacement));
    await assert.rejects(createQuotaPackageLoader({ packagePath: base, load: async () => assert.fail('invalid package must not be loaded') }), /pinned official.*5\.0\.1/);
  }
});
