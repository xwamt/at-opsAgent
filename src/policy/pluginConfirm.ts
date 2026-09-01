/**
 * 插件 MCP 路径已经会弹确认（或按信任档自动放行）的工具。
 * Agent 会话 9 要素简报不应再叠一道人审。
 *
 * at.database 永不进入此表——其 MCP 写无弹窗，必须走 Agent 简报。
 */
export function toolBareName(toolName: string): string {
  const slash = toolName.lastIndexOf('/');
  return slash >= 0 ? toolName.slice(slash + 1) : toolName;
}

const PLUGIN_CONFIRMED_TOOLS = new Set<string>([
  'run_remote_command',
  'sftp_write_file',
  'sftp_create_file',
  'sftp_create_directory',
  'sftp_rename',
  'sftp_delete',
  'jumpserver_run_terminal_command',
  'jumpserver_send_terminal_input',
  'jumpserver_sftp_write_file',
  'jumpserver_sftp_create_file',
  'jumpserver_sftp_create_directory',
  'jumpserver_sftp_rename',
  'jumpserver_sftp_delete',
  'jumpserver_mysql_execute_sql',
  'jumpserver_redis_execute_command',
  'nacos_publish_config',
  'nacos_delete_config',
  'nacos_rollback_config',
  'nacos_update_instance_health'
]);

/**
 * @param declared 来自 Hub 描述符的显式标记；true/false 覆盖 allowlist；缺省走表。
 */
export function toolConfirmsInPlugin(
  pluginId: string | undefined,
  toolName: string,
  declared?: boolean
): boolean {
  if (declared === true) return true;
  if (declared === false) return false;
  if (pluginId === 'at.database') return false;
  return PLUGIN_CONFIRMED_TOOLS.has(toolBareName(toolName));
}
