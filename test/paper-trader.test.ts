import test from 'node:test';
import assert from 'node:assert/strict';
import {paperTrade,summarizePaper,PAPER_RULES,validRules,tunePaper,tapeSamples,classifyTrade,mistakeSummary,passesFilter,type TuneToken} from '../src/paper-trader';

// [seconds, price] pairs; a trade starts when the price first changes, filled at the next reading.
const s=(pairs:[number,number][])=>pairs.map(([t,p])=>({time:t*1000,priceUsd:p}));
const FULL={...PAPER_RULES,partialTakeFraction:1};   // v2 behaviour: sell everything on the early pump
const cost=(entry:number,exit:number)=>Number((((exit*(1-PAPER_RULES.costPerSide))/(entry*(1+PAPER_RULES.costPerSide))-1)*100).toFixed(2));

test('skips dead tokens, bulk spam and tokens that already pumped before trading',()=>{
 assert.equal(paperTrade(s([[0,1],[10,1],[40,1.1],[41,1.2]])).skipReason,'dead: no trade within 30s');
 assert.equal(paperTrade(s([[0,1],[5,1.4],[6,1.5]])).skipReason,'already pumped: no chase');
 assert.equal(paperTrade(s([[0,1],[5,1.1]]),{skip:'bulk spam launch'}).skipReason,'bulk spam launch');
 assert.equal(paperTrade(s([[0,1],[10,1]]),{stillRecording:true}).status,'open','still inside the 30s window');
});
test('takes an early pump and pays costs on both sides',()=>{
 const t=paperTrade(s([[0,1],[5,1.02],[6,1.05],[20,1.4],[21,1.38]]),{rules:FULL});
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

test('rules can be tuned only within safe ranges; costs and size stay fixed',()=>{
 const r=validRules({stopPct:15,checkAtMs:45000,costPerSide:0,sizeUsd:100,version:'tuned-x'});
 assert.equal(r.stopPct,15);assert.equal(r.checkAtMs,45000);assert.equal(r.costPerSide,PAPER_RULES.costPerSide);assert.equal(r.sizeUsd,PAPER_RULES.sizeUsd);assert.equal(r.version,'tuned-x');
 assert.throws(()=>validRules({stopPct:0}),/stopPct/);assert.throws(()=>validRules({trailPct:'30'}),/trailPct/);
 assert.equal(paperTrade(s([[0,1],[5,1.01],[6,1.0],[10,0.84],[11,0.83]]),{rules:validRules({stopPct:15})}).exitReason,'stop -15%');
});
test('tuner searches around the current rules, can choose a launch filter, and only promotes on unseen wins',()=>{
 // tape: [seconds, % from first read]; fee-routed tokens pump then fade, others crash
 const pumpFade:[number,number][]=[[0,0],[2,1],[3,0],[10,22],[11,24],[40,-40],[41,-45]];
 const crash:[number,number][]=[[0,0],[2,1],[3,0],[8,-30],[9,-35]];
 const tags=(feeRouted:boolean)=>({feeRouted,mayhem:false,terminal:true});
 const make=(tape:[number,number][],test:boolean,fee:boolean,spam=false):TuneToken=>({tape,spam,tags:tags(fee),test});
 const tokens:TuneToken[]=[...Array.from({length:12},()=>make(pumpFade,false,true)),...Array.from({length:10},()=>make(crash,false,false)),...Array.from({length:6},()=>make(pumpFade,true,true)),...Array.from({length:5},()=>make(crash,true,false)),make(crash,true,true,true)];
 const exitsOnly=tunePaper(tokens,FULL,'all',false) as any;
 assert.ok([21,30,42].includes(exitsOnly.suggested.rules.earlyTakePct),'candidates are x0.7/x1/x1.4 around the current 30%');
 const withFilter=tunePaper(tokens,FULL,'all',true) as any;
 assert.equal(withFilter.suggested.filter,'feeRouted');assert.equal(withFilter.status,'promote');assert.ok(withFilter.suggested.test.avgPct>withFilter.current.test.avgPct);
 assert.equal(withFilter.suggested.rules.costPerSide,PAPER_RULES.costPerSide);
 assert.equal((tunePaper(tokens.slice(0,3)) as any).status,'insufficient-data');
 assert.deepEqual(tapeSamples([[2,50]]),[{time:2000,priceUsd:1.5}]);
 assert.equal(passesFilter('feeRouted|mayhem',{feeRouted:false,mayhem:true,terminal:false}),true);assert.equal(passesFilter('terminal&feeRouted',{feeRouted:false,mayhem:true,terminal:true}),false);
});
test('hindsight labels name what went wrong and what it cost',()=>{
 const tanker=s([[0,1],[5,1.01],[6,1.0],[10,0.74],[11,0.6],[300,0.3]]);
 assert.equal(classifyTrade(paperTrade(tanker,{rules:FULL}),tanker)!.label,'bought a tanker');
 const runAway=s([[0,1],[5,1.02],[6,1.05],[20,1.4],[21,1.38],[200,2.5]]);
 const early=classifyTrade(paperTrade(runAway,{rules:FULL}),runAway)!;assert.equal(early.label,'sold too early');assert.ok(early.missedUpsidePct!>=30);
 assert.equal(early.after!.decision,'exit');assert.ok(early.after!.rest.maxPct>=78);assert.equal(early.after!.rest.maxAtSec,200);
 const flat=s([[0,1],[5,1.01],[6,1.02],[30,1.03],[67,1.0],[68,0.99],[300,0.99]]);
 assert.equal(classifyTrade(paperTrade(flat),flat)!.label,'held a flat token');
 const missed=s([[0,1],[40,1],[200,2],[590,1.6]]);
 assert.equal(classifyTrade(paperTrade(missed),missed)!.label,'false skip: missed a winner');
 const sum=mistakeSummary([{mistake:classifyTrade(paperTrade(tanker),tanker)},{mistake:classifyTrade(paperTrade(flat),flat)},{mistake:null}]);
 assert.equal(sum['bought a tanker'].count,1);assert.ok(sum['bought a tanker'].costUsd<0);assert.equal(sum['held a flat token'].count,1);
});

test('sell-half rule: takes part of the position on the early pump and lets the rest run',()=>{
 // pump to +40% at 20s (sell half at the next reading), run to 2.0, trail out at 1.39 -> 1.35
 const path=s([[0,1],[5,1.02],[6,1.05],[20,1.47],[21,1.45],[200,2.1],[400,1.47],[401,1.4]]);
 const t=paperTrade(path);
 assert.equal(t.partialFraction,0.5);assert.equal(t.partialPrice,1.45);assert.equal(t.exitPrice,1.4);
 assert.match(t.exitReason!,/^sold 50% at \+30%, rest: trailing stop -30% from high/);
 const expect=0.5*cost(1.05,1.45)+0.5*cost(1.05,1.4);assert.ok(Math.abs(t.pnlPct!-expect)<0.02);
 // a pump that fades: the ridden half stops out, the blended result still beats holding everything
 const fade=s([[0,1],[5,1.02],[6,1.0],[15,1.35],[16,1.34],[30,0.74],[31,0.7]]);
 const f=paperTrade(fade);assert.match(f.exitReason!,/rest: stop -25%/);assert.ok(f.pnlPct!>cost(1.0,0.7));
 assert.equal(paperTrade(fade,{rules:FULL}).exitReason,'early pump: take +30%');
});

test('ladder option: half at the first take, the rest at the second take',()=>{
 const path=s([[0,1],[5,1.02],[6,1.05],[20,1.4],[21,1.39],[90,1.6],[91,1.62],[300,1.1]]);
 const t=paperTrade(path,{rules:{...PAPER_RULES,partialTakeFraction:0.5,secondTakePct:50}});
 assert.match(t.exitReason!,/^sold 50% at \+30%, rest: second take \+50%/);assert.equal(t.partialPrice,1.39);assert.equal(t.exitPrice,1.62);
 assert.equal(PAPER_RULES.secondTakePct,0,'ladder is off by default');
});
