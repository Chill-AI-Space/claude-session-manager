import { NextResponse } from "next/server";
import { getArchiverStats, cleanupArchive, getArchiverTtl } from "@/lib/archiver";

export async function GET() {
  const stats = getArchiverStats();
  return NextResponse.json(stats);
}

/** POST triggers a manual cleanup based on current TTL. */
export async function POST() {
  const ttl = getArchiverTtl();
  const deleted = ttl > 0 ? cleanupArchive(ttl) : 0;
  const stats = getArchiverStats();
  return NextResponse.json({ deleted, ...stats });
}
