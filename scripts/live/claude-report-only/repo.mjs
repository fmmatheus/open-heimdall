// Create the disposable git repository used by the live tool-path checks (T2).
// Committed files only: src/impl.js, test/impl.test.js, package.json. No hooks, no signing.
//   node repo.mjs --root /private/tmp/heimdall-0005.XXXXXX
import fs from 'node:fs';
import path from 'node:path';
import { assertFixtureRoot, assertUnder, capture, emit, parseArguments, sha256, updateManifest } from './lib.mjs';

export const FILES = {
  'package.json': JSON.stringify({ name: 'heimdall-0005-fixture', version: '0.0.0', private: true, type: 'module', scripts: { test: 'node --test test/impl.test.js' } }, null, 2) + '\n',
  'src/impl.js': 'export function greet(name) {\n  return `hello ${name}`;\n}\n',
  'test/impl.test.js': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { greet } from '../src/impl.js';\n\ntest('greet', () => {\n  assert.equal(greet('world'), 'hello world');\n});\n",
};

export function gitEnvironment() {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of Object.keys(env)) if (/^GIT_/.test(key) && key !== 'GIT_OPTIONAL_LOCKS') delete env[key];
  return env;
}

export async function createRepository(root) {
  const repository = assertUnder(root, path.join(root, 'repo'), 'repository');
  const hooks = path.join(root, 'config', 'empty-hooks');
  fs.mkdirSync(hooks, { recursive: true, mode: 0o700 });
  fs.mkdirSync(repository, { mode: 0o700 });
  const git = async args => {
    const result = await capture('git', ['-c', `core.hooksPath=${hooks}`, ...args], { cwd: repository, env: gitEnvironment() });
    if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.slice(0, 300)}`);
    return result.stdout.trim();
  };
  for (const [relative, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(repository, relative)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(repository, relative), content, { flag: 'wx', mode: 0o600 });
  }
  await git(['-c', 'init.templateDir=', 'init', '-b', 'main']);
  for (const [key, value] of [['user.name', 'Heimdall Fixture'], ['user.email', 'fixture@example.invalid'], ['commit.gpgsign', 'false'], ['core.hooksPath', hooks]]) await git(['config', '--local', key, value]);
  await git(['add', '--', ...Object.keys(FILES)]);
  await git(['commit', '-m', 'Initial live verification fixture']);
  const tests = await capture(process.execPath, ['--test', 'test/impl.test.js'], { cwd: repository });
  if (tests.code !== 0) throw new Error('Baseline fixture tests failed');
  return {
    repository,
    head: await git(['rev-parse', 'HEAD']),
    status: await git(['status', '--porcelain']),
    hashes: Object.fromEntries(Object.keys(FILES).map(relative => [relative, sha256(fs.readFileSync(path.join(repository, relative)))])),
    hooksPath: await git(['config', '--local', 'core.hooksPath']),
    gpgsign: await git(['config', '--local', 'commit.gpgsign']),
  };
}

if (import.meta.url === new URL(process.argv[1], 'file://').href) {
  const root = assertFixtureRoot(parseArguments(process.argv.slice(2)).root ?? '');
  const info = await createRepository(root);
  updateManifest(root, manifest => { manifest.repositoryBaseline = { head: info.head, hashes: info.hashes, hooksPath: info.hooksPath.replaceAll(root, '<root>'), gpgsign: info.gpgsign }; });
  emit({ ok: info.status === '', head: info.head, hashes: info.hashes });
}
