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

/** Create a missing private directory with mode 0700, or validate the existing one without changing it. */
export async function ensurePrivateDirectory(directory: string, description: string, options: { recursive?: boolean } = {}): Promise<void> {
  const created = await fs.mkdir(directory, { recursive: options.recursive ?? false, mode: 0o700 }).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'EEXIST') return false;
    throw error;
  });
  if (created) await fs.chmod(directory, 0o700);
  if (!await validatePrivateDirectory(directory, description)) throw new Error(`${description} could not be created`);
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
 * Existing content is kept: the file is opened for append and never truncated.
 */
export async function prepareLogFile(file: string, description: string): Promise<void> {
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | noFollow, 0o600)
    .catch((error: NodeJS.ErrnoException) => { throw new Error(error.code === 'ELOOP' ? `${description} must not be a symbolic link` : `${description} cannot be opened: ${error.message}`); });
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${description} must be a regular file`);
    requirePrivate(stat, description, '0600');
    if (stat.size === 0) await handle.chmod(0o600);
  } finally { await handle.close(); }
}
