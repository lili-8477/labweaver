<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useChpcBridgeStore } from '@/stores/chpcBridge'
import { useConnectionStore } from '@/stores/connection'

const bridge = useChpcBridgeStore()
const conn = useConnectionStore()

const showModal = ref(false)
const password = ref('')
const duoMode = ref<'push' | 'passcode'>('push')
const passcode = ref('')

// Two-step disconnect: first click on an up pill arms it, second click within
// 3 s actually closes. Prevents accidental drops while keeping the action a
// single visible control. Auto-reverts if the user navigates away or waits.
const armedToClose = ref(false)
let disarmTimer: ReturnType<typeof setTimeout> | null = null

function disarm() {
  if (disarmTimer) { clearTimeout(disarmTimer); disarmTimer = null }
  armedToClose.value = false
}

const label = computed(() => {
  if (bridge.isUp && armedToClose.value) return 'Click again to disconnect'
  switch (bridge.status.kind) {
    case 'up':            return `CHPC · ${bridge.status.user}`
    case 'down':          return 'CHPC · open'
    case 'unprovisioned': return 'CHPC · setup'
  }
  return 'CHPC'
})

const tooltip = computed(() => {
  if (bridge.status.kind === 'up') {
    return armedToClose.value
      ? 'Click again to close the master. Wait 3 s to cancel.'
      : `Master pid=${bridge.status.pid}, opened ${bridge.status.openedAt}. Click once to arm disconnect.`
  }
  if (bridge.status.kind === 'unprovisioned') {
    return bridge.status.reason === 'no-ssh'
      ? 'openssh-client not installed in this container'
      : '~/.ssh/config missing the chpc-login Host stanza'
  }
  return 'Open the CHPC SSH bridge (requires password + Duo)'
})

const phaseLabel = computed(() => {
  switch (bridge.phase) {
    case 'spawned':            return 'Connecting…'
    case 'password-accepted':  return 'Password accepted, awaiting Duo…'
    case 'duo-waiting':        return duoMode.value === 'push'
      ? 'Approve the push on your phone…'
      : 'Verifying passcode…'
    case 'up':                 return 'Connected ✓'
    case 'error':              return bridge.error ?? 'Failed'
    default:                   return ''
  }
})

function onClick() {
  if (bridge.isUnprovisioned) {
    // Nothing the user can do from here — config is missing on disk.
    return
  }
  if (bridge.isUp) {
    if (!armedToClose.value) {
      armedToClose.value = true
      disarmTimer = setTimeout(disarm, 3000)
      return
    }
    disarm()
    void bridge.close()
    return
  }
  // Down → open the auth modal.
  showModal.value = true
}

async function submit() {
  if (!password.value) return
  const duo = duoMode.value === 'push'
    ? { kind: 'push' as const }
    : { kind: 'passcode' as const, code: passcode.value.trim() }
  try {
    await bridge.open(password.value, duo)
  } finally {
    // Clear local refs immediately; in-flight phases still arrive via the store.
    password.value = ''
    passcode.value = ''
  }
}

function cancel() {
  showModal.value = false
  password.value = ''
  passcode.value = ''
}

// Auto-close the modal once the bridge reports up.
watch(() => bridge.phase, (p) => {
  if (p === 'up') {
    setTimeout(() => { showModal.value = false }, 600)
  }
})

// Pull initial status once we're connected to NATS, and re-pull on reconnect.
onMounted(() => {
  if (conn.connected) void bridge.refresh()
})
watch(() => conn.connected, (c) => {
  if (c) void bridge.refresh()
})

onBeforeUnmount(() => {
  // Keep the subscription alive across the app's lifetime — bridge events can
  // still arrive after the component unmounts (e.g. panel switch mid-Duo).
  // The store owns subscription teardown.
  if (disarmTimer) clearTimeout(disarmTimer)
})

// Disarm the close gesture when the bridge state changes from anywhere else
// (e.g. backend reports down on its own) — otherwise the armed flag would
// flicker over a now-inactive pill.
watch(() => bridge.status.kind, () => disarm())
</script>

<template>
  <button
    class="chpc-pill"
    :class="{ up: bridge.isUp, down: bridge.isDown, unprov: bridge.isUnprovisioned, armed: armedToClose }"
    :title="tooltip"
    :disabled="bridge.isUnprovisioned"
    @click="onClick"
    @blur="disarm"
  >
    <span class="dot" />
    {{ label }}
  </button>

  <!-- Auth modal -->
  <div v-if="showModal" class="chpc-modal-backdrop" @click.self="cancel">
    <div class="chpc-modal" role="dialog" aria-labelledby="chpc-modal-title">
      <header>
        <h3 id="chpc-modal-title">Open CHPC bridge</h3>
        <button class="close-x" @click="cancel" aria-label="Close">×</button>
      </header>

      <p class="hint">
        One-time auth per session. Once open, the agent reuses the master
        until <code>ControlPersist</code> expires (8 h).
      </p>

      <label class="field">
        <span>CHPC password</span>
        <input
          v-model="password"
          type="password"
          autocomplete="off"
          autofocus
          :disabled="bridge.submitting || bridge.inFlight"
          @keydown.enter="submit"
        />
      </label>

      <fieldset class="duo">
        <legend>Second factor</legend>
        <label>
          <input type="radio" value="push" v-model="duoMode" :disabled="bridge.inFlight" />
          Duo push to phone
        </label>
        <label>
          <input type="radio" value="passcode" v-model="duoMode" :disabled="bridge.inFlight" />
          Passcode
        </label>
        <input
          v-if="duoMode === 'passcode'"
          v-model="passcode"
          class="passcode"
          inputmode="numeric"
          pattern="[0-9]*"
          placeholder="6-digit code"
          :disabled="bridge.inFlight"
        />
      </fieldset>

      <p v-if="phaseLabel" class="phase" :class="{ error: bridge.phase === 'error' }">
        {{ phaseLabel }}
      </p>

      <footer>
        <button class="ghost" @click="cancel" :disabled="bridge.submitting">Cancel</button>
        <button
          class="primary"
          @click="submit"
          :disabled="!password || bridge.submitting || bridge.inFlight"
        >
          {{ bridge.inFlight ? 'Working…' : 'Open' }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.chpc-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 9px;
  border-radius: 10px;
  font-size: 0.72em;
  background: var(--bg-tertiary);
  color: var(--text-muted);
  border: 1px solid transparent;
  transition: all 0.12s;
  cursor: pointer;
}
.chpc-pill:hover:not(:disabled) {
  border-color: var(--border);
  color: var(--text-primary);
}
.chpc-pill.up    { color: var(--success); }
.chpc-pill.down  { color: var(--text-muted); }
.chpc-pill.unprov { color: var(--warning); cursor: not-allowed; opacity: 0.7; }
.chpc-pill.armed {
  color: var(--danger);
  border-color: var(--danger);
  background: color-mix(in srgb, var(--danger) 12%, transparent);
  animation: chpc-armed-pulse 0.6s ease-in-out infinite alternate;
}
@keyframes chpc-armed-pulse {
  from { opacity: 0.85; }
  to   { opacity: 1; }
}

.chpc-pill .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
}

/* Modal */
.chpc-modal-backdrop {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.45);
  display: flex; align-items: center; justify-content: center;
  z-index: 1000;
}
.chpc-modal {
  background: var(--bg-secondary);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  width: min(440px, 92vw);
  padding: 18px 20px 16px;
  box-shadow: 0 12px 32px rgba(0,0,0,0.35);
}
.chpc-modal header {
  display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 6px;
}
.chpc-modal h3 {
  margin: 0;
  font-size: var(--text-md);
  font-weight: var(--fw-semi);
  color: var(--text-primary);
}
.close-x {
  background: transparent; border: none; color: var(--text-muted);
  font-size: 1.4em; line-height: 1; cursor: pointer;
}
.close-x:hover { color: var(--text-primary); }

.hint {
  margin: 0 0 12px;
  font-size: var(--text-sm);
  color: var(--text-muted);
}
.hint code { font-size: 0.92em; }

.field {
  display: flex; flex-direction: column; gap: 4px;
  margin-bottom: 12px;
}
.field span {
  font-size: var(--text-2xs);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}
.field input {
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-family: inherit; font-size: var(--text-sm);
}
.field input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }

.duo {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 8px 10px;
  margin: 0 0 12px;
  display: flex; flex-direction: column; gap: 6px;
}
.duo legend {
  font-size: var(--text-2xs);
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 0 4px;
}
.duo label {
  display: flex; align-items: center; gap: 8px;
  font-size: var(--text-sm); color: var(--text-primary);
  cursor: pointer;
}
.duo .passcode {
  margin-top: 4px;
  padding: 5px 8px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-primary);
  color: var(--text-primary);
  font-family: var(--font-mono, monospace);
  font-size: var(--text-sm);
  letter-spacing: 0.15em;
}

.phase {
  margin: 0 0 12px;
  font-size: var(--text-sm);
  color: var(--text-secondary);
}
.phase.error { color: var(--danger); }

footer {
  display: flex; justify-content: flex-end; gap: 8px;
}
button.ghost, button.primary {
  padding: 5px 14px;
  border-radius: var(--radius);
  font-size: var(--text-sm);
  font-family: inherit;
  cursor: pointer;
  border: 1px solid var(--border);
}
button.ghost { background: transparent; color: var(--text-secondary); }
button.ghost:hover:not(:disabled) { background: var(--bg-tertiary); color: var(--text-primary); }
button.primary {
  background: var(--accent);
  color: white;
  border-color: var(--accent);
}
button.primary:disabled { opacity: 0.55; cursor: not-allowed; }
button.ghost:disabled { opacity: 0.55; cursor: not-allowed; }
</style>
