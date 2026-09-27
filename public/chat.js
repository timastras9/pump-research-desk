// Ask Astra tab: questions over the RAG export (rag/ in R2) and a re-sync of every study from D1.
export const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function turnHtml(t){
 if(t.role==='user')return `<article class="chat-turn user"><p class="label">You</p><p class="chat-text">${esc(t.content)}</p></article>`;
 const meta=[t.error?`<span class="error">${esc(t.error)}</span>`:'',t.actualUsd!=null?`$${Number(t.actualUsd).toFixed(3)}`:t.estimatedUsd!=null?`~$${Number(t.estimatedUsd).toFixed(3)} est.`:'',
  t.ragConnected===false?'document search not connected (index only)':'',t.ragError?`search error: ${esc(t.ragError)}`:''].filter(Boolean).join(' · ');
 const tools=(t.tools||[]).length?`<details><summary>${t.tools.length} tool steps</summary><ul>${t.tools.map(x=>`<li class="${x.ok?'':'error'}"><strong>${esc(x.name)}</strong> <span class="mint">${esc(x.detail)}</span></li>`).join('')}</ul></details>`:'';
 const prs=(t.pullRequests||[]).map(u=>/^https:\/\/github\.com\//.test(u)?`<p>Draft pull request for review: <a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a></p>`:'').join('');
 const src=(t.sources||[]).length?`<details><summary>${t.sources.length} source documents</summary><ul>${t.sources.map(s=>`<li class="mint">${esc(s)}</li>`).join('')}</ul></details>`:'';
 return `<article class="chat-turn astra"><p class="label">Astra</p><p class="chat-text">${esc(t.content||'')}</p>${prs}<p class="muted small">${meta}</p>${tools}${src}</article>`;
}
export function ragStatusText(d){
 const n=d?.index?.studies?.length??0,all=d?.studies?.length??0;
 const idx=d?.index?`Export: ${n} of ${all} studies, updated ${new Date(d.index.updatedAt).toLocaleString()}.`:`Export: not written yet (${all} studies in the database). Press Re-sync.`;
 return idx+' '+(d?.aiSearchInstance?`Document search: AI Search instance "${d.aiSearchInstance}".`:'Document search: not connected yet (set AI_SEARCH_INSTANCE); Astra answers from the study index only.');
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
  const past=history.filter(t=>t.content).map(t=>({role:t.role,content:t.content}));history.push({role:'user',content:q});render();
  try{const r=await api('/api/chat',{question:q,history:past,session});history.push({role:'assistant',content:r.answer,...r});}
  catch(e){history.push({role:'assistant',content:'',error:e.message});}
  finally{busy=false;$('ask').disabled=false;$('ask').textContent='Ask Astra';render();}}
 $('ask-form').onsubmit=e=>{e.preventDefault();const q=$('question').value;$('question').value='';ask(q);};
 $('question').onkeydown=e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('ask-form').requestSubmit();}};
 $('suggest').onclick=e=>{const b=e.target.closest('button');if(b)ask(b.textContent);};
 $('sync').onclick=async()=>{$('sync').disabled=true;let done=0;
  try{for(const s of studies){$('rag-status').textContent=`Exporting study ${done+1} of ${studies.length}…`;await api('/api/rag/sync',{id:s.id});done++;}await status();}
  catch(e){$('rag-status').textContent=`Stopped after ${done} studies: ${e.message}`;}finally{$('sync').disabled=false;}};
 status().catch(e=>{$('rag-status').textContent=e.message;});
}
