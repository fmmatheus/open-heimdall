/*
 * Service entry point for the native delayed-drain check (test/native/lifecycle.native.test.mjs).
 *
 * It runs the production `heimdall coordinator serve` command unchanged, with one injected delay: closing the
 * scheduler takes SHUTDOWN_DELAY_MS after the drain was accepted. The service manager therefore runs a real
 * coordinator whose shutdown outlasts a short `heimdall coordinator stop --timeout`. This is a protocol fixture:
 * the delay stands in for a drain that waits on a native run, which the managed service cannot hold without OpenCode.
 */
import { coordinatorMain } from '../../dist/coordinator/cli.js';

const SHUTDOWN_DELAY_MS = 6000;

// The service definition passes `coordinator serve ...`; the entry point receives them after the script path.
const [, ...args] = process.argv.slice(2);

try {
  await coordinatorMain(args, {
    serviceOptions: {
      testHooks: {
        shutdownStage: async stage => { if (stage === 'scheduler-stop') await new Promise(resolve => setTimeout(resolve, SHUTDOWN_DELAY_MS)); },
      },
    },
  });
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : 'Coordinator failed'}\n`);
  process.exitCode = 1;
}
