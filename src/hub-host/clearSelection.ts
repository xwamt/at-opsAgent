/**
 * Best-effort Hub selection clear for host lifecycle hooks (playbook close,
 * session eviction). Failures are logged, never rethrown — those paths must
 * not fail because the Hub was already gone or `at_clear_tool_selection` rejected.
 */
function describeClearError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function clearHubSelection(
  hub: { selection: { clear: () => Promise<void> } },
  log: (message: string) => void,
  reason: string
): Promise<void> {
  try {
    await hub.selection.clear();
  } catch (err) {
    log(`[hub] ${reason} clear 失败: ${describeClearError(err)}`);
  }
}
