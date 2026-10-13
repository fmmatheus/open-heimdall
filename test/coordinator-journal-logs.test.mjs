import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { lifecycleCommandMain } from '../dist/coordinator/lifecycle-cli.js';
import { FOLLOW_INTERRUPTED_EXIT_CODE } from '../dist/coordinator/lifecycle-logs.js';
import { nativeServiceNames } from '../dist/coordinator/native/types.js';

// Production `coordinator logs` on Linux, driven through lifecycleCommandMain with a synthetic journalctl: either a
// spawn seam returning a scripted child, or a real executable script that behaves like journalctl for these cases.

const posix = process.platform !== 'win32';
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const NO_ENTRIES = '-- No entries --';

async function until(predicate, message, attempts = 600) {
  for (let index = 0; index < attempts; index++) { if (await predicate()) return; await sleep(10); }
  throw new Error(message);
}

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp('/tmp/hj-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  await fs.mkdir(home);
  const stateDirectory = path.join(root, 'state');
  const configFile = path.join(root, 'coordinator.toml');
  await fs.writeFile(configFile, `[coordinator]\nstateDirectory = ${JSON.stringify(stateDirectory)}\n`);
  return { root, home, stateDirectory, configFile, unit: nativeServiceNames(stateDirectory).systemdUnit };
}

/** A scripted journalctl child that records how it was started and how it was ended. */
function scriptedJournal() {
  const calls = [];
  const spawnProcess = (file, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = [];
    child.kill = signal => { child.killed.push(signal); setImmediate(() => child.emit('close', null, signal)); return true; };
    calls.push({ file, args, options, child });
    return child;
  };
  return { calls, spawnProcess };
}

/** Runs the production logs command on Linux; the service manager adapter must never be consulted. */
function runLogs(f, extraArguments, { signals, dependencies = {} } = {}) {
  let out = '';
  let err = '';
  const adapterCalls = [];
  const finished = lifecycleCommandMain('logs', ['--coordinator-config', f.configFile, ...extraArguments], {
    streams: { stdout: { write: text => { out += text; } }, stderr: { write: text => { err += text; } } },
    signals,
    dependencies: {
      environment: { HOME: f.home, PATH: process.env.PATH }, platform: 'linux', pollIntervalMs: 20, requestTimeoutMs: 3000,
      createAdapter: () => { adapterCalls.push('createAdapter'); throw new Error('logs must not consult the service manager'); },
      ...dependencies,
    },
  });
  return { finished, adapterCalls, output: () => ({ stdout: out, stderr: err }) };
}

async function readWith(t, f, extraArguments, script) {
  const journal = scriptedJournal();
  const run = runLogs(f, extraArguments, { dependencies: { journalctl: '/usr/bin/journalctl', spawnProcess: journal.spawnProcess } });
  await until(() => journal.calls.length === 1, 'journalctl was not started');
  await script(journal.calls[0].child, journal.calls[0]);
  const status = await run.finished;
  assert.deepEqual(run.adapterCalls, [], 'logs never consults the service manager');
  return { status, ...run.output(), call: journal.calls[0] };
}

test('an empty finite read of the unit exits 1 with no output and a no-logs message naming the unit', async t => {
  const f = await fixture(t);
  const outcome = await readWith(t, f, [], child => { child.stdout.end(); child.emit('close', 0, null); });
  assert.equal(outcome.status, 1);
  assert.equal(outcome.stdout, '');
  assert.match(outcome.stderr, /no logs/i);
  assert.ok(outcome.stderr.includes(f.unit), outcome.stderr);
  assert.deepEqual(outcome.call.args, ['--user', '-u', f.unit, '-n', '100', '--no-pager', '--quiet', '-o', 'short-iso']);
  await assert.rejects(fs.lstat(f.stateDirectory), 'an empty journal read creates nothing');
});

test('empty detection does not depend on the localized status line: a quiet reader that prints nothing is empty', async t => {
  const f = await fixture(t);
  // Zero-length data events and an ended stream are still no output.
  const outcome = await readWith(t, f, ['--lines', '5'], child => {
    child.stdout.write(Buffer.alloc(0));
    child.stderr.write('');
    child.stdout.end();
    child.emit('close', 0, null);
  });
  assert.equal(outcome.status, 1);
  assert.equal(outcome.stdout, '');
  assert.match(outcome.stderr, /no logs/i);
  assert.deepEqual(outcome.call.args.slice(0, 6), ['--user', '-u', f.unit, '-n', '5', '--no-pager']);
});

test('a nonempty finite read prints the entries and exits 0', async t => {
  const f = await fixture(t);
  const outcome = await readWith(t, f, ['--lines', '7'], child => {
    child.stdout.write('2026-01-01T00:00:00+0000 host unit[1]: first\n2026-01-01T00:00:01+0000 host unit[1]: second\n');
    child.stdout.end();
    child.emit('close', 0, null);
  });
  assert.equal(outcome.status, 0);
  assert.equal(outcome.stdout, '2026-01-01T00:00:00+0000 host unit[1]: first\n2026-01-01T00:00:01+0000 host unit[1]: second\n');
  assert.equal(outcome.stderr, '');
  assert.deepEqual(outcome.call.args, ['--user', '-u', f.unit, '-n', '7', '--no-pager', '--quiet', '-o', 'short-iso']);
});

test('a real entry that contains the old no-entry text is a nonempty read', async t => {
  const f = await fixture(t);
  const entry = `2026-01-01T00:00:00+0000 host unit[1]: ${NO_ENTRIES}\n`;
  const outcome = await readWith(t, f, [], child => { child.stdout.write(entry); child.stdout.end(); child.emit('close', 0, null); });
  assert.equal(outcome.status, 0);
  assert.equal(outcome.stdout, entry);
  assert.doesNotMatch(outcome.stderr, /no logs/i);

  // A line that is exactly the old status text is also output, not a reason to call the journal empty.
  const exact = await readWith(t, f, [], child => { child.stdout.write(`${NO_ENTRIES}\n`); child.stdout.end(); child.emit('close', 0, null); });
  assert.equal(exact.status, 0);
  assert.equal(exact.stdout, `${NO_ENTRIES}\n`);
});

test('output split across chunk boundaries is reassembled and never read as empty', async t => {
  const f = await fixture(t);
  const text = '2026-01-01T00:00:00+0000 host unit[1]: first éè line\n2026-01-01T00:00:01+0000 host unit[1]: second\n';
  const bytes = Buffer.from(text);
  const middle = bytes.indexOf(Buffer.from('first')) + 3; // inside a word of the first line
  const accent = bytes.indexOf(Buffer.from('é')) + 1; // inside a two-byte character
  const cuts = [...new Set([middle, accent, bytes.length - 1])].sort((a, b) => a - b);
  const outcome = await readWith(t, f, [], async child => {
    let from = 0;
    for (const cut of [...cuts, bytes.length]) { child.stdout.write(bytes.subarray(from, cut)); from = cut; await sleep(5); }
    child.stdout.end();
    child.emit('close', 0, null);
  });
  assert.equal(outcome.status, 0);
  assert.equal(outcome.stdout, text);
  assert.equal(outcome.stderr, '');
});

test('a single byte of output without a line break still counts as output and is flushed', async t => {
  const f = await fixture(t);
  const outcome = await readWith(t, f, [], child => {
    child.stdout.write('x');
    child.stdout.end();
    child.emit('close', 0, null);
  });
  assert.equal(outcome.status, 0);
  assert.equal(outcome.stdout, 'x\n');
});

test('output that arrives after an initial empty chunk is not an empty read', async t => {
  const f = await fixture(t);
  const outcome = await readWith(t, f, [], async child => {
    child.stdout.write(Buffer.alloc(0));
    await sleep(10);
    child.stdout.write('late entry\n');
    child.stdout.end();
    child.emit('close', 0, null);
  });
  assert.equal(outcome.status, 0);
  assert.equal(outcome.stdout, 'late entry\n');
});

test('a nonzero journalctl exit is a reader failure with its diagnostic, not an empty journal', async t => {
  const f = await fixture(t);
  const failed = await readWith(t, f, [], child => {
    child.stderr.write('Failed to connect to bus: No medium found\n');
    child.stdout.end();
    child.emit('close', 1, null);
  });
  assert.equal(failed.status, 1);
  assert.equal(failed.stdout, '');
  assert.match(failed.stderr, /journalctl exited with status 1: Failed to connect to bus: No medium found/);
  assert.doesNotMatch(failed.stderr, /no logs/i);

  const partial = await readWith(t, f, [], child => {
    child.stdout.write('one entry\n');
    child.stderr.write('Failed to read journal\n');
    child.stdout.end();
    child.emit('close', 1, null);
  });
  assert.equal(partial.status, 1);
  assert.equal(partial.stdout, 'one entry\n');
  assert.match(partial.stderr, /journalctl exited with status 1: Failed to read journal/);

  const signalled = await readWith(t, f, [], child => { child.stdout.end(); child.emit('close', null, 'SIGKILL'); });
  assert.equal(signalled.status, 1);
  assert.match(signalled.stderr, /journalctl ended by SIGKILL/);
  assert.doesNotMatch(signalled.stderr, /no logs/i);
});

test('denied journal access is reported as a reader failure, not as an empty journal', async t => {
  const f = await fixture(t);
  const outcome = await readWith(t, f, [], child => {
    child.stderr.write('No journal files were opened due to insufficient permissions.\n');
    child.stdout.end();
    child.emit('close', 1, null);
  });
  assert.equal(outcome.status, 1);
  assert.equal(outcome.stdout, '');
  assert.match(outcome.stderr, /journalctl exited with status 1: No journal files were opened due to insufficient permissions\./);
  assert.doesNotMatch(outcome.stderr, /no logs/i);
});

test('a missing or unrunnable journalctl is reported distinctly from an empty journal', async t => {
  const f = await fixture(t);
  const noExecutable = runLogs(f, [], { dependencies: { journalctl: undefined, spawnProcess: () => { throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }); } } });
  const missing = { status: await noExecutable.finished, ...noExecutable.output() };
  assert.equal(missing.status, 1);
  assert.equal(missing.stdout, '');
  assert.match(missing.stderr, /journalctl/);
  assert.doesNotMatch(missing.stderr, /no logs/i);

  const journal = scriptedJournal();
  const run = runLogs(f, [], { dependencies: { journalctl: '/nonexistent/journalctl', spawnProcess: journal.spawnProcess } });
  await until(() => journal.calls.length === 1, 'journalctl was not started');
  journal.calls[0].child.emit('error', Object.assign(new Error('spawn /nonexistent/journalctl ENOENT'), { code: 'ENOENT' }));
  const status = await run.finished;
  assert.equal(status, 1);
  assert.match(run.output().stderr, /journalctl could not run: .*ENOENT/);
  assert.doesNotMatch(run.output().stderr, /no logs/i);
});

test('the read is filtered to the unit of the selected state directory and needs no running instance', async t => {
  const a = await fixture(t);
  const b = await fixture(t);
  assert.notEqual(a.unit, b.unit);
  for (const f of [a, b]) {
    const outcome = await readWith(t, f, [], child => { child.stdout.write('entry\n'); child.stdout.end(); child.emit('close', 0, null); });
    assert.equal(outcome.status, 0);
    const index = outcome.call.args.indexOf('-u');
    assert.equal(outcome.call.args[index + 1], f.unit);
    assert.equal(outcome.call.args.filter(argument => argument === '-u').length, 1);
    assert.ok(!outcome.call.options.shell && outcome.call.options.stdio[0] === 'ignore');
  }
});

test('--follow without entries keeps waiting, then Ctrl-C exits 130 and ends only the reader', async t => {
  const f = await fixture(t);
  const journal = scriptedJournal();
  const signals = new EventEmitter();
  let settled = false;
  const run = runLogs(f, ['--follow'], { signals, dependencies: { journalctl: '/usr/bin/journalctl', spawnProcess: journal.spawnProcess } });
  run.finished.then(() => { settled = true; });
  await until(() => journal.calls.length === 1, 'journalctl was not started');
  const [{ args, child }] = journal.calls;
  assert.deepEqual(args, ['--user', '-u', f.unit, '-n', '100', '--no-pager', '-f', '-o', 'short-iso']);
  await sleep(150);
  assert.equal(settled, false, 'follow waits for future entries instead of reporting an empty journal');
  assert.deepEqual(run.output(), { stdout: '', stderr: '' });
  assert.deepEqual(child.killed, []);

  child.stdout.write('a future entry\n');
  await until(() => run.output().stdout === 'a future entry\n', 'the future entry was not printed');
  assert.equal(settled, false);

  signals.emit('SIGINT');
  const status = await run.finished;
  assert.equal(status, FOLLOW_INTERRUPTED_EXIT_CODE);
  assert.equal(journal.calls.length, 1, 'no second reader was started');
  assert.deepEqual(child.killed, ['SIGTERM'], 'only the reader this command started is ended');
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
  assert.doesNotMatch(run.output().stderr, /no logs/i);
  assert.deepEqual(run.adapterCalls, []);
});

test('--follow ended by Ctrl-C before any entry exits 130 with no output', async t => {
  const f = await fixture(t);
  const journal = scriptedJournal();
  const signals = new EventEmitter();
  const run = runLogs(f, ['--follow'], { signals, dependencies: { journalctl: '/usr/bin/journalctl', spawnProcess: journal.spawnProcess } });
  await until(() => journal.calls.length === 1, 'journalctl was not started');
  signals.emit('SIGINT');
  assert.equal(await run.finished, FOLLOW_INTERRUPTED_EXIT_CODE);
  assert.deepEqual(run.output(), { stdout: '', stderr: '' });
  assert.deepEqual(journal.calls[0].child.killed, ['SIGTERM']);
});

// --- A real executable that behaves like journalctl --------------------------------------------------------------

/**
 * Prints the status line unless it was started with --quiet, as systemd's journalctl does, and prints `entry` when the
 * environment names one. Records its arguments so the spawn contract can be checked.
 */
async function syntheticJournalctl(f) {
  const script = path.join(f.root, 'journalctl');
  await fs.writeFile(script, `#!/bin/sh
printf '%s\\n' "$@" > "$ARGV_FILE"
quiet=0
for argument in "$@"; do [ "$argument" = "--quiet" ] && quiet=1; done
if [ -n "$ENTRY" ]; then printf '%s\\n' "$ENTRY"; exit 0; fi
if [ "$quiet" = 0 ]; then echo '${NO_ENTRIES}'; fi
exit 0
`, { mode: 0o755 });
  return script;
}

test('a real journalctl-like executable: an empty unit exits 1 and the status line is never needed', { skip: !posix, timeout: 30000 }, async t => {
  const f = await fixture(t);
  const script = await syntheticJournalctl(f);
  const argvFile = path.join(f.root, 'argv.txt');
  const run = runLogs(f, ['--lines', '3'], { dependencies: { journalctl: script, environment: { HOME: f.home, PATH: process.env.PATH, ARGV_FILE: argvFile } } });
  const status = await run.finished;
  assert.equal(status, 1);
  assert.equal(run.output().stdout, '');
  assert.match(run.output().stderr, /no logs/i);
  assert.deepEqual((await fs.readFile(argvFile, 'utf8')).trim().split('\n'), ['--user', '-u', f.unit, '-n', '3', '--no-pager', '--quiet', '-o', 'short-iso']);
});

test('a real journalctl-like executable: an entry containing the old status text is printed with exit 0', { skip: !posix, timeout: 30000 }, async t => {
  const f = await fixture(t);
  const script = await syntheticJournalctl(f);
  const entry = `2026-01-01T00:00:00+0000 host unit[1]: ${NO_ENTRIES}`;
  const run = runLogs(f, [], { dependencies: { journalctl: script, environment: { HOME: f.home, PATH: process.env.PATH, ARGV_FILE: path.join(f.root, 'argv.txt'), ENTRY: entry } } });
  assert.equal(await run.finished, 0);
  assert.equal(run.output().stdout, `${entry}\n`);
  assert.equal(run.output().stderr, '');
});
