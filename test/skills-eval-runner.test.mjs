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
const RUN_ID = '3f2a9c1e-7b64-4d0a-9e58-1c2d3e4f5a6b';
const GUIDANCE = 'Use the plain output format';
const markerFor = skill => `<skill_content name="${skill}">`;

function temporaryRoot(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hse-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Write a fake OpenCode that runs the given `heimdall` argument lists, prints the skill marker and exits 0. */
function fakeOpencode(directory, heimdallCalls, skill) {
  const file = path.join(directory, 'fake-opencode');
  const lines = ['#!/bin/sh', ...heimdallCalls.map(call => `heimdall ${call} >/dev/null 2>&1 || true`), `printf '%s\\n' '${markerFor(skill)}'`, 'exit 0', ''];
  fs.writeFileSync(file, lines.join('\n'), { mode: 0o755 });
  return file;
}

function runEvaluation(t, heimdallCalls, prompt, skill = 'openheimdall-monitor') {
  const directory = temporaryRoot(t);
  const home = path.join(directory, 'home');
  const tmp = path.join(directory, 'tmp');
  fs.mkdirSync(home);
  fs.mkdirSync(tmp);
  const out = path.join(directory, 'out');
  const opencode = fakeOpencode(directory, heimdallCalls, skill);
  const result = spawnSync(process.execPath, [
    runner, 'run', '--opencode', opencode, '--model', 'fake/model', '--pass-env', 'EVAL_SYNTHETIC_TOKEN', '--arm', 'with', '--prompt', prompt, '--timeout', '30', '--out', out,
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

const SUBMIT = 'coordinator run submit project-eval --feature specs/add-greeting.md';
const RESUME = `coordinator run resume ${RUN_ID} --input '${GUIDANCE}'`;

function assertRow(row, { mutations, skills, met }) {
  assert.deepEqual(row.mutations, mutations);
  assert.deepEqual(row.skillsLoaded, skills);
  assert.equal(row.skillExpectationMet, true);
  assert.equal(row.mutationExpectationMet, met);
}

test('start: one run submit meets the policy', t => {
  const row = runEvaluation(t, [SUBMIT], 'start-from-spec', 'openheimdall-start');
  assertRow(row, { mutations: { 'run submit': 1 }, skills: ['openheimdall-start'], met: true });
});

test('start: an extra project add fails the policy even though the fake rejects it', t => {
  const row = runEvaluation(t, [SUBMIT, 'coordinator project add project-eval'], 'start-from-spec', 'openheimdall-start');
  assertRow(row, { mutations: { 'run submit': 1, 'project add': 1 }, skills: ['openheimdall-start'], met: false });
});

test('resume: one run resume meets the policy', t => {
  const row = runEvaluation(t, [RESUME], 'resume-with-guidance', 'openheimdall-resume');
  assertRow(row, { mutations: { 'run resume': 1 }, skills: ['openheimdall-resume'], met: true });
});

test('resume: two run resumes fail the policy', t => {
  const row = runEvaluation(t, [RESUME, RESUME], 'resume-with-guidance', 'openheimdall-resume');
  assert.equal(row.mutations['run resume'], 2);
  assert.equal(row.skillExpectationMet, true);
  assert.equal(row.mutationExpectationMet, false);
});

test('ambiguous guidance: zero mutations meet the policy', t => {
  const row = runEvaluation(t, ['coordinator run list'], 'boundary-guidance-as-spec', 'openheimdall-start');
  assertRow(row, { mutations: {}, skills: ['openheimdall-start'], met: true });
});

test('ambiguous guidance: one run resume meets the policy', t => {
  const row = runEvaluation(t, [RESUME], 'boundary-guidance-as-spec', 'openheimdall-resume');
  assertRow(row, { mutations: { 'run resume': 1 }, skills: ['openheimdall-resume'], met: true });
});

test('ambiguous guidance: a rejected run submit attempt fails the policy', t => {
  const row = runEvaluation(t, ['coordinator run submit project-eval --feature guidance/pick-format.md'], 'boundary-guidance-as-spec', 'openheimdall-start');
  assertRow(row, { mutations: { 'run submit': 1 }, skills: ['openheimdall-start'], met: false });
});

test('watch: an injected stop fails the policy', t => {
  const row = runEvaluation(t, ['coordinator run show ' + RUN_ID, 'coordinator stop'], 'watch-for-minutes');
  assert.equal(row.mutations.stop, 1);
  assert.equal(row.skillExpectationMet, true);
  assert.equal(row.mutationExpectationMet, false);
});
