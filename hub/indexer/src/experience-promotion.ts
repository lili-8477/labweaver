// Phase 4: personal experience that keeps working is proposed to the lab.
// When a user/experience memory reaches PROMOTE_AFTER_SUCCESSES successful
// task uses, a share request is opened on its owner's behalf; an org manager
// (PI or MEMORY_ORG_MANAGER) approves it into org/experience through the
// normal share review. Each memory is auto-proposed at most once: any
// earlier request for it, whatever its outcome, suppresses another.
//
// Scientific guards (spec §7): an experience row must be at least
// 'repeated', must not be contradicted or have failed to replicate (on
// itself or on a claim it derives from), and must not carry restricted or
// IRB access — org memory is readable by the whole lab. Legacy observation
// rows have no validation level and keep the old rule.
import type { Pool } from "pg";
import { submitMemoryShareRequest } from "./share-repo.js";

export const PROMOTE_AFTER_SUCCESSES = 3;

export async function proposeExperiences(args: {
  pool:       Pool;
  managers:   string[];
  memory_ids: string[];
}): Promise<{ proposed: string[] }> {
  if (args.managers.length === 0 || args.memory_ids.length === 0) return { proposed: [] };
  const due = await args.pool.query<{ memory_id: string; username: string }>(
    `SELECT m.memory_id, m.username
       FROM memories m
      WHERE m.memory_id = ANY($1::uuid[])
        AND m.dir_key = 'user/experience'
        AND m.deleted_at IS NULL
        AND m.success_count >= $2
        AND m.status = 'active'
        AND m.access_class IN ('public', 'internal')
        AND (m.type <> 'experience' OR m.validation_level IN ('repeated', 'replicated', 'reviewed'))
        AND NOT EXISTS (
          SELECT 1 FROM memory_edges e
           WHERE e.status = 'accepted'
             AND e.rel IN ('CONTRADICTS', 'FAILED_TO_REPLICATE')
             AND (e.src_id = m.memory_id OR e.dst_id = m.memory_id
                  OR e.dst_id IN (SELECT d.dst_id FROM memory_edges d
                                   WHERE d.src_id = m.memory_id AND d.rel = 'DERIVED_FROM')
                  OR e.src_id IN (SELECT d.dst_id FROM memory_edges d
                                   WHERE d.src_id = m.memory_id AND d.rel = 'DERIVED_FROM')))
        AND NOT EXISTS (
          SELECT 1 FROM share_requests s
           WHERE s.artifact_kind = 'memory' AND s.artifact_ref = m.memory_id::text)`,
    [args.memory_ids, PROMOTE_AFTER_SUCCESSES],
  );
  const proposed: string[] = [];
  for (const row of due.rows) {
    const r = await submitMemoryShareRequest({
      pool:      args.pool,
      managers:  args.managers,
      requester: row.username,
      ref:       row.memory_id,
      note:      `Auto-proposed: used successfully in ${PROMOTE_AFTER_SUCCESSES}+ tasks.`,
    });
    if (r.ok) proposed.push(row.memory_id);
  }
  return { proposed };
}
