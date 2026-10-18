// A deterministic model inside a disposable real OpenCode host. No provider credentials or network model calls.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { Plugin, Provider, Model } from '@opencode/plugin';
import { createPlugin } from '../../../dist/opencode/plugin.js';

const root = process.env.HEIMDALL_COMPAT_ROOT;
if (!root) throw new Error('The compatibility fixture needs its isolated root');
const log = entry => fs.appendFileSync(`${root}/observations.jsonl`, JSON.stringify(entry) + '\n');
const continued = new Set();
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const flatten = prompt => prompt.flatMap(message => typeof message.content === 'string' ? [message.content] : (message.content ?? []).map(part => part.text ?? '')).join('\n');
const calls = prompt => prompt.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'tool-call') : []);
const text = (value, finish = 'stop') => [
  { type: 'text-start', id: 'text' }, { type: 'text-delta', id: 'text', delta: value }, { type: 'text-end', id: 'text' },
  { type: 'finish', finishReason: { unified: finish, raw: finish }, usage },
];
const call = (name, input) => [
  { type: 'tool-call', toolCallId: `call_${randomUUID().replaceAll('-', '')}`, toolName: name, input: JSON.stringify(input) },
  { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage },
];
const plan = {
  status: 'planned', planMarkdown: '# Compatibility fixture\nTwo deterministic tasks.', factSheet: 'Disposable native host; synthetic model and quota.',
  tasks: [
    { id: 'T1', title: 'Write a fixture marker', brief: 'Write compatibility-marker.txt in this disposable project.', dependsOn: [], dod: ['The native write tool created the fixture marker.'] },
    { id: 'T2', title: 'Wait for an explicit fixture resolution', brief: 'Report blocked until the owner supplies the fixture resolution.', dependsOn: ['T1'], dod: ['The resumed attempt received the fixture resolution.'] },
  ],
};
const result = { status: 'completed', summary: 'Fixture gate satisfied.', handoff: 'Continue the deterministic fixture.', evidence: [{ gateId: 'G1', passed: true, detail: 'Observed through the real native host fixture.' }] };

function respond(options) {
  const names = (options.tools ?? []).map(tool => tool.name);
  const prompt = flatten(options.prompt);
  const latestUser = options.prompt.findLastIndex(message => message.role === 'user');
  const following = calls(options.prompt.slice(latestUser + 1));
  log({ event: 'model', tools: names, priorToolCalls: following.map(item => item.toolName) });
  if (names.includes('adr_workflow')) {
    if (following.some(item => item.toolName === 'adr_workflow')) return text('Fixture workflow returned.');
    const resume = prompt.includes('COMPAT_RESUME');
    if (!resume) return call('adr_workflow', { action: 'start', adr: 'task.md' });
    const runs = fs.readdirSync(`${root}/project/.heimdall/runs`);
    if (runs.length !== 1) throw new Error('Expected exactly one fixture run to resume');
    return call('adr_workflow', { action: 'resume', runId: runs[0], input: 'COMPAT_RESUME' });
  }
  if (names.includes('heimdall_submit_plan')) {
    const key = /Workflow attempt: ([A-Za-z0-9-]+)/.exec(prompt)?.[1];
    if (!key) throw new Error('Planner dispatch has no attempt identity');
    if (!continued.has(key)) {
      continued.add(key);
      log({ event: 'length-continuation', attempt: key });
      return text('Partial fixture plan; the next native generation must submit it through the tool.', 'length');
    }
    return call('heimdall_submit_plan', plan);
  }
  if (names.includes('heimdall_submit_result')) {
    const task = JSON.parse(/Task: (\{[^\n]+\})/.exec(prompt)?.[1] ?? 'null');
    if (!task) throw new Error('Executor dispatch has no task');
    if (task.id === 'T1' && !calls(options.prompt).some(item => item.toolName === 'write')) {
      if (!names.includes('write')) throw new Error('Native write tool was not exposed');
      return call('write', { path: 'compatibility-marker.txt', content: 'verified\n' });
    }
    if (task.id === 'T2' && !prompt.includes('COMPAT_RESUME')) return call('heimdall_submit_result', { status: 'blocked', reason: 'Fixture owner must supply COMPAT_RESUME.' });
    return call('heimdall_submit_result', result);
  }
  return text('Fixture generation complete.');
}

const fake = {
  specificationVersion: 'v3', provider: 'compatibility-fixture', modelId: 'chat', supportedUrls: {},
  doGenerate: async () => { throw new Error('Unexpected non-streaming model request'); },
  doStream: async options => ({ stream: new ReadableStream({ start(controller) { for (const event of respond(options)) controller.enqueue(event); controller.close(); } }) }),
};
const quota = async () => Object.fromEntries(['anthropic', 'openai'].map(provider => [provider, { fetchedAt: Date.now(), errors: [], entries: [{ name: '5h', percentRemaining: 90 }, { name: 'Weekly', percentRemaining: 90 }] }]));
const inner = createPlugin({ quota });

export default Plugin.define({
  id: inner.id,
  async setup(ctx) {
    const registrations = [];
    registrations.push(await ctx.provider.transform(editor => editor.add({ info: { ...Provider.Info.empty('compatibility-fixture'), activation: 'enabled', package: 'aisdk:@ai-sdk/openai' }, models: [Model.Info.default('compatibility-fixture', 'chat')] })));
    registrations.push(await ctx.aisdk.hook('sdk', event => {
      if (event.model.providerID === 'compatibility-fixture') event.sdk = { languageModel: () => fake };
    }));
    registrations.push(await ctx.session.hook('title', event => { event.result = 'Compatibility fixture'; }));
    const dispose = await inner.setup(ctx);
    log({ event: 'plugin-loaded', hostVersion: ctx.app.version, location: ctx.location.directory });
    return async () => { if (typeof dispose === 'function') await dispose(); for (const item of registrations.reverse()) await item.dispose(); };
  },
});
