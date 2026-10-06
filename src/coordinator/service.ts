import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { CoordinatorStore } from './store.js';
import { CoordinatorScheduler } from './scheduler.js';
import { createManagedExecutor } from './executor.js';
import { inspectProject, planManagedWorktree, resolveBaseCommit } from './worktrees.js';
import { checkRuntimeConflicts, snapshotSpecification } from './runtime.js';
import { positiveInteger } from './config.js';
import type { CoordinatorConfiguration } from './config.js';
import type { ManagedExecutor, Receipt, RunRecord, StartBinding } from './types.js';
import type { RunState } from '../workflow/types.js';

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
function publicRun(run: RunRecord) {
  const { ownerToken: _ownerToken, specification, binding: _binding, ...visible } = run;
  return { ...visible, settings: specification.settings };
}

async function privateDirectory(directory: string): Promise<string> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Coordinator state must be a private directory');
  if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) throw new Error('Coordinator state directory must belong to this user and have mode 0700');
  return fs.realpath(directory);
}

async function privateFile(file: string): Promise<void> {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Coordinator state file must be a regular file');
  if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.())) throw new Error('Coordinator state file must belong to this user and have mode 0600');
}

export async function readCoordinatorToken(stateDirectory: string): Promise<string> {
  await privateFile(path.join(stateDirectory, 'coordinator.key'));
  const token = await fs.readFile(path.join(stateDirectory, 'coordinator.key'), 'utf8');
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid coordinator access key');
  return token;
}

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
}

export async function startCoordinatorService(options: ServiceOptions) {
  const { configuration } = options;
  const root = await privateDirectory(configuration.stateDirectory);
  if (process.platform !== 'win32') {
    try { await fs.lstat(configuration.endpoint); throw new Error('Coordinator endpoint already exists; inspect its owner rather than replacing it'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const key = path.join(root, 'coordinator.key');
  try { await fs.writeFile(key, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const accessToken = await readCoordinatorToken(root);
  const databasePath = path.join(root, 'coordinator.sqlite');
  // Create the database privately before SQLite opens it. Never follow a supplied symlink.
  try { await fs.writeFile(databasePath, '', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  await privateFile(databasePath);
  const store = new CoordinatorStore({ databasePath, globalConcurrency: configuration.globalConcurrency });
  const executor = options.executor ?? createManagedExecutor({ getRun: runId => store.getRun(runId)! });
  const scheduler = new CoordinatorScheduler({ ...options.scheduler, store, executor, endpoint: configuration.endpoint });
  let ready = false;
  let draining = false;
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
      if (!administrator && !owner) { send(401, { error: 'Coordinator authorization required' }); return; }
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
        send(403, { error: 'Run capability cannot administer the coordinator' }); return;
      }
      if (draining && method !== 'GET') { send(503, { error: 'Coordinator is draining; new work is disabled' }); return; }
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
        if (method === 'GET') { send(200, store.listRuns().map(publicRun)); return; }
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
          send(201, publicRun(store.enqueue({ id: newId, projectId: project.id, feature, baseCommit, worktreePath: worktree.worktreePath, branch: worktree.branch, specification }))); return;
        }
      }
      if (method === 'GET' && segments.length === 2 && run) { send(200, publicRun(run)); return; }
      if (method === 'POST' && segments.length === 3 && run) {
        if (segments[2] === 'reconcile') { send(200, publicRun(await scheduler.reconcile(run.id))); return; }
        if (segments[2] === 'resume') { send(200, publicRun(await scheduler.resume(run.id, text((await body(request)).input, 'input')))); return; }
      }
      if (method === 'GET' && segments.length === 1 && segments[0] === 'events') {
        const after = Number(url.searchParams.get('after') ?? 0);
        if (!Number.isSafeInteger(after) || after < 0) throw new Error('Event cursor must be a nonnegative integer');
        send(200, store.events(after)); return;
      }
      send(404, { error: 'Unknown coordinator route' });
    })().catch((error: unknown) => { if (!response.headersSent) send(400, { error: error instanceof Error ? error.message : 'Coordinator request failed' }); else response.destroy(); });
  });
  server.requestTimeout = 30000;
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(configuration.endpoint, () => { server.off('error', reject); resolve(); }); });
    if (process.platform !== 'win32') await fs.chmod(configuration.endpoint, 0o600);
    scheduler.markInterrupted();
    ready = true;
  } catch (error) {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close(); throw error;
  }
  const pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 1000, 'pollIntervalMs');
  const timer = setInterval(() => { void scheduler.tick().catch(() => {}); }, pollIntervalMs);
  return {
    store, scheduler, endpoint: configuration.endpoint,
    async drain(): Promise<void> {
      draining = true;
      scheduler.pauseAdmission();
      while (store.listRuns().some(run => run.capacityReserved)) {
        await scheduler.tick();
        for (const run of store.listRuns()) if (run.capacityReserved && run.status === 'reconciliation-required') await scheduler.reconcile(run.id).catch(() => {});
        if (store.listRuns().some(run => run.capacityReserved)) await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
      }
    },
    async close(): Promise<void> {
      ready = false;
      clearInterval(timer);
      await scheduler.stop();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      store.close();
    },
  };
}
