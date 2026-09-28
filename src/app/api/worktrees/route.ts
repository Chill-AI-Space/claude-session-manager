import { cleanupSessionWorktrees } from "@/lib/session-worktree-registry";

export const dynamic = "force-dynamic";

/** List session worktrees with whether each could be cleaned up (and why not). */
export async function GET() {
  try {
    return Response.json({ worktrees: await cleanupSessionWorktrees(true) });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

/** Remove every session worktree that is clean, fully pushed and not in use; keep the rest. */
export async function POST() {
  try {
    return Response.json({ worktrees: await cleanupSessionWorktrees(false) });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
