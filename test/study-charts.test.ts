import test from 'node:test';
import assert from 'node:assert/strict';
import {exitMetrics,priceSeries,outcomeLabel,COST_PER_SIDE} from '../src/study-analysis';
// @ts-ignore browser module without types
import {overviewHtml,tokenChartHtml,pathChart,watchingHtml} from '../public/study-charts.js';

const s=(pairs:[number,number][])=>pairs.map(([t,p])=>({time:t*1000,priceUsd:p}));

test('exit metrics time the fall from peak and apply costs to the trailing stop',()=>{
 // pump to 2.0 at 10s, -20% by 12s, -50% by 15s
 const e=exitMetrics(s([[0,1],[5,1.5],[10,2],[12,1.6],[15,1],[20,0.5]]));
 assert.equal(e.peakToDrop20Ms,2000);assert.equal(e.peakToDrop50Ms,5000);
 assert.equal(e.trailingStopExitMs,12000);
 assert.equal(e.trailingStopPct,Number(((1.6*(1-COST_PER_SIDE))/(1*(1+COST_PER_SIDE))*100-100).toFixed(2)));
 const flat=exitMetrics(s([[0,1],[5,1]]));assert.equal(flat.peakToDrop20Ms,null);assert.ok(flat.trailingStopPct!<0,'flat round trip still pays costs');
 assert.equal(exitMetrics(s([[0,1]])).trailingStopPct,null);
});

test('price series buckets relative to launch and ignores missing prices',()=>{
 const pts=priceSeries([{time:10_000,priceUsd:1},{time:12_000,priceUsd:null},{time:14_000,priceUsd:1.5},{time:21_000,priceUsd:3}],0);
 assert.deepEqual(pts,[[10,50],[20,200]]);
 assert.deepEqual(priceSeries([],0),[]);
});

test('outcome labels match the winner and tanked thresholds',()=>{
 assert.equal(outcomeLabel(7.1),'winner');assert.equal(outcomeLabel(7),'loser');assert.equal(outcomeLabel(-50),'tanked');assert.equal(outcomeLabel(null),'unscored');
});

test('charts escape token names and group every finished token',()=>{
 const t=(id:string,outcome:string,changePct:number,peakToDrop20Ms:number|null)=>({id,campaignId:'c',name:'<b>'+id,mint:id,outcome,changePct,peakGainPct:50,peakAfterMs:30000,detectionDelayMs:20000,initialCapUsd:3500,firstRise10PctAfterMs:5000,exits:{peakToDrop20Ms,peakToDrop50Ms:null,trailingStopPct:-5},launch:{launchTool:'axiom',mayhem:true},series:[[20,0],[30,50],[40,-60]]});
 const html=overviewHtml([t('w','winner',80,44000),t('l','loser',0,null),t('x','tanked',-90,1700),{...t('u','unscored',0,null),outcome:'unscored'}]);
 assert.ok(!html.includes('<b>w'));assert.match(html,/1 winners · 1 losers · 1 tanked/);assert.match(html,/44\.0s/);assert.match(html,/1\.7s/);
 assert.equal((html.match(/<polyline/g)||[]).length,3);
 assert.match(pathChart([{points:[[0,0],[60,100]],color:'red',title:'<x>'}]),/&lt;x&gt;/);
 assert.match(tokenChartHtml({createdAt:0},[{samples:[{priceReadAt:1000,priceUsd:1}]}]),/Not enough prices/);
 const chart=tokenChartHtml({createdAt:0,exits:{peakToDrop20Ms:2000}},[{samples:[{priceReadAt:1000,priceUsd:1},{priceReadAt:5000,priceUsd:2},{priceReadAt:7000,priceUsd:1.5}]}]);
 assert.equal((chart.match(/<circle/g)||[]).length,4);assert.match(chart,/Peak → −20%: <strong>2\.0s/);
});

test('watching cards show only live tokens with live change, peak and escaped names',()=>{
 const now=1_000_000;
 const live={id:'a',campaignId:'c',name:'<img src=x>',mint:'m',status:'watching',createdAt:now-60000,startedAt:now-50000,endsAt:now+550000,frameCount:90,firstPriceUsd:1,lastPriceUsd:1.25,peakPriceUsd:1.5,peakPriceAt:now-20000,lastFrameAt:now-1000,latestFrame:{key:'k1',capturedAt:now-1000},launch:{launchTool:'axiom',mayhem:false}};
 const html=watchingHtml([live,{...live,id:'b',status:'finished'}],(k:string)=>'/media?key='+k,now);
 assert.equal((html.match(/class="live-token watch/g)||[]).length,1);
 assert.ok(!html.includes('<img src=x>'));assert.match(html,/\+25\.0%/);assert.match(html,/peak \+50\.0% at 40s/);assert.match(html,/9m 10s left/);assert.match(html,/\/media\?key=k1/);assert.match(html,/ up/);
 assert.match(watchingHtml([],()=>null,now),/No tokens are being recorded/);
});
