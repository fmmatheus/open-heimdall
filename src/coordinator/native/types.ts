import { execFile } from 'node:child_process';
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
  /** True when the tool started but was ended before it finished, so the request it carried may still take effect. */
  timedOut?: boolean;
}

/** Runs a native tool with an argument array. Implementations never use a shell and never throw for a nonzero exit. */
export interface CommandRunner {
  run(file: string, args: readonly string[], options?: { timeoutMs?: number }): Promise<CommandResult>;
}

const DEFAULT_TOOL_TIMEOUT_MS = 15000;
const OUTPUT_BOUND = 1024 * 1024;

export function createExecFileRunner(): CommandRunner {
  return {
    run(file, args, options = {}) {
      return new Promise(resolve => {
        execFile(file, [...args], { encoding: 'utf8', timeout: options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS, maxBuffer: OUTPUT_BOUND, windowsHide: true }, (error, stdout, stderr) => {
          if (!error) { resolve({ exitCode: 0, stdout, stderr }); return; }
          const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
          if (typeof failure.code === 'number') { resolve({ exitCode: failure.code, stdout: stdout ?? '', stderr: stderr ?? '' }); return; }
          resolve({ exitCode: null, stdout: stdout ?? '', stderr: stderr ?? '', error: failure.killed ? `${file} did not finish in time` : `${file} could not run: ${failure.code ?? failure.message}`, ...(failure.killed ? { timedOut: true } : {}) });
        });
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
