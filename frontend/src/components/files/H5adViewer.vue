<script setup lang="ts">
/**
 * H5adViewer — interactive panel for poking at an AnnData (.h5ad) file.
 *
 * Talks to the adapter's h5ad_* RPCs. The backend renders plots as PNGs
 * (scanpy / squidpy) and we display the resulting image; the viewer is
 * a thin control panel around those calls. No state lives on the
 * server — the AnnData cache is keyed by file path + mtime so we can
 * call freely without worrying about lifecycle.
 */
import { ref, computed, watch, onMounted } from 'vue'
import { useFileStore } from '@/stores/files'
import {
  introspectH5ad, plotH5ad,
  type H5adIntrospection, type PlotKind,
} from '@/services/h5ad'

const files = useFileStore()

type Tab = 'qc' | 'embedding' | 'spatial'

const intro = ref<H5adIntrospection | null>(null)
const introError = ref<string | null>(null)
const introLoading = ref(false)
const plotting = ref(false)
const plotError = ref<string | null>(null)
const pngB64 = ref<string | null>(null)

const tab = ref<Tab>('qc')

// Embedding controls
const basis = ref<string>('X_umap')
const colorBy = ref<string>('')        // either an obs column or a gene name
const colorSearch = ref('')
const pointSize = ref<string>('')      // empty = scanpy default

// Spatial controls
const libraryId = ref<string>('')
const showImage = ref(true)
const imgAlpha = ref<string>('1.0')
const spotSize = ref<string>('')
const spatialColor = ref<string>('')
const spatialColorSearch = ref('')

const hasSpatial = computed(() => !!intro.value?.spatial)
const hasEmbedding = computed(() => (intro.value?.embeddings.length ?? 0) > 0)

const obsNames = computed(() => intro.value?.obs_cols.map(c => c.name) ?? [])
const obsNameSet = computed(() => new Set(obsNames.value))

interface Suggestion {
  name: string
  kind: 'obs' | 'gene'
}

/**
 * Search across both obs columns and gene names (var_names). Obs cols always
 * surface first; genes follow. Prefix matches rank above substring matches.
 * Both halves capped so the dropdown stays snappy even with 50k genes.
 */
function suggestionsFor(query: string): Suggestion[] {
  if (!intro.value) return []
  const q = query.trim().toLowerCase()
  const obs = obsNames.value
  const genes = intro.value.var_names
  const obsCap = 8
  const geneCap = 22

  if (!q) {
    return [
      ...obs.slice(0, obsCap).map((name): Suggestion => ({ name, kind: 'obs' })),
      ...genes.slice(0, geneCap).map((name): Suggestion => ({ name, kind: 'gene' })),
    ]
  }

  const matchInto = (names: string[], cap: number): string[] => {
    const pre: string[] = []
    const sub: string[] = []
    for (const n of names) {
      const lo = n.toLowerCase()
      if (lo.startsWith(q)) pre.push(n)
      else if (lo.includes(q)) sub.push(n)
      if (pre.length >= cap) break
    }
    return [...pre, ...sub].slice(0, cap)
  }

  const obsHits = matchInto(obs, obsCap).map((name): Suggestion => ({ name, kind: 'obs' }))
  const geneHits = matchInto(genes, geneCap).map((name): Suggestion => ({ name, kind: 'gene' }))
  return [...obsHits, ...geneHits]
}

// Two states per combobox: "showing dropdown" (open or not) and "actively
// searching" (user has typed since opening). When the user just opens the
// dropdown, we want the default mixed view (obs + genes) so they discover
// genes are searchable — not a list filtered by the previously-committed
// value sitting in the input.
const colorSearching = ref(false)
const spatialColorSearching = ref(false)

const colorSuggestions = computed(() =>
  colorSearching.value ? suggestionsFor(colorSearch.value) : suggestionsFor(''),
)
const spatialColorSuggestions = computed(() =>
  spatialColorSearching.value ? suggestionsFor(spatialColorSearch.value) : suggestionsFor(''),
)

const colorShowDropdown = ref(false)
const spatialColorShowDropdown = ref(false)

async function loadIntrospection() {
  if (!files.openH5ad) return
  introLoading.value = true
  introError.value = null
  try {
    const data = await introspectH5ad(files.openH5ad.path)
    intro.value = data
    // Defaults: prefer UMAP > PCA > whatever's first.
    if (data.embeddings.includes('X_umap')) basis.value = 'X_umap'
    else if (data.embeddings.length > 0) basis.value = data.embeddings[0] ?? 'X_umap'
    // Default color = first categorical obs col, else first obs col.
    const firstCat = data.obs_cols.find(c => c.dtype === 'categorical')
    colorBy.value = firstCat?.name ?? data.obs_cols[0]?.name ?? ''
    colorSearch.value = colorBy.value
    spatialColor.value = colorBy.value
    spatialColorSearch.value = colorBy.value
    if (data.spatial?.library_ids?.length) {
      libraryId.value = data.spatial.library_ids[0]?.library_id ?? ''
    }
    // Pick a sensible starting tab.
    if (data.qc.has_total_counts || data.qc.has_n_genes_by_counts) tab.value = 'qc'
    else if (data.spatial) tab.value = 'spatial'
    else if (data.embeddings.length) tab.value = 'embedding'
    await runPlot()
  } catch (e) {
    introError.value = (e as Error).message ?? String(e)
  } finally {
    introLoading.value = false
  }
}

/**
 * Commit whatever's in the combobox input as the active color. Without this,
 * the user has to *click a dropdown row* — typing the gene name and hitting
 * Plot would silently keep the previous color. Empty input = no color
 * (uncolored UMAP), which is also a valid choice.
 */
function commitColorSearch() {
  colorBy.value = colorSearch.value.trim()
}
function commitSpatialColorSearch() {
  spatialColor.value = spatialColorSearch.value.trim()
}

async function runPlot() {
  if (!files.openH5ad || !intro.value) return
  plotting.value = true
  plotError.value = null
  try {
    let kind: PlotKind
    let params: Record<string, unknown> = {}
    if (tab.value === 'qc') {
      kind = 'qc'
    } else if (tab.value === 'embedding') {
      commitColorSearch()
      kind = 'embedding'
      params = {
        basis: basis.value,
        color: colorBy.value || null,
        point_size: pointSize.value ? Number(pointSize.value) : null,
      }
    } else {
      commitSpatialColorSearch()
      kind = 'spatial'
      params = {
        color: spatialColor.value || null,
        library_id: libraryId.value || null,
        img_alpha: Number(imgAlpha.value || '1.0'),
        spot_size: spotSize.value ? Number(spotSize.value) : null,
        show_image: showImage.value,
      }
    }
    const res = await plotH5ad(files.openH5ad.path, kind, params)
    pngB64.value = res.png
  } catch (e) {
    plotError.value = (e as Error).message ?? String(e)
  } finally {
    plotting.value = false
  }
}

function pickColor(name: string) {
  colorBy.value = name
  colorSearch.value = name
  colorSearching.value = false
  colorShowDropdown.value = false
  runPlot()
}

function pickSpatialColor(name: string) {
  spatialColor.value = name
  spatialColorSearch.value = name
  spatialColorSearching.value = false
  spatialColorShowDropdown.value = false
  runPlot()
}

function onColorFocus(e: FocusEvent) {
  colorSearching.value = false
  colorShowDropdown.value = true
  ;(e.target as HTMLInputElement)?.select()
}
function onSpatialColorFocus(e: FocusEvent) {
  spatialColorSearching.value = false
  spatialColorShowDropdown.value = true
  ;(e.target as HTMLInputElement)?.select()
}
function onColorInput() { colorSearching.value = true }
function onSpatialColorInput() { spatialColorSearching.value = true }

function onColorKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    colorShowDropdown.value = false
    runPlot()
  }
}
function onSpatialColorKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    spatialColorShowDropdown.value = false
    runPlot()
  }
}

// Close on blur, but delayed so a click on a dropdown row registers first
// (mousedown fires before blur; mouseup/click would otherwise be eaten).
function deferCloseColorDropdown() {
  window.setTimeout(() => { colorShowDropdown.value = false }, 150)
}
function deferCloseSpatialColorDropdown() {
  window.setTimeout(() => { spatialColorShowDropdown.value = false }, 150)
}

function close() {
  pngB64.value = null
  intro.value = null
  files.closeH5ad()
}

watch(() => files.openH5ad?.path, (p) => {
  if (p) {
    pngB64.value = null
    intro.value = null
    loadIntrospection()
  }
})

watch(tab, () => {
  if (intro.value) runPlot()
})

onMounted(() => {
  if (files.openH5ad) loadIntrospection()
})

const imgSrc = computed(() => pngB64.value ? `data:image/png;base64,${pngB64.value}` : '')
</script>

<template>
  <div class="h5ad-overlay" v-if="files.openH5ad">
    <div class="h5ad-panel">
      <div class="panel-header">
        <span class="file-path">{{ files.openH5ad.path }}</span>
        <span v-if="intro" class="shape">{{ intro.shape[0].toLocaleString() }} × {{ intro.shape[1].toLocaleString() }}</span>
        <div class="header-spacer" />
        <button class="btn-close" @click="close" aria-label="Close">&times;</button>
      </div>

      <div class="panel-body">
        <!-- Tabs -->
        <div class="tabs">
          <button
            class="tab" :class="{ active: tab === 'qc' }"
            @click="tab = 'qc'"
          >QC</button>
          <button
            class="tab" :class="{ active: tab === 'embedding' }"
            :disabled="!hasEmbedding"
            @click="tab = 'embedding'"
            :title="hasEmbedding ? '' : 'No embeddings in obsm (X_umap, X_pca, ...)'"
          >Embedding</button>
          <button
            class="tab" :class="{ active: tab === 'spatial' }"
            :disabled="!hasSpatial"
            @click="tab = 'spatial'"
            :title="hasSpatial ? '' : 'No spatial data in this file'"
          >Spatial</button>
        </div>

        <!-- Controls -->
        <div class="controls" v-if="intro">
          <template v-if="tab === 'qc'">
            <span class="control-note">Violin (n_genes, total_counts, %mt) + total_counts vs n_genes scatter.</span>
            <button class="btn-run" :disabled="plotting" @click="runPlot">Refresh</button>
          </template>

          <template v-else-if="tab === 'embedding'">
            <label class="control">
              <span>Basis</span>
              <select v-model="basis" @change="runPlot" :disabled="plotting">
                <option v-for="e in intro.embeddings" :key="e" :value="e">{{ e }}</option>
              </select>
            </label>
            <label class="control combobox">
              <span>Color by</span>
              <input
                type="text"
                v-model="colorSearch"
                @focus="onColorFocus"
                @blur="deferCloseColorDropdown"
                @input="onColorInput"
                @keydown="onColorKeydown"
                placeholder="obs column or gene name"
              />
              <div v-if="colorShowDropdown" class="dropdown">
                <button
                  v-for="s in colorSuggestions" :key="s.kind + ':' + s.name"
                  class="dropdown-row" @mousedown.prevent="pickColor(s.name)"
                >
                  <span class="tag" :class="s.kind">{{ s.kind === 'gene' ? 'gene' : 'obs' }}</span>
                  <span class="name">{{ s.name }}</span>
                </button>
                <div v-if="colorSuggestions.length === 0" class="dropdown-empty">no match</div>
              </div>
            </label>
            <label class="control narrow">
              <span>Point size</span>
              <input v-model="pointSize" type="number" min="1" step="1" placeholder="auto"
                     @change="runPlot" />
            </label>
            <button class="btn-run" :disabled="plotting" @click="runPlot">Plot</button>
          </template>

          <template v-else>
            <label v-if="(intro.spatial?.library_ids?.length ?? 0) > 1" class="control">
              <span>Library</span>
              <select v-model="libraryId" @change="runPlot" :disabled="plotting">
                <option
                  v-for="lib in intro.spatial?.library_ids ?? []" :key="lib.library_id"
                  :value="lib.library_id"
                >{{ lib.library_id }}</option>
              </select>
            </label>
            <label class="control combobox">
              <span>Color by</span>
              <input
                type="text"
                v-model="spatialColorSearch"
                @focus="onSpatialColorFocus"
                @blur="deferCloseSpatialColorDropdown"
                @input="onSpatialColorInput"
                @keydown="onSpatialColorKeydown"
                placeholder="obs column or gene name"
              />
              <div v-if="spatialColorShowDropdown" class="dropdown">
                <button
                  v-for="s in spatialColorSuggestions" :key="s.kind + ':' + s.name"
                  class="dropdown-row" @mousedown.prevent="pickSpatialColor(s.name)"
                >
                  <span class="tag" :class="s.kind">{{ s.kind === 'gene' ? 'gene' : 'obs' }}</span>
                  <span class="name">{{ s.name }}</span>
                </button>
                <div v-if="spatialColorSuggestions.length === 0" class="dropdown-empty">no match</div>
              </div>
            </label>
            <label class="control toggle">
              <input type="checkbox" v-model="showImage" @change="runPlot" />
              <span>Show image</span>
            </label>
            <label class="control narrow" v-if="showImage">
              <span>Image α</span>
              <input v-model="imgAlpha" type="number" min="0" max="1" step="0.05" @change="runPlot" />
            </label>
            <label class="control narrow">
              <span>Spot size</span>
              <input v-model="spotSize" type="number" min="1" step="1" placeholder="auto" @change="runPlot" />
            </label>
            <button class="btn-run" :disabled="plotting" @click="runPlot">Plot</button>
          </template>
        </div>

        <!-- Plot area -->
        <div class="plot-area">
          <div v-if="introLoading" class="status">Reading h5ad metadata…</div>
          <div v-else-if="introError" class="status error">
            Failed to read file: {{ introError }}
          </div>
          <template v-else>
            <div v-if="plotting" class="status overlay-status">Rendering…</div>
            <div v-if="plotError" class="status error">Plot failed: {{ plotError }}</div>
            <img v-if="imgSrc" :src="imgSrc" class="plot-img" alt="plot" />
            <div v-else-if="!plotting && !plotError" class="status muted">No plot yet.</div>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.h5ad-overlay {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(0, 0, 0, 0.6);
  display: flex; align-items: center; justify-content: center;
}
.h5ad-panel {
  width: 90vw; height: 88vh;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  display: flex; flex-direction: column; overflow: hidden;
}
.panel-header {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
}
.file-path {
  font-family: var(--font-mono); font-size: 0.85em;
  color: var(--text-secondary);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.shape {
  font-size: 0.75em; color: var(--text-muted); font-family: var(--font-mono);
  padding: 2px 8px; background: var(--bg-tertiary); border-radius: var(--radius);
}
.header-spacer { flex: 1; }
.btn-close {
  width: 30px; height: 30px; background: transparent; border: none;
  color: var(--text-secondary); font-size: 1.2em; border-radius: 4px;
}
.btn-close:hover { background: var(--bg-tertiary); color: var(--text-primary); }

.panel-body {
  flex: 1; display: flex; flex-direction: column; min-height: 0;
}

.tabs {
  display: flex; gap: 4px; padding: 8px 16px 0;
  border-bottom: 1px solid var(--border);
}
.tab {
  padding: 6px 16px;
  background: transparent;
  border: 1px solid transparent;
  border-bottom: none;
  color: var(--text-secondary);
  font-size: 0.85em;
  border-top-left-radius: var(--radius);
  border-top-right-radius: var(--radius);
  cursor: pointer;
}
.tab:hover:not(:disabled) { color: var(--text-primary); background: var(--bg-tertiary); }
.tab.active {
  background: var(--bg-primary);
  border-color: var(--border);
  color: var(--text-primary);
  position: relative; top: 1px;
}
.tab:disabled { opacity: 0.35; cursor: not-allowed; }

.controls {
  display: flex; flex-wrap: wrap; gap: 12px;
  align-items: flex-end;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
}
.control {
  display: flex; flex-direction: column; gap: 4px;
  font-size: 0.78em; color: var(--text-secondary);
  position: relative;
}
.control.narrow { width: 110px; }
.control.combobox { width: 260px; }
.control.toggle {
  flex-direction: row; align-items: center; gap: 6px;
  padding-bottom: 6px;
}
.control input[type="text"],
.control input[type="number"],
.control select {
  background: var(--bg-primary);
  border: 1px solid var(--border);
  color: var(--text-primary);
  border-radius: var(--radius);
  padding: 5px 8px; font-size: 0.95em;
  font-family: var(--font-mono);
}
.control input[type="text"]:focus,
.control input[type="number"]:focus,
.control select:focus {
  outline: none; border-color: var(--accent);
}
.dropdown {
  position: absolute; top: 100%; left: 0; right: 0; z-index: 10;
  margin-top: 2px;
  max-height: 240px; overflow-y: auto;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
}
.dropdown-row {
  display: flex; align-items: center; gap: 8px;
  width: 100%; text-align: left;
  padding: 4px 10px;
  background: transparent; border: none;
  color: var(--text-primary);
  font-family: var(--font-mono); font-size: 0.9em;
  cursor: pointer;
}
.dropdown-row:hover { background: var(--bg-tertiary); }
.dropdown-row .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dropdown-row .tag {
  flex-shrink: 0;
  font-size: 0.7em; padding: 1px 6px; border-radius: 3px;
  font-family: var(--font-sans, sans-serif);
  text-transform: uppercase; letter-spacing: 0.04em;
  background: var(--bg-tertiary);
  color: var(--text-muted);
}
.dropdown-row .tag.obs { background: rgba(96, 165, 250, 0.18); color: #93c5fd; }
.dropdown-row .tag.gene { background: rgba(74, 222, 128, 0.16); color: #86efac; }
.dropdown-empty {
  padding: 8px 10px; color: var(--text-muted); font-size: 0.85em;
}

.btn-run {
  padding: 6px 18px; background: var(--accent); color: #fff;
  border: none; border-radius: var(--radius); font-size: 0.85em;
  cursor: pointer;
}
.btn-run:disabled { opacity: 0.5; cursor: not-allowed; }

.control-note { color: var(--text-muted); font-size: 0.8em; padding-bottom: 8px; }

.plot-area {
  flex: 1; min-height: 0;
  display: flex; align-items: center; justify-content: center;
  padding: 20px;
  background: var(--bg-primary);
  position: relative;
  overflow: auto;
}
.plot-img {
  max-width: 100%; max-height: 100%;
  background: #fff;
  border-radius: var(--radius);
  box-shadow: var(--shadow-lg);
}
.status {
  color: var(--text-secondary);
  font-size: 0.9em;
  padding: 8px 14px;
  border-radius: var(--radius);
  background: var(--bg-secondary);
}
.status.muted { color: var(--text-muted); }
.status.error {
  color: #fff; background: var(--error, #c0392b);
  font-family: var(--font-mono); white-space: pre-wrap;
}
.overlay-status {
  position: absolute; top: 14px; right: 14px;
}
</style>
