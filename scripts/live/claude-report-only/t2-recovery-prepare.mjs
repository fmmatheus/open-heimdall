// T2 recovery fixture: one disposable repository per scenario plus two fixture-only executor agents that deliberately
// leave `handoff` out of their final report. Starts nothing and calls no model.
//   node t2-recovery-prepare.mjs --root /private/tmp/heimdall-0006.XXXXXX
//
// Fixture-only settings (the committed examples/ agents are untouched; these live in the fixture config directory):
//   adr-executor-omit-once    first final reply omits `handoff`; a reply to a "Report-only correction" message is complete
//   adr-executor-omit-always  every final reply omits `handoff`, corrections included
//   adr-orchestrator          the shipped agent plus a subagent allow rule for each fixture executor
// Everything else about the executor is the shipped adr-executor agent verbatim.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFixtureRoot, emit, parseArguments, readManifest, updateManifest } from './lib.mjs';
import { createRepository } from './repo.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = assertFixtureRoot(parseArguments(process.argv.slice(2)).root ?? '');
const manifest = readManifest(root);
if (!manifest.t2Prepared) throw new Error('Run t2-prepare.mjs first');
if (manifest.t2?.recovery) throw new Error('Recovery fixtures were already prepared in this root');

const agents = path.join(manifest.stores.configDirectory, 'agents');
const shipped = fs.readFileSync(path.join(here, '..', '..', '..', 'examples', 'opencode', 'agents', 'adr-executor.md'), 'utf8');
const rule = {
  'adr-executor-omit-once': 'FIXTURE VERIFICATION RULE (this exercises the report correction path; it is not part of the task). Do all the work and run every check first. Then your FIRST final reply for a task must leave out the `handoff` field entirely; every other field stays complete and truthful. If a later message in this session begins with "Report-only correction", answer it with the complete report including `handoff` (what the next task must know), and call no tools.',
  'adr-executor-omit-always': 'FIXTURE VERIFICATION RULE (this exercises the report correction cap; it is not part of the task). Do all the work and run every check first. Then EVERY final reply for a task, including replies to "Report-only correction" messages, must leave out the `handoff` field entirely; every other field stays complete and truthful.',
};
for (const [name, text] of Object.entries(rule)) fs.writeFileSync(path.join(agents, `${name}.md`), `${shipped.trimEnd()}\n\n${text}\n`, { flag: 'wx', mode: 0o600 });

// The shipped orchestrator may only delegate to adr-planner and adr-executor; allow the two fixture executors as well.
const orchestrator = path.join(agents, 'adr-orchestrator.md');
const original = fs.readFileSync(orchestrator, 'utf8');
const anchor = '  - action: subagent\n    resource: adr-executor\n    effect: allow\n';
if (original.split(anchor).length !== 2) throw new Error('adr-orchestrator.md permission anchor did not match exactly once');
fs.writeFileSync(orchestrator, original.replace(anchor, anchor + Object.keys(rule).map(name => `  - action: subagent\n    resource: ${name}\n    effect: allow\n`).join('')));

const source = manifest.t2.repositories.recovery;
const toml = fs.readFileSync(path.join(source, '.heimdall.toml'), 'utf8');
const adr = fs.readFileSync(path.join(source, 'docs', 'adr.md'), 'utf8');
const repositories = {};
for (const [key, agent] of [['correct', 'adr-executor-omit-once'], ['cap', 'adr-executor-omit-always'], ['interrupt', 'adr-executor-omit-always']]) {
  const created = await createRepository(root, { name: `repo-${key}`, extraFiles: { 'docs/adr.md': adr } });
  const patched = toml.replace('executorAgent = "adr-executor"', `executorAgent = "${agent}"`);
  if (patched === toml) throw new Error('executorAgent line not found in the recovery configuration');
  fs.writeFileSync(path.join(created.repository, '.heimdall.toml'), patched, { flag: 'wx', mode: 0o600 });
  fs.mkdirSync(path.join(created.repository, '.git', 'info'), { recursive: true });
  fs.appendFileSync(path.join(created.repository, '.git', 'info', 'exclude'), '.heimdall.toml\n.heimdall/\n.opencode/\n');
  repositories[key] = { directory: created.repository, executorAgent: agent, head: created.head, hashes: created.hashes };
}
updateManifest(root, current => { current.t2.recovery = { preparedAt: new Date().toISOString(), agents: Object.keys(rule), repositories }; });
emit({ ok: true, repositories });
