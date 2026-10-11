import * as fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TASK_ID_PATTERN, validatePlannerPlan } from './contracts.js';
import type { ContractError, PlannedTask } from './contracts.js';

export interface PlanSnapshot {
  readonly runId: string;
  readonly planMarkdown: string;
  readonly factSheet: string;
  readonly tasks: readonly Readonly<PlannedTask>[];
  /** sha256 over the canonical plan content (plan, facts, tasks); changes only when acknowledged content changes. */
  readonly sha256: string;
}

export type PlanSnapshotResult =
  | { ok: true; snapshot: PlanSnapshot }
  | { ok: false; classification: 'format'; repairable: true; errors: ContractError[] };

const unreadable = (name: string, message: string): PlanSnapshotResult => ({
  ok: false, classification: 'format', repairable: true,
  errors: [{ path: `$.artifacts.${name}`, code: 'invalid_value', message }],
});

/** Content hash of a validated plan, independent of file layout. */
export const planDigest = (plan: { planMarkdown: string; factSheet: string; tasks: readonly unknown[] }): string =>
  createHash('sha256').update(JSON.stringify({ planMarkdown: plan.planMarkdown, factSheet: plan.factSheet, tasks: plan.tasks })).digest('hex');

/**
 * Reads the fixed host-owned planning directory `<planRoot>/adr-<runId>` for the bound run, validates the
 * complete plan with the strict contract and returns an immutable canonical snapshot. The model never
 * chooses a path; later edits to the files cannot change a snapshot that was already returned.
 */
export async function loadPlanSnapshot(options: { directory: string; planRoot?: string; runId: string; limit: number }): Promise<PlanSnapshotResult> {
  const { directory, runId, limit, planRoot = '.omo/plans' } = options;
  if (!TASK_ID_PATTERN.test(runId)) throw new Error('Invalid run id for plan artifacts');
  const repo = await fs.realpath(directory);
  const base = path.resolve(directory, planRoot, 'adr-' + runId);
  let realBase: string;
  try { realBase = await fs.realpath(base); } catch { return unreadable('directory', 'The fixed planning directory does not exist'); }
  if (!realBase.startsWith(repo + path.sep)) throw new Error('Plan artifact escapes project');
  const contents: Record<string, string> = {};
  for (const name of ['plan.md', 'facts.md', 'tasks.md']) {
    let target: string;
    try { target = await fs.realpath(path.join(base, name)); } catch { return unreadable(name, `${name} is missing from the fixed planning directory`); }
    if (path.dirname(target) !== realBase) throw new Error('Plan artifact escapes the planning directory');
    if (!(await fs.stat(target)).isFile()) return unreadable(name, `${name} is not a regular file`);
    contents[name] = await fs.readFile(target, 'utf8');
  }
  let tasks: unknown;
  try { tasks = JSON.parse(contents['tasks.md']!); } catch { return unreadable('tasks.md', 'tasks.md is not valid JSON'); }
  const validated = validatePlannerPlan({ status: 'planned', planMarkdown: contents['plan.md'], factSheet: contents['facts.md'], tasks }, { limit });
  if (!validated.ok) return { ok: false, classification: 'format', repairable: true, errors: validated.errors };
  const plan = validated.value as { planMarkdown: string; factSheet: string; tasks: PlannedTask[] };
  const snapshot: PlanSnapshot = Object.freeze({ runId, planMarkdown: plan.planMarkdown, factSheet: plan.factSheet, tasks: plan.tasks, sha256: planDigest(plan) });
  return { ok: true, snapshot };
}
