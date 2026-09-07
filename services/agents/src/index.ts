import "dotenv/config";
import express from "express";
import compression from "compression";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { FEATURES } from "./strategy/features.js";
import { strategySchema, explainInvalid, type Strategy } from "./strategy/schema.js";
import { livePicks, liveTape, publishedPicks, liveTrades, scanRate } from "./live.js";
import { startPaperEngine } from "./paper.js";
import { attach } from "./stream.js";
import { TP_MULT, SL_MULT } from "./model/spec.js";
import { assertFeatureParity, toSql } from "./strategy/evaluate.js";
import { compileStrategy } from "./llm/compile.js";
import { runBacktest } from "./backtest/run.js";
import { q, newId, migrate, describeError } from "./db.js";
import { chQuery } from "./clickhouse.js";

// Boot-time gate. A feature that exists in SQL but not live (or the reverse)
// makes every backtest on this build unreproducible in production, so refuse to
// start rather than serve results nobody can trust.
assertFeatureParity();

const app = express();
app.use(express.json({ limit: "256kb" }));
app.use(compression({
  // SSE must never be buffered by the compressor, or events sit in a gzip
  // window until it flushes and the "live" feed arrives in clumps — the exact
  // problem the stream exists to remove.
  filter: (req, res) =>
    String(res.getHeader("Content-Type") || "").includes("text/event-stream")
      ? false
      : compression.filter(req, res),
}));

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

/** Live trade stream. One tailer fans out to every connected browser. */
app.get("/api/live/stream", (_req, res) => attach(res));

/** The raw firehose as a snapshot — used to fill the table before the stream
 *  produces its first rows, so the panel is never empty on load. */
app.get("/api/live/trades", async (_req, res, next) => {
  try {
    const [trades, rate] = await Promise.all([liveTrades(60), scanRate()]);
    res.json({ trades, rate });
  } catch (e) { next(e); }
});

/**
 * The base model card: what it predicts, how well, and what it learned.
 *
 * Calibration is recomputed live against held-out episodes rather than stored,
 * so the page shows how the model is doing on data it has never seen — which is
 * the only version of the number worth showing anyone.
 */
app.get("/api/model", async (_req, res, next) => {
  try {
    const [card] = await q<Record<string, unknown>>(
      `SELECT * FROM sa_model ORDER BY trained_at DESC LIMIT 1`,
    );
    if (!card) return res.json({ trained: false });

    const calibration = await chQuery<{ bucket: number; n: number; actual: number }>(`
      WITH
        arrayFirstIndex(x -> x >= e.px_at_h * ${TP_MULT}, p.pxs) AS up_i,
        arrayFirstIndex(x -> x <= e.px_at_h * ${SL_MULT}, p.pxs) AS dn_i,
        toUInt8(if(up_i=0,99999,up_i) < if(dn_i=0,99999,dn_i)) AS y
      SELECT floor(e.model_score*10)/10 AS bucket, count() AS n, round(100*avg(y),2) AS actual
      FROM episodes_enriched AS e
      INNER JOIN (SELECT mint, horizon_s, pxs FROM episode_paths FINAL) AS p
        ON e.mint = p.mint AND e.horizon_s = p.horizon_s
      WHERE e.horizon_s = ${Number(card.horizon_s) || 60} AND e.px_at_h > 0
        AND e.t0 > toDateTime64('${String(card.train_cutoff).replace(/'/g, "")}', 3)
      GROUP BY bucket ORDER BY bucket
      FORMAT JSON`);

    // Its current best live candidates, so the page is not just history.
    const picks = await chQuery(`
      SELECT mint, symbol, age_now_s AS ageS, n_traders AS nTraders,
             round(vol_sol,2) AS volSol, twitter_kind AS twitterKind,
             round(model_score,3) AS score
      FROM live_snapshot
      WHERE horizon_s = ${Number(card.horizon_s) || 60} AND n_trades >= 3
      ORDER BY model_score DESC LIMIT 10 FORMAT JSON`);

    res.json({ trained: true, ...card, calibration, picks });
  } catch (e) { next(e); }
});

/** Strategies with their latest backtest and their live paper performance. */
app.get("/api/agents", async (_req, res, next) => {
  try {
    res.json(await q(`
      SELECT s.id, s.name, s.thesis, s.prompt, s.config, s.created_at,
             b.n_trades AS bt_trades, b.win_pct AS bt_win, b.geo_mult AS bt_geo,
             b.total_pnl_sol AS bt_pnl,
             r.id AS run_id, r.status AS run_status, r.halt_reason,
             coalesce(p.n_closed, 0)  AS paper_trades,
             coalesce(p.pnl, 0)       AS paper_pnl,
             coalesce(p.win_pct, 0)   AS paper_win,
             coalesce(p.n_open, 0)    AS paper_open
      FROM sa_strategy s
      LEFT JOIN LATERAL (
        SELECT * FROM sa_backtest b2 WHERE b2.strategy_id = s.id
        ORDER BY b2.created_at DESC LIMIT 1) b ON TRUE
      LEFT JOIN LATERAL (
        SELECT * FROM sa_run r2 WHERE r2.strategy_id = s.id
        ORDER BY r2.started_at DESC LIMIT 1) r ON TRUE
      LEFT JOIN LATERAL (
        SELECT count(*) FILTER (WHERE closed_at IS NOT NULL)               AS n_closed,
               count(*) FILTER (WHERE closed_at IS NULL)                   AS n_open,
               coalesce(sum(pnl_sol), 0)                                   AS pnl,
               coalesce(avg((pnl_sol > 0)::int) FILTER (WHERE closed_at IS NOT NULL), 0) * 100 AS win_pct
        FROM sa_position WHERE run_id = r.id) p ON TRUE
      ORDER BY s.created_at DESC LIMIT 100`));
  } catch (e) { next(e); }
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

/** Start a paper run for a saved strategy. */
app.post("/api/runs", async (req, res, next) => {
  try {
    const body = z.object({
      strategyId: z.string(),
      bankrollSol: z.number().positive().max(1000).default(10),
      ownerId: z.string().nullable().default(null),
    }).parse(req.body);

    const [s] = await q<{ id: string }>(`SELECT id FROM sa_strategy WHERE id=$1`, [body.strategyId]);
    if (!s) return res.status(404).json({ error: "strategy not found" });

    // Live mode is not reachable from the API yet. The engine, the fills table
    // and the leaderboard all handle it, but nothing signs a transaction — so
    // the endpoint refuses rather than quietly opening a "live" run that is
    // actually paper and would rank alongside real ones.
    const id = newId("run");
    await q(
      `INSERT INTO sa_run (id, strategy_id, owner_id, mode, bankroll_sol) VALUES ($1,$2,$3,'paper',$4)`,
      [id, body.strategyId, body.ownerId, body.bankrollSol],
    );
    res.json({ id, mode: "paper" });
  } catch (e) { next(e); }
});

app.post("/api/runs/:id/stop", async (req, res, next) => {
  try {
    await q(`UPDATE sa_run SET status='stopped', stopped_at=now() WHERE id=$1 AND status='running'`,
      [req.params.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/** Live paper state: open positions, recent closes, running PnL and win rate. */
app.get("/api/paper", async (_req, res, next) => {
  try {
    const [totals] = await q(`
      SELECT
        coalesce(sum(p.pnl_sol) FILTER (WHERE p.closed_at IS NOT NULL), 0)          AS realised_pnl,
        count(*) FILTER (WHERE p.closed_at IS NOT NULL)                             AS n_closed,
        count(*) FILTER (WHERE p.closed_at IS NOT NULL AND p.pnl_sol > 0)           AS n_wins,
        count(*) FILTER (WHERE p.closed_at IS NULL)                                 AS n_open,
        coalesce(sum(p.size_sol), 0)                                                AS volume_sol,
        -- Mark-to-market on open positions, so the headline number is not stale
        -- while several positions are still running.
        coalesce(sum(p.size_sol * ((p.last_px / nullif(p.entry_px,0)) * (1 - p.cost_frac) - 1))
                 FILTER (WHERE p.closed_at IS NULL), 0)                             AS unrealised_pnl
      FROM sa_position p JOIN sa_run r ON r.id = p.run_id
      WHERE r.mode = 'paper'`);

    const open = await q(`
      SELECT p.mint, p.symbol, p.image, p.size_sol, p.entry_px, p.last_px, p.peak_px,
             p.opened_at, s.name AS strategy_name,
             (p.last_px / nullif(p.entry_px,0)) * (1 - p.cost_frac) AS mult
      FROM sa_position p
      JOIN sa_run r ON r.id = p.run_id
      JOIN sa_strategy s ON s.id = r.strategy_id
      WHERE p.closed_at IS NULL AND r.mode='paper'
      ORDER BY p.opened_at DESC LIMIT 40`);

    const recent = await q(`
      SELECT p.mint, p.symbol, p.image, p.size_sol, p.entry_px, p.exit_px, p.exit_reason,
             p.pnl_sol, p.opened_at, p.closed_at, s.name AS strategy_name,
             extract(epoch FROM (p.closed_at - p.opened_at)) AS held_s
      FROM sa_position p
      JOIN sa_run r ON r.id = p.run_id
      JOIN sa_strategy s ON s.id = r.strategy_id
      WHERE p.closed_at IS NOT NULL AND r.mode='paper'
      ORDER BY p.closed_at DESC LIMIT 40`);

    const t = totals as Record<string, string>;
    const nClosed = Number(t.n_closed);
    res.json({
      realisedPnl: Number(t.realised_pnl),
      unrealisedPnl: Number(t.unrealised_pnl),
      nClosed, nOpen: Number(t.n_open),
      winPct: nClosed ? (100 * Number(t.n_wins)) / nClosed : 0,
      volumeSol: Number(t.volume_sol),
      open, recent,
    });
  } catch (e) { next(e); }
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[agents]", err.message);
  res.status(500).json({ error: err.message });
});

// Railway (and most PaaS) inject PORT and expect the process to bind it on all
// interfaces. AGENTS_PORT stays as the local/systemd fallback.
const PORT = Number(process.env.PORT || process.env.AGENTS_PORT || 3002);

// Migrate BEFORE listening. Serving traffic against a database without the
// tables would return 500s from a deploy that otherwise looks healthy, and
// Railway's healthcheck hits /health (which needs no tables) so nothing would
// catch it.
try {
  await migrate();
} catch (e) {
  console.error(`[db] migration failed: ${describeError(e)}`);
  console.error(
    "[db] required variables: DATABASE_URL (Postgres), CLICKHOUSE_URL, CLICKHOUSE_PASSWORD.",
  );
  // Sleep before exiting. Railway restarts a crashed container immediately, and
  // an instant exit loop buries the one line that explains the failure under
  // hundreds of restarts.
  await new Promise((r) => setTimeout(r, 5000));
  process.exit(1);
}

app.listen(PORT, "0.0.0.0", () => {
  console.log(`solagents API on :${PORT}`);
  // Off by default so multiple instances (a Railway deploy plus the box) cannot
  // both trade the same runs and double every position.
  if (process.env.PAPER_ENGINE === "true") startPaperEngine();
  else console.log("[paper] engine disabled (set PAPER_ENGINE=true on exactly ONE instance)");
});
