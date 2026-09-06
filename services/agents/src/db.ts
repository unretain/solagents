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
