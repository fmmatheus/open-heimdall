import { createManagedWorktree, verifyManagedWorktree } from './worktrees.js';
import { prepareRuntime } from './runtime.js';
import type { CoordinatorStore } from './store.js';
import type { ManagedExecutor, ProjectRecord, RunRecord } from './types.js';

export interface SchedulerOptions {
  store: CoordinatorStore;
  executor: ManagedExecutor;
  endpoint: string;
  createWorktree?: (input: { project: ProjectRecord; run: RunRecord }) => Promise<void>;
  verifyWorktree?: (input: { project: ProjectRecord; run: RunRecord }) => Promise<void>;
  prepare?: (run: RunRecord, endpoint: string) => Promise<void>;
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
      store.markLaunchIntent(run.id, run.ownerToken!);
      await executor.launch(run);
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
    if (!run || run.status !== 'paused' || run.capacityReserved) throw new Error('Only a confirmed idle paused run may be resumed');
    const project = this.options.store.getProject(run.projectId)!;
    await (this.options.verifyWorktree ?? verifyManagedWorktree)({ project, run });
    const observation = await this.options.executor.inspect(run);
    if (!observation.idle || observation.status !== 'paused') throw new Error('Native parent and children must be confirmed idle before resume');
    return this.options.store.queueResume(id, input);
  }

  /** Stop admission without cancelling native sessions or freeing their reservations. */
  pauseAdmission(): void { this.admissionStopped = true; }

  async stop(): Promise<void> {
    this.stopped = true;
    await this.ticking;
    await Promise.allSettled(this.launches.values());
  }
}
