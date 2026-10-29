<script setup lang="ts">
/**
 * MemoryTree — scope group (User, each Project, Org) → directory → memory.
 * Renders store.tree as loaded by MemoryPanel; clicking a memory selects it
 * into MemoryDetail exactly as MemoryList does. `filter` narrows memories by
 * name/description and opens every directory with a match.
 */
import { computed, ref } from 'vue'
import { useMemoryStore } from '@/stores/memory'
import { basenameOf } from '@/utils/path'
import { formatDate } from '@/utils/format'
import type { TreeDir, TreeMemory } from '@/types'

const props = defineProps<{ filter: string }>()
const store = useMemoryStore()

interface DirNode { key: string; dir: TreeDir; memories: TreeMemory[]; more: number }
interface Group { key: string; label: string; title: string; total: number; dirs: DirNode[] }

const query = computed(() => props.filter.trim().toLowerCase())

// The payload is already ordered user → each project → org, so a group is a
// run of consecutive directories sharing (scope, project_dir).
const groups = computed<Group[]>(() => {
  const tree = store.tree
  if (!tree) return []
  const q = query.value
  const out: Group[] = []
  for (const d of tree.dirs) {
    const memories = q
      ? d.memories.filter(m => `${m.name}\n${m.description}`.toLowerCase().includes(q))
      : d.memories
    if (q && memories.length === 0) continue
    const key = d.scope === 'project' ? `project:${d.project_dir}` : d.scope
    let g = out[out.length - 1]
    if (g?.key !== key) {
      g = d.scope === 'project'
        ? { key, label: basenameOf(d.project_dir ?? ''), title: d.project_dir ?? '', total: 0, dirs: [] }
        : { key, label: d.scope === 'user' ? 'User' : 'Org', title: '', total: 0, dirs: [] }
      out.push(g)
    }
    const listed = d.entry_count + (store.filters.include_deleted ? d.deleted_count : 0)
    g.dirs.push({ key: `${key}/${d.dir_key}`, dir: d, memories, more: Math.max(0, listed - d.memories.length) })
    g.total += d.entry_count
  }
  return out
})

const collapsedGroups = ref(new Set<string>())
const openDirs = ref(new Set<string>())
const toggle = (set: Set<string>, key: string) => (set.has(key) ? set.delete(key) : set.add(key))
const isOpen = (n: DirNode) => n.memories.length > 0 && (!!query.value || openDirs.value.has(n.key))
</script>

<template>
  <div class="memory-tree">
    <div v-if="store.error" class="error-banner" role="alert">
      <span class="error-msg">{{ store.error }}</span>
      <button class="link-btn" @click="store.loadTree()">Retry</button>
    </div>

    <div class="tree-scroll" role="tree" aria-label="Memory tree">
      <div v-if="store.treeLoading && !store.tree" class="loading-row">
        <span class="spinner" />
        <span>Loading…</span>
      </div>
      <div v-else-if="store.tree && groups.length === 0" class="empty">
        <p class="empty-title">{{ query ? 'No matching memories' : 'No memories yet' }}</p>
      </div>

      <div
        v-for="g in groups"
        :key="g.key"
        role="treeitem"
        :aria-expanded="!collapsedGroups.has(g.key)"
      >
        <button class="group-row" :title="g.title" @click="toggle(collapsedGroups, g.key)">
          <span class="caret" :class="{ open: !collapsedGroups.has(g.key) }">▸</span>
          <span class="group-name" :class="{ folder: !!g.title }">{{ g.label }}</span>
          <span v-if="g.title" class="group-kind">project</span>
          <span class="count">{{ g.total }}</span>
        </button>

        <div v-if="!collapsedGroups.has(g.key)" class="children" role="group">
          <div v-for="n in g.dirs" :key="n.key" role="treeitem" :aria-expanded="isOpen(n)">
            <button
              class="dir-row"
              :class="{ empty: n.memories.length === 0 }"
              :disabled="n.memories.length === 0"
              @click="toggle(openDirs, n.key)"
            >
              <div class="row-main">
                <span class="caret" :class="{ open: isOpen(n), hidden: n.memories.length === 0 }">▸</span>
                <span class="dir-key">{{ n.dir.dir_key }}</span>
                <span
                  v-if="n.dir.over_cap"
                  class="badge badge-cap"
                  :title="`${n.dir.entry_count} live entries; cap is ${store.tree?.cap}`"
                >over cap</span>
                <span class="count">{{ n.dir.entry_count }}</span>
              </div>
              <div class="dir-l0" :title="n.dir.l0">{{ n.dir.l0 }}</div>
            </button>

            <ul v-if="isOpen(n)" class="leaves" role="group">
              <li v-for="m in n.memories" :key="m.memory_id" role="treeitem">
                <button
                  class="leaf-row"
                  :class="{ selected: store.selected?.memory_id === m.memory_id, deleted: m.deleted_at !== null }"
                  @click="store.select(m.memory_id)"
                >
                  <div class="row-main">
                    <span class="leaf-name">{{ m.name }}</span>
                    <span class="badge badge-source">{{ m.source === 'distilled' ? 'distilled' : 'manual' }}</span>
                    <span v-if="m.deleted_at !== null" class="badge badge-deleted">deleted</span>
                    <span class="hits" :title="m.last_hit_at ? `Last hit ${new Date(m.last_hit_at).toLocaleString()}` : 'Never hit'">
                      {{ m.hit_count }} {{ m.hit_count === 1 ? 'hit' : 'hits' }}<template v-if="m.last_hit_at"> · {{ formatDate(m.last_hit_at) }}</template>
                    </span>
                  </div>
                  <div class="leaf-desc" :title="m.description">{{ m.description }}</div>
                </button>
              </li>
              <li v-if="n.more > 0" class="more">+{{ n.more }} more</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.memory-tree { display: flex; flex-direction: column; height: 100%; overflow: hidden; }

/* Error / loading / empty — same look as MemoryList */
.error-banner {
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: color-mix(in srgb, var(--danger) 12%, var(--bg-secondary));
  border-bottom: 1px solid var(--border); font-size: var(--text-xs); color: var(--danger); flex-shrink: 0;
}
.error-msg { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.link-btn { background: none; border: none; padding: 0; color: var(--accent); cursor: pointer; font-size: inherit; flex-shrink: 0; }
.link-btn:hover { text-decoration: underline; }
.loading-row {
  display: flex; align-items: center; gap: var(--space-2);
  padding: var(--space-2) var(--space-3); color: var(--text-muted); font-size: var(--text-xs);
}
.spinner {
  display: inline-block; width: 10px; height: 10px; flex-shrink: 0;
  border: 1.5px solid var(--border); border-top-color: var(--accent); border-radius: 50%;
  animation: spin 0.6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.empty { padding: var(--space-6) var(--space-4); text-align: center; color: var(--text-muted); }
.empty-title { font-size: var(--text-md); font-weight: var(--fw-semi); margin: 0; }

.tree-scroll {
  flex: 1; overflow-y: auto; padding: var(--space-1) var(--space-2) var(--space-3);
  scrollbar-width: thin; scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-bg);
}
.tree-scroll::-webkit-scrollbar { width: 6px; }
.tree-scroll::-webkit-scrollbar-track { background: var(--scrollbar-bg); }
.tree-scroll::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 3px; }

.group-row, .dir-row, .leaf-row {
  display: block; width: 100%; text-align: left; background: none; border: none;
  border-radius: var(--radius); cursor: pointer; color: var(--text-primary);
  transition: background 0.1s;
}
.group-row { display: flex; align-items: center; gap: var(--space-2); padding: 6px var(--space-2); }
.group-row:hover, .dir-row:hover:not(:disabled), .leaf-row:hover { background: var(--bg-hover); }
.group-name {
  font-size: var(--text-xs); font-weight: var(--fw-semi); text-transform: uppercase;
  letter-spacing: 0.06em; color: var(--text-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
}
.group-name.folder { text-transform: none; letter-spacing: 0; }
.group-kind { font-size: var(--text-2xs); color: var(--text-muted); }
.count {
  margin-left: auto; flex-shrink: 0; font-size: var(--text-2xs);
  color: var(--text-muted); font-variant-numeric: tabular-nums;
}

.caret { display: inline-block; width: 10px; flex-shrink: 0; font-size: 9px; color: var(--text-muted); transition: transform 0.12s; }
.caret.open { transform: rotate(90deg); }
.caret.hidden { visibility: hidden; }

/* Guide line per nesting level */
.children { margin-left: 13px; padding-left: var(--space-2); border-left: 1px solid var(--border-soft); }
.leaves {
  list-style: none; margin: 0 0 var(--space-1) 13px; padding: 0 0 0 var(--space-2);
  border-left: 1px solid var(--border-soft);
}

.row-main { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }

.dir-row { padding: 4px var(--space-2); }
.dir-row.empty { cursor: default; }
.dir-row.empty .dir-key, .dir-row.empty .dir-l0 { color: var(--text-muted); }
.dir-key {
  font-family: var(--font-mono); font-size: var(--text-xs); color: var(--text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0;
}
.dir-l0 {
  margin-left: calc(10px + var(--space-2)); font-size: var(--text-2xs); color: var(--text-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.leaf-row { padding: 3px var(--space-2); border-left: 3px solid transparent; }
.leaf-row.selected { background: var(--bg-tertiary); border-left-color: var(--accent); }
.leaf-row.selected .leaf-name { color: var(--accent); }
.leaf-row.deleted { opacity: 0.5; }
.leaf-row.deleted .leaf-name { text-decoration: line-through; }
.leaf-name {
  flex: 1; min-width: 0; font-size: var(--text-sm); font-weight: var(--fw-semi);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.leaf-desc {
  font-size: var(--text-xs); color: var(--text-secondary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.hits { flex-shrink: 0; font-size: var(--text-2xs); color: var(--text-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.more { padding: 2px var(--space-2); font-size: var(--text-2xs); color: var(--text-muted); }

.badge {
  flex-shrink: 0; font-size: var(--text-2xs); padding: 1px 5px; border-radius: var(--radius-pill);
  white-space: nowrap; font-weight: var(--fw-medium);
}
.badge-source { background: var(--success-soft); color: var(--success); }
.badge-deleted { background: var(--danger-soft); color: var(--danger); }
.badge-cap { background: var(--warning-soft); color: var(--warning); }
</style>
