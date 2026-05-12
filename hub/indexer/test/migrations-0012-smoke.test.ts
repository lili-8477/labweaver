import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMigrations } from '../src/migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

describe('migration 0012 share artifact_kind skill_update', () => {
  let pgc: StartedPostgreSqlContainer;
  let pool: Pool;

  beforeAll(async () => {
    pgc = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
    pool = new Pool({ connectionString: pgc.getConnectionUri() });
    await runMigrations({
      pool,
      migrationsDir: path.resolve(HERE, '..', 'migrations'),
      lockKey: 0xdeadbeefn,
    });
  }, 60_000);
  afterAll(async () => { await pool.end(); await pgc.stop(); });

  it('accepts skill_update kind', async () => {
    const r = await pool.query(
      `INSERT INTO share_requests (artifact_kind, artifact_ref, snapshot_meta,
                                   requester, reviewer)
       VALUES ('skill_update', 'x', '{}'::jsonb, 'alice', 'li86')
       RETURNING share_id`,
    );
    expect(r.rowCount).toBe(1);
  });

  it('still rejects garbage kind', async () => {
    await expect(pool.query(
      `INSERT INTO share_requests (artifact_kind, artifact_ref, snapshot_meta,
                                   requester, reviewer)
       VALUES ('frobnitz', 'x', '{}'::jsonb, 'alice', 'li86')`,
    )).rejects.toThrow(/share_requests_artifact_kind_check/);
  });
});
