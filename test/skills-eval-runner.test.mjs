import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// End-to-end checks of `run-eval.mjs run` with an explicit fake OpenCode executable and the evaluation kit's
// fake `heimdall`. No real host, model or credential is involved; the pass-through variable is synthetic.
// Expectations are asserted on the recorded results.json rows, never on the runner's exit status.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runner = path.join(root, 'scripts', 'live', 'skills-eval', 'run-eval.mjs');
const MARKER = '<skill_content name="openheimdall-monitor">';

function temporaryRoot(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hse-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Write a fake OpenCode that runs the given `heimdall` argument lists, prints the monitor skill marker and exits 0. */
function fakeOpencode(directory, heimdallCalls) {
  const file = path.join(directory, 'fake-opencode');
  const lines = ['#!/bin/sh', ...heimdallCalls.map(call => `heimdall ${call} >/dev/null 2>&1 || true`), `printf '%s\\n' '${MARKER}'`, 'exit 0', ''];
  fs.writeFileSync(file, lines.join('\n'), { mode: 0o755 });
  return file;
}

function runEvaluation(t, heimdallCalls, prompt) {
  const directory = temporaryRoot(t);
  const home = path.join(directory, 'home');
  const tmp = path.join(directory, 'tmp');
  fs.mkdirSync(home);
  fs.mkdirSync(tmp);
  const out = path.join(directory, 'out');
  const opencode = fakeOpencode(directory, heimdallCalls);
  const result = spawnSync(process.execPath, [
    runner, 'run', '--opencode', opencode, '--model', 'fake/model', '--pass-env', 'EVAL_SYNTHETIC_TOKEN', '--arm', 'with', '--prompt', prompt, '--out', out,
  ], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmp, EVAL_SYNTHETIC_TOKEN: 'synthetic' },
  });
  const rows = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8'));
  assert.equal(rows.length, 1, `${result.stderr}${result.stdout}`);
  return rows[0];
}

test('a monitor run that attempts coordinator start does not meet its mutation expectation', t => {
  const row = runEvaluation(t, ['coordinator start'], 'snapshot-status');
  assert.equal(row.mutations.start, 1);
  assert.equal(row.skillExpectationMet, true);
  assert.equal(row.mutationExpectationMet, false);
});

test('a clean read-only monitor run meets its mutation expectation', t => {
  const row = runEvaluation(t, ['coordinator status --json', 'coordinator run list'], 'snapshot-status');
  assert.deepEqual(row.mutations, {});
  assert.equal(row.skillExpectationMet, true);
  assert.equal(row.mutationExpectationMet, true);
});
