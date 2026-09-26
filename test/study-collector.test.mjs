import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

// Execute the production coordinator with deterministic storage/browser adapters.
// This tests alarm state transitions without billable browser or AI requests.
function harness(options={}){
  let now=1_800_000_000_000,scans=0,captures=0;const alarms=new Map(),recorders=new Map();
  const state=new Map(),tables={study_campaigns:new Map(),study_tokens:new Map(),study_chunks:new Map()};
  function makeStorage(key){let state=new Map();return {sql:{exec(query,...args){
    if(query.startsWith('CREATE'))return {toArray:()=>[]};
    if(query.startsWith('INSERT')){state.set(args[0],args[1]);return {toArray:()=>[]};}
    const rows=query.includes('LIKE')?[...state].filter(([k])=>k.startsWith(args[0].replace('%',''))).map(([,data])=>({data})):(state.has(args[0])?[{data:state.get(args[0])}]:[]);
    return {toArray:()=>rows};
  }},setAlarm:async value=>{alarms.set(key,value);},getAlarm:async()=>alarms.get(key)??null,deleteAlarm:async()=>{alarms.delete(key);}};}
  const storage=makeStorage('parent');
  const db={prepare(query){let args=[];const table=Object.keys(tables).find(t=>query.includes(t));return {bind(...values){args=values;return this;},async run(){tables[table].set(args[0],{data:args.at(-1),args});if(options.dbHook)await options.dbHook(query,args);},async first(){return tables[table].get(args[0])??null;},async all(){let rows=[...tables[table].values()];if(query.includes('campaign_id')||query.includes('token_id'))rows=rows.filter(r=>r.args[1]===args[0]);return {results:rows};}};}};
  const media=new Map(Object.entries(options.media??{}));
  const env={CRYPTO_STUDY:db,CRYPTO_MEDIA:{put:async(k,v)=>{media.set(k,v);},get:async k=>media.has(k)?{text:async()=>media.get(k)}:null},AI:{run:async()=>({})}};
  const exports_=globalThis.__ragExports=[];
  class Clock extends Date{static now(){return now;}}
  const candidate={mint:'123456789ABCDEFGHJKLMNPQRSTUVWXYZabcd',name:'test',group:'new',createdAt:now,detectedAt:now,firstSeenAt:now,raw:{},marketCapUsd:null,athUsd:null,volume24hUsd:null,traders:null,transactions:null};
  globalThis.fetch=async()=>({ok:false,json:async()=>({})});
  const mocks={
    'cloudflare:workers':{DurableObject:class {constructor(ctx,env){this.ctx=ctx;this.env=env;}}},
    './observer':{browserCapacity:async()=>({maxConcurrentSessions:options.capacity??21,activeSessions:[],allowedBrowserAcquisitions:20,timeUntilNextAllowedBrowserAcquisition:0}),scanExplore:async()=>{scans++;return {candidates:options.candidates??[candidate],errors:[],browserDurationMs:10};},observe:async(_env,_mint,id,_seconds,_assumptions,save)=>{captures++;if(options.observeHook)await options.observeHook(_mint);const frame={index:0,captureStartedAt:now,capturedAt:now,screenshotMs:0,image:'YQ==',text:'',priceUsd:1,priceRaw:'$1',priceMode:'Price',priceReadAt:now};await save(frame);return {id,startedAt:now,samples:[frame],reviews:[],measurements:{durationMs:1000},browserDurationMs:1100,usage:[],failure:null};}},
    './study-features':{compareEarlyWithLater:()=>({early:[],laterOutcomes:[]})},
    './paper-trader':{paperTrade:()=>({version:'paper-v2',status:'skipped',skipReason:'test'}),summarizePaper:()=>({overall:{}}),tunePaper:()=>({status:'insufficient-data'}),validRules:x=>({version:'paper-v2',...x}),PAPER_RULES:{version:'paper-v2'},passesFilter:()=>true,classifyTrade:()=>null,mistakeSummary:()=>({}),PAPER_FILTERS:['all','feeRouted|mayhem']},
    './launch-feed':{fetchNewLaunches:async()=>{scans++;return {candidates:options.candidates??[candidate],errors:[],browserDurationMs:0};},LAUNCH_POLL_MS:30000},
    './study-chat':{ingestChat:async(prev,snap)=>({mint:snap.mint,observations:[...(prev?.observations??[])],checks:[]}),summarizeChatAsOf:(st,start,seconds)=>({seconds,availability:'observed-empty',uniqueComments:0,sentiment:{positiveComments:0,negativeComments:0}}),wordMovementAssociations:()=>({matchedComments:0,terms:[]})},
    './research-model':{freshLaunch:c=>now-c.createdAt<=60000},
    './model':{Model:class{constructor(spec){this.spec=spec;}}},
    './model-runner':{stepJob:async()=>'finished',newJob:(campaignId,model,tokens,now)=>({campaignId,model,dueAt:now,queuedAt:now,done:0,total:tokens.length,errors:[]}),d1Deps:()=>({}),MODEL_SCHEMA:[],runKey:(c,s)=>`runs/${c}/${s}.json`},
    './astra-review':{reviewRun:async()=>({review:{summary:'ok'}})},
    './rag-export':{exportStudy:async(_db,_b,id)=>{exports_.push(id);return {study:id,tokens:0};}},
    './study-analysis':{reviewMistakes:async()=>({lessons:null,usage:{estimatedUsd:0},error:null}),compactStudyInput:x=>x,compactAggregateInput:x=>x,compareWinnersLosers:()=>({features:[]}),priceSeries:()=>[],exitMetrics:()=>({}),outcomeLabel:()=>'unscored',launchInfoFromCoin:()=>null,isTerminalLaunch:()=>false,COLLECTIVE_PROMPT:'collective',summarizeSamples:()=>({classification:'flat'}),analyzeStudy:async()=>({analysis:{},usage:{estimatedUsd:0},error:null}),aggregateStudies:rows=>({all:{count:rows.length}}),usageFromResponse:()=>({estimatedUsd:0})},
  };
  const source=ts.transpileModule(readFileSync(new URL('../src/study-collector.ts',import.meta.url),'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const exports={};new Function('require','exports','Date',source)(name=>{if(!mocks[name])throw Error(`Unexpected dependency ${name}`);return mocks[name];},exports,Clock);
  env.RECORDERS={getByName(id){if(!recorders.has(id))recorders.set(id,new exports.StudyRecorder({storage:makeStorage(id)},env));return recorders.get(id);}};
  const coordinator=new exports.StudyCoordinator({storage},env);
  return {coordinator,state,tables,advance:ms=>{now+=ms;},recorders,alarm:()=>alarms.get('parent'),runChildren:()=>Promise.all([...recorders.values()].map(r=>r.alarm())),scans:()=>scans,captures:()=>captures};
}

test('capacity checked and default campaign can admit 100 with twenty isolated recorders',async()=>{
 const h=harness();const c=await h.coordinator.start();assert.equal(c.maxTokens,100);assert.equal(c.concurrency,20);await assert.rejects(h.coordinator.start());await h.coordinator.stop();const limited=harness({capacity:4});assert.equal((await limited.coordinator.start()).concurrency,3);await assert.rejects(harness({capacity:1}).coordinator.start());
});
test('discovery only admits; child alarms persist evidence and finish independently',async()=>{
 const h=harness();const c=await h.coordinator.start({maxTokens:1});await h.coordinator.alarm();assert.equal(h.captures(),0);assert.equal(h.recorders.size,1);await h.runChildren();assert.equal(h.captures(),1);assert.equal(h.tables.study_chunks.size,1);h.advance(600001);await h.runChildren();await h.coordinator.alarm();const d=await h.coordinator.detail(c.id);assert.equal(d.tokens[0].status,'finished');assert.equal(d.campaign.status,'finished');assert.deepEqual(globalThis.__ragExports,[c.id],'finished study is exported to R2 for RAG');
});
test('a stalled token does not block discovery or another token recorder',async()=>{
 let release,entered;const gate=new Promise(r=>release=r),reached=new Promise(r=>entered=r);
 const candidates=[0,1].map(i=>({mint:`mint${i}`,name:`token${i}`,group:'new',createdAt:1_800_000_000_000,raw:{}}));
 const h=harness({candidates,observeHook:async mint=>{if(mint==='mint0'){entered();await gate;}}});const c=await h.coordinator.start({maxTokens:5});await h.coordinator.alarm();const children=[...h.recorders.values()];const stalled=children[0].alarm();await reached;await children[1].alarm();h.advance(30000);await h.coordinator.alarm();assert.equal(h.scans(),2);const d=await h.coordinator.detail(c.id);assert.equal(d.tokens.find(t=>t.mint==='mint1').frameCount,1);release();await stalled;
});
test('stop preserves stopped status after an in-flight child completes',async()=>{
 let release,entered;const gate=new Promise(r=>release=r),reached=new Promise(r=>entered=r);const h=harness({observeHook:async()=>{entered();await gate;}});const c=await h.coordinator.start({maxTokens:1});await h.coordinator.alarm();const work=h.runChildren();await reached;await h.coordinator.stop(c.id);release();await work;assert.equal((await h.coordinator.detail(c.id)).tokens[0].status,'stopped');
});
test('each failed token has bounded attempts and exclusions retain evidence',async()=>{
 const h=harness({observeHook:async()=>{throw Error('Browser failed');}});const c=await h.coordinator.start({maxTokens:1});await h.coordinator.alarm();for(let i=0;i<4;i++)await h.runChildren();const d=await h.coordinator.detail(c.id);assert.equal(h.captures(),3);assert.equal(d.tokens[0].status,'failed');const id=d.tokens[0].id;await assert.rejects(h.coordinator.flag(id,true,''));await h.coordinator.flag(id,true,'Incomplete');await h.coordinator.flag(id,false,'');assert.equal((await h.coordinator.token(id)).token.excluded,false);
});
test('capacity skips explicitly count tokens the study could not admit',async()=>{
 const candidates=Array.from({length:5},(_,i)=>({mint:`mint${i}`,name:`token${i}`,group:'new',createdAt:1_800_000_000_000,raw:{}}));const h=harness({candidates});const c=await h.coordinator.start({maxTokens:5,concurrency:2});await h.coordinator.alarm();const d=await h.coordinator.detail(c.id);assert.equal(d.tokens.length,2);assert.equal(d.campaign.skippedCapacity,3);assert.equal(d.campaign.seenCount,5);
});
test('launch filters skip website launches and re-check tokens below the minimum market cap',async()=>{
 const candidates=[{mint:'lowcap',name:'low',group:'new',createdAt:1_800_000_000_000,raw:{},marketCapUsd:3400},{mint:'webcap',name:'web',group:'new',createdAt:1_800_000_000_000,raw:{},marketCapUsd:9000}];
 const h=harness({candidates});const c=await h.coordinator.start({maxTokens:5,concurrency:3,minMarketCapUsd:5000,launchFilter:'terminal'});
 assert.equal(c.minMarketCapUsd,5000);assert.equal(c.launchFilter,'terminal');await h.coordinator.alarm();
 const d=await h.coordinator.detail(c.id);assert.equal(d.tokens.length,0);assert.equal(d.campaign.skippedFilter,1);
 const s=await h.coordinator.status();assert.equal(s.campaign.seenCount,1);
 await assert.rejects(harness().coordinator.start({minMarketCapUsd:-1}),/Minimum market cap/);
});
test('a burst of launches is admitted concurrently with latency recorded, and polls keep a fixed cadence',async()=>{
 const candidates=[0,1,2].map(i=>({mint:`burst${i}`,name:`b${i}`,group:'new',createdAt:1_800_000_000_000-4000,firstSeenAt:1_800_000_000_000-1000,detectedAt:1_800_000_000_000,raw:{}}));
 const h=harness({candidates});let inflight=0,most=0;
 globalThis.fetch=async()=>{inflight++;most=Math.max(most,inflight);await new Promise(r=>setTimeout(r,5));inflight--;return {ok:false,json:async()=>({})};};
 const c=await h.coordinator.start({maxTokens:10});await h.coordinator.alarm();
 assert.equal(most,3,'all three launch lookups ran at the same time');
 const d=await h.coordinator.detail(c.id);assert.equal(d.tokens.length,3);
 for(const t of d.tokens){assert.equal(t.latency.seenAfterLaunchMs,3000);assert.equal(t.latency.admitAfterSeenMs,1000);}
 const s=await h.coordinator.status();assert.equal(s.nextAlarmAt,s.campaign.lastScanAt+30000,'next poll is timed from this poll start');
});
test('copycat launches (same name, new mint) are recorded once and counted as skipped',async()=>{
 const mk=(mint,name)=>({mint,name,group:'new',createdAt:1_800_000_000_000,firstSeenAt:1_800_000_000_000,detectedAt:1_800_000_000_000,raw:{}});
 const h=harness({candidates:[mk('m1','TOLY RETWEETED 40k'),mk('m2','toly retweeted 40K!!'),mk('m3','Catecoin'),mk('m4','TOLY  RETWEETED 40k')]});
 const c=await h.coordinator.start({maxTokens:10});await h.coordinator.alarm();
 const d=await h.coordinator.detail(c.id);assert.deepEqual(d.tokens.map(t=>t.mint).sort(),['m1','m3']);
 const s=await h.coordinator.status();assert.equal(s.campaign.skippedDuplicate,2);assert.equal(s.campaign.seenCount,4);
});
test('trained model: owner sets the active model; finished runs queue a model paper run',async()=>{
 const spec=JSON.stringify({format:'pump-model-v1',name:'model-v3',sha256:'abc123'});
 const h=harness({media:{'models/model-v3.json':spec}});
 await assert.rejects(h.coordinator.queueModelRun('none'),/No active model/);
 await assert.rejects(h.coordinator.setActiveModel('models/missing.json','Tim'),/not found/);
 await assert.rejects(h.coordinator.setActiveModel('../etc/passwd','Tim'),/must look like/);
 await assert.rejects(h.coordinator.setActiveModel('models/model-v3.json',' '),/Approver/);
 const s=await h.coordinator.setActiveModel('models/model-v3.json','Tim');
 assert.deepEqual([s.active.name,s.active.sha,s.active.by],['model-v3','abc123','Tim']);assert.equal(s.history.length,1);
 const c=await h.coordinator.start({maxTokens:1});await h.coordinator.alarm();await h.runChildren();h.advance(600001);await h.runChildren();await h.coordinator.alarm();
 assert.equal((await h.coordinator.detail(c.id)).campaign.status,'finished');
 const jobs=h.coordinator.modelState().jobs;
 assert.equal(jobs.length,1);assert.equal(jobs[0].campaignId,c.id);assert.equal(jobs[0].model.sha,'abc123');
 await h.coordinator.alarm();assert.equal(h.coordinator.modelState().jobs.length,0,'the next alarm runs the job to completion');
});
