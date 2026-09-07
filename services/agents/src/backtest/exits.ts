/**
 * Exit simulation over a sparse 10-second price path.
 *
 * Every judgement call here is made in the pessimistic direction. A backtester
 * that resolves its own ambiguities favourably is not a backtester, it is a
 * sales pitch - and on this market (median coin dead in 2 minutes) the optimistic
 * version of each of these produces spectacular, entirely fictional returns.
 */

export interface ExitRules {
  take_profit_pct?: number;
  stop_loss_pct?: number;
  trailing_stop_pct?: number;
  max_hold_s: number;
}

export type ExitReason = "take_profit" | "stop_loss" | "trailing_stop" | "time" | "no_liquidity";

export interface ExitResult {
  exitPx: number;
  reason: ExitReason;
  heldS: number;
  /** peak price seen while the position was open, for diagnostics */
  peakPx: number;
}

/** Bucket index -> seconds after entry. Buckets are 10s wide. */
const BUCKET_S = 10;

export function simulateExit(
  entryPx: number,
  ks: number[],
  pxs: number[],
  rules: ExitRules,
): ExitResult {
  // No trade after entry at all. The position cannot be closed at any observed
  // price, so it is marked worthless rather than settled at the entry price -
  // a coin nobody traded again is not a break-even, it is a total loss.
  if (!ks.length) {
    return { exitPx: 0, reason: "no_liquidity", heldS: rules.max_hold_s, peakPx: entryPx };
  }

  const tp = rules.take_profit_pct !== undefined ? entryPx * (1 + rules.take_profit_pct / 100) : Infinity;
  const sl = rules.stop_loss_pct !== undefined ? entryPx * (1 - rules.stop_loss_pct / 100) : -Infinity;

  let peak = entryPx;
  let lastPx = entryPx;
  let lastS = 0;

  for (let i = 0; i < ks.length; i++) {
    const tSec = (ks[i] + 1) * BUCKET_S; // price is the LAST trade in the bucket
    if (tSec > rules.max_hold_s) break;

    const px = pxs[i];
    lastPx = px;
    lastS = tSec;
    if (px > peak) peak = px;

    const trail =
      rules.trailing_stop_pct !== undefined ? peak * (1 - rules.trailing_stop_pct / 100) : -Infinity;

    // Order matters and is deliberately unfavourable. Within one 10s bucket we
    // see a single price and cannot know the intra-bucket sequence, so stops are
    // checked BEFORE the take-profit: if both were reachable, we assume the
    // adverse one arrived first. Resolving ties the other way is the single
    // easiest way to manufacture a strategy that backtests well and loses live.
    // Fill price is the WORSE of the trigger level and the observed price:
    //   - gapped past a stop  -> you eat the gap, you do not get the stop price
    //   - gapped past the TP  -> you get the TP, you do not book the overshoot
    // One rule, conservative in both directions, and identical to the live paper
    // engine (see paper.ts). Taking the trigger price on stops flatters a
    // strategy on exactly the moves that hurt most, and taking the observed
    // price on take-profits manufactures profit that no resting order earns.
    const fill = (trigger: number) => Math.min(px, trigger);

    if (px <= sl) return { exitPx: fill(sl), reason: "stop_loss", heldS: tSec, peakPx: peak };
    if (px <= trail) return { exitPx: fill(trail), reason: "trailing_stop", heldS: tSec, peakPx: peak };
    if (px >= tp) return { exitPx: fill(tp), reason: "take_profit", heldS: tSec, peakPx: peak };
  }

  // Held to the time stop. Exits at the last price actually observed, not at a
  // forward-filled price at exactly max_hold_s: if the coin stopped trading at
  // t+40s there was no bid at t+300s either.
  return { exitPx: lastPx, reason: "time", heldS: Math.min(lastS, rules.max_hold_s), peakPx: peak };
}

/**
 * Round-trip cost of a position, as a fraction.
 *
 * Two components, both real on pump.fun:
 *   fees     ~1% protocol + creator, charged on both legs. Measured from the
 *            feed: 6,807 SOL of fees on ~4M trades in 24h.
 *   slippage the bonding curve moves against you by roughly size/curve_sol on
 *            entry and again on exit. A 1 SOL buy into a curve holding 30 SOL
 *            is not a 0.1% fill.
 *
 * `curveSol` is the SOL side of the curve at entry (virtual ~30 + real). When
 * `real_sol` is unknown (it is only ~45% populated) we fall back to the virtual
 * 30 SOL floor, which UNDERSTATES slippage for large curves - so callers should
 * treat unknown-reserve episodes as optimistic.
 */
export function roundTripCost(sizeSol: number, curveSol: number, feeBps = 200): number {
  const fees = feeBps / 10_000;
  const depth = Math.max(curveSol, 30);
  const slipPerLeg = Math.min(sizeSol / depth, 0.5); // cap: past this the model is meaningless
  return fees + 2 * slipPerLeg;
}
