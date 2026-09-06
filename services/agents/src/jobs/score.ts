/**
 * Scoring job. Run on a schedule (or by hand) — never in a request path.
 *
 *   node dist/jobs/score.js [batchSize]
 *
 * Stops on the budget ceiling, so re-running it can never exceed the cap.
 */
import "dotenv/config";
import { unscored, scoreOne, budgetRemaining } from "../llm/score.js";

const batch = Number(process.argv[2] || 200);

const room = await budgetRemaining();
if (room <= 0) {
  console.log("[score] budget ceiling reached — nothing to do (raise SCORE_MAX_COINS to continue)");
  process.exit(0);
}

const coins = await unscored(batch);
console.log(`[score] ${coins.length} coins to score, ${room} remaining in budget`);

let ok = 0;
let failed = 0;
for (const c of coins) {
  try {
    // Sequential on purpose. This is a background job with no deadline, and a
    // burst of parallel calls against a rate limit would fail most of them and
    // still be billed for the retries.
    const s = await scoreOne(c);
    if (s) ok++; else failed++;
  } catch (e) {
    failed++;
    console.error(`[score] ${c.mint}: ${(e as Error).message}`);
    // A 429 or an auth failure will hit every remaining coin identically —
    // stop rather than grind through the whole batch producing errors.
    if (/rate|401|403|invalid_api_key/i.test((e as Error).message)) break;
  }
}
console.log(`[score] done: ${ok} scored, ${failed} failed`);
process.exit(0);
