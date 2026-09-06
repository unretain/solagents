/**
 * Live picks: coins matching a strategy right now.
 *
 * Runs the SAME compiled WHERE clause the backtester uses, against the
 * `live_episodes` view whose columns mirror `episodes_enriched` exactly. A live
 * pick and a backtest hit are therefore the same decision by construction.
 *
 * No model call and no per-trade socket in this path — a coin whose median life
 * is two minutes will not wait for either.
 */
import { chQuery } from "./clickhouse.js";
import { toSql } from "./strategy/evaluate.js";
import type { Strategy } from "./strategy/schema.js";

export interface LivePick {
  mint: string;
  symbol: string;
  name: string;
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
  mint, symbol, name, toString(t0) AS t0, age_now_s AS ageS, horizon_s AS horizonS,
  n_traders AS nTraders, round(vol_sol, 3) AS volSol, round(buy_ratio, 3) AS buyRatio,
  round(fees_sol + creator_fees_sol, 5) AS feesSol,
  twitter_kind AS twitterKind, llm_verdict AS llmVerdict,
  px_at_h AS priceSol, round(mcap_at_h, 2) AS mcapSol, dev_sold_in_window AS devSold`;

/**
 * Coins matching `s` that crossed their decision horizon within `freshS`.
 *
 * The freshness bound is what makes this a stream of NEW picks rather than a
 * standing list — without it every poll re-reports the same coins for 40
 * minutes, and the UI shows a strategy "firing" repeatedly on one launch.
 */
export async function livePicks(s: Strategy, freshS = 900, limit = 50): Promise<LivePick[]> {
  return chQuery<LivePick>(`
    SELECT ${SELECT}
    FROM live_episodes
    WHERE ${toSql(s)}
      AND age_now_s <= ${Math.max(s.decide_at_s + freshS, s.decide_at_s + 30)}
    ORDER BY t0 DESC
    LIMIT ${limit}
    FORMAT JSON`);
}

/** Everything happening right now, regardless of strategy — the "what is the
 *  feed even doing" panel, so an empty picks list can be told apart from a
 *  stalled feed. */
export async function liveTape(limit = 40): Promise<LivePick[]> {
  return chQuery<LivePick>(`
    SELECT ${SELECT}
    FROM live_episodes
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
 * fused query could not report WHICH strategy matched — which is the only
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
