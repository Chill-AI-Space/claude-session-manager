import { NextResponse } from "next/server";
import { getPermissionRequest } from "@/lib/permissions";

// GET: Hook polls for decision (short-poll every ~1s from the hook script)
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const req = getPermissionRequest(id);

  if (!req) {
    return NextResponse.json(
      { status: "expired", response: null },
      { status: 404 }
    );
  }

  if (req.decision) {
    return NextResponse.json({
      status: "decided",
      response: {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: {
            behavior: req.decision.behavior,
          },
        },
      },
    });
  }

  return NextResponse.json({ status: "pending" });
}
