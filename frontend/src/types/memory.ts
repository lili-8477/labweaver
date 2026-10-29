// LabWeaver Memory Types — MIT License

export type MemoryType = 'user' | 'feedback' | 'project' | 'reference' | 'session_summary' | 'observation'
export type MemorySource = 'user' | 'distilled'
export type ScopeTier = 'org' | 'user' | 'project'

export interface MemoryListItem {
  memory_id: string
  type: MemoryType
  source: MemorySource
  scope_tier: ScopeTier
  name: string
  description: string
  created_at: string
  updated_at: string
  hit_count: number
  last_hit_at: string | null
  deleted_at: string | null
}

export interface MemoryDetail extends MemoryListItem {
  dir_key: string
  body: string
  facets: Record<string, string[]>
  source_session_id: string | null
}

export interface MemoryAuditEntry {
  audit_id: number
  action: 'write' | 'update' | 'forget' | 'restore'
  actor: string
  before: unknown
  after: unknown
  created_at: string
}

// Search hit with snippet and relevance score
export interface MemorySearchHit extends MemoryListItem {
  snippet: string
  score: number
}

// GET /memory/tree (hub/indexer/src/memory-repo.ts): directory instances
// ordered user → each project → org, each with its top memories.
export interface TreeMemory {
  memory_id: string
  name: string
  description: string
  dir_key: string
  scope: ScopeTier
  project_dir: string | null
  type: MemoryType
  source: MemorySource
  hit_count: number
  last_hit_at: string | null
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export interface TreeDir {
  dir_key: string
  scope: ScopeTier
  l0: string
  project_dir: string | null
  entry_count: number    // live entries
  deleted_count: number
  over_cap: boolean
  updated_at: string | null
  truncated: boolean     // more rows exist than `memories` holds
  memories: TreeMemory[]
}

export interface MemoryTree {
  cap: number
  limit: number
  dirs: TreeDir[]
}
