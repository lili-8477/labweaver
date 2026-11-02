<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { natsService } from '@/services/nats'

const MODELS = [
  { id: 'claude-fable-5-1',   label: 'Fable 5.1',   hint: 'Most capable · most expensive' },
  { id: 'claude-opus-5-5',    label: 'Opus 5.5',    hint: 'Strong reasoning' },
  { id: 'claude-sonnet-5-5',  label: 'Sonnet 5.5',  hint: 'Balanced · default' },
  { id: 'claude-haiku-5-5',   label: 'Haiku 5.5',   hint: 'Cheapest · fastest' },
] as const

const current = ref<string>('claude-sonnet-5-5')
const saving = ref(false)
const error = ref<string>('')

async function loadCurrent() {
  try {
    const res = await natsService.invoke('get_model') as { success: boolean; model: string }
    if (res?.success) current.value = res.model
  } catch (e) {
    console.warn('get_model failed:', e)
  }
}

async function onChange(e: Event) {
  const model = (e.target as HTMLSelectElement).value
  saving.value = true
  error.value = ''
  try {
    const res = await natsService.invoke('set_model', { model }) as { success: boolean; model: string }
    if (res?.success) current.value = res.model
  } catch (err) {
    error.value = (err as Error).message
    // Revert select UI to last-known good value
    ;(e.target as HTMLSelectElement).value = current.value
  } finally {
    saving.value = false
  }
}

onMounted(loadCurrent)
</script>

<template>
  <label class="model-select" :title="error || 'Claude model for new chat turns'">
    <span class="label">Model</span>
    <select :value="current" :disabled="saving" @change="onChange">
      <option v-for="m in MODELS" :key="m.id" :value="m.id" :title="m.hint">{{ m.label }}</option>
    </select>
  </label>
</template>

<style scoped>
.model-select {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 2px 6px 2px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: var(--bg-secondary);
  font-size: var(--text-sm);
}
.label {
  font-size: var(--text-2xs);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
select {
  background: transparent;
  color: var(--text-primary);
  border: none;
  padding: 4px 4px 4px 2px;
  font-size: var(--text-sm);
  font-family: inherit;
  cursor: pointer;
}
select:disabled { opacity: 0.6; cursor: wait; }
select:focus { outline: none; }
</style>
