import {activeHtml,queueHtml,runsHtml,runDetailHtml} from './model-view.js';
const $=id=>document.getElementById(id);
async function api(path,body){const r=await fetch('/api/studies'+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||'Request failed');return d;}
function notice(text,error=false){$('status').textContent=text;$('status').className=error?'notice':'';}
let busy=false;
async function load(){if(busy)return;busy=true;$('refresh').disabled=true;try{notice('Loading model runs…');const s=await api('/model');
  $('active').innerHTML=activeHtml(s);$('queue').innerHTML=queueHtml(s);$('runs').innerHTML=runsHtml(s.runs);notice('Updated '+new Date().toLocaleTimeString());}
 catch(e){notice(e.message,true);}finally{busy=false;$('refresh').disabled=false;}}
async function openRun(campaign,sha){try{notice('Loading run…');$('detail').innerHTML=runDetailHtml(await api(`/model-run?campaign=${encodeURIComponent(campaign)}&sha=${encodeURIComponent(sha)}`));$('detail-panel').hidden=false;$('detail-panel').scrollIntoView();notice('Run loaded.');}catch(e){notice(e.message,true);}}
const activate=(key,by)=>api('/model-activate',{key,by}).then(()=>{notice('Active model set: '+key);return load();}).catch(e=>notice(e.message,true));
$('refresh').onclick=load;
$('active').onsubmit=e=>{e.preventDefault();const f=new FormData(e.target);activate(String(f.get('key')),String(f.get('by')));};
$('active').onclick=e=>{const b=e.target.closest('[data-activate]');if(b)activate(b.dataset.activate,'Tim');};
$('queue').onsubmit=e=>{e.preventDefault();const id=String(new FormData(e.target).get('campaignId'));api('/model-eval',{campaignId:id}).then(()=>{notice('Model run queued. It starts once the newest token is 13 minutes old.');return load();}).catch(err=>notice(err.message,true));};
$('runs').onclick=e=>{const b=e.target.closest('[data-run]');if(!b)return;const [c,s]=b.dataset.run.split('|');openRun(c,s);};
load();setInterval(()=>{if(document.visibilityState==='visible')load();},30000);
