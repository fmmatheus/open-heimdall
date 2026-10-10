import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
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

/** The node_modules directory the package at `root` resolves its dependencies from. */
export function dependencyDirectory(root: string): string {
  const parent = path.dirname(root);
  if (path.basename(parent) === 'node_modules') return parent;
  if (path.basename(parent).startsWith('@') && path.basename(path.dirname(parent)) === 'node_modules') return path.dirname(parent);
  return path.join(root, 'node_modules');
}

function installedVersion(directory: string): string {
  try {
    const manifest: unknown = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'));
    return record(manifest) && typeof manifest.version === 'string' && manifest.version ? manifest.version : 'unreadable';
  } catch { return 'missing'; }
}

function dependencyIdentity(root: string, manifest: Record<string, unknown>): RuntimeBuildIdentity['dependencies'] {
  const modules = dependencyDirectory(root);
  const lockFile = path.join(root, 'package-lock.json');
  const lockfile = existsSync(lockFile) ? sha256(readFileSync(lockFile)) : null;
  const names = record(manifest.dependencies) ? Object.keys(manifest.dependencies).sort() : [];
  const direct = Object.fromEntries(names.map(name => [name, installedVersion(path.join(modules, name))]));
  let entries: string[];
  const lock: unknown = lockfile ? JSON.parse(readFileSync(lockFile, 'utf8')) : undefined;
  if (record(lock) && record(lock.packages)) {
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
 * `snapshot` records whether the root is an immutable run-owned copy; it is not part of `digest`.
 */
export function computeRuntimeIdentity(root: string): RuntimeIdentity {
  const manifest: unknown = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (!record(manifest) || typeof manifest.name !== 'string' || typeof manifest.version !== 'string') throw new Error('Runtime package manifest has no name and version');
  if (!existsSync(path.join(root, 'dist'))) throw new Error('Runtime package has no built dist');
  const hashes = Object.fromEntries(RUNTIME_ASSETS.map(asset => [asset.name, treeHash(root, asset)])) as Record<RuntimeAssetName, string>;
  const contracts = Object.fromEntries(SUBMISSION_KINDS.map(kind => [kind, contractRef(kind).version]));
  const dependencies = dependencyIdentity(root, manifest);
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
