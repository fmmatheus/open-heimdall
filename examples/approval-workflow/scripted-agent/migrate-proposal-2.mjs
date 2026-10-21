// Corrected proposal for task 2, after the owner asked to keep LEDGER_TENANT unchanged and to make the change reversible.
// Usage: node migrations/ledger-v2.mjs --dry-run | --apply | --rollback
// Output names variables only; values from the environment file are never printed.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORWARD = { LEDGER_URL: 'LEDGER_BASE_URL', LEDGER_API_TOKEN: 'LEDGER_TOKEN' };
const mode = process.argv[2];
if (!['--dry-run', '--apply', '--rollback'].includes(mode)) { console.error('usage: ledger-v2.mjs --dry-run | --apply | --rollback'); process.exit(2); }

const rollback = mode === '--rollback';
const renames = rollback ? Object.fromEntries(Object.entries(FORWARD).map(([from, to]) => [to, from])) : FORWARD;
const configFile = path.join(root, 'integrations/ledger/config.json');
const config = JSON.parse(readFileSync(configFile, 'utf8'));
const envFile = path.join(root, config.environmentFile);

const migrated = readFileSync(envFile, 'utf8').split('\n').map(line => {
  const at = line.indexOf('=');
  if (line.startsWith('#') || at === -1) return line;
  const name = line.slice(0, at);
  const value = line.slice(at + 1);
  const target = renames[name];
  if (!target) return line;
  const url = name === 'LEDGER_URL' || name === 'LEDGER_BASE_URL';
  return `${target}=${url ? value.replace(rollback ? /\/v2$/ : /\/v1$/, rollback ? '/v1' : '/v2') : value}`;
});
for (const [from, to] of Object.entries(renames)) console.log(`${mode === '--dry-run' ? 'would rename' : 'renamed'} ${from} -> ${to}`);
if (mode !== '--dry-run') {
  writeFileSync(envFile, migrated.join('\n'));
  config.apiVersion = rollback ? 'v1' : 'v2';
  config.variables = { ...config.variables, url: renames[config.variables.url] ?? config.variables.url, token: renames[config.variables.token] ?? config.variables.token };
  writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n');
}
