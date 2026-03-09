import { NextRequest, NextResponse } from "next/server";
import { writeFileSync, mkdirSync } from "fs";
import path from "path";
import os from "os";
import { scanSessions } from "@/lib/scanner";

export const dynamic = "force-dynamic";

// Allow cross-origin requests so the shared page (on chillai.space) can call us
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

interface ImportedMessage {
  uuid: string;
  type: "user" | "assistant";
  timestamp: string;
  content: unknown;
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

interface ImportPayload {
  session_id: string;
  title?: string;
  project_path?: string;
  model?: string;
  messages: ImportedMessage[];
}

export async function POST(req: NextRequest) {
  let payload: ImportPayload;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400, headers: CORS });
  }

  const { session_id, title, project_path, model, messages } = payload;
  if (!session_id || !Array.isArray(messages)) {
    return NextResponse.json({ error: "session_id and messages required" }, { status: 400, headers: CORS });
  }

  // Validate session_id: only allow alphanumeric, hyphens, and underscores to prevent path traversal
  if (!/^[a-zA-Z0-9_-]+$/.test(session_id)) {
    return NextResponse.json({ error: "Invalid session_id format" }, { status: 400, headers: CORS });
  }

  // Create imported project dir: ~/.claude/projects/imported/
  const projectDir = path.join(os.homedir(), ".claude", "projects", "imported");
  mkdirSync(projectDir, { recursive: true });

  const jsonlPath = path.join(projectDir, `${session_id}.jsonl`);

  // Verify resolved path stays within the intended directory
  if (!jsonlPath.startsWith(projectDir + path.sep)) {
    return NextResponse.json({ error: "Invalid session_id" }, { status: 400, headers: CORS });
  }

  // Reconstruct JSONL from parsed messages
  const lines = messages.map((msg) => {
    if (msg.type === "user") {
      return JSON.stringify({
        type: "user",
        uuid: msg.uuid,
        timestamp: msg.timestamp,
        message: { role: "user", content: msg.content },
      });
    } else {
      return JSON.stringify({
        type: "assistant",
        uuid: msg.uuid,
        timestamp: msg.timestamp,
        message: {
          id: `msg_${msg.uuid?.slice(0, 8) ?? "imported"}`,
          type: "message",
          role: "assistant",
          content: msg.content,
          model: msg.model ?? model ?? "claude-opus-4-6",
          stop_reason: "end_turn",
          usage: msg.usage ?? {},
        },
      });
    }
  });

  writeFileSync(jsonlPath, lines.join("\n") + "\n", "utf-8");

  // Scan to index the imported session
  try {
    await scanSessions("incremental");
  } catch { /* non-critical */ }

  return NextResponse.json(
    { session_id, title, message: "Imported successfully" },
    { headers: CORS }
  );
}
