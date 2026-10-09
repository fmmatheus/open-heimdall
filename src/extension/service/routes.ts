import type { ProjectRecord } from '../../coordinator/types.js';
import { LIMITS, RUN_STATUSES } from '../shared/protocol.js';
import type { ChangeFeed, ProjectsResponse, RunResponse, RunsResponse, RunSummary, WireRunStatus } from '../shared/protocol.js';
import type { CoordinatorAdapter } from './coordinator.js';
import { createChangeTracker, InvalidCursorError } from './events.js';
import { detailRun, summarizeProject, summarizeRun } from './projection.js';
import { HttpError } from './server.js';
import type { Route } from './server.js';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

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
