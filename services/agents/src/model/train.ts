/**
 * Fit the base model.
 *
 *   node dist/model/train.js [horizon=60]
 *
 * Trains on episodes before a time cutoff and evaluates on everything after it.
 * The split is by TIME, never random: memecoin launches cluster hard (the same
 * dev, the same trend, the same hour), so a random split leaks near-duplicate
 * episodes across the boundary and reports an AUC the live feed will never see.
 */
import "dotenv/config";
import { chQuery, chWrite } from "../clickhouse.js";
import { MODEL_FEATURES, TP_MULT, SL_MULT, modelScoreSql, type BaseModel } from "./spec.js";
import { writeFileSync, mkdirSync } from "node:fs";

const horizon = Number(process.argv[2] || 60);

// Rows: features + order-aware label. Dead coins (empty path) are INCLUDED with
// label 0 — they are real total losses, and dropping them would train the model
// on survivors only and make every score wildly optimistic.
const cols = MODEL_FEATURES.map((f) => `${f.expr} AS ${f.name}`).join(",\n    ");

const sql = `
  WITH
    arrayFirstIndex(x -> x >= e.px_at_h * ${TP_MULT}, p.pxs) AS up_i,
    arrayFirstIndex(x -> x <= e.px_at_h * ${SL_MULT}, p.pxs) AS dn_i,
    if(up_i = 0, 99999, up_i) AS up_at,
    if(dn_i = 0, 99999, dn_i) AS dn_at
  SELECT
    toUInt8(up_at < dn_at) AS y,
    toString(e.t0) AS t0,
    ${cols}
  FROM episodes_enriched AS e
  INNER JOIN (SELECT mint, horizon_s, pxs FROM episode_paths FINAL) AS p
    ON e.mint = p.mint AND e.horizon_s = p.horizon_s
  WHERE e.horizon_s = ${horizon}
    AND e.px_at_h > 0
    AND e.t0 >= '2026-09-04 00:00:00'
  ORDER BY e.t0 ASC
  FORMAT JSON`;

console.log(`[train] pulling episodes (horizon ${horizon}s)…`);
const rows = await chQuery<Record<string, number | string>>(sql);
if (rows.length < 5000) throw new Error(`only ${rows.length} rows — not enough to fit`);

const names = MODEL_FEATURES.map((f) => f.name);
const X = rows.map((r) => names.map((n) => Number(r[n]) || 0));
const y = rows.map((r) => Number(r.y));

// 75/25 by time.
const cut = Math.floor(rows.length * 0.75);
const cutoff = String(rows[cut].t0);
const Xtr = X.slice(0, cut), ytr = y.slice(0, cut);
const Xte = X.slice(cut), yte = y.slice(cut);

// Drop zero-variance columns. `llm_score` is all-zero until the scoring job has
// run, and standardising it would divide by zero and poison every prediction.
const keep: number[] = [];
const mean: number[] = [];
const std: number[] = [];
const lo: number[] = [];
const hi: number[] = [];
const pct = (sorted: number[], p: number) =>
  sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];

for (let j = 0; j < names.length; j++) {
  const col = Xtr.map((r) => r[j]);
  const sorted = [...col].sort((a, b2) => a - b2);
  const l = pct(sorted, 0.01);
  const h = pct(sorted, 0.99);
  // Clip BEFORE computing mean/std, so the scaling describes the clipped
  // distribution the model will actually be fed at inference time.
  const clipped = col.map((v) => Math.min(Math.max(v, l), h));
  const m = clipped.reduce((a, b) => a + b, 0) / clipped.length;
  const s = Math.sqrt(clipped.reduce((a, b) => a + (b - m) ** 2, 0) / clipped.length);
  if (s > 1e-9) { keep.push(j); mean.push(m); std.push(s); lo.push(l); hi.push(h); }
  else console.log(`[train] dropping ${names[j]} (no variance)`);
}
const kept = keep.map((j) => names[j]);
const z = (rowsIn: number[][]) =>
  rowsIn.map((r) =>
    keep.map((j, k) => (Math.min(Math.max(r[j], lo[k]), hi[k]) - mean[k]) / std[k]),
  );
const Ztr = z(Xtr), Zte = z(Xte);

// ── logistic regression, full-batch gradient descent with L2 ──────────
const d = kept.length;
let w = new Array(d).fill(0);
let b = 0;
const lr = 0.5;
const l2 = 1e-4;
const sigmoid = (t: number) => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, t))));

for (let it = 0; it < 400; it++) {
  const gw = new Array(d).fill(0);
  let gb = 0;
  for (let i = 0; i < Ztr.length; i++) {
    let t = b;
    for (let j = 0; j < d; j++) t += w[j] * Ztr[i][j];
    const err = sigmoid(t) - ytr[i];
    gb += err;
    for (let j = 0; j < d; j++) gw[j] += err * Ztr[i][j];
  }
  const n = Ztr.length;
  b -= lr * (gb / n);
  for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
}

// ── evaluate on the held-out later period ─────────────────────────────
const score = (row: number[]) => sigmoid(row.reduce((a, v, j) => a + w[j] * v, b));
const preds = Zte.map(score);

const auc = rocAuc(preds, yte);
const baseRate = yte.reduce((a, v) => a + v, 0) / yte.length;
const order = preds.map((p, i) => [p, yte[i]] as const).sort((a, b2) => b2[0] - a[0]);
const top = order.slice(0, Math.max(1, Math.floor(order.length * 0.1)));
const topRate = top.reduce((a, [, yy]) => a + yy, 0) / top.length;

const model: BaseModel = {
  version: 1,
  trainedAt: new Date().toISOString(),
  horizonS: horizon,
  features: kept,
  mean, std, lo, hi, weights: w, bias: b,
  metrics: {
    nTrain: Ztr.length, nTest: Zte.length,
    baseRate, auc,
    top10Rate: topRate,
    top10Lift: topRate / (baseRate || 1),
    trainCutoff: cutoff,
  },
};

console.log(`[train] n=${rows.length} (${Ztr.length} train / ${Zte.length} test, cutoff ${cutoff})`);
console.log(`[train] base rate ${(baseRate * 100).toFixed(2)}%   AUC ${auc.toFixed(4)}`);
console.log(`[train] top decile ${(topRate * 100).toFixed(2)}%  =  ${model.metrics.top10Lift.toFixed(2)}x lift`);
console.log(`[train] strongest terms:`);
kept.map((n2, j) => [n2, w[j]] as const)
  .sort((a, b2) => Math.abs(b2[1]) - Math.abs(a[1]))
  .slice(0, 10)
  .forEach(([n2, wt]) => console.log(`         ${wt > 0 ? "+" : "-"} ${n2.padEnd(22)} ${wt.toFixed(4)}`));

mkdirSync("models", { recursive: true });
writeFileSync("models/base_model.json", JSON.stringify(model, null, 2));

// Also record the card in Postgres, so the UI can show what the model is and how
// it scored without reading a file that only exists on the training machine.
try {
  const { q } = await import("../db.js");
  await q(
    `INSERT INTO sa_model (horizon_s, n_train, n_test, base_rate, auc, top10_rate,
                           top10_lift, train_cutoff, features, label)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      horizon, Ztr.length, Zte.length, baseRate, auc, topRate,
      model.metrics.top10Lift, cutoff,
      JSON.stringify(
        kept.map((n2, j) => ({ name: n2, weight: w[j] }))
          .sort((a, b2) => Math.abs(b2.weight) - Math.abs(a.weight)),
      ),
      `reached +${Math.round((TP_MULT - 1) * 100)}% before falling ${Math.round((SL_MULT - 1) * 100)}%, within 10 minutes of entry`,
    ],
  );
  console.log("[train] model card written to sa_model");
} catch (e) {
  // Training already succeeded and the views are updated; failing to record the
  // card is cosmetic and must not undo that.
  console.error("[train] could not write model card:", (e as Error).message);
}

// ── publish: rebuild both views with the score inlined ─────────────────
const expr = modelScoreSql(model);
await rebuildViews(expr);
console.log("[train] views rebuilt with model_score — backtest and live now share it");

async function rebuildViews(scoreExpr: string): Promise<void> {
  const { readFileSync } = await import("node:fs");
  for (const f of ["03_episodes_enriched.sql", "07_live_episodes.sql"]) {
    const tpl = readFileSync(`${process.env.SQL_DIR || "/opt/solagents/clickhouse"}/${f}`, "utf8");
    if (!tpl.includes("{{MODEL_SCORE_EXPR}}")) {
      throw new Error(`${f} has no {{MODEL_SCORE_EXPR}} placeholder`);
    }
    await chWrite(tpl.replace("{{MODEL_SCORE_EXPR}}", scoreExpr));
  }
}

/** Rank-based AUC. */
function rocAuc(p: number[], t: number[]): number {
  const idx = p.map((v, i) => [v, t[i]] as const).sort((a, b2) => a[0] - b2[0]);
  let rankSum = 0, pos = 0, neg = 0, i = 0;
  while (i < idx.length) {
    let j = i;
    while (j < idx.length && idx[j][0] === idx[i][0]) j++;
    const avgRank = (i + j + 1) / 2; // 1-based, ties share the mean rank
    for (let k = i; k < j; k++) if (idx[k][1] === 1) rankSum += avgRank;
    i = j;
  }
  for (const [, tt] of idx) tt === 1 ? pos++ : neg++;
  if (!pos || !neg) return 0.5;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

process.exit(0);
