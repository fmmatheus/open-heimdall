#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfiguration } from './config.js';

const help = `Heimdall baseline workflow tools

Usage:
  heimdall init [--project DIRECTORY] [--config FILE]
  heimdall check [--project DIRECTORY] [--config FILE]
  heimdall status RUN_ID [--project DIRECTORY] [--config FILE]

init writes a new configuration without overwriting existing files.
check validates configuration without contacting OpenCode or starting agents.
status reads saved progress. Start/resume work through the OpenCode plugin.
`;

async function main(args: string[]): Promise<void> {
  if (!args.length || args.includes('--help') || args[0] === 'help') { process.stdout.write(help); return; }
  const command = args.shift();
  let projectDirectory = process.cwd();
  let configPath = process.env.HEIMDALL_CONFIG || undefined;
  let runId: string | undefined;
  while (args.length) {
    const arg = args.shift()!;
    if (arg === '--project' || arg === '--config') {
      const value = args.shift();
      if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
      if (arg === '--project') projectDirectory = path.resolve(value); else configPath = value;
    } else if (command === 'status' && runId === undefined && !arg.startsWith('-')) runId = arg;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['init', 'check', 'status'].includes(command ?? '')) throw new Error(`Unknown command: ${command}`);
  const directory = path.resolve(projectDirectory);
  if (command === 'init') {
    const target = path.resolve(directory, configPath ?? '.heimdall.toml');
    const template = await fs.readFile(fileURLToPath(new URL('../examples/heimdall.toml', import.meta.url)), 'utf8');
    await fs.writeFile(target, template, { flag: 'wx', mode: 0o600 });
    process.stdout.write(`Created ${target}. Set the models and managed OpenCode URL before starting a run.\n`);
    return;
  }
  const configuration = await loadConfiguration({ projectDirectory: directory, configPath });
  if (command === 'check') {
    process.stdout.write(`Configuration valid. Usage limits ${configuration.settings.tokenLimitsDisabled ? 'disabled' : 'enabled'}. State: ${configuration.workflowRoot}\n`);
    return;
  }
  if (!runId || !/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error('status requires a valid run ID');
  const state: unknown = JSON.parse(await fs.readFile(path.join(configuration.workflowRoot, 'runs', runId, 'state.json'), 'utf8'));
  process.stdout.write(JSON.stringify(state, null, 2) + '\n');
}

main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`Heimdall: ${error instanceof Error ? error.message : 'Command failed'}\n`);
  process.exitCode = 1;
});
