import fs from 'node:fs/promises';
import { loadCoordinatorConfiguration } from './config.js';
import type { CoordinatorConfiguration } from './config.js';
import { readInstanceRecord, readShutdownRecord, requestCoordinatorShutdown } from './lifecycle.js';
import type { CoordinatorLifecycle, ShutdownAcknowledgement, ShutdownRecord } from './lifecycle.js';
import { resolveLaunchContext, selectConfigurationFile } from './launch-context.js';
import type { ConfigurationSelection, LaunchContext } from './launch-context.js';
import { acquireOperationLock, advanceStopGeneration } from './lifecycle-lock.js';
import { assessLaunchAttempt, clearLandedAttempt, launchMayStillDeliver, readLaunchAttempt, unresolvedLaunchMessage } from './lifecycle-launch.js';
import type { ParsedLifecycleArguments } from './lifecycle-arguments.js';
import { createLifecycleResult, sanitizeResultText } from './lifecycle-result.js';
import type { LifecycleErrorCode, LifecycleResult, LifecycleResultInput, LifecycleTarget, ObservedInstance } from './lifecycle-result.js';
import { bounded, errorText, observed, probeEndpoint, problem, requestBudget } from './lifecycle-start.js';
import type { LifecycleDependencies, Probe } from './lifecycle-start.js';
import { selectNativeManager } from './native/platform.js';
import { confirmOwnedProcess, inspectOwnership, nativeServiceNames, withCommandBudget } from './native/types.js';
import type { NativeServiceAdapter, ServiceInspection } from './native/types.js';
import { probeCoordinatorOwnership } from './ownership.js';

type Exit =
  | { kind: 'clean' }
  | { kind: 'pending'; observation: string }
  | { kind: 'final'; result: LifecycleResult };

/**
 * `heimdall coordinator stop`: serialize with other lifecycle operations for the same target, verify that the
 * answering coordinator is the managed service Heimdall owns, send one authenticated drain request naming that
 * instance, and (by default) wait within one deadline for completion evidence of that instance, a clean exit of the
 * service's main process and a released ownership lock.
 *
 * It never throws and never stops, kills, restarts or unregisters anything, deletes state or sends a signal. A wait
 * that ends early (deadline, Ctrl-C) leaves the coordinator draining.
 */
export function runCoordinatorStop(args: ParsedLifecycleArguments, deps: LifecycleDependencies): Promise<LifecycleResult> {
  const deadlineAt = deps.now() + args.timeoutSeconds * 1000;
  // Every native tool call of this command is bound by the same deadline and Ctrl-C, so none outlives the wait.
  return withCommandBudget({ deadlineAt, now: deps.now, signal: deps.signal }, () => stopBefore(args, deps, deadlineAt));
}

async function stopBefore(args: ParsedLifecycleArguments, deps: LifecycleDependencies, deadlineAt: number): Promise<LifecycleResult> {
  const secrets = new Set<string>();
  let key: string | null = null;
  let target: LifecycleTarget | null = null;
  let adapter: NativeServiceAdapter | undefined;
  const finish = (input: Omit<LifecycleResultInput, 'command'>) => createLifecycleResult({ command: 'stop', target, ...input }, secrets);
  const failed = (code: LifecycleErrorCode, message: string, extra: Partial<Omit<LifecycleResultInput, 'command'>> = {}) =>
    finish({ outcome: 'failed', message, error: { code, message }, ...extra });
  const progress = (text: string) => deps.progress(sanitizeResultText(text, secrets));
  const learn = (secret: string) => { secrets.add(secret); key = secret; };
  const logsHint = () => adapter ? `Process logs: ${adapter.logLocation()}` : undefined;
  const remaining = () => deadlineAt - deps.now();

  try {
    let selection: ConfigurationSelection;
    let configuration: CoordinatorConfiguration;
    try {
      selection = selectConfigurationFile(args.coordinatorConfig, deps.environment);
      configuration = await loadCoordinatorConfiguration(selection.file, { implicitDefault: selection.origin === 'implicit-default' });
    } catch (error) {
      return failed('invalid-configuration', `Cannot load the coordinator configuration: ${errorText(error)}`);
    }
    const manager = selectNativeManager(deps.platform);
    const names = nativeServiceNames(configuration.stateDirectory);
    const label = !manager.supported ? null : manager.manager === 'launchd' ? names.launchdLabel : names.systemdUnit;
    target = { configFile: selection.file, origin: selection.origin, stateDirectory: configuration.stateDirectory, endpoint: configuration.endpoint, manager: manager.supported ? manager.manager : null, label };
    if (!manager.supported) return failed('unsupported-platform', manager.message);

    // A target that never ran anything has nothing to stop; looking must not create its state directory.
    try { await fs.lstat(configuration.stateDirectory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return failed('not-managed', `No coordinator has used ${configuration.stateDirectory}, so there is nothing to stop. Nothing was changed.`);
      }
      return failed('state-unknown', `The state directory ${configuration.stateDirectory} cannot be inspected: ${errorText(error)}`);
    }

    let lock;
    try {
      lock = await acquireOperationLock(configuration.stateDirectory, {
        deadlineAt, now: deps.now, sleep: milliseconds => deps.sleep(milliseconds, deps.signal), signal: deps.signal,
        onWaiting: () => progress('Another lifecycle operation is running for this coordinator; waiting for it to finish.'),
      });
    } catch (error) { return failed('state-unknown', `The lifecycle lock in ${configuration.stateDirectory} cannot be used: ${errorText(error)}`); }
    if (!lock.acquired) {
      if (lock.reason === 'aborted') return failed('interrupted', 'Interrupted while waiting for another lifecycle operation. Nothing was requested.');
      return finish({ outcome: 'busy', message: 'Another lifecycle operation for this coordinator did not finish before the stop deadline. Nothing was requested; retry the command.', error: { code: 'busy', message: 'Another lifecycle operation holds the lock for this coordinator' } });
    }
    try { return await stopLocked(); } finally { lock.lock.release(); }

    // --- Everything below holds the per-target operation lock -------------------------------------------------

    async function prepare(): Promise<LifecycleResult | undefined> {
      let context: LaunchContext;
      try { context = await resolveLaunchContext({ coordinatorConfig: args.coordinatorConfig, ...deps.launchOverrides }, deps.environment); }
      catch (error) { return failed('invalid-launch-context', `The service launch context cannot be resolved, so nothing was requested: ${errorText(error)}`); }
      const selected = deps.createAdapter(context);
      if (!selected.supported) return failed('unsupported-platform', selected.message);
      adapter = selected.adapter;
      return undefined;
    }

    async function stopLocked(): Promise<LifecycleResult> {
      const first = await settle();
      if (first.kind === 'aborted') return failed('interrupted', 'Interrupted before any drain was requested. Nothing was changed.');
      if (first.kind === 'timeout') return finish({ outcome: 'completion-unknown', message: first.message, error: { code: first.code, message: first.message } });
      const probe = first.probe;
      if (probe.kind === 'problem') return problemResult(probe);
      if (probe.kind === 'absent') return await stoppedBefore();
      return await stopAnswered(probe.lifecycle);
    }

    /** Only a coordinator that is starting or closing (HTTP 503) settles; an unreachable endpoint that still exists is stale or unknown. */
    async function settle(): Promise<{ kind: 'probe'; probe: Extract<Probe, { kind: 'absent' | 'answered' | 'problem' }> } | { kind: 'timeout'; message: string; code: LifecycleErrorCode } | { kind: 'aborted' }> {
      while (true) {
        if (deps.signal?.aborted) return { kind: 'aborted' };
        let probe: Probe;
        try { probe = await probeEndpoint(configuration, deps, deadlineAt, learn); }
        catch (error) { probe = problem('state-unknown', `The endpoint could not be checked: ${errorText(error)}`); }
        if (probe.kind === 'aborted') return { kind: 'aborted' };
        if (probe.kind === 'expired') return { kind: 'timeout', code: 'deadline-exceeded', message: 'The coordinator did not answer within the stop deadline. Nothing was requested or changed.' };
        if (probe.kind === 'problem' && probe.code === 'endpoint-unreachable') probe = { ...probe, transient: false };
        if (probe.kind !== 'problem' || !probe.transient) return { kind: 'probe', probe };
        if (remaining() <= 0) return { kind: 'timeout', code: 'endpoint-transitioning', message: `${probe.message} It did not settle before the stop deadline. Nothing was requested or changed.` };
        await deps.sleep(Math.max(1, Math.min(deps.pollIntervalMs, remaining())), deps.signal);
      }
    }

    function problemResult(probe: Extract<Probe, { kind: 'problem' }>): LifecycleResult {
      const message = `${probe.message} Nothing was requested.`;
      if (probe.code === 'unsupported-lifecycle-protocol' || probe.code === 'endpoint-invalid') return failed(probe.code, message);
      if (probe.code === 'endpoint-unreachable') {
        return finish({ outcome: 'completion-unknown', message: `${message} Whether the coordinator is stopped could not be established.`, error: { code: probe.code, message } });
      }
      return finish({ outcome: 'conflict', message, error: { code: probe.code, message } });
    }

    async function stopAnswered(lifecycle: CoordinatorLifecycle): Promise<LifecycleResult> {
      const instance = observed(lifecycle);
      if (lifecycle.mode === 'foreground') {
        const message = `A foreground coordinator (process ${lifecycle.pid}, started with \`heimdall coordinator serve\`) is running for this target. Heimdall does not manage it, so stop sent no request and no signal. `
          + `Stop it with its existing workflow: press Ctrl-C in its terminal, or send SIGINT or SIGTERM to process ${lifecycle.pid}; it then drains gracefully.`;
        return finish({ outcome: 'conflict', message, error: { code: 'foreground-coordinator', message }, instance });
      }
      if (lifecycle.manager !== target!.label) {
        const message = `A managed coordinator for this target is registered as ${lifecycle.manager}, not ${target!.label}. Nothing was requested.`;
        return finish({ outcome: 'conflict', message, error: { code: 'foreign-registration', message }, instance });
      }
      const prepared = await prepare();
      if (prepared) return prepared;
      const verified = await verifyOwned(lifecycle, instance);
      if (verified) return verified;
      // Owned registration plus the authenticated instance's own process: a start attempt recorded earlier has landed,
      // unless its client may still deliver a request that would launch the coordinator again after this stop.
      await clearLandedAttempt(configuration.stateDirectory);

      progress(`Requesting a graceful drain of coordinator instance ${lifecycle.instanceId}.`);
      // Ownership can change between the inspection above and the action: look again immediately before the request.
      const rechecked = await verifyOwned(lifecycle, instance);
      if (rechecked) return rechecked;
      // A start that began waiting before this stop must not launch after it: the ordering boundary is recorded
      // durably before anything is requested, and a stop that cannot record it requests nothing.
      const boundary = await recordBoundary('drain', instance);
      if (boundary) return boundary;
      // The request is created only while the deadline has not passed and nothing interrupted the stop.
      const budget = requestBudget(configuration.endpoint, key!, deps, deadlineAt);
      if (budget.kind === 'aborted') return failed('interrupted', 'Interrupted before any drain was requested. Nothing was changed.', { instance });
      if (budget.kind === 'expired') return deadlineBeforeRequest(instance);
      const sent = await bounded(() => requestCoordinatorShutdown(budget.client, lifecycle.instanceId), deps, deadlineAt).catch((error: unknown) => ({ kind: 'error' as const, error }));
      if (sent.kind === 'aborted') {
        const message = 'Interrupted while sending the drain request; it may or may not have been accepted. Nothing was stopped, killed or restarted.';
        return finish({ outcome: 'completion-unknown', message, error: { code: 'interrupted', message }, instance, logs: logsHint() });
      }
      if (sent.kind === 'timeout') {
        const message = 'The drain request was not answered before the deadline; it may or may not have been accepted. Nothing was stopped, killed or restarted.';
        return finish({ outcome: 'completion-unknown', message, error: { code: 'deadline-exceeded', message }, instance, logs: logsHint() });
      }
      if (sent.kind === 'error') {
        const refused = requestFailure(sent.error, instance);
        if (refused.kind === 'result') return refused.result;
        // The coordinator is already closing: a shutdown it accepted earlier is in progress.
        if (args.noWait) {
          const message = 'The coordinator is already closing, so it did not take a new drain request. Run stop without --no-wait to wait for it to finish.';
          return finish({ outcome: 'still-draining', message, error: { code: 'shutdown-in-progress', message }, instance, logs: logsHint() });
        }
        return await awaitCompletion(lifecycle, instance, 'The coordinator was already closing when the drain was requested.');
      }
      return await acknowledged(lifecycle, sent.value);
    }

    /**
     * Records that a stop is being accepted or confirmed (the stop generation), so a start that was already waiting
     * does not launch afterwards. Failing or running out of time here is a non-success that claims nothing: before a
     * drain no request has been sent, and before `already-stopped` the state was not declared stopped.
     */
    async function recordBoundary(purpose: 'drain' | 'already-stopped', instance?: ObservedInstance): Promise<LifecycleResult | undefined> {
      const recorded = await bounded(() => advanceStopGeneration(configuration.stateDirectory), deps, deadlineAt).catch((error: unknown) => ({ kind: 'error' as const, error }));
      if (recorded.kind === 'value') return undefined;
      const extra = { ...(instance ? { instance } : {}), logs: logsHint() };
      if (purpose === 'drain') {
        if (recorded.kind === 'aborted') return failed('interrupted', 'Interrupted before any drain was requested. Nothing was changed.', extra);
        if (recorded.kind === 'timeout') return deadlineBeforeRequest(instance!);
        return failed('state-unknown', `The stop ordering record in ${configuration.stateDirectory} could not be updated (${errorText(recorded.error)}), so no drain was requested and admission was not disabled. The coordinator was left running. Fix the lifecycle state directory and run \`heimdall coordinator stop\` again.`, extra);
      }
      if (recorded.kind === 'aborted') return failed('interrupted', 'Interrupted before the stopped state was recorded. Nothing was changed.', extra);
      const message = recorded.kind === 'timeout'
        ? 'The stop deadline passed before the stopped state was fully established. Nothing was changed. Run `heimdall coordinator stop` again.'
        : `No coordinator answers and its last instance ended cleanly, but the stop ordering record in ${configuration.stateDirectory} could not be updated (${errorText(recorded.error)}), so a start that is still waiting could not be fenced and this is not reported as already stopped. Nothing was changed. Fix the lifecycle state directory and run \`heimdall coordinator stop\` again.`;
      return recorded.kind === 'timeout'
        ? finish({ outcome: 'completion-unknown', message, error: { code: 'deadline-exceeded', message }, logs: logsHint() })
        : failed('state-unknown', message, extra);
    }

    /** The deadline passed while the stop was still verifying the coordinator: no request was sent and nothing changed. */
    function deadlineBeforeRequest(instance: ObservedInstance): LifecycleResult {
      const message = 'The stop deadline passed before a drain was requested. Nothing was requested, stopped, killed or restarted. Run `heimdall coordinator stop` again.';
      return finish({ outcome: 'completion-unknown', message, error: { code: 'deadline-exceeded', message }, instance, logs: logsHint() });
    }

    /**
     * Nothing is requested unless positive evidence ties the answering process to the owned service: the loaded
     * registration resolves to the owned definition and its running main process has the answering instance's process id.
     * The ownership of the service that started the process is what counts, not the newly invoked command's launch context.
     */
    async function verifyOwned(lifecycle: CoordinatorLifecycle, instance: ObservedInstance): Promise<LifecycleResult | undefined> {
      const inspected = await inspectService();
      if (inspected.kind === 'aborted') return failed('interrupted', 'Interrupted before any drain was requested. Nothing was changed.', { instance });
      if (inspected.kind === 'timeout') return deadlineBeforeRequest(instance);
      if (inspected.kind !== 'value') {
        const message = `The service manager could not confirm the running coordinator (${errorText(inspected.error)}), so nothing was requested.`;
        return finish({ outcome: 'conflict', message, error: { code: 'state-unknown', message }, instance, logs: logsHint() });
      }
      const confirmed = confirmOwnedProcess(inspected.value, lifecycle.pid, target!.label!);
      if (confirmed.kind === 'process') return undefined;
      if (confirmed.code === 'state-unknown') {
        const message = `The service manager state of ${target!.label} could not be confirmed (${confirmed.reason}), so nothing was requested.`;
        return finish({ outcome: 'conflict', message, error: { code: 'state-unknown', message }, instance, logs: logsHint() });
      }
      if (confirmed.code === 'foreign-definition') {
        const message = `The running managed coordinator has no service definition owned by Heimdall (${confirmed.reason}). Nothing was requested.`;
        return finish({ outcome: 'conflict', message, error: { code: 'foreign-definition', message }, instance });
      }
      const message = `A coordinator answered as a managed instance (process ${lifecycle.pid}), but ${confirmed.reason}. Nothing was requested.`;
      return finish({ outcome: 'conflict', message, error: { code: 'registered-elsewhere', message }, instance, logs: logsHint() });
    }

    function inspectService() {
      return bounded(() => inspectOwnership(adapter!), deps, deadlineAt).catch((error: unknown) => ({ kind: 'error' as const, error }));
    }

    function requestFailure(error: unknown, instance: ObservedInstance): { kind: 'result'; result: LifecycleResult } | { kind: 'closing' } {
      const statusCode = (error as { statusCode?: unknown }).statusCode;
      const code = (error as { code?: unknown }).code;
      const message = errorText(error);
      if (statusCode === 503) return { kind: 'closing' };
      let result: LifecycleResult;
      if (statusCode === 404 || code === 'unsupported-protocol') {
        const text = 'The coordinator does not support this lifecycle protocol; it was started by a different Heimdall version. Heimdall does not signal or restart it. Stop it with its own workflow (a managed service started by an older version has no authenticated stop).';
        result = failed('unsupported-lifecycle-protocol', text, { instance });
      } else if (statusCode === 409 || code === 'instance-mismatch') {
        const text = 'The coordinator that answered is not the instance this stop verified; it was replaced in between. Nothing was requested. Run stop again.';
        result = finish({ outcome: 'conflict', message: text, error: { code: 'instance-mismatch', message: text }, instance });
      } else if (statusCode === 401 || statusCode === 403) {
        const text = 'The coordinator refused the coordinator key for the drain request. Nothing was requested.';
        result = finish({ outcome: 'conflict', message: text, error: { code: 'endpoint-refused', message: text }, instance });
      } else if (/^Coordinator (unavailable|request timed out|request exceeded)/.test(message)) {
        const text = `The coordinator did not answer the drain request (${message}); it may or may not have received it. Nothing was stopped, killed or restarted.`;
        result = finish({ outcome: 'completion-unknown', message: text, error: { code: 'endpoint-unreachable', message: text }, instance, logs: logsHint() });
      } else {
        const text = `The coordinator returned an invalid reply to the drain request: ${message}. Heimdall does not fall back to signals or killing the process.`;
        result = failed('endpoint-invalid', text, { instance, logs: logsHint() });
      }
      return { kind: 'result', result };
    }

    async function acknowledged(requested: CoordinatorLifecycle, acknowledgement: ShutdownAcknowledgement): Promise<LifecycleResult> {
      const answered = acknowledgement.lifecycle;
      if (answered.instanceId !== requested.instanceId) {
        const text = 'The drain acknowledgement named a different coordinator instance than the one requested; it was ignored. Heimdall does not fall back to signals.';
        return failed('endpoint-invalid', text, { instance: observed(answered), logs: logsHint() });
      }
      const retried = acknowledgement.retried ? ` It retried a failed drain${acknowledgement.previousError ? ` (previous error: ${acknowledgement.previousError})` : ''}.` : '';
      if (args.noWait) {
        const late = await lateLaunchNote();
        return finish({
          outcome: 'stop-requested',
          message: `Coordinator instance ${answered.instanceId} accepted the drain request; admission is disabled.${retried} It has not necessarily exited: active runs keep their capacity until native execution is idle. Run stop again to wait for completion.${late ? ` ${late}` : ''}`,
          instance: observed(answered),
        });
      }
      return await awaitCompletion(answered, observed(answered), `The drain was accepted.${retried}`);
    }

    async function awaitCompletion(expected: CoordinatorLifecycle, instance: ObservedInstance, note: string): Promise<LifecycleResult> {
      let draining = true;
      let drainSummary = 'The coordinator is draining.';
      let observation = `${note} Waiting for active runs to reach native idle.`;
      progress(`Waiting up to ${args.timeoutSeconds} seconds for instance ${expected.instanceId} to finish draining and exit.`);
      while (true) {
        if (deps.signal?.aborted) return interrupted();
        if (remaining() <= 0) break;
        // The draining detail comes from a status request inside the same budget: nothing is requested once it is spent.
        const answer: Probe = await probeEndpoint(configuration, deps, deadlineAt, learn, { statusWhenClosing: true }).catch((error: unknown) => problem('state-unknown', `The endpoint could not be checked: ${errorText(error)}`, true));
        if (answer.kind === 'aborted') return interrupted();
        if (answer.kind === 'expired') break;
        if (answer.kind === 'answered') {
          const lifecycle = answer.lifecycle;
          if (lifecycle.instanceId !== expected.instanceId) {
            const message = `A different coordinator instance (${lifecycle.instanceId}) now answers at the endpoint, so the completion of ${expected.instanceId} cannot be confirmed. Nothing was stopped, killed or restarted.`;
            return finish({ outcome: 'completion-unknown', message, error: { code: 'instance-mismatch', message }, instance: observed(lifecycle), logs: logsHint() });
          }
          if (lifecycle.phase === 'drain-failed') return drainFailed(lifecycle);
          draining = true;
          observation = 'The coordinator is still draining.';
          if (answer.status) drainSummary = `${answer.status.reservedRuns} reserved run(s) still hold capacity and ${answer.status.queuedRuns} queued run(s) stay queued.`;
        } else {
          if (answer.kind === 'problem' && !answer.transient) {
            const hard = problemResult(answer);
            return hard;
          }
          draining = false;
          observation = answer.kind === 'problem' ? answer.message : 'The coordinator endpoint no longer exists.';
          const exit = await assessExit(expected);
          if (exit.kind === 'clean') {
            // A start client that may not have delivered yet can launch the coordinator again right after this exit.
            const late = await lateLaunchNote();
            if (late) {
              const message = `Instance ${expected.instanceId} completed a clean shutdown, but a stopped coordinator is not established. ${late} Nothing was stopped, killed or restarted beyond the drain. Run \`heimdall coordinator stop\` again once the launch has landed or been ruled out, and check \`heimdall coordinator status\`.`;
              return finish({ outcome: 'completion-unknown', message, error: { code: 'completion-unknown', message }, instance, logs: logsHint() });
            }
            if (remaining() > 0) return stopped(expected, instance);
            // A success is never reported after the deadline; the next stop reports the already-stopped coordinator.
            observation = `Instance ${expected.instanceId} completed a clean shutdown, but that was established only after the stop deadline.`;
            break;
          }
          if (exit.kind === 'final') return exit.result;
          observation = exit.observation;
        }
        await deps.sleep(Math.max(1, Math.min(deps.pollIntervalMs, remaining())), deps.signal);
      }
      const detail = draining ? drainSummary : observation;
      const waited = `${args.timeoutSeconds} seconds`;
      if (draining) {
        const message = `The coordinator is still draining after ${waited}. ${detail} Admission is disabled and nothing was stopped, killed or restarted; it keeps draining. Run \`heimdall coordinator stop\` again to keep waiting.`;
        return finish({ outcome: 'still-draining', message, error: { code: 'deadline-exceeded', message }, instance, logs: logsHint() });
      }
      const message = `Completion of instance ${expected.instanceId} was not established within ${waited}. ${detail} Nothing was stopped, killed or restarted. Run \`heimdall coordinator stop\` again, and check \`heimdall coordinator status\`.`;
      return finish({ outcome: 'completion-unknown', message, error: { code: 'completion-unknown', message }, instance, logs: logsHint() });

      function interrupted(): LifecycleResult {
        const message = draining
          ? `Interrupted. Instance ${expected.instanceId} keeps draining: the drain request stays in effect and nothing was stopped, killed or restarted. Run \`heimdall coordinator stop\` to wait again.`
          : `Interrupted while confirming completion of instance ${expected.instanceId}. The drain request stays in effect; nothing was stopped, killed or restarted.`;
        return finish({ outcome: draining ? 'still-draining' : 'completion-unknown', message, error: { code: 'interrupted', message }, instance, logs: logsHint() });
      }
    }

    /**
     * A sentence saying that an earlier start request may still launch the coordinator after this stop, or null when the
     * client that carried it is proven finished (or none is recorded as unresolved). A record that cannot be read counts
     * as a request that may still land.
     */
    async function lateLaunchNote(): Promise<string | null> {
      try {
        const attempt = await readLaunchAttempt(configuration.stateDirectory);
        const reason = attempt === null ? null : launchMayStillDeliver(attempt);
        return attempt === null || reason === null ? null
          : `An earlier start request for ${attempt.label} (issued by process ${attempt.ownerPid}) is not resolved: ${reason}. It may still launch the coordinator after it stops.`;
      } catch (error) {
        return `The record of an earlier start request cannot be used (${errorText(error)}), so it cannot be ruled out that the coordinator is launched again after it stops.`;
      }
    }

    function drainFailed(lifecycle: CoordinatorLifecycle): LifecycleResult {
      const detail = lifecycle.shutdown?.error ? ` The drain failed: ${lifecycle.shutdown.error}.` : ' The drain failed.';
      const message = `Coordinator instance ${lifecycle.instanceId} could not finish draining.${detail} Admission stays disabled, reserved runs keep their capacity and owner persistence stays open; nothing was stopped, killed or restarted. Run \`heimdall coordinator stop\` again to retry the same drain.`;
      return failed('drain-failed', message, { instance: observed(lifecycle), logs: logsHint() });
    }

    /** Success requires clean completion evidence, a clean main-process exit and a free ownership lock for this instance. */
    async function assessExit(expected: CoordinatorLifecycle): Promise<Exit> {
      const inspected = await inspectService();
      if (inspected.kind === 'aborted') return { kind: 'pending', observation: 'Interrupted.' };
      if (inspected.kind !== 'value') return { kind: 'pending', observation: `The service manager state could not be read${inspected.kind === 'error' ? ` (${errorText(inspected.error)})` : ''}.` };
      const ownership = inspected.value;
      const inspection = ownership.inspection;
      // Exit evidence only counts when it comes from the owned registration, not from whatever else is now registered.
      if (ownership.kind === 'refused') {
        if (ownership.code === 'state-unknown') return { kind: 'pending', observation: `The service registration could not be confirmed as owned (${ownership.reason}).` };
        const message = `The service ${target!.label} is no longer confirmed as the owned registration of instance ${expected.instanceId} (${ownership.reason}); its completion cannot be confirmed. Nothing was stopped, killed or restarted.`;
        return { kind: 'final', result: finish({ outcome: 'completion-unknown', message, error: { code: ownership.code, message }, logs: logsHint() }) };
      }
      if (inspection.running === true) {
        if (inspection.pid !== null && inspection.pid !== expected.pid) {
          const message = `The service now runs process ${inspection.pid}, not instance ${expected.instanceId} (process ${expected.pid}); its completion cannot be confirmed. Nothing was stopped, killed or restarted.`;
          return { kind: 'final', result: finish({ outcome: 'completion-unknown', message, error: { code: 'registered-elsewhere', message }, logs: logsHint() }) };
        }
        return { kind: 'pending', observation: 'The endpoint closed but the coordinator process has not exited yet.' };
      }
      if (inspection.running === 'unknown' || inspection.registration === 'unknown') return { kind: 'pending', observation: `Process absence could not be established (${inspection.detail}).` };
      return await judgeAbsentProcess(expected.instanceId, inspection, true, observed(expected));
    }

    /**
     * The service's process is proven absent. Classify the last instance by its shutdown evidence, and for a clean
     * completion also require the ownership lock to be free and, when `requireExit`, an exit status of exactly 0.
     */
    async function judgeAbsentProcess(instanceId: string, inspection: ServiceInspection, requireExit: boolean, instance: ObservedInstance | null): Promise<Exit> {
      let record: ShutdownRecord | null;
      try { record = await readShutdownRecord(configuration.stateDirectory, instanceId); }
      catch (error) {
        const message = `The shutdown evidence of instance ${instanceId} cannot be read (${errorText(error)}), so its completion is unknown.`;
        return { kind: 'final', result: finish({ outcome: 'completion-unknown', message, error: { code: 'completion-unknown', message }, instance, logs: logsHint() }) };
      }
      const exitText = inspection.lastExitStatus === null ? 'no exit status was reported' : `it exited with status ${inspection.lastExitStatus}`;
      const unknown = (message: string): Exit => ({ kind: 'final', result: finish({ outcome: 'completion-unknown', message, error: { code: 'completion-unknown', message }, instance, logs: logsHint() }) });
      const broken = (code: LifecycleErrorCode, message: string): Exit => ({ kind: 'final', result: failed(code, message, { instance: instance ?? undefined, logs: logsHint() }) });
      if (record === null) return unknown(`Instance ${instanceId} left no shutdown evidence and its process is gone; it may have crashed or been terminated, so a clean stop is not established. Nothing was repaired.`);
      switch (record.status) {
        case 'requested':
        case 'drain-failed':
          return broken('crashed-after-acknowledgement', `Instance ${instanceId} exited after the drain was ${record.status === 'requested' ? 'acknowledged' : 'attempted'} without completing a clean shutdown (it may have crashed or been terminated). Reserved runs and state were left as they were; Heimdall made no repair. See the process logs.`);
        case 'close-failed':
          return broken('shutdown-failed', `Instance ${instanceId} failed while closing (${record.stage ?? 'unknown stage'}: ${record.error ?? 'no detail'}); resources may be partially closed (${record.completedStages.join(', ') || 'none closed'}). It is not cleanly stopped.`);
        case 'completion-unknown':
          return unknown(`Instance ${instanceId} closed every resource but could not publish its completion record (${record.error ?? 'no detail'}), so a clean stop is not established.`);
        case 'completed': break;
      }
      const ownership = await probeCoordinatorOwnership(configuration.stateDirectory).catch(() => 'held' as const);
      if (ownership === 'held') return { kind: 'pending', observation: 'The ownership lock is still held by a process the service manager does not report.' };
      if (inspection.lastExitStatus !== null && inspection.lastExitStatus !== 0) {
        return broken('shutdown-failed', `Instance ${instanceId} recorded a clean shutdown but its main process ${exitText}, so the stop is not confirmed clean.`);
      }
      if (requireExit && inspection.lastExitStatus !== 0) {
        return unknown(`Instance ${instanceId} recorded a clean shutdown and its process is gone, but ${exitText}, so a clean exit cannot be confirmed.`);
      }
      return { kind: 'clean' };
    }

    function stopped(expected: CoordinatorLifecycle, instance: ObservedInstance): LifecycleResult {
      return finish({
        outcome: 'stopped',
        message: `Coordinator instance ${expected.instanceId} stopped cleanly: its shutdown completed, its process exited with status 0 and the state ownership lock is free. The service definition is kept inactive; run \`heimdall coordinator start\` to start it again.`,
        instance,
      });
    }

    /** The endpoint does not exist. Already-stopped needs an owned inactive definition, a correlated clean completion and proven absence. */
    async function stoppedBefore(): Promise<LifecycleResult> {
      const prepared = await prepare();
      if (prepared) return prepared;
      const remembered = await adapter!.remembered().catch((error: unknown) => ({ kind: 'foreign' as const, reason: errorText(error) }));
      if (remembered.kind === 'foreign') {
        const message = `A service definition for this coordinator exists but is not owned by Heimdall: ${remembered.reason}. Nothing was requested.`;
        return finish({ outcome: 'conflict', message, error: { code: 'foreign-definition', message } });
      }
      if (remembered.kind === 'absent') {
        return failed('not-managed', 'No managed coordinator service exists for this target and no coordinator answers, so there is nothing to stop. A foreground coordinator is stopped with SIGINT or SIGTERM. Nothing was changed.');
      }
      const inspected = await inspectService();
      if (inspected.kind === 'aborted') return failed('interrupted', 'Interrupted before the service state was confirmed. Nothing was changed.');
      const unknown = (message: string, code: LifecycleErrorCode = 'completion-unknown') =>
        finish({ outcome: 'completion-unknown', message, error: { code, message }, logs: logsHint() });
      if (inspected.kind === 'timeout') return unknown('The stop deadline passed before the service manager state was read, so absence of the coordinator is not established. Nothing was changed.', 'deadline-exceeded');
      if (inspected.kind !== 'value') return unknown(`The service manager state could not be read (${errorText(inspected.error)}), so absence of the coordinator is not established.`, 'state-unknown');
      const ownership = inspected.value;
      const inspection = ownership.inspection;
      if (ownership.kind === 'refused' && ownership.code !== 'state-unknown') {
        const message = `No coordinator answers at ${configuration.endpoint}, but ${target!.label} is not confirmed as the owned registration (${ownership.reason}). Nothing was requested.`;
        return finish({ outcome: 'conflict', message, error: { code: ownership.code, message }, logs: logsHint() });
      }
      if (inspection.running === true) {
        return unknown(`No coordinator answers at ${configuration.endpoint}, but the service manager reports ${target!.label} running${inspection.pid === null ? '' : ` as process ${inspection.pid}`}; it may be starting or closing. Nothing was requested.`, 'endpoint-unreachable');
      }
      if (inspection.running === 'unknown' || inspection.registration === 'unknown') {
        return unknown(`The service manager state of ${target!.label} could not be determined (${inspection.detail}), so absence of the coordinator is not established.`, 'state-unknown');
      }
      // A start request recorded by an earlier command may still be in flight, whichever process issued it and
      // whether or not that process is alive. Until an observation resolves it, nothing is claimed stopped.
      let launch;
      try { launch = await assessLaunchAttempt(configuration.stateDirectory, adapter!, ownership); }
      catch (error) { return unknown(`The record of an earlier start request cannot be used (${errorText(error)}), so absence of the coordinator is not established. Nothing was changed.`, 'state-unknown'); }
      if (launch.kind === 'unresolved') return unknown(unresolvedLaunchMessage(launch.attempt, launch.reason, 'whether the coordinator is stopped'));
      let record;
      try { record = await readInstanceRecord(configuration.stateDirectory); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return failed('not-managed', 'The service is defined but no coordinator instance has run for this state, so there is nothing to stop. Nothing was changed.');
        return unknown(`The last instance record cannot be read (${errorText(error)}), so a prior clean shutdown is not established.`, 'state-unknown');
      }
      const exit = await judgeAbsentProcess(record.instanceId, inspection, false, null);
      if (exit.kind === 'final') return exit.result;
      if (exit.kind === 'pending') return unknown(exit.observation);
      // A success is never reported after the deadline.
      if (remaining() <= 0) return unknown('The stop deadline passed before the stopped state was fully established. Nothing was changed. Run `heimdall coordinator stop` again.', 'deadline-exceeded');
      // Already-stopped is a stop confirmation too: a start that began waiting before it must not launch afterwards.
      const boundary = await recordBoundary('already-stopped');
      if (boundary) return boundary;
      if (remaining() <= 0) return unknown('The stop deadline passed before the stopped state was fully established. Nothing was changed. Run `heimdall coordinator stop` again.', 'deadline-exceeded');
      return finish({ outcome: 'already-stopped', message: `The coordinator is already stopped: its last instance ${record.instanceId} completed a clean shutdown, its process is absent and the ownership lock is free. Nothing was changed.` });
    }
  } catch (error) {
    return failed('internal', `Unexpected failure: ${errorText(error)}`);
  }
}
