import fs from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ensurePrivateDirectory, readPrivateText, writePrivateFile } from './native/private-files.js';
import { LIFECYCLE_DIRECTORY } from './lifecycle.js';
import { privateFile } from './token.js';

const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const LOCK_FILE = 'operation.lock.sqlite';
const GENERATION_FILE = 'stop-generation.json';
const DEFAULT_POLL_MS = 50;

/** Held for the whole of one lifecycle operation (start or stop) on one state directory. */
export interface OperationLock {
  readonly path: string;
  /** Idempotent. The operating system also releases the lock when the process exits or is killed. */
  release(): void;
}

export interface OperationLockOptions {
  /** Absolute time (milliseconds, as `now` reports) at which waiting ends in a `busy` result. */
  deadlineAt: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
  pollMs?: number;
  /** Called once, the first time another operation is found holding the lock. */
  onWaiting?: () => void;
}

export type OperationLockResult =
  | { acquired: true; lock: OperationLock }
  | { acquired: false; reason: 'busy' | 'aborted' };

const lifecycleDirectory = (stateDirectory: string) => path.join(stateDirectory, LIFECYCLE_DIRECTORY);

/**
 * Take the private per-target operation lock, waiting at most until `deadlineAt`. Like coordinator ownership it is an
 * operating-system lock on a private SQLite database, so a crashed lifecycle command releases it without repair and a
 * leftover file never blocks anything. Missing private directories are created with mode 0700; existing ones are
 * validated, never repaired.
 */
export async function acquireOperationLock(stateDirectory: string, options: OperationLockOptions): Promise<OperationLockResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  await ensurePrivateDirectory(stateDirectory, 'Coordinator state directory', { recursive: true });
  await ensurePrivateDirectory(lifecycleDirectory(stateDirectory), 'Coordinator lifecycle directory');
  const lockPath = path.join(lifecycleDirectory(stateDirectory), LOCK_FILE);
  try { await fs.writeFile(lockPath, '', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await privateFile(lockPath);
  let waiting = false;
  while (true) {
    if (options.signal?.aborted) return { acquired: false, reason: 'aborted' };
    const db = new DatabaseSync(lockPath, { timeout: 0 });
    try {
      // Nothing is written; the open exclusive transaction only holds the file lock.
      db.exec('PRAGMA journal_mode = MEMORY');
      db.exec('PRAGMA locking_mode = EXCLUSIVE');
      db.exec('BEGIN EXCLUSIVE');
      return {
        acquired: true,
        lock: {
          path: lockPath,
          release() {
            if (!db.isOpen) return;
            try { if (db.isTransaction) db.exec('ROLLBACK'); }
            finally { db.close(); }
          },
        },
      };
    } catch (error) {
      try { db.close(); } catch { /* Report the original failure. */ }
      const code = (error as { errcode?: unknown }).errcode;
      if (code !== SQLITE_BUSY && code !== SQLITE_LOCKED) throw error;
    }
    if (!waiting) { waiting = true; options.onWaiting?.(); }
    const remaining = options.deadlineAt - now();
    if (remaining <= 0) return { acquired: false, reason: 'busy' };
    await sleep(Math.min(options.pollMs ?? DEFAULT_POLL_MS, remaining));
  }
}

/**
 * The stop generation counts successful clean stops of this target. A start records it before it begins waiting for
 * the operation lock and runs only if it is unchanged once the lock is held, so a start queued behind a stop that then
 * succeeded does not launch the coordinator again; a new explicit start is required. Missing means generation 0.
 */
export async function readStopGeneration(stateDirectory: string): Promise<number> {
  const text = await readPrivateText(path.join(lifecycleDirectory(stateDirectory), GENERATION_FILE), 'The stop generation record', 4096);
  if (text === null) return 0;
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('The stop generation record is not valid JSON'); }
  const generation = value && typeof value === 'object' ? (value as { generation?: unknown }).generation : undefined;
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0) throw new Error('The stop generation record is malformed');
  return generation;
}

/** Record one successful stop. The caller holds the operation lock; the record is replaced atomically with mode 0600. */
export async function advanceStopGeneration(stateDirectory: string): Promise<number> {
  const next = (await readStopGeneration(stateDirectory)) + 1;
  await ensurePrivateDirectory(lifecycleDirectory(stateDirectory), 'Coordinator lifecycle directory');
  await writePrivateFile(path.join(lifecycleDirectory(stateDirectory), GENERATION_FILE), JSON.stringify({ generation: next }));
  return next;
}
