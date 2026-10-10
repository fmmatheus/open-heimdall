// Runs INSIDE the guarded launch wrapper (guard.mjs probe). Executes the attempts listed in a plan
// file and prints one JSON document. It never reads credential values; it only reports whether
// each attempt was denied. Disposable targets only: see guard.mjs for how they are seeded.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openLedger, recordCreated } from './ownership.mjs';

const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const results = [];

// A guarded write that SUCCEEDS means the guard failed. Whatever it created is recorded in the ownership ledger
// (intent first, then dev/ino of what exists) so the outer cleanup can remove exactly that and nothing else.
const ledger = plan.ledger ? openLedger(plan.ledger) : null;
const creates = new Set(['create', 'mkdir', 'symlink', 'hardlink', 'rename']);

function attempt(entry) {
  const { target, op } = entry;
  const destination = op === 'rename' ? `${target}.renamed` : target;
  let identity = null;
  try {
    if (ledger && creates.has(op)) ledger.intent(destination, op);
    if (op === 'rename') { const stat = fs.lstatSync(target); identity = { dev: stat.dev, ino: stat.ino }; }
    if (op === 'create') fs.closeSync(fs.openSync(target, 'wx'));
    else if (op === 'overwrite') { const fd = fs.openSync(target, 'r+'); fs.writeSync(fd, 'GUARD-PROBE-OVERWRITE'); fs.closeSync(fd); }
    else if (op === 'truncate') fs.truncateSync(target, 0);
    else if (op === 'append') fs.appendFileSync(target, 'GUARD-PROBE-APPEND');
    else if (op === 'unlink') fs.unlinkSync(target);
    else if (op === 'rename') fs.renameSync(target, `${target}.renamed`);
    else if (op === 'chmod') fs.chmodSync(target, 0o666);
    else if (op === 'mkdir') fs.mkdirSync(target);
    else if (op === 'symlink') fs.symlinkSync('/nonexistent', target);
    else if (op === 'hardlink') fs.linkSync(entry.source, target);
    else throw new Error(`unknown op ${op}`);
    return { denied: false, ...record(destination, op, identity) };
  } catch (error) {
    return { denied: error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EROFS', errno: error.code ?? String(error.message).slice(0, 60) };
  }
}

// Ownership of what a successful guarded write created. A rename may overwrite a foreign destination, so it is
// claimed only when the destination is the very inode that was renamed; the others fail on an existing path.
function record(destination, op, identity) {
  if (!ledger || !creates.has(op)) return {};
  try { return { created: recordCreated(plan.ledger, destination, op, identity) }; } catch { return { created: false, ledgerError: true }; }
}

for (const entry of plan.writes) results.push({ kind: 'write', label: entry.label, class: entry.class, op: entry.op, target: entry.target, expected: entry.expect ?? 'denied', ...attempt(entry) });

for (const entry of plan.execs) {
  const run = spawnSync(entry.command, entry.args, { encoding: 'utf8', timeout: 30_000, env: process.env });
  results.push({
    kind: 'exec', label: entry.label, class: entry.class, command: entry.display ?? entry.command, expected: entry.expect ?? 'denied',
    exitCode: run.status, signal: run.signal, requiresStatus: entry.requiresStatus === true,
    osStatus: (run.stdout ?? '').match(/OSSTATUS=(-?\d+)/) ? Number((run.stdout ?? '').match(/OSSTATUS=(-?\d+)/)[1]) : null, spawnError: run.error?.code ?? null,
    // The read probe reports only whether the disposable fake values are present; stdout is never returned.
    sawFakeAccessToken: /FAKE-ACCESS-0005/.test(run.stdout ?? ''), sawFakeRefreshToken: /FAKE-REFRESH-0005/.test(run.stdout ?? ''),
    stderrFirstLine: (run.stderr ?? '').split('\n')[0].replaceAll(plan.root, '<root>').slice(0, 160),
  });
}

// Positive controls: the guard must not be a blanket failure.
const control = path.join(plan.root, 'profile', 'tmp', 'guard-control.txt');
let controlWrite = false;
try { fs.writeFileSync(control, 'ok'); controlWrite = fs.readFileSync(control, 'utf8') === 'ok'; } catch { /* reported below */ }
process.stdout.write(JSON.stringify({ results, controls: { fixtureWriteAllowed: controlWrite, node: process.version } }) + '\n');
