import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createWorkflow, loadConfiguration } from '../dist/index.js';

test('public composition rereads paused-run budgets without touching another workflow', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'heimdall-public-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, '.heimdall.toml');
  const config = '[workflow]\nplannerModel = "anthropic/planner"\nexecutorModel = "anthropic/executor"\nexecutorFallbackModel = "kimi/fallback"\n';
  await fs.writeFile(file, config);
  await fs.writeFile(path.join(directory, 'feature.md'), 'Synthetic feature specification');
  const previous = path.join(directory, '.opencode', 'adr-workflow');
  await fs.mkdir(previous, { recursive: true });
  await fs.writeFile(path.join(previous, 'active.lock'), 'another running workflow');
  const task = { id: 'T1', title: 'T1', brief: 'Implement one task', dependsOn: [], dod: ['targeted check passes'] };
  const responses = [
    { status: 'planned', planMarkdown: '# Plan', factSheet: 'Synthetic facts', tasks: [task] },
    { status: 'blocked', taskId: 'T1', reason: 'Owner input required' },
    { status: 'completed', taskId: 'T1', summary: 'Done', handoff: 'Complete', evidence: [{ gateId: 'G1', passed: true, gate: 'targeted check passes', detail: 'Synthetic targeted check passed' }] },
  ];
  const calls = [];
  let sequence = 0;
  const backend = {
    assertIdle: async () => {}, recoverResponse: async () => undefined,
    usage: async () => ({ used: 100, uncached: 50 }), interrupt: async () => {},
    runSubagent: async input => {
      const child = input.child ?? `synthetic-${++sequence}`;
      await input.onStarted(child);
      calls.push(child);
      assert.match(input.prompt, /Planning artifact directory:/);
      return JSON.stringify(responses.shift());
    },
  };
  const quota = async () => ({ anthropic: { fetchedAt: Date.now(), errors: [], entries: [{ name: '5h', percentRemaining: 80 }, { name: 'Weekly', percentRemaining: 80 }] } });
  const configuration = await loadConfiguration({ projectDirectory: directory });
  const run = createWorkflow({ configuration, backend, quota, git: args => args[0] === 'branch' ? 'main\n' : '' });
  const context = { sessionID: 'synthetic-parent', id: 'synthetic-call', messageID: 'synthetic-message', agent: 'adr-orchestrator', signal: new AbortController().signal };
  const first = JSON.parse(await run({ action: 'start', adr: 'feature.md' }, context));
  assert.equal(first.status, 'paused');
  assert.deepEqual(calls, ['synthetic-1', 'synthetic-2']);
  await fs.writeFile(file, config + 'tokenLimitsDisabled = false\nmaxSessionTokens = 20\nmaxRunTokens = 1000\n');
  const limited = JSON.parse(await run({ action: 'resume', runId: first.runId, input: 'Resolved' }, context));
  assert.equal(limited.status, 'paused');
  assert.match(limited.reason, /Token budget/);
  assert.equal(calls.length, 2, 'new limits prevent another inference');
  await fs.writeFile(file, config);
  const finished = JSON.parse(await run({ action: 'resume', runId: first.runId, input: 'Limits removed; continue' }, context));
  assert.equal(finished.status, 'completed');
  assert.deepEqual(calls, ['synthetic-1', 'synthetic-2', 'synthetic-2']);
  const state = JSON.parse(await fs.readFile(path.join(configuration.workflowRoot, 'runs', first.runId, 'state.json'), 'utf8'));
  assert.equal(state.results.length, 1);
  assert.equal(await fs.readFile(path.join(previous, 'active.lock'), 'utf8'), 'another running workflow');
});
