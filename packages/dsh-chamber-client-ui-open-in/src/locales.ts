/** Copy owned by the chamber open-in plugin (design 16 + open-in extension). */
export const zh = {
  /** Neutral entry label (slot registrant diagnostics — not user-facing). */
  titleOpen: '在应用中打开当前工作区',
  titleVscode: '在 VS Code 中打开当前工作区',
  titleFinder: '在 Finder 中打开当前工作区',
  titleExplorer: '在资源管理器中打开当前工作区',
  titleFileManager: '在文件管理器中打开当前工作区',
  /** Short dropdown-row names (icon + app name, OpenChamber-style rows). */
  appVscode: 'VS Code',
  appFinder: 'Finder',
  appExplorer: '资源管理器',
  appFileManager: '文件管理器',
  chooseAppAria: '选择打开方式',
  openFailed: '打开失败：',
}

export const en = {
  /** Neutral entry label (slot registrant diagnostics — not user-facing). */
  titleOpen: 'Open current workspace in an app',
  titleVscode: 'Open current workspace in VS Code',
  titleFinder: 'Open current workspace in Finder',
  titleExplorer: 'Open current workspace in Explorer',
  titleFileManager: 'Open current workspace in file manager',
  /** Short dropdown-row names (icon + app name, OpenChamber-style rows). */
  appVscode: 'VS Code',
  appFinder: 'Finder',
  appExplorer: 'Explorer',
  appFileManager: 'File manager',
  chooseAppAria: 'Choose how to open',
  openFailed: 'Failed to open: ',
}

export type OpenInKey = keyof typeof zh
