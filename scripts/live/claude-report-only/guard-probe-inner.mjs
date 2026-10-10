// Runs INSIDE the guarded launch wrapper (guard.mjs probe). Executes the attempts listed in a plan
// file and prints one JSON document. It never reads credential values; it only reports whether
// each attempt was denied. Disposable targets only: see guard.mjs for how they are seeded.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const results = [];

function attempt(entry) {
  const { target, op } = entry;
  try {
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
    return { denied: false };
  } catch (error) {
    return { denied: error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'EROFS', errno: error.code ?? String(error.message).slice(0, 60) };
  }
}

for (const entry of plan.writes) results.push({ kind: 'write', label: entry.label, class: entry.class, op: entry.op, expected: entry.expect ?? 'denied', ...attempt(entry) });

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
