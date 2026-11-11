<script setup lang="ts">
// Composer mode menu: how the active chat runs its turns. The mode is kept per
// chat in the chat store, so switching here never affects other chats.
import { ref, computed, onBeforeUnmount } from 'vue'
import type { ChatMode } from '@/types'

const props = defineProps<{
  modelValue: ChatMode
  /** Modes whose command is installed; the rest are shown greyed out. */
  available: ChatMode[]
  disabled?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [mode: ChatMode] }>()

const MODES: { id: ChatMode; label: string; desc: string }[] = [
  { id: 'chat', label: 'Chat', desc: 'Back-and-forth with the agent.' },
  { id: 'auto', label: 'Auto', desc: 'For your next message: plans, runs and reviews each step until progress.md is complete.' },
  { id: 'team', label: 'Team', desc: 'A lead agent splits the work among named teammates on a shared task board.' },
]

const open = ref(false)
const root = ref<HTMLElement | null>(null)
const current = computed(() => MODES.find(m => m.id === props.modelValue) ?? MODES[0])

function onDocClick(e: MouseEvent) {
  if (!root.value?.contains(e.target as Node)) close()
}
function toggle() {
  open.value = !open.value
  if (open.value) document.addEventListener('mousedown', onDocClick)
  else document.removeEventListener('mousedown', onDocClick)
}
function close() {
  open.value = false
  document.removeEventListener('mousedown', onDocClick)
}
function pick(id: ChatMode) {
  if (id !== props.modelValue) emit('update:modelValue', id)
  close()
}
onBeforeUnmount(close)
</script>

<template>
  <div ref="root" class="mode-menu">
    <button
      class="mode-trigger"
      :class="{ active: modelValue !== 'chat' }"
      :disabled="disabled"
      :title="`Mode: ${current.label}`"
      aria-haspopup="listbox"
      :aria-expanded="open"
      @click="toggle"
      @keydown.escape="close"
    >
      {{ current.label }}<span class="caret" aria-hidden="true">&#9662;</span>
    </button>
    <ul v-if="open" class="mode-list" role="listbox">
      <li
        v-for="m in MODES"
        :key="m.id"
        role="option"
        :aria-selected="m.id === modelValue"
        :aria-disabled="!available.includes(m.id)"
        class="mode-item"
        :class="{ selected: m.id === modelValue, unavailable: !available.includes(m.id) }"
        @click="available.includes(m.id) && pick(m.id)"
      >
        <span class="mode-name">{{ m.label }}</span>
        <span class="mode-desc">
          {{ available.includes(m.id) ? m.desc : 'Not installed for this workspace.' }}
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.mode-menu { position: relative; }
.mode-trigger {
  height: 40px; padding: 0 10px 0 12px;
  border-radius: var(--radius);
  border: 1px solid var(--border); background: var(--bg-primary);
  color: var(--text-secondary); font: inherit; font-size: 0.85em;
  display: flex; align-items: center; gap: 6px; cursor: pointer;
}
.mode-trigger:hover:not(:disabled) { color: var(--accent); border-color: var(--accent); }
.mode-trigger:disabled { opacity: 0.5; cursor: not-allowed; }
.mode-trigger.active { color: var(--accent); border-color: var(--accent); }
.caret { font-size: 0.75em; opacity: 0.7; }

.mode-list {
  position: absolute; left: 0; bottom: calc(100% + 6px);
  width: 260px; margin: 0; padding: 4px 0; list-style: none;
  background: var(--bg-elevated);
  -webkit-backdrop-filter: var(--glass-filter);
  backdrop-filter: var(--glass-filter);
  border: 1px solid var(--border); border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25);
  z-index: 10; font-size: 13px;
}
.mode-item { display: flex; flex-direction: column; gap: 2px; padding: 6px 12px; cursor: pointer; }
.mode-item:hover, .mode-item.selected { background: var(--bg-tertiary); }
.mode-item.unavailable { opacity: 0.5; cursor: not-allowed; }
.mode-name { font-weight: 600; }
.mode-item.selected .mode-name { color: var(--accent); }
.mode-desc { color: var(--text-muted); font-size: 12px; }
</style>
