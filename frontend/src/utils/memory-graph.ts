// Turns the /memory/tree payload into a knowledge graph: scope and directory
// nodes form the category skeleton, memories hang off their directory, and
// topic nodes (shared pipeline/tool/dataset facets) link memories across
// categories. Pure; the d3-force layout mutates x/y on these nodes.

import type { SimulationLinkDatum, SimulationNodeDatum } from 'd3-force'
import type { MemoryTree, ScopeTier } from '@/types'
import { SCOPE_LABEL } from './memory-tree'

export type GraphNodeKind = 'scope' | 'dir' | 'memory' | 'topic'

export interface GraphNode extends SimulationNodeDatum {
  id: string
  kind: GraphNodeKind
  label: string
  scope: ScopeTier | null     // category colour; null for topics
  r: number
  // memory: task outcomes; topic: readiness
  success: number
  failure: number
  uses: number
  ready: boolean
  detail: string              // tooltip second line
}

export interface GraphLink extends SimulationLinkDatum<GraphNode> {
  source: string | GraphNode
  target: string | GraphNode
  kind: 'category' | 'topic'
}

export const topicNodeId = (topic: string) => `topic:${topic}`

// Empty directories and scopes are left out: the graph shows what exists.
export function buildGraph(tree: MemoryTree): { nodes: GraphNode[]; links: GraphLink[] } {
  const nodes: GraphNode[] = []
  const links: GraphLink[] = []
  const base = { success: 0, failure: 0, uses: 0, ready: false }

  const scopes = new Set<ScopeTier>()
  for (const d of tree.dirs) {
    if (!d.entry_count) continue
    const scopeId = `scope:${d.scope}`
    if (!scopes.has(d.scope)) {
      scopes.add(d.scope)
      nodes.push({ ...base, id: scopeId, kind: 'scope', label: SCOPE_LABEL[d.scope], scope: d.scope, r: 11, detail: '' })
    }
    nodes.push({
      ...base, id: `dir:${d.dir_key}`, kind: 'dir', label: d.dir_key.split('/')[1] ?? d.dir_key,
      scope: d.scope, r: 5 + Math.sqrt(d.entry_count) * 1.4, detail: `${d.entry_count} memories · ${d.l0}`,
    })
    links.push({ source: scopeId, target: `dir:${d.dir_key}`, kind: 'category' })
  }

  const dirIds = new Set(nodes.filter(n => n.kind === 'dir').map(n => n.id))
  for (const m of tree.memories) {
    if (!dirIds.has(`dir:${m.dir_key}`)) continue
    nodes.push({
      id: m.memory_id, kind: 'memory', label: m.name, scope: m.scope,
      r: 3 + Math.min(4, Math.sqrt(m.hit_count) * 1.2),
      success: m.success_count, failure: m.failure_count, uses: m.hit_count, ready: false,
      detail: m.description,
    })
    links.push({ source: `dir:${m.dir_key}`, target: m.memory_id, kind: 'category' })
  }

  const memoryIds = new Set(tree.memories.map(m => m.memory_id))
  for (const t of tree.topics) {
    nodes.push({
      id: topicNodeId(t.topic), kind: 'topic', label: t.value, scope: null,
      r: 4 + Math.sqrt(t.memory_count) * 1.6,
      success: t.success_count, failure: t.failure_count, uses: t.hit_count, ready: t.ready,
      detail: `${t.key} · ${t.memory_count} memories · ${t.success_count} successful uses`,
    })
    for (const id of t.memory_ids) {
      if (memoryIds.has(id)) links.push({ source: id, target: topicNodeId(t.topic), kind: 'topic' })
    }
  }
  return { nodes, links }
}

// Node id → ids of directly linked nodes.
export function adjacency(links: GraphLink[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>()
  const id = (e: string | GraphNode) => (typeof e === 'string' ? e : e.id)
  for (const l of links) {
    const a = id(l.source), b = id(l.target)
    if (!adj.has(a)) adj.set(a, new Set())
    if (!adj.has(b)) adj.set(b, new Set())
    adj.get(a)!.add(b)
    adj.get(b)!.add(a)
  }
  return adj
}
