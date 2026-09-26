import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {paperAt} from '../public/study-charts.js';

const c=0.0325,net=v=>(v*(1-c)/(1+c)-1)*100;
const trade={status:'closed',entryAt:10_000,entryPrice:1,partialAt:20_000,partialPrice:1.3,partialFraction:0.5,exitAt:40_000,exitPrice:1.1,exitReason:'trailing stop',pnlPct:12.34};

test('each frame gets the paper trade value at that moment',()=>{
 assert.equal(paperAt(trade,1,5_000).state,'before');
 const open=paperAt(trade,1.2,15_000);assert.equal(open.state,'open');assert.ok(Math.abs(open.pct-net(1.2))<1e-9);assert.match(open.text,/open \+/);
 const half=paperAt(trade,1.0,25_000);assert.ok(Math.abs(half.pct-net(0.5*1.3+0.5*1.0))<1e-9,'half sold at 1.3 counts');assert.match(half.text,/50% already sold/);
 const closed=paperAt(trade,0.5,45_000);assert.equal(closed.state,'closed');assert.equal(closed.pct,12.34);assert.match(closed.text,/closed \+12\.3% \(trailing stop\)/);
});

test('skipped, missing and still-open trades say so instead of showing a number',()=>{
 assert.match(paperAt({status:'skipped',skipReason:'dead: no trade within 30s'},1,1).text,/skipped \(dead/);
 assert.equal(paperAt(null,1,1).state,'none');
 assert.equal(paperAt({status:'open'},1,1).state,'waiting');
 assert.equal(paperAt({...trade,status:'open',exitAt:undefined},null,50_000).text,'Paper: open, no price at this moment');
 const losing=paperAt({...trade,status:'open',exitAt:undefined,partialAt:undefined},0.8,30_000);assert.ok(losing.pct<0);
});

test('frame viewer and live cards both show the paper value; nothing else removed',()=>{
 const js=readFileSync(new URL('../public/studies.js',import.meta.url),'utf8');
 assert.match(js,/paperAt\(token\.paper,px,frame\.capturedAt/);assert.match(js,/paperAt\(t\.paper,t\.lastPriceUsd/);
 for(const kept of ['Saved screenshots, not encoded video.','Last capture:','Observation time','Review token','Capture failures'])assert.ok(js.includes(kept),`still shows: ${kept}`);
});
