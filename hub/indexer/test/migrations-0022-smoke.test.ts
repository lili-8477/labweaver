import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = path.resolve(HERE, '..', 'migrations');
const SID = '00000000-0000-4000-8000-000000000001';
const E1 = '00000000-0000-4000-8000-0000000000e1';
const E2 = '00000000-0000-4000-8000-0000000000e2';

describe('migrations 0019-0024 on existing rows', () => {
  let pgc: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    pgc = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    pool = new Pool({ connectionString: pgc.getConnectionUri() });
    const before = await mkdtemp(path.join(tmpdir(), 'mig-'));
    await cp(MIGRATIONS, before, {
      recursive: true,
      filter: (src) => !/^00(19|2\d)_/.test(path.basename(src)),
    });
    await runMigrations({ pool, migrationsDir: before, lockKey: 0xdeadbeefn });
    await rm(before, { recursive: true });

    // Two distilled rows citing the same transcript entry, one user row.
    for (const [n, entries, sid] of [[1, [E1, E2], SID], [2, [E1], SID], [3, [], null]] as const) {
      await pool.query(
        `INSERT INTO memories (memory_id, username, project_dir, type, source, name, description, body,
                               content_hash, dir_key, source_session_id, source_entry_uuids)
         VALUES (gen_random_uuid(), 'alice', NULL, 'observation', 'distilled', 'n', 'd', 'b',
                 $1, 'user/experience', $2, $3::jsonb)`,
        [Buffer.from([n]), sid, JSON.stringify(entries)],
      );
    }
    await runMigrations({ pool, migrationsDir: MIGRATIONS, lockKey: 0xdeadbeefn });
  }, 120_000);
  afterAll(async () => { await pool.end(); await pgc.stop(); });

  it('existing rows become active, internal, unversioned', async () => {
    const r = await pool.query(`SELECT DISTINCT status, access_class, attrs FROM memories`);
    expect(r.rows).toEqual([{ status: 'active', access_class: 'internal', attrs: {} }]);
  });

  it('backfills one transcript evidence row per entry and links every citing memory', async () => {
    const a = await pool.query(`SELECT uri, modality, locator FROM evidence_assets ORDER BY uri`);
    expect(a.rows).toEqual([
      { uri: `transcript://${SID}/${E1}`, modality: 'transcript', locator: { session_id: SID, entry_uuid: E1 } },
      { uri: `transcript://${SID}/${E2}`, modality: 'transcript', locator: { session_id: SID, entry_uuid: E2 } },
    ]);
    const l = await pool.query(`SELECT count(*)::int AS n FROM memory_evidence`);
    expect(l.rows[0].n).toBe(3);
  });

  it('refuses a self edge', async () => {
    const id = (await pool.query(`SELECT memory_id FROM memories LIMIT 1`)).rows[0].memory_id;
    await expect(pool.query(
      `INSERT INTO memory_edges (src_id, dst_id, rel, actor) VALUES ($1, $1, 'SUPPORTS', 'x')`, [id],
    )).rejects.toThrow(/check/);
  });
});
