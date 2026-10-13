import fs from 'node:fs/promises';
import path from 'node:path';
import { loadCoordinatorConfiguration, positiveInteger } from './config.js';
import { implicitDefaultMarkerApplies, managerLabelFromEnvironment } from './launch-context.js';
import type { CoordinatorConfiguration } from './config.js';
import { createCoordinatorClient } from './client.js';
import { readCoordinatorToken } from './token.js';
import { parseCoordinatorStatus } from './status.js';
import { CoordinatorShutdownError } from './lifecycle.js';
import type { ServiceOptions } from './service.js';
import { loadCredentialFile } from './credentials.js';
import { createOutputSanitizer, sanitizeProcessOutput } from './output.js';

const STATUS_DEADLINE_MS = 10000;

export const coordinatorHelp = `Global coordinator (explicit opt-in)

Usage:
  heimdall coordinator start [--coordinator-config FILE] [--env-file FILE] [--timeout SECONDS] [--json]
  heimdall coordinator stop [--coordinator-config FILE] [--timeout SECONDS] [--no-wait] [--json]
  heimdall coordinator logs [--coordinator-config FILE] [--lines N] [--follow]
  heimdall coordinator serve [--coordinator-config FILE] [--env-file FILE]
  heimdall coordinator project add DIRECTORY [--project-config FILE] [--limit N]
  heimdall coordinator project list
  heimdall coordinator run submit PROJECT_ID --feature FILE [--base REF]
  heimdall coordinator run list
  heimdall coordinator run show RUN_ID
  heimdall coordinator run resume RUN_ID --input RESOLUTION
  heimdall coordinator run reconcile RUN_ID
  heimdall coordinator events [--after SEQUENCE]
  heimdall coordinator status [--json] [--coordinator-config FILE]

All commands accept --coordinator-config FILE. start runs the coordinator in the background through the
native user service manager; serve runs it in the foreground in a separate terminal. See
"heimdall coordinator start --help", "stop --help" and "logs --help".
serve --env-file FILE reads Basic authentication credentials (NAME=value lines) from a private
regular file (owner-only, not a symbolic link). The file is read at every launch, never changes
the process environment, and its values are masked in coordinator output.
Submission schedules agents in a new managed worktree. Existing runs are untouched.

status asks the running coordinator whether it is running or draining, whether it accepts
new runs, and how many runs are queued or hold reserved capacity. It is read-only: it never
starts, restarts or stops a coordinator and never creates configuration, keys or state.
  --json                    print the validated status document as JSON
  --coordinator-config FILE select the coordinator whose endpoint and key are used
It gives up after a 10 second deadline. It exits 0 when a valid status is reported (including
draining) and 1 with a diagnostic on stderr and nothing on stdout otherwise, for example when the
coordinator is unavailable, refuses the key, is an older version without status, or answers
with an invalid response.

Examples:
  heimdall coordinator status
  heimdall coordinator status --json --coordinator-config ./coordinator.toml
`;

interface StatusOutput { write(text: string): unknown }

/** Read-only status request. Writes to `stdout` only after the response passed contract validation. */
export async function coordinatorStatus(options: { configuration: CoordinatorConfiguration; json?: boolean; deadlineMs?: number; stdout?: StatusOutput }): Promise<void> {
  const { configuration, json = false, deadlineMs = STATUS_DEADLINE_MS } = options;
  const stdout = options.stdout ?? process.stdout;
  const endpoint = configuration.endpoint;
  let key: string;
  try { key = await readCoordinatorToken(configuration.stateDirectory); }
  catch (error) { throw new Error(`Cannot read the coordinator key in ${configuration.stateDirectory}: ${error instanceof Error ? error.message : 'unknown error'}`); }
  const client = createCoordinatorClient(endpoint, key, { timeoutMs: deadlineMs, deadlineMs });
  let body: unknown;
  try { body = await client.request('GET', '/status'); }
  catch (error) {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    const message = error instanceof Error ? error.message : 'unknown error';
    if (statusCode === 404) throw new Error(`The coordinator at ${endpoint} does not support status (likely an older version) and is incompatible with this command. Heimdall does not restart it.`);
    if (statusCode === 401 || statusCode === 403) throw new Error(`The coordinator at ${endpoint} refused authorization for status; check the coordinator key.`);
    if (statusCode === 503) throw new Error(`The coordinator at ${endpoint} is starting or stopping; try again shortly.`);
    throw new Error(`Coordinator status request to ${endpoint} failed: ${message}`);
  }
  let status;
  try { status = parseCoordinatorStatus(body); }
  catch (error) { throw new Error(`The coordinator at ${endpoint} returned an invalid status response: ${error instanceof Error ? error.message : 'unknown error'}`); }
  if (json) { stdout.write(JSON.stringify(status, null, 2) + '\n'); return; }
  stdout.write([
    status.status === 'running' ? 'Coordinator running; accepting new runs.' : 'Coordinator draining; not accepting new runs.',
    `Queued runs: ${status.queuedRuns}`,
    `Reserved runs: ${status.reservedRuns} (retained capacity, including uncertain execution)`,
    '',
  ].join('\n'));
}

/** The part of a started coordinator that the foreground supervisor needs. */
export interface ForegroundService {
  lifecycle(): { phase: string };
  shutdown(): Promise<void>;
  closed: Promise<void>;
}

/**
 * Keep a foreground coordinator running until one shared shutdown operation closes it.
 * SIGINT and SIGTERM request that operation; an authenticated IPC request may also complete it.
 * Resolves true only after clean completion and false after a terminal close failure. A drain failure
 * keeps the coordinator open with admission disabled; the next signal retries the drain.
 */
export function superviseForeground(
  service: ForegroundService,
  host: Pick<NodeJS.Process, 'on' | 'off'> = process,
  output: { stdout: { write(text: string): unknown }; stderr: { write(text: string): unknown } } = process,
): Promise<boolean> {
  return new Promise(resolve => {
    const request = () => {
      const phase = service.lifecycle().phase;
      if (phase === 'running') output.stdout.write('Stopping admission and draining managed runs before closing their checkpoint connection.\n');
      else if (phase === 'drain-failed') output.stdout.write('Retrying the failed drain; admission stays disabled.\n');
      service.shutdown().catch((error: unknown) => {
        if (error instanceof CoordinatorShutdownError && error.retryable) output.stderr.write(`${error.message}\nThe coordinator remains open with admission disabled; signal it again to retry the drain.\n`);
      });
    };
    const finish = (clean: boolean) => { host.off('SIGINT', request); host.off('SIGTERM', request); resolve(clean); };
    host.on('SIGINT', request); host.on('SIGTERM', request);
    service.closed.then(() => finish(true), (error: unknown) => {
      output.stderr.write(`Coordinator shutdown did not complete cleanly: ${error instanceof Error ? error.message : 'unknown failure'}\n`);
      finish(false);
    });
  });
}

/** Programmatic seams for tests; the command line exposes none of them. */
export interface CoordinatorMainInternals {
  serviceOptions?: Pick<ServiceOptions, 'executor' | 'scheduler' | 'pollIntervalMs' | 'testHooks'>;
  lifecycle?: import('./lifecycle-cli.js').LifecycleInternals;
}

export async function coordinatorMain(args: string[], internals: CoordinatorMainInternals = {}): Promise<void> {
  // Lifecycle commands validate their own arguments before the configuration or any service is consulted.
  if (args[0] === 'start' || args[0] === 'stop' || args[0] === 'logs') {
    const { lifecycleCommandMain } = await import('./lifecycle-cli.js');
    process.exitCode = await lifecycleCommandMain(args[0], args.slice(1), internals.lifecycle);
    return;
  }
  if (!args.length || args.includes('--help') || args[0] === 'help') { process.stdout.write(coordinatorHelp); return; }
  const positional: string[] = [];
  const options = new Map<string, string>();
  let json = false;
  const allowed = new Set(['--coordinator-config', '--project-config', '--limit', '--feature', '--base', '--input', '--after', '--env-file']);
  while (args.length) {
    const argument = args.shift()!;
    if (!argument.startsWith('-')) { positional.push(argument); continue; }
    if (argument === '--json') {
      if (json) throw new Error(`Unknown or repeated option: ${argument}`);
      json = true;
      continue;
    }
    if (!allowed.has(argument) || options.has(argument)) throw new Error(`Unknown or repeated option: ${argument}`);
    const value = args.shift();
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    options.set(argument, value);
  }
  const [command, action, identifier] = positional;
  const check = (count: number, names: string[]) => {
    if (positional.length !== count) throw new Error('Invalid coordinator arguments; see --help');
    if (json && command !== 'status') throw new Error('--json does not apply to this command');
    for (const name of options.keys()) if (name !== '--coordinator-config' && !names.includes(name)) throw new Error(`${name} does not apply to this command`);
  };
  if (json && command !== 'status') check(positional.length, []);
  const configurationFlag = options.get('--coordinator-config');
  // A native service definition passes the resolved default file and marks it as implicitly selected.
  const configuration = await loadCoordinatorConfiguration(configurationFlag, { implicitDefault: command === 'serve' && implicitDefaultMarkerApplies(configurationFlag) });
  if (command === 'status') {
    check(1, []);
    await coordinatorStatus({ configuration, json });
    return;
  }
  if (command === 'serve') {
    check(1, ['--env-file']);
    // Validate the selected credential file before anything is created or started.
    const envFile = options.get('--env-file');
    const credentials = envFile === undefined ? undefined : await loadCredentialFile(envFile);
    let service: Awaited<ReturnType<typeof import('./service.js').startCoordinatorService>> | undefined;
    let coordinatorKey: string | undefined;
    // Everything this process writes passes through the sanitizer, seeded with the credentials and capabilities it knows.
    const sanitize = createOutputSanitizer(() => {
      const secrets: string[] = [...(credentials?.values() ?? [])];
      if (coordinatorKey) secrets.push(coordinatorKey);
      if (service) for (const run of service.store.listRuns()) if (run.ownerToken) secrets.push(run.ownerToken);
      return secrets;
    });
    const restoreOutput = sanitizeProcessOutput(sanitize);
    try {
      const { startCoordinatorService } = await import('./service.js');
      const { credentialSourceFor } = await import('./executor.js');
      const managerLabel = managerLabelFromEnvironment(configuration.stateDirectory);
      const lifecycle = managerLabel ? { mode: 'managed' as const, label: managerLabel } : undefined;
      // A managed service takes Basic passwords only from a selected file; the manager's environment is never a source.
      const credentialSource = credentialSourceFor({ credentials, managed: lifecycle !== undefined });
      service = await startCoordinatorService({ ...internals.serviceOptions, configuration, credentials, credentialSource, ...(lifecycle ? { lifecycle } : {}) });
      coordinatorKey = await readCoordinatorToken(configuration.stateDirectory).catch(() => undefined);
      process.stdout.write(`Coordinator listening at ${configuration.endpoint}\n`);
      if (!await superviseForeground(service)) {
        // A failed close stage may leave resources open; end the process instead of waiting on them.
        process.exitCode = 1;
        await new Promise<void>(resolve => process.stderr.write('', () => resolve()));
        process.exit(1);
      }
    } catch (error) {
      throw new Error(sanitize(error instanceof Error ? error.message : 'Coordinator failed'));
    } finally { restoreOutput(); }
    return;
  }
  const client = createCoordinatorClient(configuration.endpoint, await readCoordinatorToken(configuration.stateDirectory));
  let result: unknown;
  if (command === 'project' && action === 'list') { check(2, []); result = await client.request('GET', '/projects'); }
  else if (command === 'project' && action === 'add' && identifier) {
    check(3, ['--project-config', '--limit']);
    result = await client.request('POST', '/projects', { directory: path.resolve(identifier), configPath: options.get('--project-config'), concurrency: options.has('--limit') ? positiveInteger(Number(options.get('--limit')), 'project limit') : undefined });
  } else if (command === 'run' && action === 'list') { check(2, []); result = await client.request('GET', '/runs'); }
  else if (command === 'run' && action === 'submit' && identifier) {
    check(3, ['--feature', '--base']);
    const file = options.get('--feature');
    if (!file) throw new Error('run submit requires --feature FILE');
    result = await client.request('POST', '/runs', { projectId: identifier, feature: await fs.readFile(file, 'utf8'), baseRef: options.get('--base') });
  } else if (command === 'run' && action === 'show' && identifier) { check(3, []); result = await client.request('GET', '/runs/' + encodeURIComponent(identifier)); }
  else if (command === 'run' && action === 'reconcile' && identifier) { check(3, []); result = await client.request('POST', `/runs/${encodeURIComponent(identifier)}/reconcile`, {}); }
  else if (command === 'run' && action === 'resume' && identifier) {
    check(3, ['--input']);
    const input = options.get('--input');
    if (!input) throw new Error('run resume requires --input RESOLUTION');
    result = await client.request('POST', `/runs/${encodeURIComponent(identifier)}/resume`, { input });
  } else if (command === 'events') {
    check(1, ['--after']);
    const after = Number(options.get('--after') ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('--after must be a nonnegative integer');
    result = await client.request('GET', '/events?after=' + after);
  } else throw new Error('Unknown coordinator command; see --help');
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
