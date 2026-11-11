// Memory directory mapping. The directory catalogue itself lives in the
// memory_dirs table (migration 0017); this module only knows which directory
// a write lands in when the caller doesn't name one.

export type Scope = "user" | "project" | "org";

/** The username org memories are stored under (scope 'org' in migration 0017). */
export const ORG_USER = "__org__";

// Mirrors the generated `memories.scope` column.
export function scopeOf(username: string, project_dir: string | null): Scope {
  if (username === ORG_USER) return "org";
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
      if (type === "observation" || type === "experience") return "user/experience";
      return "user/notes";
    case "org":
      if (type === "project") return "org/entities";
      if (type === "reference" || type === "session_summary" || type === "claim") return "org/references";
      return "org/experience";
  }
}

// The directory a write lands in: the caller's choice, else the default.
export function resolveDir(
  username: string, project_dir: string | null, type: string, dir?: string,
): string {
  return dir ?? defaultDir(scopeOf(username, project_dir), type);
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
