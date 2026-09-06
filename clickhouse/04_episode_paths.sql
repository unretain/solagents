-- Post-entry price path, 10-second resolution, first 10 minutes.
--
-- Exits are what decide whether a strategy makes money, and they cannot be
-- simulated from summary columns: a trailing stop needs to know the ORDER in
-- which the peak and the trough arrived, and `px_max_after` alone cannot say.
--
-- Stored sparse — `ks` holds only the buckets that actually saw a trade, `pxs`
-- the last price in each. The median coin trades 8 times in its life, so a dense
-- 60-slot array would be almost entirely padding. The simulator forward-fills,
-- which is also the honest reading: with no trade in a bucket there is no new
-- price, and a position could not have exited at one.
--
-- 10 minutes because `max_hold_s` beyond that is rare on this market (p50 coin
-- lifetime is 2 minutes) and `px_15m` / `px_60m` on `episodes` still cover the
-- long tail.

CREATE TABLE IF NOT EXISTS episode_paths
(
    mint       String,
    horizon_s  UInt16,
    t0         DateTime64(3),
    -- 10s bucket index after the entry moment (t0 + horizon_s). 0 = first 10s.
    ks         Array(UInt16),
    -- Float32: prices here are compared as ratios against entry, and f32 carries
    -- ~7 significant digits — far more than the 2-3 that any exit rule resolves.
    pxs        Array(Float32),
    built_at   DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(built_at)
PARTITION BY toYYYYMM(t0)
ORDER BY (mint, horizon_s);
