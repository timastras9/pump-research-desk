// Paper trading from displayed-price observations. Decisions walk the samples in time order, so a
// decision at time t never sees a later price. Fills use the next observed price to model delay.
// v2 (backtest on 100 recorded tokens): flat check at 60s and a -25% stop cut the two losing exits of v1.
export const PAPER_RULES={version:'paper-v2',sizeUsd:2,costPerSide:0.0325,deadAfterMs:30000,noChaseAbovePct:30,
  earlyWindowMs:60000,earlyTakePct:30,checkAtMs:60000,checkMinPct:5,trailArmPct:20,trailPct:30,stopPct:25,maxHoldMs:600000};
export type PaperTrade={version:string;status:'skipped'|'open'|'closed';skipReason?:string;entryAt?:number;entryPrice?:number;
  exitAt?:number;exitPrice?:number;exitReason?:string;highPrice?:number;holdMs?:number;pnlPct?:number;pnlUsd?:number};
type Sample={time:number;priceUsd:number|null};
const R=PAPER_RULES;
const pnl=(entry:number,exit:number)=>((exit*(1-R.costPerSide))/(entry*(1+R.costPerSide))-1)*100;
function close(trade:PaperTrade,entry:{time:number;priceUsd:number},exit:{time:number;priceUsd:number},reason:string,high:number,status:'open'|'closed'='closed'):PaperTrade{
  const pnlPct=pnl(entry.priceUsd,exit.priceUsd);
  return {...trade,status,exitAt:exit.time,exitPrice:exit.priceUsd,exitReason:reason,highPrice:high,holdMs:exit.time-entry.time,pnlPct:Number(pnlPct.toFixed(2)),pnlUsd:Number((R.sizeUsd*pnlPct/100).toFixed(4))};
}
// skip: a reason known before trading (e.g. bulk spam launch). stillRecording: leave an unfinished position open.
export function paperTrade(samples:Sample[],opts:{skip?:string|null;stillRecording?:boolean}={}):PaperTrade{
  const base={version:R.version};
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
  for(let j=v.indexOf(e)+1;j<v.length;j++){
    const s=v[j],el=s.time-e.time,pct=(s.priceUsd/e.priceUsd-1)*100;high=Math.max(high,s.priceUsd);
    if(pct<=-R.stopPct)return close(trade,e,fill(j),`stop -${R.stopPct}%`,high);
    if(el<=R.earlyWindowMs&&pct>=R.earlyTakePct)return close(trade,e,fill(j),`early pump: take +${R.earlyTakePct}%`,high);
    if(!checked&&el>=R.checkAtMs){checked=true;if(high<e.priceUsd*(1+R.checkMinPct/100))return close(trade,e,fill(j),`${R.checkAtMs/1000}s check: never +${R.checkMinPct}%`,high);}
    if(high>=e.priceUsd*(1+R.trailArmPct/100)&&s.priceUsd<=high*(1-R.trailPct/100))return close(trade,e,fill(j),`trailing stop -${R.trailPct}% from high`,high);
    if(el>=R.maxHoldMs)return close(trade,e,fill(j),`${R.maxHoldMs/60000}-min time exit`,high);
  }
  return close(trade,e,v.at(-1)!,opts.stillRecording?'open (marked to market)':'recording ended',high,opts.stillRecording?'open':'closed');
}
const median=(a:number[])=>{const s=[...a].sort((x,y)=>x-y);return s.length?(s[Math.floor((s.length-1)/2)]+s[Math.floor(s.length/2)])/2:null;};
// Scorecard over many tokens; tags split results by launch traits so we learn which filters help.
export function summarizePaper(rows:{paper?:PaperTrade|null;tags?:Record<string,boolean>}[]){
  const trades=rows.filter(r=>r.paper);
  const closed=trades.filter(r=>r.paper!.status==='closed'&&r.paper!.pnlPct!=null);
  const group=(g:typeof closed)=>{const p=g.map(r=>r.paper!.pnlPct!);return {trades:g.length,wins:p.filter(x=>x>0).length,winRate:g.length?Number((p.filter(x=>x>0).length/g.length*100).toFixed(1)):null,avgPct:g.length?Number((p.reduce((a,b)=>a+b,0)/g.length).toFixed(2)):null,medianPct:median(p),totalUsd:Number(g.reduce((a,r)=>a+(r.paper!.pnlUsd??0),0).toFixed(3))};};
  const count=(key:(r:typeof trades[number])=>string|undefined)=>{const m:Record<string,number>={};for(const r of trades){const k=key(r);if(k)m[k]=(m[k]??0)+1;}return m;};
  const byExit:Record<string,ReturnType<typeof group>>={};for(const reason of new Set(closed.map(r=>r.paper!.exitReason!)))byExit[reason]=group(closed.filter(r=>r.paper!.exitReason===reason));
  const tagNames=[...new Set(closed.flatMap(r=>Object.keys(r.tags??{})))].sort();
  const byTag:Record<string,{with:ReturnType<typeof group>;without:ReturnType<typeof group>}>={};
  for(const t of tagNames)byTag[t]={with:group(closed.filter(r=>r.tags?.[t])),without:group(closed.filter(r=>r.tags&&!r.tags[t]))};
  return {rules:PAPER_RULES,tokens:trades.length,skipped:count(r=>r.paper!.status==='skipped'?r.paper!.skipReason:undefined),open:trades.filter(r=>r.paper!.status==='open').length,overall:group(closed),byExit,byTag,
    warning:'Paper results on displayed prices with assumed 1.25% fee + 2% slippage per side and ~0.5s delayed fills. Not executable quotes; thin tokens may not fill at these prices.'};
}
