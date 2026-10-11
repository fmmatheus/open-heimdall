import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { SUBMISSION_KINDS, SUBMISSION_PROTOCOL } from './contracts.js';
import type { SubmissionKind } from './contracts.js';
import type { NativeOutcome, RunnerPersistence, RunState, SubmissionBinding, SubmissionReceipt } from './types.js';

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const index = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const phases = ['planner', 'executor'];

export const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;
export const isSubmissionKind = (value: unknown): value is SubmissionKind => SUBMISSION_KINDS.includes(value as SubmissionKind);
export const submissionKindForPhase = (phase: 'planner' | 'executor'): SubmissionKind => phase === 'planner' ? 'planner-plan' : 'executor-result';

/** Structural guard for an untrusted stored or transmitted receipt. It checks shape only, never authority. */
export function isSubmissionReceipt(value: unknown): value is SubmissionReceipt {
  if (!isRecord(value)) return false;
  const { contract, caller, runtime } = value;
  return value.receiptVersion === 1 && value.protocol === SUBMISSION_PROTOCOL && isSubmissionKind(value.kind)
    && isRecord(contract) && contract.protocol === SUBMISSION_PROTOCOL && contract.kind === value.kind && index(contract.version)
    && text(value.runId) && phases.includes(value.phase as string) && index(value.index)
    && (value.taskId === undefined || text(value.taskId)) && text(value.attemptId) && index(value.dispatch)
    && text(value.parent) && text(value.child) && text(value.origin)
    && isRecord(caller) && text(caller.sessionID) && text(caller.agent) && text(caller.messageID) && text(caller.callId)
    && isRecord(runtime) && text(runtime.packageVersion) && runtime.protocol === SUBMISSION_PROTOCOL
    && text(value.outcome) && 'rawPayload' in value && 'canonical' in value && text(value.digest)
    && Number.isFinite(value.acceptedAt);
}

export function isNativeOutcome(value: unknown): value is NativeOutcome {
  return isRecord(value) && value.outcomeVersion === 1 && text(value.runId) && phases.includes(value.phase as string) && index(value.index)
    && text(value.attemptId) && text(value.child) && 'response' in value && Number.isFinite(value.capturedAt);
}

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/**
 * An identical duplicate has the same kind, host identity, contract and submitted payload. Acceptance time, the
 * native message and call ids of the repeated call, and the build that accepted it do not make it a conflict:
 * the stored receipt (with its original values) is what a duplicate gets back.
 */
export function sameSubmission(stored: SubmissionReceipt, candidate: SubmissionReceipt): boolean {
  const strip = (receipt: SubmissionReceipt) => {
    const { acceptedAt: _acceptedAt, runtime: _runtime, caller, ...rest } = roundTrip(receipt);
    return { ...rest, caller: { sessionID: caller.sessionID, agent: caller.agent } };
  };
  return isDeepStrictEqual(strip(stored), strip(candidate));
}
export function sameOutcome(stored: NativeOutcome, candidate: NativeOutcome): boolean {
  const { capturedAt: _a, ...left } = roundTrip(stored);
  const { capturedAt: _b, ...right } = roundTrip(candidate);
  return isDeepStrictEqual(left, right);
}

/**
 * Authority check shared by every store: the receipt must describe the checkpoint's current open binding and
 * attempt exactly. Nothing the model supplied can satisfy it; only the persisted checkpoint can.
 */
export function assertSubmissionMatchesCheckpoint(state: RunState | null | undefined, receipt: SubmissionReceipt): void {
  if (!state) throw new Error('Submission requires a saved checkpoint');
  if (state.protocol !== SUBMISSION_PROTOCOL || receipt.protocol !== state.protocol) throw new Error('Submission requires a run that selected the structured protocol');
  if (state.id !== receipt.runId || state.parent !== receipt.parent) throw new Error('Submission does not belong to this run');
  const { attempt, submissionBinding: binding } = state;
  if (!attempt || attempt.id !== receipt.attemptId || attempt.phase !== receipt.phase || attempt.index !== receipt.index
    || state.phase !== receipt.phase || state.index !== receipt.index || submissionKindForPhase(receipt.phase) !== receipt.kind) throw new Error('Submission does not match the checkpoint attempt, phase and task');
  if (receipt.phase === 'executor' && state.tasks[state.index]?.id !== receipt.taskId) throw new Error('Submission does not match the checkpoint attempt, phase and task');
  if (receipt.phase === 'planner' && receipt.taskId !== undefined) throw new Error('Submission does not match the checkpoint attempt, phase and task');
  if (!binding || binding.protocol !== receipt.protocol || binding.kind !== receipt.kind || binding.runId !== receipt.runId || binding.attemptId !== receipt.attemptId
    || binding.phase !== receipt.phase || binding.index !== receipt.index || binding.taskId !== receipt.taskId || binding.parent !== receipt.parent) throw new Error('Submission does not match the checkpoint binding');
  if (binding.status !== 'open') throw new Error('Submission binding is closed');
  if (!binding.child || binding.child !== receipt.child || state.child !== receipt.child || attempt.child !== receipt.child || receipt.caller.sessionID !== receipt.child) throw new Error('Submission does not match the bound child session');
  if (binding.dispatch !== receipt.dispatch) throw new Error('Submission dispatch generation is not current');
  if (!binding.prompt || binding.prompt !== receipt.origin) throw new Error('Submission native origin does not match the binding dispatch prompt');
}

export function assertOutcomeMatchesCheckpoint(state: RunState | null | undefined, outcome: NativeOutcome): void {
  const attempt = state?.attempt;
  if (!state || !attempt || state.id !== outcome.runId || attempt.id !== outcome.attemptId || attempt.phase !== outcome.phase || attempt.index !== outcome.index
    || !attempt.child || attempt.child !== outcome.child || state.child !== outcome.child) throw new Error('Native outcome does not match the checkpoint attempt');
}

/** Opens the binding for the checkpoint's current attempt. `dispatch` must rise with every prompt to the same child. */
export function openSubmissionBinding(state: RunState, dispatch = 1): SubmissionBinding {
  const attempt = state.attempt;
  if (state.protocol !== SUBMISSION_PROTOCOL || !attempt) throw new Error('A submission binding needs a structured run with an attempt');
  if (!Number.isSafeInteger(dispatch) || dispatch < 1) throw new Error('Dispatch generation must be a positive integer');
  const taskId = attempt.phase === 'executor' ? state.tasks[attempt.index]?.id : undefined;
  if (attempt.phase === 'executor' && !taskId) throw new Error('The bound executor attempt has no task');
  return {
    protocol: SUBMISSION_PROTOCOL, kind: submissionKindForPhase(attempt.phase), runId: state.id, phase: attempt.phase, index: attempt.index,
    ...(taskId === undefined ? {} : { taskId }), attemptId: attempt.id, dispatch, parent: state.parent, child: state.child, prompt: null, status: 'open',
  };
}
/** Records the native prompt that started a dispatch. Write-once: a recorded prompt is never replaced. */
export function recordDispatchPrompt(binding: SubmissionBinding, promptMessageId: string): SubmissionBinding {
  if (!text(promptMessageId)) throw new Error('A dispatch prompt message id is required');
  if (binding.status !== 'open') throw new Error('Submission binding is closed');
  if (binding.prompt !== null && binding.prompt !== promptMessageId) throw new Error('The dispatch prompt is already recorded');
  return { ...binding, prompt: promptMessageId };
}
export const closeSubmissionBinding = (binding: SubmissionBinding): SubmissionBinding => ({ ...binding, status: 'closed' });

// --- Standalone (atomic local) store ---------------------------------------------------------------------

type LocalStore = Pick<RunnerPersistence, 'load' | 'readSubmission' | 'writeSubmission' | 'readNativeOutcome' | 'writeNativeOutcome'>;

const missing = (error: unknown) => isRecord(error) && error.code === 'ENOENT';

async function readFileJSON<T>(file: string): Promise<T | null> {
  try { return JSON.parse(await fs.readFile(file, 'utf8')) as T; }
  catch (error) { if (missing(error)) return null; throw error; }
}

/** Writes a complete temp file, then links it into place: the destination appears whole or not at all, never overwritten. */
async function createOnce(file: string, value: unknown): Promise<boolean> {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2));
    await handle.sync();
  } finally { await handle.close(); }
  try { await fs.link(temporary, file); return true; }
  catch (error) { if (isRecord(error) && error.code === 'EEXIST') return false; throw error; }
  finally { await fs.rm(temporary, { force: true }); }
}

/** Submissions and native outcomes for standalone runs: exclusive files beside `state.json`, same semantics as the coordinator. */
export function createLocalSubmissionStore(root: string): LocalStore {
  const runDirectory = (runId: string) => {
    if (!SAFE_ID.test(runId)) throw new Error('Invalid run id');
    return path.join(root, 'runs', runId);
  };
  const attemptId = (value: string) => {
    if (!SAFE_ID.test(value)) throw new Error('Invalid attempt id');
    return value;
  };
  const submissionFile = (runId: string, attempt: string, kind: SubmissionKind) => path.join(runDirectory(runId), `submission-${attemptId(attempt)}-${kind}.json`);
  const outcomeFile = (runId: string, attempt: string) => path.join(runDirectory(runId), `outcome-${attemptId(attempt)}.json`);
  const load = (runId: string) => readFileJSON<RunState>(path.join(runDirectory(runId), 'state.json'));
  return {
    load,
    async readSubmission(runId, attempt, kind) {
      if (!isSubmissionKind(kind)) throw new Error('Unknown submission kind');
      return readFileJSON<SubmissionReceipt>(submissionFile(runId, attempt, kind));
    },
    async writeSubmission(runId, receipt) {
      if (!isSubmissionReceipt(receipt) || receipt.runId !== runId) throw new Error('Submission identity mismatch');
      const file = submissionFile(runId, receipt.attemptId, receipt.kind);
      const settle = async (): Promise<SubmissionReceipt | undefined> => {
        const stored = await readFileJSON<SubmissionReceipt>(file);
        if (!stored) return undefined;
        if (!sameSubmission(stored, receipt)) throw new Error('Saved submission is immutable');
        return stored;
      };
      const existing = await settle();
      if (existing) return existing;
      assertSubmissionMatchesCheckpoint(await load(runId), receipt);
      if (await createOnce(file, receipt)) return receipt;
      return (await settle())!;
    },
    async readNativeOutcome(runId, attempt) { return readFileJSON<NativeOutcome>(outcomeFile(runId, attempt)); },
    async writeNativeOutcome(runId, outcome) {
      if (!isNativeOutcome(outcome) || outcome.runId !== runId) throw new Error('Native outcome identity mismatch');
      const file = outcomeFile(runId, outcome.attemptId);
      const settle = async (): Promise<NativeOutcome | undefined> => {
        const stored = await readFileJSON<NativeOutcome>(file);
        if (!stored) return undefined;
        if (!sameOutcome(stored, outcome)) throw new Error('Saved native outcome is immutable');
        return stored;
      };
      const existing = await settle();
      if (existing) return existing;
      assertOutcomeMatchesCheckpoint(await load(runId), outcome);
      if (await createOnce(file, outcome)) return outcome;
      return (await settle())!;
    },
  };
}
