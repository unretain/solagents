-- Live trading wallets.
--
-- One wallet per RUN, not per user. The deposit is the bankroll, so the worst
-- case for a live agent is bounded by what was put into that single wallet:
-- a bad strategy, a bug in the exit logic or a compromised session cannot reach
-- funds belonging to another run or sitting in the owner's own wallet.
--
-- secret_enc holds the 64-byte Solana secret key encrypted with AES-256-GCM
-- under LIVE_WALLET_KEY, which lives only in the server's environment. The
-- database alone is not enough to move funds. Format is iv:tag:ciphertext, all
-- base64. There is deliberately no route that returns it.
CREATE TABLE IF NOT EXISTS sa_wallet (
    run_id      TEXT PRIMARY KEY REFERENCES sa_run(id) ON DELETE CASCADE,
    -- the wallet allowed to withdraw: whoever created the run
    owner_id    TEXT NOT NULL,
    pubkey      TEXT NOT NULL UNIQUE,
    secret_enc  TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sa_wallet_owner_idx ON sa_wallet (owner_id);

-- Withdrawals, kept so a user can reconcile what left the wallet and so a
-- replayed request cannot be mistaken for a second, genuine withdrawal.
CREATE TABLE IF NOT EXISTS sa_withdrawal (
    id          TEXT PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES sa_run(id) ON DELETE CASCADE,
    to_pubkey   TEXT NOT NULL,
    lamports    BIGINT NOT NULL,
    signature   TEXT,
    status      TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('sent', 'confirmed', 'failed')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sa_withdrawal_run_idx ON sa_withdrawal (run_id, created_at DESC);
