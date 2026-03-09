// In-memory store for pending permission requests from Claude CLI hooks

export interface PermissionRequest {
  id: string;
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  permissionSuggestions?: Array<{ type: string; tool: string }>;
  cwd: string;
  permissionMode: string;
  createdAt: number;
  decision?: {
    behavior: "allow" | "deny";
    decidedAt: number;
  };
}

const pendingPermissions = new Map<string, PermissionRequest>();

// Auto-cleanup entries older than 3 minutes
const EXPIRY_MS = 3 * 60 * 1000;

function cleanup() {
  const now = Date.now();
  for (const [id, req] of pendingPermissions) {
    if (now - req.createdAt > EXPIRY_MS) {
      pendingPermissions.delete(id);
    }
  }
}

export function createPermissionRequest(data: {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  permissionSuggestions?: Array<{ type: string; tool: string }>;
  cwd: string;
  permissionMode: string;
}): PermissionRequest {
  cleanup();
  const id = crypto.randomUUID();
  const req: PermissionRequest = {
    id,
    ...data,
    createdAt: Date.now(),
  };
  pendingPermissions.set(id, req);
  return req;
}

export function getPermissionRequest(id: string): PermissionRequest | undefined {
  return pendingPermissions.get(id);
}

export function getPendingPermissions(): PermissionRequest[] {
  cleanup();
  return Array.from(pendingPermissions.values()).filter((r) => !r.decision);
}

export function getPendingForSession(sessionId: string): PermissionRequest[] {
  cleanup();
  return Array.from(pendingPermissions.values()).filter(
    (r) => r.sessionId === sessionId && !r.decision
  );
}

export function decidePermission(
  id: string,
  behavior: "allow" | "deny"
): PermissionRequest | undefined {
  const req = pendingPermissions.get(id);
  if (!req) return undefined;
  req.decision = { behavior, decidedAt: Date.now() };
  // Keep for 30s so the hook can poll and pick it up, then auto-clean
  setTimeout(() => pendingPermissions.delete(id), 30_000);
  return req;
}
