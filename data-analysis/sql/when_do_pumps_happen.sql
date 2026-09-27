-- =============================================================================
-- WHEN DO LAUNCHES PUMP? AND WHAT WOULD "WAIT 60 S, THEN BUY" HAVE RETURNED?
-- =============================================================================
-- Question (Tim, 2026-09-26): "Why don't we just wait 60 seconds to buy? Nothing
-- really pumps that much the first minute."
--
-- Source:  artifacts/corpus/launches.db (candles = 1 s OHLCV per token, sec 0..720
--          counted from launch). Only tokens with candles_status='done'.
-- Run:     sqlite3 -csv -header artifacts/corpus/launches.db \
--            < data-analysis/sql/when_do_pumps_happen.sql > pumps.csv
--          python data-analysis/when_do_pumps_happen.py pumps.csv
--
-- Conventions (same as research/engine.py):
--   * Price at second s = close of the last candle at or before s (candles are
--     sparse: a second with no trades has no row).
--   * Launch price p0 = open of the token's first candle.
--   * A buy decided at 60 s fills at 62 s (the 2 s delay used everywhere else).
--   * Exit for "hold" = price at 600 s (end of the 10-minute window).
--   * Costs (3.25% per side) are applied in the Python summary, not here.
--
-- Output: one row per token.
--   mint         token address
--   p0           launch price (first candle open)
--   last_sec     last second with any trade (<= 62 means the token died in minute 1)
--   peak_sec     second of the highest high over the whole window (earliest if tied)
--   peak_high    that highest price
--   p62          fill price for a buy decided at 60 s
--   max_after    highest price after 62 s (best possible exit, hindsight)
--   p600         price at 10 minutes (hold-to-end exit)
--   max_first60  highest price in the first 60 s
--
-- Result on 5,753 tokens (2026-09-26):
--   73% of all peaks happen in the first 60 s (53% in the first 5 s).
--   32% of tokens have no trades after 62 s.
--   Buying at 62 s and holding to 10 min: avg -13.3%, 7% win after costs.
--   Even with a perfect exit, 76% of tokens never give +10% after 62 s.
-- =============================================================================

-- c: 1 s candles for tokens whose candle download finished.
WITH c AS (
  SELECT c.* FROM candles c JOIN tokens t USING(mint) WHERE t.candles_status='done'
),

-- base: launch price and the last second with a trade, per token.
base AS (
  SELECT mint,
    (SELECT open FROM c c2 WHERE c2.mint=c.mint ORDER BY sec LIMIT 1) AS p0,
    MAX(sec) AS last_sec
  FROM c GROUP BY mint
),

-- peak: the single highest high per token and the second it happened.
peak AS (
  SELECT mint, sec AS peak_sec, high AS peak_high FROM (
    SELECT mint, sec, high, ROW_NUMBER() OVER (PARTITION BY mint ORDER BY high DESC, sec) rn FROM c
  ) WHERE rn=1
),

-- per: the prices the "wait 60 s" strategy needs, one row per token.
per AS (
  SELECT b.mint, b.p0, b.last_sec, p.peak_sec, p.peak_high,
    -- fill for a buy decided at 60 s (+2 s delay)
    (SELECT close FROM c x WHERE x.mint=b.mint AND x.sec<=62 ORDER BY sec DESC LIMIT 1) AS p62,
    -- best price reachable after entry (hindsight ceiling; NULL if no trades after 62 s)
    (SELECT MAX(high) FROM c x WHERE x.mint=b.mint AND x.sec>62) AS max_after,
    -- price at 10 minutes (hold-to-end exit)
    (SELECT close FROM c x WHERE x.mint=b.mint AND x.sec<=600 ORDER BY sec DESC LIMIT 1) AS p600,
    -- highest price during the first minute (what waiting gives up)
    (SELECT MAX(high) FROM c x WHERE x.mint=b.mint AND x.sec<=60) AS max_first60
  FROM base b JOIN peak p USING(mint) WHERE b.p0>0
)
SELECT * FROM per;
