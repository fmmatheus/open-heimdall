import { randomBytes } from 'node:crypto';
import { LIMITS } from '../shared/protocol.js';
import type { CoordinatorAdapter } from './coordinator.js';

/** The coordinator returns at most this many events per `/events` call. */
export const EVENT_PAGE_SIZE = 500;
/** Pages pulled per poll; a larger backlog is reported through `more` and finished by the next poll. */
export const MAX_EVENT_PAGES = 10;
const MAX_RETAINED = 5000;
const CURSOR = /^([a-f0-9]{12}):(\d{1,15})$/;

export class InvalidCursorError extends Error {
  constructor() { super('The change cursor is not valid.'); this.name = 'InvalidCursorError'; }
}

export interface ChangePoll {
  cursor: string;
  changedRunIds: string[];
  projectsChanged: boolean;
  resync: boolean;
  more: boolean;
}

export interface ChangeTracker {
  poll(cursor: string | undefined): Promise<ChangePoll>;
}

interface Retained { sequence: number; runId: string | null }

/**
 * Keeps the coordinator event cursor in service memory. Cursors handed to the panel carry a per-process
 * generation, so a restarted service (which has lost this memory) answers `resync: true` instead of
 * guessing what changed. History that existed before the first poll is skipped, never replayed.
 */
export function createChangeTracker(options: { adapter: Pick<CoordinatorAdapter, 'events'>; generation?: string }): ChangeTracker {
  const generation = options.generation ?? randomBytes(6).toString('hex');
  let consumed = 0;
  /** Changes are known for every sequence above `floor`. */
  let floor = 0;
  let caughtUp = false;
  let retained: Retained[] = [];
  let lastPageFull = false;
  let queue: Promise<unknown> = Promise.resolve();

  async function advance(): Promise<void> {
    for (let page = 0; page < MAX_EVENT_PAGES; page++) {
      const events = await options.adapter.events(consumed);
      lastPageFull = false;
      if (!Array.isArray(events) || events.length === 0) { caughtUp = true; return; }
      const before = consumed;
      for (const event of events) {
        const sequence = event?.sequence;
        if (!Number.isSafeInteger(sequence) || sequence <= consumed) continue;
        consumed = sequence;
        if (caughtUp) retained.push({ sequence, runId: typeof event.runId === 'string' ? event.runId : null });
      }
      if (!caughtUp) floor = consumed;
      if (consumed === before) { caughtUp = true; return; }
      if (events.length < EVENT_PAGE_SIZE) { caughtUp = true; return; }
      lastPageFull = true;
    }
  }

  async function run(cursor: string | undefined): Promise<ChangePoll> {
    let parsed: { generation: string; sequence: number } | undefined;
    if (cursor !== undefined) {
      const match = CURSOR.exec(cursor);
      if (!match) throw new InvalidCursorError();
      parsed = { generation: match[1]!, sequence: Number(match[2]) };
    }
    await advance();
    if (retained.length > MAX_RETAINED) {
      floor = retained[retained.length - MAX_RETAINED - 1]!.sequence;
      retained = retained.slice(retained.length - MAX_RETAINED);
    }
    const next = `${generation}:${consumed}`;
    const more = !caughtUp || lastPageFull;
    const reload: ChangePoll = { cursor: next, changedRunIds: [], projectsChanged: false, resync: true, more };
    if (!parsed || parsed.generation !== generation || parsed.sequence > consumed || parsed.sequence < floor) return reload;

    const changed = new Set<string>();
    let projectsChanged = false;
    for (const entry of retained) {
      if (entry.sequence <= parsed.sequence) continue;
      if (entry.runId === null) projectsChanged = true;
      else changed.add(entry.runId);
    }
    if (changed.size > LIMITS.changedRunIds) return reload;
    return { cursor: next, changedRunIds: [...changed], projectsChanged, resync: false, more };
  }

  return {
    poll(cursor) {
      // Polls are serialised so concurrent panels cannot interleave coordinator pages.
      const result = queue.then(() => run(cursor));
      queue = result.catch(() => undefined);
      return result;
    },
  };
}
