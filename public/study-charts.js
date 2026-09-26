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
 return pathChart([{points:pts,color:OUTCOME_COLORS.winner,width:2}],markers,'Token price path')+`<p class="chart-legend"><span class="c-muted">●</span> first seen <span class="c-amber">●</span> first +10% <span class="c-winner">●</span> peak <span class="c-tanked">●</span> −20% from peak · Peak → −20%: <strong>${sec(e.peakToDrop20Ms)}</strong> · Peak → −50%: <strong>${sec(e.peakToDrop50Ms)}</strong> · 20% trailing stop after costs: <strong>${num(e.trailingStopPct,1)}%</strong></p>`;
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
