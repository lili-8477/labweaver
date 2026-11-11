<script setup lang="ts">
// The "share with the org?" dialog: a title and description from the caller,
// an optional note, and Submit. Used for folders, skills and memories.
import { ref } from 'vue'
import { useShareStore } from '@/stores/share'
import type { ArtifactKind } from '@/types/share'

const props = defineProps<{ kind: ArtifactKind; artifactRef: string }>()
const emit  = defineEmits<{ (e: 'close'): void }>()

const note       = ref('')
const submitting = ref(false)
const errorMsg   = ref('')

const share = useShareStore()

async function onSubmit() {
  submitting.value = true
  errorMsg.value = ''
  try {
    await share.submit({ kind: props.kind, ref: props.artifactRef, note: note.value.trim() || undefined })
    emit('close')
  } catch (e) {
    errorMsg.value = (e as Error).message
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div class="modal-overlay" @click.self="emit('close')">
      <div class="modal" role="dialog">
        <h3><slot name="title" /></h3>
        <p class="modal-desc"><slot /></p>
        <textarea v-model="note" rows="3" maxlength="500" placeholder="Why are you sharing this? (optional)" />
        <p v-if="errorMsg" class="modal-error">{{ errorMsg }}</p>
        <div class="modal-actions">
          <button @click="emit('close')" :disabled="submitting">Cancel</button>
          <button class="primary" @click="onSubmit" :disabled="submitting">
            {{ submitting ? 'Submitting…' : 'Submit' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  position: fixed; inset: 0; background: rgba(0,0,0,0.4);
  display: flex; align-items: center; justify-content: center; z-index: 1000;
}
.modal {
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: var(--radius); padding: var(--space-4); width: min(440px, 90vw);
  display: flex; flex-direction: column; gap: var(--space-2);
}
.modal h3 { margin: 0; }
.modal-desc { font-size: var(--text-xs); color: var(--text-muted); margin: 0; }
.modal-desc :slotted(code) { font-family: var(--font-mono); }
.modal-desc:empty { display: none; }
.modal textarea { width: 100%; padding: var(--space-2); resize: vertical; }
.modal-error { color: var(--danger); font-size: var(--text-xs); margin: 0; }
.modal-actions { display: flex; gap: var(--space-2); justify-content: flex-end; }
.modal-actions button {
  padding: var(--space-1) var(--space-3); border-radius: var(--radius);
  border: 1px solid var(--border); background: var(--bg-secondary); cursor: pointer;
}
.modal-actions button.primary { background: var(--accent); color: var(--on-accent); border-color: var(--accent); }
.modal-actions button:disabled { opacity: 0.5; cursor: default; }
</style>
