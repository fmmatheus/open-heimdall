import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {cachedQuota,retryAfterMs,deduplicateUsageFetch} from '../dist/policy/quota-cache.js';
async function fixture(t){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'quota-cache-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));return directory;}
test('429 cooldown persists across processes and honors server retry interval',async t=>{
 const directory=await fixture(t);const now=Date.now();
 const first=await cachedQuota('anthropic',async()=>({fetchedAt:now,errors:['http_429'],errorCode:'http_429',entries:[],retryAfterMs:3600000}),{directory,now:()=>now});
 assert.equal(first.retryAt,now+3600000);
 const source=`import {cachedQuota} from ${JSON.stringify(new URL('../dist/policy/quota-cache.js',import.meta.url).href)};console.log(JSON.stringify(await cachedQuota('anthropic',async()=>{throw Error('must not fetch')},{directory:${JSON.stringify(directory)}})));`;
 const result=JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',source],{encoding:'utf8'}));
 assert.equal(result.cached,true);assert.equal(result.retryAt,first.retryAt);assert.deepEqual(result.entries,[]);
});
test('backoff increases after cooldown expiry and success resets it',async t=>{
 const directory=await fixture(t);let clock=1000000;
 const fail=()=>({fetchedAt:clock,errors:['http_429'],errorCode:'http_429',entries:[]});
 const a=await cachedQuota('anthropic',async()=>fail(),{directory,now:()=>clock});assert.equal(a.retryAt-clock,300000);
 clock=a.retryAt+1;
 const b=await cachedQuota('anthropic',async()=>fail(),{directory,now:()=>clock});assert.equal(b.retryAt-clock,600000);
 clock=b.retryAt+1;
 await cachedQuota('anthropic',async()=>({fetchedAt:clock,errors:[],entries:[{name:'5h',percentRemaining:40}]}),{directory,now:()=>clock});
 assert.equal(JSON.parse(await fs.readFile(path.join(directory,'anthropic.json'))).failures,0);
});
test('success cache preserves timestamp and expires at 60 seconds',async t=>{
 const directory=await fixture(t);let clock=1000;let calls=0;
 const fetch=async()=>{calls++;return {fetchedAt:clock,errors:[],entries:[{name:'5h',percentRemaining:40}]};};
 await cachedQuota('kimi',fetch,{directory,now:()=>clock});clock+=59000;
 assert.equal((await cachedQuota('kimi',fetch,{directory,now:()=>clock})).fetchedAt,1000);assert.equal(calls,1);
 clock+=1001;await cachedQuota('kimi',fetch,{directory,now:()=>clock});assert.equal(calls,2);
});
test('concurrent processes cannot initiate duplicate provider probes',async t=>{
 const directory=await fixture(t);await fs.writeFile(path.join(directory,'anthropic.json.lock'),String(process.pid));
 const result=await cachedQuota('anthropic',async()=>{throw Error('must not fetch')},{directory});assert.equal(result.errorCode,'probe_in_progress');
});
test('usage request deduplication preserves responses and parses Retry-After',async()=>{
 let calls=0,delay=0;const fetch=deduplicateUsageFetch(async()=>{calls++;return new Response('{}',{status:429,headers:{'Retry-After':'420'}});},n=>{delay=n;});
 const url='https://api.anthropic.com/api/oauth/usage';
 assert.equal(await (await fetch(url)).text(),'{}');assert.equal(await (await fetch(url)).text(),'{}');assert.equal(calls,1);assert.equal(delay,420000);
 const now=Date.parse('2026-09-30T12:00:00Z');assert.equal(retryAfterMs('Wed, 30 Sep 2026 12:05:00 GMT',now),300000);assert.equal(retryAfterMs('bad',now),0);
});
test('account switches cannot reuse another account quota or bypass its stored cooldown',async t=>{
 const directory=await fixture(t);const clock=1000000;let calls=0;
 const accountA={directory,now:()=>clock,scope:'credential-account-A'};
 const accountB={directory,now:()=>clock,scope:'credential-account-B'};
 const limited=await cachedQuota('anthropic',async()=>{calls++;return {fetchedAt:clock,errorCode:'http_429',errors:['http_429'],entries:[]};},accountA);
 const available=await cachedQuota('anthropic',async()=>{calls++;return {fetchedAt:clock,errors:[],entries:[{name:'5h',percentRemaining:70}]};},accountB);
 assert.equal(available.entries[0].percentRemaining,70);assert.equal(available.cached,undefined);
 const again=await cachedQuota('anthropic',async()=>assert.fail('account A cooldown remains'),accountA);assert.equal(again.retryAt,limited.retryAt);assert.equal(calls,2);
 const fileText=(await Promise.all((await fs.readdir(directory)).map(file=>fs.readFile(path.join(directory,file),'utf8')))).join('');assert.ok(!fileText.includes('credential-account-A'));
});
