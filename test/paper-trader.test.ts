import test from 'node:test';
import assert from 'node:assert/strict';
import {paperTrade,summarizePaper,PAPER_RULES} from '../src/paper-trader';

// [seconds, price] pairs; a trade starts when the price first changes, filled at the next reading.
const s=(pairs:[number,number][])=>pairs.map(([t,p])=>({time:t*1000,priceUsd:p}));
const cost=(entry:number,exit:number)=>Number((((exit*(1-PAPER_RULES.costPerSide))/(entry*(1+PAPER_RULES.costPerSide))-1)*100).toFixed(2));

test('skips dead tokens, bulk spam and tokens that already pumped before trading',()=>{
 assert.equal(paperTrade(s([[0,1],[10,1],[40,1.1],[41,1.2]])).skipReason,'dead: no trade within 30s');
 assert.equal(paperTrade(s([[0,1],[5,1.4],[6,1.5]])).skipReason,'already pumped: no chase');
 assert.equal(paperTrade(s([[0,1],[5,1.1]]),{skip:'bulk spam launch'}).skipReason,'bulk spam launch');
 assert.equal(paperTrade(s([[0,1],[10,1]]),{stillRecording:true}).status,'open','still inside the 30s window');
});
test('takes an early pump and pays costs on both sides',()=>{
 const t=paperTrade(s([[0,1],[5,1.02],[6,1.05],[20,1.4],[21,1.38]]));
 assert.equal(t.exitReason,'early pump: take +30%');assert.equal(t.entryPrice,1.05);assert.equal(t.exitPrice,1.38);assert.equal(t.pnlPct,cost(1.05,1.38));
 assert.ok(Math.abs(t.pnlUsd!-PAPER_RULES.sizeUsd*t.pnlPct!/100)<0.001,'dollar P&L matches the percentage on a $2 position');
});
test('sells a token that never reaches +5% by the check, and stops out a crash',()=>{
 assert.equal(paperTrade(s([[0,1],[5,1.01],[6,1.02],[30,1.03],[67,1.0],[68,0.99]])).exitReason,'60s check: never +5%');
 const crash=paperTrade(s([[0,1],[5,1.01],[6,1.0],[10,0.74],[11,0.6]]));
 assert.equal(crash.exitReason,'stop -25%');assert.equal(crash.exitPrice,0.6,'fills at the next reading, past the stop');
});
test('rides a late run with a trailing stop and leaves unfinished trades open',()=>{
 const run=paperTrade(s([[0,1],[5,1.01],[6,1.0],[50,1.06],[100,1.3],[300,2.0],[400,1.39],[401,1.35]]));
 assert.equal(run.exitReason,'trailing stop -30% from high');assert.equal(run.highPrice,2);assert.equal(run.exitPrice,1.35);
 const open=paperTrade(s([[0,1],[5,1.01],[6,1.0],[50,1.1],[90,1.2]]),{stillRecording:true});
 assert.equal(open.status,'open');assert.equal(open.exitReason,'open (marked to market)');
});
test('scorecard separates closed, open and skipped trades and splits by launch trait',()=>{
 const sum=summarizePaper([
  {paper:paperTrade(s([[0,1],[5,1.02],[6,1.05],[20,1.4],[21,1.38]])),tags:{feeRouted:true}},
  {paper:paperTrade(s([[0,1],[5,1.01],[6,1.0],[10,0.74],[11,0.6]])),tags:{feeRouted:false}},
  {paper:paperTrade(s([[0,1],[40,1]])),tags:{feeRouted:false}},
  {paper:paperTrade(s([[0,1],[5,1.01],[6,1.0],[50,1.1]]),{stillRecording:true}),tags:{feeRouted:true}},
 ]);
 assert.equal(sum.overall.trades,2);assert.equal(sum.overall.wins,1);assert.equal(sum.open,1);assert.equal(sum.skipped['dead: no trade within 30s'],1);
 assert.equal(sum.byTag.feeRouted.with.trades,1);assert.equal(sum.byTag.feeRouted.without.trades,1);
});
