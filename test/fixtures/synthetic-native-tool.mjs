/*
 * Synthetic `systemctl --user` / `launchctl` executable for subprocess lifecycle tests.
 *
 * It is a TEST FIXTURE, not a service manager: `test/fixtures/lifecycle-subprocess-harness.mjs` writes tiny wrapper
 * scripts that run this file with a per-fixture configuration, and the production `createExecFileRunner` executes those
 * wrappers exactly as it would execute the real tools. Every call is a separate process, so the state it keeps lives in
 * files under `<manager>/` of the fixture root and survives the lifecycle command that issued the call, which is
 * what an externally observable "request already accepted by the manager" requires.
 *
 * Supported verbs (anything else is refused with exit 99 and recorded in `violations.jsonl`):
 *   systemctl --user: show-environment, show <unit> -p ..., link <definition>, daemon-reload, start <unit>
 *   launchctl: print <target>, bootstrap <domain> <plist>, kickstart <target>, bootout <target> (only while not running)
 * A starting verb (`start`, `kickstart`) spawns a detached supervisor that runs the registered definition's real
 * program, so a released start launches the real coordinator; the supervisor records the child's pid and exit status.
 *
 * Controls, all plain files so tests need no IPC with the tool:
 *   gates/<verb>      while this file exists the call blocks after it was received (and, for a starting verb, while
 *                     its request is in flight); `reached/<verb>.<pid>` is written when a call starts waiting.
 *   delay/<verb>      milliseconds every call of the verb sleeps before it takes effect.
 *   fail/<verb>       exit status the call returns after any gate, without taking effect.
 *   predeliver/<verb> (starting verbs only) while this file exists a starting call has not delivered its request to the
 *                     manager yet: it waits before it records the call in `calls.jsonl` or writes its `inflight/` marker, so
 *                     `show <unit> -p Job` prints nothing and no start is pending. `reached-predeliver/<verb>.<pid>` is
 *                     written when a call starts waiting. Once the file is removed the call proceeds as an ordinary call:
 *                     it is recorded, marks its request in flight, honours the controls above and launches the service.
 *                     Termination signals received while waiting are recorded like any other.
 *   flood/<verb>      (starting verbs only) `stdout` or `stderr`: before anything else, including the `predeliver` hold, a
 *                     starting call writes more than two MiB to that stream. Writes never wait for a reader (a closed pipe
 *                     ends the flood, a pipe nobody drains is abandoned after three seconds), so the call still reaches its
 *                     hold and stays a client that can deliver whatever happened to its output.
 *   gates/supervisor-exit  holds the supervisor after it reaps the service but before it publishes the exit status;
 *                     `reached/supervisor-exit.<pid>` records that boundary. Inspections retain the previous running
 *                     state until the manager publishes the exit and inactive state together.
 * Evidence, one JSON object per line:
 *   calls.jsonl       {at, verb, args, pid}      every call received
 *   signals.jsonl     {at, signal, pid, verb}    every termination signal a call received (the call then exits)
 *   violations.jsonl  {at, verb, args, reason}   refused verbs (stop, kill, enable, -k, ...)
 * `show <unit> -p Job` prints `Job=1` while a starting call is in flight and nothing otherwise, as systemd does for a
 * unit without a queued job.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { parsePlist } from '../../dist/coordinator/native/launchd.js';
import { parseSystemdUnit } from '../../dist/coordinator/native/systemd.js';

const [configPath, ...argv] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const dir = config.managerDirectory;
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const append = (name, value) => fs.appendFileSync(path.join(dir, name), `${JSON.stringify({ at: Date.now(), ...value })}\n`);
const read = name => { try { return fs.readFileSync(path.join(dir, name), 'utf8').trim(); } catch { return null; } };
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

const STATE_FILE = 'state.json';
const initialState = { registeredPath: null, pid: null, supervisorPid: null, exit: null, starts: 0 };
const readState = () => { try { return { ...initialState, ...JSON.parse(fs.readFileSync(path.join(dir, STATE_FILE), 'utf8')) }; } catch { return { ...initialState }; } };
function writeState(patch) {
  const next = { ...readState(), ...patch };
  const temporary = path.join(dir, `.${STATE_FILE}.${process.pid}.tmp`);
  fs.writeFileSync(temporary, JSON.stringify(next));
  fs.renameSync(temporary, path.join(dir, STATE_FILE));
  return next;
}
// Only the supervisor publishes a service's exit. Probing its PID here could report it inactive between the kernel's
// reap and that publication, with no exit status (or a fabricated default 0 for systemd).
const running = state => state.pid !== null && state.exit === null;

const ok = (stdout = '') => { process.stdout.write(stdout); process.exit(0); };
const fail = (code, stderr) => { process.stderr.write(stderr); process.exit(code); };

if (argv[0] === '--supervise') await supervise(argv[1]);
else await call(argv);

// --- supervisor: the synthetic manager's own process, running the registered program ----------------------------

async function supervise(definitionPath) {
  let definition;
  try {
    if (config.kind === 'systemctl') {
      const unit = path.basename(definitionPath);
      const parsed = parseSystemdUnit(fs.readFileSync(definitionPath, 'utf8'), unit);
      if (!parsed) throw new Error('not a unit');
      definition = { program: parsed.execStart[0], args: parsed.execStart.slice(1), env: parsed.environment, out: path.join(dir, 'journal.out.log'), err: path.join(dir, 'journal.err.log') };
    } else {
      const parsed = parsePlist(fs.readFileSync(definitionPath, 'utf8'));
      definition = { program: parsed.ProgramArguments[0], args: parsed.ProgramArguments.slice(1), env: parsed.EnvironmentVariables ?? {}, out: parsed.StandardOutPath, err: parsed.StandardErrorPath };
    }
  } catch { writeState({ pid: null, exit: { code: 127, signal: null }, supervisorPid: process.pid }); process.exit(1); }
  const open = file => file ? fs.openSync(file, 'a') : 'ignore';
  const child = spawn(definition.program, definition.args, { env: definition.env, cwd: '/', stdio: ['ignore', open(definition.out), open(definition.err)] });
  child.once('error', () => { writeState({ pid: null, exit: { code: 127, signal: null }, supervisorPid: process.pid }); process.exit(1); });
  child.once('spawn', () => writeState({ pid: child.pid, exit: null, supervisorPid: process.pid, starts: readState().starts + 1 }));
  child.once('exit', async (code, signal) => {
    if (fs.existsSync(path.join(dir, 'gates', 'supervisor-exit'))) {
      fs.writeFileSync(path.join(dir, 'reached', `supervisor-exit.${process.pid}`), '');
      while (fs.existsSync(path.join(dir, 'gates', 'supervisor-exit'))) await sleep(20);
    }
    writeState({ exit: { code, signal } });
    process.exit(0);
  });
  // Harness cleanup only: the fixture ends its own coordinator with the graceful signal a foreground coordinator drains on.
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  await new Promise(() => {});
}

// --- one verb ---------------------------------------------------------------------------------------------------

async function call(args) {
  const verb = config.kind === 'systemctl' ? args[1] : args[0];
  let signalled = false;
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(signal, () => { if (signalled) return; signalled = true; append('signals.jsonl', { signal, pid: process.pid, verb }); process.exit(128); });
  }
  const starting = verb === 'start' || verb === 'kickstart';
  // Output produced before anything is delivered: more than a runner's output bound, on the stream the control names.
  const flood = starting ? read(`flood/${verb}`) : null;
  if (flood === 'stdout' || flood === 'stderr') await floodOutput(flood === 'stdout' ? 1 : 2);
  // A client the manager has not received a request from yet: nothing is recorded, no job is queued, and nothing happens
  // to the service until the hold is released, after which the call is an ordinary one.
  if (starting && fs.existsSync(path.join(dir, 'predeliver', verb))) {
    fs.mkdirSync(path.join(dir, 'reached-predeliver'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'reached-predeliver', `${verb}.${process.pid}`), '');
    while (fs.existsSync(path.join(dir, 'predeliver', verb))) await sleep(20);
  }
  append('calls.jsonl', { verb, args, pid: process.pid });
  const refuse = reason => { append('violations.jsonl', { verb, args, reason }); fail(99, `synthetic ${config.kind} refused: ${reason}\n`); };
  const allowed = config.kind === 'systemctl' ? ['show-environment', 'show', 'link', 'daemon-reload', 'start'] : ['print', 'bootstrap', 'kickstart', 'bootout'];
  if (!allowed.includes(verb)) refuse(`verb ${verb} could stop, kill, restart or enable a service`);
  if (args.includes('-k') || args.includes('--now') || args.includes('--force') || args.includes('--system') || args.includes('--global')) refuse(`unexpected option in ${args.join(' ')}`);
  if (config.kind === 'systemctl' && args[0] !== '--user') refuse('only the user manager is addressed');

  const inflight = path.join(dir, 'inflight', `${verb}.${process.pid}`);
  if (starting) fs.writeFileSync(inflight, '');
  try {
    const delay = Number(read(`delay/${verb}`));
    if (delay > 0) await sleep(delay);
    let announced = false;
    while (fs.existsSync(path.join(dir, 'gates', verb))) {
      if (!announced) { announced = true; fs.writeFileSync(path.join(dir, 'reached', `${verb}.${process.pid}`), ''); }
      await sleep(20);
    }
    const failure = read(`fail/${verb}`);
    if (failure !== null) fail(Number(failure) || 1, `synthetic ${config.kind} ${verb} failed on request\n`);
    await (config.kind === 'systemctl' ? systemctl(verb, args.slice(2)) : launchctl(verb, args.slice(1)));
  } finally { fs.rmSync(inflight, { force: true }); }
}

/**
 * Write more than two MiB to `fd` without ever blocking the call on a reader: a reader that went away makes the write
 * fail (the call then goes on without the rest), and a reader that stopped reading cannot hold the call for more than
 * three seconds.
 */
async function floodOutput(fd) {
  // A worker thread does the writing, so a pipe that nobody drains blocks the worker and never the call itself.
  const worker = new Worker([
    "const fs = require('node:fs');",
    "const { workerData: fd } = require('node:worker_threads');",
    "const chunk = Buffer.alloc(64 * 1024, 'x');",
    'for (let total = 0; total < 2 * 1024 * 1024;) {',
    '  try { total += fs.writeSync(fd, chunk); }',
    "  catch (error) { if (error.code === 'EAGAIN') { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5); continue; } break; }",
    '}',
  ].join('\n'), { eval: true, workerData: fd });
  worker.on('error', () => undefined);
  worker.unref();
  await Promise.race([new Promise(resolve => worker.once('exit', resolve)), sleep(3000)]);
}

function startPending() {
  try {
    return fs.readdirSync(path.join(dir, 'inflight')).some(name => /^(start|kickstart)\.(\d+)$/.test(name) && alive(Number(name.split('.')[1])) && Number(name.split('.')[1]) !== process.pid);
  } catch { return false; }
}

/** Launch the registered definition through a detached supervisor and wait until it reports the child (or its failure). */
async function launch(definitionPath) {
  const state = readState();
  if (running(state)) return true;
  writeState({ pid: null, exit: null });
  const supervisor = spawn(process.execPath, [new URL(import.meta.url).pathname, configPath, '--supervise', definitionPath], { detached: true, stdio: 'ignore' });
  supervisor.unref();
  for (let waited = 0; waited < 10_000; waited += 20) {
    const now = readState();
    if (now.pid !== null) return true;
    if (now.exit !== null) return false;
    await sleep(20);
  }
  return false;
}

async function systemctl(verb, rest) {
  const linkPath = unit => path.join(config.configHome, 'systemd', 'user', unit);
  if (verb === 'show-environment') ok('HOME=/home/x\n');
  if (verb === 'daemon-reload') ok();
  if (verb === 'link') {
    const [definitionPath] = rest;
    const unit = path.basename(definitionPath);
    fs.mkdirSync(path.dirname(linkPath(unit)), { recursive: true });
    try { fs.symlinkSync(definitionPath, linkPath(unit)); } catch { fail(1, 'Failed to link unit: File exists\n'); }
    ok();
  }
  const [unit, flag, properties] = rest;
  if (verb === 'show') {
    if (flag !== '-p') fail(99, 'show must request explicit properties\n');
    if (properties === 'Job') ok(startPending() ? 'Job=1\n' : '');
    const state = readState();
    const link = linkPath(unit);
    let loaded = false;
    try { loaded = parseSystemdUnit(fs.readFileSync(link, 'utf8'), unit) !== undefined; } catch { /* not linked */ }
    const text = values => [`LoadState=${values.load}`, `ActiveState=${values.active}`, `SubState=${values.sub}`, `MainPID=${values.pid}`, `ExecMainStatus=${values.status}`, `ExecMainCode=${values.code}`, `FragmentPath=${values.fragment}`, ''].join('\n');
    if (!loaded) ok(text({ load: 'not-found', active: 'inactive', sub: 'dead', pid: 0, status: 0, code: 0, fragment: '' }));
    if (running(state)) ok(text({ load: 'loaded', active: 'active', sub: 'running', pid: state.pid, status: 0, code: 0, fragment: link }));
    const clean = state.exit === null || state.exit.code === 0;
    ok(text({ load: 'loaded', active: clean ? 'inactive' : 'failed', sub: clean ? 'dead' : 'failed', pid: 0, status: state.exit?.code ?? 0, code: state.exit === null ? 0 : 1, fragment: link }));
  }
  // start
  if (!fs.existsSync(linkPath(rest[0]))) fail(5, `Failed to start ${rest[0]}: Unit not found.\n`);
  if (!await launch(linkPath(rest[0]))) fail(1, `Job for ${rest[0]} failed.\n`);
  ok();
}

async function launchctl(verb, rest) {
  const target = rest[0] ?? '';
  const prefix = `gui/${config.uid}/`;
  if (verb === 'print') {
    if (!target.startsWith(prefix)) fail(99, 'only the user domain is addressed\n');
    const state = readState();
    if (state.registeredPath === null) fail(113, `Could not find service "${target.slice(prefix.length)}" in domain for user gui: ${config.uid}\n`);
    const up = running(state);
    const exit = state.exit === null ? '(never exited)' : state.exit.code !== null ? String(state.exit.code) : '(signal)';
    ok([
      `${target} = {`, `\tactive count = ${up ? 1 : 0}`, `\tpath = ${state.registeredPath}`, '\ttype = LaunchAgent', `\tstate = ${up ? 'running' : 'not running'}`,
      '\n\targuments = {', '\t\t/some/node', '\t\tstate = not-the-service-state', '\t}', '\n\tenvironment = {', '\t\tHOME => /home/x', '\t}',
      ...(up ? [`\tpid = ${state.pid}`] : [`\tlast exit code = ${exit}`]), '}', '',
    ].join('\n'));
  }
  if (verb === 'bootstrap') {
    const [domain, plistPath] = rest;
    if (domain !== `gui/${config.uid}`) fail(99, 'only the user domain is addressed\n');
    let parsed;
    try { parsed = parsePlist(fs.readFileSync(plistPath, 'utf8')); } catch { fail(5, 'Bootstrap failed: 5: Input/output error\n'); }
    if (readState().registeredPath !== null || typeof parsed !== 'object' || typeof parsed.Label !== 'string') fail(5, 'Bootstrap failed: 5: Input/output error\n');
    writeState({ registeredPath: plistPath, pid: null, exit: null });
    ok();
  }
  if (verb === 'bootout') {
    if (running(readState())) { append('violations.jsonl', { verb, args: rest, reason: 'bootout of a running service would terminate it' }); fail(99, 'refused\n'); }
    if (readState().registeredPath === null) fail(3, 'Boot-out failed: 3: No such process\n');
    writeState({ registeredPath: null });
    ok();
  }
  // kickstart
  const state = readState();
  if (state.registeredPath === null) fail(113, 'Could not find service\n');
  if (!await launch(state.registeredPath)) fail(5, 'Service cannot load in requested session\n');
  ok();
}
