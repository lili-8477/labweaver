<script setup lang="ts">
/**
 * MemoryGraph — the memory as a force-directed knowledge graph.
 *
 * Category skeleton: scope hubs → directory nodes → memory dots (coloured by
 * scope). Network: topic diamonds (shared pipeline/tool/dataset facets) link
 * memories across categories; a ready-to-become-skill topic gets an accent
 * ring. Hover highlights a node's neighbourhood; click a memory to open it,
 * a topic to focus it (shared with the skill candidates list), a category to
 * pin its highlight. Wheel zooms, background drag pans, node drag moves.
 *
 * Node positions survive a refresh, so new memories visibly grow out of
 * their directory instead of the whole layout reshuffling.
 */
import { computed, onMounted, onUnmounted, ref, shallowRef, triggerRef, watch } from 'vue'
import {
  forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY,
  type Simulation,
} from 'd3-force'
import { useMemoryStore } from '@/stores/memory'
import { adjacency, buildGraph, topicNodeId, type GraphLink, type GraphNode } from '@/utils/memory-graph'
import type { MemoryTree } from '@/types'

const props = defineProps<{ tree: MemoryTree; activeTopic: string | null }>()
const emit = defineEmits<{ selectTopic: [topic: string | null] }>()
const store = useMemoryStore()

const HEIGHT = 380
const width = ref(400)
const rootEl = ref<HTMLElement | null>(null)

const nodes = shallowRef<GraphNode[]>([])
const links = shallowRef<GraphLink[]>([])
const adj = shallowRef(new Map<string, Set<string>>())
let sim: Simulation<GraphNode, GraphLink> | null = null

// ── Layout ────────────────────────────────────────────────────────────────────

function rebuild(tree: MemoryTree) {
  const prev = new Map(nodes.value.map(n => [n.id, n]))
  const g = buildGraph(tree)
  const byId = new Map(g.nodes.map(n => [n.id, n]))
  // Keep known positions; new nodes start next to their parent so they grow out of it.
  for (const l of g.links) {
    const parent = prev.get(l.source as string) ?? byId.get(l.source as string)
    const child = byId.get(l.target as string)!
    const old = prev.get(child.id)
    if (old) Object.assign(child, { x: old.x, y: old.y, vx: old.vx, vy: old.vy })
    else if (parent?.x !== undefined && child.x === undefined) {
      child.x = parent.x + (Math.random() - 0.5) * 20
      child.y = parent.y! + (Math.random() - 0.5) * 20
    }
  }
  nodes.value = g.nodes
  links.value = g.links
  adj.value = adjacency(g.links)

  // Each scope gets its own region (anchors evenly on a circle) so categories
  // read as clusters; topics are only weakly centred and settle between the
  // categories they connect.
  const scopes = [...new Set(g.nodes.flatMap(n => (n.kind === 'scope' ? [n.scope!] : [])))]
  const anchor = new Map(scopes.map((sc, i) => {
    const a = Math.PI + (2 * Math.PI * i) / scopes.length   // first scope on the left; the panel is wider than tall
    const R = scopes.length > 1 ? 150 : 0
    return [sc, { x: R * Math.cos(a), y: R * Math.sin(a) }]
  }))
  const pull = { scope: 0.35, dir: 0.18, memory: 0.1, topic: 0.015 }
  const ax = (n: GraphNode) => (n.scope ? anchor.get(n.scope)!.x : 0)
  const ay = (n: GraphNode) => (n.scope ? anchor.get(n.scope)!.y : 0)

  sim?.stop()
  sim = forceSimulation(g.nodes)
    .force('link', forceLink<GraphNode, GraphLink>(g.links).id(n => n.id)
      .distance(l => (l.kind === 'topic' ? 70 : (l.source as GraphNode).kind === 'scope' ? 42 : 24))
      .strength(l => (l.kind === 'topic' ? 0.15 : 0.8)))
    .force('charge', forceManyBody<GraphNode>().strength(n => (n.kind === 'memory' ? -22 : n.kind === 'topic' ? -60 : -120)))
    // Labelled nodes (everything but memories) need room for their text.
    .force('collide', forceCollide<GraphNode>(n => n.r + (n.kind === 'memory' ? 3 : 14)))
    .force('x', forceX<GraphNode>(ax).strength(n => pull[n.kind]))
    .force('y', forceY<GraphNode>(ay).strength(n => pull[n.kind]))
    .alpha(prev.size ? 0.4 : 1)
    .on('tick', () => {
      if (!userMoved) fit()
      triggerRef(nodes)
    })
  // First layout: settle off-screen so the graph doesn't open as a jumble.
  if (!prev.size) {
    sim.tick(150)
    fit()
  }
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
  const k = Math.min(2, (width.value - pad * 2) / Math.max(1, x1 - x0), (HEIGHT - pad * 2) / Math.max(1, y1 - y0))
  view.value = { k, x: width.value / 2 - ((x0 + x1) / 2) * k, y: HEIGHT / 2 - ((y0 + y1) / 2) * k }
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

let drag: { node: GraphNode | null; startX: number; startY: number; vx: number; vy: number; moved: boolean } | null = null

function onPointerDown(e: PointerEvent, node: GraphNode | null) {
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

// ── Focus & selection ─────────────────────────────────────────────────────────

const hoverId = ref<string | null>(null)
const pinnedId = ref<string | null>(null)   // clicked scope/dir

function activate(n: GraphNode | null) {
  if (!n) { pinnedId.value = null; return }
  if (n.kind === 'memory') store.select(n.id)
  else if (n.kind === 'topic') emit('selectTopic', props.activeTopic && topicNodeId(props.activeTopic) === n.id ? null : n.id.slice('topic:'.length))
  else pinnedId.value = pinnedId.value === n.id ? null : n.id
}

const nodeById = computed(() => new Map(nodes.value.map(n => [n.id, n])))

const focusId = computed(() =>
  hoverId.value
  ?? (props.activeTopic ? topicNodeId(props.activeTopic) : null)
  ?? pinnedId.value
  ?? store.selected?.memory_id
  ?? null)

// The focused node, its neighbours, and — for a category or topic — the
// directories its memories live in.
const focusSet = computed(() => {
  const id = focusId.value
  if (!id || !nodeById.value.has(id)) return null
  const set = new Set([id, ...(adj.value.get(id) ?? [])])
  if (nodeById.value.get(id)!.kind !== 'memory') {
    for (const nb of [...set]) {
      for (const up of adj.value.get(nb) ?? []) if (nodeById.value.get(up)?.kind === 'dir') set.add(up)
    }
  }
  return set
})

const dimmed = (id: string) => !!focusSet.value && !focusSet.value.has(id)
const linkLit = (l: GraphLink) =>
  !focusSet.value || (focusSet.value.has((l.source as GraphNode).id) && focusSet.value.has((l.target as GraphNode).id))

function showLabel(n: GraphNode) {
  if (n.kind !== 'memory') return true
  if (n.id === hoverId.value || n.id === store.selected?.memory_id) return true
  return view.value.k >= 1.8
}

const hovered = computed(() => (hoverId.value ? nodeById.value.get(hoverId.value) ?? null : null))

function outcomeClass(n: GraphNode) {
  if (n.success > n.failure) return 'ok'
  if (n.failure > n.success) return 'bad'
  return ''
}

const diamond = (r: number) => `M0,${-r * 1.25} L${r * 1.25},0 L0,${r * 1.25} L${-r * 1.25},0 Z`
const truncate = (s: string, n = 28) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

const counts = computed(() => ({
  memories: nodes.value.filter(n => n.kind === 'memory').length,
  topics: nodes.value.filter(n => n.kind === 'topic').length,
}))

// Declared last: the first rebuild fits the view, which needs the state above.
watch(() => props.tree, t => rebuild(t), { immediate: true })

// ── Mount ─────────────────────────────────────────────────────────────────────

let ro: ResizeObserver | null = null
onMounted(() => {
  ro = new ResizeObserver(([entry]) => {
    width.value = entry.contentRect.width || 400
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
  <div ref="rootEl" class="memory-graph" :style="{ height: HEIGHT + 'px' }">
    <p v-if="!nodes.length" class="empty">No memories yet — the graph grows as you work.</p>

    <svg
      v-else
      :width="width" :height="HEIGHT"
      role="img"
      :aria-label="`Knowledge graph of ${counts.memories} memories and ${counts.topics} topics`"
      @wheel.prevent="onWheel"
      @pointerdown="onPointerDown($event, null)"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointerleave="hoverId = null"
    >
      <g :transform="`translate(${view.x},${view.y}) scale(${view.k})`">
        <line
          v-for="(l, i) in links" :key="i"
          class="link" :class="[l.kind, { dim: !linkLit(l) }]"
          :x1="(l.source as GraphNode).x" :y1="(l.source as GraphNode).y"
          :x2="(l.target as GraphNode).x" :y2="(l.target as GraphNode).y"
          :stroke-width="1 / view.k"
        />
        <g
          v-for="n in nodes" :key="n.id"
          class="node" :class="[n.kind, n.scope ? `s-${n.scope}` : '', { dim: dimmed(n.id), ready: n.ready, selected: n.id === store.selected?.memory_id }]"
          :transform="`translate(${n.x},${n.y})`"
          @pointerdown.stop="onPointerDown($event, n)"
          @pointerenter="hoverId = n.id"
          @pointerleave="hoverId = null"
        >
          <path v-if="n.kind === 'topic'" :d="diamond(n.r)" class="shape" :stroke-width="(n.ready ? 2.2 : 1.4) / view.k" />
          <circle v-else :r="n.r" class="shape" :class="n.kind === 'memory' ? outcomeClass(n) : ''"
                  :stroke-width="(n.kind === 'memory' ? 1.4 : 2) / view.k" />
        </g>
        <!-- Labels on top so nodes never cover them -->
        <g
          v-for="n in nodes" :key="`l-${n.id}`"
          class="node-label" :class="[n.kind, { dim: dimmed(n.id), ready: n.ready }]"
          :transform="`translate(${n.x},${n.y})`"
        >
          <text
            v-if="showLabel(n)"
            class="label"
            :y="n.r + 11 / view.k"
            :font-size="(n.kind === 'scope' ? 12 : n.kind === 'memory' ? 10 : 11) / view.k"
            :stroke-width="3 / view.k"
          >{{ n.kind === 'memory' ? truncate(n.label) : n.label }}</text>
        </g>
      </g>
    </svg>

    <!-- Tooltip -->
    <div
      v-if="hovered"
      class="tip"
      :style="{
        left: Math.min(width - 220, Math.max(4, view.x + hovered.x! * view.k + 12)) + 'px',
        top: Math.min(HEIGHT - 70, view.y + hovered.y! * view.k + 12) + 'px',
      }"
    >
      <div class="tip-title">{{ hovered.label }}</div>
      <div class="tip-kind">
        {{ hovered.kind === 'topic' ? (hovered.ready ? 'topic · ready to become a skill' : 'topic') : hovered.kind }}
      </div>
      <div v-if="hovered.detail" class="tip-detail">{{ truncate(hovered.detail, 140) }}</div>
      <div v-if="hovered.kind === 'memory'" class="tip-stats">
        used {{ hovered.uses }}× · <span class="ok">{{ hovered.success }}✓</span>
        <span v-if="hovered.failure" class="bad"> {{ hovered.failure }}✗</span>
      </div>
    </div>

    <!-- Legend & controls -->
    <div v-if="nodes.length" class="legend" aria-hidden="true">
      <span><i class="dot s-project" />Project</span>
      <span><i class="dot s-org" />Org</span>
      <span><i class="dot s-user" />Mine</span>
      <span><i class="dia" />topic</span>
      <span><i class="dia ready" />skill-ready</span>
    </div>
    <button v-if="nodes.length" class="fit" title="Fit to view" aria-label="Fit graph to view" @click="resetView">⤢</button>
  </div>
</template>

<style scoped>
.memory-graph {
  --scope-project: var(--info);
  --scope-org: var(--warning);
  --scope-user: oklch(0.72 0.12 305);
  position: relative;
  overflow: hidden;
  touch-action: none;
  user-select: none;
}
svg { display: block; cursor: grab; }
svg:active { cursor: grabbing; }
.empty { margin: 0; padding: var(--space-6) var(--space-4); text-align: center; color: var(--text-muted); font-size: var(--text-sm); }

/* Links */
.link { transition: opacity 0.15s; }
.link.category { stroke: var(--text-muted); opacity: 0.4; }
.link.topic { stroke: var(--text-secondary); opacity: 0.45; stroke-dasharray: 2 3; }
.link.dim { opacity: 0.06; }

/* Nodes */
.node { cursor: pointer; transition: opacity 0.15s; }
.node.dim, .node-label.dim { opacity: 0.15; }
.node-label { pointer-events: none; transition: opacity 0.15s; }
.s-project { --c: var(--scope-project); }
.s-org     { --c: var(--scope-org); }
.s-user    { --c: var(--scope-user); }

.scope .shape { fill: color-mix(in oklch, var(--c) 18%, var(--bg-base)); stroke: var(--c); }
.dir .shape { fill: var(--c); stroke: var(--bg-base); }
.memory .shape { fill: color-mix(in oklch, var(--c) 45%, var(--bg-base)); stroke: color-mix(in oklch, var(--c) 70%, var(--bg-base)); }
.memory .shape.ok { stroke: var(--success); }
.memory .shape.bad { stroke: var(--danger); }
.memory.selected .shape { stroke: var(--accent); stroke-width: 2.5px; }
.topic .shape { fill: var(--bg-base); stroke: var(--text-secondary); }
.topic.ready .shape { fill: var(--accent-soft); stroke: var(--accent); }

.label {
  fill: var(--text-secondary);
  text-anchor: middle;
  paint-order: stroke;
  stroke: var(--bg-base);
  stroke-linejoin: round;
  pointer-events: none;
}
.scope .label { fill: var(--text-primary); font-weight: var(--fw-semi); letter-spacing: 0.04em; text-transform: uppercase; }
.dir .label { fill: var(--text-primary); }
.topic .label { font-family: var(--font-mono); }
.topic.ready .label { fill: var(--accent); font-weight: var(--fw-semi); }

/* Tooltip */
.tip {
  position: absolute; width: 210px; pointer-events: none;
  padding: var(--space-2); border-radius: var(--radius);
  background: var(--bg-elevated); border: 1px solid var(--border);
  font-size: var(--text-2xs); color: var(--text-secondary);
}
.tip-title { font-size: var(--text-xs); font-weight: var(--fw-semi); color: var(--text-primary); }
.tip-kind { color: var(--text-muted); margin-bottom: 2px; }
.tip-detail { line-height: 1.35; }
.tip-stats { margin-top: 2px; font-variant-numeric: tabular-nums; }
.ok { color: var(--success); }
.bad { color: var(--danger); }

/* Legend & fit */
.legend {
  position: absolute; left: var(--space-3); bottom: var(--space-2);
  display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-3);
  font-size: var(--text-2xs); color: var(--text-muted); pointer-events: none;
}
.legend span { display: inline-flex; align-items: center; gap: 4px; }
.dot { width: 7px; height: 7px; border-radius: 50%; background: var(--c); }
.dia { width: 7px; height: 7px; transform: rotate(45deg); border: 1.2px solid var(--text-secondary); }
.dia.ready { border-color: var(--accent); background: var(--accent-soft); }
.fit {
  position: absolute; right: var(--space-2); top: var(--space-1);
  background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius);
  color: var(--text-secondary); cursor: pointer; font-size: var(--text-sm); line-height: 1; padding: 3px 6px;
}
.fit:hover { color: var(--text-primary); }
</style>
