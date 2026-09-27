"""Tim's exit rule vs rules v3 on the same entries (corpus, research/engine.py: 2 s fills, 3.25% cost per side).
Rule: before the position is up ARM%, stop at -BASE_STOP% from entry. Once up ARM% or more: take profit at +TP%,
stop at -STOP% from the high since entry (trailing). Always: sell after DOWN consecutive falling 1 s candles.
Forced exit 10 min after entry. Chronological halves shown so one lucky stretch can't fake it.
Usage: PYTHONPATH=. python -m research.exit_rule_tim --db artifacts/corpus/launches.db [--arm 20 --tp 100 --stop 10 --down 5 --base-stop 25 --entry model|30]
"""
import argparse
import numpy as np
from research import engine as E


def tim_policy(arm=20, tp=100, stop=10, down=5, base_stop=25):
    def policy(ep, e, t, held, tr):
        p = ep.price; pe = p[e]; hi = p[e:t + 1].max(); pct = (p[t] / pe - 1) * 100
        if t - e >= down and all(p[k] < p[k - 1] for k in range(t - down + 1, t + 1)): return held      # N falling candles
        if (hi / pe - 1) * 100 >= arm:
            if pct >= tp or p[t] <= hi * (1 - stop / 100): return held
        elif pct <= -base_stop: return held
        return 0.0
    return policy


def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--db', required=True)
    for k, d in (('arm', 20), ('tp', 100), ('stop', 10), ('down', 5), ('base-stop', 25)): ap.add_argument(f'--{k}', type=float, default=d)
    ap.add_argument('--entry', default='model'); a = ap.parse_args(); rng = np.random.default_rng(0)
    eps = sorted((e for e in E.load_episodes(a.db, min_traded=1) if not e.anomaly), key=lambda e: e.created)
    entry = (lambda ep: E.buy_decision_time(ep)) if a.entry == 'model' else (lambda ep: int(a.entry) if (ep.volume[int(a.entry) - 9:int(a.entry) + 1] > 0).any() else None)
    pol, v3 = tim_policy(a.arm, a.tp, a.stop, int(a.down), a.base_stop), E.rules_v3()
    rows = [(E.simulate(ep, pol, decision_t=d).net_return_pct(), E.simulate(ep, v3, decision_t=d).net_return_pct()) for ep in eps if (d := entry(ep)) is not None]
    r = np.array(rows); half = len(r) // 2
    print(f'{len(r)} trades · entry={a.entry} · arm {a.arm}% tp {a.tp}% trail stop {a.stop}% down-candles {int(a.down)} base stop {a.base_stop}%')
    for part, sl in (('all', slice(None)), ('older half', slice(0, half)), ('newer half', slice(half, None))):
        x = r[sl]; diff = x[:, 0] - x[:, 1]; m = rng.choice(diff, (4000, len(diff))).mean(1)
        print(f' {part:10s} Tim rule avg {x[:,0].mean():6.1f}% win {(x[:,0]>0).mean()*100:3.0f}% ${x[:,0].sum()*0.02:+8.2f} | rules v3 avg {x[:,1].mean():6.1f}% ${x[:,1].sum()*0.02:+8.2f} | difference {diff.mean():+.1f} pts [{np.percentile(m,2.5):+.1f}, {np.percentile(m,97.5):+.1f}]')


if __name__ == '__main__':
    main()
