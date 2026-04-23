// Wire types — must match pantheon-frontend/src/types/index.ts exactly.

export interface NATSMessage {
  method: string;
  parameters: Record<string, unknown>;
  correlation_id?: string;
}

export interface NATSResponse {
  result?: unknown;
  error?: string;
}

export interface ToolCallInfo {
  id: string;
  function: { name: string; arguments: string };
  type: "function";
}

export interface StepMessageData {
  role: "assistant" | "tool" | "user" | "system";
  content?: unknown;
  id?: string;
  timestamp?: number;
  agent_name?: string;
  tool_calls?: ToolCallInfo[];
  reasoning_content?: string;
  tool_name?: string;
  name?: string;
  tool_call_id?: string;
  raw_content?: unknown;
  transfer?: boolean;
  _metadata?: {
    start_timestamp?: number;
    end_timestamp?: number;
    execution_duration?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
    current_cost?: number;
    chain_path?: string[];
  };
}

export type StreamEvent =
  | { type: "chunk"; chunk: { type: string; text: string }; chat_id: string }
  | { type: "step_message"; step_message: StepMessageData; chat_id: string }
  | { type: "chat_finished"; chat_id: string };

export interface StreamEnvelope {
  type: "chat";
  session_id: string;
  timestamp: number;
  data: StreamEvent;
}

export interface ChatInfo {
  id: string;
  name: string;
  last_activity_date?: string;
  running?: boolean;
  project_name?: string;
}
