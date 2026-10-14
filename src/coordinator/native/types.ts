import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

/** Names derived from the canonical state directory, so an isolated state directory gets its own service. */
export interface NativeServiceNames { identity: string; launchdLabel: string; systemdUnit: string }

export function nativeServiceNames(canonicalStateDirectory: string): NativeServiceNames {
  const identity = createHash('sha256').update(canonicalStateDirectory).digest('hex').slice(0, 24);
  return { identity, launchdLabel: `dev.openheimdall.coordinator.${identity}`, systemdUnit: `heimdall-coordinator-${identity}.service` };
}

export interface CommandResult {
  /** Process exit status, or null when the tool could not run or was terminated. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** Present when the tool could not be started, timed out, or exceeded its output bound. */
  error?: string;
  /**
   * True when the tool was told to run but its outcome is not known: it was ended or left running before it finished
   * (a deadline, an interruption, its output bound), so the request it carried may still take effect. Absent means the
   * tool was never run, could not run, or its exit was observed.
   */
  unresolved?: boolean;
}

export interface CommandRunOptions {
  /** How long the tool may run before it is ended. Defaults to 15 seconds. */
  timeoutMs?: number;
  /**
   * The tool carries a request the manager may act on after this command gives up on it (a start request). When the
   * command's deadline passes or it is interrupted, the tool client is then left running instead of being ended: ending
   * it could drop a request the manager has not received yet, and the durable launch attempt record, not this process,
   * is what keeps that request from being forgotten. Every other tool is ended with the command.
   *
   * Inside `withClientWitness` the client is started through a launcher that waits for the witness to record the
   * client before it runs the tool, so the record exists before the request can reach the manager.
   */
  outlivesCommand?: boolean;
}

/** Runs a native tool with an argument array. Implementations never use a shell and never throw for a nonzero exit. */
export interface CommandRunner {
  run(file: string, args: readonly string[], options?: CommandRunOptions): Promise<CommandResult>;
}

/**
 * The overall allowance of one lifecycle command: the instant its deadline passes and the signal that interrupts it. A
 * runner created by `createExecFileRunner` takes it from the asynchronous context of the command that calls it, so
 * every tool call of the command (and of work the command abandoned) ends with the command rather than with the tool's
 * own, unrelated timeout, and no tool is started once the command's allowance is spent.
 */
export interface CommandBudget {
  deadlineAt: number;
  now(): number;
  signal?: AbortSignal;
}

const commandBudgets = new AsyncLocalStorage<CommandBudget>();

/** Run `work` so that every native tool call it makes, however late, is bound by `budget`. */
export function withCommandBudget<T>(budget: CommandBudget, work: () => T): T {
  return commandBudgets.run(budget, work);
}

/**
 * Durable evidence of a released tool client, supplied by the command that may have to give up on it. `spawned` runs
 * once the client exists and before it has been told to run its tool: the client waits for the answer, so the
 * evidence is on disk before the request can reach the manager. When it fails, the client is never told to run.
 *
 * The runner owns the call it makes: it reports no result, so the command's native call (and the lock the command
 * holds for it) does not settle, until `spawned` has settled. Whatever `spawned` writes is therefore finished before
 * the serialization it ran under ends, however the call ended.
 */
export interface ClientWitness {
  spawned(client: { pid: number }): Promise<void>;
}

const clientWitnesses = new AsyncLocalStorage<ClientWitness>();

/** Run `work` so that a tool client released by the production runner is made known to `witness` before it can deliver. */
export function withClientWitness<T>(witness: ClientWitness, work: () => T): T {
  return clientWitnesses.run(witness, work);
}

/**
 * What a witnessed client runs: wait for the go-ahead on stdin, then run the tool with the client's own output. The
 * client is spawned detached, so it leads its own process group and its process id names that group. Standard input
 * ending without the go-ahead means the command went away or could not record the client: the tool never runs.
 */
const CLIENT_LAUNCHER = [
  "const { spawn } = require('node:child_process');",
  'const [file, ...args] = JSON.parse(process.argv[1]);',
  'let go = false;',
  "process.stdin.on('data', chunk => { if (go || !String(chunk).includes('go')) return; go = true; process.stdin.destroy(); run(); });",
  "process.stdin.on('end', () => { if (!go) process.exit(125); });",
  "process.stdin.on('error', () => { if (!go) process.exit(125); });",
  'function run() {',
  "  const child = spawn(file, args, { stdio: ['ignore', 'inherit', 'inherit'] });",
  "  child.once('error', error => { process.stderr.write(file + ' could not run: ' + (error.code || error.message) + '\\n'); process.exit(127); });",
  "  child.once('close', (code, signal) => { if (code !== null) process.exit(code); process.removeAllListeners(signal); process.kill(process.pid, signal); });",
  '}',
].join('\n');

const DEFAULT_TOOL_TIMEOUT_MS = 15000;
const OUTPUT_BOUND = 1024 * 1024;
/** After SIGTERM, how long a tool client may take to exit before it is killed, and when the runner stops waiting for it. */
const TERMINATE_GRACE_MS = 250;
const GIVE_UP_AFTER_MS = 500;
/** After a witnessed client exits, how long its output may take to drain before the exit alone is taken as its answer. */
const EXIT_DRAIN_MS = 250;

/** Stop holding the event loop for a child that is not waited for any more. */
function release(child: ChildProcess): void {
  child.unref();
  child.stdin?.destroy();
  child.stdout?.destroy();
  child.stderr?.destroy();
}

/**
 * How a call to a tool ended, which is also what it proves about delivery. Only `left-running` leaves the request the
 * tool carried unresolved; it is never inferred from a generic failure or from the passing of time.
 *   exited         The tool's exit was observed; its status is the result.
 *   not-run        A witnessed client was never told to run its tool (its input closed first), so nothing reached the
 *                  manager and nothing is left behind.
 *   could-not-run  The tool or its client could not be started.
 *   left-running   The tool was told to run and was ended or abandoned before its exit was seen (deadline, interruption,
 *                  output bound, an unexplained death of its client): it may still deliver.
 */
type Ending =
  | { kind: 'exited'; code: number }
  | { kind: 'not-run'; reason: string }
  | { kind: 'could-not-run'; reason: string }
  | { kind: 'left-running'; reason: string };

function resultOf(file: string, ending: Ending, output: { stdout: string; stderr: string }): CommandResult {
  switch (ending.kind) {
    case 'exited': return { exitCode: ending.code, ...output };
    case 'not-run': return { exitCode: null, ...output, error: `${file} was not run: ${ending.reason}` };
    case 'could-not-run': return { exitCode: null, ...output, error: `${file} could not run: ${ending.reason}` };
    case 'left-running': return { exitCode: null, ...output, error: `${file} did not finish: ${ending.reason}`, unresolved: true };
  }
}

/**
 * The production runner: `spawn` with an argument array and no shell. Inside `withCommandBudget` the call is also bound
 * by the command: nothing starts after the deadline or an interruption, and a tool still running when either happens
 * is ended (SIGTERM, then SIGKILL) so the command can finish on time. Only the tool client this call started is ever
 * signalled, never a process it asked the manager to start. A tool marked `outlivesCommand` is released instead.
 *
 * A witnessed client has one owner, this call: it publishes the client through the witness, gives the go-ahead only
 * once the publication succeeded and the call is still open, and ends in exactly one place (`conclude`), after the
 * publication has settled.
 */
export function createExecFileRunner(): CommandRunner {
  return {
    run(file, args, options = {}) {
      return new Promise(resolve => {
        const budget = commandBudgets.getStore();
        if (budget?.signal?.aborted) { resolve({ exitCode: null, stdout: '', stderr: '', error: `${file} was not run: the command was interrupted` }); return; }
        const allowance = budget ? budget.deadlineAt - budget.now() : Infinity;
        if (allowance <= 0) { resolve({ exitCode: null, stdout: '', stderr: '', error: `${file} was not run: the command's deadline had passed` }); return; }

        // A released client is witnessed: it leads its own process group and waits for the witness to record it before it
        // runs the tool, so the record exists before the request can reach the manager.
        const witness = options.outlivesCommand ? clientWitnesses.getStore() : undefined;
        let child: ChildProcess;
        try {
          // A released tool leaves the command's process group, so a terminal Ctrl-C meant for the command cannot reach it.
          child = witness
            ? spawn(process.execPath, ['-e', CLIENT_LAUNCHER, JSON.stringify([file, ...args])], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, detached: true })
            : spawn(file, [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: options.outlivesCommand === true });
        } catch (error) {
          resolve({ exitCode: null, stdout: '', stderr: '', error: `${file} could not run: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}` });
          return;
        }
        let stdout = '';
        let stderr = '';
        /** False while a witnessed client waits for its go-ahead; true once it was told (a tool that runs at once is told from the start). */
        let told = witness === undefined;
        /** Why the tool is being ended. Once set, the go-ahead is never given. */
        let endReason: string | null = null;
        let concluded = false;
        /** The witness's publication of this client, once started. No result is reported before it has settled. */
        let publication: Promise<void> | null = null;
        const timers: NodeJS.Timeout[] = [];
        const later = (milliseconds: number, action: () => void) => { timers.push(setTimeout(action, milliseconds)); };
        const abort = () => end('the command was interrupted');

        /**
         * The one place a call ends, and the evidence disposition of every way it can: see `Ending`. The go-ahead is
         * closed first, the client's input is released (a client that was not told then exits without running its
         * tool), and the result is reported only after the witness's publication has settled, so nothing this call
         * started can finish after the command that owns it has released its serialization.
         */
        function conclude(ending: Ending): void {
          if (concluded) return;
          concluded = true;
          for (const timer of timers) clearTimeout(timer);
          budget?.signal?.removeEventListener('abort', abort);
          release(child);
          const output = { stdout, stderr };
          const report = () => resolve(resultOf(file, ending, output));
          if (publication) publication.then(report, report); else report();
        }
        /** End the tool because its time ran out or the command did. A tool that may carry a request is left running. */
        function end(reason: string, command = true): void {
          if (concluded || endReason !== null) return;
          endReason = reason;
          // Never told: nothing reached the manager and nothing is left behind.
          if (!told) { conclude({ kind: 'not-run', reason }); return; }
          if (command && options.outlivesCommand) { conclude({ kind: 'left-running', reason }); return; }
          signalClient('SIGTERM');
          later(TERMINATE_GRACE_MS, () => { signalClient('SIGKILL'); });
          later(GIVE_UP_AFTER_MS, () => { conclude({ kind: 'left-running', reason }); });
        }
        /** A witnessed client is a process group (its launcher and the tool); signalling it signals only the client this call started. */
        function signalClient(signal: NodeJS.Signals): void {
          if (witness && child.pid !== undefined) { try { process.kill(-child.pid, signal); return; } catch { /* the group is gone; address the launcher itself */ } }
          child.kill(signal);
        }
        /**
         * The output passed its bound: stop collecting. A tool that carries a request is not signalled and is not
         * reported as failed, since the bound says nothing about whether it will deliver; it is left running. A client
         * that was never told to run cannot have run anything.
         */
        function overflow(): void {
          stdout = stdout.slice(0, OUTPUT_BOUND);
          stderr = stderr.slice(0, OUTPUT_BOUND);
          if (!told) { endReason ??= 'its output passed the bound'; conclude({ kind: 'not-run', reason: 'its output passed the bound before it was told to run' }); return; }
          if (options.outlivesCommand) { endReason ??= 'its output passed the bound'; conclude({ kind: 'left-running', reason: 'its output passed the bound' }); return; }
          child.kill('SIGKILL');
          conclude({ kind: 'could-not-run', reason: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' });
        }

        const collect = (which: 'stdout' | 'stderr') => (chunk: string) => {
          if (concluded) return;
          if (which === 'stdout') stdout += chunk; else stderr += chunk;
          if (stdout.length > OUTPUT_BOUND || stderr.length > OUTPUT_BOUND) overflow();
        };
        child.stdout!.setEncoding('utf8'); child.stderr!.setEncoding('utf8');
        child.stdout!.on('data', collect('stdout')); child.stderr!.on('data', collect('stderr'));
        child.once('error', error => {
          const reason = (error as NodeJS.ErrnoException).code ?? error.message;
          if (child.pid === undefined) conclude({ kind: 'could-not-run', reason });
          else if (!told) conclude({ kind: 'not-run', reason: `the client failed before it was told to run (${reason})` });
          else conclude({ kind: 'left-running', reason: `the client failed (${reason})` });
        });
        const ended = (code: number | null, signal: NodeJS.Signals | null) => {
          if (!told) conclude({ kind: 'not-run', reason: 'the client ended before it was told to run its tool' });
          else if (code !== null) conclude({ kind: 'exited', code });
          else conclude({ kind: 'left-running', reason: endReason ?? `it was terminated by ${signal ?? 'a signal'}` });
        };
        child.once('close', ended);
        // The client's own exit is its answer even when a process it left behind keeps its output open, which would hold
        // back `close` until the tool timeout; the output gets a short grace to drain first.
        if (witness) child.once('exit', (code, signal) => later(EXIT_DRAIN_MS, () => ended(code, signal)));

        if (witness && child.pid !== undefined) {
          const client = child.pid;
          child.stdin!.on('error', () => undefined);
          publication = (async () => witness.spawned({ pid: client }))().then(() => {
            // The go-ahead needs the evidence on disk and a call that is still open; a late publication releases nothing.
            if (concluded || endReason !== null) return;
            told = true;
            child.stdin!.end('go\n');
          }, (error: unknown) => {
            if (concluded || endReason !== null) return;
            endReason = 'the client could not be recorded';
            conclude({ kind: 'not-run', reason: `the client could not be recorded (${error instanceof Error ? error.message : 'unknown error'})` });
          });
        }
        later(Math.min(options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS, 2 ** 31 - 1), () => end('the tool timeout passed', false));
        if (budget) {
          if (Number.isFinite(allowance)) later(Math.min(allowance, 2 ** 31 - 1), () => end("the command's deadline passed"));
          budget.signal?.addEventListener('abort', abort, { once: true });
        }
      });
    },
  };
}

export interface ServiceIdentity {
  manager: 'launchd' | 'systemd';
  /** The launchd label or the systemd unit name; it is also the managed lifecycle identity. */
  label: string;
  /** Owned service definition in Heimdall private storage. */
  definitionPath: string;
}

export interface ServiceInspection {
  /** `unknown` whenever the manager's answer was not recognized. */
  registration: 'loaded' | 'not-loaded' | 'unknown';
  /** False only when absence is proven: not registered, or registered with a recognized stopped state. */
  running: boolean | 'unknown';
  pid: number | null;
  lastExitStatus: number | null;
  /** The definition file the manager reports for the loaded label. */
  registeredPath: string | null;
  detail: string;
}

export type ServiceConflictCode =
  | 'foreign-definition'
  | 'registered-elsewhere'
  | 'running-context-changed'
  | 'inactive-registration-stale'
  | 'state-unknown'
  | 'manager-unavailable';

export interface ServiceConflict {
  code: ServiceConflictCode;
  message: string;
  /** What the owner can do next. The adapter does not perform it. */
  action: string;
  /** Launch context elements that differ, when the conflict is a changed context. */
  changes?: string[];
}

export interface InstallResult {
  outcome: 'created' | 'refreshed' | 'unchanged' | 'conflict' | 'failed';
  /** True only when this call registered the definition with the manager. */
  registered: boolean;
  conflicts: ServiceConflict[];
  detail: string;
}

export interface StartResult {
  outcome: 'started' | 'already-running' | 'conflict' | 'failed';
  conflicts: ServiceConflict[];
  detail: string;
  /** On `failed`: the start tool did not finish, so the manager may still act on a request it already received. */
  unresolved?: boolean;
}

export interface CleanupResult {
  outcome: 'removed' | 'nothing-to-remove' | 'refused';
  detail: string;
}

/** The nonsecret references an owned service definition remembers; an absent or foreign definition remembers none. */
export type RememberedContext =
  | { kind: 'absent' }
  | { kind: 'owned'; credentialFile: string | null; openchamberDataDirectory: string | null }
  | { kind: 'foreign'; reason: string };

/** Whether the registration the manager reports resolves to the definition Heimdall owns. */
export type RegistrationOwnership =
  | { kind: 'owned' }
  | { kind: 'refused'; code: 'registered-elsewhere' | 'foreign-definition' | 'state-unknown'; reason: string };

/**
 * Native service manager adapter. Methods only ever start the service on `start`; nothing here sends a stop,
 * kill or restart request, and a loaded running definition is never replaced.
 */
export interface NativeServiceAdapter {
  identity(): ServiceIdentity;
  /** The definition text for the current launch context. */
  render(): string;
  /** Read the credential file and OpenChamber data directory references stored in the owned definition, changing nothing. */
  remembered(): Promise<RememberedContext>;
  /** Where the service's process output can be read, for diagnostics. Touches nothing. */
  logLocation(): string;
  /** Read manager state without starting, stopping or changing anything. */
  inspect(): Promise<ServiceInspection>;
  /**
   * Whether the manager still has a start request of the owned service queued. Absent for a manager that cannot
   * report queued requests; `unknown` when the answer was not recognized. Changes nothing.
   */
  startJobPending?(): Promise<boolean | 'unknown'>;
  /**
   * Positive ownership evidence for the registration an inspection reports as loaded: the reported definition path
   * resolves (canonical path and link handling) to the owned definition and that definition is a valid Heimdall
   * definition for this state directory. A missing, different or unreadable definition is refused. Changes nothing.
   */
  registrationOwnership(inspection: ServiceInspection): Promise<RegistrationOwnership>;
  /** Write the owned definition when needed and register it when it is not loaded. */
  install(): Promise<InstallResult>;
  /** Explicitly start a registered definition that is not running. */
  start(): Promise<StartResult>;
  /**
   * Unregister an owned definition whose process is proven absent so a changed definition can be installed.
   * Never signals a process and refuses unless inspection proves the service is not running.
   */
  unloadInactive(): Promise<CleanupResult>;
  /** Fixture and test cleanup only: unloads and deletes the owned definition when the service is proven stopped. */
  cleanupFixture(): Promise<CleanupResult>;
}

/** One manager inspection together with what it proves about the registration's ownership. */
export type NativeOwnership =
  | { kind: 'owned'; inspection: ServiceInspection }
  | { kind: 'not-loaded'; inspection: ServiceInspection }
  | { kind: 'refused'; code: 'registered-elsewhere' | 'foreign-definition' | 'state-unknown'; reason: string; inspection: ServiceInspection };

/** Inspect the service and decide whether a loaded registration is the one Heimdall owns. Starts, stops and changes nothing. */
export async function inspectOwnership(adapter: NativeServiceAdapter): Promise<NativeOwnership> {
  const inspection = await adapter.inspect();
  if (inspection.registration === 'unknown') return { kind: 'refused', code: 'state-unknown', reason: inspection.detail, inspection };
  if (inspection.registration === 'not-loaded') return { kind: 'not-loaded', inspection };
  const registration = await adapter.registrationOwnership(inspection);
  return registration.kind === 'owned' ? { kind: 'owned', inspection } : { ...registration, inspection };
}

export type OwnedProcess =
  | { kind: 'process'; pid: number; inspection: ServiceInspection }
  | { kind: 'refused'; code: 'registered-elsewhere' | 'foreign-definition' | 'state-unknown'; reason: string; inspection: ServiceInspection };

/**
 * A process is the owned service's only with all of: an owned loaded registration, a recognized running main process,
 * and a positive process id equal to the authenticated coordinator instance's. An absent, unknown or different
 * value is never ownership.
 */
export function confirmOwnedProcess(ownership: NativeOwnership, expectedPid: number, label: string): OwnedProcess {
  const { inspection } = ownership;
  if (ownership.kind === 'refused') return ownership;
  if (ownership.kind === 'not-loaded') return { kind: 'refused', code: 'registered-elsewhere', reason: `${label} is not registered with the service manager`, inspection };
  if (inspection.running === 'unknown') return { kind: 'refused', code: 'state-unknown', reason: `whether ${label} is running could not be determined (${inspection.detail})`, inspection };
  if (inspection.running === false) return { kind: 'refused', code: 'registered-elsewhere', reason: `${label} is not running`, inspection };
  if (inspection.pid === null || !Number.isInteger(inspection.pid) || inspection.pid <= 0) {
    return { kind: 'refused', code: 'state-unknown', reason: `${label} is running but the service manager reports no main process id`, inspection };
  }
  if (inspection.pid !== expectedPid) return { kind: 'refused', code: 'registered-elsewhere', reason: `${label} is running process ${inspection.pid}, not ${expectedPid}`, inspection };
  return { kind: 'process', pid: inspection.pid, inspection };
}

export interface LaunchResult {
  outcome: StartResult['outcome'] | 'install-conflict' | 'install-failed' | 'abandoned' | 'unrecorded';
  install: InstallResult;
  start: StartResult | null;
  /** On `unrecorded`: why the launch attempt could not be recorded. No start was requested. */
  recordFailure?: string;
}

/**
 * Durable evidence of a launch attempt, supplied by the caller. `write` runs after the last chance to abandon the
 * launch and before the start can be requested; a start is never requested when it fails. `finished` receives the
 * outcome of a request that was made, before the launch reports it.
 */
export interface LaunchRecord {
  write(): Promise<void>;
  /** Called when the launch was abandoned after `write`, so the record of a request that never happened is removed. */
  discard(): Promise<void>;
  finished(start: StartResult): Promise<void>;
}

/**
 * Where a launch stands, shared with whoever may give up waiting for it. `abandoned` is only honoured while the launch
 * is still installing: once `start()` was called the request is issued and cannot be taken back.
 */
export interface LaunchProgress {
  phase: 'installing' | 'starting' | 'done';
  abandoned: boolean;
  record?: LaunchRecord;
}

export const createLaunchProgress = (record?: LaunchRecord): LaunchProgress => ({ phase: 'installing', abandoned: false, ...(record ? { record } : {}) });

/**
 * Give up on a launch that has not yet requested the start. Returns true when it will now never request one, false
 * when the start was already issued (or the launch finished) and stays unconfirmed.
 */
export function abandonLaunch(progress: LaunchProgress): boolean {
  if (progress.phase !== 'installing') return false;
  progress.abandoned = true;
  return true;
}

/**
 * Explicit start: install (register when unloaded), then start without any kill-existing option. With `progress`, the
 * start is requested only if the launch was not abandoned while the install was under way. The check and the phase
 * change are one synchronous step, so a launch is either abandoned before its start request or issued before it.
 */
export async function launchNativeService(adapter: NativeServiceAdapter, progress?: LaunchProgress): Promise<LaunchResult> {
  const install = await adapter.install();
  if (install.outcome === 'conflict') { if (progress) progress.phase = 'done'; return { outcome: 'install-conflict', install, start: null }; }
  if (install.outcome === 'failed') { if (progress) progress.phase = 'done'; return { outcome: 'install-failed', install, start: null }; }
  if (progress?.abandoned) { progress.phase = 'done'; return { outcome: 'abandoned', install, start: null }; }
  if (progress?.record) {
    // Still `installing`: the caller can abandon the launch while the record is being written.
    try { await progress.record.write(); }
    catch (error) {
      progress.phase = 'done';
      return { outcome: 'unrecorded', install, start: null, recordFailure: error instanceof Error ? error.message : 'unknown error' };
    }
    if (progress.abandoned) {
      progress.phase = 'done';
      await progress.record.discard().catch(() => undefined);
      return { outcome: 'abandoned', install, start: null };
    }
  }
  if (progress) progress.phase = 'starting';
  try {
    const start = await adapter.start();
    await progress?.record?.finished(start).catch(() => undefined);
    return { outcome: start.outcome, install, start };
  } finally { if (progress) progress.phase = 'done'; }
}
