/**
 * Coin terminal: everything known about one mint.
 *
 * Candles use the same `argMinMerge/argMaxMerge` aggregation polyx-api uses
 * (src/clickhouse/queries.ts) - `candles_1m` is an AggregatingMergeTree, so open
 * and close are aggregate STATES and reading them with plain `min`/`max` returns
 * binary garbage rather than prices.
 *
 * Market cap is price * 1e9: pump.fun mints a fixed 1B supply, which is also why
 * `mcap_sol` in `trades` is exactly `price_sol * 1e9`.
 */
import { chQuery, lit } from "./clickhouse.js";

const SUPPLY = 1_000_000_000;

export interface Candle {
  t: number; o: number; h: number; l: number; c: number; v: number;
}

const INTERVALS: Record<string, number> = {
  "1s": 1, "5s": 5, "15s": 15, "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400,
};

/**
 * How many bars each timeframe keeps.
 *
 * This was a flat 600 for every timeframe, which at 1s is exactly ten minutes:
 * any coin quiet for longer rendered a chart that ended in the past, with the
 * trading trimmed off the front by the same cap. Sized per timeframe so a
 * coin's whole life and its dead tail both fit.
 */
const WINDOW_BARS: Record<string, number> = {
  "1s": 1800, "5s": 900, "15s": 600, "1m": 360, "5m": 300,
  "15m": 300, "1h": 300, "4h": 300, "1d": 300,
};

/**
 * Candles for a mint.
 *
 * Below 1m we cannot use `candles_1m` at all - it is pre-bucketed to the minute.
 * Sub-minute timeframes are re-aggregated from raw `trades`, which is the only
 * place the resolution exists. Ordering is by (ts, seq): block time is
 * second-precise, so ordering by ts alone ties across every trade in the same
 * second and open/close collapse to the same row, rendering every candle flat.
 */
/**
 * Fill intervals that saw no trades.
 *
 * ClickHouse only returns buckets that HAVE trades, so a quiet stretch comes
 * back as a jump in timestamps. A chart that positions bars by time then draws
 * a hole across that stretch - which is exactly what the terminal showed on the
 * 1s view, where 300 traded buckets spanned 1,636 seconds.
 *
 * A period with no trades is not missing data: it is a period in which the
 * price did not change. So it carries the previous close on all four legs with
 * zero volume, which is the standard OHLCV convention.
 *
 * The window always ENDS AT NOW. A chart of a live market that stops ten
 * minutes in the past is wrong in the way that matters most, so the forward
 * fill is not budgeted - it is the thing being drawn.
 *
 * Capped per timeframe, because filling 1-second gaps across a coin that went
 * quiet for an hour would generate 3,600 bars nobody can read. Since the window
 * ends at now, trimming from the start is a sliding window rather than data
 * loss - and when the dead stretch is longer than the whole window, the fill
 * starts inside the window instead of walking every second up to it.
 */
function fillGaps(rows: Candle[], ivSec: number, maxBars: number): Candle[] {
  if (!rows.length) return rows;
  const step = ivSec * 1000;
  const nowMs = Date.now();
  const out: Candle[] = [];

  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i];
    if (i > 0) {
      const prev = rows[i - 1];
      // Bounded so a long mid-life gap cannot blow up before the trim runs.
      for (let t = prev.t + step; t < cur.t && out.length < maxBars * 4; t += step) {
        out.push({ t, o: prev.c, h: prev.c, l: prev.c, c: prev.c, v: 0 });
      }
    }
    out.push(cur);
  }

  // Extend to the present. A coin that traded for 14 seconds and then went
  // quiet for 14 minutes returned ONE bucket, which the chart drew as a single
  // enormous candle filling the pane. Its price did not stop existing when the
  // trading stopped, so the silence is drawn as flat bars.
  const last = out[out.length - 1];
  const missing = Math.floor((nowMs - last.t) / step);
  if (missing > 0) {
    // Walking every second of a multi-hour silence would be hundreds of
    // thousands of iterations for bars the trim discards anyway. When the
    // silence alone exceeds the window, begin where the window begins.
    const skip = Math.max(0, missing - maxBars);
    for (let k = skip + 1; k <= missing; k++) {
      const t = last.t + k * step;
      out.push({ t, o: last.c, h: last.c, l: last.c, c: last.c, v: 0 });
    }
  }
  return out.length > maxBars ? out.slice(out.length - maxBars) : out;
}


/**
 * Candles, already in USD.
 *
 * polyx-api's queries.ts converts server-side (`open_sol * p`) and hands the
 * client dollars. Doing the multiply in the browser instead meant the chart
 * rendered in SOL whenever the SOL price had not arrived yet, and the axis
 * label flipped between units depending on a race. The rate is known here, so
 * the conversion belongs here.
 */
export async function candles(
  mint: string, tf = "1m", limit = 0, solUsd = 0,
): Promise<Candle[]> {
  // Enough traded buckets to fill the window; a flat 300 at 1s covered only
  // five minutes of actual trading.
  const rowLimit = limit || WINDOW_BARS[tf] || 300;
  const iv = INTERVALS[tf] ?? 60;
  const m = lit(mint);
  const p = solUsd > 0 ? solUsd : 1;   // fall back to SOL rather than to zero
  const toUsd = (r: Candle[]): Candle[] =>
    r.map((k) => ({ t: +k.t, o: +k.o * p, h: +k.h * p, l: +k.l * p, c: +k.c * p, v: +k.v * p }));

  if (iv < 60) {
    return chQuery<Candle>(`
      SELECT toUnixTimestamp(toStartOfInterval(ts, INTERVAL ${iv} SECOND)) * 1000 AS t,
             argMin(price_sol, (ts, seq)) AS o,
             max(price_sol)               AS h,
             min(price_sol)               AS l,
             argMax(price_sol, (ts, seq)) AS c,
             sum(sol_amount)              AS v
      FROM trades
      WHERE mint = ${m} AND price_sol > 0
      GROUP BY t ORDER BY t DESC LIMIT ${rowLimit}
      FORMAT JSON`).then((r) => fillGaps(toUsd(r.reverse()), iv, WINDOW_BARS[tf] ?? 300));
  }

  return chQuery<Candle>(`
    SELECT toUnixTimestamp(toStartOfInterval(bucket, INTERVAL ${iv} SECOND)) * 1000 AS t,
           argMinMerge(open)  AS o,
           max(high)          AS h,
           min(low)           AS l,
           argMaxMerge(close) AS c,
           sum(volume_sol)    AS v
    FROM candles_1m
    WHERE mint = ${m}
    GROUP BY t ORDER BY t DESC LIMIT ${rowLimit}
    FORMAT JSON`).then((r) => fillGaps(toUsd(r.reverse()), iv, WINDOW_BARS[tf] ?? 300));
}

export async function coinDetail(mint: string): Promise<Record<string, unknown>> {
  const m = lit(mint);

  const [meta, live, trades, holders, ep] = await Promise.all([
    chQuery<Record<string, unknown>>(`
      SELECT mint, argMax(name, ingested_at) AS name, argMax(symbol, ingested_at) AS symbol,
             argMax(image, ingested_at) AS image, argMax(twitter, ingested_at) AS twitter,
             argMax(telegram, ingested_at) AS telegram, argMax(website, ingested_at) AS website,
             toString(min(created_at)) AS created_at
      FROM tokens WHERE mint = ${m} GROUP BY mint FORMAT JSON`),

    // Everything the agents see, straight from the snapshot they filter on.
    chQuery<Record<string, unknown>>(`
      SELECT horizon_s, age_now_s, n_trades, n_buys, n_sells, n_traders, n_buyers,
             round(vol_sol,3) AS vol_sol, round(buy_ratio,3) AS buy_ratio,
             round(fees_sol + creator_fees_sol, 5) AS fees_sol,
             round(top_trader_vol_share,3) AS concentration,
             dev_sold_in_window AS dev_sold, dev_launch_count, handle_launch_count,
             twitter_kind, llm_verdict, llm_score, llm_reason,
             round(model_score,4) AS model_score, px_at_h, mcap_at_h
      FROM live_snapshot WHERE mint = ${m} ORDER BY horizon_s FORMAT JSON`),

    chQuery<Record<string, unknown>>(`
      SELECT toUnixTimestamp64Milli(ts) AS t, is_buy AS isBuy,
             round(sol_amount,4) AS sol, price_sol AS px, trader
      FROM trades WHERE mint = ${m} ORDER BY ts DESC, seq DESC LIMIT 60 FORMAT JSON`),

    // Who is actually in it. This is the view nobody buying a resale API gets.
    chQuery<Record<string, unknown>>(`
      SELECT trader,
             round(sumIf(sol_amount, is_buy = 1), 3) AS bought,
             round(sumIf(sol_amount, is_buy = 0), 3) AS sold,
             count() AS trades
      FROM trades WHERE mint = ${m}
      GROUP BY trader ORDER BY bought DESC LIMIT 12 FORMAT JSON`),

    // The stored episode, once extraction has caught up with this launch.
    chQuery<Record<string, unknown>>(`
      SELECT horizon_s, toString(t0) AS t0, n_trades, n_traders, round(vol_sol,3) AS vol_sol,
             round(log_max_ret_after,3) AS log_max_ret_after, graduated, life_s,
             round(model_score,4) AS model_score
      FROM episodes_enriched WHERE mint = ${m} ORDER BY horizon_s FORMAT JSON`),
  ]);

  const [price] = await chQuery<{ px: number; mcap: number; vol24: number; trades24: number }>(`
    SELECT argMax(price_sol, (ts, seq)) AS px, argMax(price_sol, (ts, seq)) * ${SUPPLY} AS mcap,
           round(sumIf(sol_amount, ts > now() - INTERVAL 24 HOUR), 2) AS vol24,
           countIf(ts > now() - INTERVAL 24 HOUR) AS trades24
    FROM trades WHERE mint = ${m} FORMAT JSON`);

  return {
    mint,
    meta: meta[0] ?? { mint, symbol: "", name: "", image: "" },
    price: price ?? {},
    live, episodes: ep, trades, holders,
  };
}

/**
 * What the agents are watching right now: the coins their filters currently
 * match, plus every coin any running agent holds a position in.
 */
export async function watchlist(limit = 24): Promise<Record<string, unknown>[]> {
  return chQuery<Record<string, unknown>>(`
    SELECT mint, symbol, image, age_now_s AS ageS, n_traders AS nTraders,
           round(vol_sol,2) AS volSol, round(buy_ratio,2) AS buyRatio,
           twitter_kind AS twitterKind, round(model_score,3) AS score,
           round(mcap_at_h,1) AS mcapSol, llm_verdict AS llmVerdict
    FROM live_snapshot
    WHERE horizon_s = 60 AND n_trades >= 5
    ORDER BY model_score DESC
    LIMIT ${limit}
    FORMAT JSON`);
}
