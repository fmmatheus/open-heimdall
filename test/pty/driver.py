"""Runs a command on a pseudo-terminal and drives it with an expect/send script.

Usage: python3 -I driver.py SPECIFICATION_JSON

The specification is a JSON object:
  argv      command and arguments (argv[0] is looked up on PATH)
  cwd       working directory
  env       complete child environment
  steps     list of {"expect": REGEX, "send": TEXT}; REGEX is searched in the terminal output received since the
            previous step matched, with escape sequences removed, and TEXT is written to the terminal afterwards
  deadline  seconds allowed for the whole run; the child is killed when it is exceeded

After the last step the driver waits for the child to exit. It prints one JSON document on stdout:
  output        everything the child wrote, escape sequences removed
  status        exit code, or the negated signal number when the child was killed by a signal
  timedOut      true when the deadline expired
  failedStep    index of the step whose pattern never appeared before the child ended or the deadline, or null
"""
import json
import os
import pty
import re
import select
import signal
import sys
import time

ESCAPES = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|\x1b\][^\x07]*\x07')


def clean(raw):
    return ESCAPES.sub('', raw.decode('utf-8', errors='replace')).replace('\r\n', '\n').replace('\r', '\n')


def main():
    spec = json.loads(sys.argv[1])
    deadline = time.monotonic() + spec['deadline']
    pid, master = pty.fork()
    if pid == 0:
        os.chdir(spec['cwd'])
        os.execvpe(spec['argv'][0], spec['argv'], spec['env'])
    raw = b''
    consumed = 0
    step = 0
    failed = None
    timed_out = False
    eof = False

    def pump(timeout):
        nonlocal raw, eof
        if eof:
            return
        ready, _, _ = select.select([master], [], [], timeout)
        if not ready:
            return
        try:
            data = os.read(master, 65536)
        except OSError:
            data = b''
        if data:
            raw += data
        else:
            eof = True

    while step < len(spec['steps']) and failed is None:
        pending = clean(raw)
        text = pending[consumed:]
        match = re.search(spec['steps'][step]['expect'], text)
        if match:
            consumed += match.end()
            os.write(master, spec['steps'][step]['send'].encode())
            step += 1
            continue
        if eof or time.monotonic() > deadline:
            failed = step
            timed_out = not eof
            break
        pump(0.05)

    status = None
    while status is None:
        done, wait = os.waitpid(pid, os.WNOHANG)
        if done:
            status = os.waitstatus_to_exitcode(wait)
            break
        if time.monotonic() > deadline:
            timed_out = True
            os.kill(pid, signal.SIGKILL)
            _, wait = os.waitpid(pid, 0)
            status = os.waitstatus_to_exitcode(wait)
            break
        pump(0.05)
    # Collect output written just before exit.
    end = time.monotonic() + 0.5
    while not eof and time.monotonic() < end:
        pump(0.05)
    os.close(master)
    sys.stdout.write(json.dumps({'output': clean(raw), 'status': status, 'timedOut': timed_out, 'failedStep': failed}))


main()
