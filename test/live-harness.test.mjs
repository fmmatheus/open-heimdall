// Safety tests for the claude-code live verification harness (scripts/live/claude-report-only).
// Synthetic directories only: temporary roots, a synthetic HOME, stub children. No Claude login, no real
// Keychain, no model call, and nothing under the real HOME is read or written.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const harness = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'live', 'claude-report-only');
const load = name => import(path.join(harness, name));
const { cleanupOwned, createExclusiveDirectory, createExclusiveFile, newNonce, openLedger, probeOutcome, readLedger, recordCreated } = await load('ownership.mjs');
const { proveConfinement, verifyGuardMaterial } = await load('confinement.mjs');
const { FINAL_PROVIDER_LIST, HISTORICAL_PROVIDER_LIST, prepareProviderList } = await load('provider-list.mjs');
const { FORMAT_REPAIR_LIMIT, compactionVerdict, countFormatCorrections } = await load('compaction-verdict.mjs');
const { guardPaths, guardedCommand, install } = await load('guard.mjs');
const { FIXTURE_PREFIX, assertFixtureRoot, writeManifest, updateManifest, readManifest, sha256 } = await load('lib.mjs');

const temporary = [];
const scratch = (prefix = 'heimdall-live-harness-') => { const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix)); temporary.push(directory); return directory; };
after(() => { for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true }); });
const write = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; };
const present = file => { try { fs.lstatSync(file); return true; } catch { return false; } };

// Synthetic user state plus a ledger, all under one temporary directory.
function synthetic() {
  const base = scratch();
  const home = path.join(base, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const ledgerFile = path.join(base, 'evidence', 'ownership.jsonl');
  return { base, home, ledgerFile, ledger: openLedger(ledgerFile) };
}

describe('ownership based cleanup', () => {
  test('an absent class directory created by another process before cleanup survives with its marker', () => {
    const { home, ledger, ledgerFile } = synthetic();
    const classDirectory = path.join(home, '.claude', 'todos');
    ledger.intent(classDirectory, 'mkdir'); // the guarded probe attempted this mkdir; the guard denied it
    const foreign = spawnSync(process.execPath, ['-e', `const fs=require('node:fs');fs.mkdirSync(${JSON.stringify(classDirectory)});fs.writeFileSync(${JSON.stringify(path.join(classDirectory, 'marker.txt'))},'FOREIGN-MARKER');`]);
    assert.equal(foreign.status, 0);
    const result = cleanupOwned({ ledgerFile });
    assert.equal(result.confirmed, true);
    assert.deepEqual(result.removed, []);
    assert.equal(fs.readFileSync(path.join(classDirectory, 'marker.txt'), 'utf8'), 'FOREIGN-MARKER');
    assert.deepEqual(result.foreignPreserved.map(entry => entry.path), [classDirectory]);
  });

  test('a directory the probe really created is removed, but never when it holds foreign content', () => {
    const { home, ledger, ledgerFile } = synthetic();
    const empty = path.join(home, '.claude', 'todos');
    const filled = path.join(home, '.claude', 'plugins');
    createExclusiveDirectory(ledger, empty);
    createExclusiveDirectory(ledger, filled);
    write(path.join(filled, 'user-file.txt'), 'USER-DATA');
    const result = cleanupOwned({ ledgerFile });
    assert.equal(present(empty), false);
    assert.equal(fs.readFileSync(path.join(filled, 'user-file.txt'), 'utf8'), 'USER-DATA');
    assert.equal(result.confirmed, false);
    assert.match(result.preserved[0].reason, /not empty/);
    assert.deepEqual(result.removed, [empty]);
  });

  test('pre-existing sibling, renamed and lock files survive; only the owned seed is removed', () => {
    const { home, ledger, ledgerFile } = synthetic();
    const tag = `heimdall-0006-probe-${newNonce()}`;
    const seed = path.join(home, '.claude', `${tag}.json`);
    createExclusiveFile(ledger, seed, 'DISPOSABLE');
    const lock = path.join(home, `.claude.json.${tag}.lock`);
    const bystanders = [`${seed}.sibling`, `${seed}.renamed`, lock].map(file => write(file, `FOREIGN ${path.basename(file)}`));
    const result = cleanupOwned({ ledgerFile });
    assert.equal(result.confirmed, true);
    assert.deepEqual(result.removed, [seed]);
    for (const file of bystanders) assert.equal(fs.readFileSync(file, 'utf8'), `FOREIGN ${path.basename(file)}`);
  });

  test('an owned file replaced by another file or by a symlink is preserved and reported as a failure', () => {
    const { home, ledger, ledgerFile } = synthetic();
    const replaced = path.join(home, '.claude', 'replaced.json');
    const linked = path.join(home, '.claude', 'linked.json');
    createExclusiveFile(ledger, replaced, 'MINE');
    createExclusiveFile(ledger, linked, 'MINE');
    fs.unlinkSync(replaced);
    write(replaced, 'FOREIGN-REPLACEMENT');
    fs.unlinkSync(linked);
    const victim = write(path.join(home, 'victim.txt'), 'VICTIM-MARKER');
    fs.symlinkSync(victim, linked);
    const result = cleanupOwned({ ledgerFile });
    assert.equal(result.confirmed, false);
    assert.equal(fs.readFileSync(replaced, 'utf8'), 'FOREIGN-REPLACEMENT');
    assert.equal(fs.lstatSync(linked).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'VICTIM-MARKER');
    assert.deepEqual(result.preserved.map(entry => entry.reason).sort(), ['replaced by a different object', 'replaced by a symlink']);
  });

  test('a deterministic dev/ino collision with another birthtime preserves the foreign replacement', () => {
    const { home, ledger, ledgerFile } = synthetic();
    const replaced = path.join(home, '.claude', 'incarnation.json');
    createExclusiveFile(ledger, replaced, 'MINE');
    fs.unlinkSync(replaced);
    write(replaced, 'FOREIGN-REPLACEMENT');
    const current = fs.lstatSync(replaced, { bigint: true });
    const entries = readLedger(ledgerFile), owned = entries.find(entry => entry.event === 'owned');
    // Model inode reuse deterministically, without depending on the filesystem allocator.
    owned.dev = String(current.dev); owned.ino = String(current.ino);
    owned.birthtimeNs = String(current.birthtimeNs - 1n);
    fs.writeFileSync(ledgerFile, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    const result = cleanupOwned({ ledgerFile });
    assert.equal(result.confirmed, false);
    assert.deepEqual(result.removed, []);
    assert.equal(result.preserved[0].reason, 'replaced by a different object');
    assert.equal(fs.readFileSync(replaced, 'utf8'), 'FOREIGN-REPLACEMENT');
  });

  test('legacy and unavailable birthtime identities preserve present objects without upgrading by observation', () => {
    for (const incarnation of [undefined, null, '0']) {
      const { home, ledger, ledgerFile } = synthetic();
      const file = path.join(home, '.claude', 'legacy.json');
      createExclusiveFile(ledger, file, 'PRESERVE');
      const entries = readLedger(ledgerFile), owned = entries.find(entry => entry.event === 'owned');
      owned.birthtimeNs = incarnation;
      fs.writeFileSync(ledgerFile, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
      const before = fs.readFileSync(ledgerFile, 'utf8');
      const result = cleanupOwned({ ledgerFile });
      assert.equal(result.confirmed, false);
      assert.match(result.preserved[0].reason, /missing or unavailable/);
      assert.equal(fs.readFileSync(file, 'utf8'), 'PRESERVE');
      assert.equal(fs.readFileSync(ledgerFile, 'utf8'), before, 'cleanup cannot add a current incarnation to an old record');
      fs.unlinkSync(file);
      assert.deepEqual(cleanupOwned({ ledgerFile }).alreadyRemoved, [file]);
      write(file, 'FOREIGN-AFTER-RELEASE');
      assert.deepEqual(cleanupOwned({ ledgerFile }).removed, []);
      assert.equal(fs.readFileSync(file, 'utf8'), 'FOREIGN-AFTER-RELEASE');
    }
  });

  test('rename claims require the complete matching recorded incarnation', () => {
    const { home, ledger, ledgerFile } = synthetic();
    const source = path.join(home, '.claude', 'rename-source.json');
    const destination = path.join(home, '.claude', 'rename-destination.json');
    const identity = createExclusiveFile(ledger, source, 'MINE');
    fs.renameSync(source, destination);
    assert.equal(recordCreated(ledgerFile, destination, 'rename'), false);
    assert.equal(recordCreated(ledgerFile, destination, 'rename', { dev: identity.dev, ino: identity.ino }), false);
    assert.equal(recordCreated(ledgerFile, destination, 'rename', { ...identity, birthtimeNs: String(BigInt(identity.birthtimeNs) + 1n) }), false);
    assert.equal(recordCreated(ledgerFile, destination, 'rename', identity), true);
    assert.equal(cleanupOwned({ ledgerFile }).confirmed, true);
  });

  test('releasing an earlier incarnation cannot release a later same-inode ownership record', () => {
    const { home, ledger, ledgerFile } = synthetic();
    const file = path.join(home, '.claude', 'release.json');
    createExclusiveFile(ledger, file, 'MINE');
    const owned = readLedger(ledgerFile).find(entry => entry.event === 'owned');
    const earlier = { ...owned, birthtimeNs: String(BigInt(owned.birthtimeNs) - 1n) };
    const entries = [earlier, owned, { event: 'released', path: earlier.path, dev: earlier.dev, ino: earlier.ino, birthtimeNs: earlier.birthtimeNs }];
    fs.writeFileSync(ledgerFile, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n');
    assert.deepEqual(cleanupOwned({ ledgerFile }).removed, [file]);
    const release = readLedger(ledgerFile).filter(entry => entry.event === 'released').at(-1);
    assert.equal(release.birthtimeNs, owned.birthtimeNs);
  });

  test('a parent directory swapped for a symlink makes cleanup preserve instead of following it', () => {
    const { home, ledger, ledgerFile } = synthetic();
    const directory = path.join(home, '.claude', 'projects');
    fs.mkdirSync(directory);
    const owned = path.join(directory, 'seed.jsonl');
    createExclusiveFile(ledger, owned, 'MINE');
    const elsewhere = path.join(home, 'elsewhere');
    fs.mkdirSync(elsewhere);
    const decoy = write(path.join(elsewhere, 'seed.jsonl'), 'DECOY-MARKER');
    fs.renameSync(directory, `${directory}.moved`);
    fs.symlinkSync(elsewhere, directory);
    const result = cleanupOwned({ ledgerFile });
    assert.equal(result.confirmed, false);
    assert.equal(fs.readFileSync(decoy, 'utf8'), 'DECOY-MARKER');
    assert.equal(fs.readFileSync(path.join(`${directory}.moved`, 'seed.jsonl'), 'utf8'), 'MINE');
  });

  test('partial setup cleans only what was created', () => {
    const { home, ledger, ledgerFile } = synthetic();
    const first = path.join(home, '.claude', 'a.json');
    const second = path.join(home, '.claude', 'b.json');
    const preexisting = write(path.join(home, '.claude', 'c.json'), 'FOREIGN-C');
    assert.throws(() => {
      createExclusiveFile(ledger, first, 'A');
      createExclusiveFile(ledger, second, 'B');
      createExclusiveFile(ledger, preexisting, 'C'); // EEXIST: setup aborts mid-seed
    }, { code: 'EEXIST' });
    const result = cleanupOwned({ ledgerFile });
    assert.equal(result.confirmed, true);
    assert.deepEqual(result.removed.sort(), [first, second]);
    assert.equal(fs.readFileSync(preexisting, 'utf8'), 'FOREIGN-C');
  });

  test('cleanup is idempotent and never removes an object that appears at a released path', () => {
    const { home, ledger, ledgerFile } = synthetic();
    const seed = path.join(home, '.claude', 'seed.json');
    createExclusiveFile(ledger, seed, 'MINE');
    assert.deepEqual(cleanupOwned({ ledgerFile }).removed, [seed]);
    const again = cleanupOwned({ ledgerFile });
    assert.deepEqual(again.removed, []);
    assert.equal(again.confirmed, true);
    write(seed, 'FOREIGN-LATER');
    const third = cleanupOwned({ ledgerFile });
    assert.deepEqual(third.removed, []);
    assert.equal(fs.readFileSync(seed, 'utf8'), 'FOREIGN-LATER');
  });

  test('an owned object that vanished is reported as already removed', () => {
    const { home, ledger, ledgerFile } = synthetic();
    const seed = path.join(home, '.claude', 'gone.json');
    createExclusiveFile(ledger, seed, 'MINE');
    fs.unlinkSync(seed);
    const result = cleanupOwned({ ledgerFile });
    assert.deepEqual(result.alreadyRemoved, [seed]);
    assert.equal(result.confirmed, true);
  });

  test('an object a guarded write created is owned by its recorded identity; a rename over a foreign file is not claimed', () => {
    const { home, ledgerFile } = synthetic();
    const created = path.join(home, '.claude', 'created-by-guard-failure.json');
    write(created, 'LEAKED');
    assert.equal(recordCreated(ledgerFile, created, 'create'), true);
    const destination = write(path.join(home, '.claude', 'dest.renamed'), 'FOREIGN-DEST');
    const source = write(path.join(home, '.claude', 'source'), 'SOURCE');
    const stat = fs.lstatSync(source, { bigint: true });
    const identity = { dev: String(stat.dev), ino: String(stat.ino), birthtimeNs: String(stat.birthtimeNs) };
    assert.equal(recordCreated(ledgerFile, destination, 'rename', identity), false);
    const result = cleanupOwned({ ledgerFile });
    assert.deepEqual(result.removed, [created]);
    assert.equal(fs.readFileSync(destination, 'utf8'), 'FOREIGN-DEST');
    assert.equal(readLedger(ledgerFile).filter(entry => entry.event === 'owned').length, 1);
  });

  test('the probe outcome is guard proven only when every gate passed and cleanup is confirmed', () => {
    const confirmed = { confirmed: true, preserved: [], errors: [] };
    const unconfirmed = { confirmed: false, preserved: [{ path: '/x', reason: 'replaced by a symlink' }], errors: [] };
    assert.equal(probeOutcome({ failures: [], cleanup: confirmed }), 'guard proven');
    assert.match(probeOutcome({ failures: [], cleanup: unconfirmed }), /^refused: cleanup unconfirmed \(replaced by a symlink\)/);
    assert.match(probeOutcome({ failures: ['write x'], cleanup: confirmed }), /^failed gate: write x/);
    assert.match(probeOutcome({ failures: [], cleanup: null }), /^refused: cleanup unconfirmed/);
    assert.notEqual(probeOutcome({ failures: [], cleanup: { confirmed: false, preserved: [], errors: [{ path: '/x', error: 'EBUSY' }] } }), 'guard proven');
  });

  test('probe names are unique per run and the harness never removes recursively', () => {
    assert.notEqual(newNonce(), newNonce());
    const guard = fs.readFileSync(path.join(harness, 'guard.mjs'), 'utf8');
    assert.doesNotMatch(guard, /heimdall-0005-probe/);
    for (const name of fs.readdirSync(harness).filter(entry => entry.endsWith('.mjs'))) {
      const source = fs.readFileSync(path.join(harness, name), 'utf8');
      assert.doesNotMatch(source, /rmSync\([^)]*recursive/, `${name} must not remove recursively`);
    }
  });
});

// A disposable fixture root with a recorded guard profile for a synthetic home.
function fixtureRoot() {
  const root = fs.mkdtempSync(path.join('/private/tmp', FIXTURE_PREFIX));
  temporary.push(root);
  const home = scratch('heimdall-live-home-');
  for (const directory of ['guard', 'evidence', 'native-host']) fs.mkdirSync(path.join(root, directory), { recursive: true, mode: 0o700 });
  writeManifest(root, { root, processes: [], outcome: 'pending', hostModules: null });
  install(root, home);
  return { root, home };
}
const stubHost = root => {
  const marker = path.join(root, 'host-imported.marker');
  const directory = path.join(root, 'native-host', 'node_modules', '@opencode', 'server');
  write(path.join(directory, 'package.json'), JSON.stringify({ name: '@opencode/server', version: '0.0.0', type: 'module', exports: { './fetch': './fetch.js' } }));
  write(path.join(directory, 'fetch.js'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'imported'); export const ServerFetch = {};\n`);
  updateManifest(root, manifest => { manifest.hostModules = { link: path.join(root, 'native-host', 'node_modules'), openCodeServerVersion: '0.0.0', readOnlySymlink: true }; });
  return marker;
};
const sandboxUsable = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']).status === 0;
const server = path.join(harness, 'server.mjs');
const runServer = (root, home, { runtime = process.execPath, env = {}, wrap = null } = {}) => {
  const environment = { ...process.env, HOME: home, ...env };
  if (wrap) {
    const wrapped = guardedCommand(root, runtime, [server, '--root', root]);
    return spawnSync(wrapped.command, wrapped.args, { env: { ...wrapped.env, HOME: home, ...env }, encoding: 'utf8', cwd: root, timeout: 60_000 });
  }
  return spawnSync(runtime, [server, '--root', root], { env: environment, encoding: 'utf8', cwd: root, timeout: 60_000 });
};

describe('guarded startup boundary', { skip: process.platform !== 'darwin' && 'requires the macOS confinement fixture' }, () => {
  test('the check refuses an unconfined process and removes every object it created', () => {
    const { root, home } = fixtureRoot();
    const nonce = 'unconfined1';
    const result = proveConfinement({ root, home, manifest: readManifest(root), nonce });
    assert.equal(result.confined, false);
    assert.equal(result.checks.guardDirectoryWrite, 'allowed');
    assert.equal(result.checks.writeOutsideFixtureRoot, 'allowed');
    assert.equal(result.checks.securityExec, 'allowed');
    assert.equal(result.cleanup.confirmed, true);
    for (const leftover of [path.join(root, 'guard', `.confine-${nonce}`), path.join(path.dirname(root), `.heimdall-confine-${nonce}`), path.join(root, `.confine-allowed-${nonce}`)]) assert.equal(present(leftover), false, leftover);
  });

  test('server.mjs refuses before loading any host module or creating any store when unconfined', () => {
    const { root, home } = fixtureRoot();
    const marker = stubHost(root);
    const run = runServer(root, home);
    assert.equal(run.status, 3, run.stderr);
    assert.match(run.stderr, /Refusing to start: not confined/);
    assert.equal(present(marker), false, 'the host module stub must never be imported');
    assert.equal(present(path.join(root, 'native-server.json')), false);
    assert.equal(present(path.join(root, 'profile', 'data')), false);
  });

  test('spoofed environment and manifest flags do not satisfy the check', () => {
    const { root, home } = fixtureRoot();
    const marker = stubHost(root);
    updateManifest(root, manifest => { Object.assign(manifest, { confined: true, sandboxed: true, guardLaunched: true, guard: { outcome: 'guard proven' }, outcome: 'guard proven' }); });
    const spoof = { HEIMDALL_GUARD: '1', HEIMDALL_GUARDED: '1', HEIMDALL_CONFINED: '1', HEIMDALL_GUARD_BROKER: guardPaths(root).socket, APP_SANDBOX_CONTAINER_ID: 'spoofed', SANDBOX_EXEC: '1' };
    const run = runServer(root, home, { env: spoof });
    assert.equal(run.status, 3, run.stderr);
    assert.match(run.stderr, /not confined/);
    assert.equal(present(marker), false);
    assert.equal(proveConfinement({ root, home, manifest: readManifest(root) }).confined, false);
  });

  test('missing or invalid guard material fails before any write is attempted', () => {
    const missing = fixtureRoot();
    fs.rmSync(guardPaths(missing.root).profile);
    assert.match(verifyGuardMaterial({ ...missing, manifest: readManifest(missing.root) }).join(';'), /profile\.sb is missing/);
    const result = proveConfinement({ ...missing, manifest: readManifest(missing.root), nonce: 'missing1' });
    assert.equal(result.confined, false);
    assert.equal(result.checks.guardDirectoryWrite, undefined, 'no sentinel was attempted');
    assert.equal(present(path.join(missing.root, 'evidence', 'confinement-missing1.jsonl')), false);

    const tampered = fixtureRoot();
    fs.appendFileSync(guardPaths(tampered.root).profile, '(allow file-write*)\n');
    assert.match(verifyGuardMaterial({ ...tampered, manifest: readManifest(tampered.root) }).join(';'), /does not match the recorded hash/);
    // Re-recording the hash of a profile that is not the generated one is still rejected.
    const profile = guardPaths(tampered.root).profile;
    updateManifest(tampered.root, manifest => { manifest.guardInstall.profile = sha256(fs.readFileSync(profile)); });
    assert.match(verifyGuardMaterial({ ...tampered, manifest: readManifest(tampered.root) }).join(';'), /not the profile generated for this root and home/);

    const noInstall = fixtureRoot();
    updateManifest(noInstall.root, manifest => { delete manifest.guardInstall; });
    assert.match(verifyGuardMaterial({ ...noInstall, manifest: readManifest(noInstall.root) }).join(';'), /no valid guardInstall/);
    const invalid = fixtureRoot();
    updateManifest(invalid.root, manifest => { manifest.guardInstall = { profile: 'zz', shim: 5 }; });
    assert.equal(proveConfinement({ ...invalid, manifest: readManifest(invalid.root) }).confined, false);
    stubHost(missing.root);
    const run = runServer(missing.root, missing.home);
    assert.equal(run.status, 3);
    assert.match(run.stderr, /profile\.sb is missing/);
  });

  test('a stub child passes the check under the real sandbox-exec profile', { skip: !sandboxUsable && 'sandbox-exec is not usable here' }, () => {
    const { root, home } = fixtureRoot();
    const stub = write(path.join(scratch(), 'stub-child.mjs'), `
      import fs from 'node:fs';
      const { proveConfinement } = await import(${JSON.stringify(path.join(harness, 'confinement.mjs'))});
      const manifest = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(root, 'manifest.json'))}, 'utf8'));
      const result = proveConfinement({ root: ${JSON.stringify(root)}, home: ${JSON.stringify(home)}, manifest, nonce: 'sandboxed1' });
      process.stdout.write(JSON.stringify({ confined: result.confined, problems: result.problems, checks: result.checks, cleanup: result.cleanup?.confirmed }) + '\\n');
    `);
    const wrapped = guardedCommand(root, process.execPath, [stub]);
    const run = spawnSync(wrapped.command, wrapped.args, { env: { ...wrapped.env, HOME: home }, encoding: 'utf8', cwd: root, timeout: 60_000 });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout.trim().split('\n').pop());
    assert.deepEqual(result.problems, []);
    assert.deepEqual(result.checks, { material: true, guardDirectoryWrite: 'denied', writeOutsideFixtureRoot: 'denied', fixtureRootWrite: 'allowed', securityExec: 'denied' });
    assert.equal(result.confined, true);
    assert.equal(result.cleanup, true);
    assert.equal(fs.readdirSync(path.join(root, 'guard')).some(name => name.startsWith('.confine-')), false);
  });

  test('server.mjs passes the boundary under the guard wrapper and only then reaches the Bun and host checks', { skip: !sandboxUsable && 'sandbox-exec is not usable here' }, () => {
    const { root, home } = fixtureRoot();
    const marker = stubHost(root);
    const run = runServer(root, home, { wrap: true });
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /needs Bun/);
    assert.doesNotMatch(run.stderr, /not confined/);
    assert.equal(present(marker), false, 'the host is still not imported without Bun');
  });

  test('a different, more permissive sandbox is not the recorded guard', { skip: !sandboxUsable && 'sandbox-exec is not usable here' }, () => {
    const { root, home } = fixtureRoot();
    const marker = stubHost(root);
    const run = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', process.execPath, server, '--root', root], { env: { ...process.env, HOME: home, HEIMDALL_GUARD_BROKER: guardPaths(root).socket }, encoding: 'utf8', cwd: root, timeout: 60_000 });
    assert.equal(run.status, 3, run.stderr);
    assert.equal(present(marker), false);
  });

  const bunPath = spawnSync('which', ['bun'], { encoding: 'utf8' }).stdout.trim();
  const bun = bunPath ? spawnSync(bunPath, ['--version'], { encoding: 'utf8' }) : { status: 1 };
  test('under the guard wrapper with Bun the stub host is imported only after the check passes', { skip: (!sandboxUsable || bun.status !== 0) && 'sandbox-exec or bun is not usable here' }, () => {
    const { root, home } = fixtureRoot();
    const marker = stubHost(root);
    const run = runServer(root, home, { runtime: bunPath, wrap: true });
    assert.doesNotMatch(run.stderr, /not confined/, run.stderr);
    assert.equal(present(marker), true, `the stub host should be reached once confinement is proven: ${run.stderr}`);
    assert.notEqual(run.status, 0, 'the stub host is not a real OpenCode server');
  });
});

describe('fixture provider list preparation', () => {
  const module = body => `// compiled\n${body}\nexport function x() { return VERIFIED_REPORT_ONLY_PROVIDERS.includes('claude-code'); }\n`;

  test('the historical empty list is rewritten to the final list and recorded as empty', () => {
    const prepared = prepareProviderList(module(HISTORICAL_PROVIDER_LIST));
    assert.equal(prepared.found, 'empty');
    assert.equal(prepared.patched, true);
    assert.match(prepared.text, /^export const VERIFIED_REPORT_ONLY_PROVIDERS = \['claude-code'\]; \/\/ FIXTURE-ONLY/m);
    assert.match(prepared.text, /export function x\(\)/);
  });

  test('the exact final list is accepted unchanged and recorded as claude-code', () => {
    const source = module(FINAL_PROVIDER_LIST);
    const prepared = prepareProviderList(source);
    assert.deepEqual({ found: prepared.found, patched: prepared.patched, same: prepared.text === source }, { found: 'claude-code', patched: false, same: true });
  });

  test('any other value, a missing declaration or a duplicate is rejected', () => {
    for (const body of [
      "export const VERIFIED_REPORT_ONLY_PROVIDERS = ['claude-code', 'other'];", "export const VERIFIED_REPORT_ONLY_PROVIDERS = ['other'];",
      'export const VERIFIED_REPORT_ONLY_PROVIDERS = [ ];', 'export const VERIFIED_REPORT_ONLY_PROVIDERS = new Set();',
      `${FINAL_PROVIDER_LIST} // trailing`, '// nothing here', `${HISTORICAL_PROVIDER_LIST}\n${FINAL_PROVIDER_LIST}`,
    ]) assert.throws(() => prepareProviderList(module(body)), /VERIFIED_REPORT_ONLY_PROVIDERS/, body);
  });

  test('the repository build is accepted, and t2-prepare patches only the fixture copy', () => {
    const built = path.join(harness, '..', '..', '..', 'dist', 'opencode', 'report-only.js');
    if (fs.existsSync(built)) {
      const before = fs.readFileSync(built);
      assert.equal(prepareProviderList(before.toString('utf8')).found, 'claude-code');
      assert.deepEqual(fs.readFileSync(built), before);
    }
    const prepare = fs.readFileSync(path.join(harness, 't2-prepare.mjs'), 'utf8');
    assert.match(prepare, /patchProviderList\('opencode\/report-only\.js'\)/);
    assert.match(prepare, /path\.join\(dist, relative\)/);
    assert.doesNotMatch(prepare, /export const VERIFIED_REPORT_ONLY_PROVIDERS = \[\];/);
  });
});

test('new fixture roots use the 0006 prefix and the retained 0005 root is not accepted', async () => {
  assert.equal(FIXTURE_PREFIX, 'heimdall-0008.');
  assert.doesNotThrow(() => assertFixtureRoot('/private/tmp/heimdall-0008.abc123'));
  assert.throws(() => assertFixtureRoot('/private/tmp/heimdall-0006.jFpXF9'), /Fixture root must be/);
});

describe('compaction live check verdict', () => {
  const rejection = { accepted: false, result: { accepted: false, code: 'format', repairable: true, errorPaths: ['missing_gate@$.evidence'] } };
  const acceptance = { accepted: true, result: { accepted: true, code: null, repairable: null, errorPaths: [] } };
  const passing = { receiptPresent: true, singleAcceptedSubmission: true, formatCorrectionsWithinLimit: true };

  test('all checks true passes with exit status 0', () => {
    assert.deepEqual(compactionVerdict({ checks: passing }), { pass: true, exitCode: 0 });
    assert.deepEqual(compactionVerdict({ checks: passing, waitFailure: null, compactionError: null }), { pass: true, exitCode: 0 });
  });

  test('any false check fails with exit status 1', () => {
    for (const name of Object.keys(passing)) assert.deepEqual(compactionVerdict({ checks: { ...passing, [name]: false } }), { pass: false, exitCode: 1 }, name);
    assert.deepEqual(compactionVerdict({ checks: { ...passing, extra: undefined } }), { pass: false, exitCode: 1 });
  });

  test('no checks fails', () => {
    assert.deepEqual(compactionVerdict({ checks: {} }), { pass: false, exitCode: 1 });
    assert.deepEqual(compactionVerdict({}), { pass: false, exitCode: 1 });
  });

  test('a wait failure or a compaction request error fails even when every check is true', () => {
    assert.deepEqual(compactionVerdict({ checks: passing, waitFailure: 'timed out waiting for idle' }), { pass: false, exitCode: 1 });
    assert.deepEqual(compactionVerdict({ checks: passing, compactionError: 'request failed' }), { pass: false, exitCode: 1 });
  });

  test('format corrections are counted from the observed submission calls', () => {
    assert.equal(countFormatCorrections([rejection, acceptance]), 1);
    assert.equal(countFormatCorrections([acceptance]), 0);
    assert.equal(countFormatCorrections([rejection, rejection, acceptance]), 2);
    assert.equal(countFormatCorrections([]), 0);
    assert.equal(countFormatCorrections(undefined), 0);
  });

  test('only repairable format rejections before the accepted call count as corrections', () => {
    const other = { accepted: false, result: { accepted: false, code: 'provenance', repairable: false, errorPaths: [] } };
    const unparsed = { accepted: false, result: { accepted: false, code: 'unparsed', repairable: null, errorPaths: [] } };
    assert.equal(countFormatCorrections([other, unparsed, rejection, acceptance]), 1);
    assert.equal(countFormatCorrections([rejection, acceptance, rejection]), 1);
    assert.equal(countFormatCorrections([{ accepted: false }, rejection, acceptance]), 1);
  });

  test('the run state repair counter is not an input of the verdict or of the correction count', () => {
    // The counter is cleared once the task is accepted, so a cleared or stale value must not change the result.
    assert.equal(countFormatCorrections([acceptance], { submissionRepair: { repairs: 2 } }), 0);
    assert.equal(countFormatCorrections([rejection, acceptance], { submissionRepair: null }), 1);
    for (const file of ['compaction-verdict.mjs', 'e2e-compaction.mjs']) {
      const source = fs.readFileSync(path.join(harness, file), 'utf8');
      assert.doesNotMatch(source, /checks\.noRepair/, file);
      assert.doesNotMatch(source, /checks\.[A-Za-z]+\s*=[^;]*submissionRepair/, file);
    }
    assert.doesNotMatch(fs.readFileSync(path.join(harness, 'compaction-verdict.mjs'), 'utf8'), /submissionRepair/);
  });

  test('a correction count above the documented limit of two fails the limit check', () => {
    assert.equal(FORMAT_REPAIR_LIMIT, 2);
    const within = count => countFormatCorrections(Array.from({ length: count }, () => rejection).concat(acceptance)) <= FORMAT_REPAIR_LIMIT;
    assert.equal(within(0), true);
    assert.equal(within(2), true);
    assert.equal(within(3), false);
    assert.deepEqual(compactionVerdict({ checks: { ...passing, formatCorrectionsWithinLimit: within(3) } }), { pass: false, exitCode: 1 });
  });

  test('the live script derives its exit status from the verdict and counts corrections from the observed calls', () => {
    const source = fs.readFileSync(path.join(harness, 'e2e-compaction.mjs'), 'utf8');
    assert.match(source, /compactionVerdict\(\{ checks, waitFailure: summary\.waitFailure, compactionError: compaction\.error \}\)/);
    assert.match(source, /process\.exitCode = verdict\.exitCode/);
    assert.match(source, /summary\.formatCorrections = countFormatCorrections\(summary\.submissionCalls\)/);
    assert.match(source, /checks\.formatCorrectionsWithinLimit = summary\.formatCorrections <= FORMAT_REPAIR_LIMIT/);
  });
});
