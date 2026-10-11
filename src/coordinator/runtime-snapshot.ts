import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { computeRuntimeIdentity, type DependencyFormat, dependencyDirectory, installedDependencies, listRuntimeFiles, RUNTIME_ASSETS, runtimeMismatch, SNAPSHOT_MARKER } from '../workflow/runtime-identity.js';
import type { RunRecord, RuntimeSnapshotSpecification } from './types.js';

/** The package this coordinator executes from: the only source a snapshot is ever copied from. */
export const sourcePackageRoot = (): string => fileURLToPath(new URL('../../', import.meta.url));

/** Run-owned, beside the managed checkout and outside the shared package's mutable dist. */
export const snapshotRoot = (run: Pick<RunRecord, 'worktreePath'>): string => path.join(path.dirname(path.resolve(run.worktreePath)), 'runtime');

/** The only loader a snapshot-pinned run may have: it imports the snapshot and refuses any other build. */
export function snapshotLoader(root: string, runtimeConfig: string, digest: string): string {
  const plugin = pathToFileURL(path.join(root, 'dist/opencode/plugin.js')).href;
  return `import { createPlugin } from ${JSON.stringify(plugin)};\nexport default createPlugin({ configPath: ${JSON.stringify(runtimeConfig)}, expectedRuntime: ${JSON.stringify(digest)} });\n`;
}

/** What a new run is admitted with: the identity of the package executing now and the dependency location it resolves through. */
export async function admitRuntime(root = sourcePackageRoot()): Promise<RuntimeSnapshotSpecification> {
  const identity = computeRuntimeIdentity(root);
  let modules: string;
  try { modules = await fs.realpath(dependencyDirectory(root)); }
  catch { throw new Error('Runtime dependencies are not installed for this package'); }
  // A package with a lockfile (a source checkout) resolves everything through one node_modules directory. Without one (an
  // installed package, which npm never ships a lockfile for) its dependencies may sit anywhere Node would find them, so each is
  // recorded where it really is; an incomplete tree is refused rather than admitted with unidentified dependencies.
  if (identity.build?.dependencies.lockfile !== null) return { identity, modules };
  const installed = installedDependencies(root);
  if (installed.missing.length) throw new Error('Runtime dependencies are not installed for this package (missing: ' + installed.missing.join(', ') + ')');
  if (installed.unidentified.length) throw new Error('Runtime dependencies cannot be identified for this package (unidentifiable: ' + installed.unidentified.join(', ') + '); each installed dependency needs a readable package.json with a version');
  return { identity, modules, links: installed.links };
}

/**
 * The dependency format a run record was admitted in. Only a lockless record without dependency links is the earlier format
 * (identified by the installed versions of its direct dependencies): every run admitted since keeps its links, and a lockfile
 * record is identified from the lockfile. The record decides; a mismatch is never retried in another format.
 */
const recordedDependencyFormat = (expected: RuntimeSnapshotSpecification): DependencyFormat =>
  !expected.links && expected.identity.build?.dependencies.lockfile === null ? 'direct-versions' : 'graph';

/** Real directories a snapshot's node_modules must link to: exactly the recorded links, scoped names under a scope directory. */
async function linkNodeModules(root: string, links: Record<string, string>): Promise<void> {
  const base = path.join(root, 'node_modules');
  await fs.mkdir(base, { mode: 0o700 });
  for (const [name, target] of Object.entries(links)) {
    if (!path.isAbsolute(target)) throw new Error('Runtime dependency link is not absolute: ' + name);
    await fs.mkdir(path.dirname(path.join(base, name)), { recursive: true, mode: 0o700 });
    await fs.symlink(target, path.join(base, name), 'dir');
  }
}

/** The symlinks present in a snapshot's node_modules by package name, or undefined when it holds anything but a plain tree of links. */
async function readNodeModules(base: string): Promise<Record<string, string> | undefined> {
  const found: Record<string, string> = {};
  for (const entry of await fs.readdir(base, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) found[entry.name] = await fs.readlink(path.join(base, entry.name));
    else if (entry.isDirectory() && entry.name.startsWith('@')) {
      for (const inner of await fs.readdir(path.join(base, entry.name), { withFileTypes: true })) {
        if (!inner.isSymbolicLink()) return undefined;
        found[entry.name + '/' + inner.name] = await fs.readlink(path.join(base, entry.name, inner.name));
      }
    } else return undefined;
  }
  return found;
}

async function writeReadOnly(file: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await fs.writeFile(file, content, { flag: 'wx', mode: 0o444 });
}

/**
 * Copy the admitted runtime beside a newly created checkout. Every file is written exclusively and read-only (an existing
 * snapshot is never reused or overwritten); directories stay removable so an owner can still discard the run. Tampering,
 * including an added or removed executable file, is caught by the identity check before every launch and resume.
 */
export async function createRuntimeSnapshot(run: RunRecord, source = sourcePackageRoot()): Promise<string> {
  const expected = run.specification.runtime;
  if (!expected) throw new Error('Run was not admitted with a runtime identity');
  const root = snapshotRoot(run);
  await fs.mkdir(root, { mode: 0o700 }); // Exclusive: throws if anything exists here.
  await writeReadOnly(path.join(root, 'package.json'), await fs.readFile(path.join(source, 'package.json')));
  try { await writeReadOnly(path.join(root, 'package-lock.json'), await fs.readFile(path.join(source, 'package-lock.json'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  for (const asset of RUNTIME_ASSETS) {
    for (const file of listRuntimeFiles(source, asset)) await writeReadOnly(path.join(root, asset.directory, file), await fs.readFile(path.join(source, asset.directory, file)));
  }
  if (expected.links) {
    await linkNodeModules(root, expected.links);
    await writeReadOnly(path.join(root, SNAPSHOT_MARKER), JSON.stringify({ version: 2, runId: run.id, identity: expected.identity, modules: expected.modules, links: expected.links }));
  } else {
    await fs.symlink(expected.modules, path.join(root, 'node_modules'), 'dir');
    await writeReadOnly(path.join(root, SNAPSHOT_MARKER), JSON.stringify({ version: 1, runId: run.id, identity: expected.identity, modules: expected.modules }));
  }
  const copied = computeRuntimeIdentity(root, recordedDependencyFormat(expected));
  const mismatch = runtimeMismatch(expected.identity, copied);
  if (mismatch) throw new Error('Runtime snapshot refused: the package changed after this run was admitted (' + mismatch + ')');
  return root;
}

/**
 * Before launch and before resume: the snapshot, its dependency location and the generated loader are exactly what the run was
 * admitted with. A run admitted without a snapshot (an earlier run) is not pinned and follows its existing path unchanged.
 */
export async function verifyRuntimeSnapshot(run: RunRecord): Promise<void> {
  const expected = run.specification.runtime;
  if (!expected) return;
  const refuse = (reason: string): never => { throw new Error('Runtime snapshot refused for run ' + run.id + ': ' + reason); };
  const root = snapshotRoot(run);
  const lstat = async (target: string) => { try { return await fs.lstat(target); } catch { return refuse(path.relative(path.dirname(root), target) + ' is missing'); } };
  const directory = await lstat(root);
  if (!directory.isDirectory() || directory.isSymbolicLink()) refuse('the snapshot is not a plain directory');
  const marker = await lstat(path.join(root, SNAPSHOT_MARKER));
  if (!marker.isFile()) refuse('the snapshot marker is not a regular file');
  let recorded: unknown;
  try { recorded = JSON.parse(await fs.readFile(path.join(root, SNAPSHOT_MARKER), 'utf8')); } catch { refuse('the snapshot marker is unreadable'); }
  if (!recorded || typeof recorded !== 'object' || (recorded as { runId?: unknown }).runId !== run.id || !isDeepStrictEqual((recorded as { identity?: unknown }).identity, expected.identity) || (recorded as { modules?: unknown }).modules !== expected.modules) refuse('the snapshot belongs to a different admitted runtime');
  const link = await lstat(path.join(root, 'node_modules'));
  if (expected.links) {
    // Linked layout: a plain node_modules directory holding exactly the recorded links and nothing else.
    const present = link.isDirectory() && !link.isSymbolicLink() ? await readNodeModules(path.join(root, 'node_modules')) : undefined;
    if ((recorded as { version?: unknown }).version !== 2 || !isDeepStrictEqual((recorded as { links?: unknown }).links, expected.links) || !present || !isDeepStrictEqual(present, expected.links)) refuse('the dependency location is not the recorded dependency links');
  } else if (!link.isSymbolicLink() || await fs.readlink(path.join(root, 'node_modules')) !== expected.modules) refuse('the dependency location is not the recorded ' + expected.modules);
  // Version-1 markers are what the earlier format wrote; a marker claiming any other version never selects it.
  const format = (recorded as { version?: unknown }).version === 1 ? recordedDependencyFormat(expected) : 'graph';
  let actual;
  try { actual = computeRuntimeIdentity(root, format); } catch (error) { return refuse('the snapshot cannot be identified (' + (error instanceof Error ? error.message : String(error)) + ')'); }
  const mismatch = runtimeMismatch(expected.identity, actual);
  if (mismatch) refuse(mismatch);
  if (!actual.build?.snapshot) refuse('the loaded copy is not a run-owned snapshot');
  const loader = path.join(path.resolve(run.worktreePath), '.opencode/plugins/heimdall.ts');
  const loaderStat = await lstat(loader);
  if (!loaderStat.isFile() || loaderStat.isSymbolicLink()) refuse('the plugin loader is not a regular file');
  const digest = expected.identity.build?.digest;
  if (!digest || await fs.readFile(loader, 'utf8') !== snapshotLoader(root, path.join(path.resolve(run.worktreePath), '.heimdall/runtime.toml'), digest)) refuse('the active plugin loader does not import the admitted snapshot');
}
