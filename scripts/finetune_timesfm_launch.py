#!/usr/bin/env python3
"""LoRA fine-tune TimesFM 2.5 on pump.fun launch price paths, then score it against zero-shot and a trend baseline.

Task: at T seconds after launch, see the last CONTEXT seconds of log price, forecast the next HORIZON seconds.
Split by launch time (oldest 70% train, next 15% validation, newest 15% test) so the test set is the future.
The best adapter is chosen on validation loss only. The test set is scored once, paired on the same windows.

  python scripts/finetune_timesfm_launch.py --db artifacts/corpus/launches.db --out artifacts/corpus/lora-v1
"""
import argparse, hashlib, json, math, os, sqlite3, subprocess, time
import numpy as np, torch
from torch.utils.data import DataLoader, TensorDataset

MODEL_ID = 'google/timesfm-2.5-200m-transformers'
DECISIONS = (60, 90, 120, 150, 180)
COST = 0.0325

def load_paths(db_path, min_traded):
    db = sqlite3.connect(db_path)
    toks = db.execute("SELECT mint, created_ts FROM tokens WHERE candles_status='done' AND candles_n>=? ORDER BY created_ts", (min_traded,)).fetchall()
    paths = []
    for mint, created in toks:
        grid = np.full(721, np.nan)
        for sec, close in db.execute('SELECT sec, close FROM candles WHERE mint=? ORDER BY sec', (mint,)):
            if close and close > 0: grid[sec] = math.log(close)
        known = np.where(~np.isnan(grid))[0]
        if not len(known): continue
        grid[:known[0]] = grid[known[0]]
        for i in range(1, 721):
            if np.isnan(grid[i]): grid[i] = grid[i - 1]
        paths.append((mint, created, grid))
    return paths

def windows(paths, context, horizon):
    xs, ys = [], []
    for _, _, g in paths:
        for T in DECISIONS:
            if T + horizon > 720: continue
            ctx = g[max(0, T - context + 1):T + 1]
            ctx = np.concatenate([np.full(context - len(ctx), g[0]), ctx]) - g[T]   # relative to the price at the decision
            # A flat context has ~zero spread; TimesFM's per-window scaling then divides by ~0 and the loss explodes.
            if np.std(ctx) < 5e-3: continue   # below 0.5% spread the context is effectively flat
            xs.append(ctx); ys.append(g[T + 1:T + 1 + horizon] - g[T])
    # Cap log moves at +-3 (about 20x up / -95% down): single bad ticks (300x in 2 min seen in the data) otherwise dominate the loss.
    return torch.tensor(np.clip(np.array(xs), -3, 3), dtype=torch.float32), torch.tensor(np.clip(np.array(ys), -3, 3), dtype=torch.float32)

def wilson(k, n, z=1.96):
    if not n: return (None, None)
    p = k / n; d = 1 + z * z / n; c = p + z * z / (2 * n); m = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (round((c - m) / d, 3), round((c + m) / d, 3))

def forecast(model, x, context, horizon, device, bs=64):
    out = []
    with torch.no_grad():
        for i in range(0, len(x), bs):
            o = model(past_values=x[i:i + bs].to(device), forecast_context_len=context)
            out.append(o.mean_predictions[:, :horizon].float().cpu())
    return torch.cat(out).numpy()

def score(pred_end, actual_end, momentum):
    big = np.abs(actual_end) > 0.05
    def acc(sig):
        k = int((np.sign(sig[big]) == np.sign(actual_end[big])).sum()); n = int(big.sum())
        return {'right': k, 'n': n, 'rate': round(k / n, 3) if n else None, 'ci95': wilson(k, n)}
    rank = lambda a: np.argsort(np.argsort(a))
    corr = lambda a, b: round(float(np.corrcoef(rank(a), rank(b))[0, 1]), 3)
    hold_if_up = lambda sig: round(float(np.mean(np.where(sig > 0, np.exp(actual_end) - 1, 0.0))), 4)
    return {'direction_on_moves_gt5pct': acc(pred_end), 'rank_corr': corr(pred_end, actual_end), 'hold_if_forecast_up_avg_return': hold_if_up(pred_end),
            'momentum_direction': acc(momentum), 'momentum_hold_if_up': hold_if_up(momentum), 'always_hold_avg_return': round(float(np.mean(np.exp(actual_end) - 1)), 4), 'always_sell_avg_return': 0.0}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True); ap.add_argument('--out', required=True)
    ap.add_argument('--epochs', type=int, default=3); ap.add_argument('--batch', type=int, default=32); ap.add_argument('--lr', type=float, default=5e-5)
    ap.add_argument('--lora_r', type=int, default=8); ap.add_argument('--context', type=int, default=128); ap.add_argument('--horizon', type=int, default=120)
    ap.add_argument('--min_traded', type=int, default=5, help='keep tokens with at least this many traded seconds')
    a = ap.parse_args(); os.makedirs(a.out, exist_ok=True)
    from transformers import TimesFm2_5ModelForPrediction
    from peft import LoraConfig, get_peft_model
    device = 'mps' if torch.backends.mps.is_available() else 'cuda' if torch.cuda.is_available() else 'cpu'
    paths = load_paths(a.db, a.min_traded); n = len(paths)
    tr, va, te = paths[:int(n * .7)], paths[int(n * .7):int(n * .85)], paths[int(n * .85):]
    (xtr, ytr), (xva, yva), (xte, yte) = (windows(p, a.context, a.horizon) for p in (tr, va, te))
    config = {k: v for k, v in vars(a).items()} | {'model': MODEL_ID, 'decisions': DECISIONS, 'tokens': {'train': len(tr), 'val': len(va), 'test': len(te)}, 'windows': {'train': len(xtr), 'val': len(xva), 'test': len(xte)},
              'test_launch_range': [te[0][1], te[-1][1]] if te else None}
    try: config['git'] = {'sha': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(), 'dirty': bool(subprocess.check_output(['git', 'status', '--porcelain', 'scripts'], text=True).strip())}
    except Exception: pass
    config['config_sha256'] = hashlib.sha256(json.dumps(config, sort_keys=True, default=str).encode()).hexdigest()[:16]
    print(json.dumps(config, default=str), flush=True)
    model = TimesFm2_5ModelForPrediction.from_pretrained(MODEL_ID, torch_dtype=torch.float32).to(device)
    model = get_peft_model(model, LoraConfig(r=a.lora_r, lora_alpha=2 * a.lora_r, target_modules='all-linear', lora_dropout=0.05, bias='none'))
    model.print_trainable_parameters()
    opt = torch.optim.AdamW([p for p in model.parameters() if p.requires_grad], lr=a.lr, weight_decay=0.01)
    loader = DataLoader(TensorDataset(xtr, ytr), batch_size=a.batch, shuffle=True, drop_last=len(xtr) > a.batch)
    def val_loss():
        model.eval(); tot = cnt = 0
        with torch.no_grad():
            for i in range(0, len(xva), 64):
                tot += model(past_values=xva[i:i + 64].to(device), future_values=yva[i:i + 64].to(device), forecast_context_len=a.context).loss.item(); cnt += 1
        return tot / max(cnt, 1)
    with model.disable_adapter(): base_val = val_loss()
    best = float('inf'); history = [{'epoch': 0, 'val_loss': round(base_val, 6), 'note': 'zero-shot'}]
    for ep in range(1, a.epochs + 1):
        model.train(); t0 = time.time(); tl = []
        for x, y in loader:
            loss = model(past_values=x.to(device), future_values=y.to(device), forecast_context_len=a.context).loss
            loss.backward(); torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0); opt.step(); opt.zero_grad(); tl.append(loss.item())
        v = val_loss(); history.append({'epoch': ep, 'train_loss': round(float(np.mean(tl)), 6), 'val_loss': round(v, 6), 'seconds': round(time.time() - t0)})
        print(json.dumps(history[-1]), flush=True)
        if v < best: best = v; model.save_pretrained(a.out)
    # test: reload best adapter, score LoRA and zero-shot on identical windows
    from peft import PeftModel
    base = TimesFm2_5ModelForPrediction.from_pretrained(MODEL_ID, torch_dtype=torch.float32).to(device); base.eval()
    zero = forecast(base, xte, a.context, a.horizon, device)
    tuned_model = PeftModel.from_pretrained(base, a.out).to(device); tuned_model.eval()
    tuned = forecast(tuned_model, xte, a.context, a.horizon, device)
    actual = yte[:, -1].numpy(); mom = (xte[:, -1] - xte[:, -31]).numpy()
    zs, ls = score(zero[:, -1], actual, mom), score(tuned[:, -1], actual, mom)
    big = np.abs(actual) > 0.05
    zr, lr_ = np.sign(zero[big, -1]) == np.sign(actual[big]), np.sign(tuned[big, -1]) == np.sign(actual[big])
    result = {'config': config, 'history': history, 'best_val_loss': best, 'zero_shot_val_loss': base_val, 'test': {'zero_shot': zs, 'lora': ls,
              'paired_direction': {'lora_right_zero_wrong': int((lr_ & ~zr).sum()), 'zero_right_lora_wrong': int((zr & ~lr_).sum())}},
              'costs_note': f'Returns are gross displayed-price moves over the horizon; a trade also pays about {COST*100:.2f}% per side.'}
    json.dump(result, open(os.path.join(a.out, 'results.json'), 'w'), indent=1, default=str)
    print(json.dumps(result['test'], indent=1, default=str))

if __name__ == '__main__':
    main()
