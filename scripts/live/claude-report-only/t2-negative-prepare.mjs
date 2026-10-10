// T2 follow-up fixtures: disposable repositories for the failed/unresolved-work scenarios and for the retained-restriction
// scenario. Starts nothing and calls no model.
//   node t2-negative-prepare.mjs --root /private/tmp/heimdall-0005.XXXXXX
//
//   repo-blocked     farewell ADR; adr-executor-blocked (fixture-only rule) replies blocked, naming a missing owner prerequisite
//   repo-unresolved  farewell ADR; adr-executor-unresolved (fixture-only rule) implements but replies `completed` with one gate
//                    passed:false because it was told not to run the tests
//   repo-retained    farewell ADR with adr-executor-omit-always, used with the fixture observation fault
// A first attempt used an ADR whose input file was absent; the real planner correctly refused to plan it (phase planner),
// which does not exercise the executor path, so the executor-phase outcomes are produced by the fixture rules above.
// Fixture-only settings live in the fixture config directory; the committed examples/ agents are untouched.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFixtureRoot, emit, parseArguments, readManifest, updateManifest } from './lib.mjs';
import { createRepository } from './repo.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const options = parseArguments(process.argv.slice(2));
const root = assertFixtureRoot(options.root ?? '');
const manifest = readManifest(root);
if (!manifest.t2?.recovery) throw new Error('Run t2-recovery-prepare.mjs first');
// --retained-only: recreate repo-retained after moving the previous one aside (e.g. repo-retained-first-run).
const retainedOnly = options['retained-only'] === true;
if (manifest.t2.negative && !retainedOnly) throw new Error('Negative fixtures were already prepared in this root');
if (retainedOnly && (!manifest.t2.negative || fs.existsSync(path.join(root, 'repo-retained')))) throw new Error('--retained-only needs prepared negative fixtures and repo-retained moved aside');

const agents = path.join(manifest.stores.configDirectory, 'agents');
const shipped = fs.readFileSync(path.join(here, '..', '..', '..', 'examples', 'opencode', 'agents', 'adr-executor.md'), 'utf8');
const rules = {
  'adr-executor-blocked': 'FIXTURE VERIFICATION RULE (this exercises the blocked-work path; it is not part of the task). The owner prerequisite for this task is unavailable: the owner sign-off it depends on has not been provided. Do not implement anything, change no files and run no tests. Reply with the blocked shape, naming the missing owner prerequisite as the reason.',
  'adr-executor-unresolved': 'FIXTURE VERIFICATION RULE (this exercises the unresolved-gate path; it is not part of the task). Implement the function and add the test, but do NOT run `npm test` or any test (owner request). Reply with the COMPLETED envelope (not blocked): give an evidence entry for every definition-of-done item, passed:true only for what you actually proved, and passed:false for the item that needs the test run, with a truthful detail that the tests were not run.',
};
if (!retainedOnly) for (const [name, text] of Object.entries(rules)) fs.writeFileSync(path.join(agents, `${name}.md`), `${shipped.trimEnd()}\n\n${text}\n`, { flag: 'wx', mode: 0o600 });

const orchestrator = path.join(agents, 'adr-orchestrator.md');
const original = fs.readFileSync(orchestrator, 'utf8');
const anchor = '  - action: subagent\n    resource: adr-executor-omit-always\n    effect: allow\n';
if (!retainedOnly && original.split(anchor).length !== 2) throw new Error('adr-orchestrator.md permission anchor did not match exactly once');
if (!retainedOnly) fs.writeFileSync(orchestrator, original.replace(anchor, anchor + Object.keys(rules).map(name => `  - action: subagent\n    resource: ${name}\n    effect: allow\n`).join('')));

const farewellAdr = fs.readFileSync(path.join(manifest.t2.repositories.recovery, 'docs', 'adr.md'), 'utf8');
const toml = fs.readFileSync(path.join(manifest.t2.repositories.recovery, '.heimdall.toml'), 'utf8');
const repositories = {};
for (const [key, agent, adr] of [['blocked', 'adr-executor-blocked', farewellAdr], ['unresolved', 'adr-executor-unresolved', farewellAdr], ['retained', 'adr-executor-omit-always', farewellAdr]]) {
  if (retainedOnly && key !== 'retained') continue;
  const created = await createRepository(root, { name: `repo-${key}`, extraFiles: { 'docs/adr.md': adr } });
  const patched = toml.replace('executorAgent = "adr-executor"', `executorAgent = "${agent}"`);
  if (patched === toml) throw new Error('executorAgent line not found in the configuration');
  fs.writeFileSync(path.join(created.repository, '.heimdall.toml'), patched, { flag: 'wx', mode: 0o600 });
  fs.mkdirSync(path.join(created.repository, '.git', 'info'), { recursive: true });
  fs.appendFileSync(path.join(created.repository, '.git', 'info', 'exclude'), '.heimdall.toml\n.heimdall/\n.opencode/\n');
  repositories[key] = { directory: created.repository, executorAgent: agent, head: created.head, hashes: created.hashes };
}
updateManifest(root, current => {
  if (!retainedOnly) current.t2.negative = { preparedAt: new Date().toISOString(), agents: Object.keys(rules) };
  else current.t2.negative.retainedRecreatedAt = new Date().toISOString();
  Object.assign(current.t2.recovery.repositories, repositories);
});
emit({ ok: true, repositories });
