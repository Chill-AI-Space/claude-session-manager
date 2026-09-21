import { listOpencodeProfiles, getCurrentOpencodeProfile } from "@/lib/opencode-profiles";

export const dynamic = "force-dynamic";

/** Lists OpenCode model profiles (~/.config/opencode/profiles) and the currently active one. */
export async function GET() {
  return Response.json({
    profiles: listOpencodeProfiles(),
    current: getCurrentOpencodeProfile(),
  });
}
