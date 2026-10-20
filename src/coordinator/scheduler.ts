import { createManagedWorktree, verifyManagedWorktree } from './worktrees.js';
import { prepareRuntime } from './runtime.js';
import { computeReviewRevision } from './review-revision.js';
import { parseApprovalContext } from '../workflow/approval-context.js';
import { CoordinatorError } from './errors.js';
import { currentPauseId } from './pause.js';
import { verifyRuntimeSnapshot } from './runtime-snapshot.js';
import type { CoordinatorStore } from './store.js';
import type { ApprovalRevision, ManagedExecutor, PauseResponseAck, ProjectRecord, RunRecord } from './types.js';

export interface SchedulerOptions {
  store: CoordinatorStore;
  executor: ManagedExecutor;
  endpoint: string;
  createWorktree?: (input: { project: ProjectRecord; run: RunRecord }) => Promise<void>;
  verifyWorktree?: (input: { project: ProjectRecord; run: RunRecord }) => Promise<void>;
  prepare?: (run: RunRecord, endpoint: string) => Promise<void>;
  /** Measures the reviewed state of the run's worktree. Defaults to the verified managed worktree measured with read-only git. */
  revision?: (run: RunRecord) => Promise<ApprovalRevision>;
}

/** Owns admission and observation. Child sequencing/model choice remain in the proven runner. */
export class CoordinatorScheduler {
  private readonly options: SchedulerOptions;
  private readonly launches = new Map<string, Promise<void>>();
  private stopped = false;
  private admissionStopped = false;
  private ticking: Promise<void> | null = null;
  constructor(options: SchedulerOptions) { this.options = options; }

  /** A process restart does not imply that Git/OpenCode operations stopped. */
  markInterrupted(): void {
    for (const run of this.options.store.listRuns()) {
      if (run.capacityReserved && ['preparing', 'running'].includes(run.status)) {
        this.options.store.transition(run.id, run.ownerToken!, run.version, 'reconciliation-required', 'Coordinator restarted; inspect this retained run before releasing capacity');
      }
    }
  }

  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.process().finally(() => { this.ticking = null; });
    return this.ticking;
  }

  private async process(): Promise<void> {
    if (this.stopped) return;
    const { store } = this.options;
    // Poll only this process's admitted runs. Restarted/ambiguous runs require explicit reconciliation.
    for (const run of store.listRuns()) {
      if (run.status === 'running' && run.capacityReserved && !this.launches.has(run.id)) await this.observe(run);
    }
    // Owner decisions for paused, released runs are queued before admission so they compete in the ordinary queue order.
    if (!this.stopped && !this.admissionStopped) await this.continueDecisions();
    while (!this.stopped && !this.admissionStopped) {
      const run = store.admitNext();
      if (!run) break;
      const operation = this.launch(run).finally(() => this.launches.delete(run.id));
      this.launches.set(run.id, operation);
      // Failures are recorded by launch; avoid an unhandled background rejection.
      operation.catch(() => {});
    }
  }

  private async launch(run: RunRecord): Promise<void> {
    const { store, executor, endpoint } = this.options;
    try {
      const project = store.getProject(run.projectId);
      if (!project) throw new Error('Registered project is missing');
      if (run.launchAction === 'start') await (this.options.createWorktree ?? createManagedWorktree)({ project, run });
      else await (this.options.verifyWorktree ?? verifyManagedWorktree)({ project, run });
      await (this.options.prepare ?? prepareRuntime)(run, endpoint);
      let launching = run;
      const context = run.launchAction === 'resume' ? parseApprovalContext(run.resolution ?? undefined) : undefined;
      if (context) {
        // The reviewed material is measured at the dispatch boundary: an unchanged revision consumes the decision, a changed one
        // withdraws it. Both happen in the transaction that records launch intent, so a decision is neither lost nor delivered twice.
        // A decision already withdrawn is delivered as it is: nothing can make it authorize again, so nothing is measured.
        store.beginApprovalDispatch(run.id, run.ownerToken!, context.superseded ? undefined : await this.reviewRevision(run));
        launching = store.getRun(run.id)!;
      } else store.markLaunchIntent(run.id, run.ownerToken!);
      await executor.launch(launching);
      const current = store.getRun(run.id)!;
      if (current.status === 'preparing') store.transition(current.id, current.ownerToken!, current.version, 'running');
    } catch (error) {
      const current = store.getRun(run.id);
      if (current?.capacityReserved && current.ownerToken === run.ownerToken) {
        store.transition(current.id, current.ownerToken!, current.version, 'reconciliation-required', error instanceof Error ? error.message : 'Preparation or launch could not be confirmed');
      }
    }
  }

  private async observe(run: RunRecord): Promise<RunRecord> {
    const { store, executor } = this.options;
    try {
      const observation = await executor.inspect(run);
      const current = store.getRun(run.id)!;
      if (current.ownerToken !== run.ownerToken || current.version !== run.version) throw new Error('Run ownership changed during observation');
      if (observation.idle && observation.status !== 'unknown') return store.transition(run.id, run.ownerToken!, run.version, observation.status, observation.reason, true);
      return current;
    } catch (error) {
      const current = store.getRun(run.id)!;
      if (current.ownerToken !== run.ownerToken || current.version !== run.version) throw error;
      return store.transition(run.id, run.ownerToken!, run.version, 'reconciliation-required', error instanceof Error ? error.message : 'Native state could not be confirmed');
    }
  }

  async reconcile(id: string): Promise<RunRecord> {
    const run = this.options.store.getRun(id);
    if (!run || !run.capacityReserved || !run.ownerToken) throw new Error('Reconciliation requires a retained capacity reservation');
    if (this.launches.has(id)) throw new Error('Preparation or launch is still in progress');
    if (!run.launchIntent && run.launchAction === 'start') {
      return this.options.store.failBeforeLaunch(run.id, run.ownerToken, run.version, 'Preparation ended before native launch intent; worktree ownership is retained');
    }
    const project = this.options.store.getProject(run.projectId)!;
    await (this.options.verifyWorktree ?? verifyManagedWorktree)({ project, run });
    return this.observe(run);
  }

  async resume(id: string, input: string): Promise<RunRecord> {
    const run = this.options.store.getRun(id);
    // Refused first and again inside queueResume's transaction: a pending approval or unconsumed decision is not resumable by free text.
    this.options.store.assertNoUnresolvedApproval(id);
    if (!run || run.status !== 'paused' || run.capacityReserved) throw new Error('Only a confirmed idle paused run may be resumed');
    await this.proveIdle(run);
    return this.options.store.queueResume(id, input);
  }

  /**
   * The guarded response to a generic pause: owner guidance that continues the run through the existing resume, for exactly
   * the pause the owner saw. A stored acknowledgement is answered first, so an identical retry never depends on the run's
   * current state. Otherwise a typed approval request refuses, the pause must still be the run's current one, and worktree,
   * runtime snapshot and fresh native idle proof must hold before the response and the queued resume are recorded together.
   */
  async respond(id: string, pauseId: string, input: string): Promise<PauseResponseAck> {
    const { store } = this.options;
    const stored = store.getPauseResponse(id, pauseId);
    if (stored) return store.recordPauseResponse(id, pauseId, input, store.getRun(id)?.version ?? 0);
    store.assertNoUnresolvedApproval(id);
    const run = store.getRun(id);
    if (!run || run.status !== 'paused' || run.capacityReserved) throw new CoordinatorError(409, 'pause-not-ready', 'The run is not paused with released capacity; a response can only continue a confirmed idle pause');
    if (currentPauseId(run) !== pauseId) throw new CoordinatorError(409, 'pause-stale', 'This pause is no longer the run\'s current pause');
    try { await this.proveIdle(run); }
    catch (error) { throw new CoordinatorError(409, 'pause-not-ready', error instanceof Error ? error.message : 'The run could not be proven idle'); }
    return store.recordPauseResponse(id, pauseId, input, run.version);
  }

  /** Worktree, runtime and native idle proof for a paused, released run; throws unless every part holds. */
  private async proveIdle(run: RunRecord): Promise<void> {
    const project = this.options.store.getProject(run.projectId)!;
    await (this.options.verifyWorktree ?? verifyManagedWorktree)({ project, run });
    await verifyRuntimeSnapshot(run); // Refuse an altered runtime at the request, not after the run is queued.
    const observation = await this.options.executor.inspect(run);
    if (!observation.idle || observation.status !== 'paused') throw new Error('Native parent and children must be confirmed idle before resume');
  }

  /** The reviewed state of the run's managed worktree, from the same read-only measurement the approval request used. */
  async reviewRevision(run: RunRecord): Promise<ApprovalRevision> {
    if (this.options.revision) return this.options.revision(run);
    const project = this.options.store.getProject(run.projectId);
    if (!project) throw new Error('Registered project is missing');
    await (this.options.verifyWorktree ?? verifyManagedWorktree)({ project, run });
    return computeReviewRevision(run.worktreePath, { roles: Object.keys(run.specification.agents) });
  }

  /** Whether this process still accepts new work: false once admission is paused or the scheduler is stopped. */
  get accepting(): boolean { return !this.stopped && !this.admissionStopped; }

  /**
   * The run as it was proven idle for continuing an owner decision, or undefined when any part of the proof is missing: the
   * run must be paused and released, its worktree and runtime intact, and every native session confirmed idle on a paused
   * checkpoint. Never starts, releases or reconciles anything.
   */
  async proveContinuable(id: string): Promise<RunRecord | undefined> {
    const run = this.options.store.getRun(id);
    if (!run || run.status !== 'paused' || run.capacityReserved || !this.accepting) return undefined;
    try { await this.proveIdle(run); } catch { return undefined; }
    const current = this.options.store.getRun(id);
    return current && current.version === run.version && this.accepting ? current : undefined;
  }

  /** Queues each answered decision whose run is proven idle, once. A decision that cannot be proven yet stays recorded. */
  private async continueDecisions(): Promise<void> {
    const { store } = this.options;
    for (const { run, approval } of store.pendingContinuations()) {
      if (!this.accepting) return;
      try {
        const proven = await this.proveContinuable(run.id);
        if (!proven) continue;
        // Unmeasurable work is not queued for a decision that may authorize; a changed revision is decided at dispatch. A withdrawn
        // decision authorizes nothing, so its delivery does not depend on a measurement.
        if (approval.continuation !== 'superseded') await this.reviewRevision(proven);
        if (!this.accepting) return;
        store.queueContinuation(run.id, approval.requestId, proven.version);
      } catch { /* Left recorded; the next tick proves it again. */ }
    }
  }

  /** Stop admission without cancelling native sessions or freeing their reservations. */
  pauseAdmission(): void { this.admissionStopped = true; }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.ticking;
    await Promise.allSettled(this.launches.values());
  }
}
