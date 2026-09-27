import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {activeHtml,queueHtml,runsHtml,runDetailHtml} from '../public/model-view.js';

const now=1_800_000_000_000;
const summary={tokens:3,evaluated:3,model:{trades:1,avgPct:12.3,medianPct:12.3,winRate:1,shareWorseThan30:0,totalUsd:0.25},rulesV3:{trades:3,avgPct:-5,totalUsd:-0.3},labels:{bought_opportunity:1,premature_exit:1},
 timing:{exitVsBestSec:{n:1,mean:-20,median:-20},exitVsPeakSec:{n:1,mean:-18,median:-18},missVsPeakPts:{n:1,mean:40,median:40},missVsBestPts:{n:1,mean:30,median:30},crashPredictedVsActualSec:{n:1,mean:-3,median:-3}}};
const row={mint:'MintAAAA',name:'<b>Frog</b>',bought:true,decisionT:8,entryT:10,buyProb:0.8,entryCrashProb:0.2,trade:{fills:[[30,32,1,1.2]],reasons:['dropped 10% from high'],netPct:12.3,exitGrossPct:20,exitDecisionSec:30,exitFillSec:32},shadow:null,
 actual:{peakPct:60,peakSec:50,best:{decisionSec:48,fillSec:50,grossPct:60,netPct:50},winner:true,crashStartSec:55,after60:{maxPct:60,minPct:5}},
 predictedVsActual:{exitVsBestSec:-18,exitVsPeakSec:-18,missVsPeakPts:40,missVsBestPts:40,crashPredictedSec:52,crashPredictedVsActualSec:-3},
 feedback:{buyLabel:'bought_opportunity',sellLabels:['premature_exit'],loserReason:null},rulesV3:{netPct:-4,fills:[]}};

test('active model card shows the model, a picker and rollback history; empty state asks to publish',()=>{
 const s={active:{key:'models/v3.json',name:'train-v3',sha:'e004e3cf8cdea727',by:'Tim',activatedAt:now},history:[{key:'models/v2.json',name:'train-v2',sha:'aaaa1111',by:'Tim',activatedAt:now-1},{key:'models/v3.json',name:'train-v3',sha:'e004e3cf8cdea727',by:'Tim',activatedAt:now}],models:[{key:'models/v3.json'},{key:'models/v2.json'}]};
 const h=activeHtml(s);assert.match(h,/train-v3/);assert.match(h,/e004e3cf/);assert.match(h,/data-activate="models\/v2.json"/);assert.match(h,/<option value="models\/v3.json" selected>/);
 assert.match(activeHtml({history:[],models:[]}),/No active model yet/);
});

test('queue form lists finished studies and needs an active model',()=>{
 const s={active:{name:'m'},campaigns:[{id:'c1',startedAt:now,status:'finished',tokens:40},{id:'c2',startedAt:now,status:'running',tokens:5}],jobs:[{campaignId:'c1abcdefgh',model:{name:'m'},done:3,total:40,dueAt:0,errors:['X: candles unavailable']}]};
 const h=queueHtml(s);assert.match(h,/value="c1"/);assert.doesNotMatch(h,/value="c2"/);assert.match(h,/3\/40/);assert.match(h,/candles unavailable/);
 assert.match(queueHtml({...s,active:null}),/disabled/);
});

test('runs table compares the model with rules v3 and shows Astra status',()=>{
 const h=runsHtml([{campaignId:'c1',modelSha:'e004e3cf',createdAt:now,summary,review:{actualUsd:0.31,error:null}}]);
 assert.match(h,/\+12\.3%/);assert.match(h,/-5\.0%/);assert.match(h,/reviewed \$0\.31/);assert.match(h,/data-run="c1\|e004e3cf"/);
 assert.match(runsHtml([]),/No model runs yet/);
});

test('run detail: peak, best exit, timing differences, crash warning, labels, Astra, escaped names',()=>{
 const review={rowsSent:3,rowsTotal:3,actualUsd:0.3,review:{summary:'Sold too early on climbers.',problems:[{issue:'early exits',impact:'-40 pts',evidence:['Frog']}],adjustments:[{parameter:'ride trail',current:'10%',suggested:'15%',why:'x',expectedEffect:'y',confidence:'medium'}],retrainNotes:['add peak rows']}};
 const h=runDetailHtml({run:{campaignId:'c1',model:{name:'train-v3',sha:'e004'},summary,rows:[row]},review});
 assert.match(h,/&lt;b&gt;Frog&lt;\/b&gt;/);assert.doesNotMatch(h,/<b>Frog/);
 assert.match(h,/\+60\.0% @ \+40 s/,'peak 60% at 40 s after entry');assert.match(h,/\+60\.0% @ \+38 s/,'best exit decided 38 s after entry');
 assert.match(h,/-18 s/);assert.match(h,/40\.0 pts/);assert.match(h,/\+42 s \/ \+45 s/,'crash warning / actual start');
 assert.match(h,/premature exit/);assert.match(h,/Sold too early on climbers/);assert.match(h,/ride trail/);assert.match(h,/download=1/);
 assert.match(runDetailHtml({run:{campaignId:'c1',model:{name:'m',sha:'e'},summary,rows:[row]},review:{error:'over the $1 cap'}}),/over the \$1 cap/);
});

test('Model tab is linked from Studies and Paper trading',()=>{
 for(const p of ['studies','paper'])assert.match(readFileSync(new URL(`../public/${p}.html`,import.meta.url),'utf8'),/href="\/model.html"/);
});
