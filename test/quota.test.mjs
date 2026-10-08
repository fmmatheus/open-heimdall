import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chooseExecutor,createQuota,fetchQuota,probeQuota,refreshClaudeAuth,sanitizeQuotaResult} from '../dist/policy/quota.js';
const settings={minQuotaRemainingPercent:10,fiveHourQuotaWeight:0.6,executorCandidates:[{key:'sonnet',quotaProvider:'anthropic',model:'anthropic/sonnet',variant:'xhigh'},{key:'kimi',quotaProvider:'kimi',model:'kimi/k3'},{key:'gpt',quotaProvider:'openai',model:'openai/gpt',variant:'max'}]};

test('Claude Code quota uses its shared-login reader without native credential resolution', async () => {
 const cfg = { ...settings, plannerModel: 'claude-code/opus', executorCandidates: [{ key: 'sonnet', quotaProvider: 'claude-code', model: 'claude-code/sonnet' }] };
 let probes = 0;
 const options = {
  integration: { connection: { resolve: () => assert.fail('Claude Code must not resolve native credentials') } },
  load: () => assert.fail('Claude Code-only quota must not load the native account adapter'),
  claudeCodeProbe: async () => { probes++; return { fetchedAt: Date.now(), errors: [], entries: [{ name: '5h', percentRemaining: 80 }, { name: 'Weekly', percentRemaining: 70 }, { name: 'Opus Weekly', percentRemaining: 0 }] }; },
  log: () => assert.fail('successful quota must not log authentication errors'),
 };
 const value = await fetchQuota(cfg, options);
 assert.deepEqual(Object.keys(value), ['claude-code']);
 assert.equal(probes, 1);
 assert.equal(chooseExecutor(value, cfg).model, 'claude-code/sonnet');
});

test('Claude Code quota authentication failure requests its own manual refresh', async () => {
 const cfg = { ...settings, plannerModel: 'claude-code/opus', executorCandidates: [{ key: 'sonnet', quotaProvider: 'claude-code', model: 'claude-code/sonnet' }] };
 const events = [];
 await assert.rejects(fetchQuota(cfg, {
  integration: { connection: { resolve: () => assert.fail('no native refresh') } },
  claudeCodeProbe: async () => ({ fetchedAt: Date.now(), errors: ['claude_auth_required'], entries: [], authExpired: true }),
  log: async entry => events.push(entry),
 }), /Refresh Claude Code manually/);
 assert.equal(events.length, 1);
 assert.equal(events[0].provider, 'claude-code');
});

test('an unavailable optional Claude Code executor does not block native planning or fallback', async () => {
 const cfg = { ...settings, plannerModel: 'anthropic/opus', executorCandidates: [{ key: 'sdk', quotaProvider: 'claude-code', model: 'claude-code/sonnet' }, { key: 'native', quotaProvider: 'anthropic', model: 'anthropic/sonnet' }] };
 const value = await fetchQuota(cfg, {
  integration: { connection: { resolve: () => assert.fail('injected snapshots must not resolve credentials') } },
  probe: async () => ({ anthropic: { fetchedAt: Date.now(), entries: [{ name: '5h', percentRemaining: 80 }, { name: 'Weekly', percentRemaining: 80 }], errors: [] }, 'claude-code': { fetchedAt: Date.now(), entries: [], errors: ['claude_auth_required'], authExpired: true } }),
  log: async () => {},
 });
 assert.equal(chooseExecutor(value, cfg).model, 'anthropic/sonnet');
});
const quota=(five,week,extra={})=>({fetchedAt:Date.now(),errors:[],entries:[{name:'5h',percentRemaining:five},{name:'Weekly',percentRemaining:week}],...extra});
test('fresh quota reserve, harmonic weighting and per-task model variants are preserved',()=>{
 const pick=chooseExecutor({anthropic:quota(50,50),kimi:quota(80,9),openai:quota(90,90)},settings);
 assert.equal(pick.model,'openai/gpt');assert.equal(pick.variant,'max');assert.equal(pick.kimi.eligible,false);assert.ok(pick.gpt.score>pick.sonnet.score);
});
test('candidate keys cannot overwrite selected model, variant or checked timestamp',()=>{
 for(const key of ['model','variant','checkedAt']) {
  const configured={...settings,executorCandidates:[{key,quotaProvider:'openai',model:'openai/gpt',variant:'max'}]};
  assert.throws(()=>chooseExecutor({openai:quota(90,90)},configured),new RegExp('reserved selection field: '+key));
 }
 const configured={...settings,executorCandidates:[{key:'executor',quotaProvider:'openai',model:'openai/gpt',variant:'max'}]};
 const selected=chooseExecutor({openai:quota(90,90)},configured);
 assert.equal(selected.model,'openai/gpt');assert.equal(selected.variant,'max');assert.equal(typeof selected.checkedAt,'string');assert.equal(selected.executor.eligible,true);
});
test('missing, future, stale and failed quota cannot participate in selection',()=>{
 const broken=[quota(50,50,{fetchedAt:Date.now()-60001}),quota(50,50,{fetchedAt:Date.now()+10000}),quota(50,50,{errors:['http_429']}),quota(50,50,{entries:[]})];
 for(const value of broken)assert.throws(()=>chooseExecutor({anthropic:value},settings),/No eligible/);
});
test('weekly-only OpenAI availability is explicit; code review windows do not select coding work',()=>{
 const weekly={fetchedAt:Date.now(),errors:[],windowCoverage:'weekly_only',codingAllowed:true,entries:[{name:'OpenAI Weekly',percentRemaining:70},{name:'Code Review',percentRemaining:0}]};
 assert.equal(chooseExecutor({openai:weekly},settings).model,'openai/gpt');
 assert.throws(()=>chooseExecutor({openai:{...weekly,codingAllowed:false}},settings),/No eligible/);
 assert.throws(()=>chooseExecutor({openai:{...weekly,windowCoverage:'unspecified'}},settings),/No eligible/);
});
test('credential refresh belongs to OpenCode, never Terminal or auth.json',async()=>{
 const connection={type:'credential',id:'cred_one'};const events=[];
 const integration={connection:{active:async id=>{events.push(id);return connection;},resolve:async c=>{assert.equal(c,connection);events.push('resolve');return {type:'oauth',access:'secret',expires:Date.now()+10000};}}};
 assert.equal(await refreshClaudeAuth(integration),true);assert.deepEqual(events,['anthropic','resolve']);
 await assert.rejects(refreshClaudeAuth(),/integration API/);
 await assert.rejects(refreshClaudeAuth({connection:{active:async()=>undefined,resolve:async()=>assert.fail()}}),/Reconnect/);
});
test('quota failures persist classified diagnostics only and do not auto-launch authentication',async()=>{
 const value=sanitizeQuotaResult('anthropic',{entries:[],errors:[{message:'HTTP 401 unauthorized Bearer secret-token'}]});
 assert.deepEqual(value.errors,['authentication']);assert.equal(value.authExpired,true);assert.ok(!JSON.stringify(value).includes('secret-token'));
 const events=[];const integration={connection:{resolve:async()=>assert.fail('the probe performs native credential resolution')}};
 await assert.rejects(fetchQuota(settings,{integration,probe:async()=>({anthropic:value}),log:async entry=>events.push(entry)}),/Reconnect Anthropic in OpenChamber/);
 assert.equal(events[0].action,'reconnect_in_openchamber');
 const snapshot={kimi:quota(50,50)};assert.deepEqual(await createQuota({integration,probe:async()=>snapshot,log:async()=>{}})(settings),snapshot);
});
async function fixture(t){
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'quota-native-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const base=path.join(directory,'package');await fs.mkdir(base);await fs.writeFile(path.join(base,'package.json'),JSON.stringify({name:'@slkiser/opencode-quota',version:'5.0.1'}));
 return {directory,base};
}
test('quota5 uses active native credentials, observes fresh HTTP, deduplicates Anthropic and restores bindings',async t=>{
 const {directory,base}=await fixture(t);let bound;let cleanups=0;const calls={};const clock=Date.now();
 const auth={createIntegrationCredentialSource:integration=>({kind:'opencode-integration-api',readRows:async request=>{assert.equal(integration.marker,true);assert.equal(request.firstOnly,true);return request.integrationIds.map(id=>({id:'cred_'+id,integrationId:id,value:id==='kimi-code-plan-global'?{type:'api',key:'kimi-token'}:{type:'oauth',access:id+'-token',expires:clock+3600000}}));}}),bindCredentialSource:source=>{bound=source;return()=>{cleanups++;bound=undefined;};},notifyCredentialsChanged:()=>{}};
 const urls={anthropic:'https://api.anthropic.com/api/oauth/usage',kimi:'https://api.kimi.ai/coding/v1/usages',openai:'https://chatgpt.com/backend-api/wham/usage'};
 const provider=key=>({fetch:async()=>{const id=key==='kimi'?'kimi-code-plan-global':key;const rows=await bound.readRows({integrationIds:[id]});assert.equal(rows.length,1);const options={headers:{authorization:'Bearer '+(key==='kimi'?rows[0].value.key:rows[0].value.access)}};await fetch(urls[key],options);if(key==='anthropic')await fetch(urls[key],options);return {entries:[{name:'5h',percentRemaining:70},{name:'Weekly',percentRemaining:70}],errors:[]};}});
 const load=async file=>file.endsWith('/opencode-auth.js')?auth:file.endsWith('/anthropic.js')?{anthropicProvider:provider('anthropic')}:file.endsWith('/kimi-code.js')?{kimiCodePlanGlobalProvider:provider('kimi')}:{openaiProvider:provider('openai')};
 const original=globalThis.fetch;
 const fetchImpl=async url=>{calls[url]=(calls[url]||0)+1;return Response.json(String(url)===urls.openai?{rate_limit:{allowed:true,primary_window:{limit_window_seconds:604800,used_percent:30},secondary_window:null}}:{});};
 const result=await probeQuota({...settings,packagePath:base},{integration:{marker:true},directory,load,fetchImpl,now:()=>clock});
 assert.equal(calls[urls.anthropic],1);assert.equal(result.anthropic.fetchedAt,clock);assert.equal(result.openai.windowCoverage,'weekly_only');
 assert.equal(globalThis.fetch,original);assert.equal(cleanups,1);
 const again=await probeQuota({...settings,packagePath:base},{integration:{marker:true},directory,load,fetchImpl,now:()=>clock+1000});
 assert.equal(again.anthropic.fetchedAt,clock);assert.equal(again.anthropic.cached,true);assert.equal(calls[urls.anthropic],1);
});
test('provider cached output without a fresh HTTP observation is excluded',async t=>{
 const {directory,base}=await fixture(t);
 const auth={createIntegrationCredentialSource:()=>({kind:'opencode-integration-api',readRows:async request=>request.integrationIds.map(id=>({id:'cred_'+id,integrationId:id,value:id==='kimi-code-plan-global'?{type:'api',key:'key'}:{type:'oauth',access:'access',expires:Date.now()+3600000}}))}),bindCredentialSource:()=>()=>{},notifyCredentialsChanged:()=>{}};
 const provider={fetch:async()=>({entries:[{name:'5h',percentRemaining:80},{name:'Weekly',percentRemaining:80}],errors:[]})};
 const load=async file=>file.endsWith('/opencode-auth.js')?auth:{anthropicProvider:provider,kimiCodePlanGlobalProvider:provider,openaiProvider:provider};
 const result=await probeQuota({...settings,packagePath:base},{integration:{},directory,load,fetchImpl:()=>assert.fail('no HTTP'),now:Date.now});
 assert.equal(result.anthropic.errorCode,'fresh_quota_not_observed');assert.deepEqual(result.anthropic.entries,[]);
 assert.throws(()=>chooseExecutor(result,settings),/No eligible/);
});
test('missing native credentials cannot fall back to CLI or environment credentials',async t=>{
 const {directory,base}=await fixture(t);
 const auth={createIntegrationCredentialSource:()=>({kind:'opencode-integration-api',readRows:async()=>[]}),bindCredentialSource:()=>()=>{},notifyCredentialsChanged:()=>{}};
 const provider={fetch:async()=>assert.fail('never probe fallback credentials')};const load=async file=>file.endsWith('/opencode-auth.js')?auth:{anthropicProvider:provider,kimiCodePlanGlobalProvider:provider,openaiProvider:provider};
 const result=await probeQuota({...settings,packagePath:base},{integration:{},directory,load,fetchImpl:()=>assert.fail('no HTTP'),now:Date.now});
 assert.equal(result.anthropic.authExpired,true);assert.equal(result.kimi.errorCode,'native_credential_unavailable');assert.throws(()=>chooseExecutor(result,settings),/No eligible/);
});
test('configured workflow root stores only classified quota events',async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'quota-events-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const workflowRoot=path.join(directory,'custom-state');
 const value=sanitizeQuotaResult('kimi',{errors:[{message:'HTTP 503 Bearer synthetic-secret'}],entries:[]});
 await fetchQuota(settings,{integration:{connection:{resolve:async()=>assert.fail('mock probe resolves no credentials')}},directory,workflowRoot,probe:async()=>({kimi:value})});
 const text=await fs.readFile(path.join(workflowRoot,'quota-events.jsonl'),'utf8');
 assert.ok(!text.includes('synthetic-secret'));assert.ok(!text.includes('Bearer'));
 const entry=JSON.parse(text);assert.equal(entry.provider,'kimi');assert.equal(entry.errorCode,'http_503');assert.equal(entry.action,'exclude_from_selection');
});
test('thrown provider diagnostics remain classified and scoped bindings are restored',async t=>{
 const {directory,base}=await fixture(t);let cleanups=0;
 const auth={createIntegrationCredentialSource:()=>({kind:'mock-native',readRows:async request=>request.integrationIds.map(id=>({id:'mock_'+id,integrationId:id,value:id==='kimi-code-plan-global'?{type:'api',key:'fake-key'}:{type:'oauth',access:'fake-access',expires:Date.now()+3600000}}))}),bindCredentialSource:()=>()=>{cleanups++;},notifyCredentialsChanged:()=>{}};
 const provider={fetch:async()=>{throw {message:'HTTP 503 Bearer synthetic-secret'};}};
 const load=async file=>file.endsWith('/opencode-auth.js')?auth:{anthropicProvider:provider,kimiCodePlanGlobalProvider:provider,openaiProvider:provider};
 const original=globalThis.fetch;
 const result=await probeQuota({...settings,packagePath:base},{integration:{},directory,load,fetchImpl:()=>assert.fail('no real HTTP')});
 for(const value of Object.values(result))assert.equal(value.errorCode,'http_503');
 assert.ok(!JSON.stringify(result).includes('synthetic-secret'));assert.equal(globalThis.fetch,original);assert.equal(cleanups,1);
 await assert.rejects(probeQuota({...settings,packagePath:base},{integration:{},directory,load:async file=>file.endsWith('/opencode-auth.js')?auth:Promise.reject(Error('mock module failure')),fetchImpl:()=>assert.fail('no real HTTP')}),/mock module failure/);
 assert.equal(globalThis.fetch,original);assert.equal(cleanups,2);
});
