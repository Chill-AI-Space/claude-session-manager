import { NextResponse } from "next/server";
import { createPermissionRequest } from "@/lib/permissions";

// POST: Hook sends a permission request
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const req = createPermissionRequest({
      sessionId: body.session_id || "unknown",
      toolName: body.tool_name || "unknown",
      toolInput: body.tool_input || {},
      permissionSuggestions: body.permission_suggestions,
      cwd: body.cwd || "",
      permissionMode: body.permission_mode || "default",
    });
    return NextResponse.json({ id: req.id, status: "pending" });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
