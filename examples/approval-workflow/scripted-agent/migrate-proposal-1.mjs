// First proposal for task 2: move the ledger integration to API v2.
// Usage: node migrations/ledger-v2.mjs --dry-run | --apply
// Output names variables only; values from the environment file are never printed.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RENAMES = { LEDGER_URL: 'LEDGER_BASE_URL', LEDGER_API_TOKEN: 'LEDGER_TOKEN', LEDGER_TENANT: 'LEDGER_ACCOUNT' };
const mode = process.argv[2];
if (mode !== '--dry-run' && mode !== '--apply') { console.error('usage: ledger-v2.mjs --dry-run | --apply'); process.exit(2); }

const configFile = path.join(root, 'integrations/ledger/config.json');
const config = JSON.parse(readFileSync(configFile, 'utf8'));
const envFile = path.join(root, config.environmentFile);
const lines = readFileSync(envFile, 'utf8').split('\n');

const migrated = lines.map(line => {
  const at = line.indexOf('=');
  if (line.startsWith('#') || at === -1) return line;
  const name = line.slice(0, at);
  const value = line.slice(at + 1);
  const target = RENAMES[name];
  if (!target) return line;
  return `${target}=${name === 'LEDGER_URL' ? value.replace(/\/v1$/, '/v2') : value}`;
});
for (const [from, to] of Object.entries(RENAMES)) console.log(`${mode === '--apply' ? 'renamed' : 'would rename'} ${from} -> ${to}`);
if (mode === '--apply') {
  writeFileSync(envFile, migrated.join('\n'));
  config.apiVersion = 'v2';
  config.variables = { url: RENAMES.LEDGER_URL, token: RENAMES.LEDGER_API_TOKEN, tenant: RENAMES.LEDGER_TENANT };
  writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
}
