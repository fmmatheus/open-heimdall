import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { CoordinatorStore } from './store.js';
import { CoordinatorScheduler } from './scheduler.js';
import { createManagedExecutor, credentialSourceFor } from './executor.js';
import type { CredentialSource } from './executor.js';
import { inspectProject, planManagedWorktree, resolveBaseCommit } from './worktrees.js';
import { CoordinatorError } from './errors.js';
import { checkRuntimeConflicts, snapshotSpecification } from './runtime.js';
import { canonicalPlannedDirectory, positiveInteger } from './config.js';
import { COORDINATOR_SERVICE_ID, COORDINATOR_STATUS_SCHEMA_VERSION, parseCoordinatorStatus } from './status.js';
import { privateFile, readCoordinatorToken } from './token.js';
import { acquireCoordinatorOwnership } from './ownership.js';
import type { CoordinatorOwnership } from './ownership.js';
import type { CredentialContext } from './credentials.js';
import {
  buildCoordinatorLifecycle, COORDINATOR_LIFECYCLE_PROTOCOL, CoordinatorShutdownError, createCoordinatorInstance,
  privateLifecycleDirectory, sanitizeShutdownError, writeInstanceRecord, writeShutdownRecord,
} from './lifecycle.js';
import type { CoordinatorInstance, CoordinatorPhase, CoordinatorShutdownSummary, LifecycleOptions, ShutdownAcknowledgement, ShutdownRecord, ShutdownStage, ShutdownStatus } from './lifecycle.js';
import type { CoordinatorConfiguration } from './config.js';
import type { ApprovalDecision, ApprovalRecord, ApprovalRevision, ApprovalWait, ManagedExecutor, Receipt, RunRecord, StartBinding } from './types.js';
import { isSubmissionKind } from '../workflow/submission-store.js';
import type { NativeOutcome, RunState, SubmissionReceipt } from '../workflow/types.js';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be nonempty text`);
  return value;
};
const equal = (a: string, b: string) => Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const id = (value: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) throw new Error('Invalid coordinator record ID');
  return value;
};
/** `wait` is the bounded approval projection; the owner token, binding and specification never leave the coordinator. */
function publicRun(run: RunRecord, wait: ApprovalWait | null) {
  const { ownerToken: _ownerToken, specification, binding: _binding, ...visible } = run;
  return { ...visible, settings: specification.settings, wait };
}

const FEEDBACK_LIMIT = 8000;
/** The owner's answer to an approval request: a closed set of fields, with feedback required to request changes and refused to approve. */
function parseDecision(input: Record<string, unknown>): { decision: ApprovalDecision; feedback?: string } {
  for (const key of Object.keys(input)) if (key !== 'decision' && key !== 'feedback') throw new Error(`Unknown decision field: ${key}`);
  const { decision, feedback } = input;
  if (decision !== 'approve' && decision !== 'request-changes') throw new Error('decision must be "approve" or "request-changes"');
  if (decision === 'approve') {
    if (feedback !== undefined) throw new Error('Approving takes no feedback; request changes to send feedback');
    return { decision };
  }
  if (typeof feedback !== 'string' || !feedback.trim()) throw new Error('Requesting changes requires nonempty feedback');
  if (feedback.length > FEEDBACK_LIMIT || Buffer.byteLength(feedback) > 4 * FEEDBACK_LIMIT) throw new Error(`Feedback exceeds ${FEEDBACK_LIMIT} characters`);
  return { decision, feedback };
}

/** Full inspection of one approval request for resolving a lost response; the request text is bounded by its contract. */
function publicApproval(approval: ApprovalRecord) {
  const { receiptDigest: _receiptDigest, ...visible } = approval;
  return visible;
}

async function privateDirectory(directory: string): Promise<string> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Coordinator state must be a private directory');
  if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) throw new Error('Coordinator state directory must belong to this user and have mode 0700');
  return fs.realpath(directory);
}

export { readCoordinatorToken };

async function body(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 2 * 1024 * 1024) throw new Error('Coordinator request is too large');
    chunks.push(chunk as Buffer);
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Invalid JSON request'); }
  if (!record(value)) throw new Error('Request body must be a JSON object');
  return value;
}

export interface ServiceOptions {
  configuration: CoordinatorConfiguration;
  executor?: ManagedExecutor;
  scheduler?: Omit<ConstructorParameters<typeof CoordinatorScheduler>[0], 'store' | 'executor' | 'endpoint'>;
  pollIntervalMs?: number;
  /** Explicitly selected credential file for Basic authentication. */
  credentials?: CredentialContext;
  /**
   * Where Basic authentication may read its password. Defaults to the selected file, otherwise to no source for a
   * managed service and to the process environment for a foreground coordinator.
   */
  credentialSource?: CredentialSource;
  /** How this process was launched; defaults to a foreground coordinator. */
  lifecycle?: LifecycleOptions;
  /** Failure injection for tests. A hook that throws makes the named shutdown stage fail before it runs. */
  testHooks?: ServiceTestHooks;
}

export interface ServiceTestHooks {
  shutdownStage?(stage: ShutdownStage | 'publish-failure'): void | Promise<void>;
}

type ShutdownState = 'running' | 'draining' | 'drain-failed' | 'drained' | 'closing' | 'closed' | 'close-failed';
interface DrainAttempt {
  /** Settles after the shutdown request evidence was recorded or failed to record. Never rejects. */
  acknowledged: Promise<unknown>;
  /** Resolves when no reservation remains. Rejects with a retryable error after recording drain-failed. */
  done: Promise<void>;
}

export async function startCoordinatorService(options: ServiceOptions) {
  const instance = createCoordinatorInstance({ stateDirectory: '', endpoint: options.configuration.endpoint, lifecycle: options.lifecycle });
  // Resolve every spelling of the state directory to one canonical owner before any state is touched.
  const root = await privateDirectory(await canonicalPlannedDirectory(options.configuration.stateDirectory));
  const ownership = await acquireCoordinatorOwnership(root);
  try { return await startOwnedService(options, root, ownership, { ...instance, stateDirectory: root }); }
  catch (error) { ownership.release(); throw error; }
}

/**
 * Creates the access key with its content already in place. Other processes (lifecycle commands, the OpenChamber
 * service) read the key without taking the ownership lock, and a file created and then written in two steps can be
 * read while it is still empty. An existing entry is left alone. Runs under the state directory ownership, so no
 * second service creates the key concurrently.
 */
async function createCoordinatorKey(key: string): Promise<void> {
  try { await fs.lstat(key); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const pending = `${key}.pending`;
  await fs.rm(pending, { force: true });
  try {
    await fs.writeFile(pending, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
    await fs.rename(pending, key);
  } finally { await fs.rm(pending, { force: true }); }
}

async function startOwnedService(options: ServiceOptions, root: string, ownership: CoordinatorOwnership, instance: CoordinatorInstance) {
  const { configuration } = options;
  if (process.platform !== 'win32') {
    try { await fs.lstat(configuration.endpoint); throw new Error('Coordinator endpoint already exists; inspect its owner rather than replacing it'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  await privateLifecycleDirectory(root);
  await createCoordinatorKey(path.join(root, 'coordinator.key'));
  const accessToken = await readCoordinatorToken(root);
  const databasePath = path.join(root, 'coordinator.sqlite');
  // Create the database privately before SQLite opens it. Never follow a supplied symlink.
  try { await fs.writeFile(databasePath, '', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await privateFile(databasePath);
  const store = new CoordinatorStore({ databasePath, globalConcurrency: configuration.globalConcurrency });
  const executor = options.executor ?? createManagedExecutor({ getRun: runId => store.getRun(runId)!, credentialSource: options.credentialSource ?? credentialSourceFor({ credentials: options.credentials, managed: options.lifecycle?.mode === 'managed' }) });
  const scheduler = new CoordinatorScheduler({ ...options.scheduler, store, executor, endpoint: configuration.endpoint });
  const visible = (run: RunRecord) => publicRun(run, store.approvalWait(run));
  /** Measures the run's managed worktree with read-only git; fails without a result when it is not the reserved checkout. */
  const reviewRevision = (current: RunRecord): Promise<ApprovalRevision> => scheduler.reviewRevision(current);
  let ready = false;
  let draining = false;
  let state: ShutdownState = 'running';
  let shutdownRequestedAt: number | null = null;
  let drainError: string | null = null;
  let attempts = 0;
  const completedStages: ShutdownStage[] = [];
  const phases: Record<ShutdownState, CoordinatorPhase> = { running: 'running', draining: 'draining', 'drain-failed': 'drain-failed', drained: 'draining', closing: 'closing', closed: 'closing', 'close-failed': 'closing' };
  const lifecycle = () => {
    const shutdown: CoordinatorShutdownSummary | null = shutdownRequestedAt === null ? null : { requestedAt: shutdownRequestedAt, error: state === 'drain-failed' ? drainError : null };
    return buildCoordinatorLifecycle(instance, { phase: phases[state], shutdown });
  };
  const server = http.createServer((request, response) => {
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(value));
    };
    void (async () => {
      if (!ready) { send(503, { error: 'Coordinator is starting or stopping' }); return; }
      const token = request.headers.authorization?.replace(/^Bearer /, '') ?? '';
      const administrator = !!token && equal(token, accessToken);
      const url = new URL(request.url ?? '/', 'http://localhost');
      const segments = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      const method = request.method ?? 'GET';
      const runId = segments[0] === 'runs' && segments[1] ? id(segments[1]) : undefined;
      const run = runId ? store.getRun(runId) : null;
      const owner = !!run?.ownerToken && !!token && equal(token, run.ownerToken);
      const shutdownRoute = segments.length === 2 && segments[0] === 'lifecycle' && segments[1] === 'shutdown';
      if (!administrator && !owner) {
        // A run capability is recognized only to answer the shutdown route precisely; other routes keep their 401.
        if (shutdownRoute && token && store.listRuns().some(candidate => !!candidate.ownerToken && equal(token, candidate.ownerToken))) {
          send(403, { error: 'Run capability cannot administer the coordinator', code: 'forbidden' }); return;
        }
        send(401, { error: 'Coordinator authorization required' }); return;
      }
      if (runId && !run) { send(404, { error: 'Run not found' }); return; }
      if (owner && run && !administrator) {
        if (method === 'GET' && segments.length === 2) { send(200, run); return; }
        if (segments[2] === 'checkpoint' && segments.length === 3) {
          if (method === 'GET') { send(200, run.checkpoint); return; }
          if (method === 'PUT') { store.saveCheckpoint(run.id, token, await body(request) as unknown as RunState); send(200, { saved: true }); return; }
        }
        if (method === 'POST' && segments[2] === 'binding' && segments.length === 3) { send(200, store.bindStart(run.id, token, await body(request) as unknown as StartBinding)); return; }
        if (method === 'POST' && segments[2] === 'resume-binding' && segments.length === 3) { send(200, { claimed: store.bindResume(run.id, token, await body(request) as unknown as StartBinding) }); return; }
        if (segments[2] === 'receipts' && segments.length === 4) {
          const attemptId = id(segments[3]!);
          if (method === 'GET') { send(200, store.readReceipt(run.id, token, attemptId) ?? null); return; }
          if (method === 'PUT') {
            const receipt = await body(request) as unknown as Receipt;
            if (receipt.id !== attemptId) throw new Error('Receipt identity does not match its route');
            store.writeReceipt(run.id, token, receipt); send(200, { saved: true }); return;
          }
        }
        if (segments[2] === 'submissions' && segments.length === 5) {
          const attemptId = id(segments[3]!);
          const kind = segments[4]!;
          if (!isSubmissionKind(kind)) throw new Error('Unknown submission kind');
          if (method === 'GET') { send(200, store.readSubmission(run.id, token, attemptId, kind) ?? null); return; }
          if (method === 'PUT') {
            const receipt = await body(request) as unknown as SubmissionReceipt;
            if (receipt.attemptId !== attemptId || receipt.kind !== kind) throw new Error('Submission identity does not match its route');
            // Only a new approval request needs the worktree measured; a duplicate returns the stored receipt untouched.
            const revision = kind === 'executor-result' && receipt.outcome === 'approval-required' && !store.readSubmission(run.id, token, attemptId, kind)
              ? await reviewRevision(store.getRun(run.id)!) : undefined;
            send(200, store.writeSubmission(run.id, token, receipt, revision)); return;
          }
        }
        if (segments[2] === 'outcomes' && segments.length === 4) {
          const attemptId = id(segments[3]!);
          if (method === 'GET') { send(200, store.readNativeOutcome(run.id, token, attemptId) ?? null); return; }
          if (method === 'PUT') {
            const outcome = await body(request) as unknown as NativeOutcome;
            if (outcome.attemptId !== attemptId) throw new Error('Native outcome identity does not match its route');
            send(200, store.writeNativeOutcome(run.id, token, outcome)); return;
          }
        }
        send(403, { error: 'Run capability cannot administer the coordinator' }); return;
      }
      if (shutdownRoute) {
        // Handled before the draining guard so repeated requests observe the same operation.
        if (method !== 'POST') { send(405, { error: 'Shutdown requires POST', code: 'method-not-allowed' }); return; }
        const input = await body(request);
        if (input.protocol !== COORDINATOR_LIFECYCLE_PROTOCOL) { send(400, { error: 'Unsupported coordinator lifecycle protocol', code: 'unsupported-protocol' }); return; }
        if (typeof input.instanceId !== 'string' || !input.instanceId) { send(400, { error: 'instanceId must be nonempty text', code: 'invalid-request' }); return; }
        if (input.instanceId !== instance.instanceId) { send(409, { error: 'Shutdown request names a different coordinator instance', code: 'instance-mismatch' }); return; }
        const operation = beginShutdown();
        await operation.drain.acknowledged;
        const acknowledgement: ShutdownAcknowledgement = { lifecycleProtocol: COORDINATOR_LIFECYCLE_PROTOCOL, accepted: true, retried: operation.retried, previousError: operation.previousError, lifecycle: lifecycle() };
        send(202, acknowledgement); return;
      }
      if (draining && method !== 'GET') { send(503, { error: 'Coordinator is draining; new work is disabled' }); return; }
      if (method === 'GET' && segments.length === 1 && segments[0] === 'run-list') {
        const integer = (name: string): number | undefined => {
          const values = url.searchParams.getAll(name);
          if (values.length === 0) return undefined;
          if (values.length !== 1 || !/^(0|[1-9][0-9]*)$/.test(values[0]!)) throw new Error('Invalid run list query');
          const value = Number(values[0]);
          if (!Number.isSafeInteger(value)) throw new Error('Invalid run list query');
          return value;
        };
        send(200, store.listRunPage(integer('after'), integer('through'), integer('limit'))); return;
      }
      if (segments.length === 1 && segments[0] === 'projects') {
        if (method === 'GET') { send(200, store.listProjects()); return; }
        if (method === 'POST') {
          const input = await body(request);
          const identity = await inspectProject(text(input.directory, 'directory'));
          const configPath = path.resolve(identity.directory, input.configPath === undefined ? '.heimdall.toml' : text(input.configPath, 'configPath'));
          const concurrency = positiveInteger(input.concurrency ?? configuration.projectConcurrency, 'project concurrency');
          // Validate without installing plugins, changing files or contacting OpenCode.
          await snapshotSpecification({ ...identity, configPath, concurrency, id: 'validation', createdAt: 0 });
          send(201, store.registerProject({ ...identity, configPath, concurrency })); return;
        }
      }
      if (segments.length === 1 && segments[0] === 'runs') {
        if (method === 'GET') { send(200, store.listRuns().map(visible)); return; }
        if (method === 'POST') {
          const input = await body(request);
          const project = store.getProject(id(text(input.projectId, 'projectId')));
          if (!project) throw new Error('Project not found');
          const feature = text(input.feature, 'feature');
          if (Buffer.byteLength(feature) > 128 * 1024) throw new Error('Feature specification exceeds 128 KiB');
          const baseCommit = await resolveBaseCommit(project.directory, input.baseRef === undefined ? 'HEAD' : text(input.baseRef, 'baseRef'));
          const specification = await snapshotSpecification(project);
          await checkRuntimeConflicts(project, baseCommit, specification);
          const newId = randomUUID();
          const worktree = planManagedWorktree({ root, projectId: project.id, runId: newId });
          send(201, visible(store.enqueue({ id: newId, projectId: project.id, feature, baseCommit, worktreePath: worktree.worktreePath, branch: worktree.branch, specification }))); return;
        }
      }
      if (method === 'GET' && segments.length === 2 && run) { send(200, visible(run)); return; }
      if (method === 'POST' && segments.length === 3 && run) {
        if (segments[2] === 'reconcile') { send(200, visible(await scheduler.reconcile(run.id))); return; }
        if (segments[2] === 'resume') { send(200, visible(await scheduler.resume(run.id, text((await body(request)).input, 'input')))); return; }
      }
      if (segments.length >= 4 && segments[2] === 'approvals' && run) {
        // Administrator only: a run capability is answered 403 above and can neither read nor change an approval row.
        const requestId = id(segments[3]!);
        if (method === 'GET' && segments.length === 4) {
          const approval = store.getApproval(run.id, requestId);
          if (!approval) throw new CoordinatorError(404, 'approval-not-found', 'Approval request not found for this run');
          send(200, { ...publicApproval(approval), progress: store.approvalProgress(approval, run) }); return;
        }
        if (method === 'POST' && segments.length === 5 && segments[4] === 'decision') {
          const input = parseDecision(await body(request));
          const approval = store.getApproval(run.id, requestId);
          if (!approval) throw new CoordinatorError(404, 'approval-not-found', 'Approval request not found for this run');
          // The reviewed material is measured here, outside the transaction; the store compares it to the request's own revision.
          const revision = approval.state === 'pending' ? await reviewRevision(store.getRun(run.id)!) : undefined;
          // A paused, released run proven idle right now is resumed by the same transaction that records the decision; any other
          // run keeps the decision recorded and the scheduler queues it once the proof is complete. Nothing is released or started here.
          const proven = approval.state === 'pending' ? await scheduler.proveContinuable(run.id) : undefined;
          send(200, store.decideApproval(run.id, requestId, input, revision, proven?.version)); return;
        }
      }
      if (method === 'GET' && segments.length === 1 && segments[0] === 'events') {
        const after = Number(url.searchParams.get('after') ?? 0);
        if (!Number.isSafeInteger(after) || after < 0) throw new Error('Event cursor must be a nonnegative integer');
        send(200, store.events(after)); return;
      }
      if (method === 'GET' && segments.length === 1 && segments[0] === 'lifecycle') { send(200, lifecycle()); return; }
      if (method === 'GET' && segments.length === 1 && segments[0] === 'status') {
        send(200, parseCoordinatorStatus({
          schemaVersion: COORDINATOR_STATUS_SCHEMA_VERSION, service: COORDINATOR_SERVICE_ID,
          status: draining ? 'draining' : 'running', acceptingNewRuns: !draining, ...store.statusCounts(),
        })); return;
      }
      send(404, { error: 'Unknown coordinator route' });
    })().catch((error: unknown) => {
      if (response.headersSent) { response.destroy(); return; }
      if (error instanceof CoordinatorError) send(error.status, { error: error.message, code: error.code });
      else send(400, { error: error instanceof Error ? error.message : 'Coordinator request failed' });
    });
  });
  server.requestTimeout = 30000;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(configuration.endpoint, () => { server.off('error', reject); resolve(); }); });
    if (process.platform !== 'win32') await fs.chmod(configuration.endpoint, 0o600);
    await writeInstanceRecord(root, instance);
    scheduler.markInterrupted();
    ready = true;
  } catch (error) {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close(); throw error;
  }
  const pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 1000, 'pollIntervalMs');
  const timer = setInterval(() => { void scheduler.tick().catch(() => {}); }, pollIntervalMs);

  const hook = async (stage: ShutdownStage | 'publish-failure') => { await options.testHooks?.shutdownStage?.(stage); };
  const describe = (error: unknown) => {
    const secrets = [accessToken, ...(options.credentials?.values() ?? [])];
    try { for (const candidate of store.listRuns()) if (candidate.ownerToken) secrets.push(candidate.ownerToken); } catch { /* The store may be the failing part. */ }
    return sanitizeShutdownError(error, secrets);
  };
  const persist = (status: ShutdownStatus, extra: { stage?: ShutdownStage; error?: string; completedAt?: number } = {}): Promise<string> => {
    const record: ShutdownRecord = {
      lifecycleProtocol: COORDINATOR_LIFECYCLE_PROTOCOL, service: COORDINATOR_SERVICE_ID, instanceId: instance.instanceId, status, attempts,
      requestedAt: shutdownRequestedAt!, updatedAt: Date.now(), completedAt: extra.completedAt ?? null, stage: extra.stage ?? null, error: extra.error ?? null, completedStages: [...completedStages],
    };
    return writeShutdownRecord(root, record);
  };

  /** Keep admission disabled and reservations held until every reserved run has native idle proof. */
  const drainReservations = async () => {
    while (store.listRuns().some(run => run.capacityReserved)) {
      await hook('drain');
      await scheduler.tick();
      for (const run of store.listRuns()) if (run.capacityReserved && run.status === 'reconciliation-required') await scheduler.reconcile(run.id).catch(() => {});
      if (store.listRuns().some(run => run.capacityReserved)) await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
  };

  /** Record a drain failure. Admission, reservations and owner persistence are left exactly as they were. */
  const failDrain = async (stage: 'request' | 'drain', error: unknown): Promise<CoordinatorShutdownError> => {
    const message = `${stage === 'request' ? 'Shutdown request could not be recorded' : 'Drain failed'}: ${describe(error)}`;
    if (state !== 'draining') return new CoordinatorShutdownError(stage, message, false);
    state = 'drain-failed';
    drainError = message;
    await persist('drain-failed', { stage, error: message }).catch(() => {});
    return new CoordinatorShutdownError(stage, message, true);
  };

  let drainAttempt: DrainAttempt | null = null;
  const startDrain = (): DrainAttempt => {
    // Admission is disabled before anything is acknowledged, recorded or awaited.
    draining = true;
    scheduler.pauseAdmission();
    shutdownRequestedAt ??= Date.now();
    drainError = null;
    state = 'draining';
    attempts += 1;
    const acknowledged = (async (): Promise<CoordinatorShutdownError | null> => {
      try { await hook('request'); await persist('requested'); return null; }
      catch (error) { return failDrain('request', error); }
    })();
    const done = (async () => {
      const requestFailure = await acknowledged;
      if (requestFailure) throw requestFailure;
      try { await drainReservations(); }
      catch (error) { throw await failDrain('drain', error); }
      if (state === 'draining') state = 'drained';
    })();
    done.catch(() => {});
    return { acknowledged, done };
  };

  /** Start a drain, join the one in progress, or retry one that failed. Never re-enables admission. */
  const ensureDrain = (): { drain: DrainAttempt; retried: boolean; previousError: string | null } => {
    if (state === 'drain-failed') { const previousError = drainError; drainAttempt = startDrain(); return { drain: drainAttempt, retried: true, previousError }; }
    drainAttempt ??= startDrain();
    return { drain: drainAttempt, retried: false, previousError: null };
  };

  let closeOperation: Promise<void> | null = null;
  const settleClosed = (() => {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((accept, decline) => { resolve = accept; reject = decline; });
    promise.catch(() => {});
    return { promise, resolve, reject };
  })();

  /** Close in order; clean completion is published only after every stage succeeded. A close failure is terminal. */
  const ensureClose = (): Promise<void> => {
    closeOperation ??= (async () => {
      const clean = state === 'drained';
      ready = false;
      state = 'closing';
      shutdownRequestedAt ??= Date.now();
      clearInterval(timer);
      const stages: Array<[ShutdownStage, () => void | Promise<void>]> = [
        ['scheduler-stop', () => scheduler.stop()],
        ['server-close', () => new Promise<void>((resolve, reject) => { server.close(error => error ? reject(error) : resolve()); server.closeIdleConnections(); })],
        ['store-close', () => store.close()],
        ['ownership-release', () => ownership.release()],
      ];
      let stage: ShutdownStage = 'scheduler-stop';
      try {
        for (const [name, run] of stages) { stage = name; await hook(name); await run(); completedStages.push(name); }
      } catch (error) {
        state = 'close-failed';
        const message = `Close failed at ${stage}: ${describe(error)}`;
        if (attempts > 0) await persist('close-failed', { stage, error: message }).catch(() => {});
        throw new CoordinatorShutdownError(stage, message, false);
      }
      if (clean) {
        stage = 'publish-completion';
        try { await hook('publish-completion'); await persist('completed', { completedAt: Date.now() }); }
        catch (error) {
          state = 'close-failed';
          const message = `Completion evidence could not be published: ${describe(error)}`;
          await (async () => { await hook('publish-failure'); await persist('completion-unknown', { stage, error: message }); })().catch(() => {});
          throw new CoordinatorShutdownError(stage, message, false);
        }
      }
      state = 'closed';
    })();
    closeOperation.then(settleClosed.resolve, settleClosed.reject);
    return closeOperation;
  };

  /** One drain-then-close operation per instance, shared by IPC requests, signals and direct callers. */
  let shutdownOperation: { drain: DrainAttempt; completion: Promise<void> } | null = null;
  const beginShutdown = () => {
    const { drain, retried, previousError } = ensureDrain();
    if (!shutdownOperation || shutdownOperation.drain !== drain) {
      const completion = (async () => { await drain.done; await ensureClose(); })();
      completion.catch(() => {});
      shutdownOperation = { drain, completion };
    }
    return { drain, completion: shutdownOperation.completion, retried, previousError };
  };

  return {
    store, scheduler, endpoint: configuration.endpoint, instance, lifecycle,
    /** Settles when the service is fully closed: resolves after clean completion, rejects after a failed close stage. */
    closed: settleClosed.promise,
    /**
     * Drain and close once. Resolves only after clean completion evidence is published; rejects with a
     * CoordinatorShutdownError otherwise. A rejected drain leaves the coordinator open, so a later call retries it.
     */
    shutdown(): Promise<void> { return beginShutdown().completion; },
    async drain(): Promise<void> { await ensureDrain().drain.done; },
    close(): Promise<void> { return ensureClose(); },
  };
}
