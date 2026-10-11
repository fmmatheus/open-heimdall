import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUBMISSION_KINDS, SUBMISSION_PROTOCOL, contractRef } from './contracts.js';
import type { RuntimeBuildIdentity, RuntimeIdentity } from './types.js';

/** File written at the root of an immutable runtime snapshot. It is outside every hashed tree. */
export const SNAPSHOT_MARKER = '.heimdall-runtime-snapshot.json';

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Package files that decide the executing code and response contract. Declarations and source maps do not execute. */
export const RUNTIME_ASSETS = [
  { name: 'dist', directory: 'dist', include: (file: string) => /\.(?:js|mjs|json)$/.test(file) },
  { name: 'prompts', directory: 'prompts', include: (file: string) => file.endsWith('.md') },
  { name: 'agents', directory: 'examples/opencode/agents', include: (file: string) => file.endsWith('.md') },
] as const;
export type RuntimeAssetName = typeof RUNTIME_ASSETS[number]['name'];

/** Regular files below `directory`, as posix paths relative to it, sorted. Symlinks are never followed. */
export function listRuntimeFiles(root: string, asset: typeof RUNTIME_ASSETS[number]): string[] {
  const base = path.join(root, asset.directory);
  const files: string[] = [];
  const walk = (relative: string) => {
    for (const entry of readdirSync(path.join(base, relative), { withFileTypes: true })) {
      const next = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) walk(next);
      else if (entry.isSymbolicLink()) throw new Error('Runtime asset tree contains a symbolic link: ' + asset.directory + '/' + next);
      else if (entry.isFile() && asset.include(entry.name)) files.push(next);
    }
  };
  if (existsSync(base)) walk('');
  return files.sort();
}

function treeHash(root: string, asset: typeof RUNTIME_ASSETS[number]): string {
  const hash = createHash('sha256');
  for (const file of listRuntimeFiles(root, asset)) hash.update(file + '\0' + sha256(readFileSync(path.join(root, asset.directory, file))) + '\n');
  return hash.digest('hex');
}

const isDirectory = (target: string) => { try { return statSync(target).isDirectory(); } catch { return false; } };

/**
 * The main node_modules directory the package at `root` resolves its dependencies from: its own when it has one (a source
 * checkout, or a global install, where npm nests the dependencies inside the package), otherwise the one it is installed into
 * (a consumer install, where npm hoists them beside the package).
 */
export function dependencyDirectory(root: string): string {
  const own = path.join(root, 'node_modules');
  if (isDirectory(own)) return own;
  const parent = path.dirname(root);
  if (path.basename(parent) === 'node_modules') return parent;
  if (path.basename(parent).startsWith('@') && path.basename(path.dirname(parent)) === 'node_modules') return path.dirname(parent);
  return own;
}

/** The version a package.json identifies the package at `directory` with, or why it identifies none. */
function packageVersion(directory: string): { version: string } | { placeholder: 'missing' | 'unreadable' } {
  try {
    const manifest: unknown = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    return record(manifest) && typeof manifest.version === 'string' && manifest.version ? { version: manifest.version } : { placeholder: 'unreadable' };
  } catch { return { placeholder: 'missing' }; }
}

function installedVersion(directory: string): string {
  const found = packageVersion(directory);
  return 'version' in found ? found.version : found.placeholder;
}

/** The installed package a dependency named `name` of the package at `from` resolves to, by Node's node_modules lookup. */
function resolveInstalled(from: string, name: string): string | undefined {
  for (let directory = from; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate);
    if (path.dirname(directory) === directory) return undefined;
  }
}

const stringKeys = (value: unknown): string[] => record(value) ? Object.keys(value) : [];

/** Dependencies a package loads: required, optional, and peers that happen to be installed. */
function declaredDependencies(manifest: unknown): { name: string; kind: 'required' | 'optional' | 'peer' }[] {
  if (!record(manifest)) return [];
  const seen = new Set<string>();
  const out: { name: string; kind: 'required' | 'optional' | 'peer' }[] = [];
  for (const [field, kind] of [['dependencies', 'required'], ['optionalDependencies', 'optional'], ['peerDependencies', 'peer']] as const) {
    for (const name of stringKeys(manifest[field]).sort()) if (!seen.has(name)) { seen.add(name); out.push({ name, kind }); }
  }
  return out;
}

function readManifest(directory: string): unknown {
  try { return JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8')); } catch { return undefined; }
}

/** The installed runtime dependency tree of a package, resolved the way Node resolves it, whatever the layout. */
export interface InstalledDependencies {
  /** Real directory of every dependency the package itself resolves (what a snapshot must be able to import), by name. */
  links: Record<string, string>;
  /** Layout-independent description of every reachable installed package: name, version and what each dependency resolved to. */
  entries: string[];
  /** Required dependencies (of the package or any reachable one) that are not installed. */
  missing: string[];
  /**
   * Installed dependencies (of the package or any reachable one) whose package.json does not identify them: unparsable, not an
   * object, or without a non-empty string version. Only the dependency path is reported, never what the file contains.
   */
  unidentified: string[];
}

/**
 * Walk the dependency graph from the package at `root` using the installed `package.json` files. Hoisted copies, copies nested in
 * any package's own node_modules and the global layout all resolve identically to how Node would resolve them. Nothing here
 * depends on a lockfile or on where a package sits, so the same tree has the same description before and after being copied
 * into a snapshot whose node_modules links to the same real directories.
 */
export function installedDependencies(root: string): InstalledDependencies {
  const links: Record<string, string> = {};
  const entries: string[] = [];
  const missing: string[] = [];
  const unidentified: string[] = [];
  const visited = new Set<string>();
  const describe = (directory: string, label: string, isRoot: boolean): void => {
    const edges: string[] = [];
    for (const { name, kind } of declaredDependencies(readManifest(directory))) {
      const found = resolveInstalled(directory, name);
      if (!found) {
        if (kind === 'peer') continue;
        if (kind === 'required') missing.push(label + ' > ' + name);
        edges.push(name + '@' + (kind === 'optional' ? 'optional-absent' : 'missing'));
        continue;
      }
      if (isRoot) links[name] = found;
      // Only a dependency that is absent is excused when it is optional or a peer. One that is installed is on Node's resolution
      // path and can be loaded whatever it was declared as, so it must identify itself or the tree cannot be pinned.
      const identity = packageVersion(found);
      if (!('version' in identity)) unidentified.push(label + ' > ' + name);
      edges.push(name + '@' + ('version' in identity ? identity.version : identity.placeholder));
      if (!visited.has(found)) {
        visited.add(found);
        const manifest = readManifest(found);
        // The name a manifest claims is only trusted for a package that identifies itself; diagnostics never echo anything else.
        describe(found, 'version' in identity && record(manifest) && typeof manifest.name === 'string' ? manifest.name : name, false);
      }
    }
    entries.push((isRoot ? '(package)' : label + '@' + installedVersion(directory)) + '[' + edges.join(',') + ']');
  };
  describe(root, '(package)', true);
  return { links, entries: entries.sort(), missing: missing.sort(), unidentified: unidentified.sort() };
}

/**
 * How a package without a lockfile is identified. `graph` describes the whole installed dependency tree and is what every new
 * run is admitted with. `direct-versions` is the earlier format, which recorded only the installed versions of the direct
 * dependencies under the package's dependency directory; version-1 snapshots admitted before installed-package support are
 * verified in it. A package with a lockfile is identified from the lockfile whatever the format.
 */
export type DependencyFormat = 'graph' | 'direct-versions';

function dependencyIdentity(root: string, manifest: Record<string, unknown>, format: DependencyFormat): RuntimeBuildIdentity['dependencies'] {
  const modules = dependencyDirectory(root);
  const lockFile = path.join(root, 'package-lock.json');
  const lockfile = existsSync(lockFile) ? sha256(readFileSync(lockFile)) : null;
  const names = record(manifest.dependencies) ? Object.keys(manifest.dependencies).sort() : [];
  const installedDirectly = lockfile !== null || format === 'direct-versions';
  let lockless: InstalledDependencies | undefined;
  const direct = Object.fromEntries(names.map(name => {
    if (installedDirectly) return [name, installedVersion(path.join(modules, name))];
    // Without a lockfile (an installed package: npm never packs one) the installed tree itself is the lock data.
    lockless ??= installedDependencies(root);
    const found = lockless.links[name];
    return [name, found ? installedVersion(found) : 'missing'];
  }));
  let entries: string[];
  const lock: unknown = lockfile ? JSON.parse(readFileSync(lockFile, 'utf8')) : undefined;
  if (!lockfile && format === 'graph') entries = (lockless ?? installedDependencies(root)).entries;
  else if (record(lock) && record(lock.packages)) {
    // Every locked runtime package, resolved against the dependency directory actually in use.
    entries = Object.entries(lock.packages)
      .filter(([key, value]) => key.startsWith('node_modules/') && record(value) && value.dev !== true)
      .map(([key, value]) => {
        const relative = key.slice('node_modules/'.length);
        const version = installedVersion(path.join(modules, relative));
        return relative + '@' + (version === 'missing' && record(value) && value.optional === true ? 'optional-absent' : version);
      });
  } else entries = Object.entries(direct).map(([name, version]) => name + '@' + version);
  return { lockfile, direct, resolved: sha256(entries.sort().join('\n')) };
}

/**
 * Identity of the package rooted at `root`: what is actually executing, computed from file content and never from Git.
 * `snapshot` records whether the root is an immutable run-owned copy; it is not part of `digest`. `dependencyFormat` is chosen
 * from the format a run was recorded in, never by retrying after a mismatch.
 */
export function computeRuntimeIdentity(root: string, dependencyFormat: DependencyFormat = 'graph'): RuntimeIdentity {
  const manifest: unknown = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!record(manifest) || typeof manifest.name !== 'string' || typeof manifest.version !== 'string') throw new Error('Runtime package manifest has no name and version');
  if (!existsSync(path.join(root, 'dist'))) throw new Error('Runtime package has no built dist');
  const hashes = Object.fromEntries(RUNTIME_ASSETS.map(asset => [asset.name, treeHash(root, asset)])) as Record<RuntimeAssetName, string>;
  const contracts = Object.fromEntries(SUBMISSION_KINDS.map(kind => [kind, contractRef(kind).version]));
  const dependencies = dependencyIdentity(root, manifest, dependencyFormat);
  const basis = { packageName: manifest.name, packageVersion: manifest.version, protocol: SUBMISSION_PROTOCOL, contracts, ...hashes, dependencies };
  let snapshot = false;
  try { snapshot = lstatSync(path.join(root, SNAPSHOT_MARKER)).isFile(); } catch {}
  const build: RuntimeBuildIdentity = { packageName: manifest.name, contracts, ...hashes, dependencies, digest: sha256(JSON.stringify(basis)), snapshot };
  return { packageVersion: manifest.version, protocol: SUBMISSION_PROTOCOL, build };
}

/** The reason `actual` is not the runtime `expected` describes, or undefined when they match. `snapshot` is ignored. */
export function runtimeMismatch(expected: RuntimeIdentity, actual: RuntimeIdentity): string | undefined {
  const want = expected.build, have = actual.build;
  if (!want || !have) return 'Runtime build identity is unavailable';
  if (expected.packageVersion !== actual.packageVersion || want.packageName !== have.packageName) return 'Runtime package changed from ' + want.packageName + '@' + expected.packageVersion + ' to ' + have.packageName + '@' + actual.packageVersion;
  if (expected.protocol !== actual.protocol || JSON.stringify(want.contracts) !== JSON.stringify(have.contracts)) return 'Runtime protocol or contract versions changed';
  if (want.dist !== have.dist) return 'Runtime build (dist) content changed';
  if (want.prompts !== have.prompts) return 'Runtime prompt content changed';
  if (want.agents !== have.agents) return 'Runtime agent file content changed';
  if (want.dependencies.lockfile !== have.dependencies.lockfile) return 'Runtime dependency lockfile changed';
  if (want.dependencies.resolved !== have.dependencies.resolved || JSON.stringify(want.dependencies.direct) !== JSON.stringify(have.dependencies.direct)) return 'Runtime dependency identity changed (installed versions differ from the admitted run)';
  if (want.digest !== have.digest) return 'Runtime identity digest changed';
  return undefined;
}

const unavailable = (): RuntimeIdentity => ({ packageVersion: 'unknown', protocol: SUBMISSION_PROTOCOL });
const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
let loaded: RuntimeIdentity;
try { loaded = computeRuntimeIdentity(packageRoot); } catch { loaded = unavailable(); }

/** Identity of the code that is executing, fixed when this module loaded from its own package location. */
export function runtimeIdentity(): RuntimeIdentity {
  return structuredClone(loaded);
}
