// Ask Astra tab: questions over the RAG export (rag/ in R2) and a re-sync of every study from D1.
export const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function turnHtml(t){
 if(t.role==='user')return `<article class="chat-turn user"><p class="label">You</p><p class="chat-text">${esc(t.content)}</p></article>`;
 const meta=[t.error?`<span class="error">${esc(t.error)}</span>`:'',t.actualUsd!=null?`$${Number(t.actualUsd).toFixed(3)}`:t.estimatedUsd!=null?`~$${Number(t.estimatedUsd).toFixed(3)} est.`:'',
  t.ragConnected===false?'document search not connected (index only)':'',t.ragError?`search error: ${esc(t.ragError)}`:''].filter(Boolean).join(' · ');
 const tools=(t.tools||[]).length?`<details><summary>${t.tools.length} tool steps</summary><ul>${t.tools.map(x=>`<li class="${x.ok?'':'error'}"><strong>${esc(x.name)}</strong> <span class="mint">${esc(x.detail)}</span></li>`).join('')}</ul></details>`:'';
 const src=(t.sources||[]).length?`<details><summary>${t.sources.length} source documents</summary><ul>${t.sources.map(s=>`<li class="mint">${esc(s)}</li>`).join('')}</ul></details>`:'';
 return `<article class="chat-turn astra"><p class="label">Astra</p><p class="chat-text">${esc(t.content||'')}</p><p class="muted small">${meta}</p>${tools}${src}</article>`;
}
export function ragStatusText(d){
 const n=d?.index?.studies?.length??0,all=d?.studies?.length??0;
 const idx=d?.index?`Export: ${n} of ${all} studies, updated ${new Date(d.index.updatedAt).toLocaleString()}.`:`Export: not written yet (${all} studies in the database). Press Re-sync.`;
 return idx+' '+(d?.aiSearchInstance?`Document search: AI Search instance "${d.aiSearchInstance}".`:'Document search: not connected yet (set AI_SEARCH_INSTANCE); Astra answers from the study index only.');
}
// DeepSeek backtest panel: progress, then buy-everything vs DeepSeek buys vs what it skipped (same tokens).
export function dsHtml(s){
 if(!s||s.status==='not started')return '<p class="muted">Not run yet.</p>';
 const pct=v=>v==null?'—':(v>0?'+':'')+v+'%',row=(name,x)=>`<tr><td>${esc(name)}</td><td>${esc(x?.n??0)}</td><td>${pct(x?.avgPct)}${x?.ci95!=null?` ±${esc(x.ci95)}`:''}</td><td>${x?.winPct==null?'—':esc(x.winPct)+'%'}</td><td>${x?.usd==null?'—':(x.usd>=0?'+$':'-$')+Math.abs(x.usd).toFixed(2)}</td></tr>`;
 const sm=s.summary||{},lat=sm.latencyMs;
 return `<p>${esc(s.status)} · ${esc(s.done)}/${esc(s.total)} tokens${s.model?` · model ${esc(s.model)}`:''} · DeepSeek said BUY on ${esc(sm.buys??0)}${lat?` · answer time median ${(lat.median/1000).toFixed(2)} s, p90 ${(lat.p90/1000).toFixed(2)} s`:''}</p>
<div class="table-scroll"><table><thead><tr><th>Strategy (same tokens)</th><th>Trades</th><th>Avg per trade (95% CI)</th><th>Won</th><th>Total ($2)</th></tr></thead><tbody>${row('Buy everything at 30 s',sm.buyEverything)}${row('DeepSeek BUY picks (after its answer time)',sm.deepseekBuys)}${row('Tokens DeepSeek skipped',sm.deepseekSkips)}</tbody></table></div>
${(s.errors||[]).length?`<p class="error small">${s.errors.map(esc).join('<br>')}</p>`:''}`;
}
// One Astras agent session per conversation (its memory lives in a Durable Object on the server).
export const newSessionId=()=>(globalThis.crypto?.randomUUID?.()??(Date.now().toString(36)+Math.random().toString(36).slice(2))).toLowerCase();
if(typeof document!=='undefined'){
 const $=id=>document.getElementById(id),history=[];let busy=false;
 const load=()=>{try{return localStorage.getItem('astras-session');}catch{return null;}},save=v=>{try{localStorage.setItem('astras-session',v);}catch{}};
 let session=load();if(!session||!/^[a-z0-9-]{8,64}$/.test(session)){session=newSessionId();save(session);}
 $('new-chat').onclick=()=>{session=newSessionId();save(session);history.length=0;render();};
 async function api(path,body){const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});if(r.status===401){location.href='/login.html';throw Error('Please sign in.');}const d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');return d;}
 const render=()=>{$('log').innerHTML=history.map(turnHtml).join('');$('log').lastElementChild?.scrollIntoView({block:'nearest'});};
 let studies=[];
 async function status(){const d=await api('/api/rag/studies');studies=d.studies||[];$('rag-status').textContent=ragStatusText(d);}
 async function ask(q){if(busy||!q.trim())return;busy=true;$('ask').disabled=true;$('ask').textContent='Astra is reading…';
  history.push({role:'user',content:q});render();
  try{const r=await api('/api/chat',{question:q,session});   // the agent keeps the conversation server-side; sending history overflowed the 8 KB request limit
  history.push({role:'assistant',content:r.answer,...r});}
  catch(e){history.push({role:'assistant',content:'',error:e.message});}
  finally{busy=false;$('ask').disabled=false;$('ask').textContent='Ask Astra';render();}}
 $('ask-form').onsubmit=e=>{e.preventDefault();const q=$('question').value;$('question').value='';ask(q);};
 $('question').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('ask-form').requestSubmit();}};
 $('suggest').onclick=e=>{const b=e.target.closest('button');if(b)ask(b.textContent);};
 $('sync').onclick=async()=>{$('sync').disabled=true;let done=0;
  try{for(const s of studies){$('rag-status').textContent=`Exporting study ${done+1} of ${studies.length}…`;await api('/api/rag/sync',{id:s.id});done++;}await status();}
  catch(e){$('rag-status').textContent=`Stopped after ${done} studies: ${e.message}`;}finally{$('sync').disabled=false;}};
 status().catch(e=>{$('rag-status').textContent=e.message;});
 let dsTimer=null;
 async function dsStatus(){const s=await api('/api/deepseek/status');$('ds-status').innerHTML=dsHtml(s);clearTimeout(dsTimer);if(s.status==='running')dsTimer=setTimeout(()=>dsStatus().catch(()=>{}),4000);}
 $('ds-run').onclick=async()=>{$('ds-run').disabled=true;try{const r=await api('/api/deepseek/run',{});if(r.error){$('ds-status').innerHTML=`<p class="error">${esc(r.error)}</p>`;return;}await dsStatus();}catch(e){$('ds-status').textContent=e.message;}finally{$('ds-run').disabled=false;}};
 dsStatus().catch(e=>{$('ds-status').textContent=e.message;});
}
