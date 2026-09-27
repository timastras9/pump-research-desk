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

test('current study table lists live tokens first with live now/peak, falling back to review metrics',async()=>{
 // @ts-ignore browser module without types
 const {tokenTableHtml}=await import('../public/study-charts.js');
 const now=1_000_000;
 const html=tokenTableHtml([
  {id:'f',name:'Finished',status:'finished',metrics:{changePct:-90,peakGainPct:10},frameCount:900},
  {id:'l',name:'Live<b>',status:'watching',startedAt:now-60000,endsAt:now+540000,firstPriceUsd:1,lastPriceUsd:1.3,peakPriceUsd:2,frameCount:120,launch:{launchTool:'axiom',mayhem:true}},
 ],now);
 assert.ok(html.indexOf('Live&lt;b&gt;')<html.indexOf('Finished'),'live token first');
 assert.match(html,/\+30\.0%/);assert.match(html,/\+100\.0%/);assert.match(html,/9m 00s/);assert.match(html,/c-tanked">-90\.0%/);assert.match(html,/axiom · mayhem/);
 assert.match(tokenTableHtml([]),/Waiting for a fresh token/);
});

test('paper tab shows cumulative results, per-study bars, rule changes and an honest trend verdict',async()=>{
 // @ts-ignore browser module without types
 const {improvementHtml,lessonsHtml}=await import('../public/study-charts.js');
 const study=(at:number,version:string,fTotal:number,fAvg:number,aTotal:number,extra:any={})=>({startedAt:at,paperResult:{rules:{version},filter:'feeRouted|mayhem',filtered:{trades:10,winRate:50,avgPct:fAvg,totalUsd:fTotal},all:{trades:20,avgPct:-1,totalUsd:aTotal}},paperMistakes:{filtered:{'bought a tanker':{count:3,costUsd:-1.2},'good trade':{count:5,costUsd:2}}},...extra});
 const html=improvementHtml([study(3000,'tuned-x',2,10,-0.2),study(1000,'paper-v2',1,5,-0.5,{paperAutoApplied:{to:{rules:'tuned-x',filter:'feeRouted'}}}),{startedAt:2000,paperResult:null}]);
 assert.match(html,/\+\$3\.00/);assert.match(html,/Improving: latest study \+10\.0% per trade vs \+5\.0% before/);
 assert.equal((html.match(/<rect /g)||[]).length,2);assert.equal((html.match(/class="rule-change"/g)||[]).length,2,'one rule change marked on each chart');
 assert.match(html,/bought a tanker \(3\)/);assert.match(html,/auto-applied next/);
 assert.match(improvementHtml([]),/No finished studies/);
 const lessons=lessonsHtml({startedAt:1,paperLessons:{cases:[{}],lessons:{patterns:[{mistake:'<b>x',cases:2,knownSignal:'mayhem',afterData:'+900%'}],ruleChanges:[{field:'earlyTakePct',to:'60',why:'left upside'}],caveat:'test'}}});
 assert.ok(!lessons.includes('<b>x'));assert.match(lessons,/earlyTakePct → 60/);
});

test('trade table sums winners and losers separately and filters by strategy and outcome',async()=>{
 // @ts-ignore browser module without types
 const {tradesHtml}=await import('../public/study-charts.js');
 const tok=(name:string,pnlPct:number,pnlUsd:number,filtered=true)=>({name,studyStartedAt:1,tags:{feeRouted:true,mayhem:false,terminal:true},paper:{status:'closed',pnlPct,pnlUsd,holdMs:65000,exitReason:'x'},paperFiltered:filtered?{status:'closed',pnlPct,pnlUsd,holdMs:65000,exitReason:'early pump: take +30%'}:{status:'skipped'},filteredMistake:{label:'sold too early',after:{rest:{maxPct:120,endPct:40}}}});
 const toks=[tok('Winner<b>',30,0.6),tok('Loser',-20,-0.4),tok('AllOnly',10,0.2,false)];
 const html=tradesHtml(toks,'filtered','all');
 assert.match(html,/Winning trades<\/span><strong class="c-winner">\+\$0\.60/);assert.match(html,/-\$0\.40/);assert.match(html,/2 trades · 50% won/);
 assert.ok(!html.includes('Winner<b>'));assert.ok(!html.includes('AllOnly'),'filtered view excludes tokens it skipped');assert.match(html,/1:05/);assert.match(html,/high \+120\.0%/);
 assert.ok(!tradesHtml(toks,'filtered','winners').includes('>Loser<'));assert.match(tradesHtml(toks,'all','all'),/AllOnly/);
});
