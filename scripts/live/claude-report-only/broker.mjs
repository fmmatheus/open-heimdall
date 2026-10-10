// Read-only Keychain broker for the guarded Claude CLI.
//
// The sandboxed Claude CLI may not call /usr/bin/security or talk to securityd (see guard.mjs), so
// its `security` calls go through the shim in guard/bin to this broker, which runs OUTSIDE the
// sandbox and forwards exactly two read-only requests:
//   security find-generic-password -a <user> -w -s "Claude Code[-suffix]"   (credential read)
//   security show-keychain-info                                             (metadata)
// Everything else (add/delete/import/set-*, other services, extra arguments) is refused.
//
// The credential read is filtered in memory before it reaches the sandbox: only the claudeAiOauth
// object is returned, and every refresh-token key is removed. Without a refresh token the guarded
// CLI can neither refresh nor rotate the stored login. Secret values are never logged or written.
//
//   node broker.mjs --root R --login real                     # the existing login (production)
//   node broker.mjs --root R --login disposable --keychain K  # disposable keychain (guard probes)
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { assertFixtureRoot, emit, parseArguments, updateManifest } from './lib.mjs';

const SERVICE = /^Claude Code(?:-[A-Za-z0-9._-]+)?$/;
const REFRESH_KEY = /refresh.?token/i;

export function classify(argv, account) {
  if (!Array.isArray(argv) || argv.some(argument => typeof argument !== 'string')) return { kind: 'deny', reason: 'malformed request' };
  if (argv.length === 1 && argv[0] === 'show-keychain-info') return { kind: 'info' };
  if (argv[0] !== 'find-generic-password') return { kind: 'deny', reason: `write or unsupported subcommand: ${String(argv[0]).slice(0, 40)}` };
  // Exactly -a <account> -s <service> -w, in any order.
  const rest = argv.slice(1);
  const flags = { a: null, s: null, w: false };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '-w' && !flags.w) flags.w = true;
    else if ((flag === '-a' || flag === '-s') && flags[flag[1]] === null && index + 1 < rest.length) { flags[flag[1]] = rest[index + 1]; index += 1; }
    else return { kind: 'deny', reason: 'unexpected find-generic-password arguments' };
  }
  if (!flags.w || flags.a !== account || flags.s === null || !SERVICE.test(flags.s)) return { kind: 'deny', reason: 'credential read not in the allowlist' };
  return { kind: 'read-credential', account: flags.a, service: flags.s };
}

function stripRefresh(value) {
  if (Array.isArray(value)) return value.map(stripRefresh);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !REFRESH_KEY.test(key)).map(([key, inner]) => [key, stripRefresh(inner)]));
  }
  return value;
}

// Returns the filtered JSON text or null (fail closed) plus a coarse expiry bucket.
export function filterCredential(text) {
  let parsed;
  for (const candidate of [text.trim(), Buffer.from(text.trim(), 'hex').toString('utf8')]) {
    try { parsed = JSON.parse(candidate); break; } catch { /* try the hex form next */ }
  }
  if (!parsed || typeof parsed !== 'object' || !parsed.claudeAiOauth || typeof parsed.claudeAiOauth !== 'object') return null;
  const oauth = stripRefresh(parsed.claudeAiOauth);
  const remaining = typeof oauth.expiresAt === 'number' ? oauth.expiresAt - Date.now() : null;
  const bucket = remaining === null ? 'unknown' : remaining <= 0 ? 'expired' : remaining < 3_600_000 ? '<1h' : remaining < 86_400_000 ? '<24h' : '>=24h';
  return { text: JSON.stringify({ claudeAiOauth: oauth }), bucket };
}

function runSecurity(args, timeoutMs = 20_000) {
  return new Promise(resolve => {
    const child = spawn('/usr/bin/security', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
    child.on('error', error => { clearTimeout(timer); resolve({ code: 1, stdout: '', stderr: String(error.message) }); });
  });
}

export async function handle(argv, options) {
  const decision = classify(argv, options.account);
  const entry = { at: new Date().toISOString(), verb: String(argv?.[0] ?? ''), decision: decision.kind };
  let response;
  if (decision.kind === 'deny') {
    response = { code: 1, stdout: '', stderr: `security: refused by the report-only credential guard (${decision.reason})\n` };
  } else if (decision.kind === 'info') {
    const result = await runSecurity(['show-keychain-info', ...(options.keychain ? [options.keychain] : [])]);
    response = { code: result.code, stdout: '', stderr: result.stderr };
  } else {
    const result = await runSecurity([...argv, ...(options.keychain ? [options.keychain] : [])]);
    entry.exitCode = result.code;
    if (result.code !== 0 || !result.stdout.trim()) {
      response = { code: result.code, stdout: '', stderr: '' };
    } else {
      const filtered = filterCredential(result.stdout);
      entry.expiry = filtered?.bucket ?? 'unparsable';
      response = filtered ? { code: 0, stdout: filtered.text + '\n', stderr: '' } : { code: 1, stdout: '', stderr: 'security: credential could not be parsed; withheld\n' };
    }
  }
  entry.code = response.code;
  options.log?.(entry);
  return response;
}

export function serve(options) {
  const server = net.createServer(socket => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 65_536) { socket.destroy(); return; }
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      let argv;
      try { argv = JSON.parse(buffer.slice(0, newline)).argv; } catch { argv = null; }
      handle(argv, options).then(response => socket.end(JSON.stringify(response) + '\n'), () => socket.end(JSON.stringify({ code: 1, stdout: '', stderr: 'broker error\n' }) + '\n'));
    });
    socket.on('error', () => {});
  });
  return new Promise(resolve => {
    fs.rmSync(options.socket, { force: true });
    server.listen(options.socket, () => { fs.chmodSync(options.socket, 0o600); resolve(server); });
  });
}

if (import.meta.url === new URL(process.argv[1], 'file://').href) {
  const parsed = parseArguments(process.argv.slice(2));
  const root = assertFixtureRoot(parsed.root ?? '');
  if (parsed.login !== 'real' && parsed.login !== 'disposable') throw new Error('--login real|disposable is required');
  if (parsed.login === 'disposable' && !parsed.keychain) throw new Error('--keychain is required for a disposable login');
  if (parsed.login === 'real' && parsed.keychain) throw new Error('--keychain is only valid with --login disposable');
  const socket = path.join(root, 'guard', 'broker.sock');
  const logFile = path.join(root, 'evidence', `broker-${parsed.login}.log`);
  // Only verbs, decisions, exit codes and a coarse expiry bucket are logged. Never values.
  const log = entry => fs.appendFileSync(logFile, JSON.stringify(entry) + '\n', { mode: 0o600 });
  const server = await serve({ socket, account: os.userInfo().username, keychain: parsed.keychain || null, log });
  fs.writeFileSync(path.join(root, 'guard', 'broker.pid'), String(process.pid), { mode: 0o600 });
  updateManifest(root, manifest => { manifest.processes.push({ role: `keychain-broker-${parsed.login}`, pid: process.pid, socket: '<root>/guard/broker.sock', startedAt: new Date().toISOString() }); });
  const stop = () => { server.close(); fs.rmSync(socket, { force: true }); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  emit({ ready: true, pid: process.pid, login: parsed.login });
}
