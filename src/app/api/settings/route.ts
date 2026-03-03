import { NextRequest } from "next/server";
import { getAllSettings, setSetting } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(getAllSettings());
}

export async function PUT(request: NextRequest) {
  const body = await request.json();
  for (const [key, value] of Object.entries(body)) {
    if (typeof value === "string") {
      setSetting(key, value);
    }
  }
  return Response.json(getAllSettings());
}
