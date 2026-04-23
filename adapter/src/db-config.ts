export interface DbConfig {
  enabled: boolean;
  pgUrl: string;
  username: string;
}

/**
 * Load PG_URL + USERNAME from env. Returns {enabled: false} when PG_URL is
 * absent so the adapter can boot without the hub postgres during early
 * dev/testing (no-op path). When PG_URL is set, USERNAME is required and
 * validated.
 */
export function loadDbConfig(env: Record<string, string | undefined> = process.env): DbConfig {
  const pgUrl = env.PG_URL;
  if (!pgUrl) return { enabled: false, pgUrl: "", username: "" };
  const username = env.USERNAME;
  if (!username) throw new Error("USERNAME is required when PG_URL is set");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(username)) {
    throw new Error(`USERNAME must match ^[a-z0-9][a-z0-9-]*$; got ${JSON.stringify(username)}`);
  }
  return { enabled: true, pgUrl, username };
}
