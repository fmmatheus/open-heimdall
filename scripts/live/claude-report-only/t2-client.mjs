// Driver helpers for the T2 live runs: an OpenCode client scoped to one fixture repository, the owner-only
// control socket, and the evidence logs. Everything here talks only to the disposable server recorded in the
// manifest and writes only under the fixture root.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertFixtureRoot, readManifest } from './lib.mjs';

// '@opencode/client' is not resolvable from this directory; load the copy linked into the fixture host.
const loadClient = async root => (await import(pathToFileURL(path.join(root, 'native-host', 'node_modules', '@opencode', 'client', 'dist', 'promise', 'index.js')).href)).OpenCode;

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function connect(rootInput, repositoryKey = 'tools') {
  const OpenCode = await loadClient(assertFixtureRoot(rootInput));
  const root = assertFixtureRoot(rootInput);
  const manifest = readManifest(root);
  const server = JSON.parse(fs.readFileSync(path.join(root, 'native-server.json'), 'utf8'));
  if (server.baseUrl !== `http://127.0.0.1:${manifest.t2.port}`) throw new Error('native-server.json does not match the T2 port; refusing to connect');
  const directory = repositoryKey.startsWith('recovery:') ? manifest.t2.recovery.repositories[repositoryKey.slice(9)].directory : repositoryKey === 'recovery' ? manifest.t2.repositories.recovery : manifest.t2.repositories.tools;
  if (!directory.startsWith(root + path.sep)) throw new Error('Repository outside fixture root');
  const client = OpenCode.make({ baseUrl: server.baseUrl, headers: { 'x-opencode-directory': encodeURIComponent(directory) } });
  return { root, manifest, server, directory, client, pid: server.pid };
}

export function control(root, method, params = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(path.join(root, 'control.sock'));
    let buffer = '';
    socket.on('connect', () => socket.write(JSON.stringify({ id: 1, method, params }) + '\n'));
    socket.on('data', chunk => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      socket.end();
      const reply = JSON.parse(buffer.split('\n')[0]);
      reply.ok ? resolve(reply.result) : reject(new Error(reply.error));
    });
    socket.on('error', reject);
  });
}

export function readLog(root, name) {
  const file = path.join(root, 'evidence', name);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

export async function waitUntil(predicate, { timeoutMs = 180_000, stepMs = 1000, label = 'condition' } = {}) {
  const started = Date.now();
  while (true) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await sleep(stepMs);
  }
}

export const model = (variant, id = 'sonnet') => ({ providerID: 'claude-code', id, ...(variant ? { variant } : {}) });

export async function createSession(connection, { agent = 'fixture-worker', title, variant, parentID, permissions, metadata } = {}) {
  return connection.client.session.create({ agent, title, model: model(variant), location: { directory: connection.directory }, ...(parentID ? { parentID } : {}), ...(permissions ? { permissions } : {}), ...(metadata ? { metadata } : {}) });
}

const idleMarkers = async (connection, sessionID) => (await connection.client.session.context({ sessionID })).filter(message => message.type === 'idle').length;
const idleBaseline = new Map();

// Remembers how many idle markers the session had, so waitIdle only accepts an idle that follows this prompt.
export async function prompt(connection, sessionID, text) {
  idleBaseline.set(sessionID, await idleMarkers(connection, sessionID));
  return connection.client.session.prompt({ sessionID, text });
}

// session.wait is a long-poll the transport drops on slow turns; poll the durable idle marker and the active map instead.
export async function waitIdle(connection, sessionID, timeoutMs = 300_000) {
  const baseline = idleBaseline.get(sessionID) ?? 0;
  await waitUntil(async () => {
    const active = await connection.client.session.active();
    return !(sessionID in active) && (await idleMarkers(connection, sessionID)) > baseline;
  }, { timeoutMs, stepMs: 700, label: `session ${sessionID} to become idle` });
}

// Condensed transcript: tool parts with status/error, and assistant text. No credentials appear in tool inputs.
export async function transcript(connection, sessionID) {
  const messages = await connection.client.session.context({ sessionID });
  return messages.map(message => ({ type: message.type, ...(message.type === 'assistant' ? { finish: message.finish, error: message.error ? String(message.error.message ?? message.error.type ?? 'error') : undefined, content: message.content.map(part => part.type === 'text' ? { type: 'text', text: part.text.slice(0, 600) } : part.type === 'tool' ? { type: 'tool', name: part.name, state: part.state?.status ?? part.status, error: part.state?.error ?? part.error, input: JSON.stringify(part.input ?? part.state?.input ?? {}).slice(0, 200), output: JSON.stringify(part.state?.output ?? part.output ?? '').slice(0, 300) } : { type: part.type }) } : { text: String(message.text ?? '').slice(0, 300) }) }));
}
