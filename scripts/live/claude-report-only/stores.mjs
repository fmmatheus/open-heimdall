// Resolve every OpenCode and provider store with the fixture environment and prove each is
// under the fixture root. Runs `opencode debug paths` only (read-only); starts no server.
//   node stores.mjs --root /private/tmp/heimdall-0006.XXXXXX
import fs from 'node:fs';
import path from 'node:path';
import { assertFixtureRoot, capture, emit, isUnder, parseArguments, storeEnvironment, storePaths, updateManifest } from './lib.mjs';

const options = parseArguments(process.argv.slice(2));
const root = assertFixtureRoot(options.root ?? '');
const stores = storePaths(root);
const env = storeEnvironment(root);

// The live variables that must not reach the fixture. They are removed by storeEnvironment().
const mustBeUnset = ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_PASSWORD', 'OPENCODE_SERVER_PASSWORD'];
const leaked = mustBeUnset.filter(key => key in env);
if (leaked.length > 0) throw new Error(`Live variables still set: ${leaked.join(', ')}`);

const result = await capture('opencode', ['debug', 'paths'], { env, cwd: root });
if (result.code !== 0) throw new Error(`opencode debug paths failed: ${result.stderr.slice(0, 500)}`);
const resolved = {};
for (const line of result.stdout.split('\n')) {
  const match = line.match(/^(\w+)\s+(\/.*)$/);
  if (match) resolved[match[1]] = match[2].trim();
}
const required = ['home', 'data', 'cache', 'config', 'state', 'bin', 'log', 'repos', 'db', 'tmp'];
const missing = required.filter(key => !resolved[key]);
if (missing.length > 0) throw new Error(`debug paths did not report: ${missing.join(', ')}`);

const rows = Object.entries(resolved).map(([name, value]) => ({ name, path: value, underRoot: isUnder(root, value) }));
// Stores not reported by `debug paths`: the database override, pty runtime, provider auth state and provider files.
const extra = [
  ['OPENCODE_DB', env.OPENCODE_DB], ['OPENCODE_PTY_RUNTIME_DIR', env.OPENCODE_PTY_RUNTIME_DIR],
  ['OPENCODE_CONFIG_DIR', env.OPENCODE_CONFIG_DIR], ['OPENCODE_TEST_HOME', env.OPENCODE_TEST_HOME], ['TMPDIR', env.TMPDIR],
  ['OPENCODE_CLAUDE_AUTH_STATE_FILE', env.OPENCODE_CLAUDE_AUTH_STATE_FILE],
  ...Object.entries(stores.providerStores).map(([name, value]) => [`provider.${name}`, value]),
].map(([name, value]) => ({ name, path: value, underRoot: isUnder(root, value) }));
const outside = [...rows, ...extra].filter(row => !row.underRoot);
const sanitize = value => value.replaceAll(root, '<root>');
const record = {
  homeUnchanged: env.HOME === process.env.HOME,
  liveVariablesUnset: mustBeUnset,
  debugPaths: rows.map(row => ({ ...row, path: sanitize(row.path) })),
  overrides: extra.map(row => ({ ...row, path: sanitize(row.path) })),
  outsideRoot: outside.map(row => row.name),
};
fs.writeFileSync(path.join(root, 'evidence', 'stores.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
updateManifest(root, manifest => { manifest.storeResolution = { ok: outside.length === 0 && record.homeUnchanged, ...record }; });
emit({ ok: outside.length === 0 && record.homeUnchanged, outsideRoot: record.outsideRoot, debugPaths: record.debugPaths });
if (outside.length > 0) process.exitCode = 1;
