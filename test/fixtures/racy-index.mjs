// A deterministic "racily clean" Git index, built without sleeps or retries.
//
// Git trusts an index entry's cached stat data only when the entry is strictly older than the index file itself. When an
// entry's cached mtime is not older than the index file's mtime, a same-size edit made within the same timestamp second could
// have escaped the stat comparison, so Git compares content instead. A copy of the index with a newer mtime silently turns
// that safeguard off. This fixture produces exactly that situation: the index file and the tracked files' recorded mtimes
// share one integer second in the past, the file is then rewritten with different bytes of the same size, and its mtime is
// restored. The fixture repository uses `core.checkStat=minimal` and `core.trustctime=false` so that only mtime seconds,
// size and mode are compared and no rewrite-induced ctime, nanosecond or inode change can reveal the edit on any platform.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const environment = () => {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };
  for (const key of Object.keys(env)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|CONFIG.*)$/.test(key)) delete env[key];
  return env;
};

/** Runs git and returns trimmed stdout; `extra` is merged into the environment. */
export const gitOutput = (cwd, args, extra = {}) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...environment(), ...extra } }).trim();

/** Exit status of `git diff-files --quiet` for one path: 0 means Git considers it clean, 1 means modified. */
export function diffFilesStatus(cwd, relative, extra = {}) {
  try {
    execFileSync('git', ['diff-files', '--quiet', '--', relative], { cwd, stdio: 'ignore', env: { ...environment(), ...extra } });
    return 0;
  } catch (error) {
    if (error.status === 1) return 1;
    throw error;
  }
}

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Bytes and nanosecond mtime of the index file, to prove that a measurement never touched it. */
export async function indexSnapshot(directory) {
  const file = path.join(directory, '.git', 'index');
  const [bytes, stat] = await Promise.all([fs.readFile(file), fs.stat(file, { bigint: true })]);
  return { bytes: sha256(bytes), mtimeNs: stat.mtimeNs };
}

/** Cached size and mtime seconds of one entry, as recorded in the given index (`git ls-files --debug`). */
export function cachedStat(directory, relative, extra = {}) {
  const output = gitOutput(directory, ['ls-files', '--debug', '--', relative], extra);
  const mtime = /^\s+mtime: (\d+):(\d+)$/m.exec(output);
  const size = /^\s+size: (\d+)/m.exec(output);
  assert.ok(mtime && size, 'git ls-files --debug output is parseable');
  return { mtimeSeconds: Number(mtime[1]), size: Number(size[1]) };
}

/**
 * Creates a disposable repository whose tracked files and index file all carry the same integer mtime second `seconds`
 * (an hour in the past), with the index recording that mtime for every entry.
 *
 * @param {string} parent directory that will contain the repository
 * @param {Record<string, string | Buffer>} files tracked files committed as the base
 */
export async function createRacyRepository(parent, files) {
  const directory = await fs.mkdtemp(path.join(parent, 'racy-'));
  const seconds = Math.floor(Date.now() / 1000) - 3600;
  const git = (...args) => gitOutput(directory, args);
  git('init', '-b', 'main');
  git('config', 'core.checkStat', 'minimal');
  git('config', 'core.trustctime', 'false');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  const file = relative => path.join(directory, ...relative.split('/'));
  const setTimes = (target, atMs = seconds) => fs.utimes(target, atMs, atMs);

  const api = {
    directory,
    seconds,
    indexPath: path.join(directory, '.git', 'index'),
    file,
    git,
    /** Writes bytes and restores the file's mtime to the shared second, so the new bytes look untouched to a stat check. */
    async write(relative, bytes) {
      await fs.writeFile(file(relative), bytes);
      await setTimes(file(relative));
    },
    /** Dates the index file itself to the shared second: every entry recorded at that second is now racily clean. */
    async ageIndex() { await setTimes(api.indexPath); },
    /** Stages bytes (recording the shared mtime) and re-ages the index. */
    async stage(relative, bytes) {
      await api.write(relative, bytes);
      git('add', '--', relative);
      await api.ageIndex();
    },
    /** Preconditions that make the defect reproducible; each is an assertion, never a retry. */
    async assertRacy(relative, { expectedBlob } = {}) {
      const stat = await fs.stat(file(relative));
      const worktree = gitOutput(directory, ['hash-object', '--', relative]);
      const indexed = gitOutput(directory, ['ls-files', '-s', '--', relative]).split(/\s+/)[1];
      assert.notEqual(worktree, indexed, `${relative}: worktree bytes differ from the indexed blob`);
      if (expectedBlob) assert.equal(indexed, expectedBlob, `${relative}: the index still holds the staged blob`);
      const cached = cachedStat(directory, relative);
      assert.equal(cached.size, stat.size, `${relative}: cached size equals the file size`);
      assert.equal(cached.mtimeSeconds, Math.floor(stat.mtimeMs / 1000), `${relative}: cached mtime second equals the file mtime second`);
      const indexStat = await fs.stat(api.indexPath);
      assert.ok(Math.floor(indexStat.mtimeMs / 1000) <= cached.mtimeSeconds, 'the index is not newer than the cached mtime second, so Git must compare content');

      const before = await indexSnapshot(directory);
      assert.equal(diffFilesStatus(directory, relative), 1, `${relative}: the original index reports the file modified`);
      const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'racy-copy-'));
      try {
        const copy = path.join(scratch, 'index');
        await fs.copyFile(api.indexPath, copy);
        assert.ok(Math.floor((await fs.stat(copy)).mtimeMs / 1000) > cached.mtimeSeconds, 'a plain copy of the index is newer than the cached mtime second');
        assert.equal(diffFilesStatus(directory, relative, { GIT_INDEX_FILE: copy }), 0, `${relative}: a freshly dated copy of the index reports the file clean`);
      } finally { await fs.rm(scratch, { recursive: true, force: true }); }
      assert.deepEqual(await indexSnapshot(directory), before, 'the controls leave the source index bytes and mtime untouched');
    },
  };

  for (const [relative, bytes] of Object.entries(files)) {
    await fs.mkdir(path.dirname(file(relative)), { recursive: true });
    await api.write(relative, bytes);
  }
  git('add', '--', '.');
  git('commit', '-m', 'base');
  await api.ageIndex();
  return api;
}
