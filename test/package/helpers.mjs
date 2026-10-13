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

export const supportedPluginVersion = '2.0.22';
export const quotaPackageName = '@slkiser/opencode-quota';

// The dependency graph the package is published against (the checkout's lockfile). It supplies which
// packages are declared optional dependencies of which, so the tree check can tell an optional native
// package left behind by a failed optional install from an arbitrary stray package.
export async function readDependencyLock() {
  return JSON.parse(await fs.readFile(path.join(checkout, 'package-lock.json'), 'utf8'));
}

function lockedOptionalChildren(lock) {
  const byName = new Map();
  for (const [location, entry] of Object.entries(lock.packages ?? {})) {
    if (!location.includes('node_modules/')) continue;
    byName.set(location.slice(location.lastIndexOf('node_modules/') + 'node_modules/'.length), entry);
  }
  const parents = new Map();
  for (const [name, entry] of byName) {
    if (entry.optional !== true) continue;
    for (const child of Object.keys(entry.optionalDependencies ?? {})) {
      if (byName.get(child)?.optional === true) parents.set(child, [...(parents.get(child) ?? []), name]);
    }
  }
  return parents;
}

// npm 10 does not drop an optional package's own optional dependencies when the package's install script fails
// and npm removes it (arborist `optional-set.js`: only non-optional edges were followed; fixed in npm 11.6.2,
// npm/cli#8537). For msgpackr-extract that leaves its platform package installed without its parent, and `npm ls`
// reports it `extraneous`. The leftover is accepted only when every condition below holds:
//  - the lockfile declares it as an optional dependency of a package that is itself optional,
//  - that optional parent is an optional dependency of an installed package and is not installed,
//  - the leftover's own manifest restricts os and cpu and matches this host.
// Anything else npm reports stays a problem.
export async function leftoverOptionalPackages({ packages, lock }) {
  const parents = lockedOptionalChildren(lock);
  const installedNames = new Set(packages.map(entry => entry.name));
  const leftovers = new Set();
  for (const entry of packages) {
    const optionalParents = parents.get(entry.name);
    if (!optionalParents) continue;
    const { os: systems, cpu: architectures } = entry.manifest;
    if (!Array.isArray(systems) || !systems.includes(process.platform)) continue;
    if (!Array.isArray(architectures) || !architectures.includes(process.arch)) continue;
    const orphaned = optionalParents.some(parent => !installedNames.has(parent)
      && packages.some(owner => owner.manifest.optionalDependencies?.[parent] !== undefined));
    if (orphaned) leftovers.add(`${entry.name}@${entry.version}`);
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
  const leftovers = await leftoverOptionalPackages({ packages, lock });
  for (const line of listing.stdout.split('\n')) {
    if (!/\binvalid\b|extraneous|UNMET DEPENDENCY/.test(line)) continue;
    const leftover = /(\S+@\S+) extraneous\s*$/.exec(line);
    if (leftover && leftovers.has(leftover[1])) continue;
    problems.push(`npm ls --all reports: ${line.trim()}`);
  }
  return problems;
}
