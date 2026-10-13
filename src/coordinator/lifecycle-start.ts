import fs from 'node:fs/promises';
import path from 'node:path';
import { loadCoordinatorConfiguration } from './config.js';
import type { CoordinatorConfiguration } from './config.js';
import { createCoordinatorClient } from './client.js';
import { CredentialFileError, loadCredentialFile } from './credentials.js';
import { fetchCoordinatorLifecycle } from './lifecycle.js';
import type { CoordinatorLifecycle } from './lifecycle.js';
import { resolveLaunchContext, selectConfigurationFile } from './launch-context.js';
import type { ConfigurationSelection, LaunchContext, LaunchContextOptions } from './launch-context.js';
import { acquireOperationLock, readStopGeneration } from './lifecycle-lock.js';
import type { ParsedLifecycleArguments } from './lifecycle-arguments.js';
import { createLifecycleResult, sanitizeResultText } from './lifecycle-result.js';
import type { LifecycleErrorCode, LifecycleResult, LifecycleResultInput, LifecycleTarget, ObservedInstance } from './lifecycle-result.js';
import { abandonLaunch, confirmOwnedProcess, createLaunchProgress, inspectOwnership, launchNativeService, nativeServiceNames } from './native/types.js';
import type { LaunchResult, NativeOwnership, NativeServiceAdapter, ServiceConflict } from './native/types.js';
import { selectNativeAdapter, selectNativeManager } from './native/platform.js';
import type { NativeAdapterSelection } from './native/platform.js';
import { parseCoordinatorStatus } from './status.js';
import type { CoordinatorStatus } from './status.js';
import { readCoordinatorToken } from './token.js';

/**
 * Everything `start` takes from its surroundings. The command line exposes none of these; tests and the
 * entry point supply them through `coordinatorMain`'s programmatic internals.
 */
export interface LifecycleDependencies {
  environment: NodeJS.ProcessEnv;
  platform: NodeJS.Platform | string;
  now(): number;
  /** Resolves early when `signal` aborts. */
  sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
  /** The native service adapter for the resolved launch context. Production selects launchd or systemd by platform. */
  createAdapter(context: LaunchContext): NativeAdapterSelection;
  /** Installed-package layout seams for the launch context; production resolves both from the running process. */
  launchOverrides: Pick<LaunchContextOptions, 'nodeExecutable' | 'entryPoint'>;
  pollIntervalMs: number;
  /** Upper bound for one coordinator IPC request; the overall deadline still applies. */
  requestTimeoutMs: number;
  /** Progress and diagnostics for the person running the command. Written to stderr. */
  progress(text: string): void;
  /** Aborts the waiting client operation (Ctrl-C). It never reverses a launch that was already requested. */
  signal?: AbortSignal;
  /** `logs` on Linux: absolute journalctl path. Resolved from fixed system locations when omitted. */
  journalctl?: string;
  /** `logs` on Linux: starts the journal reader with an argument array. Defaults to `child_process.spawn`. */
  spawnProcess?: typeof import('node:child_process').spawn;
}

export function sleepUnlessAborted(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted) { resolve(); return; }
    const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

export function defaultLifecycleDependencies(overrides: Partial<LifecycleDependencies> = {}): LifecycleDependencies {
  const platform = overrides.platform ?? process.platform;
  return {
    environment: process.env,
    platform,
    now: Date.now,
    sleep: sleepUnlessAborted,
    createAdapter: context => selectNativeAdapter({ context, platform }),
    launchOverrides: {},
    pollIntervalMs: 100,
    requestTimeoutMs: 5000,
    progress: text => { process.stderr.write(`${text}\n`); },
    ...overrides,
  };
}

/** `dispatched` is false when the deadline or interruption was seen before the action was started, so it never ran. */
export type Bounded<T> = { kind: 'value'; value: T } | { kind: 'timeout'; dispatched: boolean } | { kind: 'aborted'; dispatched: boolean };

/**
 * Starts `action` and waits for it until the overall deadline or an interruption. The deadline and the interruption
 * are checked before the action is created, so an expired or interrupted operation never starts a new action. A late
 * rejection of an abandoned action is ignored.
 */
export function bounded<T>(action: () => Promise<T>, deps: LifecycleDependencies, deadlineAt: number): Promise<Bounded<T>> {
  const remaining = deadlineAt - deps.now();
  if (remaining <= 0) return Promise.resolve({ kind: 'timeout', dispatched: false });
  if (deps.signal?.aborted) return Promise.resolve({ kind: 'aborted', dispatched: false });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (settle: () => void) => { if (settled) return; settled = true; clearTimeout(timer); deps.signal?.removeEventListener('abort', onAbort); settle(); };
    const onAbort = () => finish(() => resolve({ kind: 'aborted', dispatched: true }));
    const timer = setTimeout(() => finish(() => resolve({ kind: 'timeout', dispatched: true })), remaining);
    deps.signal?.addEventListener('abort', onAbort, { once: true });
    let promise: Promise<T>;
    try { promise = action(); } catch (error) { finish(() => reject(error)); return; }
    promise.then(value => finish(() => resolve({ kind: 'value', value })), error => finish(() => reject(error)));
  });
}

/** What remains of the overall deadline for one more request, or why none may be started. */
export type RequestBudget = { kind: 'budget'; client: ReturnType<typeof createCoordinatorClient>; cappedByDeadline: boolean } | { kind: 'expired' } | { kind: 'aborted' };

/**
 * A coordinator client for the next request of an operation with one overall deadline: its allowance is what remains of
 * that deadline (never more than `requestTimeoutMs`), computed now rather than shared with an earlier request. Nothing
 * is created once the deadline has passed or the operation was interrupted, and Ctrl-C ends the request in flight.
 */
export function requestBudget(endpoint: string, key: string, deps: LifecycleDependencies, deadlineAt: number, limitMs = deps.requestTimeoutMs): RequestBudget {
  if (deps.signal?.aborted) return { kind: 'aborted' };
  const remaining = deadlineAt - deps.now();
  if (remaining <= 0) return { kind: 'expired' };
  const milliseconds = Math.max(1, Math.floor(Math.min(remaining, limitMs)));
  return { kind: 'budget', cappedByDeadline: remaining <= limitMs, client: createCoordinatorClient(endpoint, key, { timeoutMs: milliseconds, deadlineMs: milliseconds, signal: deps.signal }) };
}

export type Probe =
  | { kind: 'absent' }
  | { kind: 'answered'; lifecycle: CoordinatorLifecycle; status: CoordinatorStatus | null }
  | { kind: 'problem'; code: LifecycleErrorCode; message: string; transient: boolean }
  /** The overall deadline passed before the probe finished; no further request was started. */
  | { kind: 'expired' }
  /** The operation was interrupted; the request in flight was ended. */
  | { kind: 'aborted' };

export const problem = (code: LifecycleErrorCode, message: string, transient = false): Probe => ({ kind: 'problem', code, message, transient });

export function classifyRequestFailure(error: unknown, endpoint: string): Probe {
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  const message = error instanceof Error ? error.message : 'unknown error';
  if (statusCode === 404) return problem('unsupported-lifecycle-protocol', `The coordinator at ${endpoint} does not support the lifecycle protocol; it was started by an older Heimdall version. Heimdall does not signal or restart it.`);
  if (statusCode === 401 || statusCode === 403) return problem('endpoint-refused', `The coordinator at ${endpoint} refused the coordinator key; it may belong to another state directory or have been replaced.`);
  if (statusCode === 503) return problem('endpoint-transitioning', `The coordinator at ${endpoint} is starting or stopping.`, true);
  if (/^Coordinator (unavailable|request timed out|request exceeded)/.test(message)) return problem('endpoint-unreachable', `Nothing answered at ${endpoint} (${message}). The endpoint may be stale; Heimdall does not remove it or signal any process.`, true);
  return problem('endpoint-invalid', `The coordinator at ${endpoint} returned an invalid lifecycle response: ${message}`);
}

async function endpointExists(endpoint: string): Promise<boolean> {
  if (process.platform === 'win32') return true;
  try { await fs.lstat(endpoint); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/**
 * One authenticated lifecycle request and, for a running coordinator, a status request. Every request takes its
 * allowance from what remains of the overall deadline when it starts, so the pair never outlasts it. With
 * `statusWhenClosing`, a coordinator that is not running is also asked for its status (a failure of that request
 * leaves `status` null). Creates and changes nothing.
 */
export async function probeEndpoint(configuration: CoordinatorConfiguration, deps: LifecycleDependencies, deadlineAt: number, learned: (secret: string) => void, options: { statusWhenClosing?: boolean } = {}): Promise<Probe> {
  let key: string;
  try { key = await readCoordinatorToken(configuration.stateDirectory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return await endpointExists(configuration.endpoint)
        ? problem('endpoint-refused', `An endpoint exists at ${configuration.endpoint} but the coordinator key in ${configuration.stateDirectory} is missing, so its owner cannot be verified. Heimdall does not remove it.`)
        : { kind: 'absent' };
    }
    return problem('state-unknown', `The coordinator key in ${configuration.stateDirectory} cannot be used: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  learned(key);
  if (!await endpointExists(configuration.endpoint)) return { kind: 'absent' };
  /** A request that failed because the shared deadline (not its own limit) ran out, or because of Ctrl-C, ends the probe. */
  const ended = (error: unknown, cappedByDeadline: boolean): Probe | null => {
    if (deps.signal?.aborted) return { kind: 'aborted' };
    const message = error instanceof Error ? error.message : '';
    if (cappedByDeadline && /^Coordinator request (timed out|exceeded)/.test(message)) return { kind: 'expired' };
    return null;
  };
  const first = requestBudget(configuration.endpoint, key, deps, deadlineAt);
  if (first.kind !== 'budget') return first;
  let lifecycle: CoordinatorLifecycle;
  try { lifecycle = await fetchCoordinatorLifecycle(first.client); }
  catch (error) { return ended(error, first.cappedByDeadline) ?? classifyRequestFailure(error, configuration.endpoint); }
  if (lifecycle.stateDirectory !== configuration.stateDirectory || lifecycle.endpoint !== configuration.endpoint) {
    return problem('target-mismatch', `The coordinator at ${configuration.endpoint} reports state ${lifecycle.stateDirectory} and endpoint ${lifecycle.endpoint}, which do not match the selected target.`);
  }
  const closing = lifecycle.phase !== 'running';
  if (closing && !options.statusWhenClosing) return { kind: 'answered', lifecycle, status: null };
  const second = requestBudget(configuration.endpoint, key, deps, deadlineAt);
  if (second.kind !== 'budget') return closing && second.kind === 'expired' ? { kind: 'answered', lifecycle, status: null } : second;
  try { return { kind: 'answered', lifecycle, status: parseCoordinatorStatus(await second.client.request('GET', '/status')) }; }
  catch (error) {
    const stopped = ended(error, second.cappedByDeadline);
    if (stopped) return closing && stopped.kind === 'expired' ? { kind: 'answered', lifecycle, status: null } : stopped;
    return closing ? { kind: 'answered', lifecycle, status: null } : classifyRequestFailure(error, configuration.endpoint);
  }
}

export const observed = (lifecycle: CoordinatorLifecycle): ObservedInstance => ({ instanceId: lifecycle.instanceId, pid: lifecycle.pid, mode: lifecycle.mode });

function fromConflicts(conflicts: ServiceConflict[], fallback: string): { outcome: 'conflict' | 'failed'; code: LifecycleErrorCode; message: string } {
  const first = conflicts[0];
  if (!first) return { outcome: 'failed', code: 'launch-failed', message: fallback };
  const detail = `${first.message} ${first.action}`.trim();
  if (first.code === 'manager-unavailable') return { outcome: 'failed', code: 'manager-unavailable', message: detail };
  return { outcome: 'conflict', code: first.code, message: detail };
}

export const errorText = (error: unknown) => error instanceof Error ? error.message : 'unknown error';

/**
 * `heimdall coordinator start`: serialize with other lifecycle operations for the same target, recognize an
 * existing coordinator without changing it, otherwise explicitly start the native service and wait, within one
 * deadline, until the launched instance answers authenticated lifecycle and status requests.
 *
 * It never throws; every outcome is a result. It does not write coordinator or project configuration, remove
 * endpoints, signal processes or stop services.
 */
export async function runCoordinatorStart(args: ParsedLifecycleArguments, deps: LifecycleDependencies): Promise<LifecycleResult> {
  const deadlineAt = deps.now() + args.timeoutSeconds * 1000;
  const secrets = new Set<string>();
  let target: LifecycleTarget | null = null;
  const finish = (input: Omit<LifecycleResultInput, 'command'>) => createLifecycleResult({ command: 'start', target, ...input }, secrets);
  const failed = (code: LifecycleErrorCode, message: string, extra: Partial<Omit<LifecycleResultInput, 'command'>> = {}) =>
    finish({ outcome: 'failed', message, error: { code, message }, ...extra });
  const progress = (text: string) => deps.progress(sanitizeResultText(text, secrets));
  try {
    let selection: ConfigurationSelection;
    let configuration: CoordinatorConfiguration;
    try {
      selection = selectConfigurationFile(args.coordinatorConfig, deps.environment);
      configuration = await loadCoordinatorConfiguration(selection.file, { implicitDefault: selection.origin === 'implicit-default' });
    } catch (error) {
      const message = `Cannot load the coordinator configuration: ${errorText(error)}`;
      return failed('invalid-configuration', message);
    }
    const manager = selectNativeManager(deps.platform);
    const names = nativeServiceNames(configuration.stateDirectory);
    const label = !manager.supported ? null : manager.manager === 'launchd' ? names.launchdLabel : names.systemdUnit;
    target = { configFile: selection.file, origin: selection.origin, stateDirectory: configuration.stateDirectory, endpoint: configuration.endpoint, manager: manager.supported ? manager.manager : null, label };

    let explicitCredentialFile: string | null = null;
    if (args.envFile !== undefined) {
      explicitCredentialFile = path.resolve(args.envFile);
      try { for (const value of (await loadCredentialFile(explicitCredentialFile)).values()) secrets.add(value); }
      catch (error) { return failed('invalid-credentials', `The credential file cannot be used, so no service was started: ${errorText(error)}`); }
    }

    const generation = await readStopGeneration(configuration.stateDirectory).catch((error: unknown) => error as Error);
    if (generation instanceof Error) return failed('state-unknown', `The lifecycle state in ${configuration.stateDirectory} cannot be used: ${generation.message}`);
    let lock;
    try {
      lock = await acquireOperationLock(configuration.stateDirectory, {
        deadlineAt, now: deps.now, sleep: milliseconds => deps.sleep(milliseconds, deps.signal), signal: deps.signal,
        onWaiting: () => progress('Another lifecycle operation is running for this coordinator; waiting for it to finish.'),
      });
    } catch (error) { return failed('state-unknown', `The lifecycle lock in ${configuration.stateDirectory} cannot be used: ${errorText(error)}`); }
    if (!lock.acquired) {
      if (lock.reason === 'aborted') return failed('interrupted', 'Interrupted while waiting for another lifecycle operation. Nothing was started.');
      return finish({ outcome: 'busy', message: 'Another lifecycle operation for this coordinator did not finish before the startup deadline. Nothing was started; retry the command.', error: { code: 'busy', message: 'Another lifecycle operation holds the lock for this coordinator' } });
    }
    /**
     * The native call this start left running after giving up on it (deadline or interruption). The operation lock is
     * kept until it settles, so no other lifecycle operation overlaps a late definition change or an issued launch.
     */
    const pendingNativeCall: { settled: Promise<unknown> | null } = { settled: null };
    try {
      let current: number;
      try { current = await readStopGeneration(configuration.stateDirectory); }
      catch (error) { return failed('state-unknown', `The lifecycle state in ${configuration.stateDirectory} cannot be used: ${errorText(error)}. Nothing was started.`); }
      if (current !== generation) {
        return finish({ outcome: 'conflict', message: 'A stop was requested or confirmed while this start was waiting, so it did not start the coordinator. Run start again to start it explicitly.', error: { code: 'superseded-by-stop', message: 'A stop was requested while this start was waiting' } });
      }
      return await startLocked();
    } finally {
      const release = () => lock.lock.release();
      if (pendingNativeCall.settled) void pendingNativeCall.settled.then(release, release);
      else release();
    }

    async function startLocked(): Promise<LifecycleResult> {
      let context: LaunchContext | undefined;
      let adapter: NativeServiceAdapter | undefined;
      const prepare = async (credentialFile: string | null): Promise<LifecycleResult | undefined> => {
        try {
          context = await resolveLaunchContext({ coordinatorConfig: args.coordinatorConfig, ...(credentialFile === null ? {} : { envFile: credentialFile }), ...deps.launchOverrides }, deps.environment);
        } catch (error) {
          if (error instanceof CredentialFileError) return failed('invalid-credentials', `The credential file cannot be used, so no service was started: ${error.message}`);
          return failed('invalid-launch-context', `The service launch context cannot be resolved, so no service was started: ${errorText(error)}`);
        }
        const selected = deps.createAdapter(context);
        if (!selected.supported) return failed('unsupported-platform', selected.message);
        adapter = selected.adapter;
        return undefined;
      };

      const first = await settleProbe();
      if (first.kind === 'timeout') return finish({ outcome: 'conflict', message: first.message, error: { code: first.code, message: first.message } });
      if (first.kind === 'aborted') return failed('interrupted', 'Interrupted before the coordinator was started. Nothing was started.');
      const probe = first.probe;
      if (probe.kind === 'problem') {
        const message = `${probe.message} Nothing was started or changed.`;
        return finish({ outcome: 'conflict', message, error: { code: probe.code, message } });
      }
      if (probe.kind === 'answered') {
        const recognized = await handleAnswered(probe.lifecycle, probe.status);
        // Recognition that finished only after the deadline is not reported as a success.
        return recognized.ok && deadlineAt - deps.now() <= 0 ? deadlineBeforeAction('verified the running coordinator') : recognized;
      }

      // No coordinator answers: an explicit start. A remembered credential reference is reused when none is given.
      const unprepared = await prepare(null);
      if (unprepared) return unprepared;
      const remembered = await adapter!.remembered().catch((error: unknown) => ({ kind: 'foreign' as const, reason: errorText(error) }));
      if (remembered.kind === 'foreign') {
        const message = `A service definition for this coordinator exists but is not owned by Heimdall: ${remembered.reason}. Inspect or move it yourself; Heimdall will not overwrite or load it.`;
        return finish({ outcome: 'conflict', message, error: { code: 'foreign-definition', message } });
      }
      const credentialFile = explicitCredentialFile ?? (remembered.kind === 'owned' ? remembered.credentialFile : null);
      if (credentialFile !== null) {
        if (explicitCredentialFile === null) {
          try { for (const value of (await loadCredentialFile(credentialFile)).values()) secrets.add(value); } catch { /* resolveLaunchContext reports the reason. */ }
        }
        const prepared = await prepare(credentialFile);
        if (prepared) {
          if (explicitCredentialFile === null && prepared.error?.code === 'invalid-credentials') {
            const message = `The credential file remembered by the service definition cannot be used, so no service was started: ${prepared.error.message.replace(/^The credential file cannot be used, so no service was started: /, '')} Fix the file or pass --env-file FILE.`;
            return failed('invalid-credentials', message);
          }
          return prepared;
        }
      }

      progress(`Starting the coordinator through ${target!.manager} (${target!.label}).`);
      const launchProgress = createLaunchProgress();
      let call: Promise<LaunchResult> | undefined;
      const launched = await bounded(() => (call = launchNativeService(adapter!, launchProgress)), deps, deadlineAt).catch((error: unknown) => ({ kind: 'error' as const, error }));
      if (launched.kind === 'error') return failed('launch-failed', `The service manager call failed: ${errorText(launched.error)}`, { logs: logsHint() });
      // Seen before the launch was started: nothing was requested, so nothing may have started either.
      if (launched.kind === 'aborted' && !launched.dispatched) return failed('interrupted', 'Interrupted before the coordinator was started. Nothing was started.');
      if (launched.kind === 'timeout' && !launched.dispatched) return deadlineBeforeAction('started the service');
      if (launched.kind === 'aborted' || launched.kind === 'timeout') {
        // The native call keeps running. The lock stays held until it settles, and a call that is still installing
        // is told never to request the start; one that already requested it stays unconfirmed and is not undone.
        pendingNativeCall.settled = call!.catch(() => undefined);
        if (abandonLaunch(launchProgress)) {
          if (launched.kind === 'aborted') return failed('interrupted', 'Interrupted while the service definition was being installed. No start was requested and none will be; the installation under way finishes without launching the coordinator. Run start again to start it.', { logs: logsHint() });
          const message = 'The startup deadline passed while the service definition was being installed. No start was requested and none will be; the installation under way finishes without launching the coordinator. Retry the command.';
          return finish({ outcome: 'conflict', message, error: { code: 'deadline-exceeded', message }, logs: logsHint() });
        }
        if (launched.kind === 'aborted') return finish({ outcome: 'startup-not-confirmed', message: 'Interrupted while starting the service. The launch may already have been requested; check with `heimdall coordinator status`.', error: { code: 'interrupted', message: 'Interrupted while starting the service' }, logs: logsHint() });
        const message = 'The service manager did not finish within the startup deadline. The coordinator may still start.';
        return finish({ outcome: 'startup-not-confirmed', message, error: { code: 'startup-timeout', message }, logs: logsHint() });
      }
      const launch = launched.value;
      if (launch.outcome === 'abandoned') return failed('internal', 'The launch was abandoned without a request to give up on it');
      if (launch.outcome === 'install-conflict' || launch.outcome === 'conflict') {
        const mapped = fromConflicts(launch.outcome === 'conflict' ? launch.start?.conflicts ?? [] : launch.install.conflicts, launch.start?.detail ?? launch.install.detail);
        return finish({ outcome: mapped.outcome, message: mapped.message, error: { code: mapped.code, message: mapped.message }, logs: mapped.outcome === 'failed' ? undefined : logsHint() });
      }
      if (launch.outcome === 'install-failed' || launch.outcome === 'failed') {
        const conflicts = launch.outcome === 'failed' ? launch.start?.conflicts ?? [] : launch.install.conflicts;
        if (conflicts[0]?.code === 'manager-unavailable') {
          const mapped = fromConflicts(conflicts, 'The service manager is unavailable');
          return failed('manager-unavailable', `${mapped.message} No service was started.`);
        }
        const message = `The service manager could not start the coordinator: ${launch.start?.detail ?? launch.install.detail}`;
        return failed('launch-failed', message, { logs: logsHint() });
      }
      return await awaitReadiness();

      function logsHint() { return adapter ? `Process logs: ${adapter.logLocation()}` : undefined; }

      async function awaitReadiness(): Promise<LifecycleResult> {
        progress(`Waiting up to ${args.timeoutSeconds} seconds for the coordinator to become ready.`);
        let observation = 'No coordinator has answered yet.';
        let absentChecks = 0;
        let ownership: NativeOwnership | null = null;
        while (true) {
          if (deps.signal?.aborted) return interruptedWaiting();
          if (deadlineAt - deps.now() <= 0) break;
          // Each pass starts without evidence: an unreadable manager state never carries over as ownership.
          ownership = null;
          const inspected = await bounded(() => inspectOwnership(adapter!), deps, deadlineAt).catch(() => ({ kind: 'timeout' as const }));
          if (inspected.kind === 'value') {
            ownership = inspected.value;
            const inspection = ownership.inspection;
            absentChecks = inspection.running === false ? absentChecks + 1 : 0;
            if (absentChecks >= 3) {
              const status = inspection.lastExitStatus === null ? '' : ` (last exit status ${inspection.lastExitStatus})`;
              const message = `The service exited before the coordinator became ready${status}. Nothing was changed after the exit. ${inspection.detail}`;
              return finish({ outcome: 'startup-not-confirmed', message, error: { code: 'service-exited', message }, logs: logsHint() });
            }
          }
          const answer = await probeEndpoint(configuration, deps, deadlineAt, secret => secrets.add(secret)).catch((error: unknown) => problem('state-unknown', `The endpoint could not be checked: ${errorText(error)}`, true));
          if (answer.kind === 'aborted') return interruptedWaiting();
          if (answer.kind === 'expired') break;
          if (answer.kind === 'absent') observation = 'The coordinator endpoint does not exist yet.';
          else if (answer.kind === 'problem') {
            if (!answer.transient) return finish({ outcome: 'conflict', message: `${answer.message} The launch was requested and may still start.`, error: { code: answer.code, message: answer.message }, logs: logsHint() });
            observation = answer.message;
          } else {
            const lifecycle = answer.lifecycle;
            const expected = lifecycle.mode === 'managed' && lifecycle.manager === label;
            if (!expected) {
              const message = `An unexpected coordinator instance answered (${lifecycle.mode}${lifecycle.manager ? `, ${lifecycle.manager}` : ''}), not the service that was started.`;
              return finish({ outcome: 'conflict', message, error: { code: 'target-mismatch', message }, instance: observed(lifecycle), logs: logsHint() });
            }
            if (lifecycle.phase !== 'running') return shutdownInProgress(lifecycle);
            // Readiness needs the answering instance to be the owned service's own main process. An answering
            // endpoint with no manager evidence, or evidence that is unknown or points elsewhere, is not ready.
            if (ownership === null) observation = 'The coordinator answered, but the service manager state could not be read, so the answering instance is not confirmed to be the started service.';
            else if (ownership.kind === 'refused' && ownership.code !== 'state-unknown') {
              const message = `The coordinator answered, but the service manager does not confirm it as the started service: ${ownership.reason}. Heimdall changed nothing. The launch was requested and may still start.`;
              return finish({ outcome: 'conflict', message, error: { code: ownership.code, message }, instance: observed(lifecycle), logs: logsHint() });
            } else {
              const confirmed = confirmOwnedProcess(ownership, lifecycle.pid, label!);
              if (confirmed.kind === 'refused') observation = `The coordinator answered with process ${lifecycle.pid}, but it is not confirmed as the started service: ${confirmed.reason}.`;
              else if (deadlineAt - deps.now() <= 0) observation = 'The coordinator answered only after the startup deadline.';
              else if (answer.status?.status === 'running' && answer.status.acceptingNewRuns) {
                return finish({ outcome: 'ready', message: 'Coordinator started and ready. Readiness confirms coordinator IPC only; it does not check OpenCode connectivity, credentials or quota.', instance: observed(lifecycle) });
              } else observation = 'The coordinator answered but is not yet running and accepting runs.';
            }
          }
          await deps.sleep(Math.max(1, Math.min(deps.pollIntervalMs, deadlineAt - deps.now())), deps.signal);
        }
        const message = `Readiness was not confirmed within ${args.timeoutSeconds} seconds. ${observation} The service was started and may still become ready; Heimdall did not stop it.`;
        return finish({ outcome: 'startup-not-confirmed', message, error: { code: 'startup-timeout', message }, logs: logsHint() });

        function interruptedWaiting(): LifecycleResult {
          return finish({ outcome: 'startup-not-confirmed', message: `Interrupted while waiting. The service was started and keeps running or starting; it was not stopped. ${observation}`, error: { code: 'interrupted', message: 'Interrupted while waiting for readiness' }, logs: logsHint() });
        }
      }
    }

    async function settleProbe(): Promise<{ kind: 'probe'; probe: Probe } | { kind: 'timeout'; message: string; code: LifecycleErrorCode } | { kind: 'aborted' }> {
      while (true) {
        if (deps.signal?.aborted) return { kind: 'aborted' };
        let probe: Probe;
        try { probe = await probeEndpoint(configuration, deps, deadlineAt, secret => secrets.add(secret)); }
        catch (error) { probe = problem('state-unknown', `The endpoint could not be checked: ${errorText(error)}`); }
        if (probe.kind === 'aborted') return { kind: 'aborted' };
        if (probe.kind === 'expired') return { kind: 'timeout', code: 'deadline-exceeded', message: 'The coordinator did not answer within the startup deadline. Nothing was started or changed.' };
        // An unreachable endpoint that still exists is stale or unknown; only a coordinator that is starting or closing may settle.
        if (probe.kind === 'problem' && probe.code === 'endpoint-unreachable') probe = { ...probe, transient: false };
        if (probe.kind !== 'problem' || !probe.transient) return { kind: 'probe', probe };
        if (deadlineAt - deps.now() <= 0) return { kind: 'timeout', code: 'endpoint-transitioning', message: `${probe.message} It did not settle before the startup deadline. Nothing was started or changed.` };
        await deps.sleep(Math.max(1, Math.min(deps.pollIntervalMs, deadlineAt - deps.now())), deps.signal);
      }
    }

    /** The overall deadline passed before `step` finished; nothing was changed by this command, so this is not a pending startup. */
    function deadlineBeforeAction(step: string, instance?: ObservedInstance): LifecycleResult {
      const message = `The startup deadline passed before this command ${step}. Nothing was started or changed; retry the command.`;
      return finish({ outcome: 'conflict', message, error: { code: 'deadline-exceeded', message }, ...(instance ? { instance } : {}) });
    }

    function shutdownInProgress(lifecycle: CoordinatorLifecycle): LifecycleResult {
      const detail = lifecycle.shutdown?.error ? ` The drain failed: ${lifecycle.shutdown.error}.` : '';
      const message = `The coordinator is shutting down (${lifecycle.phase}); it was not restarted and admission was not re-enabled.${detail} Wait for it to stop, then run start again.`;
      return finish({ outcome: 'shutdown-in-progress', message, error: { code: 'shutdown-in-progress', message }, instance: observed(lifecycle) });
    }

    async function handleAnswered(lifecycle: CoordinatorLifecycle, status: CoordinatorStatus | null): Promise<LifecycleResult> {
      if (lifecycle.phase !== 'running') return shutdownInProgress(lifecycle);
      if (status?.status !== 'running' || !status.acceptingNewRuns) {
        const message = 'The coordinator reports a running lifecycle phase but does not accept new runs; it was left unchanged.';
        return finish({ outcome: 'conflict', message, error: { code: 'endpoint-not-ready', message }, instance: observed(lifecycle) });
      }
      if (lifecycle.mode === 'foreground') {
        const note = args.envFile === undefined ? '' : ' --env-file applies only to a managed start; the foreground coordinator keeps the credentials it started with.';
        return finish({ outcome: 'already-running-foreground', message: `A foreground coordinator is already running for this target. No service was registered or changed; Heimdall does not manage it.${note}`, instance: observed(lifecycle) });
      }
      if (lifecycle.manager !== label) {
        const message = `A managed coordinator for this target is registered as ${lifecycle.manager}, not ${label}. It was left unchanged.`;
        return finish({ outcome: 'conflict', message, error: { code: 'foreign-registration', message }, instance: observed(lifecycle) });
      }
      let context: LaunchContext;
      try { context = await resolveLaunchContext({ coordinatorConfig: args.coordinatorConfig, ...deps.launchOverrides }, deps.environment); }
      catch (error) { return failed('invalid-launch-context', `The managed coordinator is running but its service cannot be verified: ${errorText(error)}`, { instance: observed(lifecycle) }); }
      const selected = deps.createAdapter(context);
      if (!selected.supported) return failed('unsupported-platform', selected.message, { instance: observed(lifecycle) });
      const adapter = selected.adapter;
      const instance = observed(lifecycle);
      // An answering endpoint, a disk definition or a process id alone never establishes ownership: the loaded
      // registration must resolve to the owned definition and run exactly this instance's process.
      const inspected = await bounded(() => inspectOwnership(adapter), deps, deadlineAt).catch((error: unknown) => ({ kind: 'error' as const, error }));
      if (inspected.kind === 'aborted') return failed('interrupted', 'Interrupted while verifying the running coordinator. Nothing was started or changed.', { instance });
      if (inspected.kind === 'timeout') return deadlineBeforeAction('verified the running coordinator', instance);
      if (inspected.kind !== 'value') {
        const message = `The service manager could not confirm the running coordinator: ${errorText(inspected.error)}. It was left unchanged.`;
        return finish({ outcome: 'conflict', message, error: { code: 'state-unknown', message }, instance });
      }
      const confirmed = confirmOwnedProcess(inspected.value, lifecycle.pid, label!);
      if (confirmed.kind === 'refused') {
        const message = confirmed.code === 'foreign-definition'
          ? `The running managed coordinator has no definition owned by Heimdall (${confirmed.reason}). It was left unchanged.`
          : `A coordinator answered as a managed instance, but ${confirmed.reason}. It was left unchanged.`;
        return finish({ outcome: 'conflict', message, error: { code: confirmed.code, message }, instance });
      }
      const remembered = await adapter.remembered().catch((error: unknown) => ({ kind: 'foreign' as const, reason: errorText(error) }));
      if (remembered.kind !== 'owned') {
        const message = `The running managed coordinator has no definition owned by Heimdall${remembered.kind === 'foreign' ? ` (${remembered.reason})` : ''}. It was left unchanged.`;
        return finish({ outcome: 'conflict', message, error: { code: 'foreign-definition', message }, instance });
      }
      if (explicitCredentialFile !== null) {
        const requested = await fs.realpath(explicitCredentialFile).catch(() => explicitCredentialFile!);
        if (requested !== remembered.credentialFile) {
          const message = `The running coordinator was started ${remembered.credentialFile ? `with credential file ${remembered.credentialFile}` : 'without a credential file'}; --env-file selects ${requested}. Running services are not changed: stop the coordinator, then start it again with the new file.`;
          return finish({ outcome: 'conflict', message, error: { code: 'credential-conflict', message }, instance });
        }
      }
      const rawData = deps.environment.OPENCHAMBER_DATA_DIR;
      if (typeof rawData === 'string' && rawData.trim()) {
        const requested = path.resolve(rawData.trim());
        if (requested !== remembered.openchamberDataDirectory) {
          const message = `The running coordinator uses ${remembered.openchamberDataDirectory ? `OpenChamber data directory ${remembered.openchamberDataDirectory}` : 'no OpenChamber data directory selection'}; OPENCHAMBER_DATA_DIR selects ${requested}. Running services are not changed: stop the coordinator, then start it again.`;
          return finish({ outcome: 'conflict', message, error: { code: 'data-directory-conflict', message }, instance });
        }
      }
      return finish({ outcome: 'already-running', message: 'Coordinator already running (managed); nothing was changed.', instance });
    }
  } catch (error) {
    return failed('internal', `Unexpected failure: ${errorText(error)}`);
  }
}
