# Chat composer: hints + slash menu

Status: draft (awaiting user review)
Owner: lili
Date: 2026-05-27

## 1. Problem

The chat input in `ChatPanel.vue` is a bare textarea. New users have no signal
of what to type next, and discoverability of installed commands and skills is
zero — they have to know the command name or trust the agent to pick a skill.

Two small affordances close the gap:

1. A row of "what to do next" hint chips above the input.
2. A popup when the input starts with `/` that lists available commands and
   skills, filterable by what's typed after the slash.

## 2. Goals

- Show a hint chip row above the input when there is something useful to
  suggest, hide it otherwise.
- When the input starts with `/`, show a keyboard-navigable popup of matching
  commands and skills. Selecting an item inserts text into the input; the user
  hits Enter themselves to send.
- Replace the existing always-empty `chat.suggestions` plumbing — do not stack
  a second mechanism on top of it.

## 3. Non-goals (v1)

- LLM-generated follow-up suggestions after each assistant turn. The existing
  `get_suggestions` RPC was wired for this but never implemented; v1 stays
  deterministic.
- An `@` menu for agents. Possible follow-up.
- Fuzzy ranking, command argument hints, history-based reordering.

## 4. Existing state of the code

- `frontend/src/components/chat/ChatPanel.vue` lines 472–482 already render
  up to 3 `chat.suggestions` as chips. `useSuggestion(text)` fills the input
  and immediately sends.
- `frontend/src/stores/chat.ts` calls `loadSuggestions(chatId)` which invokes
  the NATS RPC `get_suggestions`.
- `adapter/src/rpc.ts:225` returns `{ success: true, suggestions: [] }` —
  permanently empty. The whole client-side suggestion machinery is dead.
- `useSkillsStore()` (`frontend/src/stores/skills.ts`) already lists user
  skills as `{ name, description }` and is loaded elsewhere in the app.
- `~/.claude/commands/*.md` exists on every user workspace (see
  `hub/workspaces/*/.claude/commands`) but is not enumerated by any RPC.
- Agents are listed via `get_agents` (`adapter/src/rpc.ts:228`) — not used
  by this feature in v1 but pattern reference for the new `list_commands`.

## 5. Design

### 5.1 Hints

**Source:** a new pure composable `frontend/src/composables/useChatHints.ts`
that returns a reactive `hints: Ref<Hint[]>` computed from chat state. No
network call.

```ts
interface Hint { id: string; text: string; }
```

**Rules v1** (first match wins; max 2 hints shown):

| Condition                                                  | Hints                                                              |
|------------------------------------------------------------|--------------------------------------------------------------------|
| `chat.messages.length === 0` and no `pendingProject`       | "Describe what you want to do" · "Drop a file to start a project"  |
| `pendingProject` exists                                    | "Send to start analyzing `<projectName>`"                          |
| any upload in `attachments` is `uploading`                 | (none — hide row, upload chips already communicate state)          |
| otherwise                                                  | (none — hide row)                                                  |

The composable's only inputs are: `chat.messages.length`, `pendingProject`,
`attachments`. It is testable in isolation with a stub object.

**Behavior change vs today:** clicking a hint chip now **fills the textarea**
and focuses it. It does **not** auto-send. This matches the slash-menu
behavior and lets the user edit before sending. The old `useSuggestion(text)`
helper (which sent immediately) is removed.

**Cleanup:**

- Remove `chat.suggestions`, `chat.loadSuggestions`, and the call site in
  `chat.ts` that invokes it.
- Remove `case "get_suggestions"` from `adapter/src/rpc.ts`.
- Remove the `Suggestion` type from `frontend/src/types/index.ts` if it has
  no other consumers (verified during implementation).

### 5.2 Slash menu

**Component:** `frontend/src/components/chat/SlashMenu.vue`.

**Activation:** open when `input.value.startsWith('/')`. Close when it no
longer does, when Esc is pressed, or when the user clicks outside. The
filter string is `input.value.slice(1)` up to the first whitespace.

**Anchoring:** absolutely positioned above the textarea, left-aligned to
it, opens upward (the textarea sits at the bottom of the panel). Max
height with internal scroll. The existing `.input-row` has
`position: relative; z-index: 0` — the popup uses a higher z-index and is
appended inside `.input-area` so its position follows the textarea.

**Data:**

```ts
interface SlashItem {
  kind: 'command' | 'skill';
  name: string;          // 'init', 'brainstorming', ...
  description: string;   // first frontmatter description, may be empty
}
```

- **Commands** — new NATS RPC `list_commands` mirroring `get_agents`:
  reads `<home>/.claude/commands/*.md`, returns `{ name, description }`
  per file. `description` parsed from the same `---\ndescription: ...\n---`
  frontmatter pattern that `skills-rpc.ts:extractDescription()` already
  handles — extract that helper to a shared util (or inline; decide
  during implementation, keeping it small).
- **Skills** — read directly from `useSkillsStore().skills`. If
  `skills.length === 0`, trigger a one-time `load()`.

Both lists are loaded once on first slash trigger and cached in the
component's local state for the chat session. They're cheap to refresh
on demand.

**Filtering:** case-insensitive substring match against `name`. Items
are split into two sections (Commands, then Skills), each section
hidden when empty. Selection index is global across visible items.

**Keyboard:**

| Key       | Action                                                |
|-----------|-------------------------------------------------------|
| ArrowDown | move selection to next visible item                   |
| ArrowUp   | move selection to previous visible item               |
| Enter     | accept selected item                                  |
| Tab       | accept selected item                                  |
| Escape    | close menu (input unchanged)                          |
| (other)   | passes through to textarea — typing keeps filter live |

`@keydown` on the textarea checks first whether the menu is open and
intercepts these keys before existing handlers (Enter-to-send).

**Mouse:** hover moves selection; click accepts.

**Accept action:**

- Command: replace `input.value` with `/<name> ` (trailing space), set
  caret to end, keep focus.
- Skill: replace `input.value` with `Use the <name> skill: `, set caret
  to end, keep focus. (Skills are not slash-invokable in Claude Code; we
  expand to a natural-language phrasing the agent will act on.)

In both cases the menu closes (because input no longer starts with `/`).
The user types remaining context then hits Enter to send.

### 5.3 File changes

| File                                                       | Change                                                                |
|------------------------------------------------------------|-----------------------------------------------------------------------|
| `frontend/src/components/chat/ChatPanel.vue`               | Swap suggestions chip source to `useChatHints`; mount `SlashMenu`; route keydown through menu first; change click handler to fill-not-send. |
| `frontend/src/components/chat/SlashMenu.vue`               | New. Popup + filtering + keyboard nav.                                |
| `frontend/src/composables/useChatHints.ts`                 | New. Pure rule-based hint generator.                                  |
| `frontend/src/stores/chat.ts`                              | Remove `suggestions` state, `loadSuggestions`, call site, and the `Suggestion` import. |
| `frontend/src/services/nats.ts` (or equivalent client)     | Add `listCommands()` wrapper if RPC clients are declared centrally.   |
| `adapter/src/rpc.ts`                                       | Add `case "list_commands"`; remove `case "get_suggestions"`.          |
| `adapter/src/commands-rpc.ts`                              | New. Walks `<home>/.claude/commands/*.md`, parses frontmatter.        |
| `frontend/src/types/index.ts`                              | Remove `Suggestion` type if unused after cleanup.                     |

### 5.4 Data flow

```
ChatPanel.vue
 ├── useChatHints(chat, attachments, pendingProject) -> Hint[]
 │     └── rendered as chip row above input (fill-not-send on click)
 │
 └── textarea
       ├── @keydown -> SlashMenu.handleKeydown (if open) else handleKeydown
       └── SlashMenu
             ├── on first open: nats.invoke('list_commands') + skillsStore.load()
             ├── filter by input.slice(1)
             ├── render Commands section, Skills section
             └── on accept: rewrite input.value, focus textarea
```

## 6. Testing

**Unit:**

- `useChatHints.test.ts` — each rule produces the expected hint list given a
  stub chat state.
- `SlashMenu.test.ts` — given a fixed set of items, `/br` filters to entries
  whose name contains `br`; arrow keys move selection; Enter calls the
  accept handler with the right item.

**Manual:**

- Fresh chat: hint row shows the two empty-state hints. Click one — input
  fills, focus is on textarea, nothing sent.
- Drop a file: pending-project hint appears with the project name; click
  fills the kickoff prefix.
- Type `/` in empty input: menu opens with Commands + Skills.
- Type `/br`: menu filters live to items containing `br`.
- Arrow Down, Enter: input becomes `/init ` (or `Use the brainstorming
  skill: `); menu closes; cursor at end.
- Esc with menu open: menu closes, input unchanged.
- Type `/foo bar`: menu stays open (input still starts with `/`). Filter
  segment is the first token after the slash (`foo`), so the list reflects
  matches for `foo` regardless of trailing text.
- Backspace the leading `/`: menu closes.

## 7. Risks and mitigations

- **Menu position bugs** — anchoring inside `.input-area` should keep the
  popup aligned with the textarea across resize. If `position: absolute`
  inside the existing relative ancestor proves flaky, fall back to a
  Floating UI-style measured offset. Defer until we see a problem.
- **Removing `chat.suggestions` breaks an unseen consumer** — grep
  for `chat.suggestions` and `loadSuggestions` first; current grep shows
  only ChatPanel.vue and chat.ts itself.
- **Empty descriptions** — skills/commands with no frontmatter description
  render the name only. That's fine; it matches `skills-rpc.ts` behavior.

## 8. Open questions

None blocking. Decided:

- Slash select inserts text, does not auto-send. (Confirmed with user.)
- Hint chips fill, do not send (consistent with slash select).
- v1 hints are rule-based, no LLM round-trip.
- Commands and skills under one `/` menu, sectioned.
