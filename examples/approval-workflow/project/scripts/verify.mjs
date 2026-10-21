// Checks that the ledger integration configuration and its environment file agree.
// Usage: node scripts/verify.mjs [--expect v1|v2]
// Output is limited to check names, counts and variable NAMES. It never prints a value from the environment file.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const expectIndex = process.argv.indexOf('--expect');
const expected = expectIndex === -1 ? undefined : process.argv[expectIndex + 1];

const config = JSON.parse(readFileSync(path.join(root, 'integrations/ledger/config.json'), 'utf8'));
const names = new Set(readFileSync(path.join(root, config.environmentFile), 'utf8').split('\n')
  .filter(line => line.trim() !== '' && !line.startsWith('#') && line.includes('='))
  .map(line => line.slice(0, line.indexOf('='))));

const checks = [
  ['configuration parses', typeof config.apiVersion === 'string'],
  ...(expected ? [[`api version is ${expected}`, config.apiVersion === expected]] : []),
  ...Object.entries(config.variables).map(([role, name]) => [`${role} variable ${name} is defined`, names.has(name)]),
];
const failed = checks.filter(([, ok]) => !ok);
for (const [name, ok] of checks) console.log(`${ok ? 'ok' : 'FAIL'} ${name}`);
console.log(`ledger verification: ${checks.length - failed.length} of ${checks.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
