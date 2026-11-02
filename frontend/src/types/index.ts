// LabWeaver Frontend Types — MIT License

export * from './memory'

// ============================================================
// NATS / Connection
// ============================================================

export interface NATSMessage {
  method: string
  parameters: Record<string, unknown>
  correlation_id?: string
}

export interface NATSResponse {
  result?: unknown
  error?: string
}

export interface ConnectionConfig {
  url: string
  serviceId: string
  subjectPrefix?: string
  token?: string
}

// ============================================================
// Tick-harness progress (parsed from progress.md by the adapter)
// ============================================================

export interface HarnessStep {
  name: string
  description: string
  done: boolean
  reviewed: boolean
}

export interface HarnessProgress {
  pipeline: string | null
  steps: HarnessStep[]
  complete: boolean
  pendingFeedback: number
  /** Index of the next ☐ step; null when nothing is pending. */
  nextStepIndex: number | null
  /** The agent that runs next: tick-executor, tick-reviewer, …; null when complete. */
  nextAgent: string | null
}

// ============================================================
// Chat
// ============================================================

/** How a chat runs its next message. The adapter turns auto into /tick and
 *  team into /team; plain chat sends the text as is. */
export type ChatMode = 'chat' | 'auto' | 'team'

export interface ChatInfo {
  id: string
  name: string
  last_activity_date?: string
  running?: boolean
  /** The running turn was sent in auto mode. */
  auto_running?: boolean
  project_name?: string
  /** Workspace-relative project directory bound to this chat (e.g.
   *  "local_projects/foo-1a2b"). When set, the chat runs with this dir as cwd
   *  and harness progress is read from <project_dir>/progress.md. Null = unbound. */
  project_dir?: string | null
}

/** A folder under local_projects/ (adapter list_projects). */
export interface ProjectInfo {
  /** Workspace-relative, e.g. "local_projects/pbmc-qc". */
  dir: string
  name: string
  modified_at: string
}

/** A project and the notebooks in it (adapter list_project_notebooks). */
export interface ProjectNotebooks extends ProjectInfo {
  notebooks: { path: string; modified_at: string }[]
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  _llm_content?: unknown
  id?: string
  tool_use?: ToolUse
  raw_content?: unknown
}

export interface ToolUse {
  id: string
  name: string
  input: Record<string, unknown>
  output?: string
  status?: string
}

export interface StreamChunk {
  type: 'chunk'
  chunk: { type: string; text: string }
  chat_id: string
}

export interface StepMessage {
  type: 'step_message'
  step_message: StepMessageData
  chat_id: string
}

/** Actual step_message payload from LabWeaver backend */
export interface StepMessageData {
  role: 'assistant' | 'tool' | 'user' | 'system'
  content?: unknown  // string or structured
  id?: string
  timestamp?: number
  agent_name?: string

  // Assistant messages
  tool_calls?: ToolCallInfo[]
  reasoning_content?: string

  // Tool result messages
  tool_name?: string
  name?: string
  tool_call_id?: string
  raw_content?: unknown

  // Transfer / delegation
  transfer?: boolean

  // Metadata with timing and cost
  _metadata?: {
    start_timestamp?: number
    end_timestamp?: number
    execution_duration?: number
    total_tokens?: number
    input_tokens?: number
    output_tokens?: number
    current_cost?: number
    chain_path?: string[]
  }
}

export interface ToolCallInfo {
  id: string
  function: { name: string; arguments: string }
  type: 'function'
}

/** Processed step for the execution timeline UI */
export interface TimelineStep {
  id: string
  type: 'tool_call' | 'tool_result' | 'assistant' | 'transfer'
  status: 'running' | 'completed' | 'failed'
  name: string         // tool name or agent name
  agentName?: string
  startTime: number
  endTime?: number
  duration?: number     // seconds
  // For tool_call: the arguments
  input?: string
  // For tool_result: the output
  output?: string
  // For assistant: thinking text
  content?: string
  // For transfer: target agent
  targetAgent?: string
  // Cost info
  tokens?: number
  cost?: number
}

export interface ChatFinished {
  type: 'chat_finished'
  chat_id: string
}

export interface BgTaskUpdate {
  type: 'bg_task_update'
  task_id: string
  tool_name: string
  status: string
  agent_name: string
  chat_id: string
}

export type StreamData = StreamChunk | StepMessage | ChatFinished | BgTaskUpdate

export interface StreamMessage {
  type: 'chat' | 'notebook' | 'custom'
  session_id: string
  timestamp: number
  data: StreamData
  metadata?: Record<string, unknown>
}

// ============================================================
// Agents panel (get_chat_stats)
// ============================================================

export interface TokenTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface SubagentRun {
  sessionId: string
  description: string | null
  /** "stopped": no result and the chat's turn is no longer running. */
  status: 'running' | 'done' | 'failed' | 'stopped'
  model: string | null
  startedAt: string
  endedAt: string
  tokens: TokenTotals
  toolCalls: number
  /** First line of the run's last reply. */
  result: string | null
}

/** Token use read from the chat's transcripts. */
export interface TranscriptStats {
  /** The chat's own turns, every session in its continuation chain. */
  main: TokenTotals
  turns: number
  lastTurn: TokenTotals | null
  subagents: SubagentRun[]
}

export interface ChatStats extends TranscriptStats {
  /** The chat's Agent Team; null until the lead creates a teammate or task. */
  team: TeamBoard | null
}

export interface TeamMember {
  /** Session id; a teammate's is its subagent session. */
  id: string
  name: string
  role: 'lead' | 'teammate'
  status: 'running' | 'inactive' | 'provisioning' | 'failed'
  description?: string
  model?: string
}

export interface TeamTask {
  id: string
  subject: string
  description?: string
  status: 'pending' | 'in_progress' | 'completed'
  ownerName?: string
  blockedBy: string[]
  ready: boolean
}

export interface TeamBoard {
  members: TeamMember[]
  tasks: TeamTask[]
  updatedAt: number
}

// ============================================================
// File System
// ============================================================

export interface FileEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
  modified?: number
  children?: FileEntry[]
}

// ============================================================
// Notebook
// ============================================================

export interface NotebookCell {
  id: string
  cell_type: 'code' | 'markdown' | 'raw'
  source: string
  outputs: CellOutput[]
  execution_count: number | null
  metadata: Record<string, unknown>
}

export interface CellOutput {
  output_type: 'stream' | 'execute_result' | 'display_data' | 'error'
  name?: string     // stdout, stderr
  text?: string | string[]
  data?: Record<string, unknown>  // mime-type -> content
  metadata?: Record<string, unknown>
  ename?: string
  evalue?: string
  traceback?: string[]
  execution_count?: number
}

export interface Notebook {
  cells: NotebookCell[]
  metadata: Record<string, unknown>
  nbformat: number
  nbformat_minor: number
}

export interface NotebookInfo {
  file_path: string
  version: number
  /** File mtime (ms) as the adapter last read or wrote it. */
  mtime?: number
  cell_count: number
  notebook: Notebook
}

export interface VariableInfo {
  name: string
  type: string
  size?: string
  value?: string
}

/** Kernel lifecycle status */
export type KernelStatus = 'idle' | 'busy' | 'starting' | 'dead' | 'unknown'

/** Per-cell UI mode (Jupyter-style) */
export type CellMode = 'command' | 'edit'

/** Markdown cell display mode */
export type MarkdownMode = 'rendered' | 'editing'

/** Clipboard entry for copy/cut/paste cell operations */
export interface ClipboardCell {
  cell_type: 'code' | 'markdown' | 'raw'
  source: string
  metadata?: Record<string, unknown>
}

/** Snapshot for undo/redo stack */
export interface NotebookSnapshot {
  cells: NotebookCell[]
  timestamp: number
  action: string
}

// ============================================================
// Notebook IOPub streaming
// ============================================================

export interface NotebookStreamMessage {
  type: 'notebook'
  session_id: string
  timestamp: number
  data: {
    msg_type: string
    content: Record<string, unknown>
    header?: Record<string, unknown>
    metadata?: Record<string, unknown>
    parent_header?: Record<string, unknown>
  }
  metadata?: {
    source?: string
    cell_id?: string
    notebook_path?: string
    operated_by?: string
  }
}
