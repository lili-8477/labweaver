export interface TokenUsage {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface ParsedEntry {
  type: "user" | "assistant";
  uuid: string;
  sessionId: string;
  timestamp: string;            // ISO-8601
  isSidechain: boolean;
  model: string | null;         // assistant only
  usage: TokenUsage | null;     // assistant only
}

const INTERESTING = new Set(["user", "assistant"]);

export function parseJsonlLine(line: string): ParsedEntry | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = obj.type;
  if (typeof type !== "string" || !INTERESTING.has(type)) return null;
  const uuid = obj.uuid;
  const sessionId = obj.sessionId;
  const timestamp = obj.timestamp;
  if (typeof uuid !== "string" || typeof sessionId !== "string" || typeof timestamp !== "string") {
    return null;
  }
  const isSidechain = obj.isSidechain === true;
  let model: string | null = null;
  let usage: TokenUsage | null = null;
  if (type === "assistant") {
    const msg = obj.message as Record<string, unknown> | undefined;
    if (msg) {
      if (typeof msg.model === "string") model = msg.model;
      const u = msg.usage as Record<string, unknown> | undefined;
      if (u) {
        usage = {
          input: intOr0(u.input_tokens),
          output: intOr0(u.output_tokens),
          cache_read: intOr0(u.cache_read_input_tokens),
          cache_write: intOr0(u.cache_creation_input_tokens),
        };
      }
    }
  }
  return { type: type as ParsedEntry["type"], uuid, sessionId, timestamp, isSidechain, model, usage };
}

export function parseJsonlBuffer(buf: string): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  for (const line of buf.split("\n")) {
    const e = parseJsonlLine(line);
    if (e) out.push(e);
  }
  return out;
}

function intOr0(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return 0;
  return Math.trunc(v);
}
