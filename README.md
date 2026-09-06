# solagents

A public platform for training trading agents on live Solana memecoin data.

Describe a strategy in plain English. An LLM compiles it once into a validated
JSON config. That config is backtested against ~380k real per-coin episodes,
watched firing live against the current feed, and ranked on a public leaderboard.

The model never runs at decision time. What trades is deterministic code reading
a validated config — so a backtest, a live pick and a real fill are the same
decision, and a strategy can be diffed, versioned and ranked.

## What it does

- **Describe** a strategy in English, or build it from filter chips —
  volume, buys, unique traders, fees actually paid, buy pressure, wallet
  concentration, dev behaviour, X-link quality, LLM presentation score.
- **Backtest** it over real history with modelled fees, bonding-curve slippage,
  and exit simulation on a 10-second price path.
- **Watch it live** — a running tape of coins being picked up right now, by your
  draft and by every published strategy.
- **Leaderboard** — backtest, paper and live ranked separately. A backtest is a
  claim about the past; only a live run risked anything. They are never merged.

## Architecture

```
agave-validator (Yellowstone gRPC :10000)      ← bare metal, Chicago
        │
   polyx-api :3001  ── decode → in-memory feed → ClickHouse
        │
   ClickHouse :8123
     trades          25.7M rows, TTL 14 days      ← the firehose
     episodes        380k rows, NO TTL            ← the training set
     episode_paths   660k rows, 10s resolution    ← exit simulation
     live_episodes   view over the last 40 min    ← live picks
        │
   solagents (this repo)  ── strategy compile · backtest · live · leaderboard
```

`solagents` runs off-box (Railway) and reads ClickHouse over the network.
Postgres holds strategies, runs and fills.

## Why "episodes" and not candles

Measured over 6 days and 25.7M trades:

- the median coin trades for **2 minutes** and sees **8 trades**; p75 is 38 min
- only ~2,255 mints ever accumulate 60 minutes of candles
- ~50k new mints/day, ~500 graduations/day

A coin is not a time series to hold. It is a short **episode**, and the only
decision that matters happens in the first 30–180 seconds. So the training set
is one row per `(mint, horizon)`: features computed strictly inside the decision
window, outcomes strictly after it.

This is also why the 14-day `trades` TTL doesn't need changing. Raw ticks expire;
`episodes` has no TTL and accumulates permanently. ~75 MiB per 290k episodes, so
a full year is a few GB.

## What the data actually says

Over 21,511 enterable episodes since 2026-09-04:

| filter | trades | win rate | graduation |
|---|---|---|---|
| everything | 21,511 | 22.4% | 6.3% |
| X profile + 15 traders + buying + dev still in | 469 | 42.4% | 46.7% |
| ...and not a serial deployer | 392 | **44.1%** | **48.7%** |

A bare `x.com/handle` link graduates **9.5%** of the time. No link: 2.5%. A link
to *someone else's tweet*: 1.1%, despite pulling the highest volume — riding a
tweet pumps the chart without building a coin. Serial deployers degrade
monotonically: 0 prior launches → ×0.75 per trade, 3+ → ×0.44.

**Nothing here is profitable yet.** With realistic exits and costs the best
configuration still loses ~17% per trade. Entry filters move it from ×0.03 to
×0.83; the remaining gap is exits. The backtester is built to say this rather
than flatter you — see `services/agents/src/backtest/exits.ts`, where every
ambiguity resolves against the strategy.

## Data notes (verified, not assumed)

- `price_sol` comes from the pump.fun `TradeEvent` virtual reserves. It is the
  on-chain mid price. Do **not** reconstruct it from `real_sol`/`real_token_reserves`
  — launch constants are no longer uniform and the reconstruction disagrees on
  ~30% of mints.
- `mcap_sol` is exactly `price_sol * 1e9` in 100% of rows. It carries no extra
  information; don't feed both to a model.
- `trader` and `signature` are **100% populated** because the feed comes from our
  own validator. Wallet-level and serial-deployer features are the real edge here
  and cannot be bought from a resale API.
- `fee_sol` 88% / `creator_fee_sol` 86% populated — read from the trade event,
  not inferred from a rate.
- `real_sol` only ~45% populated; slippage falls back to the 30 SOL virtual floor
  and is then **understated**. The backtester warns when this exceeds 30%.
- Socials capture began **2026-09-04** and is 0% before. Any analysis crossing
  that boundary must filter on it or it will conclude socials don't exist.
- `ts` is second-precise; `seq` carries intra-second order. Always sort by
  `(ts, seq)` — sorting by `ts` alone ties and every candle comes out flat.
- `episodes` and `episode_paths` are `ReplacingMergeTree`. **Always read through
  `episodes_enriched` or with `FINAL`** — duplicates are only collapsed on merge,
  and a re-extracted window otherwise multiplies every affected episode.

## Deploying to Railway

1. New project → deploy from this repo. `railway.json` points at
   `services/agents/Dockerfile`.
2. Add the **Postgres** plugin; it injects `DATABASE_URL`. Apply the schema once:
   `psql "$DATABASE_URL" -f postgres/01_schema.sql`
3. Set the variables in `.env.example` — at minimum `CLICKHOUSE_URL`,
   `CLICKHOUSE_PASSWORD`, `ANTHROPIC_API_KEY`.
4. Railway injects `PORT`; the app binds it automatically.

**Before this is public:** ClickHouse on the box listens on `0.0.0.0:8123` behind
only basic auth. Firewall it to Railway's egress range, or front it with nginx +
TLS. Anyone who finds the port can read the entire trade history.

## Running the data pipeline (on the box)

```bash
/opt/solagents/scripts/extract_episodes.sh --create           # tables + views
/opt/solagents/scripts/extract_episodes.sh --backfill -H 60   # all settled hours
node dist/jobs/score.js 200                                   # LLM-score a batch
```

Extraction lags by `horizon + 60m` so every outcome column is fully settled —
writing an episode before its outcome window closes would teach every model that
late winners do not exist.

Scoring is capped by `SCORE_MAX_COINS` (default 30,000 ≈ $15 on Haiku) and only
touches coins that already cleared a cheap prefilter, since half of all launches
see fewer than 8 trades and no strategy will ever trade them.

## Layout

    clickhouse/   episode schema, extraction, live view
    postgres/     strategies, runs, fills
    scripts/      extraction + backfill runners
    services/agents/
      src/strategy/features.ts   THE feature namespace — each feature declared
                                 once with BOTH its SQL and its live impl, so
                                 backtest and production cannot drift
      src/strategy/evaluate.ts   one compiler, two targets
      src/backtest/              exit simulation + runner
      src/llm/                   English → config; coin scoring
      src/live.ts                live picks
      public/index.html          the site
