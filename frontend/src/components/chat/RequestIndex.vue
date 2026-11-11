<script setup lang="ts">
// A compact stack of marks beside the messages' scrollbar, one per user
// request in order, centered on the rail. Marks for
// requests in view are highlighted; hovering shows the request, clicking
// scrolls to it. Requests are found by their data-request attribute (the
// label), so the panel only has to tag its user messages.
import { onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps<{
  scroller: HTMLElement | null
  /** Changes whenever the message list does, to trigger a re-measure. */
  version: unknown
}>()

interface Mark { el: HTMLElement; label: string; inView: boolean }

const marks = ref<Mark[]>([])
const rail = ref<HTMLElement | null>(null)
// The label lives on the rail, not in the (scrollable) stack, so it isn't clipped.
const hovered = ref<{ mark: Mark; y: number } | null>(null)

function hover(m: Mark, ev: MouseEvent) {
  const r = (ev.currentTarget as HTMLElement).getBoundingClientRect()
  const top = rail.value?.getBoundingClientRect().top ?? 0
  hovered.value = { mark: m, y: r.top + r.height / 2 - top }
}
const overflowing = ref(false)

function measure() {
  const s = props.scroller
  if (!s) { marks.value = []; return }
  const viewTop = s.scrollTop
  const viewBottom = viewTop + s.clientHeight
  overflowing.value = s.scrollHeight > s.clientHeight + 1
  marks.value = Array.from(s.querySelectorAll<HTMLElement>('[data-request]')).map(el => ({
    el,
    label: el.dataset.request || '',
    inView: el.offsetTop + el.offsetHeight > viewTop && el.offsetTop < viewBottom,
  }))
}

function jump(m: Mark) {
  props.scroller?.scrollTo({ top: m.el.offsetTop - 16, behavior: 'smooth' })
}

let frame = 0
function schedule() {
  cancelAnimationFrame(frame)
  frame = requestAnimationFrame(measure)
}

let resize: ResizeObserver | null = null
watch(() => props.scroller, (s, old) => {
  old?.removeEventListener('scroll', schedule)
  resize?.disconnect()
  if (!s) return
  s.addEventListener('scroll', schedule, { passive: true })
  resize = new ResizeObserver(schedule)
  resize.observe(s)
  schedule()
}, { immediate: true })
watch(() => props.version, schedule, { flush: 'post' })

onBeforeUnmount(() => {
  props.scroller?.removeEventListener('scroll', schedule)
  resize?.disconnect()
  cancelAnimationFrame(frame)
})
</script>

<template>
  <div v-if="overflowing && marks.length" ref="rail" class="request-index" aria-label="Requests in this chat">
    <div class="stack">
      <div v-for="(m, i) in marks" :key="i" class="slot">
        <button
          class="mark"
          :class="{ 'in-view': m.inView }"
          :aria-label="`Request ${i + 1}: ${m.label}`"
          @click="jump(m)"
          @mouseenter="hover(m, $event)"
          @mouseleave="hovered = null"
        />
      </div>
    </div>
    <div v-if="hovered" class="mark-label" :style="{ top: `${hovered.y}px` }">{{ hovered.mark.label }}</div>
  </div>
</template>

<style scoped>
.request-index {
  position: relative; flex: none; width: 16px; margin: 16px 0;
  display: flex; flex-direction: column; justify-content: center;
}
/* Marks stack tightly; a long chat scrolls the stack instead of spreading it. */
.stack {
  display: flex; flex-direction: column; align-items: flex-end;
  max-height: 100%; overflow-y: auto; scrollbar-width: none;
}
.stack::-webkit-scrollbar { display: none; }
.slot { display: flex; justify-content: flex-end; padding: 2px 2px; }
.mark {
  display: block; width: 10px; height: 3px;
  padding: 0; border: none; border-radius: 2px; cursor: pointer;
  background: var(--text-muted); opacity: 0.6;
  transition: background 0.1s, width 0.1s;
}
.mark.in-view { background: var(--accent); opacity: 1; }
.mark:hover { width: 12px; background: var(--text-primary); opacity: 1; }
.mark-label {
  position: absolute; right: 18px; transform: translateY(-50%);
  max-width: 280px; padding: 4px 8px; border-radius: 6px;
  background: var(--bg-elevated); border: 1px solid var(--border);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2);
  color: var(--text-primary); font-size: 0.8em; line-height: 1.35;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  pointer-events: none; z-index: 5;
}
</style>
