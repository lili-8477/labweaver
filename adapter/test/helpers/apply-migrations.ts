import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../hub/indexer/migrations/", import.meta.url));

export async function applyIndexerMigrations(pool: Pool): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const f of files) {
    const sql = await readFile(path.join(MIGRATIONS_DIR, f), "utf8");
    await pool.query(sql);
  }
}
