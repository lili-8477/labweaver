<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useFileStore } from '@/stores/files'
import { renderMarkdown } from '@/utils/markdown'

const files = useFileStore()
const editorEl = ref<HTMLElement | null>(null)
let editor: unknown = null
let monacoModule: typeof import('monaco-editor') | null = null

const isBinary = computed(() => files.openFile?.encoding === 'base64')

const isImage = computed(() => {
  if (!files.openFile) return false
  const mime = files.openFile.mimeType
  const ext = files.openFile.path.split('.').pop()?.toLowerCase()
  return mime?.startsWith('image/') ||
    ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'avif'].includes(ext || '')
})

const isPdf = computed(() => {
  if (!files.openFile) return false
  return files.openFile.mimeType === 'application/pdf' ||
    files.openFile.path.toLowerCase().endsWith('.pdf')
})

const isMarkdown = computed(() => {
  if (!files.openFile) return false
  const ext = files.openFile.path.split('.').pop()?.toLowerCase()
  return ext === 'md' || ext === 'markdown' || ext === 'mdx'
})

/** Markdown defaults to rendered view; toggle with the Edit/Preview button. */
const mdMode = ref<'rendered' | 'editing'>('rendered')
const renderedHtml = computed(() =>
  isMarkdown.value && files.openFile ? renderMarkdown(files.openFile.content) : '',
)

const isEditable = computed(() => !isBinary.value && !isImage.value && !isPdf.value)
const modified = ref(false)

/** Data URI for embedded preview (images, PDFs). */
const dataUri = computed(() => {
  if (!files.openFile) return ''
  const { content, encoding, mimeType } = files.openFile
  if (encoding === 'base64') return `data:${mimeType};base64,${content}`
  // SVG comes through as text — wrap inline.
  return `data:${mimeType};charset=utf-8,${encodeURIComponent(content)}`
})

/** URL to nginx's direct-download endpoint — scoped by HTTP Basic auth to the
 *  authenticated user's own workspace. Works for any size, bypassing NATS. */
const directDownloadUrl = computed(() => {
  if (!files.openFile) return ''
  const segs = files.openFile.path.split('/').map(encodeURIComponent)
  return `/download/${segs.join('/')}`
})

/** Trigger a download of the current file. Prefers the nginx endpoint
 *  (streams directly from disk — works at any size, doesn't hold the
 *  file in browser memory). Falls back to a blob of the in-memory content
 *  when served off-hub (e.g. dev mode on a plain NATS WebSocket). */
function download() {
  if (!files.openFile) return
  const filename = files.openFile.path.split('/').pop() || 'download'
  // Hosted behind nginx (http/https origin) → use direct streaming URL.
  if (window.location.protocol.startsWith('http')) {
    const a = document.createElement('a')
    a.href = directDownloadUrl.value
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    return
  }
  // Fallback for dev/offline: blob from the in-memory content.
  const { content, encoding, mimeType } = files.openFile
  let blob: Blob
  if (encoding === 'base64') {
    const bytes = Uint8Array.from(atob(content), c => c.charCodeAt(0))
    blob = new Blob([bytes as BlobPart], { type: mimeType })
  } else {
    blob = new Blob([content], { type: mimeType })
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function humanSize(bytes: number | undefined): string {
  if (bytes == null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

async function initEditor() {
  // Markdown starts in rendered mode; only mount Monaco when user switches to Edit.
  if (!editorEl.value || !isEditable.value || !files.openFile) return
  if (isMarkdown.value && mdMode.value === 'rendered') return

  monacoModule = await import('monaco-editor')

  // Set dark theme
  monacoModule.editor.defineTheme('pantheon-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [],
    colors: {
      'editor.background': '#0d1117',
      'editor.foreground': '#e6edf3',
    },
  })
  monacoModule.editor.setTheme('pantheon-dark')

  editor = monacoModule.editor.create(editorEl.value, {
    value: files.openFile.content,
    language: files.openFile.language,
    theme: 'pantheon-dark',
    minimap: { enabled: false },
    fontSize: 13,
    fontFamily: 'var(--font-mono)',
    lineNumbers: 'on',
    scrollBeyondLastLine: false,
    wordWrap: 'on',
    automaticLayout: true,
    readOnly: false,
  })

  const ed = editor as import('monaco-editor').editor.IStandaloneCodeEditor
  ed.onDidChangeModelContent(() => {
    modified.value = true
  })
}

async function save() {
  if (!files.openFile || !editor) return
  const ed = editor as import('monaco-editor').editor.IStandaloneCodeEditor
  const content = ed.getValue()
  await files.writeFile(files.openFile.path, content)
  modified.value = false
}

function close() {
  if (editor) {
    (editor as import('monaco-editor').editor.IStandaloneCodeEditor).dispose()
    editor = null
  }
  files.closeFile()
}

onMounted(() => {
  if (isEditable.value) initEditor()
})

watch(() => files.openFile, () => {
  if (editor) {
    (editor as import('monaco-editor').editor.IStandaloneCodeEditor).dispose()
    editor = null
  }
  modified.value = false
  // Reset md to rendered view whenever a new file opens.
  mdMode.value = 'rendered'
  if (isEditable.value) {
    setTimeout(initEditor, 50)
  }
})

/** Toggle between rendered markdown and the Monaco editor (mount lazily). */
function toggleMdMode() {
  if (!isMarkdown.value) return
  mdMode.value = mdMode.value === 'rendered' ? 'editing' : 'rendered'
  if (editor) {
    (editor as import('monaco-editor').editor.IStandaloneCodeEditor).dispose()
    editor = null
  }
  if (mdMode.value === 'editing') {
    setTimeout(initEditor, 50)
  }
}

onUnmounted(() => {
  if (editor) {
    (editor as import('monaco-editor').editor.IStandaloneCodeEditor).dispose()
  }
})
</script>

<template>
  <div class="file-viewer-overlay" v-if="files.openFile">
    <div class="file-viewer">
      <div class="viewer-header">
        <span class="file-path">{{ files.openFile.path }}</span>
        <span v-if="files.openFile.size != null" class="file-size">{{ humanSize(files.openFile.size) }}</span>
        <span v-if="modified" class="modified-badge">Modified</span>
        <div class="viewer-actions">
          <button
            v-if="isMarkdown"
            class="btn-toggle"
            @click="toggleMdMode"
            :title="mdMode === 'rendered' ? 'Switch to raw markdown' : 'Switch to rendered preview'"
          >
            {{ mdMode === 'rendered' ? 'Edit' : 'Preview' }}
          </button>
          <button v-if="isEditable" class="btn-save" @click="save" :disabled="!modified">
            Save
          </button>
          <button class="btn-download" @click="download" title="Download file">
            &#x2B07; Download
          </button>
          <button class="btn-close" @click="close">&times;</button>
        </div>
      </div>
      <div class="viewer-body">
        <!-- Image preview — renders the actual file, not a placeholder. -->
        <div v-if="isImage" class="image-preview">
          <img :src="dataUri" :alt="files.openFile.path.split('/').pop()" />
        </div>

        <!-- PDF preview via embedded object. -->
        <iframe v-else-if="isPdf" :src="dataUri" class="pdf-frame" />

        <!-- Other binary file — download-only. -->
        <div v-else-if="isBinary" class="binary-placeholder">
          <div class="binary-icon">&#x1F4E6;</div>
          <p>Binary file — preview not available</p>
          <p class="binary-name">{{ files.openFile.path.split('/').pop() }}</p>
          <button class="btn-download large" @click="download">Download</button>
        </div>

        <!-- Markdown rendered view — switchable with the Edit button. -->
        <div
          v-else-if="isMarkdown && mdMode === 'rendered'"
          class="markdown-rendered markdown-body"
          v-html="renderedHtml"
        />

        <!-- Code editor (also used when markdown is in Edit mode) -->
        <div v-else ref="editorEl" class="editor-container"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.file-viewer-overlay {
  position: fixed; inset: 0; z-index: 100;
  background: rgba(0, 0, 0, 0.6); display: flex;
  align-items: center; justify-content: center;
}
.file-viewer {
  width: 85vw; height: 80vh; background: var(--bg-primary);
  border: 1px solid var(--border); border-radius: var(--radius-lg);
  display: flex; flex-direction: column; overflow: hidden;
}
.viewer-header {
  display: flex; align-items: center; gap: 12px;
  padding: 10px 16px; border-bottom: 1px solid var(--border);
  background: var(--bg-secondary);
}
.file-path {
  flex: 1; font-family: var(--font-mono); font-size: 0.85em;
  color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap;
}
.modified-badge {
  font-size: 0.75em; padding: 2px 8px; background: var(--warning);
  color: #000; border-radius: 10px;
}
.viewer-actions { display: flex; gap: 8px; }
.btn-save {
  padding: 4px 14px; background: var(--accent); color: #fff;
  border: none; border-radius: var(--radius); font-size: 0.85em;
}
.btn-save:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-download {
  padding: 4px 12px; background: var(--bg-tertiary); color: var(--text-primary);
  border: 1px solid var(--border); border-radius: var(--radius); font-size: 0.85em;
}
.btn-download:hover { background: var(--bg-hover); }
.btn-download.large { padding: 8px 20px; background: var(--accent); color: #fff; border: none; }
.btn-toggle {
  padding: 4px 12px; background: var(--bg-tertiary); color: var(--text-primary);
  border: 1px solid var(--border); border-radius: var(--radius); font-size: 0.85em;
}
.btn-toggle:hover { background: var(--bg-hover); }
.btn-close {
  width: 30px; height: 30px; background: transparent; border: none;
  color: var(--text-secondary); font-size: 1.2em; border-radius: 4px;
}
.btn-close:hover { background: var(--bg-tertiary); color: var(--text-primary); }
.file-size {
  font-size: 0.75em; color: var(--text-muted); font-family: var(--font-mono);
  padding: 2px 8px; background: var(--bg-tertiary); border-radius: var(--radius);
}

.viewer-body { flex: 1; overflow: hidden; background: var(--bg-primary); }
.editor-container { height: 100%; }

.image-preview {
  display: flex; align-items: center; justify-content: center;
  height: 100%; overflow: auto; padding: 24px;
  background:
    linear-gradient(45deg, var(--bg-secondary) 25%, transparent 25%),
    linear-gradient(-45deg, var(--bg-secondary) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, var(--bg-secondary) 75%),
    linear-gradient(-45deg, transparent 75%, var(--bg-secondary) 75%);
  background-size: 20px 20px;
  background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
  background-color: var(--bg-primary);
}
.image-preview img {
  max-width: 100%; max-height: 100%;
  box-shadow: var(--shadow-lg); border-radius: var(--radius);
}
.pdf-frame { width: 100%; height: 100%; border: none; background: #fff; }
.binary-placeholder {
  display: flex; flex-direction: column; align-items: center;
  justify-content: center; height: 100%; color: var(--text-muted); gap: 12px;
}
.binary-icon { font-size: 3em; }
.binary-name { font-family: var(--font-mono); font-size: 0.9em; color: var(--text-secondary); }

.markdown-rendered {
  height: 100%;
  overflow: auto;
  padding: 32px 48px;
  max-width: none;
}
.markdown-rendered.markdown-body { max-width: 80ch; margin: 0 auto; }
</style>
