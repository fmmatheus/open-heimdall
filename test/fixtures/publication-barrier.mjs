import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * A deterministic barrier on the publication of a launch attempt's client evidence.
 *
 * The production record code publishes `launch-attempt.json` with `writePrivateFile`, which writes a private temporary
 * file next to it and then replaces the record with one `fs.rename` through the default export of `node:fs/promises`.
 * That object is read at call time, so replacing its `rename` property holds exactly that final atomic replacement and
 * nothing else: the temporary file is complete, the record on disk is untouched, and the publication is still pending
 * from the point of view of the code that started it. Only a rename that
 *   - targets `recordFile`, and
 *   - publishes content that names a `client`
 * is held; every other rename (the attempt's first write, the `requested` marker, other files) runs unchanged.
 *
 * `wait` receives what is being published and decides how long the rename stays held; `after` runs once the real
 * rename has returned or failed. A design that publishes the evidence through another primitive than this rename has to
 * move the barrier to that primitive, keeping the same meaning: hold only the final replacement of the record by the
 * evidence of the first attempt, and nothing else.
 *
 * Test fixture only: it changes nothing about what the product code does, it only delays one filesystem call.
 */
export function installPublicationBarrier({ recordFile, wait, after, once = true }) {
  const original = fsp.rename;
  let held = 0;
  const controller = {
    /** How many publications were held so far. */
    held: () => held,
    restore() { fsp.rename = original; },
  };
  fsp.rename = async function rename(from, to, ...rest) {
    let published = null;
    if (path.resolve(String(to)) === recordFile && (!once || held === 0)) {
      try { published = JSON.parse(fs.readFileSync(from, 'utf8')); } catch { /* not a record publication */ }
      if (!(published && typeof published === 'object' && published.client !== undefined)) published = null;
    }
    if (published === null) return original.call(this, from, to, ...rest);
    held += 1;
    const description = { attemptId: published.attemptId, client: published.client, phase: published.phase };
    await wait(description);
    try { return await original.call(this, from, to, ...rest); }
    finally { await after?.(description); }
  };
  return controller;
}

/** A promise with its settlement exposed, for hold/release pairs. */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}
