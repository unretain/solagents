-- Paper-trading additions.

-- Trailing stops need the high-water mark, and it must survive a restart: if
-- peak resets to entry when the process bounces, every open trailing position
-- silently widens its stop and the run's PnL stops matching its own rules.
ALTER TABLE sa_position ADD COLUMN IF NOT EXISTS peak_px DOUBLE PRECISION;
ALTER TABLE sa_position ADD COLUMN IF NOT EXISTS image    TEXT NOT NULL DEFAULT '';
ALTER TABLE sa_position ADD COLUMN IF NOT EXISTS last_px  DOUBLE PRECISION;
ALTER TABLE sa_position ADD COLUMN IF NOT EXISTS cost_frac DOUBLE PRECISION NOT NULL DEFAULT 0;

-- One position per coin per run, enforced by the database rather than by the
-- engine remembering. A restart mid-tick would otherwise re-enter a coin the run
-- already holds.
CREATE UNIQUE INDEX IF NOT EXISTS sa_position_open_unique
  ON sa_position (run_id, mint) WHERE closed_at IS NULL;

-- A run should not re-enter a coin it has already traded and exited.
CREATE INDEX IF NOT EXISTS sa_position_run_mint ON sa_position (run_id, mint);

ALTER TABLE sa_run ADD COLUMN IF NOT EXISTS last_tick_at TIMESTAMPTZ;
