// The memory panel's calls: each is one memory-contract operation, forwarded
// by the adapter as this container's user (adapter/src/memory-rpc.ts). Params
// and results are the contract's types, so a change there is a type error here.

import { natsService } from './nats'
import type { MemoryInput, MemoryResult, UiOp } from '@memory-contract'

function call<O extends UiOp>(op: O, params: MemoryInput<O>): Promise<MemoryResult<O>> {
  return natsService.invoke(op, params) as Promise<MemoryResult<O>>
}

export const memoryService = {
  list:    (q: MemoryInput<'memory_list'>) => call('memory_list', q),
  dirs:    () => call('memory_dirs', { all_projects: true }),
  tree:    () => call('memory_tree', {}),
  graph:   (include_deleted = false) => call('memory_graph', { include_deleted }),
  get:     (memory_id: string) => call('memory_get', { memory_id }),
  search:  (q: MemoryInput<'memory_search'>) => call('memory_search', q),
  update:  (p: MemoryInput<'memory_update'>) => call('memory_update', p),
  forget:  (memory_id: string) => call('memory_forget', { memory_id }),
  restore: (memory_id: string) => call('memory_restore', { memory_id }),
  audit:   (memory_id: string) => call('memory_audit', { memory_id }),
  buildJobs: () => call('memory_build_jobs', {}),
}

/** memory-builder.py's scan: the files a build would read (adapter/src/memory-builder.ts ScanResult). */
export interface ScanResult {
  files: Array<{ path: string; size: number; action: 'parse' | 'skip'; kind: 'table' | 'document' | null; reason?: string }>
  estimate: { table_rows: number; documents: number }
}

/** The memory builder runs in this member's adapter (adapter/src/memory-builder.ts). */
export const memoryBuilder = {
  preview: (path: string) => natsService.invoke('memory_build_preview', { path }) as Promise<ScanResult>,
  start:   (path: string, scope: 'project' | 'user') =>
    natsService.invoke('memory_build', { path, scope }) as Promise<{ job_id: string }>,
  previewUrl: (url: string) => natsService.invoke('memory_build_url_preview', { url }) as Promise<{
    url: string; kind: string; bytes: number; title: string | null
  }>,
  startUrl:   (p: { url: string; request: string; scope: 'project' | 'user'; project?: string }) =>
    natsService.invoke('memory_build_url', p) as Promise<{ job_id: string }>,
}
