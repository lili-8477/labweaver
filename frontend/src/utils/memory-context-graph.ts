// Turns the /memory/graph payload into d3-force simulation data: hidden node
// kinds are filtered out with their edges, and each node gets a radius from
// its kind and degree. Pure; the d3-force layout mutates x/y on these nodes.

import type { SimulationLinkDatum, SimulationNodeDatum } from 'd3-force'
import type { MemoryGraph, MemoryGraphEdge, MemoryGraphNode, MemoryGraphNodeKind } from '@/types'

export type SimNode = MemoryGraphNode & SimulationNodeDatum & { r: number }

export interface SimLink extends SimulationLinkDatum<SimNode> {
  source: string | SimNode
  target: string | SimNode
  kind: MemoryGraphEdge['kind']
}

const BASE_R: Record<MemoryGraphNodeKind, number> = { memory: 3.5, skill: 6, resource: 5, topic: 4 }

export function buildSimGraph(g: MemoryGraph, hidden: Set<MemoryGraphNodeKind>): { nodes: SimNode[]; links: SimLink[] } {
  const shown = g.nodes.filter(n => !hidden.has(n.kind))
  const ids = new Set(shown.map(n => n.id))
  const links: SimLink[] = g.edges
    .filter(e => ids.has(e.source) && ids.has(e.target))
    .map(e => ({ ...e }))
  const degree = new Map<string, number>()
  for (const l of links) {
    for (const id of [l.source as string, l.target as string]) degree.set(id, (degree.get(id) ?? 0) + 1)
  }
  const nodes: SimNode[] = shown.map(n => ({
    ...n,
    r: BASE_R[n.kind] + (n.kind === 'resource' && n.type === 'project' ? 2 : 0)
       + Math.min(5, Math.sqrt(degree.get(n.id) ?? 0) * 0.9),
  }))
  return { nodes, links }
}

// Node id → ids of directly linked nodes.
export function adjacency(edges: { source: string | SimNode; target: string | SimNode }[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>()
  const id = (e: string | SimNode) => (typeof e === 'string' ? e : e.id)
  for (const l of edges) {
    const a = id(l.source), b = id(l.target)
    if (!adj.has(a)) adj.set(a, new Set())
    if (!adj.has(b)) adj.set(b, new Set())
    adj.get(a)!.add(b)
    adj.get(b)!.add(a)
  }
  return adj
}
