-- The view every backtest reads. `episodes` is never queried directly.
--
-- Two kinds of column are added here rather than stored:
--
-- 1. Reputation counts (`dev_launch_count`, `handle_launch_count`) are counts of
--    PRIOR launches. Storing them would be wrong: the value changes every time
--    that dev launches again, so a stored column is correct only until the next
--    launch and rots silently after. The frame `UNBOUNDED PRECEDING TO 1
--    PRECEDING` ordered by t0 is what makes them point-in-time honest — an
--    episode counts only launches that had already happened when it began.
--    Serial deployers are common: one x.com handle took 27 launches in a single
--    two-hour sample.
--
-- 2. LLM scores are joined, not stored, because they are produced asynchronously
--    after extraction. A stored column would be empty for every episode
--    extracted before its coin was scored.

CREATE OR REPLACE VIEW episodes_enriched AS
SELECT
    e.*,
    count() OVER (
        PARTITION BY e.dev_wallet, e.horizon_s
        ORDER BY e.t0 ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ) AS dev_launch_count,
    -- An empty handle would otherwise lump every socials-less coin into one
    -- giant "account" and hand them all an enormous launch count.
    if(e.twitter_handle = '', 0, count() OVER (
        PARTITION BY e.twitter_handle, e.horizon_s
        ORDER BY e.t0 ASC
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    )) AS handle_launch_count,
    -- 0 means "not scored", which is distinct from a genuine low score. Filters
    -- on llm_score therefore also exclude unscored coins, which is the correct
    -- and conservative reading: an unscored coin is not a passing coin.
    ifNull(s.llm_score, 0)          AS llm_score,
    ifNull(s.llm_verdict, 'unscored') AS llm_verdict,
    ifNull(s.llm_reason, '')        AS llm_reason
-- FINAL is required, not optional. ReplacingMergeTree only collapses duplicates
-- when parts merge, which is asynchronous and may never happen for small parts.
-- Re-running the extractor for a window therefore leaves BOTH copies visible to
-- a plain SELECT, and a backtest would count every affected episode twice.
FROM episodes AS e FINAL
LEFT JOIN (SELECT * FROM coin_scores FINAL) AS s ON e.mint = s.mint;
