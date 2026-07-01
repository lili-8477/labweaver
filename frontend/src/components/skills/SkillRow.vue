<script setup lang="ts">
import { ref, computed } from 'vue'
import type { SkillSummary } from '@/types/skills'
import { useSkillsStore } from '@/stores/skills'
import { skillsService } from '@/services/skills'

const props = defineProps<{ skill: SkillSummary }>()

const showModal  = ref(false)
const note       = ref('')
const submitting = ref(false)
const errorMsg   = ref('')

// Lazy-loaded SKILL.md preview. Fetched on first expand and cached for the
// life of the row — the user re-opens the row, not the manifest.
const expanded     = ref(false)
const manifest     = ref<string | null>(null)
const manifestErr  = ref<string | null>(null)
const loadingMan   = ref(false)

const skills   = useSkillsStore()
const isUpdate = computed(() => skills.isOrgSkill(props.skill.name))

async function toggleExpand() {
  if (expanded.value) {
    expanded.value = false
    return
  }
  expanded.value = true
  if (manifest.value != null || loadingMan.value) return
  loadingMan.value = true
  manifestErr.value = null
  try {
    manifest.value = await skillsService.getManifest(props.skill.name)
  } catch (e) {
    manifestErr.value = (e as Error).message
  } finally {
    loadingMan.value = false
  }
}

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
  <div class="skill-row-wrap">
    <div class="skill-row">
      <button
        class="skill-meta"
        :aria-expanded="expanded"
        :aria-label="`${expanded ? 'Hide' : 'Show'} SKILL.md for ${skill.name}`"
        @click="toggleExpand"
      >
        <span class="caret" :class="{ open: expanded }">▸</span>
        <span class="meta-text">
          <span class="skill-name">{{ skill.name }}</span>
          <span v-if="skill.description" class="skill-desc">{{ skill.description }}</span>
        </span>
      </button>
      <button class="btn-share" @click="showModal = true">{{ isUpdate ? 'Submit update' : 'Share' }}</button>
    </div>

    <div v-if="expanded" class="manifest-pane">
      <div v-if="loadingMan" class="manifest-status">Loading…</div>
      <div v-else-if="manifestErr" class="manifest-status error">{{ manifestErr }}</div>
      <pre v-else-if="manifest" class="manifest-body">{{ manifest }}</pre>
      <p class="manifest-hint">
        Read-only preview of <code>~/.claude/skills/{{ skill.name }}/SKILL.md</code>.
        Edit the file in your workspace, then click <strong>{{ isUpdate ? 'Submit update' : 'Share' }}</strong>.
      </p>
    </div>
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
.skill-row-wrap { border-bottom: 1px solid var(--border-soft); }
.skill-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--space-3); padding: var(--space-3) var(--space-4);
}
.skill-meta {
  min-width: 0; flex: 1; display: flex; align-items: flex-start; gap: var(--space-2);
  background: transparent; border: 0; padding: 0; text-align: left; cursor: pointer;
  color: inherit; font: inherit;
}
.skill-meta:hover .skill-name { color: var(--accent); }
.meta-text { min-width: 0; flex: 1; display: flex; flex-direction: column; }
.caret {
  display: inline-block; font-size: var(--text-2xs); color: var(--text-muted);
  width: 10px; line-height: 1.4; flex-shrink: 0; transition: transform 0.12s;
}
.caret.open { transform: rotate(90deg); }
.skill-name { font-weight: var(--fw-semi); font-size: var(--text-sm); color: var(--text-primary); }
.skill-desc { font-size: var(--text-xs); color: var(--text-muted); margin-top: 2px;
              overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.btn-share {
  padding: var(--space-1) var(--space-3); border-radius: var(--radius);
  font-size: var(--text-xs); border: 1px solid var(--border);
  background: var(--bg-secondary); color: var(--text-primary); cursor: pointer;
  flex-shrink: 0;
}
.btn-share:hover { background: var(--bg-hover); }

.manifest-pane { padding: 0 var(--space-4) var(--space-3); }
.manifest-status { font-size: var(--text-xs); color: var(--text-muted); padding: var(--space-2) 0; }
.manifest-status.error { color: var(--danger); }
.manifest-body {
  white-space: pre-wrap; word-break: break-word;
  font-family: var(--font-mono); font-size: 0.88em;
  background: var(--code-bg); border: 1px solid var(--border-soft);
  border-radius: var(--radius); padding: var(--space-2) var(--space-3);
  color: var(--text-primary); line-height: 1.5; margin: 0;
  max-height: 320px; overflow: auto;
}
.manifest-hint {
  font-size: var(--text-2xs); color: var(--text-muted);
  margin: var(--space-2) 0 0; line-height: 1.4;
}
.manifest-hint code {
  font-family: var(--font-mono); font-size: 0.95em;
  background: var(--bg-tertiary); padding: 0 4px; border-radius: 3px;
}

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
