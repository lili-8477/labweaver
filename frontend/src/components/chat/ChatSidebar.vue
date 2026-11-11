<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useChatStore } from '@/stores/chat'
import { formatDate } from '@/utils/format'
import type { ChatInfo } from '@/types'

const chat = useChatStore()

/** Clean raw XML/tags from chat names that weren't renamed yet */
function cleanName(name: string | undefined): string {
  if (!name) return 'Untitled'
  // Strip XML-like tags: <USER_REQUEST>, <ACTION>, etc.
  let clean = name.replace(/<[^>]+>/g, '').trim()
  // Truncate long names
  if (clean.length > 50) clean = clean.slice(0, 50) + '...'
  return clean || 'Untitled'
}
const editingId = ref<string | null>(null)
const editName = ref('')
const newProjectName = ref<string | null>(null)

// Folded project groups (by dir; '' = no project), remembered per browser.
const FOLD_KEY = 'labweaver.sidebar.folded'
const folded = ref(new Set<string>(readFolded()))
function readFolded(): string[] {
  try { return JSON.parse(localStorage.getItem(FOLD_KEY) || '[]') } catch { return [] }
}
watch(folded, f => {
  try { localStorage.setItem(FOLD_KEY, JSON.stringify([...f])) } catch { /* private mode */ }
})

// Pinned projects (by dir) sort first, remembered per browser.
const PIN_KEY = 'labweaver.sidebar.pinned'
const pinned = ref(new Set<string>(readPinned()))
function readPinned(): string[] {
  try { return JSON.parse(localStorage.getItem(PIN_KEY) || '[]') } catch { return [] }
}
watch(pinned, p => {
  try { localStorage.setItem(PIN_KEY, JSON.stringify([...p])) } catch { /* private mode */ }
})

interface Group { dir: string; name: string; latest: string; chats: ChatInfo[] }

/** Chats grouped by project folder, plus "No project" for unbound chats.
 *  Only projects with chats are shown (folders without chats are plain data
 *  dirs). Pinned groups first, then by most recent chat; chat.chats is
 *  already newest-first. */
const groups = computed<Group[]>(() => {
  const byDir = new Map<string, ChatInfo[]>()
  for (const c of chat.chats) {
    const dir = c.project_dir || ''
    if (!byDir.has(dir)) byDir.set(dir, [])
    byDir.get(dir)!.push(c)
  }
  const names = new Map(chat.projects.map(p => [p.dir, p.name]))
  const rank = (g: Group) => (pinned.value.has(g.dir) ? 0 : 1)
  return [...byDir].map(([dir, chats]) => ({
    dir,
    name: dir ? names.get(dir) ?? dir.split('/').pop()! : 'No project',
    latest: chats[0]?.last_activity_date || '',
    chats,
  })).sort((a, b) => rank(a) - rank(b) || b.latest.localeCompare(a.latest))
})

// Project "⋯" menu (one open at a time) and inline project rename.
const menuDir = ref<string | null>(null)
const renamingDir = ref<string | null>(null)
const projectName = ref('')
function closeMenu() { menuDir.value = null }
onMounted(() => document.addEventListener('click', closeMenu))
onBeforeUnmount(() => document.removeEventListener('click', closeMenu))

function togglePin(dir: string) {
  const next = new Set(pinned.value)
  if (!next.delete(dir)) next.add(dir)
  pinned.value = next
  closeMenu()
}

function startProjectRename(g: Group) {
  renamingDir.value = g.dir
  projectName.value = g.name
  closeMenu()
}

async function saveProjectRename(dir: string) {
  if (renamingDir.value !== dir) return
  renamingDir.value = null
  const name = projectName.value.trim()
  if (name) await chat.renameProject(dir, name)
}

async function handleDeleteProject(g: Group) {
  closeMenu()
  const n = g.chats.length
  if (!confirm(`Delete project "${g.name}" and its ${n} chat${n === 1 ? '' : 's'}?\n\nThe folder is moved to local_projects/.trash, so its files can be recovered.`)) return
  await chat.deleteProject(g.dir)
  if (pinned.value.has(g.dir)) togglePin(g.dir)
}

function toggle(dir: string) {
  const next = new Set(folded.value)
  if (!next.delete(dir)) next.add(dir)
  folded.value = next
}

async function newChatIn(dir: string) {
  const chatId = await chat.createChat(undefined, dir || undefined)
  if (!chatId) return
  if (folded.value.has(dir)) toggle(dir)
  chat.selectChat(chatId)
}

async function saveNewProject() {
  const name = newProjectName.value?.trim()
  newProjectName.value = null
  if (!name) return
  const dir = await chat.createProject(name)
  if (dir) await newChatIn(dir)
}

function startRename(chatId: string, name: string) {
  editingId.value = chatId
  editName.value = name
}

async function saveRename(chatId: string) {
  if (editName.value.trim()) {
    await chat.updateChatName(chatId, editName.value.trim())
  }
  editingId.value = null
}

async function handleDelete(chatId: string) {
  if (confirm('Delete this chat?')) {
    await chat.deleteChat(chatId)
  }
}
</script>

<template>
  <div class="chat-sidebar">
    <div class="sidebar-header">
      <span class="title">Chats</span>
      <div class="header-actions">
        <button class="btn-project" @click="newProjectName = ''" title="New project">New project</button>
        <button class="btn-new" @click="newChatIn('')" title="New chat without a project">+</button>
      </div>
    </div>

    <div class="chat-list">
      <input
        v-if="newProjectName !== null"
        v-model="newProjectName"
        class="rename-input new-project-input"
        placeholder="Project name, then Enter"
        @keyup.enter="saveNewProject"
        @keyup.escape="newProjectName = null"
        @blur="saveNewProject"
        autofocus
      />

      <div v-for="g in groups" :key="g.dir" class="project">
        <div
          class="project-header"
          :class="{ 'menu-open': menuDir === g.dir }"
          :title="g.dir || 'Chats not bound to a project'"
          @click="toggle(g.dir)"
        >
          <span class="twisty" :class="{ open: !folded.has(g.dir) }">&#9656;</span>
          <input
            v-if="renamingDir === g.dir"
            v-model="projectName"
            class="rename-input"
            @keyup.enter="saveProjectRename(g.dir)"
            @keyup.escape="renamingDir = null"
            @blur="saveProjectRename(g.dir)"
            @click.stop
            autofocus
          />
          <span v-else class="project-name" :class="{ none: !g.dir }">{{ g.name }}</span>
          <span v-if="pinned.has(g.dir)" class="pin-mark" title="Pinned">&#128204;</span>
          <span class="project-count">{{ g.chats.length }}</span>
          <button
            class="action-btn project-new"
            :title="g.dir ? `New chat in ${g.name}` : 'New chat without a project'"
            @click.stop="newChatIn(g.dir)"
          >+</button>
          <div v-if="g.dir" class="project-menu-wrap" @click.stop>
            <button
              class="action-btn project-more"
              title="Project options"
              @click="menuDir = menuDir === g.dir ? null : g.dir"
            >&#8943;</button>
            <div v-if="menuDir === g.dir" class="project-menu">
              <button @click="togglePin(g.dir)">{{ pinned.has(g.dir) ? 'Unpin' : 'Pin' }}</button>
              <button @click="startProjectRename(g)">Rename</button>
              <button class="danger" @click="handleDeleteProject(g)">Delete</button>
            </div>
          </div>
        </div>

        <template v-if="!folded.has(g.dir)">
          <div
            v-for="c in g.chats"
            :key="c.id"
            class="chat-item"
            :class="{ active: c.id === chat.activeChatId }"
            @click="chat.selectChat(c.id)"
          >
            <div class="chat-item-content">
              <template v-if="editingId === c.id">
                <input
                  v-model="editName"
                  class="rename-input"
                  @keyup.enter="saveRename(c.id)"
                  @keyup.escape="editingId = null"
                  @blur="saveRename(c.id)"
                  @click.stop
                  autofocus
                />
              </template>
              <template v-else>
                <div class="chat-name">{{ cleanName(c.name) }}</div>
                <div class="chat-meta">
                  <span v-if="c.running" class="running-dot"></span>
                  {{ formatDate(c.last_activity_date) }}
                </div>
              </template>
            </div>
            <div class="chat-actions" @click.stop>
              <button class="action-btn" @click="startRename(c.id, c.name || '')" title="Rename">
                &#9998;
              </button>
              <button class="action-btn danger" @click="handleDelete(c.id)" title="Delete">
                &times;
              </button>
            </div>
          </div>
          <div v-if="g.chats.length === 0" class="project-empty">No chats yet</div>
        </template>
      </div>

      <div v-if="groups.length === 0" class="empty">
        No chats yet. Click + to start.
      </div>
    </div>
  </div>
</template>

<style scoped>
.chat-sidebar { display: flex; flex-direction: column; height: 100%; }
.sidebar-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 12px 16px; border-bottom: 1px solid var(--border);
}
.title { font-weight: 600; font-size: 0.9em; }
.btn-new {
  width: 28px; height: 28px; background: var(--accent); color: var(--on-accent);
  border: none; border-radius: var(--radius); font-size: 1.2em;
  display: flex; align-items: center; justify-content: center;
  line-height: 1;
}
.btn-new:hover { background: var(--accent-hover); }
.header-actions { display: flex; align-items: center; gap: 6px; }
.btn-project {
  height: 28px; padding: 0 8px; background: transparent; color: var(--text-secondary);
  border: 1px solid var(--border); border-radius: var(--radius); font-size: 0.8em;
}
.btn-project:hover { background: var(--bg-tertiary); color: var(--text-primary); }

.chat-list { flex: 1; overflow-y: auto; padding: 4px 8px; }
.new-project-input { margin: 4px 0 6px; padding: 6px 8px; }

.project { margin-bottom: 4px; }
.project-header {
  display: flex; align-items: center; gap: 4px; padding: 6px 8px;
  border-radius: var(--radius); cursor: pointer; user-select: none;
}
.project-header:hover { background: var(--bg-tertiary); }
.twisty {
  flex: none; width: 22px; height: 22px; color: var(--text-secondary); font-size: 1.35em;
  display: inline-flex; align-items: center; justify-content: center; transition: transform 0.1s;
}
.twisty.open { transform: rotate(90deg); }
.project-name {
  flex: 1; min-width: 0; font-size: 0.85em; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.project-name.none { font-weight: 500; color: var(--text-muted); }
.project-count { font-size: 0.75em; color: var(--text-muted); }
.project-new, .project-more { opacity: 0; transition: opacity 0.1s; }
.project-header:hover .project-new, .project-header:hover .project-more,
.project-header.menu-open .project-more { opacity: 1; }
.pin-mark { font-size: 0.7em; opacity: 0.8; }
.project-menu-wrap { position: relative; }
.project-menu {
  position: absolute; right: 0; top: 26px; z-index: 20; min-width: 120px;
  display: flex; flex-direction: column; padding: 4px;
  background: var(--bg-elevated); border: 1px solid var(--border);
  -webkit-backdrop-filter: var(--glass-filter); backdrop-filter: var(--glass-filter);
  border-radius: var(--radius); box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}
.project-menu button {
  padding: 6px 10px; text-align: left; background: transparent; border: none;
  color: var(--text-primary); border-radius: 4px; font-size: 0.85em;
}
.project-menu button:hover { background: var(--bg-tertiary); }
.project-menu button.danger { color: var(--danger); }
.project-empty { padding: 2px 0 6px 28px; font-size: 0.75em; color: var(--text-muted); }

.chat-item {
  display: flex; align-items: center; padding: 8px 12px 8px 28px;
  border-radius: var(--radius); cursor: pointer;
  margin-bottom: 2px; transition: background 0.1s;
}
.chat-item:hover { background: var(--bg-tertiary); }
.chat-item.active { background: var(--bg-tertiary); border-left: 2px solid var(--accent); }
.chat-item-content { flex: 1; min-width: 0; }
.chat-name {
  font-size: 0.9em; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis;
}
.chat-meta {
  font-size: 0.75em; color: var(--text-muted);
  display: flex; align-items: center; gap: 4px;
}
.running-dot {
  width: 6px; height: 6px; border-radius: 50%; background: var(--success);
  display: inline-block; animation: pulse 1.5s infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.chat-actions { display: flex; gap: 2px; opacity: 0; transition: opacity 0.1s; }
.chat-item:hover .chat-actions { opacity: 1; }
.action-btn {
  width: 24px; height: 24px; background: transparent; border: none;
  color: var(--text-muted); border-radius: 4px; font-size: 0.9em;
  display: flex; align-items: center; justify-content: center;
}
.action-btn:hover { background: var(--bg-hover); color: var(--text-primary); }
.action-btn.danger:hover { color: var(--danger); }

.rename-input {
  width: 100%; padding: 2px 4px; background: var(--bg-primary);
  border: 1px solid var(--accent); border-radius: 3px;
  color: var(--text-primary); font-size: 0.9em;
}

.empty {
  padding: 20px 16px; text-align: center;
  color: var(--text-muted); font-size: 0.85em;
}
</style>
