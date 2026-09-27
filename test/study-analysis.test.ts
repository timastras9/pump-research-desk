import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSamples,aggregateStudies,usageFromResponse,validateStudyAnalysis,analyzeStudy } from '../src/study-analysis';
test('metrics distinguish observed rise, hindsight peak, gaps and unknown launch',()=>{
 const m=summarizeSamples([{time:2000,priceUsd:1},{time:3000,priceUsd:null},{time:4000,priceUsd:1.2},{time:6000,priceUsd:.6}],1000);
 assert.equal(m.firstRise10PctAfterMs,3000);assert.equal(m.peakAfterMs,3000);assert.equal(m.maxDrawdownPct,50);assert.equal(m.maxGapMs,2000);assert.equal(m.detectionDelayMs,null);assert.equal(m.classification,'observed-rise');
});
test('missing prices are unknown, never zero-return evidence',()=>{
 const m=summarizeSamples([{time:1,priceUsd:null}],0);
 assert.equal(m.changePct,null);assert.equal(m.peakAfterMs,null);assert.equal(m.classification,'insufficient-data');
});
test('exclusions retain all data and can be reversed',()=>{
 const rows=[{id:'winner',metrics:summarizeSamples([{time:0,priceUsd:1},{time:1,priceUsd:2}],0)},{id:'loser',excluded:true,exclusionReason:'bad source',metrics:summarizeSamples([{time:0,priceUsd:1},{time:1,priceUsd:.1}],0)}];
 let a=aggregateStudies(rows);assert.equal(a.all.count,2);assert.equal(a.included.count,1);assert.equal(a.exclusions[0].reason,'bad source');
 rows[1].excluded=false;a=aggregateStudies(rows);assert.deepEqual(a.all,a.included);
});
test('usage costs require both measured token fields',()=>{
 assert.equal(usageFromResponse({usage:{prompt_tokens:1000,completion_tokens:100}}).estimatedUsd,.00135);
 assert.equal(usageFromResponse({usage:{prompt_tokens:1000}}).estimatedUsd,null);
 assert.equal(usageFromResponse({}).inputTokens,null);
});
test('structured analysis rejects oversized or unsupported output',()=>{
 const valid={assessment:'mixed',evidence:['Observation'],hypotheses:[],limitations:['Small sample'],nextTest:'Repeat on unseen tokens'};
 assert.equal(validateStudyAnalysis(JSON.stringify(valid)).assessment,'mixed');
 assert.throws(()=>validateStudyAnalysis(JSON.stringify({...valid,assessment:'winner'})));
 assert.throws(()=>validateStudyAnalysis(JSON.stringify({...valid,evidence:['x'.repeat(161)]})));
});
test('invalid AI output preserves usage and reports analysis failure without retry',async()=>{
 let calls=0;const ai={run:async()=>{calls++;return {usage:{prompt_tokens:100,completion_tokens:20},response:'not JSON'};}};
 const result=await analyzeStudy(ai as unknown as Pick<Ai,'run'>,{});
 assert.equal(calls,1);assert.equal(result.analysis,null);assert.ok(result.error);assert.equal(result.usage.inputTokens,100);
});
test('sparse unchanged observations cannot be classified as a failed launch',()=>{
 const m=summarizeSamples([{time:0,priceUsd:1},{time:600000,priceUsd:1}],0,null,{capturedMs:30000,elapsedMs:600000});
 assert.equal(m.coverageRatio,.05);assert.equal(m.coverageStatus,'sparse');assert.equal(m.classification,'insufficient-data');
});
test('partial and malformed chunk usage remains unknown',()=>{
 for(const raw of [null,{},{prompt_tokens:-1,completion_tokens:2},{prompt_tokens:1,completion_tokens:null}])assert.equal(usageFromResponse({usage:raw}).estimatedUsd,null);
 assert.equal(usageFromResponse({usage:{input_tokens:0,output_tokens:0}}).estimatedUsd,0);
});
test('single price leaves returns unknown and does not enter group return statistics',()=>{
 const metrics=summarizeSamples([{time:1,priceUsd:5}],0);
 assert.equal(metrics.changePct,null);assert.equal(metrics.peakGainPct,null);assert.equal(metrics.peakAfterMs,null);
 const group=aggregateStudies([{id:'one',metrics}]);assert.equal(group.all.changePct.count,0);assert.equal(group.all.insufficientData,1);
});
test('capture coverage cannot conceal unreadable prices or long valid-price gaps',()=>{
 const samples=[{time:0,priceUsd:1},{time:600000,priceUsd:1},...Array.from({length:100},(_,i)=>({time:100+i*5000,priceUsd:null}))];
 const m=summarizeSamples(samples,0,null,{capturedMs:550000,elapsedMs:600000});
 assert.equal(m.coverageStatus,'sparse');assert.equal(m.classification,'insufficient-data');assert.equal(m.validPriceRatio,2/102);
 assert.equal(m.changePct,0); // Retain endpoint observation; quality flag is separate.
 const gap=summarizeSamples([{time:0,priceUsd:1},{time:11000,priceUsd:1}],0,null,{capturedMs:11000,elapsedMs:11000});
 assert.equal(gap.validPriceRatio,1);assert.equal(gap.classification,'insufficient-data');
});
test('a rise remains observed in sparse data without upgrading data quality',()=>{
 const m=summarizeSamples([{time:0,priceUsd:1},{time:60000,priceUsd:1.2}],0,null,{capturedMs:5000,elapsedMs:60000});
 assert.equal(m.classification,'observed-rise');assert.equal(m.coverageStatus,'sparse');assert.equal(m.firstRise10PctAfterMs,60000);
});
