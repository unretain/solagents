-- Live candidates: episode features computed from `trades` in real time.
--
-- Column names match `episodes_enriched` EXACTLY, so the same compiled WHERE
-- clause from toSql() runs unchanged against both. That is the whole point —
-- a live pick and a backtest hit are then the same decision by construction,
-- not by two implementations that agree today and drift next month.
--
-- Rolling 40-minute window of launches, so a coin is visible here from its first
-- trade until well past the 180s horizon. Outcome columns do not exist: nothing
-- in this view can look forward, because forward has not happened.

CREATE OR REPLACE VIEW live_episodes AS
WITH
    -- Mints that traded at all recently. Cheap, and it bounds the next step.
    recent_mints AS
    (
        SELECT DISTINCT mint FROM trades WHERE ts > now() - INTERVAL 40 MINUTE
    ),
    -- t0 must be the coin's FIRST EVER trade, exactly as `episodes` defines it.
    --
    -- Taking min(ts) over only the last 40 minutes (the obvious way to write
    -- this) makes any OLD coin that resumes trading look like a brand-new
    -- launch: a mint whose real first trade was five days ago came back with
    -- t0 = its first trade inside the window, was served as a fresh launch, and
    -- got bought by the paper engine. The backtest never saw such a row, so the
    -- two stopped agreeing — the precise skew this design exists to prevent.
    --
    -- Scanning all history for these mints is affordable because `trades` is
    -- ORDER BY (mint, ts), so each mint's first row is a seek, not a scan.
    launches AS
    (
        SELECT mint, min(ts) AS t0, argMin(trader, (ts, seq)) AS dev_wallet
        FROM trades
        WHERE mint IN (SELECT mint FROM recent_mints)
        GROUP BY mint
        HAVING t0 > now() - INTERVAL 40 MINUTE
    ),
    horizons AS (SELECT arrayJoin([30, 60, 180]) AS horizon_s),
    -- One row per (coin, horizon) that has actually reached that horizon.
    pairs AS
    (
        SELECT l.mint AS mint, l.t0 AS t0, l.dev_wallet AS dev_wallet, h.horizon_s AS horizon_s
        FROM launches AS l
        CROSS JOIN horizons AS h
        WHERE l.t0 + toIntervalSecond(h.horizon_s) <= now()
    ),
    trader_vol AS
    (
        SELECT p.mint AS mint, p.horizon_s AS horizon_s, tr.trader AS trader, sum(tr.sol_amount) AS v
        FROM trades AS tr
        INNER JOIN pairs AS p ON tr.mint = p.mint
        WHERE tr.ts <= p.t0 + toIntervalSecond(p.horizon_s)
        GROUP BY p.mint, p.horizon_s, tr.trader
    ),
    concentration AS
    (
        SELECT mint, horizon_s, max(v) AS top_v, sum(v) AS tot_v
        FROM trader_vol GROUP BY mint, horizon_s
    ),
    agg AS
    (
        SELECT
            p.mint AS mint, p.t0 AS t0, p.horizon_s AS horizon_s, p.dev_wallet AS dev_wallet,
            countIf(tr.ts <= p.t0 + toIntervalSecond(p.horizon_s))                              AS n_trades,
            countIf(tr.ts <= p.t0 + toIntervalSecond(p.horizon_s) AND tr.is_buy = 1)            AS n_buys,
            countIf(tr.ts <= p.t0 + toIntervalSecond(p.horizon_s) AND tr.is_buy = 0)            AS n_sells,
            uniqExactIf(tr.trader, tr.ts <= p.t0 + toIntervalSecond(p.horizon_s))               AS n_traders,
            uniqExactIf(tr.trader, tr.ts <= p.t0 + toIntervalSecond(p.horizon_s) AND tr.is_buy = 1) AS n_buyers,
            sumIf(tr.sol_amount, tr.ts <= p.t0 + toIntervalSecond(p.horizon_s))                 AS vol_sol,
            sumIf(tr.sol_amount, tr.ts <= p.t0 + toIntervalSecond(p.horizon_s) AND tr.is_buy=1) AS buy_vol_sol,
            sumIf(tr.fee_sol,         tr.ts <= p.t0 + toIntervalSecond(p.horizon_s))            AS fees_sol,
            sumIf(tr.creator_fee_sol, tr.ts <= p.t0 + toIntervalSecond(p.horizon_s))            AS creator_fees_sol,
            argMinIf(tr.price_sol, (tr.ts, tr.seq), tr.ts <= p.t0 + toIntervalSecond(p.horizon_s)) AS px_open,
            argMaxIf(tr.price_sol, (tr.ts, tr.seq), tr.ts <= p.t0 + toIntervalSecond(p.horizon_s)) AS px_at_h,
            argMaxIf(tr.mcap_sol,  (tr.ts, tr.seq), tr.ts <= p.t0 + toIntervalSecond(p.horizon_s)) AS mcap_at_h,
            argMaxIf(tr.real_sol,  (tr.ts, tr.seq), tr.ts <= p.t0 + toIntervalSecond(p.horizon_s)) AS real_sol_at_h,
            sumIf(tr.sol_amount, tr.ts <= p.t0 + toIntervalSecond(p.horizon_s)
                                 AND tr.trader = p.dev_wallet AND tr.is_buy = 1)                AS dev_buy_sol,
            countIf(tr.ts <= p.t0 + toIntervalSecond(p.horizon_s)
                    AND tr.trader = p.dev_wallet AND tr.is_buy = 0)                             AS dev_sells
        FROM trades AS tr
        INNER JOIN pairs AS p ON tr.mint = p.mint
        GROUP BY p.mint, p.t0, p.horizon_s, p.dev_wallet
    ),
    tok AS
    (
        SELECT mint, argMax(symbol, ingested_at) AS symbol, argMax(name, ingested_at) AS name,
               argMax(twitter, ingested_at) AS twitter, argMax(telegram, ingested_at) AS telegram,
               argMax(website, ingested_at) AS website, argMax(image, ingested_at) AS image
        FROM tokens GROUP BY mint
    )
SELECT
    a.mint                                                   AS mint,
    a.horizon_s                                              AS horizon_s,
    a.t0                                                     AS t0,
    toUInt32(dateDiff('second', a.t0, now()))                AS age_now_s,
    ifNull(tk.symbol, '')                                    AS symbol,
    ifNull(tk.name, '')                                      AS name,

    a.n_trades, a.n_buys, a.n_sells, a.n_traders, a.n_buyers,
    a.vol_sol, a.buy_vol_sol,
    a.buy_vol_sol / nullIf(a.vol_sol, 0)                     AS buy_ratio,
    a.fees_sol, a.creator_fees_sol,
    a.n_trades / toFloat64(a.horizon_s)                      AS trades_per_s,
    a.px_at_h, a.mcap_at_h, a.real_sol_at_h,
    if(a.px_open > 0 AND a.px_at_h > 0, log(a.px_at_h / a.px_open), 0) AS log_ret_in,
    ifNull(c.top_v / nullIf(c.tot_v, 0), 0)                  AS top_trader_vol_share,
    a.dev_wallet, a.dev_buy_sol,
    toUInt8(a.dev_sells > 0)                                 AS dev_sold_in_window,

    multiIf(
        ifNull(tk.twitter, '') = '',                  'none',
        position(tk.twitter, '/search') > 0,          'search',
        position(tk.twitter, '/status/') > 0,         'status',
        match(tk.twitter, 'x\\.com/[A-Za-z0-9_]+/?($|\\?)'), 'profile',
        'other')                                             AS twitter_kind,
    if(position(ifNull(tk.twitter, ''), '/search') > 0, '',
       extract(ifNull(tk.twitter, ''), 'x\\.com/([A-Za-z0-9_]+)')) AS twitter_handle,
    toUInt8(ifNull(tk.telegram, '') != '')                   AS has_telegram,
    toUInt8(ifNull(tk.website,  '') != '')                   AS has_website,
    toUInt8(ifNull(tk.image,    '') != '')                   AS has_image,

    -- Reputation from history. The live count is prior launches only, because
    -- `episodes` holds nothing from the current 40-minute window yet.
    ifNull(dl.n, 0)                                          AS dev_launch_count,
    ifNull(hl.n, 0)                                          AS handle_launch_count,
    ifNull(s.llm_score, 0)                                   AS llm_score,
    ifNull(s.llm_verdict, 'unscored')                        AS llm_verdict,
    ifNull(s.llm_reason, '')                                 AS llm_reason,
    -- Same inlined model expression as episodes_enriched, written by the same
    -- training run. This is why a live pick and a backtest hit agree.
    {{MODEL_SCORE_EXPR}} AS model_score
FROM agg AS a
LEFT JOIN concentration AS c ON a.mint = c.mint AND a.horizon_s = c.horizon_s
LEFT JOIN tok AS tk ON a.mint = tk.mint
LEFT JOIN (SELECT dev_wallet, uniqExact(mint) AS n FROM episodes GROUP BY dev_wallet) AS dl
       ON a.dev_wallet = dl.dev_wallet
LEFT JOIN (SELECT twitter_handle, uniqExact(mint) AS n FROM episodes
           WHERE twitter_handle != '' GROUP BY twitter_handle) AS hl
       ON extract(ifNull(tk.twitter, ''), 'x\\.com/([A-Za-z0-9_]+)') = hl.twitter_handle
LEFT JOIN (SELECT * FROM coin_scores FINAL) AS s ON a.mint = s.mint;
