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
}
