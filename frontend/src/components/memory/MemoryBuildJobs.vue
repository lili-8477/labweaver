<script setup lang="ts">
// Memory build jobs from the last day, newest first, with live progress while
// one runs (the store polls) and each finished job's report.
import { computed, onMounted } from 'vue'
import { useMemoryStore } from '@/stores/memory'
import { relTime } from '@/utils/format'

const store = useMemoryStore()
const DAY_MS = 24 * 60 * 60 * 1000

const recent = computed(() => store.jobs.filter((j) => Date.now() - Date.parse(j.created_at) < DAY_MS).slice(0, 5))
const skippedOf = (report: Record<string, unknown>) =>
  (report.skipped ?? []) as Array<{ path: string; reason: string }>
// A file or folder by its name; a link by its host and path.
const originLabel = (j: { origin_kind: string; origin: string }) =>
  j.origin_kind === 'website' ? j.origin.replace(/^https?:\/\//, '').replace(/\/$/, '') : j.origin.split('/').pop()
const unchangedOf = (report: Record<string, unknown>) => ((report.unchanged ?? []) as string[]).length

onMounted(() => void store.loadJobs())
</script>

<template>
  <div v-if="recent.length" class="jobs" aria-label="Memory imports">
    <details v-for="j in recent" :key="j.job_id" class="job" :class="j.status">
      <summary>
        <span class="job-status">{{ j.status === 'running' || j.status === 'queued' ? 'Importing' : j.status === 'done' ? 'Imported' : 'Failed' }}</span>
        <span class="job-origin" :title="j.origin">{{ originLabel(j) }}</span>
        <span class="job-counts">
          <template v-if="j.status === 'failed'">{{ j.error }}</template>
          <template v-else>
            {{ j.entries_created }} new<template v-if="j.duplicates"> · {{ j.duplicates }} known</template>
            · {{ j.files_parsed }}/{{ j.files_seen }} files
          </template>
        </span>
        <span class="job-time">{{ relTime(j.finished_at ?? j.created_at) }}</span>
      </summary>
      <div v-if="unchangedOf(j.report)" class="job-skipped muted">
        {{ unchangedOf(j.report) }} file{{ unchangedOf(j.report) === 1 ? '' : 's' }} unchanged since the last import, not read again.
      </div>
      <ul v-if="skippedOf(j.report).length" class="job-skipped">
        <li v-for="s in skippedOf(j.report).slice(0, 20)" :key="s.path"><span>{{ s.path }}</span> — {{ s.reason }}</li>
      </ul>
      <div v-else class="job-skipped muted">Nothing skipped.</div>
    </details>
  </div>
</template>

<style scoped>
.jobs { display: flex; flex-direction: column; gap: 2px; padding: 4px 0; font-size: 0.8em; }
.job summary {
  display: flex; align-items: baseline; gap: 6px; cursor: pointer; list-style: none;
  padding: 2px 4px; border-radius: 4px;
}
.job summary:hover { background: var(--bg-tertiary); }
.job-status { flex: none; font-weight: 600; }
.job.running .job-status, .job.queued .job-status { color: var(--accent); }
.job.failed .job-status { color: var(--danger); }
.job-origin { flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.job-counts { flex: 1; min-width: 0; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.job-time { flex: none; color: var(--text-muted); }
.job-skipped { margin: 2px 0 4px 16px; padding: 0; list-style: none; color: var(--text-secondary); }
.job-skipped span { font-family: var(--font-mono, monospace); }
.muted { color: var(--text-muted); }
</style>
