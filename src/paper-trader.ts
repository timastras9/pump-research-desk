// Paper trading from displayed-price observations. Decisions walk the samples in time order, so a
// decision at time t never sees a later price. Fills use the next observed price to model delay.
// v2 (backtest on 100 recorded tokens): flat check at 60s and a -25% stop cut the two losing exits of v1.
export const PAPER_RULES={version:'paper-v2',sizeUsd:2,costPerSide:0.0325,deadAfterMs:30000,noChaseAbovePct:30,
  earlyWindowMs:60000,earlyTakePct:30,checkAtMs:60000,checkMinPct:5,trailArmPct:20,trailPct:30,stopPct:25,maxHoldMs:600000};
export type PaperRules=typeof PAPER_RULES;
export type PaperTrade={version:string;status:'skipped'|'open'|'closed';skipReason?:string;entryAt?:number;entryPrice?:number;
  exitAt?:number;exitPrice?:number;exitReason?:string;highPrice?:number;holdMs?:number;pnlPct?:number;pnlUsd?:number};
type Sample={time:number;priceUsd:number|null};
// Tunable fields and their allowed ranges; anything else stays fixed so costs and sizing cannot be tuned away.
export const TUNABLE={earlyTakePct:[5,200],earlyWindowMs:[10000,180000],checkAtMs:[15000,300000],checkMinPct:[0,50],stopPct:[5,90],trailPct:[5,90],trailArmPct:[0,200]} as const;
export function validRules(input:unknown):PaperRules{
  const r={...PAPER_RULES};if(!input||typeof input!=='object')return r;
  for(const [k,[lo,hi]] of Object.entries(TUNABLE)){const v=(input as Record<string,unknown>)[k];if(v===undefined)continue;if(typeof v!=='number'||!Number.isFinite(v)||v<lo||v>hi)throw Error(`Paper rule ${k} must be between ${lo} and ${hi}.`);(r as Record<string,unknown>)[k]=v;}
  const version=(input as {version?:unknown}).version;if(typeof version==='string'&&/^[a-z0-9.-]{1,40}$/.test(version))r.version=version;
  return r;
}
const pnl=(R:PaperRules,entry:number,exit:number)=>((exit*(1-R.costPerSide))/(entry*(1+R.costPerSide))-1)*100;
function close(R:PaperRules,trade:PaperTrade,entry:{time:number;priceUsd:number},exit:{time:number;priceUsd:number},reason:string,high:number,status:'open'|'closed'='closed'):PaperTrade{
  const pnlPct=pnl(R,entry.priceUsd,exit.priceUsd);
  return {...trade,status,exitAt:exit.time,exitPrice:exit.priceUsd,exitReason:reason,highPrice:high,holdMs:exit.time-entry.time,pnlPct:Number(pnlPct.toFixed(2)),pnlUsd:Number((R.sizeUsd*pnlPct/100).toFixed(4))};
}
// skip: a reason known before trading (e.g. bulk spam launch). stillRecording: leave an unfinished position open.
export function paperTrade(samples:Sample[],opts:{skip?:string|null;stillRecording?:boolean;rules?:PaperRules}={}):PaperTrade{
  const R=opts.rules??PAPER_RULES,base={version:R.version};
  const v=samples.filter((s):s is {time:number;priceUsd:number}=>s.priceUsd!==null&&Number.isFinite(s.priceUsd)&&s.priceUsd>0&&Number.isFinite(s.time)).sort((a,b)=>a.time-b.time);
  if(opts.skip)return {...base,status:'skipped',skipReason:opts.skip};
  if(v.length<2)return {...base,status:opts.stillRecording?'open':'skipped',skipReason:'not enough prices yet'};
  const first=v[0];
  const i=v.findIndex(s=>s.priceUsd!==first.priceUsd);
  if(i<0||v[i].time-first.time>R.deadAfterMs)return opts.stillRecording&&v.at(-1)!.time-first.time<=R.deadAfterMs?{...base,status:'open',skipReason:'waiting for first trade'}:{...base,status:'skipped',skipReason:`dead: no trade within ${R.deadAfterMs/1000}s`};
  if(v[i].priceUsd>=first.priceUsd*(1+R.noChaseAbovePct/100))return {...base,status:'skipped',skipReason:'already pumped: no chase'};
  const e=v[i+1];if(!e)return {...base,status:'open',skipReason:'entry pending'};
  const trade:PaperTrade={...base,status:'open',entryAt:e.time,entryPrice:e.priceUsd};
  let high=e.priceUsd,checked=false;
  const fill=(j:number)=>v[Math.min(j+1,v.length-1)];
  for(let j=i+2;j<v.length;j++){
    const s=v[j],el=s.time-e.time,pct=(s.priceUsd/e.priceUsd-1)*100;high=Math.max(high,s.priceUsd);
    if(pct<=-R.stopPct)return close(R,trade,e,fill(j),`stop -${R.stopPct}%`,high);
    if(el<=R.earlyWindowMs&&pct>=R.earlyTakePct)return close(R,trade,e,fill(j),`early pump: take +${R.earlyTakePct}%`,high);
    if(!checked&&el>=R.checkAtMs){checked=true;if(high<e.priceUsd*(1+R.checkMinPct/100))return close(R,trade,e,fill(j),`${R.checkAtMs/1000}s check: never +${R.checkMinPct}%`,high);}
    if(high>=e.priceUsd*(1+R.trailArmPct/100)&&s.priceUsd<=high*(1-R.trailPct/100))return close(R,trade,e,fill(j),`trailing stop -${R.trailPct}% from high`,high);
    if(el>=R.maxHoldMs)return close(R,trade,e,fill(j),`${R.maxHoldMs/60000}-min time exit`,high);
  }
  return close(R,trade,e,v.at(-1)!,opts.stillRecording?'open (marked to market)':'recording ended',high,opts.stillRecording?'open':'closed');
}
const median=(a:number[])=>{const s=[...a].sort((x,y)=>x-y);return s.length?(s[Math.floor((s.length-1)/2)]+s[Math.floor(s.length/2)])/2:null;};
// Scorecard over many tokens; tags split results by launch traits so we learn which filters help.
export function summarizePaper(rows:{paper?:PaperTrade|null;tags?:Record<string,boolean>}[],rules:PaperRules=PAPER_RULES){
  const trades=rows.filter(r=>r.paper);
  const closed=trades.filter(r=>r.paper!.status==='closed'&&r.paper!.pnlPct!=null);
  const group=(g:typeof closed)=>{const p=g.map(r=>r.paper!.pnlPct!);return {trades:g.length,wins:p.filter(x=>x>0).length,winRate:g.length?Number((p.filter(x=>x>0).length/g.length*100).toFixed(1)):null,avgPct:g.length?Number((p.reduce((a,b)=>a+b,0)/g.length).toFixed(2)):null,medianPct:median(p),totalUsd:Number(g.reduce((a,r)=>a+(r.paper!.pnlUsd??0),0).toFixed(3))};};
  const count=(key:(r:typeof trades[number])=>string|undefined)=>{const m:Record<string,number>={};for(const r of trades){const k=key(r);if(k)m[k]=(m[k]??0)+1;}return m;};
  const byExit:Record<string,ReturnType<typeof group>>={};for(const reason of new Set(closed.map(r=>r.paper!.exitReason!)))byExit[reason]=group(closed.filter(r=>r.paper!.exitReason===reason));
  const tagNames=[...new Set(closed.flatMap(r=>Object.keys(r.tags??{})))].sort();
  const byTag:Record<string,{with:ReturnType<typeof group>;without:ReturnType<typeof group>}>={};
  for(const t of tagNames)byTag[t]={with:group(closed.filter(r=>r.tags?.[t])),without:group(closed.filter(r=>r.tags&&!r.tags[t]))};
  return {rules,tokens:trades.length,skipped:count(r=>r.paper!.status==='skipped'?r.paper!.skipReason:undefined),open:trades.filter(r=>r.paper!.status==='open').length,overall:group(closed),byExit,byTag,
    warning:'Paper results on displayed prices with assumed 1.25% fee + 2% slippage per side and ~0.5s delayed fills. Not executable quotes; thin tokens may not fill at these prices.'};
}
// Compact per-second tape ([seconds from first read, % from first read]) back to samples for replay.
export const tapeSamples=(tape:[number,number][])=>tape.map(([s,p])=>({time:s*1000,priceUsd:1+p/100}));
// Launch filters the tuner may choose between for the filtered strategy.
export const PAPER_FILTERS=['all','feeRouted','mayhem','feeRouted|mayhem','terminal','terminal&feeRouted'] as const;
export type PaperFilter=typeof PAPER_FILTERS[number];
export type LaunchTags={feeRouted:boolean;mayhem:boolean;terminal:boolean};
export function passesFilter(filter:string,tags:LaunchTags){
  if(filter==='all')return true;
  if(filter.includes('|'))return filter.split('|').some(f=>tags[f as keyof LaunchTags]);
  if(filter.includes('&'))return filter.split('&').every(f=>tags[f as keyof LaunchTags]);
  return !!tags[filter as keyof LaunchTags];
}
export type TuneToken={tape:[number,number][];spam:boolean;tags:LaunchTags;test:boolean};
// Candidate values around the current setting (x0.7, x1, x1.4), clamped to the safe ranges.
function around(key:keyof typeof TUNABLE,value:number){const [lo,hi]=TUNABLE[key];const step=key.endsWith('Ms')?5000:1;return [...new Set([0.7,1,1.4].map(f=>Math.min(hi,Math.max(lo,Math.round(value*f/step)*step))))];}
// Walk-forward search: choose rules (and, for the filtered strategy, the launch filter) on earlier studies,
// report the choice on the newest study. 'promote' only when it beats the current setup there too.
export function tunePaper(tokens:TuneToken[],current:PaperRules=PAPER_RULES,currentFilter:string='all',chooseFilter=false){
  const score=(rules:PaperRules,filter:string,test:boolean)=>{const p=tokens.filter(t=>t.test===test).map(t=>paperTrade(tapeSamples(t.tape),{skip:t.spam?'bulk spam launch':passesFilter(filter,t.tags)?null:'filtered out',rules})).filter(x=>x.status==='closed'&&x.pnlPct!=null).map(x=>x.pnlPct!);
    return {trades:p.length,avgPct:p.length?Number((p.reduce((a,b)=>a+b,0)/p.length).toFixed(2)):null,totalUsd:Number(p.reduce((a,x)=>a+rules.sizeUsd*x/100,0).toFixed(3))};};
  const filters=chooseFilter?[...PAPER_FILTERS]:[currentFilter];
  let best:{rules:PaperRules;filter:string;train:ReturnType<typeof score>}|null=null;
  for(const filter of filters)for(const earlyTakePct of around('earlyTakePct',current.earlyTakePct))for(const checkAtMs of around('checkAtMs',current.checkAtMs))for(const stopPct of around('stopPct',current.stopPct))for(const trailPct of around('trailPct',current.trailPct)){
    const rules={...current,earlyTakePct,checkAtMs,stopPct,trailPct,version:`tuned-t${earlyTakePct}-c${checkAtMs/1000}-s${stopPct}-tr${trailPct}`};
    const train=score(rules,filter,false);
    if(train.trades>=10&&(!best||(train.avgPct??-1e9)>(best.train.avgPct??-1e9)))best={rules,filter,train};
  }
  const currentTrain=score(current,currentFilter,false),currentTest=score(current,currentFilter,true);
  const cur={rules:current,filter:currentFilter,train:currentTrain,test:currentTest};
  if(!best)return {status:'insufficient-data',reason:'Fewer than 10 closed training trades.',current:cur};
  const test=score(best.rules,best.filter,true);
  const promote=test.trades>=5&&(test.avgPct??-1e9)>(currentTest.avgPct??-1e9)&&(best.train.avgPct??-1e9)>(currentTrain.avgPct??-1e9)&&(best.rules.version!==current.version||best.filter!==currentFilter);
  return {status:promote?'promote':'keep-current',reason:promote?'Best training choice also beat the current setup on the newest study.':'Best training choice did not beat the current setup on the newest study (or too few test trades).',
    current:cur,suggested:{rules:best.rules,filter:best.filter,train:best.train,test},trainTokens:tokens.filter(t=>!t.test).length,testTokens:tokens.filter(t=>t.test).length,
    warning:'Variants searched around the current rules on earlier studies only. Small samples; a promoted setup is a hypothesis for the next study, not a validated edge.'};
}
// Hindsight label for a finished token: what the trader got wrong (or right), using the full 10-minute record.
// What the price did after the decision (exit, or first sight for a skip), relative to the decision price.
export type AfterDecision={decision:'exit'|'skip';atSec:number;price:number;next60:{maxPct:number;minPct:number;endPct:number};rest:{maxPct:number;minPct:number;endPct:number;maxAtSec:number}};
export type Mistake={label:string;costUsd:number;missedUpsidePct:number|null;after?:AfterDecision};
function afterDecision(v:{time:number;priceUsd:number}[],at:number,price:number,decision:'exit'|'skip'):AfterDecision{
  const origin=v[0].time,pct=(p:number)=>Number(((p/price-1)*100).toFixed(1));
  const next=v.filter(s=>s.time>at&&s.time<=at+60000),rest=v.filter(s=>s.time>at);
  const stats=(g:typeof v)=>g.length?{maxPct:pct(Math.max(...g.map(s=>s.priceUsd))),minPct:pct(Math.min(...g.map(s=>s.priceUsd))),endPct:pct(g.at(-1)!.priceUsd)}:{maxPct:0,minPct:0,endPct:0};
  const peak=rest.reduce((b,s)=>s.priceUsd>b.priceUsd?s:b,rest[0]??{time:at,priceUsd:price});
  return {decision,atSec:Math.round((at-origin)/1000),price,next60:stats(next),rest:{...stats(rest),maxAtSec:Math.round((peak.time-origin)/1000)}};
}
export function classifyTrade(trade:PaperTrade|null|undefined,samples:Sample[],rules:PaperRules=PAPER_RULES):Mistake|null{
  if(!trade)return null;
  const v=samples.filter((s):s is {time:number;priceUsd:number}=>s.priceUsd!==null&&s.priceUsd>0).sort((a,b)=>a.time-b.time);
  if(v.length<2)return null;
  if(trade.status==='skipped'){
    const first=v[0].priceUsd,peak=Math.max(...v.map(s=>s.priceUsd)),end=v.at(-1)!.priceUsd;
    const missed=peak>=first*1.5&&end>first*1.07;
    return {label:missed?'false skip: missed a winner':'correct skip',costUsd:0,missedUpsidePct:missed?Number(((peak/first-1)*100).toFixed(1)):null,after:afterDecision(v,v[0].time,first,'skip')};
  }
  if(trade.status!=='closed'||trade.exitAt==null||trade.exitPrice==null||trade.entryPrice==null)return null;
  const after=v.filter(s=>s.time>trade.exitAt!),maxAfter=after.length?Math.max(...after.map(s=>s.priceUsd)):trade.exitPrice;
  const missedUpsidePct=Number(((maxAfter/trade.exitPrice-1)*100).toFixed(1)),pnl=trade.pnlUsd??0,end=v.at(-1)!.priceUsd;
  const label=pnl<0&&(trade.exitReason?.startsWith('stop')||end<=trade.entryPrice*0.5)?'bought a tanker'
    :missedUpsidePct>=30?'sold too early'
    :trade.exitReason?.startsWith('trailing')&&trade.highPrice&&trade.exitPrice<=trade.highPrice*0.6?'gave back gains'
    :pnl<0&&trade.exitReason?.includes('check')?'held a flat token'
    :pnl>0?'good trade':'small loss';
  return {label,costUsd:Number(pnl.toFixed(4)),missedUpsidePct,after:afterDecision(v,trade.exitAt,trade.exitPrice,'exit')};
}
export function mistakeSummary(rows:{mistake?:Mistake|null}[]){
  const out:Record<string,{count:number;costUsd:number;avgMissedUpsidePct:number|null}>={};
  for(const r of rows){if(!r.mistake)continue;const m=out[r.mistake.label]??={count:0,costUsd:0,avgMissedUpsidePct:null};m.count++;m.costUsd=Number((m.costUsd+r.mistake.costUsd).toFixed(4));
    if(r.mistake.missedUpsidePct!=null)m.avgMissedUpsidePct=Number((((m.avgMissedUpsidePct??0)*(m.count-1)+r.mistake.missedUpsidePct)/m.count).toFixed(1));}
  return out;
}
