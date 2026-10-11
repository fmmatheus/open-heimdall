// Live end-to-end run of the structured completion protocol through the real plugin, against the disposable server.
//   node e2e-structured.mjs --root /private/tmp/heimdall-0006.XXXXXX [--timeout-minutes 40]
//
// The parent session is an adr-orchestrator that calls adr_workflow start on the fixture ADR repository (repo-adr).
// The real planner and executor children run on the configured claude-code models. This script only reads state:
// it sends exactly one prompt (to the parent), samples the checkpoint, and then writes an evidence summary.
// Evidence: <root>/evidence/e2e-structured.jsonl (timeline) and e2e-structured.json (summary, no raw transcripts).
// Nothing here prints or stores a credential; transcripts are condensed to tool names, states and short result stubs.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertFixtureRoot, parseArguments } from './lib.mjs';
import { connect, control, createSession, prompt, readLog, sleep, transcript, waitIdle, waitUntil } from './t2-client.mjs';

const options = parseArguments(process.argv.slice(2));
const root = assertFixtureRoot(options.root ?? '');
const timeoutMs = Number(options['timeout-minutes'] ?? 40) * 60_000;
const connection = await connect(root, 'recovery');
const repository = connection.directory;
const timeline = path.join(root, 'evidence', 'e2e-structured.jsonl');
const note = entry => fs.appendFileSync(timeline, JSON.stringify({ at: Date.now(), ...entry }) + '\n');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const observerOffset = readLog(root, 'observer.jsonl').length;

const findRun = () => {
  const runs = path.join(repository, '.heimdall', 'runs');
  if (!fs.existsSync(runs)) return undefined;
  const id = fs.readdirSync(runs).find(name => fs.existsSync(path.join(runs, name, 'state.json')));
  if (!id) return undefined;
  try { return { id, dir: path.join(runs, id), state: JSON.parse(fs.readFileSync(path.join(runs, id, 'state.json'), 'utf8')) }; } catch { return undefined; }
};
const brief = found => !found ? null : {
  status: found.state.status, phase: found.state.phase, index: found.state.index, protocol: found.state.protocol,
  child: found.state.child, attempt: found.state.attempt && { id: found.state.attempt.id, status: found.state.attempt.status, purpose: found.state.attempt.purpose ?? 'task', model: found.state.attempt.model, variant: found.state.attempt.variant },
  tasks: found.state.tasks?.length, results: found.state.results?.length, reason: found.state.reason,
  dispatch: found.state.submissionBinding?.dispatch, bindingPrompt: Boolean(found.state.submissionBinding?.prompt),
  repair: found.state.submissionRepair,
};

let sampling = true;
let last = '';
const sampler = (async () => {
  while (sampling) {
    const current = brief(findRun());
    const signature = JSON.stringify(current);
    if (signature !== last) { last = signature; note({ event: 'checkpoint', ...current }); }
    await sleep(500);
  }
})();

const parent = await createSession(connection, { agent: 'adr-orchestrator', title: 'structured completion live e2e' });
note({ event: 'parent created', parentID: parent.id });
await prompt(connection, parent.id, 'Use adr_workflow with action "start" and adr "docs/adr.md" now. Report the result and wait.');
// The plugin is set up per project location when the first prompt runs, so the owner-only control socket exists only after it.
const ping = await waitUntil(() => control(root, 'ping').catch(() => false), { timeoutMs: 60_000, stepMs: 500, label: 'the fixture control socket' });
note({ event: 'control ping', hooksMissing: ping.hooksMissing });
let failure;
try { await waitIdle(connection, parent.id, timeoutMs); } catch (error) { failure = String(error.message ?? error); note({ event: 'wait failed', failure }); }
sampling = false;
await sampler;

const found = findRun();
const summary = { hooksMissing: ping.hooksMissing, parent: parent.id, repository: '<root>/repo-adr', waitFailure: failure ?? null, checkpoint: brief(found) };
if (found) {
  const files = fs.readdirSync(found.dir).sort();
  summary.runDirectory = files;
  const read = name => JSON.parse(fs.readFileSync(path.join(found.dir, name), 'utf8'));
  summary.submissions = files.filter(name => /^submission-.*\.json$/.test(name)).map(name => {
    const receipt = read(name);
    return {
      file: name, sha256: sha(path.join(found.dir, name)), kind: receipt.kind, phase: receipt.phase, index: receipt.index, taskId: receipt.taskId ?? null,
      attemptId: receipt.attemptId, dispatch: receipt.dispatch, parent: receipt.parent, child: receipt.child, origin: receipt.origin, caller: receipt.caller,
      outcome: receipt.outcome, protocol: receipt.protocol, contract: receipt.contract, digest: receipt.digest, acceptedAt: receipt.acceptedAt,
      runtimeDigest: receipt.runtime?.build?.digest ?? null, runtimePackage: receipt.runtime && { packageVersion: receipt.runtime.packageVersion, protocol: receipt.runtime.protocol },
      rawPayloadStatus: receipt.rawPayload?.status, rawPayloadKeys: receipt.rawPayload && typeof receipt.rawPayload === 'object' ? Object.keys(receipt.rawPayload).sort() : null,
    };
  });
  summary.outcomes = files.filter(name => /^outcome-.*\.json$/.test(name)).map(name => {
    const outcome = read(name);
    return { file: name, sha256: sha(path.join(found.dir, name)), phase: outcome.phase, index: outcome.index, attemptId: outcome.attemptId, child: outcome.child, capturedAt: outcome.capturedAt, responseShape: outcome.response && typeof outcome.response === 'object' ? Object.keys(outcome.response).sort() : typeof outcome.response };
  });
  summary.attemptReceipts = files.filter(name => /^attempt-.*\.json$/.test(name)).map(name => {
    const receipt = read(name);
    return { file: name, purpose: receipt.purpose ?? 'task', status: receipt.status, phase: receipt.phase, index: receipt.index, child: receipt.child, model: receipt.model, variant: receipt.variant };
  });
  summary.runtime = found.state.runtime && { packageVersion: found.state.runtime.packageVersion, protocol: found.state.runtime.protocol, buildDigest: found.state.runtime.build?.digest, snapshot: found.state.runtime.build?.snapshot, dist: found.state.runtime.build?.dist, prompts: found.state.runtime.build?.prompts, agents: found.state.runtime.build?.agents };
  summary.results = found.state.results?.map(result => ({ taskId: result.taskId, sessionId: result.sessionId, model: result.model, reportCorrections: result.reportCorrections ?? 0, evidenceGates: result.evidence?.map(item => ({ gateId: item.gateId, passed: item.passed })) }));
  summary.statePlanner = { tasks: found.state.tasks?.map(task => ({ id: task.id, dod: task.dod?.length })), settings: { plannerModel: found.state.settings?.plannerModel, plannerVariant: found.state.settings?.plannerVariant } };
  summary.stateFileSha256 = sha(path.join(found.dir, 'state.json'));
  const children = [...new Set([...summary.submissions.map(item => item.child), ...summary.attemptReceipts.map(item => item.child)].filter(Boolean))];
  const observer = readLog(root, 'observer.jsonl').slice(observerOffset);
  summary.children = {};
  for (const child of children) {
    const events = observer.filter(event => event.sessionID === child);
    const submissionTools = new Set(['heimdall_submit_plan', 'heimdall_submit_result']);
    const contexts = events.filter(event => event.stage === 'post' && event.event === 'context');
    const messages = await transcript(connection, child).catch(error => [{ error: String(error.message ?? error) }]);
    summary.children[child] = {
      contextCount: contexts.length,
      submissionToolOfferedInContexts: contexts.map(event => event.tools.filter(name => submissionTools.has(name))),
      toolCountPerContext: contexts.map(event => event.tools.length),
      calls: events.filter(event => event.event === 'execute.before' && submissionTools.has(event.tool)).map(event => ({ stage: event.stage, tool: event.tool, at: event.at, callID: event.callID })),
      afters: events.filter(event => event.event === 'execute.after' && submissionTools.has(event.tool)).map(event => ({ stage: event.stage, tool: event.tool, at: event.at, callID: event.callID, status: event.status })),
      permissionActions: [...new Set(events.filter(event => event.event === 'permission.evaluate').map(event => `${event.action}=>${event.effect}`))].sort(),
      assistantTurns: messages.filter(message => message.type === 'assistant').map(message => ({ finish: message.finish, error: message.error, parts: message.content?.map(part => part.type === 'tool' ? { tool: part.name, state: part.state, resultStub: String(part.output ?? '').slice(0, 220) } : { type: part.type }) })),
    };
  }
}
const active = await connection.client.session.active();
summary.activeAfter = Object.keys(active);
summary.parentTail = (await transcript(connection, parent.id)).slice(-2).map(message => ({ type: message.type, finish: message.finish, tools: message.content?.filter(part => part.type === 'tool').map(part => ({ tool: part.name, state: part.state })) }));
fs.writeFileSync(path.join(root, 'evidence', 'e2e-structured.json'), JSON.stringify(summary, null, 2));
process.stdout.write(JSON.stringify({ checkpoint: summary.checkpoint, submissions: summary.submissions?.length, outcomes: summary.outcomes?.length, activeAfter: summary.activeAfter, waitFailure: summary.waitFailure }, null, 1) + '\n');
