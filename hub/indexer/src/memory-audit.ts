// The memory audit log: one memory_audit_log row per change to a memory,
// written inside the change's own transaction.

import type { PoolClient } from "pg";
import type { AuditRow } from "./memory-contract.js";

export interface AuditEntry {
  memory_id: string;
  actor:     string;
  action:    AuditRow["action"];
  before:    Record<string, unknown> | null;
  after:     Record<string, unknown> | null;
}

export async function appendAudit(
  client: PoolClient,
  e: AuditEntry,
): Promise<void> {
  await client.query(
    `INSERT INTO memory_audit_log (memory_id, actor, action, before, after)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
    [
      e.memory_id,
      e.actor,
      e.action,
      e.before ? JSON.stringify(e.before) : null,
      e.after  ? JSON.stringify(e.after)  : null,
    ],
  );
}
