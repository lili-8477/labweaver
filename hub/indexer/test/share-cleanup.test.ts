import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { Pool } from "pg";
import { mkdtemp, writeFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runMigrations } from "../src/migrate.js";
import { cleanupOldSnapshots } from "../src/share-cleanup.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe("cleanupOldSnapshots", () => {
  let pgc: StartedPostgreSqlContainer;
  let pool: Pool;
  let snapshotsDir: string;

  beforeAll(async () => {
    pgc  = await new PostgreSqlContainer("pgvector/pgvector:pg16").start();
    pool = new Pool({ connectionString: pgc.getConnectionUri() });
    await runMigrations({
      pool,
      migrationsDir: path.resolve(HERE, "..", "migrations"),
      lockKey:       0xdeadbeefn,
    });
  }, 60_000);

  afterAll(async () => { await pool.end(); await pgc.stop(); });

  beforeEach(async () => {
    snapshotsDir = await mkdtemp(path.join(tmpdir(), "snap-cleanup-"));
    await pool.query(`DELETE FROM share_requests`);
  });

  afterEach(async () => {
    await rm(snapshotsDir, { recursive: true, force: true });
  });

  /** Insert a share_requests row + optionally a tarball file. */
  async function seedRow(opts: {
    kind: 'skill' | 'folder' | 'memory';
    decidedDaysAgo: number | null;     // null = still pending
    withTarball: boolean;
  }): Promise<string> {
    const decidedAt = opts.decidedDaysAgo === null
      ? null
      : new Date(Date.now() - opts.decidedDaysAgo * 24 * 60 * 60 * 1000);
    const status = decidedAt === null ? 'pending' : 'approved';
    const r = await pool.query<{ share_id: string }>(
      `INSERT INTO share_requests
         (artifact_kind, artifact_ref, snapshot_meta, requester, reviewer,
          status, decided_at)
       VALUES ($1, 'x', '{}', 'alice', 'li86', $2, $3)
       RETURNING share_id`,
      [opts.kind, status, decidedAt],
    );
    const id = r.rows[0]!.share_id;
    if (opts.withTarball) {
      await writeFile(path.join(snapshotsDir, `${id}.tar.gz`), "stub");
    }
    return id;
  }

  it("deletes tarballs whose row was decided > ttl days ago", async () => {
    const oldId = await seedRow({ kind: 'skill', decidedDaysAgo: 31, withTarball: true });
    const r = await cleanupOldSnapshots({ pool, snapshotsDir, ttlDays: 30 });
    expect(r).toEqual({ scanned: 1, deleted: 1, missing: 0, errors: 0 });
    await expect(access(path.join(snapshotsDir, `${oldId}.tar.gz`))).rejects.toThrow();
  });

  it("leaves tarballs whose row was decided <= ttl days ago", async () => {
    const youngId = await seedRow({ kind: 'skill', decidedDaysAgo: 29, withTarball: true });
    const r = await cleanupOldSnapshots({ pool, snapshotsDir, ttlDays: 30 });
    expect(r).toEqual({ scanned: 0, deleted: 0, missing: 0, errors: 0 });
    await expect(access(path.join(snapshotsDir, `${youngId}.tar.gz`))).resolves.toBeUndefined();
  });

  it("leaves tarballs of pending requests regardless of age", async () => {
    const pendingId = await seedRow({ kind: 'skill', decidedDaysAgo: null, withTarball: true });
    const r = await cleanupOldSnapshots({ pool, snapshotsDir, ttlDays: 30 });
    expect(r.scanned).toBe(0);
    await expect(access(path.join(snapshotsDir, `${pendingId}.tar.gz`))).resolves.toBeUndefined();
  });

  it("ignores memory rows (no tarball ever existed)", async () => {
    await seedRow({ kind: 'memory', decidedDaysAgo: 100, withTarball: false });
    const r = await cleanupOldSnapshots({ pool, snapshotsDir, ttlDays: 30 });
    expect(r.scanned).toBe(0);
  });

  it("counts already-missing tarballs separately from errors", async () => {
    await seedRow({ kind: 'skill', decidedDaysAgo: 60, withTarball: false });
    const r = await cleanupOldSnapshots({ pool, snapshotsDir, ttlDays: 30 });
    expect(r).toEqual({ scanned: 1, deleted: 0, missing: 1, errors: 0 });
  });

  it("processes a mix correctly", async () => {
    await seedRow({ kind: 'skill',  decidedDaysAgo: 90, withTarball: true });   // delete
    await seedRow({ kind: 'folder', decidedDaysAgo: 45, withTarball: true });   // delete
    await seedRow({ kind: 'skill',  decidedDaysAgo: 10, withTarball: true });   // keep
    await seedRow({ kind: 'skill',  decidedDaysAgo: 50, withTarball: false });  // missing
    await seedRow({ kind: 'memory', decidedDaysAgo: 50, withTarball: false });  // ignored
    await seedRow({ kind: 'skill',  decidedDaysAgo: null, withTarball: true }); // pending — keep

    const r = await cleanupOldSnapshots({ pool, snapshotsDir, ttlDays: 30 });
    expect(r).toEqual({ scanned: 3, deleted: 2, missing: 1, errors: 0 });
  });

  it("throws RangeError for ttlDays < 1", async () => {
    await expect(cleanupOldSnapshots({ pool, snapshotsDir, ttlDays: 0 }))
      .rejects.toThrow(RangeError);
    await expect(cleanupOldSnapshots({ pool, snapshotsDir, ttlDays: -5 }))
      .rejects.toThrow(/positive integer/);
  });

  it("cleans tarballs of withdrawn requests too (status-agnostic)", async () => {
    const decidedAt = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);  // 60 days ago
    const r = await pool.query<{ share_id: string }>(
      `INSERT INTO share_requests
         (artifact_kind, artifact_ref, snapshot_meta, requester, reviewer, status, decided_at)
       VALUES ('skill', 'x', '{}', 'alice', 'li86', 'withdrawn', $1)
       RETURNING share_id`,
      [decidedAt],
    );
    const id = r.rows[0]!.share_id;
    await writeFile(path.join(snapshotsDir, `${id}.tar.gz`), "stub");

    const result = await cleanupOldSnapshots({ pool, snapshotsDir, ttlDays: 30 });
    expect(result).toEqual({ scanned: 1, deleted: 1, missing: 0, errors: 0 });
  });
});
