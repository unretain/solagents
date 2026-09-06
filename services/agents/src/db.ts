import { Pool } from "pg";

// The polyx DATABASE_URL carries a `?schema=` query parameter for Prisma, which
// libpq rejects outright ("invalid URI query parameter"). Strip it rather than
// asking for a second connection string that would drift from the first.
function pgUrl(): string {
  const raw = process.env.DATABASE_URL || "";
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
  for (const f of ["01_schema.sql", "02_paper.sql"]) {
    const path = `${dir}/${f}`;
    if (!existsSync(path)) {
      console.warn(`[db] ${path} not found — skipping migration`);
      continue;
    }
    await pool.query(readFileSync(path, "utf8"));
    console.log(`[db] applied ${f}`);
  }
}
