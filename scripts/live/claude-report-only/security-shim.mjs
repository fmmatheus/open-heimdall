#!/usr/bin/env node
// Stand-in for /usr/bin/security inside the guard. Installed as guard/bin/security (first on PATH).
// It forwards argv to the read-only broker; the sandbox denies the real binary and securityd.
import net from 'node:net';

const socketPath = process.env.HEIMDALL_GUARD_BROKER;
if (!socketPath) {
  process.stderr.write('security: no guard broker configured\n');
  process.exit(1);
}
const socket = net.createConnection(socketPath);
let buffer = '';
const timer = setTimeout(() => { process.stderr.write('security: guard broker timed out\n'); process.exit(1); }, 30_000);
socket.setEncoding('utf8');
socket.on('connect', () => socket.write(JSON.stringify({ argv: process.argv.slice(2) }) + '\n'));
socket.on('data', chunk => { buffer += chunk; });
socket.on('error', error => { process.stderr.write(`security: guard broker unavailable (${error.code ?? error.message})\n`); process.exit(1); });
socket.on('close', () => {
  clearTimeout(timer);
  try {
    const response = JSON.parse(buffer);
    if (response.stdout) process.stdout.write(response.stdout);
    if (response.stderr) process.stderr.write(response.stderr);
    process.exitCode = typeof response.code === 'number' ? response.code : 1;
  } catch {
    process.stderr.write('security: invalid guard broker response\n');
    process.exitCode = 1;
  }
});
