# Skill Plan — Next Phase

## Context

`claude-bioflow` already hosts three kinds of reusable assets under `/home/node/.claude/` inside the devcontainer — **skills** (`skills/*.md`), **agents** (`agents/*.md`), and nothing yet for multi-step workflows. Today:

- Skills are **invisible** to the end user. The embedded Claude Code CLI autodiscovers them and lazy-loads their bodies via the `Skill` tool when the agent decides one applies. Fine for context efficiency, terrible for discoverability.
- Agents have a UI (`AgentPanel.vue` + `get_agents`/`set_active_agent` RPCs) but `set_active_agent` is effectively **a no-op**: `runTurn` in `adapter/src/claude.ts` never reads the stored `active_agent` from the chat row, so picking an agent does nothing to the next turn.
- There is no concept of a **multi-step task path** at all.

**Goal of this phase.** A single "Guidance" tab in the right drawer that lists skills, agents, and task paths. Unify activation through one mechanism. Picking an entry **prepends a short directive to the next user turn** (no preloading of skill bodies — the CLI still lazy-loads). Context cost stays ≈ today; the model no longer deliberates on which skill to pick; the latent `set_active_agent` no-op is fixed as a side effect.

## Design

### Directive-prepend model

When a chat has an active guidance entry, `runTurn` builds the prompt as:

```
<guidance>
{directive}
</guidance>

{original user message}
```

Where `{directive}` is:

| Kind        | Directive                                                                                   |
|-------------|---------------------------------------------------------------------------------------------|
| skill       | `Use the skill named "<name>" to complete this task.`                                       |
| agent       | `Dispatch the "<name>" agent to handle this task.`                                          |
| task_path   | Numbered list of steps: `1. Use skill "X"\n2. Dispatch agent "Y"\n...` + `Start with step 1.` |

The CLI sees the skill/agent list in its system reminder and routes via its own `Skill` / `Agent` tools, so **no skill bodies enter our system prompt**.

### Task paths — new file format

New directory `~/.claude/task-paths/*.yaml` (host: `./hub/workspaces/<user>/.claude/task-paths/`). Add a bind mount to `docker-compose.dev.yml` next to the existing skills/agents mounts (lines 44–45). Format:

```yaml
name: "scRNA QC + cluster"
description: "Standard single-cell pipeline: 10x → QC → HVG → cluster → annotate"
steps:
  - kind: skill
    name: scanpy-qc
  - kind: skill
    name: scanpy-hvg-cluster
  - kind: agent
    name: cell-type-annotator
```

Seed two or three examples under `hub/workspaces/shared/task-paths/` so devs see the shape.

### Unified storage on the chat row

Replace `chat.active_agent` with two columns on the chats table: `active_guidance_kind` (`"skill" | "agent" | "task_path" | null`) and `active_guidance_name` (text | null). `set_active_agent` stays as a backward-compat alias that sets kind=`"agent"`.

## Files to touch

### Adapter (TypeScript)

- **NEW `adapter/src/guidance.ts`**
  - `listGuidance(home)` — reads the three directories, parses frontmatter for `.md` (name + description) and YAML for task paths, returns `{skills, agents, task_paths}`. Skips unreadable files with a warning.
  - `buildDirective({kind, name}, registry)` — produces the directive string. For `task_path`, loads its steps and formats them.
- **`adapter/src/rpc.ts`**
  - New case `list_guidance` → calls `listGuidance(this.deps.home)`, returns the three arrays.
  - New case `set_active_guidance` → `{chat_id, kind, name|null}` stores on chat row.
  - Keep `set_active_agent` as a thin wrapper that routes to the same setter with `kind="agent"`.
  - `get_agents` stays (frontend compat until we retire it).
- **`adapter/src/chats-repo.ts`**
  - Add columns `active_guidance_kind`, `active_guidance_name` (one-shot `ALTER TABLE` migration in the same style as existing column additions).
  - Add `setActiveGuidance(chatId, kind, name)` and `getActiveGuidance(chatId)`.
  - Deprecate `setActiveAgent` by routing it through the new setter.
- **`adapter/src/claude.ts`**
  - In `runTurn`, after resolving the chat row, call `buildDirective(...)` if guidance is set and prepend to the user prompt. Leave the SDK `query` options unchanged.

### Frontend (Vue)

- **NEW `frontend/src/stores/guidance.ts`**
  - `loadGuidance()` → `list_guidance` RPC.
  - `activate(kind, name)` → `set_active_guidance`.
  - `clear()` → `set_active_guidance` with `name: null`.
  - State: `skills`, `agents`, `taskPaths`, `active: {kind, name} | null`.
- **NEW `frontend/src/components/guidance/GuidancePanel.vue`**
  - Modeled on `AgentPanel.vue`. Three tabs: Skills / Agents / Task paths.
  - Card per entry (name + description); click activates; currently active entry gets an "Active" badge and a "Clear" button at the top.
  - For task paths, expand to show the step list in the card body.
- **`frontend/src/layouts/MainLayout.vue`**
  - Add a "Guidance" toggle button to the right-drawer toggle row (~lines 150–167). On click, render `GuidancePanel.vue`.
- **Retire `AgentPanel.vue` as a separate panel.** Its functionality (list agents + activate) is subsumed by the Agents tab in `GuidancePanel.vue`. Remove the old toggle button in the same edit.

### Infra

- **`docker-compose.dev.yml`** — new volume mount alongside the existing skills/agents mounts:
  ```yaml
  - ./hub/workspaces/devuser/.claude/task-paths:/home/node/.claude/task-paths
  ```
- **`image/Dockerfile`** — create `/home/node/.claude/task-paths` alongside the other `.claude/*` dirs at build time (same block as lines 59–60).
- **`hub/workspaces/shared/task-paths/`** — seed 2–3 example `.yaml` files.

## Why this helps context loading

- Skills and agents still lazy-load via the CLI's Skill/Agent tools — no preloading.
- The added directive is 1–5 lines of text; negligible overhead versus today.
- A task path's body is just a numbered list of names, not the skill content.
- Removes the model's "decide which skill to pick" deliberation, which can cost hundreds of tokens on ambiguous prompts.

## Verification

**Unit tests (vitest, in `adapter/test/`)**
- `guidance.test.ts` — `listGuidance` parses valid md + yaml, skips malformed files, handles missing dirs. `buildDirective` produces expected strings for each kind.
- Extend `chats-repo.test.ts` — round-trip `setActiveGuidance` / `getActiveGuidance` and backward-compat `setActiveAgent` → kind=`"agent"`.
- New `rpc-guidance.test.ts` (in the style of `notebook-rpc.test.ts`) that stubs a `ChatsRepo` and asserts `set_active_guidance` and `list_guidance` work end-to-end.

**Manual / E2E**
1. `npm run build` in `frontend/`, rebuild adapter image, `docker compose -f docker-compose.dev.yml up`.
2. Drop a test skill under `hub/workspaces/devuser/.claude/skills/` and a task-path YAML under `.claude/task-paths/`.
3. Open the UI, click the new Guidance tab. Confirm all three categories populate.
4. Activate a skill. Send a chat message.
5. In the adapter logs (add a `console.log` of the final prompt just before `query()` returns, gated on `DEBUG_PROMPT=1`), confirm the `<guidance>` block precedes the user text.
6. Activate a task path. Send a chat message. Confirm the directive lists the steps in order and the agent dispatches the first one via the `Skill` or `Agent` tool.
7. Clear guidance. Send another message. Confirm no `<guidance>` block appears.

## Out of scope (this phase)

- Parameterized templates (e.g. "Cluster cells" with `n_clusters` inputs) — can come later as v2 on top of task paths.
- A skill-body preview pane in the UI — nice-to-have; would require a `get_guidance_detail` RPC. Not blocking.
- Per-notebook guidance (pairing with the per-notebook kernel refactor) — today guidance is per-chat; extending to notebooks is a separate design question.

## Suggested sequencing

1. **Adapter backend** — `guidance.ts`, `chats-repo.ts` migration, `rpc.ts` new cases, `claude.ts` directive injection + their vitest suites.
2. **Infra** — `Dockerfile`, `docker-compose.dev.yml` mount, seed `hub/workspaces/shared/task-paths/`.
3. **Frontend** — `guidance.ts` store, `GuidancePanel.vue`, `MainLayout.vue` wire-up, retire old `AgentPanel.vue` panel button.
4. **E2E manual verification** per the checklist above.
5. Commit in two logical chunks: (a) adapter + infra + tests, (b) frontend wire-up.
