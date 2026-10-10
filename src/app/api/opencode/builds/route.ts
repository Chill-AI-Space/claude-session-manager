import { getOpencodeBuilds, resolveOpencodeBuild } from "@/lib/opencode-builds";

export const dynamic = "force-dynamic";

export function GET() {
  try {
    return Response.json({ builds: getOpencodeBuilds().map((build) => {
      try {
        resolveOpencodeBuild(build.id);
        return { ...build, available: true };
      } catch (error) {
        return { ...build, available: false, error: String(error) };
      }
    }) });
  } catch (error) {
    return Response.json({ error: String(error) }, { status: 400 });
  }
}
