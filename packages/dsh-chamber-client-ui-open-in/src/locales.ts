/**
 * Copy owned by the chamber open-in plugin (design 16 + design 20).
 *
 * The dictionaries started as the official `open-in-app` client's copy and
 * product-label table; since the fork & supersede ruling (design 20 §2.2) THIS
 * file is the owner rather than a mirror — the official client never loads, and
 * the `app.*` labels must cover exactly the catalog ids our host domain can
 * answer (`packages/dsh-chamber-seed-open-in/src/catalog.ts`), which
 * `test/open-in-labels.test.ts` pins. Product names still track upstream's
 * spelling where an id is shared, so a user sees the same application names the
 * official surface would show.
 */
export const zh = {
  /** Neutral entry label (slot registrant diagnostics — not user-facing). */
  titleOpen: '在应用中打开当前工作区',
  titleVscode: '在 VS Code 中打开当前工作区',
  titleFinder: '在 Finder 中打开当前工作区',
  titleExplorer: '在资源管理器中打开当前工作区',
  titleFileManager: '在文件管理器中打开当前工作区',
  titleGeneric: '在 {app} 中打开当前工作区',
  openFailed: '打开失败：',
  bridgeUnavailable: '桌面桥不可用',
  invalidResponse: '桌面桥返回了无效结果',
  /** The instance-hosted catalog is unavailable for this source (no carrier/host domain). */
  catalogUnavailable: '实例内打开目录服务不可用',
  /** Split-button copy: main-button tooltip / title template. */
  openTitle: '在 {app} 中打开工作目录',
  openTooltip: '在本地打开',
  openError: '打开失败',
  menuToggle: '选择打开方式',
  /** Catalog product names (one entry per id our host catalog can answer). */
  'app.cursor': 'Cursor',
  'app.vscode': 'VS Code',
  'app.vscodeinsiders': 'VS Code Insiders',
  'app.windsurf': 'Windsurf',
  'app.zed': 'Zed',
  'app.sublimetext': 'Sublime Text',
  'app.xcode': 'Xcode',
  'app.androidstudio': 'Android Studio',
  'app.intellij': 'IntelliJ IDEA',
  'app.pycharm': 'PyCharm',
  'app.webstorm': 'WebStorm',
  'app.phpstorm': 'PhpStorm',
  'app.goland': 'GoLand',
  'app.rider': 'Rider',
  'app.rustrover': 'RustRover',
  'app.fork': 'Fork',
  'app.sourcetree': 'Sourcetree',
  'app.github': 'GitHub Desktop',
  'app.tower': 'Tower',
  'app.gitkraken': 'GitKraken',
  'app.smartgit': 'SmartGit',
  'app.sublimemerge': 'Sublime Merge',
  'app.ghostty': 'Ghostty',
  'app.warp': 'Warp',
  'app.iterm': 'iTerm2',
  'app.kitty': 'kitty',
  'app.windowsterminal': 'Windows Terminal',
  'app.gitbash': 'Git Bash',
  'app.gnometerminal': 'GNOME Terminal',
  'app.konsole': 'Konsole',
  'app.finder': '访达',
  'app.explorer': '文件资源管理器',
  'app.filemanager': '文件管理器',
  'app.terminal': '终端',
}

export const en: Record<OpenInKey, string> = {
  /** Neutral entry label (slot registrant diagnostics — not user-facing). */
  titleOpen: 'Open current workspace in an app',
  titleVscode: 'Open current workspace in VS Code',
  titleFinder: 'Open current workspace in Finder',
  titleExplorer: 'Open current workspace in Explorer',
  titleFileManager: 'Open current workspace in file manager',
  titleGeneric: 'Open current workspace in {app}',
  openFailed: 'Failed to open: ',
  bridgeUnavailable: 'desktop bridge unavailable',
  invalidResponse: 'desktop bridge returned an invalid result',
  catalogUnavailable: 'the in-instance open catalog is unavailable',
  openTitle: 'Open workspace in {app}',
  openTooltip: 'Open locally',
  openError: 'Failed to open',
  menuToggle: 'Choose an app to open in',
  'app.cursor': 'Cursor',
  'app.vscode': 'VS Code',
  'app.vscodeinsiders': 'VS Code Insiders',
  'app.windsurf': 'Windsurf',
  'app.zed': 'Zed',
  'app.sublimetext': 'Sublime Text',
  'app.xcode': 'Xcode',
  'app.androidstudio': 'Android Studio',
  'app.intellij': 'IntelliJ IDEA',
  'app.pycharm': 'PyCharm',
  'app.webstorm': 'WebStorm',
  'app.phpstorm': 'PhpStorm',
  'app.goland': 'GoLand',
  'app.rider': 'Rider',
  'app.rustrover': 'RustRover',
  'app.fork': 'Fork',
  'app.sourcetree': 'Sourcetree',
  'app.github': 'GitHub Desktop',
  'app.tower': 'Tower',
  'app.gitkraken': 'GitKraken',
  'app.smartgit': 'SmartGit',
  'app.sublimemerge': 'Sublime Merge',
  'app.ghostty': 'Ghostty',
  'app.warp': 'Warp',
  'app.iterm': 'iTerm2',
  'app.kitty': 'kitty',
  'app.windowsterminal': 'Windows Terminal',
  'app.gitbash': 'Git Bash',
  'app.gnometerminal': 'GNOME Terminal',
  'app.konsole': 'Konsole',
  'app.finder': 'Finder',
  'app.explorer': 'File Explorer',
  'app.filemanager': 'Files',
  'app.terminal': 'Terminal',
}

export type OpenInKey = keyof typeof zh

/**
 * Label key per catalog id — the table is OURS now (design 20 §5): our host
 * domain's catalog (`packages/dsh-chamber-seed-open-in/src/catalog.ts`) is the
 * authority on which ids can appear, and `test/open-in-labels.test.ts` fails
 * when an id has no zh+en label. Ids outside this table still render through
 * `titleGeneric`, so a catalog extension degrades to a raw id instead of
 * disappearing.
 */
export const OPEN_IN_APP_LABEL_KEY: Record<string, OpenInKey | undefined> = {
  finder: 'app.finder',
  explorer: 'app.explorer',
  filemanager: 'app.filemanager',
  cursor: 'app.cursor',
  vscode: 'app.vscode',
  vscodeinsiders: 'app.vscodeinsiders',
  windsurf: 'app.windsurf',
  zed: 'app.zed',
  sublimetext: 'app.sublimetext',
  xcode: 'app.xcode',
  androidstudio: 'app.androidstudio',
  intellij: 'app.intellij',
  pycharm: 'app.pycharm',
  webstorm: 'app.webstorm',
  phpstorm: 'app.phpstorm',
  goland: 'app.goland',
  rider: 'app.rider',
  rustrover: 'app.rustrover',
  fork: 'app.fork',
  sourcetree: 'app.sourcetree',
  github: 'app.github',
  tower: 'app.tower',
  gitkraken: 'app.gitkraken',
  smartgit: 'app.smartgit',
  sublimemerge: 'app.sublimemerge',
  ghostty: 'app.ghostty',
  warp: 'app.warp',
  iterm: 'app.iterm',
  kitty: 'app.kitty',
  terminal: 'app.terminal',
  windowsterminal: 'app.windowsterminal',
  gitbash: 'app.gitbash',
  gnometerminal: 'app.gnometerminal',
  konsole: 'app.konsole',
}
