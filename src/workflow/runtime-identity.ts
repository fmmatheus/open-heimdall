import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SUBMISSION_PROTOCOL } from './contracts.js';
import type { RuntimeIdentity } from './types.js';

let cached: RuntimeIdentity | undefined;

/** Identity of the code that is executing. Read from the package this module was loaded from, not from Git. */
export function runtimeIdentity(): RuntimeIdentity {
  if (cached) return { ...cached };
  let packageVersion = 'unknown';
  try {
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8')) as { version?: unknown };
    if (typeof manifest.version === 'string' && manifest.version) packageVersion = manifest.version;
  } catch {}
  cached = { packageVersion, protocol: SUBMISSION_PROTOCOL };
  return { ...cached };
}
