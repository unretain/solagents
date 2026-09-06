/**
 * THE feature namespace.
 *
 * Every feature an agent can condition on is declared here exactly once, with
 * both of its implementations bound side by side:
 *
 *   ch    — the ClickHouse expression that produces it from `episodes` (backtest)
 *   live  — the function that produces it from live feed state (paper + real)
 *
 * They are declared together so the two can never drift apart. A feature that
 * exists in one and not the other is the single most expensive bug this kind of
 * platform can have: backtests look profitable, live loses money, and nothing in
 * the code says why. `npm run check:parity` asserts every entry has both.
 *
 * Adding a feature means adding one row here. Nothing else needs to change.
 */

export type FeatureKind = "number" | "enum" | "bool";

/** Live token state assembled from the feed at decision time. */
export interface LiveToken {
  mint: string;
  t0Ms: number;                 // first observed trade
  nowMs: number;
  trades: Array<{ tsMs: number; isBuy: boolean; solAmount: number; priceSol: number; trader: string; feeSol: number }>;
  priceSol: number;
  mcapSol: number;
  twitter: string;
  telegram: string;
  website: string;
  image: string;
  devWallet: string;
  /** launches previously seen from this dev wallet */
  devLaunchCount: number;
  /** launches previously seen from this x.com handle */
  handleLaunchCount: number;
  /** from `coin_scores`; undefined until the async scorer has reached this coin */
  llmScore?: number;
  llmVerdict?: string;
  /** base-model probability, evaluated in SQL by the live view */
  modelScore?: number;
}

export interface FeatureDef {
  kind: FeatureKind;
  /** what it means, in the words the strategy author would use */
  doc: string;
  /** enum members, when kind === "enum" */
  values?: readonly string[];
  /** ClickHouse expression over `episodes` */
  ch: string;
  /** live computation from feed state */
  live: (t: LiveToken) => number | string | boolean;
}

const inWindow = (t: LiveToken) => t.trades.filter((x) => x.tsMs <= t.nowMs);
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function twitterKind(url: string): string {
  if (!url) return "none";
  if (url.includes("/search")) return "search";
  if (url.includes("/status/")) return "status";
  if (/x\.com\/[A-Za-z0-9_]+\/?($|\?)/.test(url)) return "profile";
  return "other";
}

export const FEATURES = {
  // ---------------------------------------------------------------- activity
  age_s: {
    kind: "number",
    doc: "Seconds since the coin's first trade.",
    ch: "horizon_s",
    live: (t) => (t.nowMs - t.t0Ms) / 1000,
  },
  n_trades: {
    kind: "number",
    doc: "Trades so far. Median coin sees 8 in its whole life.",
    ch: "n_trades",
    live: (t) => inWindow(t).length,
  },
  n_traders: {
    kind: "number",
    doc: "Distinct wallets that have traded.",
    ch: "n_traders",
    live: (t) => new Set(inWindow(t).map((x) => x.trader)).size,
  },
  n_buyers: {
    kind: "number",
    doc: "Distinct wallets that have bought.",
    ch: "n_buyers",
    live: (t) => new Set(inWindow(t).filter((x) => x.isBuy).map((x) => x.trader)).size,
  },
  trades_per_s: {
    kind: "number",
    doc: "Trade rate. The clearest early proxy for attention.",
    ch: "trades_per_s",
    live: (t) => inWindow(t).length / Math.max(1, (t.nowMs - t.t0Ms) / 1000),
  },

  // ------------------------------------------------------------------ volume
  vol_sol: {
    kind: "number",
    doc: "Total SOL traded so far.",
    ch: "vol_sol",
    live: (t) => sum(inWindow(t).map((x) => x.solAmount)),
  },
  buy_ratio: {
    kind: "number",
    doc: "Buy volume / total volume. 0.5 is balanced; >0.5 is net buying pressure.",
    ch: "buy_ratio",
    live: (t) => {
      const w = inWindow(t);
      const tot = sum(w.map((x) => x.solAmount));
      return tot > 0 ? sum(w.filter((x) => x.isBuy).map((x) => x.solAmount)) / tot : 0;
    },
  },
  fees_sol: {
    kind: "number",
    doc: "Protocol + creator fees actually paid, read from the trade event (not inferred from a rate).",
    ch: "fees_sol + creator_fees_sol",
    live: (t) => sum(inWindow(t).map((x) => x.feeSol)),
  },

  // ----------------------------------------------------------------- price
  price_sol: {
    kind: "number",
    doc: "Current price in SOL, from the bonding curve's virtual reserves.",
    ch: "px_at_h",
    live: (t) => t.priceSol,
  },
  mcap_sol: {
    kind: "number",
    doc: "Market cap in SOL. Exactly price_sol * 1e9 — do not use alongside price_sol.",
    ch: "mcap_at_h",
    live: (t) => t.mcapSol,
  },
  log_ret_so_far: {
    kind: "number",
    doc: "ln(current price / first price). 0.69 is a double.",
    ch: "log_ret_in",
    live: (t) => {
      const w = inWindow(t);
      const first = w[0]?.priceSol ?? 0;
      return first > 0 && t.priceSol > 0 ? Math.log(t.priceSol / first) : 0;
    },
  },

  // ------------------------------------------------------- who is trading it
  top_trader_vol_share: {
    kind: "number",
    doc: "Largest single wallet's share of volume, 0..1. High means one wallet is the market.",
    ch: "top_trader_vol_share",
    live: (t) => {
      const w = inWindow(t);
      const tot = sum(w.map((x) => x.solAmount));
      if (tot <= 0) return 0;
      const per = new Map<string, number>();
      for (const x of w) per.set(x.trader, (per.get(x.trader) ?? 0) + x.solAmount);
      return Math.max(...per.values()) / tot;
    },
  },
  dev_buy_sol: {
    kind: "number",
    doc: "SOL the dev (first buyer) put in.",
    ch: "dev_buy_sol",
    live: (t) => sum(inWindow(t).filter((x) => x.trader === t.devWallet && x.isBuy).map((x) => x.solAmount)),
  },
  dev_sold: {
    kind: "bool",
    doc: "The dev has already sold. Measured, not guessed.",
    ch: "dev_sold_in_window",
    live: (t) => inWindow(t).some((x) => x.trader === t.devWallet && !x.isBuy),
  },
  dev_launch_count: {
    kind: "number",
    doc: "How many coins this dev wallet has launched before. Serial deployers behave differently.",
    ch: "dev_launch_count",
    live: (t) => t.devLaunchCount,
  },

  // -------------------------------------------------------------- the socials
  twitter_kind: {
    kind: "enum",
    values: ["none", "profile", "status", "search", "other"] as const,
    doc:
      "Shape of the x.com link. Measured over 2026-09-05: profile graduates 9.5% of the " +
      "time vs 2.5% for none and 1.1% for status. A status link rides someone else's " +
      "tweet — high volume, almost never graduates.",
    ch: "twitter_kind",
    live: (t) => twitterKind(t.twitter),
  },
  handle_launch_count: {
    kind: "number",
    doc: "How many coins this x.com handle has been attached to before.",
    ch: "handle_launch_count",
    live: (t) => t.handleLaunchCount,
  },
  has_telegram: { kind: "bool", doc: "Has a Telegram link.", ch: "has_telegram", live: (t) => !!t.telegram },
  has_website:  { kind: "bool", doc: "Has a website link.",  ch: "has_website",  live: (t) => !!t.website },
  has_image:    { kind: "bool", doc: "Has a resolved logo.",  ch: "has_image",    live: (t) => !!t.image },

  // ------------------------------------------------------------ LLM judgement
  // Scored ONCE per coin into `coin_scores` and read from there by both paths.
  // Never a model call at decision time: a backtest over 20k episodes would mean
  // 20k calls, and a live agent cannot wait on one in a market where the median
  // coin is dead in two minutes.
  llm_score: {
    kind: "number",
    doc:
      "0-100 LLM rating of the coin's presentation (name, description, socials, tweet " +
      "when available). 0 means NOT SCORED, which is not the same as a bad score — a " +
      "filter like llm_score > 60 therefore also excludes unscored coins, on purpose.",
    ch: "llm_score",
    live: (t) => t.llmScore ?? 0,
  },
  // ---------------------------------------------------------- the base model
  model_score: {
    kind: "number",
    doc:
      "The base model's probability (0-1) that this coin reaches +30% before -25% " +
      "within 10 minutes of entry. Trained on every episode; the single most useful " +
      "filter here. 0 means the model has not been fitted yet, so a threshold filter " +
      "matches nothing rather than everything.",
    ch: "model_score",
    live: (t) => t.modelScore ?? 0,
  },
  llm_verdict: {
    kind: "enum",
    values: ["unscored", "slop", "generic", "decent", "strong"] as const,
    doc:
      "Coarse bucket of the LLM rating. Prefer this over llm_score for filters: the " +
      "model is judging presentation, and a bucket is about as much precision as that " +
      "judgement actually supports.",
    ch: "llm_verdict",
    live: (t) => t.llmVerdict ?? "unscored",
  },
} as const satisfies Record<string, FeatureDef>;

export type FeatureName = keyof typeof FEATURES;
export const FEATURE_NAMES = Object.keys(FEATURES) as FeatureName[];
