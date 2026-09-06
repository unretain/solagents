/**
 * The strategy contract.
 *
 * A user describes a strategy in English; an LLM emits one of these; it is
 * validated here and then executed — identically — by the backtester, the paper
 * engine and the live executor. The LLM never writes code and never runs at
 * decision time. It is a compiler from English to this object, once, at save
 * time. What trades is a deterministic evaluator over a validated config.
 *
 * That separation is deliberate:
 *   - decisions are reproducible; the same config on the same data always gives
 *     the same trades, so a backtest means something
 *   - a strategy can be diffed, versioned and leaderboarded
 *   - no model call sits in the hot path of a market where the median coin is
 *     dead in two minutes
 */
import { z } from "zod";
import { FEATURES, FEATURE_NAMES, type FeatureName } from "./features.js";

const featureName = z.enum(FEATURE_NAMES as [FeatureName, ...FeatureName[]]);

const numericCondition = z.object({
  feature: featureName,
  op: z.enum(["gt", "gte", "lt", "lte", "eq", "neq"]),
  value: z.number(),
});

const enumCondition = z.object({
  feature: featureName,
  op: z.enum(["in", "nin"]),
  value: z.array(z.string()).min(1),
});

const boolCondition = z.object({
  feature: featureName,
  op: z.literal("is"),
  value: z.boolean(),
});

export const conditionSchema = z
  .union([numericCondition, enumCondition, boolCondition])
  .superRefine((c, ctx) => {
    // The op must match the feature's kind. Without this an LLM will happily
    // emit `twitter_kind gt 3`, which would silently evaluate to false forever
    // and produce a strategy that never trades and never errors.
    const def = FEATURES[c.feature as FeatureName];
    const kind = def.kind;
    const numericOps = ["gt", "gte", "lt", "lte", "eq", "neq"];
    if (kind === "number" && !numericOps.includes(c.op)) {
      ctx.addIssue({ code: "custom", message: `${c.feature} is numeric; op '${c.op}' does not apply` });
    }
    if (kind === "enum") {
      if (c.op !== "in" && c.op !== "nin") {
        ctx.addIssue({ code: "custom", message: `${c.feature} is an enum; use 'in' or 'nin'` });
      } else {
        const allowed = (def as { values?: readonly string[] }).values ?? [];
        for (const v of c.value as string[]) {
          if (!allowed.includes(v)) {
            ctx.addIssue({
              code: "custom",
              message: `${c.feature}: '${v}' is not one of ${allowed.join(", ")}`,
            });
          }
        }
      }
    }
    if (kind === "bool" && c.op !== "is") {
      ctx.addIssue({ code: "custom", message: `${c.feature} is a boolean; use 'is'` });
    }
  });

export type Condition = z.infer<typeof conditionSchema>;

export const strategySchema = z
  .object({
    version: z.literal(1),
    name: z.string().min(1).max(80),
    /** one-line description of the intent, for the leaderboard and for diffing */
    thesis: z.string().max(400).default(""),

    /**
     * How long after a coin's first trade the decision is made. Must be one of
     * the extracted horizons or the strategy cannot be backtested at all.
     * 60s is the default: enough trades to read the tape, early enough that the
     * median coin is still alive.
     */
    decide_at_s: z.union([z.literal(30), z.literal(60), z.literal(180)]),

    /** All must hold. Empty means "every coin", which is almost never intended. */
    entry_all: z.array(conditionSchema).max(20).default([]),
    /** At least one must hold. Empty means "no constraint", not "none may hold". */
    entry_any: z.array(conditionSchema).max(20).default([]),

    sizing: z.object({
      mode: z.enum(["fixed_sol", "pct_bankroll"]),
      value: z.number().positive(),
      max_concurrent: z.number().int().min(1).max(50).default(5),
    }),

    exit: z
      .object({
        take_profit_pct: z.number().positive().optional(),
        stop_loss_pct: z.number().positive().max(100).optional(),
        trailing_stop_pct: z.number().positive().max(100).optional(),
        /**
         * Required, and capped at 24h. On this market a position with no time
         * stop is not a position, it is a donation: p50 coin lifetime is 2
         * minutes, so "hold until target" usually means holding a dead chart.
         */
        max_hold_s: z.number().int().min(5).max(86_400),
      })
      .refine((e) => e.take_profit_pct !== undefined || e.stop_loss_pct !== undefined || e.trailing_stop_pct !== undefined, {
        message: "give at least one of take_profit_pct, stop_loss_pct, trailing_stop_pct alongside max_hold_s",
      }),

    risk: z.object({
      max_position_sol: z.number().positive(),
      max_daily_loss_sol: z.number().positive(),
      /** Hard ceiling on live capital. Ignored in backtest and paper. */
      max_total_deployed_sol: z.number().positive(),
    }),
  })
  .superRefine((s, ctx) => {
    if (s.entry_all.length === 0 && s.entry_any.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["entry_all"],
        message: "a strategy with no entry conditions buys every launch; state at least one condition",
      });
    }
    if (s.sizing.mode === "pct_bankroll" && s.sizing.value > 100) {
      ctx.addIssue({ code: "custom", path: ["sizing", "value"], message: "pct_bankroll cannot exceed 100" });
    }
    if (s.sizing.mode === "fixed_sol" && s.sizing.value > s.risk.max_position_sol) {
      ctx.addIssue({
        code: "custom",
        path: ["sizing", "value"],
        message: `position size ${s.sizing.value} exceeds max_position_sol ${s.risk.max_position_sol}`,
      });
    }
  });

export type Strategy = z.infer<typeof strategySchema>;

/** Human-readable validation failure, for showing back to the user or the LLM. */
export function explainInvalid(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
}
