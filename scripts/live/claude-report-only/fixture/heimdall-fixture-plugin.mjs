// Fixture-only wrapper around the built Heimdall plugin for the live verification.
//
// It calls the real createPlugin({ reportOnly }) from the fixture copy of dist/ and does not wrap, replace or
// reorder any Heimdall hook. Next to it, it opens an owner-only control socket (mode 0600, inside the fixture
// root) that shares the report-only registry: restrict, release, inspection and a tool-registry dump. The
// control channel is never exposed as a model-visible tool.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Plugin } from '@opencode/plugin';
import { createPlugin } from '../dist/opencode/plugin.js';
import { createReportOnlyRegistry } from '../dist/opencode/report-only.js';
import { createObserver } from '../dist/opencode/observer.js';
import { loadConfiguration } from '../dist/config.js';

const root = process.env.HEIMDALL_FIXTURE_ROOT;
if (!root) throw new Error('HEIMDALL_FIXTURE_ROOT is required');
const socketPath = path.join(root, 'control.sock');
const logPath = path.join(root, 'evidence', 'control.jsonl');

const registry = createReportOnlyRegistry();
// Fixture-only observation fault (T2 retained-restriction check). The injected observer is the real createObserver; it
// differs only for session ids the owner put in `faults` through the control socket, whose snapshot is reported
// `active: true`. Nothing is faulted unless the control channel says so, so every other scenario sees the real observer.
const faults = new Map(); // sessionID -> number of faulted observations
const observers = new Map(); // project directory -> real observer
const sessionDirectories = new Map(); // sessionID -> directory that last produced a snapshot
const contexts = new Map(); // project directory -> plugin context (the plugin is set up once per location)
const realObserver = async directory => {
  if (!observers.has(directory)) {
    const configuration = await loadConfiguration({ projectDirectory: directory });
    observers.set(directory, createObserver({ directory: configuration.projectDirectory, ...configuration.opencode }));
  }
  return observers.get(directory);
};
const observe = async (id, signal) => {
  const known = sessionDirectories.get(id);
  const candidates = [...new Set([...(known ? [known] : []), ...[...contexts.keys()].reverse()])];
  let failure;
  let snapshot;
  for (const directory of candidates) {
    try { snapshot = await (await realObserver(directory))(id, signal); sessionDirectories.set(id, directory); break; } catch (error) { failure = error; }
  }
  if (!snapshot) throw failure ?? new Error('No fixture location can observe this session');
  if (!faults.has(id)) return snapshot;
  faults.set(id, faults.get(id) + 1);
  return { ...snapshot, active: true };
};
const inner = createPlugin({ reportOnly: registry, observe });
const releases = new Map(); // `${child}|${attemptId}` -> idempotent release returned by restrict()
let server;
const log = entry => fs.appendFileSync(logPath, JSON.stringify({ at: Date.now(), ...entry }) + '\n');

export default Plugin.define({
  id: inner.id,
  async setup(ctx) {
    const cleanup = await inner.setup(ctx);
    contexts.set(ctx.location.directory, ctx);
    if (server) {
      log({ event: 'additional location', location: ctx.location.directory });
      return async () => { contexts.delete(ctx.location.directory); if (typeof cleanup === 'function') await cleanup(); };
    }
    const handlers = {
      ping: () => ({ pid: process.pid, hooksMissing: registry.missing() }),
      restrict: ({ sessionID, parent, attemptId, runId }) => {
        const owner = { parent, child: sessionID, attemptId, runId };
        const release = registry.restrict(sessionID, owner);
        releases.set(`${sessionID}|${attemptId}`, release);
        return { restricted: registry.has(sessionID), count: registry.count(sessionID) };
      },
      releaseOwned: ({ sessionID, parent, attemptId, runId }) => {
        const removed = registry.releaseOwned({ parent, child: sessionID, attemptId, runId });
        return { removed, restricted: registry.has(sessionID), count: registry.count(sessionID) };
      },
      fault: ({ sessionID }) => { faults.set(sessionID, 0); return { faulted: [...faults] }; },
      faultCount: ({ sessionID }) => ({ observations: faults.get(sessionID) ?? null }),
      unfault: ({ sessionID }) => { const observations = faults.get(sessionID) ?? null; faults.delete(sessionID); return { observationsWhileFaulted: observations, faulted: [...faults] }; },
      has: ({ sessionID }) => ({ restricted: registry.has(sessionID), count: registry.count(sessionID) }),
      missing: () => ({ missing: registry.missing() }),
      tools: async ({ location }) => {
        const selected = contexts.get(location) ?? [...contexts.values()].at(-1);
        return { location: selected.location.directory, tools: (await selected.tool.list()).map(tool => tool.id).sort() };
      },
    };
    server = net.createServer(socket => {
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk;
        let newline;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          let request;
          try { request = JSON.parse(line); } catch { socket.write(JSON.stringify({ ok: false, error: 'bad json' }) + '\n'); continue; }
          Promise.resolve().then(() => {
            const handler = handlers[request.method];
            if (!handler) throw new Error('unknown method');
            return handler(request.params ?? {});
          }).then(result => {
            log({ method: request.method, params: request.params, result });
            socket.write(JSON.stringify({ id: request.id, ok: true, result }) + '\n');
          }, error => {
            log({ method: request.method, params: request.params, error: String(error.message ?? error) });
            socket.write(JSON.stringify({ id: request.id, ok: false, error: String(error.message ?? error) }) + '\n');
          });
        }
      });
    });
    try { fs.unlinkSync(socketPath); } catch { /* none */ }
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    fs.chmodSync(socketPath, 0o600);
    log({ event: 'control socket listening', location: ctx.location.directory });
    return async () => {
      contexts.delete(ctx.location.directory);
      server.close();
      server = undefined;
      try { fs.unlinkSync(socketPath); } catch { /* gone */ }
      if (typeof cleanup === 'function') await cleanup();
    };
  },
});
