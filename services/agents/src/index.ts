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
import { coinDetail, candles, watchlist } from "./coin.js";
import { issueNonce, messageFor, verifyWallet, readSession } from "./auth.js";
import { memo, invalidate } from "./cache.js";
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

/**
 * SOL price, proxied.
 *
 * polyx-api's /api/feed/status requires the internal key, which must never
 * reach the browser — so the page cannot call it directly, and asking it to was
 * why the terminal rendered every market cap as $0.00. Fetched here with the
 * key server-side and re-exposed as a single number.
 */
async function solPrice(): Promise<number> {
  return memo("solprice", 30_000, async () => {
    const key = process.env.INTERNAL_API_KEY || "";
    const url = process.env.POLYX_API_URL || "http://127.0.0.1:3001";
    try {
      const r = await fetch(`${url}/api/feed/status`, {
        headers: key ? { "x-internal-api-key": key } : {},
        signal: AbortSignal.timeout(4000),
      });
      if (!r.ok) return 0;
      const j = (await r.json()) as { solPrice?: number };
      return Number(j.solPrice) || 0;
    } catch { return 0; }
  });
}

app.get("/api/solprice", async (_req, res, next) => {
  try { res.json({ solPrice: await solPrice() }); } catch (e) { next(e); }
});

// ─────────────────────────── wallet auth ─────────────────────────

function sessionOf(req: express.Request): string | null {
  const raw = req.headers.cookie || "";
  const m = /(?:^|;\s*)pl_session=([^;]+)/.exec(raw);
  return m ? readSession(decodeURIComponent(m[1])) : null;
}

app.get("/api/auth/nonce", (_req, res) => {
  const nonce = issueNonce();
  res.json({ nonce, message: messageFor(nonce) });
});

app.post("/api/auth/verify", (req, res) => {
  const body = z.object({
    pubkey: z.string().min(32).max(44),
    signature: z.string().min(64).max(120),
    nonce: z.string().min(8).max(64),
  }).safeParse(req.body);
  if (!body.success) return res.status(400).json({ error: "malformed request" });

  const out = verifyWallet(body.data);
  if (!out.ok) return res.status(401).json({ error: out.error });

  res.setHeader("Set-Cookie",
    `pl_session=${encodeURIComponent(out.token)}; Path=/; Max-Age=${30*24*3600}; ` +
    `SameSite=Lax; HttpOnly; Secure`);
  res.json({ ok: true, pubkey: body.data.pubkey });
});

app.get("/api/auth/me", (req, res) => res.json({ pubkey: sessionOf(req) }));

app.post("/api/auth/logout", (_req, res) => {
  res.setHeader("Set-Cookie", "pl_session=; Path=/; Max-Age=0; SameSite=Lax; HttpOnly; Secure");
  res.json({ ok: true });
});

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
      [id, sessionOf(req) ?? body.ownerId, s.name, s.thesis, body.prompt, JSON.stringify(s), body.isPublic],
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
    invalidate("agents"); invalidate("board");
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
async function leaderboard(mode: "backtest" | "paper" | "live"): Promise<unknown[]> {
  if (mode === "backtest") {
    return q(`
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
        ORDER BY b.geo_mult DESC LIMIT 100`);
  }
  return q(`
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
      ORDER BY total_pnl_sol DESC LIMIT 100`, [mode]);
}

app.get("/api/leaderboard", async (req, res, next) => {
  try {
    const mode = z.enum(["backtest", "paper", "live"]).catch("backtest").parse(req.query.mode);
    res.json(await memo(`board:${mode}`, 20_000, () => leaderboard(mode)));
  } catch (e) { next(e); }
});

// ─────────────────────────── live feed ───────────────────────────

/** Live trade stream. One tailer fans out to every connected browser. */
app.get("/api/live/stream", (_req, res) => attach(res));

/** Raw firehose snapshot — fills the table before the stream's first events. */
app.get("/api/live/trades", async (_req, res, next) => {
  try {
    res.json(await memo("trades", 3_000, async () => ({
      trades: await liveTrades(60),
      rate: await scanRate(),
    })));
  } catch (e) { next(e); }
});

/** What the feed is seeing right now, unfiltered. */
app.get("/api/live/tape", async (_req, res, next) => {
  try { res.json(await memo("tape", 5_000, () => liveTape())); } catch (e) { next(e); }
});

/** Live matches for a draft strategy the user has not saved yet. Not cached —
 *  the whole point is to reflect the config currently on screen. */
app.post("/api/live/test", async (req, res, next) => {
  try {
    const parsed = strategySchema.safeParse(z.object({ strategy: z.unknown() }).parse(req.body).strategy);
    if (!parsed.success) return res.status(400).json({ error: explainInvalid(parsed.error) });
    res.json(await livePicks(parsed.data));
  } catch (e) { next(e); }
});

async function pickRows(): Promise<unknown[]> {
  const rows = await q<{ id: string; name: string; config: Strategy }>(
    `SELECT id, name, config FROM sa_strategy WHERE is_public ORDER BY created_at DESC LIMIT 25`);
  return publishedPicks(rows);
}

/** Live picks across every published strategy — the public board. */
app.get("/api/live/picks", async (_req, res, next) => {
  try { res.json(await memo("picks", 5_000, pickRows)); } catch (e) { next(e); }
});

// ─────────────────────────── model & agents ───────────────────────

/**
 * The base model card: what it predicts, how well, and what it learned.
 *
 * Calibration is recomputed against held-out episodes rather than stored, so the
 * page shows how the model does on data it has never seen — the only version of
 * that number worth showing anyone. It is also the most expensive read on the
 * dashboard, hence the 2-minute memo: it changes only when the model is
 * retrained, which is nightly.
 */
async function modelCard(): Promise<Record<string, unknown>> {
  return memo("model", 120_000, async () => {
    const [card] = await q<Record<string, unknown>>(
      `SELECT * FROM sa_model ORDER BY trained_at DESC LIMIT 1`);
    if (!card) return { trained: false };

    const horizon = Number(card.horizon_s) || 60;
    const cutoff = String(card.train_cutoff).replace(/'/g, "");
    const [calibration, picks] = await Promise.all([
      chQuery<{ bucket: number; n: number; actual: number }>(`
        WITH
          arrayFirstIndex(x -> x >= e.px_at_h * ${TP_MULT}, p.pxs) AS up_i,
          arrayFirstIndex(x -> x <= e.px_at_h * ${SL_MULT}, p.pxs) AS dn_i,
          toUInt8(if(up_i=0,99999,up_i) < if(dn_i=0,99999,dn_i)) AS y
        SELECT floor(e.model_score*10)/10 AS bucket, count() AS n, round(100*avg(y),2) AS actual
        FROM episodes_enriched AS e
        INNER JOIN (SELECT mint, horizon_s, pxs FROM episode_paths FINAL) AS p
          ON e.mint = p.mint AND e.horizon_s = p.horizon_s
        WHERE e.horizon_s = ${horizon} AND e.px_at_h > 0
          AND e.t0 > toDateTime64('${cutoff}', 3)
        GROUP BY bucket ORDER BY bucket
        FORMAT JSON`),
      chQuery(`
        SELECT mint, symbol, image, age_now_s AS ageS, n_traders AS nTraders,
               round(vol_sol,2) AS volSol, twitter_kind AS twitterKind,
               round(model_score,3) AS score
        FROM live_snapshot
        WHERE horizon_s = ${horizon} AND n_trades >= 3
        ORDER BY model_score DESC LIMIT 10 FORMAT JSON`),
    ]);
    return { trained: true, ...card, calibration, picks };
  });
}

app.get("/api/model", async (_req, res, next) => {
  try { res.json(await modelCard()); } catch (e) { next(e); }
});

/** Strategies with their latest backtest and their live paper performance. */
async function agentRows(): Promise<unknown[]> {
  return q(`
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
    ORDER BY s.created_at DESC LIMIT 100`);
}

app.get("/api/agents", async (_req, res, next) => {
  try { res.json(await memo("agents", 5_000, agentRows)); } catch (e) { next(e); }
});

// ─────────────────────────── coin terminal ───────────────────────

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/; // base58, no 0/O/I/l

app.get("/api/coin/:mint", async (req, res, next) => {
  try {
    const mint = String(req.params.mint);
    if (!MINT.test(mint)) return res.status(400).json({ error: "not a mint address" });
    res.json(await memo(`coin:${mint}`, 4_000, () => coinDetail(mint)));
  } catch (e) { next(e); }
});

app.get("/api/coin/:mint/candles", async (req, res, next) => {
  try {
    const mint = String(req.params.mint);
    if (!MINT.test(mint)) return res.status(400).json({ error: "not a mint address" });
    const tf = String(req.query.tf || "1m");
    res.json(await memo(`candles:${mint}:${tf}`, 3_000, () => candles(mint, tf)));
  } catch (e) { next(e); }
});

/** What the agents are watching — ranked by the model, not by volume. */
app.get("/api/watchlist", async (_req, res, next) => {
  try { res.json(await memo("watchlist", 5_000, () => watchlist())); } catch (e) { next(e); }
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
      [id, body.strategyId, sessionOf(req) ?? body.ownerId, body.bankrollSol],
    );
    invalidate("agents");
    res.json({ id, mode: "paper" });
  } catch (e) { next(e); }
});

app.post("/api/runs/:id/stop", async (req, res, next) => {
  try {
    await q(`UPDATE sa_run SET status='stopped', stopped_at=now() WHERE id=$1 AND status='running'`,
      [req.params.id]);
    invalidate("agents");
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/**
 * Live paper state: totals, open positions, recent closes, and the equity curve.
 *
 * The curve is a running sum over closed positions in time order. Computed in
 * SQL rather than the browser so the chart is identical for everyone and does
 * not depend on how many rows the client happened to fetch.
 */
async function paperState(): Promise<Record<string, unknown>> {
  const [totals] = await q<Record<string, string>>(`
      SELECT
        coalesce(sum(p.pnl_sol) FILTER (WHERE p.closed_at IS NOT NULL), 0)          AS realised_pnl,
        count(*) FILTER (WHERE p.closed_at IS NOT NULL)                             AS n_closed,
        count(*) FILTER (WHERE p.closed_at IS NOT NULL AND p.pnl_sol > 0)           AS n_wins,
        count(*) FILTER (WHERE p.closed_at IS NULL)                                 AS n_open,
        coalesce(sum(p.size_sol), 0)                                                AS volume_sol,
        coalesce(sum(p.size_sol * ((p.last_px / nullif(p.entry_px,0)) * (1 - p.cost_frac) - 1))
                 FILTER (WHERE p.closed_at IS NULL), 0)                             AS unrealised_pnl
      FROM sa_position p JOIN sa_run r ON r.id = p.run_id
      WHERE r.mode = 'paper'`);

  const [open, recent, curve] = await Promise.all([
    q(`SELECT p.mint, p.symbol, p.image, p.size_sol, p.entry_px, p.last_px, p.peak_px,
              p.opened_at, s.name AS strategy_name,
              (p.last_px / nullif(p.entry_px,0)) * (1 - p.cost_frac) AS mult
       FROM sa_position p
       JOIN sa_run r ON r.id = p.run_id
       JOIN sa_strategy s ON s.id = r.strategy_id
       WHERE p.closed_at IS NULL AND r.mode='paper'
       ORDER BY p.opened_at DESC LIMIT 40`),
    q(`SELECT p.mint, p.symbol, p.image, p.size_sol, p.entry_px, p.exit_px, p.exit_reason,
              p.pnl_sol, p.opened_at, p.closed_at, s.name AS strategy_name,
              extract(epoch FROM (p.closed_at - p.opened_at)) AS held_s
       FROM sa_position p
       JOIN sa_run r ON r.id = p.run_id
       JOIN sa_strategy s ON s.id = r.strategy_id
       WHERE p.closed_at IS NOT NULL AND r.mode='paper'
       ORDER BY p.closed_at DESC LIMIT 40`),
    q(`SELECT extract(epoch FROM p.closed_at) AS t,
              sum(p.pnl_sol) OVER (ORDER BY p.closed_at) AS cum
       FROM sa_position p JOIN sa_run r ON r.id = p.run_id
       WHERE r.mode='paper' AND p.closed_at IS NOT NULL
       ORDER BY p.closed_at ASC LIMIT 500`),
  ]);

  const nClosed = Number(totals.n_closed);
  return {
    realisedPnl: Number(totals.realised_pnl),
    unrealisedPnl: Number(totals.unrealised_pnl),
    nClosed, nOpen: Number(totals.n_open),
    winPct: nClosed ? (100 * Number(totals.n_wins)) / nClosed : 0,
    volumeSol: Number(totals.volume_sol),
    open, recent, curve,
  };
}

app.get("/api/paper", async (_req, res, next) => {
  try { res.json(await memo("paper", 4_000, paperState)); } catch (e) { next(e); }
});

/**
 * Everything the dashboard needs, in ONE round trip.
 *
 * The UI used to fetch stats, features, model, agents, paper, picks and the
 * leaderboard separately, each on its own page-switch — so every navigation
 * showed "Loading…". One call, fetched once at boot and refreshed in the
 * background, means switching pages is a local render with nothing to wait for.
 *
 * Every part is memoised independently, so a slow leaderboard cannot hold up the
 * stat cards, and N open browsers cost the same as one.
 */
app.get("/api/bootstrap", async (_req, res, next) => {
  try {
    const [stats, model, agents, paper, board, picks, trades, watching, sol] = await Promise.all([
      memo("stats", 15_000, async () => {
        const [row] = await chQuery<Record<string, string>>(`
          SELECT
            (SELECT count() FROM episodes)           AS episodes,
            (SELECT uniqExact(mint) FROM episodes)   AS coins,
            (SELECT count() FROM coin_scores)        AS scored,
            (SELECT toString(max(t0)) FROM episodes) AS newest
          FORMAT JSON`);
        return row ?? {};
      }),
      modelCard().catch(() => ({ trained: false })),
      memo("agents", 5_000, () => agentRows()),
      memo("paper", 4_000, () => paperState()),
      memo("board:backtest", 20_000, () => leaderboard("backtest")),
      memo("picks", 5_000, pickRows),
      memo("trades", 3_000, async () => ({ trades: await liveTrades(60), rate: await scanRate() })),
      memo("watchlist", 5_000, () => watchlist()),
      solPrice(),
    ]);

    res.json({
      stats, model, agents, paper, board, picks, watching, solPrice: sol,
      trades: trades.trades, rate: trades.rate,
      features: Object.entries(FEATURES).map(([name, def]) => ({
        name, kind: def.kind, doc: def.doc,
        values: (def as { values?: readonly string[] }).values ?? null,
      })),
      serverTime: new Date().toISOString(),
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
