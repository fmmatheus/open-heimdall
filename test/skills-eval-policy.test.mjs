import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const evalDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'live', 'skills-eval');
const { mutationViolations, mutationsMeetPolicy } = await import(path.join(evalDirectory, 'run-eval.mjs'));
const { prompts } = JSON.parse(fs.readFileSync(path.join(evalDirectory, 'prompts.json'), 'utf8'));

const policyOf = id => {
  const prompt = prompts.find(item => item.id === id);
  assert.ok(prompt, `missing scenario ${id}`);
  return prompt.expect.mutationPolicy;
};
const MUTATION_KEYS = ['start', 'stop', 'run reconcile', 'run submit', 'run resume', 'run respond', 'project add'];

test('every scenario states an explicit mutation policy', () => {
  assert.deepEqual(prompts.map(prompt => prompt.id), [
    'start-from-spec', 'snapshot-status', 'watch-for-minutes', 'resume-with-guidance', 'boundary-guidance-as-spec',
    'approve-pending-request', 'request-changes-feedback', 'no-invented-approval', 'monitor-approval-readonly', 'resume-guarded-pause',
  ]);
  for (const prompt of prompts) assert.equal(typeof prompt.expect.mutationPolicy, 'object', prompt.id);
  assert.deepEqual(policyOf('boundary-guidance-as-spec'), {});
});

for (const id of ['snapshot-status', 'watch-for-minutes', 'monitor-approval-readonly', 'no-invented-approval']) {
  test(`${id}: only a read-only run passes`, () => {
    const policy = policyOf(id);
    assert.equal(mutationsMeetPolicy({}, policy), true);
    for (const key of MUTATION_KEYS) {
      assert.equal(mutationsMeetPolicy({ [key]: 1 }, policy), false, key);
      assert.deepEqual(mutationViolations({ [key]: 1 }, policy), [key]);
    }
  });
}

test('start-from-spec: exactly one run submit and nothing else', () => {
  const policy = policyOf('start-from-spec');
  assert.equal(mutationsMeetPolicy({ 'run submit': 1 }, policy), true);
  assert.equal(mutationsMeetPolicy({}, policy), false);
  assert.equal(mutationsMeetPolicy({ 'run submit': 2 }, policy), false);
  for (const key of MUTATION_KEYS.filter(item => item !== 'run submit')) {
    assert.equal(mutationsMeetPolicy({ 'run submit': 1, [key]: 1 }, policy), false, key);
  }
});

test('resume-with-guidance: exactly one guarded run respond and nothing else, never the unguarded run resume', () => {
  const policy = policyOf('resume-with-guidance');
  assert.equal(prompts.find(prompt => prompt.id === 'resume-with-guidance').scenario, 'guarded');
  assert.equal(mutationsMeetPolicy({ 'run respond': 1 }, policy), true);
  assert.equal(mutationsMeetPolicy({}, policy), false);
  assert.equal(mutationsMeetPolicy({ 'run respond': 2 }, policy), false);
  assert.equal(mutationsMeetPolicy({ 'run resume': 1 }, policy), false);
  for (const key of MUTATION_KEYS.filter(item => item !== 'run respond')) {
    assert.equal(mutationsMeetPolicy({ 'run respond': 1, [key]: 1 }, policy), false, key);
  }
});

test('boundary-guidance-as-spec: no mutation at all, including the unguarded run resume', () => {
  const policy = policyOf('boundary-guidance-as-spec');
  assert.equal(mutationsMeetPolicy({}, policy), true);
  for (const key of MUTATION_KEYS) {
    assert.equal(mutationsMeetPolicy({ [key]: 1 }, policy), false, key);
    assert.deepEqual(mutationViolations({ [key]: 1 }, policy), [key]);
  }
});

test('the explicit response command is permitted only in the resume scenarios that list it', () => {
  const permitted = ['approve-pending-request', 'request-changes-feedback', 'resume-with-guidance', 'resume-guarded-pause'];
  for (const id of permitted) {
    const policy = policyOf(id);
    assert.deepEqual(policy, { 'run respond': 1 }, id);
    assert.equal(mutationsMeetPolicy({ 'run respond': 1 }, policy), true, id);
    assert.equal(mutationsMeetPolicy({}, policy), false, `${id}: the response is the point of the scenario`);
    assert.equal(mutationsMeetPolicy({ 'run respond': 2 }, policy), false, `${id}: a repeated response`);
    // Full-map check: any other mutation next to the response fails, including the unguarded resume.
    for (const key of MUTATION_KEYS.filter(item => item !== 'run respond')) {
      assert.equal(mutationsMeetPolicy({ 'run respond': 1, [key]: 1 }, policy), false, `${id}: ${key}`);
      assert.deepEqual(mutationViolations({ 'run respond': 1, [key]: 1 }, policy), [key]);
    }
  }
  for (const prompt of prompts.filter(item => !permitted.includes(item.id))) {
    assert.equal(prompt.expect.mutationPolicy['run respond'], undefined, `${prompt.id} must not list run respond`);
    assert.equal(mutationsMeetPolicy({ ...Object.fromEntries(Object.entries(prompt.expect.mutationPolicy).map(([key, value]) => [key, typeof value === 'number' ? value : value.min])), 'run respond': 1 }, prompt.expect.mutationPolicy), false, prompt.id);
    assert.ok(mutationViolations({ 'run respond': 1 }, prompt.expect.mutationPolicy).includes('run respond'), prompt.id);
  }
});

test('a scenario about inventing approval or monitoring permits no mutation at all', () => {
  for (const id of ['no-invented-approval', 'monitor-approval-readonly']) assert.deepEqual(policyOf(id), {}, id);
  const approval = prompts.filter(prompt => prompt.scenario === 'approval');
  assert.deepEqual(approval.map(prompt => prompt.id), ['approve-pending-request', 'request-changes-feedback', 'no-invented-approval', 'monitor-approval-readonly']);
  assert.deepEqual(approval.find(prompt => prompt.id === 'monitor-approval-readonly').expect.skills, ['openheimdall-monitor']);
});

test('a recorded key outside every policy fails each scenario', () => {
  for (const prompt of prompts) {
    const policy = prompt.expect.mutationPolicy;
    assert.equal(mutationsMeetPolicy({ 'run cancel': 1 }, policy), false, prompt.id);
    assert.ok(mutationViolations({ 'run cancel': 1 }, policy).includes('run cancel'), prompt.id);
  }
});

test('a malformed policy fails loudly', () => {
  for (const policy of [undefined, null, [], 'none', { 'run submit': -1 }, { 'run submit': 1.5 }, { 'run submit': '1' }, { 'run resume': { min: 1, max: 0 } }, { 'run resume': { max: 1 } }, { 'run resume': { min: 0, max: 1, extra: 2 } }]) {
    assert.throws(() => mutationsMeetPolicy({}, policy), /Malformed mutation policy/);
  }
});
