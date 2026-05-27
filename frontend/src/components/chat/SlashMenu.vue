<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue'
import { commandsService } from '@/services/commands'
import { useSkillsStore } from '@/stores/skills'
import type { CommandSummary } from '@/types/commands'
import type { SkillSummary } from '@/types/skills'

interface SlashItem {
  kind: 'command' | 'skill'
  name: string
  description: string
}

const props = defineProps<{
  /** Full textarea value. Component decides whether to show itself. */
  input: string
}>()

const emit = defineEmits<{
  /** User accepted an item. Parent rewrites the input. */
  (e: 'accept', item: SlashItem): void
  /** User dismissed with Escape. Parent may clear leading "/". */
  (e: 'dismiss'): void
}>()

const skills = useSkillsStore()
const commands = ref<CommandSummary[]>([])
const commandsLoaded = ref(false)
const selected = ref(0)

const open = computed(() => props.input.startsWith('/'))

// Filter is the first token after the leading slash. "/br foo" -> "br".
const filter = computed(() => {
  if (!open.value) return ''
  const rest = props.input.slice(1)
  const ws = rest.search(/\s/)
  return (ws === -1 ? rest : rest.slice(0, ws)).toLowerCase()
})

async function ensureLoaded() {
  if (!commandsLoaded.value) {
    try { commands.value = await commandsService.list() }
    catch { commands.value = [] }
    commandsLoaded.value = true
  }
  if (skills.skills.length === 0 && !skills.loading) {
    await skills.load()
  }
}

watch(open, (isOpen) => {
  if (isOpen) ensureLoaded()
  selected.value = 0
})

watch(filter, () => { selected.value = 0 })

onMounted(() => { if (open.value) ensureLoaded() })

const matchedCommands = computed<SlashItem[]>(() =>
  commands.value
    .filter(c => c.name.toLowerCase().includes(filter.value))
    .map(c => ({ kind: 'command', name: c.name, description: c.description }))
)

const matchedSkills = computed<SlashItem[]>(() =>
  skills.skills
    .filter((s: SkillSummary) => s.name.toLowerCase().includes(filter.value))
    .map((s: SkillSummary) => ({ kind: 'skill', name: s.name, description: s.description }))
)

// Flat list in render order: commands first, then skills.
const flat = computed<SlashItem[]>(() => [...matchedCommands.value, ...matchedSkills.value])

watch(flat, (list) => {
  if (selected.value >= list.length) selected.value = Math.max(0, list.length - 1)
})

// Public API consumed by the parent's @keydown handler. Returns true when the
// menu handled the key (parent should preventDefault and skip its own logic).
function handleKey(e: KeyboardEvent): boolean {
  if (!open.value || flat.value.length === 0) {
    // Esc on an open-but-empty menu still dismisses.
    if (open.value && e.key === 'Escape') { emit('dismiss'); return true }
    return false
  }
  switch (e.key) {
    case 'ArrowDown':
      selected.value = (selected.value + 1) % flat.value.length
      return true
    case 'ArrowUp':
      selected.value = (selected.value - 1 + flat.value.length) % flat.value.length
      return true
    case 'Enter':
    case 'Tab':
      emit('accept', flat.value[selected.value])
      return true
    case 'Escape':
      emit('dismiss')
      return true
    default:
      return false
  }
}

defineExpose({ handleKey })

function clickItem(idx: number) {
  selected.value = idx
  emit('accept', flat.value[idx])
}
</script>

<template>
  <div v-if="open && flat.length > 0" class="slash-menu" role="listbox">
    <template v-if="matchedCommands.length > 0">
      <div class="slash-section">Commands</div>
      <div
        v-for="(c, i) in matchedCommands"
        :key="'cmd:' + c.name"
        class="slash-item"
        :class="{ 'is-selected': selected === i }"
        role="option"
        :aria-selected="selected === i"
        @mouseenter="selected = i"
        @mousedown.prevent="clickItem(i)"
      >
        <span class="slash-name">/{{ c.name }}</span>
        <span class="slash-desc">{{ c.description }}</span>
      </div>
    </template>
    <template v-if="matchedSkills.length > 0">
      <div class="slash-section">Skills</div>
      <div
        v-for="(s, j) in matchedSkills"
        :key="'skill:' + s.name"
        class="slash-item"
        :class="{ 'is-selected': selected === matchedCommands.length + j }"
        role="option"
        :aria-selected="selected === matchedCommands.length + j"
        @mouseenter="selected = matchedCommands.length + j"
        @mousedown.prevent="clickItem(matchedCommands.length + j)"
      >
        <span class="slash-name">{{ s.name }}</span>
        <span class="slash-desc">{{ s.description }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.slash-menu {
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: calc(100% + 6px);
  max-height: 280px;
  overflow-y: auto;
  background: var(--bg-secondary, #1a1a1a);
  border: 1px solid var(--border, #333);
  border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25);
  padding: 4px 0;
  z-index: 10;
  font-size: 13px;
}
.slash-section {
  padding: 6px 12px 2px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted, #888);
}
.slash-item {
  display: flex;
  gap: 12px;
  align-items: baseline;
  padding: 6px 12px;
  cursor: pointer;
}
.slash-item.is-selected { background: var(--bg-tertiary, #2a2a2a); }
.slash-name { font-weight: 600; }
.slash-desc {
  color: var(--text-muted, #888);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
</style>
