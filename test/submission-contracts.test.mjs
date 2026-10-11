import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  SUBMISSION_PROTOCOL, SUBMISSION_KINDS, SUBMISSION_TOOL_IDS, IDENTITY_FIELDS, plannerPlanContract, executorResultContract,
  contractFieldNames, submissionInputSchema, submissionToolDescription, validatePlannerPlan, validateExecutorResult,
  validateSubmission, submissionKindOfTool, isLookalikeSubmissionTool,
} from '../dist/workflow/contracts.js';
import { loadPlanSnapshot } from '../dist/workflow/plan-snapshot.js';
import { validatePlan } from '../dist/workflow/runner.js';

const task = (id, extra = {}) => ({ id, title: 'Title ' + id, brief: 'Brief ' + id, dependsOn: [], dod: ['gate one', 'gate two'], ...extra });
const inline = (tasks = [task('T1'), task('T2', { dependsOn: ['T1'] })]) => ({ status: 'planned', planMarkdown: '# Plan', factSheet: '# Facts', tasks });
const completed = (extra = {}) => ({
  status: 'completed', summary: 'Done', handoff: 'Next', evidence: [
    { gateId: 'G1', passed: true, detail: 'proved one' }, { gateId: 'G2', passed: true, detail: 'proved two' },
  ], ...extra,
});
const plan = raw => validatePlannerPlan(raw, { limit: 7 });
const result = raw => validateExecutorResult(raw, { dodCount: 2 });
const errorsOf = outcome => { assert.equal(outcome.ok, false, JSON.stringify(outcome)); return outcome.errors; };
const has = (errors, errorPath, code) => assert.ok(errors.some(e => e.path === errorPath && e.code === code), `${code} at ${errorPath} in ${JSON.stringify(errors)}`);

test('protocol, versions and tool ids are defined once per kind', () => {
  assert.equal(SUBMISSION_PROTOCOL, 'structured-v1');
  assert.deepEqual([...SUBMISSION_KINDS], ['planner-plan', 'executor-result']);
  assert.equal(plannerPlanContract.version, 1);
  assert.equal(executorResultContract.version, 1);
  assert.deepEqual({ ...SUBMISSION_TOOL_IDS }, { 'planner-plan': 'heimdall_submit_plan', 'executor-result': 'heimdall_submit_result' });
  const ok = plan(inline());
  assert.deepEqual(ok.contract, { protocol: 'structured-v1', kind: 'planner-plan', version: 1 });
});

test('tool schema, description and validator derive from one definition', () => {
  const definitions = { 'planner-plan': plannerPlanContract, 'executor-result': executorResultContract };
  for (const kind of SUBMISSION_KINDS) {
    const variantKeys = new Set(Object.values(definitions[kind].variants).flatMap(variant => Object.keys(variant.fields)));
    const schema = submissionInputSchema(kind);
    assert.deepEqual(new Set(Object.keys(schema.properties)), variantKeys, kind);
    assert.deepEqual(contractFieldNames(kind), Object.keys(schema.properties));
    // Permissive transport so every call reaches Heimdall's own validator.
    assert.equal(schema.additionalProperties, true);
    assert.equal(schema.required, undefined);
    for (const property of Object.values(schema.properties)) assert.deepEqual(Object.keys(property), ['description']);
    const description = submissionToolDescription(kind);
    for (const key of variantKeys) assert.ok(description.includes(key), `${kind} description mentions ${key}`);
    for (const identity of IDENTITY_FIELDS) assert.ok(description.includes(identity));
  }
  // The validator is driven by the same definition: dropping any specified field of a valid sample reports exactly that path.
  const samples = { 'planner-plan': { rule: { kind: 'planner-plan', limit: 7 }, variants: { inline: inline(), blocked: { status: 'blocked', reason: 'why' }, artifacts: { status: 'planned', artifacts: true } } }, 'executor-result': { rule: { kind: 'executor-result', dodCount: 2 }, variants: { completed: completed(), blocked: { status: 'blocked', reason: 'why' } } } };
  for (const kind of SUBMISSION_KINDS) {
    for (const [name, sample] of Object.entries(samples[kind].variants)) {
      assert.equal(validateSubmission(samples[kind].rule, sample).ok, true, `${kind}/${name} sample valid`);
      for (const field of Object.keys(definitions[kind].variants[name].fields)) {
        // `status` and the artifacts flag select the variant, so dropping them selects another variant.
        if (field === 'status' || (name === 'artifacts' && field === 'artifacts')) continue;
        const { [field]: _dropped, ...rest } = sample;
        const errors = errorsOf(validateSubmission(samples[kind].rule, rest));
        has(errors, '$.' + field, 'missing_field');
      }
    }
  }
});

test('valid payloads return frozen canonical values with a stable digest and semantic classification', () => {
  const raw = completed();
  const ok = result(raw);
  assert.equal(ok.ok, true);
  assert.equal(ok.outcome, 'completed');
  assert.equal(ok.classification, 'accepted');
  assert.equal(ok.repairable, false);
  assert.ok(Object.isFrozen(ok.value) && Object.isFrozen(ok.value.evidence[0]));
  assert.notEqual(ok.value, raw);
  assert.equal(result(JSON.parse(JSON.stringify(raw))).digest, ok.digest);
  assert.notEqual(result({ ...raw, summary: 'Other' }).digest, ok.digest);
  assert.deepEqual(plan({ status: 'planned', artifacts: true }).variant, 'artifacts');
  assert.equal(plan(inline()).outcome, 'planned');
  assert.equal(plan({ status: 'blocked', reason: 'no api' }).outcome, 'blocked');
});

test('raw input is never mutated and the canonical value is a separate object', () => {
  const raw = inline();
  const frozenCopy = JSON.stringify(raw);
  plan(raw);
  assert.equal(JSON.stringify(raw), frozenCopy);
  const evidence = completed();
  const before = JSON.stringify(evidence);
  const ok = result(evidence);
  assert.equal(JSON.stringify(evidence), before);
  assert.ok(!('gate' in evidence.evidence[0]));
  assert.ok(!Object.isFrozen(evidence));
  assert.ok(ok.ok);
  const bad = { ...completed(), runId: 'x', evidence: [] };
  const badBefore = JSON.stringify(bad);
  assert.equal(result(bad).ok, false);
  assert.equal(JSON.stringify(bad), badBefore);
});

test('model-supplied identity is rejected as unknown with a precise host-derives message', () => {
  for (const field of IDENTITY_FIELDS) {
    const errors = errorsOf(result({ ...completed(), [field]: 'T1' }));
    has(errors, '$.' + field, 'identity_field');
    assert.match(errors.find(e => e.path === '$.' + field).message, /derived by the host/);
  }
  has(errorsOf(plan({ ...inline(), runId: 'r' })), '$.runId', 'identity_field');
  has(errorsOf(plan({ status: 'blocked', reason: 'x', owner: 'me' })), '$.owner', 'identity_field');
  // Identity is also flagged when the status itself is unusable.
  has(errorsOf(result({ status: 'done', taskId: 'T1' })), '$.taskId', 'identity_field');
  // Only root identity is special: a task's own id is a legitimate field.
  assert.equal(plan(inline()).ok, true);
});

test('missing and extra fields, wrong types and empty strings are path-specific format errors', () => {
  const missing = errorsOf(result({ status: 'completed' }));
  for (const field of ['summary', 'handoff', 'evidence']) has(missing, '$.' + field, 'missing_field');
  has(errorsOf(result({ ...completed(), extra: 1 })), '$.extra', 'unknown_field');
  has(errorsOf(result({ ...completed(), summary: 7 })), '$.summary', 'invalid_type');
  has(errorsOf(result({ ...completed(), summary: '   ' })), '$.summary', 'empty_string');
  has(errorsOf(result({ ...completed(), handoff: '' })), '$.handoff', 'empty_string');
  has(errorsOf(result({ ...completed(), evidence: 'ok' })), '$.evidence', 'invalid_type');
  has(errorsOf(result({ ...completed(), evidence: [{ gateId: 'G1', passed: 'yes', detail: 'x' }, { gateId: 'G2', passed: true, detail: 'y' }] })), '$.evidence[0].passed', 'invalid_type');
  has(errorsOf(result({ ...completed(), evidence: [{ gateId: 'G1', passed: true, detail: '' }, { gateId: 'G2', passed: true, detail: 'y' }] })), '$.evidence[0].detail', 'empty_string');
  has(errorsOf(result({ ...completed(), evidence: [{ gateId: 'G1', gate: 'text', passed: true, detail: 'x' }, { gateId: 'G2', passed: true, detail: 'y' }] })), '$.evidence[0].gate', 'unknown_field');
  has(errorsOf(result({ ...completed(), evidence: [{ gateId: 'G1', passed: true }, { gateId: 'G2', passed: true, detail: 'y' }] })), '$.evidence[0].detail', 'missing_field');
  has(errorsOf(result({ status: 'blocked' })), '$.reason', 'missing_field');
  has(errorsOf(result({ status: 'blocked', reason: 'x', summary: 'y' })), '$.summary', 'unknown_field');
  has(errorsOf(result({ status: 'finished' })), '$.status', 'invalid_value');
  has(errorsOf(result({})), '$.status', 'missing_field');
  for (const input of [null, [], 7, true, undefined]) has(errorsOf(result(input)), '$', 'invalid_type');
  class Fake { constructor() { this.status = 'blocked'; this.reason = 'x'; } }
  has(errorsOf(result(new Fake())), '$', 'invalid_type');
  has(errorsOf(plan({ status: 'planned', artifacts: false })), '$.artifacts', 'invalid_value');
  has(errorsOf(plan({ status: 'planned', artifacts: true, planMarkdown: 'x' })), '$.planMarkdown', 'unknown_field');
  has(errorsOf(plan({ status: 'planned' })), '$.planMarkdown', 'missing_field');
});

test('plan tasks: ids, dependencies, dod and limit are validated', () => {
  has(errorsOf(plan(inline([]))), '$.tasks', 'empty_array');
  has(errorsOf(plan(inline([task('bad id!')]))), '$.tasks[0].id', 'invalid_task_id');
  has(errorsOf(plan(inline([task('')]))), '$.tasks[0].id', 'invalid_task_id');
  has(errorsOf(plan(inline([task('T1'), task('T1')]))), '$.tasks[1].id', 'duplicate_task_id');
  has(errorsOf(plan(inline([task('T1', { dependsOn: ['T2'] }), task('T2')]))), '$.tasks[0].dependsOn[0]', 'invalid_dependency');
  has(errorsOf(plan(inline([task('T1', { dependsOn: ['T1'] })]))), '$.tasks[0].dependsOn[0]', 'invalid_dependency');
  has(errorsOf(plan(inline([task('T1', { dependsOn: ['nope'] })]))), '$.tasks[0].dependsOn[0]', 'invalid_dependency');
  has(errorsOf(plan(inline([task('T1', { dod: [] })]))), '$.tasks[0].dod', 'empty_array');
  has(errorsOf(plan(inline([task('T1', { dod: ['ok', ' '] })]))), '$.tasks[0].dod[1]', 'empty_string');
  has(errorsOf(plan(inline([task('T1', { title: '' })]))), '$.tasks[0].title', 'empty_string');
  has(errorsOf(plan(inline([task('T1', { owner: 'x' })]))), '$.tasks[0].owner', 'unknown_field');
  has(errorsOf(plan(inline([task('T1', { dependsOn: 'T0' })]))), '$.tasks[0].dependsOn', 'invalid_type');
  const many = Array.from({ length: 8 }, (_, i) => task('T' + (i + 1)));
  const limited = errorsOf(plan(inline(many)));
  has(limited, '$.tasks', 'task_limit');
  assert.match(limited.find(e => e.code === 'task_limit').message, /8 tasks; maximum is 7/);
  assert.equal(plan(inline(many.slice(0, 7))).ok, true);
});

test('executor evidence: invalid, duplicate, out-of-range and missing gates', () => {
  has(errorsOf(result({ ...completed(), evidence: [{ gateId: 'g1', passed: true, detail: 'x' }, { gateId: 'G2', passed: true, detail: 'y' }] })), '$.evidence[0].gateId', 'invalid_gate_id');
  has(errorsOf(result({ ...completed(), evidence: [{ gateId: 'G0', passed: true, detail: 'x' }, { gateId: 'G2', passed: true, detail: 'y' }] })), '$.evidence[0].gateId', 'invalid_gate_id');
  has(errorsOf(result({ ...completed(), evidence: [{ gateId: 'G01', passed: true, detail: 'x' }, { gateId: 'G2', passed: true, detail: 'y' }] })), '$.evidence[0].gateId', 'invalid_gate_id');
  has(errorsOf(result({ ...completed(), evidence: [{ gateId: 'G1', passed: true, detail: 'x' }, { gateId: 'G1', passed: true, detail: 'y' }] })), '$.evidence[1].gateId', 'duplicate_gate_id');
  has(errorsOf(result({ ...completed(), evidence: [{ gateId: 'G1', passed: true, detail: 'x' }, { gateId: 'G3', passed: true, detail: 'y' }] })), '$.evidence[1].gateId', 'gate_out_of_range');
  has(errorsOf(result({ ...completed(), evidence: [{ gateId: 'G1', passed: true, detail: 'x' }] })), '$.evidence', 'missing_gate');
  const none = errorsOf(result({ ...completed(), evidence: [] }));
  has(none, '$.evidence', 'empty_array');
  assert.equal(none.filter(e => e.code === 'missing_gate').length, 0, 'structural errors stop before coverage');
  assert.equal(validateExecutorResult(completed(), { dodCount: 2 }).ok, true);
  assert.equal(errorsOf(validateExecutorResult(completed(), { dodCount: 3 })).some(e => e.code === 'missing_gate' && /G3/.test(e.message)), true);
});

test('historical malformed shapes are rejected deterministically with precise field feedback', () => {
  const fixtures = [
    ['task instead of taskId', { status: 'completed', task: 'T1', summary: 's', handoff: 'h', evidence: completed().evidence }, [['$.task', 'unknown_field']]],
    ['taskId supplied by the model', { ...completed(), taskId: 'T1' }, [['$.taskId', 'identity_field']]],
    ['omitted handoff', { status: 'completed', summary: 's', evidence: completed().evidence }, [['$.handoff', 'missing_field']]],
    ['missing evidence', { status: 'completed', summary: 's', handoff: 'h' }, [['$.evidence', 'missing_field']]],
    ['prose', 'All gates passed. Here is my report.', [['$', 'invalid_type']]],
    ['fenced json text', '```json\n' + JSON.stringify(completed()) + '\n```', [['$', 'invalid_type']]],
    ['stringified json', JSON.stringify(completed()), [['$', 'invalid_type']]],
    ['legacy gate text field', { ...completed(), evidence: completed().evidence.map(e => ({ ...e, gate: 'text' })) }, [['$.evidence[0].gate', 'unknown_field'], ['$.evidence[1].gate', 'unknown_field']]],
  ];
  for (const [label, raw, expected] of fixtures) {
    const first = result(raw);
    const second = result(raw);
    assert.deepEqual(first, second, label + ' deterministic');
    assert.equal(first.classification, 'format', label);
    assert.equal(first.repairable, true, label);
    for (const [errorPath, code] of expected) has(first.errors, errorPath, code);
    assert.deepEqual(first.errors.map(e => e.path), first.errors.map(e => e.path).filter(Boolean), label);
  }
  const prose = result(fixtures[4][1]).errors[0];
  assert.match(prose.message, /never parses prose or code fences/);
});

test('blocked results and unpassed gates are semantic outcomes, never format-repairable', () => {
  const blocked = result({ status: 'blocked', reason: 'needs owner key' });
  assert.equal(blocked.ok, true);
  assert.equal(blocked.outcome, 'blocked');
  assert.equal(blocked.classification, 'semantic');
  assert.equal(blocked.repairable, false);
  const unfinished = result(completed({ evidence: [{ gateId: 'G1', passed: true, detail: 'a' }, { gateId: 'G2', passed: false, detail: 'could not finish' }] }));
  assert.equal(unfinished.ok, true);
  assert.equal(unfinished.outcome, 'unfinished');
  assert.equal(unfinished.classification, 'semantic');
  assert.equal(unfinished.repairable, false);
  assert.equal('errors' in unfinished, false);
  const planBlocked = plan({ status: 'blocked', reason: 'cannot plan' });
  assert.deepEqual([planBlocked.outcome, planBlocked.classification, planBlocked.repairable], ['blocked', 'semantic', false]);
  // A malformed payload stays a format error even when it also reports an unpassed gate.
  const mixed = result(completed({ evidence: [{ gateId: 'G1', passed: false, detail: 'a' }] }));
  assert.deepEqual([mixed.ok, mixed.classification], [false, 'format']);
});

test('error output is bounded', () => {
  const errors = errorsOf(plan(inline(Array.from({ length: 200 }, () => task('bad id', { dod: [] })))));
  assert.ok(errors.length <= 51);
  assert.equal(errors.at(-1).code, 'too_many_errors');
});

test('tool id matching is exact and lookalikes are identified, never matched', () => {
  assert.equal(submissionKindOfTool('heimdall_submit_result'), 'executor-result');
  assert.equal(submissionKindOfTool('heimdall_submit_plan'), 'planner-plan');
  for (const name of ['foo__heimdall_submit_result', 'mcp.heimdall_submit_plan', 'x:heimdall_submit_result', 'heimdall_submit_results', 'Heimdall_submit_plan']) assert.equal(submissionKindOfTool(name), undefined, name);
  assert.equal(isLookalikeSubmissionTool('foo__heimdall_submit_result'), true);
  assert.equal(isLookalikeSubmissionTool('mcp/heimdall_submit_plan'), true);
  assert.equal(isLookalikeSubmissionTool('heimdall_submit_plan'), false);
  assert.equal(isLookalikeSubmissionTool('adr_workflow'), false);
});

test('legacy plan validation keeps its rules after sharing the task id check', () => {
  const legacy = tasks => validatePlan({ status: 'planned', planMarkdown: 'p', factSheet: 'f', tasks }, 7);
  legacy([task('T1'), task('T2', { dependsOn: ['T1'], extra: 'allowed in legacy' })]);
  assert.throws(() => legacy([task('bad id')]), /Invalid task or dependency: bad id/);
  assert.throws(() => legacy([task('T1'), task('T1')]), /Invalid task or dependency: T1/);
  assert.throws(() => legacy([task('T1', { dependsOn: ['T2'] })]), /Invalid task or dependency: T1/);
  assert.throws(() => legacy(Array.from({ length: 8 }, (_, i) => task('T' + i))), /maximum is 7/);
  assert.throws(() => legacy([]), /Invalid plan/);
});

// --- Host plan snapshot ----------------------------------------------------------------------------------

async function planFixture(t, tasks = [task('T1'), task('T2', { dependsOn: ['T1'] })]) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-snapshot-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const base = path.join(directory, '.plans', 'adr-run1');
  await fs.mkdir(base, { recursive: true });
  await fs.writeFile(path.join(base, 'plan.md'), '# Plan v1');
  await fs.writeFile(path.join(base, 'facts.md'), '# Facts v1');
  await fs.writeFile(path.join(base, 'tasks.md'), JSON.stringify(tasks));
  return { directory, base, load: (options = {}) => loadPlanSnapshot({ directory, planRoot: '.plans', runId: 'run1', limit: 7, ...options }) };
}

test('plan snapshot loads the fixed directory, validates it completely and ignores later file edits', async t => {
  const f = await planFixture(t);
  const loaded = await f.load();
  assert.equal(loaded.ok, true);
  const { snapshot } = loaded;
  assert.equal(snapshot.planMarkdown, '# Plan v1');
  assert.equal(snapshot.factSheet, '# Facts v1');
  assert.deepEqual(snapshot.tasks.map(x => x.id), ['T1', 'T2']);
  assert.match(snapshot.sha256, /^[0-9a-f]{64}$/);
  assert.ok(Object.isFrozen(snapshot) && Object.isFrozen(snapshot.tasks) && Object.isFrozen(snapshot.tasks[0].dod));
  const frozen = JSON.stringify(snapshot);
  await fs.writeFile(path.join(f.base, 'plan.md'), '# Plan v2 edited later');
  await fs.writeFile(path.join(f.base, 'tasks.md'), JSON.stringify([task('Z9')]));
  assert.equal(JSON.stringify(snapshot), frozen);
  const reloaded = await f.load();
  assert.equal(reloaded.ok, true);
  assert.notEqual(reloaded.snapshot.sha256, snapshot.sha256);
  assert.equal((await (await planFixture(t)).load()).snapshot.sha256, snapshot.sha256, 'hash depends only on content');
});

test('plan snapshot rejects incomplete, invalid and escaping artifacts without guessing', async t => {
  const f = await planFixture(t, [task('T1', { dependsOn: ['T9'] })]);
  const invalid = await f.load();
  assert.equal(invalid.ok, false);
  assert.equal(invalid.repairable, true);
  has(invalid.errors, '$.tasks[0].dependsOn[0]', 'invalid_dependency');
  const tooMany = await (await planFixture(t, Array.from({ length: 8 }, (_, i) => task('T' + (i + 1))))).load();
  has(tooMany.errors, '$.tasks', 'task_limit');

  await fs.writeFile(path.join(f.base, 'tasks.md'), 'not json');
  has((await f.load()).errors, '$.artifacts.tasks.md', 'invalid_value');
  await fs.rm(path.join(f.base, 'facts.md'));
  has((await f.load()).errors, '$.artifacts.facts.md', 'invalid_value');
  await assert.rejects(f.load({ runId: '../x' }), /Invalid run id/);
  const missing = await f.load({ runId: 'other' });
  has(missing.errors, '$.artifacts.directory', 'invalid_value');

  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-snapshot-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'facts.md'), 'secret');
  await fs.symlink(path.join(outside, 'facts.md'), path.join(f.base, 'facts.md'));
  await assert.rejects(f.load(), /escapes/);
  const inner = await planFixture(t);
  await fs.writeFile(path.join(inner.directory, 'other.md'), 'elsewhere in project');
  await fs.rm(path.join(inner.base, 'plan.md'));
  await fs.symlink(path.join(inner.directory, 'other.md'), path.join(inner.base, 'plan.md'));
  await assert.rejects(inner.load(), /escapes the planning directory/);
  const linked = await planFixture(t);
  await fs.rename(linked.base, path.join(outside, 'adr-run1'));
  await fs.symlink(path.join(outside, 'adr-run1'), linked.base);
  await assert.rejects(linked.load(), /escapes project/);
});
