<script setup lang="ts">
// Import into memory (docs/superpowers/specs/2026-11-09-memory-builder-plugin-design.md §6):
// pick a workspace file or folder, preview what the builder would read, choose
// the scope and start a build. The build runs in the background; the Memory
// panel's jobs tray (MemoryBuildJobs.vue) shows its progress.
import { computed, ref, watch } from 'vue'
import { useMemoryStore } from '@/stores/memory'
import { memoryBuilder, type ScanResult } from '@/services/memory'
import { formatFileSize } from '@/utils/format'
import DirPickerModal from '@/components/files/DirPickerModal.vue'

const store = useMemoryStore()
const path = ref(store.importPath ?? '')
const picking = ref(false)
const preview = ref<ScanResult | null>(null)
const previewing = ref(false)
const starting = ref(false)
const error = ref<string | null>(null)

// A path inside local_projects/<name> can go to that project's memory.
const project = computed(() => /^local_projects\/([^/._][^/]*)/.exec(path.value.replace(/^\/workspace\//, ''))?.[1] ?? null)
const scope = ref<'project' | 'user'>(project.value ? 'project' : 'user')
watch(project, (p) => { if (!p) scope.value = 'user' })

const toRead = computed(() => preview.value?.files.filter((f) => f.action === 'parse') ?? [])
const skipped = computed(() => preview.value?.files.filter((f) => f.action === 'skip') ?? [])

async function runPreview() {
  error.value = null
  preview.value = null
  previewing.value = true
  try {
    preview.value = await memoryBuilder.preview(path.value.trim())
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    previewing.value = false
  }
}

async function start() {
  error.value = null
  starting.value = true
  try {
    await memoryBuilder.start(path.value.trim(), scope.value)
    void store.loadJobs()
    close()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    starting.value = false
  }
}

function close() {
  store.importPath = null
}

watch(path, () => { preview.value = null })
if (path.value) void runPreview()
</script>

<template>
  <Teleport to="body">
    <div class="modal-backdrop" @click.self="close">
      <div class="modal" role="dialog" aria-label="Import into memory">
        <div class="modal-header">Import into memory</div>
        <div class="modal-body">
          <label class="field">
            <span class="field-label">File or folder</span>
            <span class="path-row">
              <input v-model="path" class="path-input" placeholder="local_projects/my-project/protocols" @keyup.enter="runPreview" />
              <button class="btn" @click="picking = true">Browse…</button>
              <button class="btn" :disabled="!path.trim() || previewing" @click="runPreview">Preview</button>
            </span>
          </label>
          <p class="hint">
            Protocols, inventories, sequencing orders, pipelines and notes (PDF, Word, Excel, CSV, Markdown, HTML, scripts).
            Raw data such as FASTQ, BAM or images is skipped. To add one file, right-click it in Files.
          </p>

          <div v-if="previewing" class="muted">Reading the folder…</div>
          <div v-else-if="preview" class="preview">
            <div class="preview-summary">
              {{ toRead.length }} file{{ toRead.length === 1 ? '' : 's' }} to read
              · about {{ preview.estimate.table_rows }} table row{{ preview.estimate.table_rows === 1 ? '' : 's' }}
              and {{ preview.estimate.documents }} document{{ preview.estimate.documents === 1 ? '' : 's' }}
              <template v-if="skipped.length"> · {{ skipped.length }} skipped</template>
            </div>
            <ul class="file-list">
              <li v-for="f in toRead.slice(0, 50)" :key="f.path">
                <span class="file-kind">{{ f.kind === 'table' ? 'table' : 'doc' }}</span>
                <span class="file-path">{{ f.path }}</span>
                <span class="file-size">{{ formatFileSize(f.size) }}</span>
              </li>
              <li v-if="toRead.length > 50" class="muted">… and {{ toRead.length - 50 }} more</li>
            </ul>
            <details v-if="skipped.length" class="skipped">
              <summary>{{ skipped.length }} skipped</summary>
              <ul class="file-list">
                <li v-for="f in skipped.slice(0, 50)" :key="f.path">
                  <span class="file-path">{{ f.path }}</span><span class="muted">{{ f.reason }}</span>
                </li>
              </ul>
            </details>
            <p v-if="preview.estimate.documents" class="hint">
              Documents are split into entries by your current model, so they use your model quota.
            </p>
          </div>

          <div class="field">
            <span class="field-label">Save to</span>
            <label class="radio" :class="{ disabled: !project }">
              <input v-model="scope" type="radio" value="project" :disabled="!project" />
              Project memory<template v-if="project"> ({{ project }})</template>
            </label>
            <label class="radio">
              <input v-model="scope" type="radio" value="user" />
              My memory
            </label>
          </div>

          <div v-if="error" class="error">{{ error }}</div>
        </div>
        <div class="modal-footer">
          <button class="btn" @click="close">Cancel</button>
          <button class="btn btn-primary" :disabled="!preview || !toRead.length || starting" @click="start">
            Build memory
          </button>
        </div>
      </div>
    </div>
    <DirPickerModal v-if="picking" v-model="path" label="Choose a folder to import" @close="picking = false">
      <template #header>Import which folder?</template>
      <template #footer>
        <span class="dest-label">{{ path || 'Pick a folder' }}</span>
        <button class="btn btn-primary" :disabled="!path" @click="picking = false; runPreview()">Choose</button>
      </template>
    </DirPickerModal>
  </Teleport>
</template>

<style scoped>
.modal-backdrop {
  position: fixed; inset: 0; z-index: 1900;
  background: rgba(0, 0, 0, 0.5); backdrop-filter: blur(6px);
  display: flex; align-items: center; justify-content: center;
}
.modal {
  width: min(620px, calc(100vw - 32px)); max-height: 80vh;
  display: flex; flex-direction: column;
  background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 8px;
  font-size: 0.9em;
}
.modal-header { padding: 12px 16px; border-bottom: 1px solid var(--border); font-weight: 600; }
.modal-body { flex: 1; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 10px; }
.modal-footer { display: flex; justify-content: flex-end; gap: 8px; padding: 10px 16px; border-top: 1px solid var(--border); }
.field { display: flex; flex-direction: column; gap: 4px; }
.field-label { font-size: 0.8em; color: var(--text-secondary); font-weight: 600; }
.path-row { display: flex; gap: 6px; }
.path-input {
  flex: 1; min-width: 0; padding: 5px 8px;
  background: var(--bg-primary); border: 1px solid var(--border); border-radius: 4px; color: var(--text-primary);
}
.hint { margin: 0; font-size: 0.8em; color: var(--text-muted); }
.muted { color: var(--text-muted); font-size: 0.85em; }
.preview { display: flex; flex-direction: column; gap: 6px; }
.preview-summary { font-weight: 500; }
.file-list { list-style: none; margin: 0; padding: 0; max-height: 180px; overflow-y: auto; font-size: 0.85em; }
.file-list li { display: flex; gap: 8px; padding: 2px 0; }
.file-kind { flex: none; width: 36px; color: var(--text-muted); }
.file-path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-size { flex: none; color: var(--text-muted); }
.skipped summary { cursor: pointer; font-size: 0.85em; color: var(--text-secondary); }
.radio { display: flex; align-items: center; gap: 6px; }
.radio.disabled { color: var(--text-muted); }
.error { color: var(--danger); font-size: 0.85em; }
.dest-label { flex: 1; font-size: 0.85em; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btn {
  background: var(--bg-tertiary); border: 1px solid var(--border); color: var(--text-primary);
  border-radius: 4px; padding: 5px 12px; cursor: pointer;
}
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
</style>
