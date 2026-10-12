import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { privateFile } from './token.js';

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;

export interface CoordinatorOwnership {
  /** Private lock database held for the lifetime of the owning coordinator. */
  readonly lockPath: string;
  /** Idempotently give up ownership. The operating system also releases it when the process exits. */
  release(): void;
}

export const OWNERSHIP_CONFLICT_MESSAGE = 'Another coordinator owns this state directory; stop that coordinator before starting another';

export type OwnershipProbe = 'free' | 'held' | 'absent';

/**
 * Check, without creating anything, whether a coordinator currently holds the ownership lock. The lock is taken and
 * dropped within one call, so `free` means no process owned the state at that moment. `absent` means no coordinator
 * ever created the lock database in this state directory.
 */
export async function probeCoordinatorOwnership(stateDirectory: string): Promise<OwnershipProbe> {
  const lockPath = path.join(stateDirectory, 'coordinator.owner.sqlite');
  try { await privateFile(lockPath); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent'; throw error; }
  const db = new DatabaseSync(lockPath, { timeout: 0 });
  try {
    db.exec('PRAGMA journal_mode = MEMORY');
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.exec('BEGIN EXCLUSIVE');
    return 'free';
  } catch (error) {
    const code = (error as { errcode?: unknown }).errcode;
    if (code === SQLITE_BUSY || code === SQLITE_LOCKED) return 'held';
    throw error;
  } finally {
    try { if (db.isOpen && db.isTransaction) db.exec('ROLLBACK'); } finally { if (db.isOpen) db.close(); }
  }
}

/**
 * Take exclusive ownership of an already canonical, private coordinator state directory.
 *
 * The owner is whichever process holds an exclusive SQLite lock on a private lock database. The lock is an
 * operating-system file lock, so a crashed or killed owner releases it without any repair, and a PID, socket
 * or file left behind never proves ownership. Acquire before touching the endpoint, key or coordinator database.
 */
export async function acquireCoordinatorOwnership(stateDirectory: string): Promise<CoordinatorOwnership> {
  const lockPath = path.join(stateDirectory, 'coordinator.owner.sqlite');
  try { await fs.writeFile(lockPath, '', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await privateFile(lockPath);
  const db = new DatabaseSync(lockPath, { timeout: 0 });
  try {
    // Nothing is ever written, so keep a rollback journal file from appearing beside the lock database.
    db.exec('PRAGMA journal_mode = MEMORY');
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    // The transaction is never committed: it only exists to keep the exclusive file lock until release.
    db.exec('BEGIN EXCLUSIVE');
  } catch (error) {
    try { db.close(); } catch { /* Report the original failure. */ }
    const code = (error as { errcode?: unknown }).errcode;
    if (code === SQLITE_BUSY || code === SQLITE_LOCKED) throw new Error(OWNERSHIP_CONFLICT_MESSAGE);
    throw error;
  }
  return {
    lockPath,
    release() {
      if (!db.isOpen) return;
      try { if (db.isTransaction) db.exec('ROLLBACK'); }
      finally { db.close(); }
    },
  };
}
