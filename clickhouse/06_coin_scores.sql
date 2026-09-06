-- LLM judgement of a coin's presentation, scored once and cached forever.
--
-- Keyed by mint. A backtest over 20,000 episodes must never make 20,000 model
-- calls: scoring happens once, asynchronously, when a coin is first seen, and
-- both the backtester and the live engine read this table. That is also what
-- keeps backtest and live honest — they read the SAME score, not two different
-- model calls with two different results.
--
-- `scored_at` is kept so a re-score with a newer prompt version can be detected
-- and so an episode can be checked against scores that existed at its own t0.

CREATE TABLE IF NOT EXISTS coin_scores
(
    mint          String,
    -- 0-100. Deliberately coarse: the model is judging vibes, and pretending to
    -- 2 decimal places of precision about vibes would be false confidence.
    llm_score     UInt8,
    -- one of: slop | generic | decent | strong. The bucket users actually filter
    -- on; the numeric score is for ranking within a bucket.
    llm_verdict   LowCardinality(String),
    -- one sentence, shown in the UI so a user can see WHY their filter fired
    llm_reason    String DEFAULT '',
    -- what the model was actually shown, so a score can be audited later
    had_tweet_text UInt8 DEFAULT 0,
    had_description UInt8 DEFAULT 0,
    prompt_version UInt16 DEFAULT 1,
    scored_at     DateTime DEFAULT now()
)
ENGINE = ReplacingMergeTree(scored_at)
ORDER BY mint;
