// Inline-SVG price paths and cross-study summaries. Pure functions: data in, escaped HTML out.
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=(v,d=0)=>typeof v==='number'&&Number.isFinite(v)?v.toFixed(d):'—';
const sec=ms=>typeof ms==='number'&&Number.isFinite(ms)?(ms/1000).toFixed(1)+'s':'—';
export const OUTCOME_COLORS={winner:'var(--accent)',loser:'#6f8593',tanked:'var(--red)',unscored:'#3a4d59'};
const W=720,H=260,PAD={l:46,r:12,t:12,b:26},X_MAX=660;
const TICKS=[-90,-50,0,100,300,700];
// Ratio axis: +100% and -50% sit the same distance from zero, so pumps and dumps compare fairly.
const yv=pct=>Math.log2(Math.max(0.05,1+pct/100));
const Y_MIN=yv(-95),Y_MAX=yv(800);
const px=s=>PAD.l+Math.min(Math.max(s,0),X_MAX)/X_MAX*(W-PAD.l-PAD.r);
const py=p=>PAD.t+(1-(Math.min(Math.max(yv(p),Y_MIN),Y_MAX)-Y_MIN)/(Y_MAX-Y_MIN))*(H-PAD.t-PAD.b);
// lines: [{points:[[secondsSinceLaunch,pctChange]],color,width?,opacity?,title?}], markers: [{s,pct,label,color}]
export function pathChart(lines,markers=[],label='Price change since first observation'){
 const grid=TICKS.map(t=>`<line x1="${PAD.l}" x2="${W-PAD.r}" y1="${py(t).toFixed(1)}" y2="${py(t).toFixed(1)}" stroke="${t===0?'#4a5d69':'#1f2d36'}"/><text x="${PAD.l-6}" y="${(py(t)+4).toFixed(1)}" text-anchor="end">${t>0?'+':''}${t}%</text>`).join('');
 const xt=[0,60,120,180,300,420,600].map(s=>`<line x1="${px(s).toFixed(1)}" x2="${px(s).toFixed(1)}" y1="${PAD.t}" y2="${H-PAD.b}" stroke="#1a262e"/><text x="${px(s).toFixed(1)}" y="${H-8}" text-anchor="middle">${s/60}m</text>`).join('');
 const paths=lines.filter(l=>l.points?.length>1).map(l=>`<polyline fill="none" stroke="${l.color}" stroke-width="${l.width??1.5}" stroke-opacity="${l.opacity??1}" points="${l.points.map(([s,p])=>`${px(s).toFixed(1)},${py(p).toFixed(1)}`).join(' ')}">${l.title?`<title>${esc(l.title)}</title>`:''}</polyline>`).join('');
 const marks=markers.filter(m=>Number.isFinite(m.s)&&Number.isFinite(m.pct)).map(m=>`<circle cx="${px(m.s).toFixed(1)}" cy="${py(m.pct).toFixed(1)}" r="4" fill="${m.color}"><title>${esc(m.label)}</title></circle>`).join('');
 return `<svg class="path-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${grid}${xt}${paths}${marks}</svg>`;
}
// Token detail: path from raw chunk samples relative to launch, with first sight, first +10%, peak and first -20% from peak.
export function tokenChartHtml(token,chunks){
 const origin=token.createdAt??token.startedAt;
 const s=(chunks||[]).flatMap(c=>c.samples||[]).filter(x=>x.priceUsd>0&&Number.isFinite(x.priceReadAt)).sort((a,b)=>a.priceReadAt-b.priceReadAt);
 if(s.length<2)return '<p class="muted">Not enough prices for a chart yet.</p>';
 const base=s[0].priceUsd,pt=x=>[(x.priceReadAt-origin)/1000,(x.priceUsd/base-1)*100];
 const pts=s.map(pt);let peak=s[0];for(const x of s)if(x.priceUsd>peak.priceUsd)peak=x;
 const rise=s.find(x=>x.priceUsd>=base*1.1),drop=s.find(x=>x.priceReadAt>=peak.priceReadAt&&x.priceUsd<=peak.priceUsd*0.8);
 const markers=[{x:s[0],label:'First observed',color:'#91a4af'},rise&&{x:rise,label:'First +10%',color:'var(--amber)'},{x:peak,label:'Peak',color:'var(--accent)'},drop&&{x:drop,label:`-20% from peak after ${sec(drop.priceReadAt-peak.priceReadAt)}`,color:'var(--red)'}].filter(Boolean).map(m=>{const [a,b]=pt(m.x);return {s:a,pct:b,label:m.label,color:m.color};});
 const e=token.exits||{};
 // Paper trade replay: buy/sell markers and the path after the sale, i.e. the data that decided whether the call was right.
 const useFiltered=token.paper?.status==='skipped'&&token.paperFiltered?.entryAt;const pt2=useFiltered?token.paperFiltered:token.paper,mis=useFiltered?token.paperFilteredMistake:token.paperMistake;
 const at=(ms,price)=>[(ms-origin)/1000,(price/base-1)*100];
 if(pt2?.entryAt){const [a1,b1]=at(pt2.entryAt,pt2.entryPrice);markers.push({s:a1,pct:b1,label:'Paper buy',color:'#6cb4ff'});}
 if(pt2?.exitAt){const [a2,b2]=at(pt2.exitAt,pt2.exitPrice);markers.push({s:a2,pct:b2,label:`Paper sell: ${pt2.exitReason} (${num(pt2.pnlPct,1)}%)`,color:'#c792ea'});}
 const afterPts=pt2?.exitAt?s.filter(x=>x.priceReadAt>=pt2.exitAt).map(pt):[];
 const m=mis?.after,clock=sec=>sec==null?'—':Math.floor(sec/60)+':'+String(Math.round(sec%60)).padStart(2,'0');
 const afterText=m?`<p class="chart-legend"><strong>${esc(mis.label)}</strong> · after we ${m.decision==='skip'?'skipped':'sold'} at ${clock(m.atSec)}: next 60 s high ${m.next60.maxPct>0?'+':''}${num(m.next60.maxPct,1)}% / low ${num(m.next60.minPct,1)}% · rest of window high ${m.rest.maxPct>0?'+':''}${num(m.rest.maxPct,1)}% at ${clock(m.rest.maxAtSec)}, ended ${m.rest.endPct>0?'+':''}${num(m.rest.endPct,1)}%${useFiltered?' (filtered strategy)':''}</p>`:'';
 return pathChart([{points:pts,color:OUTCOME_COLORS.winner,width:2},...(afterPts.length>1?[{points:afterPts,color:'var(--amber)',width:2.5,title:'after the paper sale'}]:[])],markers,'Token price path')+afterText+`<p class="chart-legend"><span class="c-muted">●</span> first seen <span class="c-amber">●</span> first +10% <span class="c-winner">●</span> peak <span class="c-tanked">●</span> −20% from peak <span class="c-buy">●</span> paper buy <span class="c-sell">●</span> paper sell <span class="c-amber">━</span> after the sale · Peak → −20%: <strong>${sec(e.peakToDrop20Ms)}</strong> · Peak → −50%: <strong>${sec(e.peakToDrop50Ms)}</strong> · 20% trailing stop after costs: <strong>${num(e.trailingStopPct,1)}%</strong></p>`;
}
const median=v=>{const a=v.filter(x=>typeof x==='number'&&Number.isFinite(x)).sort((x,y)=>x-y);return a.length?(a[Math.floor((a.length-1)/2)]+a[Math.floor(a.length/2)])/2:null;};
const GROUP_METRICS=[['Tokens',g=>g.length,v=>v],['Median detection delay',g=>median(g.map(t=>t.detectionDelayMs)),sec],['Median cap when first seen',g=>median(g.map(t=>t.initialCapUsd)),v=>v==null?'—':'$'+num(v)],
 ['Median time to first +10%',g=>median(g.map(t=>t.firstRise10PctAfterMs)),sec],['Median peak gain',g=>median(g.map(t=>t.peakGainPct)),v=>num(v)+'%'],['Median time to peak',g=>median(g.map(t=>t.peakAfterMs)),sec],
 ['Median peak → −20%',g=>median(g.map(t=>t.exits?.peakToDrop20Ms)),sec],['Median peak → −50%',g=>median(g.map(t=>t.exits?.peakToDrop50Ms)),sec],['Fell −50% from peak',g=>g.filter(t=>t.exits?.peakToDrop50Ms!=null).length+'/'+g.length,v=>v],
 ['Median 20% trailing stop (after costs)',g=>median(g.map(t=>t.exits?.trailingStopPct)),v=>num(v,1)+'%'],['Median final change',g=>median(g.map(t=>t.changePct)),v=>num(v,1)+'%']];
export function overviewHtml(tokens){
 const scored=tokens.filter(t=>!t.excluded&&t.outcome!=='unscored');
 if(!scored.length)return '<p>No finished tokens yet.</p>';
 const groups={winner:scored.filter(t=>t.outcome==='winner'),loser:scored.filter(t=>t.outcome==='loser'),tanked:scored.filter(t=>t.outcome==='tanked')};
 const summary=`<div class="table-scroll"><table><thead><tr><th>Metric</th><th class="c-winner">Winners (&gt;+7%)</th><th>Losers</th><th class="c-tanked">Tanked (≤−50%)</th></tr></thead><tbody>${GROUP_METRICS.map(([name,f,fmt])=>`<tr><td>${name}</td>${Object.values(groups).map(g=>`<td>${esc(fmt(f(g)))}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
 // Draw losers first so winners and tanked tokens stay visible on top.
 const order={unscored:0,loser:1,tanked:2,winner:3};
 const lines=[...scored].sort((a,b)=>order[a.outcome]-order[b.outcome]).map(t=>({points:t.series,color:OUTCOME_COLORS[t.outcome],width:t.outcome==='loser'?1:1.6,opacity:t.outcome==='loser'?0.45:0.9,title:`${t.name} · ${num(t.changePct,1)}%`}));
 const chart=pathChart(lines,[],'All tokens price paths')+`<p class="chart-legend"><span class="c-winner">━</span> winners <span class="c-loser">━</span> losers <span class="c-tanked">━</span> tanked · time since launch · ratio scale</p>`;
 const rows=[...scored].sort((a,b)=>(b.changePct??-1e9)-(a.changePct??-1e9)).map(t=>`<tr><td><button class="link" data-token="${esc(t.id)}" data-campaign="${esc(t.campaignId)}">${esc(t.name||t.mint?.slice(0,10))}</button></td><td class="c-${esc(t.outcome)}">${esc(t.outcome)}</td><td>${t.initialCapUsd==null?'—':'$'+num(t.initialCapUsd)}</td><td>${sec(t.detectionDelayMs)}</td><td>${sec(t.firstRise10PctAfterMs)}</td><td>${num(t.peakGainPct)}%</td><td>${sec(t.peakAfterMs)}</td><td>${sec(t.exits?.peakToDrop20Ms)}</td><td>${sec(t.exits?.peakToDrop50Ms)}</td><td>${num(t.exits?.trailingStopPct,1)}%</td><td>${num(t.changePct,1)}%</td><td>${t.chat120==null?'—':esc(t.chat120)}</td><td>${esc(t.launch?.launchTool??'—')}${t.launch?.mayhem?' · mayhem':''}</td></tr>`).join('');
 const table=`<div class="table-scroll"><table><thead><tr><th>Token</th><th>Outcome</th><th>Cap first seen</th><th>Detect delay</th><th>First +10%</th><th>Peak</th><th>Time to peak</th><th>Peak → −20%</th><th>Peak → −50%</th><th>20% trail stop</th><th>Final</th><th>Comments 0–2m</th><th>Launch</th></tr></thead><tbody>${rows}</tbody></table></div>`;
 return `<p>${scored.length} finished tokens across all studies · ${groups.winner.length} winners · ${groups.loser.length} losers · ${groups.tanked.length} tanked. Hindsight measurements from displayed prices, not executable fills.</p>${summary}${chart}${table}`;
}

// Token chat: per-window comment counts, keyword sentiment, repeated words, and words followed by price moves 30s later.
export function chatHtml(token){
 const w=token.chatWindows;
 if(!w?.length)return '<p class="muted">No chat captured for this token (recorded before chat capture, or the Callouts panel was never readable). Missing chat is not neutral chat.</p>';
 const label={'observed-comments':'comments seen','observed-empty':'checked, no comments','unavailable':'panel unavailable','not-observed':'not observed'};
 const rows=w.map(x=>`<tr><td>${esc(x.seconds===600?'10 min':x.seconds+' sec')}</td><td>${esc(label[x.availability]??x.availability)}</td><td>${esc(x.uniqueComments)}</td><td>${esc(x.sentiment?.positiveComments??0)} / ${esc(x.sentiment?.negativeComments??0)}</td><td>${(x.repeatedTerms||[]).slice(0,6).map(t=>esc(t.term)+' ×'+esc(t.commentCount)).join(', ')||'—'}</td></tr>`).join('');
 const a=token.chatAssociations;
 const assoc=a?.terms?.length?`<h3>Words and the price 30 seconds later</h3><table><thead><tr><th>Word</th><th>Comments</th><th>Mean price change 30s later</th><th>Enough samples</th></tr></thead><tbody>${a.terms.slice(0,10).map(t=>`<tr><td>${esc(t.term)}</td><td>${esc(t.count)}</td><td>${num(t.meanObservedChangePct,1)}%</td><td>${t.minimumCountMet?'yes':'no (<5)'}</td></tr>`).join('')}</tbody></table>`:'<p class="muted">No comments could be matched to a price 30 seconds later.</p>';
 return `<div class="table-scroll"><table><thead><tr><th>Window</th><th>Chat status</th><th>Comments</th><th>Positive / negative</th><th>Repeated words</th></tr></thead><tbody>${rows}</tbody></table></div>${assoc}<p class="muted small">Keyword sentiment, not a language model. Sarcasm, spam and bots distort it. Associations only, never proof that chat caused a move.</p>`;
}

const ACTIVE=['watching','running','queued','capturing','analyzing'];
const age=ms=>ms==null||!Number.isFinite(ms)?'—':ms<60000?Math.round(ms/1000)+'s':Math.floor(ms/60000)+'m '+String(Math.round(ms%60000/1000)).padStart(2,'0')+'s';
// Live cards for tokens being recorded now: latest screenshot, live change/peak from the recorder's price reads.
export function watchingHtml(tokens,mediaUrl,now=Date.now()){
 const live=tokens.filter(t=>ACTIVE.includes(t.status)).sort((a,b)=>(a.endsAt??0)-(b.endsAt??0));
 if(!live.length)return '<p class="muted">No tokens are being recorded right now. Start a study to watch launches live.</p>';
 return live.map(t=>{
  const first=t.firstPriceUsd,last=t.lastPriceUsd,peak=t.peakPriceUsd;
  const chg=first&&last?(last/first-1)*100:null,pk=first&&peak?(peak/first-1)*100:null;
  const cls=chg==null?'':chg>7?'up':chg<=-50?'tanked':chg<0?'down':'';
  const start=t.startedAt??now,end=t.endsAt??start+600000,progress=Math.min(100,Math.max(0,(now-start)/Math.max(1,end-start)*100));
  const lastAt=t.lastFrameAt??t.latestFrame?.capturedAt??null,stale=lastAt!=null&&now-lastAt>60000;
  const url=t.latestFrame?.key?mediaUrl(t.latestFrame.key):null;
  return `<article class="live-token watch ${cls}${stale?' delayed':''}" data-token="${esc(t.id)}" data-campaign="${esc(t.campaignId)}" tabindex="0" role="button" aria-label="Open ${esc(t.name||t.mint)}">
<h3>${esc(t.name||t.mint?.slice(0,10))}</h3>${url?`<img src="${esc(url)}" alt="Latest screenshot for ${esc(t.name||t.mint)}">`:'<div class="preview-empty">Waiting for first screenshot</div>'}
<p class="watch-numbers"><span class="big ${cls}">${chg==null?'—':(chg>0?'+':'')+num(chg,1)+'%'}</span> now · peak ${pk==null?'—':'+'+num(pk,1)+'%'}${t.peakPriceAt&&t.createdAt?` at ${age(t.peakPriceAt-t.createdAt)}`:''}</p>
<progress max="100" value="${progress.toFixed(0)}"></progress>
<p>${age(Math.max(0,end-now))} left · ${age(t.createdAt?now-t.createdAt:null)} since launch · ${esc(t.frameCount??0)} frames · last capture ${lastAt?age(now-lastAt)+' ago':'none'}</p>
<p class="muted">${esc(t.launch?.launchTool??'launch source unknown')}${t.launch?.mayhem?' · mayhem':''}${t.candidate?.marketCapUsd?` · cap first seen $${num(t.candidate.marketCapUsd)}`:''}${stale?' · capture delayed':''}</p></article>`;}).join('');
}

// Current study's token table: live tokens first (live price reads), then finished ones by final change.
export function tokenTableHtml(rows,now=Date.now()){
 if(!rows.length)return '<p>Waiting for a fresh token. No observation is implied until it appears here.</p>';
 const live=t=>ACTIVE.includes(t.status);
 const nowPct=t=>t.firstPriceUsd&&t.lastPriceUsd?(t.lastPriceUsd/t.firstPriceUsd-1)*100:t.metrics?.changePct??null;
 const peakPct=t=>t.firstPriceUsd&&t.peakPriceUsd?(t.peakPriceUsd/t.firstPriceUsd-1)*100:t.metrics?.peakGainPct??null;
 const sorted=[...rows].sort((a,b)=>live(b)-live(a)||(live(a)?(a.endsAt??0)-(b.endsAt??0):(nowPct(b)??-1e9)-(nowPct(a)??-1e9)));
 const pct=v=>v==null?'—':(v>0?'+':'')+num(v,1)+'%';
 const cls=v=>v==null?'':v>7?'c-winner':v<=-50?'c-tanked':'';
 return `<table><thead><tr><th>Token</th><th>Status</th><th>Now</th><th>Peak</th><th>Time left</th><th>Frames</th><th>Launch</th><th>Paper (all)</th><th>Paper (filtered)</th><th>What went wrong</th><th>Comparison</th><th>Review</th></tr></thead><tbody>${sorted.map(t=>{const n=nowPct(t),p=peakPct(t);return `<tr><td>${esc(t.name||t.mint?.slice(0,10))}</td><td>${esc(t.status)}</td><td class="${cls(n)}">${pct(n)}</td><td>${pct(p)}</td><td>${live(t)?age(Math.max(0,(t.endsAt??now)-now)):'done'}</td><td>${esc(t.frameCount??0)}</td><td>${esc(t.launch?.launchTool??'—')}${t.launch?.mayhem?' · mayhem':''}</td><td>${paperCell(t.paper)}</td><td>${paperCell(t.paperFiltered)}</td><td class="small">${esc(t.paperMistake?.label??'—')}</td><td>${t.excluded?'Excluded':'Included'}</td><td><button data-token="${esc(t.id)}">Open</button></td></tr>`;}).join('')}</tbody></table>`;
}

// Paper trading scorecard: two strategies side by side, exits and launch traits that drive the result.
export function paperHtml(paper,title='this study'){
 if(!paper?.all)return '<p class="muted">No paper trades yet.</p>';
 const money=v=>v==null?'—':(v>=0?'+$':'-$')+Math.abs(v).toFixed(2);
 const pct=v=>v==null?'—':(v>0?'+':'')+num(v,1)+'%';
 const cls=v=>v==null?'':v>0?'c-winner':v<0?'c-tanked':'';
 const col=(name,s)=>{const o=s.overall;return `<article class="paper-card"><h3>${esc(name)}</h3><p class="big ${cls(o.totalUsd)}">${money(o.totalUsd)}</p><p>${esc(o.trades)} closed trades · ${o.winRate==null?'—':esc(o.winRate)+'% won'} · avg ${pct(o.avgPct)} · median ${pct(o.medianPct)}${s.open?` · ${esc(s.open)} open`:''}</p><p class="muted">Skipped: ${Object.entries(s.skipped||{}).map(([k,v])=>esc(k)+' '+esc(v)).join(' · ')||'none'}</p></article>`;};
 const exits=Object.entries(paper.all.byExit||{}).sort((a,b)=>b[1].totalUsd-a[1].totalUsd).map(([k,v])=>`<tr><td>${esc(k)}</td><td>${esc(v.trades)}</td><td>${v.winRate==null?'—':esc(v.winRate)+'%'}</td><td class="${cls(v.avgPct)}">${pct(v.avgPct)}</td><td class="${cls(v.totalUsd)}">${money(v.totalUsd)}</td></tr>`).join('');
 const tags=Object.entries(paper.all.byTag||{}).map(([k,v])=>`<tr><td>${esc(k)}</td><td>${esc(v.with.trades)} · ${pct(v.with.avgPct)} · ${money(v.with.totalUsd)}</td><td>${esc(v.without.trades)} · ${pct(v.without.avgPct)} · ${money(v.without.totalUsd)}</td></tr>`).join('');
 const r=paper.all.rules||{};
 return `<div class="paper-grid">${col('All tradable tokens',paper.all)}${col('Filtered: fee-routed or mayhem',paper.filtered)}</div>
<p class="muted small">Rules ${esc(r.version)}: $${esc(r.sizeUsd)} per trade · skip no trade within ${esc((r.deadAfterMs||0)/1000)}s, bulk spam, or already +${esc(r.noChaseAbovePct)}% · sell +${esc(r.earlyTakePct)}% in first ${esc((r.earlyWindowMs||0)/1000)}s · sell if never +${esc(r.checkMinPct)}% by ${esc((r.checkAtMs||0)/1000)}s · stop −${esc(r.stopPct)}% · trail −${esc(r.trailPct)}% after +${esc(r.trailArmPct)}% · out at ${esc((r.maxHoldMs||0)/60000)} min · ${esc((r.costPerSide||0)*100)}% cost per side. ${esc(paper.all.warning||'')}</p>
<div class="table-scroll"><table><thead><tr><th>Exit (all tokens, ${esc(title)})</th><th>Trades</th><th>Won</th><th>Avg</th><th>Total</th></tr></thead><tbody>${exits||'<tr><td colspan="5">No closed trades yet.</td></tr>'}</tbody></table></div>
${tags?`<div class="table-scroll"><table><thead><tr><th>Launch trait</th><th>With it: trades · avg · total</th><th>Without it</th></tr></thead><tbody>${tags}</tbody></table></div>`:''}`;
}
export function paperCell(p){if(!p)return '—';if(p.status==='skipped')return `<span class="muted">skip</span>`;const v=p.pnlPct;const s=v==null?'—':(v>0?'+':'')+num(v,1)+'%';return `<span class="${v>0?'c-winner':v<0?'c-tanked':''}">${p.status==='open'?'open ':''}${s}</span>`;}

const ruleText=r=>r?`${esc(r.version)}: take +${esc(r.earlyTakePct)}% in ${esc((r.earlyWindowMs||0)/1000)}s · check +${esc(r.checkMinPct)}% at ${esc((r.checkAtMs||0)/1000)}s · stop −${esc(r.stopPct)}% · trail −${esc(r.trailPct)}% after +${esc(r.trailArmPct)}%`:'—';
// One row per study: how each paper strategy did under the rules that study used.
export function mistakesHtml(m){if(!m)return '—';const e=Object.entries(m).filter(([k])=>k!=='good trade'&&k!=='correct skip').sort((a,b)=>a[1].costUsd-b[1].costUsd);
 return e.length?e.map(([k,v])=>`${esc(k)} ${esc(v.count)}${v.costUsd?` (${v.costUsd<0?'-$':'+$'}${Math.abs(v.costUsd).toFixed(2)})`:''}${v.avgMissedUpsidePct!=null&&k!=='bought a tanker'?` · missed +${esc(v.avgMissedUpsidePct)}%`:''}`).join('<br>'):'none';}
export function ledgerHtml(ledger,state){
 const nextRules=state?.nextPaperRules??state;
 const money=v=>v==null?'—':(v>=0?'+$':'-$')+Math.abs(v).toFixed(2);
 const cell=o=>o&&o.trades?`<span class="${o.totalUsd>0?'c-winner':o.totalUsd<0?'c-tanked':''}">${esc(o.trades)} · ${o.winRate==null?'—':esc(o.winRate)+'%'} · ${o.avgPct==null?'—':(o.avgPct>0?'+':'')+esc(o.avgPct)+'%'} · ${money(o.totalUsd)}</span>`:'—';
 const rows=(ledger||[]).map(l=>`<tr><td>${esc(new Date(l.startedAt).toLocaleString())}</td><td>${esc(l.tokens??0)}</td><td>${esc(l.paperResult?.rules?.version??'not recorded')}<br><span class="muted small">${esc(l.paperResult?.filter??'')}</span>${l.paperAutoApplied?`<br><span class="c-winner small">auto-applied → ${esc(l.paperAutoApplied.to.rules)} · ${esc(l.paperAutoApplied.to.filter)}</span>`:''}</td><td>${cell(l.paperResult?.all)}</td><td>${cell(l.paperResult?.filtered)}</td><td class="small">${mistakesHtml(l.paperMistakes?.filtered)}</td></tr>`).join('');
 const latest=(ledger||[]).find(l=>l.paperSuggestion&&!l.paperSuggestion.error);
 const sug=(name,x)=>{if(!x)return '';if(x.status==='insufficient-data')return `<article class="paper-card"><h3>${esc(name)}</h3><p class="muted">${esc(x.reason)}</p></article>`;
  const line=(lab,s)=>`<p>${lab} (${esc(s.filter??'all')}): train ${s.train.avgPct==null?'—':esc(s.train.avgPct)+'%'} (${esc(s.train.trades)}) · <strong>newest study ${s.test.avgPct==null?'—':esc(s.test.avgPct)+'%'} (${esc(s.test.trades)})</strong></p>`;
  return `<article class="paper-card"><h3>${esc(name)} <span class="pill ${x.status==='promote'?'c-winner':''}">${x.status==='promote'?'better on unseen data':'keep current'}</span></h3>${line('Current',x.current)}${line('Suggested',x.suggested)}<p class="muted small">${ruleText(x.suggested.rules)}</p><p class="muted small">${esc(x.reason)}</p>${x.status==='promote'?`<button class="primary" data-apply='${esc(JSON.stringify({...x.suggested.rules,filter:x.suggested.filter}))}'>Apply to next study</button>`:''}</article>`;};
 const hist=(state?.paperHistory||[]).slice(0,8).map((h,k)=>`<tr><td>${esc(new Date(h.at).toLocaleString())}</td><td>${esc(h.source)}</td><td>${esc(h.rules?.version)}</td><td>${esc(h.filter)}</td><td>${k>0?`<button data-apply='${esc(JSON.stringify({...h.rules,filter:h.filter,source:'rollback'}))}'>Roll back to this</button>`:'in use'}</td></tr>`).join('');
 return `<p>Next study: <strong>${ruleText(nextRules)}</strong> · filter <strong>${esc(state?.nextPaperFilter??'feeRouted|mayhem')}</strong></p>
<p><label><input type="checkbox" id="paper-auto" ${state?.paperAuto===false?'':'checked'}> Auto-apply rules that beat the current setup on the newest (unseen) study</label></p>
<div class="table-scroll"><table><thead><tr><th>Study</th><th>Tokens</th><th>Rules / filter used</th><th>All tokens: trades · won · avg · total</th><th>Filtered: trades · won · avg · total</th><th>What went wrong (filtered)</th></tr></thead><tbody>${rows||'<tr><td colspan="6">No studies yet.</td></tr>'}</tbody></table></div>
${latest?`<h3>Rule tuner (after ${esc(new Date(latest.startedAt).toLocaleString())} study)</h3><p class="muted small">Variants around the current rules (and launch filters for the filtered strategy), chosen on earlier studies only, scored on the newest study. ${esc(latest.paperSuggestion.all?.warning??'')}</p><div class="paper-grid">${sug('All tradable tokens',latest.paperSuggestion.all)}${sug('Filtered strategy',latest.paperSuggestion.filtered)}</div>`:'<p class="muted">The rule tuner runs when a study finishes.</p>'}
${lessonsHtml((ledger||[]).find(l=>l.paperLessons?.lessons||l.paperLessons?.error))}${hist?`<h3>Rules history</h3><div class="table-scroll"><table><thead><tr><th>When</th><th>Source</th><th>Rules</th><th>Filter</th><th></th></tr></thead><tbody>${hist}</tbody></table></div>`:''}`;
}

// Kimi's review of the study's mistakes: what was known, what came after, which rule change to test.
export function lessonsHtml(l){
 if(!l)return '';const x=l.paperLessons;
 if(!x?.lessons)return `<h3>Mistake review</h3><p class="muted">${esc(x?.error??'No review yet.')}</p>`;
 const pats=x.lessons.patterns.map(p=>`<tr><td>${esc(p.mistake)}</td><td>${esc(p.cases)}</td><td>${esc(p.knownSignal)}</td><td>${esc(p.afterData)}</td></tr>`).join('');
 const changes=x.lessons.ruleChanges.map(r=>`<li><strong>${esc(r.field)} → ${esc(r.to)}</strong>: ${esc(r.why)}</li>`).join('');
 return `<h3>Mistake review (${esc(new Date(l.startedAt).toLocaleString())} study, ${esc(x.cases?.length??0)} cases)</h3><p class="muted small">Each case: what was known at the decision, what the rules did, and what the price did afterwards. Kimi finds the patterns; the tuner tests any change on unseen data before it is used.</p>
<div class="table-scroll"><table><thead><tr><th>Mistake</th><th>Cases</th><th>Signal that should have changed the call</th><th>What happened after</th></tr></thead><tbody>${pats||'<tr><td colspan="4">No patterns found.</td></tr>'}</tbody></table></div>${changes?`<p>Rule changes to test:</p><ul>${changes}</ul>`:''}<p class="muted small">${esc(x.lessons.caveat)}</p>`;
}

// Paper trading tab: is the system improving? Cumulative P&L per strategy, per-study results, rule changes marked.
const SERIES={filtered:{color:'#5fa83a',label:'Filtered strategy'},all:{color:'#3f7fc0',label:'All tokens'}};
export function improvementHtml(ledger){
 const rows=[...(ledger||[])].filter(l=>l.paperResult).sort((a,b)=>a.startedAt-b.startedAt);
 if(!rows.length)return '<p class="muted">No finished studies with paper trades yet.</p>';
 const money=v=>v==null?'—':(v>=0?'+$':'-$')+Math.abs(v).toFixed(2);
 const pct=v=>v==null?'—':(v>0?'+':'')+num(v,1)+'%';
 const cum={filtered:[],all:[]};let fs=0,as=0;
 for(const r of rows){fs+=r.paperResult.filtered?.totalUsd??0;as+=r.paperResult.all?.totalUsd??0;cum.filtered.push(fs);cum.all.push(as);}
 const tradesOf=k=>rows.reduce((n,r)=>n+(r.paperResult[k]?.trades??0),0);
 const avgOf=(list,k)=>{const t=list.reduce((n,r)=>n+(r.paperResult[k]?.trades??0),0);return t?list.reduce((n,r)=>n+(r.paperResult[k]?.avgPct??0)*(r.paperResult[k]?.trades??0),0)/t:null;};
 const latest=rows.at(-1),earlier=rows.slice(0,-1),la=latest.paperResult.filtered?.avgPct??null,ea=avgOf(earlier,'filtered');
 const verdict=la==null||ea==null?'Needs at least two finished studies to compare.':la>ea?`Improving: latest study ${pct(la)} per trade vs ${pct(ea)} before.`:`Not improving yet: latest study ${pct(la)} per trade vs ${pct(ea)} before.`;
 const changed=(r,k)=>k>0&&(r.paperResult.rules?.version!==rows[k-1].paperResult.rules?.version||r.paperResult.filter!==rows[k-1].paperResult.filter);
 const changes=rows.filter(changed).length;
 const hero=`<div class="stats paper-stats"><article><span class="label">Filtered strategy, all studies</span><strong class="${fs>0?'c-winner':fs<0?'c-tanked':''}">${money(fs)}</strong><span class="small muted">${tradesOf('filtered')} trades · ${pct(avgOf(rows,'filtered'))} per trade</span></article><article><span class="label">All tokens, all studies</span><strong class="${as>0?'c-winner':as<0?'c-tanked':''}">${money(as)}</strong><span class="small muted">${tradesOf('all')} trades · ${pct(avgOf(rows,'all'))} per trade</span></article><article><span class="label">Studies · rule changes</span><strong>${rows.length} · ${changes}</strong><span class="small muted">${rows.filter(r=>r.paperAutoApplied).length} auto-applied</span></article><article><span class="label">Trend (filtered, per trade)</span><strong>${la!=null&&ea!=null?(la>ea?'▲':'▼'):'—'}</strong><span class="small muted">${esc(verdict)}</span></article></div>`;
 // One axis per chart: cumulative $ (two series) and per-study $ (filtered only) are separate charts.
 const W=720,H=240,P={l:52,r:110,t:18,b:40},n=rows.length;
 const x=k=>P.l+(n===1?(W-P.l-P.r)/2:k*(W-P.l-P.r)/(n-1));
 const scale=vals=>{const lo=Math.min(0,...vals),hi=Math.max(0,...vals),pad=(hi-lo||1)*0.12;return v=>P.t+(1-(v-(lo-pad))/((hi+pad)-(lo-pad)))*(H-P.t-P.b);};
 const date=r=>new Date(r.startedAt).toLocaleDateString(undefined,{month:'short',day:'numeric'})+' '+new Date(r.startedAt).toLocaleTimeString(undefined,{hour:'numeric',minute:'2-digit'});
 const axis=y=>`<line x1="${P.l}" x2="${W-P.r}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" class="axis-zero"/><text x="${P.l-6}" y="${(y(0)+4).toFixed(1)}" text-anchor="end">$0</text>`+rows.map((r,k)=>`<text x="${x(k).toFixed(1)}" y="${H-14}" text-anchor="middle">${esc(date(r))}</text>`).join('');
 const ruleMarks=rows.map((r,k)=>changed(r,k)?`<line x1="${x(k).toFixed(1)}" x2="${x(k).toFixed(1)}" y1="${P.t}" y2="${H-P.b}" class="rule-change"/><text x="${(x(k)+4).toFixed(1)}" y="${P.t+8}" class="rule-label">${esc(r.paperResult.rules?.version)}</text>`:'').join('');
 const yc=scale([...cum.filtered,...cum.all]);
 const line=key=>{const s=SERIES[key],pts=cum[key].map((v,k)=>[x(k),yc(v)]);return `<polyline fill="none" stroke="${s.color}" stroke-width="2" points="${pts.map(p=>p.map(v=>v.toFixed(1)).join(',')).join(' ')}"/>`+pts.map((p,k)=>`<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="5" fill="${s.color}" stroke="#111c25" stroke-width="2"><title>${esc(s.label)} · ${esc(date(rows[k]))}: cumulative ${money(cum[key][k])} (this study ${money(rows[k].paperResult[key]?.totalUsd)}, rules ${esc(rows[k].paperResult.rules?.version??'')})</title></circle>`).join('')+`<text x="${(pts.at(-1)[0]+10).toFixed(1)}" y="${(pts.at(-1)[1]+4).toFixed(1)}" class="direct-label">${esc(s.label)}</text>`;};
 const cumChart=`<figure class="paper-figure"><figcaption>Cumulative paper P&L, $2 trades (hover points for details)</figcaption><svg class="path-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative paper profit and loss per study">${axis(yc)}${ruleMarks}${line('all')}${line('filtered')}</svg><p class="chart-legend"><span class="c-filtered">━</span> Filtered strategy <span class="c-all">━</span> All tokens <span class="muted">┆ rules changed</span></p></figure>`;
 const per=rows.map(r=>r.paperResult.filtered?.totalUsd??0),yb=scale(per),bw=Math.max(8,Math.min(40,(W-P.l-P.r)/Math.max(n,1)*0.5));
 const bars=per.map((v,k)=>{const y0=yb(0),y1=yb(v),top=Math.min(y0,y1),h=Math.max(1,Math.abs(y1-y0));return `<rect x="${(x(k)-bw/2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="4" fill="${SERIES.filtered.color}"><title>${esc(date(rows[k]))}: ${money(v)} · ${rows[k].paperResult.filtered?.trades??0} trades · ${pct(rows[k].paperResult.filtered?.avgPct)} per trade · won ${rows[k].paperResult.filtered?.winRate??'—'}%</title></rect><text x="${x(k).toFixed(1)}" y="${(v>=0?top-6:top+h+14).toFixed(1)}" text-anchor="middle" class="bar-label">${money(v)}</text>`;}).join('');
 const barChart=`<figure class="paper-figure"><figcaption>Filtered strategy P&L per study</figcaption><svg class="path-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Filtered strategy profit and loss for each study">${axis(yb)}${ruleMarks}${bars}</svg></figure>`;
 const top=m=>{const e=Object.entries(m||{}).filter(([k])=>k!=='good trade'&&k!=='correct skip').sort((a,b)=>a[1].costUsd-b[1].costUsd)[0];return e?`${esc(e[0])} (${e[1].count})`:'—';};
 const table=`<h3>Every study</h3><div class="table-scroll"><table><thead><tr><th>Study</th><th>Rules · filter</th><th>Filtered: trades · won · per trade · total</th><th>Cumulative</th><th>All tokens: per trade · total</th><th>Costliest mistake</th></tr></thead><tbody>${rows.map((r,k)=>`<tr><td>${esc(date(r))}</td><td>${esc(r.paperResult.rules?.version??'—')} · ${esc(r.paperResult.filter??'—')}${r.paperAutoApplied?' <span class="c-winner small">→ auto-applied next</span>':''}</td><td>${esc(r.paperResult.filtered?.trades??0)} · ${esc(r.paperResult.filtered?.winRate??'—')}% · ${pct(r.paperResult.filtered?.avgPct)} · ${money(r.paperResult.filtered?.totalUsd)}</td><td>${money(cum.filtered[k])}</td><td>${pct(r.paperResult.all?.avgPct)} · ${money(r.paperResult.all?.totalUsd)}</td><td class="small">${top(r.paperMistakes?.filtered)}</td></tr>`).reverse().join('')}</tbody></table></div>`;
 return hero+`<div class="paper-charts">${cumChart}${barChart}</div>`+table;
}

// Every paper trade, one row per token: entry, exit, P&L and what the price did after the exit.
export function tradesHtml(tokens,strategy='filtered',show='all'){
 const key=strategy==='all'?'paper':'paperFiltered',mkey=strategy==='all'?'mistake':'filteredMistake';
 const money=v=>v==null?'—':(v>=0?'+$':'-$')+Math.abs(v).toFixed(2);
 const pct=v=>v==null?'—':(v>0?'+':'')+num(v,1)+'%';
 const clock=ms=>ms==null?'—':Math.floor(ms/60000)+':'+String(Math.round(ms%60000/1000)).padStart(2,'0');
 const traded=(tokens||[]).filter(t=>t[key]&&(t[key].status==='closed'||t[key].status==='open')&&t[key].pnlPct!=null);
 const wins=traded.filter(t=>t[key].pnlPct>0),losses=traded.filter(t=>t[key].pnlPct<=0);
 const sum=g=>g.reduce((a,t)=>a+(t[key].pnlUsd??0),0);
 const list=(show==='winners'?wins:show==='losers'?losses:traded).sort((a,b)=>b[key].pnlPct-a[key].pnlPct);
 const summary=`<div class="stats paper-stats"><article><span class="label">Winning trades</span><strong class="c-winner">${money(sum(wins))}</strong><span class="small muted">${wins.length} tokens · avg ${pct(wins.length?wins.reduce((a,t)=>a+t[key].pnlPct,0)/wins.length:null)}</span></article><article><span class="label">Losing trades</span><strong class="c-tanked">${money(sum(losses))}</strong><span class="small muted">${losses.length} tokens · avg ${pct(losses.length?losses.reduce((a,t)=>a+t[key].pnlPct,0)/losses.length:null)}</span></article><article><span class="label">Net</span><strong class="${sum(traded)>0?'c-winner':sum(traded)<0?'c-tanked':''}">${money(sum(traded))}</strong><span class="small muted">${traded.length} trades · ${traded.length?Math.round(wins.length/traded.length*100):0}% won</span></article></div>`;
 const tagText=t=>[t.tags?.feeRouted&&'fee-routed',t.tags?.mayhem&&'mayhem',t.tags?.terminal&&'terminal'].filter(Boolean).join(' · ')||'website';
 const after=m=>m?.after?`high ${pct(m.after.rest.maxPct)} · end ${pct(m.after.rest.endPct)}`:'—';
 const rows=list.map(t=>{const p=t[key],m=t[mkey];return `<tr><td>${esc(t.name||t.mint?.slice(0,10))}</td><td class="small">${t.studyStartedAt?esc(new Date(t.studyStartedAt).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})):'—'}</td><td class="small">${esc(tagText(t))}</td><td>${clock(p.holdMs)}</td><td class="small">${esc(p.exitReason??'')}</td><td class="${p.pnlPct>0?'c-winner':p.pnlPct<0?'c-tanked':''}">${pct(p.pnlPct)}</td><td class="${p.pnlUsd>0?'c-winner':p.pnlUsd<0?'c-tanked':''}">${money(p.pnlUsd)}</td><td class="small">${esc(m?.label??(p.status==='open'?'still open':'—'))}</td><td class="small">${after(m)}</td></tr>`;}).join('');
 return summary+`<div class="table-scroll"><table><thead><tr><th>Token</th><th>Study</th><th>Launch</th><th>Held</th><th>Exit</th><th>P&L %</th><th>P&L ($2)</th><th>What went wrong</th><th>After our exit</th></tr></thead><tbody>${rows||'<tr><td colspan="9">No trades for this view.</td></tr>'}</tbody></table></div><p class="muted small">P&L after 1.25% fee + 2% slippage per side on displayed prices; "after our exit" is the highest and final price in the rest of the 10-minute window relative to our sale.</p>`;
}
