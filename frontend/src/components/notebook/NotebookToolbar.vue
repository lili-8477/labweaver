<script setup lang="ts">
import { computed, ref } from 'vue'
import { useNotebookStore } from '@/stores/notebook'

const nb = useNotebookStore()
const menuOpen = ref(false)

// Jupyter's toolbar, one icon per action. Paths are 24×24 strokes.
const ICONS = {
  add: 'M12 5v14M5 12h14',
  cut: 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  paste: 'M9 4h6v3H9zM8 5H6a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2',
  up: 'M12 19V5M5 12l7-7 7 7',
  down: 'M12 5v14M19 12l-7 7-7-7',
  run: 'M7 4v16l13-8z',
  stop: 'M6 6h12v12H6z',
  restart: 'M3 12a9 9 0 1 0 2.64-6.36M3 4v5h5',
  restartRun: 'M4 5v14l8-7zM12 5v14l8-7z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
}

// What runs this notebook, from its metadata: "R 4.5.3", "Python 3".
const kernelLabel = computed(() => {
  const meta = (nb.notebook?.metadata ?? {}) as {
    kernelspec?: { display_name?: string; name?: string }
    language_info?: { name?: string; version?: string }
  }
  const name = meta.kernelspec?.display_name || meta.kernelspec?.name || 'Python 3'
  const version = meta.language_info?.version
  return version && !name.includes(version) ? `${name} ${version}` : name
})
const kernelSpecName = computed(
  () => ((nb.notebook?.metadata as { kernelspec?: { name?: string } })?.kernelspec?.name) || 'python3',
)

const statusLabel = computed(() => {
  switch (nb.kernelStatus) {
    case 'busy': return 'Busy'
    case 'idle': return 'Idle'
    case 'starting': return 'Starting'
    case 'dead': return 'Dead'
    // The kernel starts on the first run; until then it is simply not running.
    default: return 'Not started'
  }
})

async function confirmRestart() {
  if (window.confirm('Restart the kernel? All variables will be lost.')) await nb.restartKernel()
}
async function confirmRestartRunAll() {
  if (window.confirm('Restart the kernel and run every cell? All variables will be lost.')) {
    await nb.restartAndRunAll()
  }
}
function fromMenu(action: () => unknown) {
  menuOpen.value = false
  void action()
}
</script>

<template>
  <div class="nb-toolbar" v-if="nb.notebook">
    <div class="group">
      <button class="tb-btn" title="Insert cell below (b)" @click="nb.insertCell('below', 'code')">
        <svg viewBox="0 0 24 24"><path :d="ICONS.add" /></svg>
      </button>
    </div>

    <div class="group">
      <button class="tb-btn" :disabled="!nb.selectedCellId" title="Cut cell (x)" @click="nb.selectedCellId && nb.cutCell(nb.selectedCellId)">
        <svg viewBox="0 0 24 24"><path :d="ICONS.cut" /></svg>
      </button>
      <button class="tb-btn" :disabled="!nb.selectedCellId" title="Copy cell (c)" @click="nb.selectedCellId && nb.copyCell(nb.selectedCellId)">
        <svg viewBox="0 0 24 24"><path :d="ICONS.copy" /></svg>
      </button>
      <button class="tb-btn" :disabled="!nb.clipboard" title="Paste cell below (v)" @click="nb.pasteCell()">
        <svg viewBox="0 0 24 24"><path :d="ICONS.paste" /></svg>
      </button>
    </div>

    <div class="group">
      <button
        class="tb-btn"
        :disabled="!nb.selectedCellId || nb.cells[0]?.id === nb.selectedCellId"
        title="Move cell up"
        @click="nb.selectedCellId && nb.moveCell(nb.selectedCellId, 'up')"
      ><svg viewBox="0 0 24 24"><path :d="ICONS.up" /></svg></button>
      <button
        class="tb-btn"
        :disabled="!nb.selectedCellId || nb.cells[nb.cells.length - 1]?.id === nb.selectedCellId"
        title="Move cell down"
        @click="nb.selectedCellId && nb.moveCell(nb.selectedCellId, 'down')"
      ><svg viewBox="0 0 24 24"><path :d="ICONS.down" /></svg></button>
    </div>

    <div class="group">
      <button
        class="tb-btn run"
        :disabled="!nb.selectedCellId"
        title="Run this cell and select the next (Shift+Enter)"
        @click="nb.selectedCellId && nb.runAndAdvance(nb.selectedCellId)"
      ><svg viewBox="0 0 24 24"><path :d="ICONS.run" /></svg><span>Run</span></button>
      <button class="tb-btn" :disabled="!nb.isBusy" title="Interrupt the kernel" @click="nb.interruptKernel()">
        <svg viewBox="0 0 24 24"><path :d="ICONS.stop" /></svg>
      </button>
      <button class="tb-btn" title="Restart the kernel" @click="confirmRestart">
        <svg viewBox="0 0 24 24"><path :d="ICONS.restart" /></svg>
      </button>
      <button class="tb-btn" :disabled="nb.isBusy" title="Restart the kernel and run all cells" @click="confirmRestartRunAll">
        <svg viewBox="0 0 24 24"><path :d="ICONS.restartRun" /></svg>
      </button>
    </div>

    <select
      class="tb-select"
      :disabled="!nb.selectedCell"
      :value="nb.selectedCell?.cell_type || 'code'"
      title="Cell type (y code, m markdown)"
      @change="(e) => nb.selectedCellId && nb.changeCellType(nb.selectedCellId, (e.target as HTMLSelectElement).value as 'code' | 'markdown')"
    >
      <option value="code">Code</option>
      <option value="markdown">Markdown</option>
      <option value="raw">Raw</option>
    </select>

    <div class="more">
      <button class="tb-btn" :class="{ active: menuOpen }" title="More actions" @click="menuOpen = !menuOpen">
        <svg viewBox="0 0 24 24" class="dots"><path :d="ICONS.more" /></svg>
      </button>
      <template v-if="menuOpen">
        <div class="menu-backdrop" @click="menuOpen = false" />
        <div class="menu" role="menu">
          <button :disabled="nb.isBusy" @click="fromMenu(nb.runAll)">Run all cells</button>
          <button :disabled="nb.isBusy || !nb.selectedCellId" @click="fromMenu(nb.runBelow)">Run selected and below</button>
          <hr>
          <button @click="fromMenu(() => nb.insertCell('below', 'markdown'))">Insert markdown cell below</button>
          <hr>
          <button :disabled="!nb.selectedCellId" @click="fromMenu(() => nb.selectedCellId && nb.clearCellOutputs(nb.selectedCellId))">Clear cell output</button>
          <button @click="fromMenu(nb.clearAllOutputs)">Clear all outputs</button>
        </div>
      </template>
    </div>

    <div
      class="kernel"
      :title="`Kernel: ${kernelLabel} (${kernelSpecName}) · ${statusLabel}${nb.lastExecutionError ? ' · last run failed' : ''}`"
    >
      <span v-if="nb.saving" class="saving">Saving…</span>
      <span class="kernel-name">{{ kernelLabel }}</span>
      <span class="kernel-dot" :class="nb.kernelStatus" />
      <span class="status-text">{{ statusLabel }}</span>
    </div>
  </div>
</template>

<style scoped>
.nb-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 2px;
  padding: 5px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
  position: sticky;
  top: 0;
  z-index: 5;
}
.group {
  display: flex;
  align-items: center;
  gap: 1px;
  padding-right: 5px;
  margin-right: 4px;
  border-right: 1px solid var(--border);
}
.tb-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 26px;
  min-width: 26px;
  padding: 0 5px;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: var(--radius);
  color: var(--text-secondary);
  font-size: 0.8em;
}
.tb-btn svg {
  width: 15px;
  height: 15px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.tb-btn svg.dots { stroke-width: 3; }
.tb-btn:hover:not(:disabled), .tb-btn.active { background: var(--bg-tertiary); color: var(--text-primary); }
.tb-btn:disabled { opacity: 0.35; cursor: not-allowed; }
.tb-btn.run { color: var(--accent); padding-right: 8px; }
.tb-btn.run svg { fill: currentColor; stroke-width: 1.5; }

.tb-select {
  height: 26px;
  padding: 0 6px;
  margin-right: 2px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border);
  color: var(--text-primary);
  border-radius: var(--radius);
  font-size: 0.8em;
}

.more { position: relative; }
.menu-backdrop { position: fixed; inset: 0; z-index: 30; }
.menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 31;
  min-width: 210px;
  padding: 4px;
  background: var(--bg-elevated);
  -webkit-backdrop-filter: var(--glass-filter);
  backdrop-filter: var(--glass-filter);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.35);
}
.menu button {
  display: block;
  width: 100%;
  padding: 6px 10px;
  background: transparent;
  border: none;
  border-radius: var(--radius);
  color: var(--text-primary);
  text-align: left;
  font-size: 0.82em;
}
.menu button:hover:not(:disabled) { background: var(--bg-tertiary); }
.menu button:disabled { opacity: 0.4; }
.menu hr { border: none; border-top: 1px solid var(--border); margin: 4px 2px; }

.kernel {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 6px;
  padding-left: 8px;
  font-size: 0.78em;
  color: var(--text-muted);
  white-space: nowrap;
}
.kernel-name { color: var(--text-primary); font-weight: var(--fw-semi); }
.kernel-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  border: 1.5px solid var(--text-muted);
  transition: background 0.2s, border-color 0.2s;
}
/* Jupyter's convention: hollow when idle, filled when busy. */
.kernel-dot.idle { border-color: var(--success); }
.kernel-dot.busy { border-color: var(--warning); background: var(--warning); }
.kernel-dot.starting { border-color: var(--accent); animation: pulse 1.2s ease-in-out infinite; }
.kernel-dot.dead { border-color: var(--danger); background: var(--danger); }
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
.saving { color: var(--accent); font-style: italic; }
</style>
