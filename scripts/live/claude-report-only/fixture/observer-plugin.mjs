// Fixture-only observer for the live verification. It only records; it never changes an event.
// Two instances bracket the Heimdall plugin in the plugin order: `pre` sees each hook payload before
// Heimdall's hooks run and `post` sees it after, so the effective tool list and permission outcome are both recorded.
// Inputs are truncated and carry no credentials: they are the fixture prompts' own tool arguments.
import fs from 'node:fs';
import path from 'node:path';
import { Plugin } from '@opencode/plugin';

const root = process.env.HEIMDALL_FIXTURE_ROOT;
if (!root) throw new Error('HEIMDALL_FIXTURE_ROOT is required');
const logPath = path.join(root, 'evidence', 'observer.jsonl');
const clip = value => { try { return JSON.stringify(value).slice(0, 240); } catch { return String(value).slice(0, 240); } };

export function makeObserver(stage) {
  return Plugin.define({
    id: `fixture.observer.${stage}`,
    async setup(ctx) {
      const log = entry => fs.appendFileSync(logPath, JSON.stringify({ at: Date.now(), stage, ...entry }) + '\n');
      const registrations = [];
      registrations.push(await ctx.tool.hook('execute.before', async input => {
        log({ event: 'execute.before', tool: input.tool, sessionID: input.sessionID, agent: input.agent, callID: input.id, input: clip(input.input) });
      }));
      registrations.push(await ctx.tool.hook('execute.after', async input => {
        log({ event: 'execute.after', tool: input.tool, sessionID: input.sessionID, callID: input.id, status: input.status, error: input.status === 'error' ? clip(input.error) : undefined });
      }));
      registrations.push(await ctx.session.hook('context', async event => {
        log({ event: 'context', sessionID: event.sessionID, agent: event.agent, model: event.model, tools: Object.keys(event.tools).sort() });
      }));
      registrations.push(await ctx.permission.hook('evaluate', event => {
        log({ event: 'permission.evaluate', sessionID: event.sessionID, agent: event.agent, action: event.action, resources: event.resources, effect: event.effect, message: event.message });
      }));
      log({ event: 'observer ready', location: ctx.location.directory });
      return async () => { for (const registration of registrations.reverse()) await registration.dispose(); };
    },
  });
}
