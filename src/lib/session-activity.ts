/** Whether a local session has a confirmed live process in the manager. */
export function isSessionActiveForList(
  row: { session_id: string; agent_type?: string | null; file_mtime: number },
  activeIds: ReadonlySet<string>,
  now = Date.now(),
): boolean {
  if (row.agent_type === "forge") return now - row.file_mtime < 5 * 60 * 1000;
  return activeIds.has(row.session_id);
}
