import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface DesktopClientConnection { port: number; token: string }
export interface DesktopConnectionOptions {
  readFile?: (file: string, encoding: 'utf8') => Promise<string>;
  homeDirectory?: string;
}

/** Follows OpenChamber Desktop's CLI settings path; never persists its token. */
export async function readDesktopConnection(base: URL, environment: NodeJS.ProcessEnv, {
  readFile = fs.readFile,
  homeDirectory = os.homedir(),
}: DesktopConnectionOptions = {}): Promise<DesktopClientConnection> {
  if (base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) throw new Error('OpenChamber Desktop requires a local HTTP origin');
  const configuredDirectory = environment.OPENCHAMBER_DATA_DIR;
  const dataDirectory = typeof configuredDirectory === 'string' && configuredDirectory.trim()
    ? path.resolve(configuredDirectory.trim()) : path.join(homeDirectory, '.config', 'openchamber');
  let settings: unknown;
  try { settings = JSON.parse(await readFile(path.join(dataDirectory, 'settings.json'), 'utf8')); }
  catch { throw new Error('OpenChamber Desktop settings unavailable; open Desktop before connecting'); }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('Invalid OpenChamber Desktop connection settings');
  const selected = settings as Record<string, unknown>;
  const port = selected.desktopLocalPort;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535 || Number(base.port || 80) !== port) throw new Error('Configured OpenChamber URL must match the Desktop local port');
  const token = typeof selected.desktopLocalClientToken === 'string' ? selected.desktopLocalClientToken.trim() : '';
  if (!token || /[\x00-\x20\x7f]/.test(token)) throw new Error('OpenChamber Desktop local client token is unavailable');
  return { port, token };
}
