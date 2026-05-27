# Chat composer: hints + slash menu — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two affordances to the chat composer: a rule-based "what to do next" hint chip row, and a `/` popup listing available commands and skills.

**Architecture:** Frontend-only UI work (Vue 3 + Pinia) plus one new adapter RPC (`commands_list`) that enumerates `~/.claude/commands/*.md`. The dead `get_suggestions` RPC and `chat.suggestions` plumbing are removed as part of the same change. Hints are computed client-side from chat state — no LLM round-trip in v1.

**Tech Stack:** Vue 3 composition API, Pinia, TypeScript, NATS JSON-RPC, Node 20 + vitest (adapter side). Frontend has no unit-test runner; frontend correctness is verified by `vue-tsc` typecheck and manual browser testing.

**Spec:** `docs/superpowers/specs/2026-05-27-chat-hints-slash-menu-design.md`

**Naming note (deviation from spec §5.3):** the spec called the new RPC
`list_commands`, but the existing codebase uses `skills_list` /
`org_skills_list`. We will name ours `commands_list` for consistency.

**Testing note (deviation from spec §6):** the spec calls for unit tests of
`useChatHints` and `SlashMenu`. The frontend package has no unit-test
runner installed (only `vue-tsc` typecheck + Playwright for E2E). Adding
vitest to the frontend is out of scope for this feature. Frontend
correctness is verified by typecheck + the manual browser checklist in
Task 9. Adapter changes still have full vitest coverage.

---

## File map

**Adapter (Node 20 + vitest):**

| Path                                       | Action  | Responsibility                                                   |
|--------------------------------------------|---------|------------------------------------------------------------------|
| `adapter/src/frontmatter.ts`               | Create  | Shared `extractDescription(manifest)` helper.                    |
| `adapter/src/skills-rpc.ts`                | Modify  | Import shared helper, delete local copy.                         |
| `adapter/src/org-skills-rpc.ts`            | Modify  | Import shared helper, delete local copy.                         |
| `adapter/src/commands-rpc.ts`              | Create  | `listUserCommands(home)` walking `<home>/.claude/commands/*.md`. |
| `adapter/src/rpc.ts`                       | Modify  | Add `commands_list` case; remove `get_suggestions` case.         |
| `adapter/test/commands-rpc.test.ts`        | Create  | Vitest unit tests for `listUserCommands`.                        |
| `adapter/test/frontmatter.test.ts`         | Create  | Vitest unit tests for `extractDescription`.                      |

**Frontend (Vue 3 + Pinia):**

| Path                                                    | Action  | Responsibility                                                          |
|---------------------------------------------------------|---------|-------------------------------------------------------------------------|
| `frontend/src/types/commands.ts`                        | Create  | `CommandSummary` type.                                                  |
| `frontend/src/services/commands.ts`                     | Create  | `commandsService.list()` thin wrapper over `natsService.invoke`.        |
| `frontend/src/composables/useChatHints.ts`              | Create  | Pure rule-based hint generator.                                         |
| `frontend/src/components/chat/SlashMenu.vue`            | Create  | Popup component: filter, sections, keyboard nav, accept handler.        |
| `frontend/src/components/chat/ChatPanel.vue`            | Modify  | Mount SlashMenu, swap chip row source to hints, fill-not-send on click. |
| `frontend/src/stores/chat.ts`                           | Modify  | Remove `suggestions`, `loadSuggestions`, `Suggestion` import.           |
| `frontend/src/types/index.ts`                           | Modify  | Remove the now-unused `Suggestion` interface.                           |

---

## Task 1: Extract shared `extractDescription` helper

`skills-rpc.ts` and `org-skills-rpc.ts` already contain byte-identical copies of
`extractDescription`. The new `commands-rpc.ts` needs the same parser, which
would be a third copy. Extract once now.

**Files:**
- Create: `adapter/src/frontmatter.ts`
- Create: `adapter/test/frontmatter.test.ts`
- Modify: `adapter/src/skills-rpc.ts`
- Modify: `adapter/src/org-skills-rpc.ts`

- [ ] **Step 1: Write the failing test**

Create `adapter/test/frontmatter.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { extractDescription } from "../src/frontmatter.js";

describe("extractDescription", () => {
  it("returns the description from a leading YAML frontmatter block", () => {
    const manifest = "---\nname: foo\ndescription: A short summary\n---\n\nBody";
    expect(extractDescription(manifest)).toBe("A short summary");
  });

  it("strips surrounding single or double quotes", () => {
    const manifest = `---\ndescription: "Quoted text"\n---\n`;
    expect(extractDescription(manifest)).toBe("Quoted text");
  });

  it("returns empty string when there is no frontmatter", () => {
    expect(extractDescription("Just a body.\n")).toBe("");
  });

  it("returns empty string when the frontmatter lacks a description field", () => {
    expect(extractDescription("---\nname: foo\n---\n")).toBe("");
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd adapter && npx vitest run test/frontmatter.test.ts
```

Expected: FAIL with "Cannot find module '../src/frontmatter.js'".

- [ ] **Step 3: Create the shared module**

Create `adapter/src/frontmatter.ts`:

```ts
// Parses the `description:` field from a leading YAML frontmatter block.
// Shared by skills-rpc, org-skills-rpc, and commands-rpc — all of which
// surface a name + one-line description for SKILL.md / command files.
//
// Anything beyond the simplest single-line value (multi-line, escaped,
// CRLF) is treated as opaque and surfaced as an empty string.

export function extractDescription(manifest: string): string {
  const fmMatch = manifest.match(/^---\n(?<fm>[\s\S]*?)\n---\n/);
  const fm = fmMatch?.groups?.fm;
  if (!fm) return "";
  const dm = fm.match(/^description:\s*(?<val>.+?)\s*$/m);
  const val = dm?.groups?.val;
  if (!val) return "";
  return val.replace(/^['"]|['"]$/g, "");
}
```

- [ ] **Step 4: Run test, verify pass**

```bash
cd adapter && npx vitest run test/frontmatter.test.ts
```

Expected: 4 tests pass.

- [ ] **Step 5: Delete the duplicate from `skills-rpc.ts`**

In `adapter/src/skills-rpc.ts`:

Add import at the top (after the existing `node:fs/promises` import):

```ts
import { extractDescription } from "./frontmatter.js";
```

Delete the local `extractDescription` function (currently lines 58–69) entirely.

- [ ] **Step 6: Delete the duplicate from `org-skills-rpc.ts`**

Same change in `adapter/src/org-skills-rpc.ts`: add the import, delete the
local copy.

- [ ] **Step 7: Run the full adapter test suite**

```bash
cd adapter && npm test
```

Expected: all tests pass. (Skills tests indirectly exercise the now-shared
helper; they should continue to pass unchanged.)

- [ ] **Step 8: Commit**

```bash
git add adapter/src/frontmatter.ts adapter/test/frontmatter.test.ts \
        adapter/src/skills-rpc.ts adapter/src/org-skills-rpc.ts
git commit -m "refactor(adapter): hoist extractDescription into shared frontmatter util"
```

---

## Task 2: Adapter — `listUserCommands` module

Mirror of `skills-rpc.ts` for the `commands` directory.

**Files:**
- Create: `adapter/src/commands-rpc.ts`
- Create: `adapter/test/commands-rpc.test.ts`

- [ ] **Step 1: Write the failing test**

Create `adapter/test/commands-rpc.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listUserCommands } from "../src/commands-rpc.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "bioflow-commands-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeCmd(name: string, body: string) {
  const dir = join(home, ".claude", "commands");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.md`), body);
}

describe("listUserCommands", () => {
  it("returns [] when the commands directory does not exist", async () => {
    expect(await listUserCommands(home)).toEqual([]);
  });

  it("lists each .md file with its parsed description", async () => {
    writeCmd("init", "---\ndescription: Initialize a new project\n---\n\nbody");
    writeCmd("review", "---\ndescription: Review pending changes\n---\n\nbody");

    const out = await listUserCommands(home);

    expect(out).toEqual([
      { name: "init",   description: "Initialize a new project" },
      { name: "review", description: "Review pending changes"   },
    ]);
  });

  it("uses empty description when frontmatter is missing", async () => {
    writeCmd("plain", "Just a body, no frontmatter.\n");
    const out = await listUserCommands(home);
    expect(out).toEqual([{ name: "plain", description: "" }]);
  });

  it("ignores non-.md files and subdirectories", async () => {
    writeCmd("real", "---\ndescription: Real\n---\n");
    const dir = join(home, ".claude", "commands");
    writeFileSync(join(dir, "notes.txt"), "x");
    mkdirSync(join(dir, "subdir"));
    const out = await listUserCommands(home);
    expect(out.map(c => c.name)).toEqual(["real"]);
  });

  it("sorts results alphabetically by name", async () => {
    writeCmd("zebra", "---\ndescription: z\n---\n");
    writeCmd("alpha", "---\ndescription: a\n---\n");
    const out = await listUserCommands(home);
    expect(out.map(c => c.name)).toEqual(["alpha", "zebra"]);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

```bash
cd adapter && npx vitest run test/commands-rpc.test.ts
```

Expected: FAIL with "Cannot find module '../src/commands-rpc.js'".

- [ ] **Step 3: Implement the module**

Create `adapter/src/commands-rpc.ts`:

```ts
// Lists the user's slash commands under <home>/.claude/commands/<name>.md.
// Pure read-only file walk. Returns [] when the directory does not exist.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { extractDescription } from "./frontmatter.js";

export interface CommandSummary {
  name:        string;
  description: string;       // empty string when frontmatter has no description
}

export async function listUserCommands(home: string): Promise<CommandSummary[]> {
  const dir = join(home, ".claude", "commands");
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const out: CommandSummary[] = [];
  for (const it of entries) {
    if (!it.isFile()) continue;
    if (!it.name.endsWith(".md")) continue;
    const name = it.name.slice(0, -3);
    let manifest: string;
    try {
      manifest = await readFile(join(dir, it.name), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    out.push({ name, description: extractDescription(manifest) });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}
```

- [ ] **Step 4: Run the test, verify pass**

```bash
cd adapter && npx vitest run test/commands-rpc.test.ts
```

Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add adapter/src/commands-rpc.ts adapter/test/commands-rpc.test.ts
git commit -m "feat(adapter): list user slash commands from ~/.claude/commands"
```

---

## Task 3: Adapter — wire `commands_list` RPC, remove `get_suggestions`

**Files:**
- Modify: `adapter/src/rpc.ts`

- [ ] **Step 1: Add the import**

In `adapter/src/rpc.ts`, near the other RPC imports (around line 17–19),
add:

```ts
import { listUserCommands } from "./commands-rpc.js";
```

- [ ] **Step 2: Add the `commands_list` case**

In `adapter/src/rpc.ts`, immediately after the `org_skills_list` case
(currently ending around line 583), add:

```ts
      case "commands_list": {
        const commands = await listUserCommands(this.deps.home);
        return { success: true, commands };
      }
```

- [ ] **Step 3: Remove the dead `get_suggestions` case**

In `adapter/src/rpc.ts`, delete lines 225–226 (the entire `case "get_suggestions":` and its return):

```ts
      case "get_suggestions":
        return { success: true, suggestions: [] };
```

Leave no blank case behind.

- [ ] **Step 4: Build the adapter**

```bash
cd adapter && npm run build
```

Expected: TypeScript build succeeds with no errors.

- [ ] **Step 5: Run the full adapter test suite**

```bash
cd adapter && npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add adapter/src/rpc.ts
git commit -m "feat(adapter): expose commands_list RPC; drop unused get_suggestions"
```

---

## Task 4: Frontend — `CommandSummary` type and service

**Files:**
- Create: `frontend/src/types/commands.ts`
- Create: `frontend/src/services/commands.ts`

- [ ] **Step 1: Create the type**

Create `frontend/src/types/commands.ts`:

```ts
export interface CommandSummary {
  name:        string;
  description: string;
}
```

- [ ] **Step 2: Create the service**

Create `frontend/src/services/commands.ts`, mirroring `services/skills.ts`:

```ts
import { natsService } from './nats';
import type { CommandSummary } from '@/types/commands';

export const commandsService = {
  list: async (): Promise<CommandSummary[]> => {
    const r = await natsService.invoke('commands_list', {}) as
      { success: true; commands: CommandSummary[] };
    return r.commands;
  },
} as const;
```

- [ ] **Step 3: Verify typecheck passes**

```bash
cd frontend && npm run typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/types/commands.ts frontend/src/services/commands.ts
git commit -m "feat(frontend): add commandsService for commands_list RPC"
```

---

## Task 5: Frontend — `useChatHints` composable

A pure function of chat state that returns 0–2 hint chips. Lives in
`composables/` because there is no `composables` dir yet — create it.

**Files:**
- Create: `frontend/src/composables/useChatHints.ts`

- [ ] **Step 1: Define the composable**

Create `frontend/src/composables/useChatHints.ts`:

```ts
import { computed, type ComputedRef, type Ref } from 'vue'
import type { ChatMessage } from '@/types'
import type { ChatAttachment } from '@/services/chat-attachments'
import type { CreatedProject } from '@/services/project-from-drop'

export interface Hint {
  id:   string
  text: string
}

export interface HintInputs {
  messages:       Ref<ChatMessage[]>
  attachments:    Ref<ChatAttachment[]>
  pendingProject: Ref<CreatedProject | null>
}

// Rule-based "what to do next" chips. First matching rule wins.
//   - empty chat (no messages, no pending project) -> two starter hints
//   - pending project queued                       -> send-to-analyze hint
//   - uploads in flight                            -> none (chips already show)
//   - otherwise                                    -> none
export function useChatHints(inputs: HintInputs): ComputedRef<Hint[]> {
  return computed<Hint[]>(() => {
    const anyUploading = inputs.attachments.value.some(a => a.state === 'uploading')
    if (anyUploading) return []

    if (inputs.pendingProject.value) {
      return [{
        id: 'send-pending-project',
        text: `Send to start analyzing ${inputs.pendingProject.value.projectName}`,
      }]
    }

    if (inputs.messages.value.length === 0) {
      return [
        { id: 'describe',  text: 'Describe what you want to do' },
        { id: 'drop-file', text: 'Drop a file to start a project' },
      ]
    }

    return []
  })
}
```

- [ ] **Step 2: Verify typecheck passes**

```bash
cd frontend && npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/composables/useChatHints.ts
git commit -m "feat(frontend): add useChatHints composable for next-step chips"
```

---

## Task 6: Frontend — `SlashMenu.vue` component

Self-contained popup. Owns its own loaded lists (commands fetched once on
mount, skills pulled from the existing store).

**Files:**
- Create: `frontend/src/components/chat/SlashMenu.vue`

- [ ] **Step 1: Create the component**

Create `frontend/src/components/chat/SlashMenu.vue`:

```vue
<script setup lang="ts">
import { computed, ref, watch, onMounted } from 'vue'
import { commandsService } from '@/services/commands'
import { useSkillsStore } from '@/stores/skills'
import type { CommandSummary } from '@/types/commands'
import type { SkillSummary } from '@/types/skills'

interface SlashItem {
  kind: 'command' | 'skill'
  name: string
  description: string
}

const props = defineProps<{
  /** Full textarea value. Component decides whether to show itself. */
  input: string
}>()

const emit = defineEmits<{
  /** User accepted an item. Parent rewrites the input. */
  (e: 'accept', item: SlashItem): void
  /** User dismissed with Escape. Parent may clear leading "/". */
  (e: 'dismiss'): void
}>()

const skills = useSkillsStore()
const commands = ref<CommandSummary[]>([])
const commandsLoaded = ref(false)
const selected = ref(0)

const open = computed(() => props.input.startsWith('/'))

// Filter is the first token after the leading slash. "/br foo" -> "br".
const filter = computed(() => {
  if (!open.value) return ''
  const rest = props.input.slice(1)
  const ws = rest.search(/\s/)
  return (ws === -1 ? rest : rest.slice(0, ws)).toLowerCase()
})

async function ensureLoaded() {
  if (!commandsLoaded.value) {
    try { commands.value = await commandsService.list() }
    catch { commands.value = [] }
    commandsLoaded.value = true
  }
  if (skills.skills.length === 0 && !skills.loading) {
    await skills.load()
  }
}

watch(open, (isOpen) => {
  if (isOpen) ensureLoaded()
  selected.value = 0
})

watch(filter, () => { selected.value = 0 })

onMounted(() => { if (open.value) ensureLoaded() })

const matchedCommands = computed<SlashItem[]>(() =>
  commands.value
    .filter(c => c.name.toLowerCase().includes(filter.value))
    .map(c => ({ kind: 'command', name: c.name, description: c.description }))
)

const matchedSkills = computed<SlashItem[]>(() =>
  skills.skills
    .filter((s: SkillSummary) => s.name.toLowerCase().includes(filter.value))
    .map((s: SkillSummary) => ({ kind: 'skill', name: s.name, description: s.description }))
)

// Flat list in render order: commands first, then skills.
const flat = computed<SlashItem[]>(() => [...matchedCommands.value, ...matchedSkills.value])

watch(flat, (list) => {
  if (selected.value >= list.length) selected.value = Math.max(0, list.length - 1)
})

// Public API consumed by the parent's @keydown handler. Returns true when the
// menu handled the key (parent should preventDefault and skip its own logic).
function handleKey(e: KeyboardEvent): boolean {
  if (!open.value || flat.value.length === 0) {
    // Esc on an open-but-empty menu still dismisses.
    if (open.value && e.key === 'Escape') { emit('dismiss'); return true }
    return false
  }
  switch (e.key) {
    case 'ArrowDown':
      selected.value = (selected.value + 1) % flat.value.length
      return true
    case 'ArrowUp':
      selected.value = (selected.value - 1 + flat.value.length) % flat.value.length
      return true
    case 'Enter':
    case 'Tab':
      emit('accept', flat.value[selected.value])
      return true
    case 'Escape':
      emit('dismiss')
      return true
    default:
      return false
  }
}

defineExpose({ handleKey })

function clickItem(idx: number) {
  selected.value = idx
  emit('accept', flat.value[idx])
}
</script>

<template>
  <div v-if="open && flat.length > 0" class="slash-menu" role="listbox">
    <template v-if="matchedCommands.length > 0">
      <div class="slash-section">Commands</div>
      <div
        v-for="(c, i) in matchedCommands"
        :key="'cmd:' + c.name"
        class="slash-item"
        :class="{ 'is-selected': selected === i }"
        role="option"
        :aria-selected="selected === i"
        @mouseenter="selected = i"
        @mousedown.prevent="clickItem(i)"
      >
        <span class="slash-name">/{{ c.name }}</span>
        <span class="slash-desc">{{ c.description }}</span>
      </div>
    </template>
    <template v-if="matchedSkills.length > 0">
      <div class="slash-section">Skills</div>
      <div
        v-for="(s, j) in matchedSkills"
        :key="'skill:' + s.name"
        class="slash-item"
        :class="{ 'is-selected': selected === matchedCommands.length + j }"
        role="option"
        :aria-selected="selected === matchedCommands.length + j"
        @mouseenter="selected = matchedCommands.length + j"
        @mousedown.prevent="clickItem(matchedCommands.length + j)"
      >
        <span class="slash-name">{{ s.name }}</span>
        <span class="slash-desc">{{ s.description }}</span>
      </div>
    </template>
  </div>
</template>

<style scoped>
.slash-menu {
  position: absolute;
  left: 16px;
  right: 16px;
  bottom: calc(100% + 6px);
  max-height: 280px;
  overflow-y: auto;
  background: var(--bg-secondary, #1a1a1a);
  border: 1px solid var(--border, #333);
  border-radius: 8px;
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.25);
  padding: 4px 0;
  z-index: 10;
  font-size: 13px;
}
.slash-section {
  padding: 6px 12px 2px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted, #888);
}
.slash-item {
  display: flex;
  gap: 12px;
  align-items: baseline;
  padding: 6px 12px;
  cursor: pointer;
}
.slash-item.is-selected { background: var(--bg-tertiary, #2a2a2a); }
.slash-name { font-weight: 600; }
.slash-desc {
  color: var(--text-muted, #888);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
</style>
```

`mousedown.prevent` is used (not `click`) so the textarea keeps focus when an
item is selected by mouse.

- [ ] **Step 2: Verify typecheck passes**

```bash
cd frontend && npm run typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/chat/SlashMenu.vue
git commit -m "feat(frontend): add SlashMenu popup for commands and skills"
```

---

## Task 7: Frontend — wire SlashMenu and swap suggestions for hints in ChatPanel

This is the largest single change. It does three things to `ChatPanel.vue`:

1. Replace `chat.suggestions` chip row with `useChatHints` output, and change
   the click handler to fill-not-send.
2. Mount `SlashMenu` inside `.input-area`, anchored above the textarea.
3. Route textarea `@keydown` through the menu first.

**Files:**
- Modify: `frontend/src/components/chat/ChatPanel.vue`

- [ ] **Step 1: Add the new imports**

In `frontend/src/components/chat/ChatPanel.vue`, add to the existing
`<script setup>` import block (near the top of the file). Augment the
existing `from 'vue'` import to also include `toRef`, and add two new
imports below it:

```ts
import { ref, nextTick, watch, computed, onMounted, onBeforeUnmount, toRef } from 'vue'
// ...existing imports...
import SlashMenu from '@/components/chat/SlashMenu.vue'
import { useChatHints } from '@/composables/useChatHints'
```

- [ ] **Step 2: Wire the hints composable and add the refs**

In the `<script setup>` block, after the existing reactive refs but before
`function send()`, add:

```ts
const slashMenuRef = ref<InstanceType<typeof SlashMenu> | null>(null)
const inputRef = ref<HTMLTextAreaElement | null>(null)

const hints = useChatHints({
  messages:       toRef(chat, 'messages'),
  attachments,
  pendingProject,
})
```

`toRef(chat, 'messages')` returns a true `Ref` backed by the Pinia store's
reactive state, which is what `useChatHints` expects.

- [ ] **Step 3: Add the fill-not-send helper**

Replace the existing `useSuggestion` function (currently around line 122):

```ts
function useSuggestion(text: string) {
  input.value = text
  send()
}
```

with:

```ts
function applyHint(text: string) {
  input.value = text
  nextTick(() => inputRef.value?.focus())
}
```

- [ ] **Step 4: Update the textarea `@keydown` handler**

Replace the existing `handleKeydown` (around line 115):

```ts
function handleKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}
```

with:

```ts
function handleKeydown(e: KeyboardEvent) {
  if (slashMenuRef.value?.handleKey(e)) {
    e.preventDefault()
    return
  }
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
}
```

- [ ] **Step 5: Add the slash-menu accept/dismiss handlers**

In the `<script setup>` block, near `applyHint`, add:

```ts
function onSlashAccept(item: { kind: 'command' | 'skill'; name: string }) {
  input.value = item.kind === 'command'
    ? `/${item.name} `
    : `Use the ${item.name} skill: `
  nextTick(() => inputRef.value?.focus())
}

function onSlashDismiss() {
  if (input.value.startsWith('/')) input.value = ''
  nextTick(() => inputRef.value?.focus())
}
```

- [ ] **Step 6: Update the template — swap suggestions row for hints row**

In the `<template>` section, find the existing block (currently lines
472–482):

```vue
<!-- Suggestions -->
<div v-if="chat.suggestions.length > 0 && !chat.sending" class="suggestions">
  <button
    v-for="(s, i) in chat.suggestions.slice(0, 3)"
    :key="i"
    class="suggestion-btn"
    @click="useSuggestion(s.text)"
  >
    {{ s.text }}
  </button>
</div>
```

Replace with:

```vue
<!-- Hints -->
<div v-if="hints.length > 0 && !chat.sending" class="suggestions">
  <button
    v-for="h in hints"
    :key="h.id"
    class="suggestion-btn"
    @click="applyHint(h.text)"
  >
    {{ h.text }}
  </button>
</div>
```

(The `.suggestions` and `.suggestion-btn` CSS classes are reused as-is.)

- [ ] **Step 7: Mount the SlashMenu inside `.input-area`**

Locate the `<div class="input-area" ...>` block (around line 485). Inside it,
just before the `<div class="input-row">` element (around line 555), add:

```vue
<SlashMenu
  ref="slashMenuRef"
  :input="input"
  @accept="onSlashAccept"
  @dismiss="onSlashDismiss"
/>
```

No CSS change is needed: `.input-area` already declares
`position: relative` (verified at `ChatPanel.vue:647`), which is what the
popup's `position: absolute` anchors to.

- [ ] **Step 8: Add the `ref` to the textarea**

Find the textarea (around line 556):

```vue
<textarea
  v-model="input"
  class="message-input"
  ...
></textarea>
```

Add `ref="inputRef"`:

```vue
<textarea
  ref="inputRef"
  v-model="input"
  class="message-input"
  ...
></textarea>
```

- [ ] **Step 9: Run typecheck**

```bash
cd frontend && npm run typecheck
```

Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add frontend/src/components/chat/ChatPanel.vue
git commit -m "feat(frontend): wire SlashMenu and rule-based hints in ChatPanel"
```

---

## Task 8: Frontend — remove dead suggestions plumbing

Now that nothing in the UI reads `chat.suggestions`, the store and shared
type are dead. Remove them.

**Files:**
- Modify: `frontend/src/stores/chat.ts`
- Modify: `frontend/src/types/index.ts`

- [ ] **Step 1: Remove `Suggestion` from the imports in `chat.ts`**

In `frontend/src/stores/chat.ts` line 5–9, change:

```ts
import type {
  ChatInfo, ChatMessage, StreamMessage, StreamChunk,
  StepMessage, ChatFinished, Suggestion, AgentInfo,
  StepMessageData, TimelineStep, HarnessProgress,
} from '@/types'
```

to:

```ts
import type {
  ChatInfo, ChatMessage, StreamMessage, StreamChunk,
  StepMessage, ChatFinished, AgentInfo,
  StepMessageData, TimelineStep, HarnessProgress,
} from '@/types'
```

- [ ] **Step 2: Remove the `suggestions` ref**

In `frontend/src/stores/chat.ts`, delete line 18:

```ts
const suggestions = ref<Suggestion[]>([])
```

- [ ] **Step 3: Remove the `loadSuggestions` call site**

In `frontend/src/stores/chat.ts`, delete line 191:

```ts
    loadSuggestions(chatId)
```

- [ ] **Step 4: Remove the `loadSuggestions` definition**

In `frontend/src/stores/chat.ts`, delete lines 194–201 entirely:

```ts
  async function loadSuggestions(chatId: string) {
    try {
      const result = await natsService.invoke('get_suggestions', { chat_id: chatId }) as {
        success: boolean; suggestions: Suggestion[]
      }
      if (result?.success) suggestions.value = result.suggestions || []
    } catch { /* ignore */ }
  }
```

- [ ] **Step 5: Remove `suggestions` from the store's public return**

In `frontend/src/stores/chat.ts` line 487, change:

```ts
    sending, suggestions, agents, activeAgent,
```

to:

```ts
    sending, agents, activeAgent,
```

- [ ] **Step 6: Remove the `Suggestion` interface from types**

In `frontend/src/types/index.ts` lines 179–182, delete:

```ts
export interface Suggestion {
  text: string
  category?: string
}
```

(The unrelated local `interface Suggestion` inside
`frontend/src/components/files/H5adViewer.vue` stays — it's file-scoped and
unrelated.)

- [ ] **Step 7: Run typecheck**

```bash
cd frontend && npm run typecheck
```

Expected: no errors. If there are errors, they will be unused-import
warnings — fix by removing the unused imports they point to.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/stores/chat.ts frontend/src/types/index.ts
git commit -m "refactor(frontend): drop unused chat.suggestions plumbing"
```

---

## Task 9: End-to-end verification

Frontend has no unit-test runner, so this final step is manual.

**Files:** none modified

- [ ] **Step 1: Run typecheck on both halves**

```bash
cd adapter && npm run build && npm test
cd ../frontend && npm run typecheck
```

Expected: both succeed.

- [ ] **Step 2: Start the dev environment**

Follow the README's "Quick start (multi-user hub)" or the single-user
`docker-compose.dev.yml` flow. Open the chat UI in a browser.

- [ ] **Step 3: Verify hints — empty chat**

Open a fresh chat (no messages). Confirm two chips appear above the
textarea: "Describe what you want to do" and "Drop a file to start a
project".

- [ ] **Step 4: Verify hints — click fills, does not send**

Click "Describe what you want to do". Expected: the text fills the
textarea, the textarea is focused, **no message is sent**. The user can
edit and then press Enter to send.

- [ ] **Step 5: Verify hints — pending project**

Drag a non-image file onto the chat to start a project. After the project
status row appears, the hint chip should read "Send to start analyzing
`<projectName>`". Clicking it fills the kickoff prefix into the textarea.

- [ ] **Step 6: Verify slash menu — opens on `/`**

Clear the textarea and type `/`. Expected: popup appears above the
textarea with two sections ("Commands" and "Skills"), each populated.

- [ ] **Step 7: Verify slash menu — filtering**

Type `/br`. Expected: only items whose name contains `br` are visible.
(Example: `brainstorming` skill if installed.)

- [ ] **Step 8: Verify slash menu — keyboard nav**

With the menu open: ArrowDown moves the selection highlight down,
ArrowUp moves it up. Enter accepts the highlighted item.

- [ ] **Step 9: Verify slash menu — accept rewrites input**

Type `/init`, ArrowDown to the `init` command, press Enter. Expected:
textarea now reads `/init ` with cursor at the end; menu closes.
Repeat with a skill (e.g. `brainstorming`): textarea should read
`Use the brainstorming skill: `.

- [ ] **Step 10: Verify slash menu — Esc dismisses**

Type `/foo`, press Esc. Expected: textarea is cleared and the menu
closes.

- [ ] **Step 11: Verify slash menu — backspace closes**

Type `/foo`, then backspace until only the leading text remains. Once
the input no longer starts with `/`, the menu must disappear.

- [ ] **Step 12: Verify normal Enter-to-send still works**

With the menu closed (input does not start with `/`), type any
message and press Enter. Expected: message is sent as before.

- [ ] **Step 13: Final cleanup commit (if anything was tweaked during testing)**

If the manual run exposed any CSS or focus issue requiring a fix, commit
it now. Otherwise, this step is a no-op.

---

## Done criteria

- Adapter `commands_list` RPC works and is tested; `get_suggestions` is gone.
- `extractDescription` is defined once in `frontmatter.ts`.
- Frontend chat panel shows rule-based hint chips that fill without sending.
- Slash menu opens on `/`, lists commands + skills, supports keyboard nav,
  and rewrites the input on accept.
- `chat.suggestions` and the unused `Suggestion` type are removed.
- `npm run typecheck` (frontend) and `npm test` (adapter) both pass.
