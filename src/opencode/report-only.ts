/**
 * Report-only enforcement state shared by the plugin hooks and the native backend.
 *
 * The plugin denies every tool call, empties the tool list and denies permission
 * evaluation for a registered session. Prompt text is never the enforcement.
 *
 * A restriction may name ONE tool id to keep (`allow`): the owner-bound submission tool of a structured repair. Only
 * an exact id match is kept, so namespaced or suffixed lookalikes, delegation, MCP and nested code-mode calls stay
 * denied, and a session holding any restriction without `allow` keeps everything denied.
 */

import type { ReportOnlyOwner } from '../workflow/types.js';

export const REPORT_ONLY_DENIAL = 'Heimdall report-only correction: every tool call is denied. Reply with the completion report JSON only.';
/** Denial while only the submission tool is kept: nothing but a corrected submission is possible. */
export const REPAIR_ONLY_DENIAL = 'Heimdall submission repair: only the submission tool is available. Do no other work; correct the payload and call the submission tool again.';

/**
 * Providers whose tool paths are proven to pass through the enforcement hooks.
 * Only `claude-code` is listed: feature 0005 observed live, in a guarded disposable
 * OpenCode fixture, edit, write, shell, tests, git commit, delegation, namespaced MCP and
 * nested code-mode calls denied under restriction and working again after owner-matched
 * release (docs/validation/claude-code-report-only-live.md). No other provider has live
 * evidence, so none may be added from it.
 */
export const VERIFIED_REPORT_ONLY_PROVIDERS: readonly string[] = ['claude-code'];

export type ReportOnlyHook = 'execute.before' | 'context' | 'permission.evaluate';
const HOOKS: readonly ReportOnlyHook[] = ['execute.before', 'context', 'permission.evaluate'];

export interface ReportOnlyRegistry {
  /** True while a session is restricted. */
  has(sessionID: string): boolean;
  /** Number of live restrictions held on a session. */
  count(sessionID: string): number;
  /** True only when the session is restricted and EVERY restriction on it keeps exactly this tool id. */
  permits(sessionID: string, tool: string): boolean;
  /** Mark one enforcement hook as registered (alive) or disposed. */
  setHook(name: ReportOnlyHook, active: boolean): void;
  /** Names of the enforcement hooks that are not registered. */
  missing(): ReportOnlyHook[];
  /**
   * Restrict a session. Returns an idempotent release. Fails closed without all hooks.
   * An owner makes the restriction releasable by identity, so it survives the caller losing the returned release.
   */
  restrict(sessionID: string, owner?: ReportOnlyOwner, options?: { allow?: string }): () => void;
  /**
   * Remove only the restrictions taken under exactly this owner. Idempotent: returns how many were removed.
   * Other owners, unowned restrictions and other sessions are never touched.
   */
  releaseOwned(owner: ReportOnlyOwner): number;
}

interface Entry { owner?: ReportOnlyOwner; allow?: string }

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
    permits(sessionID, tool) {
      const entries = sessions.get(sessionID) ?? [];
      return entries.length > 0 && typeof tool === 'string' && tool.length > 0 && entries.every(entry => entry.allow === tool);
    },
    setHook(name, active) { if (active) hooks.add(name); else hooks.delete(name); },
    missing: () => HOOKS.filter(name => !hooks.has(name)),
    restrict(sessionID, owner, options) {
      if (typeof sessionID !== 'string' || !sessionID) throw new Error('A child session is required for report-only restriction');
      if (owner && (owner.child !== sessionID || !owner.parent || !owner.attemptId)) throw new Error('A report-only owner must name its parent, child and attempt');
      const missing = HOOKS.filter(name => !hooks.has(name));
      if (missing.length) throw new Error('Report-only enforcement is unavailable: plugin hooks not registered (' + missing.join(', ') + ')');
      if (options?.allow !== undefined && (typeof options.allow !== 'string' || !options.allow)) throw new Error('A report-only allowance must name one exact tool id');
      const entry: Entry = { ...(owner ? { owner: { ...owner } } : {}), ...(options?.allow === undefined ? {} : { allow: options.allow }) };
      sessions.set(sessionID, [...(sessions.get(sessionID) ?? []), entry]);
      return () => { remove(sessionID, candidate => candidate !== entry); };
    },
    releaseOwned(owner) {
      if (!owner?.child) return 0;
      return remove(owner.child, entry => !sameOwner(entry.owner, owner));
    },
  };
}
