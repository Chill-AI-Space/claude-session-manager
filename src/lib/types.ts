export interface SessionRow {
  session_id: string;
  jsonl_path: string;
  project_dir: string;
  project_path: string;
  git_branch: string | null;
  claude_version: string | null;
  model: string | null;
  first_prompt: string | null;
  message_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  created_at: string;
  modified_at: string;
  file_mtime: number;
  file_size: number;
  custom_name: string | null;
  tags: string | null;
  pinned: number;
  archived: number;
  last_scanned_at: string;
}

export interface ProjectRow {
  project_dir: string;
  project_path: string;
  display_name: string | null;
  session_count: number;
  last_activity: string | null;
  custom_name: string | null;
  color: string | null;
}

export interface SessionListItem {
  session_id: string;
  project_dir: string;
  project_path: string;
  display_name: string;
  first_prompt: string | null;
  custom_name: string | null;
  tags: string[];
  pinned: boolean;
  archived: boolean;
  message_count: number;
  model: string | null;
  git_branch: string | null;
  created_at: string;
  modified_at: string;
  total_input_tokens: number;
  total_output_tokens: number;
  is_active?: boolean;
}

export interface ProjectListItem {
  project_dir: string;
  project_path: string;
  display_name: string;
  custom_name: string | null;
  session_count: number;
  last_activity: string | null;
  color: string | null;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | ContentBlock[];
    };

export interface ParsedMessage {
  uuid: string;
  type: "user" | "assistant";
  timestamp: string;
  content: string | ContentBlock[];
  model?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  git_branch?: string;
  cwd?: string;
}

export interface SessionDetail {
  session_id: string;
  project_path: string;
  messages: ParsedMessage[];
  metadata: SessionRow;
}
