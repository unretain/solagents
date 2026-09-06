/**
 * The base model: one logistic regression over every episode, shared by everyone.
 *
 * Why linear, when gradient boosting would score better:
 *
 *   A linear model's prediction is a dot product over columns that already exist
 *   in both `episodes_enriched` and `live_episodes`. That means the score can be
 *   written as a plain SQL expression and evaluated INSIDE the same query that
 *   filters on it — identically in a backtest and in the live feed, with no
 *   serving layer, no feature store, and no way for the two to drift. A tree
 *   ensemble would need a separate inference service and would immediately
 *   reintroduce exactly the backtest/live skew this whole design exists to avoid.
 *
 *   It is also auditable: a user can be shown which terms pushed a coin's score
 *   up or down, which matters when the product is "train your own agent".
 *
 * Users do not train their own model. They filter ON it — `model_score > 0.4`
 * plus whatever else they ask for. One well-fit model over 380k episodes beats
 * thousands of individually-overfit ones on a few hundred rows each.
 */

/** Label: reached +30% before falling -25%, within 10 minutes of entry.
 *  Order-aware — computed by walking the price path, not from a max/min pair. */
export const TP_MULT = 1.30;
export const SL_MULT = 0.75;

/**
 * Model inputs. `expr` is SQL valid against BOTH views.
 *
 * Heavily skewed counts are log1p'd: a linear model fed raw `vol_sol` (which
 * spans 0.001 to 900) is dominated by a handful of episodes, and the fitted
 * coefficient describes those rather than the population.
 */
export const MODEL_FEATURES: Array<{ name: string; expr: string }> = [
  { name: "log_n_trades",      expr: "log1p(n_trades)" },
  { name: "log_n_traders",     expr: "log1p(n_traders)" },
  { name: "log_n_buyers",      expr: "log1p(n_buyers)" },
  { name: "log_vol_sol",       expr: "log1p(vol_sol)" },
  { name: "log_fees_sol",      expr: "log1p(fees_sol + creator_fees_sol)" },
  { name: "buy_ratio",         expr: "ifNull(buy_ratio, 0.5)" },
  { name: "sell_frac",         expr: "n_sells / greatest(n_trades, 1)" },
  { name: "trades_per_s",      expr: "least(trades_per_s, 20)" },
  { name: "log_ret_in",        expr: "greatest(least(log_ret_in, 3), -3)" },
  { name: "concentration",     expr: "ifNull(top_trader_vol_share, 0)" },
  { name: "log_dev_buy",       expr: "log1p(dev_buy_sol)" },
  { name: "dev_sold",          expr: "dev_sold_in_window" },
  { name: "log_dev_launches",  expr: "log1p(dev_launch_count)" },
  { name: "log_handle_launches", expr: "log1p(handle_launch_count)" },
  { name: "tw_profile",        expr: "toUInt8(twitter_kind = 'profile')" },
  { name: "tw_status",         expr: "toUInt8(twitter_kind = 'status')" },
  { name: "tw_search",         expr: "toUInt8(twitter_kind = 'search')" },
  { name: "tw_none",           expr: "toUInt8(twitter_kind = 'none')" },
  { name: "has_telegram",      expr: "has_telegram" },
  { name: "has_website",       expr: "has_website" },
  { name: "has_image",         expr: "has_image" },
  { name: "log_mcap",          expr: "log1p(greatest(mcap_at_h, 0))" },
  { name: "log_real_sol",      expr: "log1p(greatest(real_sol_at_h, 0))" },
  { name: "llm_score",         expr: "llm_score" },
];

export interface BaseModel {
  version: number;
  trainedAt: string;
  horizonS: number;
  /** feature names in coefficient order; may be a SUBSET of MODEL_FEATURES —
   *  zero-variance columns are dropped at fit time and must stay dropped. */
  features: string[];
  mean: number[];
  std: number[];
  /** training-set p1 / p99 per feature. Inference CLIPS to these before scoring.
   *  Without it the model extrapolates: a wash-traded coin with 9,246 trades from
   *  2 wallets and 0.009 SOL of volume sat 140x beyond any training example and
   *  scored 0.95, because log_n_trades carries the largest positive weight. A
   *  linear model has no notion of "I have never seen this" unless it is given
   *  one. */
  lo: number[];
  hi: number[];
  weights: number[];
  bias: number;
  metrics: {
    nTrain: number;
    nTest: number;
    baseRate: number;
    auc: number;
    /** lift of the top decile over the base rate — the number a trader cares about */
    top10Lift: number;
    top10Rate: number;
    trainCutoff: string;
  };
}

/**
 * SQL for the model's probability, inlined into the views.
 *
 * Standardisation is folded into the expression so the views need no auxiliary
 * table: each term is w_i * (x_i - mean_i) / std_i.
 */
export function modelScoreSql(m: BaseModel | null): string {
  if (!m || !m.features.length) return "toFloat64(0)";
  const byName = new Map(MODEL_FEATURES.map((f) => [f.name, f.expr]));
  const terms = m.features.map((name, i) => {
    const expr = byName.get(name);
    if (!expr) throw new Error(`model references unknown feature ${name}`);
    const w = m.weights[i] / (m.std[i] || 1);
    const c = m.mean[i];
    // Clip to the training range FIRST, then standardise. Order matters: clipping
    // after standardising would still let an out-of-range value through scaled.
    const clipped = `greatest(least((${expr}), ${num(m.hi[i])}), ${num(m.lo[i])})`;
    return `(${num(w)}) * ((${clipped}) - (${num(c)}))`;
  });
  const z = `(${num(m.bias)}) + ${terms.join(" + ")}`;
  // Clamped before exp() so a wild feature value cannot overflow to inf/NaN and
  // silently turn the score column into nulls for a whole query.
  return `round(1 / (1 + exp(-greatest(least(${z}, 30), -30))), 6)`;
}

function num(x: number): string {
  if (!Number.isFinite(x)) return "0";
  return x.toExponential(10);
}
