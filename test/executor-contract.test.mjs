import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRunner, executorContract, parseResult, validateCompletion } from '../dist/workflow/runner.js';
import { createNativeBackend } from '../dist/opencode/native-backend.js';

const snapshot = () => Object.fromEntries([['anthropic', 50], ['kimi', 40]].map(([key, n]) => [key, { fetchedAt: Date.now(), entries: [{ name: '5h', percentRemaining: n }, { name: 'Weekly', percentRemaining: n }], errors: [] }]));
const dodItems = Array.from({ length: 7 }, (_, i) => `Gate ${i + 1}: verbatim   requirement with \`ticks\` and "quotes" #${i + 1}`);
const task = (id, extra = {}) => ({ id, title: id, brief: 'Implement ' + id, dependsOn: [], dod: dodItems, ...extra });
const plan = tasks => ({ status: 'planned', planMarkdown: '# Plan', factSheet: 'Known facts', tasks });
const completion = (id, dod) => ({ status: 'completed', taskId: id, summary: 'Done', handoff: 'Changed module', evidence: dod.map((gate, i) => ({ gateId: 'G' + (i + 1), gate, passed: true, detail: 'proved ' + (i + 1) })) });
const MARKER = '=== Executor completion contract for ';

async function fixture(t, responses) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-contract-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, '.opencode/adr-workflow');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(directory, 'ADR.md'), 'Spec');
  await fs.writeFile(path.join(root, 'settings.json'), JSON.stringify({ plannerAgent: 'adr-planner', executorAgent: 'adr-executor', plannerModel: 'a/p', executorModel: 'a/e', executorFallbackModel: 'k/k3', timeoutMinutes: 1, maxTasks: 10, maxSessionTokens: 60000, maxRunTokens: 300000, minQuotaRemainingPercent: 10 }));
  for (const name of ['planner', 'executor']) await fs.writeFile(path.join(root, name + '.md'), name);
  const prompts = []; let n = 0;
  const backend = {
    assertIdle: async () => {},
    recoverResponse: async () => undefined,
    usage: async () => ({ used: 0, uncached: 0 }),
    interrupt: async () => {},
    runSubagent: async (input) => {
      const id = input.child ?? 's' + ++n;
      await input.onStarted(id);
      prompts.push({ agent: input.agent, prompt: input.prompt });
      const r = responses.shift();
      return typeof r === 'string' ? r : JSON.stringify(r);
    },
  };
  const context = { sessionID: 'parent', id: 'call_1', messageID: 'msg_1', agent: 'adr-orchestrator', abort: new AbortController().signal };
  const run = createRunner({ backend, directory, quota: async () => snapshot(), git: a => a[0] === 'branch' ? 'main\n' : ' M existing.txt\n' });
  return { root, prompts, run, context };
}

test('executor prompt ends with the task-specific contract mapping every G1..G7 to its verbatim DoD item', async t => {
  const t2 = task('T2');
  const f = await fixture(t, [plan([t2]), completion('T2', t2.dod)]);
  const result = JSON.parse(await f.run({ action: 'start', adr: 'ADR.md' }, f.context));
  assert.equal(result.status, 'completed');
  assert.equal(f.prompts.length, 2);
  const executor = f.prompts[1].prompt;
  const footer = executorContract(t2);
  assert.ok(executor.endsWith(footer), 'contract is the final prompt text');
  assert.ok(executor.indexOf('Workflow attempt: ') < executor.indexOf(footer), 'attempt marker precedes the contract');
  assert.ok(executor.indexOf('Task: ') < executor.indexOf(footer));
  for (const [i, gate] of t2.dod.entries()) assert.ok(footer.includes('G' + (i + 1) + ' = ' + gate), 'G' + (i + 1));
  assert.ok(!footer.includes('G8 ='));
  for (const field of ['status', 'taskId', 'summary', 'handoff', 'evidence', 'gateId', 'gate', 'passed', 'detail']) assert.ok(footer.includes(field), field);
  assert.ok(footer.includes('{"status":"blocked","taskId":"T2","reason"'));
  assert.ok(footer.includes('"taskId":"T2"'));
  assert.match(footer, /exactly one JSON object/);
  assert.match(footer, /no code fences/);
  assert.match(footer, /evidence must already exist/);
  assert.match(footer, /truthfully/);
  assert.match(footer, /passed=true only for a gate you fully proved/);
});

test('footer names the current task and never another task id', () => {
  const footer = executorContract(task('T2'));
  assert.ok(!footer.includes('T1'));
  assert.ok(footer.includes('"taskId":"T2"'));
  assert.ok(executorContract(task('T7')).includes('"taskId":"T7"'));
});

test('50,000-character brief and owner resolution keep one complete footer as the final prompt text', async t => {
  const big = task('T2', { brief: 'B'.repeat(50000) });
  const f = await fixture(t, [plan([big]), { status: 'blocked', reason: 'Need owner answer' }, completion('T2', big.dod)]);
  const paused = JSON.parse(await f.run({ action: 'start', adr: 'ADR.md' }, f.context));
  assert.equal(paused.status, 'paused');
  const resolution = 'R'.repeat(50000);
  const resumed = JSON.parse(await f.run({ action: 'resume', runId: paused.runId, input: resolution }, f.context));
  assert.equal(resumed.status, 'completed');
  const footer = executorContract(big);
  for (const { prompt } of f.prompts.slice(1)) {
    assert.ok(prompt.endsWith(footer));
    assert.equal(prompt.split(MARKER).length - 1, 1, 'footer appears exactly once');
    assert.equal(prompt.split(footer).length - 1, 1);
  }
  const last = f.prompts.at(-1).prompt;
  assert.ok(last.includes('Owner resolution: ' + resolution));
  assert.ok(last.includes('B'.repeat(50000)));
  assert.ok(last.length > 100000);
  assert.ok(last.indexOf('Owner resolution: ') < last.indexOf('Workflow attempt: '));
});

test('planner prompt has no contract footer and still ends with the attempt marker', async t => {
  const f = await fixture(t, [plan([task('T2')]), completion('T2', dodItems)]);
  await f.run({ action: 'start', adr: 'ADR.md' }, f.context);
  const planner = f.prompts[0].prompt;
  assert.ok(!planner.includes(MARKER));
  assert.ok(!planner.includes('Executor completion contract'));
  assert.match(planner, /\nWorkflow attempt: [0-9a-f-]{36}$/);
  assert.ok(!planner.includes('Task: '));
});

test('legacy replies without gate IDs and native gate-ID replies both parse and validate', () => {
  const t1 = task('T1', { dod: ['test passed'] });
  const legacy = { status: 'completed', taskId: 'T1', summary: 'Done', handoff: 'h', evidence: [{ gate: 'test passed', detail: 'old output' }] };
  const parsed = parseResult(JSON.stringify(legacy));
  validateCompletion(parsed, t1);
  assert.throws(() => validateCompletion(parseResult(JSON.stringify(legacy)), t1, { requireGateIds: true }), /stable gate ID/);

  const native = completion('T1', t1.dod);
  validateCompletion(parseResult(JSON.stringify(native)), t1, { requireGateIds: true });
});

test('native receipt with gate IDs resumes and advances exactly once with the footer-bearing prompt', async t => {
  const t1 = task('T1', { dod: ['test passed'] });
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-contract-resume-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, '.opencode/adr-workflow');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(directory, 'ADR.md'), 'Spec');
  await fs.writeFile(path.join(root, 'settings.json'), JSON.stringify({ plannerAgent: 'p', executorAgent: 'e', plannerModel: 'a/p', executorModel: 'a/e', executorFallbackModel: 'k/k3', timeoutMinutes: 1, maxTasks: 10, maxSessionTokens: 60000, maxRunTokens: 300000, minQuotaRemainingPercent: 10 }));
  for (const name of ['planner', 'executor']) await fs.writeFile(path.join(root, name + '.md'), name);
  const prompts = []; let n = 0; let fail = true;
  const backend = {
    assertIdle: async () => {}, recoverResponse: async () => undefined, usage: async () => ({ used: 0, uncached: 0 }), interrupt: async () => {},
    runSubagent: async input => {
      const id = input.child ?? 's' + ++n;
      await input.onStarted(id);
      prompts.push(input.prompt);
      if (prompts.length === 1) return JSON.stringify(plan([t1]));
      if (fail) throw new Error('process stopped before saving response');
      return JSON.stringify(completion('T1', t1.dod));
    },
  };
  const context = { sessionID: 'parent', id: 'call_1', messageID: 'msg_1', agent: 'o', abort: new AbortController().signal };
  const run = createRunner({ backend, directory, quota: async () => snapshot(), git: a => a[0] === 'branch' ? 'main\n' : '' });
  const paused = JSON.parse(await run({ action: 'start', adr: 'ADR.md' }, context));
  assert.equal(paused.status, 'paused');
  const base = path.join(root, 'runs', paused.runId);
  const file = path.join(base, 'state.json');
  const state = JSON.parse(await fs.readFile(file, 'utf8'));
  state.attempt.status = 'admitted';
  await fs.writeFile(file, JSON.stringify(state));
  await fs.writeFile(path.join(base, 'attempt-' + state.attempt.id + '.json'), JSON.stringify({ ...state.attempt, response: JSON.stringify(completion('T1', t1.dod)) }));
  fail = false;
  const completed = JSON.parse(await run({ action: 'resume', runId: state.id, input: 'Apply the saved completion' }, context));
  assert.equal(completed.status, 'completed');
  assert.equal(prompts.length, 2, 'the saved receipt is applied without a second executor prompt');
  assert.ok(prompts[1].endsWith(executorContract(t1)));
});

test('recoverResponse binds the attempt marker when the contract follows it', async () => {
  const t2 = task('T2');
  const prompt = 'Task: x\nWorkflow attempt: attempt-1\n\n' + executorContract(t2);
  const messages = [{ type: 'user', text: prompt }, { type: 'assistant', time: { completed: 20 }, finish: 'stop', content: [{ type: 'text', text: '{"status":"completed"}' }] }];
  const idle = { session: { id: 'child', parentID: 'parent', tokens: { input: 2, output: 3, reasoning: 4, cache: { read: 5, write: 6 } }, outcome: 'succeeded', time: { idle: 10 } }, active: false, inbox: [], permissions: [], forms: [] };
  const ctx = { session: { context: async () => messages } };
  const backend = createNativeBackend({ ctx, observe: async () => idle, cancellationWaitMs: 0 });
  assert.equal(await backend.recoverResponse('child', 'parent', { id: 'attempt-1', startedAt: 10 }), '{"status":"completed"}');
  await assert.rejects(backend.recoverResponse('child', 'parent', { id: 'different', startedAt: 10 }), /bind completed/);
});
