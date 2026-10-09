import fs from 'node:fs/promises';
import path from 'node:path';

/** Sqlite-free helpers so the OpenChamber guest service can read the coordinator key without bundling the store. */
export async function privateFile(file: string): Promise<void> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Coordinator state file must be a regular file');
  if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) throw new Error('Coordinator state file must belong to this user and have mode 0600');
}

export async function readCoordinatorToken(stateDirectory: string): Promise<string> {
  await privateFile(path.join(stateDirectory, 'coordinator.key'));
  const token = await fs.readFile(path.join(stateDirectory, 'coordinator.key'), 'utf8');
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid coordinator access key');
  return token;
}
