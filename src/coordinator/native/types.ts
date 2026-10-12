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
          resolve({ exitCode: null, stdout: stdout ?? '', stderr: stderr ?? '', error: failure.killed ? `${file} did not finish in time` : `${file} could not run: ${failure.code ?? failure.message}` });
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

export interface LaunchResult {
  outcome: StartResult['outcome'] | 'install-conflict' | 'install-failed';
  install: InstallResult;
  start: StartResult | null;
}

/** Explicit start: install (register when unloaded), then start without any kill-existing option. */
export async function launchNativeService(adapter: NativeServiceAdapter): Promise<LaunchResult> {
  const install = await adapter.install();
  if (install.outcome === 'conflict') return { outcome: 'install-conflict', install, start: null };
  if (install.outcome === 'failed') return { outcome: 'install-failed', install, start: null };
  const start = await adapter.start();
  return { outcome: start.outcome, install, start };
}
