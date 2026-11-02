// Memory directory mapping. The directory catalogue itself lives in the
// memory_dirs table (migration 0017); this module only knows which directory
// a write lands in when the caller doesn't name one.

export type Scope = "user" | "project" | "org";

// Live entries a directory instance (username, project_dir, dir_key) holds
// before distilled rows are retired. MEMORY_DIR_CAP overrides it.
export const DEFAULT_DIR_CAP = 50;

// Mirrors the generated `memories.scope` column.
export function scopeOf(username: string, project_dir: string | null): Scope {
  if (username === "__org__") return "org";
  return project_dir === null ? "user" : "project";
}

// Default directory for (scope, type). Must match the backfill in
// migrations/0017_memory_dirs.sql.
export function defaultDir(scope: Scope, type: string): string {
  switch (scope) {
    case "project":
      if (type === "reference") return "project/entities";
      if (type === "session_summary") return "project/trajectories";
      return "project/decisions";
    case "user":
      if (type === "user" || type === "feedback") return "user/preferences";
      if (type === "observation") return "user/experience";
      return "user/notes";
    case "org":
      if (type === "project") return "org/entities";
      if (type === "reference" || type === "session_summary") return "org/references";
      return "org/experience";
  }
}

// Thrown when a caller names a directory that doesn't exist or belongs to a
// different scope than the memory (the memories_dir_fk violation).
export class InvalidDirError extends Error {
  constructor(dir: string, scope: Scope) {
    super(`directory '${dir}' does not exist in scope '${scope}'`);
    this.name = "InvalidDirError";
  }
}

export function isDirFkViolation(e: unknown): boolean {
  const err = e as { code?: string; constraint?: string };
  return err?.code === "23503" && err.constraint === "memories_dir_fk";
}
