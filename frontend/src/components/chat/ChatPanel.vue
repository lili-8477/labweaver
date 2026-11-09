<script setup lang="ts">
import { ref, nextTick, watch, computed, onMounted, onBeforeUnmount } from 'vue'
import { storeToRefs } from 'pinia'
import { useChatStore } from '@/stores/chat'
import { isDisplayableMessage, extractTextContent } from '@/utils/content'
import type { ChatMessage, ChatMode } from '@/types'
import ChatMessageComp from '@/components/chat/ChatMessage.vue'
import RequestIndex from '@/components/chat/RequestIndex.vue'
import ExecutionTimeline from '@/components/chat/ExecutionTimeline.vue'
import HarnessChecklist from '@/components/chat/HarnessChecklist.vue'
import ModeMenu from '@/components/chat/ModeMenu.vue'
import { isImage, makeAttachment, uploadAttachment, discardAttachmentFile, type ChatAttachment } from '@/services/chat-attachments'
import { composeUploadNote, pickedFiles, queueProjectUploads } from '@/services/project-upload'
import { cancelUpload } from '@/services/upload'
import { useUploadsStore } from '@/stores/uploads'
import { useFileStore } from '@/stores/files'
import { formatFileSize } from '@/utils/format'
import { isSupported as voiceSupported, startVoice, type VoiceSession } from '@/services/voice'
import SlashMenu from '@/components/chat/SlashMenu.vue'
import { useChatHints, inputPlaceholder } from '@/composables/useChatHints'
import { useSelectionStore } from '@/stores/selection'
import { selectionBlock, splitSelection } from '@/utils/selection'
import { walkDataTransferItems, type DroppedFile } from '@/utils/dnd'

const chat = useChatStore()
const selection = useSelectionStore()
const uploads = useUploadsStore()
const fileStore = useFileStore()
const input = ref('')
const messagesEl = ref<HTMLElement | null>(null)

const attachments = ref<ChatAttachment[]>([])
const isDragging = ref(false)
const dragDepth = ref(0)
// Files and folders go into the active chat's project; nothing uploads
// without one. `uploadIds` are the batch in flight (progress, cancel);
// `uploaded` waits for Send, which tells the agent what arrived.
const projectDir = computed(() => chat.activeChat?.project_dir || null)
const projectName = computed(() => projectDir.value?.split('/').pop() ?? null)
const uploadIds = ref<string[]>([])
const uploaded = ref<DroppedFile[]>([])
const uploadError = ref<string | null>(null)
const fileInput = ref<HTMLInputElement | null>(null)
const dirInput = ref<HTMLInputElement | null>(null)
const uploadMenuOpen = ref(false)

const activeUpload = computed(() => {
  for (const id of uploadIds.value) {
    const u = uploads.items.find(i => i.id === id)
    if (u && (u.state === 'uploading' || u.state === 'pending')) return u
  }
  return null
})
const activeUploadPct = computed(() => {
  const u = activeUpload.value
  if (!u || u.totalBytes <= 0) return 0
  return Math.min(100, Math.floor((u.bytesSent / u.totalBytes) * 100))
})
const uploadsLeft = computed(() => uploadIds.value.filter(id => {
  const u = uploads.items.find(i => i.id === id)
  return u && (u.state === 'uploading' || u.state === 'pending')
}).length)
function cancelProjectUpload() {
  for (const id of uploadIds.value) cancelUpload(id)
}
const voiceOn = ref(false)
const voiceSupportedFlag = voiceSupported()
let voiceSession: VoiceSession | null = null
// Text already in the textarea when recording starts; new transcript is
// appended to it so we don't clobber a partially-typed message.
let voiceBaseText = ''

const slashMenuRef = ref<InstanceType<typeof SlashMenu> | null>(null)
const inputRef = ref<HTMLTextAreaElement | null>(null)

const { messages: chatMessages, nextSteps } = storeToRefs(chat)
const hints = useChatHints({
  messages:       chatMessages,
  attachments,
  uploadedCount:  computed(() => uploaded.value.length),
  hasProject:     computed(() => projectDir.value !== null),
  nextSteps,
})

const placeholder = computed(() => inputPlaceholder(chat.activeMode === 'auto', chat.harnessProgress))

function setMode(mode: ChatMode) {
  if (chat.activeChatId) chat.setChatMode(chat.activeChatId, mode)
}

const anyUploading = computed(() => attachments.value.some(a => a.state === 'uploading') || uploadIds.value.length > 0)
const hasContent = computed(
  () => (
    input.value.trim().length > 0
    || attachments.value.some(a => a.state === 'done')
    || uploaded.value.length > 0
  ) && !anyUploading.value,
)

// Filter messages for display — hide tool/system messages
const displayMessages = computed(() =>
  chat.messages.filter(m => isDisplayableMessage(m as Record<string, unknown>))
)

// Map from display index to original message index for timeline lookup
const displayToOriginalIndex = computed(() => {
  const map = new Map<number, number>()
  let displayIdx = 0
  for (let i = 0; i < chat.messages.length; i++) {
    if (isDisplayableMessage(chat.messages[i] as Record<string, unknown>)) {
      map.set(displayIdx, i)
      displayIdx++
    }
  }
  return map
})

function getTimelineForDisplayMsg(displayIdx: number) {
  const origIdx = displayToOriginalIndex.value.get(displayIdx)
  if (origIdx == null) return null
  return chat.completedTimelines.get(origIdx) || null
}

// Assistant turns that emitted only tool_use blocks have no text — skip the
// empty bubble. The timeline rendered below the (now-absent) bubble still
// shows what the agent did.
function hasBubbleBody(msg: ChatMessage): boolean {
  if (msg.role !== 'assistant') return true
  return extractTextContent(msg.content).trim().length > 0
}

/** Label for the request index: the request's first line, minus attached-image lines. */
function requestLabel(msg: ChatMessage): string | undefined {
  if (msg.role !== 'user') return undefined
  const text = splitSelection(extractTextContent(msg.content)).rest.replace(/^\[image: [^\]]*\]\n?/gm, '').trim()
  return text.split('\n')[0].slice(0, 120) || 'Image'
}

function send() {
  if (!hasContent.value || chat.sending) return
  if (voiceOn.value) stopVoice()
  const paths = attachments.value
    .filter(a => a.state === 'done' && a.workspacePath)
    .map(a => a.workspacePath)
  let text = uploaded.value.length && projectDir.value
    ? composeUploadNote(projectDir.value, uploaded.value, input.value.trim())
    : input.value.trim()
  // A slash command only runs from the start of the prompt, so it goes
  // without the selection; the chip stays for the next message.
  if (selection.current && !text.startsWith('/')) {
    text = `${selectionBlock(selection.current)}\n\n${text}`
    selection.clear()
  }
  uploaded.value = []
  chat.sendMessage(text, paths)
  input.value = ''
  clearAttachments()
}

// Split the input for the highlight overlay: when it starts with "/", the
// leading command token (up to the first whitespace) is colored; the rest is
// plain. Rendered as text (not v-html) so user input can't inject markup.
const inputSegments = computed(() => {
  const v = input.value
  if (!v.startsWith('/')) return { cmd: '', rest: v }
  const ws = v.search(/\s/)
  return ws === -1
    ? { cmd: v, rest: '' }
    : { cmd: v.slice(0, ws), rest: v.slice(ws) }
})

const highlightRef = ref<HTMLDivElement | null>(null)

// Keep the mirror div's scroll aligned with the textarea (it scrolls
// internally once content passes max-height).
function syncHighlightScroll() {
  const ta = inputRef.value
  const hl = highlightRef.value
  if (ta && hl) { hl.scrollTop = ta.scrollTop; hl.scrollLeft = ta.scrollLeft }
}

// Grow the editor with the content until max-height, then let it scroll.
// The textarea is rows="1", so without this it stays one line tall and the
// text scrolls inside it. The mirror is inset:0 on the wrapper, so it follows.
function autosize() {
  const ta = inputRef.value
  if (!ta) return
  ta.style.height = 'auto'
  ta.style.height = `${ta.scrollHeight}px`
  syncHighlightScroll()
}

watch(input, () => { void nextTick(autosize) })

// Wrapping changes when the chat pane is resized, so re-fit on width changes
// (height changes are our own and are ignored).
let editorWidth = 0
const editorResize = new ResizeObserver(([entry]) => {
  const w = entry.contentRect.width
  if (w !== editorWidth) { editorWidth = w; autosize() }
})
watch(inputRef, (ta, old) => {
  if (old?.parentElement) editorResize.unobserve(old.parentElement)
  if (ta?.parentElement) editorResize.observe(ta.parentElement)
})
onMounted(autosize)
onBeforeUnmount(() => editorResize.disconnect())

function handleKeydown(e: KeyboardEvent) {
  if (slashMenuRef.value?.handleKey(e)) {
    e.preventDefault()
    return
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}

function applyHint(text: string) {
  input.value = text
  nextTick(() => inputRef.value?.focus())
}

function onSlashAccept(item: { kind: 'command' | 'skill'; name: string }) {
  input.value = item.kind === 'command'
    ? `/${item.name} `
    : `Use the ${item.name} skill: `
  nextTick(() => inputRef.value?.focus())
}

function onSlashDismiss() {
  if (input.value.startsWith('/')) input.value = ''
  nextTick(() => inputRef.value?.focus())
}

// ---- Image attachments ----

function addFiles(files: FileList | File[]) {
  for (const f of Array.from(files)) {
    if (!isImage(f)) continue
    const att = makeAttachment(f)
    attachments.value.push(att)
    const id = att.id

    // Mutate via the reactive proxy (look up by id) so Vue's `set` trap
    // fires and the chip re-renders. Mutating the local `att` reference
    // updates the underlying object but skips reactivity tracking.
    const patch = (p: Partial<ChatAttachment>) => {
      const cur = attachments.value.find(a => a.id === id)
      if (cur) Object.assign(cur, p)
    }

    uploadAttachment(id, (pct) => patch({ progress: pct }))
      .then(path => patch({ workspacePath: path, state: 'done', progress: 100 }))
      .catch(err => patch({ state: 'error', error: err.message || String(err) }))
  }
}

function removeAttachment(id: string) {
  const idx = attachments.value.findIndex(a => a.id === id)
  if (idx < 0) return
  URL.revokeObjectURL(attachments.value[idx].previewUrl)
  attachments.value.splice(idx, 1)
  discardAttachmentFile(id)
}

function clearAttachments() {
  for (const a of attachments.value) {
    URL.revokeObjectURL(a.previewUrl)
    discardAttachmentFile(a.id)
  }
  attachments.value = []
}

function handlePaste(e: ClipboardEvent) {
  const items = e.clipboardData?.items
  if (!items) return
  const files: File[] = []
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    if (it.kind === 'file') {
      const f = it.getAsFile()
      if (f && isImage(f)) files.push(f)
    }
  }
  if (files.length > 0) {
    e.preventDefault()
    addFiles(files)
  }
}

// Matches FileTree's INTERNAL_PATH_MIME — a drag originating from the file
// tree (a folder/file path), as opposed to an OS file drag (kind 'Files').
const PATH_DRAG_MIME = 'application/x-bioflow-path'

function hasPathInDrag(e: DragEvent): boolean {
  const types = e.dataTransfer?.types
  if (!types) return false
  for (let i = 0; i < types.length; i++) if (types[i] === PATH_DRAG_MIME) return true
  return false
}

// Insert a path at the caret (or append), padding with spaces so it doesn't
// fuse onto surrounding words.
function insertPathIntoInput(path: string) {
  const ta = inputRef.value
  const cur = input.value
  if (ta && ta.selectionStart != null) {
    const start = ta.selectionStart
    const end = ta.selectionEnd ?? start
    const before = cur.slice(0, start)
    const after = cur.slice(end)
    const lead = before && !/\s$/.test(before) ? ' ' : ''
    const trail = after && !/^\s/.test(after) ? ' ' : ''
    input.value = before + lead + path + trail + after
    const pos = (before + lead + path).length
    nextTick(() => { ta.focus(); ta.setSelectionRange(pos, pos) })
  } else {
    const lead = cur && !/\s$/.test(cur) ? ' ' : ''
    input.value = cur + lead + path + ' '
    nextTick(() => inputRef.value?.focus())
  }
}

function onDragEnter(e: DragEvent) {
  if (hasPathInDrag(e)) { e.preventDefault(); return }
  if (!hasFilesInDrag(e)) return
  e.preventDefault()
  dragDepth.value++
  isDragging.value = true
}
function onDragOver(e: DragEvent) {
  if (hasPathInDrag(e)) {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    return
  }
  if (!hasFilesInDrag(e)) return
  e.preventDefault()
}
function onDragLeave(e: DragEvent) {
  if (!hasFilesInDrag(e)) return
  e.preventDefault()
  dragDepth.value = Math.max(0, dragDepth.value - 1)
  if (dragDepth.value === 0) isDragging.value = false
}
function onDrop(e: DragEvent) {
  if (!e.dataTransfer) return
  e.preventDefault()
  dragDepth.value = 0
  isDragging.value = false

  // A folder/file dragged from the file tree carries its path (text/plain),
  // not File objects — drop it into the prompt instead of uploading.
  if (hasPathInDrag(e)) {
    const p = e.dataTransfer.getData('text/plain')
    if (p) insertPathIntoInput(p)
    return
  }

  // Images attach to the message. Everything else (CSV, FASTQ, PDF, folders…)
  // uploads into the chat's project. Entries are read now: the drop's item
  // list is gone once this handler returns.
  const dt = e.dataTransfer
  const walking = dt.items?.length && 'webkitGetAsEntry' in dt.items[0]
    ? walkDataTransferItems(dt.items)
    : Promise.resolve(pickedFiles(dt.files))
  void walking.then(all => {
    const images = all.filter(d => !d.relativePath.includes('/') && isImage(d.file))
    if (images.length > 0) addFiles(images.map(d => d.file))
    const others = all.filter(d => !images.includes(d))
    if (others.length > 0) uploadToProject(others)
  })
}
function hasFilesInDrag(e: DragEvent): boolean {
  const types = e.dataTransfer?.types
  if (!types) return false
  // dataTransfer.items isn't reliable across browsers during dragenter, so we
  // accept any drag carrying Files; onDrop decides how to route each file.
  for (let i = 0; i < types.length; i++) if (types[i] === 'Files') return true
  return false
}

// ---- Upload to the chat's project ----

function uploadToProject(files: DroppedFile[]) {
  uploadError.value = null
  const dir = projectDir.value
  if (!dir) {
    uploadError.value = 'Open a chat in a project first. Create one with + under Projects.'
    return
  }
  const { ids, done } = queueProjectUploads(files, dir)
  uploadIds.value = [...uploadIds.value, ...ids]
  void done.then(({ ok, failed }) => {
    uploadIds.value = uploadIds.value.filter(id => !ids.includes(id))
    // These uploads bypass the Files panel, so tell it to refresh the project.
    fileStore.requestReveal(dir)
    // The note is for this chat only; a switch while uploading drops it.
    if (chat.activeChat?.project_dir === dir) uploaded.value = [...uploaded.value, ...ok]
    if (failed > 0) uploadError.value = `${failed} of ${files.length} file(s) failed to upload. See Files › uploads for details.`
  })
}

function pickUpload(kind: 'file' | 'directory') {
  uploadMenuOpen.value = false
  ;(kind === 'file' ? fileInput : dirInput).value?.click()
}

function onPicked(e: Event) {
  const el = e.target as HTMLInputElement
  if (el.files?.length) uploadToProject(pickedFiles(el.files))
  el.value = ''  // allow picking the same file again
}

// ---- Voice ----

function toggleVoice() {
  if (voiceOn.value) stopVoice()
  else startVoiceSession()
}

function startVoiceSession() {
  if (!voiceSupportedFlag) return
  voiceBaseText = input.value
  try {
    voiceSession = startVoice({
      onTranscript: (text) => {
        input.value = (voiceBaseText ? voiceBaseText + ' ' : '') + text
      },
      onError: () => stopVoice(),
      onEnd: () => { voiceOn.value = false; voiceSession = null },
    })
    voiceOn.value = true
  } catch {
    voiceOn.value = false
  }
}

function stopVoice() {
  voiceSession?.stop()
  voiceSession = null
  voiceOn.value = false
}

// If a drag escapes the chat panel and the user releases over an unhandled
// region, the browser would otherwise navigate the tab to the dropped file —
// which unloads the SPA and blanks everything. Swallow window-level drag/drop
// so a stray miss is a no-op instead of a navigation.
function swallow(e: DragEvent) {
  if (e.dataTransfer?.types?.includes('Files')) e.preventDefault()
}

// Harness progress polling. Auto mode applies to one message (picked in the
// composer's ModeMenu), so "running" means this chat's auto turn is in flight.
// progress.md is polled at a variable cadence depending on activity:
//       running + sending → 3s   (a tick is in flight, items change fast)
//       running + idle    → 8s   (between ticks)
//       stopped + has progress → 30s (sticky final state; mostly to catch
//                                     manual edits, slow but cheap)
//       no progress, not active → no poll (nothing to read)
//     The point is to keep the checklist live during /tick but not hammer
//     NATS when the run has stopped. The stopped-state poll exists so that
//     if the user manually edits progress.md, or kicks /tick off again,
//     the view eventually catches up without a chat re-select.
let harnessProgressTimer: number | null = null

function progressCadence(): number | null {
  if (chat.harnessActive) return chat.sending ? 3000 : 8000
  if (chat.harnessProgress) return 30_000
  return null
}

function scheduleProgressTick() {
  if (harnessProgressTimer != null) {
    clearTimeout(harnessProgressTimer)
    harnessProgressTimer = null
  }
  const delay = progressCadence()
  if (delay == null) return
  harnessProgressTimer = window.setTimeout(() => {
    void chat.refreshHarnessProgress().finally(scheduleProgressTick)
  }, delay)
}

function stopHarnessPolling() {
  if (harnessProgressTimer != null) { clearTimeout(harnessProgressTimer); harnessProgressTimer = null }
}

// Mode and chat changes both trigger an immediate fetch — waiting for the
// next 30s tick after a chat switch would leave the checklist blank for the
// first half-minute, which feels broken.
watch(() => chat.harnessActive, () => {
  void chat.refreshHarnessProgress()
  scheduleProgressTick()
})
watch(() => chat.activeChatId, () => {
  void chat.refreshHarnessProgress()
  scheduleProgressTick()
})
watch(() => chat.sending, () => {
  // Sending flipping changes the running-cadence (3s vs 8s); reschedule so
  // we don't wait the full idle cadence to pick up the burstier rate.
  scheduleProgressTick()
})

onMounted(() => {
  window.addEventListener('dragover', swallow)
  window.addEventListener('drop', swallow)
  void chat.refreshAvailableModes()
  void chat.refreshHarnessProgress()
  scheduleProgressTick()
})

onBeforeUnmount(() => {
  window.removeEventListener('dragover', swallow)
  window.removeEventListener('drop', swallow)
  stopHarnessPolling()
  voiceSession?.abort()
  clearAttachments()
})

// The upload note belongs to the chat it was made in; the files stay on disk.
watch(() => chat.activeChatId, () => {
  uploaded.value = []
  uploadError.value = null
  uploadMenuOpen.value = false
})

// Auto-scroll
watch(
  [() => chat.messages.length, () => chat.streamingText, () => chat.liveTimeline.length],
  () => {
    nextTick(() => {
      if (messagesEl.value) {
        messagesEl.value.scrollTop = messagesEl.value.scrollHeight
      }
    })
  },
)
</script>

<template>
  <div
    class="chat-panel"
    :class="{ 'panel-drag-active': isDragging }"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- Empty state -->
    <div v-if="!chat.activeChatId" class="empty-state">
      <div class="empty-icon">&#x1F4AC;</div>
      <h3>Select or create a chat</h3>
      <p>Choose a chat from the sidebar or create a new one to get started.</p>
    </div>

    <!-- Chat content -->
    <template v-else>
      <!-- Self-driving banner + live checklist. Pinned above messages so it
           stays visible as the scroll grows. Visible while an auto turn runs
           OR this session has a progress.md — once a run produces a plan,
           the checklist sticks around as a record after the turn ends. The component itself collapses to just the banner
           if the user folds it. -->
      <HarnessChecklist
        v-if="chat.harnessActive || chat.harnessProgress"
        :active="chat.harnessActive"
        :progress="chat.harnessProgress"
        :project-name="chat.harnessProject"
        :chat-id="chat.activeChatId"
      />

      <div class="messages-row">
      <div ref="messagesEl" class="messages">
        <!-- Rendered messages with inline timelines -->
        <template v-for="(msg, i) in displayMessages" :key="i">
          <ChatMessageComp v-if="hasBubbleBody(msg)" :message="msg" :data-request="requestLabel(msg)" />
          <!-- Show timeline below assistant messages that had tool activity -->
          <ExecutionTimeline
            v-if="msg.role === 'assistant' && getTimelineForDisplayMsg(i)"
            :steps="getTimelineForDisplayMsg(i)!"
          />
        </template>

        <!-- Streaming response -->
        <div v-if="chat.streamingText" class="streaming-msg">
          <ChatMessageComp
            :message="{ role: 'assistant', content: chat.streamingText }"
            :streaming="true"
          />
        </div>

        <!-- Live execution timeline (during streaming) -->
        <ExecutionTimeline
          v-if="chat.liveTimeline.length > 0"
          :steps="chat.liveTimeline"
          :live="true"
        />

        <!-- Sending indicator (no streaming yet) -->
        <div v-if="chat.sending && !chat.streamingText && !chat.isStreaming && chat.liveTimeline.length === 0" class="thinking">
          <div class="thinking-dots">
            <span></span><span></span><span></span>
          </div>
          <span class="thinking-text">Agent is thinking...</span>
        </div>
      </div>
      <RequestIndex :scroller="messagesEl" :version="displayMessages.length" />
      </div>

      <!-- Hints -->
      <div v-if="hints.length > 0 && !chat.sending" class="suggestions">
        <button
          v-for="h in hints"
          :key="h.id"
          class="suggestion-btn"
          @click="h.id === 'upload' ? pickUpload('file') : applyHint(h.text)"
        >
          {{ h.text }}
        </button>
      </div>

      <!-- Input -->
      <div
        class="input-area"
        :class="{ 'drag-active': isDragging }"
      >
        <div v-if="selection.current" class="selection-chip" :title="selection.current.text">
          <span class="selection-label">Selection</span>
          <span class="selection-where">
            {{ selection.current.source.split('/').pop() }}<template v-if="selection.current.where"> · {{ selection.current.where }}</template>
          </span>
          <span class="selection-text">{{ selection.current.text }}</span>
          <button class="selection-remove" @click="selection.clear()" title="Don't send the selection">&times;</button>
        </div>

        <div v-if="attachments.length > 0" class="attachment-strip">
          <div
            v-for="a in attachments"
            :key="a.id"
            class="attachment-chip"
            :class="{ 'chip-error': a.state === 'error' }"
            :title="a.state === 'error' ? a.error : a.fileName"
          >
            <img :src="a.previewUrl" alt="" class="chip-thumb" />
            <div v-if="a.state === 'uploading'" class="chip-progress">
              <div class="chip-progress-bar" :style="{ width: a.progress + '%' }"></div>
              <span class="chip-progress-pct">{{ a.progress }}%</span>
            </div>
            <span v-else-if="a.state === 'error'" class="chip-error-icon">!</span>
            <button class="chip-remove" @click="removeAttachment(a.id)" title="Remove">&times;</button>
          </div>
        </div>

        <div v-if="isDragging" class="drop-overlay">
          <div>Drop files or folders</div>
          <div class="drop-overlay-sub">
            <template v-if="projectName">images attach &middot; everything else goes into {{ projectName }}</template>
            <template v-else>images attach &middot; open a chat in a project to upload data</template>
          </div>
        </div>

        <div v-if="uploadIds.length" class="project-status project-status-uploading">
          <div class="upload-progress-row">
            <span class="project-status-spinner"></span>
            <span class="upload-progress-label">
              <template v-if="activeUpload">
                Uploading <code>{{ activeUpload.fileName }}</code> to {{ projectName }}
                <template v-if="uploadsLeft > 1"> &middot; {{ uploadsLeft }} left</template>
              </template>
              <template v-else>Finishing…</template>
            </span>
            <span v-if="activeUpload" class="upload-progress-bytes">
              {{ formatFileSize(activeUpload.bytesSent) }} /
              {{ formatFileSize(activeUpload.totalBytes) }}
              · {{ activeUploadPct }}%
            </span>
            <button class="upload-progress-cancel" @click="cancelProjectUpload" title="Cancel upload">Cancel</button>
          </div>
          <div v-if="activeUpload" class="upload-progress-bar">
            <div class="upload-progress-bar-fill" :style="{ width: activeUploadPct + '%' }"></div>
          </div>
        </div>
        <div v-else-if="uploaded.length" class="project-status">
          <span class="project-status-icon">&#x1F4C1;</span>
          <span>
            {{ uploaded.length }} file{{ uploaded.length === 1 ? '' : 's' }} uploaded to <code>{{ projectName }}</code>
            &middot; add context or hit send
          </span>
          <button class="project-status-dismiss" @click="uploaded = []" title="Don't mention the upload (the files stay)">&times;</button>
        </div>
        <div v-if="uploadError" class="project-status project-status-error">
          <span>{{ uploadError }}</span>
          <button class="project-status-dismiss" @click="uploadError = null" title="Dismiss">&times;</button>
        </div>

        <SlashMenu
          ref="slashMenuRef"
          :input="input"
          @accept="onSlashAccept"
          @dismiss="onSlashDismiss"
        />

        <div class="input-row">
          <ModeMenu
            :model-value="chat.activeMode"
            :available="chat.availableModes"
            :disabled="!chat.activeChatId || chat.sending"
            @update:model-value="setMode"
          />
          <div class="upload-menu" @focusout="(e: FocusEvent) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) uploadMenuOpen = false }">
            <button
              class="btn-attach"
              :disabled="!projectDir"
              :title="projectDir ? `Upload files or a folder to ${projectName}` : 'Open a chat in a project to upload files'"
              @click="uploadMenuOpen = !uploadMenuOpen"
            >
              <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M21 11.5 12.5 20a5 5 0 0 1-7-7L14 4.5a3.5 3.5 0 0 1 5 5L10.5 18a2 2 0 0 1-3-3L15 7.5" />
              </svg>
            </button>
            <div v-if="uploadMenuOpen" class="upload-menu-list">
              <button @click="pickUpload('file')">Upload files…</button>
              <button @click="pickUpload('directory')">Upload folder…</button>
            </div>
            <input ref="fileInput" type="file" multiple hidden @change="onPicked" />
            <input ref="dirInput" type="file" webkitdirectory hidden @change="onPicked" />
          </div>
          <div class="input-editor">
            <!-- Mirror layer: re-prints the text with the leading /command
                 token colored. Sits behind the transparent textarea. The
                 trailing space makes a final newline render as a line. -->
            <div ref="highlightRef" class="input-highlight" aria-hidden="true">
              <span class="cmd-token">{{ inputSegments.cmd }}</span>{{ inputSegments.rest }}{{ ' ' }}
            </div>
            <textarea
              ref="inputRef"
              v-model="input"
              class="message-input"
              :placeholder="placeholder"
              @keydown="handleKeydown"
              @paste="handlePaste"
              @scroll="syncHighlightScroll"
              rows="1"
            ></textarea>
          </div>
          <button
            v-if="voiceSupportedFlag"
            class="btn-mic"
            :class="{ 'mic-on': voiceOn }"
            :disabled="chat.sending"
            @click="toggleVoice"
            :title="voiceOn ? 'Stop recording' : 'Record voice'"
          >
            <svg v-if="!voiceOn" class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="9" y="3" width="6" height="12" rx="3" />
              <path d="M5 11a7 7 0 0 0 14 0" />
              <line x1="12" y1="18" x2="12" y2="22" />
            </svg>
            <svg v-else class="icon mic-rec" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <circle cx="12" cy="12" r="6" />
            </svg>
          </button>
          <button
            v-if="chat.sending"
            class="btn-stop"
            @click="chat.stopChat()"
            title="Stop"
          >&#9632;</button>
          <button
            v-else
            class="btn-send"
            :disabled="!hasContent"
            @click="send"
            title="Send"
          >&#10148;</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.chat-panel {
  display: flex; flex-direction: column; height: 100%;
  background: var(--bg-primary);
}

.empty-state {
  flex: 1; display: flex; flex-direction: column;
  align-items: center; justify-content: center; color: var(--text-muted);
}
.empty-icon { font-size: 3em; margin-bottom: 16px; opacity: 0.5; }
.empty-state h3 { margin-bottom: 8px; color: var(--text-secondary); }
.empty-state p { font-size: 0.9em; }

.messages-row { flex: 1; min-height: 0; display: flex; }
/* position: relative makes this the offsetParent RequestIndex measures against. */
.messages { flex: 1; min-width: 0; overflow-y: auto; padding: 16px; position: relative; }

.streaming-msg { opacity: 0.95; }

.thinking {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 0; color: var(--text-muted);
}
.thinking-dots { display: flex; gap: 4px; }
.thinking-dots span {
  width: 6px; height: 6px; background: var(--text-muted);
  border-radius: 50%; animation: bounce 1.4s infinite;
}
.thinking-dots span:nth-child(2) { animation-delay: 0.2s; }
.thinking-dots span:nth-child(3) { animation-delay: 0.4s; }
@keyframes bounce {
  0%, 80%, 100% { transform: translateY(0); }
  40% { transform: translateY(-6px); }
}
.thinking-text { font-size: 0.85em; font-style: italic; }

.selection-chip {
  display: flex; align-items: center; gap: 8px; min-width: 0;
  margin-bottom: 8px; padding: 4px 6px 4px 10px;
  border: 1px solid var(--border); border-left: 2px solid var(--accent); border-radius: 6px;
  background: var(--bg-primary); font-size: 0.8em;
}
.selection-label { color: var(--accent); font-weight: 600; flex-shrink: 0; }
.selection-where { color: var(--text-secondary); flex-shrink: 0; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.selection-text {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--text-muted); font-family: var(--font-mono);
}
.selection-remove {
  flex-shrink: 0; width: 20px; height: 20px; border-radius: 4px;
  color: var(--text-muted); font-size: 1.1em; line-height: 1;
}
.selection-remove:hover { color: var(--text-primary); background: var(--bg-tertiary); }

.suggestions { display: flex; gap: 8px; padding: 8px 16px; flex-wrap: wrap; }
.suggestion-btn {
  padding: 6px 14px; background: var(--bg-secondary);
  border: 1px solid var(--border); border-radius: 20px;
  color: var(--text-secondary); font-size: 0.85em;
  transition: all 0.15s; white-space: nowrap;
}
.suggestion-btn:hover {
  background: var(--bg-tertiary); color: var(--accent); border-color: var(--accent);
}

.input-area {
  position: relative;
  padding: 12px 16px; border-top: 1px solid var(--border);
  background: var(--bg-secondary);
}
.input-area.drag-active { background: var(--bg-tertiary); }
.drop-overlay {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 4px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  border: 2px dashed var(--accent);
  border-radius: var(--radius);
  color: var(--accent); font-weight: 600; pointer-events: none;
  z-index: 1;
}
.drop-overlay-sub {
  font-weight: 400; font-size: 0.8em; opacity: 0.85;
}

.project-status {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 8px; padding: 6px 10px;
  background: var(--bg-primary); border: 1px solid var(--border);
  border-radius: var(--radius); font-size: 0.85em; color: var(--text-secondary);
}
.project-status-error {
  border-color: var(--danger); color: var(--danger);
  justify-content: space-between;
}
.project-status code {
  background: var(--bg-tertiary); padding: 0 4px; border-radius: 3px;
  font-size: 0.95em;
}
.project-status-icon { font-size: 1em; }
.project-status-spinner {
  width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--accent) 25%, transparent);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
.project-status-dismiss {
  background: transparent; border: none; color: inherit;
  cursor: pointer; font-size: 1.1em; line-height: 1; padding: 0 4px;
}

.project-status-uploading { flex-direction: column; align-items: stretch; gap: 6px; }
.upload-progress-row {
  display: flex; align-items: center; gap: 8px;
}
.upload-progress-label {
  flex: 1; min-width: 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.upload-progress-label code {
  background: var(--bg-tertiary); padding: 0 4px; border-radius: 3px;
  font-size: 0.95em;
}
.upload-progress-bytes {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums; font-size: 0.92em;
  flex-shrink: 0;
}
.upload-progress-cancel {
  background: transparent; border: 1px solid var(--border);
  color: var(--text-secondary);
  border-radius: 4px; padding: 2px 10px;
  font-size: 0.9em; cursor: pointer; line-height: 1.4;
}
.upload-progress-cancel:hover {
  background: var(--bg-hover); color: var(--danger); border-color: var(--danger);
}
.upload-progress-bar {
  height: 6px; background: var(--bg-tertiary);
  border-radius: 3px; overflow: hidden;
}
.upload-progress-bar-fill {
  height: 100%; background: var(--accent);
  transition: width 0.12s linear;
}

.attachment-strip {
  display: flex; gap: 8px; flex-wrap: wrap;
  margin-bottom: 8px;
}
.attachment-chip {
  position: relative; width: 64px; height: 64px;
  border-radius: var(--radius); overflow: hidden;
  border: 1px solid var(--border); background: var(--bg-primary);
}
.attachment-chip.chip-error { border-color: var(--danger); }
.chip-thumb { width: 100%; height: 100%; object-fit: cover; display: block; }
.chip-progress {
  position: absolute; inset: 0;
  background: color-mix(in srgb, var(--bg-primary) 55%, transparent);
  display: flex; align-items: flex-end; justify-content: center;
  padding-bottom: 4px;
}
.chip-progress-bar {
  position: absolute; left: 0; bottom: 0; height: 3px;
  background: var(--accent);
  transition: width 120ms ease-out;
}
.chip-progress-pct {
  font-size: 0.7em; font-weight: 600;
  color: var(--text-primary);
  background: color-mix(in srgb, var(--bg-primary) 80%, transparent);
  padding: 1px 5px; border-radius: 10px;
}
.chip-error-icon {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: color-mix(in srgb, var(--danger) 30%, transparent);
  color: #fff; font-weight: 700;
}
.chip-remove {
  position: absolute; top: 2px; right: 2px;
  width: 18px; height: 18px; border-radius: 50%;
  background: rgba(0,0,0,0.6); color: #fff; border: none;
  font-size: 0.85em; line-height: 1; cursor: pointer;
  display: flex; align-items: center; justify-content: center;
}
.chip-remove:hover { background: rgba(0,0,0,0.85); }

.input-row { display: flex; gap: 8px; align-items: flex-end; position: relative; z-index: 0; }
/* Wrapper carries the border/background/focus ring. The textarea and the
   highlight mirror share identical inner metrics so their text aligns exactly. */
.input-editor {
  flex: 1; position: relative;
  background: var(--bg-primary);
  border: 1px solid var(--border); border-radius: var(--radius-lg);
}
.input-editor:focus-within { border-color: var(--accent); }

/* Shared box model — these two MUST stay in sync for the overlay to line up. */
.input-highlight,
.message-input {
  padding: 10px 14px;
  /* Grows with the text up to ~a third of the window, then scrolls. */
  min-height: 40px; max-height: clamp(120px, 35vh, 360px);
  font: inherit; font-size: 0.95em; line-height: 1.4;
  white-space: pre-wrap; overflow-wrap: break-word; word-break: break-word;
  box-sizing: border-box;
  /* Reserve the scrollbar lane in both, so wrapping matches once the
     textarea starts scrolling. */
  scrollbar-gutter: stable;
}

.message-input {
  display: block; width: 100%;
  background: transparent; border: none; resize: none;
  color: transparent; caret-color: var(--text-primary);
  position: relative; z-index: 1; overflow-y: auto;
}
.message-input:focus { outline: none; }
.message-input::placeholder { color: var(--text-muted); }

/* Mirror layer behind the textarea: shows the colored command token. */
.input-highlight {
  position: absolute; inset: 0;
  color: var(--text-primary);
  overflow: hidden; pointer-events: none; z-index: 0;
}
.input-highlight .cmd-token { color: var(--accent); }

.btn-send, .btn-stop {
  width: 40px; height: 40px; border-radius: var(--radius);
  border: none; display: flex; align-items: center; justify-content: center;
  font-size: 1.1em;
}
.btn-send { background: var(--accent); color: var(--on-accent); }
.btn-send:disabled { opacity: 0.4; cursor: not-allowed; }
.btn-send:hover:not(:disabled) { background: var(--accent-hover); }
.btn-stop { background: var(--danger); color: #fff; }
.btn-stop:hover { opacity: 0.85; }

.btn-mic {
  width: 40px; height: 40px; border-radius: var(--radius);
  border: 1px solid var(--border); background: var(--bg-primary);
  color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
}
.btn-mic .icon { width: 20px; height: 20px; }
.btn-mic:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.btn-mic:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-mic.mic-on { background: var(--danger); color: #fff; border-color: var(--danger); }
.btn-mic.mic-on .icon { width: 14px; height: 14px; }
.upload-menu { position: relative; flex: none; }
.btn-attach {
  width: 40px; height: 40px; border-radius: var(--radius);
  border: 1px solid var(--border); background: var(--bg-primary);
  color: var(--text-secondary);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
}
.btn-attach .icon { width: 20px; height: 20px; }
.btn-attach:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.btn-attach:disabled { opacity: 0.5; cursor: not-allowed; }
.upload-menu-list {
  position: absolute; bottom: calc(100% + 4px); left: 0; z-index: 20;
  display: flex; flex-direction: column; min-width: 150px; padding: 4px;
  background: var(--bg-secondary); border: 1px solid var(--border);
  border-radius: var(--radius); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}
.upload-menu-list button {
  padding: 6px 10px; text-align: left; font-size: 0.85em;
  background: transparent; border: none; border-radius: 4px; color: var(--text-primary);
}
.upload-menu-list button:hover { background: var(--bg-tertiary); }
.mic-rec { animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
</style>
