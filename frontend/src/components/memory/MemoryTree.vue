<script setup lang="ts">
/**
 * MemoryTree — scope → directory → memory as an indented tree with per-row
 * stats (count, weekly growth, task outcomes, last change). With an active
 * topic it shows only that topic's memories. Clicking a memory selects it.
 */
import { computed, ref } from 'vue'
import { useMemoryStore } from '@/stores/memory'
import { buildScopes, type DirNode } from '@/utils/memory-tree'
import type { MemoryTree } from '@/types'

const props = defineProps<{ tree: MemoryTree; activeTopic: string | null }>()
const store = useMemoryStore()

const topicIds = computed(() => {
  const t = props.tree.topics.find(x => x.topic === props.activeTopic)
  return t ? new Set(t.memory_ids) : undefined
})

const scopes = computed(() => buildScopes(props.tree, topicIds.value))

// ── Expansion ─────────────────────────────────────────────────────────────────
const collapsedScopes = ref(new Set<string>())
const openDirs = ref(new Set<string>())
const toggle = (set: Set<string>, key: string) => (set.has(key) ? set.delete(key) : set.add(key))
// A topic filter opens every directory it touches.
const isOpen = (d: DirNode) => openDirs.value.has(d.dir_key) || (!!topicIds.value && d.leaves.length > 0)

const maxUses = computed(() => Math.max(1, ...scopes.value.flatMap(s => s.dirs.map(d => d.success + d.failure))))
const maxWeekly = computed(() => Math.max(1, ...scopes.value.flatMap(s => s.dirs.flatMap(d => d.weekly))))

function relTime(iso: string | null): string {
  if (!iso) return ''
  const day = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (day < 1) return 'today'
  if (day < 30) return `${day}d`
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(iso))
}
</script>

<template>
  <div class="tree" role="tree" aria-label="Memory tree">
    <div v-for="s in scopes" :key="s.scope" class="scope" role="treeitem" :aria-expanded="!collapsedScopes.has(s.scope)">
      <button class="scope-row" @click="toggle(collapsedScopes, s.scope)">
        <span class="caret" :class="{ open: !collapsedScopes.has(s.scope) }">▸</span>
        <span class="scope-name">{{ s.label }}</span>
        <span class="scope-total">{{ s.total }}</span>
      </button>

      <div v-if="!collapsedScopes.has(s.scope)" class="children" role="group">
        <div v-for="d in s.dirs" :key="d.dir_key" role="treeitem" :aria-expanded="isOpen(d)">
          <button
            class="dir-row"
            :class="{ empty: !d.leaves.length }"
            :disabled="!d.leaves.length"
            :title="d.l0"
            @click="toggle(openDirs, d.dir_key)"
          >
            <span class="caret" :class="{ open: isOpen(d), hidden: !d.leaves.length }">▸</span>
            <span class="dir-name">{{ d.name }}</span>
            <span class="dir-count">{{ d.leaves.length }}</span>
            <span class="spark" :title="`New per week, last ${d.weekly.length} weeks: ${d.weekly.join(' ')}`">
              <span v-for="(n, i) in d.weekly" :key="i" class="spark-bar"
                    :style="{ height: n ? `${20 + (80 * n) / maxWeekly}%` : '1px' }" />
            </span>
            <span class="uses" :title="`${d.success} successful · ${d.failure} failed task uses`">
              <span class="uses-bar">
                <span class="uses-ok" :style="{ width: `${(100 * d.success) / maxUses}%` }" />
                <span class="uses-bad" :style="{ width: `${(100 * d.failure) / maxUses}%` }" />
              </span>
            </span>
            <span class="age">{{ relTime(d.updated_at) }}</span>
          </button>

          <ul v-if="isOpen(d) && d.leaves.length" class="leaves" role="group">
            <li v-for="m in d.leaves" :key="m.memory_id" role="treeitem">
              <button
                class="leaf-row"
                :class="{ selected: store.selected?.memory_id === m.memory_id }"
                :title="m.description + (m.project_dir ? `\n${m.project_dir}` : '')"
                @click="store.select(m.memory_id)"
              >
                <span class="leaf-dot" :class="{ ok: m.success_count > m.failure_count, bad: m.failure_count > m.success_count }" />
                <span class="leaf-name">{{ m.name }}</span>
                <span v-if="m.success_count || m.failure_count" class="leaf-uses">
                  <span class="ok">{{ m.success_count }}✓</span><span v-if="m.failure_count" class="bad"> {{ m.failure_count }}✗</span>
                </span>
                <span class="age">{{ relTime(m.created_at) }}</span>
              </button>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tree { padding: 0 var(--space-2) var(--space-3); }
.ok { color: var(--success); }
.bad { color: var(--danger); }

button.scope-row, button.dir-row, button.leaf-row {
  display: flex; align-items: center; gap: var(--space-2); width: 100%;
  background: none; border: none; border-radius: var(--radius);
  text-align: left; cursor: pointer; color: var(--text-primary);
}
.scope-row { padding: 6px var(--space-2); }
.scope-row:hover, .dir-row:hover:not(:disabled), .leaf-row:hover { background: var(--bg-hover); }
.scope-name { font-size: var(--text-xs); font-weight: var(--fw-semi); text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary); }
.scope-total { font-size: var(--text-2xs); color: var(--text-muted); font-variant-numeric: tabular-nums; }

.caret { display: inline-block; width: 10px; font-size: 9px; color: var(--text-muted); transition: transform 0.12s; }
.caret.open { transform: rotate(90deg); }
.caret.hidden { visibility: hidden; }

/* Guide line for each nesting level */
.children { margin-left: 13px; padding-left: var(--space-2); border-left: 1px solid var(--border-soft); }
.leaves { list-style: none; margin: 0 0 var(--space-1) 13px; padding: 0 0 0 var(--space-2); border-left: 1px solid var(--border-soft); }

.dir-row { padding: 4px var(--space-2); }
.dir-row.empty { cursor: default; }
.dir-row.empty .dir-name, .dir-row.empty .dir-count { color: var(--text-muted); }
.dir-name { flex: 1; min-width: 0; font-size: var(--text-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dir-count { width: 28px; text-align: right; font-size: var(--text-xs); font-variant-numeric: tabular-nums; color: var(--text-secondary); }

.dir-row.empty .spark, .dir-row.empty .uses { visibility: hidden; }
.spark { display: flex; align-items: flex-end; gap: 1px; width: 40px; height: 14px; flex-shrink: 0; }
.spark-bar { flex: 1; background: var(--text-muted); border-radius: 1px 1px 0 0; }
.uses { width: 56px; flex-shrink: 0; }
.uses-bar { display: flex; height: 5px; border-radius: 3px; background: var(--bg-tertiary); overflow: hidden; }
.uses-ok { background: var(--success); }
.uses-bad { background: var(--danger); }
.age { width: 40px; flex-shrink: 0; text-align: right; font-size: var(--text-2xs); color: var(--text-muted); white-space: nowrap; }

.leaf-row { padding: 3px var(--space-2); }
.leaf-row.selected { background: var(--bg-tertiary); }
.leaf-row.selected .leaf-name { color: var(--accent); }
.leaf-dot { width: 5px; height: 5px; border-radius: 50%; flex-shrink: 0; background: var(--text-muted); }
.leaf-dot.ok { background: var(--success); }
.leaf-dot.bad { background: var(--danger); }
.leaf-name { flex: 1; min-width: 0; font-size: var(--text-xs); color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.leaf-uses { font-size: var(--text-2xs); font-variant-numeric: tabular-nums; white-space: nowrap; }
</style>
