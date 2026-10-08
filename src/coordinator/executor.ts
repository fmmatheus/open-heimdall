import path from 'node:path';
import { connect, snapshot } from '../opencode/observer.js';
import type { ConnectionOptions } from '../opencode/observer.js';
import type { SessionAPI, SessionSnapshot } from '../opencode/types.js';
import type { ExecutorInspection, ManagedExecutor, RunRecord } from './types.js';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const status = (error: unknown) => record(error) ? error.status : undefined;
const empty = (value: SessionSnapshot) => !value.active && !value.inbox.length && !value.permissions.length && !value.forms.length;
const terminal = (value: SessionSnapshot) => empty(value) && ['succeeded', 'failed', 'interrupted'].includes(value.session.outcome ?? '') && Number.isFinite(value.session.time?.idle);
const pristine = (value: SessionSnapshot) => empty(value) && !value.session.outcome && !value.messages.length && [value.session.tokens?.input, value.session.tokens?.output, value.session.tokens?.reasoning, value.session.tokens?.cache?.read, value.session.tokens?.cache?.write].every(token => token === 0);
const stopped = (value: SessionSnapshot) => {
  const answer = value.messages.filter(record).find(message => message.type === 'assistant');
  return !!answer && answer.finish === 'stop' && !answer.error && record(answer.time) && typeof answer.time.completed === 'number' && Number.isFinite(answer.time.completed);
};

/** One durable parent launch. The native plugin retains ownership of agent execution. */
export function managedPrompt(run: RunRecord): string {
  const args = run.launchAction === 'start'
    ? { action: 'start', runId: run.id, adr: '.heimdall/feature.md' }
    : { action: 'resume', runId: run.id, input: run.resolution };
  return 'Heimdall managed run: ' + run.id + '\nCall the native adr_workflow tool exactly once with these arguments:\n' + JSON.stringify(args) + '\nReport its result and wait. Do not implement, delegate directly, or retry a paused run.';
}

export function createManagedExecutor({ getRun, connection = {}, preflightTimeoutMs = 10000, pause = ms => new Promise<void>(resolve => setTimeout(resolve, ms)), now = Date.now }: {
  getRun: (id: string) => RunRecord | Promise<RunRecord>;
  connection?: ConnectionOptions;
  preflightTimeoutMs?: number;
  pause?: (ms: number) => Promise<void>;
  now?: () => number;
}): ManagedExecutor {
  if (!Number.isFinite(preflightTimeoutMs) || preflightTimeoutMs <= 0 || preflightTimeoutMs > 10000) throw new Error('Native readiness timeout must be positive and at most 10000ms');
  const current = async (expected: RunRecord, launching = false) => {
    const run = await getRun(expected.id);
    if (run.id !== expected.id || run.parentSessionId !== expected.parentSessionId || path.resolve(run.worktreePath) !== path.resolve(expected.worktreePath)) throw new Error('Managed run launch identity changed');
    if (run.ownerToken !== expected.ownerToken || run.version !== expected.version || (launching && (!run.ownerToken || !run.capacityReserved))) throw new Error('Managed executor ownership or version changed');
    return run;
  };
  const apiFor = (run: RunRecord) => connect(run.worktreePath, undefined, { ...connection, ...run.specification.opencode, authentication: run.specification.opencode.authentication ?? 'basic' });
  const verifySession = (value: SessionSnapshot, run: RunRecord, parent?: string) => {
    if (typeof value.session.location?.directory !== 'string' || path.resolve(value.session.location.directory) !== path.resolve(run.worktreePath) || (parent !== undefined && value.session.parentID !== parent)) throw new Error('Native session escaped the managed worktree or parent');
  };
  const listChildren = async (api: SessionAPI, parent: string, run: RunRecord): Promise<string[]> => {
    const children = new Set<string>(), cursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    while (true) {
      if (++pages > 1000) throw new Error('Native child inventory exceeds the verified pagination bound');
      const query = cursor === undefined ? new URLSearchParams({ parentID: parent, limit: '100', order: 'asc' }) : new URLSearchParams({ cursor, limit: '100' });
      const page = await api.request('/api/session?' + query, { raw: true });
      if (!record(page) || !Array.isArray(page.data) || !record(page.cursor)) throw new Error('Cannot verify paginated native child inventory');
      for (const session of page.data) {
        if (!record(session) || typeof session.id !== 'string' || !session.id || session.parentID !== parent || !record(session.location) || typeof session.location.directory !== 'string' || path.resolve(session.location.directory) !== path.resolve(run.worktreePath) || children.has(session.id)) throw new Error('Native child inventory changed or escaped its parent/worktree');
        children.add(session.id);
      }
      const next = page.cursor.next;
      // V2 emits a next cursor for every nonempty page, including the last one.
      if (next === undefined || next === null) return [...children];
      if (!page.data.length || typeof next !== 'string' || !next || cursors.has(next)) throw new Error('Cannot verify native child pagination');
      cursors.add(next); cursor = next;
    }
  };
  const preflight = async (api: SessionAPI, run: RunRecord) => {
    const deadline = now() + preflightTimeoutMs;
    const expected = path.join(run.worktreePath, '.opencode/plugins/heimdall.ts');
    const roles = ['adr-orchestrator', run.specification.settings.plannerAgent, run.specification.settings.executorAgent];
    const timeout = () => new Error('Timed out waiting for managed Heimdall plugin and native agents');
    while (true) {
      const remaining = deadline - now();
      if (remaining <= 0) throw timeout();
      const signal = AbortSignal.timeout(Math.max(1, Math.ceil(remaining)));
      let plugins: unknown, agents: unknown;
      try {
        [plugins, agents] = await Promise.all([api.request('/api/plugin', { signal }), api.request('/api/agent', { signal })]);
      } catch (error) {
        if (signal.aborted || now() >= deadline) throw timeout();
        if (status(error) !== 503) throw error;
        await pause(Math.min(250, deadline - now()));
        continue;
      }
      if (!Array.isArray(plugins) || !Array.isArray(agents)) throw new Error('Cannot verify managed native plugin and agent inventories');
      const entries = plugins.filter(record);
      for (const entry of entries) {
        const ours = record(entry.source) && entry.source.type === 'local' && typeof entry.source.path === 'string' && path.resolve(entry.source.path) === path.resolve(expected);
        if ((entry.id === 'adr.workflow' || ours) && record(entry.state) && entry.state.status === 'failed') throw new Error('Managed Heimdall plugin failed to activate');
        if (ours && entry.id !== 'adr.workflow') throw new Error('Managed Heimdall plugin has an unexpected native identity');
      }
      const workflow = entries.filter(plugin => plugin.id === 'adr.workflow');
      if (workflow.length > 1) throw new Error('Expected exactly one managed Heimdall plugin');
      if (workflow[0] && (!record(workflow[0].state) || workflow[0].state.status !== 'active' || !record(workflow[0].source) || workflow[0].source.type !== 'local' || typeof workflow[0].source.path !== 'string' || path.resolve(workflow[0].source.path) !== path.resolve(expected))) throw new Error('Expected one active managed Heimdall plugin in this worktree');
      let ready = workflow.length === 1;
      for (const role of roles) {
        const found = agents.filter(record).filter(agent => agent.id === role);
        if (found.length > 1 || (found[0] && (role === 'adr-orchestrator' ? found[0].mode !== 'primary' : found[0].mode !== 'subagent'))) throw new Error('Managed native agent has the wrong mode or ambiguous identity: ' + role);
        if (!found.length) ready = false;
      }
      // Cold locations announce an empty inventory until their asynchronous setup settles.
      if (now() >= deadline) throw timeout();
      if (ready) return;
      await pause(Math.min(250, deadline - now()));
    }
  };
  return {
    async launch(expected) {
      const run = await current(expected, true);
      const api = await apiFor(run);
      await preflight(api, run);
      const mutate = async (route: string, body: unknown) => {
        await current(expected, true);
        return api.request(route, { method: 'POST', body });
      };
      const slash = run.specification.settings.plannerModel.indexOf('/');
      if (slash < 1 || slash === run.specification.settings.plannerModel.length - 1) throw new Error('Invalid managed parent model');
      const model = { providerID: run.specification.settings.plannerModel.slice(0, slash), id: run.specification.settings.plannerModel.slice(slash + 1), ...(run.specification.settings.plannerVariant ? { variant: run.specification.settings.plannerVariant } : {}) };
      const created = await mutate('/api/session', {
        id: run.parentSessionId, agent: 'adr-orchestrator', model, title: 'Heimdall ' + run.id,
        location: { directory: run.worktreePath }, metadata: { heimdallRunId: run.id },
      });
      // Native 2.0.22 session projection names an omitted variant "default".
      if (!record(created) || created.id !== run.parentSessionId || created.agent !== 'adr-orchestrator' || !record(created.location) || created.location.directory !== run.worktreePath || !record(created.metadata) || created.metadata.heimdallRunId !== run.id || !record(created.model) || created.model.providerID !== model.providerID || created.model.id !== model.id || created.model.variant !== (model.variant ?? 'default')) throw new Error('Created native parent does not match the reserved managed identity');
      const observed = await snapshot(api, run.parentSessionId);
      verifySession(observed, run);
      const text = managedPrompt(run);
      const verifyAdmission = (value: unknown) => {
        if (!record(value) || value.id !== run.promptMessageId || value.sessionID !== run.parentSessionId || value.type !== 'user' || !record(value.payload) || value.payload.text !== text || !record(value.payload.metadata) || value.payload.metadata.heimdallRunId !== run.id) throw new Error('Native prompt identity conflicts with the reserved launch');
      };
      let projected: unknown;
      try { projected = await api.request('/api/session/' + encodeURIComponent(run.parentSessionId) + '/message/' + encodeURIComponent(run.promptMessageId)); }
      catch (error) { if (status(error) !== 404) throw error; }
      if (projected !== undefined) {
        if (!record(projected) || projected.id !== run.promptMessageId || projected.type !== 'user' || projected.text !== text || !record(projected.metadata) || projected.metadata.heimdallRunId !== run.id) throw new Error('Projected native prompt identity conflicts with the reserved launch');
        return;
      }
      const pending = observed.inbox.filter(record).find(item => item.id === run.promptMessageId);
      if (pending) verifyAdmission(pending);
      if (observed.active) {
        if (pending) return;
        throw new Error('Native parent is active without this reserved prompt');
      }
      if (observed.permissions.length || observed.forms.length || observed.inbox.some(item => !record(item) || item.id !== run.promptMessageId)) throw new Error('Managed parent has unrelated pending input');
      if (!pending && !(pristine(observed) || terminal(observed))) throw new Error('Native parent has no verified durable launch boundary');
      if (!pending && run.launchAction === 'start' && !pristine(observed)) throw new Error('Managed parent already executed; reconcile instead of starting another workflow');
      const route = '/api/session/' + encodeURIComponent(run.parentSessionId) + '/prompt';
      const body = { id: run.promptMessageId, text, metadata: { heimdallRunId: run.id }, delivery: 'queue' };
      if (!pending) verifyAdmission(await mutate(route, { ...body, resume: false }));
      verifyAdmission(await mutate(route, { ...body, resume: true }));
    },
    async inspect(expected): Promise<ExecutorInspection> {
      try {
        const run = await current(expected);
        const api = await apiFor(run);
        const checkpoint = run.checkpoint;
        const children = new Set<string>([
          ...(checkpoint?.child ? [checkpoint.child] : []),
          ...(checkpoint?.attempt?.child ? [checkpoint.attempt.child] : []),
          ...(checkpoint?.results.flatMap(result => result.sessionId ? [result.sessionId] : []) ?? []),
          ...Object.keys(checkpoint?.usage ?? {}), ...Object.keys(checkpoint?.uncachedUsage ?? {}),
        ]);
        const checkpointedChildren = new Set(children);
        for (const child of await listChildren(api, run.parentSessionId, run)) children.add(child);
        let parent: SessionSnapshot | undefined;
        try { parent = await snapshot(api, run.parentSessionId); }
        catch (error) {
          if (status(error) !== 404) throw error;
        }
        if (parent) {
          verifySession(parent, run);
          if (!terminal(parent)) return { idle: false, status: 'unknown', reason: 'Native parent is active, awaiting input, or lacks a durable terminal outcome' };
        }
        const observations = await Promise.all([...children].map(async id => {
          if ((await listChildren(api, id, run)).length) throw new Error('Nested native delegation is outside the verified managed workflow');
          const value = await snapshot(api, id);
          verifySession(value, run, run.parentSessionId);
          if (!terminal(value) && !(checkpointedChildren.has(id) && pristine(value))) throw new Error('Native child is active, awaiting input, or lacks a durable terminal outcome');
          return value;
        }));
        if (!parent) {
          if (checkpoint) return { idle: false, status: 'unknown', reason: 'Authoritative workflow parent is absent' };
          return { idle: true, status: 'failed', reason: 'Reserved native parent is absent and all linked native children were verified idle' };
        }
        if (!checkpoint) return { idle: true, status: 'failed', reason: 'Native parent terminated without a managed workflow checkpoint' };
        if (checkpoint.id !== run.id || checkpoint.parent !== run.parentSessionId) throw new Error('Managed checkpoint belongs to a different native run');
        if (checkpoint.attempt?.status === 'launching' && !checkpoint.child) return { idle: false, status: 'unknown', reason: 'A child launch has no durably recorded native identity' };
        if (checkpoint.status === 'paused') return { idle: true, status: 'paused', reason: checkpoint.reason ?? 'Native workflow paused for owner resolution' };
        if (checkpoint.status === 'completed' && checkpoint.tasks.length > 0 && checkpoint.results.length === checkpoint.tasks.length && checkpoint.index === checkpoint.tasks.length) {
          if (parent.session.outcome !== 'succeeded' || !stopped(parent) || observations.some(child => child.session.outcome !== 'succeeded' || !stopped(child))) return { idle: true, status: 'failed', reason: 'Completed workflow lacks successful final native responses' };
          return { idle: true, status: 'succeeded' };
        }
        return { idle: false, status: 'unknown', reason: 'Native sessions settled but the authoritative workflow checkpoint is unfinished' };
      } catch {
        return { idle: false, status: 'unknown', reason: 'Unable to verify complete managed native execution state' };
      }
    },
  };
}
