import { Pool } from "pg";

// The polyx DATABASE_URL carries a `?schema=` query parameter for Prisma, which
// libpq rejects outright ("invalid URI query parameter"). Strip it rather than
// asking for a second connection string that would drift from the first.
function pgUrl(): string {
  const raw = process.env.DATABASE_URL || "";
  // Deliberately does NOT throw: this runs at module load, and a throw there
  // escapes before any caller's error handling exists. The missing-variable
  // case is reported by migrate() instead, where it can be formatted properly.
  if (!raw.trim()) return "";
  try {
    const u = new URL(raw);
    u.searchParams.delete("schema");
    u.searchParams.delete("connection_limit");
    // sslmode is stripped and re-applied via the explicit `ssl` option below.
    // pg-connection-string currently treats sslmode=require as verify-full, and
    // whatever it derives from the URL OVERRIDES the ssl object passed to Pool -
    // so leaving it in makes the connection fail against the box's self-signed
    // certificate no matter what the code says.
    u.searchParams.delete("sslmode");
    u.searchParams.delete("uselibpqcompat");
    return u.toString();
  } catch {
    return raw;
  }
}

/** sslmode as written by the operator, before pgUrl() strips it. */
function requestedSslMode(): string {
  const m = /[?&]sslmode=([^&]+)/.exec(process.env.DATABASE_URL || "");
  return m ? decodeURIComponent(m[1]).toLowerCase() : "";
}

/**
 * TLS for remote connections.
 *
 * The box's Postgres presents Ubuntu's self-signed ("snakeoil") certificate, so
 * the chain cannot be verified and `rejectUnauthorized: true` would refuse every
 * connection. The traffic is still encrypted, and auth is scram-sha-256, which
 * never puts the password on the wire even to a machine-in-the-middle - so the
 * exposure here is confidentiality of query data, not credential theft.
 *
 * Local connections skip TLS entirely: the socket never leaves the machine, and
 * pg_hba only accepts `hostssl` from remote hosts anyway.
 */
function sslConfig(url: string): false | { rejectUnauthorized: boolean } {
  const isLocal = /@(127\.0\.0\.1|localhost|\[::1\]|::1)[:/]/.test(url);
  if (isLocal) return false;
  // An operator who explicitly asked for verify-full gets it, rather than being
  // silently downgraded. Everything else is encrypted-but-unverified, which is
  // what a self-signed server certificate allows.
  return { rejectUnauthorized: requestedSslMode() === "verify-full" };
}

const CONN = pgUrl();
export const pool = new Pool({ connectionString: CONN, max: 8, ssl: sslConfig(CONN) });

/**
 * Readable text for an unknown thrown value.
 *
 * AggregateError - what Node produces when a dual-stack connect fails on both
 * IPv4 and IPv6 - carries an EMPTY `.message` and hides the real reason in
 * `.errors`. Logging `(e as Error).message` on one of those prints nothing at
 * all, which is exactly how a dead database looked in production.
 */
export function describeError(e: unknown): string {
  if (e instanceof AggregateError) {
    const inner = e.errors.map(describeError).filter(Boolean);
    return `${e.message || "all connection attempts failed"}: ${[...new Set(inner)].join("; ")}`;
  }
  if (e instanceof Error) {
    const code = (e as NodeJS.ErrnoException).code;
    const addr = (e as NodeJS.ErrnoException & { address?: string; port?: number });
    const where = addr.address ? ` (${addr.address}:${addr.port ?? "?"})` : "";
    const base = `${e.message || e.name}${code ? ` [${code}]` : ""}${where}`;
    return e.cause ? `${base} <- ${describeError(e.cause)}` : base;
  }
  return String(e);
}

export async function q<T = unknown>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(sql, params as never[]);
  return res.rows as T[];
}

export function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Apply the schema on boot.
 *
 * Every statement is CREATE ... IF NOT EXISTS or ADD COLUMN IF NOT EXISTS, so
 * this is idempotent and safe to run on every deploy. It exists so a fresh
 * Railway Postgres works without a manual psql step - the failure it prevents is
 * a deploy that boots green and then 500s on the first request.
 */
export async function migrate(): Promise<void> {
  const { readFileSync, existsSync } = await import("node:fs");
  const dir = process.env.PG_SQL_DIR || "postgres";

  // An empty connection string does NOT fail loudly on its own: node-postgres
  // falls back to libpq defaults and dials localhost:5432, which in a container
  // produces ECONNREFUSED wrapped in an AggregateError whose `.message` is the
  // empty string - printing literally nothing. Check it explicitly.
  if (!(process.env.DATABASE_URL || "").trim()) {
    throw new Error(
      "DATABASE_URL is not set. On Railway: add the Postgres database to the " +
        "project, then in this service's Variables add DATABASE_URL with the " +
        "value ${{Postgres.DATABASE_URL}} (adding the database alone does not " +
        "expose it to the service).",
    );
  }

  // Connect once first, so a connectivity problem is reported as a connectivity
  // problem rather than as a failure of whichever SQL file happened to run first.
  try {
    const c = await pool.connect();
    const { rows } = await c.query("SELECT current_database() AS db, version() AS v");
    c.release();
    console.log(`[db] connected to ${rows[0].db} (${String(rows[0].v).split(",")[0]})`);
  } catch (e) {
    throw new Error(`cannot reach Postgres: ${describeError(e)}`);
  }

  for (const f of ["01_schema.sql", "02_paper.sql", "03_model.sql", "04_live.sql"]) {
    const path = `${dir}/${f}`;
    if (!existsSync(path)) {
      console.warn(`[db] ${path} not found - skipping migration`);
      continue;
    }
    try {
      await pool.query(readFileSync(path, "utf8"));
    } catch (e) {
      throw new Error(`${f}: ${describeError(e)}`);
    }
    console.log(`[db] applied ${f}`);
  }
}
