// Rendering for the Model tab (pure functions; test/model-ui.test.mjs checks them).
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num=(v,d=1)=>v==null||Number.isNaN(v)?'—':Number(v).toFixed(d);
const pct=v=>v==null?'—':(v>0?'+':'')+num(v,1)+'%';
const money=v=>v==null?'—':(v>=0?'+$':'-$')+Math.abs(v).toFixed(2);
const cls=v=>v==null?'':v>0?'c-winner':v<0?'c-tanked':'';
const sec=v=>v==null?'—':(v>0?'+':'')+v+' s';
const when=ms=>ms?new Date(ms).toLocaleString():'—';
const short=s=>esc(String(s??'').slice(0,8));

export function activeHtml(s){
 const a=s.active;
 const models=(s.models||[]).map(m=>`<option value="${esc(m.key)}"${a&&a.key===m.key?' selected':''}>${esc(m.key)}</option>`).join('');
 const hist=[...(s.history||[])].reverse().slice(0,10).map((h,i)=>`<tr><td>${esc(h.name)}</td><td><code>${short(h.sha)}</code></td><td>${esc(h.by)}</td><td>${when(h.activatedAt)}</td><td>${i>0&&(!a||h.key!==a.key)?`<button data-activate="${esc(h.key)}">Roll back to this</button>`:i===0?'<span class="muted">active</span>':''}</td></tr>`).join('');
 return `${a?`<p class="big">${esc(a.name)} <code>${short(a.sha)}</code></p><p class="muted">Set active by ${esc(a.by)} · ${when(a.activatedAt)}. Every finished study is paper-traded with this model once its tokens are 13 minutes old.</p>`
  :'<p class="notice">No active model yet. Publish one (steps below), then set it active here.</p>'}
<form id="activate-form" class="inline-form"><label>Model file <select name="key">${models||'<option value="">none uploaded</option>'}</select></label><label>Your name <input name="by" value="Tim" maxlength="60"></label><button type="submit"${models?'':' disabled'}>Set active</button></form>
${hist?`<div class="table-scroll"><table><thead><tr><th>Model</th><th>SHA</th><th>By</th><th>When</th><th></th></tr></thead><tbody>${hist}</tbody></table></div>`:''}`;
}

export function queueHtml(s){
 const opts=(s.campaigns||[]).filter(c=>c.status!=='running').map(c=>`<option value="${esc(c.id)}">${when(c.startedAt)} · ${esc(c.tokens)} tokens · ${esc(c.status)}</option>`).join('');
 const jobs=(s.jobs||[]).map(j=>`<tr><td>${esc(j.campaignId.slice(0,8))}</td><td>${esc(j.model.name)}</td><td>${esc(j.done)}/${esc(j.total??'?')}</td><td>${Date.now()<j.dueAt?'starts '+new Date(j.dueAt).toLocaleTimeString():'running'}</td><td class="small">${esc((j.errors||[]).slice(-2).join(' · '))}</td></tr>`).join('');
 return `<form id="eval-form" class="inline-form"><label>Study <select name="campaignId">${opts||'<option value="">no finished studies</option>'}</select></label><button type="submit"${opts&&s.active?'':' disabled'}>Run model on this study</button></form>
<p class="muted small">Uses the free pump.fun 1 s candles and wallet trades (same data the model trained on). Astra reviews the whole run when it finishes (about $0.20–0.35 per 100 tokens, hard cap $1).</p>
${jobs?`<div class="table-scroll"><table><thead><tr><th>Study</th><th>Model</th><th>Tokens done</th><th>Status</th><th>Errors</th></tr></thead><tbody>${jobs}</tbody></table></div>`:'<p class="muted">No model runs in progress.</p>'}`;
}

export function runsHtml(runs){
 if(!runs?.length)return '<p class="muted">No model runs yet.</p>';
 return `<div class="table-scroll"><table><thead><tr><th>Study</th><th>Model</th><th>Trades</th><th>Avg</th><th>Median</th><th>Won</th><th>Worse than −30%</th><th>Total ($2 each)</th><th>Rules v3 avg / total</th><th>Astra</th><th></th></tr></thead><tbody>${runs.map(r=>{const m=r.summary.model,v=r.summary.rulesV3;
  return `<tr><td>${esc(r.campaignId.slice(0,8))} · ${when(r.createdAt)}</td><td><code>${short(r.modelSha)}</code></td><td>${esc(m.trades)}/${esc(r.summary.tokens)}</td><td class="${cls(m.avgPct)}">${pct(m.avgPct)}</td><td class="${cls(m.medianPct)}">${pct(m.medianPct)}</td><td>${m.winRate==null?'—':esc(Math.round(m.winRate*100))+'%'}</td><td>${m.shareWorseThan30==null?'—':esc(Math.round(m.shareWorseThan30*100))+'%'}</td><td class="${cls(m.totalUsd)}">${money(m.totalUsd)}</td><td class="${cls(v.avgPct)}">${pct(v.avgPct)} / ${money(v.totalUsd)}</td><td>${r.review?(r.review.error?`<span class="c-tanked">${esc(r.review.error.slice(0,40))}</span>`:'reviewed $'+num(r.review.actualUsd??r.review.estimatedUsd,2)):'pending'}</td><td><button data-run="${esc(r.campaignId)}|${esc(r.modelSha)}">Open</button></td></tr>`;}).join('')}</tbody></table></div>`;
}

export function runDetailHtml(d){
 const run=d.run,s=run.summary,rv=d.review?.review,t=s.timing;
 const stat=(label,x,unit)=>`<tr><td>${esc(label)}</td><td>${esc(x.n)}</td><td>${num(x.mean)}${unit}</td><td>${num(x.median)}${unit}</td></tr>`;
 const labels=Object.entries(s.labels||{}).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${esc(k.replace(/_/g,' '))} ${esc(v)}`).join(' · ');
 const rows=[...run.rows].filter(r=>r.decisionT!=null).sort((a,b)=>Number(b.bought)-Number(a.bought)||(b.actual?.peakPct??0)-(a.actual?.peakPct??0)).map(r=>{const e=r.entryT??0,rel=x=>x==null?null:x-e,p=r.predictedVsActual||{},a=r.actual;
  return `<tr><td>${esc(r.name||r.mint.slice(0,8))}</td><td>${r.seenAgeS==null?'—':num(r.seenAgeS,0)+' s'}${r.liveFeasible===false?' <span class="c-tanked" title="buy decision came before we saw the token">late</span>':''}</td><td>${r.bought?'buy':'<span class="muted">skip</span>'}</td><td>${num(r.buyProb,2)}</td><td>${num(r.entryCrashProb,2)}</td>
<td class="${cls(r.trade?.netPct)}">${r.trade?pct(r.trade.netPct):r.shadow?`<span class="muted">(${pct(r.shadow.netPct)})</span>`:'—'}</td><td>${r.trade?sec(rel(r.trade.exitDecisionSec))+' · '+esc([...new Set(r.trade.reasons)].join(', ')):'—'}</td>
<td>${a?pct(a.peakPct)+' @ '+sec(rel(a.peakSec)):'—'}</td><td>${a?pct(a.best.grossPct)+' @ '+sec(rel(a.best.decisionSec)):'—'}</td>
<td>${sec(p.exitVsBestSec)}</td><td>${p.missVsPeakPts==null?'—':num(p.missVsPeakPts)+' pts'}</td><td>${p.crashPredictedSec==null?'—':sec(rel(p.crashPredictedSec))}${a?.crashStartSec!=null?' / '+sec(rel(a.crashStartSec)):''}</td>
<td class="small">${esc(r.feedback?[r.feedback.buyLabel,...r.feedback.sellLabels,r.feedback.loserReason].filter(Boolean).join(', ').replace(/_/g,' '):'')}</td><td class="${cls(r.rulesV3?.netPct)}">${pct(r.rulesV3?.netPct)}</td></tr>`;}).join('');
 const adj=rv?.adjustments?.length?`<div class="table-scroll"><table><thead><tr><th>Change</th><th>Now</th><th>Suggested</th><th>Why</th><th>Expected effect</th><th>Confidence</th></tr></thead><tbody>${rv.adjustments.map(x=>`<tr><td>${esc(x.parameter)}</td><td>${esc(x.current)}</td><td>${esc(x.suggested)}</td><td>${esc(x.why)}</td><td>${esc(x.expectedEffect)}</td><td>${esc(x.confidence)}</td></tr>`).join('')}</tbody></table></div>`:'';
 const list=(title,xs)=>xs?.length?`<h4>${esc(title)}</h4><ul>${xs.map(x=>`<li>${typeof x==='string'?esc(x):`${esc(x.issue)} — ${esc(x.impact)} <span class="muted">(${esc((x.evidence||[]).join(', '))})</span>`}</li>`).join('')}</ul>`:'';
 const astra=d.review?(rv?`<p>${esc(rv.summary)}</p>${list('What worked',rv.whatWorked)}${list('Problems',rv.problems)}${adj?'<h4>Suggested adjustments (you decide)</h4>'+adj:''}${list('Retraining notes',rv.retrainNotes)}${list('Data Astra wants',rv.dataRequests)}<p class="muted small">Astra saw ${esc(d.review.rowsSent)} of ${esc(d.review.rowsTotal)} rows · cost $${num(d.review.actualUsd??d.review.estimatedUsd,3)}</p>`
  :`<p class="c-tanked">${esc(d.review.error)}</p>${d.review.raw?`<pre>${esc(d.review.raw.slice(0,4000))}</pre>`:''}`):'<p class="muted">Astra review pending.</p>';
 return `<div class="paper-grid"><article class="paper-card"><h3>Model ${esc(run.model.name)}</h3><p class="big ${cls(s.model.totalUsd)}">${money(s.model.totalUsd)}</p><p>${esc(s.model.trades)} trades · avg ${pct(s.model.avgPct)} · median ${pct(s.model.medianPct)} · ${s.model.winRate==null?'—':Math.round(s.model.winRate*100)+'% won'} · ${s.model.shareWorseThan30==null?'—':Math.round(s.model.shareWorseThan30*100)+'%'} worse than −30%</p></article>
<article class="paper-card"><h3>Rules v3, same tokens</h3><p class="big ${cls(s.rulesV3.totalUsd)}">${money(s.rulesV3.totalUsd)}</p><p>${esc(s.rulesV3.trades)} trades · avg ${pct(s.rulesV3.avgPct)}</p></article></div>
<p><a class="button" href="/api/studies/model-run?campaign=${encodeURIComponent(run.campaignId)}&sha=${encodeURIComponent(run.model.sha)}&download=1">Download run JSON (every row + Astra review)</a></p>
<h3>Prediction vs actual: timing and peak</h3><div class="table-scroll"><table><thead><tr><th>Measure (bought tokens)</th><th>n</th><th>Mean</th><th>Median</th></tr></thead><tbody>
${stat('Exit decision vs best reachable exit (− = sold early)',t.exitVsBestSec,' s')}${stat('Exit fill vs peak second',t.exitVsPeakSec,' s')}${stat('Missed vs peak',t.missVsPeakPts,' pts')}${stat('Missed vs best reachable exit',t.missVsBestPts,' pts')}${stat('Crash warning vs actual crash start (− = early)',t.crashPredictedVsActualSec,' s')}</tbody></table></div>
<p class="small"><strong>Feedback labels:</strong> ${labels||'none'}</p>
${s.latency?`<p class="small"><strong>Detection latency:</strong> first seen ${num(s.latency.seenAgeS.median)} s after launch (median, mean ${num(s.latency.seenAgeS.mean)} s) · ${s.latency.tradesLiveFeasible==null?'—':Math.round(s.latency.tradesLiveFeasible*100)+'%'} of model trades were decided after we could have seen the token (live-feasible).</p>`:''}
<h3>Astra's review</h3>${astra}
<h3>Every token</h3><p class="muted small">Seconds are after entry. Skipped tokens show the model's shadow result in brackets (not a trade). Crash column: model warning / actual crash start.</p>
<div class="table-scroll"><table><thead><tr><th>Token</th><th>Seen</th><th>Model</th><th>Buy score</th><th>Crash risk</th><th>Net</th><th>Exit · why</th><th>Peak</th><th>Best reachable exit</th><th>Exit vs best</th><th>Missed vs peak</th><th>Crash</th><th>Feedback</th><th>Rules v3</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
