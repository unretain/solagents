import "dotenv/config";
import express from "express";
import compression from "compression";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { FEATURES } from "./strategy/features.js";
import { strategySchema, explainInvalid, type Strategy } from "./strategy/schema.js";
import { livePicks, liveTape, publishedPicks } from "./live.js";
import { assertFeatureParity, toSql } from "./strategy/evaluate.js";
import { compileStrategy } from "./llm/compile.js";
import { runBacktest } from "./backtest/run.js";
import { q, newId } from "./db.js";
import { chQuery } from "./clickhouse.js";

// Boot-time gate. A feature that exists in SQL but not live (or the reverse)
// makes every backtest on this build unreproducible in production, so refuse to
// start rather than serve results nobody can trust.
assertFeatureParity();

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(compression());

const here = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(here, "../public"), { maxAge: "1h" }));

app.get("/health", (_req, res) => res.json({ ok: true }));

/** The feature catalogue drives the UI's filter builder — the UI never hardcodes
 *  a feature list, so adding one to features.ts makes it appear on the site. */
app.get("/api/features", (_req, res) => {
  res.json(
    Object.entries(FEATURES).map(([name, def]) => ({
      name,
      kind: def.kind,
      doc: def.doc,
      values: (def as { values?: readonly string[] }).values ?? null,
    })),
  );
});

app.get("/api/stats", async (_req, res, next) => {
  try {
    const [row] = await chQuery<{ episodes: string; coins: string; scored: string; newest: string }>(`
      SELECT
        (SELECT count() FROM episodes)                       AS episodes,
        (SELECT uniqExact(mint) FROM episodes)               AS coins,
        (SELECT count() FROM coin_scores)                    AS scored,
        (SELECT toString(max(t0)) FROM episodes)             AS newest
      FORMAT JSON`);
    res.json(row ?? {});
  } catch (e) { next(e); }
});

app.post("/api/compile", async (req, res, next) => {
  try {
    const { text } = z.object({ text: z.string().min(3).max(4000) }).parse(req.body);
    res.json(await compileStrategy(text));
  } catch (e) { next(e); }
});

const backtestBody = z.object({
  strategy: z.unknown(),
  from: z.string().optional(),
  to: z.string().optional(),
  bankrollSol: z.number().positive().max(10_000).optional(),
  feeBps: z.number().min(0).max(2000).optional(),
});

app.post("/api/backtest", async (req, res, next) => {
  try {
    const body = backtestBody.parse(req.body);
    const parsed = strategySchema.safeParse(body.strategy);
    if (!parsed.success) return res.status(400).json({ error: explainInvalid(parsed.error) });
    const result = await runBacktest(parsed.data, {
      from: body.from, to: body.to, bankrollSol: body.bankrollSol, feeBps: body.feeBps,
    });
    res.json({ ...result, sql: toSql(parsed.data) });
  } catch (e) { next(e); }
});

app.post("/api/strategies", async (req, res, next) => {
  try {
    const body = z
      .object({
        strategy: z.unknown(),
        prompt: z.string().max(4000).default(""),
        isPublic: z.boolean().default(true),
        ownerId: z.string().nullable().default(null),
      })
      .parse(req.body);
    const parsed = strategySchema.safeParse(body.strategy);
    if (!parsed.success) return res.status(400).json({ error: explainInvalid(parsed.error) });

    const s = parsed.data;
    const id = newId("st");
    await q(
      `INSERT INTO sa_strategy (id, owner_id, name, thesis, prompt, config, is_public)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, body.ownerId, s.name, s.thesis, body.prompt, JSON.stringify(s), body.isPublic],
    );

    // Backtest on publish, so the leaderboard is never populated by a strategy
    // whose numbers nobody has actually computed.
    const r = await runBacktest(s);
    await q(
      `INSERT INTO sa_backtest (id, strategy_id, window_from, window_to, n_trades, win_pct,
         geo_mult, total_pnl_sol, volume_sol, max_dd_sol, result)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [newId("bt"), id, r.from, r.to, r.nTrades, r.winPct, r.geoMult,
       r.totalPnlSol, r.volumeSol, r.maxDrawdownSol, JSON.stringify(r)],
    );
    res.json({ id, backtest: r });
  } catch (e) { next(e); }
});

app.get("/api/strategies", async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT s.id, s.name, s.thesis, s.prompt, s.created_at,
             b.n_trades, b.win_pct, b.geo_mult, b.total_pnl_sol, b.volume_sol
      FROM sa_strategy s
      LEFT JOIN LATERAL (
        SELECT * FROM sa_backtest b2 WHERE b2.strategy_id = s.id
        ORDER BY b2.created_at DESC LIMIT 1
      ) b ON TRUE
      WHERE s.is_public
      ORDER BY s.created_at DESC LIMIT 100`));
  } catch (e) { next(e); }
});

app.get("/api/strategies/:id", async (req, res, next) => {
  try {
    const [row] = await q(`SELECT * FROM sa_strategy WHERE id = $1`, [req.params.id]);
    if (!row) return res.status(404).json({ error: "not found" });
    res.json(row);
  } catch (e) { next(e); }
});

/**
 * Leaderboard.
 *
 * `mode` is 'backtest' | 'paper' | 'live'. They are ranked SEPARATELY and never
 * merged: a backtest is a claim about the past, a paper run is a claim about the
 * present, and only a live run risked anything. Blending them would let a
 * strategy that has never traded outrank one that has.
 */
app.get("/api/leaderboard", async (req, res, next) => {
  try {
    const mode = z.enum(["backtest", "paper", "live"]).catch("backtest").parse(req.query.mode);

    if (mode === "backtest") {
      return res.json(await q(`
        SELECT s.id, s.name, s.thesis, b.n_trades, b.win_pct, b.geo_mult,
               b.total_pnl_sol, b.volume_sol, b.max_dd_sol, b.created_at
        FROM sa_strategy s
        JOIN LATERAL (
          SELECT * FROM sa_backtest b2 WHERE b2.strategy_id = s.id
          ORDER BY b2.created_at DESC LIMIT 1
        ) b ON TRUE
        WHERE s.is_public
          -- Below this a rank is noise, not skill.
          AND b.n_trades >= 30
        ORDER BY b.geo_mult DESC LIMIT 100`));
    }

    res.json(await q(`
      SELECT r.id AS run_id, s.id, s.name, s.thesis, r.mode, r.status, r.halt_reason,
             r.bankroll_sol, r.started_at,
             count(p.id) FILTER (WHERE p.closed_at IS NOT NULL) AS n_trades,
             coalesce(sum(p.pnl_sol), 0)                        AS total_pnl_sol,
             coalesce(sum(p.size_sol), 0)                       AS volume_sol,
             coalesce(avg((p.pnl_sol > 0)::int) * 100, 0)       AS win_pct
      FROM sa_run r
      JOIN sa_strategy s ON s.id = r.strategy_id
      LEFT JOIN sa_position p ON p.run_id = r.id
      WHERE r.mode = $1 AND s.is_public
      GROUP BY r.id, s.id
      HAVING count(p.id) FILTER (WHERE p.closed_at IS NOT NULL) > 0
      ORDER BY total_pnl_sol DESC LIMIT 100`, [mode]));
  } catch (e) { next(e); }
});

/** Live tape — what the feed is seeing right now, unfiltered. Lets an empty
 *  picks list be told apart from a stalled feed. */
app.get("/api/live/tape", async (_req, res, next) => {
  try { res.json(await liveTape()); } catch (e) { next(e); }
});

/** Live matches for a draft strategy the user has not saved yet. */
app.post("/api/live/test", async (req, res, next) => {
  try {
    const parsed = strategySchema.safeParse(z.object({ strategy: z.unknown() }).parse(req.body).strategy);
    if (!parsed.success) return res.status(400).json({ error: explainInvalid(parsed.error) });
    res.json(await livePicks(parsed.data));
  } catch (e) { next(e); }
});

/** Live picks across every published strategy — the public board. */
app.get("/api/live/picks", async (_req, res, next) => {
  try {
    const rows = await q<{ id: string; name: string; config: Strategy }>(
      `SELECT id, name, config FROM sa_strategy WHERE is_public ORDER BY created_at DESC LIMIT 25`,
    );
    res.json(await publishedPicks(rows));
  } catch (e) { next(e); }
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[agents]", err.message);
  res.status(500).json({ error: err.message });
});

// Railway (and most PaaS) inject PORT and expect the process to bind it on all
// interfaces. AGENTS_PORT stays as the local/systemd fallback.
const PORT = Number(process.env.PORT || process.env.AGENTS_PORT || 3002);
app.listen(PORT, "0.0.0.0", () => console.log(`solagents API on :${PORT}`));
