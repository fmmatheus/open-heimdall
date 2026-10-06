import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import type { RunState } from '../workflow/types.js';
import type { CoordinatorEvent, ProjectRecord, Receipt, RunRecord, RunStatus, StartBinding } from './types.js';

type Row = Record<string, SQLOutputValue>;
type ProjectInput = Omit<ProjectRecord, 'id' | 'createdAt'>;
type EnqueueInput = Pick<RunRecord, 'id' | 'projectId' | 'feature' | 'baseCommit' | 'worktreePath' | 'branch' | 'specification'>;
const schemaVersion = 2;
const transitions: Record<RunStatus, readonly RunStatus[]> = {
  queued: [],
  preparing: ['running', 'reconciliation-required'],
  running: ['paused', 'succeeded', 'failed', 'reconciliation-required'],
  paused: [],
  succeeded: [],
  failed: [],
  'reconciliation-required': ['paused', 'succeeded', 'failed'],
};

function positiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(name + ' must be a positive safe integer');
}
function nonempty(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(name + ' must be a nonempty string');
}
function serialize(value: unknown): string {
  const result = JSON.stringify(value);
  if (result === undefined) throw new Error('Cannot persist an undefined value');
  return result;
}
function nullableJSON<T>(value: SQLOutputValue): T | null {
  return value === null ? null : JSON.parse(String(value)) as T;
}
function sameBinding(left: StartBinding, right: StartBinding): boolean {
  return left.sessionID === right.sessionID && left.id === right.id && left.messageID === right.messageID && left.agent === right.agent;
}

// A planned worktree need not exist yet; resolve its existing ancestors to prevent alias claims.
function canonicalPlannedPath(value: string): string {
  nonempty(value, 'worktreePath');
  const suffix: string[] = [];
  let ancestor = path.resolve(value);
  while (true) {
    try { return path.join(realpathSync(ancestor), ...suffix); }
    catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
    }
  }
}

function projectFromRow(row: Row): ProjectRecord {
  return {
    id: String(row.id), directory: String(row.directory), commonGitDirectory: String(row.common_git_directory),
    configPath: String(row.config_path), concurrency: Number(row.concurrency), createdAt: Number(row.created_at),
  };
}
function runFromRow(row: Row): RunRecord {
  return {
    id: String(row.id), projectId: String(row.project_id), feature: String(row.feature), baseCommit: String(row.base_commit),
    worktreePath: String(row.worktree_path), branch: String(row.branch), specification: JSON.parse(String(row.specification_json)),
    status: row.status as RunStatus, capacityReserved: row.capacity_reserved === 1, ownerToken: row.owner_token === null ? null : String(row.owner_token),
    version: Number(row.version), parentSessionId: String(row.parent_session_id), promptMessageId: String(row.prompt_message_id),
    launchAction: row.launch_action as 'start' | 'resume', resolution: row.resolution === null ? null : String(row.resolution),
    checkpoint: nullableJSON<RunState>(row.checkpoint_json), binding: nullableJSON<StartBinding>(row.binding_json),
    resumeBinding: nullableJSON<StartBinding>(row.resume_binding_json), launchIntent: row.launch_intent === 1,
    reason: row.reason === null ? null : String(row.reason), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

/** Durable admission and ownership. Reservations never expire automatically. */
export class CoordinatorStore {
  private readonly db: DatabaseSync;

  constructor({ databasePath, globalConcurrency }: { databasePath: string; globalConcurrency: number }) {
    nonempty(databasePath, 'databasePath');
    positiveInteger(globalConcurrency, 'globalConcurrency');
    if (databasePath !== ':memory:') mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath, { timeout: 5000, enableForeignKeyConstraints: true });
    try {
      this.initialize(globalConcurrency);
      this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void { if (this.db.isOpen) this.db.close(); }

  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private initialize(globalConcurrency: number): void {
    this.transaction(() => {
      const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
      if (version !== 0 && version !== 1 && version !== schemaVersion) throw new Error('Unsupported coordinator database schema version: ' + version);
      if (version === 0) {
        const existing = this.db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
        if (existing.length) throw new Error('Refusing to initialize a database with an unknown existing schema');
        this.db.exec(`
          CREATE TABLE coordinator_settings (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            global_concurrency INTEGER NOT NULL CHECK (global_concurrency > 0)
          ) STRICT;
          CREATE TABLE projects (
            id TEXT PRIMARY KEY,
            directory TEXT NOT NULL UNIQUE,
            common_git_directory TEXT NOT NULL UNIQUE,
            config_path TEXT NOT NULL,
            concurrency INTEGER NOT NULL CHECK (concurrency > 0),
            created_at INTEGER NOT NULL
          ) STRICT;
          CREATE TABLE runs (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL REFERENCES projects(id),
            feature TEXT NOT NULL,
            base_commit TEXT NOT NULL,
            worktree_path TEXT NOT NULL,
            branch TEXT NOT NULL,
            specification_json TEXT NOT NULL CHECK (json_valid(specification_json)),
            status TEXT NOT NULL CHECK (status IN ('queued','preparing','running','paused','succeeded','failed','reconciliation-required')),
            capacity_reserved INTEGER NOT NULL CHECK (capacity_reserved IN (0,1)),
            owner_token TEXT,
            version INTEGER NOT NULL CHECK (version >= 0),
            parent_session_id TEXT NOT NULL UNIQUE,
            prompt_message_id TEXT NOT NULL UNIQUE,
            launch_action TEXT NOT NULL CHECK (launch_action IN ('start','resume')),
            resolution TEXT,
            checkpoint_json TEXT CHECK (checkpoint_json IS NULL OR json_valid(checkpoint_json)),
            binding_json TEXT CHECK (binding_json IS NULL OR json_valid(binding_json)),
            resume_binding_json TEXT CHECK (resume_binding_json IS NULL OR json_valid(resume_binding_json)),
            launch_intent INTEGER NOT NULL DEFAULT 0 CHECK (launch_intent IN (0,1)),
            reason TEXT,
            queue_sequence INTEGER NOT NULL UNIQUE,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            CHECK (capacity_reserved = 0 OR owner_token IS NOT NULL),
            CHECK (status != 'queued' OR capacity_reserved = 0),
            UNIQUE (id, project_id)
          ) STRICT;
          CREATE INDEX runs_admission ON runs(status, queue_sequence);
          CREATE INDEX runs_capacity ON runs(project_id, capacity_reserved);
          CREATE TABLE worktrees (
            run_id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            path TEXT NOT NULL UNIQUE,
            branch TEXT NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('planned','preparing','retained')),
            created_at INTEGER NOT NULL,
            FOREIGN KEY (run_id, project_id) REFERENCES runs(id, project_id),
            UNIQUE (project_id, branch)
          ) STRICT;
          CREATE TABLE receipts (
            run_id TEXT NOT NULL REFERENCES runs(id),
            attempt_id TEXT NOT NULL,
            receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
            created_at INTEGER NOT NULL,
            PRIMARY KEY (run_id, attempt_id)
          ) STRICT;
          CREATE TABLE events (
            sequence INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT REFERENCES runs(id),
            project_id TEXT REFERENCES projects(id),
            type TEXT NOT NULL,
            at INTEGER NOT NULL,
            payload_json TEXT NOT NULL CHECK (json_valid(payload_json))
          ) STRICT;
          PRAGMA user_version = 2;
        `);
        this.db.prepare('INSERT INTO coordinator_settings(singleton, global_concurrency) VALUES (1, ?)').run(globalConcurrency);
      }
      if (version === 1) {
        this.db.exec(`
          ALTER TABLE runs ADD COLUMN resume_binding_json TEXT CHECK (resume_binding_json IS NULL OR json_valid(resume_binding_json));
          ALTER TABLE runs ADD COLUMN launch_intent INTEGER NOT NULL DEFAULT 0 CHECK (launch_intent IN (0,1));
          UPDATE runs SET launch_intent = 1
            WHERE capacity_reserved = 1 OR binding_json IS NOT NULL OR checkpoint_json IS NOT NULL;
          UPDATE runs SET resume_binding_json = json_extract(checkpoint_json, '$.caller')
            WHERE launch_action = 'resume' AND capacity_reserved = 1 AND json_type(checkpoint_json, '$.caller') = 'object';
          PRAGMA user_version = 2;
        `);
      }
      const configured = Number(this.db.prepare('SELECT global_concurrency FROM coordinator_settings WHERE singleton = 1').get()!.global_concurrency);
      if (configured !== globalConcurrency) throw new Error('Global concurrency differs from the persisted coordinator setting');
    });
  }

  private event(type: string, run: Pick<RunRecord, 'id' | 'projectId'> | null, projectId: string | null, payload: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO events(run_id, project_id, type, at, payload_json) VALUES (?, ?, ?, ?, ?)')
      .run(run?.id ?? null, run?.projectId ?? projectId, type, Date.now(), serialize(payload));
  }
  private requireRun(id: string): RunRecord {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    if (!row) throw new Error('Unknown run: ' + id);
    return runFromRow(row);
  }
  private requireOwner(id: string, ownerToken: string, requireCapacity = true): RunRecord {
    const run = this.requireRun(id);
    if (!ownerToken || run.ownerToken !== ownerToken) throw new Error('Stale or invalid run owner');
    if (requireCapacity && !run.capacityReserved) throw new Error('Run has no active capacity reservation');
    return run;
  }
  private nextQueueSequence(): number {
    return Number(this.db.prepare('SELECT coalesce(max(queue_sequence), 0) + 1 AS sequence FROM runs').get()!.sequence);
  }

  registerProject(input: ProjectInput): ProjectRecord {
    positiveInteger(input.concurrency, 'Project concurrency');
    const canonical = {
      directory: realpathSync(input.directory), commonGitDirectory: realpathSync(input.commonGitDirectory),
      configPath: realpathSync(input.configPath), concurrency: input.concurrency,
    };
    return this.transaction(() => {
      const existing = this.db.prepare('SELECT * FROM projects WHERE common_git_directory = ?').get(canonical.commonGitDirectory);
      if (existing) {
        const project = projectFromRow(existing);
        if (project.directory !== canonical.directory || project.configPath !== canonical.configPath || project.concurrency !== canonical.concurrency) throw new Error('Project already registered with different paths, configuration, or concurrency');
        return project;
      }
      const id = randomUUID();
      const now = Date.now();
      this.db.prepare('INSERT INTO projects(id, directory, common_git_directory, config_path, concurrency, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, canonical.directory, canonical.commonGitDirectory, canonical.configPath, canonical.concurrency, now);
      this.event('project.registered', null, id, { directory: canonical.directory, concurrency: canonical.concurrency });
      return { id, ...canonical, createdAt: now };
    });
  }

  listProjects(): ProjectRecord[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY created_at, rowid').all().map(projectFromRow);
  }
  getProject(id: string): ProjectRecord | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    return row ? projectFromRow(row) : null;
  }

  enqueue(input: EnqueueInput): RunRecord {
    for (const name of ['id', 'projectId', 'feature', 'baseCommit', 'branch'] as const) nonempty(input[name], name);
    const worktreePath = canonicalPlannedPath(input.worktreePath);
    const specification = serialize(input.specification);
    return this.transaction(() => {
      if (!this.getProject(input.projectId)) throw new Error('Unknown project: ' + input.projectId);
      const now = Date.now();
      this.db.prepare(`INSERT INTO runs(
        id, project_id, feature, base_commit, worktree_path, branch, specification_json,
        status, capacity_reserved, owner_token, version, parent_session_id, prompt_message_id,
        launch_action, resolution, checkpoint_json, binding_json, reason, queue_sequence, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, NULL, 0, ?, ?, 'start', NULL, NULL, NULL, NULL, ?, ?, ?)`).run(
        input.id, input.projectId, input.feature, input.baseCommit, worktreePath, input.branch, specification,
        'ses_' + randomUUID(), 'msg_' + randomUUID(), this.nextQueueSequence(), now, now,
      );
      this.db.prepare("INSERT INTO worktrees(run_id, project_id, path, branch, state, created_at) VALUES (?, ?, ?, ?, 'planned', ?)")
        .run(input.id, input.projectId, worktreePath, input.branch, now);
      const run = this.requireRun(input.id);
      this.event('run.queued', run, null, { featureLength: run.feature.length, baseCommit: run.baseCommit, worktreePath, branch: run.branch });
      return run;
    });
  }

  listRuns(): RunRecord[] { return this.db.prepare('SELECT * FROM runs ORDER BY created_at, rowid').all().map(runFromRow); }
  getRun(id: string): RunRecord | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return row ? runFromRow(row) : null;
  }
  events(after = 0): CoordinatorEvent[] {
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('Event cursor must be a nonnegative safe integer');
    return this.db.prepare('SELECT * FROM events WHERE sequence > ? ORDER BY sequence LIMIT 500').all(after).map(row => ({
      sequence: Number(row.sequence), runId: row.run_id === null ? null : String(row.run_id),
      projectId: row.project_id === null ? null : String(row.project_id), type: String(row.type), at: Number(row.at),
      payload: JSON.parse(String(row.payload_json)),
    }));
  }

  admitNext(): RunRecord | null {
    return this.transaction(() => {
      const limit = Number(this.db.prepare('SELECT global_concurrency FROM coordinator_settings WHERE singleton = 1').get()!.global_concurrency);
      const reserved = Number(this.db.prepare('SELECT count(*) AS count FROM runs WHERE capacity_reserved = 1').get()!.count);
      if (reserved >= limit) return null;
      const row = this.db.prepare(`SELECT r.* FROM runs r JOIN projects p ON p.id = r.project_id
        WHERE r.status = 'queued' AND r.capacity_reserved = 0
          AND (SELECT count(*) FROM runs active WHERE active.project_id = r.project_id AND active.capacity_reserved = 1) < p.concurrency
        ORDER BY r.queue_sequence LIMIT 1`).get();
      if (!row) return null;
      const run = runFromRow(row);
      const status = run.launchAction === 'resume' ? 'running' : 'preparing';
      this.db.prepare('UPDATE runs SET status = ?, capacity_reserved = 1, owner_token = ?, resume_binding_json = NULL, launch_intent = 0, version = version + 1, updated_at = ? WHERE id = ?')
        .run(status, randomUUID(), Date.now(), run.id);
      this.db.prepare("UPDATE worktrees SET state = 'preparing' WHERE run_id = ?").run(run.id);
      const admitted = this.requireRun(run.id);
      this.event('run.admitted', admitted, null, { status, version: admitted.version, launchAction: admitted.launchAction });
      return admitted;
    });
  }

  transition(id: string, ownerToken: string, expectedVersion: number, status: RunStatus, reason?: string, releaseCapacity = false): RunRecord {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('Expected version must be a nonnegative safe integer');
    return this.transaction(() => {
      const run = this.requireOwner(id, ownerToken, false);
      if (run.version !== expectedVersion) throw new Error('Stale run version');
      if (!transitions[run.status].includes(status)) throw new Error('Invalid run transition: ' + run.status + ' -> ' + status);
      if (releaseCapacity && !['paused', 'succeeded', 'failed'].includes(status)) throw new Error('Uncertain or active runs must retain capacity');
      return this.applyTransition(run, status, reason, releaseCapacity);
    });
  }

  private applyTransition(run: RunRecord, status: RunStatus, reason: string | undefined, releaseCapacity: boolean): RunRecord {
    this.db.prepare('UPDATE runs SET status = ?, reason = ?, capacity_reserved = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .run(status, reason ?? null, releaseCapacity ? 0 : Number(run.capacityReserved), Date.now(), run.id);
    if (releaseCapacity) this.db.prepare("UPDATE worktrees SET state = 'retained' WHERE run_id = ?").run(run.id);
    const updated = this.requireRun(run.id);
    this.event('run.transitioned', updated, null, { from: run.status, status, capacityReserved: updated.capacityReserved, version: updated.version });
    return updated;
  }

  /** Release agent capacity only when the current admission never began a native operation. */
  failBeforeLaunch(id: string, ownerToken: string, expectedVersion: number, reason?: string): RunRecord {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('Expected version must be a nonnegative safe integer');
    return this.transaction(() => {
      const run = this.requireOwner(id, ownerToken);
      if (run.version !== expectedVersion) throw new Error('Stale run version');
      if (run.status !== 'reconciliation-required') throw new Error('Failed preparation requires explicit reconciliation');
      if (run.launchIntent) throw new Error('Native launch intent exists; complete idle proof is required');
      return this.applyTransition(run, 'failed', reason, true);
    });
  }

  markLaunchIntent(id: string, ownerToken: string): void {
    this.transaction(() => {
      const run = this.requireOwner(id, ownerToken);
      if (run.launchIntent) return;
      this.db.prepare('UPDATE runs SET launch_intent = 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
      this.event('run.launch_intent', run, null, { launchAction: run.launchAction });
    });
  }

  bindStart(id: string, ownerToken: string, binding: StartBinding): RunRecord {
    for (const field of ['sessionID', 'id', 'messageID', 'agent'] as const) nonempty(binding[field], 'binding.' + field);
    const identity: StartBinding = { sessionID: binding.sessionID, id: binding.id, messageID: binding.messageID, agent: binding.agent };
    return this.transaction(() => {
      const run = this.requireOwner(id, ownerToken);
      if (run.binding) {
        if (!sameBinding(run.binding, identity)) throw new Error('Run already bound to a different native start identity');
        return run;
      }
      if (identity.sessionID !== run.parentSessionId || identity.agent !== 'adr-orchestrator') throw new Error('Native start binding must match the persisted parent and adr-orchestrator agent');
      this.db.prepare('UPDATE runs SET binding_json = ?, launch_intent = 1, updated_at = ? WHERE id = ?').run(serialize(identity), Date.now(), id);
      this.event('run.bound', run, null, { sessionID: identity.sessionID, messageID: identity.messageID, agent: identity.agent });
      return this.requireRun(id);
    });
  }

  bindResume(id: string, ownerToken: string, binding: StartBinding): boolean {
    for (const field of ['sessionID', 'id', 'messageID', 'agent'] as const) nonempty(binding[field], 'binding.' + field);
    const identity: StartBinding = { sessionID: binding.sessionID, id: binding.id, messageID: binding.messageID, agent: binding.agent };
    return this.transaction(() => {
      const run = this.requireOwner(id, ownerToken);
      if (run.launchAction !== 'resume') throw new Error('Admission is not an explicit resume');
      if (identity.sessionID !== run.parentSessionId || identity.agent !== 'adr-orchestrator') throw new Error('Native resume binding must match the persisted parent and adr-orchestrator agent');
      if (run.resumeBinding) {
        if (!sameBinding(run.resumeBinding, identity)) throw new Error('Resume admission already claimed by a different native tool call');
        return false;
      }
      if (!run.binding || run.checkpoint?.status !== 'paused') throw new Error('Resume claim requires a bound paused checkpoint');
      this.db.prepare('UPDATE runs SET resume_binding_json = ?, launch_intent = 1, updated_at = ? WHERE id = ?').run(serialize(identity), Date.now(), id);
      this.event('run.resume_bound', run, null, { sessionID: identity.sessionID, messageID: identity.messageID, agent: identity.agent });
      return true;
    });
  }

  saveCheckpoint(id: string, ownerToken: string, state: RunState): void {
    const encoded = serialize(state);
    this.transaction(() => {
      const run = this.requireOwner(id, ownerToken);
      if (!run.binding || state.id !== run.id || state.parent !== run.parentSessionId || state.caller.sessionID !== run.parentSessionId) throw new Error('Checkpoint is not bound to this run and native parent');
      if (run.launchAction === 'start' && !sameBinding(run.binding, state.caller as StartBinding)) throw new Error('Checkpoint caller does not match the immutable start binding');
      if (run.launchAction === 'resume' && (!run.resumeBinding || !sameBinding(run.resumeBinding, state.caller as StartBinding))) throw new Error('Checkpoint caller does not match the claimed resume admission');
      this.db.prepare('UPDATE runs SET checkpoint_json = ?, updated_at = ? WHERE id = ?').run(encoded, Date.now(), id);
      this.event('checkpoint.saved', run, null, {
        status: state.status, phase: state.phase, index: state.index, child: state.child,
        usage: {
          reported: Object.values(state.usage ?? {}).reduce((total, used) => total + used, 0),
          uncached: Object.values(state.uncachedUsage ?? {}).reduce((total, used) => total + used, 0),
        },
      });
    });
  }

  readReceipt(id: string, ownerToken: string, attemptId: string): Receipt | undefined {
    return this.transaction(() => {
      this.requireOwner(id, ownerToken);
      const row = this.db.prepare('SELECT receipt_json FROM receipts WHERE run_id = ? AND attempt_id = ?').get(id, attemptId);
      return row ? JSON.parse(String(row.receipt_json)) as Receipt : undefined;
    });
  }

  writeReceipt(id: string, ownerToken: string, receipt: Receipt): void {
    nonempty(receipt.id, 'Receipt attempt ID');
    const encoded = serialize(receipt);
    this.transaction(() => {
      const run = this.requireOwner(id, ownerToken);
      if (!run.binding) throw new Error('Receipt requires a bound native start');
      const existing = this.db.prepare('SELECT receipt_json FROM receipts WHERE run_id = ? AND attempt_id = ?').get(id, receipt.id);
      if (existing) {
        if (!isDeepStrictEqual(JSON.parse(String(existing.receipt_json)), JSON.parse(encoded))) throw new Error('Saved receipt is immutable');
        return;
      }
      const attempt = run.checkpoint?.attempt;
      if (!attempt || attempt.id !== receipt.id || attempt.phase !== receipt.phase || attempt.index !== receipt.index || attempt.child !== receipt.child || run.checkpoint?.child !== receipt.child) throw new Error('Receipt does not match the checkpoint attempt');
      this.db.prepare('INSERT INTO receipts(run_id, attempt_id, receipt_json, created_at) VALUES (?, ?, ?, ?)').run(id, receipt.id, encoded, Date.now());
      this.event('receipt.saved', run, null, { attemptId: receipt.id, phase: receipt.phase, index: receipt.index, child: receipt.child });
    });
  }

  queueResume(id: string, input: string): RunRecord {
    nonempty(input, 'Resume resolution');
    return this.transaction(() => {
      const run = this.requireRun(id);
      if (run.status !== 'paused' || run.capacityReserved || !run.checkpoint || !run.binding) throw new Error('Resume requires a released paused run with a bound checkpoint');
      this.db.prepare("UPDATE runs SET status = 'queued', owner_token = NULL, prompt_message_id = ?, launch_action = 'resume', resolution = ?, resume_binding_json = NULL, launch_intent = 0, reason = NULL, queue_sequence = ?, version = version + 1, updated_at = ? WHERE id = ?")
        .run('msg_' + randomUUID(), input, this.nextQueueSequence(), Date.now(), id);
      const queued = this.requireRun(id);
      this.event('run.resume_queued', queued, null, { version: queued.version, messageID: queued.promptMessageId });
      return queued;
    });
  }
}
