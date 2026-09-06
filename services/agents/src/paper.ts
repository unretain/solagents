/**
 * Live paper trading.
 *
 * One tick every few seconds: open positions for coins that match a running
 * strategy right now, then mark every open position to the current price and
 * close the ones whose exit rule has fired.
 *
 * Uses the same `toSql()` filter as the backtester and the same `roundTripCost`
 * model, so a paper run and a backtest of the same strategy differ only in that
 * one of them already happened.
 */
import { q } from "./db.js";
import { chQuery, lit } from "./clickhouse.js";
import { toSql } from "./strategy/evaluate.js";
import type { Strategy } from "./strategy/schema.js";
import { roundTripCost } from "./backtest/exits.js";

interface RunRow {
  id: string;
  strategy_id: string;
  bankroll_sol: number;
  config: Strategy;
  name: string;
}

interface OpenPos {
  id: string;
  run_id: string;
  mint: string;
  symbol: string;
  size_sol: number;
  entry_px: number;
  peak_px: number | null;
  cost_frac: number;
  opened_at: string;
  config: Strategy;
}

/** Latest observed price per mint, straight from the feed's own table. */
async function currentPrices(mints: string[]): Promise<Map<string, number>> {
  if (!mints.length) return new Map();
  const rows = await chQuery<{ mint: string; px: number }>(`
    SELECT mint, argMax(price_sol, (ts, seq)) AS px
    FROM trades
    WHERE mint IN (${mints.map(lit).join(",")})
      AND ts > now() - INTERVAL 2 HOUR
      AND price_sol > 0
    GROUP BY mint
    FORMAT JSON`);
  return new Map(rows.map((r) => [r.mint, Number(r.px)]));
}

async function openPositions(run: RunRow): Promise<number> {
  const s = run.config;

  const [{ n: openCount }] = await q<{ n: string }>(
    `SELECT count(*) AS n FROM sa_position WHERE run_id = $1 AND closed_at IS NULL`,
    [run.id],
  );
  const room = s.sizing.max_concurrent - Number(openCount);
  if (room <= 0) return 0;

  // Realised PnL so far, for the daily-loss halt and for pct_bankroll sizing.
  const [{ pnl }] = await q<{ pnl: string }>(
    `SELECT coalesce(sum(pnl_sol), 0) AS pnl FROM sa_position WHERE run_id = $1 AND closed_at IS NOT NULL`,
    [run.id],
  );
  const equity = run.bankroll_sol + Number(pnl);

  if (Number(pnl) <= -s.risk.max_daily_loss_sol) {
    await q(`UPDATE sa_run SET status='halted', halt_reason=$2, stopped_at=now() WHERE id=$1`,
      [run.id, `daily loss limit hit (${Number(pnl).toFixed(2)} SOL)`]);
    return 0;
  }

  const size = s.sizing.mode === "fixed_sol"
    ? Math.min(s.sizing.value, s.risk.max_position_sol)
    : Math.min((equity * s.sizing.value) / 100, s.risk.max_position_sol);
  if (size <= 0 || equity < size) return 0;

  // Candidates: live matches this run has never traded. The freshness bound is
  // tight (120s past the horizon) because a paper run must enter at roughly the
  // moment the strategy fires — entering a 30-minute-old match would record a
  // fill the backtest would never have taken.
  const picks = await chQuery<{
    mint: string; symbol: string; px: number; real_sol: number; image: string;
  }>(`
    SELECT l.mint AS mint, l.symbol AS symbol, l.px_at_h AS px,
           l.real_sol_at_h AS real_sol, ifNull(t.image, '') AS image
    FROM live_episodes AS l
    LEFT JOIN (SELECT mint, argMax(image, ingested_at) AS image FROM tokens GROUP BY mint) AS t
      ON l.mint = t.mint
    WHERE ${toSql(s)}
      AND l.age_now_s <= ${s.decide_at_s + 120}
      AND l.px_at_h > 0
    ORDER BY l.t0 DESC
    LIMIT ${room * 4}
    FORMAT JSON`);

  let opened = 0;
  for (const p of picks) {
    if (opened >= room) break;
    const cost = roundTripCost(size, Number(p.real_sol) || 0);
    // ON CONFLICT DO NOTHING leans on the partial unique index: two overlapping
    // ticks cannot double-enter the same coin, and neither can a restart.
    const res = await q<{ id: string }>(
      `INSERT INTO sa_position (run_id, mint, symbol, image, size_sol, entry_px, peak_px, last_px, cost_frac)
       SELECT $1,$2,$3,$4,$5,$6,$6,$6,$7
       WHERE NOT EXISTS (SELECT 1 FROM sa_position WHERE run_id=$1 AND mint=$2)
       RETURNING id`,
      [run.id, p.mint, p.symbol || "", p.image || "", size, Number(p.px), cost],
    );
    if (!res.length) continue;
    await q(
      `INSERT INTO sa_fill (run_id, mint, symbol, side, size_sol, price_sol, fee_sol)
       VALUES ($1,$2,$3,'buy',$4,$5,$6)`,
      [run.id, p.mint, p.symbol || "", size, Number(p.px), size * cost / 2],
    );
    opened++;
  }
  return opened;
}

async function markAndClose(): Promise<number> {
  const open = await q<OpenPos>(`
    SELECT p.id, p.run_id, p.mint, p.symbol, p.size_sol, p.entry_px, p.peak_px,
           p.cost_frac, p.opened_at, s.config
    FROM sa_position p
    JOIN sa_run r      ON r.id = p.run_id
    JOIN sa_strategy s ON s.id = r.strategy_id
    WHERE p.closed_at IS NULL AND r.mode = 'paper'`);
  if (!open.length) return 0;

  const prices = await currentPrices([...new Set(open.map((p) => p.mint))]);
  let closed = 0;

  for (const p of open) {
    const rules = p.config.exit;
    const heldS = (Date.now() - Date.parse(p.opened_at)) / 1000;
    const px = prices.get(p.mint);

    // No trade in two hours: the coin is gone. Settle at zero rather than
    // leaving the position open forever inflating the run's apparent exposure.
    if (px === undefined) {
      if (heldS > rules.max_hold_s) await close(p, 0, "no_liquidity");
      continue;
    }

    const peak = Math.max(p.peak_px ?? p.entry_px, px);
    if (peak !== p.peak_px) {
      await q(`UPDATE sa_position SET peak_px=$2, last_px=$3 WHERE id=$1`, [p.id, peak, px]);
    } else {
      await q(`UPDATE sa_position SET last_px=$2 WHERE id=$1`, [p.id, px]);
    }

    const tp = rules.take_profit_pct !== undefined ? p.entry_px * (1 + rules.take_profit_pct / 100) : Infinity;
    const sl = rules.stop_loss_pct !== undefined ? p.entry_px * (1 - rules.stop_loss_pct / 100) : -Infinity;
    const trail = rules.trailing_stop_pct !== undefined ? peak * (1 - rules.trailing_stop_pct / 100) : -Infinity;

    // Same adverse-first ordering AND the same fill rule as the backtester:
    // the worse of the trigger level and the observed price. Closing at the
    // observed price on a take-profit books the whole gap between two 5s ticks —
    // that recorded a +84% net fill on a 30% take-profit here, which no resting
    // order would ever have earned. Keeping the two engines in step matters more
    // than either individual choice.
    const fill = (trigger: number) => Math.min(px, trigger);

    if (px <= sl)            { await close(p, fill(sl), "stop_loss"); closed++; }
    else if (px <= trail)    { await close(p, fill(trail), "trailing_stop"); closed++; }
    else if (px >= tp)       { await close(p, fill(tp), "take_profit"); closed++; }
    else if (heldS >= rules.max_hold_s) { await close(p, px, "time"); closed++; }
  }
  return closed;
}

async function close(p: OpenPos, exitPx: number, reason: string): Promise<void> {
  const gross = p.entry_px > 0 ? exitPx / p.entry_px : 0;
  const mult = Math.max(0, gross * (1 - p.cost_frac));
  const pnl = p.size_sol * (mult - 1);
  await q(
    `UPDATE sa_position SET exit_px=$2, exit_reason=$3, pnl_sol=$4, closed_at=now(), last_px=$2 WHERE id=$1`,
    [p.id, exitPx, reason, pnl],
  );
  await q(
    `INSERT INTO sa_fill (run_id, mint, symbol, side, size_sol, price_sol, fee_sol, exit_reason)
     VALUES ($1,$2,$3,'sell',$4,$5,$6,$7)`,
    [p.run_id, p.mint, p.symbol, p.size_sol, exitPx, p.size_sol * p.cost_frac / 2, reason],
  );
}

let ticking = false;

/** One full cycle. Guarded against overlap: a slow tick must not run twice. */
export async function tick(): Promise<{ opened: number; closed: number }> {
  if (ticking) return { opened: 0, closed: 0 };
  ticking = true;
  try {
    const closed = await markAndClose();
    const runs = await q<RunRow>(`
      SELECT r.id, r.strategy_id, r.bankroll_sol, s.config, s.name
      FROM sa_run r JOIN sa_strategy s ON s.id = r.strategy_id
      WHERE r.mode='paper' AND r.status='running'`);
    let opened = 0;
    for (const run of runs) {
      try {
        opened += await openPositions(run);
        await q(`UPDATE sa_run SET last_tick_at=now() WHERE id=$1`, [run.id]);
      } catch (e) {
        // One broken strategy must not stop every other run's exits from firing.
        console.error(`[paper] run ${run.id}: ${(e as Error).message}`);
      }
    }
    return { opened, closed };
  } finally {
    ticking = false;
  }
}

export function startPaperEngine(intervalMs = 5000): void {
  setInterval(() => {
    tick().catch((e) => console.error("[paper]", (e as Error).message));
  }, intervalMs);
  console.log(`[paper] engine started (${intervalMs}ms tick)`);
}
