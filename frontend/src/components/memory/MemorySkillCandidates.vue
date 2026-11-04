<script setup lang="ts">
/**
 * Facet topics ranked by skill readiness. Readiness has two halves shown as
 * one split meter: knowledge (memories gathered) and proof (successful task
 * uses). "Draft skill" asks the agent in the active chat to distill the
 * topic's memories into ~/.labweaver/skills/<slug>/SKILL.md.
 */
import { computed, onMounted, ref } from 'vue'
import { useChatStore } from '@/stores/chat'
import { useSkillsStore } from '@/stores/skills'
import type { MemoryTopic } from '@/types'

const props = defineProps<{
  topics: MemoryTopic[]
  thresholds: { memories: number; successes: number }
  activeTopic: string | null
}>()
const emit = defineEmits<{ select: [topic: string | null] }>()

const chat = useChatStore()
const skills = useSkillsStore()
const drafted = ref(new Set<string>())
const showAll = ref(false)

onMounted(() => { if (!skills.skills.length) void skills.load() })

const visible = computed(() => (showAll.value ? props.topics : props.topics.slice(0, 5)))
const readyCount = computed(() => props.topics.filter(t => t.ready).length)

const slug = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

// A skill already named after the topic (exact or containing it).
function relatedSkill(t: MemoryTopic): string | null {
  const s = slug(t.value)
  return s ? skills.skills.find(k => k.name.toLowerCase().includes(s))?.name ?? null : null
}

const pct = (n: number, of: number) => `${Math.min(1, n / of) * 50}%`

function draft(t: MemoryTopic) {
  const prompt = [
    `Build a reusable skill from my memory topic "${t.key}: ${t.value}" ` +
      `(${t.memory_count} memories, ${t.success_count} successful task uses).`,
    `1. Read each memory with memory_get: ${t.memory_ids.join(', ')}.`,
    `2. Distill the procedure that worked into ~/.labweaver/skills/${slug(t.value)}/SKILL.md ` +
      'with name and description frontmatter. Keep steps concrete; drop one-off details.',
    '3. Tell me which memories the skill now covers so I can decide whether to forget them.',
  ].join('\n')
  void chat.sendMessage(prompt)
  drafted.value.add(t.topic)
}
</script>

<template>
  <section class="candidates">
    <header class="sec-head">
      <h4>Skill candidates</h4>
      <span class="sec-meta">
        ready at {{ thresholds.memories }} memories + {{ thresholds.successes }} successful uses
      </span>
    </header>

    <p v-if="!topics.length" class="hint">
      Topics form when two or more memories share a pipeline, tool or dataset.
    </p>

    <ul v-else class="topic-list">
      <li
        v-for="t in visible"
        :key="t.topic"
        class="topic"
        :class="{ active: activeTopic === t.topic, ready: t.ready }"
      >
        <button
          class="topic-main"
          :aria-pressed="activeTopic === t.topic"
          :title="activeTopic === t.topic ? 'Show the whole tree' : 'Show only these memories in the tree'"
          @click="emit('select', activeTopic === t.topic ? null : t.topic)"
        >
          <span class="topic-name">
            <span class="topic-key">{{ t.key }}</span>{{ t.value }}
          </span>
          <span class="meter" :title="`knowledge ${t.memory_count}/${thresholds.memories} · proof ${t.success_count}/${thresholds.successes}`">
            <span class="meter-fill know" :style="{ width: pct(t.memory_count, thresholds.memories) }" />
            <span class="meter-fill proof" :style="{ width: pct(t.success_count, thresholds.successes) }" />
          </span>
          <span class="topic-stats">
            {{ t.memory_count }} mem · <span class="ok">{{ t.success_count }}✓</span>
            <span v-if="t.failure_count" class="bad"> {{ t.failure_count }}✗</span>
          </span>
        </button>
        <span v-if="relatedSkill(t)" class="skill-exists" :title="`Skill ${relatedSkill(t)} already exists`">
          skill: {{ relatedSkill(t) }}
        </span>
        <button
          v-else-if="t.ready"
          class="draft-btn"
          :disabled="!chat.activeChatId || chat.sending || drafted.has(t.topic)"
          :title="chat.activeChatId ? 'Ask the agent in this chat to write the skill' : 'Open a chat first'"
          @click="draft(t)"
        >{{ drafted.has(t.topic) ? 'Sent to chat' : 'Draft skill' }}</button>
        <span v-else class="growing">{{ Math.round(t.readiness * 100) }}%</span>
      </li>
    </ul>

    <button v-if="topics.length > 5" class="link-btn" @click="showAll = !showAll">
      {{ showAll ? 'Show top 5' : `Show all ${topics.length}` }}
    </button>
    <p v-if="readyCount" class="sr-only" aria-live="polite">{{ readyCount }} topics ready to become skills</p>
  </section>
</template>

<style scoped>
.candidates { padding: var(--space-3); border-bottom: 1px solid var(--border-soft); }

.sec-head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--space-2); margin-bottom: var(--space-2); }
.sec-head h4 { margin: 0; font-size: var(--text-xs); font-weight: var(--fw-semi); text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-secondary); }
.sec-meta { font-size: var(--text-2xs); color: var(--text-muted); }
.hint { margin: 0; font-size: var(--text-xs); color: var(--text-muted); }

.topic-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.topic { display: flex; align-items: center; gap: var(--space-2); border-radius: var(--radius); }
.topic.active { background: var(--bg-tertiary); }

.topic-main {
  flex: 1; min-width: 0;
  display: grid; grid-template-columns: minmax(0, 1fr) 72px auto; align-items: center; gap: var(--space-2);
  background: none; border: none; padding: 5px var(--space-2); border-radius: var(--radius);
  text-align: left; cursor: pointer; color: var(--text-primary);
}
.topic-main:hover { background: var(--bg-hover); }
.topic-name { font-size: var(--text-sm); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.topic-key { color: var(--text-muted); font-size: var(--text-2xs); margin-right: 6px; font-family: var(--font-mono); }
.topic.ready .topic-name { font-weight: var(--fw-semi); }

/* Split meter: left half = knowledge, right half = proof */
.meter { position: relative; height: 6px; border-radius: 3px; background: var(--bg-tertiary); overflow: hidden; }
.meter::after { content: ''; position: absolute; left: 50%; top: 0; bottom: 0; width: 1px; background: var(--bg-base); }
.meter-fill { position: absolute; top: 0; bottom: 0; }
.meter-fill.know { left: 0; background: var(--text-secondary); }
.meter-fill.proof { left: 50%; background: var(--success); }

.topic-stats { font-size: var(--text-2xs); color: var(--text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ok { color: var(--success); }
.bad { color: var(--danger); }

.draft-btn {
  flex-shrink: 0; padding: 2px 10px; border-radius: var(--radius-pill);
  background: var(--accent-soft); color: var(--accent);
  border: 1px solid color-mix(in oklch, var(--accent) 35%, transparent);
  font-size: var(--text-2xs); font-weight: var(--fw-semi); cursor: pointer; white-space: nowrap;
}
.draft-btn:hover:not(:disabled) { background: var(--accent); color: var(--bg-base); }
.draft-btn:disabled { opacity: 0.55; cursor: default; }
.skill-exists { flex-shrink: 0; font-size: var(--text-2xs); color: var(--success); font-family: var(--font-mono); white-space: nowrap; max-width: 120px; overflow: hidden; text-overflow: ellipsis; }
.growing { flex-shrink: 0; width: 34px; text-align: right; font-size: var(--text-2xs); color: var(--text-muted); font-variant-numeric: tabular-nums; }

.link-btn { margin-top: var(--space-1); background: none; border: none; padding: 0 var(--space-2); color: var(--accent); cursor: pointer; font-size: var(--text-2xs); }
.link-btn:hover { text-decoration: underline; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style>
