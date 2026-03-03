import { generateTitleBatch } from "@/lib/title-generator";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const limit = Math.min(body.limit || 20, 50);
  const force = body.force === true;

  try {
    const result = await generateTitleBatch(limit, force);
    if (result.total === 0) {
      return Response.json({ generated: 0, message: "All sessions have titles" });
    }
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return Response.json({ error: message }, { status: 500 });
  }
}
