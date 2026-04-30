<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { natsService } from '@/services/nats'

const props = defineProps<{
  sourcePath: string
}>()

const emit = defineEmits<{
  (e: 'pick', dir: string): void
  (e: 'close'): void
}>()

interface DirNode {
  name: string
  path: string
  children?: DirNode[]
  loading?: boolean
}

const root = ref<DirNode[]>([])
const expanded = ref<Set<string>>(new Set())
const selected = ref<string>('')
const error = ref<string | null>(null)

const sourceParent = computed(() =>
  props.sourcePath.includes('/')
    ? props.sourcePath.slice(0, props.sourcePath.lastIndexOf('/'))
    : '',
)

function isAncestorOrSelf(maybeAncestor: string, descendant: string): boolean {
  if (maybeAncestor === descendant) return true
  return descendant.startsWith(maybeAncestor + '/')
}

async function loadDir(parentPath: string): Promise<DirNode[]> {
  const result = await natsService.proxyToolset('list_files', {
    sub_dir: parentPath || null,
    recursive: false,
  }, 'file_manager') as { success: boolean; files: Array<{ name: string; type: string }> }
  if (!result?.success || !Array.isArray(result.files)) return []
  return result.files
    .filter(f => f.type === 'directory' && f.name !== '.executor')
    .map(f => ({
      name: f.name,
      path: parentPath ? `${parentPath}/${f.name}` : f.name,
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

onMounted(async () => {
  root.value = await loadDir('')
})

async function toggle(node: DirNode) {
  if (expanded.value.has(node.path)) {
    expanded.value.delete(node.path)
    expanded.value = new Set(expanded.value)
    return
  }
  expanded.value.add(node.path)
  expanded.value = new Set(expanded.value)
  if (node.children === undefined) {
    node.loading = true
    node.children = await loadDir(node.path)
    node.loading = false
  }
}

function pickDir(node: DirNode) {
  selected.value = node.path
}
function pickRoot() {
  selected.value = ''
}

const moveDisabled = computed(() => {
  if (selected.value === sourceParent.value) return true
  if (isAncestorOrSelf(props.sourcePath, selected.value)) return true
  return false
})

function confirm() {
  if (moveDisabled.value) {
    error.value = 'Cannot move into the same folder, into the file itself, or into a descendant.'
    return
  }
  emit('pick', selected.value)
}

function flatten(nodes: DirNode[], depth: number, out: { node: DirNode; depth: number }[]) {
  for (const n of nodes) {
    out.push({ node: n, depth })
    if (expanded.value.has(n.path) && n.children) flatten(n.children, depth + 1, out)
  }
}
const visible = computed(() => {
  const out: { node: DirNode; depth: number }[] = []
  flatten(root.value, 0, out)
  return out
})
</script>

<template>
  <div class="modal-backdrop" @click.self="emit('close')">
    <div class="modal" role="dialog" aria-label="Move to folder">
      <div class="modal-header">Move <strong>{{ sourcePath }}</strong> to&hellip;</div>
      <div class="modal-body">
        <div
          class="dir-row"
          :class="{ selected: selected === '' }"
          @click="pickRoot()"
        >
          <span class="icon">&#128193;</span>
          <span class="name">/ (workspace root)</span>
        </div>
        <div
          v-for="{ node, depth } in visible"
          :key="node.path"
          class="dir-row"
          :class="{ selected: selected === node.path }"
          :style="{ paddingLeft: (12 + depth * 16) + 'px' }"
          @click="pickDir(node)"
        >
          <span class="caret" @click.stop="toggle(node)">
            <span v-if="node.loading" class="spinner"></span>
            <template v-else>{{ expanded.has(node.path) ? '&#9660;' : '&#9654;' }}</template>
          </span>
          <span class="icon">&#128193;</span>
          <span class="name">{{ node.name }}</span>
        </div>
      </div>
      <div v-if="error" class="modal-error">{{ error }}</div>
      <div class="modal-footer">
        <button class="btn" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary" :disabled="moveDisabled" @click="confirm()">Move</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed; inset: 0; background: rgba(0,0,0,0.5);
  display: flex; align-items: center; justify-content: center;
  z-index: 2000;
}
.modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: 8px;
  width: 480px;
  max-height: 70vh;
  display: flex; flex-direction: column;
  font-size: 0.9em;
}
.modal-header {
  padding: 12px 16px; border-bottom: 1px solid var(--border);
  font-weight: 600;
}
.modal-body {
  flex: 1; overflow-y: auto; padding: 4px 0;
}
.dir-row {
  display: flex; align-items: center; gap: 6px;
  padding: 4px 12px; cursor: pointer;
}
.dir-row:hover { background: var(--bg-tertiary); }
.dir-row.selected { background: color-mix(in srgb, var(--accent) 18%, transparent); }
.caret { width: 14px; font-size: 0.7em; color: var(--text-muted); cursor: pointer; }
.icon { font-size: 0.9em; }
.name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.modal-error {
  padding: 6px 16px; color: var(--danger); font-size: 0.85em;
  border-top: 1px solid var(--border);
}
.modal-footer {
  display: flex; justify-content: flex-end; gap: 8px;
  padding: 10px 16px; border-top: 1px solid var(--border);
}
.btn {
  background: var(--bg-tertiary); border: 1px solid var(--border);
  color: var(--text-primary); border-radius: 4px;
  padding: 6px 12px; cursor: pointer;
}
.btn:hover:not(:disabled) { background: var(--bg-hover); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary { background: var(--accent); border-color: var(--accent); color: white; }
.spinner {
  display: inline-block; width: 8px; height: 8px;
  border: 1.5px solid var(--border); border-top-color: var(--accent);
  border-radius: 50%; animation: spin 0.6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
