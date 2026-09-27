"""One accounting engine and delayed-fill simulator for every strategy (rules, buy models, sell models, RL).

Per Astra's review: every P&L number comes from this file. A decision at second t fills at the price of second
t + LATENCY_S; each fill pays COST_PER_SIDE (1.25% fee + 2% slippage). Features at second t use only data <= t.
"""
from __future__ import annotations
import math, re, sqlite3
from dataclasses import dataclass, field
import numpy as np

LATENCY_S = 2
COST_PER_SIDE = 0.0325
FIRST_SIGHT_S = 5          # live launch feed sees tokens ~3-8 s after creation
DEAD_AFTER_S = 30          # skip if no trade within 30 s of first sight
NO_CHASE = 1.30            # skip if already +30% vs first sight when trading starts
HOLD_S = 600               # forced exit 10 minutes after entry
WINDOW_S = 720             # candles collected for the first 12 minutes

@dataclass
class Episode:
    mint: str
    name: str
    created: int
    creator: str | None
    tags: dict
    price: np.ndarray            # 1 s close, forward-filled, length WINDOW_S + 1
    volume: np.ndarray           # 1 s volume
    trades: dict                 # per-second wallet aggregates (arrays) + wallet sets
    anomaly: bool
    has_trades: bool

def load_episodes(db_path: str, min_traded: int = 20, require_trades: bool = False) -> list[Episode]:
    db = sqlite3.connect(db_path)
    cols = {r[1] for r in db.execute('PRAGMA table_info(tokens)')}
    tcol = ', trades_status' if 'trades_status' in cols else ", 'none'"
    rows = db.execute(f"SELECT mint, created_ts, name, creator, description, image_uri, mayhem{tcol} FROM tokens WHERE candles_status='done' AND candles_n>=? ORDER BY created_ts", (min_traded,)).fetchall()
    out = []
    for mint, created, name, creator, desc, img, mayhem, tstatus in rows:
        p = np.full(WINDOW_S + 1, np.nan); v = np.zeros(WINDOW_S + 1)
        for sec, close, vol in db.execute('SELECT sec, close, volume FROM candles WHERE mint=?', (mint,)):
            if close and close > 0 and 0 <= sec <= WINDOW_S: p[sec] = close; v[sec] = vol or 0
        known = np.where(~np.isnan(p))[0]
        if not len(known): continue
        p[:known[0]] = p[known[0]]
        for i in range(1, WINDOW_S + 1):
            if np.isnan(p[i]): p[i] = p[i - 1]
        jumps = p[1:] / p[:-1]
        anomaly = bool(jumps.max() > 20 or p[:61].max() > 30 * p[0])   # impossible on a bonding curve
        has_trades = tstatus in ('done', 'capped')
        tr = _trade_arrays(db, mint, creator) if has_trades else None
        if require_trades and tr is None: continue
        tags = {'fee_routed': bool(re.search(r'fees? to @\w+', desc or '', re.I)), 'mayhem': bool(mayhem), 'terminal': not (not img or re.search('ipfs|pinata', img or ''))}
        out.append(Episode(mint, name or '', created, creator, tags, p, v, tr, anomaly, has_trades))
    return out

def _trade_arrays(db, mint, creator):
    n = WINDOW_S + 1
    buy_sol = np.zeros(n); sell_sol = np.zeros(n); buys = np.zeros(n); sells = np.zeros(n); dev_buy = np.zeros(n); dev_sell = np.zeros(n)
    first_buy_sec: dict[str, int] = {}; seller_first: dict[str, int] = {}; buy_amount: dict[str, float] = {}; buy_by_sec: list[list] = [[] for _ in range(n)]
    for sec, wallet, side, sol in db.execute('SELECT sec, wallet, side, sol FROM trades WHERE mint=? ORDER BY ts', (mint,)):
        if sec is None or not (0 <= sec <= WINDOW_S): continue
        sol = sol or 0.0
        if side == 'buy':
            buy_sol[sec] += sol; buys[sec] += 1; first_buy_sec.setdefault(wallet, sec); buy_by_sec[sec].append((wallet, sol))
            if wallet and wallet == creator: dev_buy[sec] += sol
        elif side == 'sell':
            sell_sol[sec] += sol; sells[sec] += 1; seller_first.setdefault(wallet, sec)
            if wallet and wallet == creator: dev_sell[sec] += sol
    return {'buy_sol': buy_sol, 'sell_sol': sell_sol, 'buys': buys, 'sells': sells, 'dev_buy': dev_buy, 'dev_sell': dev_sell,
            'first_buy_sec': first_buy_sec, 'seller_first': seller_first, 'buy_by_sec': buy_by_sec}

# ---------- causal features at second t (uses data <= t only) ----------
PRICE_FEATURES = ['since_launch', 'ret_launch', 'active_secs', 'active_share', 'volume_log', 'vol_accel', 'volatility', 'max_rise', 'drop_from_high', 'mom5', 'mom15']
WALLET_FEATURES = ['buyers', 'sellers', 'buyer_seller_ratio', 'buy_sol', 'sell_sol', 'net_sol', 'max_buy_sol', 'top3_share', 'dev_bought_sol', 'dev_sold', 'snipers', 'churn_share']
TAG_FEATURES = ['fee_routed', 'mayhem', 'terminal']

def features(ep: Episode, t: int) -> dict:
    p, v = ep.price, ep.volume; lp = np.log(p)
    r = np.diff(lp[:t + 1]); hi = p[:t + 1].max()
    f = {'since_launch': t, 'ret_launch': (p[t] / p[0] - 1) * 100, 'active_secs': float((v[:t + 1] > 0).sum()), 'active_share': float((v[:t + 1] > 0).mean()),
         'volume_log': math.log1p(v[:t + 1].sum()), 'vol_accel': (v[max(0, t - 4):t + 1].sum() + 1) / (v[:max(1, t - 4)].sum() / max(1, t - 4) * 5 + 1),
         'volatility': float(r.std() * 100) if len(r) > 1 else 0.0, 'max_rise': (hi / p[0] - 1) * 100, 'drop_from_high': (p[t] / hi - 1) * 100,
         'mom5': (p[t] / p[max(0, t - 5)] - 1) * 100, 'mom15': (p[t] / p[max(0, t - 15)] - 1) * 100}
    f.update({k: float(ep.tags[k]) for k in TAG_FEATURES})
    tr = ep.trades
    if tr is None:
        f.update({k: np.nan for k in WALLET_FEATURES}); return f
    buyers = [w for w, s in tr['first_buy_sec'].items() if s <= t]; sellers = [w for w, s in tr['seller_first'].items() if s <= t]
    amounts: dict[str, float] = {}
    for sec in range(t + 1):
        for w, sol in tr['buy_by_sec'][sec]: amounts[w] = amounts.get(w, 0) + sol
    tot = sum(amounts.values()); top3 = sum(sorted(amounts.values(), reverse=True)[:3]) / tot if tot else 0.0
    bs, ss = tr['buy_sol'][:t + 1].sum(), tr['sell_sol'][:t + 1].sum()
    f.update({'buyers': float(len(buyers)), 'sellers': float(len(sellers)), 'buyer_seller_ratio': len(buyers) / max(1, len(sellers)), 'buy_sol': bs, 'sell_sol': ss, 'net_sol': bs - ss,
              'max_buy_sol': max(amounts.values(), default=0.0), 'top3_share': top3, 'dev_bought_sol': tr['dev_buy'][:t + 1].sum(), 'dev_sold': float(tr['dev_sell'][:t + 1].sum() > 0),
              'snipers': float(sum(1 for w, s in tr['first_buy_sec'].items() if s <= 3 and w != ep.creator)),
              'churn_share': len(set(buyers) & set(sellers)) / max(1, len(set(buyers) | set(sellers)))})
    return f

def feature_vector(ep: Episode, t: int, names: list[str]) -> np.ndarray:
    f = features(ep, t); return np.array([f[k] for k in names], dtype=np.float32)

ALL_FEATURES = PRICE_FEATURES + WALLET_FEATURES + TAG_FEATURES

def feature_table(ep: Episode) -> np.ndarray:
    """All features for every second at once (row t uses data <= t only). Same values as features(ep, t), computed
    with running totals so RL can read any second instantly. Cached on the episode."""
    cached = getattr(ep, '_ftable', None)
    if cached is not None: return cached
    n = WINDOW_S + 1; p, v = ep.price, ep.volume; lp = np.log(p); t = np.arange(n)
    ret = np.diff(lp, prepend=lp[0]); c1 = np.cumsum(ret); c2 = np.cumsum(ret ** 2); cnt = np.maximum(t, 1)
    mean = c1 / cnt; var = np.maximum(c2 / cnt - mean ** 2, 0)   # population std of returns 1..t (matches np.std)
    hi = np.maximum.accumulate(p); act = np.cumsum(v > 0); vc = np.cumsum(v)
    last5 = vc - np.concatenate([np.zeros(5), vc[:-5]]); before = np.concatenate([np.zeros(5), vc[:-5]]); nb = np.maximum(t - 4, 1)
    cols = {'since_launch': t.astype(float), 'ret_launch': (p / p[0] - 1) * 100, 'active_secs': act.astype(float), 'active_share': act / (t + 1), 'volume_log': np.log1p(vc),
            'vol_accel': (last5 + 1) / (np.where(t - 4 > 0, before, vc[0]) / nb * 5 + 1), 'volatility': np.where(t > 1, np.sqrt(var) * 100, 0.0), 'max_rise': (hi / p[0] - 1) * 100,
            'drop_from_high': (p / hi - 1) * 100, 'mom5': (p / p[np.maximum(t - 5, 0)] - 1) * 100, 'mom15': (p / p[np.maximum(t - 15, 0)] - 1) * 100}
    for k in TAG_FEATURES: cols[k] = np.full(n, float(ep.tags[k]))
    tr = ep.trades
    if tr is None:
        for k in WALLET_FEATURES: cols[k] = np.full(n, np.nan)
    else:
        buyers_at = np.zeros(n); sellers_at = np.zeros(n); top3 = np.zeros(n); maxb = np.zeros(n); churn = np.zeros(n)
        amounts: dict = {}; buyers: set = set(); sellers: set = set(); first_sell = tr['seller_first']
        sells_by_sec: list = [[] for _ in range(n)]
        for w, sec in first_sell.items():
            if 0 <= sec < n: sells_by_sec[sec].append(w)
        for sec in range(n):
            for w, sol in tr['buy_by_sec'][sec]: amounts[w] = amounts.get(w, 0.0) + sol; buyers.add(w)
            for w in sells_by_sec[sec]: sellers.add(w)
            buyers_at[sec] = len(buyers); sellers_at[sec] = len(sellers); tot = sum(amounts.values())
            top3[sec] = sum(sorted(amounts.values(), reverse=True)[:3]) / tot if tot else 0.0; maxb[sec] = max(amounts.values(), default=0.0)
            u = len(buyers | sellers); churn[sec] = len(buyers & sellers) / max(1, u)
        bs, ss = np.cumsum(tr['buy_sol']), np.cumsum(tr['sell_sol'])
        snipers = float(sum(1 for w, s in tr['first_buy_sec'].items() if s <= 3 and w != ep.creator))
        cols.update({'buyers': buyers_at, 'sellers': sellers_at, 'buyer_seller_ratio': buyers_at / np.maximum(1, sellers_at), 'buy_sol': bs, 'sell_sol': ss, 'net_sol': bs - ss,
                     'max_buy_sol': maxb, 'top3_share': top3, 'dev_bought_sol': np.cumsum(tr['dev_buy']), 'dev_sold': (np.cumsum(tr['dev_sell']) > 0).astype(float),
                     'snipers': np.full(n, snipers), 'churn_share': churn})
    table = np.stack([cols[k] for k in ALL_FEATURES], axis=1).astype(np.float32)
    ep._ftable = table
    return table

# ---------- entry schedule (causal) ----------
def buy_decision_time(ep: Episode) -> int | None:
    """First trade after first sight, within DEAD_AFTER_S; None if dead or already pumped (no chase)."""
    p = ep.price; s0 = FIRST_SIGHT_S
    for t in range(s0 + 1, min(s0 + DEAD_AFTER_S, WINDOW_S - LATENCY_S) + 1):
        if p[t] != p[s0]:
            return None if p[t] >= p[s0] * NO_CHASE else t
    return None

# ---------- accounting ----------
@dataclass
class Trade:
    mint: str
    decision_t: int
    entry_t: int
    entry_price: float
    fills: list = field(default_factory=list)        # (decision_t, fill_t, fraction, price)
    def net_return_pct(self) -> float:
        outlay = 1.0 * (1 + COST_PER_SIDE)              # $1 notional at entry price, cost on the buy side
        proceeds = sum(frac * (price / self.entry_price) * (1 - COST_PER_SIDE) for _, _, frac, price in self.fills)
        return (proceeds / outlay - 1) * 100

def simulate(ep: Episode, sell_policy, decision_t: int | None = None) -> Trade | None:
    """Run one position through the delayed-fill market. sell_policy(ep, entry_t, t, held_fraction, trade) -> fraction of the
    ORIGINAL position to sell at t (0 = hold). Orders fill LATENCY_S later; one pending order at a time; forced exit at the horizon."""
    d = buy_decision_time(ep) if decision_t is None else decision_t
    if d is None: return None
    e = d + LATENCY_S; p = ep.price; end = min(WINDOW_S, e + HOLD_S)
    tr = Trade(ep.mint, d, e, float(p[e])); held = 1.0; pending_until = -1
    for t in range(e + 1, end):
        if held <= 1e-9: break
        if t < pending_until: continue
        frac = min(held, float(sell_policy(ep, e, t, held, tr)))
        if frac > 1e-9:
            f = min(t + LATENCY_S, end); tr.fills.append((t, f, frac, float(p[f]))); held -= frac; pending_until = f
    if held > 1e-9: tr.fills.append((end, end, held, float(p[end])))   # forced liquidation at the horizon
    return tr

def summarize(returns: list[float], seed: int = 0) -> dict:
    a = np.array([x for x in returns if x is not None], dtype=float)
    if not len(a): return {'trades': 0}
    rng = np.random.default_rng(seed); boot = [rng.choice(a, len(a)).mean() for _ in range(500)]
    eq = np.cumsum(a); dd = float((eq - np.maximum.accumulate(eq)).min())
    return {'trades': int(len(a)), 'avg_pct': round(float(a.mean()), 2), 'avg_ci95': [round(float(np.percentile(boot, 2.5)), 2), round(float(np.percentile(boot, 97.5)), 2)],
            'median_pct': round(float(np.median(a)), 2), 'win_rate': round(float((a > 0).mean()), 3), 'total_usd_on_2': round(float(a.sum() * 0.02), 2),
            'p5_pct': round(float(np.percentile(a, 5)), 1), 'max_drawdown_usd_on_2': round(dd * 0.02, 2)}

# ---------- rule policies ----------
def rules_v3(take=30, window=60, part=0.5, check_at=60, check_min=5, stop=25, trail=30, arm=20):
    """The live paper-trading rules (paper-v3), expressed in the engine for like-for-like comparison."""
    def policy(ep, e, t, held, tr):
        p = ep.price; pct = (p[t] / p[e] - 1) * 100; hi = p[e:t + 1].max(); el = t - e
        took = any(True for _ in tr.fills)
        if pct <= -stop: return held
        if not took and el <= window and pct >= take: return part if part < 1 else held
        if not took and el == check_at and hi < p[e] * (1 + check_min / 100): return held
        if hi >= p[e] * (1 + arm / 100) and p[t] <= hi * (1 - trail / 100): return held
        return 0.0
    return policy

def hold_policy(ep, e, t, held, tr): return 0.0
