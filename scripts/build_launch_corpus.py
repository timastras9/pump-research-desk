#!/usr/bin/env python3
"""Collect a launch corpus into SQLite: every new pump.fun coin plus its first 12 minutes of 1s candles.

Free public endpoints only (frontend-api-v3 newest-coins list, coins-v2 record, swap-api candles).
Polls forward because the public list only reaches a few thousand coins back.

  python3 scripts/build_launch_corpus.py --db artifacts/corpus/launches.db --target 5000
"""
import argparse, json, sqlite3, time, urllib.error, urllib.request

LIST = 'https://frontend-api-v3.pump.fun/coins?offset=0&limit=50&sort=created_timestamp&order=DESC&includeNsfw=false'
COIN = 'https://frontend-api-v3.pump.fun/coins-v2/{mint}'
TRADES = ('https://swap-api.pump.fun/v2/coins/{mint}/trades?limit=100&cursor={cursor}&program=pump&minSolAmount=0'
          '&chainId=solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp&createdTs={created}')
MAX_TRADE_PAGES = 30   # 3,000 trades: enough to cover the first 12 minutes of all but the busiest launches
CANDLES = ('https://swap-api.pump.fun/v2/coins/{mint}/candles?interval=1s&limit=1000&currency=USD'
           '&createdTs={created}&program=pump&chainId=solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp')
HEADERS = {'User-Agent': 'Mozilla/5.0', 'Origin': 'https://pump.fun', 'Accept': 'application/json'}
WINDOW_S = 720          # first 12 minutes after creation
READY_AFTER_MS = 13 * 60 * 1000

SCHEMA = """
CREATE TABLE IF NOT EXISTS tokens(mint TEXT PRIMARY KEY, created_ts INTEGER, first_seen_ts INTEGER, name TEXT, symbol TEXT,
  creator TEXT, image_uri TEXT, description TEXT, twitter TEXT, website TEXT, mayhem INTEGER, cap_at_seen_usd REAL,
  candles_status TEXT DEFAULT 'pending', candles_n INTEGER, fetched_ts INTEGER, trades_status TEXT DEFAULT 'pending', trades_n INTEGER);
CREATE TABLE IF NOT EXISTS candles(mint TEXT, sec INTEGER, open REAL, high REAL, low REAL, close REAL, volume REAL, PRIMARY KEY(mint, sec));
CREATE TABLE IF NOT EXISTS trades(mint TEXT, ts INTEGER, sec INTEGER, wallet TEXT, side TEXT, sol REAL, usd REAL, tokens REAL, tx TEXT, PRIMARY KEY(mint, tx, wallet, side));
CREATE INDEX IF NOT EXISTS trades_mint ON trades(mint, sec);
CREATE TABLE IF NOT EXISTS fetch_log(ts INTEGER, url TEXT, status INTEGER, note TEXT);
"""

def get(db, url):
    for attempt in range(6):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=HEADERS), timeout=20) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            db.execute('INSERT INTO fetch_log VALUES(?,?,?,?)', (int(time.time() * 1000), url[:200], e.code, 'retry' if e.code == 429 else 'error'))
            if e.code == 429:
                time.sleep(2 * (attempt + 1)); continue
            return None
        except Exception as e:
            db.execute('INSERT INTO fetch_log VALUES(?,?,?,?)', (int(time.time() * 1000), url[:200], 0, str(e)[:120]))
            time.sleep(2)
    return None

def fetch_trades(db, mint, created):
    # Wallet-level trades for the first 12 minutes (newest-first pages, walked back to launch).
    import urllib.parse, datetime as dt
    cursor, n, pages = '0', 0, 0
    while pages < MAX_TRADE_PAGES:
        d = get(db, TRADES.format(mint=mint, cursor=urllib.parse.quote(cursor), created=created)); pages += 1
        if not d: break
        oldest = None
        for x in d.get('trades', []):
            ts = int(dt.datetime.fromisoformat(x['timestamp'].replace('Z', '+00:00')).timestamp() * 1000); sec = (ts - created) // 1000; oldest = sec
            if 0 <= sec <= WINDOW_S:
                db.execute('INSERT OR IGNORE INTO trades VALUES(?,?,?,?,?,?,?,?,?)', (mint, ts, sec, x.get('userAddress'), x.get('type'), float(x.get('amountSol') or 0), float(x.get('amountUsd') or 0), float(x.get('baseAmount') or 0), x.get('tx'))); n += 1
        pg = d.get('pagination') or {}
        if not pg.get('hasMore') or not pg.get('nextCursor') or (oldest is not None and oldest < 0): break
        cursor = pg['nextCursor']; time.sleep(0.35)
    db.execute("UPDATE tokens SET trades_status=?, trades_n=? WHERE mint=?", ('done' if pages < MAX_TRADE_PAGES else 'capped', n, mint))

def poll_new(db):
    rows = get(db, LIST) or []
    rows = rows if isinstance(rows, list) else rows.get('coins', [])
    now = int(time.time() * 1000)
    for c in rows:
        if isinstance(c, dict) and c.get('mint') and c.get('created_timestamp'):
            db.execute('INSERT OR IGNORE INTO tokens(mint,created_ts,first_seen_ts,name,symbol,creator,image_uri,cap_at_seen_usd) VALUES(?,?,?,?,?,?,?,?)',
                       (c['mint'], int(c['created_timestamp']), now, str(c.get('name', ''))[:80], str(c.get('symbol', ''))[:20],
                        c.get('creator'), str(c.get('image_uri', ''))[:300], c.get('usd_market_cap')))

def fetch_ready(db, limit):
    cutoff = int(time.time() * 1000) - READY_AFTER_MS
    for mint, created in db.execute("SELECT mint, created_ts FROM tokens WHERE candles_status='pending' AND created_ts<? ORDER BY created_ts LIMIT ?", (cutoff, limit)).fetchall():
        coin = get(db, COIN.format(mint=mint)) or {}
        candles = get(db, CANDLES.format(mint=mint, created=created))
        if candles is None:
            db.execute("UPDATE tokens SET candles_status='failed', fetched_ts=? WHERE mint=?", (int(time.time() * 1000), mint)); continue
        kept = 0
        for x in candles:
            sec = int((x['timestamp'] - created) / 1000)
            if 0 <= sec <= WINDOW_S:
                db.execute('INSERT OR REPLACE INTO candles VALUES(?,?,?,?,?,?,?)', (mint, sec, float(x['open']), float(x['high']), float(x['low']), float(x['close']), float(x.get('volume') or 0)))
                kept += 1
        if kept >= 5: fetch_trades(db, mint, created)
        else: db.execute("UPDATE tokens SET trades_status='skipped-inactive' WHERE mint=?", (mint,))
        db.execute("UPDATE tokens SET candles_status='done', candles_n=?, fetched_ts=?, description=?, twitter=?, website=?, mayhem=? WHERE mint=?",
                   (kept, int(time.time() * 1000), str(coin.get('description') or '')[:500], coin.get('twitter'), coin.get('website'), 1 if coin.get('mayhem_state') else 0, mint))
        time.sleep(0.4)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--db', required=True); ap.add_argument('--target', type=int, default=5000); ap.add_argument('--poll', type=float, default=10); ap.add_argument('--backfill-trades', action='store_true')
    a = ap.parse_args()
    db = sqlite3.connect(a.db, isolation_level=None); db.executescript(SCHEMA)
    cols = {r[1] for r in db.execute('PRAGMA table_info(tokens)')}
    for c, ddl in (('trades_status', "TEXT DEFAULT 'pending'"), ('trades_n', 'INTEGER')):
        if c not in cols: db.execute(f'ALTER TABLE tokens ADD COLUMN {c} {ddl}')
    last_report = 0
    if a.backfill_trades:
        todo = db.execute("SELECT mint, created_ts FROM tokens WHERE candles_status='done' AND candles_n>=5 AND (trades_status IS NULL OR trades_status='pending') ORDER BY created_ts").fetchall()
        for i, (mint, created) in enumerate(todo):
            fetch_trades(db, mint, created)
            if i % 100 == 0: print(f"{time.strftime('%H:%M:%S')} backfill {i}/{len(todo)}", flush=True)
        print('backfill done', flush=True); return
    while True:
        poll_new(db); fetch_ready(db, 20)
        done = db.execute("SELECT COUNT(*) FROM tokens WHERE candles_status='done'").fetchone()[0]
        if time.time() - last_report > 300:
            seen = db.execute('SELECT COUNT(*) FROM tokens').fetchone()[0]
            active = db.execute("SELECT COUNT(*) FROM tokens WHERE candles_n>=5").fetchone()[0]
            print(f"{time.strftime('%H:%M:%S')} seen {seen} · candles done {done} · active (>=5 traded seconds) {active}", flush=True); last_report = time.time()
        if done >= a.target: break
        time.sleep(a.poll)

if __name__ == '__main__':
    main()
