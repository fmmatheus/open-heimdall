import { LifecycleArgumentError, parseLifecycleArguments, requestsJson } from './lifecycle-arguments.js';
import type { LifecycleCommandName } from './lifecycle-arguments.js';
import { createLifecycleResult, lifecycleExitCode, renderLifecycleJson, renderLifecycleText, sanitizeResultText } from './lifecycle-result.js';
import type { LifecycleCommand, LifecycleResult } from './lifecycle-result.js';
import { defaultLifecycleDependencies, runCoordinatorStart } from './lifecycle-start.js';
import type { LifecycleDependencies } from './lifecycle-start.js';

export const startHelp = `heimdall coordinator start [--coordinator-config FILE] [--env-file FILE] [--timeout SECONDS] [--json]

Start the coordinator through the native user service manager (launchd on macOS, the systemd user
manager on Linux) and wait until the started instance answers authenticated readiness requests.
Nothing starts automatically at install, login or boot; start is always an explicit command.

  --coordinator-config FILE  coordinator configuration (default: HEIMDALL_COORDINATOR_CONFIG, then the
                             default location; a missing file is an error unless it is the default)
  --env-file FILE            private file of NAME=value Basic authentication credentials, read by the
                             coordinator at every launch. Remembered by the owned service definition by
                             path; omit it to reuse the remembered file. Changing it needs a stop first.
  --timeout SECONDS          overall startup wait, 1 to 3600 (default 30)
  --json                     print one versioned result document on stdout; progress goes to stderr

The environment variable OPENCHAMBER_DATA_DIR, when set, is recorded as a path (never read for tokens)
so the service keeps the same OpenChamber data directory. start never prompts and exits 0 only when
the coordinator is ready or was already running. Readiness covers coordinator IPC only; it does not
check OpenCode connectivity, credentials, models or quota.

Result outcomes: ready, already-running, already-running-foreground (reported, not managed),
shutdown-in-progress, startup-not-confirmed, busy, conflict, failed.

Examples:
  heimdall coordinator start
  heimdall coordinator start --coordinator-config ./coordinator.toml --env-file ~/.config/heimdall/opencode.env --json
`;

export const stopHelp = `heimdall coordinator stop [--coordinator-config FILE] [--timeout SECONDS] [--no-wait] [--json]

Ask the managed coordinator to drain and close, and wait for confirmed clean shutdown. Admission stops
immediately; active runs keep their reserved capacity until native execution is idle.

  --coordinator-config FILE  coordinator configuration, as for start
  --timeout SECONDS          overall shutdown wait, 1 to 3600 (default 60)
  --no-wait                  return after the drain request is acknowledged; cannot be combined with
                             --timeout. Exit 0 means only that the drain was accepted.
  --json                     print one versioned result document on stdout; progress goes to stderr

Result outcomes: stop-requested, stopped, already-stopped, still-draining, completion-unknown, busy,
conflict, failed. A wait that times out does not stop, kill or restart anything; the coordinator keeps
draining.

Examples:
  heimdall coordinator stop
  heimdall coordinator stop --timeout 300 --json
`;

export const logsHelp = `heimdall coordinator logs [--coordinator-config FILE] [--lines N] [--follow]

Print recent process logs of the managed coordinator: the owned journal unit on Linux, the private
output log files on macOS.

  --coordinator-config FILE  coordinator configuration, as for start
  --lines N                  number of recent lines, 1 to 10000 (default 100)
  --follow                   keep printing new lines until interrupted with Ctrl-C

Examples:
  heimdall coordinator logs
  heimdall coordinator logs --lines 500 --follow
`;

const HELP: Record<LifecycleCommandName, string> = { start: startHelp, stop: stopHelp, logs: logsHelp };

export interface LifecycleStreams {
  stdout: { write(text: string): unknown };
  stderr: { write(text: string): unknown };
}

/** Programmatic seams for tests; the command line exposes none of them. */
export interface LifecycleInternals {
  dependencies?: Partial<LifecycleDependencies>;
  streams?: LifecycleStreams;
  /** Receives the result a start or stop command produced. */
  onResult?(result: LifecycleResult): void;
  /** Where Ctrl-C and termination requests come from; defaults to the process. */
  signals?: Pick<NodeJS.Process, 'on' | 'off'>;
}

function emit(result: LifecycleResult, json: boolean, streams: LifecycleStreams): void {
  if (json) streams.stdout.write(renderLifecycleJson(result));
  else if (result.ok) streams.stdout.write(renderLifecycleText(result));
  else streams.stderr.write(renderLifecycleText(result));
}

/**
 * Run `start`, `stop` or `logs`. Arguments are fully validated before the configuration, a state directory,
 * a service manager or a coordinator is consulted. Returns the process exit status.
 */
export async function lifecycleCommandMain(command: LifecycleCommandName, args: readonly string[], internals: LifecycleInternals = {}): Promise<number> {
  const streams = internals.streams ?? process;
  let parsed;
  try { parsed = parseLifecycleArguments(command, args); }
  catch (error) {
    const message = sanitizeResultText(error instanceof LifecycleArgumentError ? error.message : error instanceof Error ? error.message : 'Invalid arguments');
    if (command !== 'logs' && requestsJson(args)) {
      const result = createLifecycleResult({ command: command as LifecycleCommand, outcome: 'failed', message, error: { code: 'invalid-arguments', message } });
      streams.stdout.write(renderLifecycleJson(result));
      internals.onResult?.(result);
    } else streams.stderr.write(`Heimdall: ${message}\nRun \`heimdall coordinator ${command} --help\` for usage.\n`);
    return 2;
  }
  if (parsed.help) { streams.stdout.write(HELP[command]); return 0; }

  if (command === 'start') {
    const controller = new AbortController();
    const signals = internals.signals ?? process;
    const interrupt = () => controller.abort();
    signals.on('SIGINT', interrupt); signals.on('SIGTERM', interrupt);
    try {
      const dependencies = defaultLifecycleDependencies({
        progress: text => { streams.stderr.write(`${text}\n`); },
        ...internals.dependencies,
        signal: controller.signal,
      });
      const result = await runCoordinatorStart(parsed, dependencies);
      emit(result, parsed.json, streams);
      internals.onResult?.(result);
      return lifecycleExitCode(result);
    } finally { signals.off('SIGINT', interrupt); signals.off('SIGTERM', interrupt); }
  }

  const message = `heimdall coordinator ${command} is not available in this build yet. Nothing was changed.`;
  if (command === 'stop') {
    const result = createLifecycleResult({ command: 'stop', outcome: 'failed', message, error: { code: 'not-implemented', message } });
    emit(result, parsed.json, streams);
    internals.onResult?.(result);
    return lifecycleExitCode(result);
  }
  streams.stderr.write(`Heimdall: ${message}\n`);
  return 1;
}
