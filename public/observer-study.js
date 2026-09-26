// Concurrent 10-minute study panel on the observer page. Each launch gets its own browser.
const $=id=>document.getElementById(id);
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const secs=ms=>ms==null||!Number.isFinite(ms)?'unknown':Math.round(ms/1000)+'s';
const ACTIVE=['watching','running','queued','capturing'];
async function api(path,body){const r=await fetch('/api/studies'+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const d=await r.json();if(!r.ok)throw Error(d.error||'Request failed');return d;}
export function tokenRow(t,now=Date.now()){
 const start=t.startedAt??now,end=t.endsAt??start+600000,active=ACTIVE.includes(t.status);
 const progress=Math.min(100,Math.max(0,(now-start)/Math.max(1,end-start)*100));
 const lastAt=t.lastFrameAt??t.latestFrame?.capturedAt??null;
 const lag=t.createdAt?start-t.createdAt:null;
 return `<article class="live-token${active&&lastAt&&now-lastAt>60000?' delayed':''}"><h3>${esc(t.name||t.mint?.slice(0,10))}</h3><p class="mint">${esc(t.mint)}</p><progress max="100" value="${progress.toFixed(0)}"></progress><p>${active?`Watching · ${secs(Math.max(0,end-now))} left`:esc(t.status)} · ${esc(t.frameCount??0)} frames · started ${secs(lag)} after launch${lastAt?` · last capture ${secs(now-lastAt)} ago`:''}</p></article>`;
}
export function render(status,now=Date.now()){
 const c=status.campaign,tokens=status.tokens||[],running=c?.status==='running';
 const watching=tokens.filter(t=>ACTIVE.includes(t.status)).length;
 $('study-start').disabled=running;$('study-stop').disabled=!running;
 $('study-summary').textContent=!c?'No concurrent study yet. Press Start to watch many launches at once.':
  `${running?'Running':'Study '+c.status} · ${watching} watching now of ${c.concurrency} slots · ${tokens.length}/${c.maxTokens} tokens admitted · ${c.seenCount??0} launches seen, ${c.skippedCapacity??0} skipped for capacity · admission ${now<c.admissionEndsAt?'closes in '+secs(c.admissionEndsAt-now):'closed'}`;
 $('study-live').innerHTML=tokens.map(t=>tokenRow(t,now)).join('');
 return running;
}
let timer=null;
async function refresh(){clearTimeout(timer);try{const running=render(await api('/status'));timer=setTimeout(refresh,running?5000:30000);}catch(e){$('study-summary').textContent=e.message;timer=setTimeout(refresh,30000);}}
async function act(fn){$('study-start').disabled=$('study-stop').disabled=true;try{await fn();}catch(e){$('study-summary').textContent=e.message;}await refresh();}
if(typeof document!=='undefined'&&$('study-panel')){
 $('study-form').addEventListener('submit',e=>{e.preventDefault();act(()=>api('/start',{maxTokens:Number($('study-max').value),concurrency:Number($('study-concurrency').value),minMarketCapUsd:Number($('study-min-cap').value)||0,launchFilter:$('study-launch').value}));});
 $('study-stop').addEventListener('click',()=>act(()=>api('/stop',{})));
 refresh();
}
