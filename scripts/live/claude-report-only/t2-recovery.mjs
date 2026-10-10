// T2 recovery scenarios against the disposable server: the real workflow runs through the real plugin with fresh
// claude-code/sonnet planner and executor children.
//   node t2-recovery.mjs --root /private/tmp/heimdall-0006.XXXXXX --scenario correct|cap|interrupt
//
//   correct    executor omits `handoff` once; one automatic correction on the same idle child repairs it
//   cap        executor omits `handoff` every time; corrections stop at the cap; a later resume does not add more
//   interrupt  the parent is cancelled during a correction; the restriction outlives the cancel and is released only
//              by the next resume after idle proof; the executor then has its tools again
// Evidence: <root>/evidence/recovery-<scenario>.jsonl (state timeline) and recovery-<scenario>.json (summary).
import fs from 'node:fs';
import path from 'node:path';
import { assertFixtureRoot, parseArguments, readManifest } from './lib.mjs';
import { connect, control, createSession, prompt, readLog, sleep, transcript, waitIdle, waitUntil } from './t2-client.mjs';

const options = parseArguments(process.argv.slice(2));
const root = assertFixtureRoot(options.root ?? '');
const scenario = options.scenario;
if (!['correct', 'cap', 'interrupt'].includes(scenario)) throw new Error('--scenario must be correct, cap or interrupt');
const manifest = readManifest(root);
const connection = await connect(root, `recovery:${scenario}`);
const repository = connection.directory;
const timeline = path.join(root, 'evidence', `recovery-${scenario}.jsonl`);
const note = entry => fs.appendFileSync(timeline, JSON.stringify({ at: Date.now(), ...entry }) + '\n');

const findState = () => {
  const runs = path.join(repository, '.heimdall', 'runs');
  if (!fs.existsSync(runs)) return undefined;
  const id = fs.readdirSync(runs).find(name => fs.existsSync(path.join(runs, name, 'state.json')));
  if (!id) return undefined;
  try { return { id, dir: path.join(runs, id), state: JSON.parse(fs.readFileSync(path.join(runs, id, 'state.json'), 'utf8')) }; } catch { return undefined; }
};
const brief = found => !found ? null : {
  runId: found.id, status: found.state.status, phase: found.state.phase, index: found.state.index, child: found.state.child,
  attempt: found.state.attempt && { id: found.state.attempt.id, status: found.state.attempt.status, purpose: found.state.attempt.purpose ?? 'task', model: found.state.attempt.model, variant: found.state.attempt.variant },
  reportRecovery: found.state.reportRecovery && { corrections: found.state.reportRecovery.corrections, mode: found.state.reportRecovery.mode, child: found.state.reportRecovery.child, attempts: found.state.reportRecovery.attempts?.length, diagnostic: found.state.reportRecovery.diagnostic },
  results: found.state.results?.map(result => ({ taskId: result.taskId, sessionId: result.sessionId, reportCorrections: result.reportCorrections, model: result.model })),
  reason: found.state.reason, usage: found.state.usage,
};

// Sample the checkpoint (and whether the executor child is restricted) once a second until stopped.
let sampling = true;
let lastSeen = '';
const sampler = (async () => {
  while (sampling) {
    const found = findState();
    const current = brief(found);
    const restricted = current?.child ? await control(root, 'has', { sessionID: current.child }).catch(() => undefined) : undefined;
    const signature = JSON.stringify([current, restricted]);
    if (signature !== lastSeen) { lastSeen = signature; note({ event: 'checkpoint', ...current, childRestriction: restricted }); }
    await sleep(700);
  }
})();

const parent = await createSession(connection, { agent: 'adr-orchestrator', title: `t2 recovery ${scenario}` });
const parentID = parent.id;
note({ event: 'parent created', parentID, executorAgent: manifest.t2.recovery.repositories[scenario].executorAgent });
const start = `Use adr_workflow with action "start" and adr "docs/adr.md" now. Report the result and wait.`;
await prompt(connection, parentID, start);
const summary = { scenario, parentID, repository, executorAgent: manifest.t2.recovery.repositories[scenario].executorAgent, steps: [] };
const step = async (name, run) => { note({ event: 'step', name }); const value = await run(); summary.steps.push({ name, ...value }); return value; };

const snapshot = () => ({ checkpoint: brief(findState()) });
const tail = async () => (await transcript(connection, parentID)).slice(-3);

if (scenario === 'correct' || scenario === 'cap') {
  await step('first run to idle', async () => { await waitIdle(connection, parentID, 1_500_000); return { ...snapshot(), parentTail: await tail() }; });
}
if (scenario === 'cap') {
  const found = findState();
  await step('resume after cap', async () => {
    await prompt(connection, parentID, `The owner resolves this: continue the same task. Use adr_workflow with action "resume", runId "${found.id}" and input "Owner: continue T1 and give the full report." now. Report the result and wait.`);
    await waitIdle(connection, parentID, 1_500_000);
    return { ...snapshot(), parentTail: await tail() };
  });
}
if (scenario === 'interrupt') {
  const during = await waitUntil(() => { const found = findState(); return found?.state.attempt?.purpose === 'report-correction' && found.state.attempt.child && found; }, { timeoutMs: 1_200_000, stepMs: 400, label: 'a running report correction' });
  const child = during.state.child;
  await step('interrupt parent during correction', async () => {
    const reply = await connection.client.session.interrupt({ sessionID: parentID });
    note({ event: 'interrupt sent', reply: JSON.stringify(reply).slice(0, 200) });
    await waitIdle(connection, parentID, 300_000).catch(error => note({ event: 'parent wait', error: String(error.message) }));
    const active = await connection.client.session.active();
    return { child, childActive: child in active, parentActive: parentID in active, restrictionAfterInterrupt: await control(root, 'has', { sessionID: child }), ...snapshot() };
  });
  await step('resume after confirmed idle', async () => {
    const found = findState();
    const active = await connection.client.session.active();
    const idleBefore = !(child in active) && !(parentID in active);
    const restrictionBefore = await control(root, 'has', { sessionID: child });
    await prompt(connection, parentID, `Use adr_workflow with action "resume", runId "${found.id}" and input "Owner: continue T1 and give the full report." now. Report the result and wait.`);
    const released = await waitUntil(async () => { const state = await control(root, 'has', { sessionID: child }); return state.restricted ? false : state; }, { timeoutMs: 600_000, stepMs: 300, label: 'owner-matched release of the retained restriction' }).catch(error => ({ error: String(error.message) }));
    note({ event: 'restriction released', released });
    await waitIdle(connection, parentID, 1_500_000);
    return { child, idleBefore, restrictionBefore, released, ...snapshot(), parentTail: await tail() };
  });
}

sampling = false;
await sampler;
summary.final = snapshot();
const found = findState();
summary.attemptReceipts = found ? fs.readdirSync(found.dir).filter(name => /^attempt-.*\.json$/.test(name)).map(name => {
  const receipt = JSON.parse(fs.readFileSync(path.join(found.dir, name), 'utf8'));
  return { file: name, purpose: receipt.purpose ?? 'task', status: receipt.status, child: receipt.child, model: receipt.model, variant: receipt.variant };
}) : [];
summary.executorToolEvents = readLog(root, 'observer.jsonl').filter(event => event.stage === 'post' && event.event === 'execute.before' && event.sessionID === found?.state.child).length;
fs.writeFileSync(path.join(root, 'evidence', `recovery-${scenario}.json`), JSON.stringify(summary, null, 2));
process.stdout.write(JSON.stringify({ scenario, final: summary.final, receipts: summary.attemptReceipts }, null, 1) + '\n');
