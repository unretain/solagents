/**
 * Live trade stream (Server-Sent Events).
 *
 * Replaces the browser polling `/api/live/trades` every few seconds, which had
 * two problems that turned out to be the same problem: trades arrived in visible
 * clumps of ten, and the coin images never rendered - because each poll rebuilt
 * the table's innerHTML, destroying every <img> before it finished loading.
 * Streaming one trade at a time lets the client append rows that persist, so
 * images load once and stay.
 *
 * SSE rather than a WebSocket: this is one-directional, it survives proxies that
 * mangle upgrade handshakes, and EventSource reconnects on its own. There is
 * nothing to send upstream.
 *
 * ONE tailer serves every connected browser. A per-client poller would multiply
 * ClickHouse queries by the number of open tabs for identical data.
 */
import type { Response } from "express";
import { chQuery } from "./clickhouse.js";

interface Tx {
  mint: string; symbol: string; image: string; ts: string;
  isBuy: number; solAmount: number; priceSol: number; trader: string;
}

const clients = new Set<Response>();
let timer: NodeJS.Timeout | null = null;
let cursorTs = "";
let cursorSeq = 0;

const POLL_MS = 1000;
/** Never emit a burst: spread whatever arrived across the poll window so the
 *  feed reads like a ticker instead of a stack of ten appearing at once. */
const MAX_PER_TICK = 40;

function send(res: Response, event: string, data: unknown): void {
  try {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    clients.delete(res);
  }
}

async function pump(): Promise<void> {
  if (!clients.size) return;

  // (ts, seq) as a tuple is the only correct cursor here: block time is
  // second-precise, so dozens of trades share a ts and a `ts >` cursor would
  // skip every trade after the first in that second.
  const where = cursorTs
    ? `WHERE (ts, seq) > (toDateTime64('${cursorTs}', 3), ${cursorSeq}) AND ts > now() - INTERVAL 2 MINUTE`
    : `WHERE ts > now() - INTERVAL 10 SECOND`;

  let rows: Tx[];
  try {
    rows = await chQuery<Tx>(`
      SELECT t.mint AS mint, ifNull(k.symbol,'') AS symbol, ifNull(k.image,'') AS image,
             toString(t.ts) AS ts, t.seq AS seq, t.is_buy AS isBuy,
             round(t.sol_amount, 4) AS solAmount, t.price_sol AS priceSol, t.trader AS trader
      FROM (
        SELECT mint, ts, seq, is_buy, sol_amount, price_sol, trader
        FROM trades ${where}
        ORDER BY ts ASC, seq ASC
        LIMIT ${MAX_PER_TICK}
      ) AS t
      LEFT JOIN (
        SELECT mint, argMax(symbol, ingested_at) AS symbol, argMax(image, ingested_at) AS image
        FROM tokens GROUP BY mint
      ) AS k ON t.mint = k.mint
      ORDER BY ts ASC, seq ASC
      FORMAT JSON`);
  } catch {
    return; // a transient ClickHouse error must not kill the stream
  }
  if (!rows.length) return;

  const last = rows[rows.length - 1] as Tx & { seq: number };
  cursorTs = last.ts;
  cursorSeq = Number(last.seq) || 0;

  // Stagger emission across the window. Slightly under POLL_MS so a burst has
  // drained before the next query lands and rows never queue up behind us.
  const gap = Math.max(12, Math.floor((POLL_MS - 120) / rows.length));
  rows.forEach((row, i) => {
    setTimeout(() => {
      for (const res of clients) send(res, "trade", row);
    }, i * gap);
  });
}

export function attach(res: Response): void {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    // nginx honours this per-response, so SSE works even where the location
    // block forgot `proxy_buffering off`.
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");
  clients.add(res);

  if (!timer) {
    timer = setInterval(() => { void pump(); }, POLL_MS);
    // Start from "now" when the first client arrives, so a stream opened after
    // an idle period does not replay two minutes of backlog.
    cursorTs = "";
  }

  const hb = setInterval(() => {
    // Comment frames keep the connection alive through Cloudflare and any proxy
    // idle timeout; a quiet market would otherwise look like a dropped stream.
    try { res.write(": ping\n\n"); } catch { /* closed */ }
  }, 15_000);

  res.on("close", () => {
    clearInterval(hb);
    clients.delete(res);
    if (!clients.size && timer) { clearInterval(timer); timer = null; }
  });
}

export function streamClientCount(): number {
  return clients.size;
}
