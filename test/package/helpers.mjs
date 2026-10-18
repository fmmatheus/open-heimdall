import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { packClean } from '../../scripts/pack.mjs';

// Installed-package harness. Everything here runs against a tarball built from a clean
// copy of the working tree and installed with ordinary npm commands into temporary
// locations; nothing reads the checkout's dist/ or node_modules/.

export const checkout = fileURLToPath(new URL('../..', import.meta.url));
export const packageName = '@open-heimdall/core';
const exec = promisify(execFile);

// Flags and subcommands that would hide the packaging problem instead of solving it.
const forbiddenArguments = [/^(?:-f|--force)$/, /^--legacy-peer-deps/, /^--install-links/, /^--no-install-links/, /^--strict-peer-deps/, /^--global-style/, /^--override/, /^link$/, /^ln$/];

export async function temporaryDirectory(t, label) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `heimdall-${label}-`)));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

// A process environment that cannot see the developer's HOME, npm configuration, cache,
// Heimdall configuration or OpenChamber settings.
export async function isolatedEnvironment(root) {
  const home = path.join(root, 'home');
  const directories = {
    home,
    cache: path.join(root, 'npm-cache'),
    prefix: path.join(root, 'npm-prefix'),
    openchamber: path.join(home, 'openchamber'),
  };
  for (const directory of Object.values(directories)) await fs.mkdir(directory, { recursive: true });
  const userconfig = path.join(root, 'npmrc-user');
  const globalconfig = path.join(root, 'npmrc-global');
  await fs.writeFile(userconfig, '');
  await fs.writeFile(globalconfig, '');
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: home,
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
    LANG: process.env.LANG ?? 'C.UTF-8',
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_STATE_HOME: path.join(home, '.local', 'state'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    HEIMDALL_CONFIG: '',
    HEIMDALL_COORDINATOR_CONFIG: '',
    OPENCHAMBER_DATA_DIR: directories.openchamber,
    npm_config_cache: directories.cache,
    npm_config_prefix: directories.prefix,
    npm_config_userconfig: userconfig,
    npm_config_globalconfig: globalconfig,
    npm_config_update_notifier: 'false',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  };
  return { env, ...directories };
}

export async function toolVersions(env) {
  const { stdout } = await exec('npm', ['--version'], { env });
  return `${os.type()} ${os.release()} ${os.arch()}, Node ${process.versions.node}, npm ${stdout.trim()}`;
}

let tarballPromise;
// Builds (once per process) a tarball from a clean copy of the working tree. An existing
// tarball can be supplied through HEIMDALL_PACKAGE_TARBALL to reuse a build.
export function buildTarball() {
  tarballPromise ??= (async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-tarball-'));
    const { env } = await isolatedEnvironment(root);
    const lines = [];
    const supplied = process.env.HEIMDALL_PACKAGE_TARBALL;
    if (supplied) {
      const { stdout } = await exec('tar', ['-tzf', path.resolve(supplied)], { maxBuffer: 64 * 1024 * 1024 });
      const files = stdout.split('\n').filter(Boolean).map(entry => entry.replace(/^package\//, '')).sort();
      return { tarball: path.resolve(supplied), files, lines: [`using supplied tarball ${supplied}`], root };
    }
    const result = await packClean({ out: path.join(root, 'out'), env, log: line => lines.push(line) });
    return { tarball: result.tarball, files: result.files, lines, root };
  })();
  return tarballPromise;
}

export async function removeTarballBuild() {
  if (!tarballPromise) return;
  const { root } = await tarballPromise;
  await fs.rm(root, { recursive: true, force: true });
}

export function assertOrdinaryInstall(argv) {
  for (const argument of argv) {
    for (const pattern of forbiddenArguments) assert.doesNotMatch(argument, pattern, `forbidden installation argument ${argument}`);
  }
}

async function npm(argv, { cwd, env }) {
  assertOrdinaryInstall(argv);
  try {
    const { stdout, stderr } = await exec('npm', argv, { cwd, env, maxBuffer: 64 * 1024 * 1024 });
    return { argv, stdout, stderr };
  } catch (error) {
    throw new Error(`npm ${argv.join(' ')} failed (exit ${error.code}):\n${error.stdout ?? ''}\n${error.stderr ?? ''}`);
  }
}

// Ordinary dependency installation of the tarball into a fresh consumer project.
export async function installConsumer(tarball, { env, directory }) {
  await fs.mkdir(directory, { recursive: true });
  const manifest = { name: 'heimdall-consumer', version: '1.0.0', private: true };
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify(manifest, null, 2));
  const { argv } = await npm(['install', tarball], { cwd: directory, env });
  const modules = path.join(directory, 'node_modules');
  return {
    layout: 'consumer',
    argv,
    directory,
    modules,
    root: path.join(modules, ...packageName.split('/')),
    bin: path.join(modules, '.bin', 'heimdall'),
    initialManifest: manifest,
  };
}

// Ordinary global installation into a temporary user-writable prefix.
export async function installGlobal(tarball, { env, prefix, cwd }) {
  await fs.mkdir(prefix, { recursive: true });
  const { argv } = await npm(['install', '--global', '--prefix', prefix, tarball], { cwd, env });
  const modules = path.join(prefix, 'lib', 'node_modules');
  return {
    layout: 'global',
    argv,
    directory: prefix,
    modules,
    root: path.join(modules, ...packageName.split('/')),
    bin: path.join(prefix, 'bin', 'heimdall'),
  };
}

// Runs `npm ls --all` and reports its exit status instead of throwing, so that the caller decides what
// a nonzero status or a problem line means.
export async function listTree(install, { env, cwd }) {
  const argv = install.layout === 'global' ? ['ls', '--global', '--prefix', install.directory, '--all'] : ['ls', '--all'];
  assertOrdinaryInstall(argv);
  const result = await runProcess('npm', argv, { cwd: install.layout === 'global' ? cwd : install.directory, env });
  return { argv, ...result };
}

export function runProcess(file, args, { cwd, env, input } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
    child.stdin.end(input ?? '');
  });
}

export const runBinary = (install, args, options) => runProcess(install.bin, args, options);
export const runModule = (code, options) => runProcess(process.execPath, ['--input-type=module', '--eval', code], options);

// Every package installed below a node_modules tree, with its manifest.
export async function listPackages(modules) {
  const found = [];
  const visit = async directory => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const location = path.join(directory, entry.name);
      if (entry.name.startsWith('@')) { await visit(location); continue; }
      const manifest = await fs.readFile(path.join(location, 'package.json'), 'utf8').then(JSON.parse, () => undefined);
      if (!manifest) continue;
      found.push({ name: manifest.name, location, version: manifest.version, manifest });
      await visit(path.join(location, 'node_modules'));
    }
  };
  await visit(modules);
  return found;
}

// Finds every installed copy of a package below a node_modules tree.
export async function findPackages(modules, name) {
  return (await listPackages(modules)).filter(entry => entry.name === name).map(({ location, version }) => ({ location, version }));
}

export const supportedPluginVersion = '2.0.32';
export const quotaPackageName = '@slkiser/opencode-quota';

// The dependency graph the package is published against (the checkout's lockfile). It supplies which
// packages are declared optional dependencies of which, so the tree check can tell an optional native
// package left behind by a failed optional install from an arbitrary stray package.
export async function readDependencyLock() {
  return JSON.parse(await fs.readFile(path.join(checkout, 'package-lock.json'), 'utf8'));
}

const exactVersion = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

// Whether a version satisfies an exact, caret or tilde range. Any other range syntax, a prerelease under a
// non-exact range and a malformed version or range all answer false, so unrecognised evidence grants nothing.
function satisfies(version, range) {
  if (typeof version !== 'string' || typeof range !== 'string' || !exactVersion.test(version)) return false;
  const operator = /^[\^~]/.exec(range)?.[0] ?? '';
  const base = range.slice(operator.length);
  if (!exactVersion.test(base)) return false;
  if (operator === '') return version === base;
  if (version.includes('-')) return false;
  const [major, minor, patch] = version.split(/[-+]/)[0].split('.').map(Number);
  const [lowMajor, lowMinor, lowPatch] = base.split(/[-+]/)[0].split('.').map(Number);
  if (base.includes('-')) return false;
  const atLeast = major !== lowMajor ? major > lowMajor : minor !== lowMinor ? minor > lowMinor : patch >= lowPatch;
  if (!atLeast) return false;
  if (operator === '~') return major === lowMajor && minor === lowMinor;
  if (lowMajor > 0) return major === lowMajor;
  if (lowMinor > 0) return major === 0 && minor === lowMinor;
  return major === 0 && minor === 0 && patch === lowPatch;
}

// The lockfile path of an installed package. The lockfile describes the package's own install tree, so a copy
// below the installed package (global layout) and a hoisted copy beside it (consumer layout) both map to
// `node_modules/<name>` records.
function lockLocation(modules, location) {
  const relative = path.relative(modules, location).split(path.sep).join('/');
  if (relative === '' || relative.startsWith('..')) return undefined;
  const full = `node_modules/${relative}`;
  const prefix = 'node_modules/@open-heimdall/core/node_modules/';
  return full.startsWith(prefix) ? `node_modules/${full.slice(prefix.length)}` : full;
}

// The package names along a lockfile path: `node_modules/a/node_modules/@s/b` is ['a', '@s/b'].
const lockPathNames = location => location.split('node_modules/').slice(1).map(segment => segment.replace(/\/$/, ''));
const packageNameInLockPath = location => lockPathNames(location).at(-1);

// The lockfile record Node's lookup finds for `name` when required from the package at `location`: the nearest
// `node_modules/<name>` in the package's own tree, then in each enclosing tree.
function lookupInLock(lock, location, name) {
  const names = lockPathNames(location);
  for (let depth = names.length; depth >= 0; depth -= 1) {
    const candidate = `${names.slice(0, depth).map(segment => `node_modules/${segment}/`).join('')}node_modules/${name}`;
    if (lock.packages?.[candidate] !== undefined) return candidate;
  }
  return undefined;
}

const recordsNamed = (lock, name) => Object.entries(lock.packages ?? {})
  .filter(([location]) => location.includes('node_modules/') && packageNameInLockPath(location) === name);

// Several lockfile records for one name must agree on what they describe; otherwise the evidence is ambiguous.
function agreeing(records) {
  return records.length > 0 && records.every(([, entry]) => entry.version === records[0][1].version
    && (entry.optional === true) === (records[0][1].optional === true));
}

const matchesHost = (systems, architectures) => Array.isArray(systems) && systems.includes(process.platform)
  && Array.isArray(architectures) && architectures.includes(process.arch);

// npm 10 does not drop an optional package's own optional dependencies when the package's install script fails
// and npm removes it (arborist `optional-set.js`: only non-optional edges were followed; fixed in npm 11.6.2,
// npm/cli#8537). For msgpackr-extract that leaves its platform package installed without its parent, and `npm ls`
// reports it `extraneous`. The leftover is accepted only when every condition below holds, resolving each
// lockfile record by installed location (the lookup chain npm uses) and never by bare package name:
//  - the leftover is installed at a location the lockfile has a record for, its directory name equals its
//    manifest name, and its manifest version is a valid version equal to that record's version,
//  - that record is optional and restricts os and cpu to this host, as does the leftover's own manifest,
//  - exactly one lockfile record for an optional parent resolves the leftover's name to that record and lists the
//    leftover in `optionalDependencies` with a range the installed version satisfies,
//  - that parent is not installed anywhere, and an installed package whose lookup finds the same parent record
//    declares it in `optionalDependencies` with a range the locked parent version satisfies,
//  - lockfile records sharing the leftover's name, or the parent's, agree on version and optionality.
// Missing, malformed, incompatible or ambiguous evidence grants nothing; anything else npm reports stays a problem.
export async function leftoverOptionalPackages({ modules, packages, lock }) {
  const leftovers = new Set();
  const installedNames = new Set(packages.map(entry => entry.name));
  const locations = new Map(packages.map(entry => [entry, lockLocation(modules, entry.location)]));
  for (const entry of packages) {
    const location = locations.get(entry);
    const record = location === undefined ? undefined : lock.packages?.[location];
    const name = location === undefined ? undefined : packageNameInLockPath(location);
    if (!record || name === undefined || entry.name !== name) continue;
    if (typeof entry.version !== 'string' || !exactVersion.test(entry.version) || record.version !== entry.version) continue;
    if (record.optional !== true || !matchesHost(record.os, record.cpu)) continue;
    if (!matchesHost(entry.manifest.os, entry.manifest.cpu)) continue;
    if (!agreeing(recordsNamed(lock, name))) continue;
    const parents = Object.entries(lock.packages ?? {}).filter(([parentLocation, parent]) => parentLocation.includes('node_modules/')
      && parent.optional === true && parent.optionalDependencies?.[name] !== undefined
      && lookupInLock(lock, parentLocation, name) === location);
    if (parents.length !== 1) continue;
    const [parentLocation, parent] = parents[0];
    const parentName = packageNameInLockPath(parentLocation);
    if (!satisfies(entry.version, parent.optionalDependencies[name])) continue;
    if (!agreeing(recordsNamed(lock, parentName)) || typeof parent.version !== 'string' || !exactVersion.test(parent.version)) continue;
    if (installedNames.has(parentName)) continue;
    const declared = packages.some(owner => {
      const ownerLocation = locations.get(owner);
      return ownerLocation !== undefined && lookupInLock(lock, ownerLocation, parentName) === parentLocation
        && satisfies(parent.version, owner.manifest.optionalDependencies?.[parentName]);
    });
    if (declared) leftovers.add(`${entry.name}@${entry.version}`);
  }
  return leftovers;
}

// The installed-tree rules: `npm ls --all` exits zero with no invalid, missing or extraneous package, exactly
// one supported @opencode/plugin version is installed, and no runtime dependency on the quota package exists.
// Returns the list of violations (empty when the tree is acceptable).
export async function verifyDependencyTree({ modules, listing, lock }) {
  const problems = [];
  if (listing.status !== 0) problems.push(`npm ls --all exited ${listing.status}`);
  const packages = await listPackages(modules);
  const plugins = packages.filter(entry => entry.name === '@opencode/plugin');
  if (plugins.length === 0) problems.push('@opencode/plugin is not installed');
  for (const plugin of plugins) {
    if (plugin.version !== supportedPluginVersion) problems.push(`unsupported @opencode/plugin ${plugin.version} at ${plugin.location}`);
  }
  for (const entry of packages.filter(candidate => candidate.name === quotaPackageName)) {
    problems.push(`${quotaPackageName} is installed at ${entry.location}`);
  }
  const leftovers = await leftoverOptionalPackages({ modules, packages, lock });
  for (const line of listing.stdout.split('\n')) {
    if (!/\binvalid\b|extraneous|UNMET DEPENDENCY/.test(line)) continue;
    const leftover = /(\S+@\S+) extraneous\s*$/.exec(line);
    if (leftover && leftovers.has(leftover[1])) continue;
    problems.push(`npm ls --all reports: ${line.trim()}`);
  }
  return problems;
}
