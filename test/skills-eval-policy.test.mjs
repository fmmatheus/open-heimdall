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
const MUTATION_KEYS = ['start', 'stop', 'run reconcile', 'run submit', 'run resume', 'project add'];

test('every scenario states an explicit mutation policy', () => {
  assert.deepEqual(prompts.map(prompt => prompt.id), ['start-from-spec', 'snapshot-status', 'watch-for-minutes', 'resume-with-guidance', 'boundary-guidance-as-spec']);
  for (const prompt of prompts) assert.equal(typeof prompt.expect.mutationPolicy, 'object', prompt.id);
  assert.deepEqual(policyOf('boundary-guidance-as-spec'), { 'run resume': { min: 0, max: 1 } });
});

for (const id of ['snapshot-status', 'watch-for-minutes']) {
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

test('resume-with-guidance: exactly one run resume and nothing else', () => {
  const policy = policyOf('resume-with-guidance');
  assert.equal(mutationsMeetPolicy({ 'run resume': 1 }, policy), true);
  assert.equal(mutationsMeetPolicy({}, policy), false);
  assert.equal(mutationsMeetPolicy({ 'run resume': 2 }, policy), false);
  for (const key of MUTATION_KEYS.filter(item => item !== 'run resume')) {
    assert.equal(mutationsMeetPolicy({ 'run resume': 1, [key]: 1 }, policy), false, key);
  }
});

test('boundary-guidance-as-spec: zero or one run resume, nothing else', () => {
  const policy = policyOf('boundary-guidance-as-spec');
  assert.equal(mutationsMeetPolicy({}, policy), true);
  assert.equal(mutationsMeetPolicy({ 'run resume': 1 }, policy), true);
  assert.equal(mutationsMeetPolicy({ 'run resume': 2 }, policy), false);
  for (const key of MUTATION_KEYS.filter(item => item !== 'run resume')) {
    assert.equal(mutationsMeetPolicy({ [key]: 1 }, policy), false, key);
    assert.equal(mutationsMeetPolicy({ 'run resume': 1, [key]: 1 }, policy), false, key);
  }
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
