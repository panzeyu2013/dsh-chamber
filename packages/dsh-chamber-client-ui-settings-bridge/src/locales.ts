/** `dsh-chamber.settings.bridge` namespace dictionaries: the chamber settings shell copy. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  trigger: '设置',
  title: '设置',
  serverDropdownLabel: '选择服务器',
  connectionsNav: '连接',
  noServers: '暂无可管理的实例。请在「连接」中启动本地实例或注册远程主机。',
  loadingServers: '正在加载实例…',
  targetUnavailable: '该实例当前不可达，其配置存储在该实例的宿主机器上，建立连接后可编辑。',
  localNotReady: '本地实例尚未就绪，可在「连接」中启动。',
  sectionsEmpty: '该实例没有可显示的内容（可能正在启动，稍后自动出现）。',
  current: '当前',
  close: '关闭',
}

/** English dictionary (key-set must match `zh` exactly). */
export const en: Record<keyof typeof zh, string> = {
  trigger: 'Settings',
  title: 'Settings',
  serverDropdownLabel: 'Choose server',
  connectionsNav: 'Connections',
  noServers: 'Nothing to manage yet. Start the local instance or register a remote host in Connections.',
  loadingServers: 'Loading instances…',
  targetUnavailable: 'This instance is not reachable right now. Its config lives on the instance host machine; connect first to edit.',
  localNotReady: 'The local instance is not ready yet — start it in Connections.',
  sectionsEmpty: 'Nothing to show yet (the instance may still be starting — it appears automatically).',
  current: 'Current',
  close: 'Close',
}

/** Dictionary key set for the settings bridge namespace. */
export type SettingsBridgeKey = keyof typeof zh
