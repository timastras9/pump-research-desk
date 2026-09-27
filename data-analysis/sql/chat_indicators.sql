-- =============================================================================
-- CHAT INDICATORS: do tokens with early pump.fun chat comments trade better?
-- =============================================================================
-- Source: D1 crypto-study, study_tokens.data.chatWindows (one entry per window of N seconds after recording start).
-- Buy-time safe: uses the 60 s chat window only (known before a 60 s+ decision; windows stored: 60, 120, 600 s). Outcomes (paper P&L, final change)
-- are labels only. A trade = $.paper.status = 'closed'. Excluded tokens left out.
-- Run: npx wrangler d1 execute crypto-study --remote --file data-analysis/sql/chat_indicators.sql  (use --command
--      with the SQL on one line to see rows; --file on --remote does not print results)
-- =============================================================================
WITH w AS (
  SELECT t.id,
         json_extract(t.data,'$.paper.status')              AS status,
         json_extract(t.data,'$.paper.pnlPct')              AS pnl_pct,
         json_extract(t.data,'$.paper.pnlUsd')              AS pnl_usd,
         json_extract(t.data,'$.metrics.changePct')         AS final_pct,
         (SELECT json_extract(c.value,'$.uniqueComments') FROM json_each(t.data,'$.chatWindows') c
           WHERE json_extract(c.value,'$.seconds') = 60)    AS comments_60s,
         (SELECT json_extract(c.value,'$.sentiment.negativeComments') FROM json_each(t.data,'$.chatWindows') c
           WHERE json_extract(c.value,'$.seconds') = 60)    AS negative_60s
  FROM study_tokens t
  WHERE COALESCE(json_extract(t.data,'$.excluded'),0) = 0
)
SELECT CASE WHEN comments_60s IS NULL THEN 'no chat data'
            WHEN comments_60s = 0 THEN '0 comments by 60 s'
            WHEN comments_60s <= 2 THEN '1-2 comments'
            ELSE '3+ comments' END                          AS chat_by_60s,
       COUNT(*)                                             AS tokens,
       SUM(status = 'closed')                               AS trades,
       ROUND(AVG(CASE WHEN status='closed' THEN pnl_pct END),2) AS avg_paper_pct,
       ROUND(SUM(CASE WHEN status='closed' THEN pnl_usd END),2) AS paper_usd,
       SUM(final_pct > 7)                                   AS winners,
       SUM(final_pct <= -50)                                AS tanked,
       SUM(negative_60s > 0)                                AS with_negative_comment
FROM w GROUP BY 1 ORDER BY 1;
