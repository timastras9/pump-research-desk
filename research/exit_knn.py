"""Exit levels from a lookup table of similar past launches (k nearest neighbours), no model training.

Lookup table (older launches only): per launch, at the standard entry (engine.buy_decision_time + latency):
  features at the decision second (engine.features, data <= t only), and what happened AFTER entry within the hold:
  peak gain %, seconds to peak, worst drop % before the peak.  (Same definitions as the corpus exit labels.)
Exit plan for a new trade = from its K nearest neighbours in the table (standardised features):
  take-profit = TP_Q quantile of neighbour peak gains (sell all), stop = SL_Q quantile of neighbour pre-peak drops,
  time limit = neighbour median seconds-to-peak + buffer. Decisions fill LATENCY_S later at 3.25% cost per side.
Scored on NEWER launches (chronological split) against rules v3 on the SAME entries. Bootstrap 95% CI.
Usage (Tim runs): PYTHONPATH=. python -m research.exit_knn --db artifacts/corpus/launches.db [--k 25 --tp-q 0.4 --sl-q 0.25]
"""
from __future__ import annotations
import argparse
import numpy as np

from research import engine as E

FEATURES = E.PRICE_FEATURES + E.TAG_FEATURES   # present for every launch (wallet features are often missing)


def outcome(ep: E.Episode, e: int) -> tuple[float, int, float]:
    """After entry second e: peak gain %, seconds to peak, worst drop % before the peak (all vs the entry price)."""
    end = min(E.WINDOW_S, e + E.HOLD_S); seg = ep.price[e:end + 1]; pe = ep.price[e]
    k = int(np.argmax(seg)); pre = seg[:k + 1]
    return (seg[k] / pe - 1) * 100, k, (pre.min() / pe - 1) * 100


def build_table(eps):
    X, Y = [], []
    for ep in eps:
        d = E.buy_decision_time(ep)
        if d is None: continue
        f = E.features(ep, d); X.append([float(f[n]) for n in FEATURES]); Y.append(outcome(ep, d + E.LATENCY_S))
    return np.array(X, dtype=float), np.array(Y, dtype=float)


def knn_policy(table_X, table_Y, k=25, tp_q=0.4, sl_q=0.25, buffer_s=30):
    mu = np.nanmean(table_X, 0); sd = np.nanstd(table_X, 0); sd[sd == 0] = 1
    Z = np.nan_to_num((table_X - mu) / sd)

    def plan(ep, d):
        f = E.features(ep, d); z = np.nan_to_num((np.array([float(f[n]) for n in FEATURES]) - mu) / sd)
        nn = np.argsort(((Z - z) ** 2).sum(1))[:k]; peaks, secs, drops = table_Y[nn, 0], table_Y[nn, 1], table_Y[nn, 2]
        tp = max(5.0, float(np.quantile(peaks, tp_q)))           # at least +5% so costs are covered
        sl = min(-5.0, float(np.quantile(drops, sl_q)))           # at least a 5% stop
        tmax = int(np.median(secs)) + buffer_s
        return tp, sl, tmax

    def make(ep, d):
        tp, sl, tmax = plan(ep, d)
        def policy(ep_, e, t, held, tr):
            pct = (ep_.price[t] / ep_.price[e] - 1) * 100
            if pct >= tp or pct <= sl or t - e >= tmax: return held
            return 0.0
        return policy, (tp, sl, tmax)
    return make


def boot(x, rng, n=4000):
    x = np.array(x); m = rng.choice(x, (n, len(x))).mean(1); return x.mean(), np.percentile(m, 2.5), np.percentile(m, 97.5)


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--db', required=True); ap.add_argument('--k', type=int, default=25)
    ap.add_argument('--tp-q', type=float, default=0.4); ap.add_argument('--sl-q', type=float, default=0.25); ap.add_argument('--limit', type=int, default=0)
    a = ap.parse_args(); rng = np.random.default_rng(0)
    eps = sorted((e for e in E.load_episodes(a.db, min_traded=1) if not e.anomaly and E.buy_decision_time(e) is not None), key=lambda e: e.created)
    if a.limit: eps = eps[-a.limit:]
    cut = int(len(eps) * 0.7); train, test = eps[:cut], eps[cut:]
    tX, tY = build_table(train); make = knn_policy(tX, tY, a.k, a.tp_q, a.sl_q)
    print(f'lookup table: {len(tX)} older launches · scored on {len(test)} newer launches · k={a.k} tp_q={a.tp_q} sl_q={a.sl_q}')
    rules = E.rules_v3(); knn_r, v3_r, plans = [], [], []
    for ep in test:
        d = E.buy_decision_time(ep); pol, pl = make(ep, d); plans.append(pl)
        knn_r.append(E.simulate(ep, pol, decision_t=d).net_return_pct()); v3_r.append(E.simulate(ep, rules, decision_t=d).net_return_pct())
    for name, r in (('rules v3 (current exits)', v3_r), ('kNN exit lookup', knn_r)):
        m, lo, hi = boot(r, rng); r = np.array(r)
        print(f'  {name:26s} n={len(r):5d}  avg {m:6.1f}% [{lo:6.1f}, {hi:6.1f}]  win {(r > 0).mean()*100:3.0f}%  worse than -30%: {(r < -30).mean()*100:3.0f}%  $2 trades {r.sum()*0.02:+8.2f}')
    diff = np.array(knn_r) - np.array(v3_r); m, lo, hi = boot(diff, rng)
    print(f'  kNN minus rules v3 (same trades)  {m:+.1f} pts [{lo:+.1f}, {hi:+.1f}]')
    p = np.array(plans); print(f'  exit plans: take-profit median {np.median(p[:,0]):.0f}%, stop median {np.median(p[:,1]):.0f}%, time limit median {np.median(p[:,2]):.0f} s')


if __name__ == '__main__':
    main()
