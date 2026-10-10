import * as fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chooseExecutor, authExpired, executorCandidates } from '../policy/quota.js';

import { classifyError, classifyResult, pauseReportRecovery, reportPauseReason, submissionPauseReason, submissionRepairPauseReason } from './report.js';
import { MAX_SUBMISSION_REPAIRS } from './submission-repair.js';
import type { ConflictInfo, RepairDecision, RepairHandler, RepairRequest } from './submission-repair.js';
import { isTaskId, SUBMISSION_PROTOCOL, SUBMISSION_TOOL_IDS } from './contracts.js';
import { closeSubmissionBinding, createLocalSubmissionStore, openSubmissionBinding, recordDispatchPrompt, submissionKindForPhase } from './submission-store.js';
import type {
  CompletionResult, PlanResult, ProgressUpdate, ReportDiagnostic, ReportOnlyCheck, RunArguments, RunState,
  RunnerContext, RunnerOptions, RunnerSettings, SubmissionReceipt, SubmissionRepairRecord, SubmissionRepairRefusal, WorkflowResult, WorkflowTask,
} from './types.js';
export type { RunnerBackend, RunnerContext, RunnerOptions, RunnerSettings } from './types.js';
export { classifyError, classifyResult, reportPauseReason } from './report.js';

const readJSON = async <T>(p: string): Promise<T> => JSON.parse(await fs.readFile(p, 'utf8')) as T;
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
const nonempty = (x: unknown): x is string => typeof x === 'string' && x.trim().length > 0;
const invalidResponse = () => new Error('Invalid child response: expected one intact workflow JSON object. Saved last-response.json; caller tool arguments are not the issue.');
const workflowJSON = (text: string): WorkflowResult | undefined => {
  try {
    const value: unknown = JSON.parse(text);
    if (isRecord(value) && typeof value.status === 'string' && ['completed', 'planned', 'blocked'].includes(value.status)) return value as WorkflowResult;
  } catch {}
};
const workflowMarker = (text: string) => /["'](?:status|taskId|planMarkdown|factSheet|evidence|artifacts|summary|handoff)["']\s*:|\{\s*["'](?:status|taskId|planMarkdown|factSheet|evidence|artifacts|summary|handoff)["']|\{\s*["'](?:s|st|sta|stat|statu|task|taskI)[ \t]*(?:\r?\n|$)/.test(text);
export function parseResult(response: unknown): WorkflowResult {
  if (typeof response === 'string') response = { data: { parts: [{ type: 'text', text: response }] } };
  if (!isRecord(response)) throw invalidResponse();
  const data = isRecord(response.data) ? response.data : undefined;
  const info = isRecord(data?.info) ? data.info : undefined;
  if (response.error || info?.error) {
    const error = response.error || info?.error;
    throw new Error(JSON.stringify(error));
  }
  if (info?.finish === 'length') throw new Error('Planner/executor output truncated at model output limit. Raw response saved; recover artifacts before resuming.');
  const raw = Array.isArray(data?.parts) ? data.parts.filter(isRecord).filter(p => p.type === 'text').map(p => p.text).join('\n') : '';
  const cleaned = raw.trim();
  const direct = workflowJSON(cleaned);
  if (direct) return direct;
  // A complete fence gives an exact boundary even when surrounding prose contains JS braces.
  let fenced: { result: WorkflowResult; start: number; end: number } | undefined;
  const fencePattern = /(^|\n)[ \t]*```([^\r\n`]*)\r?\n([\s\S]*?)\r?\n[ \t]*```[ \t]*(?=\r?\n|$)/g;
  for (const match of cleaned.matchAll(fencePattern)) {
    const language = match[2]!.trim().toLowerCase();
    if (language !== 'json' && language !== '') continue;
    const value = workflowJSON(match[3]!);
    if (language === 'json' && !value) throw invalidResponse();
    if (!value) {
      if (workflowMarker(match[3]!)) throw invalidResponse();
      continue;
    }
    if (fenced) throw invalidResponse();
    fenced = { result: value, start: match.index, end: match.index + match[0].length };
  }
  if (fenced) {
    const outside = cleaned.slice(0, fenced.start) + cleaned.slice(fenced.end);
    const unfenced = outside.replace(fencePattern, '');
    if (workflowMarker(outside) || /(^|\n)[ \t]*```(?:json)?[ \t]*\r?\n/i.test(unfenced)) throw invalidResponse();
    return fenced.result;
  }
  if (/(^|\n)[ \t]*```(?:json)?[ \t]*\r?\n/i.test(cleaned)) throw invalidResponse();
  // Preserve the legacy single-object prose envelope. Never repair or guess JSON.
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const value = workflowJSON(cleaned.slice(start, end + 1));
    if (value) return value;
  }
  throw invalidResponse();
}
/**
 * Classifies why an executor completion was rejected: a thrown error, a raw native response, or an
 * already-parsed result. Native and ambiguous-output signals come before envelope omissions.
 */
export function classifyCompletionFailure(task: WorkflowTask, subject: { error: unknown } | { response: unknown } | { result: WorkflowResult }): ReportDiagnostic {
  if ('result' in subject) return classifyResult(subject.result, task);
  if ('error' in subject) return classifyError(subject.error);
  const response = typeof subject.response === 'string' ? { data: { parts: [{ type: 'text', text: subject.response }] } } : subject.response;
  if (!isRecord(response)) return { code: 'ambiguous_output' };
  const data = isRecord(response.data) ? response.data : undefined;
  const info = isRecord(data?.info) ? data.info : undefined;
  const nativeError = response.error || info?.error;
  if (nativeError) {
    let text: string;
    try { text = typeof nativeError === 'string' ? nativeError : JSON.stringify(nativeError); } catch { text = String(nativeError); }
    return classifyError(new Error(text));
  }
  if (info?.finish === 'length') return { code: 'ambiguous_output' };
  let parsed: WorkflowResult;
  try { parsed = parseResult(response); } catch { return { code: 'ambiguous_output' }; }
  return classifyResult(parsed, task);
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
    if (!isTaskId(t.id) || seen.has(t.id) || !nonempty(t.title) || !nonempty(t.brief) || !Array.isArray(t.dependsOn) || t.dependsOn.some(d => !seen.has(d)) || !Array.isArray(t.dod) || !t.dod.length || !t.dod.every(nonempty)) throw new Error('Invalid task or dependency: ' + t.id);
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


/** Compact, task-specific final-reply contract. Always the last text of an executor prompt so long context cannot dilute it. */
export function executorContract(task: WorkflowTask): string {
  return [
    '=== Executor completion contract for ' + task.id + ' (authoritative; overrides any earlier example) ===',
    'Reply with exactly one JSON object: no code fences, no prose before or after it.',
    'Completed shape: {"status":"completed","taskId":' + JSON.stringify(task.id) + ',"summary":"<what changed>","handoff":"<what the next task must know>","evidence":[{"gateId":"G1","gate":"<exact DoD item>","passed":true,"detail":"<actual check, result and evidence path>"}]}',
    'Required fields: status, taskId, summary, handoff, evidence[{gateId, gate, passed, detail}]. Include one evidence entry for every gate below.',
    'Gates:',
    ...task.dod.map((gate, i) => 'G' + (i + 1) + ' = ' + gate),
    'Blocked shape: {"status":"blocked","taskId":' + JSON.stringify(task.id) + ',"reason":"<specific blocker and owner steps>"}',
    'Rules: evidence must already exist before you reply; report results truthfully; set passed=true only for a gate you fully proved; if any gate is unresolved, reply blocked.',
  ].join('\n');
}

/**
 * Final contract of a structured executor prompt. The result goes through the owner-bound tool; the final chat text is
 * human-readable only and is never parsed. The host supplies run, task, attempt and gate text, so none of them appears.
 */
export function structuredExecutorContract(task: WorkflowTask): string {
  const tool = SUBMISSION_TOOL_IDS['executor-result'];
  return [
    '=== Executor submission contract for ' + task.id + ' (authoritative; overrides any earlier example) ===',
    'Submit your result by calling the tool ' + tool + ' exactly once. Your final chat text is never parsed and cannot complete the task: a JSON reply without this tool call is a missing submission.',
    'Completed payload: {"status":"completed","summary":"<what changed>","handoff":"<what the next task must know>","evidence":[{"gateId":"G1","passed":true,"detail":"<actual check, result and evidence path>"}]}',
    'Include exactly one evidence entry for every gate below. Do not include taskId, gate text or any run, attempt, session or owner identity: the host supplies them.',
    'Gates:',
    ...task.dod.map((gate, i) => 'G' + (i + 1) + ' = ' + gate),
    'Blocked payload: {"status":"blocked","reason":"<specific blocker and owner steps>"}',
    'Rules: evidence must already exist before you submit; report results truthfully; set passed=true only for a gate you fully proved; if any gate is unresolved, submit the blocked payload. A call the tool rejects records nothing.',
    'A malformed call may be corrected at most twice. After the first rejection every other tool is disabled for this session, so submit the complete payload from results you already have; do no further work.',
    'After the tool acknowledges the submission, stop: reply with one short sentence and call no other tool.',
  ].join('\n');
}

/** Final contract of a structured planner prompt: artifacts stay in the planning directory and only a reference is submitted. */
export function structuredPlannerContract(): string {
  const tool = SUBMISSION_TOOL_IDS['planner-plan'];
  return [
    '=== Planner submission contract (authoritative; overrides any earlier example) ===',
    'Write plan.md, facts.md and tasks.md in the planning artifact directory named above, then call the tool ' + tool + ' exactly once with {"status":"planned","artifacts":true}. The host reads and validates those files itself and snapshots them when it accepts the plan.',
    'If the plan cannot be made responsibly, call the tool with {"status":"blocked","reason":"<specific decision or prerequisite>"}.',
    'A rejected call may be corrected at most twice. After the first rejection every other tool is disabled, including file writes: the correction is the whole plan submitted inline as {"status":"planned","planMarkdown":"...","factSheet":"...","tasks":[...]}.',
    'Your final chat text is never parsed and cannot admit a plan. Do not put the plan, fact sheet or tasks in the tool payload or the chat reply.',
    'After the tool acknowledges the submission, stop: reply with one short sentence and call no other tool.',
  ].join('\n');
}

/** Delay between host observations of the dispatch prompt. The binding is not authoritative until it is recorded. */
const PROMPT_POLL_MS = 50;

/** Automatic report-only corrections allowed per task. The counter lives in the checkpoint and only advancement resets it. */
export const MAX_REPORT_CORRECTIONS = 2;

/**
 * Report-only correction prompt: restate results that already exist, never do work. Names only fields and gate
 * IDs from the diagnostic, never reply text. The caller appends the attempt marker and then the contract footer.
 */
export function correctionInstruction(task: WorkflowTask, number: number, diagnostic: ReportDiagnostic): string {
  const missing = [diagnostic.missingFields?.length && 'missing fields: ' + diagnostic.missingFields.join(', '), diagnostic.gateIds?.length && 'missing gate entries: ' + diagnostic.gateIds.slice(0, 20).join(', ')].filter(Boolean).join('; ');
  return 'Report-only correction ' + number + '/' + MAX_REPORT_CORRECTIONS + ' for ' + task.id + '. Your previous final reply was not an acceptable completion report' + (missing ? ' (' + missing + ')' : '') + '. '
    + 'Restate ONLY results you already obtained in this session, in the final contract below. Do not call any tools, edit files, run commands or tests, commit, or delegate: all tools are disabled for this turn. '
    + 'For any gate or field you did not actually prove, report passed:false for that gate or reply with the blocked shape. Never guess or invent evidence.';
}

const contextSignal = (context: RunnerContext) => context.signal || context.abort;
const callerIdentity = (context: RunnerContext) => ({ sessionID: context.sessionID, id: context.id, messageID: context.messageID, agent: context.agent });

export function createRunner({ backend, directory, quota, authRefresh, guards = new Map(), git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }), settings: suppliedSettings, workflowRoot, settingsPath, plannerPromptPath, executorPromptPath, planRoot: suppliedPlanRoot, persistence, protocol, promptSync, supervisor }: RunnerOptions) {
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
  // Typed submissions and native outcomes of a structured run: the authoritative persistence, or the atomic local files.
  const localSubmissions = createLocalSubmissionStore(root);
  const submissionStore = persistence ?? localSubmissions;
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
    let rejection: ReportDiagnostic | undefined; // Set only when an executor completion report is rejected.
    let pendingCorrection: string | undefined; // A correction attempt persisted by this invocation and not yet dispatched.
    let correctionRelease: (() => Promise<void>) | undefined; // Report-only restriction held for the pending or running correction.
    let terminationUnconfirmed = false; // True while an interrupt is unconfirmed: the restriction then stays in force.
    const releaseCorrection = async () => {
      const release = correctionRelease;
      if (!release || terminationUnconfirmed) return;
      correctionRelease = undefined;
      await release();
    };
    /**
     * Releases a report-only restriction that an earlier invocation or backend instance left in force. Only with fresh
     * idle proof for the recorded child under the recorded parent; any failure throws, so the restriction stays and the
     * run pauses before dispatching anything. The next explicit resume retries.
     */
    const releaseRetained = async () => {
      const recovery = state.reportRecovery;
      const repair = state.submissionRepair;
      const capability = backend.reportOnly;
      const attemptIds = [...(recovery?.child === state.child ? recovery?.attempts ?? [] : []), ...(repair?.child === state.child ? repair?.attempts ?? [] : [])];
      if (!capability || !state.child || !attemptIds.length) return;
      await backend.assertIdle(state.child, state.parent, contextSignal(context));
      await capability.releaseRetained({ child: state.child, parent: state.parent, runId: state.id, attemptIds });
    };
    /** Names the run the lock holder owns, so the host can find the one active checkpoint without a process-local map. */
    const recordLockOwner = async () => {
      await lock.truncate(0);
      await lock.write(JSON.stringify({ pid: process.pid, parent: context.sessionID, runId: state.id }), 0);
    };
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, parent: context.sessionID }));
      const settings = await configuredSettings();
      if (!Number.isInteger(settings.maxTasks) || settings.maxTasks < 1 || settings.maxTasks > 10 || (settings.timeoutMinutes != null && !(settings.timeoutMinutes > 0))) throw new Error('Runner requires at most 10 tasks and valid optional time warning');
      if (args.action === 'start') {
        if (!nonempty(args.adr) || path.isAbsolute(args.adr)) throw new Error('Provide a repo-relative ADR path');
        const adr = await fs.realpath(path.resolve(directory, args.adr));
        const repo = await fs.realpath(directory);
        if (!adr.startsWith(repo + path.sep)) throw new Error('ADR must be inside this project');
        state = { id: persistence ? args.runId! : randomUUID(), status: 'running', adr: args.adr, parent: context.sessionID, caller: callerIdentity(context), branch: git(['branch', '--show-current']).trim(), baseline: git(['status', '--porcelain']), index: 0, tasks: [], results: [], phase: 'planner', child: null, settings, ...(protocol ? { protocol } : {}) };
        await fs.mkdir(path.join(root, 'runs', state.id), { recursive: !!persistence });
        await save(state);
        started = true;
        await recordLockOwner();
      } else if (args.action === 'resume') {
        if (!/^[\w-]+$/.test(args.runId || '') || !nonempty(args.input)) throw new Error('Resume requires a run ID and resolution');
        state = await load(args.runId!);
        if (persistence) await fs.mkdir(path.join(root, 'runs', state.id), { recursive: true });
        if (state.parent !== context.sessionID) throw new Error('Resume must run from the original parent session');
        if (state.status === 'completed') return JSON.stringify(state);
        if (state.protocol !== undefined && state.protocol !== SUBMISSION_PROTOCOL) throw new Error('This run uses an unsupported protocol: ' + String(state.protocol));
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
        await recordLockOwner();
        await releaseRetained(); // After the fenced save, so a stale owner never releases; before any prompt is dispatched.
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
      /**
       * Decides whether a format-only rejection may be corrected and, if so, persists the consumed counter and the
       * new correction attempt in ONE save. Returns true when the loop should dispatch it. Every refusal throws with
       * `rejection` set to its category, so the run pauses without any prompt. Nothing is sent from here.
       */
      const prepareCorrection = async (task: WorkflowTask, diagnostic: ReportDiagnostic): Promise<boolean> => {
        const failed = state.attempt!;
        const child = state.child;
        if (!child) return false;
        const record = pauseReportRecovery(state.reportRecovery, { index: state.index, taskId: task.id, child, attemptId: failed.id }, diagnostic);
        state.reportRecovery = record; // Keeps the counter in the pause checkpoint even when the next checks refuse.
        const stop = (code: 'correction_exhausted' | 'correction_unsupported', message: string): never => {
          rejection = { ...diagnostic, code };
          throw new Error(message);
        };
        if (contextSignal(context)?.aborted) { rejection = undefined; throw new Error('Run cancelled'); }
        if (record.corrections >= MAX_REPORT_CORRECTIONS) stop('correction_exhausted', 'Report correction exhausted for ' + task.id + ' after ' + record.corrections + ' attempts');
        const capability = backend.reportOnly;
        let support: ReportOnlyCheck;
        try { support = capability ? await capability.check(failed.model, child) : { supported: false, reason: 'Report-only enforcement is unavailable: this backend has no report-only capability' }; }
        catch (error) { support = { supported: false, reason: errorMessage(error) }; }
        if (!capability || !support.supported) return stop('correction_unsupported', support.supported ? 'Report-only enforcement is unavailable' : support.reason);
        try {
          await backend.assertIdle(child, state.parent, contextSignal(context));
          await checkBudget();
        } catch (error) { rejection = undefined; throw error; }
        // Same model and variant only: never switch provider for a correction.
        const same = executorCandidates(cfg).filter(candidate => candidate.model === failed.model && (candidate.variant || undefined) === (failed.variant || undefined));
        try {
          if (!same.length) throw new Error('the selected model is no longer configured');
          chooseExecutor(await quota(cfg), { ...cfg, executorCandidates: same });
        } catch (error) {
          rejection = { code: 'auth_or_quota' };
          throw new Error('Quota unavailable for the selected model ' + failed.model + '; no report correction was sent: ' + errorMessage(error));
        }
        // The restriction is taken before anything is persisted, so a refusal never consumes a correction.
        const id = randomUUID();
        // The owner identity outlives this invocation, so a later invocation (or a new backend) can release it after fresh idle proof.
        try { correctionRelease = await capability.restrict(child, { parent: state.parent, attemptId: id, runId: state.id }); }
        catch (error) { return stop('correction_unsupported', errorMessage(error)); }
        const previous = { recovery: state.reportRecovery, attempt: state.attempt };
        failed.status = 'rejected';
        state.reportRecovery = { ...record, corrections: record.corrections + 1, mode: 'correcting', attempts: [...record.attempts, id], diagnostic };
        state.attempt = { id, phase: 'executor', index: state.index, child, status: 'launching', startedAt: Date.now(), model: failed.model, ...(failed.variant ? { variant: failed.variant } : {}), purpose: 'report-correction' };
        try { await save(state); }
        catch (error) {
          state.reportRecovery = previous.recovery; state.attempt = previous.attempt; // A stale owner never dispatches.
          await releaseCorrection().catch(() => {});
          rejection = undefined;
          throw error;
        }
        pendingCorrection = id;
        rejection = undefined;
        return true;
      };
      /** Commits advancement atomically in one checkpoint. A crash before this save replays the saved receipt only. */
      const advance = async (planning: boolean, admittedPlan: PlanResult | undefined, admittedCompletion: CompletionResult | undefined): Promise<void> => {
        const next = { ...state, child: null };
        delete next.attempt;
        delete next.resolution;
        delete next.taskStartedAt;
        delete next.taskElapsedMs;
        delete next.reportRecovery; // Real advancement only: restarts, new attempts and resumes keep the record.
        delete next.submissionRepair; // Same for the structured repair bound: it never resets on a restart or a resume.
        if (next.submissionBinding) next.submissionBinding = closeSubmissionBinding(next.submissionBinding);
        if (planning) { next.tasks = admittedPlan!.tasks; next.phase = 'executor'; }
        else {
          next.results = [...state.results, { ...admittedCompletion!, sessionId: state.child, model: state.attempt!.model, quotaSelection: state.selection, ...(state.reportRecovery?.corrections ? { reportCorrections: state.reportRecovery.corrections } : {}) }];
          next.index++;
        }
        await save(next);
        state = next;
        await ledger(state);
      };
      /** The native turn result of a structured attempt, kept apart from the typed submission. Idempotent per attempt. */
      const captureOutcome = async (response: unknown): Promise<void> => {
        const attempt = state.attempt!;
        if (!state.child || await submissionStore.readNativeOutcome(state.id, attempt.id)) return;
        await submissionStore.writeNativeOutcome(state.id, { outcomeVersion: 1, runId: state.id, phase: attempt.phase, index: attempt.index, attemptId: attempt.id, child: state.child, response, capturedAt: Date.now() });
      };
      /**
       * Applies the durable typed submission of a structured attempt, or pauses. Nothing is parsed from chat text. A
       * plan or result is admitted only when the receipt matches the attempt AND the child is freshly confirmed idle
       * with a successful final stop and empty inbox, forms and permissions. Blocked and unfinished submissions are
       * semantic pauses and never invite a repair.
       */
      const admitSubmission = async (planning: boolean, task: WorkflowTask | undefined, stored: SubmissionReceipt): Promise<void> => {
        const attempt = state.attempt!;
        if (stored.protocol !== SUBMISSION_PROTOCOL || stored.runId !== state.id || stored.parent !== state.parent || stored.attemptId !== attempt.id || stored.phase !== state.phase
          || stored.index !== state.index || stored.kind !== submissionKindForPhase(state.phase) || stored.child !== state.child || (task ? stored.taskId !== task.id : stored.taskId !== undefined)) {
          throw new Error('Saved submission does not match the current attempt');
        }
        const canonical: Record<string, unknown> = isRecord(stored.canonical) ? stored.canonical : {};
        if (stored.outcome === 'blocked') {
          attempt.status = 'rejected';
          if (task) rejection = { code: 'agent_blocked' };
          throw new Error(nonempty(canonical.reason) ? canonical.reason : 'Agent blocked without a reason');
        }
        if (stored.outcome === 'unfinished') {
          attempt.status = 'rejected';
          const gateIds = (Array.isArray(canonical.evidence) ? canonical.evidence : []).filter(isRecord).filter(entry => entry.passed !== true).map(entry => entry.gateId).filter((id): id is string => typeof id === 'string').slice(0, 50);
          if (task) rejection = { code: 'unfinished_work', ...(gateIds.length ? { gateIds } : {}) };
          throw new Error('Unfinished work: the submission reported unresolved gates');
        }
        if (stored.outcome !== (planning ? 'planned' : 'completed')) throw new Error('Saved submission has an unknown outcome');
        // Receipt AND confirmed native stop. Anything short of that pauses with the receipt kept for the next resume.
        try {
          if (!state.child) throw new Error('The submission has no recorded child session');
          await backend.assertIdle(state.child, state.parent, contextSignal(context));
          const finalText = await backend.recoverResponse(state.child, state.parent, attempt);
          if (finalText === undefined) throw new Error('Native child did not finish successfully');
          await captureOutcome(finalText);
        } catch (error) {
          const diagnostic = classifyError(error);
          if (diagnostic.code === 'auth_or_quota') { if (task) rejection = diagnostic; throw error; }
          if (task) { rejection = { code: 'submission_unconfirmed' }; throw error; }
          throw new Error(submissionPauseReason('submission_unconfirmed', 'the plan', errorMessage(error)));
        }
        await checkBudget();
        let admittedPlan: PlanResult | undefined;
        let admittedCompletion: CompletionResult | undefined;
        try {
          if (planning) {
            // The tasks come from the immutable snapshot the host captured when it accepted the plan, never from the files now.
            const plan = { status: 'planned', planMarkdown: canonical.planMarkdown, factSheet: canonical.factSheet, tasks: structuredClone(canonical.tasks) } as WorkflowResult;
            validatePlan(plan, cfg.maxTasks);
            await atomicJSON(path.join(runDir, 'reply-plan.json'), plan);
            await fs.writeFile(path.join(runDir, 'plan.md'), plan.planMarkdown);
            await fs.writeFile(path.join(runDir, 'facts.md'), plan.factSheet);
            await atomicJSON(path.join(runDir, 'tasks.json'), plan.tasks);
            admittedPlan = plan;
          } else {
            const completion = structuredClone(canonical) as WorkflowResult;
            validateCompletion(completion, task!, { requireGateIds: true });
            await atomicJSON(path.join(runDir, 'reply-' + task!.id + '.json'), completion);
            admittedCompletion = completion;
          }
        } catch (error) {
          attempt.status = 'rejected';
          throw error;
        }
        await advance(planning, admittedPlan, admittedCompletion);
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
        const structured = state.protocol === SUBMISSION_PROTOCOL;
        const recheckRejected = !structured && args.action === 'resume' && !args.recovery && state.attempt?.status === 'rejected';
        // A correction persisted by THIS invocation is dispatched below. Any other correction without a receipt may already have run.
        const dispatchingCorrection = pendingCorrection !== undefined && state.attempt?.id === pendingCorrection;
        pendingCorrection = undefined;
        if (structured && state.attempt && state.attempt.status !== 'rejected') {
          if (state.attempt.phase !== state.phase || state.attempt.index !== state.index || state.attempt.child !== state.child) throw new Error('Attempt does not match the current task');
          // A saved typed submission is applied without redispatching: admission needs the receipt AND a freshly confirmed native stop.
          const stored = await submissionStore.readSubmission(state.id, state.attempt.id, submissionKindForPhase(state.phase));
          if (stored) {
            // Work that ran alongside or after this attempt's receipt was recorded durably: its evidence is not admitted. The
            // explicit resume that reaches here dispatches a fresh attempt for the same task instead.
            if (state.submissionRepair?.conflict?.attemptId === state.attempt.id) {
              state.attempt.status = 'rejected';
              state.submissionRepair = { ...state.submissionRepair }; delete state.submissionRepair.conflict;
              if (state.submissionBinding) state.submissionBinding = closeSubmissionBinding(state.submissionBinding);
            } else { await admitSubmission(planning, task, stored); continue; }
          }
          // No submission was recorded for the interrupted attempt: only an explicit resume reaches here, and it dispatches a fresh attempt.
        }
        if (!structured && state.attempt && (state.attempt.status !== 'rejected' || recheckRejected)) {
          if (state.attempt.phase !== state.phase || state.attempt.index !== state.index || state.attempt.child !== state.child) throw new Error('Attempt does not match the current task');
          const receiptPath = path.join(runDir, 'attempt-' + state.attempt.id + '.json');
          try { receipt = persistence ? await persistence.readReceipt(state.id, state.attempt.id) ?? undefined : await readJSON<NonNullable<typeof receipt>>(receiptPath); } catch (error) { if (!isRecord(error) || error.code !== 'ENOENT') throw error; }
          const correctionAttempt = state.attempt.purpose === 'report-correction';
          // A correction is persisted before it is sent, so even a launching one with a recorded child may have been admitted.
          if (!receipt && state.child && !dispatchingCorrection && (['admitted', 'interrupted'].includes(state.attempt.status) || (correctionAttempt && state.attempt.status === 'launching'))) {
            let response: unknown;
            try { response = await backend.recoverResponse(state.child, state.parent, state.attempt); }
            catch (error) {
              state.attempt.status = 'rejected';
              if (correctionAttempt) rejection = { code: 'correction_ambiguous' };
              else if (!planning) rejection = classifyCompletionFailure(task, { error });
              throw error;
            }
            if (response !== undefined) {
              receipt = { ...state.attempt, response };
              await writeReceipt(state.id, receipt);
            } else if (correctionAttempt) {
              state.attempt.status = 'rejected';
              rejection = { code: 'correction_ambiguous' };
              throw new Error('A previous report correction may already have run and no reply could be recovered; none is repeated automatically');
            }
          }
          if (receipt) {
            if (receipt.id !== state.attempt.id || receipt.child !== state.child || receipt.phase !== state.phase || receipt.index !== state.index) throw new Error('Saved response does not match the current attempt');
            try {
              result = parseResult(receipt.response);
              if (recheckRejected) {
                if (planning) {
                  result = await loadPlanArtifacts(result, directory, state.id, planRoot);
                  validatePlan(result, cfg.maxTasks);
                } else validateCompletion(result, task, { requireGateIds: true });
              }
            } catch (error) {
              state.attempt.status = 'rejected';
              if (!recheckRejected) {
                if (!planning) rejection = classifyCompletionFailure(task, { response: receipt.response });
                throw error;
              }
              receipt = undefined; // Explicit resume may request a fresh reply; preserve the invalid original receipt.
            }
            if (receipt) await checkBudget();
          }
        }
        if (!receipt) {
          if (!tokenLimitsDisabled && Object.values(usage).reduce((a, b) => a + b, 0) >= maxRunTokens) throw new Error('ADR token budget reached');
          // A structured submission is authenticated to the observed dispatch prompt. Without that observation nothing could ever be accepted.
          if (structured && typeof backend.observeDispatchPrompt !== 'function') throw new Error('This backend cannot observe the dispatch prompt, so no submission could be authenticated. Nothing was dispatched; use a native backend that supports structured submissions.');
          // The persisted correction attempt keeps its model and variant: no new quota selection and no provider switch.
          const correcting = dispatchingCorrection ? state.attempt : undefined;
          if (!correcting && planning) {
            const snapshot = await quota(cfg);
            const provider = cfg.plannerModel.startsWith('claude-code/') ? 'claude-code' : 'anthropic';
            if (!snapshot[provider]?.entries?.length || snapshot[provider]!.errors?.length) throw new Error('Claude quota unavailable before planning');
          } else if (!correcting) {
            state.selection = chooseExecutor(await quota(cfg), cfg);
          }
          const chosen = correcting ? correcting.model : planning ? cfg.plannerModel : state.selection!.model;
          const variant = correcting ? correcting.variant : planning ? cfg.plannerVariant : state.selection!.variant;
          const attemptID = correcting ? correcting.id : randomUUID();
          const instructions = correcting ? '' : await fs.readFile(promptPaths[planning ? 'planner' : 'executor'], 'utf8');
          const prompt = correcting ? correctionInstruction(task, state.reportRecovery!.corrections, state.reportRecovery!.diagnostic ?? { code: 'report_format' }) : (tokenLimitsDisabled ? 'Token limits disabled by owner; usage tracking remains enabled.' : 'Budget: ' + (planning ? cfg.maxPlannerTokens : cfg.maxSessionTokens) + ' reported tokens for this session, ' + cfg.maxRunTokens + ' for the ADR;') + ' ' + (timeoutMinutes > 0 ? 'Time warning after ' + cfg.timeoutMinutes + ' active minutes: continue working toward the DoD; elapsed time alone is not a blocker.' : 'No elapsed-time warning or task deadline is configured.') + ' Keep context narrow. Token limits, when enabled, still apply.\n' + instructions + '\n\nADR: ' + state.adr + '\nProject: ' + directory + '\nBranch: ' + state.branch + ' (stay on this branch; return blocked if another branch is required)\nPre-existing changes, do not overwrite or commit:\n' + state.baseline + '\nRun directory: ' + runDir + '\nPlanning artifact directory: ' + path.join(planRoot, 'adr-' + state.id) + '\n' + (planning ? '' : 'Task: ' + JSON.stringify(task) + '\nRead facts.md and ledger.md in the run directory. Do not read prior session transcripts.') + '\n' + (state.resolution ? 'Owner resolution: ' + state.resolution : '') + '\nDo not invoke other agents, background jobs, or Session Goals. ' + (structured ? 'Report only through the submission tool named in the contract below; your final chat text is human-readable and is never parsed.' : 'Return the specified JSON as your final answer.') + ' If interrupted, reconcile files and existing completed work before continuing. Do not repeat passed checks unless affected by new changes.';
          if (!correcting) {
            state.attempt = { id: attemptID, phase: state.phase, index: state.index, child: state.child, status: 'launching', startedAt: Date.now(), model: chosen, ...(variant ? { variant } : {}) };
            // Structured runs persist the submission authority with the attempt, in the same save, before any prompt is sent.
            if (state.protocol) state.submissionBinding = openSubmissionBinding(state, (state.submissionBinding?.dispatch ?? 0) + 1);
            await save(state);
          }
          const attempt = state.attempt!;
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
          let promptStop = false;
          const promptAbort = new AbortController();
          let promptWatch: Promise<void> | undefined;
          /**
           * Records the native prompt that started this dispatch once the host observes it in the child session. The
           * binding authenticates no call until then, and a failure here stops the dispatch (fail closed).
           */
          const watchPrompt = () => {
            if (!structured || promptWatch) return;
            let recorded = false;
            let tail: Promise<void> = Promise.resolve();
            const observeOnce = async () => {
              if (recorded || promptStop) return;
              const child = attempt.child;
              const found = child ? await backend.observeDispatchPrompt!({ child, parent: state.parent, attemptId: attempt.id, signal: AbortSignal.any([controller.signal, promptAbort.signal]) }) : undefined;
              if (promptStop || recorded || !found) return;
              if (state.submissionBinding?.attemptId !== attempt.id) throw new Error('The submission binding no longer belongs to this attempt');
              state.submissionBinding = recordDispatchPrompt(state.submissionBinding, found);
              recorded = true;
              await save(state);
            };
            /** One serialized observation. The poll below and the host's first model-context observation share it. */
            const settle = () => {
              const pending = tail.then(observeOnce);
              tail = pending.catch(() => {});
              return pending;
            };
            const unregister = attempt.child && promptSync ? promptSync.register(attempt.child, settle) : undefined;
            promptWatch = (async () => {
              try {
                while (!promptStop && !recorded) {
                  await settle();
                  if (recorded) return;
                  await new Promise(resolve => setTimeout(resolve, PROMPT_POLL_MS));
                }
              } finally { unregister?.(); }
            })().catch(error => {
              if (promptStop) return;
              guardError ??= error;
              controller.abort(error);
            });
          };
          let unregisterRepair: (() => void) | undefined;
          let conflicting: ConflictInfo | undefined;
          let conflictSave: Promise<void> | undefined;
          let repairTail: Promise<unknown> = Promise.resolve();
          const repairCode: Record<SubmissionRepairRefusal, 'submission_repair_exhausted' | 'submission_unsupported' | 'auth_or_quota' | 'submission_refused'> = {
            exhausted: 'submission_repair_exhausted', unsupported: 'submission_unsupported', auth_or_quota: 'auth_or_quota', unavailable: 'submission_refused',
          };
          const repairRecord = (): SubmissionRepairRecord => {
            const existing = state.submissionRepair;
            if (existing && existing.phase === state.phase && existing.index === state.index && existing.taskId === task?.id && existing.child === state.child) return existing;
            return { phase: state.phase, index: state.index, ...(task ? { taskId: task.id } : {}), child: state.child, repairs: 0, attempts: [] };
          };
          /**
           * Ends the offer of repair for this attempt. The refusal is saved (best effort) and the dispatch is aborted, so the run
           * pauses with the exact category and nothing is rerun. The child is interrupted and, until that is confirmed, restricted.
           */
          const refuse = async (code: SubmissionRepairRefusal, detail: string, cause?: unknown): Promise<RepairDecision> => {
            const subject = planning ? 'the plan' : task.id;
            const quotaStop = code === 'auth_or_quota';
            const category = repairCode[code];
            const reason = category === 'auth_or_quota' ? 'Quota or authentication unavailable for the selected model; no submission repair was offered: ' + detail : submissionRepairPauseReason(category, subject, detail);
            const stop = cause ?? new Error(reason);
            state.submissionRepair = { ...repairRecord(), refused: { attemptId: attempt.id, code, reason: detail } };
            // A budget or other guard error carries its own pause text; only a refusal the host decided here gets a category.
            if (!planning && !cause) rejection = quotaStop ? { code: 'auth_or_quota' } : { code: category };
            await save(state).catch(() => {});
            guardError ??= stop;
            controller.abort(stop);
            return { feedback: false, code, message: detail };
          };
          const decide = async (request: RepairRequest): Promise<RepairDecision> => {
            const child = state.child;
            if (!child || request.kind !== submissionKindForPhase(state.phase)) return { feedback: false, code: 'unavailable', message: 'this session is not the bound child' };
            if (controller.signal.aborted || state.submissionRepair?.refused?.attemptId === attempt.id) return { feedback: false, code: 'unavailable', message: 'this dispatch has ended' };
            const record = repairRecord();
            if (record.repairs >= MAX_SUBMISSION_REPAIRS) return refuse('exhausted', 'the submission was malformed ' + (record.repairs + 1) + ' times');
            // Repair needs enforced report-only mode; an unverifiable host or model pauses here, before any feedback is sent.
            const capability = backend.reportOnly;
            if (!correctionRelease) {
              let support: ReportOnlyCheck;
              try { support = capability ? await capability.check(attempt.model, child) : { supported: false, reason: 'this backend has no report-only capability' }; }
              catch (error) { support = { supported: false, reason: errorMessage(error) }; }
              if (!capability || !support.supported) return refuse('unsupported', support.supported ? 'report-only enforcement is unavailable' : support.reason);
            }
            // The same usage and quota guards as any dispatch. A repair never resets accounting.
            try { await checkBudget(); }
            catch (error) { return refuse('unavailable', errorMessage(error), error); }
            try {
              if (planning) {
                const snapshot = await quota(cfg);
                const provider = attempt.model.startsWith('claude-code/') ? 'claude-code' : 'anthropic';
                if (!snapshot[provider]?.entries?.length || snapshot[provider]!.errors?.length) throw new Error('Claude quota unavailable before the plan repair');
              } else {
                const same = executorCandidates(cfg).filter(candidate => candidate.model === attempt.model && (candidate.variant || undefined) === (attempt.variant || undefined));
                if (!same.length) throw new Error('the selected model is no longer configured');
                chooseExecutor(await quota(cfg), { ...cfg, executorCandidates: same });
              }
            } catch (error) { return refuse('auth_or_quota', errorMessage(error)); }
            // Restriction first (a refusal never consumes a repair), then the durable counter, then the feedback.
            let taken = false;
            if (!correctionRelease) {
              try { correctionRelease = await capability!.restrict(child, { parent: state.parent, attemptId: attempt.id, runId: state.id }, { allow: SUBMISSION_TOOL_IDS[request.kind] }); taken = true; }
              catch (error) { return refuse('unsupported', errorMessage(error)); }
            }
            const previous = state.submissionRepair;
            const next: SubmissionRepairRecord = { ...record, repairs: record.repairs + 1, attempts: record.attempts.includes(attempt.id) ? record.attempts : [...record.attempts, attempt.id] };
            state.submissionRepair = next;
            try { await save(state); }
            catch (error) {
              state.submissionRepair = previous; // A stale owner never grants a repair.
              if (taken) await releaseCorrection().catch(() => {});
              return refuse('unavailable', errorMessage(error));
            }
            return { feedback: true, used: next.repairs, remaining: MAX_SUBMISSION_REPAIRS - next.repairs };
          };
          const repairHandler: RepairHandler = {
            reject(request) {
              const pending = repairTail.then(() => decide(request));
              repairTail = pending.catch(() => {});
              return pending;
            },
            conflict(info) {
              conflicting ??= info;
              state.submissionRepair = { ...repairRecord(), conflict: { attemptId: attempt.id, kind: info.kind, tool: info.tool } };
              conflictSave = save(state).catch(() => {});
            },
          };
          const onStarted = async (id: string) => {
            if (state.child && state.child !== id) throw new Error('Native executor changed the child session');
            if (activeStartedAt) return;
            state.child = id;
            attempt.child = id;
            attempt.status = 'admitted';
            if (state.submissionBinding?.attemptId === attempt.id) state.submissionBinding = { ...state.submissionBinding, child: id };
            state.taskStartedAt ||= Date.now();
            state.taskElapsedMs ||= 0;
            await save(state); // Native progress runs before prompt admission.
            watchPrompt();
            if (structured && supervisor) unregisterRepair ??= supervisor.register(id, repairHandler);
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
            const response = await backend.runSubagent({ child: state.child, parent: state.parent, agent: planning ? cfg.plannerAgent : cfg.executorAgent, model: chosen, variant, title: 'ADR ' + path.basename(state.adr) + ': ' + (planning ? 'plan' : task.id + ' ' + task.title + (correcting ? ' (report correction ' + state.reportRecovery!.corrections + '/' + MAX_REPORT_CORRECTIONS + ')' : '')), prompt: prompt + '\nWorkflow attempt: ' + attemptID + (structured ? '\n\n' + (planning ? structuredPlannerContract() : structuredExecutorContract(task)) : planning ? '' : '\n\n' + executorContract(task)), onStarted, currentChild: () => state.child }, { ...context, signal: controller.signal, progress: update => announce({ title: state.id + ': ' + (planning ? 'planning' : task.id + ' (' + (state.index + 1) + '/' + state.tasks.length + ')'), ...update }) });
            if (guardError) throw guardError;
            if (controller.signal.aborted) throw new Error('Run cancelled');
            if (structured) {
              // The final chat text is only a human-readable native outcome; it is never parsed and never a receipt shortcut.
              await captureOutcome(response);
              await checkBudget();
            } else {
              receipt = { ...attempt, response };
              await writeReceipt(state.id, receipt);
              await atomicJSON(path.join(runDir, 'last-response.json'), response);
              try { result = parseResult(response); }
              catch (error) { attempt.status = 'rejected'; if (!planning) rejection = classifyCompletionFailure(task, { response }); throw error; }
              await checkBudget();
            }
          } catch (error) {
            // Native cancellation may reject with a generic interruption. Preserve the guard that caused it.
            const cause = guardError ?? error;
            // A failure before any reply (and not a budget guard or cancellation) is a native/provider failure.
            if (structured) {
              // Never a format diagnostic in a structured run: only auth/quota or a native failure, neither invites a restated report.
              if (!planning && !guardError && !controller.signal.aborted) rejection = classifyError(cause).code === 'auth_or_quota' ? classifyError(cause) : { code: 'native_failure' };
            } else if (!planning && !receipt && !guardError && !controller.signal.aborted) rejection = classifyCompletionFailure(task, { error: cause });
            controller.abort(cause);
            if (!receipt && state.child) attempt.status = 'interrupted';
            if (state.child) {
              terminationUnconfirmed = !!correctionRelease; // A held report-only restriction is kept until termination is confirmed.
              try { await backend.interrupt(state.child, state.parent); terminationUnconfirmed = false; }
              catch (cancelError) {
                if (guardError) throw new Error(errorMessage(guardError) + '. Cancellation check: ' + errorMessage(cancelError));
                throw new Error(errorMessage(cancelError) + '. Original error: ' + errorMessage(cause));
              }
            }
            if (chosen.startsWith('claude-code/') && authExpired(errorMessage(cause))) {
              throw new Error('Claude Code authentication unavailable. Refresh Claude Code manually, then explicitly resume this run.');
            }
            if ((planning || chosen.startsWith('anthropic/')) && authExpired(errorMessage(cause))) {
              if (typeof authRefresh !== 'function') throw new Error('Claude authentication expired; no credential refresh integration is available');
              await authRefresh();
              throw new Error('Claude authentication expired. Native credential refresh attempted; check provider connection, then resume.');
            }
            throw cause;
          } finally {
            if (activeStartedAt) state.taskElapsedMs = (state.taskElapsedMs ?? 0) + Date.now() - activeStartedAt;
            clearTimeout(timer);
            clearInterval(budgetTimer);
            promptStop = true;
            unregisterRepair?.();
            await repairTail;
            promptAbort.abort();
            await promptWatch; // No binding write may land after this dispatch ended.
            await warningWrite;
            if (state.child) guards.delete(state.child);
            parentSignal?.removeEventListener('abort', cancel);
            await releaseCorrection().catch(() => {}); // Fail closed: a release that cannot run leaves the restriction in force.
          }
          if (structured) {
            // Implementation work next to or after the accepted submission means its evidence may have changed after the receipt.
            if (state.child && supervisor) { const seen = supervisor.conflict(state.child); if (seen && !conflicting) repairHandler.conflict(seen); }
            await conflictSave;
            if (conflicting) {
              attempt.status = 'rejected';
              const reason = submissionRepairPauseReason('conflicting_work', planning ? 'the plan' : task.id, conflicting.kind === 'parallel' ? 'a tool call ran in parallel with the submission' : 'a tool call started after the submission');
              if (!planning) rejection = { code: 'conflicting_work' };
              throw new Error(reason);
            }
            // The child returned. Admit only a durable typed submission; a missing one (refusal, omission, a rejected call) pauses.
            const stored = await submissionStore.readSubmission(state.id, attempt.id, submissionKindForPhase(state.phase));
            if (!stored) {
              attempt.status = 'rejected';
              if (!planning) rejection = { code: 'submission_missing' };
              throw new Error(submissionPauseReason('submission_missing', planning ? 'the plan' : task.id));
            }
            await admitSubmission(planning, task, stored);
            continue;
          }
        }
        let admittedPlan: PlanResult | undefined;
        let admittedCompletion: CompletionResult | undefined;
        let correctable: ReportDiagnostic | undefined; // Set only for a format-only rejection that may be corrected.
        try {
          await atomicJSON(path.join(runDir, 'reply-' + (planning ? 'plan' : task.id) + '.json'), result);
          if (result.status === 'blocked') {
            if (!planning) rejection = classifyCompletionFailure(task, { result });
            throw new Error(result.reason || 'Agent blocked without a reason');
          }
          if (planning) {
            result = await loadPlanArtifacts(result, directory, state.id, planRoot);
            validatePlan(result, cfg.maxTasks);
            admittedPlan = result;
            await fs.writeFile(path.join(runDir, 'plan.md'), result.planMarkdown);
            await fs.writeFile(path.join(runDir, 'facts.md'), result.factSheet);
            await atomicJSON(path.join(runDir, 'tasks.json'), result.tasks);
          } else {
            try { validateCompletion(result, task, { requireGateIds: true }); }
            catch (error) {
              rejection = classifyCompletionFailure(task, { result });
              if (rejection.code === 'report_format') correctable = rejection;
              throw error;
            }
            admittedCompletion = result;
          }
        } catch (error) {
          if (state.attempt) state.attempt.status = 'rejected'; // An explicit resolution may reprompt this idle child.
          // Only a format-only rejection is corrected, and only after the counter and attempt are durably saved. Every refusal throws.
          if (!correctable || !(await prepareCorrection(task, correctable))) throw error;
        }
        if (correctable) continue;
        // Commit advancement atomically. A crash before this commit replays the receipt only.
        await advance(planning, admittedPlan, admittedCompletion);
      }
    } catch (error) {
      if (!state || !started) throw error;
      state.status = 'paused';
      state.reason = errorMessage(error);
      if (state.submissionBinding) state.submissionBinding = closeSubmissionBinding(state.submissionBinding); // A stopped run accepts no late submission.
      const failedTask = state.phase === 'executor' ? state.tasks[state.index] : undefined;
      if (rejection && failedTask) {
        state.reportRecovery = pauseReportRecovery(state.reportRecovery, { index: state.index, taskId: failedTask.id, child: state.child, attemptId: state.attempt?.id ?? '' }, rejection);
        state.reason = reportPauseReason(rejection, failedTask, state.reason);
      }
      // A pause is never "correcting": cancellation, budget and quota stops keep the counter and clear the mode.
      if (state.reportRecovery?.mode === 'correcting') state.reportRecovery = { ...state.reportRecovery, mode: 'paused' };
      await save(state);
      return JSON.stringify({ runId: state.id, status: 'paused', childSession: state.child, reason: state.reason });
    } finally {
      await releaseCorrection().catch(() => {}); // Pre-dispatch stops; an unconfirmed interrupt keeps the restriction.
      await lock.close();
      await fs.unlink(lockPath);
    }
  };
}
