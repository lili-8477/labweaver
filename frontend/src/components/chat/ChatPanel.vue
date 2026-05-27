<script setup lang="ts">
import { ref, nextTick, watch, computed, onMounted, onBeforeUnmount } from 'vue'
import { storeToRefs } from 'pinia'
import { useChatStore } from '@/stores/chat'
import { isDisplayableMessage, extractTextContent } from '@/utils/content'
import type { ChatMessage } from '@/types'
import ChatMessageComp from '@/components/chat/ChatMessage.vue'
import ExecutionTimeline from '@/components/chat/ExecutionTimeline.vue'
import HarnessChecklist from '@/components/chat/HarnessChecklist.vue'
import { isImage, makeAttachment, uploadAttachment, discardAttachmentFile, type ChatAttachment } from '@/services/chat-attachments'
import { createProjectWithFiles, composeKickoffMessage, type CreatedProject } from '@/services/project-from-drop'
import { queueUpload, cancelUpload } from '@/services/upload'
import { useUploadsStore } from '@/stores/uploads'
import { formatFileSize } from '@/utils/format'
import { isSupported as voiceSupported, startVoice, type VoiceSession } from '@/services/voice'
import SlashMenu from '@/components/chat/SlashMenu.vue'
import { useChatHints } from '@/composables/useChatHints'

const chat = useChatStore()
const uploads = useUploadsStore()
const input = ref('')
const messagesEl = ref<HTMLElement | null>(null)

const attachments = ref<ChatAttachment[]>([])
const isDragging = ref(false)
const dragDepth = ref(0)
const creatingProject = ref(false)
const projectError = ref<string | null>(null)
// IDs of upload entries belonging to the in-flight project drop. Used to
// look up live progress in the uploads store and to cancel the whole batch.
const creatingProjectIds = ref<string[]>([])
const projectCanceled = ref(false)

const activeProjectUpload = computed(() => {
  for (const id of creatingProjectIds.value) {
    const u = uploads.items.find(i => i.id === id)
    if (u && (u.state === 'uploading' || u.state === 'pending')) return u
  }
  return null
})
const activeProjectPct = computed(() => {
  const u = activeProjectUpload.value
  if (!u || u.totalBytes <= 0) return 0
  return Math.min(100, Math.floor((u.bytesSent / u.totalBytes) * 100))
})

function cancelProjectUpload() {
  projectCanceled.value = true
  for (const id of creatingProjectIds.value) cancelUpload(id)
}
// A drop creates the project + uploads files, but the kickoff message waits
// here until the user actually hits Send. They can type more context first,
// or just send for the default "what can you do with this" overview.
const pendingProject = ref<CreatedProject | null>(null)
const voiceOn = ref(false)
const voiceSupportedFlag = voiceSupported()
let voiceSession: VoiceSession | null = null
// Text already in the textarea when recording starts; new transcript is
// appended to it so we don't clobber a partially-typed message.
let voiceBaseText = ''

const slashMenuRef = ref<InstanceType<typeof SlashMenu> | null>(null)
const inputRef = ref<HTMLTextAreaElement | null>(null)

const { messages: chatMessages } = storeToRefs(chat)
const hints = useChatHints({
  messages:       chatMessages,
  attachments,
  pendingProject,
})

const anyUploading = computed(() => attachments.value.some(a => a.state === 'uploading'))
const hasContent = computed(
  () => (
    input.value.trim().length > 0
    || attachments.value.some(a => a.state === 'done')
    || pendingProject.value !== null
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

function send() {
  if (!hasContent.value || chat.sending) return
  if (voiceOn.value) stopVoice()
  const paths = attachments.value
    .filter(a => a.state === 'done' && a.workspacePath)
    .map(a => a.workspacePath)
  const text = pendingProject.value
    ? composeKickoffMessage(pendingProject.value, input.value.trim())
    : input.value.trim()
  pendingProject.value = null
  chat.sendMessage(text, paths)
  input.value = ''
  clearAttachments()
}

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

function onDragEnter(e: DragEvent) {
  if (!hasFilesInDrag(e)) return
  e.preventDefault()
  dragDepth.value++
  isDragging.value = true
}
function onDragOver(e: DragEvent) {
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
  const fileList = e.dataTransfer.files
  if (!fileList || fileList.length === 0) return
  const all = Array.from(fileList)
  // Images keep attaching to the current chat. Anything else (CSV, FASTQ,
  // PDF, …) kicks off a brand-new project in local_projects/ and opens a
  // fresh chat bound to that folder.
  const images = all.filter(isImage)
  const others = all.filter(f => !isImage(f))
  if (images.length > 0) addFiles(images)
  if (others.length > 0) void startProjectFromFiles(others)
}
function hasFilesInDrag(e: DragEvent): boolean {
  const types = e.dataTransfer?.types
  if (!types) return false
  // dataTransfer.items isn't reliable across browsers during dragenter, so we
  // accept any drag carrying Files; onDrop decides how to route each file.
  for (let i = 0; i < types.length; i++) if (types[i] === 'Files') return true
  return false
}

// ---- Drop-to-project ----

async function startProjectFromFiles(files: File[]) {
  if (creatingProject.value || chat.sending) return
  creatingProject.value = true
  creatingProjectIds.value = []
  projectCanceled.value = false
  projectError.value = null
  try {
    if (pendingProject.value) {
      // Additional files dropped before the user sent — append them to the
      // pending project rather than creating a second one.
      const proj = pendingProject.value
      for (const f of files) {
        if (projectCanceled.value) break
        const { id, promise } = queueUpload(f, proj.projectDir)
        creatingProjectIds.value.push(id)
        await promise
        if (projectCanceled.value) break
        proj.files.push({ name: f.name, workspacePath: `${proj.workspaceDir}/${f.name}` })
      }
    } else {
      pendingProject.value = await createProjectWithFiles(files, {
        onUploadQueued: (id) => { creatingProjectIds.value.push(id) },
        isCanceled: () => projectCanceled.value,
      })
    }
  } catch (err) {
    // User-initiated cancel surfaces as Error('canceled') — not an error path.
    if (!projectCanceled.value && (err as Error)?.message !== 'canceled') {
      projectError.value = (err as Error)?.message || String(err)
    }
  } finally {
    creatingProject.value = false
    creatingProjectIds.value = []
    projectCanceled.value = false
  }
}

function discardPendingProject() {
  pendingProject.value = null
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

// Harness polling. Two timers run independently because the cadences and
// life-cycles differ:
//
//   - mode (active/installed) — every 5s for the whole life of ChatPanel.
//     Cheap, and it's how we detect a restart that wipes the marker file or
//     an external toggle (AgentPanel) flipping the mode on while we sit on
//     a chat with no progress yet.
//
//   - progress.md — variable cadence depending on activity:
//       running + sending → 3s   (a tick is in flight, items change fast)
//       running + idle    → 8s   (between ticks)
//       stopped + has progress → 30s (sticky final state; mostly to catch
//                                     manual edits, slow but cheap)
//       no progress, not active → no poll (nothing to read)
//     The point is to keep the checklist live during /tick but not hammer
//     NATS when the run has stopped. The stopped-state poll exists so that
//     if the user manually edits progress.md, or kicks /tick off again,
//     the view eventually catches up without a chat re-select.
let harnessModeTimer: number | null = null
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
  if (harnessModeTimer != null) { clearInterval(harnessModeTimer); harnessModeTimer = null }
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
  harnessModeTimer = window.setInterval(() => { void chat.refreshHarnessMode() }, 5000)
  void chat.refreshHarnessMode()
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

// If the user navigates to a different chat before sending, the pending
// kickoff no longer makes sense — drop it. The project folder + files stay
// on disk; only the unsent kickoff is discarded.
watch(() => chat.activeChatId, (id) => {
  if (pendingProject.value && pendingProject.value.chatId !== id) {
    pendingProject.value = null
  }
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
           stays visible as the scroll grows. Visible whenever the mode is on
           OR this session has a progress.md — once a run produces a plan,
           the checklist sticks around as a record even after the harness
           toggles off. The component itself collapses to just the banner
           if the user folds it. -->
      <HarnessChecklist
        v-if="chat.harnessActive || chat.harnessProgress"
        :active="chat.harnessActive"
        :progress="chat.harnessProgress"
        :project-name="chat.harnessProject"
        :chat-id="chat.activeChatId"
      />

      <div ref="messagesEl" class="messages">
        <!-- Rendered messages with inline timelines -->
        <template v-for="(msg, i) in displayMessages" :key="i">
          <ChatMessageComp v-if="hasBubbleBody(msg)" :message="msg" />
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

      <!-- Hints -->
      <div v-if="hints.length > 0 && !chat.sending" class="suggestions">
        <button
          v-for="h in hints"
          :key="h.id"
          class="suggestion-btn"
          @click="applyHint(h.text)"
        >
          {{ h.text }}
        </button>
      </div>

      <!-- Input -->
      <div
        class="input-area"
        :class="{ 'drag-active': isDragging }"
      >
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
          <div>Drop file</div>
          <div class="drop-overlay-sub">images attach &middot; everything else starts a new project</div>
        </div>

        <div v-if="creatingProject" class="project-status project-status-uploading">
          <div class="upload-progress-row">
            <span class="project-status-spinner"></span>
            <span class="upload-progress-label">
              <template v-if="activeProjectUpload">
                Uploading <code>{{ activeProjectUpload.fileName }}</code>
              </template>
              <template v-else>
                Preparing project…
              </template>
            </span>
            <span v-if="activeProjectUpload" class="upload-progress-bytes">
              {{ formatFileSize(activeProjectUpload.bytesSent) }} /
              {{ formatFileSize(activeProjectUpload.totalBytes) }}
              · {{ activeProjectPct }}%
            </span>
            <button
              class="upload-progress-cancel"
              @click="cancelProjectUpload"
              title="Cancel upload"
            >Cancel</button>
          </div>
          <div v-if="activeProjectUpload" class="upload-progress-bar">
            <div
              class="upload-progress-bar-fill"
              :style="{ width: activeProjectPct + '%' }"
            ></div>
          </div>
        </div>
        <div v-else-if="pendingProject" class="project-status">
          <span class="project-status-icon">&#x1F4C1;</span>
          <span>
            Project <code>{{ pendingProject.projectName }}</code> ready &middot;
            {{ pendingProject.files.length }} file{{ pendingProject.files.length === 1 ? '' : 's' }} &middot;
            add context or hit send
          </span>
          <button class="project-status-dismiss" @click="discardPendingProject" title="Discard pending project">&times;</button>
        </div>
        <div v-if="projectError" class="project-status project-status-error">
          <span>Project creation failed: {{ projectError }}</span>
          <button class="project-status-dismiss" @click="projectError = null" title="Dismiss">&times;</button>
        </div>

        <SlashMenu
          ref="slashMenuRef"
          :input="input"
          @accept="onSlashAccept"
          @dismiss="onSlashDismiss"
        />

        <div class="input-row">
          <textarea
            ref="inputRef"
            v-model="input"
            class="message-input"
            placeholder="Type a message. Drop an image to attach, or any other file to start a new project."
            @keydown="handleKeydown"
            @paste="handlePaste"
            rows="1"
          ></textarea>
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

.messages { flex: 1; overflow-y: auto; padding: 16px; }

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
.message-input {
  flex: 1; padding: 10px 14px; background: var(--bg-primary);
  border: 1px solid var(--border); border-radius: var(--radius-lg);
  color: var(--text-primary); resize: none;
  min-height: 40px; max-height: 200px;
  font-size: 0.95em; line-height: 1.4;
}
.message-input:focus { outline: none; border-color: var(--accent); }

.btn-send, .btn-stop {
  width: 40px; height: 40px; border-radius: var(--radius);
  border: none; display: flex; align-items: center; justify-content: center;
  font-size: 1.1em;
}
.btn-send { background: var(--accent); color: #fff; }
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
.mic-rec { animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
</style>
