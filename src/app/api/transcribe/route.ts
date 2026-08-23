import { NextRequest, NextResponse } from "next/server";
import { getSetting } from "@/lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const apiKey = getSetting("deepgram_api_key");
  if (!apiKey) {
    return NextResponse.json({ error: "deepgram_api_key not configured in Settings" }, { status: 400 });
  }

  const formData = await request.formData();
  const file = formData.get("audio") as File | null;
  if (!file) {
    return NextResponse.json({ error: "No audio" }, { status: 400 });
  }

  const audioBuffer = await file.arrayBuffer();

  try {
    const dgRes = await fetch("https://api.deepgram.com/v1/listen?model=nova-2&language=ru&smart_format=true", {
      method: "POST",
      headers: {
        authorization: `Token ${apiKey}`,
        "content-type": file.type || "audio/webm",
      },
      body: audioBuffer,
    });
    const dgData = await dgRes.json();
    if (!dgRes.ok) {
      return NextResponse.json({ error: dgData.err_msg || "Deepgram error" }, { status: 502 });
    }
    const transcript = dgData.results?.channels?.[0]?.alternatives?.[0]?.transcript || "";
    return NextResponse.json({ transcript });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
