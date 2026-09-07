/**
 * Image proxy, served from our own path prefix.
 *
 * Coin art had failed in the browser through every host tried: ipfs.io direct
 * (403 from the gateway), api.polyx.trade/img (the polyx proxy) and
 * api.polyx.trade/ipfs (our kubo node) - all of which return valid image bytes
 * to curl with browser headers. Meanwhile every API call under /agents/api/*
 * renders fine.
 *
 * So images now go through the same prefix as the calls that demonstrably work,
 * from the same origin and the same service. That removes the host as a variable
 * instead of guessing at which one the browser objects to.
 *
 * Fetching server-side also fixes the underlying problem: the gateways that
 * refuse a browser will happily answer the box, and a hotlink-blocking CDN never
 * sees a cross-site referer.
 */
import type { Request, Response } from "express";

const KUBO = process.env.IPFS_GATEWAY || "http://127.0.0.1:8080";
const MAX_BYTES = 8 * 1024 * 1024;

/** Fallbacks for a CID, ours first. */
function ipfsCandidates(cid: string): string[] {
  return [
    `${KUBO}/ipfs/${cid}`,
    `https://ipfs.filebase.io/ipfs/${cid}`,
    `https://nftstorage.link/ipfs/${cid}`,
  ];
}

function candidatesFor(url: string): string[] {
  const cid = /\/ipfs\/([A-Za-z0-9]+)/.exec(url);
  if (cid) return ipfsCandidates(cid[1]);
  return [url];
}

/**
 * Refuse anything that is not a public http(s) URL.
 *
 * Without this the endpoint is an SSRF hole: a caller could ask it to fetch
 * 127.0.0.1:8123 and read ClickHouse through us. The kubo gateway is reached by
 * its own constant above, never from user input.
 */
function safeRemote(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" && u.protocol !== "http:") return false;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".local")) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
      const [a, b] = h.split(".").map(Number);
      if (a === 10 || a === 127 || a === 0 || (a === 192 && b === 168)) return false;
      if (a === 172 && b >= 16 && b <= 31) return false;
      if (a === 169 && b === 254) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function serveImage(req: Request, res: Response): Promise<void> {
  const url = String(req.query.u || "");
  if (!url) { res.status(400).end(); return; }

  const tries = candidatesFor(url);
  for (const target of tries) {
    const isOurs = target.startsWith(KUBO);
    if (!isOurs && !safeRemote(target)) continue;
    try {
      const r = await fetch(target, {
        redirect: "follow",
        // Some CDNs serve a placeholder, or nothing, to a client that does not
        // look like a browser.
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; PumpLab/1.0)",
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
        signal: AbortSignal.timeout(9000),
      });
      const ct = r.headers.get("content-type") || "";
      if (!r.ok || !ct.startsWith("image/")) continue;

      const buf = Buffer.from(await r.arrayBuffer());
      if (!buf.length || buf.length > MAX_BYTES) continue;

      res.setHeader("Content-Type", ct);
      res.setHeader("Content-Length", String(buf.length));
      // Coin art never changes for a given URL, so this can be cached hard.
      res.setHeader("Cache-Control", "public, max-age=604800, immutable");
      res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
      res.end(buf);
      return;
    } catch {
      // try the next candidate
    }
  }
  // A 404 lets the client's onerror swap in its placeholder. Returning a
  // stub image instead would look like a successful load of a blank coin.
  res.status(404).end();
}
