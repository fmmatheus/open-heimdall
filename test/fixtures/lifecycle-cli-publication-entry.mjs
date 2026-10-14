/*
 * Test-only process entry: the production lifecycle command of `lifecycle-cli-entry.mjs`, with the publication of a
 * launch attempt's client evidence held while the fixture's `publication-hold` file exists (see
 * `publication-barrier.mjs`). A held publication writes `publication-reached.<pid>` next to the fixture and keeps this
 * process alive until the hold file is removed, so a test can end the invoking command (deadline, Ctrl-C, SIGKILL)
 * while its publication is still pending, run another command from a different process, and only then let the
 * publication finish.
 *
 *   node lifecycle-cli-publication-entry.mjs <fixture.json> <start|stop> [arguments...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { installPublicationBarrier } from './publication-barrier.mjs';

const [fixturePath] = process.argv.slice(2);
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const root = path.dirname(fixturePath);
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

installPublicationBarrier({
  recordFile: fixture.recordFile,
  once: false,
  async wait(published) {
    if (!fs.existsSync(fixture.publicationHold)) return;
    fs.writeFileSync(path.join(root, `publication-reached.${process.pid}`), JSON.stringify(published));
    while (fs.existsSync(fixture.publicationHold)) await sleep(20);
  },
  async after(published) {
    fs.writeFileSync(path.join(root, `publication-landed.${process.pid}`), JSON.stringify(published));
  },
});

await import('./lifecycle-cli-entry.mjs');
