import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRunner, validateCompletion, validatePlan } from '../dist/workflow/runner.js';
import { parseResult, loadPlanArtifacts } from '../dist/workflow/runner.js';
import { chooseExecutor } from '../dist/policy/quota.js';
const snapshot = (sonnet=50,kimi=40) => Object.fromEntries([['anthropic',sonnet],['kimi',kimi]].map(([key,n]) => [key,{fetchedAt:Date.now(),entries:[{name:'5h',percentRemaining:n},{name:'Weekly',percentRemaining:n}],errors:[]}]));
const task = id => ({ id, title: id, brief: 'Implement ' + id, dependsOn: [], dod: ['test passed'] });
const plan = { status: 'planned', planMarkdown: '# Plan', factSheet: 'Known facts', tasks: [task('T1'), task('T2')] };
test('oversized plan reports actual and permitted task counts',()=>{
 assert.throws(()=>validatePlan({...plan,tasks:Array.from({length:12},(_,i)=>task('T'+(i+1)))},10),/Plan has 12 tasks; maximum is 10/);
 validatePlan({...plan,tasks:Array.from({length:10},(_,i)=>task('T'+(i+1)))},10);
});
const done = id => ({ status: 'completed', taskId: id, summary: 'Done', handoff: 'Changed module', evidence: [{ gateId: 'G1', passed: true, gate: 'test passed', detail: 'targeted test exit 0' }] });
async function fixture(t, responses, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-adr-test-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, '.opencode/adr-workflow');
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(directory, 'ADR.md'), 'Spec');
  await fs.writeFile(path.join(root, 'settings.json'), JSON.stringify({ plannerAgent: 'adr-planner', executorAgent: 'adr-executor', plannerModel: 'a/p', executorModel: 'a/e', executorFallbackModel: 'k/k3', timeoutMinutes: 1, maxTasks: 10, maxSessionTokens: 60000, maxRunTokens: 300000, minQuotaRemainingPercent: 10, ...overrides }));
  for (const name of ['planner', 'executor']) await fs.writeFile(path.join(root, name + '.md'), name);
  const calls = []; let n = 0; let active = 0;
  const backend = {
    assertIdle: async (id, parent) => { calls.push(['idle', id, parent]); },
    recoverResponse: async () => undefined,
    usage: async () => ({ used: overrides.reportedTokens || 0, uncached: overrides.reportedTokens || 0 }),
    interrupt: async () => { calls.push(['abort']); },
    runSubagent: async (input, context) => {
      let id = input.child;
      if (!id) { id = 's' + ++n; calls.push(['create', { body: { parentID: input.parent } }]); }
      await input.onStarted(id);
      assert.equal(input.currentChild(), id);
      assert.equal(active++, 0, 'only one executor at a time');
      const state = JSON.parse(await fs.readFile(path.join(root, 'runs', (await fs.readdir(path.join(root, 'runs')))[0], 'state.json'), 'utf8'));
      assert.equal(state.child, id, 'child ID is persisted before prompt admission');
      const o = { path: { id }, body: { agent: input.agent, model: input.model, variant: input.variant, parts: [{ type: 'text', text: input.prompt }] } };
      calls.push(['prompt', o]);
      try {
        const r = responses.shift();
        if (typeof r === 'function') return await r();
        if (r instanceof Error) throw r;
        return JSON.stringify(r);
      } finally { active--; }
    },
  };
  return { root, calls, backend, run: createRunner({ backend, directory, quota: async () => snapshot(), authRefresh: async () => { calls.push(['authRefresh']); }, git: a => a[0] === 'branch' ? 'main\\n' : ' M existing.txt\\n' }), context: { sessionID: 'parent', id: 'call_1', messageID: 'msg_1', agent: 'adr-orchestrator', abort: new AbortController().signal } };
}
test('planner then fresh sequential sessions, durable completion', async t => {
  const f = await fixture(t, [plan, done('T1'), done('T2')]);
  const result = JSON.parse(await f.run({ action: 'start', adr: 'ADR.md' }, f.context));
  assert.equal(result.status, 'completed');
  assert.deepEqual(f.calls.filter(c => c[0] === 'prompt').map(c => c[1].path.id), ['s1', 's2', 's3']);
  const state = JSON.parse(await f.run({ action: 'status', runId: result.runId }, f.context));
  assert.equal(state.results.length, 2);
  assert.match(await fs.readFile(path.join(f.root, 'runs', result.runId, 'ledger.md'), 'utf8'), /T2/);
});
test('blocked task stops and explicit resume reuses its session', async t => {
  const f = await fixture(t, [plan, { status: 'blocked', reason: 'Attach phone' }, done('T1'), done('T2')]);
  const r = JSON.parse(await f.run({ action: 'start', adr: 'ADR.md' }, f.context));
  assert.equal(r.status, 'paused');
  assert.equal(f.calls.filter(c => c[0] === 'create').length, 2);
  const resumed = JSON.parse(await f.run({ action: 'resume', runId: r.runId, input: 'Phone attached' }, f.context));
  assert.equal(resumed.status, 'completed');
  assert.deepEqual(f.calls.filter(c => c[0] === 'prompt').map(c => c[1].path.id), ['s1', 's2', 's2', 's3']);
});
test('quota selection compares limiting windows, prefers Sonnet on ties, fails closed', () => {
  const cfg = {executorModel:'sonnet',executorFallbackModel:'kimi',minQuotaRemainingPercent:10};
  assert.equal(chooseExecutor(snapshot(30,60),cfg).model,'kimi');
  assert.equal(chooseExecutor(snapshot(70,60),cfg).model,'sonnet');
  assert.equal(chooseExecutor(snapshot(60,60),cfg).model,'sonnet');
  const emptyShort=snapshot(90,30); emptyShort.anthropic.entries[0].percentRemaining=0;
  assert.equal(chooseExecutor(emptyShort,cfg).model,'kimi');
  const weighted=snapshot(80,55); weighted.anthropic.entries[1].percentRemaining=40;
  assert.equal(chooseExecutor(weighted,cfg).model,'sonnet');
  const q = snapshot(80,50); q.anthropic.entries.push({name:'Weekly',percentRemaining:20});
  assert.equal(chooseExecutor(q,cfg).model,'kimi');
  assert.throws(() => chooseExecutor({},cfg), /unavailable/);
  assert.throws(() => chooseExecutor(snapshot(0,0),cfg), /reserve/);
});
test('token budget stops before inference', async t => {
  const f = await fixture(t, [], {reportedTokens:60000});
  const result = JSON.parse(await f.run({action:'start',adr:'ADR.md'},f.context));
  assert.equal(result.status,'paused');
  assert.match(result.reason,/Token budget/);
  assert.equal(f.calls.filter(c=>c[0]==='prompt').length,0);
});
test('project can disable all token and elapsed-time limits while retaining counters',async t=>{
 const f=await fixture(t,[plan,done('T1'),done('T2')],{tokenLimitsDisabled:true,timeoutMinutes:null,maxSessionTokens:null,maxRunTokens:null,maxSessionUncachedTokens:1,maxRunUncachedTokens:1,reportedTokens:1000000000});
 const result=JSON.parse(await f.run({action:'start',adr:'ADR.md'},f.context));
 assert.equal(result.status,'completed');
 const state=JSON.parse(await fs.readFile(path.join(f.root,'runs',result.runId,'state.json'),'utf8'));
 assert.equal(state.usage.s1,1000000000);assert.equal(state.uncachedUsage.s1,1000000000);
 assert.equal(state.timeWarnings,undefined);assert.ok(!f.calls.some(c=>c[0]==='abort'));
 const prompt=f.calls.find(c=>c[0]==='prompt')[1].body.parts[0].text;
 assert.match(prompt,/Token limits disabled by owner/);assert.doesNotMatch(prompt,/Time warning after/);
});
test('existing paused run inherits removed caps on resume and reuses its child',async t=>{
 const f=await fixture(t,[plan,done('T1'),done('T2')],{reportedTokens:1000000000});
 const first=JSON.parse(await f.run({action:'start',adr:'ADR.md'},f.context));assert.equal(first.status,'paused');
 const file=path.join(f.root,'settings.json');const cfg=JSON.parse(await fs.readFile(file,'utf8'));
 cfg.tokenLimitsDisabled=true;cfg.timeoutMinutes=null;delete cfg.maxRunTokens;delete cfg.maxSessionTokens;
 await fs.writeFile(file,JSON.stringify(cfg));
 const resumed=JSON.parse(await f.run({action:'resume',runId:first.runId,input:'Remove time and token caps'},f.context));
 assert.equal(resumed.status,'completed');assert.equal(f.calls.find(c=>c[0]==='prompt')[1].path.id,'s1');
});
test('ordinary error pauses without fallback or next task', async t => {
  const f = await fixture(t, [plan, new Error('network failure')]);
  assert.equal(JSON.parse(await f.run({ action: 'start', adr: 'ADR.md' }, f.context)).status, 'paused');
  assert.equal(f.calls.filter(c => c[0] === 'prompt').length, 2);
});
test('elapsed time emits one warning and allows task completion without abort', async t => {
  const f = await fixture(t, [async () => {
    await new Promise(resolve => setTimeout(resolve, 30));
    return {data:{parts:[{type:'text',text:JSON.stringify(plan)}]}};
  }, done('T1'), done('T2')], {timeoutMinutes:0.0001});
  const notices = [];
  f.context.metadata = value => notices.push(value);
  const result = JSON.parse(await f.run({action:'start',adr:'ADR.md'},f.context));
  assert.equal(result.status,'completed');
  assert.equal(f.calls.filter(c => c[0] === 'abort').length,0);
  assert.equal(notices.filter(n => n.metadata.warning).length,1);
  const state = JSON.parse(await fs.readFile(path.join(f.root,'runs',result.runId,'state.json'),'utf8'));
  assert.match(state.timeWarnings.s1.message,/warning only/);
});

test('existing lock prevents another run', async t => {
  const f = await fixture(t, []);
  await fs.writeFile(path.join(f.root, 'active.lock'), 'busy');
  await assert.rejects(f.run({ action: 'start', adr: 'ADR.md' }, f.context), /Another run/);
  assert.equal(f.calls.length, 0);
});
test('missing DoD evidence and forward dependencies rejected', () => {
  assert.throws(() => validateCompletion({ ...done('T1'), evidence: [] }, task('T1')));
  assert.throws(() => validatePlan({ ...plan, tasks: [{ ...task('T1'), dependsOn: ['T2'] }, task('T2')] }, 20));
});

test('Claude auth failure starts recovery once and pauses', async t => {
  const f = await fixture(t, [new Error('401 Unauthorized')]);
  const result = JSON.parse(await f.run({action:'start',adr:'ADR.md'},f.context));
  assert.equal(result.status,'paused');
  assert.match(result.reason,/authentication expired/);
  assert.equal(f.calls.filter(c=>c[0]==='authRefresh').length,1);
  assert.equal(f.calls.filter(c=>c[0]==='prompt').length,1);
});

test('truncated model output has an explicit diagnostic', () => {
  assert.throws(() => parseResult({data:{info:{finish:'length'},parts:[{type:'text',text:'{"status":"pla'}]}}), /output truncated/);
});
test('file manifest loads plan without embedding it in response', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'adr-artifact-'));
  t.after(() => fs.rm(dir, {recursive:true,force:true}));
  const base = path.join(dir,'.omo/plans/adr-test');
  await fs.mkdir(base,{recursive:true});
  for (const [name,value] of [['plan.md',plan.planMarkdown],['facts.md',plan.factSheet],['tasks.md',JSON.stringify(plan.tasks)]]) await fs.writeFile(path.join(base,name),value);
  assert.deepEqual(await loadPlanArtifacts({status:'planned',artifacts:true},dir,'test'),plan);
  await fs.writeFile(path.join(base,'tasks.md'),'[{');
  await assert.rejects(loadPlanArtifacts({status:'planned',artifacts:true},dir,'test'),SyntaxError);
});

test('owner can disable token enforcement for one run while retaining usage', async t => {
  const f = await fixture(t, [plan, done('T1'), done('T2')], {reportedTokens: 400000});
  const first = JSON.parse(await f.run({action:'start',adr:'ADR.md'},f.context));
  assert.equal(first.status,'paused');
  const file = path.join(f.root,'runs',first.runId,'state.json');
  const state = JSON.parse(await fs.readFile(file,'utf8'));
  state.tokenLimitsDisabled = true;
  await fs.writeFile(file,JSON.stringify(state));
  const resumed = JSON.parse(await f.run({action:'resume',runId:first.runId,input:'Disable token limits for this run'},f.context));
  assert.equal(resumed.status,'completed');
  const final = JSON.parse(await fs.readFile(file,'utf8'));
  assert.equal(final.usage.s1,400000);
});

test('completion tolerates backticks but reports actual missing gates', () => {
  const t = {...task('T1'),dod:['Run `tests` successfully']};
  const r = {...done('T1'),evidence:[{gate:'Run tests successfully',detail:'log confirms pass'}]};
  assert.doesNotThrow(() => validateCompletion(r,t));
  assert.throws(() => validateCompletion({...r,evidence:[{gate:'Run tests',detail:'pass'}]},t),/Run `tests` successfully/);
});

test('parse one intact completion with prose without accepting broken or multiple objects', () => {
  const response = text => ({data:{info:{finish:'stop'},parts:[{type:'text',text}]}});
  const result = done('T2');
  assert.deepEqual(parseResult(response('Committed.\n\n'+JSON.stringify(result))), result);
  assert.throws(() => parseResult(response('Committed. {"status":"completed","summary":"cut')), /Invalid child response/);
  assert.throws(() => parseResult(response(JSON.stringify(result)+'\n'+JSON.stringify(result))), /Invalid child response/);
});

test('quota failure excludes only affected provider and preserves weighted routing', () => {
  const cfg={executorModel:'sonnet',executorFallbackModel:'kimi',minQuotaRemainingPercent:10};
  const q=snapshot();q.anthropic.errors=['Quota query failed'];
  assert.equal(chooseExecutor(q,cfg).model,'kimi');
  q.kimi.errors=['Quota query failed'];
  assert.throws(()=>chooseExecutor(q,cfg),/anthropic:.*kimi:/);
  const stale=snapshot();stale.kimi.fetchedAt=Date.now()-61000;
  assert.equal(chooseExecutor(stale,cfg).model,'sonnet');
  delete stale.anthropic.fetchedAt;
  assert.throws(()=>chooseExecutor(stale,cfg),/No eligible/);
});

test('native raw JSON output uses the same exact envelope gate', () => {
 assert.deepEqual(parseResult(JSON.stringify(done('T1'))), done('T1'));
 assert.throws(() => parseResult('{"status":"completed"'), /Invalid child response/);
});

const threeCandidates=[{key:'sonnet',quotaProvider:'anthropic',model:'a/sonnet',variant:'xhigh'},{key:'kimi',quotaProvider:'kimi',model:'k/k3'},{key:'gpt',quotaProvider:'openai',model:'openai/gpt-5.6-sol',variant:'max'}];
test('three-provider picker selects weighted winner and requested effort; excludes code review',()=>{
 const cfg={executorCandidates:threeCandidates,minQuotaRemainingPercent:10};
 const q=snapshot(50,50);q.openai={...snapshot(90).anthropic,entries:[{name:'5h',percentRemaining:90},{name:'Weekly',percentRemaining:90},{name:'Code Review',percentRemaining:0}]};
 let choice=chooseExecutor(q,cfg);assert.equal(choice.model,'openai/gpt-5.6-sol');assert.equal(choice.variant,'max');
 q.openai.entries[0].percentRemaining=0;choice=chooseExecutor(q,cfg);assert.equal(choice.model,'a/sonnet');assert.equal(choice.variant,'xhigh');
 q.anthropic.errors=['unavailable'];assert.equal(chooseExecutor(q,cfg).model,'k/k3');
 q.openai=snapshot(50).anthropic;q.anthropic=snapshot(50).anthropic;assert.equal(chooseExecutor(q,cfg).model,'a/sonnet');
});
test('executor prompt carries configured effort variant',async t=>{
 const f=await fixture(t,[plan,done('T1'),done('T2')],{executorCandidates:threeCandidates});
 const result=JSON.parse(await f.run({action:'start',adr:'ADR.md'},f.context));assert.equal(result.status,'completed');
 const prompts=f.calls.filter(c=>c[0]==='prompt');assert.equal(prompts[1][1].body.variant,'xhigh');assert.equal(prompts[0][1].body.variant,undefined);
});

test('Codex weekly-only scoring requires explicit provider window metadata',async()=>{
 const {codexWindowMetadata}=await import('../dist/policy/quota.js');
 const cfg={executorCandidates:threeCandidates,minQuotaRemainingPercent:10};
 const q=snapshot(50,50);q.openai={fetchedAt:Date.now(),entries:[{name:'Weekly',percentRemaining:70}],errors:[]};
 assert.equal(chooseExecutor(q,cfg).model,'a/sonnet');
 Object.assign(q.openai,codexWindowMetadata({rate_limit:{primary_window:{limit_window_seconds:604800,used_percent:30},secondary_window:null,allowed:true}}));
 const selection=chooseExecutor(q,cfg);assert.equal(selection.model,'openai/gpt-5.6-sol');assert.equal(selection.variant,'max');assert.equal(selection.gpt.fiveHour,null);assert.equal(selection.gpt.score,70);
 q.openai.codingAllowed=false;assert.equal(chooseExecutor(q,cfg).model,'a/sonnet');
});

test('watchdog recovery consumes a durable reservation and reuses the paused child', async t => {
 const f=await fixture(t,[plan,new Error('cancelled stalled request'),done('T1'),done('T2')],{executorCandidates:threeCandidates});
 const stopped=JSON.parse(await f.run({action:'start',adr:'ADR.md'},f.context));
 const read=async()=>JSON.parse(await fs.readFile(path.join(f.root,'runs',stopped.runId,'state.json'),'utf8'));
 const state=await read();
 await fs.mkdir(path.join(f.root,'watchdog'));
 const retryAt=Date.now();
 await fs.writeFile(path.join(f.root,'watchdog/state.json'),JSON.stringify({records:{[state.id+':'+state.child]:{stage:'retry_reserved',retryAt,recoveries:1,index:state.index,phase:state.phase}}}));
 const final=JSON.parse(await f.run({action:'resume',runId:state.id,input:'Watchdog confirmed cancellation. Reconcile existing work.',recovery:{child:state.child,expectedReservationAt:retryAt}},f.context));
 assert.equal(final.status,'completed');
 const prompts=f.calls.filter(c=>c[0]==='prompt').map(c=>c[1]);
 assert.deepEqual(prompts.map(p=>p.path.id),['s1','s2','s2','s3']);
 assert.equal(prompts[2].body.variant,'xhigh');
 assert.match(prompts[2].body.parts[0].text,/Reconcile existing work/);
 assert.equal((await read()).watchdogReservationAt,retryAt);
 assert.ok(f.calls.some(c=>c[0]==='idle'&&c[1]==='parent'));
});

test('stable gate IDs avoid wording mismatch while requiring explicit success',()=>{
 const t={...task('T5'),dod:['photo preserved','tests pass']};
 const response={...done('T5'),evidence:[{gateId:'G1',passed:true,detail:'Verified photo state preserved by locale-switch test'},{gateId:'G2',passed:true,detail:'594 tests passed'}]};
 validateCompletion(response,t);assert.deepEqual(response.evidence.map(e=>e.gate),t.dod);
 for(const evidence of [[{gateId:'G1',passed:false,detail:'not done'}],[{gateId:'G3',passed:true,detail:'wrong index'}],[{gateId:'G1',passed:true,detail:'ok'},{gateId:'G1',passed:true,detail:'duplicate'}]])assert.throws(()=>validateCompletion({...done('T5'),evidence},t));
});

test('native completion rejects ambiguous legacy-only evidence while legacy validation stays compatible', () => {
 const legacy={...done('T1'),evidence:[{gate:'test passed',detail:'Historical test output'}]};
 validateCompletion(legacy,task('T1'));
 assert.throws(()=>validateCompletion(legacy,task('T1'),{requireGateIds:true}),/stable gate ID/);
});

test('a saved attempt receipt advances exactly once without reprompting its completed child', async t => {
 const f=await fixture(t,[plan,new Error('process stopped before saving response'),done('T2')]);
 const paused=JSON.parse(await f.run({action:'start',adr:'ADR.md'},f.context));
 const base=path.join(f.root,'runs',paused.runId);const file=path.join(base,'state.json');
 const state=JSON.parse(await fs.readFile(file,'utf8'));
 state.attempt.status='admitted';await fs.writeFile(file,JSON.stringify(state));
 await fs.writeFile(path.join(base,'attempt-'+state.attempt.id+'.json'),JSON.stringify({...state.attempt,response:JSON.stringify(done('T1'))}));
 const completed=JSON.parse(await f.run({action:'resume',runId:state.id,input:'Apply the saved completion'},f.context));
 assert.equal(completed.status,'completed');
 assert.deepEqual(f.calls.filter(c=>c[0]==='prompt').map(c=>c[1].path.id),['s1','s2','s3']);
 const final=JSON.parse(await fs.readFile(file,'utf8'));assert.deepEqual(final.results.map(r=>r.taskId),['T1','T2']);
 const before=await fs.readFile(file,'utf8');
 await f.run({action:'resume',runId:state.id,input:'Already complete'},f.context);
 assert.equal(await fs.readFile(file,'utf8'),before,'completed runs are not rewritten');
});

test('completed native output can be recovered without a receipt or duplicate task prompt', async t => {
 const f=await fixture(t,[plan,new Error('connection disappeared after completion'),done('T2')]);
 const paused=JSON.parse(await f.run({action:'start',adr:'ADR.md'},f.context));
 const file=path.join(f.root,'runs',paused.runId,'state.json');const state=JSON.parse(await fs.readFile(file,'utf8'));
 state.attempt.status='admitted';await fs.writeFile(file,JSON.stringify(state));
 let recovered=0;f.backend.recoverResponse=async(child,parent,attempt)=>{assert.equal(child,'s2');assert.equal(parent,'parent');assert.equal(attempt.id,state.attempt.id);recovered++;return JSON.stringify(done('T1'));};
 const result=JSON.parse(await f.run({action:'resume',runId:state.id,input:'Recover the last native output'},f.context));
 assert.equal(result.status,'completed');assert.equal(recovered,1);
 assert.deepEqual(f.calls.filter(c=>c[0]==='prompt').map(c=>c[1].path.id),['s1','s2','s3']);
});

test('uncertain child creation and wrong-parent resume cannot create duplicates',async t=>{
 const f=await fixture(t,[new Error('interrupted')]);const paused=JSON.parse(await f.run({action:'start',adr:'ADR.md'},f.context));
 const file=path.join(f.root,'runs',paused.runId,'state.json');const state=JSON.parse(await fs.readFile(file,'utf8'));
 await assert.rejects(f.run({action:'resume',runId:state.id,input:'Resume'}, {...f.context,sessionID:'another-parent'}),/original parent/);
 state.child=null;state.attempt.child=null;state.attempt.status='launching';await fs.writeFile(file,JSON.stringify(state));
 const calls=f.calls.length;
 await assert.rejects(f.run({action:'resume',runId:state.id,input:'Try again'},f.context),/duplicate child will not be created/);
 assert.equal(f.calls.length,calls);
});

test('a watchdog retry reservation is consumed once even if its recovered task pauses again',async t=>{
 const f=await fixture(t,[plan,new Error('stall'),new Error('another failure')]);const paused=JSON.parse(await f.run({action:'start',adr:'ADR.md'},f.context));
 const file=path.join(f.root,'runs',paused.runId,'state.json');const state=JSON.parse(await fs.readFile(file,'utf8'));
 const retryAt=Date.now();await fs.mkdir(path.join(f.root,'watchdog'));
 await fs.writeFile(path.join(f.root,'watchdog/state.json'),JSON.stringify({records:{[state.id+':'+state.child]:{stage:'retry_reserved',retryAt,recoveries:1,index:state.index,phase:state.phase}}}));
 const args={action:'resume',runId:state.id,input:'Reconcile after cancellation',recovery:{child:state.child,expectedReservationAt:retryAt}};
 assert.equal(JSON.parse(await f.run(args,f.context)).status,'paused');const calls=f.calls.length;
 await assert.rejects(f.run(args,f.context),/already consumed/);
 assert.equal(f.calls.filter(c=>c[0]==='prompt').length,3);assert.equal(f.calls.length,calls+1,'only the idle verification is repeated');
});
