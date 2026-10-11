// Disposable native OpenCode host for the live verification, adapted from the feature 0003 smoke host.
// Start it only through the guard launcher, which wraps it in the recorded sandbox-exec profile and Bun:
//   node guard.mjs launch --root /private/tmp/heimdall-0006.XXXXXX -- bun server.mjs --root /private/tmp/heimdall-0006.XXXXXX [--port N]
//   node server.mjs --root ... --resolve-only      # prints resolved stores, starts nothing
// It refuses to start unless every resolved store is under the fixture root and the process proves, by OS
// behaviour (confinement.mjs), that it runs confined by the recorded profile. That check runs before any
// directory is created, any host module is imported or any server is opened.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { proveConfinement } from './confinement.mjs';
import { assertFixtureRoot, emit, isUnder, parseArguments, readManifest, storeEnvironment, storePaths } from './lib.mjs';

const options = parseArguments(process.argv.slice(2));
const root = assertFixtureRoot(options.root ?? '');
const manifest = readManifest(root);
const stores = storePaths(root);

const environment = storeEnvironment(root);
const resolved = {
  XDG_DATA_HOME: environment.XDG_DATA_HOME, XDG_CACHE_HOME: environment.XDG_CACHE_HOME,
  XDG_CONFIG_HOME: environment.XDG_CONFIG_HOME, XDG_STATE_HOME: environment.XDG_STATE_HOME,
  OPENCODE_TEST_HOME: environment.OPENCODE_TEST_HOME, OPENCODE_CONFIG_DIR: environment.OPENCODE_CONFIG_DIR,
  OPENCODE_DB: environment.OPENCODE_DB, TMPDIR: environment.TMPDIR, OPENCODE_PTY_RUNTIME_DIR: environment.OPENCODE_PTY_RUNTIME_DIR,
  OPENCODE_CLAUDE_AUTH_STATE_FILE: environment.OPENCODE_CLAUDE_AUTH_STATE_FILE,
  database: stores.database, configDirectory: stores.configDirectory,
};
const outside = Object.entries(resolved).filter(([, value]) => !isUnder(root, value)).map(([key]) => key);
if (outside.length > 0) { process.stderr.write(`Refusing to start: outside fixture root: ${outside.join(', ')}\n`); process.exit(2); }
if (options['resolve-only']) {
  emit({ resolveOnly: true, home: process.env.HOME === environment.HOME ? 'unchanged' : 'CHANGED', stores: Object.fromEntries(Object.entries(resolved).map(([key, value]) => [key, value.replaceAll(root, '<root>')])) });
  process.exit(0);
}
const confinement = proveConfinement({ root, home: os.homedir(), manifest });
if (!confinement.confined) {
  process.stderr.write(`Refusing to start: not confined by the recorded guard (${confinement.problems.join('; ').replaceAll(root, '<root>')}). Start it with guard.mjs launch.\n`);
  process.exit(3);
}
if (typeof Bun === 'undefined') { process.stderr.write('Refusing to start: this host needs Bun\n'); process.exit(2); }

// Replace this process environment with the isolated one. HOME and CODEX_HOME are untouched.
for (const key of Object.keys(process.env)) if (!(key in environment)) delete process.env[key];
Object.assign(process.env, environment);
for (const directory of [stores.data, stores.cache, stores.config, stores.state, stores.home, stores.tmp, stores.pty, stores.configDirectory]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });

const hostDirectory = path.join(root, 'native-host');
if (!manifest.hostModules) { process.stderr.write('Refusing to start: no matching @opencode/server modules were linked by prepare.mjs\n'); process.exit(2); }
const load = specifier => import(Bun.resolveSync(specifier, hostDirectory));
const { ServerFetch } = await load('@opencode/server/fetch');
const { SessionRestart } = await load('@opencode/core/session/execution/restart');
const { Effect, Layer } = await load('effect');

const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
process.on('SIGTERM', () => controller.abort());
const version = manifest.hostModules.openCodeServerVersion;

const program = Effect.gen(function* () {
  const handler = yield* ServerFetch.make({
    app: { name: 'heimdall-0005-live', version },
    database: { path: stores.database },
    config: { directory: stores.configDirectory, project: true },
    fs: { filewatcher: false, fff: false }, events: { persist: true },
  }, {
    // No automatic resume of suspended sessions.
    overrides: [SessionRestart.node.replace(Layer.succeed(SessionRestart.Service, { resumeSuspendedSessions: Effect.void }))],
  });
  const server = Bun.serve({ hostname: '127.0.0.1', port: Number(options.port ?? 0), fetch: handler });
  yield* Effect.addFinalizer(() => Effect.sync(() => server.stop(true)));
  const metadata = { baseUrl: `http://127.0.0.1:${server.port}`, pid: process.pid, version, authentication: 'none', database: stores.database, privateProfile: stores.profile, automaticSessionRecovery: false };
  fs.writeFileSync(path.join(root, 'native-server.json'), JSON.stringify(metadata, null, 2), { mode: 0o600 });
  process.stdout.write(JSON.stringify({ ready: true, baseUrl: metadata.baseUrl, pid: metadata.pid, authentication: 'none' }) + '\n');
  yield* Effect.never;
});
try { await Effect.runPromise(Effect.scoped(program), { signal: controller.signal }); }
catch (error) { if (!controller.signal.aborted) { process.stderr.write(String(error) + '\n'); process.exitCode = 1; } }
