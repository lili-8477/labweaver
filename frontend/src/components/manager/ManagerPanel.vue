<script setup lang="ts">
// Manager view: every user container's status, from the reports the adapters
// publish on NATS (adapter/src/fleet-status.ts). Refreshes while open.
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { fleetService, type FleetEntry } from '@/services/fleet'

const REFRESH_MS = 10_000

const entries = ref<FleetEntry[]>([])
const loading = ref(false)
const error = ref('')
const now = ref(Date.now())

async function load() {
  if (loading.value) return
  loading.value = true
  try {
    entries.value = await fleetService.list()
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
    now.value = Date.now()
  }
}

let refresh = 0
let clock = 0
onMounted(() => {
  load()
  refresh = window.setInterval(load, REFRESH_MS)
  clock = window.setInterval(() => { now.value = Date.now() }, 1000)
})
onUnmounted(() => {
  window.clearInterval(refresh)
  window.clearInterval(clock)
})

const onlineCount = computed(() => entries.value.filter(e => e.online).length)

function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}

function bytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n < 10 && i > 0 ? n.toFixed(1) : Math.round(n)} ${units[i]}`
}
</script>

<template>
  <div class="panel">
    <header class="panel-header">
      <h3>Containers <span class="count">{{ onlineCount }}/{{ entries.length }} online</span></h3>
      <button class="refresh" @click="load" :disabled="loading">{{ loading ? '…' : 'Refresh' }}</button>
    </header>
    <div v-if="error" class="error">{{ error }}</div>
    <div v-else-if="!entries.length && !loading" class="empty">No containers have reported yet.</div>
    <div v-else class="list">
      <table>
        <thead>
          <tr>
            <th>User</th><th>Up</th><th title="Percent of one core">CPU</th><th>Memory</th>
            <th>Turns</th><th>Kernels</th><th>Seen</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="e in entries" :key="e.username" :class="{ offline: !e.online }">
            <td class="user">
              <i class="dot" :title="e.online ? 'Online' : 'Offline'" />{{ e.username }}
            </td>
            <template v-if="e.status && e.online">
              <td>{{ duration(now - e.status.startedAt) }}</td>
              <td :title="`${e.status.cpus} CPUs`">{{ e.status.cpuPercent === null ? '—' : `${e.status.cpuPercent}%` }}</td>
              <td>{{ bytes(e.status.memoryBytes) }} / {{ e.status.memoryLimitBytes ? bytes(e.status.memoryLimitBytes) : '∞' }}</td>
              <td>{{ e.status.activeTurns }}</td>
              <td>{{ e.status.kernels }}</td>
              <td class="seen">{{ duration(now - e.status.reportedAt) }} ago</td>
            </template>
            <template v-else>
              <td colspan="5">offline</td>
              <td class="seen">{{ e.status ? `${duration(now - e.status.reportedAt)} ago` : 'never' }}</td>
            </template>
          </tr>
        </tbody>
      </table>
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
.count { margin-left: 6px; font-size: var(--text-xs); font-weight: var(--fw-medium); color: var(--text-muted); }
.refresh {
  padding: var(--space-1) var(--space-2); border-radius: var(--radius);
  border: 1px solid var(--border); background: var(--bg-secondary);
  font-size: var(--text-xs); cursor: pointer;
}
.error { padding: var(--space-3) var(--space-4); color: var(--danger); }
.empty { padding: var(--space-4); color: var(--text-muted); font-size: var(--text-sm); }
.list { flex: 1; overflow: auto; }
table {
  width: 100%; border-collapse: collapse;
  font-size: var(--text-xs); font-variant-numeric: tabular-nums; color: var(--text-secondary);
}
th, td { padding: var(--space-1) var(--space-2); text-align: left; white-space: nowrap; }
th:first-child, td:first-child { padding-left: var(--space-4); }
th { color: var(--text-muted); font-weight: var(--fw-medium); border-bottom: 1px solid var(--border-soft); }
tbody tr:hover { background: var(--bg-hover); }
tr.offline { color: var(--text-muted); }
.user { color: var(--text-primary); }
.offline .user { color: var(--text-muted); }
.dot {
  display: inline-block; width: 7px; height: 7px; margin-right: 6px;
  border-radius: 50%; background: var(--success);
}
.offline .dot { background: var(--danger); }
.seen { color: var(--text-muted); }
</style>
