import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { chpcBridgeService } from '@/services/chpc-bridge'
import { natsService } from '@/services/nats'
import type {
  BridgeStatus,
  ChpcBridgeStreamMessage,
  DuoChoice,
  OpenPhase,
} from '@/types/chpc-bridge'

export const useChpcBridgeStore = defineStore('chpcBridge', () => {
  const status = ref<BridgeStatus>({ kind: 'down' })
  const phase = ref<OpenPhase>('idle')
  const error = ref<string | null>(null)
  const pendingRequestId = ref<string | null>(null)
  const submitting = ref(false)

  let subId: string | null = null
  let lastRefreshAt = 0

  async function refresh() {
    // Coalesce rapid calls (e.g. mount + post-open) to one round-trip every 250ms.
    const now = Date.now()
    if (now - lastRefreshAt < 250) return
    lastRefreshAt = now
    try {
      status.value = await chpcBridgeService.status()
    } catch (e) {
      // Treat RPC failure as "not connected" rather than blocking the UI.
      console.warn('[chpc] status failed:', e)
      status.value = { kind: 'down' }
    }
  }

  function subscribeIfNeeded() {
    if (subId !== null) return
    subId = natsService.subscribe('chpc_bridge_events', (msg) => {
      const m = msg as unknown as ChpcBridgeStreamMessage
      if (m.type !== 'chpc_bridge') return
      const ev = m.data
      if (!pendingRequestId.value || ev.requestId !== pendingRequestId.value) return
      phase.value = ev.phase
      if (ev.phase === 'up') {
        error.value = null
        pendingRequestId.value = null
        // Status refresh picks up pid/openedAt/user from the source of truth.
        void refresh()
      } else if (ev.phase === 'error') {
        error.value = ev.message
        pendingRequestId.value = null
      }
    })
  }

  function unsubscribe() {
    if (subId !== null) {
      natsService.unsubscribe(subId)
      subId = null
    }
  }

  async function open(password: string, duo: DuoChoice): Promise<void> {
    const requestId = crypto.randomUUID()
    pendingRequestId.value = requestId
    phase.value = 'spawned'
    error.value = null
    submitting.value = true
    subscribeIfNeeded()
    try {
      await chpcBridgeService.open({ password, duo, requestId })
    } catch (e) {
      error.value = (e as Error).message
      phase.value = 'error'
      pendingRequestId.value = null
      throw e
    } finally {
      submitting.value = false
    }
  }

  async function close(): Promise<void> {
    await chpcBridgeService.close()
    phase.value = 'idle'
    error.value = null
    await refresh()
  }

  const isUp = computed(() => status.value.kind === 'up')
  const isDown = computed(() => status.value.kind === 'down')
  const isUnprovisioned = computed(() => status.value.kind === 'unprovisioned')
  const inFlight = computed(() => pendingRequestId.value !== null)

  return {
    // state
    status,
    phase,
    error,
    submitting,
    // derived
    isUp,
    isDown,
    isUnprovisioned,
    inFlight,
    // actions
    refresh,
    open,
    close,
    subscribeIfNeeded,
    unsubscribe,
  }
})
