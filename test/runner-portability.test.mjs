import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRunner, loadPlanArtifacts } from '../dist/workflow/runner.js';

const task = { id: 'T1', title: 'Task', brief: 'Do the task', dependsOn: [], dod: ['verified'] };
const plan = { status: 'planned', planMarkdown: '# Plan', factSheet: 'Confirmed facts', tasks: [task] };
const completion = { status: 'completed', taskId: 'T1', summary: 'Done', handoff: 'Result ready', evidence: [{ gateId: 'G1', passed: true, detail: 'Focused verification passed' }] };
const settings = { plannerAgent: 'planner', executorAgent: 'executor', plannerModel: 'anthropic/planner', executorModel: 'anthropic/executor', executorFallbackModel: 'kimi/fallback', maxTasks: 10, minQuotaRemainingPercent: 10, tokenLimitsDisabled: true };
const context = { sessionID: 'parent', signal: new AbortController().signal };
const quota = async () => ({ anthropic: { fetchedAt: Date.now(), errors: [], entries: [{ name: '5h', percentRemaining: 80 }, { name: 'Weekly', percentRemaining: 80 }] } });

async function fixture(t, responses, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall runner paths '));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'ADR.md'), 'Feature specification');
  await fs.mkdir(path.join(directory, 'custom prompts'));
  await fs.writeFile(path.join(directory, 'custom prompts', 'plan.md'), 'CUSTOM PLANNER');
  await fs.writeFile(path.join(directory, 'custom prompts', 'execute.md'), 'CUSTOM EXECUTOR');
  const calls = [];
  let session = 0;
  const backend = {
    assertIdle: async () => {},
    recoverResponse: async () => undefined,
    usage: async () => ({ used: 123, uncached: 45 }),
    interrupt: async () => {},
    runSubagent: async input => {
      await input.onStarted(input.child ?? 'child-' + ++session);
      calls.push(input);
      const response = responses.shift();
      return typeof response === 'function' ? response(input, directory) : JSON.stringify(response);
    },
  };
  const run = createRunner({
    directory, backend, quota, settings,
    workflowRoot: 'custom state', planRoot: 'custom plans',
    plannerPromptPath: 'custom prompts/plan.md', executorPromptPath: 'custom prompts/execute.md',
    git: args => args[0] === 'branch' ? 'main\n' : '',
    ...options,
  });
  return { directory, run, calls };
}

test('injected settings and project-relative paths isolate state and load configured plan artifacts', async t => {
  const f = await fixture(t, [async (input, directory) => {
    const artifactDirectory = /^Planning artifact directory: (.+)$/m.exec(input.prompt)?.[1];
    assert.ok(artifactDirectory?.startsWith(path.join(directory, 'custom plans') + path.sep));
    await fs.mkdir(artifactDirectory, { recursive: true });
    for (const [name, content] of [['plan.md', plan.planMarkdown], ['facts.md', plan.factSheet], ['tasks.md', JSON.stringify(plan.tasks)]]) {
      await fs.writeFile(path.join(artifactDirectory, name), content);
    }
    return JSON.stringify({ status: 'planned', artifacts: true });
  }, completion]);
  const result = JSON.parse(await f.run({ action: 'start', adr: 'ADR.md' }, context));
  assert.equal(result.status, 'completed');
  assert.match(f.calls[0].prompt, /CUSTOM PLANNER/);
  assert.match(f.calls[1].prompt, /CUSTOM EXECUTOR/);
  const state = JSON.parse(await f.run({ action: 'status', runId: result.runId }, context));
  assert.equal(state.results.length, 1);
  assert.equal(state.usage['child-1'], 123);
  assert.equal(state.uncachedUsage['child-2'], 45);
  await fs.access(path.join(f.directory, 'custom state', 'runs', result.runId, 'ledger.md'));
  await assert.rejects(fs.access(path.join(f.directory, '.opencode')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(f.directory, '.omo')), { code: 'ENOENT' });
});

test('settings getter reloads limits on resume and status does not consult settings', async t => {
  let current = { ...settings, tokenLimitsDisabled: false, maxSessionTokens: 100, maxRunTokens: 1000 };
  let reads = 0;
  const f = await fixture(t, [plan, completion], { settings: async () => { reads++; return current; } });
  const paused = JSON.parse(await f.run({ action: 'start', adr: 'ADR.md' }, context));
  assert.equal(paused.status, 'paused');
  assert.match(paused.reason, /Token budget/);
  assert.equal(f.calls.length, 0);
  await f.run({ action: 'status', runId: paused.runId }, context);
  assert.equal(reads, 1);
  current = { ...settings };
  const resumed = JSON.parse(await f.run({ action: 'resume', runId: paused.runId, input: 'Remove configured caps' }, context));
  assert.equal(resumed.status, 'completed');
  assert.equal(reads, 2);
  assert.equal(f.calls[0].child, 'child-1', 'the paused planner child is reused');
});

test('explicit settings path is independent of the state directory', async t => {
  const f = await fixture(t, [plan, completion], { settings: undefined, settingsPath: 'config/settings.json' });
  await fs.mkdir(path.join(f.directory, 'config'));
  await fs.writeFile(path.join(f.directory, 'config/settings.json'), JSON.stringify(settings));
  const result = JSON.parse(await f.run({ action: 'start', adr: 'ADR.md' }, context));
  assert.equal(result.status, 'completed');
  await assert.rejects(fs.access(path.join(f.directory, 'custom state/settings.json')), { code: 'ENOENT' });
});

test('custom planning path retains the project containment check', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall plan boundary '));
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall external plan '));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  t.after(() => fs.rm(external, { recursive: true, force: true }));
  await fs.mkdir(path.join(external, 'adr-test'));
  await fs.writeFile(path.join(external, 'adr-test/plan.md'), '# External plan');
  await assert.rejects(loadPlanArtifacts({ status: 'planned', artifacts: true }, directory, 'test', external), /escapes project/);
});
