import { Pool } from "@neondatabase/serverless";
import { fileURLToPath } from "node:url";
import { applyMigrations } from "../lib/migrate.ts";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}
const pool = new Pool({ connectionString: url });
try {
  const applied = await applyMigrations(pool, fileURLToPath(new URL("../db/migrations", import.meta.url)));
  console.log(applied.length ? `applied: ${applied.join(", ")}` : "up to date");
} finally {
  await pool.end();
}
