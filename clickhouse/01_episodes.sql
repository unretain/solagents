-- Permanent training set: one row per (mint, horizon).
--
-- NO TTL. `trades` expires at 14 days; this table is what survives, so every
-- feature an agent may ever want must be materialised here at extraction time.
--
-- Features are computed strictly inside [t0, t0 + horizon_s]; outcomes strictly
-- after it. Nothing in a feature column may depend on data after the window, or
-- backtests will look profitable and live will not.
--
-- ReplacingMergeTree(built_at): re-running the extractor for a day is idempotent
-- and the newest build wins.

CREATE TABLE IF NOT EXISTS episodes
(
    mint                  String,
    horizon_s             UInt16,
    t0                    DateTime64(3),          -- first observed trade
    t0_date               Date MATERIALIZED toDate(t0),

    -- ---------------- launch metadata ----------------
    symbol                String  DEFAULT '',
    name                  String  DEFAULT '',
    -- x.com link shape is itself a signal: a `search?q=` link means the launcher
    -- had no account to point at, a `status/` link means it is riding someone
    -- else's tweet, a bare profile is the strongest of the three.
    twitter_kind          LowCardinality(String) DEFAULT 'none',  -- none|profile|status|search|other
    twitter_handle        String  DEFAULT '',
    has_telegram          UInt8   DEFAULT 0,
    has_website           UInt8   DEFAULT 0,
    has_image             UInt8   DEFAULT 0,

    -- ---------------- window features ----------------
    n_trades              UInt32  DEFAULT 0,
    n_buys                UInt32  DEFAULT 0,
    n_sells               UInt32  DEFAULT 0,
    n_traders             UInt32  DEFAULT 0,
    n_buyers              UInt32  DEFAULT 0,
    vol_sol               Float64 DEFAULT 0,
    buy_vol_sol           Float64 DEFAULT 0,
    sell_vol_sol          Float64 DEFAULT 0,
    buy_ratio             Float64 DEFAULT 0,      -- buy_vol / vol
    fees_sol              Float64 DEFAULT 0,      -- protocol fees actually paid
    creator_fees_sol      Float64 DEFAULT 0,
    trades_per_s          Float64 DEFAULT 0,

    px_open               Float64 DEFAULT 0,
    px_at_h               Float64 DEFAULT 0,      -- the price an agent would enter at
    px_max_in             Float64 DEFAULT 0,
    px_min_in             Float64 DEFAULT 0,
    log_ret_in            Float64 DEFAULT 0,      -- ln(px_at_h / px_open)
    mcap_at_h             Float64 DEFAULT 0,
    real_sol_at_h         Float64 DEFAULT 0,      -- ~45% populated; 0 = unknown

    -- concentration: one wallet doing most of the volume is a different regime
    -- from 40 wallets doing it. Both can look identical on volume alone.
    top_trader_vol_share  Float64 DEFAULT 0,
    -- the dev. `tokens.creator` is 0% populated, so this is the first buyer.
    dev_wallet            String  DEFAULT '',
    dev_buy_sol           Float64 DEFAULT 0,
    dev_sold_in_window    UInt8   DEFAULT 0,      -- dev already dumping inside the window

    -- ---------------- outcomes (strictly after the window) ----------------
    px_max_after          Float64 DEFAULT 0,
    px_last               Float64 DEFAULT 0,
    px_5m                 Float64 DEFAULT 0,      -- first trade at/after t0+h+5m
    px_15m                Float64 DEFAULT 0,
    px_60m                Float64 DEFAULT 0,
    -- log returns from the entry price. Log because the tail is brutal: per-mint
    -- max/min price ratio is 10,554x at p99 and 347,554x at max, and a linear
    -- target lets a handful of episodes dictate the whole fit.
    log_max_ret_after     Float64 DEFAULT 0,
    log_ret_5m            Float64 DEFAULT 0,
    log_ret_15m           Float64 DEFAULT 0,
    log_ret_60m           Float64 DEFAULT 0,
    log_final_ret         Float64 DEFAULT 0,
    -- fraction of the post-entry peak given back by the last trade. Not a true
    -- running-max drawdown (that needs a window pass over every tick); this is
    -- the cheap honest version, so it is named for what it measures.
    giveback_from_peak    Float64 DEFAULT 0,      -- 1 - px_last/px_max_after, 0..1
    time_to_peak_s        Int32   DEFAULT -1,
    n_trades_after        UInt32  DEFAULT 0,
    life_s                UInt32  DEFAULT 0,
    total_vol_sol         Float64 DEFAULT 0,
    graduated             UInt8   DEFAULT 0,
    time_to_grad_s        Int32   DEFAULT -1,
    died_5m               UInt8   DEFAULT 0,      -- no trade at all in the 5m after entry

    built_at              DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(built_at)
PARTITION BY toYYYYMM(t0)
ORDER BY (mint, horizon_s);
