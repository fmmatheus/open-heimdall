// Copy the installed provider into the fixture with exclusive-create writes and apply only
// the isolation patches. The installed provider is hashed before and after and never written.
//   node copy-provider.mjs --root /private/tmp/heimdall-0005.XXXXXX
import fs from 'node:fs';
import path from 'node:path';
import {
  INSTALLED_PROVIDER, PROVIDER_FILES, assertFixtureRoot, assertUnder, capture, emit, hashInstalledProvider, hashTree,
  parseArguments, readJson, sha256, updateManifest,
} from './lib.mjs';

// Anchors re-derived against provider 1.3.4 dist/query.js. Each must match exactly once.
export const PATCHES = [
  {
    name: 'settingSources-empty',
    reason: 'no user/project/local Claude settings or hooks; OpenCode supplies project instructions',
    anchor: '        settingSources: Array.isArray(params.settingSources)\n            ? params.settingSources\n            : ["user", "project", "local"],',
    replacement: '        // Fixture isolation: never load user/project/local Claude settings or hooks.\n        settingSources: [],',
  },
  {
    name: 'persistSession-false',
    reason: 'never write Claude transcripts for any turn',
    anchor: '    if (params.persistSession === false)\n        options.persistSession = false;',
    replacement: '    // Fixture isolation: never persist Claude transcripts for any turn.\n    options.persistSession = false;',
  },
];
const PATCHED_FILE = 'dist/query.js';

export function applyPatches(source) {
  let patched = source;
  for (const patch of PATCHES) {
    if (patched.split(patch.anchor).length !== 2) throw new Error(`Patch anchor "${patch.name}" does not match exactly once in the installed provider`);
    patched = patched.replace(patch.anchor, () => patch.replacement);
  }
  return patched;
}

function exclusiveWrite(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 });
}

if (import.meta.url === new URL(process.argv[1], 'file://').href) {
  const options = parseArguments(process.argv.slice(2));
  const root = assertFixtureRoot(options.root ?? '');
  const destination = path.join(root, 'native-host', 'plugins', 'opencode-claude');
  assertUnder(root, destination, 'copied provider');

  const before = hashInstalledProvider();
  const packageJson = readJson(path.join(INSTALLED_PROVIDER, 'package.json'));
  const modules = fs.realpathSync(path.join(INSTALLED_PROVIDER, 'node_modules'));
  const modulePackage = name => readJson(path.join(modules, name, 'package.json')).version;
  if (modulePackage('@anthropic-ai/claude-agent-sdk') !== packageJson.dependencies['@anthropic-ai/claude-agent-sdk']) throw new Error('Agent SDK version does not match the provider dependency');
  if (modulePackage('zod') !== packageJson.dependencies.zod) throw new Error('zod version does not match the provider dependency');

  const files = [...PROVIDER_FILES, ...Object.keys(hashTree(path.join(INSTALLED_PROVIDER, 'dist'))).map(name => `dist/${name}`)];
  for (const relative of files) {
    let bytes = fs.readFileSync(path.join(INSTALLED_PROVIDER, relative));
    if (relative === PATCHED_FILE) bytes = applyPatches(bytes.toString('utf8'));
    exclusiveWrite(path.join(destination, relative), bytes);
  }
  // Read-only link to the installed dependency tree, created only after the versions matched.
  fs.symlinkSync(modules, path.join(destination, 'node_modules'), 'dir');

  const after = hashInstalledProvider();
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  if (!unchanged) throw new Error('Installed provider changed while copying');

  const copied = hashTree(destination, new Set(['node_modules']));
  const differing = files.filter(relative => copied[relative] !== before[relative]);
  const unexpected = differing.filter(relative => relative !== PATCHED_FILE);
  if (unexpected.length > 0) throw new Error(`Unexpected copied differences: ${unexpected.join(', ')}`);
  if (copied['dist/proxy.js'] !== before['dist/proxy.js']) throw new Error('proxy.js tool bridge differs from the installed provider');

  const diff = await capture('diff', ['-u', path.join(INSTALLED_PROVIDER, PATCHED_FILE), path.join(destination, PATCHED_FILE)]);
  const diffText = diff.stdout.replaceAll(INSTALLED_PROVIDER, '<installed-provider>').replaceAll(root, '<root>');
  fs.writeFileSync(path.join(root, 'evidence', 'provider-query.diff'), diffText, { mode: 0o600 });
  const added = diffText.split('\n').filter(line => /^[-+][^-+]/.test(line));
  updateManifest(root, manifest => {
    manifest.providerCopy = {
      installedProvider: '~/.config/opencode/v2-plugins/opencode-claude',
      destination,
      patches: PATCHES.map(({ name, reason }) => ({ name, reason })),
      differingFiles: differing,
      proxyJsIdentical: true,
      installedHashesIdenticalBeforeAndAfter: unchanged,
      installedQueryJsSha256: before[PATCHED_FILE],
      copiedQueryJsSha256: copied[PATCHED_FILE],
      installedProxyJsSha256: before['dist/proxy.js'],
      installedFileCount: Object.keys(before).length,
      installedTreeSha256: sha256(JSON.stringify(before)),
      diffLines: added.length,
    };
  });
  emit({ ok: true, differingFiles: differing, installedHashesIdenticalBeforeAndAfter: unchanged, installedFileCount: Object.keys(before).length, installedTreeSha256: sha256(JSON.stringify(before)) });
}
