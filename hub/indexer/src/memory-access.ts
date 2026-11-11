// Memory access (GLOSSARY.md): who may see a memory and who may change it,
// decided once for every query and mutation.
//
// See: a memory is visible to a viewer when it is theirs or the org's, and
// its access class is within their clearance. Deleted, superseded and
// project filters are not visibility — each query chooses those.
//
// Change: only the owner changes a memory (withOwnedRow), under a row lock,
// all in one transaction.

import type { Pool, PoolClient } from "pg";
import { ACCESS_ORDER, type AccessClass } from "./access-classes.js";
import type { Domain } from "./memory-domain.js";
import { withTx } from "./tx.js";

/** Who is reading: their username and clearance, and the domain they read when it is one (the lab UI). */
export interface Viewer {
  username:  string;
  clearance: AccessClass;
  domain?:   Domain;
}

/** The viewer when no clearance is configured for them (MEMORY_CLEARANCE). */
export const DEFAULT_CLEARANCE: AccessClass = "internal";

const ORDER_SQL = `ARRAY[${ACCESS_ORDER.map((c) => `'${c}'`).join(",")}]`;

/**
 * SQL condition: memory row `alias` is visible to the viewer whose username
 * and clearance are the query parameters `user` and `clearance` (e.g. "$1").
 * With `domain`, a parameter holding the viewer's domain or NULL, the row
 * must also be of that domain.
 */
export function visibleSql(alias: string, user: string, clearance: string, domain?: string): string {
  return `((${alias}.username = ${user} OR ${alias}.scope = 'org')
    AND array_position(${ORDER_SQL}, ${alias}.access_class) <= array_position(${ORDER_SQL}, ${clearance}::text)${
    domain ? `\n    AND (${domain}::text IS NULL OR ${alias}.domain = ${domain})` : ""})`;
}

export type Changed<Reason extends string> = { ok: true } | { ok: false; reason: Reason };

/**
 * Run `change` on memory `memoryId` if `actor` owns it: locks the row, reads
 * `columns` (plus username), and commits when `change` succeeds or rolls back
 * when it refuses or throws. not_found / forbidden come from here.
 */
export async function withOwnedRow<Row, Reason extends string>(
  pool: Pool,
  memoryId: string,
  actor: string,
  columns: string,
  change: (client: PoolClient, row: Row) => Promise<Changed<Reason>>,
): Promise<Changed<Reason | "not_found" | "forbidden">> {
  return await withTx(pool, async (client) => {
    const sel = await client.query<Row & { username: string }>(
      `SELECT username, ${columns} FROM memories WHERE memory_id = $1 FOR UPDATE`,
      [memoryId],
    );
    const row = sel.rows[0];
    const out: Changed<Reason | "not_found" | "forbidden"> =
      !row ? { ok: false, reason: "not_found" }
      : row.username !== actor ? { ok: false, reason: "forbidden" }
      : await change(client, row);
    return out;
  }, (out) => out.ok);
}
