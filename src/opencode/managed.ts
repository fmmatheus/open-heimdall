import fs from 'node:fs/promises';
import path from 'node:path';
import { createCoordinatorClient } from '../coordinator/client.js';
import type { RunRecord, StartBinding } from '../coordinator/types.js';
import type { RunArguments, RunnerContext, RunnerPersistence, RunState, WorkflowReceipt } from '../workflow/types.js';

export interface ManagedMetadata {
  endpoint: string;
  runId: string;
  ownerToken: string;
  parentSessionId: string;
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

export async function readManagedMetadata(directory: string): Promise<ManagedMetadata | undefined> {
  let content: string;
  try { content = await fs.readFile(path.join(directory, '.heimdall/managed.json'), 'utf8'); }
  catch (error) { if (record(error) && error.code === 'ENOENT') return undefined; throw error; }
  const value: unknown = JSON.parse(content);
  if (!record(value) || !text(value.endpoint) || !text(value.ownerToken) || !text(value.parentSessionId) || !value.parentSessionId.startsWith('ses') || !text(value.runId) || !/^[A-Za-z0-9_-]+$/.test(value.runId)) throw new Error('Invalid managed workflow identity');
  return { endpoint: value.endpoint, runId: value.runId, ownerToken: value.ownerToken, parentSessionId: value.parentSessionId };
}

/** One native invocation holds one owner fence; a later resume creates a new adapter. */
export function createManagedPersistence(directory: string, metadata: ManagedMetadata, client = createCoordinatorClient(metadata.endpoint)) {
  const identity = { ...metadata };
  const base = '/runs/' + encodeURIComponent(identity.runId);
  const request = async (method: string, route: string, body?: unknown) => {
    const current = await readManagedMetadata(directory);
    if (!current || current.endpoint !== identity.endpoint || current.runId !== identity.runId || current.parentSessionId !== identity.parentSessionId || current.ownerToken !== identity.ownerToken) throw new Error('Managed workflow identity changed');
    return client.request(method, route, body, identity.ownerToken);
  };
  const getRun = async (): Promise<RunRecord> => {
    const value = await request('GET', base);
    if (!record(value) || value.id !== identity.runId || value.parentSessionId !== identity.parentSessionId || typeof value.worktreePath !== 'string' || path.resolve(value.worktreePath) !== path.resolve(directory) || !record(value.specification)) throw new Error('Coordinator run does not belong to this native worktree');
    return value as unknown as RunRecord;
  };
  const persistence: RunnerPersistence = {
    async load(runId) {
      if (runId !== identity.runId) throw new Error('Managed checkpoint run mismatch');
      return await request('GET', base + '/checkpoint') as RunState | null;
    },
    async save(state) {
      if (state.id !== identity.runId || state.parent !== identity.parentSessionId) throw new Error('Managed checkpoint identity mismatch');
      await request('PUT', base + '/checkpoint', state);
    },
    async readReceipt(runId, attemptId) {
      if (runId !== identity.runId || !/^[A-Za-z0-9_-]+$/.test(attemptId)) throw new Error('Managed receipt identity mismatch');
      return await request('GET', base + '/receipts/' + encodeURIComponent(attemptId)) as WorkflowReceipt | null;
    },
    async writeReceipt(runId, receipt) {
      if (runId !== identity.runId || !/^[A-Za-z0-9_-]+$/.test(receipt.id)) throw new Error('Managed receipt identity mismatch');
      await request('PUT', base + '/receipts/' + encodeURIComponent(receipt.id), receipt);
    },
    async bindStart(binding) {
      if (binding.sessionID !== identity.parentSessionId) throw new Error('Managed native parent mismatch');
      await request('POST', base + '/binding', binding);
    },
  };
  const authorize = async (args: RunArguments, context: RunnerContext): Promise<RunArguments> => {
    if (context.sessionID !== identity.parentSessionId || (args.runId !== undefined && args.runId !== identity.runId)) throw new Error('This native parent does not own the managed run');
    const run = await getRun();
    if (args.action === 'status') return { action: 'status', runId: identity.runId };
    if (!context.id || !context.messageID || context.agent !== 'adr-orchestrator') throw new Error('Managed execution requires its native orchestrator caller');
    if (args.action === 'start') {
      if (run.launchAction !== 'start' || (args.adr !== undefined && args.adr !== '.heimdall/feature.md')) throw new Error('Managed start does not match the reserved feature');
      const binding: StartBinding = { sessionID: context.sessionID, id: context.id, messageID: context.messageID, agent: context.agent };
      if (run.binding && Object.keys(binding).some(key => binding[key as keyof StartBinding] !== run.binding![key as keyof StartBinding])) throw new Error('Managed start belongs to a different native tool call');
      return { action: 'start', runId: identity.runId, adr: '.heimdall/feature.md' };
    }
    if (run.launchAction !== 'resume' || !run.resolution || args.input !== run.resolution || run.checkpoint?.status !== 'paused') throw new Error('Managed resume requires the coordinator-approved resolution');
    const claim = await request('POST', base + '/resume-binding', { sessionID: context.sessionID, id: context.id, messageID: context.messageID, agent: context.agent });
    if (!record(claim) || claim.claimed !== true) throw new Error('This owner-approved native resume was already claimed; reconcile before another explicit resume');
    return { action: 'resume', runId: identity.runId, input: run.resolution };
  };
  return { persistence, getRun, authorize };
}
