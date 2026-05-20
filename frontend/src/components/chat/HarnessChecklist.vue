<script setup lang="ts">
// Pinned to the top of the chat panel while the session has a self-driving
// plan, OR while harness mode is currently on. Three visual states:
//
//   - running  (active=true): pulsing accent dot, "Self-driving mode" title,
//                            "routed via /tick" hint, live progress polled.
//   - stopped  (active=false, progress exists): static muted dot,
//                            "Self-driving plan" title (no route hint), the
//                            checklist remains so the user can review what
//                            happened.
//   - complete (progress.complete=true): green dot + COMPLETE badge,
//                            regardless of active.
//
// The whole panel is foldable. The banner row is always present; the step
// list + feedback note collapse via a chevron in the banner. Fold state is
// remembered per chat in localStorage (key: `harness-collapsed:<chatId>`)
// so a chat the user prefers folded stays folded across reloads.
import { computed, ref, watch, onMounted } from 'vue'
import type { HarnessProgress, HarnessStep } from '@/types'

const props = defineProps<{
  active: boolean                       // harness mode marker file present
  progress: HarnessProgress | null      // parsed progress.md for THIS chat
  projectName: string | null            // matched project dir
  chatId: string | null                 // for per-chat fold persistence
}>()

const stepLabel = (s: HarnessStep): string => {
  if (s.reviewed) return 'reviewed'
  if (s.done)     return 'done'
  return 'pending'
}

const totalDone = computed(() => props.progress?.steps.filter(s => s.done).length ?? 0)
const totalSteps = computed(() => props.progress?.steps.length ?? 0)

const isComplete = computed(() => !!props.progress?.complete)
const statusLabel = computed(() => {
  if (isComplete.value) return 'complete'
  if (props.active)     return 'running'
  return 'stopped'
})
const titleLabel = computed(() => {
  // Stopped sessions show a calmer "plan" wording — the harness isn't doing
  // anything right now, the checklist is just a record.
  if (props.active) return 'Self-driving mode'
  return 'Self-driving plan'
})

// ---- Fold state ----
// localStorage key includes chatId so each session has its own preference.
// A null chatId (shouldn't normally happen since the parent v-ifs us out)
// falls back to a shared key so we still degrade cleanly.
const storageKey = (id: string | null) => `harness-collapsed:${id ?? '_'}`

const collapsed = ref(false)
function loadCollapsed(id: string | null) {
  try {
    collapsed.value = localStorage.getItem(storageKey(id)) === '1'
  } catch {
    collapsed.value = false
  }
}
function saveCollapsed(id: string | null, value: boolean) {
  try {
    localStorage.setItem(storageKey(id), value ? '1' : '0')
  } catch { /* storage disabled — keep in-memory only */ }
}

function toggleCollapsed() {
  collapsed.value = !collapsed.value
  saveCollapsed(props.chatId, collapsed.value)
}

onMounted(() => loadCollapsed(props.chatId))
watch(() => props.chatId, (id) => loadCollapsed(id))
</script>

<template>
  <div class="harness-checklist" :class="[`state-${statusLabel}`, { collapsed }]">
    <!-- Banner row — always visible. Clicking the row (or its chevron)
         toggles fold; the chevron has its own button for keyboard a11y. -->
    <button
      type="button"
      class="banner"
      :aria-expanded="!collapsed"
      :title="collapsed ? 'Show checklist' : 'Hide checklist'"
      @click="toggleCollapsed"
    >
      <span class="banner-dot"></span>
      <span class="banner-title">{{ titleLabel }}</span>
      <span v-if="projectName" class="banner-sep">·</span>
      <span v-if="projectName" class="banner-project"><code>{{ projectName }}</code></span>
      <span v-if="active && !isComplete" class="banner-sep">·</span>
      <span v-if="active && !isComplete" class="banner-route">routed via <code>/tick</code></span>
      <span v-if="!active && !isComplete && progress" class="banner-sep">·</span>
      <span v-if="!active && !isComplete && progress" class="banner-stopped-hint">stopped</span>
      <span v-if="progress" class="banner-progress">
        {{ totalDone }} / {{ totalSteps }} steps
      </span>
      <span v-if="isComplete" class="banner-done-badge">complete</span>
      <span class="banner-chevron" :class="{ rotated: !collapsed }" aria-hidden="true">▸</span>
    </button>

    <!-- Body collapses as a whole. v-show (not v-if) so the list isn't
         remounted on every toggle — keeps any internal scroll position. -->
    <div v-show="!collapsed" class="body">
      <!-- No progress.md yet — the bootstrap will create one on the next /tick. -->
      <div v-if="!progress" class="empty-plan">
        No plan yet. Send a prompt — <code>tick-bootstrap</code> will scaffold
        <code>progress.md</code> and the checklist will appear here.
      </div>

      <!-- Plan exists but contains no items (planner hasn't run yet). -->
      <div v-else-if="progress.steps.length === 0" class="empty-plan">
        Plan is empty. Waiting for <code>tick-planner</code> to fill it on the next tick.
      </div>

      <ol v-else class="step-list">
        <li
          v-for="(s, i) in progress.steps"
          :key="s.name + i"
          class="step"
          :class="{
            done: s.done,
            reviewed: s.reviewed,
            'next-up': active && i === progress.nextStepIndex,
          }"
        >
          <span class="step-box" :title="stepLabel(s)">
            <template v-if="s.done">☑</template>
            <template v-else>☐</template>
          </span>
          <span class="step-name">{{ s.name }}</span>
          <span v-if="s.description" class="step-desc">{{ s.description }}</span>
          <span v-if="s.reviewed" class="step-badge reviewed-badge">reviewed</span>
          <span v-else-if="active && i === progress.nextStepIndex" class="step-badge next-badge">next</span>
        </li>
      </ol>

      <div v-if="progress && progress.pendingFeedback > 0 && active" class="feedback-note">
        ⚠ {{ progress.pendingFeedback }} unaddressed review note{{ progress.pendingFeedback === 1 ? '' : 's' }} — executor will handle on the next tick.
      </div>
      <div v-else-if="progress && progress.pendingFeedback > 0" class="feedback-note feedback-stopped">
        ⚠ {{ progress.pendingFeedback }} unaddressed review note{{ progress.pendingFeedback === 1 ? '' : 's' }} pending — resume self-driving to address.
      </div>
    </div>
  </div>
</template>

<style scoped>
.harness-checklist {
  margin: 8px 16px 12px;
  background: var(--bg-secondary);
  border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
  border-radius: var(--radius);
  overflow: hidden;
  transition: border-color 0.2s;
}
.harness-checklist.state-stopped {
  /* Muted border when nothing's running — the panel becomes a record, not
     an indicator. */
  border-color: var(--border);
}
.harness-checklist.state-complete {
  border-color: color-mix(in srgb, var(--success) 35%, var(--border));
}

.banner {
  display: flex; align-items: center; gap: 8px;
  width: 100%; padding: 8px 12px;
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  font-size: 0.85em; color: var(--text-secondary);
  border-bottom: 1px solid color-mix(in srgb, var(--accent) 20%, var(--border));
  /* Reset button defaults so this still reads as a banner. */
  border-top: none; border-left: none; border-right: none;
  font: inherit; font-size: 0.85em;
  text-align: left; cursor: pointer;
}
.banner:hover { background: color-mix(in srgb, var(--accent) 14%, transparent); }
.banner:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.state-stopped .banner {
  background: color-mix(in srgb, var(--text-muted) 8%, transparent);
  border-bottom-color: var(--border);
}
.state-stopped .banner:hover {
  background: color-mix(in srgb, var(--text-muted) 14%, transparent);
}
.state-complete .banner {
  background: color-mix(in srgb, var(--success) 12%, transparent);
  border-bottom-color: color-mix(in srgb, var(--success) 25%, var(--border));
}
.collapsed .banner { border-bottom: none; }

.banner-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 50%, transparent);
  animation: pulse-dot 2s infinite;
  flex-shrink: 0;
}
.state-stopped .banner-dot {
  background: var(--text-muted);
  animation: none;
  box-shadow: none;
}
.state-complete .banner-dot {
  background: var(--success); animation: none; box-shadow: none;
}
@keyframes pulse-dot {
  0%   { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 60%, transparent); }
  70%  { box-shadow: 0 0 0 6px color-mix(in srgb, var(--accent) 0%, transparent); }
  100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--accent) 0%, transparent); }
}
.banner-title { font-weight: 600; color: var(--text-primary); }
.banner-sep { opacity: 0.5; }
.banner-project code, .banner-route code, .empty-plan code {
  background: var(--bg-tertiary); padding: 0 4px; border-radius: 3px;
  font-size: 0.95em; font-family: var(--font-mono);
}
.banner-stopped-hint {
  font-size: 0.78em; letter-spacing: 0.4px;
  color: var(--text-muted); text-transform: uppercase;
}
.banner-progress {
  margin-left: auto;
  font-family: var(--font-mono); font-size: 0.9em;
  color: var(--text-muted);
}
.banner-done-badge {
  font-size: 0.7em; font-weight: 700; letter-spacing: 0.5px;
  padding: 1px 6px; border-radius: 10px;
  background: var(--success); color: #fff;
  text-transform: uppercase;
}
.banner-chevron {
  display: inline-block;
  margin-left: 8px;
  font-size: 0.85em;
  color: var(--text-muted);
  transition: transform 0.18s ease;
  width: 12px; text-align: center;
}
.banner-chevron.rotated { transform: rotate(90deg); }
.banner-progress + .banner-chevron { margin-left: 4px; }

.empty-plan {
  padding: 10px 12px;
  font-size: 0.82em; color: var(--text-muted); line-height: 1.5;
}

.step-list {
  list-style: none; margin: 0; padding: 6px 0;
  max-height: 240px; overflow-y: auto;
}
.step {
  display: flex; align-items: center; gap: 8px;
  padding: 4px 12px;
  font-size: 0.85em; color: var(--text-secondary);
  border-left: 2px solid transparent;
  transition: background 0.15s, border-color 0.15s;
}
.step.done { color: var(--text-primary); }
.step.reviewed .step-box { color: var(--success); }
.step:not(.done) .step-box { color: var(--text-muted); }
.step.next-up {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  border-left-color: var(--accent);
}

.step-box {
  font-family: var(--font-mono); font-size: 1.05em; width: 14px;
  flex-shrink: 0;
}
.step-name {
  font-family: var(--font-mono); font-weight: 600;
  color: var(--text-primary);
  white-space: nowrap;
}
.step:not(.done):not(.next-up) .step-name { color: var(--text-secondary); }
.step-desc {
  flex: 1; min-width: 0;
  font-size: 0.92em; color: var(--text-muted);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}

.step-badge {
  font-size: 0.7em; font-weight: 600; letter-spacing: 0.3px;
  padding: 1px 6px; border-radius: 8px; text-transform: uppercase;
  flex-shrink: 0;
}
.reviewed-badge {
  background: color-mix(in srgb, var(--success) 15%, transparent);
  color: var(--success);
}
.next-badge {
  background: var(--accent); color: #fff;
}

.feedback-note {
  padding: 6px 12px;
  font-size: 0.8em; color: var(--warning, var(--text-secondary));
  background: color-mix(in srgb, var(--warning, var(--accent)) 8%, transparent);
  border-top: 1px solid var(--border);
}
.feedback-note.feedback-stopped {
  color: var(--text-muted);
  background: color-mix(in srgb, var(--text-muted) 6%, transparent);
}
</style>
