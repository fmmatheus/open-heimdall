import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { parse } from 'smol-toml';

export interface CoordinatorConfiguration {
  stateDirectory: string;
  endpoint: string;
  globalConcurrency: number;
  projectConcurrency: number;
}

async function canonicalPlannedDirectory(value: string): Promise<string> {
  const suffix: string[] = [];
  let ancestor = path.resolve(value);
  while (true) {
    try { return path.join(await fs.realpath(ancestor), ...suffix); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

export function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

export async function loadCoordinatorConfiguration(configPath?: string): Promise<CoordinatorConfiguration> {
  const file = path.resolve(configPath ?? process.env.HEIMDALL_COORDINATOR_CONFIG ?? path.join(os.homedir(), '.config', 'heimdall', 'coordinator.toml'));
  let content: string;
  try { content = await fs.readFile(file, 'utf8'); }
  catch (error) {
    if (configPath || process.env.HEIMDALL_COORDINATOR_CONFIG || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    content = '';
  }
  const document = parse(content, { unsafeKeyBehaviour: 'throw' });
  if (Object.keys(document).some(key => key !== 'coordinator')) throw new Error('Only [coordinator] settings are accepted');
  const settings = document.coordinator ?? {};
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings) || settings instanceof Date) throw new Error('coordinator must be a TOML table');
  const values = settings as Record<string, unknown>;
  for (const key of Object.keys(values)) if (!['stateDirectory', 'globalConcurrency', 'projectConcurrency'].includes(key)) throw new Error(`Unknown coordinator setting: ${key}`);
  const defaultState = process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'Heimdall') : path.join(os.homedir(), '.local', 'state', 'heimdall');
  if (values.stateDirectory !== undefined && (typeof values.stateDirectory !== 'string' || !values.stateDirectory.trim())) throw new Error('stateDirectory must be a nonempty path');
  const stateDirectory = await canonicalPlannedDirectory(values.stateDirectory === undefined ? defaultState : path.resolve(path.dirname(file), values.stateDirectory as string));
  const identity = createHash('sha256').update(process.platform === 'win32' ? stateDirectory.toLowerCase() : stateDirectory).digest('hex').slice(0, 24);
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\heimdall-${identity}` : path.join(stateDirectory, 'coordinator.sock');
  if (process.platform !== 'win32' && Buffer.byteLength(endpoint) > 100) throw new Error('stateDirectory is too long for a portable Unix socket path; choose a shorter path');
  return {
    stateDirectory, endpoint,
    globalConcurrency: positiveInteger(values.globalConcurrency ?? 1, 'globalConcurrency'),
    projectConcurrency: positiveInteger(values.projectConcurrency ?? 1, 'projectConcurrency'),
  };
}
