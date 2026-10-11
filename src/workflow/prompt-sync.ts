/**
 * Lets the host's first model-context observation of a child wake the runner's dispatch-prompt watcher.
 *
 * The runner records the dispatch prompt asynchronously, and the child's first native model context can be built
 * before that save lands. Waiting for the prompt inside `onStarted` would deadlock (the prompt is admitted only after
 * `onStarted` returns), so the context hook asks the watcher to observe and save NOW instead. This carries no
 * authority: it only triggers the runner's own observation; admission still comes from the durable binding.
 */
export interface DispatchPromptSync {
  /** Registers the settle step of a running dispatch's watcher for its child; returns the unregister function. */
  register(child: string, settle: () => Promise<void>): () => void;
  /** Runs the watcher's observation for this child once, resolving after the binding is saved. No watcher is a no-op. */
  settle(child: string): Promise<void>;
}

export function createDispatchPromptSync(): DispatchPromptSync {
  const watchers = new Map<string, () => Promise<void>>();
  return {
    register(child, settle) {
      watchers.set(child, settle);
      return () => { if (watchers.get(child) === settle) watchers.delete(child); };
    },
    async settle(child) { await watchers.get(child)?.(); },
  };
}
