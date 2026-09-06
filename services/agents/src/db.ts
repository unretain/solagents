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
    return u.toString();
  } catch {
    return raw;
  }
}

export const pool = new Pool({ connectionString: pgUrl(), max: 8 });

/**
 * Readable text for an unknown thrown value.
 *
 * AggregateError — what Node produces when a dual-stack connect fails on both
 * IPv4 and IPv6 — carries an EMPTY `.message` and hides the real reason in
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
 * Railway Postgres works without a manual psql step — the failure it prevents is
 * a deploy that boots green and then 500s on the first request.
 */
export async function migrate(): Promise<void> {
  const { readFileSync, existsSync } = await import("node:fs");
  const dir = process.env.PG_SQL_DIR || "postgres";

  // An empty connection string does NOT fail loudly on its own: node-postgres
  // falls back to libpq defaults and dials localhost:5432, which in a container
  // produces ECONNREFUSED wrapped in an AggregateError whose `.message` is the
  // empty string — printing literally nothing. Check it explicitly.
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

  for (const f of ["01_schema.sql", "02_paper.sql"]) {
    const path = `${dir}/${f}`;
    if (!existsSync(path)) {
      console.warn(`[db] ${path} not found — skipping migration`);
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
