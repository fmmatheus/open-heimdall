import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/** A freshly created, invocation-owned temporary file. */
export interface TemporaryFile {
  writeFile(data: string, encoding: 'utf8'): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** The only mutating filesystem operations setup performs; tests substitute them to inject faults. */
export interface SetupFileOperations {
  mkdir(directory: string, mode: number): Promise<void>;
  /** Must fail when the file already exists. */
  createTemporary(file: string, mode: number): Promise<TemporaryFile>;
  /** Must fail with EEXIST when `created` already exists. */
  link(existing: string, created: string): Promise<void>;
  unlink(file: string): Promise<void>;
}

export const nodeFileOperations: SetupFileOperations = {
  mkdir: async (directory, mode) => { await fs.mkdir(directory, { mode }); },
  createTemporary: (file, mode) => fs.open(file, 'wx', mode),
  link: (existing, created) => fs.link(existing, created),
  unlink: file => fs.unlink(file),
};

export class PublishError extends Error {
  /** Directories this call created before it failed; they are never removed. */
  readonly createdDirectories: string[];
  constructor(readonly kind: 'exists' | 'failed', message: string, options?: ErrorOptions & { createdDirectories?: string[] }) {
    super(message, options);
    this.name = 'PublishError';
    this.createdDirectories = options?.createdDirectories ?? [];
  }
}

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | null)?.code;
const reason = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * Creates the missing directories in order with mode 0700 and returns those this call created; existing ones are never touched.
 * When a later directory fails, the thrown error lists the directories created before it.
 */
export async function createDirectories(directories: string[], operations: SetupFileOperations = nodeFileOperations): Promise<string[]> {
  const created: string[] = [];
  for (const directory of directories) {
    try { await operations.mkdir(directory, 0o700); created.push(directory); }
    catch (error) {
      if (errorCode(error) === 'EEXIST') continue;
      throw new PublishError('failed', `Cannot create directory ${directory}: ${reason(error)}`, { cause: error, createdDirectories: created });
    }
  }
  return created;
}

/**
 * Publishes complete content at `target` without ever replacing an existing file: the content is written and
 * synced to an invocation-owned temporary file in the same directory (mode 0600), then hard-linked into place.
 * Readers see either no file or the whole file. Only the temporary file owned by this call is ever removed.
 */
export async function publishNoClobber(target: string, content: string, operations: SetupFileOperations = nodeFileOperations): Promise<{ warnings: string[] }> {
  const temporary = path.join(path.dirname(target), `.heimdall-setup-${randomBytes(8).toString('hex')}.tmp`);
  const discard = async (): Promise<void> => { try { await operations.unlink(temporary); } catch { /* best effort: only our own temporary file */ } };
  let owned = false;
  try {
    const handle = await operations.createTemporary(temporary, 0o600);
    owned = true;
    try { await handle.writeFile(content, 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
  } catch (error) {
    if (owned) await discard();
    throw new PublishError('failed', `Cannot write ${target}: ${reason(error)}`, { cause: error });
  }
  try { await operations.link(temporary, target); }
  catch (error) {
    await discard();
    if (errorCode(error) === 'EEXIST') throw new PublishError('exists', `${target} already exists`, { cause: error });
    throw new PublishError('failed', `Cannot publish ${target}: ${reason(error)}`, { cause: error });
  }
  const warnings: string[] = [];
  try { await operations.unlink(temporary); }
  catch (error) { warnings.push(`Could not remove temporary file ${temporary}: ${reason(error)}`); }
  return { warnings };
}
