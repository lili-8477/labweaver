<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import { useMemoryStore } from '@/stores/memory'
import type { MemoryListItem } from '@/types'

const store = useMemoryStore()

const tailRef = ref<HTMLDivElement | null>(null)
let observer: IntersectionObserver | null = null

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return 'just now'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d ago`
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(iso))
}

function scopeLabel(tier: MemoryListItem['scope_tier']): string {
  return `[${tier}]`
}

function sourceLabel(src: MemoryListItem['source']): string {
  return src === 'distilled' ? '[distilled]' : '[manual]'
}

function connectObserver() {
  if (!tailRef.value) return
  observer?.disconnect()
  observer = new IntersectionObserver(
    ([entry]) => { if (entry.isIntersecting && store.cursor !== null && !store.loading) store.loadMore() },
    { threshold: 0.1 },
  )
  observer.observe(tailRef.value)
}

// Reconnect whenever cursor becomes non-null (pagination reset after setFilter)
watch(() => store.cursor, (cur) => {
  if (cur !== null) connectObserver()
})

onMounted(() => {
  if (store.items.length === 0) store.loadFirstPage()
  connectObserver()
})

onUnmounted(() => observer?.disconnect())
</script>

<template>
  <div class="memory-list">
    <!-- Error banner -->
    <div v-if="store.error" class="error-banner" role="alert">
      <span class="error-msg">{{ store.error }}</span>
      <button class="link-btn" @click="store.loadFirstPage()">Retry</button>
    </div>

    <!-- Scrollable list -->
    <div class="list-scroll">
      <!-- Empty state -->
      <div v-if="store.items.length === 0 && !store.loading" class="empty">
        <p class="empty-title">No memories yet</p>
        <p class="empty-hint">Use <code>/memorize</code> in chat to add one.</p>
      </div>

      <button
        v-for="item in store.items"
        :key="item.memory_id"
        class="memory-row"
        :class="{ selected: store.selected?.memory_id === item.memory_id }"
        @click="store.select(item.memory_id)"
      >
        <div class="row-main">
          <span
            class="row-name"
            :class="{ deleted: item.deleted_at !== null }"
          >{{ item.name }}</span>
          <span class="row-time">{{ relTime(item.updated_at) }}</span>
        </div>
        <div class="row-sub">
          <span class="row-desc">{{ item.description }}</span>
          <div class="row-badges">
            <span class="badge badge-scope">{{ scopeLabel(item.scope_tier) }}</span>
            <span class="badge badge-source">{{ sourceLabel(item.source) }}</span>
            <span v-if="item.deleted_at !== null" class="badge badge-deleted">[deleted]</span>
          </div>
        </div>
      </button>

      <!-- Tail sentinel for infinite scroll -->
      <div ref="tailRef" class="tail-sentinel" />

      <!-- Loading indicator -->
      <div v-if="store.loading" class="loading-row">
        <span class="spinner" />
        <span>Loading…</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.memory-list {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}

/* Error banner */
.error-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: color-mix(in srgb, var(--danger) 12%, var(--bg-secondary));
  border-bottom: 1px solid var(--border);
  font-size: var(--text-xs);
  color: var(--danger);
  flex-shrink: 0;
}
.error-msg { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.link-btn { background: none; border: none; padding: 0; color: var(--accent); cursor: pointer; font-size: inherit; flex-shrink: 0; }
.link-btn:hover { text-decoration: underline; }

/* Scroll container */
.list-scroll {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-1) 0;
  scrollbar-width: thin;
  scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-bg);
}
.list-scroll::-webkit-scrollbar { width: 6px; }
.list-scroll::-webkit-scrollbar-track { background: var(--scrollbar-bg); }
.list-scroll::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 3px; }

/* Row */
.memory-row {
  display: block;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  border-left: 3px solid transparent;
  padding: var(--space-2) var(--space-3);
  cursor: pointer;
  transition: background 0.1s;
  min-height: 52px;
}
.memory-row:hover { background: var(--bg-hover); }
.memory-row.selected {
  background: var(--bg-tertiary);
  border-left-color: var(--accent);
}
.memory-row.selected .row-name { color: var(--accent); }

/* Row layout */
.row-main {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--space-2);
  margin-bottom: 2px;
}
.row-name {
  font-size: var(--text-sm);
  font-weight: var(--fw-semi);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}
.row-name.deleted { text-decoration: line-through; color: var(--text-muted); }
.row-time {
  font-size: var(--text-2xs);
  color: var(--text-muted);
  flex-shrink: 0;
  white-space: nowrap;
}

.row-sub {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
}
.row-desc {
  font-size: var(--text-xs);
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

/* Badges */
.row-badges { display: flex; gap: var(--space-1); flex-shrink: 0; }
.badge {
  font-size: var(--text-2xs);
  padding: 1px 5px;
  border-radius: var(--radius-pill);
  white-space: nowrap;
  font-weight: var(--fw-medium);
}
.badge-scope { background: var(--accent-soft); color: var(--accent); }
.badge-source { background: var(--success-soft); color: var(--success); }
.badge-deleted { background: var(--danger-soft); color: var(--danger); }

/* Tail / loading */
.tail-sentinel { height: 1px; }
.loading-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  color: var(--text-muted);
  font-size: var(--text-xs);
}
.spinner {
  display: inline-block;
  width: 10px; height: 10px;
  border: 1.5px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  flex-shrink: 0;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* Empty state */
.empty {
  padding: var(--space-6) var(--space-4);
  text-align: center;
  color: var(--text-muted);
}
.empty-title { font-size: var(--text-md); font-weight: var(--fw-semi); margin: 0 0 var(--space-1); }
.empty-hint { font-size: var(--text-xs); margin: 0; }
.empty-hint code {
  background: var(--code-bg-inline);
  padding: 1px 4px;
  border-radius: 3px;
  font-family: var(--font-mono);
}
</style>
