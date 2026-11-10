// The memory builder's write (docs/superpowers/specs/2026-11-09-memory-builder-plugin-design.md):
// entries the member's adapter parsed and segmented from a file, folder or
// website become lab reference memories with source 'import'. Category is a
// facet plus a directory; provenance is a set of facets. Dedupe is the
// content hash, so re-importing the same source writes nothing new.

import type { Pool } from "pg";
import { contentHash } from "./content-hash.js";
import { insertMemoryRow } from "./distiller-repo.js";
import { appendAudit } from "./memory-audit.js";
import type { ImportCategory, ImportEntry } from "./memory-contract.js";
import { defaultDir, scopeOf, type Scope } from "./memory-dirs.js";
import { withTx } from "./tx.js";

export type { ImportCategory, ImportEntry };

const CATEGORY_DIRS: Record<Exclude<ImportCategory, "reference">, string> = {
  protocol: "protocols", inventory: "inventories", data_record: "data-records", pipeline: "pipelines",
};

/** The directory an imported entry lands in (migration 0025). */
export function importDir(scope: Scope, category: ImportCategory): string {
  return category === "reference" ? defaultDir(scope, "reference") : `${scope}/${CATEGORY_DIRS[category]}`;
}

export async function importEntries(args: {
  pool:            Pool;
  username:        string;
  project_dir:     string | null;
  builder_version: number;
  entries:         ImportEntry[];
}): Promise<{ created: number; duplicates: number; memory_ids: string[] }> {
  const scope = scopeOf(args.username, args.project_dir);
  const imported_at = new Date().toISOString();
  return withTx(args.pool, async (client) => {
    const memory_ids: string[] = [];
    for (const e of args.entries) {
      const dir_key = importDir(scope, e.category);
      // Hashed like a member's own memory (promptVersion 0), so an entry that
      // repeats one they wrote by hand is a duplicate, and so is a rebuild.
      const content_hash = contentHash({ body: `${e.name}\n${e.body}`, promptVersion: 0 });
      const memory_id = await insertMemoryRow(client, {
        username: args.username, project_dir: args.project_dir, source: "import", type: "reference",
        source_session_id: null, name: e.name, description: e.description, body: e.body,
        facets: {
          ...e.facets,
          category: [e.category], origin_kind: [e.origin_kind], origin: [e.origin],
          origin_sha256: [e.origin_sha256], imported_at: [imported_at],
          builder_version: [String(args.builder_version)],
        },
        content_hash, dir_key, domain: "lab",
      });
      if (memory_id === null) continue;
      memory_ids.push(memory_id);
      await appendAudit(client, {
        memory_id, actor: args.username, action: "write", before: null,
        after: { type: "reference", source: "import", name: e.name, description: e.description, body: e.body, dir_key, origin: e.origin },
      });
    }
    return { created: memory_ids.length, duplicates: args.entries.length - memory_ids.length, memory_ids };
  });
}

/** Which of these source files (by sha256) already have live imported
 *  memories in the scope, so the builder can skip them unchanged instead of
 *  segmenting them again (a model splits the same text differently each time). */
export async function importedFiles(args: {
  pool: Pool; username: string; project_dir: string | null; sha256s: string[];
}): Promise<string[]> {
  if (args.sha256s.length === 0) return [];
  const r = await args.pool.query<{ value: string }>(
    `SELECT DISTINCT f.value
       FROM memory_facets f JOIN memories m USING (memory_id)
      WHERE f.key = 'origin_sha256' AND f.value = ANY($3::text[])
        AND m.username = $1 AND m.project_dir IS NOT DISTINCT FROM $2
        AND m.source = 'import' AND m.deleted_at IS NULL`,
    [args.username, args.project_dir, args.sha256s],
  );
  return r.rows.map((row) => row.value);
}
