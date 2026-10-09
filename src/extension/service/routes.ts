import { loadCoordinatorConfiguration } from '../../coordinator/config.js';
import type { CoordinatorConfiguration } from '../../coordinator/config.js';
import type { ProjectRecord } from '../../coordinator/types.js';
import { LIMITS, RUN_STATUSES } from '../shared/protocol.js';
import type {
  BlockerContentResponse, ChangeFeed, ProjectsResponse, ReviewFileResponse, ReviewResponse, RunResponse, RunsResponse, RunSummary,
  TaskContentResponse, WireRunStatus,
} from '../shared/protocol.js';
import { CoordinatorAdapterError } from './coordinator.js';
import type { CoordinatorAdapter } from './coordinator.js';
import { createChangeTracker, InvalidCursorError } from './events.js';
import { blockerContent, detailRun, summarizeProject, summarizeRun, taskContent } from './projection.js';
import { reviewFile, reviewRun, ReviewGitError, ReviewRequestError, validReviewPath } from './review.js';
import { HttpError } from './server.js';
import type { Route } from './server.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
/** A plan position: digits only, no sign, no leading zero, at most six digits. */
const TASK_INDEX = /^(?:0|[1-9][0-9]{0,5})$/;

function single(query: URLSearchParams, name: string): string | undefined {
  const values = query.getAll(name);
  if (values.length > 1) throw new HttpError(400, 'invalid-request', `Query parameter ${name} may be given only once.`);
  return values[0] === '' ? undefined : values[0];
}

/** Read-only projection routes. The coordinator's runs are fetched only by the routes that need them. */
export function projectionRoutes(options: { adapter: CoordinatorAdapter; now?: () => Date }): Route[] {
  const { adapter } = options;
  const now = options.now ?? (() => new Date());
  const tracker = createChangeTracker({ adapter });
  const directories = (projects: ProjectRecord[]) => new Map(projects.map(project => [project.id, project]));

  return [
    {
      method: 'GET', path: '/projects',
      async handler(): Promise<ProjectsResponse> {
        const projects = (await adapter.projects()).map(summarizeProject);
        return { projects, fetchedAt: now().toISOString() };
      },
    },
    {
      method: 'GET', path: '/runs',
      async handler({ query }): Promise<RunsResponse> {
        const projectId = single(query, 'projectId');
        const status = single(query, 'status');
        if (projectId !== undefined && !IDENTIFIER.test(projectId)) throw new HttpError(400, 'invalid-request', 'The projectId filter is not valid.');
        if (status !== undefined && !(RUN_STATUSES as readonly string[]).includes(status)) {
          throw new HttpError(400, 'invalid-request', `The status filter must be one of: ${RUN_STATUSES.join(', ')}.`);
        }
        const [projects, runs] = await Promise.all([adapter.projects(), adapter.runs()]);
        const known = directories(projects);
        if (projectId !== undefined && !known.has(projectId)) throw new HttpError(404, 'not-found', 'No such Heimdall project.');

        const matching = runs
          .filter(run => (projectId === undefined || run.projectId === projectId) && (status === undefined || run.status === (status as WireRunStatus)))
          .sort((left, right) => (right.updatedAt - left.updatedAt) || (right.createdAt - left.createdAt));
        const summaries: RunSummary[] = [];
        let bytes = 256;
        let truncated = false;
        for (const run of matching) {
          const summary = summarizeRun(run, known.get(run.projectId));
          const size = Buffer.byteLength(JSON.stringify(summary)) + 1;
          if (summaries.length >= LIMITS.runsPerList || bytes + size > LIMITS.listBytes) { truncated = true; break; }
          summaries.push(summary);
          bytes += size;
        }
        return { runs: summaries, total: matching.length, truncated, fetchedAt: now().toISOString() };
      },
    },
    {
      method: 'GET', path: '/runs/:id',
      async handler({ params }): Promise<RunResponse> {
        const id = params.id!;
        if (!IDENTIFIER.test(id)) throw new HttpError(404, 'not-found', 'No such Heimdall run.');
        const [run, projects] = await Promise.all([adapter.run(id), adapter.projects()]);
        return { run: detailRun(run, directories(projects).get(run.projectId)), fetchedAt: now().toISOString() };
      },
    },
    {
      // Read-only: more of one task's recorded text. `:index` is the 0-based plan position, digits only.
      method: 'GET', path: '/runs/:id/tasks/:index',
      async handler({ params }): Promise<TaskContentResponse> {
        const id = params.id!;
        if (!IDENTIFIER.test(id)) throw new HttpError(404, 'not-found', 'No such Heimdall run.');
        const raw = params.index!;
        // Rejected before the coordinator is consulted.
        if (!TASK_INDEX.test(raw)) throw new HttpError(400, 'invalid-request', 'The task index must be a whole number.');
        const run = await adapter.run(id);
        const content = taskContent(run, Number(raw));
        if (content === null) throw new HttpError(404, 'not-found', 'No such task in this Heimdall run.');
        return { ...content, fetchedAt: now().toISOString() };
      },
    },
    {
      // Read-only: the recorded reason and resolution of a paused, failed or reconciliation-required run.
      method: 'GET', path: '/runs/:id/blocker',
      async handler({ params }): Promise<BlockerContentResponse> {
        const id = params.id!;
        if (!IDENTIFIER.test(id)) throw new HttpError(404, 'not-found', 'No such Heimdall run.');
        const content = blockerContent(await adapter.run(id));
        if (content === null) throw new HttpError(404, 'not-found', 'This Heimdall run has no recorded blocker.');
        return { ...content, fetchedAt: now().toISOString() };
      },
    },
    {
      method: 'GET', path: '/changes',
      async handler({ query }): Promise<ChangeFeed> {
        try {
          const poll = await tracker.poll(single(query, 'cursor'));
          return { ...poll, fetchedAt: now().toISOString() };
        } catch (error) {
          if (error instanceof InvalidCursorError) throw new HttpError(400, 'invalid-request', error.message);
          throw error;
        }
      },
    },
  ];
}

export interface ReviewRoutesOptions {
  adapter: CoordinatorAdapter;
  /** Supplies the coordinator state directory that locates managed worktrees. */
  loadConfiguration?: () => Promise<Pick<CoordinatorConfiguration, 'stateDirectory'>>;
  configPath?: string;
  now?: () => Date;
}

/** Read-only review of a run's managed worktree. Run and project come only from the coordinator, by run id. */
export function reviewRoutes(options: ReviewRoutesOptions): Route[] {
  const { adapter } = options;
  const loadConfiguration = options.loadConfiguration ?? (() => loadCoordinatorConfiguration(options.configPath));
  const now = options.now;

  async function context(id: string) {
    if (!IDENTIFIER.test(id)) throw new HttpError(404, 'not-found', 'No such Heimdall run.');
    const [run, projects, configuration] = await Promise.all([
      adapter.run(id),
      adapter.projects(),
      loadConfiguration().catch(() => { throw new CoordinatorAdapterError('configuration-invalid'); }),
    ]);
    return { run, project: projects.find(project => project.id === run.projectId), configuration };
  }
  const failure = (error: unknown): never => {
    if (error instanceof ReviewRequestError) throw new HttpError(400, 'invalid-request', error.message);
    if (error instanceof ReviewGitError) throw new HttpError(500, 'internal-error', error.message);
    throw error;
  };

  return [
    {
      method: 'GET', path: '/runs/:id/review',
      async handler({ params }): Promise<ReviewResponse> {
        const { run, project, configuration } = await context(params.id!);
        try { return await reviewRun(run, project, configuration, { now }); }
        catch (error) { return failure(error); }
      },
    },
    {
      method: 'GET', path: '/runs/:id/review/file',
      async handler({ params, query }): Promise<ReviewFileResponse> {
        const values = query.getAll('path');
        // Rejected before the coordinator, the filesystem or git are consulted.
        if (values.length !== 1 || !validReviewPath(values[0])) throw new HttpError(400, 'invalid-request', 'Provide one valid repository-relative path.');
        const { run, project, configuration } = await context(params.id!);
        try { return await reviewFile(run, project, configuration, values[0], { now }); }
        catch (error) { return failure(error); }
      },
    },
  ];
}
