/**
 * Report-only enforcement state shared by the plugin hooks and the native backend.
 *
 * The plugin denies every tool call, empties the tool list and denies permission
 * evaluation for a registered session. Prompt text is never the enforcement.
 */

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
  /** Mark one enforcement hook as registered (alive) or disposed. */
  setHook(name: ReportOnlyHook, active: boolean): void;
  /** Names of the enforcement hooks that are not registered. */
  missing(): ReportOnlyHook[];
  /** Restrict a session. Returns an idempotent release. Fails closed without all hooks. */
  restrict(sessionID: string): () => void;
}

export function createReportOnlyRegistry(): ReportOnlyRegistry {
  const sessions = new Map<string, number>();
  const hooks = new Set<ReportOnlyHook>();
  return {
    has: sessionID => (sessions.get(sessionID) ?? 0) > 0,
    setHook(name, active) { if (active) hooks.add(name); else hooks.delete(name); },
    missing: () => HOOKS.filter(name => !hooks.has(name)),
    restrict(sessionID) {
      if (typeof sessionID !== 'string' || !sessionID) throw new Error('A child session is required for report-only restriction');
      const missing = HOOKS.filter(name => !hooks.has(name));
      if (missing.length) throw new Error('Report-only enforcement is unavailable: plugin hooks not registered (' + missing.join(', ') + ')');
      sessions.set(sessionID, (sessions.get(sessionID) ?? 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (sessions.get(sessionID) ?? 1) - 1;
        if (left > 0) sessions.set(sessionID, left); else sessions.delete(sessionID);
      };
    },
  };
}
