/**
 * English -> Strategy config.
 *
 * The model runs ONCE, at save time, and never at decision time. What trades is
 * the validated JSON it produces. If this ever moves into the hot path, the
 * whole reproducibility argument for the backtester collapses.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { FEATURES } from "../strategy/features.js";
import { strategySchema, explainInvalid, type Strategy } from "../strategy/schema.js";

const client = new Anthropic();

/** Model for strategy compilation. Config, not code, so it can be changed
 *  without a deploy — but the default is the most capable model, because a
 *  misread strategy is a silent loss of the user's money. */
const MODEL = process.env.COMPILE_MODEL || "claude-opus-5";

/**
 * A LOOSE mirror of the strategy shape.
 *
 * The real `strategySchema` carries `superRefine` rules (op must match feature
 * kind, size must respect max_position_sol, ...) that JSON Schema cannot
 * express, so they would be invisible to the model. We therefore generate
 * against a plain shape and validate with the real schema afterwards, handing
 * any failure back for one repair attempt. Trying to encode the refinements in
 * the output format instead would silently drop them.
 */
const draftSchema = z.object({
  name: z.string(),
  thesis: z.string(),
  decide_at_s: z.number(),
  entry_all: z.array(z.object({ feature: z.string(), op: z.string(), value: z.string() })),
  entry_any: z.array(z.object({ feature: z.string(), op: z.string(), value: z.string() })),
  sizing: z.object({ mode: z.string(), value: z.number(), max_concurrent: z.number() }),
  exit: z.object({
    take_profit_pct: z.number(),
    stop_loss_pct: z.number(),
    trailing_stop_pct: z.number(),
    max_hold_s: z.number(),
  }),
  risk: z.object({
    max_position_sol: z.number(),
    max_daily_loss_sol: z.number(),
    max_total_deployed_sol: z.number(),
  }),
});

function featureCatalogue(): string {
  return Object.entries(FEATURES)
    .map(([name, def]) => {
      const vals = (def as { values?: readonly string[] }).values;
      const kind = vals ? `enum(${vals.join("|")})` : def.kind;
      return `- ${name} [${kind}]: ${def.doc}`;
    })
    .join("\n");
}

const SYSTEM = `You translate a plain-English trading strategy into a strategy config for a Solana memecoin agent platform.

You may ONLY use the features below. Never invent a feature name.

${featureCatalogue()}

Operators: numeric features take gt/gte/lt/lte/eq/neq; enum features take in/nin; boolean features take is.
Encode every "value" as a STRING: "15", "0.55", "true", or for enums a comma-separated list like "profile,decent".

Market facts that should inform your defaults — this is not a normal market:
- The median coin trades for 2 minutes and sees 8 trades. p75 is 38 minutes.
- Buying at 60s and holding 5 minutes loses ~46% on average across all launches. Entry filters are what make a strategy viable, and exits are what make it profitable.
- A bare x.com profile link graduates ~9.5% of the time; no link ~2.5%; a link to someone else's tweet ~1.1% despite high volume.
- Devs who have launched before perform monotonically worse.
- Fees plus bonding-curve slippage cost roughly 2-5% round trip, so a take-profit under ~10% rarely survives costs.

Rules:
- max_hold_s is REQUIRED and should usually be 60-600 given the lifetimes above.
- Always give at least one entry condition. A strategy with none buys every launch.
- sizing.value must not exceed risk.max_position_sol.
- If the user does not state risk limits, choose conservative ones and say so in the thesis.
- The thesis is one sentence describing the intent, so a reader can tell what the strategy believes.`;

export interface CompileResult {
  ok: boolean;
  strategy?: Strategy;
  error?: string;
  /** what the model produced, for showing the user when validation fails */
  draft?: unknown;
}

export async function compileStrategy(text: string): Promise<CompileResult> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: text }];

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await client.messages.parse({
      model: MODEL,
      max_tokens: 8000,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages,
      output_config: { format: zodOutputFormat(draftSchema) },
    });

    if (res.stop_reason === "refusal") {
      return { ok: false, error: "The model declined to write this strategy." };
    }
    const draft = res.parsed_output;
    if (!draft) return { ok: false, error: "The model did not return a usable config." };

    const parsed = strategySchema.safeParse(coerce(draft));
    if (parsed.success) return { ok: true, strategy: parsed.data };

    // One repair round. The model gets the exact validator output, which names
    // the offending path — far more useful than restating the rules.
    if (attempt === 0) {
      messages.push(
        { role: "assistant", content: JSON.stringify(draft) },
        {
          role: "user",
          content: `That config failed validation:\n${explainInvalid(parsed.error)}\n\nReturn a corrected config.`,
        },
      );
      continue;
    }
    return { ok: false, error: explainInvalid(parsed.error), draft };
  }
  return { ok: false, error: "unreachable" };
}

/**
 * Turn the model's string-valued draft into the real config's types.
 *
 * The draft asks for strings deliberately: a JSON Schema union of
 * number|boolean|string[] on the same field is exactly the shape models get
 * wrong most often, and a mistyped value there is silently un-fixable later.
 * One string field, coerced here by the feature's declared kind, has one
 * failure mode instead of three.
 */
function coerce(draft: z.infer<typeof draftSchema>): unknown {
  const conv = (c: { feature: string; op: string; value: string }) => {
    const def = (FEATURES as Record<string, { kind: string } | undefined>)[c.feature];
    if (!def) return c; // unknown feature — let the real schema reject it by name
    if (def.kind === "enum") return { ...c, value: c.value.split(",").map((s) => s.trim()).filter(Boolean) };
    if (def.kind === "bool") return { ...c, value: /^(true|1|yes)$/i.test(c.value.trim()) };
    return { ...c, value: Number(c.value) };
  };
  return {
    ...draft,
    version: 1,
    entry_all: (draft.entry_all ?? []).map(conv),
    entry_any: (draft.entry_any ?? []).map(conv),
  };
}
