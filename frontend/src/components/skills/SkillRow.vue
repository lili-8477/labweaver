<script setup lang="ts">
import { ref, computed } from 'vue'
import type { SkillSummary } from '@/types/skills'
import { useSkillsStore } from '@/stores/skills'

const props = defineProps<{ skill: SkillSummary }>()

const showModal  = ref(false)
const note       = ref('')
const submitting = ref(false)
const errorMsg   = ref('')

const skills   = useSkillsStore()
const isUpdate = computed(() => skills.isOrgSkill(props.skill.name))

async function onSubmit(name: string) {
  submitting.value = true
  errorMsg.value = ''
  try {
    if (isUpdate.value) {
      await skills.submitUpdate(name, note.value || undefined)
    } else {
      await skills.submitShare(name, note.value || undefined)
    }
    showModal.value = false
    note.value = ''
  } catch (e) {
    errorMsg.value = (e as Error).message
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <div class="skill-row">
    <div class="skill-meta">
      <div class="skill-name">{{ skill.name }}</div>
      <div v-if="skill.description" class="skill-desc">{{ skill.description }}</div>
    </div>
    <button class="btn-share" @click="showModal = true">{{ isUpdate ? 'Submit update' : 'Share' }}</button>
  </div>

  <Teleport to="body">
    <div v-if="showModal" class="modal-overlay" @click.self="showModal = false">
      <div class="modal">
        <h3 v-if="isUpdate">Submit update to <strong>{{ skill.name }}</strong></h3>
        <h3 v-else>Share <strong>{{ skill.name }}</strong> with the org?</h3>
        <p v-if="isUpdate" class="modal-desc">
          This will atomically replace the existing org skill at
          <code>/workspace/shared/skills/{{ skill.name }}</code>
          when the manager approves.
        </p>
        <p v-else-if="skill.description" class="modal-desc">{{ skill.description }}</p>
        <textarea v-model="note" rows="3" placeholder="Why are you sharing this? (optional)" />
        <p v-if="errorMsg" class="modal-error">{{ errorMsg }}</p>
        <div class="modal-actions">
          <button @click="showModal = false" :disabled="submitting">Cancel</button>
          <button class="primary" @click="onSubmit(skill.name)" :disabled="submitting">
            {{ submitting ? 'Submitting…' : 'Submit' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.skill-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--space-3); padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-soft);
}
.skill-meta { min-width: 0; flex: 1; }
.skill-name { font-weight: var(--fw-semi); font-size: var(--text-sm); color: var(--text-primary); }
.skill-desc { font-size: var(--text-xs); color: var(--text-muted); margin-top: 2px;
              overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btn-share {
  padding: var(--space-1) var(--space-3); border-radius: var(--radius);
  font-size: var(--text-xs); border: 1px solid var(--border);
  background: var(--bg-secondary); color: var(--text-primary); cursor: pointer;
}
.btn-share:hover { background: var(--bg-hover); }

.modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.4);
  display: flex; align-items: center; justify-content: center; z-index: 1000;
}
.modal {
  background: var(--bg-primary); border: 1px solid var(--border);
  border-radius: var(--radius); padding: var(--space-4); width: min(420px, 90vw);
  display: flex; flex-direction: column; gap: var(--space-2);
}
.modal-desc { font-size: var(--text-xs); color: var(--text-muted); margin: 0; }
.modal textarea { width: 100%; padding: var(--space-2); resize: vertical; }
.modal-error { color: var(--danger); font-size: var(--text-xs); margin: 0; }
.modal-actions { display: flex; gap: var(--space-2); justify-content: flex-end; }
.modal-actions button {
  padding: var(--space-1) var(--space-3); border-radius: var(--radius);
  border: 1px solid var(--border); background: var(--bg-secondary); cursor: pointer;
}
.modal-actions button.primary { background: var(--accent); color: white; border-color: var(--accent); }
.modal-actions button:disabled { opacity: 0.5; cursor: default; }
</style>
