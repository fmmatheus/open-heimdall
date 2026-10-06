import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chooseExecutor, authExpired } from '../policy/quota.js';

import type {
  CompletionResult, PlanResult, ProgressUpdate, RunArguments, RunState,
  RunnerContext, RunnerOptions, RunnerSettings, WorkflowResult, WorkflowTask,
} from './types.js';
export type { RunnerBackend, RunnerContext, RunnerOptions, RunnerSettings } from './types.js';

const readJSON = async <T>(p: string): Promise<T> => JSON.parse(await fs.readFile(p, 'utf8')) as T;
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
const nonempty = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
export function parseResult(response: unknown): WorkflowResult {
  if (typeof response === 'string') response = { data: { parts: [{ type: 'text', text: response }] } };
  if (!isRecord(response)) throw new Error('Invalid child response: expected one intact workflow JSON object. Saved last-response.json; caller tool arguments are not the issue.');
  const data = isRecord(response.data) ? response.data : undefined;
  const info = isRecord(data?.info) ? data.info : undefined;
  if (response.error || info?.error) {
    const error = response.error || info?.error;
    throw new Error(JSON.stringify(error));
  }
  if (info?.finish === 'length') throw new Error('Planner/executor output truncated at model output limit. Raw response saved; recover artifacts before resuming.');
  const raw = Array.isArray(data?.parts) ? data.parts.filter(isRecord).filter(p => p.type === 'text').map(p => p.text).join('\n') : '';
  const cleaned = raw.trim().replace(/^```(?:json)?\s*\n/, '').replace(/\n```$/, '');
  try { return JSON.parse(cleaned) as WorkflowResult; } catch {}
  // Permit prose/fences around one intact object; never repair or guess JSON.
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try {
      const value: unknown = JSON.parse(cleaned.slice(start, end + 1));
      if (isRecord(value) && typeof value.status === 'string' && ['completed', 'planned', 'blocked'].includes(value.status)) return value as WorkflowResult;
    } catch {}
  }
  throw new Error('Invalid child response: expected one intact workflow JSON object. Saved last-response.json; caller tool arguments are not the issue.');
}
export async function loadPlanArtifacts(result: WorkflowResult, directory: string, id: string, planRoot = '.omo/plans'): Promise<WorkflowResult> {
  if (result.status !== 'planned' || result.artifacts !== true) return result;
  const base = path.resolve(directory, planRoot, 'adr-' + id);
  const repo = await fs.realpath(directory);
  const read = async (name: string) => {
    const target = await fs.realpath(path.join(base, name));
    if (!target.startsWith(repo + path.sep)) throw new Error('Plan artifact escapes project');
    return fs.readFile(target, 'utf8');
  };
  return { status: 'planned', planMarkdown: await read('plan.md'), factSheet: await read('facts.md'), tasks: JSON.parse(await read('tasks.md')) };
}
export function validatePlan(result: WorkflowResult, limit: number): asserts result is PlanResult {
  if (result.status !== 'planned' || !nonempty(result.planMarkdown) || !nonempty(result.factSheet) || !Array.isArray(result.tasks) || !result.tasks.length) throw new Error('Invalid plan: expected planned status, nonempty plan and fact sheet, and a nonempty task array');
  if (result.tasks.length > limit) throw new Error(`Plan has ${result.tasks.length} tasks; maximum is ${limit}. Reuse saved planning artifacts and consolidate tasks without dropping scope or acceptance gates.`);
  const seen = new Set();
  for (const t of result.tasks) {
    if (!/^[A-Za-z0-9_-]+$/.test(t.id) || seen.has(t.id) || !nonempty(t.title) || !nonempty(t.brief) || !Array.isArray(t.dependsOn) || t.dependsOn.some(d => !seen.has(d)) || !Array.isArray(t.dod) || !t.dod.length || !t.dod.every(nonempty)) throw new Error('Invalid task or dependency: ' + t.id);
    seen.add(t.id);
  }
}
export function validateCompletion(result: WorkflowResult, task: WorkflowTask, { requireGateIds = false } = {}): asserts result is CompletionResult {
  if (result.status !== 'completed' || result.taskId !== task.id || !nonempty(result.summary) || !nonempty(result.handoff) || !Array.isArray(result.evidence)) throw new Error('Invalid completion envelope for ' + task.id);
  const gateIds = new Set();
  for (const evidence of result.evidence) {
    if (requireGateIds && evidence.gateId === undefined) throw new Error('Native completion requires an explicit passed stable gate ID for every DoD item');
    if (evidence.gateId === undefined) continue; // Legacy saved replies retain strict text matching.
    const match = /^G([1-9][0-9]*)$/.exec(evidence.gateId);
    const index = match ? Number(match[1]) - 1 : -1;
    if (index < 0 || index >= task.dod.length || gateIds.has(evidence.gateId) || evidence.passed !== true) throw new Error('Invalid, duplicate, or unpassed evidence gate: ' + evidence.gateId);
    gateIds.add(evidence.gateId);
    evidence.gate = task.dod[index];
  }
  const normalize = (text: unknown) => typeof text === 'string' ? text.replace(/`/g, '').replace(/\s+/g, ' ').trim() : '';
  const evidence = result.evidence;
  const missing = task.dod.filter(gate => !evidence.some(e => normalize(e.gate) === normalize(gate) && nonempty(e.detail)));
  if (missing.length) throw new Error('Missing completion evidence for ' + task.id + ': ' + missing.join(' | '));
}


const contextSignal = (context: RunnerContext) => context.signal || context.abort;
const callerIdentity = (context: RunnerContext) => ({ sessionID: context.sessionID, id: context.id, messageID: context.messageID, agent: context.agent });

export function createRunner({ backend, directory, quota, authRefresh, guards = new Map(), git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }), settings: suppliedSettings, workflowRoot, settingsPath, plannerPromptPath, executorPromptPath, planRoot: suppliedPlanRoot, persistence }: RunnerOptions) {
  if (!backend || typeof quota !== 'function') throw new Error('Native backend and quota callback are required');
  const root = path.resolve(directory, workflowRoot ?? '.opencode/adr-workflow');
  const planRoot = path.resolve(directory, suppliedPlanRoot ?? '.omo/plans');
  const promptPaths = {
    planner: plannerPromptPath ? path.resolve(directory, plannerPromptPath) : path.join(root, 'planner.md'),
    executor: executorPromptPath ? path.resolve(directory, executorPromptPath) : path.join(root, 'executor.md'),
  };
  const settingsFile = settingsPath ? path.resolve(directory, settingsPath) : path.join(root, 'settings.json');
  const configuredSettings = async (): Promise<RunnerSettings> => typeof suppliedSettings === 'function' ? suppliedSettings() : suppliedSettings ?? readJSON<RunnerSettings>(settingsFile);
  const atomicJSON = async (dest: string, value: unknown) => {
    await fs.writeFile(dest + '.tmp', JSON.stringify(value, null, 2));
    await fs.rename(dest + '.tmp', dest);
  };
  let saveTail = Promise.resolve();
  const save = (state: RunState) => {
    const value = structuredClone(state);
    const pending = saveTail.then(() => persistence ? persistence.save(value) : atomicJSON(path.join(root, 'runs', value.id, 'state.json'), value));
    saveTail = pending.catch(() => {});
    return pending;
  };
  const load = async (id: string): Promise<RunState> => {
    const state = persistence ? await persistence.load(id) : await readJSON<RunState>(path.join(root, 'runs', id, 'state.json'));
    if (!state) throw new Error('No authoritative checkpoint exists for this run');
    return state;
  };
  const writeReceipt = async (id: string, receipt: NonNullable<RunState['attempt']> & { response: unknown }) => persistence ? persistence.writeReceipt(id, receipt) : atomicJSON(path.join(root, 'runs', id, 'attempt-' + receipt.id + '.json'), receipt);
  const ledger = (state: RunState) => fs.writeFile(path.join(root, 'runs', state.id, 'ledger.md'), '# Task handoffs\n\n' + state.results.map(r => '## ' + r.taskId + '\n' + r.summary + '\n\n' + r.handoff + '\n\n' + r.evidence.map(e => '- ' + e.gate + ': ' + e.detail).join('\n')).join('\n\n'));
  return async function run(args: RunArguments, context: RunnerContext): Promise<string> {
    if (args.action === 'status') {
      if (!/^[\w-]+$/.test(args.runId || '')) throw new Error('Provide the run ID');
      return JSON.stringify(await load(args.runId!));
    }
    if (persistence) {
      if (!/^[A-Za-z0-9_-]+$/.test(args.runId ?? '')) throw new Error('Managed workflow requires its reserved run ID');
      if (args.recovery) throw new Error('Managed recovery requires an explicit coordinator-approved resume');
      if (args.action === 'start') {
        if (!context.id || !context.messageID || !context.agent) throw new Error('Managed start requires a native caller identity');
        await persistence.bindStart({ sessionID: context.sessionID, id: context.id, messageID: context.messageID, agent: context.agent });
        const existing = await persistence.load(args.runId!);
        if (existing) {
          if (existing.id !== args.runId || existing.parent !== context.sessionID || existing.adr !== args.adr) throw new Error('Managed start identity does not match the authoritative run');
          if (existing.status === 'completed') return JSON.stringify(existing);
          throw new Error('Managed run already started; reconcile its existing checkpoint before an explicit resume');
        }
      }
    }
    await fs.mkdir(path.join(root, 'runs'), { recursive: true });
    const lockPath = path.join(root, 'active.lock');
    let lock;
    try { lock = await fs.open(lockPath, 'wx'); }
    catch { throw new Error('Another run owns active.lock. Check its child session before recovering a stale lock.'); }
    let state!: RunState;
    let started = false;
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, parent: context.sessionID }));
      const settings = await configuredSettings();
      if (!Number.isInteger(settings.maxTasks) || settings.maxTasks < 1 || settings.maxTasks > 10 || (settings.timeoutMinutes != null && !(settings.timeoutMinutes > 0))) throw new Error('Runner requires at most 10 tasks and valid optional time warning');
      if (args.action === 'start') {
        if (!nonempty(args.adr) || path.isAbsolute(args.adr)) throw new Error('Provide a repo-relative ADR path');
        const adr = await fs.realpath(path.resolve(directory, args.adr));
        const repo = await fs.realpath(directory);
        if (!adr.startsWith(repo + path.sep)) throw new Error('ADR must be inside this project');
        state = { id: persistence ? args.runId! : randomUUID(), status: 'running', adr: args.adr, parent: context.sessionID, caller: callerIdentity(context), branch: git(['branch', '--show-current']).trim(), baseline: git(['status', '--porcelain']), index: 0, tasks: [], results: [], phase: 'planner', child: null, settings };
        await fs.mkdir(path.join(root, 'runs', state.id), { recursive: !!persistence });
        await save(state);
        started = true;
      } else if (args.action === 'resume') {
        if (!/^[\w-]+$/.test(args.runId || '') || !nonempty(args.input)) throw new Error('Resume requires a run ID and resolution');
        state = await load(args.runId!);
        if (persistence) await fs.mkdir(path.join(root, 'runs', state.id), { recursive: true });
        if (state.parent !== context.sessionID) throw new Error('Resume must run from the original parent session');
        if (state.status === 'completed') return JSON.stringify(state);
        if (state.attempt?.status === 'launching' && !state.child) throw new Error('Child creation was interrupted before its ID was recorded. Reconcile linked sessions manually before resuming; a duplicate child will not be created');
        if (state.child) await backend.assertIdle(state.child, state.parent, contextSignal(context));
        if (git(['branch', '--show-current']).trim() !== state.branch) throw new Error('Branch changed since this run started');
        if (args.recovery) {
          const journal = await readJSON<{ records?: Record<string, { stage: string; recoveries: number; retryAt: number; index: number; phase: string }> }>(path.join(root, 'watchdog/state.json'));
          const record = journal.records?.[state.id + ':' + state.child];
          if (state.status !== 'paused' || state.child !== args.recovery.child || record?.stage !== 'retry_reserved' || record.recoveries !== 1 || record.retryAt !== args.recovery.expectedReservationAt || record.index !== state.index || record.phase !== state.phase || state.watchdogReservationAt === record.retryAt) throw new Error('Recovery reservation/state mismatch or already consumed');
          await backend.assertIdle(state.parent, undefined, contextSignal(context));
          state.watchdogReservationAt = record.retryAt;
        }
        state.settings = settings;
        state.caller = callerIdentity(context);
        state.status = 'running';
        state.resolution = args.input;
        delete state.reason;
        await save(state);
        started = true;
      } else throw new Error('Unknown action');
      await args.onLaunch?.();
      const runDir = path.join(root, 'runs', state.id);
      const cfg = state.settings;
      const tokenLimitsDisabled = state.tokenLimitsDisabled === true || cfg.tokenLimitsDisabled === true;
      if (!tokenLimitsDisabled && (!((cfg.maxSessionTokens ?? 0) > 0) || !((cfg.maxRunTokens ?? 0) > 0))) throw new Error('Token budgets must be positive');
      const maxSessionTokens = cfg.maxSessionTokens ?? Infinity;
      const maxRunTokens = cfg.maxRunTokens ?? Infinity;
      const timeoutMinutes = cfg.timeoutMinutes ?? 0;
      const usage = state.usage ||= {};
      const uncachedUsage = state.uncachedUsage ||= {};
      const checkBudget = async () => {
        if (!state.child) return;
        const { used, uncached } = await backend.usage(state.child);
        if (![used, uncached].every(v => Number.isFinite(v) && v >= 0)) throw new Error('Cannot verify token usage');
        usage[state.child] = used;
        uncachedUsage[state.child] = uncached;
        const total = Object.values(usage).reduce((a, b) => a + b, 0);
        const sessionLimit = state.phase === 'planner' ? (cfg.maxPlannerTokens || maxSessionTokens) : maxSessionTokens;
        const uncachedLimit = state.phase === 'planner' ? cfg.maxPlannerUncachedTokens : cfg.maxSessionUncachedTokens;
        const uncachedTotal = Object.values(uncachedUsage).reduce((a, b) => a + b, 0);
        if (!tokenLimitsDisabled && (used >= sessionLimit || total >= maxRunTokens || uncached >= (uncachedLimit || Infinity) || uncachedTotal >= (cfg.maxRunUncachedTokens || Infinity))) throw new Error('Token budget reached: session ' + used + '/' + sessionLimit + '; ADR ' + total + '/' + cfg.maxRunTokens + '; non-cache-read session ' + uncached + '/' + uncachedLimit + '; ADR ' + uncachedTotal + '/' + cfg.maxRunUncachedTokens);
      };
      const announce = async (update: ProgressUpdate) => {
        if (context.progress) await context.progress({ runId: state.id, childSession: state.child, ...update });
        else context.metadata?.({ title: update.title, metadata: { runId: state.id, childSession: state.child, ...update } });
      };
      await ledger(state);
      while (true) {
        if (contextSignal(context)?.aborted) throw new Error('Run cancelled');
        if (git(['branch', '--show-current']).trim() !== state.branch) throw new Error('Branch changed: pause and reconcile before resuming');
        const planning = state.phase === 'planner';
        const task = state.tasks[state.index];
        if (state.tasks.length > cfg.maxTasks) throw new Error('Plan exceeds current task limit');
        if (!planning && !task) {
          state.status = 'completed';
          await save(state);
          return JSON.stringify({ runId: state.id, status: state.status, completed: state.results.length });
        }
        // A receipt saved before a crash is applied without submitting the same task again.
        let result!: WorkflowResult;
        let receipt: (NonNullable<RunState['attempt']> & { response: unknown }) | undefined;
        if (state.attempt && state.attempt.status !== 'rejected') {
          if (state.attempt.phase !== state.phase || state.attempt.index !== state.index || state.attempt.child !== state.child) throw new Error('Attempt does not match the current task');
          const receiptPath = path.join(runDir, 'attempt-' + state.attempt.id + '.json');
          try { receipt = persistence ? await persistence.readReceipt(state.id, state.attempt.id) ?? undefined : await readJSON<NonNullable<typeof receipt>>(receiptPath); } catch (error) { if (!isRecord(error) || error.code !== 'ENOENT') throw error; }
          if (!receipt && state.child && ['admitted', 'interrupted'].includes(state.attempt.status)) {
            let response: unknown;
            try { response = await backend.recoverResponse(state.child, state.parent, state.attempt); }
            catch (error) { state.attempt.status = 'rejected'; throw error; }
            if (response !== undefined) {
              receipt = { ...state.attempt, response };
              await writeReceipt(state.id, receipt);
            }
          }
          if (receipt) {
            if (receipt.id !== state.attempt.id || receipt.child !== state.child || receipt.phase !== state.phase || receipt.index !== state.index) throw new Error('Saved response does not match the current attempt');
            try { result = parseResult(receipt.response); }
            catch (error) { state.attempt.status = 'rejected'; throw error; }
            await checkBudget();
          }
        }
        if (!receipt) {
          if (!tokenLimitsDisabled && Object.values(usage).reduce((a, b) => a + b, 0) >= maxRunTokens) throw new Error('ADR token budget reached');
          if (planning) {
            const snapshot = await quota(cfg);
            if (!snapshot.anthropic?.entries?.length || snapshot.anthropic.errors?.length) throw new Error('Claude quota unavailable before planning');
          } else {
            state.selection = chooseExecutor(await quota(cfg), cfg);
          }
          const chosen = planning ? cfg.plannerModel : state.selection!.model;
          const variant = planning ? cfg.plannerVariant : state.selection!.variant;
          const attemptID = randomUUID();
          const instructions = await fs.readFile(promptPaths[planning ? 'planner' : 'executor'], 'utf8');
          const prompt = (tokenLimitsDisabled ? 'Token limits disabled by owner; usage tracking remains enabled.' : 'Budget: ' + (planning ? cfg.maxPlannerTokens : cfg.maxSessionTokens) + ' reported tokens for this session, ' + cfg.maxRunTokens + ' for the ADR;') + ' ' + (timeoutMinutes > 0 ? 'Time warning after ' + cfg.timeoutMinutes + ' active minutes: continue working toward the DoD; elapsed time alone is not a blocker.' : 'No elapsed-time warning or task deadline is configured.') + ' Keep context narrow. Token limits, when enabled, still apply.\n' + instructions + '\n\nADR: ' + state.adr + '\nProject: ' + directory + '\nBranch: ' + state.branch + ' (stay on this branch; return blocked if another branch is required)\nPre-existing changes, do not overwrite or commit:\n' + state.baseline + '\nRun directory: ' + runDir + '\nPlanning artifact directory: ' + path.join(planRoot, 'adr-' + state.id) + '\n' + (planning ? '' : 'Task: ' + JSON.stringify(task) + '\nRead facts.md and ledger.md in the run directory. Do not read prior session transcripts.') + '\n' + (state.resolution ? 'Owner resolution: ' + state.resolution : '') + '\nDo not invoke other agents, background jobs, or Session Goals. Return the specified JSON as your final answer. If interrupted, reconcile files and existing completed work before continuing. Do not repeat passed checks unless affected by new changes.';
          state.attempt = { id: attemptID, phase: state.phase, index: state.index, child: state.child, status: 'launching', startedAt: Date.now(), model: chosen, ...(variant ? { variant } : {}) };
          const attempt = state.attempt;
          await save(state);
          const controller = new AbortController();
          const parentSignal = contextSignal(context);
          const cancel = () => controller.abort(parentSignal?.reason);
          parentSignal?.addEventListener('abort', cancel, { once: true });
          if (parentSignal?.aborted) cancel();
          let timer: ReturnType<typeof setTimeout> | undefined;
          let budgetTimer: ReturnType<typeof setInterval> | undefined;
          let warningWrite: Promise<void> | undefined;
          let polling = false;
          let guardError: unknown;
          let activeStartedAt: number | undefined;
          const onStarted = async (id: string) => {
            if (state.child && state.child !== id) throw new Error('Native executor changed the child session');
            if (activeStartedAt) return;
            state.child = id;
            attempt.child = id;
            attempt.status = 'admitted';
            state.taskStartedAt ||= Date.now();
            state.taskElapsedMs ||= 0;
            await save(state); // Native progress runs before prompt admission.
            guards.set(id, checkBudget);
            await checkBudget();
            activeStartedAt = Date.now();
            if (timeoutMinutes > 0 && !state.timeWarnings?.[id]) timer = setTimeout(() => {
              const warning = (planning ? 'Planner' : task.id) + ': exceeded ' + cfg.timeoutMinutes + ' active minutes; continuing (warning only).';
              state.timeWarnings ||= {};
              state.timeWarnings[id] = { message: warning, at: new Date().toISOString() };
              warningWrite = announce({ title: warning, warning }).then(() => save(state)).catch(error => { state.timeWarningSaveError = errorMessage(error); });
            }, Math.max(1, timeoutMinutes * 60000 - state.taskElapsedMs));
            budgetTimer = setInterval(async () => {
              if (polling) return;
              polling = true;
              try { await checkBudget(); } catch (error) { guardError = error; controller.abort(error); } finally { polling = false; }
            }, 1000);
          };
          try {
            if (state.child) await checkBudget();
            const response = await backend.runSubagent({ child: state.child, parent: state.parent, agent: planning ? cfg.plannerAgent : cfg.executorAgent, model: chosen, variant, title: 'ADR ' + path.basename(state.adr) + ': ' + (planning ? 'plan' : task.id + ' ' + task.title), prompt: prompt + '\nWorkflow attempt: ' + attemptID, onStarted, currentChild: () => state.child }, { ...context, signal: controller.signal, progress: update => announce({ title: state.id + ': ' + (planning ? 'planning' : task.id + ' (' + (state.index + 1) + '/' + state.tasks.length + ')'), ...update }) });
            if (guardError) throw guardError;
            if (controller.signal.aborted) throw new Error('Run cancelled');
            receipt = { ...state.attempt, response };
            await writeReceipt(state.id, receipt);
            await atomicJSON(path.join(runDir, 'last-response.json'), response);
            try { result = parseResult(response); }
            catch (error) { state.attempt.status = 'rejected'; throw error; }
            await checkBudget();
          } catch (error) {
            controller.abort(error);
            if (!receipt && state.child) state.attempt.status = 'interrupted';
            if (state.child) {
              try { await backend.interrupt(state.child, state.parent); }
              catch (cancelError) { throw new Error(errorMessage(cancelError) + '. Original error: ' + errorMessage(error)); }
            }
            if ((planning || chosen.startsWith('anthropic/')) && authExpired(errorMessage(error))) {
              if (typeof authRefresh !== 'function') throw new Error('Claude authentication expired; no credential refresh integration is available');
              await authRefresh();
              throw new Error('Claude authentication expired. Native credential refresh attempted; check provider connection, then resume.');
            }
            throw error;
          } finally {
            if (activeStartedAt) state.taskElapsedMs = (state.taskElapsedMs ?? 0) + Date.now() - activeStartedAt;
            clearTimeout(timer);
            clearInterval(budgetTimer);
            await warningWrite;
            if (state.child) guards.delete(state.child);
            parentSignal?.removeEventListener('abort', cancel);
          }
        }
        let admittedPlan: PlanResult | undefined;
        let admittedCompletion: CompletionResult | undefined;
        try {
          await atomicJSON(path.join(runDir, 'reply-' + (planning ? 'plan' : task.id) + '.json'), result);
          if (result.status === 'blocked') throw new Error(result.reason || 'Agent blocked without a reason');
          if (planning) {
            result = await loadPlanArtifacts(result, directory, state.id, planRoot);
            validatePlan(result, cfg.maxTasks);
            admittedPlan = result;
            await fs.writeFile(path.join(runDir, 'plan.md'), result.planMarkdown);
            await fs.writeFile(path.join(runDir, 'facts.md'), result.factSheet);
            await atomicJSON(path.join(runDir, 'tasks.json'), result.tasks);
          } else {
            validateCompletion(result, task, { requireGateIds: true });
            admittedCompletion = result;
          }
        } catch (error) {
          if (state.attempt) state.attempt.status = 'rejected'; // An explicit resolution may reprompt this idle child.
          throw error;
        }
        // Commit advancement atomically. A crash before this commit replays the receipt only.
        const next = { ...state, child: null };
        delete next.attempt;
        delete next.resolution;
        delete next.taskStartedAt;
        delete next.taskElapsedMs;
        if (planning) { next.tasks = admittedPlan!.tasks; next.phase = 'executor'; }
        else {
          next.results = [...state.results, { ...admittedCompletion!, sessionId: state.child, model: state.attempt!.model, quotaSelection: state.selection }];
          next.index++;
        }
        await save(next);
        state = next;
        await ledger(state);
      }
    } catch (error) {
      if (!state || !started) throw error;
      state.status = 'paused';
      state.reason = errorMessage(error);
      await save(state);
      return JSON.stringify({ runId: state.id, status: 'paused', childSession: state.child, reason: state.reason });
    } finally {
      await lock.close();
      await fs.unlink(lockPath);
    }
  };
}
