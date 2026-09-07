/**
 * ClickHouse client.
 *
 * Reads go over HTTP GET (which the server enforces as readonly - a useful
 * guarantee for a service that runs user-authored filters). Writes must be POST
 * with the body sent raw, because the POST body is NOT url-decoded server-side.
 */
const URL_BASE = process.env.CLICKHOUSE_URL || "http://127.0.0.1:8123";
const USER = process.env.CLICKHOUSE_USER || "default";
const PASS = process.env.CLICKHOUSE_PASSWORD || "";

const auth = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");

// Shared secret for the nginx /ch/ proxy, when reading ClickHouse from off-box.
// Without it that URL would be a public ClickHouse endpoint guarded only by a
// password; with it, anything scanning gets a 403 before ClickHouse is reached.
// Unset for a direct localhost connection, where the header is simply ignored.
const PROXY_KEY = process.env.CLICKHOUSE_PROXY_KEY || "";

function headers(extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { Authorization: auth, ...extra };
  if (PROXY_KEY) h["X-Solagents-Key"] = PROXY_KEY;
  return h;
}

export async function chQuery<T>(sql: string): Promise<T[]> {
  const res = await fetch(`${URL_BASE}/?${new URLSearchParams({ query: sql })}`, {
    headers: headers(),
    signal: AbortSignal.timeout(120_000),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`clickhouse ${res.status}: ${body.slice(0, 500)}`);
  if (!body.trim()) return [];
  return (JSON.parse(body).data ?? []) as T[];
}

export async function chWrite(sql: string): Promise<void> {
  const res = await fetch(URL_BASE, {
    method: "POST",
    headers: headers({ "Content-Type": "text/plain" }),
    body: sql,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`clickhouse ${res.status}: ${(await res.text()).slice(0, 500)}`);
}

/** Single-quoted ClickHouse literal. Use for EVERY user-derived string. */
export function lit(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}
