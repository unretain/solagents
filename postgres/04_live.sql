-- Live trading wallets.
--
-- One internal wallet per USER, created the moment they connect a wallet, so
-- there is an address to fund before they have decided what to run. Agents
-- trade from it; a run's bankroll_sol is the cap on what that run may commit,
-- enforced by the engine rather than by holding separate balances.
--
-- secret_enc holds the 64-byte Solana secret key encrypted with AES-256-GCM
-- under LIVE_WALLET_KEY, which lives only in the server's environment. The
-- database alone is not enough to move funds. Format is iv:tag:ciphertext, all
-- base64. There is deliberately no route that returns it.
--
-- An earlier version of this table was keyed by run_id. It is replaced rather
-- than migrated, but ONLY when empty - dropping a table that holds custody of
-- somebody's money because a migration assumed it was still test data is not a
-- mistake that can be undone.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sa_wallet' AND column_name = 'run_id'
  ) THEN
    IF (SELECT count(*) FROM sa_wallet) = 0 THEN
      DROP TABLE sa_wallet;
    ELSE
      RAISE EXCEPTION
        'sa_wallet still holds % funded wallet(s) keyed by run_id; migrate them by hand',
        (SELECT count(*) FROM sa_wallet);
    END IF;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS sa_wallet (
    owner_id    TEXT PRIMARY KEY,
    pubkey      TEXT NOT NULL UNIQUE,
    secret_enc  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Withdrawals, kept so a user can reconcile what left the wallet and so a
-- replayed request cannot be mistaken for a second, genuine withdrawal.
CREATE TABLE IF NOT EXISTS sa_withdrawal (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL,
    to_pubkey   TEXT NOT NULL,
    lamports    BIGINT NOT NULL,
    signature   TEXT,
    status      TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'confirmed', 'failed')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The old shape had run_id here too; same reasoning as above.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'sa_withdrawal' AND column_name = 'run_id'
  ) AND (SELECT count(*) FROM sa_withdrawal) = 0 THEN
    DROP TABLE sa_withdrawal;
    CREATE TABLE sa_withdrawal (
        id          TEXT PRIMARY KEY,
        owner_id    TEXT NOT NULL,
        to_pubkey   TEXT NOT NULL,
        lamports    BIGINT NOT NULL,
        signature   TEXT,
        status      TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent','confirmed','failed')),
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS sa_withdrawal_owner_idx ON sa_withdrawal (owner_id, created_at DESC);
