import fs from 'node:fs/promises';
import path from 'node:path';
import { MATCH_LIMITS } from '../shared/protocol.js';
import type { DirectoryMatch, DirectoryMatchResponse } from '../shared/protocol.js';
import type { CoordinatorAdapter } from './coordinator.js';
import { HttpError } from './server.js';
import type { Route } from './server.js';

/** Room for 200 directories of 1024 characters with JSON escaping; the server default is far smaller. */
const BODY_BYTES = 256 * 1024;

function requestedDirectories(body: unknown): string[] {
  const list = typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as { directories?: unknown }).directories : undefined;
  if (!Array.isArray(list)) throw new HttpError(400, 'invalid-request', 'Provide a directories array.');
  if (list.length > MATCH_LIMITS.directories) throw new HttpError(400, 'invalid-request', `Provide at most ${MATCH_LIMITS.directories} directories.`);
  for (const entry of list) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > MATCH_LIMITS.pathChars || entry.includes('\0') || !path.isAbsolute(entry)) {
      throw new HttpError(400, 'invalid-request', `Each directory must be an absolute path of at most ${MATCH_LIMITS.pathChars} characters without NUL.`);
    }
  }
  return list as string[];
}

/** Resolves symlinks only; nothing is read from the directory, and any failure simply means "no match". */
async function canonical(directory: string): Promise<string | undefined> {
  try { return await fs.realpath(directory); } catch { return undefined; }
}

/**
 * Canonical identity matching: OpenChamber directories may be aliases (symlinks, non-canonical spellings), so they
 * are compared with the coordinator's canonical project directories and managed worktree paths, never by name or id.
 */
export function directoryRoutes(options: { adapter: CoordinatorAdapter }): Route[] {
  const { adapter } = options;
  return [
    {
      method: 'POST', path: '/directories/match', body: { maxBytes: BODY_BYTES },
      async handler({ body }): Promise<DirectoryMatchResponse> {
        const directories = requestedDirectories(body);
        if (directories.length === 0) return { matches: [] };
        const [projects, runs, resolved] = await Promise.all([
          adapter.projects(),
          adapter.runs(),
          Promise.all(directories.map(canonical)),
        ]);
        const projectByDirectory = new Map<string, string>();
        for (const project of projects) projectByDirectory.set(project.directory, project.id);
        const runByWorktree = new Map<string, { projectId: string; runId: string }>();
        for (const run of runs) {
          if (typeof run.worktreePath === 'string' && run.worktreePath !== '') runByWorktree.set(run.worktreePath, { projectId: run.projectId, runId: run.id });
        }
        return {
          matches: resolved.map((real): DirectoryMatch => {
            if (real === undefined) return {};
            const projectId = projectByDirectory.get(real);
            if (projectId !== undefined) return { projectId };
            return runByWorktree.get(real) ?? {};
          }),
        };
      },
    },
  ];
}
