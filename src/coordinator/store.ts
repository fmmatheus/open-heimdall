import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { SQLOutputValue } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { checkpointReportInfo } from '../workflow/report-info.js';
import { assertRepairMonotonic } from '../workflow/repair-state.js';
import { contractDigest, validateSubmission } from '../workflow/contracts.js';
import type { SubmissionKind } from '../workflow/contracts.js';
import {
  assertOutcomeMatchesCheckpoint, assertSubmissionMatchesCheckpoint, isNativeOutcome, isSubmissionKind, isSubmissionReceipt, sameOutcome, sameSubmission,
} from '../workflow/submission-store.js';
import type { NativeOutcome, RunState, SubmissionReceipt } from '../workflow/types.js';
import { parseApprovalContext, renderApprovalContext, supersedeApprovalContext } from '../workflow/approval-context.js';
import { CoordinatorError } from './errors.js';
import type {
  ApprovalAck, ApprovalContinuation, ApprovalDecision, ApprovalProgress, ApprovalRecord, ApprovalRequestContent, ApprovalRevision, ApprovalState, ApprovalWait,
  CoordinatorEvent, PauseResponseAck, ProjectRecord, Receipt, RunRecord, RunStatus, RunWaitSummary, StartBinding,
} from './types.js';
import { clipText, currentPauseId, genericWaitOf, isPausedCheckpoint, labelledGuidance, pauseIdFor, PAUSE_REASON_IDENTITY_BYTES, PAUSE_REASON_LIMIT } from './pause.js';
import type { GenericWait } from './pause.js';
import { RUN_LIST_FEATURE_HEAD, RUN_LIST_MAX_BYTES, RUN_LIST_PAGE_SIZE } from './run-list.js';
import type { RunListEntry, RunListPage } from './run-list.js';

type Row = Record<string, SQLOutputValue>;
type ProjectInput = Omit<ProjectRecord, 'id' | 'createdAt'>;
type EnqueueInput = Pick<RunRecord, 'id' | 'projectId' | 'feature' | 'baseCommit' | 'worktreePath' | 'branch' | 'specification'>;
const schemaVersion = 4;
const NATIVE_OUTCOME = 'native-outcome';
const submissionsTable = (ifNotExists: string) => `
  CREATE TABLE ${ifNotExists}submissions (
    run_id TEXT NOT NULL REFERENCES runs(id),
    attempt_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('planner-plan','executor-result','native-outcome')),
    submission_json TEXT NOT NULL CHECK (json_valid(submission_json)),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, attempt_id, kind)
  ) STRICT;`;
/**
 * Version 4 (additive, one migration): durable approval requests with the owner's response, and recorded responses to
 * generic pauses. Both tables are created together so a later feature needs no further schema change. Existing rows are
 * never read or rewritten.
 */
const approvalTables = (ifNotExists: string) => `
  CREATE TABLE ${ifNotExists}approval_requests (
    run_id TEXT NOT NULL REFERENCES runs(id),
    request_id TEXT NOT NULL,
    phase TEXT NOT NULL CHECK (phase IN ('planner','executor')),
    task_index INTEGER NOT NULL CHECK (task_index >= 0),
    task_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    receipt_digest TEXT NOT NULL,
    request_json TEXT NOT NULL CHECK (json_valid(request_json)),
    revision_json TEXT NOT NULL CHECK (json_valid(revision_json)),
    state TEXT NOT NULL CHECK (state IN ('pending','answered','superseded')),
    decision TEXT CHECK (decision IS NULL OR decision IN ('approve','request-changes')),
    feedback TEXT,
    response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
    answered_at INTEGER,
    continuation TEXT NOT NULL CHECK (continuation IN ('none','pending','queued','consumed','superseded')),
    continuation_at INTEGER,
    continuation_message_id TEXT,
    consumed_attempt_id TEXT,
    superseded_at INTEGER,
    superseded_reason TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, request_id),
    UNIQUE (request_id),
    UNIQUE (run_id, attempt_id),
    CHECK ((state = 'answered') = (decision IS NOT NULL)),
    CHECK ((state = 'answered') = (response_json IS NOT NULL)),
    CHECK (decision IS NULL OR decision != 'request-changes' OR (feedback IS NOT NULL AND length(trim(feedback)) > 0)),
    CHECK (decision IS NULL OR decision != 'approve' OR feedback IS NULL)
  ) STRICT;
  CREATE INDEX ${ifNotExists}approval_requests_open ON approval_requests(run_id, state, continuation);
  CREATE TABLE ${ifNotExists}run_responses (
    run_id TEXT NOT NULL REFERENCES runs(id),
    pause_id TEXT NOT NULL,
    input TEXT NOT NULL,
    ack_json TEXT NOT NULL CHECK (json_valid(ack_json)),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (run_id, pause_id)
  ) STRICT;`;
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
const WAIT_TEXT_LIMIT = 1500;
const WAIT_ENTRY_LIMIT = 400;
const WAIT_LIST_LIMIT = 10;
const WAIT_TITLE_LIMIT = 200;
/** Clips to at most `limit` UTF-16 units without splitting a surrogate pair. */
function clip(value: string, limit: number): { text: string; clipped: boolean } {
  if (value.length <= limit) return { text: value, clipped: false };
  let end = limit;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: value.slice(0, end), clipped: true };
}
/** Where a run stands, as far as deciding whether its latest request is still what it waits for. */
interface WaitPlace {
  status: RunStatus;
  /** Paused with released capacity on a paused checkpoint: the run has a pause identity and accepts a guarded response. */
  released: boolean;
  /** The attempt of the checkpoint's approval wait, or null. */
  waitAttempt: string | null;
}
/**
 * Whether a run's latest request is still part of what it is waiting for, or only history.
 *
 * - A decision is history only once an attempt carried it (`consumedAttemptId`). Dispatched but not yet carried, it is still
 *   shown while the run executes, and again when the run came back to its paused wait without having received it.
 * - A superseded request that left the run paused and released is not shown as an approval: the run has a pause identity
 *   then, and the owner answers it with the guarded, labelled response like any other pause.
 * - A withdrawn decision (its answer is kept, its authorization is not) is delivered like any other: until an attempt carried
 *   its superseded context it stays shown, also when the run is back on the paused wait that asked, because the delivery is
 *   still owed and the run does not take guidance in the meantime.
 */
function approvalShown(request: Pick<ApprovalRecord, 'state' | 'continuation' | 'attemptId' | 'consumedAttemptId'>, place: WaitPlace): boolean {
  const finished = place.status === 'succeeded' || place.status === 'failed';
  if (request.state === 'superseded') return place.status === 'paused' && !place.released;
  if (request.state === 'answered' && request.continuation === 'consumed') {
    if (request.consumedAttemptId !== null || finished) return false;
    return place.status !== 'paused' || (place.released && place.waitAttempt === request.attemptId);
  }
  if (request.continuation === 'superseded') {
    if (request.consumedAttemptId !== null || finished) return false;
    return place.status !== 'paused' || !place.released || place.waitAttempt === request.attemptId;
  }
  return true;
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
      let version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
      if (version < 0 || version > schemaVersion) throw new Error('Unsupported coordinator database schema version: ' + version);
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
        `);
        this.db.prepare('INSERT INTO coordinator_settings(singleton, global_concurrency) VALUES (1, ?)').run(globalConcurrency);
        version = 2;
      }
      if (version === 1) {
        this.db.exec(`
          ALTER TABLE runs ADD COLUMN resume_binding_json TEXT CHECK (resume_binding_json IS NULL OR json_valid(resume_binding_json));
          ALTER TABLE runs ADD COLUMN launch_intent INTEGER NOT NULL DEFAULT 0 CHECK (launch_intent IN (0,1));
          UPDATE runs SET launch_intent = 1
            WHERE capacity_reserved = 1 OR binding_json IS NOT NULL OR checkpoint_json IS NOT NULL;
          UPDATE runs SET resume_binding_json = json_extract(checkpoint_json, '$.caller')
            WHERE launch_action = 'resume' AND capacity_reserved = 1 AND json_type(checkpoint_json, '$.caller') = 'object';
        `);
        version = 2;
      }
      if (version === 2) {
        // Additive: the new table never touches existing receipts, checkpoints or run rows.
        this.db.exec(submissionsTable('IF NOT EXISTS ') + ' PRAGMA user_version = 3;');
        version = 3;
      }
      if (version === 3) {
        this.db.exec(approvalTables('IF NOT EXISTS ') + ' PRAGMA user_version = 4;');
        version = 4;
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
  /** Read-only, bounded projection: never deserialize specifications or full checkpoints for a list. */
  listRunPage(after = 0, through?: number, limit = RUN_LIST_PAGE_SIZE): RunListPage {
    for (const cursor of [after, through ?? 0]) {
      if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Error('Run list cursor must be a nonnegative safe integer');
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > RUN_LIST_PAGE_SIZE) throw new Error('Invalid run list page size');
    const fence = through ?? Number(this.db.prepare('SELECT coalesce(max(rowid), 0) AS cursor FROM runs').get()!.cursor);
    const total = Number(this.db.prepare('SELECT count(*) AS count FROM runs WHERE rowid <= ?').get(fence)!.count);
    const paused = `status = 'paused' AND capacity_reserved = 0 AND json_extract(checkpoint_json, '$.status') = 'paused'`;
    const rows = this.db.prepare(`SELECT rowid AS cursor, id, project_id, worktree_path, status, created_at, updated_at, version,
      CASE WHEN ${paused} THEN 1 ELSE 0 END AS generic_candidate,
      CASE WHEN ${paused} THEN substr(CAST(json_extract(checkpoint_json, '$.parent') AS BLOB), 1, 512) END AS pause_parent,
      CASE WHEN ${paused} THEN json_extract(checkpoint_json, '$.phase') END AS pause_phase,
      CASE WHEN ${paused} AND json_type(checkpoint_json, '$.index') = 'integer' THEN json_extract(checkpoint_json, '$.index') END AS pause_index,
      CASE WHEN ${paused} THEN substr(CAST(json_extract(checkpoint_json, '$.attempt.id') AS BLOB), 1, 512) END AS pause_attempt,
      CASE WHEN ${paused} THEN substr(CAST(json_extract(checkpoint_json, '$.reason') AS BLOB), 1, ${PAUSE_REASON_IDENTITY_BYTES}) END AS pause_reason,
      CASE WHEN ${paused} THEN length(CAST(json_extract(checkpoint_json, '$.reason') AS BLOB)) END AS pause_reason_bytes,
      CASE WHEN ${paused} AND json_extract(checkpoint_json, '$.wait.kind') = 'approval' THEN substr(CAST(json_extract(checkpoint_json, '$.wait.attemptId') AS BLOB), 1, 512) END AS pause_wait_attempt,
      substr(CAST(feature AS BLOB), 1, ? * 4) AS feature_head,
      CASE json_extract(checkpoint_json, '$.phase') WHEN 'planner' THEN 'planner' WHEN 'executor' THEN 'executor' END AS phase,
      coalesce(json_array_length(checkpoint_json, '$.tasks'), 0) AS task_count,
      coalesce(json_array_length(checkpoint_json, '$.results'), 0) AS completed_count,
      CASE WHEN json_type(checkpoint_json, '$.index') = 'integer'
        AND json_extract(checkpoint_json, '$.index') >= 0
        AND json_extract(checkpoint_json, '$.index') < json_array_length(checkpoint_json, '$.tasks')
        AND json_type(checkpoint_json, '$.tasks[' || json_extract(checkpoint_json, '$.index') || ']') = 'object'
        THEN json_extract(checkpoint_json, '$.index') END AS task_index,
      CASE WHEN json_type(checkpoint_json, '$.index') = 'integer'
        AND json_extract(checkpoint_json, '$.index') >= 0
        AND json_extract(checkpoint_json, '$.index') < json_array_length(checkpoint_json, '$.tasks')
        AND json_type(checkpoint_json, '$.tasks[' || json_extract(checkpoint_json, '$.index') || '].id') = 'text'
        THEN substr(CAST(json_extract(checkpoint_json, '$.tasks[' || json_extract(checkpoint_json, '$.index') || '].id') AS BLOB), 1, 484) END AS task_id,
      CASE WHEN json_type(checkpoint_json, '$.index') = 'integer'
        AND json_extract(checkpoint_json, '$.index') >= 0
        AND json_extract(checkpoint_json, '$.index') < json_array_length(checkpoint_json, '$.tasks')
        AND json_type(checkpoint_json, '$.tasks[' || json_extract(checkpoint_json, '$.index') || '].title') = 'text'
        THEN substr(CAST(json_extract(checkpoint_json, '$.tasks[' || json_extract(checkpoint_json, '$.index') || '].title') AS BLOB), 1, 804) END AS task_title
      FROM runs WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?`).all(RUN_LIST_FEATURE_HEAD, after, fence, limit);
    const page: RunListPage = { runs: [], total, nextCursor: null, through: fence };
    let cursor = after;
    let bytes = Buffer.byteLength(JSON.stringify(page)) + 32;
    // SQLite's text substr stops at NUL. Bound UTF-8 bytes instead, then apply the display's UTF-16 scan limit.
    const head = (value: SQLOutputValue, length: number): string => Buffer.from(value as Uint8Array).toString('utf8').slice(0, length);
    for (const row of rows) {
      const totalTasks = Number(row.task_count);
      const entry: RunListEntry = {
        id: String(row.id), projectId: String(row.project_id), worktreePath: String(row.worktree_path),
        status: row.status as RunStatus, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
        feature: head(row.feature_head!, RUN_LIST_FEATURE_HEAD),
        progress: {
          phase: typeof row.phase === 'string' ? row.phase : null, total: totalTasks, completed: Number(row.completed_count),
          currentTask: row.phase === 'executor' && row.status !== 'succeeded' && row.task_index !== null
            ? { id: row.task_id === null ? `task-${Number(row.task_index) + 1}` : head(row.task_id!, 121), title: row.task_title === null ? '' : head(row.task_title!, 201) } : null,
        },
        wait: this.listWait(row, head),
      };
      const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (bytes + size > RUN_LIST_MAX_BYTES) {
        if (page.runs.length === 0) throw new Error('Run list entry exceeds the response size limit');
        break;
      }
      page.runs.push(entry);
      bytes += size;
      cursor = Number(row.cursor);
    }
    if (this.db.prepare('SELECT 1 FROM runs WHERE rowid > ? AND rowid <= ? LIMIT 1').get(cursor, fence)) page.nextCursor = cursor;
    return page;
  }
  /** The bounded wait summary of one list row: the current typed request, else a generic pause, else null. */
  private listWait(row: Row, head: (value: SQLOutputValue, length: number) => string): RunWaitSummary | null {
    const status = row.status as RunStatus;
    const request = this.db.prepare('SELECT request_id, state, continuation, task_id, attempt_id, consumed_attempt_id FROM approval_requests WHERE run_id = ? ORDER BY rowid DESC LIMIT 1').get(row.id!);
    const place: WaitPlace = {
      status, released: row.generic_candidate === 1,
      waitAttempt: row.pause_wait_attempt === null || row.pause_wait_attempt === undefined ? null : Buffer.from(row.pause_wait_attempt as Uint8Array).toString('utf8'),
    };
    if (request && approvalShown({
      state: request.state as ApprovalState, continuation: request.continuation as ApprovalContinuation, attemptId: String(request.attempt_id),
      consumedAttemptId: request.consumed_attempt_id === null ? null : String(request.consumed_attempt_id),
    }, place)) {
      return { kind: 'approval', requestId: String(request.request_id), state: request.state as ApprovalState, continuation: request.continuation as ApprovalContinuation, taskId: head(request.task_id!, 121) };
    }
    if (row.generic_candidate !== 1) return null;
    const bytes = (value: SQLOutputValue): Uint8Array | null => value === null ? null : Buffer.from(value as Uint8Array);
    const reasonHead = bytes(row.pause_reason) ?? new Uint8Array();
    const reasonBytes = row.pause_reason_bytes === null ? 0 : Number(row.pause_reason_bytes);
    const pauseId = pauseIdFor({
      runId: String(row.id), version: Number(row.version), parent: bytes(row.pause_parent), phase: typeof row.pause_phase === 'string' ? row.pause_phase : null,
      index: row.pause_index === null ? null : Number(row.pause_index), attemptId: bytes(row.pause_attempt), reasonHead, reasonBytes,
    });
    const shown = clipText(Buffer.from(reasonHead).toString('utf8'), PAUSE_REASON_LIMIT);
    return { kind: 'generic', pauseId, reason: shown.text, reasonClipped: shown.clipped || reasonBytes > reasonHead.length };
  }
  getRun(id: string): RunRecord | null {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return row ? runFromRow(row) : null;
  }
  /** Read-only admission counts: no transaction, no event. */
  statusCounts(): { queuedRuns: number; reservedRuns: number } {
    const value = (sql: string) => Number(this.db.prepare(sql).get()!.count);
    return {
      queuedRuns: value("SELECT count(*) AS count FROM runs WHERE status = 'queued'"),
      reservedRuns: value('SELECT count(*) AS count FROM runs WHERE capacity_reserved = 1'),
    };
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
    const report = checkpointReportInfo(state);
    this.transaction(() => {
      const run = this.requireOwner(id, ownerToken);
      if (!run.binding || state.id !== run.id || state.parent !== run.parentSessionId || state.caller.sessionID !== run.parentSessionId) throw new Error('Checkpoint is not bound to this run and native parent');
      if (run.launchAction === 'start' && !sameBinding(run.binding, state.caller as StartBinding)) throw new Error('Checkpoint caller does not match the immutable start binding');
      if (run.launchAction === 'resume' && (!run.resumeBinding || !sameBinding(run.resumeBinding, state.caller as StartBinding))) throw new Error('Checkpoint caller does not match the claimed resume admission');
      // The protocol is selected once, when the run starts; a later checkpoint can neither switch nor drop it.
      if (run.checkpoint && run.checkpoint.protocol !== state.protocol) throw new Error('Run protocol is immutable once selected');
      // The loaded runtime is recorded once, at start, for new runs only; an existing run is never given or stripped of one.
      if (run.checkpoint && !isDeepStrictEqual(run.checkpoint.runtime, state.runtime)) throw new Error('Run runtime identity is immutable once recorded');
      // A late writer holding an older view can never erase a seal, conflict, outcome or refusal, nor lower the repair counter.
      assertRepairMonotonic(run.checkpoint, state);
      this.assertOwnerFieldsUnforged(run, state);
      this.db.prepare('UPDATE runs SET checkpoint_json = ?, updated_at = ? WHERE id = ?').run(encoded, Date.now(), id);
      // The first fresh attempt that carries a delivered decision is recorded as the attempt that consumed it. The decision was
      // validated above against the coordinator's own records, so the request named here is never one the checkpoint made up.
      if (state.approval && state.attempt && state.status === 'running') {
        this.db.prepare(`UPDATE approval_requests SET consumed_attempt_id = ?
          WHERE run_id = ? AND request_id = ? AND consumed_attempt_id IS NULL AND continuation IN ('consumed','superseded') AND attempt_id != ?`)
          .run(state.attempt.id, id, state.approval.requestId, state.attempt.id);
      }
      this.event('checkpoint.saved', run, null, {
        status: state.status, phase: state.phase, index: state.index, child: state.child,
        usage: {
          reported: Object.values(state.usage ?? {}).reduce((total, used) => total + used, 0),
          uncached: Object.values(state.uncachedUsage ?? {}).reduce((total, used) => total + used, 0),
        },
        ...(report ? { report } : {}),
      });
    });
  }

  /**
   * A checkpoint is written by the run's own process, which an agent can influence, so the two fields that stand for the owner
   * are never taken from it on trust. `approval` may only be unchanged, absent, or exactly the decision context the coordinator
   * delivered for this admission (its stored resolution, backed by an answered request whose continuation passed the dispatch
   * boundary). `wait` may only be unchanged, absent, or the pause on a request this coordinator published for that very attempt.
   */
  private assertOwnerFieldsUnforged(run: RunRecord, state: RunState): void {
    const previous = run.checkpoint;
    if (state.approval !== undefined && !isDeepStrictEqual(state.approval, previous?.approval)) {
      const delivered = run.launchAction === 'resume' ? parseApprovalContext(run.resolution ?? undefined) : undefined;
      const stored = delivered ? this.getApproval(run.id, delivered.requestId) : null;
      const genuine = !!delivered && !!stored && isDeepStrictEqual(state.approval, delivered)
        && stored.state === 'answered' && stored.decision === delivered.decision && ['consumed', 'superseded'].includes(stored.continuation)
        && stored.continuationMessageId === run.promptMessageId && delivered.index === state.index && state.tasks[state.index]?.id === delivered.taskId
        // It is first recorded by the resume that leaves the wait this request asked for. Once the runner has dropped it (a fresh
        // request was filed) or moved on, the same text, which stays the run's stored resolution, cannot be written back.
        && previous?.wait?.kind === 'approval' && previous.wait.attemptId === stored.attemptId;
      if (!genuine) throw new Error('Checkpoint carries an approval decision that the coordinator did not deliver for this admission');
    }
    if (state.wait !== undefined && !isDeepStrictEqual(state.wait, previous?.wait)) {
      const wait = state.wait;
      const published = wait.kind === 'approval' && state.status === 'paused' && state.phase === 'executor' && state.attempt?.id === wait.attemptId
        && state.index === wait.index && state.tasks[wait.index]?.id === wait.taskId
        && !!this.db.prepare('SELECT 1 FROM approval_requests WHERE run_id = ? AND attempt_id = ? AND task_index = ? AND task_id = ?').get(run.id, wait.attemptId, wait.index, wait.taskId);
      if (!published) throw new Error('Checkpoint approval wait does not match an approval request published for this attempt');
    }
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

  readSubmission(id: string, ownerToken: string, attemptId: string, kind: SubmissionKind): SubmissionReceipt | undefined {
    nonempty(attemptId, 'attemptId');
    if (!isSubmissionKind(kind)) throw new Error('Unknown submission kind');
    return this.transaction(() => {
      this.requireOwner(id, ownerToken);
      return this.storedSubmission<SubmissionReceipt>(id, attemptId, kind);
    });
  }

  /**
   * Immutable and idempotent. The owner must hold the capacity fence, the native start must be bound, and the receipt
   * must describe the checkpoint's current open binding exactly. An identical duplicate returns the stored receipt;
   * anything else for the same (run, attempt, kind) is rejected and the stored row is never touched.
   *
   * An `approval-required` executor result also publishes its approval request in the same transaction, bound to the
   * identity the checkpoint matched and to `revision`, which the caller computed from the managed worktree. A duplicate
   * returns the stored receipt and never publishes a second request.
   */
  writeSubmission(id: string, ownerToken: string, receipt: SubmissionReceipt, revision?: ApprovalRevision): SubmissionReceipt {
    if (!isSubmissionReceipt(receipt) || receipt.runId !== id) throw new Error('Submission identity mismatch');
    const encoded = serialize(receipt);
    return this.transaction(() => {
      const run = this.requireOwner(id, ownerToken);
      if (!run.binding) throw new Error('Submission requires a bound native start');
      const stored = this.storedSubmission<SubmissionReceipt>(id, receipt.attemptId, receipt.kind);
      if (stored) {
        if (!sameSubmission(stored, receipt)) throw new Error('Saved submission is immutable');
        return stored;
      }
      assertSubmissionMatchesCheckpoint(run.checkpoint, receipt);
      this.db.prepare('INSERT INTO submissions(run_id, attempt_id, kind, submission_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, receipt.attemptId, receipt.kind, encoded, Date.now());
      this.event('submission.saved', run, null, { attemptId: receipt.attemptId, kind: receipt.kind, phase: receipt.phase, index: receipt.index, dispatch: receipt.dispatch, digest: receipt.digest });
      if (receipt.kind === 'executor-result') this.publishApproval(run, receipt, revision);
      return JSON.parse(encoded) as SubmissionReceipt;
    });
  }

  readNativeOutcome(id: string, ownerToken: string, attemptId: string): NativeOutcome | undefined {
    nonempty(attemptId, 'attemptId');
    return this.transaction(() => {
      this.requireOwner(id, ownerToken);
      return this.storedSubmission<NativeOutcome>(id, attemptId, NATIVE_OUTCOME);
    });
  }

  writeNativeOutcome(id: string, ownerToken: string, outcome: NativeOutcome): NativeOutcome {
    if (!isNativeOutcome(outcome) || outcome.runId !== id) throw new Error('Native outcome identity mismatch');
    const encoded = serialize(outcome);
    return this.transaction(() => {
      const run = this.requireOwner(id, ownerToken);
      if (!run.binding) throw new Error('Native outcome requires a bound native start');
      const stored = this.storedSubmission<NativeOutcome>(id, outcome.attemptId, NATIVE_OUTCOME);
      if (stored) {
        if (!sameOutcome(stored, outcome)) throw new Error('Saved native outcome is immutable');
        return stored;
      }
      assertOutcomeMatchesCheckpoint(run.checkpoint, outcome);
      this.db.prepare('INSERT INTO submissions(run_id, attempt_id, kind, submission_json, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, outcome.attemptId, NATIVE_OUTCOME, encoded, Date.now());
      return JSON.parse(encoded) as NativeOutcome;
    });
  }

  private storedSubmission<T>(id: string, attemptId: string, kind: string): T | undefined {
    const row = this.db.prepare('SELECT submission_json FROM submissions WHERE run_id = ? AND attempt_id = ? AND kind = ?').get(id, attemptId, kind);
    return row ? JSON.parse(String(row.submission_json)) as T : undefined;
  }

  /**
   * Refuses when the run has an unresolved approval request, or an owner decision whose continuation has not been consumed.
   * The generic resume operation is not a way to answer such a request or to replace its scoped decision context.
   */
  assertNoUnresolvedApproval(id: string): void {
    const open = this.db.prepare(`SELECT request_id, state FROM approval_requests
      WHERE run_id = ? AND (state = 'pending' OR (state = 'answered' AND continuation IN ('pending','queued'))) ORDER BY rowid LIMIT 1`).get(id);
    const owed = open ? undefined : this.undeliveredDecision(id);
    if (!open && !owed) return;
    throw new CoordinatorError(409, 'approval-pending', open?.state === 'pending'
      ? 'An approval request is waiting for an owner decision; answer it with the approval decision operation instead of resuming'
      : owed?.continuation === 'superseded'
        ? 'An owner decision was withdrawn and its superseded context has not reached the agent; it is delivered automatically and cannot be replaced by a generic resume or response'
        : 'An owner decision is recorded and its continuation has not been consumed; it continues automatically and cannot be replaced by a generic resume');
  }

  /**
   * An answered request that passed the dispatch boundary but whose decision no attempt carried, while the run sits again on the
   * paused wait that asked: the dispatch was lost (a crash or failed launch), so the decision is still owed to the agent. A
   * decision withdrawn at the boundary is owed the same way, as superseded context that authorizes nothing.
   */
  private undeliveredDecision(runId: string): ApprovalRecord | undefined {
    const run = this.getRun(runId);
    if (!run) return undefined;
    return this.db.prepare("SELECT * FROM approval_requests WHERE run_id = ? AND state = 'answered' AND continuation IN ('consumed','superseded') AND consumed_attempt_id IS NULL ORDER BY rowid")
      .all(runId).map(row => this.approvalFromRow(row)).find(request => this.continuable(run, request));
  }

  queueResume(id: string, input: string): RunRecord {
    nonempty(input, 'Resume resolution');
    // Only an answered approval request produces an approval continuation; free text cannot impersonate one.
    if (parseApprovalContext(input)) throw new Error('A resume resolution cannot be an approval continuation');
    return this.transaction(() => {
      this.assertNoUnresolvedApproval(id);
      const run = this.requireRun(id);
      if (run.status !== 'paused' || run.capacityReserved || !run.checkpoint || !run.binding) throw new Error('Resume requires a released paused run with a bound checkpoint');
      // A run that used typed approvals never receives unscoped text that could be read as one: it arrives labelled as guidance.
      const typed = !!this.db.prepare('SELECT 1 FROM approval_requests WHERE run_id = ? LIMIT 1').get(id);
      return this.queueResolution(id, typed ? labelledGuidance(currentPauseId(run) ?? 'unidentified', input) : input);
    });
  }

  /** Queues the existing resume admission of a released paused run. The caller holds the transaction and has validated the run. */
  private queueResolution(id: string, resolution: string): RunRecord {
    this.db.prepare("UPDATE runs SET status = 'queued', owner_token = NULL, prompt_message_id = ?, launch_action = 'resume', resolution = ?, resume_binding_json = NULL, launch_intent = 0, reason = NULL, queue_sequence = ?, version = version + 1, updated_at = ? WHERE id = ?")
      .run('msg_' + randomUUID(), resolution, this.nextQueueSequence(), Date.now(), id);
    const queued = this.requireRun(id);
    this.event('run.resume_queued', queued, null, { version: queued.version, messageID: queued.promptMessageId });
    return queued;
  }

  // --- Guarded responses to generic pauses --------------------------------------------------------------------------------

  /** The stored acknowledgement of a guarded response to this pause, with the input it was recorded with. */
  getPauseResponse(runId: string, pauseId: string): { input: string; ack: PauseResponseAck } | null {
    const row = this.db.prepare('SELECT input, ack_json FROM run_responses WHERE run_id = ? AND pause_id = ?').get(runId, pauseId);
    return row ? { input: String(row.input), ack: JSON.parse(String(row.ack_json)) as PauseResponseAck } : null;
  }

  /**
   * Records owner guidance for one generic pause and queues the existing resume with it, in one transaction. The operation's
   * identity is the run and the pause: an identical retry returns the stored acknowledgement (also after the run advanced),
   * a different input for the same pause conflicts, and a pause that is no longer the run's current one is stale. The caller
   * proved worktree, runtime and native idle at `expectedVersion`; any other version, an unresolved typed request or a run
   * that is not paused and released refuses without changing anything.
   */
  recordPauseResponse(runId: string, pauseId: string, input: string, expectedVersion: number): PauseResponseAck {
    nonempty(input, 'Response input');
    if (parseApprovalContext(input)) throw new Error('A response cannot be an approval continuation');
    return this.transaction(() => {
      const stored = this.getPauseResponse(runId, pauseId);
      if (stored) {
        if (stored.input === input) return { ...stored.ack, retried: true };
        throw new CoordinatorError(409, 'response-conflict', 'This pause was already answered with a different response');
      }
      this.assertNoUnresolvedApproval(runId);
      const run = this.requireRun(runId);
      if (run.status !== 'paused' || run.capacityReserved || !run.checkpoint || !run.binding) throw new CoordinatorError(409, 'pause-not-ready', 'Only a released paused run on a bound checkpoint accepts a response');
      if (currentPauseId(run) !== pauseId) throw new CoordinatorError(409, 'pause-stale', 'This pause is no longer the run\'s current pause');
      if (run.version !== expectedVersion) throw new CoordinatorError(409, 'pause-stale', 'The run changed while its idle state was being verified');
      const queued = this.queueResolution(runId, labelledGuidance(pauseId, input));
      const ack: PauseResponseAck = { runId, pauseId, recordedAt: Date.now(), retried: false, continuation: 'queued', run: { status: queued.status, version: queued.version } };
      this.db.prepare('INSERT INTO run_responses(run_id, pause_id, input, ack_json, created_at) VALUES (?, ?, ?, ?, ?)').run(runId, pauseId, input, serialize(ack), ack.recordedAt);
      this.event('run.response_recorded', queued, null, { pauseId, inputLength: input.length, version: queued.version, messageID: queued.promptMessageId });
      return ack;
    });
  }

  // --- Approval requests and owner decisions ----------------------------------------------------------------------------

  private approvalFromRow(row: Row): ApprovalRecord {
    return {
      runId: String(row.run_id), requestId: String(row.request_id), phase: row.phase as 'planner' | 'executor', taskIndex: Number(row.task_index),
      taskId: String(row.task_id), attemptId: String(row.attempt_id), receiptDigest: String(row.receipt_digest),
      request: JSON.parse(String(row.request_json)) as ApprovalRequestContent, revision: JSON.parse(String(row.revision_json)) as ApprovalRevision,
      state: row.state as ApprovalState, decision: row.decision === null ? null : row.decision as ApprovalDecision,
      feedback: row.feedback === null ? null : String(row.feedback), ack: nullableJSON<ApprovalAck>(row.response_json),
      answeredAt: row.answered_at === null ? null : Number(row.answered_at), continuation: row.continuation as ApprovalContinuation,
      continuationAt: row.continuation_at === null ? null : Number(row.continuation_at),
      continuationMessageId: row.continuation_message_id === null ? null : String(row.continuation_message_id),
      consumedAttemptId: row.consumed_attempt_id === null ? null : String(row.consumed_attempt_id),
      supersededAt: row.superseded_at === null ? null : Number(row.superseded_at),
      supersededReason: row.superseded_reason === null ? null : String(row.superseded_reason), createdAt: Number(row.created_at),
    };
  }

  getApproval(runId: string, requestId: string): ApprovalRecord | null {
    const row = this.db.prepare('SELECT * FROM approval_requests WHERE run_id = ? AND request_id = ?').get(runId, requestId);
    return row ? this.approvalFromRow(row) : null;
  }

  /** The newest request of a run, whatever its state. */
  latestApproval(runId: string): ApprovalRecord | null {
    const row = this.db.prepare('SELECT * FROM approval_requests WHERE run_id = ? ORDER BY rowid DESC LIMIT 1').get(runId);
    return row ? this.approvalFromRow(row) : null;
  }

  /**
   * Publishes the approval request carried by an accepted executor submission. Called inside the submission transaction, so
   * a request exists if and only if its receipt does. Identity comes from the receipt the checkpoint just matched; the
   * content is re-validated with the executor-result contract, never taken from the receipt on trust.
   */
  private publishApproval(run: RunRecord, receipt: SubmissionReceipt, revision: ApprovalRevision | undefined): void {
    const canonical = receipt.canonical;
    const isApproval = typeof canonical === 'object' && canonical !== null && !Array.isArray(canonical) && (canonical as Record<string, unknown>).status === 'approval-required';
    if (isApproval !== (receipt.outcome === 'approval-required')) throw new Error('Submission outcome does not match its approval payload');
    if (!isApproval) return;
    if (receipt.phase !== 'executor' || receipt.taskId === undefined) throw new Error('An approval request belongs to an executor task');
    if (!revision || !/^[a-f0-9]{40,64}$/.test(revision.head) || !/^[a-f0-9]{64}$/.test(revision.digest)) throw new Error('An approval request requires a review revision computed by the coordinator');
    const { taskId, ...payload } = canonical as Record<string, unknown>;
    if (taskId !== receipt.taskId || receipt.digest !== contractDigest(receipt.contract, canonical)) throw new Error('Approval request does not match its submission');
    const result = validateSubmission({ kind: 'executor-result', dodCount: run.checkpoint?.tasks[receipt.index]?.dod.length ?? 0 }, payload);
    if (!result.ok || result.outcome !== 'approval-required') throw new Error('Approval request does not satisfy the executor-result contract');
    const value = result.value as unknown as ApprovalRequestContent;
    const content: ApprovalRequestContent = {
      question: value.question, scope: value.scope, completedWork: value.completedWork, verification: [...value.verification],
      artifacts: [...value.artifacts], onApprove: [...value.onApprove], onRequestChanges: [...value.onRequestChanges],
    };
    const now = Date.now();
    const requestId = 'apr_' + randomUUID();
    const replaced = this.db.prepare("UPDATE approval_requests SET state = 'superseded', superseded_at = ?, superseded_reason = ? WHERE run_id = ? AND state = 'pending'")
      .run(now, 'A newer approval request was published', run.id);
    this.db.prepare(`INSERT INTO approval_requests(
      run_id, request_id, phase, task_index, task_id, attempt_id, receipt_digest, request_json, revision_json, state, continuation, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'none', ?)`).run(
      run.id, requestId, receipt.phase, receipt.index, receipt.taskId, receipt.attemptId, receipt.digest, serialize(content),
      serialize({ head: revision.head, digest: revision.digest }), now,
    );
    this.event('approval.requested', run, null, {
      requestId, attemptId: receipt.attemptId, phase: receipt.phase, index: receipt.index, taskId: receipt.taskId,
      revision: { head: revision.head, digest: revision.digest }, supersededRequests: Number(replaced.changes),
    });
  }

  /** Why a pending request can no longer be answered, or undefined while it is the run's current paused-or-pending request. */
  private staleApproval(run: RunRecord, request: ApprovalRecord): string | undefined {
    if (run.status === 'succeeded' || run.status === 'failed') return 'The run has finished';
    const state = run.checkpoint;
    if (!state || state.phase !== request.phase || state.index !== request.taskIndex || state.tasks[request.taskIndex]?.id !== request.taskId) return 'The run is no longer on the task that asked for approval';
    if (state.attempt?.id !== request.attemptId) return 'The task was dispatched again after this request';
    if (state.status === 'paused' && (state.wait?.kind !== 'approval' || state.wait.attemptId !== request.attemptId)) return 'The run is not waiting for this approval request';
    return undefined;
  }

  private supersedeApproval(run: RunRecord, request: ApprovalRecord, reason: string): void {
    this.db.prepare("UPDATE approval_requests SET state = 'superseded', superseded_at = ?, superseded_reason = ? WHERE run_id = ? AND request_id = ? AND state = 'pending'")
      .run(Date.now(), reason, run.id, request.requestId);
    this.event('approval.superseded', run, null, { requestId: request.requestId, attemptId: request.attemptId, reason });
  }

  /**
   * Records the owner's decision on one request, once. `revision` is the worktree's current review revision, computed by the
   * caller before this transaction; it is required only while the request is pending.
   *
   * - A pending request whose checkpoint or reviewed material moved on is marked superseded and the call fails with
   *   `approval-stale`; nothing is recorded.
   * - An identical decision (and verbatim feedback) for an answered request returns the stored acknowledgement with
   *   `retried: true`, whatever the run has done since.
   * - Any other decision for an answered, superseded or foreign request fails; no stored value changes.
   * - Recording stores the decision and the `pending` continuation together with the event in one transaction.
   */
  decideApproval(runId: string, requestId: string, input: { decision: ApprovalDecision; feedback?: string }, revision?: ApprovalRevision, queueAtVersion?: number): ApprovalAck {
    if (input.decision !== 'approve' && input.decision !== 'request-changes') throw new Error('Decision must be approve or request-changes');
    const feedback = input.feedback ?? null;
    const outcome = this.transaction((): { ack: ApprovalAck } | { stale: string } => {
      const request = this.getApproval(runId, requestId);
      if (!request) throw new CoordinatorError(404, 'approval-not-found', 'Approval request not found for this run');
      if (request.state === 'answered') {
        if (request.decision === input.decision && request.feedback === feedback) return { ack: { ...request.ack!, retried: true } };
        throw new CoordinatorError(409, 'approval-conflict', 'This approval request was already answered with a different decision');
      }
      if (request.state === 'superseded') return { stale: request.supersededReason ?? 'The approval request was superseded' };
      const run = this.requireRun(runId);
      const moved = this.staleApproval(run, request);
      if (moved) { this.supersedeApproval(run, request, moved); return { stale: moved }; }
      if (!revision) throw new Error('A review revision is required to answer a pending approval request');
      if (revision.head !== request.revision.head || revision.digest !== request.revision.digest) {
        const reason = 'The reviewed worktree changed after the request was published';
        this.supersedeApproval(run, request, reason);
        return { stale: reason };
      }
      const now = Date.now();
      // Recording and queueing are one transaction only when the caller proved the run idle at exactly this version.
      const queue = queueAtVersion === run.version && this.continuable(run, request);
      const ack: ApprovalAck = {
        runId, requestId, decision: input.decision, recordedAt: now, retried: false, continuation: queue ? 'queued' : 'pending',
        run: queue ? { status: 'queued', version: run.version + 1 } : { status: run.status, version: run.version },
      };
      this.db.prepare(`UPDATE approval_requests SET state = 'answered', decision = ?, feedback = ?, response_json = ?, answered_at = ?,
        continuation = 'pending', continuation_at = ? WHERE run_id = ? AND request_id = ? AND state = 'pending'`)
        .run(input.decision, feedback, serialize(ack), now, now, runId, requestId);
      this.event('approval.answered', run, null, {
        requestId, attemptId: request.attemptId, decision: input.decision, feedbackLength: feedback === null ? 0 : feedback.length, continuation: ack.continuation,
      });
      if (queue) this.enqueueContinuation(run, this.getApproval(runId, requestId)!);
      return { ack };
    });
    if ('stale' in outcome) throw new CoordinatorError(409, 'approval-stale', outcome.stale);
    return outcome.ack;
  }

  /** True when the run is released, paused on exactly the task and attempt that asked, and may be resumed by the decision. */
  private continuable(run: RunRecord, request: ApprovalRecord): boolean {
    const state = run.checkpoint;
    return run.status === 'paused' && !run.capacityReserved && !!run.binding && !!state && state.status === 'paused'
      && state.phase === request.phase && state.index === request.taskIndex && state.tasks[request.taskIndex]?.id === request.taskId
      && state.wait?.kind === 'approval' && state.wait.attemptId === request.attemptId && state.attempt?.id === request.attemptId;
  }

  /**
   * Queues the one resume that carries an answered request's decision. The caller holds the transaction and has checked
   * `continuable`. A withdrawn decision is rendered with its superseded marker, whatever the worktree measures now: its
   * withdrawal is permanent, so it can only ever tell the agent what the owner said and that nothing is authorized.
   */
  private enqueueContinuation(run: RunRecord, request: ApprovalRecord): void {
    const messageId = 'msg_' + randomUUID();
    const withdrawn = request.continuation === 'superseded';
    const resolution = renderApprovalContext({
      requestId: request.requestId, decision: request.decision!, feedback: request.feedback, scope: request.request.scope, revision: request.revision,
      onApprove: request.request.onApprove, onRequestChanges: request.request.onRequestChanges, taskId: request.taskId, index: request.taskIndex,
      ...(withdrawn ? { superseded: { reason: request.supersededReason ?? 'The reviewed worktree changed after the decision was recorded' } } : {}),
    });
    this.db.prepare("UPDATE runs SET status = 'queued', owner_token = NULL, prompt_message_id = ?, launch_action = 'resume', resolution = ?, resume_binding_json = NULL, launch_intent = 0, reason = NULL, queue_sequence = ?, version = version + 1, updated_at = ? WHERE id = ?")
      .run(messageId, resolution, this.nextQueueSequence(), Date.now(), run.id);
    // A withdrawn decision keeps its continuation: the new message id is what a later dispatch recognizes as its queued delivery.
    this.db.prepare('UPDATE approval_requests SET continuation = ?, continuation_at = ?, continuation_message_id = ? WHERE run_id = ? AND request_id = ?')
      .run(withdrawn ? 'superseded' : 'queued', Date.now(), messageId, run.id, request.requestId);
    const queued = this.requireRun(run.id);
    this.event('run.resume_queued', queued, null, { version: queued.version, messageID: queued.promptMessageId, requestId: request.requestId });
    this.event('approval.continuation_queued', queued, null, { requestId: request.requestId, messageID: messageId, version: queued.version, ...(withdrawn ? { superseded: true } : {}) });
  }

  /** Answered requests whose decision still has to reach a resumed attempt, for runs that are paused and released right now. */
  pendingContinuations(): Array<{ run: RunRecord; approval: ApprovalRecord }> {
    const found: Array<{ run: RunRecord; approval: ApprovalRecord }> = [];
    for (const row of this.db.prepare(`SELECT * FROM approval_requests WHERE state = 'answered'
      AND (continuation IN ('pending','queued') OR (continuation IN ('consumed','superseded') AND consumed_attempt_id IS NULL)) ORDER BY answered_at, rowid`).all()) {
      const approval = this.approvalFromRow(row);
      const run = this.getRun(approval.runId);
      if (run && this.continuable(run, approval)) found.push({ run, approval });
    }
    return found;
  }

  /**
   * Queues the resume that carries an answered decision, at most once per decision. `expectedVersion` is the run version at
   * which the caller proved the run idle; any other version, a run that is not paused and released on the asking task, or a
   * continuation that is no longer waiting returns null and changes nothing. A continuation left `queued` by a run that
   * returned to paused without dispatching is waiting again and is queued once more. So is a decision that passed the dispatch
   * boundary but was never carried by an attempt: when the run is back on the paused wait that asked, it is still owed. A
   * decision withdrawn at the boundary and never carried is owed the same way, as superseded context without authorization.
   */
  queueContinuation(runId: string, requestId: string, expectedVersion: number): RunRecord | null {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new Error('Expected version must be a nonnegative safe integer');
    return this.transaction(() => {
      const request = this.getApproval(runId, requestId);
      const run = this.getRun(runId);
      if (!request || !run || request.state !== 'answered') return null;
      const owed = ['consumed', 'superseded'].includes(request.continuation) && request.consumedAttemptId === null;
      if (!owed && !['pending', 'queued'].includes(request.continuation)) return null;
      if (run.version !== expectedVersion || !this.continuable(run, request)) return null;
      this.enqueueContinuation(run, request);
      return this.requireRun(runId);
    });
  }

  /**
   * The dispatch boundary of an admitted resume that carries an approval decision: records native launch intent and, in the
   * same transaction, consumes the decision. `revision` is the worktree measured just before. An unchanged revision consumes
   * the continuation; a changed one withdraws the authorization and replaces the delivered context with a superseded one, so
   * the agent keeps its work, performs nothing gated and asks again. Replaying after the boundary reports the stored outcome.
   * A resolution that is not an approval decision only marks launch intent.
   */
  beginApprovalDispatch(id: string, ownerToken: string, revision?: ApprovalRevision): 'plain' | 'authorized' | 'superseded' {
    return this.transaction(() => {
      const run = this.requireOwner(id, ownerToken);
      const context = run.launchAction === 'resume' ? parseApprovalContext(run.resolution ?? undefined) : undefined;
      const mark = () => {
        this.db.prepare('UPDATE runs SET launch_intent = 1, updated_at = ? WHERE id = ?').run(Date.now(), id);
        this.event('run.launch_intent', run, null, { launchAction: run.launchAction });
      };
      if (!context) { if (!run.launchIntent) mark(); return 'plain'; }
      const request = this.getApproval(id, context.requestId);
      if (!request || request.state !== 'answered' || request.decision !== context.decision || request.continuationMessageId !== run.promptMessageId) throw new Error('The approval continuation is not the one queued for this admission');
      if (run.launchIntent) return request.continuation === 'superseded' ? 'superseded' : 'authorized';
      if (request.continuation === 'superseded') {
        // A withdrawn decision requeued because no attempt carried its context: the delivery admitted here only informs the agent.
        // The revision is not measured again, since withdrawal is permanent and nothing can make this decision authorize again.
        if (!context.superseded) throw new Error('A withdrawn approval decision cannot be delivered as an authorization');
        mark();
        return 'superseded';
      }
      if (request.continuation !== 'queued') throw new Error('The approval continuation was already delivered');
      if (!revision) throw new Error('Dispatching an approval continuation requires the current review revision');
      const now = Date.now();
      if (revision.head === request.revision.head && revision.digest === request.revision.digest) {
        this.db.prepare("UPDATE approval_requests SET continuation = 'consumed', continuation_at = ? WHERE run_id = ? AND request_id = ?").run(now, id, request.requestId);
        this.event('approval.consumed', run, null, { requestId: request.requestId, messageID: run.promptMessageId });
        mark();
        return 'authorized';
      }
      const reason = 'The reviewed worktree changed after the decision was recorded';
      this.db.prepare("UPDATE approval_requests SET continuation = 'superseded', continuation_at = ?, superseded_at = ?, superseded_reason = ? WHERE run_id = ? AND request_id = ?")
        .run(now, now, reason, id, request.requestId);
      this.db.prepare('UPDATE runs SET resolution = ? WHERE id = ?').run(supersedeApprovalContext(context, reason), id);
      this.event('approval.superseded', run, null, { requestId: request.requestId, attemptId: request.attemptId, reason, continuation: 'superseded' });
      mark();
      return 'superseded';
    });
  }

  /** Where an answered request's decision stands, from the request and the run together. */
  approvalProgress(request: ApprovalRecord, run: RunRecord): ApprovalProgress {
    if (request.state !== 'answered') return 'none';
    switch (request.continuation) {
      case 'consumed':
        // Delivered means an attempt carried it. Dispatched but not carried, it is executing, or owed again once the run is idle.
        if (request.consumedAttemptId !== null) return 'consumed';
        if (run.capacityReserved) return 'executing';
        return this.continuable(run, request) ? 'waiting-for-idle' : 'consumed';
      case 'superseded':
        // Withdrawn: it authorizes nothing, but its context is owed to the agent until an attempt carries it.
        if (request.consumedAttemptId !== null) return 'superseded';
        if (run.status === 'queued') return 'queued';
        if (run.capacityReserved) return 'executing';
        return this.continuable(run, request) ? 'waiting-for-idle' : 'superseded';
      case 'queued':
        if (run.status === 'queued') return 'queued';
        return run.capacityReserved ? 'executing' : 'waiting-for-idle';
      case 'pending': return this.continuable(run, request) ? 'recorded' : 'waiting-for-idle';
      default: return 'none';
    }
  }

  /** What the run is waiting for: its current typed request, else a generic pause, else nothing. Bounded in both cases. */
  runWait(run: RunRecord): ApprovalWait | GenericWait | null {
    return this.approvalWait(run) ?? genericWaitOf(run);
  }

  /**
   * The bounded projection of a run's current request, or null. An answered request whose continuation was consumed is
   * history, and a superseded one is shown only while the run is still paused on it.
   */
  approvalWait(run: RunRecord): ApprovalWait | null {
    const request = this.latestApproval(run.id);
    const place: WaitPlace = {
      status: run.status, released: !!run.checkpoint && isPausedCheckpoint(run, run.checkpoint.status),
      waitAttempt: run.checkpoint?.wait?.kind === 'approval' ? run.checkpoint.wait.attemptId : null,
    };
    if (!request || !approvalShown(request, place)) return null;
    const task = run.checkpoint?.tasks[request.taskIndex];
    const clipped = { question: false, scope: false, completedWork: false, verification: false, artifacts: false, onApprove: false, onRequestChanges: false, taskTitle: false, feedback: false };
    const text = (name: keyof typeof clipped, value: string, limit: number): string => {
      const result = clip(value, limit);
      if (result.clipped) clipped[name] = true;
      return result.text;
    };
    const list = (name: keyof typeof clipped, values: string[]): string[] => {
      if (values.length > WAIT_LIST_LIMIT) clipped[name] = true;
      return values.slice(0, WAIT_LIST_LIMIT).map(value => {
        const result = clip(value, WAIT_ENTRY_LIMIT);
        if (result.clipped) clipped[name] = true;
        return result.text;
      });
    };
    return {
      kind: 'approval', requestId: request.requestId, state: request.state, continuation: request.continuation, progress: this.approvalProgress(request, run), phase: request.phase,
      taskIndex: request.taskIndex, taskId: request.taskId, taskTitle: task && task.id === request.taskId ? text('taskTitle', task.title, WAIT_TITLE_LIMIT) : null,
      attemptId: request.attemptId, question: text('question', request.request.question, WAIT_TEXT_LIMIT), scope: text('scope', request.request.scope, WAIT_TEXT_LIMIT),
      completedWork: text('completedWork', request.request.completedWork, WAIT_TEXT_LIMIT), verification: list('verification', request.request.verification),
      artifacts: list('artifacts', request.request.artifacts), onApprove: list('onApprove', request.request.onApprove),
      onRequestChanges: list('onRequestChanges', request.request.onRequestChanges), revision: request.revision,
      response: request.state === 'answered' ? { decision: request.decision!, feedback: request.feedback === null ? null : text('feedback', request.feedback, WAIT_TEXT_LIMIT), answeredAt: request.answeredAt! } : null,
      createdAt: request.createdAt, clipped,
    };
  }
}
