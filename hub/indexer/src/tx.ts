import type { Pool, PoolClient } from "pg";

/**
 * Run `fn` in one transaction on its own client. Commits when `fn` returns and
 * `commitIf` accepts the result (by default always); rolls back when it
 * refuses or when `fn` throws, rethrowing the original error.
 */
export async function withTx<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  commitIf: (result: T) => boolean = () => true,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query(commitIf(result) ? "COMMIT" : "ROLLBACK");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
