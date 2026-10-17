import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Anything with pg-style query(text, params), i.e. neon Pool or PGlite.
export type Db = { query(text: string, params?: unknown[]): Promise<{ rows: any[] }> };

export async function applyMigrations(db: Db, dir: string): Promise<string[]> {
  await db.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
  const done = new Set((await db.query("select name from schema_migrations")).rows.map((r) => r.name));
  const applied: string[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (done.has(name)) continue;
    // ponytail: no transaction around file + record; a failed file may need manual cleanup. Wrap in BEGIN/COMMIT if migrations get risky.
    await db.query(readFileSync(join(dir, name), "utf8"));
    await db.query("insert into schema_migrations (name) values ($1)", [name]);
    applied.push(name);
  }
  return applied;
}
