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
 */

import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useMemoryStore } from '@/stores/memory'
import { memoryService } from '@/services/memory'
import type { MemoryListItem, MemorySource, ScopeTier } from '@/types'
import MemoryList from './MemoryList.vue'
import MemoryDetail from './MemoryDetail.vue'

const store = useMemoryStore()

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
  scheduleSearch(searchInput.value)
}

function onSearchKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') clearSearch()
}

function clearSearch() {
  searchInput.value = ''
  if (searchActive.value) {
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
  store.setFilter({ scope: value })
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
let panelEl: HTMLElement | null = null

function onSplitMousedown(e: MouseEvent) {
  splitDragging = true
  splitStartY = e.clientY
  splitStartPct = splitPercent.value
  document.body.style.cursor = 'row-resize'
  document.body.style.userSelect = 'none'
}

function onSplitMousemove(e: MouseEvent) {
  if (!splitDragging || !panelEl) return
  const totalH = panelEl.getBoundingClientRect().height
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
  store.loadFirstPage()

  window.addEventListener('mousemove', onSplitMousemove)
  window.addEventListener('mouseup', onSplitMouseup)

  mq = window.matchMedia('(max-width: 600px)')
  handleMQ(mq)
  mq.addEventListener('change', handleMQ)
})

onUnmounted(() => {
  // Intentionally do NOT reset store state so the user's filter+selection
  // survives navigating away to Files/Notebook and back.
  window.removeEventListener('mousemove', onSplitMousemove)
  window.removeEventListener('mouseup', onSplitMouseup)
  mq?.removeEventListener('change', handleMQ)
  if (searchTimer !== null) clearTimeout(searchTimer)
})
</script>

<template>
  <div class="memory-panel" ref="panelEl">
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
            placeholder="Search memories…"
            aria-label="Search memories"
            @input="onSearchInput"
            @keydown="onSearchKeydown"
          />
          <button v-if="searchInput" class="search-clear" @click="clearSearch" aria-label="Clear search">×</button>
        </div>
      </div>

      <!-- Scope tabs -->
      <div class="filter-row" role="tablist" aria-label="Scope">
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

        <!-- Include deleted -->
        <label class="deleted-label">
          <input
            type="checkbox"
            class="deleted-cb"
            :checked="store.filters.include_deleted"
            @change="store.setFilter({ include_deleted: ($event.target as HTMLInputElement).checked })"
          />
          Deleted
        </label>
      </div>
    </div>

    <!-- ── Narrow viewport: single-pane ──────────────────────────── -->
    <template v-if="isNarrow">
      <div class="narrow-pane">
        <!-- Back button only in detail view -->
        <div v-if="narrowView === 'detail'" class="narrow-back-row">
          <button class="btn-back" @click="narrowView = 'list'">‹ Back</button>
        </div>
        <MemoryList v-if="narrowView === 'list'" class="pane-fill" />
        <MemoryDetail v-else class="pane-fill" />
      </div>
    </template>

    <!-- ── Wide viewport: dual-pane vertical split ────────────────── -->
    <template v-else>
      <div
        class="split-body"
        ref="panelEl"
      >
        <!-- List pane (top) -->
        <div
          class="split-pane pane-list"
          :style="{ height: splitPercent + '%' }"
        >
          <MemoryList class="pane-fill" />
        </div>

        <!-- Drag handle -->
        <div class="split-resizer" @mousedown.prevent="onSplitMousedown" />

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
  padding: var(--space-2) var(--space-3) 0;
}

.search-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

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
  height: 4px;
  background: var(--border);
  cursor: row-resize;
  transition: background 0.1s;
}
.split-resizer:hover,
.split-resizer:active {
  background: var(--accent);
}

.pane-fill {
  height: 100%;
  overflow: hidden;
}
</style>
