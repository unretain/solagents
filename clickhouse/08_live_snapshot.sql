-- Materialised snapshot of `live_episodes`, refreshed every 5 seconds.
--
-- `live_episodes` is a view whose CTEs scan `trades` four times — about 100M
-- rows PER EVALUATION. That was fine when one page read it once, and became a
-- denial of service the moment the paper engine (one query per run, every 5s),
-- the live picks board and the model page all read it continuously: ClickHouse
-- logged 1,236 queries in a single minute averaging 4.4 SECONDS, with the worst
-- at 768s / 96.8M rows, and the paper engine timed out on every tick.
--
-- Computing it once on a schedule and letting every consumer read the ~2,000-row
-- result turns each of those queries from 100M rows into a rounding error. The
-- SQL the consumers run is otherwise unchanged, so strategy filters still
-- evaluate against exactly the same columns.
--
-- 5s is well inside the resolution that matters here: the decision horizon is
-- 30-180 seconds, so a snapshot up to 5 seconds stale cannot change which side
-- of a horizon a coin falls on.

CREATE MATERIALIZED VIEW IF NOT EXISTS live_snapshot
REFRESH EVERY 5 SECOND
ENGINE = MergeTree
ORDER BY (horizon_s, mint)
AS SELECT * FROM live_episodes;
