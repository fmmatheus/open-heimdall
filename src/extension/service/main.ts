import { createServer } from 'node:http';

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN;

if (!Number.isInteger(port) || port < 0 || port > 65535 || !token) {
  process.stderr.write('Heimdall service requires OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN\n');
  process.exit(1);
}

const server = createServer((request, response) => {
  const authorized = request.headers.authorization === `Bearer ${token}`;
  if (!authorized) {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: true }));
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(port, '127.0.0.1');
