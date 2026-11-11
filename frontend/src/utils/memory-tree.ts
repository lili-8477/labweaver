// Shapes the flat /memory/tree payload into scope → directory → memory rows
// with the stats each row shows. Pure functions; no store access.

import type { MemoryTree, MemoryTreeLeaf, ScopeTier } from '@/types'

const WEEK_MS = 7 * 86_400_000

export interface DirNode {
  dir_key: string
  name: string
  l0: string
  leaves: MemoryTreeLeaf[]
  uses: number
  success: number
  failure: number
  weekly: number[]           // new memories per week, oldest first
  updated_at: string | null
}

export interface ScopeNode {
  scope: ScopeTier
  label: string
  total: number
  dirs: DirNode[]
}

export const SCOPE_LABEL: Record<ScopeTier, string> = { project: 'Project', org: 'Org', user: 'Mine' }

// New memories per week over the last `weeks` weeks, oldest first.
export function weeklyCounts(dates: string[], weeks = 8, now = Date.now()): number[] {
  const counts = new Array<number>(weeks).fill(0)
  for (const d of dates) {
    const age = Math.floor((now - new Date(d).getTime()) / WEEK_MS)
    if (age >= 0 && age < weeks) counts[weeks - 1 - age]++
  }
  return counts
}

// Directories keep the hub's catalogue order; `only` limits leaves to a topic
// and then drops directories and scopes left empty.
export function buildScopes(tree: MemoryTree, only?: Set<string>): ScopeNode[] {
  const byDir = new Map<string, MemoryTreeLeaf[]>()
  for (const m of tree.memories) {
    if (only && !only.has(m.memory_id)) continue
    byDir.set(m.dir_key, [...(byDir.get(m.dir_key) ?? []), m])
  }
  const scopes = new Map<ScopeTier, ScopeNode>()
  for (const d of tree.dirs) {
    const leaves = byDir.get(d.dir_key) ?? []
    if (only && !leaves.length) continue
    const sum = (k: 'hit_count' | 'success_count' | 'failure_count') => leaves.reduce((n, m) => n + m[k], 0)
    const node: DirNode = {
      dir_key: d.dir_key,
      name: d.dir_key.split('/')[1] ?? d.dir_key,
      l0: d.l0,
      leaves,
      uses: sum('hit_count'),
      success: sum('success_count'),
      failure: sum('failure_count'),
      weekly: weeklyCounts(leaves.map(m => m.created_at)),
      updated_at: leaves.reduce<string | null>((a, m) => (a && a > m.updated_at ? a : m.updated_at), null),
    }
    const scope = scopes.get(d.scope) ?? { scope: d.scope, label: SCOPE_LABEL[d.scope], total: 0, dirs: [] }
    scope.dirs.push(node)
    scope.total += leaves.length
    scopes.set(d.scope, scope)
  }
  return [...scopes.values()]
}

// Cumulative memory count at each creation time, ending at `now`.
export function growthSeries(memories: MemoryTreeLeaf[], now = Date.now()): { t: number; n: number }[] {
  const times = memories.map(m => new Date(m.created_at).getTime()).sort((a, b) => a - b)
  const points = times.map((t, i) => ({ t, n: i + 1 }))
  if (points.length) points.push({ t: Math.max(now, points[points.length - 1].t), n: points.length })
  return points
}
