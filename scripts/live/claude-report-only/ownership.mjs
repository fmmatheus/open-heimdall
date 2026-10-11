// Ownership-based cleanup for the live verification harness.
//
// Rule: an object may be removed only when this run created it exclusively and recorded it in a persisted
// ownership ledger (path, type, dev/ino/birthtimeNs, parent realpath, creating operation). Observing that a path exists
// is never ownership. Cleanup re-checks identity with lstat immediately before removing, removes files with
// unlink and directories with a non-recursive rmdir, and preserves (and reports as a failure) anything that
// was replaced, symlinked or filled by someone else. Nothing here ever calls a recursive remove.
//
// The ledger is an append-only JSON-lines file so that the outer process and the sandboxed inner probe can
// both extend it, and so that a crash leaves a readable record.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const newNonce = () => crypto.randomBytes(6).toString('hex');

const appendLine = (file, value) => {
  const fd = fs.openSync(file, 'a', 0o600);
  try { fs.writeSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};

const typeOf = stat => (stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other');
// Nanoseconds are persisted as strings: JSON cannot serialize BigInts and Numbers lose precision.
// An unavailable birthtime is never inferred from the current path. Some filesystems report ctime
// as birthtime; later metadata changes then conservatively preserve our object instead of deleting it.
const statIdentity = stat => ({ dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: typeof stat.birthtimeNs === 'bigint' && stat.birthtimeNs > 0n ? String(stat.birthtimeNs) : null });
const validIdentity = value => value && ['dev', 'ino'].every(key => typeof value[key] === 'string' && /^\d+$/.test(value[key])) && typeof value.birthtimeNs === 'string' && /^[1-9]\d*$/.test(value.birthtimeNs);
const matchesIdentity = (stat, expected) => {
  const actual = statIdentity(stat);
  return validIdentity(actual) && validIdentity(expected) && actual.dev === expected.dev && actual.ino === expected.ino && actual.birthtimeNs === expected.birthtimeNs;
};

export function openLedger(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const identity = (target, stat) => ({ path: target, type: typeOf(stat), ...statIdentity(stat), parent: fs.realpathSync(path.dirname(target)) });
  return {
    file,
    intent: (target, op) => appendLine(file, { event: 'intent', path: target, op, at: new Date().toISOString() }),
    owned: (target, stat, op) => appendLine(file, { event: 'owned', ...identity(target, stat), op, at: new Date().toISOString() }),
  };
}

// Used by the sandboxed inner probe: record an object a guarded operation created (the guard failed, so this is
// the only way it can be cleaned up). `expectIdentity` (dev/ino/birthtimeNs of a file we already own) is required for a
// rename, which may overwrite a foreign destination; link/create/mkdir fail with EEXIST on an existing path,
// so their success proves exclusive creation.
export function recordCreated(ledgerFile, target, op, expectIdentity = null) {
  const stat = fs.lstatSync(target, { bigint: true });
  if (op === 'rename' && !validIdentity(expectIdentity)) return false;
  if (expectIdentity && !matchesIdentity(stat, expectIdentity)) return false;
  if (!validIdentity(statIdentity(stat))) return false;
  openLedger(ledgerFile).owned(target, stat, op);
  return true;
}

// Exclusive file creation (wx). Ownership is written as soon as the descriptor exists.
export function createExclusiveFile(ledger, target, content, { mode = 0o600, op = 'create-file' } = {}) {
  ledger.intent(target, op);
  const fd = fs.openSync(target, 'wx', mode);
  let stat;
  try {
    stat = fs.fstatSync(fd, { bigint: true });
    ledger.owned(target, stat, op);
    if (content !== undefined) fs.writeSync(fd, content);
  } catch (error) {
    // We hold the descriptor of the file we just created: remove it only if the path still names it.
    try { const now = fs.lstatSync(target, { bigint: true }); if (stat && matchesIdentity(now, statIdentity(stat)) && now.isFile()) fs.unlinkSync(target); } catch { /* reported by the original error */ }
    throw error;
  } finally {
    fs.closeSync(fd);
  }
  return { path: target, ...statIdentity(stat), type: 'file' };
}

// Exclusive, non-recursive directory creation.
export function createExclusiveDirectory(ledger, target, { mode = 0o700, op = 'mkdir' } = {}) {
  ledger.intent(target, op);
  fs.mkdirSync(target, { mode });
  const stat = fs.lstatSync(target, { bigint: true });
  ledger.owned(target, stat, op);
  return { path: target, ...statIdentity(stat), type: 'directory' };
}

export function readLedger(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line, index) => {
    try { return JSON.parse(line); } catch { throw new Error(`ownership ledger line ${index + 1} is not valid JSON`); }
  });
}

const depth = value => value.split(path.sep).length;

// Remove what the ledger proves this run owns; report everything else. Safe to call repeatedly and after a
// partial setup. `confirmed` is false when any owned object could not be removed or verified as already gone.
export function cleanupOwned({ ledgerFile }) {
  const result = { removed: [], alreadyRemoved: [], preserved: [], foreignPreserved: [], errors: [], confirmed: true };
  let entries;
  try { entries = readLedger(ledgerFile); } catch (error) {
    result.errors.push({ path: ledgerFile, error: String(error.message ?? error) });
    result.confirmed = false;
    return result;
  }
  const key = entry => `${entry.path}\0${entry.dev}\0${entry.ino}\0${entry.birthtimeNs ?? ''}`;
  const owned = new Map();
  const claimed = new Set();
  for (const entry of entries) {
    if (entry.event === 'owned') { owned.set(key(entry), entry); claimed.add(entry.path); }
    else if (entry.event === 'released') owned.delete(key(entry));
  }
  // Intent without an ownership record: the creation never happened, was denied, or hit an existing object.
  // We cannot claim it, so it is never touched; it is only reported when something is there.
  for (const entry of entries) {
    if (entry.event !== 'intent' || claimed.has(entry.path)) continue;
    try { fs.lstatSync(entry.path); result.foreignPreserved.push({ path: entry.path, reason: 'present without an ownership record' }); } catch { /* absent: nothing to report */ }
    claimed.add(entry.path);
  }
  const fail = (entry, reason) => { result.preserved.push({ path: entry.path, reason }); result.confirmed = false; };
  const release = (entry, outcome) => { try { appendRelease(ledgerFile, entry, outcome); } catch (error) { result.errors.push({ path: entry.path, error: `ledger update failed: ${error.message}` }); result.confirmed = false; } };
  for (const entry of [...owned.values()].sort((a, b) => depth(b.path) - depth(a.path))) {
    let parent;
    try { parent = fs.realpathSync(path.dirname(entry.path)); } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') { result.alreadyRemoved.push(entry.path); release(entry, 'already-removed'); continue; }
      result.errors.push({ path: entry.path, error: String(error.code ?? error.message) }); result.confirmed = false; continue;
    }
    if (parent !== entry.parent) { fail(entry, 'parent directory changed (symlink or move)'); continue; }
    let stat;
    try { stat = fs.lstatSync(entry.path, { bigint: true }); } catch (error) {
      if (error.code === 'ENOENT') { result.alreadyRemoved.push(entry.path); release(entry, 'already-removed'); continue; }
      result.errors.push({ path: entry.path, error: String(error.code ?? error.message) }); result.confirmed = false; continue;
    }
    if (stat.isSymbolicLink()) { fail(entry, 'replaced by a symlink'); continue; }
    if (!validIdentity(entry) || !validIdentity(statIdentity(stat))) { fail(entry, 'ownership incarnation is missing or unavailable'); continue; }
    if (typeOf(stat) !== entry.type || !matchesIdentity(stat, entry)) { fail(entry, 'replaced by a different object'); continue; }
    try {
      if (entry.type === 'directory') fs.rmdirSync(entry.path);
      else fs.unlinkSync(entry.path);
      result.removed.push(entry.path);
      release(entry, 'removed');
    } catch (error) {
      if (error.code === 'ENOENT') { result.alreadyRemoved.push(entry.path); release(entry, 'already-removed'); continue; }
      if (error.code === 'ENOTEMPTY' || error.code === 'EEXIST') { fail(entry, 'directory is not empty (foreign content preserved)'); continue; }
      result.errors.push({ path: entry.path, error: String(error.code ?? error.message) }); result.confirmed = false;
    }
  }
  return result;
}

function appendRelease(file, entry, outcome) {
  appendLine(file, { event: 'released', path: entry.path, dev: entry.dev, ino: entry.ino, birthtimeNs: entry.birthtimeNs, outcome, at: new Date().toISOString() });
}

// The probe is 'guard proven' only when every gate passed AND every owned object was confirmed cleaned up.
export function probeOutcome({ failures, cleanup }) {
  if (!cleanup || cleanup.confirmed !== true) {
    const detail = [...(cleanup?.preserved ?? []).map(entry => `${entry.reason}`), ...(cleanup?.errors ?? []).map(entry => entry.error)].join('; ') || 'cleanup not performed';
    return `refused: cleanup unconfirmed (${detail})${failures.length ? `; failed gate: ${failures.join('; ')}` : ''}`;
  }
  return failures.length === 0 ? 'guard proven' : `failed gate: ${failures.join('; ')}`;
}
