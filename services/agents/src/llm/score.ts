/**
 * LLM judgement of a coin's presentation, written to `coin_scores`.
 *
 * Scored ONCE per coin. Both the backtester and the live engine read the stored
 * score, so a backtest and a live run see the identical judgement — two separate
 * model calls on the same coin would not agree, and the strategy would behave
 * differently in the two places for reasons no one could debug.
 *
 * Backfill goes through the Batches API (50% cost, results within 24h, which is
 * fine for history). Live scoring of brand-new coins uses a direct call.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { chQuery, chWrite, lit } from "../clickhouse.js";

const client = new Anthropic();

/**
 * Haiku by explicit budget decision, not by default.
 *
 * Scoring every launch on Opus would be ~$3,000/mo at 40k coins/day. The task
 * here is a coarse four-bucket judgement of presentation quality, which Haiku
 * does well, and the budget for this whole feature is $40.
 */
const MODEL = process.env.SCORE_MODEL || "claude-haiku-4-5";
const PROMPT_VERSION = 1;

/**
 * Hard ceiling on how many coins will ever be scored, enforced against the row
 * count in `coin_scores` before each run. ~$0.0005/coin on Haiku, so the default
 * 30,000 is roughly $15 — comfortably inside a $40 budget even if it runs twice.
 * A runaway loop over a 40k/day firehose is the failure mode this exists to stop.
 */
const MAX_SCORED = Number(process.env.SCORE_MAX_COINS || 30_000);

export async function budgetRemaining(): Promise<number> {
  const [row] = await chQuery<{ n: string }>(`SELECT count() AS n FROM coin_scores FORMAT JSON`);
  return Math.max(0, MAX_SCORED - Number(row?.n ?? 0));
}

const scoreSchema = z.object({
  score: z.number().min(0).max(100),
  verdict: z.enum(["slop", "generic", "decent", "strong"]),
  reason: z.string().max(200),
});

const SYSTEM = `You rate how a newly launched Solana memecoin presents itself. You are given its name, symbol, description, and social links.

You are NOT predicting price. You are judging presentation quality — whether a real person put real effort into this, or whether it is one of the thousands of throwaway launches minted every day.

Signals of effort: a coherent name/symbol/description that share a concept; a real x.com profile; a working site; a description that says something specific rather than generic hype.
Signals of slop: empty or one-word descriptions; pure ticker spam; "1000x" / "next pepe" filler; a link to someone else's tweet rather than the project's own account; a link that is an x.com SEARCH url, which means the launcher had no account to point at.

Scoring:
  0-25   slop     — no discernible effort
  26-50  generic  — template launch, nothing wrong, nothing distinctive
  51-75  decent   — coherent concept, some real effort
  76-100 strong   — genuinely well presented, real identity behind it

Be harsh. On this market the overwhelming majority of launches are slop, and a scale where most coins score "decent" is useless as a filter. Give one short sentence of reasoning.`;

export interface CoinMeta {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  twitter: string;
  website: string;
  telegram: string;
}

/** Fetch the metadata JSON for its description. Served from the box's own IPFS
 *  node, so this is a local call, not a public gateway round trip. */
async function description(uri: string): Promise<string> {
  if (!uri) return "";
  const gw = process.env.IPFS_GATEWAY || "http://127.0.0.1:8080";
  const url = uri.startsWith("ipfs://") ? `${gw}/ipfs/${uri.slice(7)}` : uri;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return "";
    const j = (await r.json()) as { description?: unknown };
    return typeof j.description === "string" ? j.description.slice(0, 1000) : "";
  } catch {
    return ""; // a coin whose metadata will not load is itself a weak signal
  }
}

function promptFor(m: CoinMeta, desc: string): string {
  return [
    `name: ${m.name || "(none)"}`,
    `symbol: ${m.symbol || "(none)"}`,
    `description: ${desc || "(none)"}`,
    `x.com: ${m.twitter || "(none)"}`,
    `website: ${m.website || "(none)"}`,
    `telegram: ${m.telegram || "(none)"}`,
  ].join("\n");
}

export async function scoreOne(m: CoinMeta): Promise<z.infer<typeof scoreSchema> | null> {
  const desc = await description(m.uri);
  const res = await client.messages.parse({
    model: MODEL,
    max_tokens: 1000,
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: promptFor(m, desc) }],
    output_config: { format: zodOutputFormat(scoreSchema) },
  });
  if (res.stop_reason === "refusal") return null;
  const out = res.parsed_output;
  if (!out) return null;
  await persist(m.mint, out, !!desc);
  return out;
}

async function persist(mint: string, s: z.infer<typeof scoreSchema>, hadDesc: boolean): Promise<void> {
  await chWrite(
    `INSERT INTO coin_scores (mint, llm_score, llm_verdict, llm_reason, had_tweet_text, had_description, prompt_version)
     VALUES (${lit(mint)}, ${Math.round(s.score)}, ${lit(s.verdict)}, ${lit(s.reason)}, 0, ${hadDesc ? 1 : 0}, ${PROMPT_VERSION})`,
  );
}

/**
 * Coins worth spending a model call on.
 *
 * NOT simply "everything unscored". Half of all launches see fewer than 8 trades
 * in their entire life and no strategy will ever trade them, so scoring those
 * would burn most of the budget on coins nobody can act on. The prefilter is
 * free (it is already in `episodes`) and cuts the population by ~95%.
 *
 * Ordered by volume so the budget lands on the coins most likely to appear in a
 * backtest or a live pick.
 */
export async function unscored(limit = 500): Promise<CoinMeta[]> {
  const room = await budgetRemaining();
  if (room <= 0) return [];

  return chQuery<CoinMeta>(`
    WITH candidates AS (
      SELECT mint, max(vol_sol) AS v
      FROM episodes
      WHERE horizon_s = 60 AND n_traders >= 10 AND vol_sol >= 3
      GROUP BY mint
    )
    SELECT t.mint AS mint, argMax(t.name, t.ingested_at) AS name, argMax(t.symbol, t.ingested_at) AS symbol,
           argMax(t.uri, t.ingested_at) AS uri, argMax(t.twitter, t.ingested_at) AS twitter,
           argMax(t.website, t.ingested_at) AS website, argMax(t.telegram, t.ingested_at) AS telegram
    FROM tokens AS t
    INNER JOIN candidates AS c ON t.mint = c.mint
    WHERE t.mint NOT IN (SELECT mint FROM coin_scores)
    GROUP BY t.mint, c.v
    ORDER BY c.v DESC
    LIMIT ${Math.min(limit, room)}
    FORMAT JSON`);
}

/**
 * Submit a batch of scoring requests. Returns the batch id; results are
 * collected later by `collectBatch`. Batches cost 50% of standard rates and
 * complete within 24h, which suits history backfill and does not suit live.
 */
export async function submitBatch(coins: CoinMeta[]): Promise<string> {
  const descs = await Promise.all(coins.map((c) => description(c.uri)));
  const batch = await client.messages.batches.create({
    requests: coins.map((c, i) => ({
      custom_id: c.mint,
      params: {
        model: MODEL,
        max_tokens: 1000,
        system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: promptFor(c, descs[i]) }],
        output_config: { format: zodOutputFormat(scoreSchema) },
      },
    })),
  });
  return batch.id;
}

export async function collectBatch(batchId: string): Promise<number> {
  const batch = await client.messages.batches.retrieve(batchId);
  if (batch.processing_status !== "ended") return -1;

  let written = 0;
  // Results come back in ARBITRARY order — keyed by custom_id, never by index.
  for await (const entry of await client.messages.batches.results(batchId)) {
    if (entry.result.type !== "succeeded") continue;
    const text = entry.result.message.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") continue;
    const parsed = scoreSchema.safeParse(JSON.parse(text.text));
    if (!parsed.success) continue;
    await persist(entry.custom_id, parsed.data, true);
    written++;
  }
  return written;
}
