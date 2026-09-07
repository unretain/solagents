/**
 * Static check for the single-page UI.
 *
 * Written after three incidents where a text-slicing patch silently deleted a
 * live function (`selectCoin`, `loadCoinDetail`, `ago`). Each shipped, because
 * the file still PARSED and only threw at runtime on a page I cannot open from
 * here. `ago` was gone while every visible marker for the trade feed was intact,
 * so the feed rendered nothing and looked like a server problem.
 *
 * An earlier version of this tried to find undefined calls generically. That
 * needs the strings and comments stripped first, and this file is full of NESTED
 * template literals, which a regex cannot balance - so the stripper swallowed
 * real code and reported defined functions as missing. A checker that cries wolf
 * is worse than none.
 *
 * So it is explicit instead: these symbols must exist, and every element the
 * script reaches for must be in the markup. Deterministic, no false positives.
 * Add a name here whenever you add a function worth not losing.
 *
 *   node scripts/check_ui.mjs [path]
 */
import fs from "node:fs";

const REQUIRED = [
  // helpers - `ago` is here because losing it silently emptied the trade feed
  "$", "api", "n", "esc", "cls", "usd", "ago", "stat", "coinHTML", "imgTag",
  // shell
  "show", "navStats", "loadHome",
  // live
  "addTrade", "openStream", "tickPicks",
  // terminal
  "loadTerminal", "selectCoin", "loadCoinDetail", "loadCandles", "initChart",
  "applyBars", "ensureYAxis", "buildStyles", "fmtClock",
  // build
  "filterRow", "read", "write", "renderBT", "renderPresets", "renderFeatureTable",
  // pages
  "loadModel", "loadMine", "loadBoard",
  // wallet
  "provider", "paintWallet", "connectWallet", "disconnectWallet", "b58encode", "solTick",
];

const file = process.argv[2] ?? "services/agents/public/index.html";
const html = fs.readFileSync(file, "utf8");
const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!m) {
  console.error("no module script found");
  process.exit(1);
}
const src = m[1];

// `$` is a real identifier here (the querySelector helper) and also a regex
// metacharacter, so names are escaped before being built into a pattern.
const rx = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const defines = (name) =>
  new RegExp(`(function\\s+${rx(name)}\\b|(?:const|let|var)\\s+${rx(name)}\\s*=)`).test(src);

const missing = REQUIRED.filter((name) => !defines(name));

// Every element the script reaches for must exist in the markup. A renamed id
// is the other way this file breaks quietly.
const ids = new Set([...html.matchAll(/id="([\w-]+)"/g)].map((r) => r[1]));
const badIds = [...new Set([...src.matchAll(/\$\("#([\w-]+)"\)/g)].map((r) => r[1]))]
  .filter((id) => !ids.has(id));

// Every required name should also be USED somewhere, or it is dead weight.
const unused = REQUIRED.filter(
  (name) => defines(name) && (src.match(new RegExp(`\\b${name}\\b`, "g")) || []).length < 2,
);

let bad = false;
if (missing.length) {
  bad = true;
  console.error("MISSING - required but not defined:");
  for (const name of missing) console.error(`  ${name}`);
}
if (badIds.length) {
  bad = true;
  console.error("SELECTORS WITH NO MATCHING ELEMENT:");
  for (const id of badIds) console.error(`  #${id}`);
}
if (unused.length) console.warn(`note: defined but never used - ${unused.join(", ")}`);

if (bad) process.exit(1);
console.log(`ui check ok - ${REQUIRED.length} required symbols present, ${ids.size} ids resolve`);
