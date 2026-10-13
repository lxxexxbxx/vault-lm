export type Mode = "chat" | "code";

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface Message {
  id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  created_at: number;
  updated_at: number;
  reasoning?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  model?: string;
  deleted?: boolean;
}

export interface Session {
  id: string;
  title: string;
  mode: Mode;
  workspace?: string | null;
  created_at: number;
  updated_at: number;
  deleted: boolean;
  pinned: boolean;
  summary?: string | null;
  summary_until?: string | null;
  messages: Message[];
}

export interface SessionMeta {
  id: string;
  title: string;
  mode: Mode;
  workspace?: string | null;
  created_at: number;
  updated_at: number;
  pinned: boolean;
  message_count: number;
}

export interface ModelProfile {
  id: string;
  name: string;
  model_path: string;
  port: number;
  ctx_size: number;
  extra_args: string;
}

export interface AppConfig {
  vault_dir: string;
  llm: {
    base_url: string;
    model: string;
    temperature: number;
    top_p: number;
    max_tokens: number;
    context_tokens: number;
    system_prompt_chat: string;
    system_prompt_code: string;
  };
  server: {
    llama_server_path: string;
    profiles: ModelProfile[];
    active_profile: string | null;
    auto_start: boolean;
  };
  drive: {
    enabled: boolean;
    client_id: string;
    client_secret: string;
    auto_sync_secs: number;
  };
  allow_private_lan: boolean;
  auto_approve_reads: boolean;
}

export interface VaultStatus {
  exists: boolean;
  unlocked: boolean;
  vaultDir: string;
  remembered: boolean;
  driveConnected: boolean;
}

export interface ServerStatus {
  running: boolean;
  pid: number | null;
  profileId: string | null;
  port: number;
  ready: boolean;
}

export type StreamEvent =
  | { type: "token"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "toolCall"; name: string };

export interface ChatResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  promptTokens: number | null;
  completionTokens: number | null;
  tokensPerSec: number | null;
  cancelled: boolean;
}

export interface SyncReport {
  uploaded: number;
  downloaded: number;
  merged: number;
  unchanged: number;
  at: number;
}

export interface FileEntry {
  path: string;
  isDir: boolean;
  size: number;
}
