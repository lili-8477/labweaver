<script setup lang="ts">
/**
 * MemoryPanel — top-level container for the memory right-panel slot.
 *
 * Owns the memory lifecycle:
 *   - Calls store.loadFirstPage() on mount (MemoryList.vue does NOT do this).
 *   - Does NOT reset state on unmount so filter+selection survive a Files/Notebook detour.
 *
 * Search mode:
 *   When searchActive is true, store.items is overwritten with search hits coerced
 *   to MemoryListItem shape. The store is otherwise oblivious to search mode — this
 *   is intentional simplicity. Clearing the input or pressing Escape returns to
 *   loadFirstPage() and resets searchActive.
 *
 * Narrow viewport (<600px):
 *   The right-panel default width is 460 px, so the dual-pane is mildly cramped but
 *   workable. A simple single-pane mode (view = 'list' | 'detail') is implemented via
 *   a window.matchMedia watcher. The back button on MemoryDetail is not exposed here
 *   because MemoryDetail doesn't accept props — instead the panel renders a back button
 *   in the narrow-detail header row.
 *
 * Tree and Graph views:
 *   A List / Tree / Graph toggle swaps MemoryList for MemoryTree or MemoryGraph (choice
 *   kept in localStorage). In tree and graph view the search input filters the loaded
 *   payload client-side instead of running a server search, and the scope/source
 *   filters are hidden (both group by scope or kind themselves). MemoryDetail is
 *   shared by all views.
 */

import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useMemoryStore } from '@/stores/memory'
import { memoryService } from '@/services/memory'
import type { MemoryListItem, MemorySource, ScopeTier } from '@/types'
import MemoryList from './MemoryList.vue'
import MemoryDetail from './MemoryDetail.vue'
import MemoryTree from './MemoryTree.vue'
import MemoryGraph from './MemoryGraph.vue'

const store = useMemoryStore()

// ── List / Tree / Graph view ──────────────────────────────────────────────────

type View = 'list' | 'tree' | 'graph'
const VIEWS: { value: View; label: string }[] = [
  { value: 'list', label: 'List' },
  { value: 'tree', label: 'Tree' },
  { value: 'graph', label: 'Graph' },
]
const VIEW_KEY = 'bioflow-memory-view'
const view = ref<View>(
  (() => {
    try {
      const v = localStorage.getItem(VIEW_KEY)
      if (v === 'tree' || v === 'graph') return v
    } catch { /* ignore */ }
    return 'list'
  })()
)

const filterPlaceholder = computed(() =>
  view.value === 'tree' ? 'Filter tree…' : view.value === 'graph' ? 'Filter graph…' : 'Search memories…')

// Each switch reloads the target view so it reflects edits made in the others.
function setView(v: View) {
  if (view.value === v) return
  view.value = v
  try { localStorage.setItem(VIEW_KEY, v) } catch { /* ignore */ }
  if (v === 'tree') {
    store.loadTree()
  } else if (v === 'graph') {
    store.loadGraph()
  } else if (searchInput.value.trim()) {
    scheduleSearch(searchInput.value)
  } else {
    searchActive.value = false
    store.loadFirstPage()
  }
}

function setIncludeDeleted(v: boolean) {
  if (view.value === 'tree') {
    store.filters.include_deleted = v
    store.loadTree()
  } else if (view.value === 'graph') {
    store.filters.include_deleted = v
    store.loadGraph()
  } else {
    store.setFilter({ include_deleted: v })
  }
}

// ── Search ────────────────────────────────────────────────────────────────────

const searchInput = ref('')
const searchActive = ref(false)
let searchTimer: ReturnType<typeof setTimeout> | null = null

function scheduleSearch(val: string) {
  if (searchTimer !== null) clearTimeout(searchTimer)
  if (!val.trim()) {
    // Empty input → return to list mode
    if (searchActive.value) {
      searchActive.value = false
      store.loadFirstPage()
    }
    return
  }
  searchTimer = setTimeout(async () => {
    const hits = await memoryService.search({ query: val.trim(), project_dir: undefined })
    // Overwrite store.items with search hits coerced to MemoryListItem shape.
    // The store is oblivious to search mode; we just replace the array.
    store.items = hits as unknown as MemoryListItem[]
    // Null out cursor so MemoryList's IntersectionObserver won't trigger loadMore.
    store.cursor = null
    searchActive.value = true
  }, 300)
}

function onSearchInput() {
  if (view.value === 'list') scheduleSearch(searchInput.value)
}

function onSearchKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') clearSearch()
}

function clearSearch() {
  searchInput.value = ''
  if (searchActive.value && view.value === 'list') {
    searchActive.value = false
    store.loadFirstPage()
  }
}

// ── Scope tabs ────────────────────────────────────────────────────────────────

type ScopeTab = undefined | ScopeTier  // undefined = "All"

const scopeTabs: { label: string; value: ScopeTab }[] = [
  { label: 'All',     value: undefined },
  { label: 'Org',     value: 'org' },
  { label: 'Mine',    value: 'user' },
  { label: 'Project', value: 'project' },
]

const activeScope = computed(() => store.filters.scope)

function setScope(value: ScopeTab) {
  store.setFilter({ scope: value, dir_key: undefined })
  if (value && !store.tree) store.loadTree()
}

// ── Directories of the active scope (from the tree payload) ──────────────────

const scopeDirs = computed(() => {
  const scope = activeScope.value
  if (!scope || !store.tree) return []
  // Project dirs repeat per project; sum them per dir_key.
  const byKey = new Map<string, { dir_key: string; l0: string; entry_count: number }>()
  for (const d of store.tree.dirs) {
    if (d.scope !== scope) continue
    const cur = byKey.get(d.dir_key)
    if (cur) cur.entry_count += d.entry_count
    else byKey.set(d.dir_key, { dir_key: d.dir_key, l0: d.l0, entry_count: d.entry_count })
  }
  return [...byKey.values()]
})

function toggleDir(dirKey: string) {
  store.setFilter({ dir_key: store.filters.dir_key === dirKey ? undefined : dirKey })
}

// ── Source chip ───────────────────────────────────────────────────────────────

// Cycles: undefined → 'user' → 'distilled' → undefined
const sourceOrder: (MemorySource | undefined)[] = [undefined, 'user', 'distilled']

const sourceLabel = computed(() => {
  const s = store.filters.source
  if (s === 'user') return 'Source: manual'
  if (s === 'distilled') return 'Source: distilled'
  return 'Source: any'
})

function cycleSource() {
  const cur = store.filters.source
  const idx = sourceOrder.indexOf(cur)
  const next = sourceOrder[(idx + 1) % sourceOrder.length]
  store.setFilter({ source: next })
}

// ── Split pane (vertical) ─────────────────────────────────────────────────────

const SPLIT_KEY = 'bioflow-memory-split'
const splitPercent = ref<number>(
  (() => {
    try {
      const v = localStorage.getItem(SPLIT_KEY)
      if (v !== null) {
        const n = Number(v)
        if (n >= 20 && n <= 80) return n
      }
    } catch { /* ignore */ }
    return 40
  })()
)

let splitDragging = false
let splitStartY = 0
let splitStartPct = 0
// Template ref on .split-body. (It used to be a plain `let`, which Vue never
// fills, so the drag handler bailed out and the bar could not move.)
const splitEl = ref<HTMLElement | null>(null)

function onSplitMousedown(e: PointerEvent) {
  splitDragging = true
  splitStartY = e.clientY
  splitStartPct = splitPercent.value
  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
}

function onSplitMousemove(e: PointerEvent) {
  if (!splitDragging || !splitEl.value) return
  const totalH = splitEl.value.getBoundingClientRect().height
  if (totalH === 0) return
  const dy = e.clientY - splitStartY
  const newPct = splitStartPct + (dy / totalH) * 100
  splitPercent.value = Math.max(20, Math.min(80, newPct))
}

function onSplitMouseup() {
  if (!splitDragging) return
  splitDragging = false
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  try { localStorage.setItem(SPLIT_KEY, String(Math.round(splitPercent.value))) } catch { /* ignore */ }
}

function resetSplit() {
  splitPercent.value = 40
  try { localStorage.removeItem(SPLIT_KEY) } catch { /* ignore */ }
}

// ── Narrow viewport ───────────────────────────────────────────────────────────

// Single-pane mode on narrow viewports; default view is 'list'.
const isNarrow = ref(false)
const narrowView = ref<'list' | 'detail'>('list')

let mq: MediaQueryList | null = null
function handleMQ(e: MediaQueryListEvent | MediaQueryList) {
  isNarrow.value = e.matches
}

// Watch for when a memory is selected in narrow mode to switch to detail.
watch(() => store.selected, (val) => {
  if (isNarrow.value && val !== null) narrowView.value = 'detail'
})

// ── Mount / unmount ───────────────────────────────────────────────────────────

onMounted(() => {
  // This is the single source of truth for the initial load — MemoryList.vue
  // no longer calls loadFirstPage() itself.
  if (view.value === 'tree') store.loadTree()
  else if (view.value === 'graph') store.loadGraph()
  else store.loadFirstPage()

  window.addEventListener('pointermove', onSplitMousemove)
  window.addEventListener('pointerup', onSplitMouseup)

  mq = window.matchMedia('(max-width: 600px)')
  handleMQ(mq)
  mq.addEventListener('change', handleMQ)
})

onUnmounted(() => {
  // Intentionally do NOT reset store state so the user's filter+selection
  // survives navigating away to Files/Notebook and back.
  window.removeEventListener('pointermove', onSplitMousemove)
  window.removeEventListener('pointerup', onSplitMouseup)
  mq?.removeEventListener('change', handleMQ)
  if (searchTimer !== null) clearTimeout(searchTimer)
})
</script>

<template>
  <div class="memory-panel">
    <!-- ── Header ─────────────────────────────────────────────────── -->
    <div class="panel-header">
      <!-- Search bar -->
      <div class="search-row">
        <div class="search-wrap">
          <span class="search-icon">⌕</span>
          <input
            v-model="searchInput"
            class="search-input"
            type="search"
            :placeholder="filterPlaceholder"
            :aria-label="filterPlaceholder.replace('…', '')"
            @input="onSearchInput"
            @keydown="onSearchKeydown"
          />
          <button v-if="searchInput" class="search-clear" @click="clearSearch" aria-label="Clear search">×</button>
        </div>
        <div class="view-toggle" role="group" aria-label="View">
          <button
            v-for="v in VIEWS"
            :key="v.value"
            class="scope-tab"
            :class="{ active: view === v.value }"
            :aria-pressed="view === v.value"
            @click="setView(v.value)"
          >{{ v.label }}</button>
        </div>
      </div>

      <!-- Scope tabs -->
      <div class="filter-row" role="tablist" aria-label="Scope">
        <template v-if="view === 'list'">
          <button
            v-for="tab in scopeTabs"
            :key="String(tab.value)"
            class="scope-tab"
            :class="{ active: activeScope === tab.value }"
            role="tab"
            :aria-selected="activeScope === tab.value"
            @click="setScope(tab.value)"
          >{{ tab.label }}</button>

          <span class="filter-spacer" />

          <!-- Source chip -->
          <button
            class="source-chip"
            :class="{ 'chip-active': store.filters.source !== undefined }"
            @click="cycleSource"
            :title="sourceLabel"
          >{{ sourceLabel }}</button>
        </template>
        <span v-else class="filter-spacer" />

        <!-- Include deleted -->
        <label class="deleted-label">
          <input
            type="checkbox"
            class="deleted-cb"
            :checked="store.filters.include_deleted"
            @change="setIncludeDeleted(($event.target as HTMLInputElement).checked)"
          />
          Deleted
        </label>
      </div>

      <!-- Directories of the selected scope -->
      <div v-if="view === 'list' && scopeDirs.length" class="filter-row dir-row" role="tablist" aria-label="Directory">
        <button
          v-for="d in scopeDirs"
          :key="d.dir_key"
          class="scope-tab"
          :class="{ active: store.filters.dir_key === d.dir_key }"
          role="tab"
          :aria-selected="store.filters.dir_key === d.dir_key"
          :title="d.l0"
          @click="toggleDir(d.dir_key)"
        >{{ d.dir_key.split('/')[1] }} <span class="dir-count">{{ d.entry_count }}</span></button>
      </div>
    </div>

    <!-- ── Narrow viewport: single-pane ──────────────────────────── -->
    <template v-if="isNarrow">
      <div class="narrow-pane">
        <!-- Back button only in detail view -->
        <div v-if="narrowView === 'detail'" class="narrow-back-row">
          <button class="btn-back" @click="narrowView = 'list'">‹ Back</button>
        </div>
        <template v-if="narrowView === 'list'">
          <MemoryTree v-if="view === 'tree'" :filter="searchInput" class="pane-fill" />
          <MemoryGraph v-else-if="view === 'graph'" :filter="searchInput" class="pane-fill" />
          <MemoryList v-else class="pane-fill" />
        </template>
        <MemoryDetail v-else class="pane-fill" />
      </div>
    </template>

    <!-- ── Wide viewport: dual-pane vertical split ────────────────── -->
    <template v-else>
      <div
        class="split-body"
        ref="splitEl"
      >
        <!-- List pane (top) -->
        <div
          class="split-pane pane-list"
          :style="{ height: splitPercent + '%' }"
        >
          <MemoryTree v-if="view === 'tree'" :filter="searchInput" class="pane-fill" />
          <MemoryGraph v-else-if="view === 'graph'" :filter="searchInput" class="pane-fill" />
          <MemoryList v-else class="pane-fill" />
        </div>

        <!-- Drag handle -->
        <div
          class="split-resizer"
          role="separator"
          aria-orientation="horizontal"
          title="Drag to resize · double-click to reset"
          @pointerdown.prevent="onSplitMousedown"
          @dblclick="resetSplit"
        />

        <!-- Detail pane (bottom) -->
        <div class="split-pane pane-detail">
          <MemoryDetail class="pane-fill" />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.memory-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
  background: var(--bg-primary);
}

/* ── Header ──────────────────────────────────────────────────────────────── */
.panel-header {
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
}

.search-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3) 0;
}

.search-wrap {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
}

.view-toggle { display: flex; gap: 2px; flex-shrink: 0; }

.search-icon {
  position: absolute;
  left: var(--space-2);
  font-size: var(--text-sm);
  color: var(--text-muted);
  pointer-events: none;
  line-height: 1;
}

.search-input {
  width: 100%;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-1) var(--space-3) var(--space-1) calc(var(--space-2) + 1.2em);
  font-size: var(--text-sm);
  color: var(--text-primary);
  transition: border-color 0.15s;
}

.search-input:focus {
  border-color: var(--accent);
  outline: none;
}

/* Remove browser default clear button on search inputs */
.search-input::-webkit-search-cancel-button { display: none; }

.search-clear {
  position: absolute;
  right: var(--space-2);
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  font-size: var(--text-md);
  line-height: 1;
  padding: 0 2px;
}
.search-clear:hover { color: var(--text-primary); }

/* ── Filter row ──────────────────────────────────────────────────────────── */
.filter-row {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-3);
  flex-wrap: wrap;
}

.scope-tab {
  padding: 2px 10px;
  border-radius: var(--radius-pill);
  background: transparent;
  border: 1px solid transparent;
  font-size: var(--text-xs);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.1s;
  white-space: nowrap;
}
.scope-tab:hover {
  background: var(--bg-tertiary);
  color: var(--text-primary);
}
.scope-tab.active {
  background: var(--accent-soft);
  color: var(--accent);
  border-color: color-mix(in oklch, var(--accent) 30%, transparent);
  font-weight: var(--fw-medium);
}

.filter-spacer { flex: 1; }

.source-chip {
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  font-size: var(--text-2xs);
  color: var(--text-secondary);
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.1s;
}
.source-chip:hover {
  border-color: var(--accent);
  color: var(--text-primary);
}
.source-chip.chip-active {
  background: var(--success-soft);
  color: var(--success);
  border-color: color-mix(in oklch, var(--success) 30%, transparent);
}

.deleted-label {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-2xs);
  color: var(--text-muted);
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
}
.deleted-cb { accent-color: var(--accent); cursor: pointer; }

/* ── Narrow pane (single pane < 600 px) ──────────────────────────────────── */
.narrow-pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}

.narrow-back-row {
  flex-shrink: 0;
  padding: var(--space-1) var(--space-3);
  border-bottom: 1px solid var(--border-soft);
  background: var(--bg-secondary);
}
.btn-back {
  background: none;
  border: none;
  color: var(--accent);
  cursor: pointer;
  font-size: var(--text-sm);
  padding: 0;
}
.btn-back:hover { text-decoration: underline; }

/* ── Dual-pane split ─────────────────────────────────────────────────────── */
.split-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}

.split-pane {
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.pane-detail {
  flex: 1;  /* takes the remaining space below the list pane */
}

.split-resizer {
  flex-shrink: 0;
  position: relative;
  height: 9px;
  cursor: row-resize;
  touch-action: none;
}
/* Thin visible line, wide grab area; a grip in the middle shows it moves. */
.split-resizer::before {
  content: '';
  position: absolute; left: 0; right: 0; top: 4px; height: 1px;
  background: var(--border);
  transition: background 0.1s;
}
.split-resizer::after {
  content: '';
  position: absolute; left: 50%; top: 2px; width: 32px; height: 5px;
  transform: translateX(-50%);
  border-radius: 3px;
  background: var(--border);
  transition: background 0.1s;
}
.split-resizer:hover::before, .split-resizer:active::before,
.split-resizer:hover::after, .split-resizer:active::after {
  background: var(--accent);
}

.dir-row { padding-top: 0; }
.dir-count { opacity: 0.6; margin-left: 2px; }

.pane-fill {
  height: 100%;
  overflow: hidden;
}
</style>
