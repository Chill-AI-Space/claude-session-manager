import { NextRequest, NextResponse } from "next/server";
import { getContextSourceGroups, upsertContextSourceGroup, deleteContextSourceGroup } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const groups = getContextSourceGroups();
  return NextResponse.json(groups);
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { id, name, enabled = true, sources = [], patterns = [] } = body;
  if (!id || !name) {
    return NextResponse.json({ error: "id and name required" }, { status: 400 });
  }
  upsertContextSourceGroup(id, name, enabled, sources, patterns);
  return NextResponse.json({ ok: true });
}

export async function PUT(request: NextRequest) {
  const body = await request.json();
  const { id, name, enabled = true, sources = [], patterns = [] } = body;
  if (!id || !name) {
    return NextResponse.json({ error: "id and name required" }, { status: 400 });
  }
  upsertContextSourceGroup(id, name, enabled, sources, patterns);
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
  deleteContextSourceGroup(id);
  return NextResponse.json({ ok: true });
}
