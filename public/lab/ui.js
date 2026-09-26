import { observations, candles, replay } from './model.js';
const $ = s => document.querySelector(s);
const usd = n => n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 4 });
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let rows = [], metadata = null, report = null;
function load(data) {
  if (typeof data.source !== 'string' || !data.source.trim() || typeof data.mint !== 'string' || !data.mint.trim()) throw Error('Include source and mint labels.');
  rows = observations(data.trades); metadata = { source: data.source.slice(0, 500), mint: data.mint.slice(0, 100), synthetic: data.synthetic === true };
  report = null; $('#export').disabled = true; $('#results').textContent = 'New sample loaded. Run the replay.'; $('#journal').innerHTML = ''; $('#stress').textContent = '';
  $('#source').textContent = `${metadata.synthetic ? 'SYNTHETIC DEMO · ' : 'USER-SUPPLIED DATA · '}${metadata.source} · ${rows.length.toLocaleString()} observations · ${metadata.mint}`;
  chart();
}
$('#file').addEventListener('change', async e => {
  try { $('#error').textContent = ''; const f = e.target.files[0]; if (!f) return; if (f.size > 10000000) throw Error('Maximum file size is 10 MB.'); load(JSON.parse(await f.text())); }
  catch (e) { $('#error').textContent = e.message; }
});
$('#demo').addEventListener('click', () => {
  const time = 1780000000000;
  load({ source: 'Synthetic rise, crash and observation gap; not real trading evidence', mint: 'DEMO', synthetic: true,
    trades: Array.from({length:240}, (_,i) => ({id:`demo:${i}`,time:time+i*1000+(i>=120?12000:0),priceUsd:0.001*Math.exp(Math.sin(i/18)*0.25+i*0.0002),volumeUsd:5+(i%30)})) });
});
function chart() {
  const bars = candles(rows, Number($('#interval').value)).slice(-120);
  if (!bars.length) return;
  const min = Math.min(...bars.map(c=>c.low)), max = Math.max(...bars.map(c=>c.high));
  const range = max-min || min*0.01, width = Number($('#interval').value)*1000;
  const span = bars.at(-1).time-bars[0].time+width, x=t=>60+(t-bars[0].time)/span*820, y=p=>170-(p-min)/range*145;
  const w=Math.max(1,Math.min(12,820*width/span*0.7));
  $('#candles').innerHTML = `<svg viewBox="0 0 920 210" role="img" aria-label="Observed price candles in USD"><text x="2" y="18" fill="#82939c" font-size="11">${max.toPrecision(4)}</text><text x="2" y="177" fill="#82939c" font-size="11">${min.toPrecision(4)}</text>${bars.map(c=>`<g stroke="${c.close>=c.open?'#bbef64':'#fa7e7e'}" fill="${c.close>=c.open?'#bbef64':'#fa7e7e'}"><title>${esc(new Date(c.time).toISOString())} · O ${c.open} H ${c.high} L ${c.low} C ${c.close} · ${c.count} trades</title><line x1="${x(c.time)}" x2="${x(c.time)}" y1="${y(c.high)}" y2="${y(c.low)}"/><rect x="${x(c.time)-w/2}" y="${y(Math.max(c.open,c.close))}" width="${w}" height="${Math.max(1,Math.abs(y(c.open)-y(c.close)))}"/></g>`).join('')}<text x="60" y="200" fill="#82939c" font-size="11">${esc(new Date(bars[0].time).toISOString())}</text></svg>`;
}
$('#interval').addEventListener('change',chart);
$('#experiment').addEventListener('submit', e => {
  e.preventDefault(); $('#error').textContent = '';
  try {
    if (!rows.length) throw Error('Load trade observations or try the synthetic demo first.');
    const rules=Object.fromEntries([...new FormData(e.target)].map(([k,v])=>[k,Number(v)])); rules.holdMs*=1000;
    const result=replay(rows,rules), stress=replay(rows,{...rules,slipPct:Math.min(90,rules.slipPct*2),networkUsd:rules.networkUsd*2,delayMs:rules.delayMs*2});
    report={...metadata,modelVersion:1,runAt:new Date().toISOString(),sample:{first:rows[0].time,last:rows.at(-1).time,count:rows.length},result,stress};
    $('#results').textContent=`${metadata.synthetic?'SYNTHETIC DEMO — ':''}${result.trades.length} closed trades · ${usd(result.cash)} cash · ${usd(result.markedEquity)} estimated equity · ${usd(result.modeledCosts)} modeled costs · ${result.gaps} gaps · ${result.failed} unfilled attempts. ${result.position?'Position still open; exit is NOT assumed.':'No open position.'} ${result.pending?'An order is still pending.':''}`;
    $('#stress').textContent=`Double slippage adjustment, network fees and delay: ${usd(stress.markedEquity)} estimated equity, ${stress.trades.length} closed trades. Neither scenario proves executable fills or profitability.`;
    $('#journal').innerHTML=result.trades.slice(-100).reverse().map(t=>`<tr><td>${((t.closedAt-t.openedAt)/1000).toFixed(1)}s</td><td>${esc(t.reason)}</td><td>${usd(t.entryCosts+t.exitCosts)}</td><td>${usd(t.pnl)}</td></tr>`).join(''); $('#export').disabled=false;
  } catch(e) { $('#error').textContent=e.message; }
});
$('#export').addEventListener('click',()=>{if(!report)return; const url=URL.createObjectURL(new Blob([JSON.stringify({...report,observations:rows},null,2)],{type:'application/json'})); const a=document.createElement('a');a.href=url;a.download='momentum-experiment.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
