import test from 'node:test';
import assert from 'node:assert/strict';
import {deriveEarlyWindows,compareEarlyWithLater} from '../src/study-features';
const baseline=Array.from({length:241},(_,i)=>({time:i*500,priceUsd:1+i/1000}));
test('60-second feature values cannot use later prices',()=>{
 const original=deriveEarlyWindows(baseline,0,null,120000);
 const changed=deriveEarlyWindows([...baseline.filter(s=>s.time<=60000),{time:60500,priceUsd:1000},{time:120000,priceUsd:.0001}],0,null,120000);
 assert.deepEqual(original[0],changed[0]);assert.notDeepEqual(original[1].metrics,changed[1].metrics);
});
test('caller availability prevents future evidence leakage even if supplied',()=>{
 const early=deriveEarlyWindows([...baseline,{time:600000,priceUsd:1000}],0,null,30000);
 assert.equal(early[0].complete,false);assert.equal(early[0].metrics.lastPriceAt,30000);
 assert.equal(early[1].metrics.lastPriceAt,30000);
});
test('cutoff inclusive and timing relative to detection, not creation',()=>{
 const windows=deriveEarlyWindows([{time:10000,priceUsd:1},{time:70000,priceUsd:2},{time:70001,priceUsd:10}],10000,1000,70001);
 assert.equal(windows[0].metrics.lastPriceUsd,2);assert.equal(windows[0].detectionDelayMs,9000);assert.equal(windows[0].clockBasis,'observation-start');
});
test('leading and trailing gaps flag sparse early evidence',()=>{
 const windows=deriveEarlyWindows([{time:20000,priceUsd:1},{time:20500,priceUsd:1.1}],0,null,60000);
 assert.equal(windows[0].quality,'sparse');assert.equal(windows[0].leadingGapMs,20000);assert.equal(windows[0].trailingGapMs,39500);
});
test('later outcome is separate and requires actual later observations',()=>{
 const emptyLater=compareEarlyWithLater(baseline.filter(s=>s.time<=60000),0,null,60000);
 assert.equal(emptyLater.laterOutcomes[0].changeFromEarlyLastPct,null);
 const result=compareEarlyWithLater([...baseline,{time:600000,priceUsd:2}],0,null,600000);
 assert.equal(result.early[0].metrics.lastPriceUsd,1.12);assert.equal(result.laterOutcomes[0].metrics.lastPriceUsd,2);
 assert.equal(result.laterOutcomes[0].finalWindowComplete,true);
});
