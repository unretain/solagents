/**
 * Backtest: compile a strategy to SQL, pull the matching episodes with their
 * price paths, simulate exits, report.
 *
 * One pass over ClickHouse, exits simulated in JS. 377k episodes is small enough
 * that the query is the cheap part.
 */
import { chQuery } from "../clickhouse.js";
import { toSql } from "../strategy/evaluate.js";
import type { Strategy } from "../strategy/schema.js";
import { simulateExit, roundTripCost, type ExitReason } from "./exits.js";

export interface Trade {
  mint: string;
  symbol: string;
  t0: string;
  entryPx: number;
  exitPx: number;
  reason: ExitReason;
  heldS: number;
  sizeSol: number;
  costFrac: number;
  /** net multiple on the position, 1.0 = break even */
  mult: number;
  pnlSol: number;
}

export interface BacktestResult {
  strategyName: string;
  from: string;
  to: string;
  nCandidates: number;
  nTrades: number;
  winPct: number;
  totalPnlSol: number;
  avgPnlSol: number;
  /** geometric mean multiple per trade - the number that actually compounds */
  geoMult: number;
  medianMult: number;
  maxDrawdownSol: number;
  avgHoldS: number;
  exitBreakdown: Record<string, number>;
  volumeSol: number;
  trades: Trade[];
  warnings: string[];
}

interface Row {
  mint: string; symbol: string; t0: string;
  px_at_h: number; real_sol_at_h: number; vol_sol: number;
  ks: number[]; pxs: number[]; has_path: number;
}

export async function runBacktest(
  s: Strategy,
  opts: { from?: string; to?: string; bankrollSol?: number; feeBps?: number; maxTrades?: number } = {},
): Promise<BacktestResult> {
  const from = opts.from ?? "2026-09-04 00:00:00";
  const to = opts.to ?? "2099-01-01 00:00:00";
  const bankroll = opts.bankrollSol ?? 10;
  const warnings: string[] = [];

  // Socials only began populating 2026-09-04. A window that starts earlier will
  // score every twitter_kind as 'none' and quietly conclude the feature is dead.
  if (from < "2026-09-04" && usesSocials(s)) {
    warnings.push(
      "Window starts before 2026-09-04, when socials capture began. Twitter features " +
        "read as 'none' for earlier episodes - results before that date are not meaningful.",
    );
  }

  const where = toSql(s);
  const sql = `
    SELECT e.mint AS mint, e.symbol AS symbol, toString(e.t0) AS t0,
           e.px_at_h AS px_at_h, e.real_sol_at_h AS real_sol_at_h, e.vol_sol AS vol_sol,
           ifNull(p.ks, []) AS ks, ifNull(p.pxs, []) AS pxs,
           -- Distinguishes "no path row" (never extracted - unjudgeable) from an
           -- empty path (extracted, nobody traded it again - a real total loss).
           p.mint != '' AS has_path
    FROM episodes_enriched AS e
    -- FINAL: without it a re-extracted window leaves duplicate path rows, and the
    -- join would multiply the episode into several identical "trades".
    LEFT JOIN (SELECT mint, horizon_s, ks, pxs FROM episode_paths FINAL) AS p
      ON e.mint = p.mint AND e.horizon_s = p.horizon_s
    WHERE ${where}
      AND e.t0 >= toDateTime64('${from}', 3)
      AND e.t0 <  toDateTime64('${to}', 3)
    ORDER BY e.t0 ASC
    LIMIT ${opts.maxTrades ?? 20000}
    FORMAT JSON`;

  const rows = await chQuery<Row>(sql);

  const trades: Trade[] = [];
  // Positions are opened in time order and capped at max_concurrent, so a
  // strategy cannot claim 400 simultaneous positions it could never have funded.
  const open: { untilMs: number }[] = [];
  let equity = bankroll;
  let peakEquity = bankroll;
  let maxDd = 0;

  let skippedNoPath = 0;
  for (const r of rows) {
    // An episode whose path was never extracted cannot be judged. Scoring it as
    // a total loss (which an empty path legitimately means) would make an
    // incomplete backfill look like a catastrophic strategy.
    if (!r.has_path) { skippedNoPath++; continue; }

    const tMs = Date.parse(r.t0.replace(" ", "T") + "Z");
    for (let i = open.length - 1; i >= 0; i--) if (open[i].untilMs <= tMs) open.splice(i, 1);
    if (open.length >= s.sizing.max_concurrent) continue;

    const sizeSol =
      s.sizing.mode === "fixed_sol"
        ? Math.min(s.sizing.value, s.risk.max_position_sol)
        : Math.min((equity * s.sizing.value) / 100, s.risk.max_position_sol);
    if (sizeSol <= 0 || equity < sizeSol) continue;

    const ex = simulateExit(r.px_at_h, r.ks ?? [], r.pxs ?? [], s.exit);
    const cost = roundTripCost(sizeSol, r.real_sol_at_h || 0, opts.feeBps ?? 200);
    const gross = ex.exitPx > 0 ? ex.exitPx / r.px_at_h : 0;
    const mult = Math.max(0, gross * (1 - cost));
    const pnl = sizeSol * (mult - 1);

    equity += pnl;
    peakEquity = Math.max(peakEquity, equity);
    maxDd = Math.max(maxDd, peakEquity - equity);
    open.push({ untilMs: tMs + ex.heldS * 1000 });

    trades.push({
      mint: r.mint, symbol: r.symbol, t0: r.t0,
      entryPx: r.px_at_h, exitPx: ex.exitPx, reason: ex.reason,
      heldS: ex.heldS, sizeSol, costFrac: cost, mult, pnlSol: pnl,
    });
  }

  const n = trades.length;
  const mults = trades.map((t) => t.mult);
  const wins = trades.filter((t) => t.pnlSol > 0).length;
  const exitBreakdown: Record<string, number> = {};
  for (const t of trades) exitBreakdown[t.reason] = (exitBreakdown[t.reason] ?? 0) + 1;

  // Geometric, not arithmetic. A strategy with one 50x and forty -100%s has a
  // fine arithmetic mean and is a guaranteed way to lose everything. Total-loss
  // trades are floored rather than dropped so they cannot be silently excluded
  // from a log-space average.
  const geo = n ? Math.exp(mults.reduce((a, m) => a + Math.log(Math.max(m, 1e-6)), 0) / n) : 0;
  const sorted = [...mults].sort((a, b) => a - b);

  if (n > 0 && n < 30) {
    warnings.push(`Only ${n} trades matched. That is too few to distinguish skill from noise.`);
  }
  if (skippedNoPath > 0) {
    warnings.push(
      `${skippedNoPath} matching episodes were skipped because their price paths have not been ` +
        "extracted yet. This result covers only the remainder - re-run once the backfill completes.",
    );
  }
  const unknownDepth = trades.length
    ? rows.filter((r) => !r.real_sol_at_h).length / rows.length
    : 0;
  if (unknownDepth > 0.3) {
    warnings.push(
      `${Math.round(unknownDepth * 100)}% of episodes have no curve-depth reading, so slippage ` +
        "is modelled at the 30 SOL virtual floor and is understated. Real fills will be worse.",
    );
  }

  return {
    strategyName: s.name,
    from, to,
    nCandidates: rows.length,
    nTrades: n,
    winPct: n ? (100 * wins) / n : 0,
    totalPnlSol: trades.reduce((a, t) => a + t.pnlSol, 0),
    avgPnlSol: n ? trades.reduce((a, t) => a + t.pnlSol, 0) / n : 0,
    geoMult: geo,
    medianMult: n ? sorted[Math.floor(n / 2)] : 0,
    maxDrawdownSol: maxDd,
    avgHoldS: n ? trades.reduce((a, t) => a + t.heldS, 0) / n : 0,
    exitBreakdown,
    volumeSol: trades.reduce((a, t) => a + t.sizeSol, 0),
    trades: trades.slice(0, 200),
    warnings,
  };
}

function usesSocials(s: Strategy): boolean {
  const names = [...s.entry_all, ...s.entry_any].map((c) => c.feature as string);
  return names.some((n) => n.startsWith("twitter") || n.startsWith("handle") || n.startsWith("llm"));
}
