// Task 1 output: a small client that resolves the integration's variable NAMES from its configuration.
import { readFileSync } from 'node:fs';

export function loadConfiguration(file = new URL('./config.json', import.meta.url)) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function requiredVariables(configuration) {
  return Object.values(configuration.variables);
}
