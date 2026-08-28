/** Copy owned by the chamber open-in plugin (design 16 + open-in extension). */
export const zh = {
  /** Neutral entry label (slot registrant diagnostics — not user-facing). */
  titleOpen: '在应用中打开当前工作区',
  titleVscode: '在 VS Code 中打开当前工作区',
  titleFinder: '在 Finder 中打开当前工作区',
  titleExplorer: '在资源管理器中打开当前工作区',
  titleFileManager: '在文件管理器中打开当前工作区',
  titleGeneric: '在 {app} 中打开当前工作区',
  chooseAppAria: '选择打开方式',
  openFailed: '打开失败：',
  bridgeUnavailable: '桌面桥不可用',
  invalidResponse: '桌面桥返回了无效结果',
}

export const en = {
  /** Neutral entry label (slot registrant diagnostics — not user-facing). */
  titleOpen: 'Open current workspace in an app',
  titleVscode: 'Open current workspace in VS Code',
  titleFinder: 'Open current workspace in Finder',
  titleExplorer: 'Open current workspace in Explorer',
  titleFileManager: 'Open current workspace in file manager',
  titleGeneric: 'Open current workspace in {app}',
  chooseAppAria: 'Choose how to open',
  openFailed: 'Failed to open: ',
  bridgeUnavailable: 'desktop bridge unavailable',
  invalidResponse: 'desktop bridge returned an invalid result',
}

export type OpenInKey = keyof typeof zh
