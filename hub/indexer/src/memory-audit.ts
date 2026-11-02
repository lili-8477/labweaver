import type { PoolClient } from "pg";

export interface AuditEntry {
  memory_id: string;
  actor:     string;
  action:    'write' | 'update' | 'forget' | 'restore' | 'merge';
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
