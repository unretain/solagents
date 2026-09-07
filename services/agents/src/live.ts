/**
 * Live picks: coins matching a strategy right now.
 *
 * Runs the SAME compiled WHERE clause the backtester uses, against the
 * `live_episodes` view whose columns mirror `episodes_enriched` exactly. A live
 * pick and a backtest hit are therefore the same decision by construction.
 *
 * No model call and no per-trade socket in this path - a coin whose median life
 * is two minutes will not wait for either.
 */
import { chQuery } from "./clickhouse.js";
import { toSql } from "./strategy/evaluate.js";
import type { Strategy } from "./strategy/schema.js";

export interface LivePick {
  mint: string;
  symbol: string;
  name: string;
  /** carried from live_snapshot so the picks list shows coin art like every
   *  other list does - without it these rows rendered as blank placeholders */
  image: string;
  t0: string;
  ageS: number;
  horizonS: number;
  nTraders: number;
  volSol: number;
  buyRatio: number;
  feesSol: number;
  twitterKind: string;
  llmVerdict: string;
  priceSol: number;
  mcapSol: number;
  devSold: number;
  strategyId?: string;
  strategyName?: string;
}

const SELECT = `
  mint, symbol, name, image, toString(t0) AS t0, age_now_s AS ageS, horizon_s AS horizonS,
  n_traders AS nTraders, round(vol_sol, 3) AS volSol, round(buy_ratio, 3) AS buyRatio,
  round(fees_sol + creator_fees_sol, 5) AS feesSol,
  twitter_kind AS twitterKind, llm_verdict AS llmVerdict,
  px_at_h AS priceSol, round(mcap_at_h, 2) AS mcapSol, dev_sold_in_window AS devSold`;

/**
 * Coins matching `s` that crossed their decision horizon within `freshS`.
 *
 * The freshness bound is what makes this a stream of NEW picks rather than a
 * standing list - without it every poll re-reports the same coins for 40
 * minutes, and the UI shows a strategy "firing" repeatedly on one launch.
 */
export async function livePicks(s: Strategy, freshS = 900, limit = 50): Promise<LivePick[]> {
  return chQuery<LivePick>(`
    SELECT ${SELECT}
    FROM live_snapshot
    WHERE ${toSql(s)}
      AND age_now_s <= ${Math.max(s.decide_at_s + freshS, s.decide_at_s + 30)}
    ORDER BY t0 DESC
    LIMIT ${limit}
    FORMAT JSON`);
}

export interface LiveTx {
  mint: string;
  symbol: string;
  image: string;
  ts: string;
  isBuy: number;
  solAmount: number;
  priceSol: number;
  trader: string;
}

/**
 * The raw firehose: every trade the platform is scanning, newest first.
 *
 * This is what the agents actually see. It is deliberately unfiltered - roughly
 * 30 trades a second across ~57 coins - because "what is it looking at" and
 * "what did it pick" are different questions, and only showing picks makes a
 * quiet minute indistinguishable from a broken feed.
 *
 * The inner LIMIT runs before the join so only ~60 rows are ever decorated with
 * token metadata, which keeps this at ~25ms even though `trades` is 25M rows.
 */
export async function liveTrades(limit = 60): Promise<LiveTx[]> {
  return chQuery<LiveTx>(`
    SELECT t.mint AS mint, ifNull(k.symbol,'') AS symbol, ifNull(k.image,'') AS image,
           toString(t.ts) AS ts, t.is_buy AS isBuy,
           round(t.sol_amount, 4) AS solAmount, t.price_sol AS priceSol, t.trader AS trader
    FROM (
      SELECT mint, ts, seq, is_buy, sol_amount, price_sol, trader
      FROM trades
      WHERE ts > now() - INTERVAL 60 SECOND
      ORDER BY ts DESC, seq DESC
      LIMIT ${limit}
    ) AS t
    LEFT JOIN (
      SELECT mint, argMax(symbol, ingested_at) AS symbol, argMax(image, ingested_at) AS image
      FROM tokens GROUP BY mint
    ) AS k ON t.mint = k.mint
    ORDER BY ts DESC
    FORMAT JSON`);
}

/** Headline counters for the scanner: rate, coins, SOL in the last 10s. */
export async function scanRate(): Promise<{ trades: number; coins: number; sol: number }> {
  const [r] = await chQuery<{ trades: number; coins: number; sol: number }>(`
    SELECT count() AS trades, uniqExact(mint) AS coins, round(sum(sol_amount),1) AS sol
    FROM trades WHERE ts > now() - INTERVAL 10 SECOND
    FORMAT JSON`);
  return r ?? { trades: 0, coins: 0, sol: 0 };
}

/** Everything happening right now, regardless of strategy - the "what is the
 *  feed even doing" panel, so an empty picks list can be told apart from a
 *  stalled feed. */
export async function liveTape(limit = 40): Promise<LivePick[]> {
  return chQuery<LivePick>(`
    SELECT ${SELECT}
    FROM live_snapshot
    WHERE horizon_s = 60 AND n_trades >= 3
    ORDER BY t0 DESC
    LIMIT ${limit}
    FORMAT JSON`);
}

/**
 * Picks across every published strategy, newest first.
 *
 * Deliberately one query per strategy rather than one big OR: the strategies are
 * independent, each WHERE is cheap (the view answers in ~0.3s), and a single
 * fused query could not report WHICH strategy matched - which is the only
 * interesting part of the display.
 */
export async function publishedPicks(
  strategies: Array<{ id: string; name: string; config: Strategy }>,
  freshS = 900,
): Promise<LivePick[]> {
  const out: LivePick[] = [];
  const results = await Promise.allSettled(
    strategies.map(async (row) => {
      const picks = await livePicks(row.config, freshS, 15);
      return picks.map((p) => ({ ...p, strategyId: row.id, strategyName: row.name }));
    }),
  );
  // A broken strategy config must not blank the whole board for everyone else.
  for (const r of results) if (r.status === "fulfilled") out.push(...r.value);
  out.sort((a, b) => (a.t0 < b.t0 ? 1 : -1));
  return out.slice(0, 60);
}
