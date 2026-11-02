<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { natsService } from '@/services/nats'
import { useNotebookStore } from '@/stores/notebook'
import { formatDate } from '@/utils/format'
import type { ProjectNotebooks } from '@/types'

const emit = defineEmits<{ create: [dir: string] }>()
const nb = useNotebookStore()
const projects = ref<ProjectNotebooks[]>([])
const loading = ref(true)
const error = ref('')

async function load() {
  loading.value = true
  error.value = ''
  try {
    const r = (await natsService.invoke('list_project_notebooks')) as { projects?: ProjectNotebooks[] }
    projects.value = r.projects ?? []
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}
onMounted(load)

const fileName = (p: string) => p.slice(p.lastIndexOf('/') + 1)
// Folder inside the project, e.g. "scripts" for local_projects/demo/scripts/a.ipynb.
function subdir(project: ProjectNotebooks, p: string) {
  const rest = p.slice(project.dir.length + 1)
  const cut = rest.lastIndexOf('/')
  return cut < 0 ? '' : rest.slice(0, cut)
}
</script>

<template>
  <div class="nb-list">
    <div class="list-head">
      <span>Notebooks in your projects</span>
      <button class="icon-btn" :disabled="loading" title="Rescan projects" @click="load">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg>
      </button>
    </div>

    <div v-if="loading && !projects.length" class="state">Scanning projects…</div>
    <div v-else-if="error" class="state err">{{ error }}</div>
    <div v-else-if="!projects.length" class="state">
      No notebooks in <code>local_projects/</code> yet.<br>Create one with <b>+ New</b>.
    </div>

    <section v-for="p in projects" :key="p.dir" class="project">
      <div class="project-head">
        <span class="project-name" :title="p.dir">{{ p.name }}</span>
        <span class="count">{{ p.notebooks.length }}</span>
        <button class="icon-btn add" title="New notebook in this project" @click="emit('create', p.dir)">+</button>
      </div>
      <button
        v-for="n in p.notebooks"
        :key="n.path"
        class="nb-row"
        :class="{ open: nb.filePath === n.path }"
        :title="n.path"
        @click="nb.openNotebook(n.path)"
      >
        <svg class="nb-icon" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>
        <span class="nb-name">{{ fileName(n.path) }}</span>
        <span v-if="subdir(p, n.path)" class="nb-dir">{{ subdir(p, n.path) }}/</span>
        <span class="nb-time">{{ formatDate(n.modified_at) }}</span>
      </button>
    </section>
  </div>
</template>

<style scoped>
.nb-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 6px 8px 24px;
}
.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 6px 8px;
  font-size: 0.75em;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-muted);
}
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  background: transparent;
  border: none;
  border-radius: var(--radius);
  color: var(--text-muted);
}
.icon-btn:hover:not(:disabled) { background: var(--bg-tertiary); color: var(--text-primary); }
.icon-btn:disabled { opacity: 0.4; }

.state {
  padding: 40px 16px;
  text-align: center;
  font-size: 0.85em;
  line-height: 1.6;
  color: var(--text-muted);
}
.state.err { color: var(--danger); }
.state code {
  font-family: var(--font-mono);
  background: var(--bg-tertiary);
  padding: 1px 5px;
  border-radius: 3px;
}

.project { margin-bottom: 10px; }
.project-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
}
.project-name {
  font-weight: var(--fw-semi);
  font-size: 0.86em;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.count {
  font-size: 0.72em;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  border-radius: 999px;
  padding: 0 7px;
}
.icon-btn.add { margin-left: auto; font-size: 1.05em; }

.nb-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 8px 6px 14px;
  background: transparent;
  border: none;
  border-radius: var(--radius);
  color: var(--text-secondary);
  text-align: left;
  font-size: 0.84em;
}
.nb-row:hover { background: var(--bg-tertiary); color: var(--text-primary); }
.nb-row.open { background: var(--bg-tertiary); color: var(--accent); }
.nb-icon { flex-shrink: 0; opacity: 0.75; }
.nb-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.nb-dir {
  font-family: var(--font-mono);
  font-size: 0.85em;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.nb-time {
  margin-left: auto;
  flex-shrink: 0;
  font-size: 0.85em;
  color: var(--text-muted);
}
</style>
