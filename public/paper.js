import {improvementHtml,ledgerHtml,paperHtml,tradesHtml} from './study-charts.js';
let data=null;
const renderTrades=()=>{if(data)document.getElementById('trades').innerHTML=tradesHtml(data.tokens,document.getElementById('trade-strategy').value,document.getElementById('trade-show').value);};
const $=id=>document.getElementById(id);
async function api(path,body){const r=await fetch('/api/studies'+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json().catch(()=>({}));if(!r.ok)throw Error(d.error||'Request failed');return d;}
function notice(text,error=false){$('status').textContent=text;$('status').className=error?'notice':'';}
let busy=false;
async function load(){if(busy)return;busy=true;$('refresh').disabled=true;try{notice('Loading paper trading history…');data=await api('/overview');renderTrades();
  $('improvement').innerHTML=improvementHtml(data.ledger);$('ledger').innerHTML=ledgerHtml(data.ledger,data);$('paper-all').innerHTML=paperHtml(data.paper,'all studies');
  notice('Updated '+new Date().toLocaleTimeString());}catch(e){notice(e.message,true);}finally{busy=false;$('refresh').disabled=false;}}
$('refresh').onclick=load;
$('trade-strategy').onchange=renderTrades;$('trade-show').onchange=renderTrades;
$('ledger').onchange=e=>{if(e.target.id!=='paper-auto')return;api('/paper-auto',{enabled:e.target.checked}).then(r=>notice(r.paperAuto?'Auto-apply on.':'Auto-apply off: rule changes need your click.')).catch(err=>notice(err.message,true));};
$('ledger').onclick=e=>{const b=e.target.closest('[data-apply]');if(!b)return;e.preventDefault();api('/paper-rules',JSON.parse(b.dataset.apply)).then(r=>{notice('Next study will use paper rules '+r.nextPaperRules.version+' · filter '+r.nextPaperFilter+'.');return load();}).catch(err=>notice(err.message,true));};
load();
