// Who is calling? Each user container sends its SERVICE_ID as
// `Authorization: Bearer <id>`. The hub's service-map.conf (nginx's map,
// written by hub/scripts/gen-service-map.sh, lines `"<service_id>" "<username>";`)
// says whose it is. The request also names a user in its body or query (actor, requester or
// username), and the routes act as that user.
//
// So /memory/ and /share/ requests are refused unless the key is known (401)
// and belongs to the user the request names (403). Each distinct refusal is
// logged once, so a misbehaving caller does not flood the log.

import { readFileSync, statSync } from "node:fs";
import type { FastifyInstance, FastifyRequest } from "fastify";

export type CallerProblem = "no_key" | "unknown_key" | "wrong_user";

/** service_id → username, from service-map.conf text. */
export function parseCallerMap(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^\s*"([^\s"]+)"\s+"([a-z0-9][a-z0-9-]*)";\s*$/.exec(line);
    if (m) map.set(m[1]!, m[2]!);
  }
  return map;
}

/** The user a request says it acts as; actor wins, as in the routes. */
export function claimedUser(req: Pick<FastifyRequest, "body" | "query">): string | null {
  for (const src of [req.body, req.query]) {
    if (src === null || typeof src !== "object") continue;
    const s = src as Record<string, unknown>;
    for (const k of ["actor", "requester", "username"]) {
      if (typeof s[k] === "string" && s[k] !== "") return s[k] as string;
    }
  }
  return null;
}

export function checkCaller(
  callers: Map<string, string>,
  authorization: string | undefined,
  claimed: string | null,
): { caller: string | null; problem: CallerProblem | null } {
  const key = /^Bearer (\S+)$/.exec(authorization ?? "")?.[1];
  if (!key) return { caller: null, problem: "no_key" };
  const caller = callers.get(key) ?? null;
  if (caller === null) return { caller, problem: "unknown_key" };
  if (claimed !== null && claimed !== caller) return { caller, problem: "wrong_user" };
  return { caller, problem: null };
}

/**
 * Re-reads the map when the file changes. An unreadable file is an empty map,
 * so every request is refused until it is fixed.
 */
function callerMapReader(file: string, warn: (obj: object, msg: string) => void): () => Map<string, string> {
  let mtimeMs = -1;
  let map = new Map<string, string>();
  return () => {
    try {
      const st = statSync(file);
      if (st.mtimeMs !== mtimeMs) {
        map = parseCallerMap(readFileSync(file, "utf8"));
        mtimeMs = st.mtimeMs;
      }
    } catch (err) {
      if (mtimeMs !== -2) warn({ file, err: (err as Error).message }, "caller map unreadable: refusing every caller");
      map = new Map();
      mtimeMs = -2;
    }
    return map;
  };
}

const STATUS: Record<CallerProblem, number> = { no_key: 401, unknown_key: 401, wrong_user: 403 };

/**
 * Refuse /memory/ and /share/ requests from unknown callers or callers acting
 * as someone else. Glasses routes have their own secret and health checks need
 * none, so both are skipped.
 */
export function checkCallers(
  app: FastifyInstance,
  opts: { mapFile: string; warn: (obj: object, msg: string) => void },
): void {
  const callers = callerMapReader(opts.mapFile, opts.warn);
  const seen = new Set<string>();
  app.addHook("preValidation", async (req, reply) => {
    const route = req.routeOptions.url ?? req.url;
    if (!route.startsWith("/memory/") && !route.startsWith("/share/")) return;
    const claimed = claimedUser(req);
    const { caller, problem } = checkCaller(callers(), req.headers.authorization, claimed);
    if (problem === null) return;
    const key = `${problem} ${caller} ${claimed} ${req.method} ${route}`;
    if (!seen.has(key)) {
      seen.add(key);
      opts.warn({ problem, caller, claimed, method: req.method, route }, "caller refused");
    }
    return reply.code(STATUS[problem]).send({ error: `caller refused: ${problem}` });
  });
}
