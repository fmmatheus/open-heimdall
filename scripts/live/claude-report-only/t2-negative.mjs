// T2 follow-up scenarios against the disposable server, through the real workflow runner with fresh claude-code/sonnet
// planner and executor children.
//   node t2-negative.mjs --root /private/tmp/heimdall-0005.XXXXXX --scenario blocked|unresolved|retained
//
//   blocked     a fixture-only executor replies blocked (missing owner prerequisite): the run must stay paused with
//               no report-correction prompt, no restriction and no task advancement
//   unresolved  a fixture-only executor replies `completed` with one gate passed:false: same expectations
//   retained    fixture-only observation fault (control socket `fault`): the correction child is really interrupted but the
//               observer keeps reporting it active, so the runtime cannot confirm termination and must keep the report-only
//               restriction. The fault is then removed (the child is genuinely idle) and an explicit resume must release the
//               retained restriction after fresh idle proof; an ordinary tool call then works.
// Evidence: <root>/evidence/negative-<scenario>.jsonl (timeline) and negative-<scenario>.json (summary).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertFixtureRoot, parseArguments, readManifest } from './lib.mjs';
import { connect, control, createSession, prompt, readLog, sleep, transcript, waitIdle, waitUntil } from './t2-client.mjs';

const options = parseArguments(process.argv.slice(2));
const root = assertFixtureRoot(options.root ?? '');
const scenario = options.scenario;
if (!['blocked', 'unresolved', 'retained'].includes(scenario)) throw new Error('--scenario must be blocked, unresolved or retained');
const manifest = readManifest(root);
const connection = await connect(root, `recovery:${scenario}`);
const repository = connection.directory;
const timeline = path.join(root, 'evidence', `negative-${scenario}.jsonl`);
const note = entry => fs.appendFileSync(timeline, JSON.stringify({ at: Date.now(), ...entry }) + '\n');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

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

let sampling = true;
let lastSeen = '';
let everRestricted = false;
const sampler = (async () => {
  while (sampling) {
    const found = findState();
    const current = brief(found);
    const restricted = current?.child ? await control(root, 'has', { sessionID: current.child }).catch(() => undefined) : undefined;
    if (restricted?.restricted) everRestricted = true;
    const signature = JSON.stringify([current, restricted]);
    if (signature !== lastSeen) { lastSeen = signature; note({ event: 'checkpoint', ...current, childRestriction: restricted }); }
    await sleep(500);
  }
})();

const parent = await createSession(connection, { agent: 'adr-orchestrator', title: `t2 negative ${scenario}` });
const parentID = parent.id;
const executorAgent = manifest.t2.recovery.repositories[scenario].executorAgent;
note({ event: 'parent created', parentID, executorAgent });
const summary = { scenario, parentID, repository, executorAgent, steps: [] };
const step = async (name, run) => { note({ event: 'step', name }); const value = await run(); summary.steps.push({ name, ...value }); return value; };
const tail = async () => (await transcript(connection, parentID)).slice(-3);
const snapshot = () => ({ checkpoint: brief(findState()) });
const start = 'Use adr_workflow with action "start" and adr "docs/adr.md" now. Report the result and wait.';
const resume = found => `Use adr_workflow with action "resume", runId "${found.id}" and input "Owner: continue T1 and give the full report." now. Report the result and wait.`;

const postcheck = async child => {
  const active = await connection.client.session.active();
  const restrictionBefore = await control(root, 'has', { sessionID: child });
  const file = `after-release-${scenario}.txt`;
  const offset = readLog(root, 'observer.jsonl').length;
  await prompt(connection, child, `Use the write tool to create the file ${file} in the repository root containing exactly the text ok. Then reply done.`);
  await waitIdle(connection, child, 300_000);
  const events = readLog(root, 'observer.jsonl').slice(offset).filter(event => event.sessionID === child);
  return {
    child, idleBefore: !(child in active), restrictionBefore,
    fileWritten: fs.existsSync(path.join(repository, file)) && fs.readFileSync(path.join(repository, file), 'utf8') === 'ok',
    writeReachedAllHooks: events.some(event => event.stage === 'post' && event.event === 'execute.before' && event.tool === 'write'),
    writeCompleted: events.some(event => event.stage === 'post' && event.event === 'execute.after' && event.status === 'completed'),
    contextToolCounts: events.filter(event => event.stage === 'post' && event.event === 'context').map(event => event.tools.length),
  };
};

await prompt(connection, parentID, start);
if (scenario === 'blocked' || scenario === 'unresolved') {
  await step('first run to idle', async () => { await waitIdle(connection, parentID, 1_500_000); return { ...snapshot(), parentTail: await tail() }; });
}
if (scenario === 'retained') {
  const during = await waitUntil(() => { const found = findState(); return found?.state.attempt?.purpose === 'report-correction' && found.state.attempt.child && found; }, { timeoutMs: 1_200_000, stepMs: 300, label: 'a running report correction' });
  const child = during.state.child;
  const attemptId = during.state.attempt.id;
  await step('fault the observer for the correction child, then interrupt the parent', async () => {
    note({ event: 'fault', child, reply: await control(root, 'fault', { sessionID: child }) });
    const reply = await connection.client.session.interrupt({ sessionID: parentID });
    note({ event: 'interrupt sent', reply: JSON.stringify(reply).slice(0, 200) });
    await waitIdle(connection, parentID, 300_000).catch(error => note({ event: 'parent wait', error: String(error.message) }));
    const active = await connection.client.session.active();
    return { child, attemptId, childActiveInRealActiveMap: child in active, parentActive: parentID in active, restrictionAfterUnconfirmedInterrupt: await control(root, 'has', { sessionID: child }), ...snapshot() };
  });
  // The original invocation keeps polling the (faulted) observer for its confirmation window (cancellationWaitMs = 30 s) and
  // only then gives up. Lift the fault only after it has: otherwise that in-flight loop, not a later invocation, could release.
  await step('stay faulted until the original invocation gives up', async () => {
    const gaveUp = await waitUntil(() => { const found = findState(); return found?.state.status === 'paused' && found; }, { timeoutMs: 180_000, stepMs: 500, label: 'the interrupted invocation to give up and persist a pause' });
    return { restrictionStillHeld: await control(root, 'has', { sessionID: child }), observationsSoFar: (await control(root, 'faultCount', { sessionID: child })).observations, ...snapshot(), reasonText: String(gaveUp.state.reason ?? '').slice(0, 300) };
  });
  const retainedState = findState();
  await step('remove the fault: the child is genuinely idle', async () => {
    const lifted = await control(root, 'unfault', { sessionID: child });
    await sleep(3000); // with no invocation running, nothing may release the restriction by itself
    const active = await connection.client.session.active();
    return { lifted, childActiveInRealActiveMap: child in active, parentActive: parentID in active, restrictionBeforeResume: await control(root, 'has', { sessionID: child }) };
  });
  await step('resume: fresh idle proof then owner-matched release', async () => {
    const found = findState();
    await prompt(connection, parentID, resume(found));
    const released = await waitUntil(async () => { const state = await control(root, 'has', { sessionID: child }); return state.restricted ? false : state; }, { timeoutMs: 600_000, stepMs: 250, label: 'release of the retained restriction' }).catch(error => ({ error: String(error.message) }));
    note({ event: 'restriction released', released });
    await waitIdle(connection, parentID, 1_500_000);
    return { child, retainedOwnerAttempt: retainedState.state.reportRecovery?.attempts?.at(-1), released, ...snapshot(), parentTail: await tail() };
  });
  const checkChild = findState().state.child;
  await step('ordinary tool call after the late release', async () => ({ ...(await postcheck(checkChild)) }));
}

sampling = false;
await sampler;
const found = findState();
summary.final = snapshot();
summary.everRestrictedWhileSampled = everRestricted;
if (found) {
  summary.attemptReceipts = fs.readdirSync(found.dir).filter(name => /^attempt-.*\.json$/.test(name)).map(name => {
    const receipt = JSON.parse(fs.readFileSync(path.join(found.dir, name), 'utf8'));
    return { file: name, sha256: sha(path.join(found.dir, name)), purpose: receipt.purpose ?? 'task', status: receipt.status, child: receipt.child, model: receipt.model, variant: receipt.variant };
  });
  const replyFile = path.join(found.dir, 'reply-T1.json');
  if (fs.existsSync(replyFile)) {
    const reply = JSON.parse(fs.readFileSync(replyFile, 'utf8'));
    summary.executorReply = { sha256: sha(replyFile), status: reply.status, ...(reply.reason ? { reason: String(reply.reason).slice(0, 300) } : {}), ...(Array.isArray(reply.evidence) ? { gates: reply.evidence.map(gate => ({ gateId: gate.gateId, passed: gate.passed })) } : {}), hasHandoff: typeof reply.handoff === 'string' && reply.handoff.length > 0 };
  }
  const child = found.state.child ?? found.state.results?.[0]?.sessionId;
  if (child) {
    const messages = await transcript(connection, child);
    summary.childUserMessages = messages.filter(message => message.type === 'user').map(message => ({ correctionPrompt: /^Report-only correction/.test(message.text ?? ''), length: (message.text ?? '').length }));
    summary.childTools = readLog(root, 'observer.jsonl').filter(event => event.stage === 'post' && event.event === 'context' && event.sessionID === child).map(event => event.tools.length);
  }
  summary.implementationHashes = Object.fromEntries(['package.json', 'src/impl.js', 'test/impl.test.js'].map(file => [file, sha(path.join(repository, file))]));
}
fs.writeFileSync(path.join(root, 'evidence', `negative-${scenario}.json`), JSON.stringify(summary, null, 2));
process.stdout.write(JSON.stringify({ scenario, final: summary.final, receipts: summary.attemptReceipts, executorReply: summary.executorReply, childUserMessages: summary.childUserMessages }, null, 1) + '\n');
