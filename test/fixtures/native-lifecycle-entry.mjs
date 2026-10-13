/*
 * Test-only process entry for the production `heimdall coordinator start|stop` commands against the REAL user
 * service manager of the host (test/native/lifecycle.native.test.mjs).
 *
 *   node native-lifecycle-entry.mjs <service-entry-point> <start|stop> [arguments...]
 *
 * It runs `lifecycleCommandMain` unchanged in its own process, so a test measures the wall-clock time of the
 * invoking client process itself (not an in-process call) and sees exactly what a terminal user would see. The
 * adapters, the native tool and its resolution are the production ones: nothing is mocked. The only injected pieces
 * are the process environment of the isolated fixture and the entry point the service definition should run, which
 * lets the managed service be the delayed-shutdown protocol fixture (test/fixtures/delayed-drain-entry.mjs).
 */
import { lifecycleCommandMain } from '../../dist/coordinator/lifecycle-cli.js';

const [entryPoint, command, ...args] = process.argv.slice(2);

process.exitCode = await lifecycleCommandMain(command, args, {
  dependencies: {
    environment: process.env,
    launchOverrides: { nodeExecutable: process.execPath, entryPoint },
  },
});
