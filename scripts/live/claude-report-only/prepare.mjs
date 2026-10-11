// Create a fresh disposable fixture root and manifest.json. Starts nothing, calls no model.
//   node prepare.mjs [--host-modules <dir with @opencode/server matching OpenCode>]
// The host modules directory is only symlinked read-only after its versions are confirmed.
import fs from 'node:fs';
import path from 'node:path';
import {
  FIXTURE_PARENT, FIXTURE_PREFIX, INSTALLED_PROVIDER, capture, emit, parseArguments, readJson, storeEnvironment,
  storePaths, writeManifest,
} from './lib.mjs';

const options = parseArguments(process.argv.slice(2));

const root = fs.mkdtempSync(path.join(FIXTURE_PARENT, FIXTURE_PREFIX));
fs.chmodSync(root, 0o700);
const stores = storePaths(root);
for (const directory of [
  stores.profile, stores.data, stores.cache, stores.config, stores.state, stores.home, stores.tmp, stores.pty,
  stores.configDirectory, path.join(root, 'config', 'empty-hooks'), path.join(root, 'guard'),
  path.join(root, 'evidence'), path.join(root, 'logs'), path.join(root, 'native-host'),
]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

// Version probes run in the scrubbed environment; only --version flags are used.
const env = storeEnvironment(root);
const first = async (command, args) => (await capture(command, args, { env })).stdout.trim().split('\n')[0];
const swVers = Object.fromEntries((await capture('sw_vers', [], { env })).stdout.trim().split('\n').map(line => line.split(/:\s+/)));
const providerPackage = readJson(path.join(INSTALLED_PROVIDER, 'package.json'));
const sdkPackage = readJson(path.join(INSTALLED_PROVIDER, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'));
const openCodeVersion = await first('opencode', ['--version']);
const versions = {
  opencode: openCodeVersion,
  claude: await first('claude', ['--version']),
  provider: { name: providerPackage.name, version: providerPackage.version },
  agentSdk: { name: sdkPackage.name, version: sdkPackage.version },
  node: process.version,
  bun: await first('bun', ['--version']),
  macOS: { productVersion: swVers.ProductVersion, buildVersion: swVers.BuildVersion },
};

let hostModules = null;
if (options['host-modules']) {
  const source = fs.realpathSync(options['host-modules']);
  const serverVersion = readJson(path.join(source, '@opencode/server/package.json')).version;
  const expected = openCodeVersion.replace(/^opencode v/, '');
  if (serverVersion !== expected) throw new Error(`@opencode/server ${serverVersion} does not match OpenCode ${expected}`);
  const target = path.join(root, 'native-host', 'node_modules');
  fs.symlinkSync(source, target, 'dir');
  hostModules = { link: target, openCodeServerVersion: serverVersion, readOnlySymlink: true };
}

writeManifest(root, {
  root,
  createdAt: new Date().toISOString(),
  versions,
  stores,
  hostModules,
  guardProfile: path.join(root, 'guard', 'profile.sb'),
  repository: path.join(root, 'repo'),
  provider: path.join(root, 'native-host', 'plugins', 'opencode-claude'),
  processes: [],
  outcome: 'pending',
});
emit({ root, manifest: path.join(root, 'manifest.json'), versions });
