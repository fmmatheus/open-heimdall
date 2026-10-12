// Live check that a typed executor submission is accepted after the host compacted the child's active context past the
// dispatch prompt, through the real plugin against the disposable server.
//   node e2e-compaction.mjs --root /private/tmp/heimdall-0008.XXXXXX [--timeout-minutes 40] [--expect-digest <sha256>]
//
// Prepare the fixture exactly as for e2e-structured.mjs (t2-prepare.mjs), start the server only through guard.mjs, then run this.
// Like e2e-structured.mjs it never writes a receipt, checkpoint or outcome. It does exactly three things to the fixture:
//   1. replaces docs/adr.md of the disposable repo-adr repository with a multi-step ADR and commits it (fixture identity);
//   2. sends one prompt, to the adr-orchestrator parent, which starts the workflow;
//   3. asks the host to compact the executor child once, through the supported `POST /api/session/:id/compact` route
//      (client.session.compact), after that child has completed its first non-submission tool call. The host runs the
//      compaction at the next step boundary, so the child's later steps, including its submission, follow it.
// Everything else only reads. Evidence: <root>/evidence/e2e-compaction.jsonl (timeline) and e2e-compaction.json (summary:
// ids, positions, digests, timestamps; no transcript text and no credential). A final read-only phase walks the archive of
// each child with createMessageHistory at a small page size and compares it with the server's single-page order.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertFixtureRoot, capture, parseArguments } from './lib.mjs';
import { gitEnvironment } from './repo.mjs';
import { connect, control, createSession, prompt, readLog, sleep, waitIdle, waitUntil } from './t2-client.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(here, '..', '..', '..');
const loadBuilt = async relative => import(pathToFileURL(path.join(repositoryRoot, 'dist', relative)).href);
const { createAPI, createMessageHistory } = await loadBuilt('opencode/observer.js');
const { computeRuntimeIdentity } = await loadBuilt('workflow/runtime-identity.js');

const options = parseArguments(process.argv.slice(2));
const root = assertFixtureRoot(options.root ?? '');
const timeoutMs = Number(options['timeout-minutes'] ?? 40) * 60_000;
const connection = await connect(root, 'recovery');
const repository = connection.directory;
const timeline = path.join(root, 'evidence', 'e2e-compaction.jsonl');
const note = entry => fs.appendFileSync(timeline, JSON.stringify({ at: Date.now(), ...entry }) + '\n');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const SUBMISSION_TOOLS = new Set(['heimdall_submit_plan', 'heimdall_submit_result']);

// The candidate: identity of the built package this script lives in, and of the copy the fixture plugin actually loads.
const candidate = computeRuntimeIdentity(repositoryRoot);
const loadedCopy = computeRuntimeIdentity(path.join(root, 'native-host', 'heimdall'));
if (options['expect-digest'] && options['expect-digest'] !== candidate.build.digest) throw new Error('The built candidate digest differs from --expect-digest');

const api = createAPI({ baseUrl: connection.server.baseUrl, authentication: 'none', directory: repository });
const archiveOf = async (sessionID, pageSize = 200) => {
  const messages = [];
  for await (const message of createMessageHistory({ directory: repository, baseUrl: connection.server.baseUrl, authentication: 'none', pageSize })(sessionID)) messages.push(message);
  return messages; // newest first, exactly as the server ordered it
};

// 1. A multi-step ADR, so the executor's first tool call is followed by further steps before it can submit.
const hooks = path.join(root, 'config', 'empty-hooks');
const git = async args => {
  const result = await capture('git', ['-c', `core.hooksPath=${hooks}`, ...args], { cwd: repository, env: gitEnvironment() });
  if (result.code !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.slice(0, 300)}`);
  return result.stdout.trim();
};
const adr = `# ADR: string helpers

Extend \`src/impl.js\` with four exported functions and add one test per function to \`test/impl.test.js\`. The test command is \`npm test\`.

1. \`farewell(name)\` returns \`goodbye <name>\`.
2. \`shout(text)\` returns \`text\` in upper case followed by \`!\`.
3. \`repeat(text, times)\` returns \`text\` repeated \`times\` times, joined with \`-\`.
4. \`describe(name)\` returns \`<greet(name)> / <farewell(name)>\`.

Plan exactly ONE task, T1, covering all four functions. Its brief must tell the executor to work one function at a time: write the function, write its test, run \`npm test\`, and only then start the next function. Its definition of done:
1. \`src/impl.js\` exports \`farewell\`, \`shout\`, \`repeat\` and \`describe\` with the behaviour above.
2. \`test/impl.test.js\` tests each of them.
3. \`npm test\` passes.

Do not commit.
`;
fs.writeFileSync(path.join(repository, 'docs', 'adr.md'), adr);
await git(['add', '--', 'docs/adr.md']);
if ((await capture('git', ['diff', '--cached', '--quiet', '--', 'docs/adr.md'], { cwd: repository, env: gitEnvironment() })).code !== 0) await git(['commit', '-m', 'Multi-step ADR for the compaction live check']);
note({ event: 'adr committed', head: await git(['rev-parse', 'HEAD']) });

const observerOffset = readLog(root, 'observer.jsonl').length;
const findRun = () => {
  const runs = path.join(repository, '.heimdall', 'runs');
  if (!fs.existsSync(runs)) return undefined;
  const id = fs.readdirSync(runs).find(name => fs.existsSync(path.join(runs, name, 'state.json')));
  if (!id) return undefined;
  try { return { id, dir: path.join(runs, id), state: JSON.parse(fs.readFileSync(path.join(runs, id, 'state.json'), 'utf8')) }; } catch { return undefined; }
};
const brief = found => !found ? null : {
  status: found.state.status, phase: found.state.phase, index: found.state.index, protocol: found.state.protocol, child: found.state.child,
  attempt: found.state.attempt && { id: found.state.attempt.id, status: found.state.attempt.status },
  tasks: found.state.tasks?.length, results: found.state.results?.length, reason: found.state.reason,
  dispatch: found.state.submissionBinding?.dispatch, bindingPrompt: found.state.submissionBinding?.prompt ?? null, bindingStatus: found.state.submissionBinding?.status,
  runtimeDigest: found.state.runtime?.build?.digest,
};

// 3. The compaction request, issued once for the executor child after its first completed non-submission tool call.
const compaction = { requestedAt: null, child: null, dispatch: null, bindingPrompt: null, toolsCompletedBefore: null, response: null, error: null, completedSeenAt: null };
let sampling = true;
let last = '';
const compactWhenReady = async found => {
  if (compaction.requestedAt || !found || found.state.phase !== 'executor' || !found.state.child || !found.state.submissionBinding?.prompt) return;
  const child = found.state.child;
  const finished = readLog(root, 'observer.jsonl').slice(observerOffset).filter(event => event.stage === 'post' && event.event === 'execute.after' && event.sessionID === child && !SUBMISSION_TOOLS.has(event.tool));
  if (finished.length < 1) return;
  Object.assign(compaction, { requestedAt: Date.now(), child, dispatch: found.state.submissionBinding.dispatch, bindingPrompt: found.state.submissionBinding.prompt, toolsCompletedBefore: finished.length });
  try {
    const item = await connection.client.session.compact({ sessionID: child });
    compaction.response = { type: item?.type, hasId: Boolean(item?.id) };
  } catch (error) { compaction.error = String(error.message ?? error).slice(0, 200); }
  note({ event: 'compaction requested', child, dispatch: compaction.dispatch, toolsCompletedBefore: compaction.toolsCompletedBefore, response: compaction.response, error: compaction.error });
};
const watchCompaction = async () => {
  if (!compaction.requestedAt || compaction.completedSeenAt) return;
  try {
    const page = await api.request(`/api/session/${encodeURIComponent(compaction.child)}/message?order=desc&limit=20&type=compaction`);
    const done = page.find(message => message.status === 'completed');
    if (done) { compaction.completedSeenAt = Date.now(); note({ event: 'compaction completed seen', status: done.status, reason: done.reason }); }
  } catch { /* retried on the next sample */ }
};
const sampler = (async () => {
  while (sampling) {
    const found = findRun();
    const current = brief(found);
    const signature = JSON.stringify(current);
    if (signature !== last) { last = signature; note({ event: 'checkpoint', ...current }); }
    await compactWhenReady(found);
    await watchCompaction();
    await sleep(300);
  }
})();

// 2. The single prompt.
const parent = await createSession(connection, { agent: 'adr-orchestrator', title: 'compaction live e2e' });
note({ event: 'parent created', parentID: parent.id });
await prompt(connection, parent.id, 'Use adr_workflow with action "start" and adr "docs/adr.md" now. Report the result and wait.');
const ping = await waitUntil(() => control(root, 'ping').catch(() => false), { timeoutMs: 60_000, stepMs: 500, label: 'the fixture control socket' });
note({ event: 'control ping', hooksMissing: ping.hooksMissing });
let failure;
try { await waitIdle(connection, parent.id, timeoutMs); } catch (error) { failure = String(error.message ?? error); note({ event: 'wait failed', failure }); }
sampling = false;
await sampler;

// Evidence (read-only from here).
const found = findRun();
const summary = {
  candidate: { packageVersion: candidate.packageVersion, protocol: candidate.protocol, buildDigest: candidate.build.digest, dist: candidate.build.dist, prompts: candidate.build.prompts, agents: candidate.build.agents },
  loadedCopyDigest: loadedCopy.build.digest,
  hooksMissing: ping.hooksMissing, parent: parent.id, waitFailure: failure ?? null, checkpoint: brief(found), compaction,
};
const checks = {};
summary.checks = checks;
if (found) {
  const files = fs.readdirSync(found.dir).sort();
  const read = name => JSON.parse(fs.readFileSync(path.join(found.dir, name), 'utf8'));
  const receiptFile = files.find(name => /^submission-.*-executor-result\.json$/.test(name));
  const outcomeFile = files.find(name => /^outcome-.*\.json$/.test(name) && receiptFile && name.includes(read(receiptFile).attemptId));
  const receipt = receiptFile ? read(receiptFile) : undefined;
  const observer = readLog(root, 'observer.jsonl').slice(observerOffset);
  const timelineEntries = fs.readFileSync(timeline, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  const checkpoints = timelineEntries.filter(entry => entry.event === 'checkpoint');

  summary.runtime = { stateDigest: found.state.runtime?.build?.digest, snapshot: found.state.runtime?.build?.snapshot, packageVersion: found.state.runtime?.packageVersion, protocol: found.state.runtime?.protocol };
  summary.receiptFiles = files.filter(name => /^submission-/.test(name));
  summary.results = found.state.results?.map(result => ({ taskId: result.taskId, sessionId: result.sessionId, model: result.model, reportCorrections: result.reportCorrections ?? 0, gates: result.evidence?.map(item => ({ gateId: item.gateId, passed: item.passed })) }));
  summary.repair = found.state.submissionRepair ?? null;
  checks.receiptPresent = Boolean(receipt);

  if (receipt) {
    summary.receipt = { file: receiptFile, sha256: sha(path.join(found.dir, receiptFile)), kind: receipt.kind, outcome: receipt.outcome, taskId: receipt.taskId, dispatch: receipt.dispatch, attemptId: receipt.attemptId, parent: receipt.parent, child: receipt.child, origin: receipt.origin, caller: receipt.caller, acceptedAt: receipt.acceptedAt, runtimeDigest: receipt.runtime?.build?.digest, protocol: receipt.protocol };
    // Runtime identity: the digest the run recorded, not Git, equals the candidate.
    checks.digestReceiptEqualsCandidate = receipt.runtime?.build?.digest === candidate.build.digest;
    checks.digestStateEqualsCandidate = found.state.runtime?.build?.digest === candidate.build.digest;
    checks.digestLoadedCopyEqualsCandidate = loadedCopy.build.digest === candidate.build.digest;

    // The archive of the executor child, newest first, and its active context.
    const child = receipt.child;
    const archive = await archiveOf(child);
    const timelineOrder = [...archive].reverse(); // oldest first
    const position = id => timelineOrder.findIndex(message => message.id === id);
    const promptIndex = position(receipt.origin);
    const carrierIndex = position(receipt.caller.messageID);
    const carrier = timelineOrder[carrierIndex];
    const compactions = timelineOrder.map((message, index) => ({ message, index })).filter(item => item.message.type === 'compaction');
    summary.archive = {
      messages: archive.length,
      types: Object.fromEntries([...new Set(archive.map(message => message.type))].map(type => [type, archive.filter(message => message.type === type).length])),
      timeline: timelineOrder.map((message, index) => ({ index, id: message.id, type: message.type, ...(message.type === 'compaction' ? { status: message.status, reason: message.reason } : {}), ...(message.type === 'assistant' ? { finish: message.finish, agent: message.agent, tools: (Array.isArray(message.content) ? message.content : []).filter(part => part.type === 'tool').map(part => ({ name: part.name, state: part.state?.status ?? part.status })) } : {}), ...(message.id === receipt.origin ? { role: 'dispatch prompt' } : {}), ...(message.id === receipt.caller.messageID ? { role: 'submission carrier' } : {}) })),
      messageKeys: Object.fromEntries([...new Set(archive.map(message => message.type))].map(type => [type, Object.keys(archive.find(message => message.type === type)).sort()])),
    };
    checks.dispatchPromptInArchive = promptIndex >= 0 && timelineOrder[promptIndex].type === 'user' && typeof timelineOrder[promptIndex].text === 'string' && timelineOrder[promptIndex].text.includes('Workflow attempt: ' + receipt.attemptId);
    checks.bindingPromptEqualsReceiptOrigin = compaction.bindingPrompt === receipt.origin;
    const carrierCall = carrier && Array.isArray(carrier.content) ? carrier.content.find(part => part.type === 'tool' && part.id === receipt.caller.callId) : undefined;
    checks.carrierIsSubmissionCall = Boolean(carrier && carrier.type === 'assistant' && carrierCall && carrierCall.name === 'heimdall_submit_result');
    // The submission descends from the dispatch prompt: the nearest user message before the carrier is that prompt.
    const nearestUser = timelineOrder.slice(0, Math.max(carrierIndex, 0)).reverse().find(message => message.type === 'user');
    checks.callerDescendsFromDispatchPrompt = Boolean(carrier && nearestUser && nearestUser.id === receipt.origin);
    const completed = compactions.filter(item => item.message.status === 'completed');
    checks.completedCompactionBetweenPromptAndSubmission = completed.some(item => item.index > promptIndex && item.index < carrierIndex);
    checks.noFailedOrRunningCompaction = compactions.every(item => item.message.status === 'completed');
    summary.archive.compactions = compactions.map(item => ({ id: item.message.id, index: item.index, status: item.message.status, reason: item.message.reason }));
    summary.archive.indices = { dispatchPrompt: promptIndex, carrier: carrierIndex };

    // Active context: what the host hands a plugin after compaction. REST copy now, plugin-side copy from the observer.
    const context = await api.request(`/api/session/${encodeURIComponent(child)}/context`);
    summary.activeContextAfter = { messages: context.length, ids: context.map(message => ({ id: message.id, type: message.type })) };
    checks.dispatchPromptAbsentFromActiveContextAfter = !context.some(message => message.id === receipt.origin);
    const pluginView = observer.filter(event => event.stage === 'post' && event.event === 'submission.context' && event.sessionID === child && event.tool === 'heimdall_submit_result' && event.callID === receipt.caller.callId);
    summary.activeContextAtSubmission = pluginView.map(event => ({ at: event.at, messages: Array.isArray(event.active) ? event.active.length : null, error: event.active?.error, promptPresent: Array.isArray(event.active) ? event.active.some(message => message.id === receipt.origin) : null, types: Array.isArray(event.active) ? event.active.map(message => message.type) : null }));
    checks.dispatchPromptAbsentFromActiveContextAtSubmission = pluginView.length >= 1 && pluginView.every(event => Array.isArray(event.active) && !event.active.some(message => message.id === receipt.origin));

    // Acknowledgement after the durable receipt: the post-hook (which runs after the tool returned its acknowledgement) already sees the file.
    const afters = observer.filter(event => event.stage === 'post' && event.event === 'submission.after' && event.sessionID === child && event.callID === receipt.caller.callId);
    const before = pluginView.at(0);
    const receiptStat = fs.statSync(path.join(found.dir, receiptFile));
    summary.acknowledgement = {
      receiptBirthMs: Math.round(receiptStat.birthtimeMs), receiptMtimeMs: Math.round(receiptStat.mtimeMs), acceptedAt: receipt.acceptedAt,
      receiptsBeforeCall: before?.receiptsBefore?.map(item => item.file) ?? null,
      afterHooks: afters.map(event => ({ at: event.at, status: event.status, receiptSeen: event.receiptsAfter?.some(item => item.file === receiptFile), receiptBirthMs: event.receiptsAfter?.find(item => item.file === receiptFile)?.birthMs })),
    };
    checks.receiptAbsentBeforeCall = Boolean(before) && !before.receiptsBefore.some(item => item.file === receiptFile);
    checks.acknowledgedAfterReceiptExisted = afters.length === 1 && afters[0].status === 'completed' && afters[0].receiptsAfter.some(item => item.file === receiptFile) && summary.acknowledgement.receiptBirthMs <= afters[0].at && receipt.acceptedAt <= afters[0].at;
    // A compacted child may have lost the gate list and be rejected once for its evidence format. That is a repairable
    // rejection: it writes no receipt. Exactly one call may be accepted; every earlier call must be such a rejection.
    const calls = observer.filter(event => event.stage === 'post' && event.event === 'execute.before' && event.sessionID === child && SUBMISSION_TOOLS.has(event.tool)).sort((a, b) => a.at - b.at);
    const callResult = callID => {
      for (const message of archive) for (const part of Array.isArray(message.content) ? message.content : []) {
        if (part.type !== 'tool' || part.id !== callID) continue;
        try { const reply = JSON.parse(part.state?.content?.find(item => item.type === 'text')?.text ?? ''); return { accepted: reply.accepted === true, code: reply.code ?? null, repairable: reply.repairable ?? null, errorPaths: (reply.errors ?? []).map(item => item.code + '@' + item.path) }; } catch { return { accepted: false, code: 'unparsed', repairable: null, errorPaths: [] }; }
      }
      return undefined;
    };
    summary.submissionCalls = calls.map(event => ({ at: event.at, tool: event.tool, accepted: event.callID === receipt.caller.callId, result: callResult(event.callID) }));
    const executorReceipts = files.filter(name => /^submission-.*-executor-result\.json$/.test(name));
    checks.singleAcceptedSubmission = executorReceipts.length === 1 && calls.length >= 1 && calls.at(-1).callID === receipt.caller.callId
      && calls.slice(0, -1).every(event => { const result = callResult(event.callID); return result && result.accepted === false && result.repairable === true && result.code === 'format'; });

    // Native stop and idle, the outcome captured after it, and a single advancement.
    const newest = archive.slice(0, 4).map(message => ({ type: message.type, finish: message.finish }));
    const finalAssistant = archive.find(message => message.type === 'assistant');
    summary.nativeStop = { newestFirst: newest, finalAssistantFinish: finalAssistant?.finish ?? null, finalAssistantError: finalAssistant?.error ? 'present' : null, outcomeFile: outcomeFile ?? null };
    checks.nativeStopAndIdle = Boolean(finalAssistant && finalAssistant.finish === 'stop' && !finalAssistant.error && archive[0].type === 'idle');
    if (outcomeFile) {
      const outcome = read(outcomeFile);
      summary.nativeStop.outcomeCapturedAt = outcome.capturedAt;
      checks.outcomeCapturedAfterReceipt = outcome.capturedAt >= receipt.acceptedAt;
    } else checks.outcomeCapturedAfterReceipt = false;
    const active = await connection.client.session.active();
    summary.activeAfter = Object.keys(active);
    checks.noActiveSessionAfter = summary.activeAfter.length === 0;
    const indexes = checkpoints.map(entry => entry.index).filter(index => index !== undefined);
    const transitions = indexes.filter((index, at) => at === 0 || index !== indexes[at - 1]);
    summary.indexTransitions = transitions;
    checks.checkpointAdvancedExactlyOnce = found.state.status === 'completed' && found.state.index === 1 && found.state.results?.length === 1 && JSON.stringify(transitions) === JSON.stringify([0, 1]);
    checks.noRepair = !found.state.submissionRepair || (found.state.submissionRepair.repairs ?? 0) === 0;
    // Counts of completed tools in the child around the compaction request, to show the submission followed further steps.
    const childTools = observer.filter(event => event.stage === 'post' && event.event === 'execute.after' && event.sessionID === child);
    summary.executorTools = { total: childTools.length, afterCompactionRequest: childTools.filter(event => event.at > (compaction.requestedAt ?? Infinity)).map(event => event.tool) };
  }

  // 6. Read-only cursor probe at a small page size, for each child archive.
  const children = [...new Set([...files.filter(name => /^attempt-.*\.json$/.test(name)).map(name => read(name).child), ...(receipt ? [receipt.child] : [])].filter(Boolean))];
  summary.cursorProbe = {};
  for (const child of children) {
    const single = await archiveOf(child, 200);
    const base = `/api/session/${encodeURIComponent(child)}/message`;
    const first = await api.request(`${base}?order=desc&limit=2`, { raw: true });
    const second = first.cursor?.next ? await api.request(`${base}?cursor=${encodeURIComponent(first.cursor.next)}&limit=2`, { raw: true }) : undefined;
    const walked = await archiveOf(child, 2);
    const ids = list => list.map(message => message.id);
    summary.cursorProbe[child] = {
      messages: single.length,
      firstPageIds: ids(first.data), secondPageIds: second ? ids(second.data) : null,
      secondPageContinuesTowardOlder: Boolean(second) && JSON.stringify(ids(second.data)) === JSON.stringify(ids(single.slice(2, 4))),
      pageSize2WalkEqualsSinglePage: JSON.stringify(ids(walked)) === JSON.stringify(ids(single)),
      walkedMessages: walked.length,
      pagesAtSize2: Math.ceil(walked.length / 2),
      singlePageNewestFirst: single.length > 1 ? single[0].id > single[single.length - 1].id : null,
    };
  }
  checks.cursorNextContinuesTowardOlder = children.length > 0 && children.every(child => summary.cursorProbe[child].messages <= 2 || (summary.cursorProbe[child].secondPageContinuesTowardOlder && summary.cursorProbe[child].pageSize2WalkEqualsSinglePage));
}
summary.pass = Object.values(checks).length > 0 && Object.values(checks).every(Boolean);
fs.writeFileSync(path.join(root, 'evidence', 'e2e-compaction.json'), JSON.stringify(summary, null, 2));
process.stdout.write(JSON.stringify({ pass: summary.pass, checks, checkpoint: summary.checkpoint, compaction: { requested: Boolean(compaction.requestedAt), error: compaction.error }, waitFailure: summary.waitFailure }, null, 1) + '\n');
