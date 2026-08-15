/**
 * Bridge-rows dictionaries (self-built copy of the OFFICIAL key sets, source
 * of truth: the official packages' locales.ts — the rows render the same
 * copy on the child ctx because the owning official plugins are not mounted
 * there). Key sets must stay in sync with the official dictionaries; an
 * upstream key change shows as a missing-key fallback (fail-visible), caught
 * in the harness.commit upgrade review.
 */

/** `conversation` namespace (owned officially by ui-conversation; unclaimed on the child ctx). */
export const conversationZh = {
  'settings.enter.title': '繁忙时 Enter 键行为',
  'settings.enter.description': '仅在智能体运行时生效；Cmd/Ctrl+Enter 使用另一行为',
  'settings.enter.queue': '排队发送',
  'settings.enter.steer': '插话发送',
}

export const conversationEn: Record<keyof typeof conversationZh, string> = {
  'settings.enter.title': 'Enter behavior while busy',
  'settings.enter.description': 'Busy only; Cmd/Ctrl+Enter uses the other behavior',
  'settings.enter.queue': 'Queue',
  'settings.enter.steer': 'Steer',
}

/** `settings.permission` namespace (owned officially by ui-permission-presets). */
export const permissionZh = {
  'title': '权限',
  'description': '选择新会话的默认权限模式',
  'loading': '加载中',
  'unavailable': '不可用',
  'confirm.title': '确认启用 Full access？',
  'confirm.description': '启用 Full access 后，新会话将减少确认步骤，并且可以直接执行更多操作，包括敏感操作、文件修改或外部命令。仅建议在你信任后续任务时使用。',
  'confirm.acknowledge': '我已了解风险，并愿意继续',
  'confirm.cancel': '取消',
  'confirm.enable': '启用 Full access',
}

export const permissionEn: Record<keyof typeof permissionZh, string> = {
  'title': 'Permission',
  'description': 'Choose the default permission mode for new sessions',
  'loading': 'Loading',
  'unavailable': 'Unavailable',
  'confirm.title': 'Enable Full access?',
  'confirm.description': 'Full access lets new sessions reduce confirmation steps and perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust subsequent tasks.',
  'confirm.acknowledge': 'I understand the risks and want to continue',
  'confirm.cancel': 'Cancel',
  'confirm.enable': 'Enable Full access',
}
