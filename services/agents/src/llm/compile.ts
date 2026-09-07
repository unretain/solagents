/**
 * English -> Strategy config.
 *
 * The model runs ONCE, at save time, and never at decision time. What trades is
 * the validated JSON it produces. If this ever moves into the hot path, the
 * whole reproducibility argument for the backtester collapses.
 */
import type Anthropic from "@anthropic-ai/sdk";
// jsonSchemaOutputFormat, not zodOutputFormat: the Zod helper calls
// `z.toJSONSchema`, which only exists in Zod 4, and this project is on Zod 3.
// Upgrading Zod to satisfy one helper would put every validator in the codebase
// through a major-version migration for no gain - the schema below is written
// once and Zod still does the real validation after the model answers.
import { jsonSchemaOutputFormat } from "@anthropic-ai/sdk/helpers/json-schema";
import { client, modelId, llmConfigured } from "./client.js";
import { z } from "zod";
import { FEATURES } from "../strategy/features.js";
import { strategySchema, explainInvalid, type Strategy } from "../strategy/schema.js";

/** Model for strategy compilation. Config, not code, so it can be changed
 *  without a deploy - but the default is the most capable model, because a
 *  misread strategy is a silent loss of the user's money. */
const MODEL = modelId(process.env.COMPILE_MODEL || "claude-opus-5");

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

/**
 * The model writes `name` and `thesis`, and both render on the Build page, so a
 * model-authored em dash lands on the site no matter how clean the source is.
 * Instructing it is not enough to rely on, so strip on the way out too.
 */
function stripEmDashes<T>(v: T): T {
  if (typeof v === "string") return v.replace(/\s*—\s*/g, " - ") as unknown as T;
  if (Array.isArray(v)) return v.map(stripEmDashes) as unknown as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, stripEmDashes(x)])) as T;
  }
  return v;
}

/** The same shape as `draftSchema`, for the model. Kept beside it deliberately -
 *  if one changes the other must, and the Zod parse right after the call is what
 *  catches it if they drift. */
const cond = {
  type: "object",
  additionalProperties: false,
  properties: { feature: { type: "string" }, op: { type: "string" }, value: { type: "string" } },
  required: ["feature", "op", "value"],
} as const;

const DRAFT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
    thesis: { type: "string" },
    decide_at_s: { type: "number", enum: [30, 60, 180] },
    entry_all: { type: "array", items: cond },
    entry_any: { type: "array", items: cond },
    sizing: {
      type: "object", additionalProperties: false,
      properties: {
        mode: { type: "string", enum: ["fixed_sol", "pct_bankroll"] },
        value: { type: "number" },
        max_concurrent: { type: "number" },
      },
      required: ["mode", "value", "max_concurrent"],
    },
    exit: {
      type: "object", additionalProperties: false,
      properties: {
        take_profit_pct: { type: "number" },
        stop_loss_pct: { type: "number" },
        trailing_stop_pct: { type: "number" },
        max_hold_s: { type: "number" },
      },
      required: ["take_profit_pct", "stop_loss_pct", "trailing_stop_pct", "max_hold_s"],
    },
    risk: {
      type: "object", additionalProperties: false,
      properties: {
        max_position_sol: { type: "number" },
        max_daily_loss_sol: { type: "number" },
        max_total_deployed_sol: { type: "number" },
      },
      required: ["max_position_sol", "max_daily_loss_sol", "max_total_deployed_sol"],
    },
  },
  required: ["name", "thesis", "decide_at_s", "entry_all", "entry_any", "sizing", "exit", "risk"],
} as const;

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

Never use em dashes in any text you write. Use a plain hyphen.

Market facts that should inform your defaults - this is not a normal market:
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
  // Say what is actually wrong. Without this the SDK throws a generic auth error
  // and the page shows it verbatim, which reads like the feature is broken
  // rather than switched off.
  if (!llmConfigured()) {
    return {
      ok: false,
      error:
        "AI compile is off - no ANTHROPIC_API_KEY is configured. " +
        "Use “Build by hand” to set the same conditions yourself; everything else works.",
    };
  }

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: text }];

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await client.messages.parse({
      model: MODEL,
      max_tokens: 8000,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages,
      output_config: {
        // Low effort, deliberately. The prompt is ~1,000 tokens in and ~142 out;
        // at default effort the thinking tokens are ~2,500 and are billed as
        // output, so they are 93% of the bill - $0.067 a compile instead of
        // $0.005. This is constrained extraction into a fixed schema with a
        // validator and a repair round behind it, not a reasoning problem.
        effort: "low",
        format: jsonSchemaOutputFormat(DRAFT_JSON_SCHEMA),
      },
    });

    if (res.stop_reason === "refusal") {
      return { ok: false, error: "The model declined to write this strategy." };
    }
    const draft = res.parsed_output as z.infer<typeof draftSchema> | null;
    if (!draft) return { ok: false, error: "The model did not return a usable config." };

    const parsed = strategySchema.safeParse(coerce(stripEmDashes(draft)));
    if (parsed.success) return { ok: true, strategy: parsed.data };

    // One repair round. The model gets the exact validator output, which names
    // the offending path - far more useful than restating the rules.
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
    if (!def) return c; // unknown feature - let the real schema reject it by name
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
