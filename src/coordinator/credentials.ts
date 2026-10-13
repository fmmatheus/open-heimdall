import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

/**
 * Private credential input for Basic authentication (`coordinator serve --env-file FILE`).
 *
 * Format: one `NAME=value` per line. Blank lines and lines whose first character is `#` are ignored. A name is an
 * environment variable name directly followed by `=`. A value is taken literally: it may be wrapped in one matching
 * pair of single or double quotes, which are removed; there are no escapes, interpolation, `export` prefix, inline
 * comments or command substitution. Unquoted values lose trailing whitespace only. Values must be nonempty and free
 * of control characters. A name may appear once.
 *
 * The file is credential input only. Its values live in a lookup context and are never copied into `process.env`.
 */

/** Largest accepted file; a credential file is a handful of short lines. */
export const CREDENTIAL_FILE_MAXIMUM_BYTES = 64 * 1024;

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Variables that select executables, configuration, Git, OpenChamber or runtime behavior are not credentials.
const CONTROL_NAMES = /^(HOME|PATH|PWD|OLDPWD|SHELL|USER|LOGNAME|TMPDIR|TMP|TEMP|IFS|ENV|BASH_ENV|CDPATH|TZ|TERM|LANG|LANGUAGE|EDITOR|VISUAL|PAGER|ALL_PROXY|HTTP_PROXY|HTTPS_PROXY|NO_PROXY|PYTHONPATH|PYTHONHOME|RUBYLIB|PERL5LIB|CLASSPATH)$/i;
const CONTROL_PREFIXES = /^(NODE(_|$)|HEIMDALL_|OPENCHAMBER_|GIT_|XDG_|NPM_|LD_|DYLD_|LC_|SSL_|SSH_|BASH_FUNC_)/i;

export const isControlVariable = (name: string): boolean => CONTROL_NAMES.test(name) || CONTROL_PREFIXES.test(name);

/** Raised for every rejected credential file. Messages name files, variables and line numbers, never contents. */
export class CredentialFileError extends Error {
  constructor(message: string) { super(message); this.name = 'CredentialFileError'; }
}

/** Parsed credential values, reachable only through explicit lookups. */
export interface CredentialContext {
  /** Absolute path the context was read from. */
  readonly file: string;
  /** Variable names defined by the file, in file order. */
  readonly names: readonly string[];
  has(name: string): boolean;
  lookup(name: string): string | undefined;
  /**
   * An environment for one OpenCode connection: exactly the selected credential variable from the file plus the
   * nonsecret OpenChamber data directory selection taken from `base`. Nothing else is carried over.
   */
  environmentFor(reference: string, base?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  /** Every credential value, for sanitizing output. */
  values(): readonly string[];
}

/** Test seams for the open/validate/read sequence; the command line exposes none of them. */
export interface CredentialFileHooks {
  beforeOpen?(): void | Promise<void>;
  afterOpen?(): void | Promise<void>;
}

export interface LoadCredentialFileOptions {
  /** Owner the opened file must have; defaults to the current user. */
  uid?: number;
  hooks?: CredentialFileHooks;
}

const text = new TextDecoder('utf-8', { fatal: true });

function parse(content: string, file: string): Map<string, string> {
  const values = new Map<string, string>();
  const lines = new Map<string, number>();
  content.split('\n').forEach((raw, index) => {
    const number = index + 1;
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!line.trim() || line.startsWith('#')) return;
    const separator = line.indexOf('=');
    const name = separator < 0 ? '' : line.slice(0, separator);
    if (!VARIABLE_NAME.test(name)) throw new CredentialFileError(`Credential file ${file}: line ${number} is not NAME=value`);
    let value = line.slice(separator + 1);
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      if (value.length < 2 || value[value.length - 1] !== quote || value.slice(1, -1).includes(quote)) throw new CredentialFileError(`Credential file ${file}: line ${number} has an unterminated or unsupported quoted value`);
      value = value.slice(1, -1);
    } else value = value.trimEnd();
    // eslint-disable-next-line no-control-regex
    if (!value || /[\u0000-\u001f\u007f]/.test(value)) throw new CredentialFileError(`Credential file ${file}: line ${number} has an empty value or a control character`);
    if (isControlVariable(name)) throw new CredentialFileError(`Credential file ${file}: line ${number} sets ${name}, which is not a credential variable and cannot be set here`);
    const first = lines.get(name);
    if (first !== undefined) throw new CredentialFileError(`Credential file ${file}: ${name} is defined more than once (lines ${first} and ${number})`);
    lines.set(name, number);
    values.set(name, value);
  });
  return values;
}

/**
 * Reads a private credential file. The file is opened without following a final symbolic link and without blocking
 * on a pipe, and every check is made on the opened descriptor, so a path substituted after opening cannot change
 * what is validated or read. The file is never created, repaired or modified.
 */
export async function loadCredentialFile(file: string, options: LoadCredentialFileOptions = {}): Promise<CredentialContext> {
  const absolute = path.resolve(file);
  const subject = `Credential file ${absolute}`;
  await options.hooks?.beforeOpen?.();
  let handle: fs.FileHandle;
  try { handle = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ELOOP') throw new CredentialFileError(`${subject} must not be a symbolic link`);
    if (code === 'ENOENT') throw new CredentialFileError(`${subject} does not exist`);
    if (code === 'EACCES' || code === 'EPERM') throw new CredentialFileError(`${subject} is not readable by this user`);
    throw new CredentialFileError(`${subject} cannot be opened (${code ?? 'unknown error'})`);
  }
  try {
    await options.hooks?.afterOpen?.();
    const stat = await handle.stat();
    if (!stat.isFile()) throw new CredentialFileError(`${subject} must be a regular file`);
    if (process.platform !== 'win32') {
      const owner = options.uid ?? process.getuid?.();
      if (stat.uid !== owner) throw new CredentialFileError(`${subject} must be owned by the current user`);
      if ((stat.mode & 0o077) !== 0) throw new CredentialFileError(`${subject} must not be accessible by group or others (use mode 0600)`);
    }
    if (stat.size > CREDENTIAL_FILE_MAXIMUM_BYTES) throw new CredentialFileError(`${subject} is larger than ${CREDENTIAL_FILE_MAXIMUM_BYTES} bytes`);
    const buffer = Buffer.alloc(CREDENTIAL_FILE_MAXIMUM_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > CREDENTIAL_FILE_MAXIMUM_BYTES) throw new CredentialFileError(`${subject} is larger than ${CREDENTIAL_FILE_MAXIMUM_BYTES} bytes`);
    const after = await handle.stat();
    if (after.size !== length || after.mtimeMs !== stat.mtimeMs) throw new CredentialFileError(`${subject} changed while it was read`);
    let content: string;
    try { content = text.decode(buffer.subarray(0, length)); }
    catch { throw new CredentialFileError(`${subject} is not valid UTF-8`); }
    return context(absolute, parse(content, absolute));
  } finally { await handle.close(); }
}

/** A fresh environment carrying only the nonsecret OpenChamber data directory selection from `base`. */
export function selectionEnvironment(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = Object.create(null);
  if (typeof base.OPENCHAMBER_DATA_DIR === 'string') environment.OPENCHAMBER_DATA_DIR = base.OPENCHAMBER_DATA_DIR;
  return environment;
}

function context(file: string, entries: Map<string, string>): CredentialContext {
  const names = Object.freeze([...entries.keys()]);
  const values = Object.freeze([...entries.values()]);
  return Object.freeze({
    file, names,
    has: (name: string) => entries.has(name),
    lookup: (name: string) => entries.get(name),
    environmentFor(reference: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
      const environment = selectionEnvironment(base);
      const value = entries.get(reference);
      if (value !== undefined) environment[reference] = value;
      return environment;
    },
    values: () => values,
  });
}
