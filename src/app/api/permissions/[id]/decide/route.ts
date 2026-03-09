import { NextResponse } from "next/server";
import { decidePermission } from "@/lib/permissions";

// POST: UI sends allow/deny decision
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const behavior = body.behavior as "allow" | "deny";

    if (!["allow", "deny"].includes(behavior)) {
      return NextResponse.json(
        { error: 'behavior must be "allow" or "deny"' },
        { status: 400 }
      );
    }

    const req = decidePermission(id, behavior);
    if (!req) {
      return NextResponse.json(
        { error: "Permission request not found or expired" },
        { status: 404 }
      );
    }

    return NextResponse.json({ status: "decided", behavior });
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
}
