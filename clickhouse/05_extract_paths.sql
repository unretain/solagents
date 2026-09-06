-- Populate episode_paths for launches in [{FROM}, {TO}) at horizon {H}.
-- Substituted by scripts/extract_episodes.sh exactly like 02_extract_episodes.sql.
--
-- A row is written for EVERY launch, including those with no post-entry trades
-- (empty arrays). That distinction carries real weight downstream: an empty
-- array means "we looked, nobody traded it again" — a genuine total loss — while
-- a MISSING row means "not extracted yet". Emitting rows only where trades
-- existed made those two indistinguishable, and the backtester scored every
-- un-backfilled episode as a -100% trade.

INSERT INTO episode_paths (mint, horizon_s, t0, ks, pxs)
WITH
    launches AS
    (
        SELECT mint, min(ts) AS t0
        FROM trades
        GROUP BY mint
        HAVING t0 >= toDateTime64('{FROM}', 3) AND t0 < toDateTime64('{TO}', 3)
    ),
    -- Last price in each 10s bucket after entry. argMax on (ts, seq), never ts
    -- alone: block time is second-precise, so ordering by ts ties across every
    -- trade in the same second and the "last" price becomes arbitrary.
    buckets AS
    (
        SELECT
            l.mint                                                                          AS mint,
            toUInt16(intDiv(dateDiff('second', l.t0 + toIntervalSecond({H}), tr.ts), 10))    AS k,
            argMax(tr.price_sol, (tr.ts, tr.seq))                                            AS px
        FROM trades AS tr
        INNER JOIN launches AS l ON tr.mint = l.mint
        WHERE tr.ts >  l.t0 + toIntervalSecond({H})
          AND tr.ts <= l.t0 + toIntervalSecond({H} + 600)
          AND tr.price_sol > 0
        GROUP BY l.mint, k
    ),
    -- Sorted as (k, px) pairs rather than two independent groupArrays: a JOIN
    -- makes no ordering promise, and two separately-ordered arrays would pair
    -- each bucket index with another bucket's price.
    joined AS
    (
        SELECT
            l.mint AS mint,
            l.t0   AS t0,
            arraySort(p -> p.1, groupArrayIf((b.k, toFloat32(b.px)), b.mint != '')) AS pairs
        FROM launches AS l
        LEFT JOIN buckets AS b ON l.mint = b.mint
        GROUP BY l.mint, l.t0
    )
SELECT
    mint,
    toUInt16({H}),
    t0,
    arrayMap(p -> p.1, pairs) AS ks,
    arrayMap(p -> p.2, pairs) AS pxs
FROM joined;
