import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { createCoordinatorClient } from '../dist/coordinator/client.js';

const TOKEN = 'k'.repeat(64);

async function listen(t, handler) {
  const temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hd-')));
  const endpoint = process.platform === 'win32' ? `\\\\.\\pipe\\hd-${path.basename(temporary)}` : path.join(temporary, 's.sock');
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(endpoint, resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(temporary, { recursive: true, force: true });
  });
  return endpoint;
}

test('overall deadline bounds a trickling response that keeps resetting the inactivity timeout', async t => {
  const timers = new Set();
  t.after(() => { for (const timer of timers) clearInterval(timer); });
  const endpoint = await listen(t, (request, response) => {
    if (request.url === '/fresh') { response.setHeader('Content-Type', 'application/json'); response.end('{"ok":true}'); return; }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    const timer = setInterval(() => response.write(' '), 20);
    timers.add(timer);
    response.on('close', () => { clearInterval(timer); timers.delete(timer); });
  });

  const client = createCoordinatorClient(endpoint, TOKEN, { timeoutMs: 5000, deadlineMs: 200 });
  const started = Date.now();
  await assert.rejects(client.request('GET', '/trickle'), error => /deadline/.test(error.message) && /200 ms/.test(error.message));
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 150, `rejected too early: ${elapsed} ms`);
  assert.ok(elapsed < 2000, `rejected too late: ${elapsed} ms`);

  assert.deepEqual(await client.request('GET', '/fresh'), { ok: true });
});

test('error responses keep their message and expose the HTTP status code', async t => {
  const endpoint = await listen(t, (_request, response) => {
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'Unknown coordinator route' }));
  });
  await assert.rejects(createCoordinatorClient(endpoint, TOKEN).request('GET', '/status'), error => {
    assert.equal(error.message, 'Unknown coordinator route');
    assert.equal(error.statusCode, 404);
    return true;
  });
});

test('deadlineMs must be a positive safe integer', () => {
  for (const deadlineMs of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createCoordinatorClient('/tmp/x.sock', TOKEN, { deadlineMs }), /deadline/);
  }
  assert.equal(typeof createCoordinatorClient('/tmp/x.sock', TOKEN, { deadlineMs: 1 }).request, 'function');
});
