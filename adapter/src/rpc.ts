// RPC dispatch: maps frontend method names to handlers. The frontend contract
// is pinned — see pantheon-frontend/src/stores/chat.ts for the list of calls.

import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { ChatsRepo } from "./chats-repo.js";
import { ChpcBridge, type OpenRequest } from "./chpc-bridge-rpc.js";
import { runTurn } from "./claude.js";
import { AbortRegistry, ChatMutexRegistry } from "./concurrency.js";
import { FileManager } from "./fs-rpc.js";
import { readSessionMessages, type LegacyMessage } from "./history.js";
import { H5adService } from "./h5ad-rpc.js";
import { KernelBridge, type IOPubEvent } from "./kernel.js";
import { MemoryRpcClient } from "./memory-rpc.js";
import { NotebookManager } from "./notebook-rpc.js";
import { ShareRpcClient } from "./share-rpc.js";
import { listOrgSkills } from "./org-skills-rpc.js";
import { listUserSkills } from "./skills-rpc.js";
import type { StreamEvent } from "./types.js";

export interface RpcDeps {
  serviceId: string;
  workspaceRoot: string;
  chats: ChatsRepo;
  home: string;
  defaultProjectCwd: string; // where `chat` runs by default (a project dir)
  publishStream: (streamId: string, ev: StreamEvent) => void;
  /** Raw NATS publish for non-chat streams (notebook IOPub, etc.). */
  publishRaw: (subject: string, envelope: Record<string, unknown>) => void;
  /** Subject for streams (frontend `pantheon.stream.<id>`). */
  streamSubject: (streamId: string) => string;
  /** Path to the Python kernel bridge script. */
  kernelBridgePath: string;
  /** Idle-cull threshold (ms). 0 disables automatic culling. */
  kernelIdleCullMs?: number;
  /** How often to check for cull (ms). Defaults to 60_000. */
  kernelCullCheckIntervalMs?: number;
  /** Memory API client. null when MEMORY_API_URL is not configured. */
  memory: MemoryRpcClient | null;
  /** Share API client. null when MEMORY_API_URL is not configured. */
  share: ShareRpcClient | null;
}

export class RpcRouter {
  private chats: ChatsRepo;
  private files: FileManager;
  private notebooks: NotebookManager;
  private h5ad: H5adService;
  private chpc: ChpcBridge;
  private mutexes = new ChatMutexRegistry();
  private aborts = new AbortRegistry();

  constructor(private deps: RpcDeps) {
    this.chats = deps.chats;
    this.files = new FileManager(deps.workspaceRoot);
    // CHPC bridge: publishes OpenEvent frames on pantheon.stream.chpc_bridge_events.
    this.chpc = new ChpcBridge(deps.home, (ev) => {
      const subject = deps.streamSubject("chpc_bridge_events");
      deps.publishRaw(subject, {
        type: "chpc_bridge",
        session_id: deps.serviceId,
        timestamp: Date.now() / 1000,
        data: ev,
      });
    });
    // Kernel session_id = `<prefix>_<hash-of-notebook-path>`. One kernel
    // per notebook so their variable namespaces don't bleed together.
    const kernelSessionPrefix = `k_${deps.serviceId.slice(0, 16)}`;
    const kernelFactory = (sessionId: string): KernelBridge =>
      new KernelBridge({
        bridgePath: deps.kernelBridgePath,
        sessionId,
        onIopub: (sid, ev) => this.publishIopub(sid, ev),
        cullIdleMs: deps.kernelIdleCullMs,
        cullCheckIntervalMs: deps.kernelCullCheckIntervalMs,
        onCulled: (sid, reason) => this.publishCulled(sid, reason),
      });
    this.notebooks = new NotebookManager(
      deps.workspaceRoot,
      kernelFactory,
      kernelSessionPrefix,
    );
    // h5ad viewer reuses the same kernel-factory contract (Python child
    // process, iopub republished to NATS) but pins a single session id so
    // the AnnData cache survives across plot calls.
    this.h5ad = new H5adService({
      serviceId: deps.serviceId,
      workspaceRoot: deps.workspaceRoot,
      kernelFactory,
    });
  }

  private settingsPath(): string {
    return path.join(this.deps.home, ".claude", "settings.json");
  }

  private async readSettings(): Promise<Record<string, unknown>> {
    try {
      const raw = await fs.readFile(this.settingsPath(), "utf8");
      return JSON.parse(raw) as Record<string, unknown>;
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
  }

  private async writeSettings(obj: Record<string, unknown>): Promise<void> {
    await fs.writeFile(this.settingsPath(), JSON.stringify(obj, null, 2) + "\n", "utf8");
  }

  private publishCulled(
    sessionId: string,
    reason: { idleMs: number; thresholdMs: number },
  ): void {
    // Publish a synthetic iopub-style status message so any frontend listening
    // on notebook_iopub_<sessionId> learns the kernel was culled. Next
    // executeCell will respawn lazily.
    const subject = this.deps.streamSubject(`notebook_iopub_${sessionId}`);
    this.deps.publishRaw(subject, {
      type: "notebook",
      session_id: this.deps.serviceId,
      timestamp: Date.now() / 1000,
      data: {
        msg_type: "status",
        content: { execution_state: "dead", cull_reason: reason },
      },
      metadata: { cell_id: undefined },
    });
  }

  private publishIopub(sessionId: string, ev: IOPubEvent): void {
    const subject = this.deps.streamSubject(`notebook_iopub_${sessionId}`);
    this.deps.publishRaw(subject, {
      type: "notebook",
      session_id: this.deps.serviceId,
      timestamp: Date.now() / 1000,
      data: {
        msg_type: ev.msg_type,
        content: ev.content,
      },
      metadata: { cell_id: ev.cell_id ?? undefined },
    });
  }

  abortAll(): void {
    this.aborts.abortAll();
    this.notebooks.shutdownAll();
    this.h5ad.shutdown();
  }

  async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    const short = method === "chat"
      ? `chat(chat_id=${String(params.chat_id).slice(0, 8)}..., len=${(params.message as unknown[])?.length ?? 0})`
      : method;
    console.log(`[rpc] -> ${short}`);
    try {
      const result = await this.dispatchInner(method, params);
      console.log(`[rpc] <- ${method} ok`);
      return result;
    } catch (e) {
      console.error(`[rpc] <- ${method} err:`, e instanceof Error ? e.stack ?? e.message : e);
      throw e;
    }
  }

  private async dispatchInner(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "get_endpoint":
        return { success: true, service_id: this.deps.serviceId };

      case "get_model": {
        const cur = await this.readSettings();
        return { success: true, model: (cur.model as string) ?? "claude-sonnet-4-6" };
      }

      case "set_model": {
        const model = params.model as string;
        if (!model || typeof model !== "string") throw new Error("model required");
        const cur = await this.readSettings();
        cur.model = model;
        await this.writeSettings(cur);
        return { success: true, model };
      }

      case "list_chats": {
        const chats = await this.chats.list();
        return { success: true, chats };
      }

      case "create_chat": {
        const name = (params.chat_name as string | undefined) ?? "New chat";
        const chatId = crypto.randomUUID();
        await this.chats.create(chatId, name);
        return { success: true, chat_id: chatId };
      }

      case "delete_chat": {
        const chatId = params.chat_id as string;
        await this.chats.delete(chatId);
        this.mutexes.delete(chatId);
        return { success: true };
      }

      case "update_chat_name": {
        const chatId = params.chat_id as string;
        const name = params.chat_name as string;
        await this.chats.updateName(chatId, name);
        return { success: true };
      }

      case "get_chat_messages": {
        const chatId = params.chat_id as string;
        const chat = await this.chats.read(chatId);
        // Use the real SDK session UUID if we have one, else fall back to chat_id.
        const sessionUuid = chat?.session_id ?? chatId;
        const messages = await readSessionMessages(
          this.deps.home,
          this.deps.defaultProjectCwd,
          sessionUuid,
        );
        return { success: true, messages };
      }

      case "get_suggestions":
        return { success: true, suggestions: [] };

      case "get_agents": {
        // Hide harness-internal subagents (planner/executor/reviewer of the
        // tick harness) from the user-facing agents listing. They're dispatched
        // by the orchestrator via the Task tool, not picked by the user.
        // Convention: names starting with `tick-` or `_` are internal.
        const agentsDir = path.join(this.deps.home, ".claude", "agents");
        const names = await fs.readdir(agentsDir).catch(() => [] as string[]);
        const agents = names
          .filter((n) => n.endsWith(".md"))
          .map((n) => n.replace(/\.md$/, ""))
          .filter((n) => !n.startsWith("tick-") && !n.startsWith("_"))
          .map((name) => ({
            name,
            instructions: "",
            tools: [],
            toolsets: [],
            icon: "",
            not_loaded_toolsets: [],
            model: null,
            models: [],
          }));
        return { success: true, agents, can_switch_agents: false };
      }

      case "get_harness_mode": {
        const flag = path.join(this.deps.home, ".claude", ".harness_active");
        const active = await fs.stat(flag).then(() => true).catch(() => false);
        // installed = the orchestrator command + tick-* agents are present.
        const cmdFile = path.join(this.deps.home, ".claude", "commands", "tick.md");
        const installed = await fs.stat(cmdFile).then(() => true).catch(() => false);
        return { success: true, active, installed };
      }

      case "set_harness_mode": {
        const enabled = Boolean(params.enabled);
        const flag = path.join(this.deps.home, ".claude", ".harness_active");
        if (enabled) {
          await fs.mkdir(path.dirname(flag), { recursive: true });
          await fs.writeFile(flag, "");
        } else {
          await fs.unlink(flag).catch(() => { /* not present is fine */ });
        }
        return { success: true, active: enabled };
      }

      case "get_harness_progress": {
        // Resolution order — first hit wins, no cross-session fallback:
        //   1. chat_id → chats.project_dir            (explicit, persisted binding)
        //   2. chat_id → local_projects/<chat.name>/  (legacy: drop-created
        //      chats from before the project_dir column existed still have
        //      name === dir, so we read by name. If found, persist as
        //      project_dir so the next call hits path #1.)
        //   3. chat_id → scan message history for local_projects/<slug>/
        //      mentions. Catches typed-prompt chats whose name doesn't
        //      match the bootstrap-picked slug (e.g. chat "Run PBMC3k…"
        //      bound implicitly to local_projects/pbmc-smoke/). Persists
        //      the inferred binding too.
        //   4. project_name param → local_projects/<name>/  (manual override
        //      from the UI, e.g. before a chat is selected).
        //
        // We deliberately removed the old "most-recently-modified within 6h"
        // global fallback. It let chat A see chat B's plan whenever B's run
        // was the most recent activity in the workspace — the exact
        // cross-session leak the user wanted gone.
        const projectsRoot = path.join(this.deps.workspaceRoot, "local_projects");

        const tryPath = async (p: string): Promise<string | null> => {
          try { return await fs.readFile(p, "utf8"); }
          catch { return null; }
        };

        const isSafeProjectDir = (d: string): boolean => {
          // Workspace-relative, no traversal, no leading slash. We don't
          // require the local_projects/ prefix — a binding outside that root
          // is unusual but not invalid (e.g. a shared folder), and the
          // workspace-root check below catches escapes.
          if (!d || d.startsWith("/")) return false;
          if (d.includes("..")) return false;
          if (d.startsWith(".")) return false;
          return true;
        };

        const resolveInWorkspace = (rel: string): string | null => {
          const abs = path.resolve(this.deps.workspaceRoot, rel);
          if (!abs.startsWith(this.deps.workspaceRoot + path.sep) && abs !== this.deps.workspaceRoot) {
            return null;
          }
          return abs;
        };

        const chatIdParam = (params.chat_id as string | undefined)?.trim();
        const projectNameParam = (params.project_name as string | undefined)?.trim();

        let raw: string | null = null;
        let matchedDir: string | null = null;     // workspace-relative
        let matchedDisplay: string | null = null; // last path segment for the UI

        // Path #1: explicit binding.
        let chatRow = chatIdParam ? await this.chats.read(chatIdParam) : null;
        if (chatRow?.project_dir && isSafeProjectDir(chatRow.project_dir)) {
          const abs = resolveInWorkspace(chatRow.project_dir);
          if (abs) {
            raw = await tryPath(path.join(abs, "progress.md"));
            if (raw != null) {
              matchedDir = chatRow.project_dir;
              matchedDisplay = path.basename(chatRow.project_dir);
            }
          }
        }

        // Path #2: legacy name-match for chats with no explicit binding.
        // Once found, persist so the agent's cwd picks it up too.
        if (raw == null && chatRow && !chatRow.project_dir) {
          const name = chatRow.name?.trim();
          if (name && !name.includes("/") && !name.startsWith(".") && name !== "New chat") {
            const rel = `local_projects/${name}`;
            const abs = resolveInWorkspace(rel);
            if (abs) {
              raw = await tryPath(path.join(abs, "progress.md"));
              if (raw != null) {
                matchedDir = rel;
                matchedDisplay = name;
                // Fire-and-forget: backfill the binding so subsequent calls
                // (and runChat's cwd) use the explicit path.
                this.chats.setProjectDir(chatRow.chat_id, rel).catch((e) => {
                  console.warn(`[rpc] backfill project_dir for ${chatRow!.chat_id}:`, e);
                });
              }
            }
          }
        }

        // Path #3: history-scan inference. The agent (especially
        // tick-bootstrap) routinely echoes the absolute project path back
        // to the user — "Created project at /workspace/local_projects/foo".
        // For chats with no explicit binding and no name match, count
        // local_projects/<slug>/ mentions across the session JSONL and
        // bind to the most-mentioned slug whose progress.md exists.
        //
        // The scan is expensive (file read + regex over all messages) but
        // only runs ONCE per chat — once we persist via setProjectDir,
        // path #1 catches it forever after. We cap at 500 messages so a
        // pathologically long chat doesn't tie up the RPC thread.
        if (raw == null && chatRow && !chatRow.project_dir) {
          const inferred = await inferProjectDirFromHistory(
            this.deps.home,
            this.deps.defaultProjectCwd,
            this.deps.workspaceRoot,
            chatRow.session_id ?? chatRow.chat_id,
          );
          if (inferred) {
            raw = await tryPath(path.join(projectsRoot, inferred, "progress.md"));
            if (raw != null) {
              matchedDir = `local_projects/${inferred}`;
              matchedDisplay = inferred;
              this.chats.setProjectDir(chatRow.chat_id, matchedDir).catch((e) => {
                console.warn(`[rpc] backfill (history-inferred) project_dir for ${chatRow!.chat_id}:`, e);
              });
            }
          }
        }

        // Path #4: manual project_name (no chat context, e.g. a future
        // "browse plans" view). Pure name lookup, no binding side-effects.
        if (raw == null && projectNameParam &&
            !projectNameParam.includes("/") && !projectNameParam.startsWith(".")) {
          const rel = `local_projects/${projectNameParam}`;
          const abs = resolveInWorkspace(rel);
          if (abs) {
            raw = await tryPath(path.join(abs, "progress.md"));
            if (raw != null) {
              matchedDir = rel;
              matchedDisplay = projectNameParam;
            }
          }
        }

        if (raw == null) {
          return { success: true, exists: false, progress: null, project_name: null, project_dir: null };
        }
        return {
          success: true,
          exists: true,
          progress: parseProgressMd(raw),
          project_name: matchedDisplay,
          project_dir: matchedDir,
        };
      }

      case "set_chat_project_dir": {
        // Workspace-relative path or empty string to unbind. Validated here
        // so a malformed value never reaches the DB or the agent's cwd.
        const chatId = (params.chat_id as string)?.trim();
        if (!chatId) throw new Error("chat_id required");
        const raw = (params.project_dir as string | undefined)?.trim() ?? "";
        let projectDir: string | null = null;
        if (raw !== "") {
          if (raw.startsWith("/") || raw.includes("..") || raw.startsWith(".")) {
            throw new Error("project_dir must be a safe workspace-relative path");
          }
          const abs = path.resolve(this.deps.workspaceRoot, raw);
          if (!abs.startsWith(this.deps.workspaceRoot + path.sep)) {
            throw new Error("project_dir escapes workspace");
          }
          // Don't require the dir to exist yet — drop-to-project calls this
          // immediately after createDirectory, and the order of the two
          // calls is racy across NATS round-trips. The binding is just a
          // pointer; runChat handles a missing dir by falling back to the
          // default cwd.
          projectDir = raw.replace(/\/+$/, "");
        }
        await this.chats.setProjectDir(chatId, projectDir);
        return { success: true, project_dir: projectDir };
      }

      case "set_active_agent": {
        const chatId = (params.chat_name as string) || (params.chat_id as string);
        const agentName = params.agent_name as string;
        await this.chats.setActiveAgent(chatId, agentName);
        return { success: true };
      }

      case "stop_chat": {
        const chatId = params.chat_id as string;
        const stopped = this.aborts.abort(chatId);
        return { success: true, stopped };
      }

      case "chat": {
        const chatId = params.chat_id as string;
        const messageArr = params.message as Array<{ role: string; content: string }>;
        const { text, images } = extractPrompt(messageArr);
        return await this.runChat(chatId, text, images);
      }

      case "proxy_toolset": {
        const methodName = params.method_name as string;
        const toolsetName = params.toolset_name as string | undefined;
        const args = (params.args as Record<string, unknown>) ?? {};
        if (toolsetName === "file_manager" || !toolsetName) {
          return this.files.dispatch(methodName, args);
        }
        if (toolsetName === "notebook") {
          return this.notebooks.dispatch(methodName, args);
        }
        throw new Error(`unknown toolset: ${toolsetName}`);
      }

      case "memory_search": {
        if (!this.deps.memory) throw new Error("memory api not configured");
        const hits = await this.deps.memory.search(params as Parameters<MemoryRpcClient["search"]>[0]);
        return { success: true, hits };
      }

      case "memory_get": {
        if (!this.deps.memory) throw new Error("memory api not configured");
        const memory = await this.deps.memory.get(params.memory_id as string);
        return { success: true, memory };
      }

      case "memory_timeline": {
        if (!this.deps.memory) throw new Error("memory api not configured");
        const entries = await this.deps.memory.timeline(params as Parameters<MemoryRpcClient["timeline"]>[0]);
        return { success: true, entries };
      }

      case "memory_list": {
        if (!this.deps.memory) throw new Error("memory api not configured");
        const res = await this.deps.memory.list(params as Parameters<MemoryRpcClient["list"]>[0]);
        return { success: true, ...(res as object) };
      }

      case "memory_write": {
        if (!this.deps.memory) throw new Error("memory api not configured");
        const res = await this.deps.memory.write(params as Parameters<MemoryRpcClient["write"]>[0]);
        return { success: true, ...(res as object) };
      }

      case "memory_update": {
        if (!this.deps.memory) throw new Error("memory api not configured");
        const { memory_id, ...body } = params as { memory_id: string; name: string; description: string; body: string };
        const res = await this.deps.memory.update(memory_id, body);
        return { success: true, ...(res as object) };
      }

      case "memory_forget": {
        if (!this.deps.memory) throw new Error("memory api not configured");
        const res = await this.deps.memory.forget(params.memory_id as string);
        return { success: true, ...(res as object) };
      }

      case "memory_restore": {
        if (!this.deps.memory) throw new Error("memory api not configured");
        const res = await this.deps.memory.restore(params.memory_id as string);
        return { success: true, ...(res as object) };
      }

      case "memory_audit": {
        if (!this.deps.memory) throw new Error("memory api not configured");
        const res = await this.deps.memory.audit(
          params.memory_id as string,
          params.limit as number | undefined,
        );
        return { success: true, ...(res as object) };
      }

      case "share_submit": {
        if (!this.deps.share) throw new Error("share api not configured");
        const res = await this.deps.share.submit(
          params as Parameters<ShareRpcClient["submit"]>[0],
        );
        return { success: true, ...(res as object) };
      }

      case "share_list": {
        if (!this.deps.share) throw new Error("share api not configured");
        const res = await this.deps.share.list(
          params as Parameters<ShareRpcClient["list"]>[0],
        );
        return { success: true, ...(res as object) };
      }

      case "share_get": {
        if (!this.deps.share) throw new Error("share api not configured");
        const res = await this.deps.share.get(params.share_id as string);
        return { success: true, share: res };
      }

      case "share_decide": {
        if (!this.deps.share) throw new Error("share api not configured");
        const { share_id, ...body } = params as { share_id: string; decision: "approve" | "reject"; comment?: string };
        const res = await this.deps.share.decide(share_id, body);
        return { success: true, ...(res as object) };
      }

      case "share_withdraw": {
        if (!this.deps.share) throw new Error("share api not configured");
        const res = await this.deps.share.withdraw(params.share_id as string);
        return { success: true, ...(res as object) };
      }

      case "share_capabilities": {
        if (!this.deps.share) throw new Error("share api not configured");
        const res = await this.deps.share.capabilities();
        return { success: true, ...(res as object) };
      }

      case "skills_list": {
        const skills = await listUserSkills(this.deps.home);
        return { success: true, skills };
      }

      case "org_skills_list": {
        const skills = await listOrgSkills(this.deps.workspaceRoot);
        return { success: true, skills };
      }

      case "h5ad_introspect": {
        const p = params.path as string;
        if (!p || typeof p !== "string") throw new Error("path required");
        const res = await this.h5ad.introspect(p);
        return { success: true, ...res };
      }

      case "h5ad_plot": {
        const p = params.path as string;
        const kind = params.kind as "qc" | "embedding" | "spatial";
        if (!p || typeof p !== "string") throw new Error("path required");
        if (!kind) throw new Error("kind required");
        const plotParams = (params.params as Record<string, unknown>) ?? {};
        const res = await this.h5ad.plot(p, kind, plotParams);
        return { success: true, ...res };
      }

      case "chpc_bridge_status": {
        const status = await this.chpc.status();
        return { success: true, status };
      }

      case "chpc_bridge_open": {
        const password = params.password as string | undefined;
        const duo = params.duo as OpenRequest["duo"] | undefined;
        const requestId = params.requestId as string | undefined;
        if (!password || typeof password !== "string") throw new Error("password required");
        if (!requestId || typeof requestId !== "string") throw new Error("requestId required");
        if (!duo || (duo.kind !== "push" && duo.kind !== "passcode")) {
          throw new Error("duo.kind must be 'push' or 'passcode'");
        }
        if (duo.kind === "passcode" && (!duo.code || typeof duo.code !== "string")) {
          throw new Error("duo.code required when duo.kind === 'passcode'");
        }
        // Fire-and-forget — open() returns immediately, status arrives via stream.
        const res = await this.chpc.open({ password, duo, requestId });
        return { success: true, ...res };
      }

      case "chpc_bridge_close": {
        const res = await this.chpc.close();
        return { success: true, ...res };
      }

      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  private async runChat(chatId: string, prompt: string, images: ImageRef[] = []): Promise<unknown> {
    const chat = await this.chats.read(chatId);
    if (!chat) throw new Error(`chat not found: ${chatId}`);

    // cwd stays at defaultProjectCwd even when the chat is bound to a
    // project. Claude Code stores session JSONL under
    // ~/.claude/projects/<encoded-cwd>/<session>.jsonl — switching cwd
    // mid-chat would fragment history (old turns in one dir, new turns in
    // another) and break message reads. The agent learns the project from
    // the kickoff prompt and tick-bootstrap output, not cwd.
    const mutex = this.mutexes.get(chatId);
    const run = mutex.tryRun(async () => {
      const ac = this.aborts.register(chatId);
      try {
        await runTurn({
          chatId,
          prompt,
          images,
          cwd: this.deps.defaultProjectCwd,
          // Resume only if we've already captured a real SDK session UUID.
          resumeSessionId: chat.session_id ?? undefined,
          signal: ac.signal,
          onEvent: (ev) => this.deps.publishStream(`chat_${chatId}`, ev),
          onSessionId: (sessionId) => {
            // Fire-and-forget — stash the real session UUID so next resume works.
            this.chats.setSessionUuid(chatId, sessionId).catch((e) => {
              console.warn(`[rpc] failed to stash session_uuid for ${chatId}:`, e);
            });
          },
        });
        await this.chats.touch(chatId);
      } finally {
        this.aborts.clear(chatId);
      }
      return { success: true };
    });

    if (run === null) {
      throw new Error(`chat ${chatId} is already streaming a turn`);
    }
    return await run;
  }
}

export interface ImageRef {
  path: string;
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
}

// Allow-listed parent for any image path the frontend can attach. The frontend
// can only POST uploads into this directory via the upload-http server, so any
// path outside it is either a programming error or someone trying to read
// CLAUDE.md / .env via a crafted [image:] line.
const ATTACHMENT_PREFIX = "/workspace/local_projects/.chat-attachments/";

const MEDIA_TYPE_BY_EXT: Record<string, ImageRef["mediaType"]> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

// ─── progress.md parsing ───────────────────────────────────────────────
// The tick harness keeps all per-project state in a single markdown file. The
// frontend wants a parsed view for its self-driving checklist, but we don't
// want a full markdown library here — the structure is rigid enough that line
// scanning is sufficient. Tolerant on input: if a section is missing or the
// format drifts, we degrade to "no steps" rather than throwing.

export interface ProgressStep {
  /** First word after the box (and the optional `(reviewed)` marker). */
  name: string;
  /** Rest of the line up to ` | ` (which separates description from metrics). */
  description: string;
  done: boolean;
  reviewed: boolean;
}

export interface ParsedProgress {
  pipeline: string | null;
  steps: ProgressStep[];
  complete: boolean;
  /** Count of unchecked `☐` lines under `## Review feedback`. */
  pendingFeedback: number;
  /** Index of the next ☐ step (or null when nothing is pending). The
   *  orchestrator dispatches this one next, so the UI can highlight it. */
  nextStepIndex: number | null;
}

const STEP_LINE_RE = /^-\s*([☑☐])\s*(?:\(reviewed\)\s*)?(\S+)(?:\s+(.*))?$/u;

// Match a local_projects/<slug> reference in message content. Slug rules
// mirror tick-bootstrap's slugifier (lowercase kebab + dataset accessions)
// plus a defensive cap on length so we don't capture pathological junk.
// We tolerate optional /workspace/ prefix and either / or end-of-token
// terminator so "local_projects/foo," and "local_projects/foo/data/x.h5"
// both yield "foo".
const PROJECT_REF_RE = /(?:^|[\s"'`])(?:\/workspace\/)?local_projects\/([a-z0-9][a-z0-9._-]{0,63})(?=[\s/"'`,)\]]|$)/giu;

/**
 * Scan a chat's session history for `local_projects/<slug>/` mentions and
 * return the slug that (a) appears most often and (b) has an existing
 * progress.md. Returns null if nothing matches. Caps at 500 messages.
 *
 * Used as a one-shot inference for chats with no DB binding and no
 * chat-name match — the result is persisted so the scan only runs once.
 */
async function inferProjectDirFromHistory(
  home: string,
  cwd: string,
  workspaceRoot: string,
  sessionId: string,
): Promise<string | null> {
  let messages: LegacyMessage[] = [];
  try {
    messages = await readSessionMessages(home, cwd, sessionId);
  } catch {
    return null;
  }
  if (messages.length === 0) return null;
  // Walk newest-to-oldest so we early-exit on the first viable hit, which
  // is typically the most recent agent/user reference to the project.
  const counts = new Map<string, number>();
  const considered = messages.slice(-500);
  for (const m of considered) {
    const content = typeof m.content === "string" ? m.content : "";
    if (!content) continue;
    PROJECT_REF_RE.lastIndex = 0;
    let mm: RegExpExecArray | null;
    while ((mm = PROJECT_REF_RE.exec(content)) != null) {
      const slug = mm[1];
      // mm[1] is technically string|undefined under strict TS; the regex
      // always has the capture group, but humour the type system.
      if (!slug) continue;
      // Skip dotted/underscored special dirs (.chat-attachments, _starter_pipelines).
      if (slug.startsWith(".") || slug.startsWith("_")) continue;
      counts.set(slug, (counts.get(slug) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return null;

  // Tie-break: the slug with the most mentions whose progress.md exists.
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [slug] of ranked) {
    const candidate = path.join(workspaceRoot, "local_projects", slug, "progress.md");
    const ok = await fs.stat(candidate).then((s) => s.isFile()).catch(() => false);
    if (ok) return slug;
  }
  return null;
}

export function parseProgressMd(raw: string): ParsedProgress {
  // Walk the file once, tracking which top-level section we're in. Plan and
  // Review feedback are the only sections with parseable structure.
  let section: string | null = null;
  let pipeline: string | null = null;
  const steps: ProgressStep[] = [];
  let pendingFeedback = 0;
  let complete = false;

  for (const line of raw.split(/\r?\n/)) {
    const headerMatch = /^##\s+(.+?)\s*$/.exec(line);
    if (headerMatch) {
      const heading = (headerMatch[1] ?? "").toLowerCase();
      if (heading.startsWith("status:")) {
        if (/complete/i.test(line)) complete = true;
        section = null;
        continue;
      }
      // First word: plan / sample(s) / pipeline / review / ...
      section = heading.split(/\s+/)[0] ?? null;
      continue;
    }

    if (section === "pipeline" && line.trim() && !pipeline) {
      pipeline = line.trim();
      continue;
    }

    if (section === "plan") {
      const m = STEP_LINE_RE.exec(line);
      if (!m) continue;
      const box = m[1] ?? "";
      const name = m[2] ?? "";
      const restRaw = (m[3] ?? "").trim();
      // Strip metrics suffix (` | metric=value ...`) from the human-readable
      // description so the checklist stays one line.
      const description = (restRaw.split(/\s*\|\s*/, 1)[0] ?? "").trim();
      steps.push({
        name,
        description,
        done: box === "☑",
        reviewed: /\(reviewed\)/.test(line),
      });
    }

    if (section === "review" && /^-\s*☐/.test(line)) {
      pendingFeedback++;
    }
  }

  const nextStepIndex = steps.findIndex(s => !s.done);
  return {
    pipeline,
    steps,
    complete,
    pendingFeedback,
    nextStepIndex: nextStepIndex === -1 ? null : nextStepIndex,
  };
}

const IMAGE_LINE_RE = /^\[image:\s*([^\]]+)\]\s*$/;

/**
 * Pull the most recent user message and split out any `[image: <path>]`
 * lines into structured ImageRefs. Lines for non-allow-listed paths are
 * dropped (logged); the rest of the text passes through verbatim.
 */
function extractPrompt(messages: Array<{ role: string; content: string }>): {
  text: string;
  images: ImageRef[];
} {
  let raw = "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") { raw = m.content; break; }
  }
  if (!raw) return { text: "", images: [] };

  const images: ImageRef[] = [];
  const remaining: string[] = [];
  for (const line of raw.split("\n")) {
    const m = IMAGE_LINE_RE.exec(line);
    if (!m || !m[1]) { remaining.push(line); continue; }
    const path = m[1].trim();
    if (!path.startsWith(ATTACHMENT_PREFIX)) {
      console.warn(`[chat] dropping image line outside allowed prefix: ${path}`);
      continue;
    }
    const ext = (path.match(/\.[a-z0-9]+$/i)?.[0] ?? "").toLowerCase();
    const mediaType = MEDIA_TYPE_BY_EXT[ext];
    if (!mediaType) {
      console.warn(`[chat] dropping image with unsupported extension: ${path}`);
      continue;
    }
    images.push({ path, mediaType });
  }
  return { text: remaining.join("\n").trim(), images };
}
