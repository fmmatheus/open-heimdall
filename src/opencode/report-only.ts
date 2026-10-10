/**
 * Report-only enforcement state shared by the plugin hooks and the native backend.
 *
 * The plugin denies every tool call, empties the tool list and denies permission
 * evaluation for a registered session. Prompt text is never the enforcement.
 */

import type { ReportOnlyOwner } from '../workflow/types.js';

export const REPORT_ONLY_DENIAL = 'Heimdall report-only correction: every tool call is denied. Reply with the completion report JSON only.';

/**
 * Providers whose tool paths are proven to pass through the enforcement hooks.
 * Empty on purpose: no provider has been proven (see the H1 conclusion in docs).
 * `claude-code` stays unsupported: its source is read, but the host dispatch of
 * nested code-mode calls cannot be proven from locally available sources.
 */
export const VERIFIED_REPORT_ONLY_PROVIDERS: readonly string[] = [];

export type ReportOnlyHook = 'execute.before' | 'context' | 'permission.evaluate';
const HOOKS: readonly ReportOnlyHook[] = ['execute.before', 'context', 'permission.evaluate'];

export interface ReportOnlyRegistry {
  /** True while a session is restricted. */
  has(sessionID: string): boolean;
  /** Number of live restrictions held on a session. */
  count(sessionID: string): number;
  /** Mark one enforcement hook as registered (alive) or disposed. */
  setHook(name: ReportOnlyHook, active: boolean): void;
  /** Names of the enforcement hooks that are not registered. */
  missing(): ReportOnlyHook[];
  /**
   * Restrict a session. Returns an idempotent release. Fails closed without all hooks.
   * An owner makes the restriction releasable by identity, so it survives the caller losing the returned release.
   */
  restrict(sessionID: string, owner?: ReportOnlyOwner): () => void;
  /**
   * Remove only the restrictions taken under exactly this owner. Idempotent: returns how many were removed.
   * Other owners, unowned restrictions and other sessions are never touched.
   */
  releaseOwned(owner: ReportOnlyOwner): number;
}

interface Entry { owner?: ReportOnlyOwner }

const sameOwner = (a: ReportOnlyOwner | undefined, b: ReportOnlyOwner) => !!a && a.parent === b.parent && a.child === b.child && a.attemptId === b.attemptId && a.runId === b.runId;

export function createReportOnlyRegistry(): ReportOnlyRegistry {
  const sessions = new Map<string, Entry[]>();
  const hooks = new Set<ReportOnlyHook>();
  const remove = (sessionID: string, keep: (entry: Entry) => boolean) => {
    const entries = sessions.get(sessionID) ?? [];
    const kept = entries.filter(keep);
    if (kept.length) sessions.set(sessionID, kept); else sessions.delete(sessionID);
    return entries.length - kept.length;
  };
  return {
    has: sessionID => (sessions.get(sessionID)?.length ?? 0) > 0,
    count: sessionID => sessions.get(sessionID)?.length ?? 0,
    setHook(name, active) { if (active) hooks.add(name); else hooks.delete(name); },
    missing: () => HOOKS.filter(name => !hooks.has(name)),
    restrict(sessionID, owner) {
      if (typeof sessionID !== 'string' || !sessionID) throw new Error('A child session is required for report-only restriction');
      if (owner && (owner.child !== sessionID || !owner.parent || !owner.attemptId)) throw new Error('A report-only owner must name its parent, child and attempt');
      const missing = HOOKS.filter(name => !hooks.has(name));
      if (missing.length) throw new Error('Report-only enforcement is unavailable: plugin hooks not registered (' + missing.join(', ') + ')');
      const entry: Entry = owner ? { owner: { ...owner } } : {};
      sessions.set(sessionID, [...(sessions.get(sessionID) ?? []), entry]);
      return () => { remove(sessionID, candidate => candidate !== entry); };
    },
    releaseOwned(owner) {
      if (!owner?.child) return 0;
      return remove(owner.child, entry => !sameOwner(entry.owner, owner));
    },
  };
}
