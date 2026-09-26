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
export type TuneToken={tape:[number,number][];skip:string|null;test:boolean};
// Walk-forward rule search: choose the best variant on earlier studies (train), report it on the newest (test).
// A suggestion is only 'promote' when it beats the current rules on the test study too.
export function tunePaper(tokens:TuneToken[],current:PaperRules=PAPER_RULES){
  const score=(rules:PaperRules,test:boolean)=>{const p=tokens.filter(t=>t.test===test).map(t=>paperTrade(tapeSamples(t.tape),{skip:t.skip,rules})).filter(x=>x.status==='closed'&&x.pnlPct!=null).map(x=>x.pnlPct!);return {trades:p.length,avgPct:p.length?Number((p.reduce((a,b)=>a+b,0)/p.length).toFixed(2)):null,totalUsd:Number(p.reduce((a,x)=>a+rules.sizeUsd*x/100,0).toFixed(3))};};
  let best:{rules:PaperRules;train:ReturnType<typeof score>}|null=null;
  for(const earlyTakePct of [20,30,50])for(const checkAtMs of [45000,60000,90000])for(const stopPct of [15,25,35])for(const trailPct of [20,30,40]){
    const rules={...current,earlyTakePct,checkAtMs,stopPct,trailPct,version:`tuned-t${earlyTakePct}-c${checkAtMs/1000}-s${stopPct}-tr${trailPct}`};
    const train=score(rules,false);
    if(train.trades>=10&&(!best||(train.avgPct??-1e9)>(best.train.avgPct??-1e9)))best={rules,train};
  }
  const currentTrain=score(current,false),currentTest=score(current,true);
  if(!best)return {status:'insufficient-data',reason:'Fewer than 10 closed training trades.',current:{rules:current,train:currentTrain,test:currentTest}};
  const test=score(best.rules,true);
  const promote=test.trades>=5&&(test.avgPct??-1e9)>(currentTest.avgPct??-1e9)&&(best.train.avgPct??-1e9)>(currentTrain.avgPct??-1e9);
  return {status:promote?'promote':'keep-current',reason:promote?'Best training variant also beat the current rules on the newest study.':'Best training variant did not beat the current rules on the newest study (or too few test trades).',
    current:{rules:current,train:currentTrain,test:currentTest},suggested:{rules:best.rules,train:best.train,test},trainTokens:tokens.filter(t=>!t.test).length,testTokens:tokens.filter(t=>t.test).length,
    warning:'Grid of 81 variants chosen on earlier studies only. Small samples; a promoted rule is a hypothesis for the next study, not a validated edge.'};
}
