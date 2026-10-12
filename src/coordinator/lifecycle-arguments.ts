/** Lifecycle commands handled by the strict parser below. */
export type LifecycleCommandName = 'start' | 'stop' | 'logs';
export const LIFECYCLE_COMMANDS: readonly string[] = ['start', 'stop', 'logs'];

export const DEFAULT_START_TIMEOUT_SECONDS = 30;
export const DEFAULT_STOP_TIMEOUT_SECONDS = 60;
export const DEFAULT_LOG_LINES = 100;
export const MINIMUM_TIMEOUT_SECONDS = 1;
export const MAXIMUM_TIMEOUT_SECONDS = 3600;
export const MAXIMUM_LOG_LINES = 10000;

export class LifecycleArgumentError extends Error {
  constructor(message: string) { super(message); this.name = 'LifecycleArgumentError'; }
}

export interface ParsedLifecycleArguments {
  command: LifecycleCommandName;
  help: boolean;
  json: boolean;
  coordinatorConfig: string | undefined;
  envFile: string | undefined;
  /** Seconds, from `--timeout` or the command default. */
  timeoutSeconds: number;
  /** True only when `--timeout` was given. */
  timeoutExplicit: boolean;
  noWait: boolean;
  lines: number;
  follow: boolean;
}

interface OptionSpecification { flag: boolean; commands: readonly LifecycleCommandName[] }

const OPTIONS: Record<string, OptionSpecification> = {
  '--coordinator-config': { flag: false, commands: ['start', 'stop', 'logs'] },
  '--env-file': { flag: false, commands: ['start'] },
  '--timeout': { flag: false, commands: ['start', 'stop'] },
  '--json': { flag: true, commands: ['start', 'stop'] },
  '--no-wait': { flag: true, commands: ['stop'] },
  '--lines': { flag: false, commands: ['logs'] },
  '--follow': { flag: true, commands: ['logs'] },
  '--help': { flag: true, commands: ['start', 'stop', 'logs'] },
};

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/;

function pathValue(name: string, value: string): string {
  if (!value) throw new LifecycleArgumentError(`${name} requires a nonempty path`);
  if (CONTROL_CHARACTERS.test(value)) throw new LifecycleArgumentError(`${name} must not contain control characters`);
  return value;
}

/** Positive decimal seconds within the supported range. Exponents, signs, hex, whitespace and non-finite values are rejected. */
export function parseTimeoutSeconds(value: string): number {
  const supported = `${MINIMUM_TIMEOUT_SECONDS} to ${MAXIMUM_TIMEOUT_SECONDS} seconds`;
  if (!/^\d{1,5}(\.\d{1,3})?$/.test(value)) throw new LifecycleArgumentError(`--timeout must be a decimal number of seconds from ${supported}`);
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < MINIMUM_TIMEOUT_SECONDS || seconds > MAXIMUM_TIMEOUT_SECONDS) throw new LifecycleArgumentError(`--timeout must be from ${supported}`);
  return seconds;
}

export function parseLineCount(value: string): number {
  if (!/^[1-9]\d{0,5}$/.test(value)) throw new LifecycleArgumentError(`--lines must be a whole number from 1 to ${MAXIMUM_LOG_LINES}`);
  const lines = Number(value);
  if (!Number.isSafeInteger(lines) || lines > MAXIMUM_LOG_LINES) throw new LifecycleArgumentError(`--lines must be a whole number from 1 to ${MAXIMUM_LOG_LINES}`);
  return lines;
}

/** Whether the arguments ask for machine-readable output, decided before the rest of the arguments are validated. */
export function requestsJson(args: readonly string[]): boolean {
  return args.includes('--json');
}

/**
 * Parse the arguments after `start`, `stop` or `logs`. Nothing is read from the environment, the file system or a
 * service, so every rejection happens before any side effect. `--help` wins over every other argument.
 */
export function parseLifecycleArguments(command: LifecycleCommandName, args: readonly string[]): ParsedLifecycleArguments {
  if (args.includes('--help')) {
    return { command, help: true, json: false, coordinatorConfig: undefined, envFile: undefined, timeoutSeconds: 0, timeoutExplicit: false, noWait: false, lines: DEFAULT_LOG_LINES, follow: false };
  }
  const seen = new Map<string, string | true>();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    if (!argument.startsWith('-')) throw new LifecycleArgumentError(`Unexpected argument: ${argument}`);
    const specification = Object.hasOwn(OPTIONS, argument) ? OPTIONS[argument] : undefined;
    if (!specification) throw new LifecycleArgumentError(`Unknown option: ${argument}`);
    if (!specification.commands.includes(command)) throw new LifecycleArgumentError(`${argument} does not apply to ${command}`);
    if (seen.has(argument)) throw new LifecycleArgumentError(`Repeated option: ${argument}`);
    if (specification.flag) { seen.set(argument, true); continue; }
    const value = args[++index];
    if (value === undefined || value.startsWith('--')) throw new LifecycleArgumentError(`${argument} requires a value`);
    seen.set(argument, value);
  }
  const text = (name: string) => { const value = seen.get(name); return typeof value === 'string' ? value : undefined; };
  const timeoutText = text('--timeout');
  const linesText = text('--lines');
  const configuration = text('--coordinator-config');
  const envFile = text('--env-file');
  const noWait = seen.has('--no-wait');
  if (noWait && timeoutText !== undefined) throw new LifecycleArgumentError('--no-wait and --timeout cannot be combined: --no-wait returns after the drain request is acknowledged');
  return {
    command,
    help: false,
    json: seen.has('--json'),
    coordinatorConfig: configuration === undefined ? undefined : pathValue('--coordinator-config', configuration),
    envFile: envFile === undefined ? undefined : pathValue('--env-file', envFile),
    timeoutSeconds: timeoutText === undefined ? (command === 'stop' ? DEFAULT_STOP_TIMEOUT_SECONDS : DEFAULT_START_TIMEOUT_SECONDS) : parseTimeoutSeconds(timeoutText),
    timeoutExplicit: timeoutText !== undefined,
    noWait,
    lines: linesText === undefined ? DEFAULT_LOG_LINES : parseLineCount(linesText),
    follow: seen.has('--follow'),
  };
}
