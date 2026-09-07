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
  "filterRow", "read", "write", "renderBT", "paintLlm", "initCA", "loadWallet", "openCode", "closeCode", "startScan", "stopScan", "scanRead", "scanTick", "scanDraw", "initScanChart", "renderPresets", "renderFeatureTable",
  // pages
  "loadModel", "loadMine", "loadBoard", "rankIcon",
  // wallet
  "provider", "paintWallet", "connectWallet", "disconnectWallet", "b58encode", "solTick",
];

const file = process.argv[2] ?? "services/agents/public/index.html";

/**
 * Parse the page's module script.
 *
 * This checker matched NAMES and ids for months and never once parsed the code,
 * so an edit that produced an unterminated string literal passed it and shipped
 * a page that ran nothing at all. A symbol list cannot catch a syntax error;
 * only a parser can. `node --check` on a .mjs gets module semantics, so
 * top-level await reads as valid rather than as a false alarm.
 */
async function syntaxCheck(src, lineOffset) {
  const { writeFileSync, mkdtempSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const f = join(mkdtempSync(join(tmpdir(), "uicheck-")), "page.mjs");
  writeFileSync(f, src);
  try {
    execFileSync(process.execPath, ["--check", f], { stdio: "pipe" });
  } catch (e) {
    const out = String(e.stderr || e.stdout || e.message);
    const m = /page\.mjs:(\d+)/.exec(out);
    const where = m ? `  (index.html line ${Number(m[1]) + lineOffset})` : "";
    console.error(`ui check FAILED - the page does not parse:${where}`);
    console.error(out.split("\n").slice(0, 8).join("\n"));
    process.exit(1);
  }
}

const NL = String.fromCharCode(10);

/**
 * Balance the container tags.
 *
 * An extra </div> in the home page closed .wrap early, so every section after
 * Overview escaped the 1360px container and rendered at full window width -
 * the leaderboard ran off the right edge and the page scrolled sideways. The
 * browser does not complain about this; it silently reparents everything.
 *
 * Only div and section are tracked. They are the ones the layout depends on,
 * and they are always explicitly closed here, so a mismatch is a real fault
 * rather than a void element or an optional end tag.
 */
function structureCheck(html) {
  const start = html.indexOf('<div class="wrap">');
  if (start < 0) return;
  const end = html.indexOf('<script type="module">');
  const body = html.slice(start, end);
  const before = html.slice(0, start).split(NL).length;
  const re = /<(\/?)(div|section)\b[^>]*?(\/?)>/g;
  let m, depth = 0, closedAt = 0;
  while ((m = re.exec(body))) {
    if (m[3] === '/') continue;
    depth += m[1] ? -1 : 1;
    if (depth === 0 && !closedAt) {
      closedAt = before + body.slice(0, m.index).split(NL).length - 1;
    }
    if (depth < 0) {
      const ln = before + body.slice(0, m.index).split(NL).length - 1;
      console.error(`ui check FAILED - unbalanced </${m[2]}> at index.html line ${ln}`);
      process.exit(1);
    }
  }
  if (depth !== 0) {
    console.error(`ui check FAILED - ${depth} container tag(s) left open in index.html`);
    process.exit(1);
  }
  const last = [...body.matchAll(/<section[^>]*id="page-[a-z]+"/g)].pop();
  if (last && closedAt) {
    const lastLn = before + body.slice(0, last.index).split(NL).length - 1;
    if (closedAt < lastLn) {
      console.error(`ui check FAILED - .wrap closes at line ${closedAt}, before the last page section at ${lastLn}`);
      console.error('  sections after that point render outside the container, full window width');
      process.exit(1);
    }
  }
}

const html = fs.readFileSync(file, "utf8");
const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
if (!m) {
  console.error("no module script found");
  process.exit(1);
}
const src = m[1];

// Parse first. Every check below is about the CONTENT of code that runs;
// none of it means anything if the file does not parse.
structureCheck(html);
await syntaxCheck(src, html.slice(0, m.index).split("\n").length);

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
