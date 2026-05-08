<script setup lang="ts">
import { onMounted } from 'vue'
import { useSkillsStore } from '@/stores/skills'
import SkillRow from './SkillRow.vue'

const skills = useSkillsStore()

onMounted(() => skills.load())
</script>

<template>
  <div class="panel">
    <header class="panel-header">
      <h3>Skills</h3>
      <button class="refresh" @click="skills.load()" :disabled="skills.loading">
        {{ skills.loading ? '…' : 'Refresh' }}
      </button>
    </header>
    <div v-if="skills.error" class="error">{{ skills.error }}</div>
    <div v-else-if="skills.skills.length === 0 && !skills.loading" class="empty">
      No skills under <code>~/.claude/skills/</code>.
    </div>
    <div v-else class="list">
      <SkillRow v-for="s in skills.skills" :key="s.name" :skill="s" />
    </div>
  </div>
</template>

<style scoped>
.panel { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
.panel-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: var(--space-3) var(--space-4); border-bottom: 1px solid var(--border-soft);
}
.panel-header h3 { margin: 0; font-size: var(--text-md); font-weight: var(--fw-semi); }
.refresh {
  padding: var(--space-1) var(--space-2); border-radius: var(--radius);
  border: 1px solid var(--border); background: var(--bg-secondary);
  font-size: var(--text-xs); cursor: pointer;
}
.error  { padding: var(--space-3) var(--space-4); color: var(--danger); }
.empty  { padding: var(--space-4); color: var(--text-muted); font-size: var(--text-sm); }
.list   { flex: 1; overflow-y: auto; }
</style>
