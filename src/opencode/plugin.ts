import { Plugin } from '@opencode/plugin';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createWorkflow } from '../workflow.js';
import type { WorkflowOptions } from '../workflow.js';
import { loadConfiguration } from '../config.js';
import type { Configuration } from '../config.js';
import type { RunArguments, RunnerContext } from '../workflow/types.js';
import type { MessageHistory, SessionObserver } from './types.js';
import { createMessageHistory, createObserver } from './observer.js';
import { createReportOnlyRegistry, REPAIR_ONLY_DENIAL, REPORT_ONLY_DENIAL } from './report-only.js';
import type { ReportOnlyRegistry } from './report-only.js';
import { createManagedPersistence, readManagedMetadata } from './managed.js';
import {
  isLookalikeSubmissionTool, SUBMISSION_KINDS, SUBMISSION_TOOL_IDS, submissionInputSchema, submissionKindOfTool,
  submissionToolDescription,
} from '../workflow/contracts.js';
import type { SubmissionKind } from '../workflow/contracts.js';
import { SEALED_DENIAL, SUBMISSION_DENIAL } from '../workflow/submission.js';
import { createDispatchPromptSync } from '../workflow/prompt-sync.js';
import { runtimeIdentity } from '../workflow/runtime-identity.js';
import { createSubmissionSupervisor } from '../workflow/submission-repair.js';
import type { SubmissionSupervisor } from '../workflow/submission-repair.js';
import { createNativeSubmissionGate } from './submission-gate.js';
import type { SubmissionGate } from '../workflow/submission.js';

const actions = ['start', 'resume', 'status'];
const inputSchema = {
  type: 'object',
  properties: { action: { type: 'string', enum: actions }, adr: { type: 'string' }, runId: { type: 'string' }, input: { type: 'string' } },
  required: ['action'], additionalProperties: false,
};
const delegated = (name: string) => ['subagent', 'task', 'call_omo_agent', 'adr_workflow', 'opencode', 'session_goal', 'session_goals'].some(leaf => name === leaf || name.endsWith('__' + leaf) || name.endsWith('.' + leaf) || name.endsWith(':' + leaf) || name.endsWith('/' + leaf));
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

export interface PluginOptions {
  configPath?: string;
  configuration?: Configuration;
  observe?: SessionObserver;
  /** Report-only state shared with the backend. Injectable so tests can restrict a session. */
  reportOnly?: ReportOnlyRegistry;
  /** Owns binding and persistence of typed submissions. Defaults to the durable gate over the run's authoritative checkpoint and the host-observed call origin. */
  submissionGate?: SubmissionGate;
  /** Complete message archive used by the default gate to prove call origin. Injectable so tests can serve a paginated archive. */
  history?: MessageHistory;
  /** Format-repair decisions and the tool-call timeline shared with the runner. Injectable so tests can observe it. */
  supervisor?: SubmissionSupervisor;
  /** Managed runs: the runtime digest the coordinator admitted. A plugin loaded from any other build refuses to activate. */
  expectedRuntime?: string;
  /** Harness seams for the composed workflow; production leaves both unset. */
  quota?: WorkflowOptions['quota'];
  git?: WorkflowOptions['git'];
}

export function createPlugin(options: PluginOptions = {}): Plugin.Plugin {
  return Plugin.define({
    id: 'adr.workflow',
    async setup(ctx) {
      if (options.expectedRuntime !== undefined && runtimeIdentity().build?.digest !== options.expectedRuntime) throw new Error('Heimdall runtime does not match the build admitted for this run; refusing to activate');
      const metadata = await readManagedMetadata(ctx.location.directory);
      const configuredPath = process.env.HEIMDALL_CONFIG?.trim() ? process.env.HEIMDALL_CONFIG : undefined;
      const configuration = options.configuration ?? await loadConfiguration({ projectDirectory: ctx.location.directory, configPath: options.configPath ?? (metadata ? '.heimdall/runtime.toml' : configuredPath) });
      if (path.resolve(configuration.projectDirectory) !== path.resolve(ctx.location.directory)) throw new Error('Heimdall configuration belongs to a different native project');
      const root = configuration.workflowRoot;
      const guards = new Map<string, () => Promise<void>>();
      const reportOnly = options.reportOnly ?? createReportOnlyRegistry();
      const observe = options.observe ?? createObserver({ directory: configuration.projectDirectory, ...configuration.opencode });
      const history = options.history ?? createMessageHistory({ directory: configuration.projectDirectory, ...configuration.opencode });
      const promptSync = createDispatchPromptSync();
      const supervisor = options.supervisor ?? createSubmissionSupervisor();
      // Calls that reached execute.before. A submission call the framework rejected earlier (input validation) never does.
      const reached = new Set<string>();
      const run = metadata ? undefined : createWorkflow({ configuration, ctx, observe, history, guards, reportOnly, promptSync, supervisor, quota: options.quota, git: options.git });
      const registrations: Array<{ dispose(): Promise<void> }> = [];
      const recoveries = new Map<string, { operation: Promise<string>; controller: AbortController }>();
      const submissions = options.submissionGate ?? createNativeSubmissionGate({ configuration, history, metadata });
      // Exact registered ids only. A caller is allowed only when the gate binds its session to this kind.
      const permitted = async (kind: SubmissionKind, sessionID: string, agent: string) => (await submissions.exposed(sessionID, agent)) === kind;
      registrations.push(await ctx.tool.transform(editor => {
        // Registered before adr_workflow; each tool is only ever visible to the session its kind is bound to.
        for (const kind of SUBMISSION_KINDS) editor.add({
          name: SUBMISSION_TOOL_IDS[kind],
          options: { codemode: false },
          description: submissionToolDescription(kind),
          input: submissionInputSchema(kind),
          output: { type: 'object', additionalProperties: true },
          async execute(value, context) {
            // Identity comes only from the native call context, never from the model-supplied value.
            const native = { sessionID: context.sessionID, agent: context.agent, messageID: context.messageID, id: context.id };
            if (!await permitted(kind, native.sessionID, native.agent)) throw new Error(SUBMISSION_DENIAL);
            // A blocked or unpassed outcome already closed this attempt: nothing further is accepted from it.
            if (!supervisor.submitting(native.sessionID, native.id)) throw new Error(SUBMISSION_DENIAL);
            try {
              // The boundary seals durably before any receipt is acknowledged; a seal that cannot be saved throws, so nothing is acknowledged.
              const response = await submissions.submit(kind, value, native, { seal: () => supervisor.seal(native.sessionID) });
              if (!response.accepted && response.code === 'unauthorized') {
                // The bound child's call was refused only because its origin is unverifiable: leave a bounded note for the pause reason, nothing else.
                if (response.origin) supervisor.unverified(native.sessionID, response.origin);
                throw new Error(response.message);
              }
              if (!response.accepted && response.code === 'negative') {
                // Explicit blocked or unpassed work is the outcome. It is recorded durably and pauses the run; it is never repaired.
                await supervisor.negative(native.sessionID, { kind, outcome: response.outcome, gateIds: response.gateIds, fields: response.fields, ...(response.reason === undefined ? {} : { reason: response.reason }) });
                const answer = { accepted: false as const, code: 'negative' as const, repairable: false as const, outcome: response.outcome, errors: response.errors, message: 'Your ' + response.outcome + ' outcome was recorded as reported. No repair is offered and nothing will be rerun automatically. Stop now; do not call any other tool.' };
                return { output: answer, content: JSON.stringify(answer) };
              }
              if (response.accepted || response.code !== 'format') return { output: response, content: JSON.stringify(response) };
              // A format rejection spends one bounded repair. The restriction and the saved counter come BEFORE this feedback.
              const decision = await supervisor.reject(native.sessionID, { kind, errors: response.errors });
              const answer = decision.feedback
                ? { ...response, repairsRemaining: decision.remaining, message: response.message + (kind === 'planner-plan' ? ' Only this tool is available now and file writes are disabled: resubmit the whole plan inline as {"status":"planned","planMarkdown":...,"factSheet":...,"tasks":[...]} or the blocked payload.' : ' Only this tool is available now: correct the payload and call it again.') + ' Repairs remaining: ' + decision.remaining + '.' }
                : { accepted: false as const, code: 'format' as const, repairable: false as const, errors: response.errors, message: 'Submission rejected and no repair is available (' + decision.message + '). Stop now; do not call any other tool.' };
              return { output: answer, content: JSON.stringify(answer) };
            } finally { supervisor.submitted(native.sessionID, native.id); }
          },
        });
        editor.add({
          name: 'adr_workflow',
          options: { codemode: false },
          description: 'Plan an ADR and execute its linked tasks sequentially. Start, resume from the original parent session after resolving a blocker, or inspect saved status.',
          input: inputSchema,
          output: { type: 'object', additionalProperties: true },
          async execute(value, context) {
            if (!record(value) || typeof value.action !== 'string' || !actions.includes(value.action)) throw new Error('Unknown workflow action');
            const args = value as unknown as RunArguments;
            let text: string;
            if (metadata) {
              const current = await readManagedMetadata(ctx.location.directory);
              if (!current || current.runId !== metadata.runId || current.parentSessionId !== metadata.parentSessionId || current.endpoint !== metadata.endpoint) throw new Error('Managed workflow identity changed');
              const managed = createManagedPersistence(ctx.location.directory, current);
              const authorized = await managed.authorize(args, context);
              const execute = createWorkflow({ configuration, ctx, observe, history, guards, reportOnly, promptSync, supervisor, quota: options.quota, git: options.git, persistence: managed.persistence });
              text = await execute(authorized, context);
            } else text = await run!(args, context);
            return { output: JSON.parse(text) as unknown, content: text };
          },
        });
      }));
      const submissionIds = Object.values(SUBMISSION_TOOL_IDS);
      const roleAgents = [configuration.settings.plannerAgent, configuration.settings.executorAgent];
      registrations.push(await ctx.tool.hook('execute.before', async input => {
        if (submissionKindOfTool(input.tool)) reached.add(input.id);
        // Report-only keeps at most the one exact submission tool id: anything else (lookalikes, MCP, delegation, nested) is denied here.
        if (reportOnly.has(input.sessionID) && !reportOnly.permits(input.sessionID, input.tool)) throw new Error(submissionIds.some(id => reportOnly.permits(input.sessionID, id)) ? REPAIR_ONLY_DENIAL : REPORT_ONLY_DENIAL);
        const kind = submissionKindOfTool(input.tool);
        if (kind) { if (!await permitted(kind, input.sessionID, input.agent)) throw new Error(SUBMISSION_DENIAL); }
        else if (isLookalikeSubmissionTool(input.tool)) throw new Error(SUBMISSION_DENIAL);
        // No process-local timeline (a plugin restart, say): the persisted sealed boundary still denies new implementation work.
        if (!kind && !supervisor.tracked(input.sessionID) && roleAgents.includes(input.agent) && await submissions.sealed?.(input.sessionID, input.agent)) throw new Error(SEALED_DENIAL);
        // Registered before anything awaits, so a boundary sealed while the guards run still sees this call. A sealed one is denied.
        const admitted = kind ? true : await supervisor.begin(input.sessionID, input.id, input.tool);
        if (!admitted) throw new Error(SEALED_DENIAL);
        try { await guards.get(input.sessionID)?.(); } // Usage and quota guards also run for submission calls.
        catch (error) { if (!kind) supervisor.finished(input.sessionID, input.id); throw error; }
      }));
      registrations.push(await ctx.tool.hook('execute.after', async event => {
        supervisor.finished(event.sessionID, event.id);
        const kind = submissionKindOfTool(event.tool);
        const framework = kind !== undefined && event.status === 'error' && !reached.has(event.id);
        reached.delete(event.id);
        // The framework refused the call before any Heimdall code ran. It still spends a repair, and the restriction and
        // the saved counter are taken here, before the model sees the framework's own error.
        if (framework) await supervisor.reject(event.sessionID, { kind, errors: [{ path: '$', code: 'invalid_type', message: 'the call was rejected before it reached the submission tool' }] }).catch(() => undefined);
      }));
      reportOnly.setHook('execute.before', true);
      registrations.push(await ctx.session.hook('context', async event => {
        if (reportOnly.has(event.sessionID)) {
          // Only a tool the restriction names exactly survives, and only while the gate still binds this session to it.
          const bound = await submissions.exposed(event.sessionID, event.agent);
          for (const name of Object.keys(event.tools)) if (!reportOnly.permits(event.sessionID, name) || submissionKindOfTool(name) !== bound) delete event.tools[name];
          return;
        }
        if (metadata && event.agent === 'adr-orchestrator') {
          if (event.sessionID !== metadata.parentSessionId) event.tools = {};
          else for (const name of Object.keys(event.tools)) if (!/^(?:.*[.:/]|.*__)?adr_workflow$/.test(name)) delete event.tools[name];
        } else if ([configuration.settings.plannerAgent, configuration.settings.executorAgent].includes(event.agent)) {
          for (const name of Object.keys(event.tools)) if (delegated(name)) delete event.tools[name];
        } else if (event.agent === 'adr-orchestrator') {
          const messages = await ctx.session.context({ sessionID: event.sessionID });
          const latest = messages.filter(m => m.type === 'user').at(-1);
          if (latest?.metadata?.adrNotification === true) event.tools = {};
        }
        // The child's FIRST model context can be built before the runner's asynchronous watcher has saved the dispatch
        // prompt. This is the host's own observation of that context, so it asks the watcher to record the prompt now
        // (never from onStarted, which would wait on a prompt that is admitted only after it returns).
        if ([configuration.settings.plannerAgent, configuration.settings.executorAgent].includes(event.agent)) await promptSync.settle(event.sessionID).catch(() => {});
        // Submission tools survive only for the session the gate binds to that exact kind. Decorated
        // lookalike names (namespaced or suffixed) are never ours and are always removed.
        const bound = await submissions.exposed(event.sessionID, event.agent);
        for (const name of Object.keys(event.tools)) {
          const kind = submissionKindOfTool(name);
          if (kind ? kind !== bound : isLookalikeSubmissionTool(name)) delete event.tools[name];
        }
      }));
      reportOnly.setHook('context', true);
      // Enforcement stays unavailable (fail closed) when the host exposes no permission hook.
      if (ctx.permission?.hook) {
        registrations.push(await ctx.permission.hook('evaluate', event => {
          if (!reportOnly.has(event.sessionID) || reportOnly.permits(event.sessionID, event.action)) return;
          event.effect = 'deny';
          event.message = REPORT_ONLY_DENIAL;
        }));
        reportOnly.setHook('permission.evaluate', true);
      }
      if (!metadata) registrations.push(await ctx.rpc.register({
        id: 'adr.workflow',
        methods: {
          recover: {
            input: { type: 'object', properties: { runId: { type: 'string', pattern: '^[A-Za-z0-9_-]+$' }, child: { type: 'string' }, input: { type: 'string', minLength: 1 }, expectedReservationAt: { type: 'number' } }, required: ['runId', 'child', 'input', 'expectedReservationAt'], additionalProperties: false },
            output: { type: 'object', properties: { started: { type: 'boolean' }, runId: { type: 'string' } }, required: ['started', 'runId'], additionalProperties: false },
          },
        },
        events: {},
      }, {
        async recover(value) {
          if (!record(value) || !nonempty(value.runId) || !/^[A-Za-z0-9_-]+$/.test(value.runId) || !nonempty(value.child) || !nonempty(value.input) || typeof value.expectedReservationAt !== 'number' || !Number.isFinite(value.expectedReservationAt)) throw new Error('Invalid recovery reservation');
          const input = { runId: value.runId, child: value.child, input: value.input, expectedReservationAt: value.expectedReservationAt };
          if (recoveries.has(input.runId)) throw new Error('This run is already recovering');
          const state: unknown = JSON.parse(await fs.readFile(path.join(root, 'runs', input.runId, 'state.json'), 'utf8'));
          const caller = record(state) && record(state.caller) ? state.caller : undefined;
          if (!record(state) || !caller || !nonempty(caller.id) || !nonempty(caller.messageID) || !nonempty(caller.agent) || !nonempty(caller.sessionID) || caller.sessionID !== state.parent) throw new Error('This run has no saved native caller identity. Resume once from its parent session first');
          const controller = new AbortController();
          let launched!: (value: { started: boolean; runId: string }) => void;
          const launch = new Promise<{ started: boolean; runId: string }>(resolve => { launched = resolve; });
          const log = (event: Record<string, unknown>) => fs.appendFile(path.join(root, 'runs', input.runId, 'recovery-events.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
          const context: RunnerContext = {
            ...caller,
            sessionID: caller.sessionID, id: caller.id, messageID: caller.messageID, agent: caller.agent,
            signal: controller.signal,
            progress: async update => { await log({ event: 'progress', ...update }); },
          };
          const operation = run!({ action: 'resume', runId: input.runId, input: input.input, recovery: input, onLaunch: async () => { await log({ event: 'recovery_started', reservation: input.expectedReservationAt }); launched({ started: true, runId: input.runId }); } }, context);
          recoveries.set(input.runId, { operation, controller });
          const finished = operation.then(async result => {
            await log({ event: 'recovery_finished', result: JSON.parse(result) as unknown });
            return { started: false, runId: input.runId };
          }, async (error: unknown) => {
            await log({ event: 'recovery_failed', message: error instanceof Error ? error.message : 'Recovery failed' });
            throw error;
          }).finally(() => recoveries.delete(input.runId));
          // Keep native foreground execution alive beyond the short RPC response.
          finished.catch(() => {});
          return Promise.race([launch, finished]);
        },
      }));
      return async () => {
        for (const name of ['execute.before', 'context', 'permission.evaluate'] as const) reportOnly.setHook(name, false);
        for (const { controller } of recoveries.values()) controller.abort(new Error('Heimdall plugin unloaded'));
        await Promise.allSettled([...recoveries.values()].map(x => x.operation));
        for (const registration of registrations.reverse()) await registration.dispose();
      };
    },
  });
}

export default createPlugin();
