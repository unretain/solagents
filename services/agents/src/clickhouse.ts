/**
 * ClickHouse client.
 *
 * Reads go over HTTP GET (which the server enforces as readonly — a useful
 * guarantee for a service that runs user-authored filters). Writes must be POST
 * with the body sent raw, because the POST body is NOT url-decoded server-side.
 */
const URL_BASE = process.env.CLICKHOUSE_URL || "http://127.0.0.1:8123";
const USER = process.env.CLICKHOUSE_USER || "default";
const PASS = process.env.CLICKHOUSE_PASSWORD || "";

const auth = "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64");

export async function chQuery<T>(sql: string): Promise<T[]> {
  const res = await fetch(`${URL_BASE}/?${new URLSearchParams({ query: sql })}`, {
    headers: { Authorization: auth },
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
    headers: { Authorization: auth, "Content-Type": "text/plain" },
    body: sql,
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`clickhouse ${res.status}: ${(await res.text()).slice(0, 500)}`);
}

/** Single-quoted ClickHouse literal. Use for EVERY user-derived string. */
export function lit(s: string): string {
  return `'${s.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}
