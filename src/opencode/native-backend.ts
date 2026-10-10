import type { ReportOnlyCapability, RunnerBackend, RunnerContext, SubagentInput, WorkflowAttempt } from '../workflow/types.js';
import type { NativeOriginResolver } from '../workflow/durable-submission.js';
import { VERIFIED_REPORT_ONLY_PROVIDERS } from './report-only.js';
import type { ReportOnlyRegistry } from './report-only.js';
import type { NativeContext, NativeTool, NativeToolContext, ObservedSession, SessionObserver, SessionSnapshot } from './types.js';

const terminal = (session: ObservedSession) => ['succeeded', 'failed', 'interrupted'].includes(session.outcome ?? '') && Number.isFinite(session.time?.idle);
const unprompted = (value: SessionSnapshot) => value.session.outcome === undefined && Array.isArray(value.messages) && value.messages.length === 0 && [value.session.tokens?.input, value.session.tokens?.output, value.session.tokens?.reasoning, value.session.tokens?.cache?.read, value.session.tokens?.cache?.write].every(v => v === 0);

export function requireIdle(value: SessionSnapshot, id: string, parent?: string, allowUnprompted = false): SessionSnapshot {
  if (value.session.id !== id || (parent !== undefined && value.session.parentID !== parent)) throw new Error('Child session does not belong to this parent');
  if (value.active || value.inbox.length || value.permissions.length || value.forms.length || (!terminal(value.session) && !(allowUnprompted && unprompted(value)))) throw new Error('Session is active, awaiting input, or has no durable terminal outcome; resolve it before resuming');
  return value;
}

// Resolve after transforms: another plugin may namespace the built-in tool.
export async function resolveSubagent(tool: NativeContext['tool']): Promise<NativeTool> {
  const matches = (await tool.list()).filter(t => t.id === 'subagent' || t.name === 'subagent' || /(?:[.:/]|__)subagent$/.test(t.id) || /(?:[.:/]|__)subagent$/.test(t.name));
  if (matches.length !== 1 || typeof matches[0]?.execute !== 'function') throw new Error('Expected exactly one native subagent executor in the effective tool registry');
  return matches[0];
}

export function nativeModel(model: string, variant?: string): string {
  if (typeof model !== 'string' || !/^[^/#]+\/[^#]+$/.test(model) || (variant !== undefined && (typeof variant !== 'string' || !variant || variant.includes('#')))) throw new Error('Invalid native provider/model#variant');
  return model + (variant ? '#' + variant : '');
}

/**
 * Proves, from the host's ordered message timeline of the calling session, which user prompt a tool call descends
 * from: the assistant message that carries the call (identified by the native message id, never by anything the
 * model supplied) belongs to the nearest user message before it. A delayed call from an earlier dispatch on a reused
 * child therefore resolves to the earlier prompt, and an unknown message, a foreign agent or a missing prompt yields
 * undefined (the gate then fails closed).
 */
export function createNativeOriginResolver(ctx: Pick<NativeContext, 'session'>): NativeOriginResolver {
  return async native => {
    const messages = await ctx.session.context({ sessionID: native.sessionID as never });
    const index = messages.findIndex(m => m.type === 'assistant' && m.id === native.messageID);
    if (index < 0 || (messages[index] as { agent?: unknown }).agent !== native.agent) return undefined;
    const prompt = messages.slice(0, index).filter(m => m.type === 'user').at(-1);
    return typeof prompt?.id === 'string' && prompt.id.length > 0 ? prompt.id : undefined;
  };
}

export function createNativeBackend({ ctx, observe, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), cancellationWaitMs = 30000, reportOnly, verifiedProviders = VERIFIED_REPORT_ONLY_PROVIDERS }: {
  ctx: NativeContext;
  observe: SessionObserver;
  pause?: (ms: number) => Promise<unknown>;
  cancellationWaitMs?: number;
  /** Shared with the plugin hooks. Omitted means no report-only capability. */
  reportOnly?: ReportOnlyRegistry;
  /** Providers proven to route every tool path through the hooks. Injectable for tests. */
  verifiedProviders?: readonly string[];
}): RunnerBackend {
  const capability: ReportOnlyCapability | undefined = reportOnly && {
    async check(model) {
      const missing = reportOnly.missing();
      if (missing.length) return { supported: false, reason: 'Report-only enforcement is unavailable: Heimdall plugin hooks are not registered (' + missing.join(', ') + ')' };
      const provider = typeof model === 'string' ? /^([^/#]+)\/[^#]+(?:#.+)?$/.exec(model)?.[1] : undefined;
      if (!provider) return { supported: false, reason: 'Report-only enforcement cannot identify the provider of model "' + String(model) + '"' };
      if (!verifiedProviders.includes(provider)) return { supported: false, reason: 'Report-only enforcement is not verified for provider "' + provider + '"' };
      return { supported: true };
    },
    async restrict(child, owner) {
      const release = reportOnly.restrict(child, owner && { ...owner, child });
      return async () => { release(); };
    },
    // The registry is shared by every adapter built for this plugin, so a recreated backend releases what an earlier one took.
    async releaseRetained({ child, parent, runId, attemptIds }) {
      for (const attemptId of attemptIds) reportOnly.releaseOwned({ parent, child, attemptId, runId });
    },
  };
  return {
    ...(capability ? { reportOnly: capability } : {}),
    async assertIdle(id, parent, signal) { return requireIdle(await observe(id, signal), id, parent, true); },
    // Host-observed native state only: the user message of the child session that carries this attempt's marker.
    async observeDispatchPrompt({ child, parent, attemptId, signal }) {
      const value = await observe(child, signal);
      if (value.session.id !== child || value.session.parentID !== parent) throw new Error('Child session does not belong to this parent');
      const marker = 'Workflow attempt: ' + attemptId;
      const messages = await ctx.session.context({ sessionID: child });
      const prompt = messages.filter(m => m.type === 'user' && typeof m.id === 'string' && m.id.length > 0 && m.text.includes(marker)).at(-1);
      return prompt?.id;
    },
    async recoverResponse(id: string, parent: string, attempt: WorkflowAttempt) {
      const value = requireIdle(await observe(id), id, parent, true);
      if (value.session.outcome !== 'succeeded') return undefined;
      const messages = await ctx.session.context({ sessionID: id });
      const user = messages.filter(m => m.type === 'user').at(-1);
      const answer = messages.filter(m => m.type === 'assistant').at(-1);
      if (!user?.text.includes('Workflow attempt: ' + attempt.id) || !answer || typeof answer.time.completed !== 'number' || !Number.isFinite(answer.time.completed) || answer.time.completed < attempt.startedAt || answer.error) throw new Error('Cannot bind completed child output to this attempt. Reconcile the saved child before resuming');
      if (answer.finish === 'length') throw new Error('Planner/executor output truncated at model output limit. Recover artifacts before resuming');
      if (answer.finish !== 'stop') throw new Error('Completed child has no final stop response; reconcile it before resuming');
      return answer.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
    },
    async usage(id) {
      const session = await ctx.session.get({ sessionID: id });
      if (session.id !== id || !session.tokens) throw new Error('Cannot verify token usage');
      const t = session.tokens;
      const values = [t.input, t.output, t.reasoning, t.cache?.read, t.cache?.write];
      if (!values.every(v => typeof v === 'number' && Number.isFinite(v) && v >= 0)) throw new Error('Invalid cumulative session token accounting');
      return { used: values.reduce((a, b) => a + b, 0), uncached: values.filter((_, i) => i !== 3).reduce((a, b) => a + b, 0) };
    },
    async interrupt(id, parent) {
      // A false acknowledgement can mean the foreground job already finished.
      await ctx.session.interrupt({ sessionID: id });
      const until = Date.now() + cancellationWaitMs;
      while (true) {
        const value = await observe(id);
        if (value.session.id !== id || value.session.parentID !== parent) throw new Error('Cancellation target changed');
        if (!value.active && !value.inbox.length && !value.permissions.length && !value.forms.length && (terminal(value.session) || unprompted(value))) return;
        if (Date.now() >= until) throw new Error('Could not confirm child termination and empty inbox. Resolve its pending work before resuming');
        await pause(250);
      }
    },
    async runSubagent(input: SubagentInput, context: RunnerContext) {
      if (!context.id || !context.messageID || !context.agent || context.sessionID !== input.parent) throw new Error('A native parent tool context is required');
      const signal = context.signal ?? context.abort;
      if (!signal) throw new Error('A native parent cancellation signal is required');
      const native = await resolveSubagent(ctx.tool);
      const nativeContext: NativeToolContext = {
        ...context,
        id: context.id as NativeToolContext['id'],
        messageID: context.messageID as NativeToolContext['messageID'],
        agent: context.agent as NativeToolContext['agent'],
        sessionID: context.sessionID as NativeToolContext['sessionID'],
        signal,
        progress: async update => {
          if (typeof update.sessionID === 'string' && update.sessionID) await input.onStarted(update.sessionID);
          await context.progress?.(update);
        },
      };
      const result = await native.execute({ agent: input.agent, description: input.title, prompt: input.prompt, model: nativeModel(input.model, input.variant), ...(input.child ? { sessionID: input.child } : {}), background: false }, nativeContext);
      const output = result?.output as unknown;
      if (!output || typeof output !== 'object' || !('sessionID' in output) || !output.sessionID || output.sessionID !== input.currentChild() || !('status' in output) || output.status !== 'completed' || !('output' in output) || typeof output.output !== 'string') throw new Error('Native child did not return foreground completion; the task has not advanced');
      const value = requireIdle(await observe(output.sessionID as string, signal), output.sessionID as string, input.parent, true);
      if (value.session.outcome !== 'succeeded') throw new Error('Native child did not finish successfully');
      const messages = await ctx.session.context({ sessionID: output.sessionID as string });
      const answer = messages.filter(m => m.type === 'assistant').at(-1);
      if (answer?.finish === 'length') throw new Error('Planner/executor output truncated at model output limit. Recover artifacts before resuming');
      if (!answer?.time.completed || answer.error || answer.finish !== 'stop') throw new Error('Native child has no successful final stop response');
      return output.output;
    },
  };
}
