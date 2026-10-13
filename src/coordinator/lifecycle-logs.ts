import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { loadCoordinatorConfiguration } from './config.js';
import { selectConfigurationFile } from './launch-context.js';
import type { ParsedLifecycleArguments } from './lifecycle-arguments.js';
import { errorText } from './lifecycle-start.js';
import type { LifecycleDependencies } from './lifecycle-start.js';
import { launchdPaths } from './native/launchd.js';
import { selectNativeManager } from './native/platform.js';
import { nativeServiceNames } from './native/types.js';
import { validatePrivateDirectory } from './native/private-files.js';

export interface LogStreams {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}

/** Exit status of a `--follow` that the person ended with Ctrl-C (128 + SIGINT, as for `tail -f`). */
export const FOLLOW_INTERRUPTED_EXIT_CODE = 130;

const CHUNK_BYTES = 64 * 1024;
/** Upper bound for the bytes scanned to find the last lines of one file, however long those lines are. */
const MAXIMUM_TAIL_BYTES = 4 * 1024 * 1024;
const MAXIMUM_LINE_LENGTH = 4000;
const JOURNALCTL_CANDIDATES = ['/usr/bin/journalctl', '/bin/journalctl', '/usr/local/bin/journalctl'];
const KILL_GRACE_MS = 2000;
const noFollow = constants.O_NOFOLLOW ?? 0;

// eslint-disable-next-line no-control-regex
const ANSI_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

/** One printable line: terminal escape sequences and control characters removed, length bounded. */
export function cleanLogLine(text: string): string {
  const clean = text.replace(/\r$/, '').replace(ANSI_SEQUENCE, '').replace(CONTROL_CHARACTERS, '?');
  return clean.length > MAXIMUM_LINE_LENGTH ? `${clean.slice(0, MAXIMUM_LINE_LENGTH - 3)}...` : clean;
}

export interface TailResult {
  /** At most the requested number of complete lines, oldest first, not yet cleaned. */
  lines: string[];
  /** Bytes read from the file to produce `lines`; never more than the scan bound plus one chunk. */
  bytesRead: number;
  /** True when the scan bound ended the search inside a very long line, so the oldest returned line is the last complete one found. */
  truncated: boolean;
}

/**
 * The last `count` lines of the first `size` bytes of an open file. The file is read backwards in fixed chunks and
 * the search stops as soon as enough line breaks were seen, so memory and I/O depend on the length of the tail
 * rather than on the length of the file.
 */
export async function readTailLines(handle: FileHandle, size: number, count: number, options: { chunkBytes?: number; maximumBytes?: number } = {}): Promise<TailResult> {
  const chunkBytes = Math.max(1, options.chunkBytes ?? CHUNK_BYTES);
  const maximumBytes = Math.max(chunkBytes, options.maximumBytes ?? MAXIMUM_TAIL_BYTES);
  const chunks: Buffer[] = [];
  let position = size;
  let bytesRead = 0;
  let newlines = 0;
  // Counting `count + 1` line breaks guarantees `count` complete lines, whether or not the file ends with a break.
  while (position > 0 && newlines <= count && bytesRead < maximumBytes) {
    const length = Math.min(chunkBytes, position);
    const buffer = Buffer.allocUnsafe(length);
    position -= length;
    let filled = 0;
    while (filled < length) {
      const { bytesRead: read } = await handle.read(buffer, filled, length - filled, position + filled);
      if (read === 0) break;
      filled += read;
    }
    bytesRead += filled;
    const data = filled === length ? buffer : buffer.subarray(0, filled);
    chunks.unshift(data);
    for (const byte of data) if (byte === 0x0a) newlines++;
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const pieces = text.split('\n');
  if (pieces.length > 0 && pieces[pieces.length - 1] === '') pieces.pop();
  // Unless the scan reached the start of the file, the first piece may be the end of a line that began earlier.
  const reachedStart = position === 0;
  if (!reachedStart && pieces.length > 0) pieces.shift();
  const lines = pieces.slice(-count);
  return { lines, bytesRead, truncated: !reachedStart && newlines <= count };
}

/** Splits a byte stream into cleaned lines; an unterminated tail waits for its line break. */
function createLineWriter(write: (line: string) => void) {
  let pending: Buffer = Buffer.alloc(0);
  return {
    push(data: Buffer): void {
      pending = pending.length ? Buffer.concat([pending, data]) : data;
      const end = pending.lastIndexOf(0x0a);
      if (end >= 0) {
        for (const line of pending.subarray(0, end).toString('utf8').split('\n')) write(cleanLogLine(line));
        pending = Buffer.from(pending.subarray(end + 1));
      }
      if (pending.length > MAXIMUM_LINE_LENGTH * 4) { write(cleanLogLine(pending.toString('utf8'))); pending = Buffer.alloc(0); }
    },
    flush(): void {
      if (pending.length) write(cleanLogLine(pending.toString('utf8')));
      pending = Buffer.alloc(0);
    },
  };
}

interface FileSource { label: string; description: string; file: string }

type Opened = { kind: 'open'; handle: FileHandle; size: number; dev: number; ino: number } | { kind: 'missing' } | { kind: 'invalid'; reason: string };

/** Open a log file for reading and validate the opened object: an owned, private, regular file, never a followed symlink. */
async function openLogFile(source: FileSource): Promise<Opened> {
  let handle: FileHandle;
  try { handle = await fs.open(source.file, constants.O_RDONLY | constants.O_NONBLOCK | noFollow); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'missing' };
    if (code === 'ELOOP') return { kind: 'invalid', reason: `${source.description} must not be a symbolic link` };
    return { kind: 'invalid', reason: `${source.description} cannot be opened: ${errorText(error)}` };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${source.description} must be a regular file`);
    if (process.platform !== 'win32') {
      if (stat.uid !== process.getuid?.()) throw new Error(`${source.description} must belong to this user`);
      if ((stat.mode & 0o077) !== 0) throw new Error(`${source.description} must have mode 0600 with no group or other access`);
    }
    return { kind: 'open', handle, size: stat.size, dev: stat.dev, ino: stat.ino };
  } catch (error) {
    await handle.close().catch(() => {});
    return { kind: 'invalid', reason: errorText(error) };
  }
}

const MISSING_NOTE = 'It does not exist yet: the service was never started with this state directory.';

/**
 * `heimdall coordinator logs`: print a bounded recent tail of the coordinator's process output, then optionally follow
 * new output until interrupted. It reads logs only; it never consults, starts or signals the coordinator or the service
 * manager, so it works while the coordinator is stopped or failed to start. Returns the process exit status.
 */
export async function runCoordinatorLogs(args: ParsedLifecycleArguments, deps: LifecycleDependencies, streams: LogStreams): Promise<number> {
  const unavailable = (message: string) => { streams.stderr.write(`Heimdall: ${message}\n`); return 1; };
  try {
    let configuration;
    try {
      const selection = selectConfigurationFile(args.coordinatorConfig, deps.environment);
      configuration = await loadCoordinatorConfiguration(selection.file, { implicitDefault: selection.origin === 'implicit-default' });
    } catch (error) {
      return unavailable(`Cannot load the coordinator configuration: ${errorText(error)}`);
    }
    const manager = selectNativeManager(deps.platform);
    if (!manager.supported) return unavailable(manager.message);
    const names = nativeServiceNames(configuration.stateDirectory);
    if (manager.manager === 'systemd') return await journalLogs(names.systemdUnit);

    try { await fs.lstat(configuration.stateDirectory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return unavailable(`No coordinator has used ${configuration.stateDirectory}, so there are no logs. Nothing was changed.`);
      return unavailable(`The state directory ${configuration.stateDirectory} cannot be inspected: ${errorText(error)}`);
    }
    return await fileLogs(launchdPaths(configuration.stateDirectory, names.launchdLabel));
  } catch (error) {
    return unavailable(`Unexpected failure: ${errorText(error)}`);
  }

  // --- macOS: the private output files under the state directory ------------------------------------------------

  async function fileLogs(paths: ReturnType<typeof launchdPaths>): Promise<number> {
    try {
      if (!await validatePrivateDirectory(paths.logDirectory, 'The Heimdall log directory')) {
        return unavailable(`No coordinator logs exist: ${paths.logDirectory} does not exist because the service was never started for this state directory.`);
      }
    } catch (error) { return unavailable(`The log directory cannot be read safely: ${errorText(error)}`); }

    const sources: FileSource[] = [
      { label: path.basename(paths.standardOut), description: 'The standard output log', file: paths.standardOut },
      { label: path.basename(paths.standardError), description: 'The standard error log', file: paths.standardError },
    ];
    const state = new Map<FileSource, { dev: number; ino: number; offset: number; lines: ReturnType<typeof createLineWriter> }>();
    let problem = false;
    let printedAny = false;
    let lastHeader: FileSource | null = null;
    const header = (source: FileSource) => {
      if (lastHeader === source) return;
      lastHeader = source;
      streams.stdout.write(`==> ${source.file} <==\n`);
    };
    const print = (source: FileSource) => (line: string) => { header(source); streams.stdout.write(`${line}\n`); printedAny = true; };

    for (const source of sources) {
      const opened = await openLogFile(source);
      if (opened.kind === 'missing') { streams.stderr.write(`Heimdall: ${source.description} ${source.file}: ${MISSING_NOTE}\n`); continue; }
      if (opened.kind === 'invalid') { streams.stderr.write(`Heimdall: ${opened.reason}; it was not read.\n`); problem = true; continue; }
      try {
        const tail = await readTailLines(opened.handle, opened.size, args.lines);
        header(source);
        for (const line of tail.lines) { streams.stdout.write(`${cleanLogLine(line)}\n`); printedAny = true; }
        state.set(source, { dev: opened.dev, ino: opened.ino, offset: opened.size, lines: createLineWriter(print(source)) });
      } catch (error) {
        streams.stderr.write(`Heimdall: ${source.description} cannot be read: ${errorText(error)}\n`); problem = true;
      } finally { await opened.handle.close().catch(() => {}); }
    }
    if (state.size === 0) {
      return unavailable(problem ? 'No coordinator log could be read safely.' : `No coordinator logs exist in ${paths.logDirectory}: the service was never started for this state directory.`);
    }
    if (!printedAny) streams.stderr.write('Heimdall: the coordinator log files are empty so far.\n');
    if (!args.follow) return problem ? 1 : 0;

    while (!deps.signal?.aborted) {
      await deps.sleep(Math.max(100, deps.pollIntervalMs), deps.signal);
      if (deps.signal?.aborted) break;
      for (const [source, known] of state) {
        const opened = await openLogFile(source);
        if (opened.kind === 'missing') continue;
        if (opened.kind === 'invalid') { streams.stderr.write(`Heimdall: ${opened.reason}; following stopped.\n`); return 1; }
        try {
          // A replaced or truncated file is read again from its start.
          if (opened.dev !== known.dev || opened.ino !== known.ino || opened.size < known.offset) { known.dev = opened.dev; known.ino = opened.ino; known.offset = 0; known.lines.flush(); }
          while (known.offset < opened.size && !deps.signal?.aborted) {
            const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, opened.size - known.offset));
            const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, known.offset);
            if (bytesRead === 0) break;
            known.offset += bytesRead;
            known.lines.push(buffer.subarray(0, bytesRead));
          }
        } catch (error) {
          streams.stderr.write(`Heimdall: ${source.description} cannot be read: ${errorText(error)}\n`);
          return 1;
        } finally { await opened.handle.close().catch(() => {}); }
      }
    }
    return FOLLOW_INTERRUPTED_EXIT_CODE;
  }

  // --- Linux: the owned user unit's journal, filtered to that unit -----------------------------------------------

  async function journalLogs(unit: string): Promise<number> {
    const journalctl = deps.journalctl ?? await resolveJournalctl();
    if (!journalctl) return unavailable(`journalctl was not found, so the journal of ${unit} cannot be read.`);
    // A finite read adds --quiet (systemd v255, journalctl.c: `if (n_shown == 0 && !arg_quiet) printf("-- No entries --\n")`),
    // so the reader prints nothing but entries and an empty result is zero output bytes on exit 0, whatever the locale.
    // Real access failures stay errors with --quiet: "No journal files were opened due to insufficient permissions."
    // is logged unconditionally and exits nonzero. `--follow` keeps waiting for future entries and is left unchanged.
    const argv = ['--user', '-u', unit, '-n', String(args.lines), '--no-pager', ...(args.follow ? ['-f'] : ['--quiet']), '-o', 'short-iso'];
    const start = deps.spawnProcess ?? spawn;
    let child;
    try { child = start(journalctl, argv, { stdio: ['ignore', 'pipe', 'pipe'], env: deps.environment, windowsHide: true }); }
    catch (error) { return unavailable(`journalctl could not run: ${errorText(error)}`); }

    const lines = createLineWriter(line => { streams.stdout.write(`${line}\n`); });
    const diagnostics: Buffer[] = [];
    let diagnosticBytes = 0;
    let spawnError: Error | null = null;
    let outputBytes = 0;
    child.stdout?.on('data', (data: Buffer) => { outputBytes += data.length; lines.push(Buffer.from(data)); });
    child.stderr?.on('data', (data: Buffer) => { if (diagnosticBytes < 8192) { diagnostics.push(Buffer.from(data)); diagnosticBytes += data.length; } });

    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.once('error', (error: Error) => { spawnError = error; resolve({ code: null, signal: null }); });
      child.once('close', (code: number | null, signal: NodeJS.Signals | null) => resolve({ code, signal }));
    });
    let killTimer: NodeJS.Timeout | undefined;
    const interrupt = () => {
      // Only the reader this command started is ended; the service and its journal are untouched.
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, KILL_GRACE_MS);
      killTimer.unref?.();
    };
    if (deps.signal?.aborted) interrupt(); else deps.signal?.addEventListener('abort', interrupt, { once: true });
    const result = await closed;
    deps.signal?.removeEventListener('abort', interrupt);
    if (killTimer) clearTimeout(killTimer);
    lines.flush();

    if (spawnError) return unavailable(`journalctl could not run: ${errorText(spawnError)}`);
    if (deps.signal?.aborted) return FOLLOW_INTERRUPTED_EXIT_CODE;
    if (result.code !== 0) {
      const detail = cleanLogLine(Buffer.concat(diagnostics).toString('utf8').replace(/\s+/g, ' ').trim());
      return unavailable(`journalctl ${result.code === null ? `ended by ${result.signal ?? 'a signal'}` : `exited with status ${result.code}`}${detail ? `: ${detail}` : ''}`);
    }
    if (!args.follow && outputBytes === 0) {
      return unavailable(`There are no logs for ${unit}: its journal has no entries, because the service was never started for this state directory or the host's journal retention removed them.`);
    }
    return 0;
  }
}

async function resolveJournalctl(): Promise<string | undefined> {
  for (const candidate of JOURNALCTL_CANDIDATES) {
    try { await fs.access(candidate, constants.X_OK); return candidate; } catch { /* try the next location */ }
  }
  return undefined;
}
