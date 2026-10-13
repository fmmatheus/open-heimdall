/*
 * Test-only process entry for the production `heimdall coordinator start|stop` commands.
 *
 *   node lifecycle-cli-entry.mjs <fixture.json> <start|stop> [arguments...]
 *
 * It runs `lifecycleCommandMain` unchanged in its own process, so a test can end that process the way a crash or a
 * kill would, and can run a second lifecycle command from another process against the same state directory. The only
 * injected pieces are the ones a real user session supplies: the environment, the platform, and the absolute path of
 * the native tool. The adapters are the production `createSystemdAdapter` / `createLaunchdAdapter`, and the tool is
 * run by the production `createExecFileRunner`. The tool itself is the synthetic executable of
 * `test/fixtures/synthetic-native-tool.mjs`; nothing here is launchd or systemd evidence.
 */
import { lifecycleCommandMain } from '../../dist/coordinator/lifecycle-cli.js';
import { createLaunchdAdapter } from '../../dist/coordinator/native/launchd.js';
import { createSystemdAdapter } from '../../dist/coordinator/native/systemd.js';
import { createExecFileRunner } from '../../dist/coordinator/native/types.js';
import fs from 'node:fs';

const [fixturePath, command, ...args] = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));

const createAdapter = context => fixture.manager === 'launchd'
  ? { supported: true, manager: 'launchd', adapter: createLaunchdAdapter({ context, runner: createExecFileRunner(), uid: fixture.uid, launchctl: fixture.tool }) }
  : {
    supported: true,
    manager: 'systemd',
    adapter: createSystemdAdapter({
      context,
      runner: createExecFileRunner(),
      systemctl: fixture.tool,
      environment: { XDG_RUNTIME_DIR: fixture.runtimeDirectory, DBUS_SESSION_BUS_ADDRESS: `unix:path=${fixture.runtimeDirectory}/bus`, XDG_CONFIG_HOME: fixture.configHome },
    }),
  };

const status = await lifecycleCommandMain(command, args, {
  dependencies: {
    environment: { HOME: fixture.home, OPENCHAMBER_DATA_DIR: fixture.openchamber },
    platform: fixture.manager === 'launchd' ? 'darwin' : 'linux',
    createAdapter,
    launchOverrides: { nodeExecutable: process.execPath, entryPoint: fixture.entryPoint },
    pollIntervalMs: 20,
    requestTimeoutMs: 3000,
    progress: text => { process.stderr.write(`${text}\n`); },
  },
});
process.exitCode = status;
