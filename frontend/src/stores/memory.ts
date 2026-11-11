// LabWeaver Memory Store — MIT License

import { defineStore } from 'pinia'
import { ref } from 'vue'
import { memoryService } from '@/services/memory'
import type {
  MemoryListItem, MemoryDetail, MemoryAuditEntry, MemoryType, MemorySource, ScopeTier, MemoryDirSummary, MemoryTree,
  MemoryListQuery, MemoryGraph,
} from '@/types'
import type { BuildJob } from '@memory-contract'

export const useMemoryStore = defineStore('memory', () => {
  const items = ref<MemoryListItem[]>([])
  const loading = ref(false)
  const cursor = ref<string | null>(null)
  const filters = ref<{
    scope?: ScopeTier
    type?: MemoryType[]
    source?: MemorySource
    dir?: string
    include_deleted: boolean
    sort: 'created' | 'hit'
  }>({
    include_deleted: false,
    sort: 'created',
  })
  const selected = ref<MemoryDetail | null>(null)
  const audit = ref<MemoryAuditEntry[]>([])
  const editDirty = ref(false)
  const editDraft = ref<{ name: string; description: string; body: string } | null>(null)
  const error = ref<string | null>(null)
  const dirs = ref<MemoryDirSummary[]>([])
  const tree = ref<MemoryTree | null>(null)
  const treeLoading = ref(false)
  // The context graph view (v1); same lifecycle as the tree.
  const graph = ref<MemoryGraph | null>(null)
  const graphLoading = ref(false)
  // The Import dialog (MemoryImport.vue): the path it opens on, null when closed.
  const importPath = ref<string | null>(null)
  const jobs = ref<BuildJob[]>([])
  let jobsTimer: ReturnType<typeof setTimeout> | null = null

  function openImport(path: string) {
    importPath.value = path
  }

  // Build jobs refresh every few seconds while one is queued or running; when
  // a job finishes, the list, directories, tree and graph reload to show its memories.
  async function loadJobs() {
    if (jobsTimer !== null) { clearTimeout(jobsTimer); jobsTimer = null }
    const wasActive = new Set(jobs.value.filter(isActive).map((j) => j.job_id))
    try {
      jobs.value = await memoryService.buildJobs()
    } catch {
      return
    }
    if (jobs.value.some((j) => wasActive.has(j.job_id) && !isActive(j))) {
      void loadFirstPage()
      void loadTree()
      void loadGraph()
    }
    if (jobs.value.some(isActive)) jobsTimer = setTimeout(() => void loadJobs(), 3000)
  }

  // Directory counts change with every write/forget, so refresh them with
  // each first-page load. Failure only hides the directory row.
  async function loadDirs() {
    try {
      dirs.value = await memoryService.dirs()
    } catch {
      dirs.value = []
    }
  }

  async function loadTree() {
    treeLoading.value = true
    error.value = null
    try {
      tree.value = await memoryService.tree()
    } catch (e) {
      error.value = (e as Error)?.message || 'Failed to load memory tree'
    } finally {
      treeLoading.value = false
    }
  }

  async function loadGraph() {
    graphLoading.value = true
    error.value = null
    try {
      graph.value = await memoryService.graph(filters.value.include_deleted)
    } catch (e) {
      error.value = (e as Error)?.message || 'Failed to load memory graph'
    } finally {
      graphLoading.value = false
    }
  }

  async function loadFirstPage() {
    void loadDirs()
    loading.value = true
    cursor.value = null
    error.value = null
    try {
      const query: MemoryListQuery = {
        ...filters.value,
        cursor: undefined,
      }
      const response = await memoryService.list(query)
      items.value = response.items
      cursor.value = response.next_cursor
    } catch (e) {
      error.value = (e as Error)?.message || 'Failed to load memories'
      items.value = []
    } finally {
      loading.value = false
    }
  }

  async function loadMore() {
    if (cursor.value === null) return
    loading.value = true
    error.value = null
    try {
      const query: MemoryListQuery = {
        ...filters.value,
        cursor: cursor.value,
      }
      const response = await memoryService.list(query)
      items.value = [...items.value, ...response.items]
      cursor.value = response.next_cursor
    } catch (e) {
      error.value = (e as Error)?.message || 'Failed to load more memories'
    } finally {
      loading.value = false
    }
  }

  async function select(id: string) {
    error.value = null
    try {
      // The audit trail is owner-only: a lab (org) memory still opens, without it.
      const [detail, auditTrail] = await Promise.all([
        memoryService.get(id),
        memoryService.audit(id).catch(() => ({ rows: [] })),
      ])
      selected.value = detail
      audit.value = auditTrail.rows
      editDraft.value = null
      editDirty.value = false
    } catch (e) {
      error.value = (e as Error)?.message || 'Failed to load memory detail'
    }
  }

  async function saveEdit() {
    if (!selected.value || !editDraft.value) return
    error.value = null
    try {
      const response = await memoryService.update({
        memory_id: selected.value.memory_id,
        name: editDraft.value.name,
        description: editDraft.value.description,
        body: editDraft.value.body,
      })
      if (response.ok) {
        // Refetch the selected item and audit trail
        await select(selected.value.memory_id)
        editDraft.value = null
        editDirty.value = false
      }
    } catch (e) {
      error.value = (e as Error)?.message || 'Failed to save memory'
    }
  }

  async function forget(id: string) {
    error.value = null
    try {
      const response = await memoryService.forget(id)
      if (response.ok) {
        // Mark the item as deleted in the local list
        const idx = items.value.findIndex(m => m.memory_id === id)
        if (idx >= 0) {
          items.value[idx].deleted_at = new Date().toISOString()
        }
        if (tree.value) void loadTree()
        // If the selected item was just deleted, refetch it to get the updated state
        if (selected.value?.memory_id === id) {
          await select(id)
        }
      }
    } catch (e) {
      error.value = (e as Error)?.message || 'Failed to forget memory'
    }
  }

  async function restore(id: string) {
    error.value = null
    try {
      const response = await memoryService.restore(id)
      if (response.ok) {
        // Clear deleted_at on the matching item
        const idx = items.value.findIndex(m => m.memory_id === id)
        if (idx >= 0) {
          items.value[idx].deleted_at = null
        }
        if (tree.value) void loadTree()
        // If the selected item was just restored, refetch it
        if (selected.value?.memory_id === id) {
          await select(id)
        }
      }
    } catch (e) {
      error.value = (e as Error)?.message || 'Failed to restore memory'
    }
  }

  function startEdit() {
    if (!selected.value) return
    editDraft.value = {
      name: selected.value.name,
      description: selected.value.description,
      body: selected.value.body,
    }
    editDirty.value = false
  }

  function cancelEdit() {
    editDraft.value = null
    editDirty.value = false
  }

  function setFilter(f: Partial<typeof filters.value>) {
    Object.assign(filters.value, f)
    loadFirstPage()
  }

  return {
    items,
    loading,
    cursor,
    filters,
    selected,
    audit,
    editDirty,
    editDraft,
    error,
    loadFirstPage,
    loadMore,
    select,
    saveEdit,
    forget,
    restore,
    startEdit,
    cancelEdit,
    setFilter,
    dirs,
    tree,
    treeLoading,
    loadTree,
    graph,
    graphLoading,
    loadGraph,
    importPath,
    openImport,
    jobs,
    loadJobs,
  }
})

const isActive = (j: BuildJob) => j.status === 'queued' || j.status === 'running'
