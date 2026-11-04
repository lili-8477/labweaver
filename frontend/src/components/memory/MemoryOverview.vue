<script setup lang="ts">
/**
 * MemoryOverview — the whole memory at a glance: headline stats, its
 * structure as a knowledge graph (or a tree), the topics ready to become
 * skills, and how it has grown. Selecting a skill candidate (or a topic node
 * in the graph) focuses the structure view on that topic's memories.
 */
import { computed, onMounted, ref } from 'vue'
import { useMemoryStore } from '@/stores/memory'
import { growthSeries, weeklyCounts } from '@/utils/memory-tree'
import MemoryGraph from './MemoryGraph.vue'
import MemoryTree from './MemoryTree.vue'
import MemorySkillCandidates from './MemorySkillCandidates.vue'

const store = useMemoryStore()
onMounted(() => store.loadTree())

const activeTopic = ref<string | null>(null)

const STRUCTURE_KEY = 'labweaver-memory-structure'
const structure = ref<'graph' | 'tree'>(
  (() => { try { return localStorage.getItem(STRUCTURE_KEY) === 'tree' ? 'tree' : 'graph' } catch { return 'graph' } })()
)
function setStructure(v: 'graph' | 'tree') {
  structure.value = v
  try { localStorage.setItem(STRUCTURE_KEY, v) } catch { /* ignore */ }
}
// ── Headline stats ────────────────────────────────────────────────────────────
const stats = computed(() => {
  const ms = store.tree?.memories ?? []
  const success = ms.reduce((n, m) => n + m.success_count, 0)
  const failure = ms.reduce((n, m) => n + m.failure_count, 0)
  return {
    total: ms.length,
    thisWeek: weeklyCounts(ms.map(m => m.created_at), 1)[0],
    used: ms.filter(m => m.hit_count > 0).length,
    rate: success + failure ? Math.round((100 * success) / (success + failure)) : null,
    ready: store.tree?.topics.filter(t => t.ready).length ?? 0,
  }
})

// ── Growth curve (cumulative count, step line) ────────────────────────────────
const W = 300, H = 48
const growth = computed(() => {
  const pts = growthSeries(store.tree?.memories ?? [])
  if (pts.length < 2) return null
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t, max = pts[pts.length - 1].n
  const x = (t: number) => (t1 === t0 ? W : ((t - t0) / (t1 - t0)) * W)
  const y = (n: number) => H - (n / max) * (H - 2)
  const line = `M0,${H}` + pts.map(p => ` H${x(p.t).toFixed(1)} V${y(p.n).toFixed(1)}`).join('')
  return { line, area: `${line} V${H} Z`, start: new Date(t0) }
})

const fmtDate = (d: Date) => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(d)
</script>

<template>
  <div class="memory-overview">
    <div v-if="store.treeLoading && !store.tree" class="state">Loading…</div>
    <div v-else-if="!store.tree" class="state">
      {{ store.error ?? 'Memory tree unavailable.' }}
      <button class="link-btn" @click="store.loadTree()">Retry</button>
    </div>

    <template v-else>
      <!-- Headline -->
      <section class="headline">
        <div class="stat">
          <span class="stat-num">{{ stats.total }}</span>
          <span class="stat-label">memories<template v-if="stats.thisWeek"> · <em>+{{ stats.thisWeek }} this week</em></template></span>
        </div>
        <div class="stat">
          <span class="stat-num">{{ stats.used }}</span>
          <span class="stat-label">used in tasks</span>
        </div>
        <div class="stat">
          <span class="stat-num">{{ stats.rate === null ? '—' : stats.rate + '%' }}</span>
          <span class="stat-label">task success</span>
        </div>
        <div class="stat">
          <span class="stat-num" :class="{ hot: stats.ready }">{{ stats.ready }}</span>
          <span class="stat-label">skill-ready</span>
        </div>
        <button class="refresh" :disabled="store.treeLoading" title="Refresh" aria-label="Refresh memory tree" @click="store.loadTree()">↻</button>
      </section>

      <!-- Structure -->
      <section class="structure">
        <header class="structure-head">
          <span v-if="activeTopic" class="topic-filter">
            Focused on <strong>{{ activeTopic }}</strong>
            <button class="link-btn" @click="activeTopic = null">Clear</button>
          </span>
          <span v-else class="structure-title">Structure</span>
          <span class="structure-toggle" role="tablist" aria-label="Structure view">
            <button v-for="v in (['graph', 'tree'] as const)" :key="v" role="tab"
                    :class="{ active: structure === v }" :aria-selected="structure === v"
                    @click="setStructure(v)">{{ v === 'graph' ? 'Graph' : 'Tree' }}</button>
          </span>
        </header>
        <MemoryGraph v-if="structure === 'graph'" :tree="store.tree" :active-topic="activeTopic" @select-topic="activeTopic = $event" />
        <MemoryTree v-else :tree="store.tree" :active-topic="activeTopic" />
      </section>

      <MemorySkillCandidates
        :topics="store.tree.topics"
        :thresholds="store.tree.thresholds"
        :active-topic="activeTopic"
        @select="activeTopic = $event"
      />

      <!-- Growth -->
      <section v-if="growth" class="growth" aria-label="Cumulative memories over time">
        <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" class="growth-svg" role="img"
             :aria-label="`${stats.total} memories since ${fmtDate(growth.start)}`">
          <path :d="growth.area" class="growth-area" />
          <path :d="growth.line" class="growth-line" vector-effect="non-scaling-stroke" />
        </svg>
        <div class="growth-axis"><span>{{ fmtDate(growth.start) }}</span><span>now</span></div>
      </section>

    </template>
  </div>
</template>

<style scoped>
.memory-overview { height: 100%; overflow-y: auto; scrollbar-width: thin; scrollbar-color: var(--scrollbar-thumb) var(--scrollbar-bg); }
.state { padding: var(--space-5) var(--space-4); text-align: center; color: var(--text-muted); font-size: var(--text-sm); }
.link-btn { background: none; border: none; padding: 0 var(--space-1); color: var(--accent); cursor: pointer; font-size: inherit; }
.link-btn:hover { text-decoration: underline; }
.ok { color: var(--success); }
.bad { color: var(--danger); }

/* ── Headline ── */
.headline { display: flex; align-items: flex-end; gap: var(--space-4); padding: var(--space-3) var(--space-3) var(--space-2); }
.stat { display: flex; flex-direction: column; min-width: 0; }
.stat-num { font-family: var(--font-display); font-size: var(--text-xl); font-weight: var(--fw-semi); line-height: 1.1; color: var(--text-primary); font-variant-numeric: tabular-nums; }
.stat-num.hot { color: var(--accent); }
.stat-label { font-size: var(--text-2xs); color: var(--text-muted); white-space: nowrap; }
.stat-label em { font-style: normal; color: var(--success); }
.refresh { margin-left: auto; align-self: flex-start; background: none; border: 1px solid var(--border); border-radius: var(--radius); color: var(--text-secondary); cursor: pointer; padding: 0 6px; font-size: var(--text-sm); }
.refresh:hover:not(:disabled) { color: var(--text-primary); border-color: var(--text-muted); }

/* ── Growth ── */
.growth { padding: 0 var(--space-3) var(--space-3); border-bottom: 1px solid var(--border-soft); }
.growth-svg { display: block; width: 100%; height: 48px; overflow: visible; }
.growth-area { fill: var(--text-secondary); opacity: 0.12; }
.growth-line { fill: none; stroke: var(--text-secondary); stroke-width: 1.5; }
.growth-axis { display: flex; justify-content: space-between; font-size: var(--text-2xs); color: var(--text-muted); margin-top: 2px; }


/* ── Structure ── */
.structure { border-bottom: 1px solid var(--border-soft); }
.structure-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); padding: var(--space-2) var(--space-3) var(--space-1); }
.structure-title { font-size: var(--text-xs); font-weight: var(--fw-semi); text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary); }
.topic-filter { font-size: var(--text-xs); color: var(--text-secondary); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.topic-filter strong { font-family: var(--font-mono); font-weight: var(--fw-medium); color: var(--text-primary); }
.structure-toggle { display: flex; gap: 2px; flex-shrink: 0; }
.structure-toggle button { background: none; border: 1px solid transparent; border-radius: var(--radius-pill); padding: 1px 8px; font-size: var(--text-2xs); color: var(--text-muted); cursor: pointer; }
.structure-toggle button:hover { color: var(--text-primary); }
.structure-toggle button.active { color: var(--text-primary); border-color: var(--border); background: var(--bg-tertiary); }
.growth { padding-top: var(--space-3); border-bottom: none; }
</style>
