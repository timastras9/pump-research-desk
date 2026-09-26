import test from 'node:test';
import assert from 'node:assert/strict';
import {finalNumbersHtml} from '../public/study-charts.js';

const toks=[
 {name:'Holder',metrics:{changePct:264,peakGainPct:400}},
 {name:'Flat',metrics:{changePct:-10,peakGainPct:5}},
 {name:'Dump',metrics:{changePct:-80,peakGainPct:2}},
 {name:'Pending',status:'watching'},
 {name:'Catecoin',excluded:true,exclusionReason:'insider <buy>',metrics:{changePct:900,peakGainPct:5000}},
];
const paper={all:{overall:{trades:51,winRate:18,avgPct:-9.8,medianPct:-12,totalUsd:-9.98}},filtered:{overall:{trades:10,winRate:30,avgPct:2,medianPct:1,totalUsd:0.4}}};

test('final numbers: counts, outcomes, stats and best/worst leave excluded tokens out',()=>{
 const html=finalNumbersHtml(toks,paper);
 assert.match(html,/3 scored/);assert.match(html,/5 recorded · 1 excluded · 1 pending/);
 assert.match(html,/c-winner">1<\/span> · 2 · <span class="c-tanked">1</);
 assert.match(html,/\+58\.0%/,'avg final of 264,-10,-80');assert.match(html,/median -10\.0%/);
 assert.match(html,/\+264\.0%<\/strong><span class="small muted">Holder/);
 assert.match(html,/-80\.0%<\/strong><span class="small muted">Dump/);
 assert.match(html,/\+400\.0%<\/strong><span class="small muted">Holder/,'highest peak ignores excluded Catecoin');
 assert.doesNotMatch(html,/\+5000/);
});

test('final numbers: paper totals and escaped excluded list',()=>{
 const html=finalNumbersHtml(toks,paper);
 assert.match(html,/-\$9\.98/);assert.match(html,/51 trades · 18% won/);assert.match(html,/\+\$0\.40/);
 assert.match(html,/Excluded \(1\): Catecoin \+900\.0% \(insider &lt;buy&gt;\)/);
});

test('final numbers: empty study shows dashes, not zeros',()=>{
 const html=finalNumbersHtml([],null);
 assert.match(html,/0 scored/);assert.match(html,/no trades yet/);assert.match(html,/Excluded \(0\): none/);
 assert.doesNotMatch(html,/0\.0%/);
});
