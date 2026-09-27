import test from 'node:test';import assert from 'node:assert/strict';
import {ingestChat,summarizeChatAsOf} from '../src/study-chat';
test('dedup preserves first observed time and token isolation',async()=>{
 let s=await ingestChat(undefined,{mint:'m',observedAt:1000,availability:'available',comments:[{text:'  moon   soon '}]});
 s=await ingestChat(s,{mint:'m',observedAt:2000,availability:'available',comments:[{text:'moon soon'}]});
 assert.equal(s.observations.length,1);assert.equal(s.observations[0].firstObservedAt,1000);
 await assert.rejects(()=>ingestChat(s,{mint:'other',observedAt:3000,availability:'available',comments:[]}));
});
test('early summaries never include later observed text even when published earlier',async()=>{
 let s=await ingestChat(undefined,{mint:'m',observedAt:1000,availability:'available',comments:[{id:'a',text:'buy moon'}]});
 const before=summarizeChatAsOf(s,0,60,60000);
 s=await ingestChat(s,{mint:'m',observedAt:61000,availability:'available',comments:[{id:'b',text:'rug dump',publishedAt:1000}]});
 assert.deepEqual(summarizeChatAsOf(s,0,60,60000),before);
 assert.equal(summarizeChatAsOf(s,0,120,120000).sentiment.negativeComments,1);
});
test('empty and unavailable differ and published time must be valid',async()=>{
 const empty=await ingestChat(undefined,{mint:'m',observedAt:1000,availability:'available',comments:[]});
 const unavailable=await ingestChat(undefined,{mint:'m',observedAt:1000,availability:'unavailable',comments:[]});
 assert.equal(summarizeChatAsOf(empty,0,60,60000).availability,'observed-empty');assert.equal(summarizeChatAsOf(unavailable,0,60,60000).availability,'unavailable');
 const s=await ingestChat(undefined,{mint:'m',observedAt:1000,availability:'available',comments:[{text:'hello',publishedAt:2000}]});assert.equal(s.observations[0].publishedAt,null);
});
test('repeated terms count separate comments not repeated words in a comment',async()=>{
 const s=await ingestChat(undefined,{mint:'m',observedAt:1000,availability:'available',comments:[{id:'1',text:'moon moon moon'},{id:'2',text:'moon but scam'}]});
 const r=summarizeChatAsOf(s,0,60,60000);assert.deepEqual(r.repeatedTerms,[{term:'moon',commentCount:2}]);assert.equal(r.sentiment.mixedComments,1);
});
test('retention bounded while preserving oldest observations for early windows',async()=>{
 let s=await ingestChat(undefined,{mint:'m',observedAt:1,availability:'available',comments:Array.from({length:300},(_,i)=>({id:String(i),text:'comment '+i}))});
 s=await ingestChat(s,{mint:'m',observedAt:2,availability:'available',comments:[{id:'extra',text:'extra'}]});assert.equal(s.observations.length,300);assert.equal(s.overflowObservationAttempts,1);assert.equal(s.observations[0].id,'source:0');
});
test('word movement uses a prior baseline and only available future outcomes',async()=>{
 const {wordMovementAssociations}=await import('../src/study-chat');
 const s=await ingestChat(undefined,{mint:'m',observedAt:10000,availability:'available',comments:[{text:'moon moon'}]});
 const samples=[{time:9000,priceUsd:1},{time:11000,priceUsd:100},{time:40000,priceUsd:2}];
 assert.equal(wordMovementAssociations(s.observations,samples,39999).matchedComments,0);
 const r=wordMovementAssociations(s.observations,samples,40000);assert.equal(r.terms[0].meanObservedChangePct,100);assert.equal(r.terms[0].count,1);assert.equal(r.terms[0].minimumCountMet,false);
 assert.equal(wordMovementAssociations(s.observations,samples.filter(p=>p.time!==9000),40000).matchedComments,0);
});
test('word movement rejects stale baseline and delayed outcome',async()=>{
 const {wordMovementAssociations}=await import('../src/study-chat');
 const s=await ingestChat(undefined,{mint:'m',observedAt:10000,availability:'available',comments:[{text:'moon'}]});
 assert.equal(wordMovementAssociations(s.observations,[{time:4999,priceUsd:1},{time:40000,priceUsd:2}],50000).matchedComments,0);
 assert.equal(wordMovementAssociations(s.observations,[{time:10000,priceUsd:1},{time:45001,priceUsd:2}],50000).matchedComments,0);
});

test('valid publication timestamps distinguish separate identical posts',async()=>{
 const s=await ingestChat(undefined,{mint:'m',observedAt:5000,availability:'available',comments:[{text:'moon',publishedAt:1000},{text:'moon',publishedAt:2000},{text:'moon',publishedAt:1000}]});
 assert.equal(s.observations.length,2);assert.notEqual(s.observations[0].id,s.observations[1].id);
});
test('full study summary includes late chat and labels repeated overflow attempts',async()=>{
 let s=await ingestChat(undefined,{mint:'m',observedAt:500000,availability:'available',comments:[{text:'late comment'}]});
 assert.equal(summarizeChatAsOf(s,0,120,600000).uniqueComments,0);assert.equal(summarizeChatAsOf(s,0,600,600000).uniqueComments,1);
 s=await ingestChat(s,{mint:'m',observedAt:500001,availability:'available',comments:Array.from({length:300},(_,i)=>({id:String(i),text:'comment '+i}))});
 s=await ingestChat(s,{mint:'m',observedAt:500002,availability:'available',comments:[{id:'299',text:'comment 299'}]});
 assert.equal(s.overflowObservationAttempts,2);assert.match(summarizeChatAsOf(s,0,600,600000).overflowCountMeaning,/not unique/);
});
