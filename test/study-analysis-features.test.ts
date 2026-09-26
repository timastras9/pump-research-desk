import test from 'node:test';
import assert from 'node:assert/strict';
import {compactAggregateInput,compactStudyInput,summarizeSamples} from '../src/study-analysis';
const metrics=summarizeSamples([{time:0,priceUsd:1},{time:600000,priceUsd:2}],0,null,{capturedMs:300000,elapsedMs:600000});
const earlyWindows=[{seconds:60,complete:true,quality:'sampled',metrics:{changePct:5}},{seconds:120,complete:true,quality:'sparse',metrics:{changePct:10}}];
const laterOutcomes=[{afterSeconds:60,changeFromEarlyLastPct:90,finalWindowComplete:true},{afterSeconds:120,changeFromEarlyLastPct:80,finalWindowComplete:true}];
test('collective table preserves matched early and later features and exclusions',()=>{
 const r=compactAggregateInput([{id:'one',metrics,earlyWindows,laterOutcomes,excluded:true,candidate:{marketCapUsd:5000,traders:7,transactions:8}}]);
 assert.deepEqual(r.table[0].slice(1,11),[5000,7,8,5,1,10,2,90,80,100]);assert.equal(r.table[0][12],true);
});
test('100 rows with extreme numerics and long IDs remain within24k',()=>{
 const r=compactAggregateInput(Array.from({length:100},(_,i)=>({id:'x'.repeat(400)+i,metrics:{...metrics,changePct:1e300,coverageRatio:1e-300},earlyWindows:earlyWindows.map(w=>({...w,metrics:{changePct:1e300}})),laterOutcomes:laterOutcomes.map(w=>({...w,changeFromEarlyLastPct:-1e300})),excluded:true,exclusionReason:'x'.repeat(500),candidate:{marketCapUsd:1e300,traders:1e300,transactions:1e300}})));
 assert.equal(r.tableCount,100);assert.ok(JSON.stringify(r).length<24000,String(JSON.stringify(r).length));
});
test('interim token input omits later outcomes; final includes separately',()=>{
 const input={id:'one',mint:'mint',metrics,coverage:{},earlyWindows,laterOutcomes};
 assert.equal(compactStudyInput({...input,phase:'interim'}).laterOutcomes,undefined);
 assert.equal(compactStudyInput({...input,phase:'final'}).laterOutcomes?.length,2);
});
