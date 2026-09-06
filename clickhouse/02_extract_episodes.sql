-- Extract episodes for launches in [{FROM}, {TO}) at horizon {H} seconds.
--
-- Placeholders are substituted by scripts/extract_episodes.sh:
--   {H}     horizon in seconds (30 / 60 / 180)
--   {FROM}  inclusive lower bound on t0, 'YYYY-MM-DD HH:MM:SS'
--   {TO}    exclusive upper bound on t0
--
-- Only run for windows where t0 + {H} + 3600s has fully elapsed, otherwise the
-- 60m outcome columns are silently truncated and every model trained on them
-- learns that late winners do not exist.

INSERT INTO episodes
(
    mint, horizon_s, t0,
    symbol, name, twitter_kind, twitter_handle, has_telegram, has_website, has_image,
    n_trades, n_buys, n_sells, n_traders, n_buyers,
    vol_sol, buy_vol_sol, sell_vol_sol, buy_ratio,
    fees_sol, creator_fees_sol, trades_per_s,
    px_open, px_at_h, px_max_in, px_min_in, log_ret_in, mcap_at_h, real_sol_at_h,
    top_trader_vol_share, dev_wallet, dev_buy_sol, dev_sold_in_window,
    px_max_after, px_last, px_5m, px_15m, px_60m,
    log_max_ret_after, log_ret_5m, log_ret_15m, log_ret_60m, log_final_ret,
    giveback_from_peak, time_to_peak_s, n_trades_after, life_s, total_vol_sol,
    graduated, time_to_grad_s, died_5m
)
WITH
    -- One row per launch. dev_wallet is the first buyer: tokens.creator is 0%
    -- populated on this box, so the dev has to be inferred, and the very first
    -- trade on a fresh bonding curve is the dev buy in practice.
    launches AS
    (
        SELECT
            mint,
            min(ts)                    AS t0,
            argMin(trader, (ts, seq))  AS dev_wallet
        FROM trades
        GROUP BY mint
        HAVING t0 >= toDateTime64('{FROM}', 3) AND t0 < toDateTime64('{TO}', 3)
    ),

    -- Per-wallet volume inside the decision window, for the concentration feature.
    trader_vol AS
    (
        SELECT tr.mint AS mint, tr.trader AS trader, sum(tr.sol_amount) AS v
        FROM trades AS tr
        INNER JOIN launches AS l ON tr.mint = l.mint
        WHERE tr.ts <= l.t0 + toIntervalSecond({H})
        GROUP BY tr.mint, tr.trader
    ),
    concentration AS
    (
        SELECT mint, max(v) AS top_v, sum(v) AS tot_v
        FROM trader_vol
        GROUP BY mint
    ),

    agg AS
    (
        SELECT
            l.mint                                                        AS mint,
            l.t0                                                          AS t0,
            l.dev_wallet                                                  AS dev_wallet,

            -- ---------- inside the window ----------
            countIf(tr.ts <= l.t0 + toIntervalSecond({H}))                            AS n_trades,
            countIf(tr.ts <= l.t0 + toIntervalSecond({H}) AND tr.is_buy = 1)          AS n_buys,
            countIf(tr.ts <= l.t0 + toIntervalSecond({H}) AND tr.is_buy = 0)          AS n_sells,
            uniqExactIf(tr.trader, tr.ts <= l.t0 + toIntervalSecond({H}))             AS n_traders,
            uniqExactIf(tr.trader, tr.ts <= l.t0 + toIntervalSecond({H}) AND tr.is_buy = 1) AS n_buyers,

            sumIf(tr.sol_amount, tr.ts <= l.t0 + toIntervalSecond({H}))               AS vol_sol,
            sumIf(tr.sol_amount, tr.ts <= l.t0 + toIntervalSecond({H}) AND tr.is_buy = 1) AS buy_vol_sol,
            sumIf(tr.sol_amount, tr.ts <= l.t0 + toIntervalSecond({H}) AND tr.is_buy = 0) AS sell_vol_sol,
            sumIf(tr.fee_sol,         tr.ts <= l.t0 + toIntervalSecond({H}))          AS fees_sol,
            sumIf(tr.creator_fee_sol, tr.ts <= l.t0 + toIntervalSecond({H}))          AS creator_fees_sol,

            -- (ts, seq) not ts: block time is second-precise, so ordering by ts
            -- alone ties across every trade in the same second and open == close.
            argMinIf(tr.price_sol, (tr.ts, tr.seq), tr.ts <= l.t0 + toIntervalSecond({H})) AS px_open,
            argMaxIf(tr.price_sol, (tr.ts, tr.seq), tr.ts <= l.t0 + toIntervalSecond({H})) AS px_at_h,
            maxIf(tr.price_sol, tr.ts <= l.t0 + toIntervalSecond({H}))                AS px_max_in,
            minIf(tr.price_sol, tr.ts <= l.t0 + toIntervalSecond({H}) AND tr.price_sol > 0) AS px_min_in,
            argMaxIf(tr.mcap_sol, (tr.ts, tr.seq), tr.ts <= l.t0 + toIntervalSecond({H})) AS mcap_at_h,
            argMaxIf(tr.real_sol, (tr.ts, tr.seq), tr.ts <= l.t0 + toIntervalSecond({H})) AS real_sol_at_h,

            sumIf(tr.sol_amount, tr.ts <= l.t0 + toIntervalSecond({H})
                                 AND tr.trader = l.dev_wallet AND tr.is_buy = 1)      AS dev_buy_sol,
            countIf(tr.ts <= l.t0 + toIntervalSecond({H})
                    AND tr.trader = l.dev_wallet AND tr.is_buy = 0)                   AS dev_sells,

            -- ---------- strictly after the window ----------
            maxIf(tr.price_sol, tr.ts > l.t0 + toIntervalSecond({H}))                 AS px_max_after,
            argMaxIf(tr.price_sol, (tr.ts, tr.seq), tr.ts > l.t0 + toIntervalSecond({H})) AS px_last,
            argMinIf(tr.price_sol, (tr.ts, tr.seq), tr.ts >= l.t0 + toIntervalSecond({H} + 300))  AS px_5m,
            argMinIf(tr.price_sol, (tr.ts, tr.seq), tr.ts >= l.t0 + toIntervalSecond({H} + 900))  AS px_15m,
            argMinIf(tr.price_sol, (tr.ts, tr.seq), tr.ts >= l.t0 + toIntervalSecond({H} + 3600)) AS px_60m,
            countIf(tr.ts > l.t0 + toIntervalSecond({H}))                             AS n_trades_after,
            argMaxIf(tr.ts, tr.price_sol, tr.ts > l.t0 + toIntervalSecond({H}))       AS peak_ts,
            countIf(tr.ts > l.t0 + toIntervalSecond({H})
                    AND tr.ts <= l.t0 + toIntervalSecond({H} + 300))                  AS n_trades_5m,

            max(tr.ts)                                                                AS last_ts,
            sum(tr.sol_amount)                                                        AS total_vol_sol
        FROM trades AS tr
        INNER JOIN launches AS l ON tr.mint = l.mint
        GROUP BY l.mint, l.t0, l.dev_wallet
    )

SELECT
    a.mint,
    toUInt16({H}),
    a.t0,

    ifNull(tk.symbol, ''),
    ifNull(tk.name, ''),
    multiIf(
        ifNull(tk.twitter, '') = '',                  'none',
        position(tk.twitter, '/search') > 0,          'search',
        position(tk.twitter, '/status/') > 0,         'status',
        match(tk.twitter, 'x\\.com/[A-Za-z0-9_]+/?($|\\?)'), 'profile',
        'other'),
    -- A search URL is x.com/search?q=..., which would otherwise yield the literal
    -- handle "search" and bucket unrelated coins under one fake account.
    if(position(ifNull(tk.twitter, ''), '/search') > 0, '',
       extract(ifNull(tk.twitter, ''), 'x\\.com/([A-Za-z0-9_]+)')),
    toUInt8(ifNull(tk.telegram, '') != ''),
    toUInt8(ifNull(tk.website,  '') != ''),
    toUInt8(ifNull(tk.image,    '') != ''),

    a.n_trades, a.n_buys, a.n_sells, a.n_traders, a.n_buyers,
    a.vol_sol, a.buy_vol_sol, a.sell_vol_sol,
    a.buy_vol_sol / nullIf(a.vol_sol, 0),
    a.fees_sol, a.creator_fees_sol,
    a.n_trades / toFloat64({H}),

    a.px_open, a.px_at_h, a.px_max_in, a.px_min_in,
    if(a.px_open > 0 AND a.px_at_h > 0, log(a.px_at_h / a.px_open), 0),
    a.mcap_at_h, a.real_sol_at_h,

    ifNull(c.top_v / nullIf(c.tot_v, 0), 0),
    a.dev_wallet, a.dev_buy_sol, toUInt8(a.dev_sells > 0),

    a.px_max_after, a.px_last, a.px_5m, a.px_15m, a.px_60m,
    -- Every return is measured from px_at_h: that is the price an agent that
    -- decided at the horizon would actually have paid.
    if(a.px_at_h > 0 AND a.px_max_after > 0, log(a.px_max_after / a.px_at_h), 0),
    if(a.px_at_h > 0 AND a.px_5m  > 0, log(a.px_5m  / a.px_at_h), 0),
    if(a.px_at_h > 0 AND a.px_15m > 0, log(a.px_15m / a.px_at_h), 0),
    if(a.px_at_h > 0 AND a.px_60m > 0, log(a.px_60m / a.px_at_h), 0),
    if(a.px_at_h > 0 AND a.px_last > 0, log(a.px_last / a.px_at_h), 0),
    if(a.px_max_after > 0, 1 - (a.px_last / a.px_max_after), 0),
    if(a.n_trades_after > 0, toInt32(dateDiff('second', a.t0, a.peak_ts)), -1),
    a.n_trades_after,
    toUInt32(dateDiff('second', a.t0, a.last_ts)),
    a.total_vol_sol,

    toUInt8(g.mint != ''),
    if(g.mint != '', toInt32(dateDiff('second', a.t0, g.ts)), -1),
    toUInt8(a.n_trades_5m = 0)
FROM agg AS a
LEFT JOIN concentration AS c ON a.mint = c.mint
LEFT JOIN (SELECT mint, argMax(symbol, ingested_at) AS symbol, argMax(name, ingested_at) AS name,
                  argMax(twitter, ingested_at) AS twitter, argMax(telegram, ingested_at) AS telegram,
                  argMax(website, ingested_at) AS website, argMax(image, ingested_at) AS image
           FROM tokens GROUP BY mint) AS tk ON a.mint = tk.mint
LEFT JOIN (SELECT mint, min(ts) AS ts FROM graduations GROUP BY mint) AS g ON a.mint = g.mint
-- A one-trade mint is not an episode, it is noise. This alone drops roughly half
-- of all launches (median coin sees 8 trades over 2 minutes).
WHERE a.n_trades >= 3;
