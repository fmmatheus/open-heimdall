import fs from 'node:fs/promises';
import readline from 'node:readline/promises';
import { planSetup, SetupError, type SetupInput, type SetupOptions, type SetupTrace } from './core.js';
import type { SetupPromptRequest } from './cli.js';

/*
 * Interactive front end of `heimdall setup`. It only collects missing decisions; the completed SetupInput is
 * validated and written by the same core as the flag front end, so equivalent answers and flags produce the same
 * files. The wizard asks nothing that the flags or an existing file already settle, never asks for a password
 * (only for the name of the environment variable that holds it) and never asks for optional settings.
 */

export interface WizardStreams {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
}

interface Choice { value: string; description: string }

export const QUOTA_PROVIDER_CHOICES: readonly Choice[] = [
  { value: 'anthropic', description: 'Anthropic account usage limits (executor models such as anthropic/MODEL)' },
  { value: 'claude-code', description: 'Claude Code subscription usage limits (requires claude-code/MODEL executor models)' },
  { value: 'openai', description: 'OpenAI account usage limits (executor models such as openai/MODEL)' },
  { value: 'kimi', description: 'Kimi Code usage limits' },
];

export const AUTHENTICATION_CHOICES: readonly Choice[] = [
  { value: 'basic', description: 'HTTP Basic; the password is read from an environment variable at run time' },
  { value: 'none', description: 'No authentication; the OpenCode server runs without a password' },
  { value: 'openchamber', description: 'Token from the local OpenChamber Desktop profile (its port must match the URL)' },
];

const DEFAULT_PASSWORD_ENVIRONMENT_VARIABLE = 'OPENCODE_PASSWORD';

/** Order in which missing decisions are asked. */
const DECISIONS = [
  { flag: '--planner-model', key: 'plannerModel' },
  { flag: '--executor-model', key: 'executorModel' },
  { flag: '--quota-provider', key: 'quotaProvider' },
  { flag: '--opencode-url', key: 'opencodeUrl' },
  { flag: '--opencode-auth', key: 'opencodeAuth' },
] as const;

class WizardCancelled extends Error {}

/** Runs the wizard. Returns the completed input, or null when the user cancelled (Ctrl-C or end of input). */
export async function runWizard(request: SetupPromptRequest, streams: WizardStreams): Promise<SetupInput | null> {
  const { stdout } = streams;
  // Text that quotes paths or validation messages passes through the sanitizer; fixed prompt text does not.
  const sanitize = request.sanitize ?? ((text: string): string => text);
  const options: SetupOptions = {
    environment: request.environment,
    ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
    ...(request.homeDirectory === undefined ? {} : { homeDirectory: request.homeDirectory }),
  };
  const rl = readline.createInterface({ input: streams.stdin, output: stdout, terminal: true });
  const ended = new Promise<null>(resolve => {
    rl.once('close', () => resolve(null));
    rl.once('SIGINT', () => resolve(null));
  });
  const say = (text = ''): void => { stdout.write(`${text}\n`); };
  const ask = async (query: string): Promise<string> => {
    const answer = await Promise.race([rl.question(query), ended]);
    if (answer === null) throw new WizardCancelled();
    return answer.trim();
  };

  /** Accepts an answer only when the core's own validation does not reject it as invalid input. */
  const accept = async (input: SetupInput, candidate: SetupInput): Promise<string | null> => {
    try { await planSetup({ ...input, ...candidate }, options); return null; }
    catch (error) {
      if (error instanceof SetupError && error.code === 'invalid-input') return error.message;
      return null;
    }
  };

  const chooseFrom = (choices: readonly Choice[], answer: string): string | undefined => {
    const index = /^[0-9]{1,2}$/.test(answer) ? Number(answer) - 1 : -1;
    return choices[index]?.value ?? choices.find(choice => choice.value === answer)?.value;
  };

  const askDecision = async (input: SetupInput, key: typeof DECISIONS[number]['key']): Promise<string> => {
    while (true) {
      let answer: string;
      if (key === 'plannerModel') {
        say('Planner model: the model that plans each task, written PROVIDER/MODEL (for example anthropic/MODEL).');
        answer = await ask('Planner model: ');
      } else if (key === 'executorModel') {
        say('Executor model: the primary model that carries out each task, written PROVIDER/MODEL.');
        answer = await ask('Executor model: ');
      } else if (key === 'quotaProvider') {
        say('Quota provider: whose usage limits Heimdall consults before choosing the executor.');
        QUOTA_PROVIDER_CHOICES.forEach((choice, index) => say(`  ${index + 1}) ${choice.value} - ${choice.description}`));
        const chosen = chooseFrom(QUOTA_PROVIDER_CHOICES, await ask('Quota provider (name or number): '));
        if (chosen === undefined) { say('Choose one of: ' + QUOTA_PROVIDER_CHOICES.map(choice => choice.value).join(', ') + '.'); continue; }
        answer = chosen;
      } else if (key === 'opencodeUrl') {
        say('OpenCode URL: the local OpenCode server origin, for example http://127.0.0.1:4096 (loopback only).');
        answer = await ask('OpenCode URL: ');
      } else {
        say('OpenCode authentication:');
        AUTHENTICATION_CHOICES.forEach((choice, index) => say(`  ${index + 1}) ${choice.value} - ${choice.description}`));
        const chosen = chooseFrom(AUTHENTICATION_CHOICES, await ask('Authentication (name or number): '));
        if (chosen === undefined) { say('Choose one of: ' + AUTHENTICATION_CHOICES.map(choice => choice.value).join(', ') + '.'); continue; }
        answer = chosen;
      }
      if (answer === '') { say('A value is required; setup does not guess it.'); continue; }
      const reason = await accept(input, { [key]: answer });
      if (reason !== null) { say(sanitize(reason)); continue; }
      return answer;
    }
  };

  const askPasswordVariable = async (input: SetupInput): Promise<string> => {
    say('Password variable: name the environment variable that holds the OpenCode password.');
    say('Enter the variable name only; the password itself is never requested or stored.');
    while (true) {
      const answer = await ask(`Environment variable [${DEFAULT_PASSWORD_ENVIRONMENT_VARIABLE}]: `) || DEFAULT_PASSWORD_ENVIRONMENT_VARIABLE;
      // The core's message could quote what was typed; a pasted password must not be echoed back.
      if (await accept(input, { passwordEnv: answer }) === null) return answer;
      say('That is not a valid environment variable name (letters, digits and underscores, not starting with a digit). Enter the name, never the password.');
    }
  };

  const showTargets = async (trace: SetupTrace): Promise<void> => {
    const existing = trace.coordinatorPath === undefined ? false : await fs.lstat(trace.coordinatorPath).then(() => true, () => false);
    say('Heimdall setup');
    if (trace.projectDirectory !== undefined) say(sanitize(`  Project:                   ${trace.projectDirectory}`));
    if (trace.coordinatorPath !== undefined) say(sanitize(`  Coordinator configuration: ${trace.coordinatorPath} (${existing ? 'exists; reused unchanged' : 'will be created'})`));
    if (trace.projectPath !== undefined) say(sanitize(`  Project configuration:     ${trace.projectPath} (will be created)`));
    say('Only decisions that are still missing are asked. Nothing is written until every answer is valid; Ctrl-C cancels.');
    say();
  };

  try {
    let input: SetupInput = { ...request.input };
    for (let round = 0; round < 8; round += 1) {
      const trace: SetupTrace = {};
      try {
        await planSetup(input, options, trace);
        return input;
      } catch (error) {
        if (!(error instanceof SetupError)) return input;
        if (error.code === 'no-git-project' && request.input.projectDirectory === undefined) {
          say(round === 0 ? 'The current directory is not inside a Git project.' : sanitize(`${input.projectDirectory} is not inside a Git project.`));
          say('Project directory: an existing Git project that has at least one commit.');
          const answer = await ask('Project directory: ');
          if (answer === '') { say('A value is required; setup does not guess it.'); continue; }
          input = { ...input, projectDirectory: answer };
          continue;
        }
        if (error.code !== 'missing-input') return input;
        await showTargets(trace);
        let askedAuthentication = false;
        for (const decision of DECISIONS) {
          if (input[decision.key] !== undefined || !error.missing.includes(decision.flag)) continue;
          input = { ...input, [decision.key]: await askDecision(input, decision.key) };
          if (decision.key === 'opencodeAuth') askedAuthentication = true;
        }
        if (askedAuthentication && input.opencodeAuth === 'basic' && input.passwordEnv === undefined) {
          input = { ...input, passwordEnv: await askPasswordVariable(input) };
        }
        return input;
      }
    }
    return input;
  } catch (error) {
    if (error instanceof WizardCancelled) { say(); return null; }
    throw error;
  } finally {
    rl.close();
  }
}
