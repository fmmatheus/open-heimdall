// Enforced read-only credential and user-state guard for the claude-code live verification.
//
//   node guard.mjs install --root R              write guard/profile.sb and guard/bin/security
//   node guard.mjs launch  --root R -- cmd args  run cmd inside the exact guard wrapper
//   node guard.mjs probe   --root R              prove the guard with disposable fixtures only
//
// Mechanisms (all enforced by the OS, none by prompt):
//   1. /usr/bin/sandbox-exec profile: every file write is denied except the fixture root; the
//      guard directory, user Claude state, the Keychain directories and the live OpenCode stores
//      are explicitly denied again.
//   2. The sandbox denies exec of /usr/bin/security and mach-lookup of the Security services, so no
//      sandboxed process can add, update or delete a Keychain item.
//   3. `security` on PATH is a shim that forwards only the credential read to broker.mjs, which
//      runs outside the sandbox and strips every refresh token before the CLI sees the login, so
//      the CLI cannot refresh (rotate) the stored login either.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  assertFixtureRoot, capture, emit, parseArguments, readManifest, sha256, storeEnvironment, updateManifest,
} from './lib.mjs';

const here = path.dirname(new URL(import.meta.url).pathname);
export const PROBE_SERVICE = 'Claude Code-credentials-probe0005';
const CONTROL_SERVICE = 'heimdall-0005-control';
const NEW_SERVICE = 'heimdall-0005-new-item';

// Direct Security.framework client (no security(1)). Run unsandboxed as a control and inside the guard.
const DIRECT_PROBE = `import ctypes, sys
sec = ctypes.CDLL('/System/Library/Frameworks/Security.framework/Security')
op, path, svc = sys.argv[1], sys.argv[2], sys.argv[3]
sec.SecKeychainOpen.argtypes = [ctypes.c_char_p, ctypes.POINTER(ctypes.c_void_p)]
kc = ctypes.c_void_p()
st = sec.SecKeychainOpen(path.encode(), ctypes.byref(kc))
if st != 0:
    print('OSSTATUS=%d' % st); sys.exit(3)
acct = b'probe'
service = svc.encode()
item = ctypes.c_void_p()
if op == 'add':
    st = sec.SecKeychainAddGenericPassword(kc, len(service), service, len(acct), acct, 4, b'FAKE', ctypes.byref(item))
elif op == 'delete':
    st = sec.SecKeychainFindGenericPassword(kc, len(service), service, len(acct), acct, None, None, ctypes.byref(item))
    if st == 0:
        st = sec.SecKeychainItemDelete(item)
else:
    st = -1
print('OSSTATUS=%d' % st)
sys.exit(0 if st == 0 else 3)
`;
const DIRECT_PYTHON = '/usr/bin/python3';

const quote = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const regexEscape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Paths (relative to HOME) the guarded process may never modify.
export const GUARDED_HOME_PATHS = [
  '.claude', '.config/claude', '.local/share/claude', '.local/state/claude', '.cache/claude',
  'Library/Keychains', 'Library/Application Support/Claude', 'Library/Caches/claude-cli-nodejs', 'Library/Logs/Claude',
  '.local/share/opencode', '.config/opencode', '.local/state/opencode', '.cache/opencode',
  '.config/openchamber', '.local/share/openchamber',
];
export const SECURITY_MACH_SERVICES = ['com.apple.SecurityServer', 'com.apple.securityd', 'com.apple.secd', 'com.apple.security.agentd', 'com.apple.security.XPCKeychainSandboxCheck'];

export function buildProfile({ root, home }) {
  const lines = [
    '(version 1)',
    '(allow default)',
    ';; 1. Default-deny file writes. Only the fixture root and terminal/null devices stay writable.',
    '(deny file-write*)',
    `(allow file-write* (subpath ${quote(root)}) (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/(ptmx|tty[a-z0-9]*|pty[a-z0-9]+)$"))`,
    ';; 2. The guard material is read-only to the guarded process.',
    `(deny file-write* (subpath ${quote(path.join(root, 'guard'))}) (literal ${quote(path.join(root, 'manifest.json'))}))`,
    ';; 3. User state is denied again explicitly, including hard-link creation, so widening rule 1 can never expose it.',
    `(deny file-write* file-link (literal ${quote(path.join(home, '.claude.json'))}) (regex #"^${regexEscape(path.join(home, '.claude.json'))}[^/]*$"))`,
    ...GUARDED_HOME_PATHS.map(relative => `(deny file-write* file-link (subpath ${quote(path.join(home, relative))}))`),
    '(deny file-write* file-link (subpath "/Library/Keychains"))',
    ';; 4. Keychain: no direct security(1), no Security services. Reads go through the shim and broker.',
    '(deny process-exec (literal "/usr/bin/security"))',
    `(deny mach-lookup ${SECURITY_MACH_SERVICES.map(name => `(global-name ${quote(name)})`).join(' ')})`,
  ];
  return lines.join('\n') + '\n';
}

export function guardPaths(root) {
  return { profile: path.join(root, 'guard', 'profile.sb'), bin: path.join(root, 'guard', 'bin'), shim: path.join(root, 'guard', 'bin', 'security'), socket: path.join(root, 'guard', 'broker.sock') };
}

export function guardedEnvironment(root) {
  const paths = guardPaths(root);
  const env = storeEnvironment(root);
  env.PATH = `${paths.bin}:${process.env.PATH ?? '/usr/bin:/bin'}`;
  env.HEIMDALL_GUARD_BROKER = paths.socket;
  return env;
}

// The exact wrapper the server uses: sandbox-exec -f profile.sb <command> ...
export function guardedCommand(root, command, args) {
  return { command: '/usr/bin/sandbox-exec', args: ['-f', guardPaths(root).profile, command, ...args], env: guardedEnvironment(root) };
}

export function install(root) {
  const paths = guardPaths(root);
  const home = os.homedir();
  fs.mkdirSync(paths.bin, { recursive: true, mode: 0o700 });
  fs.rmSync(paths.profile, { force: true });
  fs.writeFileSync(paths.profile, buildProfile({ root, home }), { flag: 'wx', mode: 0o600 });
  fs.rmSync(paths.shim, { force: true });
  fs.copyFileSync(path.join(here, 'security-shim.mjs'), paths.shim, fs.constants.COPYFILE_EXCL);
  fs.chmodSync(paths.shim, 0o700);
  const hashes = { profile: sha256(fs.readFileSync(paths.profile)), shim: sha256(fs.readFileSync(paths.shim)) };
  updateManifest(root, manifest => { manifest.guardInstall = { ...hashes, mechanisms: ['sandbox-exec file-write default deny', 'exec deny /usr/bin/security', 'mach-lookup deny Security services', 'read-only broker with refresh-token strip'] }; });
  return hashes;
}

function waitFor(predicate, timeoutMs, stepMs = 100) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => (predicate() ? resolve() : Date.now() - started > timeoutMs ? reject(new Error('timeout')) : setTimeout(tick, stepMs));
    tick();
  });
}

async function startBroker(root, extra) {
  fs.rmSync(guardPaths(root).socket, { force: true });
  const child = spawn(process.execPath, [path.join(here, 'broker.mjs'), '--root', root, ...extra], { stdio: ['ignore', 'pipe', 'pipe'], env: storeEnvironment(root) });
  await waitFor(() => fs.existsSync(guardPaths(root).socket), 10_000);
  return child;
}

async function stopBroker(root, child) {
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill('SIGTERM');
  await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 5_000))]);
  const alive = child.exitCode === null && child.signalCode === null;
  if (alive) child.kill('SIGKILL');
  updateManifest(root, manifest => { for (const entry of manifest.processes) if (entry.pid === child.pid) { entry.stoppedAt = new Date().toISOString(); entry.exited = !alive; } });
  return !alive;
}

function runGuarded(root, command, args, timeoutMs = 120_000) {
  const wrapped = guardedCommand(root, command, args);
  const run = spawnSync(wrapped.command, wrapped.args, { env: wrapped.env, encoding: 'utf8', timeout: timeoutMs, cwd: root });
  return { status: run.status, signal: run.signal, stdout: run.stdout ?? '', stderr: run.stderr ?? '', error: run.error?.code ?? null };
}

const security = (args, options = {}) => capture('/usr/bin/security', args, options);
const listKeychains = async () => ({
  user: (await security(['list-keychains', '-d', 'user'])).stdout.split('\n').map(line => line.trim().replace(/^"|"$/g, '')).filter(Boolean),
  defaultKeychain: (await security(['default-keychain', '-d', 'user'])).stdout.trim().replace(/^"|"$/g, ''),
});
const serviceNames = async keychain => [...(await security(['dump-keychain', keychain])).stdout.matchAll(/"svce"<blob>="([^"]*)"/g)].map(match => match[1]).sort();

function seedFile(file) {
  fs.writeFileSync(file, 'DISPOSABLE-GUARD-PROBE-0005\n', { flag: 'wx', mode: 0o600 });
  return { sha256: sha256(fs.readFileSync(file)), mode: fs.statSync(file).mode & 0o777 };
}

export async function probe(root) {
  const home = os.homedir();
  const user = os.userInfo().username;
  const paths = guardPaths(root);
  const hashes = install(root);
  const evidenceDirectory = path.join(root, 'evidence');
  const failures = [];
  const created = [];
  const seeds = [];
  const record = { home: 'unchanged', installedGuard: hashes, writes: [], execs: [], keychain: {}, controls: {}, authStatus: {}, cleanup: {} };

  // Disposable keychain. create-keychain may add it to the user's search list; the list is restored and compared.
  const keychain = path.join(root, 'guard', 'disposable.keychain-db');
  const listBefore = await listKeychains();
  const password = crypto.randomBytes(12).toString('hex');
  const fakeCredential = JSON.stringify({ claudeAiOauth: { accessToken: 'FAKE-ACCESS-0005', refreshToken: 'FAKE-REFRESH-0005', expiresAt: Date.now() + 365 * 86_400_000, scopes: ['probe'], subscriptionType: 'probe' } });
  let broker = null;
  try {
    const steps = [
      await security(['create-keychain', '-p', password, keychain]),
      await security(['set-keychain-settings', keychain]),
      await security(['unlock-keychain', '-p', password, keychain]),
      await security(['add-generic-password', '-U', '-a', user, '-s', PROBE_SERVICE, '-w', fakeCredential, keychain]),
    ];
    if (steps.some(step => step.code !== 0)) throw new Error(`disposable keychain setup failed: ${steps.map(step => step.code).join(',')}`);
    const afterCreate = await listKeychains();
    if (JSON.stringify(afterCreate) !== JSON.stringify(listBefore)) await security(['list-keychains', '-d', 'user', '-s', ...listBefore.user]);
    record.keychain.searchListChangedByCreate = JSON.stringify(afterCreate) !== JSON.stringify(listBefore);

    // A direct Security.framework client (not security(1)). Unsandboxed controls prove it can write the
    // disposable keychain, so a denial inside the guard is attributable to the guard.
    const direct = path.join(root, 'guard', 'direct-probe.py');
    fs.writeFileSync(direct, DIRECT_PROBE, { flag: 'wx', mode: 0o600 });
    const controlAdd = await capture(DIRECT_PYTHON, [direct, 'add', keychain, CONTROL_SERVICE]);
    const throwaway = await capture(DIRECT_PYTHON, [direct, 'add', keychain, 'heimdall-0005-throwaway']);
    const throwawayDelete = await capture(DIRECT_PYTHON, [direct, 'delete', keychain, 'heimdall-0005-throwaway']);
    record.controls.unsandboxedDirectFrameworkAddWritesDisposableKeychain = controlAdd.code === 0 && /OSSTATUS=0/.test(controlAdd.stdout);
    record.controls.unsandboxedDirectFrameworkDeleteWorksOnDisposableKeychain = throwaway.code === 0 && throwawayDelete.code === 0 && !(await serviceNames(keychain)).includes('heimdall-0005-throwaway');
    if (!record.controls.unsandboxedDirectFrameworkAddWritesDisposableKeychain || !record.controls.unsandboxedDirectFrameworkDeleteWorksOnDisposableKeychain) throw new Error('control: the direct Security.framework client cannot modify the disposable keychain unsandboxed; probe would prove nothing');
    const servicesBefore = await serviceNames(keychain);
    const secretBefore = sha256((await security(['find-generic-password', '-a', user, '-s', PROBE_SERVICE, '-w', keychain])).stdout);
    const keychainFileBefore = sha256(fs.readFileSync(keychain));

    // Seed disposable credential-like files in each existing guarded class (sibling probe names only).
    const seedClasses = [
      ['claude-home', '.claude', 'heimdall-0005-probe.credentials.json'], ['claude-settings', '.claude', 'heimdall-0005-probe.settings.json'],
      ['claude-projects', '.claude/projects', 'heimdall-0005-probe.jsonl'], ['claude-todos', '.claude/todos', 'heimdall-0005-probe.json'],
      ['claude-shell-snapshots', '.claude/shell-snapshots', 'heimdall-0005-probe.sh'], ['claude-plugins', '.claude/plugins', 'heimdall-0005-probe.json'],
      ['claude-session-env', '.claude/session-env', 'heimdall-0005-probe.env'], ['claude-statsig', '.claude/statsig', 'heimdall-0005-probe.json'],
      ['claude-telemetry', '.claude/telemetry', 'heimdall-0005-probe.json'], ['claude-sessions', '.claude/sessions', 'heimdall-0005-probe.json'],
      ['claude-json-sibling', '.', '.claude.json.heimdall-0005-probe'], ['keychains-dir', 'Library/Keychains', 'heimdall-0005-probe.txt'],
    ];
    const writes = [];
    const hardlinkDirectory = path.join(root, 'profile', 'tmp');
    for (const [label, relative, name] of seedClasses) {
      const directory = path.join(home, relative);
      // Class directory absent on this machine: creating the class directory itself must be denied.
      if (!fs.existsSync(directory)) { writes.push({ label: `${label}:mkdir-absent-class`, class: label, op: 'mkdir', target: directory }); continue; }
      const file = path.join(directory, name);
      seeds.push({ label, file, ...seedFile(file) });
      created.push(file);
      for (const op of ['overwrite', 'truncate', 'append', 'unlink', 'rename', 'chmod']) writes.push({ label: `${label}:${op}`, class: label, op, target: file });
      writes.push({ label: `${label}:hardlink`, class: label, op: 'hardlink', source: file, target: path.join(hardlinkDirectory, `link-${label}`) });
      writes.push({ label: `${label}:create-sibling`, class: label, op: 'create', target: `${file}.sibling` });
    }
    // Classes with no existing directory or no seed: attempt creation only.
    for (const [label, relative] of [['xdg-claude-config', '.config/claude'], ['xdg-claude-share', '.local/share/claude'], ['xdg-claude-state', '.local/state/claude'], ['xdg-claude-cache', '.cache/claude']]) {
      const target = path.join(home, relative);
      writes.push(fs.existsSync(target)
        ? { label: `${label}:create`, class: label, op: 'create', target: path.join(target, 'heimdall-0005-probe-create') }
        : { label: `${label}:mkdir-absent-class`, class: label, op: 'mkdir', target });
    }
    for (const [label, relative] of [['opencode-data', '.local/share/opencode'], ['opencode-config', '.config/opencode'], ['opencode-state', '.local/state/opencode'], ['openchamber-config', '.config/openchamber']]) {
      if (fs.existsSync(path.join(home, relative))) writes.push({ label: `${label}:create`, class: label, op: 'create', target: path.join(home, relative, 'heimdall-0005-probe-create') });
    }
    writes.push({ label: 'keychains-dir:create', class: 'keychains-dir', op: 'create', target: path.join(home, 'Library/Keychains', 'heimdall-0005-probe-create.keychain-db') });
    writes.push({ label: 'claude-json:create-lock', class: 'claude-json-sibling', op: 'create', target: path.join(home, '.claude.json.heimdall-0005-probe.lock') });
    // Guard material and the disposable keychain file itself.
    for (const [label, target] of [['guard-profile', paths.profile], ['guard-shim', paths.shim], ['disposable-keychain-file', keychain]]) {
      writes.push({ label: `${label}:overwrite`, class: 'guard-material', op: 'overwrite', target });
      writes.push({ label: `${label}:unlink`, class: 'guard-material', op: 'unlink', target });
      writes.push({ label: `${label}:rename`, class: 'guard-material', op: 'rename', target });
    }
    writes.push({ label: 'guard-dir:create', class: 'guard-material', op: 'create', target: path.join(root, 'guard', 'heimdall-0005-probe-create') });
    writes.push({ label: 'fixture-profile-tmp:create (allowed control)', class: 'control', op: 'create', target: path.join(root, 'profile', 'tmp', 'allowed-control'), expect: 'allowed' });

    broker = await startBroker(root, ['--login', 'disposable', '--keychain', keychain]);
    const envUser = ['-a', user];
    const execs = [
      { label: 'shim add-generic-password -U (existing probe item)', class: 'keychain-write', command: 'security', args: ['add-generic-password', '-U', ...envUser, '-s', PROBE_SERVICE, '-w', 'FAKE-OVERWRITE-0005', keychain] },
      { label: 'shim add-generic-password (new item)', class: 'keychain-write', command: 'security', args: ['add-generic-password', ...envUser, '-s', NEW_SERVICE, '-w', 'FAKE-NEW-0005', keychain] },
      { label: 'shim delete-generic-password', class: 'keychain-write', command: 'security', args: ['delete-generic-password', ...envUser, '-s', PROBE_SERVICE, keychain] },
      { label: 'shim find-generic-password for a non-allowlisted service', class: 'keychain-read-scope', command: 'security', args: ['find-generic-password', ...envUser, '-w', '-s', CONTROL_SERVICE] },
      { label: 'shim find-generic-password without -w', class: 'keychain-read-scope', command: 'security', args: ['find-generic-password', ...envUser, '-s', PROBE_SERVICE] },
      { label: '/usr/bin/security add-generic-password (direct exec)', class: 'keychain-write', command: '/usr/bin/security', args: ['add-generic-password', '-U', ...envUser, '-s', PROBE_SERVICE, '-w', 'FAKE-DIRECT-0005', keychain] },
      { label: '/usr/bin/security delete-generic-password (direct exec)', class: 'keychain-write', command: '/usr/bin/security', args: ['delete-generic-password', ...envUser, '-s', CONTROL_SERVICE, keychain] },
      { label: 'direct Security.framework SecKeychainAddGenericPassword (new item)', class: 'keychain-write', command: DIRECT_PYTHON, args: [direct, 'add', keychain, NEW_SERVICE], requiresStatus: true },
      { label: 'direct Security.framework SecKeychainItemDelete (control item)', class: 'keychain-write', command: DIRECT_PYTHON, args: [direct, 'delete', keychain, CONTROL_SERVICE], requiresStatus: true },
      { label: 'shim find-generic-password -w on the allowlisted probe service', class: 'keychain-read', command: 'security', args: ['find-generic-password', ...envUser, '-w', '-s', PROBE_SERVICE], expect: 'allowed' },
    ];
    const planFile = path.join(root, 'guard', 'probe-plan.json');
    fs.rmSync(planFile, { force: true });
    fs.writeFileSync(planFile, JSON.stringify({ root, writes, execs }), { flag: 'wx', mode: 0o600 });
    const inner = runGuarded(root, process.execPath, [path.join(here, 'guard-probe-inner.mjs'), planFile], 180_000);
    let parsed = null;
    try { parsed = JSON.parse(inner.stdout.trim().split('\n').pop()); } catch { /* reported below */ }
    if (!parsed) throw new Error(`guarded probe produced no result (status ${inner.status}, ${inner.error ?? ''}): ${inner.stderr.slice(0, 300).replaceAll(root, '<root>')}`);

    for (const result of parsed.results) {
      if (result.kind === 'write') {
        const ok = result.expected === 'allowed' ? !result.denied : result.denied;
        record.writes.push({ label: result.label, class: result.class, op: result.op, expected: result.expected, denied: result.denied, errno: result.errno ?? null, ok });
        if (!ok) failures.push(`write ${result.label}`);
      } else {
        // A Security.framework call with the Security services denied either returns a non-zero OSStatus or
        // hangs until the probe timeout. Both leave the keychain untouched (checked below); success never does.
        const hung = result.requiresStatus && result.spawnError === 'ETIMEDOUT';
        const denied = result.exitCode !== 0 && (!result.requiresStatus || (result.osStatus !== null && result.osStatus !== 0) || hung);
        const ok = result.expected === 'allowed' ? !denied && result.sawFakeAccessToken && !result.sawFakeRefreshToken : denied;
        record.execs.push({ label: result.label, class: result.class, expected: result.expected, exitCode: result.exitCode, signal: result.signal, spawnError: result.spawnError, osStatus: result.osStatus ?? null, stderrFirstLine: result.stderrFirstLine, ...(result.expected === 'allowed' ? { fakeAccessTokenReturned: result.sawFakeAccessToken, fakeRefreshTokenReturned: result.sawFakeRefreshToken } : {}), ok });
        if (!ok) failures.push(`exec ${result.label}`);
      }
    }
    record.controls.fixtureWriteAllowedInsideWrapper = parsed.controls.fixtureWriteAllowed;
    if (!parsed.controls.fixtureWriteAllowed) failures.push('control: fixture write inside wrapper');

    // Post-conditions: seeded targets unchanged, nothing created, disposable keychain unchanged.
    record.postconditions = { seeded: [], createdPathsAbsent: true };
    for (const seed of seeds) {
      const exists = fs.existsSync(seed.file);
      const unchanged = exists && sha256(fs.readFileSync(seed.file)) === seed.sha256 && (fs.statSync(seed.file).mode & 0o777) === seed.mode && fs.statSync(seed.file).nlink === 1 && !fs.existsSync(`${seed.file}.renamed`);
      record.postconditions.seeded.push({ class: seed.label, unchanged });
      if (!unchanged) failures.push(`seed ${seed.label} changed`);
    }
    const strays = [...writes.filter(entry => entry.op === 'create' || entry.op === 'mkdir').map(entry => entry.target), ...writes.filter(entry => entry.op === 'hardlink').map(entry => entry.target)].filter(target => !target.includes('allowed-control') && fs.existsSync(target));
    record.postconditions.createdPathsAbsent = strays.length === 0;
    if (strays.length > 0) { failures.push('stray created paths'); for (const stray of strays) fs.rmSync(stray, { recursive: true, force: true }); }
    const servicesAfter = await serviceNames(keychain);
    const secretAfter = sha256((await security(['find-generic-password', '-a', user, '-s', PROBE_SERVICE, '-w', keychain])).stdout);
    record.keychain.servicesBefore = servicesBefore.length;
    record.keychain.servicesAfter = servicesAfter.length;
    record.keychain.serviceSetUnchanged = JSON.stringify(servicesBefore) === JSON.stringify(servicesAfter);
    record.keychain.probeSecretUnchanged = secretBefore === secretAfter;
    record.keychain.newItemAbsent = !servicesAfter.includes(NEW_SERVICE);
    record.keychain.controlItemPresent = servicesAfter.includes(CONTROL_SERVICE);
    record.keychain.fileSha256UnchangedAfterProbes = keychainFileBefore === sha256(fs.readFileSync(keychain));
    for (const key of ['serviceSetUnchanged', 'probeSecretUnchanged', 'newItemAbsent', 'controlItemPresent']) if (!record.keychain[key]) failures.push(`keychain ${key}`);
    const guardNow = sha256(fs.readFileSync(paths.profile)) === hashes.profile && sha256(fs.readFileSync(paths.shim)) === hashes.shim;
    record.postconditions.guardMaterialUnchanged = guardNow;
    if (!guardNow) failures.push('guard material changed');
    record.brokerLog = fs.existsSync(path.join(evidenceDirectory, 'broker-disposable.log')) ? fs.readFileSync(path.join(evidenceDirectory, 'broker-disposable.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).map(({ verb, decision, code }) => ({ verb, decision, code })) : [];
  } finally {
    if (broker) record.cleanup.disposableBrokerExited = await stopBroker(root, broker);
    for (const seed of seeds) { fs.rmSync(seed.file, { force: true }); fs.rmSync(`${seed.file}.renamed`, { force: true }); fs.rmSync(`${seed.file}.sibling`, { force: true }); }
    for (const extra of ['.claude.json.heimdall-0005-probe.lock']) fs.rmSync(path.join(home, extra), { force: true });
    record.cleanup.seededFilesRemoved = seeds.every(seed => !fs.existsSync(seed.file));
    await security(['delete-keychain', keychain]);
    const listAfter = await listKeychains();
    if (JSON.stringify(listAfter) !== JSON.stringify(listBefore)) await security(['list-keychains', '-d', 'user', '-s', ...listBefore.user]);
    const listFinal = await listKeychains();
    record.cleanup.keychainSearchListRestored = JSON.stringify(listFinal) === JSON.stringify(listBefore);
    record.cleanup.disposableKeychainRemoved = !fs.existsSync(keychain);
    if (!record.cleanup.keychainSearchListRestored) failures.push('keychain search list not restored');
  }

  // Guarded read-only operation with the existing login: auth status through the real read-only broker.
  const realBroker = await startBroker(root, ['--login', 'real']);
  try {
    const status = runGuarded(root, 'claude', ['auth', 'status', '--json'], 90_000);
    let loggedIn = null; let authMethod = null;
    try { const parsed = JSON.parse(status.stdout); loggedIn = parsed.loggedIn ?? null; authMethod = parsed.authMethod ?? null; } catch { /* leave null */ }
    record.authStatus = { exitCode: status.status, loggedIn, authMethod, stderrFirstLine: status.stderr.split('\n')[0].replaceAll(root, '<root>').slice(0, 160) };
    if (loggedIn !== true) failures.push(`guarded auth status loggedIn=${loggedIn}`);
  } finally {
    record.cleanup.realBrokerExited = await stopBroker(root, realBroker);
  }
  const realLog = fs.existsSync(path.join(evidenceDirectory, 'broker-real.log')) ? fs.readFileSync(path.join(evidenceDirectory, 'broker-real.log'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const tally = {};
  for (const entry of realLog) { const key = `${entry.verb}:${entry.decision}:exit${entry.code}`; tally[key] = (tally[key] ?? 0) + 1; }
  record.authStatus.brokerRequests = tally;
  record.authStatus.credentialExpiryBucket = [...new Set(realLog.map(entry => entry.expiry).filter(Boolean))];

  record.outcome = failures.length === 0 ? 'guard proven' : `failed gate: ${failures.join('; ')}`;
  fs.writeFileSync(path.join(evidenceDirectory, 'guard-results.json'), JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
  updateManifest(root, manifest => { manifest.outcome = record.outcome; manifest.guard = { outcome: record.outcome, results: '<root>/evidence/guard-results.json', failures }; });
  return record;
}

if (import.meta.url === new URL(process.argv[1], 'file://').href) {
  const [verb, ...rest] = process.argv.slice(2);
  const separator = rest.indexOf('--');
  const options = parseArguments(separator < 0 ? rest : rest.slice(0, separator));
  const root = assertFixtureRoot(options.root ?? '');
  readManifest(root);
  if (verb === 'install') emit(install(root));
  else if (verb === 'launch') {
    if (separator < 0 || separator === rest.length - 1) throw new Error('Usage: guard.mjs launch --root R -- command args');
    const wrapped = guardedCommand(root, rest[separator + 1], rest.slice(separator + 2));
    const child = spawn(wrapped.command, wrapped.args, { env: wrapped.env, stdio: 'inherit', cwd: root });
    child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
  } else if (verb === 'probe') {
    const record = await probe(root);
    emit({ outcome: record.outcome, writes: record.writes.length, writesOk: record.writes.filter(entry => entry.ok).length, execs: record.execs.map(entry => ({ label: entry.label, ok: entry.ok, exitCode: entry.exitCode })), keychain: record.keychain, authStatus: { loggedIn: record.authStatus.loggedIn, authMethod: record.authStatus.authMethod }, cleanup: record.cleanup });
    if (record.outcome !== 'guard proven') process.exitCode = 1;
  } else throw new Error(`Unknown verb: ${verb}`);
}
