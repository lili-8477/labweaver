// Memory shapes as the UI receives them, from the memory contract
// (hub/indexer/src/memory-contract.ts). Type-only: nothing of the contract
// reaches the bundle.

import type {
  AuditRow, DirSummary, ListItem, MemoryDetail as DetailRow, MemoryInput, Scope, SearchHit,
  MemoryTree as TreeShape, TreeMemory, TreeTopic, MemoryGraph as GraphShape, GraphNode, GraphEdge,
} from '@memory-contract'

export type ScopeTier = Scope
export type MemorySource = ListItem['source']
/** Known memory types; the API reports any string. */
export type MemoryType = 'user' | 'feedback' | 'project' | 'reference' | 'session_summary' | 'observation' | 'claim' | 'experience'

export type MemoryListItem = ListItem
export type MemoryDetail = DetailRow
export type MemoryAuditEntry = AuditRow
export type MemorySearchHit = SearchHit
export type MemoryDirSummary = DirSummary
export type MemoryTreeLeaf = TreeMemory
export type MemoryTopic = TreeTopic
export type MemoryTree = TreeShape
// v1's context graph (hub/indexer/src/memory-graph.ts): memories, skills and resources.
export type MemoryGraph = GraphShape
export type MemoryGraphNode = GraphNode
export type MemoryGraphNodeKind = GraphNode['kind']
export type MemoryGraphEdge = GraphEdge

export type MemoryListQuery = MemoryInput<'memory_list'>
export type MemorySearchQuery = MemoryInput<'memory_search'>
export type MemoryUpdate = MemoryInput<'memory_update'>
