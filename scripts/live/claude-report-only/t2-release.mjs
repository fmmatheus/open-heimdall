// T2 late-release checks on the live registry and the paused `interrupt` run.
//   node t2-release.mjs --root /private/tmp/heimdall-0006.XXXXXX
//
//   1. owner isolation: a restriction held by one owner is not removed by another owner's release, and an
//      unowned/other-session restriction is untouched
//   2. late release: the interrupt scenario's cancel confirmed idle at once, so the runtime never kept a restriction
//      past a cancel. To exercise the retained-restriction path anyway, the paused child is restricted again under its
//      recorded owner (parent, child, correction attempt id, run id). The next explicit resume must release exactly that
//      owner after fresh idle proof, and the executor must then have its tools back.
// The re-created restriction is a harness action, not a runtime one; it is reported as such.
import fs from 'node:fs';
import path from 'node:path';
import { assertFixtureRoot, parseArguments } from './lib.mjs';
import { connect, control, createSession, prompt, readLog, transcript, waitIdle, waitUntil } from './t2-client.mjs';

const root = assertFixtureRoot(parseArguments(process.argv.slice(2)).root ?? '');
const evidence = path.join(root, 'evidence');
const connection = await connect(root, 'recovery:interrupt');
const previous = JSON.parse(fs.readFileSync(path.join(evidence, 'recovery-interrupt.json'), 'utf8'));
const result = { harnessAction: 'owner-matched re-restriction of the paused child; not left behind by the runtime' };

// 1. Owner isolation on a throwaway session.
{
  const session = await createSession(connection, { title: 't2 owner isolation' });
  const sessionID = session.id;
  const owner = suffix => ({ sessionID, parent: `ses_fixture_owner_${suffix}`, attemptId: `attempt-${suffix}`, runId: `run-${suffix}` });
  const first = await control(root, 'restrict', owner('a'));
  const second = await control(root, 'restrict', owner('b'));
  const releaseWrongRun = await control(root, 'releaseOwned', { ...owner('a'), runId: 'run-other' });
  const releaseA = await control(root, 'releaseOwned', owner('a'));
  const releaseAAgain = await control(root, 'releaseOwned', owner('a'));
  const stillRestricted = await control(root, 'has', { sessionID });
  const releaseB = await control(root, 'releaseOwned', owner('b'));
  result.ownerIsolation = { first, second, releaseWrongRun, releaseA, releaseAAgain, stillRestrictedForB: stillRestricted, releaseB };
}

// 2. Late release through the real resume.
const state = (() => {
  const runs = path.join(connection.directory, '.heimdall', 'runs');
  const id = fs.readdirSync(runs).find(name => fs.existsSync(path.join(runs, name, 'state.json')));
  return { id, state: JSON.parse(fs.readFileSync(path.join(runs, id, 'state.json'), 'utf8')) };
})();
const child = state.state.child;
const attemptId = state.state.reportRecovery.attempts.at(-1);
const owner = { sessionID: child, parent: state.state.parent, attemptId, runId: state.id };
result.before = { status: state.state.status, corrections: state.state.reportRecovery.corrections, child, parent: state.state.parent };
const active = await connection.client.session.active();
result.idleBeforeRestrict = !(child in active) && !(state.state.parent in active);
result.restricted = await control(root, 'restrict', owner);
const offset = readLog(root, 'observer.jsonl').length;
await prompt(connection, previous.parentID, `Use adr_workflow with action "resume", runId "${state.id}" and input "Owner: continue T1 and give the full report." now. Report the result and wait.`);
result.released = await waitUntil(async () => { const now = await control(root, 'has', { sessionID: child }); return now.restricted ? false : now; }, { timeoutMs: 600_000, stepMs: 200, label: 'owner-matched release at resume' });
const releasedAt = Date.now();
await waitIdle(connection, previous.parentID, 1_500_000);
const after = JSON.parse(fs.readFileSync(path.join(connection.directory, '.heimdall', 'runs', state.id, 'state.json'), 'utf8'));
result.after = { status: after.status, corrections: after.reportRecovery?.corrections, mode: after.reportRecovery?.mode, diagnostic: after.reportRecovery?.diagnostic?.code, reason: after.reason };
const events = readLog(root, 'observer.jsonl').slice(offset).filter(event => event.sessionID === child);
result.executorAfterRelease = {
  toolCallsReachingAllHooks: events.filter(event => event.stage === 'post' && event.event === 'execute.before' && event.at >= releasedAt - 2000).map(event => event.tool),
  toolCallsDenied: events.filter(event => event.stage === 'pre' && event.event === 'execute.before').filter(pre => !events.some(post => post.stage === 'post' && post.event === 'execute.before' && post.callID === pre.callID)).map(event => event.tool),
  contextToolCounts: events.filter(event => event.stage === 'post' && event.event === 'context').map(event => event.tools.length),
};
result.finalRestriction = await control(root, 'has', { sessionID: child });
fs.writeFileSync(path.join(evidence, 'recovery-release.json'), JSON.stringify(result, null, 2));
process.stdout.write(JSON.stringify(result, null, 1) + '\n');
