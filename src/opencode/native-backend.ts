import type { ReportOnlyCapability, RunnerBackend, RunnerContext, SubagentInput, WorkflowAttempt } from '../workflow/types.js';
import type { NativeOriginResolver } from '../workflow/durable-submission.js';
import { VERIFIED_REPORT_ONLY_PROVIDERS } from './report-only.js';
import type { ReportOnlyRegistry } from './report-only.js';
import { SUBMISSION_TOOL_IDS } from '../workflow/contracts.js';
import { OriginProofError } from './types.js';
import type { HistoryMessage, MessageHistory, NativeContext, NativeTool, NativeToolContext, ObservedSession, SessionObserver, SessionSnapshot } from './types.js';

const terminal = (session: ObservedSession) => ['succeeded', 'failed', 'interrupted'].includes(session.outcome ?? '') && Number.isFinite(session.time?.idle);
const unprompted = (value: SessionSnapshot) => value.session.outcome === undefined && Array.isArray(value.messages) && value.messages.length === 0 && [value.session.tokens?.input, value.session.tokens?.output, value.session.tokens?.reasoning, value.session.tokens?.cache?.read, value.session.tokens?.cache?.write].every(v => v === 0);

export function requireIdle(value: SessionSnapshot, id: string, parent?: string, allowUnprompted = false): SessionSnapshot {
  if (value.session.id !== id || (parent !== undefined && value.session.parentID !== parent)) throw new Error('Child session does not belong to this parent');
  if (!Array.isArray(value.pendingWork) || value.pendingWork.length) throw new Error('Session has pending background work or its completion cannot be verified; resolve it before resuming');
  if (value.active || value.inbox.length || value.permissions.length || value.forms.length || (!terminal(value.session) && !(allowUnprompted && unprompted(value)))) throw new Error('Session is active, awaiting input, or has no durable terminal outcome; resolve it before resuming');
  return value;
}

/** Minimum spacing of full-archive scans for one dispatch prompt that the compacted context does not hold. */
const HISTORY_FALLBACK_MS = 1000;

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
 * Proves, from the complete native message archive of the calling session, which user prompt a tool call descends
 * from: the assistant message that carries the call (identified by the native message id, never by anything the
 * model supplied) belongs to the nearest user message before it. The archive is read newest first, so the scan
 * finds that assistant message and then the first real `user` message after it. Compaction, synthetic, system,
 * skill, shell, switch and idle records are never prompts, and the archive keeps the original dispatch prompt even
 * after the host compacted the active context past it. A delayed call from an earlier dispatch on a reused child
 * therefore resolves to the earlier prompt.
 *
 * When the carrying assistant message lists tool calls, one of them must be this call and the submission tool of the
 * binding's kind. Anything that cannot be proven throws an OriginProofError with a bounded reason (never transcript text); the
 * gate treats a throw exactly like an unknown origin and fails closed.
 */
export function createNativeOriginResolver(history: MessageHistory): NativeOriginResolver {
  return async (native, binding) => {
    let carrier: HistoryMessage | undefined;
    for await (const message of history(native.sessionID)) {
      if (!carrier) {
        if (message.type !== 'assistant' || message.id !== native.messageID) continue;
        if (message.agent !== native.agent) throw new OriginProofError('agent_mismatch');
        const calls = Array.isArray(message.content) ? message.content.filter((part): part is Record<string, unknown> => part !== null && typeof part === 'object' && (part as { type?: unknown }).type === 'tool') : [];
        if (calls.length > 0) {
          const call = calls.find(part => part.id === native.id);
          if (!call) throw new OriginProofError('call_mismatch');
          if (call.name !== SUBMISSION_TOOL_IDS[binding.kind]) throw new OriginProofError('call_mismatch');
        }
        carrier = message;
      } else if (message.type === 'user') {
        return message.id;
      }
    }
    throw new OriginProofError(carrier ? 'prompt_not_found' : 'call_not_found');
  };
}

export function createNativeBackend({ ctx, observe, history, pause = ms => new Promise(resolve => setTimeout(resolve, ms)), cancellationWaitMs = 30000, reportOnly, verifiedProviders = VERIFIED_REPORT_ONLY_PROVIDERS }: {
  ctx: NativeContext;
  observe: SessionObserver;
  /** Complete message archive. Binding a completed child to its attempt must not depend on the compacted active context. */
  history?: MessageHistory;
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
    async restrict(child, owner, options) {
      const release = reportOnly.restrict(child, owner && { ...owner, child }, options);
      return async () => { release(); };
    },
    // The registry is shared by every adapter built for this plugin, so a recreated backend releases what an earlier one took.
    async releaseRetained({ child, parent, runId, attemptIds }) {
      for (const attemptId of attemptIds) reportOnly.releaseOwned({ parent, child, attemptId, runId });
    },
  };
  // The runner polls for the dispatch prompt every few milliseconds; a full archive scan per poll would be wasteful.
  const historyScans = new Map<string, number>();
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
      if (prompt) return prompt.id;
      // Compaction between dispatch and observation can drop the marker prompt from the active context. The archive keeps it.
      if (!history) return undefined;
      const key = child + '\0' + attemptId;
      const last = historyScans.get(key);
      if (last !== undefined && Date.now() - last < HISTORY_FALLBACK_MS) return undefined;
      historyScans.set(key, Date.now());
      try {
        for await (const message of history(child, signal)) {
          if (message.type === 'user' && typeof message.id === 'string' && message.id.length > 0 && typeof message.text === 'string' && message.text.includes(marker)) return message.id;
        }
      } catch (error) {
        // An unprovable archive is no prompt: the next poll tries again, exactly as when the context lacks the marker.
        if (!(error instanceof OriginProofError)) throw error;
      }
      return undefined;
    },
    async recoverResponse(id: string, parent: string, attempt: WorkflowAttempt) {
      const value = requireIdle(await observe(id), id, parent, true);
      if (value.session.outcome !== 'succeeded') return undefined;
      let user: { text: string } | undefined;
      let answer: Awaited<ReturnType<NativeContext['session']['context']>>[number] & { type: 'assistant' } | undefined;
      if (history) {
        // The archive is newest first; the compacted context may no longer hold the dispatch prompt.
        let latestUser: HistoryMessage | undefined;
        let latestAnswer: HistoryMessage | undefined;
        for await (const message of history(id)) {
          if (message.type === 'user') latestUser ??= message;
          else if (message.type === 'assistant') latestAnswer ??= message;
          if (latestUser && latestAnswer) break;
        }
        user = latestUser as typeof user;
        answer = latestAnswer as typeof answer;
      } else {
        const messages = await ctx.session.context({ sessionID: id });
        user = messages.filter(m => m.type === 'user').at(-1) as typeof user;
        answer = messages.filter(m => m.type === 'assistant').at(-1) as typeof answer;
      }
      if (typeof user?.text !== 'string' || !user.text.includes('Workflow attempt: ' + attempt.id) || !answer || typeof answer.time.completed !== 'number' || !Number.isFinite(answer.time.completed) || answer.time.completed < attempt.startedAt || answer.error) throw new Error('Cannot bind completed child output to this attempt. Reconcile the saved child before resuming');
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
        if (!value.active && !value.inbox.length && !value.permissions.length && !value.forms.length && Array.isArray(value.pendingWork) && !value.pendingWork.length && (terminal(value.session) || unprompted(value))) return;
        if (Date.now() >= until) throw new Error('Could not confirm child termination, settled background work and empty inbox. Resolve its pending work before resuming');
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
      let value = await observe(output.sessionID as string, signal);
      let deferred = false;
      // A background shell settles its current turn before its completion wakes another one. Keep the original
      // foreground dispatch (and its guards/submission authority) alive; never enqueue a duplicate prompt.
      while (true) {
        signal.throwIfAborted();
        if (value.session.id !== output.sessionID || value.session.parentID !== input.parent) throw new Error('Child session does not belong to this parent');
        if (!Array.isArray(value.pendingWork)) throw new Error('Session background completion cannot be verified');
        deferred ||= value.pendingWork.length > 0 || value.active || value.inbox.length > 0 || value.permissions.length > 0 || value.forms.length > 0;
        if (!value.pendingWork.length && (!deferred || (!value.active && !value.inbox.length && !value.permissions.length && !value.forms.length && terminal(value.session)))) break;
        await pause(250);
        signal.throwIfAborted();
        value = await observe(output.sessionID as string, signal);
      }
      requireIdle(value, output.sessionID as string, input.parent, true);
      if (value.session.outcome !== 'succeeded') throw new Error('Native child did not finish successfully');
      const messages = await ctx.session.context({ sessionID: output.sessionID as string });
      const answer = messages.filter(m => m.type === 'assistant').at(-1);
      if (answer?.finish === 'length') throw new Error('Planner/executor output truncated at model output limit. Recover artifacts before resuming');
      if (!answer?.time.completed || answer.error || answer.finish !== 'stop') throw new Error('Native child has no successful final stop response');
      // The tool's original output can be a waiting placeholder. The final native context is authoritative after
      // an automatic continuation, including one that finished before our first observation.
      return Array.isArray(answer.content) ? answer.content.filter(part => part.type === 'text').map(part => part.text).join('\n') : output.output;
    },
  };
}
