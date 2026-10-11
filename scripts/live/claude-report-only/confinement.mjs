// Startup boundary check for the session-capable host (server.mjs).
//
// `guard.mjs launch` is the supported way to start the server: it wraps the command in
// `/usr/bin/sandbox-exec -f guard/profile.sb`. sandbox-exec sets no environment marker, so confinement is
// proven by BEHAVIOUR of the running process, never by an environment variable or a manifest flag:
//   1. a write into <root>/guard is denied (EPERM)         profile rule 2
//   2. a write beside the fixture root is denied (EPERM)   profile rule 1 (default-deny file writes)
//   3. exec of /usr/bin/security is denied (EPERM)         profile rule 4
//   4. a write inside the fixture root is allowed          positive control, so a blanket failure cannot pass
// and the guard material must be intact: the recorded profile and shim hash to the manifest's guardInstall
// values, and the profile equals the one regenerated for this root and home.
// Every object the check creates (it creates real ones when unconfined) is owned through the ownership ledger
// and removed before the verdict is returned; an unconfirmed removal also fails the check.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildProfile, guardPaths } from './guard.mjs';
import { sha256 } from './lib.mjs';
import { cleanupOwned, createExclusiveFile, newNonce, openLedger } from './ownership.mjs';

const SECURITY = '/usr/bin/security';
const denied = error => error?.code === 'EPERM';

export function verifyGuardMaterial({ root, home, manifest }) {
  const problems = [];
  const install = manifest?.guardInstall;
  const hex = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
  if (!install || !hex(install.profile) || !hex(install.shim)) return ['manifest has no valid guardInstall hashes (run guard.mjs install)'];
  const paths = guardPaths(root);
  let profile; let shim;
  try { profile = fs.readFileSync(paths.profile); } catch { problems.push('guard/profile.sb is missing or unreadable'); }
  try { shim = fs.readFileSync(paths.shim); } catch { problems.push('guard/bin/security shim is missing or unreadable'); }
  if (profile) {
    if (sha256(profile) !== install.profile) problems.push('guard/profile.sb does not match the recorded hash');
    if (profile.toString('utf8') !== buildProfile({ root, home })) problems.push('guard/profile.sb is not the profile generated for this root and home');
  }
  if (shim) {
    if (sha256(shim) !== install.shim) problems.push('guard/bin/security does not match the recorded hash');
    if ((fs.statSync(paths.shim).mode & 0o100) === 0) problems.push('guard/bin/security is not executable');
  }
  return problems;
}

// Returns { confined, problems, checks, cleanup }. Never throws for an unconfined or misconfigured process.
export function proveConfinement({ root, home, manifest, spawn = spawnSync, nonce = newNonce() }) {
  const problems = verifyGuardMaterial({ root, home, manifest });
  const checks = { material: problems.length === 0 };
  if (problems.length > 0) return { confined: false, problems, checks, cleanup: null };
  const ledgerFile = path.join(root, 'evidence', `confinement-${nonce}.jsonl`);
  let ledger;
  let cleanup = null;
  try {
    ledger = openLedger(ledgerFile);
    const attempt = (name, target, expectation) => {
      try {
        createExclusiveFile(ledger, target, 'heimdall-confinement-sentinel\n', { op: `confinement:${name}` });
        checks[name] = 'allowed';
      } catch (error) {
        checks[name] = denied(error) ? 'denied' : `error:${error.code ?? 'unknown'}`;
      }
      if (checks[name] !== expectation) problems.push(`${name}: expected ${expectation}, observed ${checks[name]}`);
    };
    attempt('guardDirectoryWrite', path.join(root, 'guard', `.confine-${nonce}`), 'denied');
    attempt('writeOutsideFixtureRoot', path.join(path.dirname(root), `.heimdall-confine-${nonce}`), 'denied');
    attempt('fixtureRootWrite', path.join(root, `.confine-allowed-${nonce}`), 'allowed');
    const run = spawn(SECURITY, ['-h'], { encoding: 'utf8', timeout: 10_000 });
    checks.securityExec = run.error ? (denied(run.error) ? 'denied' : `error:${run.error.code ?? 'unknown'}`) : 'allowed';
    if (checks.securityExec !== 'denied') problems.push(`securityExec: expected denied, observed ${checks.securityExec}`);
  } catch (error) {
    problems.push(`confinement check failed: ${String(error.code ?? error.message)}`);
  } finally {
    cleanup = ledger ? cleanupOwned({ ledgerFile }) : null;
    if (cleanup && !cleanup.confirmed) problems.push(`confinement check could not remove what it created: ${[...cleanup.preserved.map(entry => entry.reason), ...cleanup.errors.map(entry => entry.error)].join('; ')}`);
  }
  return { confined: problems.length === 0, problems, checks, cleanup };
}
