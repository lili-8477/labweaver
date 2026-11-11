<script setup lang="ts">
/**
 * MemoryGraph — the user's context as a force-directed graph, after
 * OpenViking's context types: memories (circles), skills (diamonds),
 * resources (squares: project folders and the files/datasets memories cite)
 * and topic hubs (triangles: genes/tools several memories share). Edges are
 * styled by kind: facet (solid), project (dashed), mention (dotted).
 *
 * Hover highlights a node's neighbours; click a memory to open it in
 * MemoryDetail, any other node for an info card. The legend toggles each node
 * kind. Wheel zooms, background drag pans, node drag moves. Node positions
 * survive a refresh, so the layout does not reshuffle. `filter` dims nodes
 * whose label does not match.
 */
import { computed, onMounted, onUnmounted, ref, shallowRef, triggerRef, watch } from 'vue'
import {
  forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY,
  type Simulation,
} from 'd3-force'
import { useMemoryStore } from '@/stores/memory'
import { adjacency, buildSimGraph, type SimLink, type SimNode } from '@/utils/memory-context-graph'
import type { MemoryGraphNode, MemoryGraphNodeKind } from '@/types'

const props = defineProps<{ filter: string }>()
const store = useMemoryStore()

const KINDS: { kind: MemoryGraphNodeKind; label: string }[] = [
  { kind: 'memory', label: 'Memory' },
  { kind: 'skill', label: 'Skill' },
  { kind: 'resource', label: 'Resource' },
  { kind: 'topic', label: 'Topic' },
]

const width = ref(400)
const height = ref(300)
const rootEl = ref<HTMLElement | null>(null)

const nodes = shallowRef<SimNode[]>([])
const links = shallowRef<SimLink[]>([])
const adj = shallowRef(new Map<string, Set<string>>())
const hidden = ref(new Set<MemoryGraphNodeKind>())
// Last known position of every node ever laid out, hidden ones included.
const placed = new Map<string, SimNode>()
let sim: Simulation<SimNode, SimLink> | null = null

// ── Layout ────────────────────────────────────────────────────────────────────

// Skills settle left, resources right, memories and topics between them.
const ANCHOR_X: Record<MemoryGraphNodeKind, number> = { skill: -150, memory: 0, topic: 0, resource: 150 }
const PULL_X: Record<MemoryGraphNodeKind, number> = { skill: 0.1, memory: 0.04, topic: 0.03, resource: 0.1 }

function rebuild() {
  for (const n of nodes.value) placed.set(n.id, n)
  const first = placed.size === 0
  const g = store.graph ? buildSimGraph(store.graph, hidden.value) : { nodes: [], links: [] }
  const byId = new Map(g.nodes.map(n => [n.id, n]))
  for (const n of g.nodes) {
    const old = placed.get(n.id)
    if (old) Object.assign(n, { x: old.x, y: old.y, vx: old.vx, vy: old.vy })
  }
  // New nodes start next to a placed neighbour so they grow out of it.
  for (const l of g.links) {
    const [a, b] = [byId.get(l.source as string)!, byId.get(l.target as string)!]
    const [from, to] = a.x === undefined ? [b, a] : [a, b]
    if (from.x !== undefined && to.x === undefined) {
      to.x = from.x + (Math.random() - 0.5) * 20
      to.y = from.y! + (Math.random() - 0.5) * 20
    }
  }
  nodes.value = g.nodes
  links.value = g.links
  adj.value = adjacency(g.links)

  sim?.stop()
  sim = forceSimulation(g.nodes)
    .force('link', forceLink<SimNode, SimLink>(g.links).id(n => n.id)
      .distance(l => (l.kind === 'mention' ? 60 : 40))
      .strength(l => (l.kind === 'mention' ? 0.2 : 0.4)))
    .force('charge', forceManyBody<SimNode>().strength(n => (n.kind === 'memory' ? -25 : -70)))
    // Labelled nodes (everything but memories) need room for their text.
    .force('collide', forceCollide<SimNode>(n => n.r + (n.kind === 'memory' ? 2 : 8)))
    .force('x', forceX<SimNode>(n => ANCHOR_X[n.kind]).strength(n => PULL_X[n.kind]))
    .force('y', forceY<SimNode>(0).strength(0.06))
    .alpha(first ? 1 : 0.4)
    .on('tick', () => {
      if (!userMoved) fit()
      triggerRef(nodes)
    })
  // First layout: settle off-screen so the graph doesn't open as a jumble.
  if (first) {
    sim.tick(150)
    fit()
  }
}

function toggleKind(kind: MemoryGraphNodeKind) {
  const next = new Set(hidden.value)
  if (!next.delete(kind)) next.add(kind)
  hidden.value = next
  if (card.value && next.has(card.value.kind)) cardId.value = null
}

// ── View transform (pan / zoom / fit) ─────────────────────────────────────────

const view = ref({ x: 0, y: 0, k: 1 })
let userMoved = false

function fit() {
  const ns = nodes.value
  if (!ns.length) return
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const n of ns) {
    x0 = Math.min(x0, n.x! - n.r); x1 = Math.max(x1, n.x! + n.r)
    y0 = Math.min(y0, n.y! - n.r); y1 = Math.max(y1, n.y! + n.r)
  }
  const pad = 36
  const legend = 36   // the two legend rows along the bottom edge
  const h = height.value - pad * 2 - legend
  const k = Math.min(2, (width.value - pad * 2) / Math.max(1, x1 - x0), h / Math.max(1, y1 - y0))
  view.value = { k, x: width.value / 2 - ((x0 + x1) / 2) * k, y: pad + h / 2 - ((y0 + y1) / 2) * k }
}

function resetView() {
  userMoved = false
  fit()
}

function toGraph(e: PointerEvent | WheelEvent) {
  const box = rootEl.value!.getBoundingClientRect()
  const { x, y, k } = view.value
  return { sx: e.clientX - box.left, sy: e.clientY - box.top, gx: (e.clientX - box.left - x) / k, gy: (e.clientY - box.top - y) / k }
}

function onWheel(e: WheelEvent) {
  userMoved = true
  const { sx, sy, gx, gy } = toGraph(e)
  const k = Math.max(0.3, Math.min(5, view.value.k * Math.exp(-e.deltaY * 0.0015)))
  view.value = { k, x: sx - gx * k, y: sy - gy * k }
}

let drag: { node: SimNode | null; startX: number; startY: number; vx: number; vy: number; moved: boolean } | null = null

function onPointerDown(e: PointerEvent, node: SimNode | null) {
  (e.currentTarget as Element).setPointerCapture?.(e.pointerId)
  drag = { node, startX: e.clientX, startY: e.clientY, vx: view.value.x, vy: view.value.y, moved: false }
  if (node) {
    node.fx = node.x
    node.fy = node.y
  }
}

function onPointerMove(e: PointerEvent) {
  if (!drag) return
  const dx = e.clientX - drag.startX, dy = e.clientY - drag.startY
  if (!drag.moved && Math.hypot(dx, dy) < 3) return
  drag.moved = true
  userMoved = true
  if (drag.node) {
    const { gx, gy } = toGraph(e)
    drag.node.fx = gx
    drag.node.fy = gy
    sim?.alphaTarget(0.25).restart()
  } else {
    view.value = { ...view.value, x: drag.vx + dx, y: drag.vy + dy }
  }
}

function onPointerUp() {
  if (!drag) return
  const { node, moved } = drag
  drag = null
  if (node) {
    node.fx = null
    node.fy = null
    sim?.alphaTarget(0)
  }
  if (!moved) activate(node)
}

// ── Focus, selection & info card ──────────────────────────────────────────────

const hoverId = ref<string | null>(null)
const cardId = ref<string | null>(null)   // clicked skill / resource / topic

function activate(n: SimNode | null) {
  if (n?.kind === 'memory') {
    cardId.value = null
    store.select(n.id)
  } else {
    cardId.value = n && cardId.value !== n.id ? n.id : null
  }
}

const nodeById = computed(() => new Map(nodes.value.map(n => [n.id, n])))
const query = computed(() => props.filter.trim().toLowerCase())

const matches = (n: SimNode) => !!query.value && n.label.toLowerCase().includes(query.value)

// Lit nodes: the hovered or carded node and its neighbours, else the filter
// matches, else the selected memory and its neighbours.
const focusSet = computed(() => {
  const neighbourhood = (id: string | null | undefined) =>
    id && nodeById.value.has(id) ? new Set([id, ...(adj.value.get(id) ?? [])]) : null
  return neighbourhood(hoverId.value ?? cardId.value)
    ?? (query.value ? new Set(nodes.value.filter(matches).map(n => n.id)) : null)
    ?? neighbourhood(store.selected?.memory_id)
})

const dimmed = (id: string) => !!focusSet.value && !focusSet.value.has(id)
const linkLit = (l: SimLink) =>
  !focusSet.value || (focusSet.value.has((l.source as SimNode).id) && focusSet.value.has((l.target as SimNode).id))

function showLabel(n: SimNode) {
  if (n.id === hoverId.value || n.id === cardId.value || n.id === store.selected?.memory_id || matches(n)) return true
  if (n.kind === 'memory' || (n.kind === 'resource' && n.type !== 'project')) return view.value.k >= 1.8
  return true
}

const hovered = computed(() => (hoverId.value ? nodeById.value.get(hoverId.value) ?? null : null))

// The card reads the full payload so counts include hidden kinds.
const card = computed<MemoryGraphNode | null>(() =>
  (cardId.value && store.graph?.nodes.find(n => n.id === cardId.value)) || null)
const cardMemories = computed(() => {
  const g = store.graph
  const id = cardId.value
  if (!g || !id) return 0
  const memoryIds = new Set(g.nodes.filter(n => n.kind === 'memory').map(n => n.id))
  const linked = new Set<string>()
  for (const e of g.edges) {
    if (e.source === id && memoryIds.has(e.target)) linked.add(e.target)
    if (e.target === id && memoryIds.has(e.source)) linked.add(e.source)
  }
  return linked.size
})

function kindLine(n: MemoryGraphNode): string {
  switch (n.kind) {
    case 'memory': return `memory · ${n.scope === 'user' ? 'mine' : n.scope} · ${n.dir_key}${n.deleted ? ' · deleted' : ''}`
    case 'skill': return `skill · ${n.scope === 'org' ? 'org' : 'mine'}`
    case 'resource': return `resource · ${n.type}`
    case 'topic': return `topic · ${n.facet}`
  }
}

const shapePath: Record<Exclude<MemoryGraphNodeKind, 'memory'>, (r: number) => string> = {
  skill: r => `M0,${-r * 1.3} L${r * 1.3},0 L0,${r * 1.3} L${-r * 1.3},0 Z`,
  resource: r => `M${-r},${-r} H${r} V${r} H${-r} Z`,
  topic: r => `M0,${-r * 1.25} L${r * 1.1},${r * 0.75} L${-r * 1.1},${r * 0.75} Z`,
}
const truncate = (s: string, n = 28) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

const counts = computed(() => {
  const c: Record<MemoryGraphNodeKind, number> = { memory: 0, skill: 0, resource: 0, topic: 0 }
  for (const n of store.graph?.nodes ?? []) c[n.kind]++
  return c
})
const droppedTotal = computed(() => Object.values(store.graph?.dropped ?? {}).reduce((a, b) => a + b, 0))
const droppedTitle = computed(() => {
  const d = store.graph?.dropped
  if (!d) return ''
  return 'Left out by the graph size cap: ' + KINDS.filter(k => d[k.kind]).map(k => `${d[k.kind]} ${k.label.toLowerCase()}`).join(', ')
})

// Declared last: the first rebuild fits the view, which needs the state above.
watch([() => store.graph, hidden], rebuild, { immediate: true })

// ── Mount ─────────────────────────────────────────────────────────────────────

let ro: ResizeObserver | null = null
onMounted(() => {
  // Mounted on each switch to this view, so it reflects edits made in the others.
  store.loadGraph()
  ro = new ResizeObserver(([entry]) => {
    width.value = entry.contentRect.width || 400
    height.value = entry.contentRect.height || 300
    if (!userMoved) fit()
  })
  if (rootEl.value) ro.observe(rootEl.value)
})
onUnmounted(() => {
  sim?.stop()
  ro?.disconnect()
})
</script>

<template>
  <div ref="rootEl" class="memory-graph">
    <div v-if="store.error" class="error-banner" role="alert">
      <span class="error-msg">{{ store.error }}</span>
      <button class="link-btn" @click="store.loadGraph()">Retry</button>
    </div>

    <div v-if="store.graphLoading && !store.graph" class="loading-row">
      <span class="spinner" />
      <span>Loading…</span>
    </div>
    <p v-else-if="store.graph && !store.graph.nodes.length" class="empty">
      No memories, skills or projects yet — the graph grows as you work.
    </p>

    <svg
      v-if="store.graph?.nodes.length"
      :width="width" :height="height"
      role="img"
      :aria-label="`Context graph: ${counts.memory} memories, ${counts.skill} skills, ${counts.resource} resources, ${counts.topic} topics`"
      @wheel.prevent="onWheel"
      @pointerdown="onPointerDown($event, null)"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointerleave="hoverId = null"
    >
      <g :transform="`translate(${view.x},${view.y}) scale(${view.k})`">
        <line
          v-for="(l, i) in links" :key="i"
          class="link" :class="[`e-${l.kind}`, { dim: !linkLit(l) }]"
          :x1="(l.source as SimNode).x" :y1="(l.source as SimNode).y"
          :x2="(l.target as SimNode).x" :y2="(l.target as SimNode).y"
          :stroke-width="(l.kind === 'facet' ? 1 : 1.3) / view.k"
        />
        <g
          v-for="n in nodes" :key="n.id"
          class="node" :class="[`k-${n.kind}`, {
            dim: dimmed(n.id),
            project: n.kind === 'resource' && n.type === 'project',
            deleted: n.kind === 'memory' && n.deleted,
            selected: n.id === store.selected?.memory_id || n.id === cardId,
          }]"
          :transform="`translate(${n.x},${n.y})`"
          @pointerdown.stop="onPointerDown($event, n)"
          @pointerenter="hoverId = n.id"
          @pointerleave="hoverId = null"
        >
          <circle v-if="n.kind === 'memory'" :r="n.r" class="shape" :stroke-width="1.2 / view.k" />
          <path v-else :d="shapePath[n.kind](n.r)" class="shape" :stroke-width="1.5 / view.k" />
        </g>
        <!-- Labels on top so nodes never cover them -->
        <g
          v-for="n in nodes" :key="`l-${n.id}`"
          class="node-label" :class="[`k-${n.kind}`, { dim: dimmed(n.id) }]"
          :transform="`translate(${n.x},${n.y})`"
        >
          <text
            v-if="showLabel(n)"
            class="label"
            :y="n.r + 11 / view.k"
            :font-size="(n.kind === 'memory' ? 10 : 11) / view.k"
            :stroke-width="3 / view.k"
          >{{ truncate(n.label) }}</text>
        </g>
      </g>
    </svg>

    <!-- Hover tooltip -->
    <div
      v-if="hovered && hovered.id !== cardId"
      class="tip"
      :style="{
        left: Math.min(width - 220, Math.max(4, view.x + hovered.x! * view.k + 12)) + 'px',
        top: Math.min(height - 70, view.y + hovered.y! * view.k + 12) + 'px',
      }"
    >
      <div class="tip-title">{{ hovered.label }}</div>
      <div class="tip-kind">{{ kindLine(hovered) }}</div>
      <div v-if="hovered.kind === 'memory' || hovered.kind === 'skill'" class="tip-detail">{{ truncate(hovered.description, 140) }}</div>
    </div>

    <!-- Info card for a clicked skill / resource / topic -->
    <div v-if="card" class="card" :class="`k-${card.kind}`" role="dialog" :aria-label="card.label">
      <div class="card-head">
        <span class="card-title">{{ card.label }}</span>
        <button class="card-close" aria-label="Close" @click="cardId = null">×</button>
      </div>
      <div class="card-kind">{{ kindLine(card) }}</div>
      <p v-if="card.kind === 'skill' && card.description" class="card-desc">{{ card.description }}</p>
      <code v-if="card.kind === 'skill' || card.kind === 'resource'" class="card-path">{{ card.path }}</code>
      <div class="card-count">{{ cardMemories }} connected {{ cardMemories === 1 ? 'memory' : 'memories' }}</div>
    </div>

    <!-- Legend: node kinds toggle; edge kinds are a key -->
    <div v-if="store.graph?.nodes.length" class="legend">
      <button
        v-for="k in KINDS" :key="k.kind"
        class="legend-kind" :class="[`k-${k.kind}`, { off: hidden.has(k.kind) }]"
        :aria-pressed="!hidden.has(k.kind)"
        :title="hidden.has(k.kind) ? `Show ${k.label.toLowerCase()} nodes` : `Hide ${k.label.toLowerCase()} nodes`"
        @click="toggleKind(k.kind)"
      ><i class="swatch" />{{ k.label }} <span class="legend-count">{{ counts[k.kind] }}</span></button>
      <span class="legend-edges" aria-hidden="true">
        <span><i class="edge e-facet" />facet</span>
        <span><i class="edge e-project" />project</span>
        <span><i class="edge e-mention" />mention</span>
      </span>
      <span v-if="droppedTotal" class="legend-dropped" :title="droppedTitle">+{{ droppedTotal }} not shown</span>
    </div>
    <button v-if="store.graph?.nodes.length" class="fit" title="Fit to view" aria-label="Fit graph to view" @click="resetView">⤢</button>
  </div>
</template>

<style scoped>
.memory-graph {
  position: relative;
  overflow: hidden;
  touch-action: none;
  user-select: none;
  background: var(--bg-base);
}
svg { display: block; cursor: grab; }
svg:active { cursor: grabbing; }

/* Error / loading / empty — same look as MemoryTree */
.error-banner {
  position: absolute; top: 0; left: 0; right: 0; z-index: 2;
  display: flex; align-items: center; justify-content: space-between; gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: color-mix(in srgb, var(--danger) 12%, var(--bg-secondary));
  border-bottom: 1px solid var(--border); font-size: var(--text-xs); color: var(--danger);
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
.empty { margin: 0; padding: var(--space-6) var(--space-4); text-align: center; color: var(--text-muted); font-size: var(--text-sm); }

/* One colour per node kind */
.k-memory   { --c: var(--info); }
.k-skill    { --c: var(--success); }
.k-resource { --c: var(--warning); }
.k-topic    { --c: var(--text-secondary); }

/* Links, styled by kind */
.link { transition: opacity 0.15s; }
.link.e-facet   { stroke: var(--text-muted); opacity: 0.45; }
.link.e-project { stroke: var(--warning); opacity: 0.45; stroke-dasharray: 5 3; }
.link.e-mention { stroke: var(--success); opacity: 0.55; stroke-dasharray: 1.5 3; stroke-linecap: round; }
.link.dim { opacity: 0.06; }

/* Nodes */
.node { cursor: pointer; transition: opacity 0.15s; }
.node.dim, .node-label.dim { opacity: 0.15; }
.node-label { pointer-events: none; transition: opacity 0.15s; }
.node .shape { fill: color-mix(in oklch, var(--c) 45%, var(--bg-base)); stroke: var(--c); }
.node.project .shape { fill: color-mix(in oklch, var(--c) 70%, var(--bg-base)); }
.node.k-topic .shape { fill: var(--bg-base); }
.node.deleted { opacity: 0.45; }
.node.deleted .shape { stroke-dasharray: 2 2; }
.node.selected .shape { stroke: var(--accent); stroke-width: 2.5px; }

.label {
  fill: var(--text-secondary);
  text-anchor: middle;
  paint-order: stroke;
  stroke: var(--bg-base);
  stroke-linejoin: round;
}
.k-skill .label, .k-resource .label { fill: var(--text-primary); }
.k-topic .label { font-family: var(--font-mono); }

/* Tooltip & info card */
.tip, .card {
  position: absolute; width: 210px;
  padding: var(--space-2); border-radius: var(--radius);
  background: var(--bg-elevated); border: 1px solid var(--border); box-shadow: var(--shadow-md);
  font-size: var(--text-2xs); color: var(--text-secondary);
}
.tip { pointer-events: none; }
.tip-title, .card-title { font-size: var(--text-xs); font-weight: var(--fw-semi); color: var(--text-primary); overflow-wrap: anywhere; }
.tip-kind, .card-kind { color: var(--text-muted); margin-bottom: 2px; }
.tip-detail { line-height: 1.35; }

.card { left: var(--space-2); top: var(--space-2); width: 240px; z-index: 1; border-left: 3px solid var(--c); }
.card-head { display: flex; align-items: flex-start; gap: var(--space-2); }
.card-title { flex: 1; min-width: 0; }
.card-close {
  background: none; border: none; color: var(--text-muted); cursor: pointer;
  font-size: var(--text-md); line-height: 1; padding: 0 2px;
}
.card-close:hover { color: var(--text-primary); }
.card-desc {
  margin: var(--space-1) 0; line-height: 1.4;
  display: -webkit-box; -webkit-line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden;
}
.card-path {
  display: block; margin: var(--space-1) 0; padding: 2px 4px; border-radius: 4px;
  background: var(--code-bg-inline); font-family: var(--font-mono); font-size: var(--text-2xs);
  color: var(--text-primary); overflow-wrap: anywhere;
}
.card-count { color: var(--text-primary); font-variant-numeric: tabular-nums; }

/* Legend & fit */
.legend {
  position: absolute; left: var(--space-2); right: var(--space-2); bottom: var(--space-1);
  display: flex; flex-wrap: wrap; align-items: center; gap: 2px var(--space-2);
  font-size: var(--text-2xs); color: var(--text-muted); pointer-events: none;
}
.legend-kind {
  pointer-events: auto; display: inline-flex; align-items: center; gap: 4px;
  padding: 1px 6px; border-radius: var(--radius-pill); border: 1px solid transparent;
  background: color-mix(in oklch, var(--bg-base) 80%, transparent);
  color: var(--text-secondary); font-size: inherit; cursor: pointer;
}
.legend-kind:hover { border-color: var(--border); color: var(--text-primary); }
.legend-kind.off { color: var(--text-muted); text-decoration: line-through; }
.legend-kind.off .swatch { background: transparent; }
.legend-count { color: var(--text-muted); font-variant-numeric: tabular-nums; }
.swatch { width: 8px; height: 8px; border: 1.2px solid var(--c); background: color-mix(in oklch, var(--c) 45%, var(--bg-base)); }
.k-memory .swatch { border-radius: 50%; }
.k-skill .swatch { transform: rotate(45deg) scale(0.85); }
.k-topic .swatch { border: none; background: var(--c); clip-path: polygon(50% 0, 100% 100%, 0 100%); }
.legend-edges { display: inline-flex; gap: var(--space-2); }
.legend-edges span { display: inline-flex; align-items: center; gap: 4px; }
.edge { width: 14px; height: 0; border-top: 1.5px solid var(--text-muted); }
.edge.e-project { border-top-style: dashed; border-color: var(--warning); }
.edge.e-mention { border-top-style: dotted; border-color: var(--success); }
.legend-dropped { pointer-events: auto; cursor: help; }
.fit {
  position: absolute; right: var(--space-2); top: var(--space-1);
  background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius);
  color: var(--text-secondary); cursor: pointer; font-size: var(--text-sm); line-height: 1; padding: 3px 6px;
}
.fit:hover { color: var(--text-primary); }
</style>
