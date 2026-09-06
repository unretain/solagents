-- Base model card, written by each training run.
--
-- Stored in Postgres rather than read from models/base_model.json on disk so the
-- web tier can show it from anywhere — the training job runs on the box, the UI
-- may not.

CREATE TABLE IF NOT EXISTS sa_model (
    id            BIGSERIAL PRIMARY KEY,
    horizon_s     INT NOT NULL,
    trained_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    n_train       INT NOT NULL,
    n_test        INT NOT NULL,
    base_rate     DOUBLE PRECISION NOT NULL,
    auc           DOUBLE PRECISION NOT NULL,
    top10_rate    DOUBLE PRECISION NOT NULL,
    top10_lift    DOUBLE PRECISION NOT NULL,
    train_cutoff  TEXT NOT NULL,
    -- [{name, weight}] sorted by |weight|, so the UI can show what it learned
    -- without shipping the whole coefficient vector.
    features      JSONB NOT NULL,
    label         TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS sa_model_latest_idx ON sa_model (horizon_s, trained_at DESC);
