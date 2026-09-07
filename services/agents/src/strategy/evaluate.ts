/**
 * Strategy evaluation, in both directions.
 *
 *   toSql(strategy)         -> a ClickHouse WHERE clause over `episodes_enriched`
 *   matchesLive(strategy,t) -> boolean, from live feed state
 *
 * Both are generated from the SAME `FEATURES` table, so a feature cannot mean
 * one thing in a backtest and another thing in production. They live in one file
 * so a change to either is impossible to make without seeing the other.
 */
import { FEATURES, type FeatureName, type LiveToken } from "./features.js";
import type { Condition, Strategy } from "./schema.js";

// ---------------------------------------------------------------- SQL target

const SQL_OP: Record<string, string> = {
  gt: ">", gte: ">=", lt: "<", lte: "<=", eq: "=", neq: "!=",
};

/** ClickHouse string literal. Values reaching here are already schema-validated
 *  to be enum members, but this is the boundary where a config becomes SQL, so
 *  it escapes regardless rather than trusting the caller. */
function sqlStr(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

function conditionToSql(c: Condition): string {
  const expr = FEATURES[c.feature as FeatureName].ch;
  switch (c.op) {
    case "in":
      return `${expr} IN (${(c.value as string[]).map(sqlStr).join(", ")})`;
    case "nin":
      return `${expr} NOT IN (${(c.value as string[]).map(sqlStr).join(", ")})`;
    case "is":
      return `${expr} = ${c.value ? 1 : 0}`;
    default:
      return `${expr} ${SQL_OP[c.op]} ${Number(c.value)}`;
  }
}

export function toSql(s: Strategy): string {
  const parts: string[] = [`horizon_s = ${s.decide_at_s}`];
  for (const c of s.entry_all) parts.push(conditionToSql(c));
  if (s.entry_any.length) parts.push(`(${s.entry_any.map(conditionToSql).join(" OR ")})`);
  // An episode with no entry price was never enterable - excluding it here keeps
  // the denominator honest instead of counting it as a flat trade.
  parts.push("px_at_h > 0");
  return parts.join("\n  AND ");
}

// --------------------------------------------------------------- live target

function compare(actual: number, op: string, want: number): boolean {
  switch (op) {
    case "gt": return actual > want;
    case "gte": return actual >= want;
    case "lt": return actual < want;
    case "lte": return actual <= want;
    case "eq": return actual === want;
    case "neq": return actual !== want;
    default: return false;
  }
}

function matchesCondition(c: Condition, t: LiveToken): boolean {
  const v = FEATURES[c.feature as FeatureName].live(t);
  switch (c.op) {
    case "in": return (c.value as string[]).includes(String(v));
    case "nin": return !(c.value as string[]).includes(String(v));
    case "is": return Boolean(v) === c.value;
    default: return compare(Number(v), c.op, Number(c.value));
  }
}

export function matchesLive(s: Strategy, t: LiveToken): boolean {
  const ageS = (t.nowMs - t.t0Ms) / 1000;
  // The decision is made AT the horizon, not any time after it. Without this a
  // live agent would re-evaluate a coin every tick and enter late on a chart the
  // backtest only ever judged at t0 + decide_at_s.
  if (ageS < s.decide_at_s) return false;
  if (!s.entry_all.every((c) => matchesCondition(c, t))) return false;
  if (s.entry_any.length && !s.entry_any.some((c) => matchesCondition(c, t))) return false;
  return true;
}

// ------------------------------------------------------------------- parity

/**
 * Asserts every declared feature has both implementations. Called by
 * `npm run check:parity` in CI and at service boot - a feature that is
 * SQL-only would make backtests unreproducible live, and the failure would
 * otherwise show up as unexplained live underperformance months later.
 */
export function assertFeatureParity(): void {
  const broken: string[] = [];
  for (const [name, def] of Object.entries(FEATURES)) {
    if (!def.ch || typeof def.ch !== "string") broken.push(`${name}: missing ClickHouse expression`);
    if (typeof def.live !== "function") broken.push(`${name}: missing live implementation`);
  }
  if (broken.length) throw new Error(`feature parity broken:\n${broken.join("\n")}`);
}
