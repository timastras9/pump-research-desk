const $ = s => document.querySelector(s);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = n => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n);
const compact = n => n == null ? 'Unavailable' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
const signed = n => `${n >= 0 ? '+' : ''}${money(n)}`;
const cls = n => n >= 0 ? 'positive' : 'negative';
const pct = n => n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}%`;
const short = s => `${s.slice(0, 5)}…${s.slice(-4)}`;
let state; let rulesDirty = false; let toastTimer; let loading = false;
function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 5500); }
async function api(path, input) {
  const res = await fetch(`/api/${path}`, input === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const data = await res.json(); if (res.status === 401) { location.href = '/login.html'; throw new Error('Session expired.'); }
  if (!res.ok) throw new Error(data.error || 'Request failed.'); return data;
}
function positionValue(p) {
  const q = state.quotes[p.mint]; if (!q?.liquidity) return 0;
  const gross = p.quantity * q.price;
  return Math.max(0, gross * Math.max(0, 1 - p.rules.slippagePct / 100 - Math.min(1, 2 * gross / q.liquidity)) * (1 - p.rules.feePct / 100) - p.rules.networkFeeUsd);
}
function render() {
  const s = state; const now = Date.now(); const pnl = s.equity - s.initialCash;
  $('#equity').textContent = money(s.equity); $('#cash').textContent = `${money(s.cash)} available · simulated USD`;
  $('#pnl').textContent = signed(pnl); $('#pnl').className = cls(pnl);
  $('#count').textContent = s.trades.length;
  const wins = s.trades.filter(t => t.pnl > 0).length;
  $('#win-rate').textContent = s.trades.length ? `${(wins / s.trades.length * 100).toFixed(0)}% wins · ${s.trades.length < 30 ? 'very small sample' : 'experimental results'}` : 'Build a track record first';
  const age = s.lastRefresh ? Math.floor((now - s.lastRefresh) / 1000) : null;
  $('#feed-status').textContent = s.feedError ? 'Unavailable' : age === null ? 'Waiting' : age > 120 ? 'Stale' : 'Receiving';
  $('#latency').textContent = s.latencyMs === null ? 'Checks approximately every minute' : `${s.latencyMs} ms fetch · retrieved ${age}s ago`;
  $('#run-status').textContent = s.halted ? 'Daily loss halt' : s.enabled ? 'Paper strategy running' : 'Paper entries paused';
  $('#toggle').textContent = s.enabled ? 'Pause new entries' : 'Start paper strategy';
  $('#toggle').disabled = !s.enabled && (s.halted || !s.watchlist.length);
  $('#strategy-summary').textContent = `${money(s.rules.positionUsd)} per trade · +${s.rules.takeProfitPct}% target · −${s.rules.stopLossPct}% stop · ${s.rules.maxHoldMinutes} min exit`;
  const blocked = s.positions.filter(p => p.exitBlocked).length;
  const stalePositions = s.positions.some(p => !s.quotes[p.mint] || now - s.quotes[p.mint].fetchedAt > 120000);
  const notice = s.feedError ? `Feed unavailable: ${s.feedError} New entries are blocked; exits cannot be assumed.` : blocked ? `${blocked} exit${blocked > 1 ? 's' : ''} blocked. The paper position remains open and the exit will be retried.` : stalePositions ? 'An open position has a stale quote. Its displayed value is not a current exit quote.' : s.halted ? 'Daily paper loss limit reached. New entries are stopped for this UTC day.' : '';
  $('#notice').hidden = !notice; $('#notice').textContent = notice;
  $('#watchlist').innerHTML = s.watchlist.length ? s.watchlist.map(mint => {
    const q = s.quotes[mint]; const reasons = s.reasons[mint] ?? ['Waiting for quote'];
    const stale = !q || now - q.fetchedAt > 120000;
    return `<article class="token"><div class="token-head"><div class="coin">${esc(q?.symbol ?? short(mint))}<small>${esc(q?.name ?? 'Waiting for a Pump market quote')} · <a class="mint" href="https://solscan.io/token/${encodeURIComponent(mint)}" target="_blank" rel="noopener noreferrer">${esc(short(mint))} ↗</a></small></div><button class="quiet" data-action="unwatch" data-mint="${esc(mint)}" aria-label="Remove ${esc(q?.symbol ?? 'token')}" ${s.positions.some(p => p.mint === mint) ? 'disabled' : ''}>Remove</button></div><div class="token-metrics"><div><span>Past 5m rise</span><strong class="${cls(q?.momentum ?? 0)}">${pct(q?.momentum)}</strong></div><div><span>Liquidity</span><strong>${q?.liquidity == null ? 'Unavailable' : '$' + compact(q.liquidity)}</strong></div><div><span>1h volume</span><strong>${q?.volume1h == null ? 'Unavailable' : '$' + compact(q.volume1h)}</strong></div></div><div class="token-bottom"><span class="reason" title="${esc(reasons.join('; '))}">${stale ? 'Missing or stale quote' : reasons.length ? esc(reasons[0]) : '<span class="positive">Entry rules met · security unverified</span>'}</span><button data-action="buy" data-mint="${esc(mint)}" class="secondary" ${reasons.length || stale || s.feedError ? 'disabled' : ''}>Paper buy</button></div></article>`;
  }).join('') : '<div class="empty"><span class="empty-mark">↗</span><h3>Start with a few coins.</h3><p>Add a token or browse the market sample below. We’ll check each against your entry rules.</p></div>';
  $('#position-count').textContent = `${s.positions.length} OPEN`;
  $('#positions').innerHTML = s.positions.length ? s.positions.map(p => {
    const value = positionValue(p); const net = value - p.cost; const seconds = Math.max(0, Math.floor((p.openedAt + p.rules.maxHoldMinutes * 60000 - now) / 1000));
    return `<article class="position"><div class="token-head"><div class="coin">${esc(p.symbol)}<small>${money(p.cost)} paper entry · rules v${p.ruleVersion}</small></div><strong class="${cls(net)}">${signed(net)}</strong></div><div class="token-metrics"><div><span>After-cost return</span><strong class="${cls(net)}">${pct(net / p.cost * 100)}</strong></div><div><span>Time exit in</span><strong>${Math.floor(seconds / 60)}m ${seconds % 60}s</strong></div><div><span>Exit value estimate</span><strong>${money(value)}</strong></div></div><div class="token-bottom"><span class="reason">${p.exitBlocked ? esc(p.exitBlocked) : `+${p.rules.takeProfitPct}% target / −${p.rules.stopLossPct}% stop`}</span><button class="primary" data-action="close" data-id="${esc(p.id)}">${p.exitRequested ? 'Retry exit' : 'Exit now'}</button></div></article>`;
  }).join('') : '<div class="empty"><span class="empty-mark">◷</span><h3>No trades running.</h3><p>When a watched token meets your rules, try a paper buy or start the paper strategy.</p></div>';
  $('#trades').innerHTML = s.trades.length ? s.trades.slice(0, 100).map(t => `<tr><td><strong>${esc(t.symbol)}</strong> <span class="muted">/ v${t.ruleVersion}</span></td><td>${pct(t.entryMomentum)}</td><td>${((t.closedAt - t.openedAt) / 60000).toFixed(1)} min</td><td>${esc(t.reason)}</td><td class="${cls(t.pnl)}">${signed(t.pnl)}</td><td>${new Date(t.closedAt).toLocaleString()}</td></tr>`).join('') : '<tr><td colspan="6" class="muted">Your first closed paper trade will appear here.</td></tr>';
  if (s.trades.length) {
    const avg = s.trades.reduce((sum, t) => sum + t.pnl, 0) / s.trades.length;
    const hold = s.trades.reduce((sum, t) => sum + (t.closedAt - t.openedAt) / 60000, 0) / s.trades.length;
    const exits = s.trades.reduce((out, t) => { out[t.reason] = (out[t.reason] ?? 0) + 1; return out; }, {});
    const common = Object.entries(exits).sort((a, b) => b[1] - a[1])[0];
    $('#lesson').textContent = `Across ${s.trades.length} closed paper trade${s.trades.length === 1 ? '' : 's'}, the average net result is ${signed(avg)} and the average hold is ${hold.toFixed(1)} minutes. The most common exit is “${common[0]}” (${common[1]}). ${s.trades.length < 30 ? 'This is too small a sample to establish an edge.' : 'These descriptive results do not establish an edge; test unchanged rules on fresh observations.'} ${new Set(s.trades.map(t => t.ruleVersion)).size > 1 ? 'Results combine multiple rule versions; export the data to compare them separately.' : ''}`;
    $('#review-metrics').innerHTML = `<p><span>Average net trade</span><strong class="${cls(avg)}">${signed(avg)}</strong></p><p><span>Average hold</span><strong>${hold.toFixed(1)} min</strong></p><p><span>Best / worst trade</span><strong>${signed(Math.max(...s.trades.map(t => t.pnl)))} / ${signed(Math.min(...s.trades.map(t => t.pnl)))}</strong></p>`;
  }
  if (s.history.length > 1) {
    const values = s.history.map(h => h.equity); const min = Math.min(...values); const max = Math.max(...values); const range = max - min || 1;
    const path = values.map((v, i) => `${i ? 'L' : 'M'}${(i / (values.length - 1) * 630 + 5).toFixed(1)},${(125 - (v - min) / range * 100).toFixed(1)}`).join(' ');
    $('#chart').innerHTML = `<path d="${path}" fill="none" stroke="#b8f56b" stroke-width="2"/><text x="5" y="13" fill="#91a4af" font-size="12">${money(max)}</text><text x="635" y="138" text-anchor="end" fill="#91a4af" font-size="12">${money(min)}</text>`;
    let peak = values[0]; let dd = 0; for (const v of values) { peak = Math.max(peak, v); dd = Math.max(dd, (peak - v) / peak * 100); }
    $('#drawdown').textContent = `Sampled drawdown ${dd.toFixed(2)}%`;
  }
  if (!rulesDirty) for (const [key, value] of Object.entries(s.rules)) { const field = $(`#rules-form [name="${key}"]`); if (field) field.value = value; }
  if (s.insight) { $('#ai-text').textContent = s.insight.text; $('#ai-meta').textContent = `AI interpretation · ${new Date(s.insight.at).toLocaleString()} · ${s.insight.tradeCount} closed trades at review · may contain errors`; }
  $('#rule-version').textContent = `VERSION ${s.ruleVersion}`;
  $('#events').innerHTML = s.events.length ? s.events.slice(0, 40).map(e => `<p><time>${new Date(e.at).toLocaleString()}</time>${esc(e.message)}</p>`).join('') : '<p class="muted">No activity yet.</p>';
}
async function load() { if (loading) return; loading = true; try { state = await api('state'); render(); } catch (e) { toast(e.message); } finally { loading = false; } }
async function action(button, fn) { button.disabled = true; try { await fn(); await load(); } catch (e) { toast(e.message); } finally { button.disabled = false; } }
$('#toggle').addEventListener('click', e => action(e.currentTarget, async () => { await api('toggle', { enabled: !state.enabled }); toast(state.enabled ? 'New entries paused. Exit rules remain active.' : 'Paper strategy started. Only watched coins can be traded.'); }));
$('#refresh').addEventListener('click', e => action(e.currentTarget, async () => { const result = await api('refresh', {}); toast(result.throttled ? 'Quotes were checked recently. Next refresh is available shortly.' : 'Quotes refreshed.'); }));
$('#watch-form').addEventListener('submit', e => { e.preventDefault(); action(e.target.querySelector('button'), async () => { await api('watch', { mint: $('#mint').value.trim() }); $('#mint').value = ''; await api('refresh', {}); toast('Token added to watchlist.'); }); });
$('#rules-form').addEventListener('input', () => { rulesDirty = true; });
$('#rules-form').addEventListener('submit', e => { e.preventDefault(); action(e.target.querySelector('button'), async () => { const rules = Object.fromEntries([...new FormData(e.target)].map(([k, v]) => [k, Number(v)])); await api('rules', { rules }); rulesDirty = false; toast('Rules saved for new paper trades.'); }); });
$('#ai-review').addEventListener('click', e => action(e.currentTarget, async () => { const data = await api('review', {}); toast(data.cached ? 'A review was requested recently. Try again in five minutes.' : 'AI review is ready.'); }));
$('#logout').addEventListener('click', async () => { try { await api('logout', {}); location.href = '/login.html'; } catch (e) { toast(e.message); } });
$('#discover').addEventListener('click', e => action(e.currentTarget, async () => {
  const data = await api('discover'); $('#candidates').innerHTML = data.tokens.length ? data.tokens.map(q => `<div class="candidate"><div class="coin">${esc(q.symbol)} <span class="${cls(q.momentum ?? 0)} small">${pct(q.momentum)} / 5m</span><small>${esc(short(q.mint))} · ${q.liquidity == null ? 'Liquidity unavailable' : '$' + compact(q.liquidity) + ' liquidity'}</small></div><button class="secondary" data-action="watch" data-mint="${esc(q.mint)}">Watch</button></div>`).join('') : '<p class="muted">No Pump markets were returned. You can still paste an exact mint address.</p>';
}));
document.addEventListener('click', e => { const button = e.target.closest('button[data-action]'); if (!button) return;
  action(button, async () => { const name = button.dataset.action; await api(name, { mint: button.dataset.mint, id: button.dataset.id });
    if (name === 'watch') { await api('refresh', {}); button.textContent = 'Watching'; }
    toast(name === 'close' ? 'Exit requested. The position stays open if a fill cannot be modeled.' : name === 'buy' ? 'Paper trade opened. Automatic exit rules are active.' : name === 'unwatch' ? 'Token removed.' : 'Token added.');
  });
});
load(); setInterval(load, 15000);
