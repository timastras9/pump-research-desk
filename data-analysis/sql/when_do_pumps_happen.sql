-- When do launches pump, and what would "wait 60 s, then buy" have returned?
-- Price at second s = close of the last 1 s candle at or before s. Launch price = open of the first candle.
-- Entry for a buy decided at 60 s fills at 62 s (the 2 s delay used everywhere else).
WITH c AS (
  SELECT c.* FROM candles c JOIN tokens t USING(mint) WHERE t.candles_status='done'
),
base AS (
  SELECT mint,
    (SELECT open FROM c c2 WHERE c2.mint=c.mint ORDER BY sec LIMIT 1) AS p0,
    MAX(sec) AS last_sec
  FROM c GROUP BY mint
),
peak AS (
  SELECT mint, sec AS peak_sec, high AS peak_high FROM (
    SELECT mint, sec, high, ROW_NUMBER() OVER (PARTITION BY mint ORDER BY high DESC, sec) rn FROM c
  ) WHERE rn=1
),
per AS (
  SELECT b.mint, b.p0, b.last_sec, p.peak_sec, p.peak_high,
    (SELECT close FROM c x WHERE x.mint=b.mint AND x.sec<=62 ORDER BY sec DESC LIMIT 1) AS p62,
    (SELECT MAX(high) FROM c x WHERE x.mint=b.mint AND x.sec>62) AS max_after,
    (SELECT close FROM c x WHERE x.mint=b.mint AND x.sec<=600 ORDER BY sec DESC LIMIT 1) AS p600,
    (SELECT MAX(high) FROM c x WHERE x.mint=b.mint AND x.sec<=60) AS max_first60
  FROM base b JOIN peak p USING(mint) WHERE b.p0>0
)
SELECT * FROM per;
