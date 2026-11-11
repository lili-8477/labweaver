// Memory writes by their owner: write, update, forget and restore. Every
// change is audited (memory-audit.ts) in its own transaction.

import type { Pool } from "pg";
import { contentHash } from "./content-hash.js";
import { insertMemoryRow } from "./distiller-repo.js";
import { InvalidDirError, isDirFkViolation, resolveDir } from "./memory-dirs.js";
import { embedForMerge, findSimilar, type MergeCheck, type SimilarMemory } from "./memory-merge.js";
import { withOwnedRow, type Changed } from "./memory-access.js";
import type { Domain } from "./memory-domain.js";
import { appendAudit } from "./memory-audit.js";
import { REINFORCE_SQL } from "./memory-outcome.js";
import { withTx } from "./tx.js";

export interface WriteUserMemoryArgs {
  pool:        Pool;
  username:    string;
  scope:       "user" | "project" | "org";
  project_dir: string | null;     // required when scope === "project"; ignored otherwise
  type:        "user" | "feedback" | "project" | "reference";
  name:        string;
  description: string;
  body:        string;
  domain:      Domain;
  facets?:     Record<string, string[]>;
  dir?:        string;            // dir_key; defaults by (scope, type)
  // When set, look for near matches in the target directory first and return
  // them instead of writing. force_new skips the check.
  merge?:      MergeCheck;
  force_new?:  boolean;
}

// Persist a /memorize-style user-authored memory. Shares the chunk + facet +
// queue path with distillation by delegating to insertMemoryRow; the only
// caller-side differences are source='user', source_session_id=NULL, and the
// content_hash recipe.
//
// Org-scope writes are operator-administered (sub-phase B spec §7.4): they
// cannot be issued from inside a user container, so we reject them here.
//
// Returns { memory_id: null } when the row collides on
// (username, project_dir, type, content_hash) — that is dedup, not failure —
// and { memory_id: null, similar } when the merge check found near matches.
export async function writeUserMemory(
  args: WriteUserMemoryArgs,
): Promise<{ memory_id: string | null; similar?: SimilarMemory[] }> {
  if (args.scope === "org") {
    throw new Error("org-scope writes are admin-only; use the operator administration path");
  }
  if (args.scope === "project" && args.project_dir == null) {
    throw new Error("scope=project requires a project_dir");
  }
  const project_dir = args.scope === "user" ? null : args.project_dir;

  // promptVersion=0 is the sentinel for user-authored memories: there is no
  // distillation prompt to version, so identical user content always hashes
  // the same regardless of any future prompt-version bumps in distillation.
  const hash = contentHash({
    body:          `${args.name}\n${args.body}`,
    promptVersion: 0,
  });

  const dirKey = resolveDir(args.username, project_dir, args.type, args.dir);
  const embedding = args.merge
    ? (await embedForMerge(args.merge, [args.body]))?.[0]
    : undefined;

  return await withTx(args.pool, async (client) => {
    if (args.merge && embedding && !args.force_new) {
      const similar = await findSimilar(client, {
        username: args.username, project_dir, dir_key: dirKey,
        embedding, similarity: args.merge.similarity,
      });
      if (similar.length > 0) {
        return { memory_id: null, similar };
      }
    }
    const memory_id = await insertMemoryRow(client, {
      username:          args.username,
      project_dir,
      source:            "user",
      type:              args.type,
      source_session_id: null,
      name:              args.name,
      description:       args.description,
      body:              args.body,
      facets:            args.facets ?? {},
      content_hash:      hash,
      dir_key:           dirKey,
      domain:            args.domain,
      embedding,
    });
    if (memory_id !== null) {
      await appendAudit(client, {
        memory_id,
        actor:  args.username,
        action: 'write',
        before: null,
        after:  {
          type: args.type, name: args.name, description: args.description, body: args.body,
          dir_key: dirKey,
        },
      });
    }
    return { memory_id };
  }, (r) => r.similar === undefined);
}

export interface ForgetMemoryArgs {
  pool:     Pool;
  username: string;          // for authorization scoping (caller cannot forget another user's memory)
  memoryId: string;
}

// Soft-delete a memory by setting `deleted_at = now()`. Authorisation is
// enforced in the WHERE clause: a row is only updated when both the id and
// the caller's username match. Returns {ok: true} when a row was actually
// updated, {ok: false} for any miss (not found, owned by someone else, or
// already deleted) — that asymmetry makes the second forget on the same id
// idempotent without silently lying to the caller.
//
// Chunks, facets, and embedder_queue rows are intentionally left in place.
// Search and timeline already filter by `deleted_at IS NULL`, so the data is
// invisible to readers; physical deletion is a separate retention concern.
export async function forgetMemory(args: ForgetMemoryArgs): Promise<{ ok: boolean }> {
  const r = await withOwnedRow<{ deleted_at: Date | null; name: string }, "deleted">(
    args.pool, args.memoryId, args.username, "deleted_at, name",
    async (client, row) => {
      // Already deleted → idempotent false, no audit.
      if (row.deleted_at !== null) return { ok: false, reason: "deleted" };
      await client.query(
        `UPDATE memories SET deleted_at = now(), updated_at = now() WHERE memory_id = $1`,
        [args.memoryId],
      );
      await appendAudit(client, {
        memory_id: args.memoryId,
        actor:     args.username,
        action:    'forget',
        before:    { deleted_at: null, name: row.name },
        after:     null,
      });
      return { ok: true };
    },
  );
  // Not found, not yours and already deleted all read as "nothing forgotten".
  return { ok: r.ok };
}

export async function updateMemory(args: {
  pool:        Pool;
  actor:       string;
  memoryId:    string;
  name:        string;
  description: string;
  body:        string;
  dir?:        string;            // move to another dir in the same scope
  domain?:     Domain;            // relabel; unchanged when omitted
  // Fold a near-duplicate into this memory (merge-on-write). Unlike a plain
  // edit it may rewrite distilled rows; audited as 'merge'.
  merge?:      boolean;
}): Promise<Changed<"not_found" | "forbidden" | "distilled" | "immutable">> {
  type Row = {
    source:      string;
    name:        string;
    description: string;
    body:        string;
    scope:       "user" | "project" | "org";
    dir_key:     string;
    type:        string;
  };
  return withOwnedRow<Row, "distilled" | "immutable">(
    args.pool, args.memoryId, args.actor, "source, name, description, body, scope, dir_key, type",
    async (client, row) => {
      if (row.source !== 'user' && !args.merge) return { ok: false, reason: 'distilled' };
      // Claims are immutable, even for merges: a correction is a new claim
      // linked with SUPERSEDES or RETRACTS (spec §4.1).
      if (row.type === 'claim') return { ok: false, reason: 'immutable' };

      // Match writeUserMemory's hash recipe exactly: promptVersion=0, body=`${name}\n${body}`.
      const hash = contentHash({
        body:          `${args.name}\n${args.body}`,
        promptVersion: 0,
      });

      const dirKey = args.dir ?? row.dir_key;
      try {
        await client.query(
          `UPDATE memories
              SET name        = $1,
                  description = $2,
                  body        = $3,
                  content_hash = $4,
                  dir_key     = $6,
                  domain      = COALESCE($7, domain),
                  updated_at  = now()
                  ${args.merge ? `, ${REINFORCE_SQL}` : ""}
            WHERE memory_id = $5`,
          [args.name, args.description, args.body, hash, args.memoryId, dirKey, args.domain ?? null],
        );
      } catch (e) {
        if (isDirFkViolation(e)) throw new InvalidDirError(dirKey, row.scope);
        throw e;
      }

      // Delete old chunks and re-insert one chunk with the new body, embedding=NULL.
      await client.query(`DELETE FROM memory_chunks WHERE memory_id = $1`, [args.memoryId]);
      const chunk = await client.query<{ chunk_id: string }>(
        `INSERT INTO memory_chunks (memory_id, chunk_idx, content)
         VALUES ($1, 0, $2) RETURNING chunk_id`,
        [args.memoryId, args.body],
      );
      await client.query(
        `INSERT INTO embedder_queue (chunk_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [chunk.rows[0]!.chunk_id],
      );

      await appendAudit(client, {
        memory_id: args.memoryId,
        actor:     args.actor,
        action:    args.merge ? 'merge' : 'update',
        before:    { name: row.name, description: row.description, body: row.body, dir_key: row.dir_key },
        after:     { name: args.name, description: args.description, body: args.body, dir_key: dirKey },
      });
      return { ok: true };
    },
  );
}

export async function restoreMemory(args: {
  pool:     Pool;
  actor:    string;
  memoryId: string;
}): Promise<Changed<"not_found" | "forbidden" | "not_deleted">> {
  return withOwnedRow<{ deleted_at: Date | null }, "not_deleted">(
    args.pool, args.memoryId, args.actor, "deleted_at",
    async (client, row) => {
      if (row.deleted_at === null) return { ok: false, reason: 'not_deleted' };
      await client.query(
        `UPDATE memories SET deleted_at = NULL, updated_at = now() WHERE memory_id = $1`,
        [args.memoryId],
      );
      await appendAudit(client, {
        memory_id: args.memoryId,
        actor:     args.actor,
        action:    'restore',
        before:    { deleted_at: row.deleted_at },
        after:     { deleted_at: null },
      });
      return { ok: true };
    },
  );
}
