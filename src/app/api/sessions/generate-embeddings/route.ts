import { NextResponse } from "next/server";
import { generateMissingEmbeddings } from "@/lib/embeddings";

export const dynamic = "force-dynamic";

export async function POST() {
  const result = await generateMissingEmbeddings();
  return NextResponse.json(result);
}
