import fs from 'node:fs/promises';
import path from 'node:path';
import { loadCoordinatorConfiguration, positiveInteger } from './config.js';
import type { CoordinatorConfiguration } from './config.js';
import { createCoordinatorClient } from './client.js';
import { readCoordinatorToken } from './token.js';
import { parseCoordinatorStatus } from './status.js';

const STATUS_DEADLINE_MS = 10000;

export const coordinatorHelp = `Global coordinator (explicit opt-in)

Usage:
  heimdall coordinator serve [--coordinator-config FILE]
  heimdall coordinator project add DIRECTORY [--project-config FILE] [--limit N]
  heimdall coordinator project list
  heimdall coordinator run submit PROJECT_ID --feature FILE [--base REF]
  heimdall coordinator run list
  heimdall coordinator run show RUN_ID
  heimdall coordinator run resume RUN_ID --input RESOLUTION
  heimdall coordinator run reconcile RUN_ID
  heimdall coordinator events [--after SEQUENCE]
  heimdall coordinator status [--json] [--coordinator-config FILE]

All commands accept --coordinator-config FILE. Start serve in a separate terminal.
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

export async function coordinatorMain(args: string[]): Promise<void> {
  if (!args.length || args.includes('--help') || args[0] === 'help') { process.stdout.write(coordinatorHelp); return; }
  const positional: string[] = [];
  const options = new Map<string, string>();
  let json = false;
  const allowed = new Set(['--coordinator-config', '--project-config', '--limit', '--feature', '--base', '--input', '--after']);
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
  const configuration = await loadCoordinatorConfiguration(options.get('--coordinator-config'));
  if (command === 'status') {
    check(1, []);
    await coordinatorStatus({ configuration, json });
    return;
  }
  if (command === 'serve') {
    check(1, []);
    const { startCoordinatorService } = await import('./service.js');
    const service = await startCoordinatorService({ configuration });
    process.stdout.write(`Coordinator listening at ${configuration.endpoint}\n`);
    await new Promise<void>((resolve, reject) => {
      let closing = false;
      const close = () => {
        if (closing) return;
        closing = true;
        process.stdout.write('Stopping admission and draining managed runs before closing their checkpoint connection.\n');
        void service.drain().then(() => service.close()).then(resolve, reject).finally(() => { process.off('SIGINT', close); process.off('SIGTERM', close); });
      };
      process.on('SIGINT', close); process.on('SIGTERM', close);
    });
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
