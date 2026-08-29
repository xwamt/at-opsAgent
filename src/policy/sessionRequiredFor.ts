/**
 * 会话审批范围（`approval.sessionRequiredFor` / `policy.floor`）。
 * 纯比较：无 IO、无 vscode、无 node:crypto（webview 可安全引用）。
 *
 * 全序（松 → 严）：never < exec-only < write-exec。
 * 更严 = 更多风险级需要会话内审批。effective = max(floor, userSetting)。
 */
export type SessionRequiredFor = 'write-exec' | 'exec-only' | 'never';

export const SESSION_REQUIRED_FOR_VALUES = ['write-exec', 'exec-only', 'never'] as const;

/** 松 → 严 的秩。never=0（最松）… write-exec=2（最严）。 */
export const SESSION_REQUIRED_FOR_RANK: Record<SessionRequiredFor, number> = {
  never: 0,
  'exec-only': 1,
  'write-exec': 2
};

export function isSessionRequiredFor(value: unknown): value is SessionRequiredFor {
  return (
    value === 'write-exec' || value === 'exec-only' || value === 'never'
  );
}

export function parseSessionRequiredFor(
  value: unknown,
  fallback: SessionRequiredFor = 'write-exec'
): SessionRequiredFor {
  return isSessionRequiredFor(value) ? value : fallback;
}

/**
 * 组织下限与用户设置取更严者。
 * floor=`write-exec` + user=`never` → `write-exec`；
 * floor=`exec-only` + user=`write-exec` → `write-exec`（用户已更严，不变）。
 */
export function effectiveSessionRequiredFor(
  floor: SessionRequiredFor,
  userSetting: SessionRequiredFor
): SessionRequiredFor {
  return SESSION_REQUIRED_FOR_RANK[floor] >= SESSION_REQUIRED_FOR_RANK[userSetting]
    ? floor
    : userSetting;
}

export function sessionRequiredForIsLooser(
  value: SessionRequiredFor,
  floor: SessionRequiredFor
): boolean {
  return SESSION_REQUIRED_FOR_RANK[value] < SESSION_REQUIRED_FOR_RANK[floor];
}
