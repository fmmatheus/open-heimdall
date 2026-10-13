import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const noFollow = constants.O_NOFOLLOW ?? 0;
const currentUser = () => process.getuid?.();

/** Existing application-owned objects are validated, never repaired. */
function requirePrivate(stat: { mode: number; uid: number }, description: string, mode: string): void {
  if (process.platform === 'win32') return;
  if (stat.uid !== currentUser()) throw new Error(`${description} must belong to this user`);
  if ((stat.mode & 0o077) !== 0) throw new Error(`${description} must have mode ${mode} with no group or other access`);
}

/** Validate an existing directory as a private, owned, non-symlink directory. Returns false when it does not exist. */
export async function validatePrivateDirectory(directory: string, description: string): Promise<boolean> {
  let stat;
  try { stat = await fs.lstat(directory); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${description} must be a private directory, not a symbolic link or file`);
  requirePrivate(stat, description, '0700');
  return true;
}

/**
 * Create a directory this call just made with mode 0700. The mode is applied through a descriptor opened without
 * following symbolic links, so a path substituted after `mkdir` can never have its target changed.
 */
async function sealCreatedDirectory(directory: string, description: string): Promise<void> {
  if (process.platform === 'win32') return;
  let handle;
  try { handle = await fs.open(directory, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | noFollow); }
  catch (error) {
    // Opening a symbolic link with O_NOFOLLOW reports ELOOP on Linux and ENOTDIR (with O_DIRECTORY) on macOS.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP' || code === 'ENOTDIR') throw new Error(`${description} must be a private directory, not a symbolic link or file`);
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isDirectory() || stat.uid !== currentUser()) throw new Error(`${description} was replaced while it was being created`);
    if ((stat.mode & 0o777) !== 0o700) await handle.chmod(0o700);
  } finally { await handle.close(); }
}

/**
 * Make sure a private directory exists. A missing directory (and, with `recursive`, each missing ancestor) is created
 * one component at a time and only those created here receive mode 0700. An existing directory is validated (owned by
 * this user, not a symbolic link, no group or other access) and never repaired, and existing ancestors are left alone.
 */
export async function ensurePrivateDirectory(directory: string, description: string, options: { recursive?: boolean } = {}): Promise<void> {
  const target = path.resolve(directory);
  const missing: string[] = [];
  for (let current = target; ; current = path.dirname(current)) {
    const exists = await fs.lstat(current).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    if (exists) break;
    missing.unshift(current);
    if (!options.recursive || path.dirname(current) === current) break;
  }
  for (const component of missing) {
    const created = await fs.mkdir(component, { mode: 0o700 }).then(() => true, (error: NodeJS.ErrnoException) => {
      // Another actor made it first: it is existing, so it is validated below and not modified.
      if (error.code === 'EEXIST') return false;
      throw error;
    });
    if (created) await sealCreatedDirectory(component, component === target ? description : `The parent of ${description}`);
  }
  if (!await validatePrivateDirectory(target, description)) throw new Error(`${description} could not be created`);
}

/** Read a private regular file through the opened descriptor. Returns null when it does not exist. */
export async function readPrivateText(file: string, description: string, maximumBytes: number): Promise<string | null> {
  let handle;
  try { handle = await fs.open(file, constants.O_RDONLY | constants.O_NONBLOCK | noFollow); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    if (code === 'ELOOP') throw new Error(`${description} must not be a symbolic link`);
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${description} must be a regular file`);
    requirePrivate(stat, description, '0600');
    if (stat.size > maximumBytes) throw new Error(`${description} is larger than expected`);
    return await handle.readFile('utf8');
  } finally { await handle.close(); }
}

/** Atomically publish a new private file; the destination is replaced only after the caller validated it. */
export async function writePrivateFile(file: string, content: string): Promise<void> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    const handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    try { await handle.chmod(0o600); await handle.writeFile(content); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Ensure an append-only log destination exists as a private regular file the manager can open.
 * Existing content is kept: the file is opened for append and never truncated. The open never blocks (a named pipe
 * without a reader is refused) and never follows a symbolic link; the opened descriptor, not the path, is validated.
 * Only a file created by this call has its mode set.
 */
export async function prepareLogFile(file: string, description: string): Promise<void> {
  const base = constants.O_WRONLY | constants.O_APPEND | constants.O_NONBLOCK | noFollow;
  const refuse = (error: NodeJS.ErrnoException): never => {
    if (error.code === 'ELOOP') throw new Error(`${description} must not be a symbolic link`);
    if (error.code === 'ENXIO' || error.code === 'EISDIR' || error.code === 'ENOTDIR') throw new Error(`${description} must be a regular file`);
    throw new Error(`${description} cannot be opened: ${error.message}`);
  };
  let handle;
  let created = false;
  // An exclusive create tells a new file from an existing object; the other actor winning the race is simply existing.
  for (let attempt = 0; handle === undefined; attempt++) {
    try { handle = await fs.open(file, base | constants.O_CREAT | constants.O_EXCL, 0o600); created = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') refuse(error as NodeJS.ErrnoException);
      try { handle = await fs.open(file, base); }
      catch (opening) {
        if ((opening as NodeJS.ErrnoException).code === 'ENOENT' && attempt < 3) continue;
        refuse(opening as NodeJS.ErrnoException);
      }
    }
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${description} must be a regular file`);
    if (created) { if ((stat.mode & 0o777) !== 0o600) await handle.chmod(0o600); }
    else requirePrivate(stat, description, '0600');
  } finally { await handle.close(); }
}
