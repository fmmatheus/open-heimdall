// Shared helpers for the claude-code report-only live verification harness.
// Nothing here starts a server, calls a model or touches credentials.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const FIXTURE_PARENT = '/private/tmp';
export const FIXTURE_PREFIX = 'heimdall-0006.';
export const INSTALLED_PROVIDER = path.join(os.homedir(), '.config/opencode/v2-plugins/opencode-claude');
export const PROVIDER_FILES = ['package.json', 'index.js', 'opencode-claude.js', 'LICENSE', 'README.md'];

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      parsed[argument.slice(2)] = true; // bare flag
      continue;
    }
    parsed[argument.slice(2)] = value;
    index += 1;
  }
  return parsed;
}

export function isUnder(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function assertUnder(root, candidate, label = candidate) {
  if (!isUnder(root, candidate)) throw new Error(`${label} resolves outside the fixture root`);
  return path.resolve(candidate);
}

export function assertFixtureRoot(root) {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== FIXTURE_PARENT || !path.basename(resolved).startsWith(FIXTURE_PREFIX)) {
    throw new Error(`Fixture root must be ${FIXTURE_PARENT}/${FIXTURE_PREFIX}*: ${resolved}`);
  }
  return resolved;
}

export function manifestPath(root) {
  return path.join(root, 'manifest.json');
}

export function readManifest(root) {
  return JSON.parse(fs.readFileSync(manifestPath(assertFixtureRoot(root)), 'utf8'));
}

export function writeManifest(root, manifest) {
  const target = manifestPath(assertFixtureRoot(root));
  const temporary = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(temporary, target);
}

export function updateManifest(root, mutate) {
  const manifest = readManifest(root);
  mutate(manifest);
  writeManifest(root, manifest);
  return manifest;
}

// Every store the OpenCode server and the provider may write, all under the fixture root.
export function storePaths(root) {
  const profile = path.join(root, 'profile');
  return {
    profile,
    data: path.join(profile, 'data'),
    cache: path.join(profile, 'cache'),
    config: path.join(profile, 'config'),
    state: path.join(profile, 'state'),
    home: path.join(profile, 'home'),
    tmp: path.join(profile, 'tmp'),
    pty: path.join(profile, 'pty'),
    configDirectory: path.join(profile, 'config', 'opencode'),
    database: path.join(profile, 'native.db'),
    providerAuthState: path.join(profile, 'data', 'opencode-claude', 'manual-auth.json'),
    // Provider 1.3.4 derives these from XDG_DATA_HOME (log.js, models.js, rate-limit.js, session-store.js).
    providerStores: {
      debugLog: path.join(profile, 'data', 'opencode-claude', 'debug.log'),
      models: path.join(profile, 'data', 'opencode-claude', 'models.json'),
      rateLimit: path.join(profile, 'data', 'opencode-claude', 'rate-limit.json'),
      sessions: path.join(profile, 'data', 'opencode-claude', 'sessions.json'),
    },
  };
}

const SCRUBBED_ENV = /^(OPENCODE|CLAUDE|ANTHROPIC|OPENAI|KIMI|XDG|GIT)_/;

// Build the isolated process environment. HOME and CODEX_HOME are never changed:
// the existing Claude login is reached through HOME only, behind the guard.
export function storeEnvironment(root, base = process.env) {
  const stores = storePaths(root);
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !SCRUBBED_ENV.test(key) && key !== 'TMPDIR') env[key] = value;
  }
  return Object.assign(env, {
    XDG_DATA_HOME: stores.data,
    XDG_CACHE_HOME: stores.cache,
    XDG_CONFIG_HOME: stores.config,
    XDG_STATE_HOME: stores.state,
    OPENCODE_TEST_HOME: stores.home,
    OPENCODE_CONFIG_DIR: stores.configDirectory,
    OPENCODE_DB: stores.database,
    OPENCODE_PTY_RUNTIME_DIR: stores.pty,
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    DISABLE_AUTOUPDATER: '1',
    OPENCODE_CLAUDE_AUTH_STATE_FILE: stores.providerAuthState,
    TMPDIR: stores.tmp,
  });
}

export async function capture(command, args, options = {}) {
  try {
    const { stdout, stderr } = await run(command, args, { maxBuffer: 64 * 1024 * 1024, ...options });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: typeof error.code === 'number' ? error.code : 1, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error.message ?? error) };
  }
}

// Recursive sorted file listing with SHA-256, following no symlinks.
export function hashTree(directory, skip = new Set()) {
  const result = {};
  const walk = (current, prefix) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (skip.has(relative)) continue;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) walk(absolute, relative);
      else if (entry.isFile()) result[relative] = sha256(fs.readFileSync(absolute));
    }
  };
  walk(directory, '');
  return result;
}

export function hashInstalledProvider(provider = INSTALLED_PROVIDER) {
  const hashes = {};
  for (const name of PROVIDER_FILES) hashes[name] = sha256(fs.readFileSync(path.join(provider, name)));
  for (const [name, hash] of Object.entries(hashTree(path.join(provider, 'dist')))) hashes[`dist/${name}`] = hash;
  return hashes;
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function emit(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}
