import type { Configuration } from '../config.js';
import { connect, supportedOpenCodeVersion } from '../opencode/observer.js';
import type { DoctorCheck, DoctorOptions } from './checks.js';

/** Result of the check: the report entry plus whether a probe was attempted and succeeded. */
export interface ConnectionResult { check: DoctorCheck; verified: boolean }

export const connectionNotRequested = (): ConnectionResult => ({
  verified: false,
  check: { id: 'connection', status: 'not-verified', fatal: false, message: 'Not requested; the OpenCode connection is not verified. Request it with --connect' },
});

const failure = (message: string): ConnectionResult => ({ verified: false, check: { id: 'connection', status: 'fail', fatal: true, message } });

/**
 * Verifies the configured loopback OpenCode origin with the existing bounded probe: a single `GET /api/info` using only
 * the selected authentication source. Reuses `connect()` without a session, so no session, agent, plugin, quota or
 * provider endpoint is contacted. Only the probe's fixed error text is reported; causes are never forwarded.
 */
export async function verifyConnection(
  { configuration, projectDirectory, environment, connection }: {
    configuration: Configuration | undefined;
    projectDirectory: string | undefined;
    environment: NodeJS.ProcessEnv;
    connection?: DoctorOptions['connection'];
  },
): Promise<ConnectionResult> {
  if (!configuration || projectDirectory === undefined) {
    return failure('The OpenCode connection cannot be verified because the project configuration is unavailable; fix the project checks above or run heimdall setup');
  }
  const { baseUrl, authentication = 'basic', passwordEnvironmentVariable } = configuration.opencode;
  if (!baseUrl) return failure('opencode.baseUrl is not configured, so the configuration is incomplete for a connection check; run heimdall setup or set opencode.baseUrl');
  try {
    const api = await connect(projectDirectory, undefined, {
      baseUrl, authentication, passwordEnvironmentVariable, environment,
      ...(connection?.fetchImpl === undefined ? {} : { fetchImpl: connection.fetchImpl }),
      ...(connection?.timeoutMilliseconds === undefined ? {} : { timeoutMilliseconds: connection.timeoutMilliseconds }),
      ...(connection?.openchamber === undefined ? {} : { openchamber: connection.openchamber }),
    });
    return {
      verified: true,
      check: {
        id: 'connection', status: 'pass', fatal: true,
        message: `GET /api/info at ${baseUrl} with authentication mode ${authentication} returned OpenCode ${api.version} (pid ${api.pid}), the supported version ${supportedOpenCodeVersion}. This verifies only that endpoint and the selected authentication source; protected-API authorization, model availability, provider login and quota remain unverified, and it does not show that a run can execute`,
      },
    };
  } catch (error) {
    const detail = error instanceof Error && error.message ? error.message : 'connection failed';
    return failure(`The OpenCode connection to ${baseUrl} (authentication mode ${authentication}) failed: ${detail}`);
  }
}
