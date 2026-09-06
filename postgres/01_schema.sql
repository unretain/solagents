-- solagents tables. Additive: every object is prefixed `sa_` and nothing here
-- touches the existing polyx/Prisma tables. Deliberately plain SQL rather than
-- an edit to the production schema.prisma — a migration against the live
-- database mid-build risks the app's own tables for no benefit. These can be
-- adopted into Prisma later with `prisma db pull`.

CREATE TABLE IF NOT EXISTS sa_strategy (
    id            TEXT PRIMARY KEY,
    owner_id      TEXT,                      -- References "User".id; null = anonymous draft
    name          TEXT NOT NULL,
    thesis        TEXT NOT NULL DEFAULT '',
    prompt        TEXT NOT NULL DEFAULT '',  -- the English the user actually typed
    config        JSONB NOT NULL,            -- the validated Strategy
    is_public     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sa_strategy_public_idx ON sa_strategy (is_public, created_at DESC);
CREATE INDEX IF NOT EXISTS sa_strategy_owner_idx  ON sa_strategy (owner_id, created_at DESC);

-- One row per backtest. Kept rather than recomputed so a leaderboard entry can
-- always be traced back to the exact window and settings that produced it —
-- a leaderboard whose numbers cannot be reproduced is worse than none.
CREATE TABLE IF NOT EXISTS sa_backtest (
    id            TEXT PRIMARY KEY,
    strategy_id   TEXT NOT NULL REFERENCES sa_strategy(id) ON DELETE CASCADE,
    window_from   TIMESTAMPTZ NOT NULL,
    window_to     TIMESTAMPTZ NOT NULL,
    fee_bps       INT NOT NULL DEFAULT 200,
    n_trades      INT NOT NULL,
    win_pct       DOUBLE PRECISION NOT NULL,
    geo_mult      DOUBLE PRECISION NOT NULL,
    total_pnl_sol DOUBLE PRECISION NOT NULL,
    volume_sol    DOUBLE PRECISION NOT NULL,
    max_dd_sol    DOUBLE PRECISION NOT NULL,
    result        JSONB NOT NULL,            -- full BacktestResult incl. warnings
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sa_backtest_strategy_idx ON sa_backtest (strategy_id, created_at DESC);

-- Live runs: paper today, real once enabled. Same table because they must be
-- ranked on the same numbers — a leaderboard that scores paper differently from
-- real is a leaderboard people learn to game with paper.
CREATE TABLE IF NOT EXISTS sa_run (
    id            TEXT PRIMARY KEY,
    strategy_id   TEXT NOT NULL REFERENCES sa_strategy(id) ON DELETE CASCADE,
    owner_id      TEXT,
    mode          TEXT NOT NULL CHECK (mode IN ('paper', 'live')),
    status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'stopped', 'halted')),
    -- why a run halted itself (daily loss limit, deploy cap). Null while healthy.
    halt_reason   TEXT,
    bankroll_sol  DOUBLE PRECISION NOT NULL,
    started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    stopped_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sa_run_leaderboard_idx ON sa_run (mode, status, started_at DESC);

-- Every fill, paper or real. `signature` is null for paper.
CREATE TABLE IF NOT EXISTS sa_fill (
    id            BIGSERIAL PRIMARY KEY,
    run_id        TEXT NOT NULL REFERENCES sa_run(id) ON DELETE CASCADE,
    mint          TEXT NOT NULL,
    symbol        TEXT NOT NULL DEFAULT '',
    side          TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    size_sol      DOUBLE PRECISION NOT NULL,
    price_sol     DOUBLE PRECISION NOT NULL,
    -- Modelled for paper, actual for live. Stored either way so paper and live
    -- PnL are computed by identical arithmetic.
    fee_sol       DOUBLE PRECISION NOT NULL DEFAULT 0,
    signature     TEXT,
    exit_reason   TEXT,
    at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sa_fill_run_idx ON sa_fill (run_id, at DESC);

-- Open + closed positions, so a run's PnL never has to be replayed from fills.
CREATE TABLE IF NOT EXISTS sa_position (
    id            BIGSERIAL PRIMARY KEY,
    run_id        TEXT NOT NULL REFERENCES sa_run(id) ON DELETE CASCADE,
    mint          TEXT NOT NULL,
    symbol        TEXT NOT NULL DEFAULT '',
    size_sol      DOUBLE PRECISION NOT NULL,
    entry_px      DOUBLE PRECISION NOT NULL,
    exit_px       DOUBLE PRECISION,
    exit_reason   TEXT,
    pnl_sol       DOUBLE PRECISION,
    opened_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    closed_at     TIMESTAMPTZ,
    UNIQUE (run_id, mint, opened_at)
);

CREATE INDEX IF NOT EXISTS sa_position_open_idx ON sa_position (run_id) WHERE closed_at IS NULL;
