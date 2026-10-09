import { createCoordinatorAdapter } from './coordinator.js';
import { createExtensionServer, listenExtensionServer } from './server.js';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN;

if (!Number.isInteger(port) || port < 0 || port > 65535 || !token) {
  process.stderr.write('Heimdall service requires OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN\n');
  process.exit(1);
}

const server = createExtensionServer({ token, adapter: createCoordinatorAdapter() });
listenExtensionServer(server, port).catch(() => {
  process.stderr.write('Heimdall service could not listen on the assigned port\n');
  process.exit(1);
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => server.close(() => process.exit(0)));
