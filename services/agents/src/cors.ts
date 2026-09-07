/**
 * Origin allowlist.
 *
 * The page is served from more than one host but reads from exactly one API, so
 * the browser now sends cross-origin requests that need an explicit answer.
 * The answer is an allowlist, not `*`, for two reasons: `*` is incompatible
 * with credentialed requests (the wallet session would stop being sent), and
 * this API is backed by our own validator and our own ClickHouse. Anyone may
 * read the site; nobody else gets to point their own front end at our feed.
 *
 * An origin that is not on the list simply receives no CORS header, which the
 * browser turns into a refusal. Non-browser clients are unaffected either way -
 * CORS is a browser policy, not an authentication mechanism, which is why the
 * genuinely sensitive routes stay behind the wallet session regardless.
 */
import type { Request, Response, NextFunction } from "express";

const ALLOWED = new Set(
  [
    // The site's own domains. pumplab.lol is where people actually arrive;
    // api.polyx.trade is the API host, and is listed because the page is also
    // served from there directly.
    "https://pumplab.lol",
    "https://www.pumplab.lol",
    "https://api.polyx.trade",
    "https://polyx.trade",
    "https://www.polyx.trade",
    "https://solagents-production.up.railway.app",
    ...(process.env.EXTRA_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean),
  ],
);

/** Any Railway preview deploy of this project, plus local dev. */
function allowed(origin: string): boolean {
  if (ALLOWED.has(origin)) return true;
  if (/^https:\/\/[a-z0-9-]+\.up\.railway\.app$/.test(origin)) return true;
  if (/^http:\/\/localhost(:\d+)?$/.test(origin)) return true;
  return false;
}

export function cors(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (origin && allowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    // Echoing a specific origin makes the response vary by it, so a cache must
    // not hand one site's answer to another.
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Max-Age", "86400");
  }
  // Answer the preflight here; it must not fall through to a route that would
  // 404 it and make the real request look blocked.
  if (req.method === "OPTIONS") { res.status(204).end(); return; }
  next();
}
